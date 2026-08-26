/**
 * TTM Event Analysis Service
 *
 * Wraps the fine-tuned IBM Granite TTM-R3 event-classification model.
 * Spawns `python/ttm_event_forecast.py` and returns the parsed JSON forecast.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class TTMEventAnalysisService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.pythonExe = options.pythonExe || path.join(this.projectRoot, 'python', 'venv-ttm', 'bin', 'python');
    this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'python', 'ttm_event_forecast.py');
    // ttm-event-r3-dte: 16-channel feature set — the 14 channels of
    // ttm-event-r3-y1-ns plus exp1/exp2 days-to-expiry (log-scaled, centred
    // on 30d). Test AUROC 0.800, statistically tied with the 14-channel
    // reproduction (0.805; the original y1-ns 0.825 did not reproduce on
    // current data). Put-side mirrors (20ch: 0.758) and per-moneyness-bucket
    // DV ranks (40-60ch: 0.72-0.75) were tested and regressed — see the NOTE
    // in python/ttm_event_dataset.py CHANNELS.
    //
    // The scaling choice dominates everything else here: the target is driven by
    // the ABSOLUTE level of recent event magnitude, and the previous "std"
    // setting z-normalized each window, erasing exactly that signal (AUROC 0.621).
    //
    // NOTE: its event threshold (432,294) differs from ttm-event-r3-opt's
    // (1,030,342) because the threshold is the 80th percentile of the training
    // window's event magnitudes. Probabilities from the two checkpoints are NOT
    // comparable — do not mix historical values across the switch.
    //
    // Older ttm-event-r3* checkpoints predate the options channels and will be
    // rejected by the channel-count check in ttm_event_forecast.py.
    this.modelDir = options.modelDir || path.join(this.projectRoot, 'python', 'models', 'ttm-event-r3-dte', 'final');
    this.datasetStats = options.datasetStats || path.join(this.projectRoot, 'data', 'ttm-events', 'stats.json');
    this.dbPath = options.dbPath || path.join(this.projectRoot, 'articles.db');
    // 'auto' lets the script pick CUDA when available and fall back to CPU.
    this.device = options.device || process.env.TTM_DEVICE || 'auto';
  }

  /**
   * Run the forecast script once with the given stdin payload.
   * Handles the DB snapshot, spawn, and JSON parsing shared by both modes.
   * @private
   * @param {Object} payload - {ticker, date} or {tickers, date}
   * @returns {Promise<Object>} Parsed JSON from the script
   */
  _run(payload) {
    return new Promise((resolve, reject) => {
      // DuckDB does not allow a second process to read the DB while the main
      // Electron process holds the write lock. Copy to a temp file first.
      // Batch mode makes this copy worth it: it is paid once per group rather
      // than once per ticker.
      const tmpDb = path.join(os.tmpdir(), `adapta_ttm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
      try {
        fs.copyFileSync(this.dbPath, tmpDb);
      } catch (copyErr) {
        reject(new Error(`Failed to copy database for TTM forecast: ${copyErr.message}`));
        return;
      }

      const args = [
        this.scriptPath,
        '--db', tmpDb,
        '--model', this.modelDir,
        '--dataset-stats', this.datasetStats,
        '--device', this.device,
      ];

      const child = spawn(this.pythonExe, args, {
        cwd: this.projectRoot,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('error', (err) => {
        fs.unlink(tmpDb, () => {});
        reject(new Error(`Failed to start TTM forecast: ${err.message}`));
      });

      child.on('close', (code) => {
        fs.unlink(tmpDb, () => {});
        if (code !== 0) {
          reject(new Error(`TTM forecast exited with ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          resolve(result);
        } catch (parseErr) {
          reject(new Error(`TTM forecast returned invalid JSON: ${parseErr.message}\n${stdout}\n${stderr}`));
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  /**
   * Forecast the next-day event probability for a single ticker.
   * @param {string} ticker
   * @param {string|null} date Optional target date (YYYY-MM-DD)
   * @returns {Promise<Object>}
   */
  async forecast(ticker, date = null) {
    return this._run({ ticker, date });
  }

  /**
   * Forecast many tickers in ONE batched forward pass.
   *
   * Far cheaper than calling forecast() per ticker: model weights and the ~2s
   * of Python/torch import cost are paid once for the whole group, and the
   * batched matmul runs on the GPU when available (~40x faster than CPU at
   * batch=100). Scoring the full ~104-ticker universe takes ~10s total.
   *
   * Tickers that cannot be scored are reported in `errors` rather than
   * failing the batch.
   *
   * @param {string[]} tickers
   * @param {string|null} date Optional target date (YYYY-MM-DD)
   * @returns {Promise<{results: Array, errors: Array, device: string, count: number}>}
   */
  async forecastBatch(tickers, date = null) {
    const list = (tickers || []).map(t => String(t).toUpperCase()).filter(Boolean);
    if (list.length === 0) {
      return { results: [], errors: [], device: this.device, count: 0 };
    }
    return this._run({ tickers: list, date });
  }

  /**
   * Convenience wrapper: returns a Map of ticker → event_probability.
   * Failed tickers are simply absent from the map.
   * @param {string[]} tickers
   * @param {string|null} date
   * @returns {Promise<Map<string, number>>}
   */
  async forecastProbabilities(tickers, date = null) {
    const out = new Map();
    const batch = await this.forecastBatch(tickers, date);
    for (const r of batch.results || []) {
      if (r.ticker && typeof r.event_probability === 'number') {
        out.set(r.ticker, r.event_probability);
      }
    }
    if (batch.errors?.length > 0) {
      const preview = batch.errors.slice(0, 3).map(e => `${e.ticker}: ${e.error}`).join('; ');
      console.warn(`[TTM] ${batch.errors.length} ticker(s) could not be scored — ${preview}`);
    }
    return out;
  }
}

module.exports = TTMEventAnalysisService;
