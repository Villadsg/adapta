'use strict';
/**
 * In-app options-data backfill (phases A+C+D of ci/backfill-marketdata.js).
 *
 * Runs inside the Electron main process and reuses the app's open DuckDB
 * database — the standalone CLI cannot run while the app holds the articles.db
 * writer lock, so gap-filling from the UI has to happen here. Work executes on
 * a secondary connection created from the same Database instance (DuckDB allows
 * multiple connections per process, and the writer lock is per-process), so
 * phase D's long sequential query loops can't delay renderer queries that share
 * the primary connection.
 *
 * Phase A (candles) always runs first so phase C has marketdata-sourced bars
 * to drive its fetch list — without it, trading days the daily cron missed
 * (machine off) are invisible: the estimate says "up to date" while data is
 * missing. Symbols already current through the last closed session are
 * skipped, so a re-click when nothing is stale costs no credits. Phase C is
 * incremental and resumable:
 * already-present (ticker, date) pairs are skipped, no-data days are remembered
 * in ci/backfill-state.json, and tickers confirmed options-less in
 * ci/options-coverage.json are never asked for. Phase D re-derives
 * options_daily_iv + iv_history_records for exactly the tickers phase C
 * filled, so a multi-ticker gap fill costs seconds, not the full-universe
 * rebuild.
 */

const path = require('path');
const fs = require('fs');
const MarketDataClient = require('./marketDataClient');
const {
  phaseA, phaseC, phaseD, loadState, getBackfillTickers, loadBars,
  lastClosedSession, BENCHMARK, CHAIN_SKIP, LOOKBACK_DAYS,
} = require('../../ci/backfill-marketdata');

const COVERAGE_PATH = path.join(__dirname, '..', '..', 'ci', 'options-coverage.json');
const PROGRESS_SEND_INTERVAL_MS = 500;
// Observed MarketData trial pricing for chain fetches (~1.6 credits per
// ticker-day across the Oct 2026 backfill runs) — estimate only.
const CREDITS_PER_TICKER_DAY = 1.6;

class OptionsBackfillService {
  /**
   * @param {object} database - initialized ArticleDatabase instance
   * @param {function(Object): void} [pushProgress] - called with throttled
   *   progress payloads; main.js wires this to webContents.send
   * @param {function(): MarketDataClient} [clientFactory] - override for the
   *   MarketData client (tests inject a stub so no real credits are spent)
   */
  constructor(database, pushProgress = null, clientFactory = null) {
    this.database = database;
    this.pushProgress = pushProgress;
    this.clientFactory = clientFactory || (() => new MarketDataClient());
    this.running = false;
    this.cancelRequested = false;
    this.status = null;
    this.lastSummary = null;
    this._lastSentAt = 0;
  }

  isRunning() {
    return this.running;
  }

  cancel() {
    if (!this.running) return { success: false, error: 'No backfill is running' };
    this.cancelRequested = true;
    console.log('[Backfill] Cancel requested — phase C stops after in-flight fetches, phase D still runs for filled tickers');
    return { success: true };
  }

  getStatus() {
    return {
      running: this.running,
      cancelRequested: this.cancelRequested,
      ...(this.status || { phase: null }),
      lastSummary: this.lastSummary,
    };
  }

  /**
   * Tickers the vendor has repeatedly returned zero chains for — never spend
   * credits re-asking them.
   */
  _loadConfirmedMissing() {
    try {
      const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf-8'));
      return new Set(coverage.skip_tickers || []);
    } catch (_) {
      return new Set();
    }
  }

  _emit(payload, force = false) {
    this.status = { ...this.status, ...payload };
    const now = Date.now();
    if (!force && now - this._lastSentAt < PROGRESS_SEND_INTERVAL_MS) return;
    this._lastSentAt = now;
    if (this.pushProgress) {
      try { this.pushProgress({ ...this.status }); } catch (_) { /* UI gone — keep going */ }
    }
  }

