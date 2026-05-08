const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * RunArchiver — writes raw screening-run data to per-run parquet sidecars.
 *
 * Each run produces files in `outputDir`:
 *   run-<runId>.run.json       metadata + per-ticker statuses
 *   run-<runId>.bars.parquet   one row per (ticker, trading day)
 *   run-<runId>.chains.parquet one row per options contract observed
 *   run-<runId>.events.parquet one row per detected event
 *
 * runId is the run-start ISO timestamp with `:` and `.` replaced by `-` so it's
 * filesystem-safe and matches the existing HTML naming convention.
 *
 * Parquet conversion uses the existing DuckDB connection: rows are serialized as
 * newline-delimited JSON to a temp file, then COPY'd into a parquet via
 * `read_json_auto`. The temp JSONL is removed after the COPY succeeds.
 */
class RunArchiver {
  constructor({ database, outputDir }) {
    this.database = database;
    this.outputDir = outputDir;
    this.hostId = os.hostname();
  }

  startRun({ trigger = 'manual', config = {} } = {}) {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(this.outputDir, { recursive: true });
    return {
      runId,
      runDir: this.outputDir,
      hostId: this.hostId,
      trigger,
      config,
      startedAt: new Date().toISOString(),
      buffers: {
        bars: [],
        chains: [],
        events: [],
        tickers: [],
      },
    };
  }

  recordBars(run, ticker, bars) {
    if (!run || !bars?.length) return;
    for (const b of bars) {
      if (b.open == null || b.close == null) continue;
      run.buffers.bars.push({
        ticker,
        date: this._toDateStr(b.date),
        open: this._num(b.open),
        high: this._num(b.high),
        low: this._num(b.low),
        close: this._num(b.close),
        volume: this._int(b.volume),
      });
    }
  }

  recordChain(run, { ticker, snapshotDate, expirationDate, currentPrice, source, calls = [], puts = [] }) {
    if (!run) return;
    const flatten = (contracts, side) => {
      for (const c of contracts) {
        run.buffers.chains.push({
          ticker,
          snapshot_date: snapshotDate,
          expiration_date: this._toDateStr(expirationDate),
          side,
          strike: this._num(c.strike),
          contract_symbol: c.contractSymbol || null,
          last_price: this._num(c.lastPrice),
          bid: this._num(c.bid),
          ask: this._num(c.ask),
          change: this._num(c.change),
          percent_change: this._num(c.percentChange),
          volume: this._int(c.volume),
          open_interest: this._int(c.openInterest),
          implied_volatility: this._num(c.impliedVolatility),
          in_the_money: c.inTheMoney === true,
          last_trade_date: c.lastTradeDate ? new Date(c.lastTradeDate).toISOString() : null,
          currency: c.currency || null,
          current_price: this._num(currentPrice),
          source: source || null,
        });
      }
    };
    flatten(calls, 'call');
    flatten(puts, 'put');
  }

  recordEvents(run, ticker, events, benchmark) {
    if (!run || !events?.length) return;
    for (const e of events) {
      run.buffers.events.push({
        ticker,
        date: e.dateStr || this._toDateStr(e.date),
        classification: e.classification || null,
        strength: this._num(e.strength),
        residual_return: this._num(e.residualReturn),
        volume_gap_product: this._num(e.volumeGapProduct),
        open: this._num(e.open),
        high: this._num(e.high),
        low: this._num(e.low),
        close: this._num(e.close),
        volume: this._int(e.volume),
        benchmark: benchmark || null,
      });
    }
  }

  recordTicker(run, ticker, info = {}) {
    if (!run) return;
    run.buffers.tickers.push({
      ticker,
      r_squared: info.rSquared ?? null,
      bars: info.bars ?? null,
      events: info.events ?? null,
      hits: info.hits ?? 0,
      status: info.status || 'ok',
      error: info.error || null,
    });
  }

  async finishRun(run, { status = 'completed', error = null } = {}) {
    if (!run) return null;
    const finishedAt = new Date().toISOString();
    const baseName = `run-${run.runId}`;
    const meta = {
      runId: run.runId,
      hostId: run.hostId,
      trigger: run.trigger,
      startedAt: run.startedAt,
      finishedAt,
      status,
      error: error ? (error.message || String(error)) : null,
      config: this._sanitizeConfig(run.config),
      counts: {
        bars: run.buffers.bars.length,
        chains: run.buffers.chains.length,
        events: run.buffers.events.length,
        tickers: run.buffers.tickers.length,
      },
      tickers: run.buffers.tickers,
    };

    fs.writeFileSync(
      path.join(run.runDir, `${baseName}.run.json`),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );

    // Sequential to avoid contention on the shared DuckDB connection.
    await this._writeParquet(run.runDir, baseName, 'bars', run.buffers.bars);
    await this._writeParquet(run.runDir, baseName, 'chains', run.buffers.chains);
    await this._writeParquet(run.runDir, baseName, 'events', run.buffers.events);

    return { runId: run.runId, runDir: run.runDir, counts: meta.counts };
  }

  async _writeParquet(dir, baseName, kind, rows) {
    if (!rows.length) return;
    const jsonlPath = path.join(dir, `${baseName}.${kind}.jsonl`);
    const parquetPath = path.join(dir, `${baseName}.${kind}.parquet`);
    fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
    try {
      await this._copyJsonlToParquet(jsonlPath, parquetPath);
    } finally {
      try { fs.unlinkSync(jsonlPath); } catch (_) { /* ignore */ }
    }
  }

  _copyJsonlToParquet(jsonlPath, parquetPath) {
    return new Promise((resolve, reject) => {
      const escapedJsonl = jsonlPath.replace(/'/g, "''");
      const escapedParquet = parquetPath.replace(/'/g, "''");
      const sql =
        `COPY (SELECT * FROM read_json_auto('${escapedJsonl}', format='newline_delimited')) ` +
        `TO '${escapedParquet}' (FORMAT PARQUET, COMPRESSION ZSTD)`;
      this.database.connection.run(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _toDateStr(d) {
    if (!d) return null;
    if (typeof d === 'string') {
      // Already YYYY-MM-DD or ISO — return YYYY-MM-DD slice
      return d.length >= 10 ? d.slice(0, 10) : d;
    }
    return new Date(d).toISOString().split('T')[0];
  }

  _num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  _int(v) {
    if (v == null || v === '') return null;
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? n : null;
  }

  _sanitizeConfig(config) {
    // Avoid bloating run.json with the full UNIVERSE on every run.
    // Keep ticker count + a sample, drop the rest.
    if (!config || typeof config !== 'object') return config;
    const out = { ...config };
    if (Array.isArray(out.screenTickers) && out.screenTickers.length > 50) {
      out.screenTickers = {
        count: out.screenTickers.length,
        sample: out.screenTickers.slice(0, 20),
      };
    }
    return out;
  }
}

module.exports = RunArchiver;
