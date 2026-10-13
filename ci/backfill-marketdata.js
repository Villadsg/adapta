#!/usr/bin/env node

/**
 * MarketData.app Historical Backfill
 *
 * One-time backfill of the screening dataset to a full year using the
 * MarketData.app API (Trader trial: 100k credits/day, 1y history):
 *
 *   Phase A — daily candles for all DB tickers + SPY → stock_prices (source='marketdata')
 *   Phase B — recompute stock_events over the full 1y window (shared algorithm
 *             with ci/ticker-screen.js)
 *   Phase C — full historical options chains per ticker-day → options_chain_history
 *             (raw, most granular form; no metrics computed here)
 *   Phase D — derive options_daily_iv from the raw chains and regenerate
 *             iv_history_records. IV is BSM-implied from raw prices
 *             (MarketData has no historical IV/greeks — prices only).
 *
 * Note: MarketData historical options data is as-traded (NOT split/dividend
 * adjusted). Fine for IV levels; be careful comparing raw strikes across
 * corporate actions.
 *
 * Usage:
 *   MARKET_DATA_API_KEY=... node ci/backfill-marketdata.js             # all phases A→D
 *   node ci/backfill-marketdata.js --phase=C                           # one phase only
 *   node ci/backfill-marketdata.js --phase=C --tickers=AAPL,QCOM       # subset
 *   node ci/backfill-marketdata.js --phase=A,C                         # comma list
 *   node ci/backfill-marketdata.js --phase=A,C --lookback=10           # short phase A window
 *   node ci/backfill-marketdata.js --maintenance                       # A(1y)+C+D + coverage report
 *
 * Cron recipe (options data maintenance, see ci/options-coverage.js):
 *   daily:   --phase=A,C --lookback=10   (refresh candles + new chain days)
 *   weekly:  --maintenance               (full year + IV re-derive + prune list)
 * Phase C is incremental: already-downloaded (ticker, date) pairs in
 * options_chain_history are skipped, no-data days are remembered in
 * ci/backfill-state.json, and tickers confirmed options-less by
 * ci/options-coverage.json are skipped entirely. Needs the articles.db
 * writer lock — skip quietly when the Electron app is holding it.
 */

