'use strict';

/**
 * FlowstateAnalysisService — IBM Granite Flowstate-R1 next-day price forecast.
 *
 * Replaces the previous GLM analysis. Flowstate-R1 is a univariate zero-shot
 * time-series foundation model: given a window of close prices, it returns
 * 9 quantile forecasts for the next trading day. We surface the q10/q90
 * band as (low, high) and q50 as the median.
 *
 * Architecture:
 *   - Python subprocess (python/venv-flowstate) loads the HF model and runs
 *     batched inference per call. Mirrors src/services/chronosHoldPeriod.js.
 *   - Multiple tickers (or multiple historical days for a backtest) are sent
 *     in a single batch to amortize the ~3s model-load cost.
 *
 * NOTE on event/IV features: Flowstate-R1 only accepts a single channel,
 * so the IV/event/volume features that drove the old GLM cannot be fed to
 * the model directly. They are reported alongside the forecast for context;
 * a future calibration layer can fit `realized = a*median + b*ivSpread + ...`
 * on backtest output.
 */

const { spawn } = require('child_process');
const path = require('path');

const VENV_PYTHON = path.join(__dirname, '..', '..', 'python', 'venv-flowstate', 'bin', 'python');
const FORECAST_SCRIPT = path.join(__dirname, '..', '..', 'python', 'flowstate_forecast.py');

// Quantile index → quantile level mapping (Flowstate emits 9 quantiles, q10..q90)
const QUANTILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