  /**
   * Count the ticker-days phase C would actually fetch right now: bar-days
   * with no stored chain, minus known no-data days and vendor-confirmed
   * options-less tickers. Same filters as phase C's task list — including the
   * already-stored (ticker, date) skip, which is what keeps this honest.
   *
   * Also counts tickers whose candles end before the last closed session
   * (staleCandles). Phase A refreshes those first, which typically exposes new
   * chain-days — gapDays approximates them as weekday distance from the newest
   * bar to the last closed session, and feeds the credit estimate alongside
   * the stale-candle requests themselves.
   */
  async estimate() {
    const state = loadState();
    const noData = new Set(state.noDataDays || []);
    const confirmedMissing = this._loadConfirmedMissing();
    const conn = this.database.db.connect();
    const dbProxy = Object.create(this.database);
    dbProxy.connection = conn;
    try {
      const existing = await dbProxy.getExistingChainDays();
      const tickers = (await getBackfillTickers(dbProxy, null)).filter(
        (t) => t !== BENCHMARK && !CHAIN_SKIP.has(t) && !confirmedMissing.has(t)
      );
      const ref = lastClosedSession();
      const missing = new Map(); // ticker -> day count
      let staleCandles = 0;
      let gapDays = 0;
      for (const ticker of tickers) {
        const bars = await loadBars(dbProxy, ticker, 'marketdata');
        if (bars.length === 0 || bars[bars.length - 1].date < ref) {
          // Weekdays in (newest bar, last closed session] — the chain-days the
          // candle refresh will expose. Barless (new-universe) tickers assume
          // the full lookback window. US holidays slightly overcount;
          // estimate-only.
          const end = new Date(ref + 'T12:00:00Z');
          const from = bars.length
            ? new Date(bars[bars.length - 1].date + 'T12:00:00Z')
            : new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
          for (let d = new Date(from.getTime() + 86400000); d <= end; d = new Date(d.getTime() + 86400000)) {
            const dow = d.getUTCDay();
            if (dow !== 0 && dow !== 6) gapDays++;
          }
          staleCandles++;
        }
        for (const b of bars) {
          const key = `${ticker}|${b.date}`;
          if (!existing.has(key) && !noData.has(key)) {
            missing.set(ticker, (missing.get(ticker) || 0) + 1);
          }
        }
      }
      let missingDays = 0;
      for (const n of missing.values()) missingDays += n;
      return {
        success: true,
        tickers: missing.size,
        missingDays,
        staleCandles,
        gapDays,
        creditsEstimate: Math.round(missingDays * CREDITS_PER_TICKER_DAY + gapDays * CREDITS_PER_TICKER_DAY + staleCandles),
      };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      try { conn.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Run phases C→D for the requested tickers.
   * @param {Object} options
   * @param {string[]|null} [options.tickers] - uppercased symbols, or null for
   *   the full universe (equivalent to `node ci/backfill-marketdata.js --phase=C`)
   * @param {number} [options.creditCap] - stop phase C once the MarketData
   *   client's credits-used counter reaches this (job budget; the phase is
   *   resumable, so the rest continues on a later run)
   * @param {boolean} [options.isScreeningActive] - main.js passes its
   *   screening-in-progress flag; backfill refuses to share the API + DB with it
   */
  async start({ tickers = null, creditCap = null, isScreeningActive = null } = {}) {
    if (this.running) return { success: false, error: 'A backfill is already in progress' };
    if (typeof isScreeningActive === 'function' && isScreeningActive()) {
      return { success: false, error: 'A screening is running — stop it or wait for it to finish first' };
    }
    if (tickers !== null && (!Array.isArray(tickers) || tickers.length === 0)) {
      return { success: false, error: 'No tickers selected for backfill' };
    }

    let client;
    try {
      client = this.clientFactory(); // default throws a readable message if no API key
    } catch (err) {
      return { success: false, error: err.message };
    }

    this.running = true;
    this.cancelRequested = false;
    this.status = { phase: 'starting', current: 0, total: 0, ticker: null, creditsUsed: 0, creditsRemaining: null };
    this._emit({}, true);
    const state = loadState();
    const startedAt = new Date().toISOString();

    const conn = this.database.db.connect();
    const dbProxy = Object.create(this.database);
    dbProxy.connection = conn;

    try {
      const confirmedMissing = this._loadConfirmedMissing();

      // Phase A always runs first (never the benchmark): phase C builds its
      // fetch list from marketdata-sourced bars, so trading days the daily
      // cron missed (machine off) or tickers whose candles only exist as
      // another source (e.g. 'screening') would otherwise be invisible — the
      // estimate reports "up to date" while data is missing. Candles are one
      // request per ticker and symbols already current through the last
      // closed session are skipped inside phase A; the creditCap below still
      // governs the chains.
      let scope = tickers;
      if (tickers === null) {
        scope = (await getBackfillTickers(dbProxy, null)).filter(
          (t) => t !== BENCHMARK && !CHAIN_SKIP.has(t) && !confirmedMissing.has(t)
        );
      }
      this._emit({ phase: 'A', ticker: null, done: 0, total: scope.length }, true);
      const a = await phaseA(client, dbProxy, scope, LOOKBACK_DAYS, {
        includeBenchmark: false,
        onProgress: (info) => this._emit({ phase: 'A', ticker: info.ticker, done: info.done, total: info.total }),
      });

      const c = await phaseC(client, dbProxy, scope, state, confirmedMissing, {
        creditCap,
        isCancelled: () => this.cancelRequested,
        onProgress: (info) => this._emit({ phase: 'C', ...info }),
      });

      // Phase D: ALWAYS a full-universe rebuild, not just this run's
      // filledTickers. Chains fetched by an earlier interrupted/capped run
      // are skipped by phase C's already-stored check, so a subset derive
      // would leave them underived forever — exactly the SMCI hole bug:
      // complete backfill, empty IV records for the backfilled window.
      // The full rebuild costs ~a minute; correctness wins.
      let derivedTickers = 0;
      if (c.done > 0 || c.totalTasks === 0) {
        this._emit({ phase: 'D', ticker: null, done: 0, total: 0 }, true);
        const d = await phaseD(dbProxy, {
          onProgress: (info) => this._emit({ phase: 'D', done: info.current, total: info.total, ticker: info.ticker }),
        });
        derivedTickers = d.derivedTickers || d.tickers || 0;
      }

      const summary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        cancelled: c.cancelled,
        creditCapped: c.creditCapped,
        quotaExhausted: c.quotaExhausted,
        requestedTickers: scope.length,
        candlesBars: a.totalBars,
        daysFetched: c.done,
        totalTasks: c.totalTasks,
        daysFailed: c.failed,
        chainRows: c.totalRows,
        tickersFilled: c.filledTickers,
        derivedTickers,
        creditsUsed: client.creditsUsed,
        creditsRemaining: client.creditsRemaining,
      };
      this.lastSummary = summary;
      try {
        await this.database.setSetting('backfill.lastRun', JSON.stringify(summary));
      } catch (_) { /* status is best-effort */ }
      this._emit({ phase: 'done' }, true);
      return { success: true, ...summary };
    } catch (err) {
      console.error('[Backfill] Failed:', err.message);
      this._emit({ phase: 'error', error: err.message }, true);
      return { success: false, error: err.message };
    } finally {
      try { conn.close(); } catch (_) { /* ignore */ }
      this.running = false;
    }
  }
}

module.exports = { OptionsBackfillService, COVERAGE_PATH };