const path = require('path');
require('dotenv').config({ path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')] });

const fs = require('fs');
const ArticleDatabase = require('../src/services/database');
const MarketDataClient = require('../src/services/marketDataClient');
const { computeEventsFromBars } = require('./ticker-screen.js');
const config = require('./config.json');

const DB_PATH = path.join(__dirname, '..', 'articles.db');
const STATE_PATH = path.join(__dirname, 'backfill-state.json');

const BENCHMARK = config.benchmark || 'SPY';
const PERCENTILE = config.screenPercentileThreshold ?? 92;
const LOOKBACK_DAYS = 370; // ~1 calendar year of trading days
// Not US-listed on MarketData (OTC ADR / Euronext) — keep Yahoo/IB path for these
const CHAIN_SKIP = new Set(['XIACY', 'AIR.PA']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = { phase: 'all', tickers: null, lookback: LOOKBACK_DAYS, maintenance: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--phase=')) args.phase = a.slice('--phase='.length).toUpperCase();
    if (a.startsWith('--tickers=')) {
      args.tickers = a.slice('--tickers='.length).split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }
    if (a.startsWith('--lookback=')) args.lookback = parseInt(a.slice('--lookback='.length), 10) || LOOKBACK_DAYS;
    if (a === '--maintenance') args.maintenance = true;
  }
  return args;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (_) { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function dateNDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// --- DB helpers (read side; writes go through database.js methods) ---

function dbAll(database, sql, ...params) {
  return new Promise((resolve, reject) => {
    database.connection.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function getBackfillTickers(database, override) {
  if (override) return override;
  const rows = await dbAll(database, 'SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker');
  return rows.map(r => r.ticker);
}

async function loadBars(database, ticker, source) {
  const rows = await dbAll(
    database,
    `SELECT date::TEXT AS d, open, high, low, close, volume
     FROM stock_prices WHERE ticker = $1 AND source = $2 ORDER BY date`,
    ticker, source
  );
  return rows
    .map(r => ({
      date: String(r.d).split(' ')[0],
      open: Number(r.open), high: Number(r.high), low: Number(r.low),
      close: Number(r.close), volume: Number(r.volume),
    }))
    .filter(b => b.open != null && b.close != null && b.volume != null && !isNaN(b.close));
}

// --- Phases ---

async function phaseA(client, database, tickers, lookbackDays = LOOKBACK_DAYS, opts = {}) {
  console.log(`\n=== Phase A: daily candles (${Math.round(lookbackDays / 7)}w) → stock_prices (source=marketdata) ===`);
  const from = dateNDaysAgo(lookbackDays);
  const to = today();
  // Gap-fill runs (in-app backfill) pass includeBenchmark:false — SPY candles
  // already exist there and the point is to backfill the requested tickers.
  const symbols = opts.includeBenchmark === false
    ? tickers.filter(t => t !== BENCHMARK)
    : [BENCHMARK, ...tickers.filter(t => t !== BENCHMARK)];

  let totalBars = 0;
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const bars = await client.fetchDailyCandles(sym, from, to);
      for (const b of bars) {
        await database.saveStockPrice(sym, b.date, {
          open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        }, 'marketdata');
      }
      totalBars += bars.length;
      console.log(`  [A] ${sym}: ${bars.length} bars (${i + 1}/${symbols.length})`);
    } catch (err) {
      console.error(`  [A] ${sym}: FAILED — ${err.message}`);
    }
    if (opts.onProgress) {
      opts.onProgress({ ticker: sym, done: i + 1, total: symbols.length, bars: totalBars });
    }
    await sleep(100);
  }
  console.log(`[A] Done. ${totalBars} bars, ~${client.creditsUsed} credits used so far.`);
  return { totalBars };
}

async function phaseB(database, tickers) {
  console.log('\n=== Phase B: recompute stock_events over the 1y window ===');

  const spyBars = await loadBars(database, BENCHMARK, 'marketdata');
  if (spyBars.length < 20) {
    throw new Error(`Not enough ${BENCHMARK} marketdata bars (${spyBars.length}) — run phase A first`);
  }
  const marketReturns = new Map();
  for (let j = 1; j < spyBars.length; j++) {
    marketReturns.set(spyBars[j].date, (spyBars[j].close - spyBars[j - 1].close) / spyBars[j - 1].close);
  }
  console.log(`  [B] ${BENCHMARK}: ${marketReturns.size} daily returns`);

  let totalEvents = 0;
  for (const ticker of tickers) {
    try {
      const bars = await loadBars(database, ticker, 'marketdata');
      if (bars.length < 20) {
        console.log(`  [B] ${ticker}: skipped (${bars.length} bars)`);
        continue;
      }
      const ev = computeEventsFromBars(bars, marketReturns, PERCENTILE);
      if (ev.products.length === 0) {
        console.log(`  [B] ${ticker}: skipped (no usable products)`);
        continue;
      }
      const startDate = ev.chartDates[0];
      const endDate = ev.chartDates[ev.chartDates.length - 1];
      const { saved } = await database.saveStockEvents(ticker, ev.dbEvents, BENCHMARK, startDate, endDate);
      totalEvents += saved;
      console.log(`  [B] ${ticker}: ${saved} events (R²=${ev.rSquared?.toFixed(3) ?? 'n/a'}, ${bars.length} bars)`);
    } catch (err) {
      console.error(`  [B] ${ticker}: FAILED — ${err.message}`);
    }
  }
  console.log(`[B] Done. ${totalEvents} events written.`);
}

async function phaseC(client, database, tickers, state, confirmedMissing = new Set(), opts = {}) {
  console.log('\n=== Phase C: raw historical options chains → options_chain_history ===');
  const existing = await database.getExistingChainDays();
  const noData = new Set(state.noDataDays || []);

  // Build the full task list first (skip benchmark + non-US tickers +
  // vendor-confirmed-options-less tickers + already-done days)
  const tasks = [];
  for (const ticker of tickers) {
    if (ticker === BENCHMARK || CHAIN_SKIP.has(ticker) || confirmedMissing.has(ticker)) continue;
    const bars = await loadBars(database, ticker, 'marketdata');
    for (const b of bars) {
      const key = `${ticker}|${b.date}`;
      if (!existing.has(key) && !noData.has(key)) tasks.push({ ticker, date: b.date, key });
    }
  }
  console.log(`  [C] ${tasks.length} ticker-days to fetch (${existing.size} already in DB, ${noData.size} known no-data)`);

  // Worker pool — API latency dominates, so modest concurrency cuts wall time a lot.
  // Retries/backoff in the client handle any 429s.
  const CONCURRENCY = 6;
  let idx = 0;
  let done = 0;
  let failed = 0;
  let totalRows = 0;
  let cancelled = false;
  let creditCapped = false;
  const filledTickers = new Set();

  async function worker() {
    while (idx < tasks.length) {
      if (opts.isCancelled?.()) { cancelled = true; idx = tasks.length; break; }
      const t = tasks[idx++];
      try {
        const { underlyingPrice, contracts } = await client.fetchHistoricalChain(t.ticker, t.date);
        if (contracts.length === 0) {
          noData.add(t.key);
        } else {
          const rows = contracts.map(c => ({
            ...c, ticker: t.ticker, date: t.date, underlyingPrice, source: 'marketdata',
          }));
          await database.saveChainRows(rows);
          existing.add(t.key);
          filledTickers.add(t.ticker);
          totalRows += rows.length;
        }
      } catch (err) {
        failed++;
        console.error(`  [C] ${t.ticker} ${t.date}: FAILED — ${err.message}`);
      }
      done++;
      if (opts.onProgress) {
        opts.onProgress({
          ticker: t.ticker, date: t.date, done, total: tasks.length, failed,
          rows: totalRows, creditsUsed: client.creditsUsed, creditsRemaining: client.creditsRemaining,
        });
      }
      if (opts.creditCap && client.creditsUsed >= opts.creditCap) {
        console.log(`  [C] credit cap reached (${client.creditsUsed} >= ${opts.creditCap}) — stopping; resume tomorrow`);
        creditCapped = true;
        idx = tasks.length;
        break;
      }
      if (done % 200 === 0) {
        state.noDataDays = [...noData];
        saveState(state);
        console.log(`  [C] ${done}/${tasks.length} days, ${totalRows} rows, ${failed} failed, ~${client.creditsUsed} credits`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  state.noDataDays = [...noData];
  saveState(state);
  console.log(`[C] Done. ${totalRows} contract rows, ${done} days, ${failed} failed, ~${client.creditsUsed} credits.`);
  return { done, failed, totalRows, filledTickers: [...filledTickers], cancelled, creditCapped, totalTasks: tasks.length };
}

// --- Black-Scholes implied vol -------------------------------------------------
// MarketData provides NO historical IV/greeks (prices only), so IV is computed
// here from raw contract prices via BSM inversion. A constant risk-free rate is
// fine: all downstream consumers (IV percentile ranks, IV spreads, TTM options
// channels) are relative measures, robust to small rate/ dividend simplifications.
const RISK_FREE_RATE = 0.045;

function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z));
  return 0.5 * (1 + erf);
}

function bsmPrice(side, S, K, T, r, sigma) {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const df = Math.exp(-r * T);
  return side === 'call'
    ? S * normCdf(d1) - K * df * normCdf(d2)
    : K * df * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * Implied volatility (decimal) via bisection. Returns null when the price is
 * outside no-arbitrage bounds (stale/mismatched prints).
 */
function impliedVol(side, price, S, K, T, r) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const df = Math.exp(-r * T);
  const intrinsic = side === 'call' ? Math.max(0, S - K * df) : Math.max(0, K * df - S);
  const upper = side === 'call' ? S : K * df;
  if (price < intrinsic - 1e-9 || price >= upper) return null;
  let lo = 1e-4, hi = 5;
  if (bsmPrice(side, S, K, T, r, hi) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsmPrice(side, S, K, T, r, mid) < price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Derive per-day IV data from the raw chain rows.
 * Returns { dbRows, history }:
 *   dbRows  — one options_daily_iv row per (ticker, date), exp1..exp3 aggregates
 *   history — {ticker: [records]} in the canonical IV-history record format
 *             (exp1..exp3, per-strike calls/puts, atmBand + deepOTM metrics),
 *             so derived records can fully replace live snapshots.
 *
 * Metric definitions mirror buildExpResult/weightedIV in ci/ticker-screen.js:
 *   - exp1..3   = nearest expirations for that day
 *   - w*_iv     = dollar-volume-weighted BSM IV (%) over OTM contracts
 *                 (calls: strike >= 1.015×spot; puts: strike <= 0.985×spot),
 *                 dv = volume × last × 100, only contracts with dv>0 and a
 *                 computable IV (volume>0 ⇒ last is that day's trade, matching
 *                 the live fresh-trade filter)
 *   - atm_*_iv  = same weighting over the near-ATM band (0.985–1.015×spot)
 *   - atmBand_* = same weighting over the complement band (calls < 1.015×spot,
 *                 puts > 0.985×spot)
 *   - deepOTM*  = % of OTM-set dollar volume in strikes >10% OTM
 *   - *_dv      = total dollar volume over the OTM sets
 */
async function deriveDailyIVRows(database, opts = {}) {
  // Optional subset: derive only these tickers (in-app backfill fills gaps for
  // a few tickers at a time — no need to re-derive the whole universe).
  const wanted = Array.isArray(opts.tickers) && opts.tickers.length > 0 ? new Set(opts.tickers) : null;
  const days = await dbAll(
    database,
    'SELECT DISTINCT ticker, date::TEXT AS d FROM options_chain_history ORDER BY ticker, date'
  );
  // Group by ticker so bars (for dailyReturn) load once per ticker
  const byTicker = new Map();
  for (const { ticker, d } of days) {
    if (wanted && !wanted.has(ticker)) continue;
    const date = String(d).split(' ')[0];
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push(date);
  }

  const dbRows = [];
  const history = {};
  let processed = 0;
  let tickersDone = 0;
  for (const [ticker, tickerDays] of byTicker) {
    const bars = await loadBars(database, ticker, 'marketdata');
    const barIdx = new Map(bars.map((b, i) => [b.date, i]));

    for (const date of tickerDays) {
      const contracts = await dbAll(
        database,
        `SELECT expiration_date::TEXT AS exp, side, strike, last_price, volume, underlying_price
         FROM options_chain_history
         WHERE ticker = $1 AND date = $2 AND volume > 0 AND last_price > 0 AND underlying_price > 0`,
        ticker, date
      );
      processed++;
      if (contracts.length === 0) continue;

      const S = Number(contracts[0].underlying_price);
      const byExp = new Map();
      for (const c of contracts) {
        const exp = String(c.exp).split(' ')[0];
        const K = Number(c.strike);
        const last = Number(c.last_price);
        const dv = Number(c.volume) * last * 100;
        const T = Math.max((new Date(exp) - new Date(date)) / (365 * 86400000), 1 / 365);
        const iv = impliedVol(c.side, last, S, K, T, RISK_FREE_RATE);
        const ivPct = iv != null ? iv * 100 : null;
        const usable = ivPct != null && dv > 0;
        let e = byExp.get(exp);
        if (!e) {
          e = {
            exp, wcN: 0, wcD: 0, wpN: 0, wpD: 0, acN: 0, acD: 0, apN: 0, apD: 0,
            callDV: 0, putDV: 0, callList: [], putList: [],
            bcN: 0, bcD: 0, bcDV: 0, bpN: 0, bpD: 0, bpDV: 0,
            deepCallDV: 0, deepPutDV: 0,
          };
          byExp.set(exp, e);
        }
        if (c.side === 'call') {
          if (K < S * 1.015) {
            e.bcDV += dv;
            if (usable) { e.bcN += ivPct * dv; e.bcD += dv; }
          }
          if (K >= S * 0.985 && K <= S * 1.015 && usable) { e.acN += ivPct * dv; e.acD += dv; }
          if (K >= S * 1.015) {
            e.callDV += dv;
            e.callList.push({ strike: K, dv: Math.round(dv), iv: usable ? Math.round(ivPct * 10) / 10 : 0 });
            if (usable) { e.wcN += ivPct * dv; e.wcD += dv; }
            if (K >= S * 1.10) e.deepCallDV += dv;
          }
        } else {
          if (K > S * 0.985) {
            e.bpDV += dv;
            if (usable) { e.bpN += ivPct * dv; e.bpD += dv; }
          }
          if (K >= S * 0.985 && K <= S * 1.015 && usable) { e.apN += ivPct * dv; e.apD += dv; }
          if (K <= S * 0.985) {
            e.putDV += dv;
            e.putList.push({ strike: K, dv: Math.round(dv), iv: usable ? Math.round(ivPct * 10) / 10 : 0 });
            if (usable) { e.wpN += ivPct * dv; e.wpD += dv; }
            if (K <= S * 0.90) e.deepPutDV += dv;
          }
        }
      }

      const exps = [...byExp.values()].sort((a, b) => (a.exp < b.exp ? -1 : 1));

      // DB row (exp1..exp3 aggregates)
      const row = {
        ticker, date, source: 'derived-bsm',
        exp1_label: null, exp1_call_iv: null, exp1_put_iv: null,
        exp1_atm_call_iv: null, exp1_atm_put_iv: null, exp1_call_dv: null, exp1_put_dv: null,
        exp2_label: null, exp2_call_iv: null, exp2_put_iv: null,
        exp2_atm_call_iv: null, exp2_atm_put_iv: null, exp2_call_dv: null, exp2_put_dv: null,
        exp3_label: null, exp3_call_iv: null, exp3_put_iv: null,
        exp3_atm_call_iv: null, exp3_atm_put_iv: null, exp3_call_dv: null, exp3_put_dv: null,
      };
      const fill = (e, p) => {
        row[`${p}_label`] = e.exp;
        row[`${p}_call_iv`] = e.wcD > 0 ? e.wcN / e.wcD : null;
        row[`${p}_put_iv`] = e.wpD > 0 ? e.wpN / e.wpD : null;
        row[`${p}_atm_call_iv`] = e.acD > 0 ? e.acN / e.acD : null;
        row[`${p}_atm_put_iv`] = e.apD > 0 ? e.apN / e.apD : null;
        row[`${p}_call_dv`] = e.callDV;
        row[`${p}_put_dv`] = e.putDV;
      };
      if (exps[0]) fill(exps[0], 'exp1');
      if (exps[1]) fill(exps[1], 'exp2');
      if (exps[2]) fill(exps[2], 'exp3');
      dbRows.push(row);

      // JSON record (full live format, exp1..exp3)
      const record = { date, source: 'marketdata-derived' };
      const bi = barIdx.get(date);
      if (bi != null && bi >= 1) {
        const c0 = bars[bi - 1].close, c1 = bars[bi].close;
        if (c0 > 0) record.dailyReturn = ((c1 - c0) / c0) * 100;
      }
      if (exps[0]) record.exp1 = buildDerivedExpRecord(exps[0]);
      if (exps[1]) record.exp2 = buildDerivedExpRecord(exps[1]);
      if (exps[2]) record.exp3 = buildDerivedExpRecord(exps[2]);
      if (!history[ticker]) history[ticker] = [];
      history[ticker].push(record);

      if (processed % 2000 === 0) {
        console.log(`  [D] derived ${processed}/${days.length} ticker-days`);
      }
    }
    tickersDone++;
    if (opts.onProgress) opts.onProgress({ ticker, current: tickersDone, total: byTicker.size });
  }
  return { dbRows, history };
}

/**
 * Build one expiration record in the canonical IV-history format
 * (mirrors buildExpRecord in ci/ticker-screen.js + buildExpRecord in main.js).
 */
function buildDerivedExpRecord(e) {
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const w = (n, d) => (d > 0 ? n / d : null);
  const callDV = Math.round(e.callDV), putDV = Math.round(e.putDV);
  return {
    label: e.exp,
    callIV: r1(w(e.wcN, e.wcD)),
    putIV: r1(w(e.wpN, e.wpD)),
    atmCallIV: r1(w(e.acN, e.acD)),
    atmPutIV: r1(w(e.apN, e.apD)),
    atmBandCallIV: r1(w(e.bcN, e.bcD)),
    atmBandPutIV: r1(w(e.bpN, e.bpD)),
    atmCallDV: Math.round(e.bcDV),
    atmPutDV: Math.round(e.bpDV),
    deepOTMCallPct: e.callDV > 0 ? Math.round((e.deepCallDV / e.callDV) * 1000) / 10 : 0,
    deepOTMPutPct: e.putDV > 0 ? Math.round((e.deepPutDV / e.putDV) * 1000) / 10 : 0,
    callDV, putDV, dv: callDV + putDV,
    calls: e.callList,
    puts: e.putList,
  };
}

async function phaseD(database, opts = {}) {
  console.log('\n=== Phase D: derive options_daily_iv + iv_history_records (BSM) ===');
  // Subset mode: re-derive and replace only these tickers (in-app backfill).
  // Without opts.tickers the behavior is the historical full-table rebuild.
  const subset = Array.isArray(opts.tickers) && opts.tickers.length > 0 ? opts.tickers : null;
  if (subset) console.log(`  [D] subset: ${subset.length} ticker${subset.length === 1 ? '' : 's'}`);
  const { dbRows, history } = await deriveDailyIVRows(database, { tickers: subset, onProgress: opts.onProgress });
  if (subset) await database.clearDailyIVForTickers(subset);
  else await database.clearDailyIV();
  const written = await database.saveDailyIVRows(dbRows);
  console.log(`  [D] options_daily_iv: ${written} rows derived (BSM-implied IV)`);

  // Rebuild iv_history_records. FULL OVERWRITE per backfilled ticker: derived
  // records replace all prior snapshots, giving one uniform BSM methodology
  // across the whole history. Tickers MarketData can't cover (XIACY, AIR.PA,
  // INTL, …) keep their existing rows untouched. Sectors are carried over from
  // the rows being replaced. Note: eventTags on replaced rows are dropped
  // (tags are re-attached by future screening runs).
  const replacedTickers = Object.keys(history);
  const existing = await database.getIVHistoryRecords();
  const sectorByTicker = {};
  for (const [ticker, records] of Object.entries(existing)) {
    if (!Array.isArray(records)) continue;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].sector) { sectorByTicker[ticker] = records[i].sector; break; }
    }
  }

  let replaced = 0;
  for (const [ticker, records] of Object.entries(history)) {
    const sector = sectorByTicker[ticker];
    for (const r of records) {
      if (sector) r.sector = sector;
      r.source = 'derived-bsm';
    }
    replaced += records.length;
  }

  await database.clearIVHistoryForTickers(replacedTickers);
  await database.saveIVHistoryRecords(history);
  console.log(`[D] Done. ${replaced} derived records written to iv_history_records; ${replacedTickers.length} tickers fully replaced.`);
}

async function main() {
  const args = parseArgs();
  if (args.maintenance) args.phase = 'A,C,D';
  const phases = args.phase === 'all' ? ['A', 'B', 'C', 'D'] : args.phase.split(',').map(p => p.trim()).filter(Boolean);

  const database = new ArticleDatabase(DB_PATH);
  try {
    await database.initialize();
  } catch (err) {
    // DuckDB allows a single writer: the Electron app holds articles.db while
    // it is open. Cron runs should skip quietly and let the next run try again.
    if (/lock/i.test(err.message || '')) {
      console.error(`[${new Date().toISOString()}] articles.db is locked (app open?) — skipping this run.`);
      process.exit(0);
    }
    throw err;
  }

  const needsApi = phases.some(p => p === 'A' || p === 'C');
  const apiKey = process.env.MARKETDATA_API_KEY || process.env.MARKET_DATA_API_KEY;
  const client = needsApi ? new MarketDataClient(apiKey) : null;

  const tickers = await getBackfillTickers(database, args.tickers);
  console.log(`Backfill phases: ${phases.join(',')} | tickers: ${tickers.length} | percentile: p${PERCENTILE}`);

  // Tickers ci/options-coverage.json confirmed options-less: the vendor has
  // returned zero chains for them repeatedly, so stop spending credits.
  let confirmedMissing = new Set();
  try {
    const coverage = JSON.parse(fs.readFileSync(path.join(__dirname, 'options-coverage.json'), 'utf-8'));
    confirmedMissing = new Set(coverage.skip_tickers || []);
    if (confirmedMissing.size) console.log(`Skipping ${confirmedMissing.size} vendor-confirmed options-less tickers: ${[...confirmedMissing].join(', ')}`);
  } catch (_) { /* no coverage report yet — first run classifies everything as pending */ }

  const state = loadState();
  try {
    for (const p of phases) {
      if (p === 'A') await phaseA(client, database, tickers, args.lookback);
      else if (p === 'B') await phaseB(database, tickers);
      else if (p === 'C') await phaseC(client, database, tickers, state, confirmedMissing);
      else if (p === 'D') await phaseD(database);
      else throw new Error(`Unknown phase: ${p}`);
    }
    if (args.maintenance) {
      const { writeCoverageReport, printReport } = require('./options-coverage');
      printReport(await writeCoverageReport(database, state));
    }
  } finally {
    try { database.db?.close(); } catch (_) { /* ignore */ }
  }
}

// Phases and helpers are importable so the Electron app can run C+D in-process
// (it already owns the articles.db writer lock; the CLI cannot run while the
// app is open). The CLI entry point below is unchanged.
module.exports = {
  phaseA, phaseB, phaseC, phaseD, deriveDailyIVRows,
  loadState, saveState, getBackfillTickers, loadBars,
  BENCHMARK, CHAIN_SKIP, LOOKBACK_DAYS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