class FlowstateAnalysisService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Fetch the most recent N daily closes for a ticker, oldest first.
   * Falls back to the 'analysis' source if 'yahoo_finance' has too few bars.
   */
  async _fetchContext(ticker, contextDays) {
    const fetchFrom = async (source) => {
      const rows = await this.database.getPriceHistory(ticker, {
        limit: contextDays,
        source,
      });
      if (!rows || rows.length === 0) return [];
      const toIsoDate = (d) => {
        if (!d) return '';
        if (d instanceof Date) return d.toISOString().slice(0, 10);
        const s = String(d);
        return s.length >= 10 ? s.slice(0, 10) : s;
      };
      return rows
        .slice()
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map((r) => ({ date: toIsoDate(r.date), close: Number(r.close) }))
        .filter((r) => Number.isFinite(r.close) && r.close > 0);
    };

    let bars = await fetchFrom('yahoo_finance');
    if (bars.length < 64) {
      const alt = await fetchFrom('analysis');
      if (alt.length > bars.length) bars = alt;
    }
    return bars;
  }

  /**
   * Forecast next-day low/median/high for one or more tickers.
   *
   * @param {string[]} tickers
   * @param {Object} opts
   * @param {number} [opts.contextDays=512]   Trading days of history to feed the model.
   * @param {number} [opts.scaleFactor=1.0]   Flowstate sampling-rate hint. {0.5,1.0,2.0}.
   * @param {number} [opts.qLowIdx=0]         Quantile index for "low" (0=q10).
   * @param {number} [opts.qHighIdx=8]        Quantile index for "high" (8=q90).
   * @returns {Promise<{forecasts: Array, params: Object}>}
   */
  async forecastNextDay(tickers, opts = {}) {
    const {
      contextDays = 512,
      scaleFactor = 1.0,
      qLowIdx = 0,
      qHighIdx = 8,
    } = opts;

    if (!Array.isArray(tickers) || tickers.length === 0) {
      throw new Error('forecastNextDay: tickers must be a non-empty array');
    }

    const requests = [];
    const skipped = [];
    for (const ticker of tickers) {
      const bars = await this._fetchContext(ticker, contextDays);
      if (bars.length < 64) {
        skipped.push({ ticker, reason: `only ${bars.length} bars (need >= 64)` });
        continue;
      }
      requests.push({
        id: ticker,
        ticker,
        lastClose: bars[bars.length - 1].close,
        lastDate: bars[bars.length - 1].date,
        series: bars.map((b) => b.close),
      });
    }

    if (requests.length === 0) {
      return { forecasts: [], skipped, params: { contextDays, scaleFactor } };
    }

    const out = await this._runPython({
      requests: requests.map((r) => ({ id: r.id, series: r.series })),
      scale_factor: scaleFactor,
      prediction_length: 1,
      quantile_low_idx: qLowIdx,
      quantile_high_idx: qHighIdx,
      median_idx: 4,
    });

    const byId = new Map(out.results.map((r) => [r.id, r]));
    const forecasts = requests.map((r) => {
      const f = byId.get(r.id);
      if (!f) return { ticker: r.ticker, error: 'no forecast returned' };
      return {
        ticker: r.ticker,
        asOf: r.lastDate,
        lastClose: r.lastClose,
        low: f.low,
        median: f.median,
        high: f.high,
        quantiles: f.quantiles,
        bandPct: r.lastClose > 0 ? (f.high - f.low) / r.lastClose : null,
        medianReturnPct: r.lastClose > 0 ? (f.median - r.lastClose) / r.lastClose : null,
      };
    });

    return {
      forecasts,
      skipped,
      params: {
        contextDays,
        scaleFactor,
        qLowIdx,
        qHighIdx,
        qLowLevel: QUANTILE_LEVELS[qLowIdx],
        qHighLevel: QUANTILE_LEVELS[qHighIdx],
        model: out.model,
        revision: out.revision,
        device: out.device,
      },
    };
  }

  /**
   * Walk-forward backtest: for the last `nDays` trading days of `ticker`,
   * forecast the next-day close from the prior `contextDays` window and
   * compare to the realized close. Reports MAE, RMSE, [low,high]-band
   * empirical coverage, and directional hit-rate.
   *
   * Runs as a single batched Python call.
   */
  async walkForwardBacktest(ticker, opts = {}) {
    const {
      contextDays = 512,
      nDays = 60,
      scaleFactor = 1.0,
      qLowIdx = 0,
      qHighIdx = 8,
    } = opts;

    // Need contextDays + nDays + 1 bars: each prediction at day t uses bars [t-contextDays..t-1] and predicts t.
    const bars = await this._fetchContext(ticker, contextDays + nDays + 8);
    const minNeeded = contextDays + nDays + 1;
    if (bars.length < minNeeded) {
      throw new Error(
        `Backtest needs ${minNeeded} bars for ${ticker}; only have ${bars.length}. ` +
        `Try a smaller contextDays or nDays.`
      );
    }

    const closes = bars.map((b) => b.close);
    const dates = bars.map((b) => b.date);
    const start = bars.length - nDays;

    const requests = [];
    for (let i = start; i < bars.length; i++) {
      const ctxStart = i - contextDays;
      requests.push({
        id: `${ticker}_${dates[i]}`,
        date: dates[i],
        prevClose: closes[i - 1],
        series: closes.slice(ctxStart, i), // history strictly before day i
        realized: closes[i],
      });
    }

    const out = await this._runPython({
      requests: requests.map((r) => ({ id: r.id, series: r.series, realized: r.realized })),
      scale_factor: scaleFactor,
      prediction_length: 1,
      quantile_low_idx: qLowIdx,
      quantile_high_idx: qHighIdx,
      median_idx: 4,
    });

    const byId = new Map(out.results.map((r) => [r.id, r]));
    let sumAbsErr = 0;
    let sumSqErr = 0;
    let inBand = 0;
    let dirHits = 0;
    let dirCount = 0;
    const days = [];

    for (const r of requests) {
      const f = byId.get(r.id);
      if (!f) continue;
      const err = r.realized - f.median;
      sumAbsErr += Math.abs(err);
      sumSqErr += err * err;
      if (r.realized >= f.low && r.realized <= f.high) inBand++;
      // Direction relative to prevClose: did the model and realized agree on up/down?
      const realizedDir = Math.sign(r.realized - r.prevClose);
      const predDir = Math.sign(f.median - r.prevClose);
      if (realizedDir !== 0 && predDir !== 0) {
        dirCount++;
        if (realizedDir === predDir) dirHits++;
      }
      days.push({
        date: r.date,
        prevClose: r.prevClose,
        realized: r.realized,
        low: f.low,
        median: f.median,
        high: f.high,
        error: err,
        inBand: r.realized >= f.low && r.realized <= f.high,
        realizedDir: realizedDir > 0 ? 'up' : realizedDir < 0 ? 'down' : 'flat',
        predDir: predDir > 0 ? 'up' : predDir < 0 ? 'down' : 'flat',
      });
    }

    const n = days.length || 1;
    const lastClose = closes[closes.length - 1];

    return {
      ticker,
      nDays: days.length,
      contextDays,
      scaleFactor,
      mae: sumAbsErr / n,
      rmse: Math.sqrt(sumSqErr / n),
      maePct: (sumAbsErr / n) / (lastClose || 1),
      coverage: inBand / n,
      nominalCoverage: QUANTILE_LEVELS[qHighIdx] - QUANTILE_LEVELS[qLowIdx],
      directionalHitRate: dirCount > 0 ? dirHits / dirCount : null,
      directionalSamples: dirCount,
      qLowLevel: QUANTILE_LEVELS[qLowIdx],
      qHighLevel: QUANTILE_LEVELS[qHighIdx],
      days,
      model: out.model,
      revision: out.revision,
    };
  }

  /**
   * Spawn the Flowstate Python script with a JSON payload over stdin.
   * Resolves with the parsed JSON from stdout, or rejects on error.
   */
  _runPython(payload) {
    return new Promise((resolve, reject) => {
      const py = spawn(VENV_PYTHON, [FORECAST_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600000, // 10 min — covers model load + large batches
      });

      let stdout = '';
      let stderr = '';

      py.stdout.on('data', (d) => { stdout += d.toString(); });
      py.stderr.on('data', (d) => {
        const msg = d.toString();
        stderr += msg;
        // Forward Flowstate's progress messages (model load, forecast start) to console
        const trimmed = msg.trim();
        if (trimmed && !trimmed.startsWith('INFO:') && !trimmed.startsWith('WARNING:')) {
          console.log(`[Flowstate] ${trimmed}`);
        }
      });

      py.on('close', (code) => {
        if (code !== 0) {
          console.error(`[Flowstate] python exited code=${code}`);
          if (stderr) console.error(`[Flowstate] stderr tail: ${stderr.slice(-500)}`);
          reject(new Error(`Flowstate forecast failed (exit ${code})`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) {
            reject(new Error(`Flowstate: ${parsed.error}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Flowstate: failed to parse output: ${e.message}`));
        }
      });

      py.on('error', (err) => {
        reject(new Error(`Flowstate: failed to spawn Python: ${err.message}`));
      });

      py.stdin.write(JSON.stringify(payload));
      py.stdin.end();
    });
  }
}

module.exports = FlowstateAnalysisService;
