#!/usr/bin/env node

/**
 * Options coverage classifier.
 *
 * Answers "which tickers are genuinely options-less (prune candidates)?" vs
 * "which just haven't been backfilled yet?", so universe pruning never runs on
 * a data hole. Also produces the skip list phase C uses to stop wasting API
 * credits re-asking the vendor about tickers it has already rejected.
 *
 * Classification per ticker in the universe (DISTINCT ticker FROM stock_prices):
 *
 *   covered          — has chain days and the newest chain day is recent
 *   stale            — has chain days but the newest is older than STALE_DAYS
 *   confirmed_missing— zero chain days, enough price bars to prove the ticker
 *                      actively trades, and the vendor answered "no chains" on
 *                      at least MIN_NO_DATA_DAYS distinct trading days.
 *                      These are real prune candidates (foreign listings,
 *                      OTC, delisted…).
 *   pending_backfill — everything else with no chains yet (usually tickers
 *                      that entered the universe after the last phase C run).
 *                      NOT optionless — just unfetched.
 *   skipped          — benchmark + CHAIN_SKIP tickers phase C never asks about
 *                      (no chains possible); excluded from pending_backfill so
 *                      the UI banner only lists fixable gaps.
 *
 * Output: ci/options-coverage.json (summary + per-class ticker lists).
 *
 * Usage:
 *   node ci/options-coverage.js                 # classify + write report
 *   OPTIONS_COVERAGE_MIN_NO_DATA_DAYS=3 ...     # thresholds are env-tunable
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'backfill-state.json');
const COVERAGE_PATH = path.join(__dirname, 'options-coverage.json');

// A ticker needs this many price bars before we trust "vendor says no chains"
// as a real answer rather than a ticker nobody asked about yet.
const MIN_CONFIRM_BARS = parseInt(process.env.OPTIONS_COVERAGE_MIN_BARS || '20', 10);
// And at least this many distinct trading days where the vendor returned zero
// contracts (guards against a single transient API glitch flagging a ticker).
const MIN_NO_DATA_DAYS = parseInt(process.env.OPTIONS_COVERAGE_MIN_NO_DATA_DAYS || '3', 10);
// Chain data older than this is flagged stale (phase C fixes it on next run).
const STALE_DAYS = parseInt(process.env.OPTIONS_COVERAGE_STALE_DAYS || '14', 10);

function dbAll(database, sql, ...params) {
  return new Promise((resolve, reject) => {
    database.connection.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (_) { return {}; }
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

/**
 * Classify every universe ticker.
 * @param {Object} database - initialized ArticleDatabase
 * @param {Object} [state] - parsed backfill-state.json (loaded if omitted)
 * @returns {Promise<Object>} coverage report (also written to options-coverage.json)
 */
async function computeCoverage(database, state) {
  state = state || loadState();
  const noDataCount = new Map();
  for (const entry of state.noDataDays || []) {
    const ticker = String(entry).split('|')[0];
    noDataCount.set(ticker, (noDataCount.get(ticker) || 0) + 1);
  }

  const universe = await dbAll(database,
    'SELECT ticker, COUNT(*)::INT AS bars FROM stock_prices GROUP BY ticker ORDER BY ticker');
  const chains = await dbAll(database,
    `SELECT ticker, COUNT(DISTINCT date)::INT AS days, MAX(date)::TEXT AS last_day
     FROM options_chain_history GROUP BY ticker`);
  const chainByTicker = new Map(chains.map(r => [r.ticker, r]));

  const covered = [], stale = [], pendingBackfill = [], confirmedMissing = [];
  const skipped = [];
  const staleCutoff = daysAgoISO(STALE_DAYS);

  // Phase C deliberately never requests chains for the benchmark and the
  // CHAIN_SKIP OTC/foreign tickers. Listing them as "pending backfill" made
  // the UI backfill banner show permanently unfixable gaps. Lazily required —
  // backfill-marketdata only pulls this module in for --maintenance, so there
  // is no require cycle.
  const { BENCHMARK, CHAIN_SKIP, excludedTickers } = require('./backfill-marketdata');
  const userExcluded = excludedTickers();

  for (const { ticker, bars } of universe) {
    const chain = chainByTicker.get(ticker);
    const noDataDays = noDataCount.get(ticker) || 0;
    if (userExcluded.has(ticker)) {
      skipped.push({ ticker, bars, reason: 'excluded' });
    } else if (ticker === BENCHMARK || CHAIN_SKIP.has(ticker)) {
      skipped.push({ ticker, bars, reason: ticker === BENCHMARK ? 'benchmark' : 'chain-skip' });
    } else if (chain && chain.days > 0) {
      if (chain.last_day < staleCutoff) {
        stale.push({ ticker, days: chain.days, last_day: chain.last_day });
      } else {
        covered.push({ ticker, days: chain.days, last_day: chain.last_day });
      }
    } else if (noDataDays >= MIN_NO_DATA_DAYS && bars >= MIN_CONFIRM_BARS) {
      confirmedMissing.push({ ticker, no_data_days: noDataDays });
    } else {
      pendingBackfill.push({ ticker, no_data_days: noDataDays, bars });
    }
  }

  const report = {
    generated: new Date().toISOString(),
    universe: universe.length,
    covered: covered.length,
    stale: stale.length,
    pending_backfill: pendingBackfill.length,
    confirmed_missing: confirmedMissing.length,
    skipped: skipped.length,
    thresholds: {
      min_confirm_bars: MIN_CONFIRM_BARS,
      min_no_data_days: MIN_NO_DATA_DAYS,
      stale_days: STALE_DAYS,
    },
    // Phase C skips these — the vendor already said no, repeatedly.
    skip_tickers: confirmedMissing.map(r => r.ticker),
    details: { covered, stale, pending_backfill: pendingBackfill,
               confirmed_missing: confirmedMissing, skipped },
  };
  return report;
}

async function writeCoverageReport(database, state) {
  const report = await computeCoverage(database, state);
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function printReport(report) {
  console.log(`\n[coverage] universe: ${report.universe} tickers — ` +
    `${report.covered} covered, ${report.stale} stale, ` +
    `${report.pending_backfill} pending backfill, ${report.confirmed_missing} confirmed options-less`);
  const names = (arr, n = 12) => arr.slice(0, n).map(r => r.ticker).join(', ') + (arr.length > n ? ', …' : '');
  if (report.confirmed_missing > 0) {
    console.log(`[coverage] PRUNE candidates (vendor returned no chains on ≥${report.thresholds.min_no_data_days} days): ` +
      names(report.details.confirmed_missing));
  }
  if (report.pending_backfill > 0) {
    console.log(`[coverage] NOT optionless, just never fetched — run phase C: ` +
      names(report.details.pending_backfill));
  }
  if (report.stale > 0) {
    console.log(`[coverage] stale (last chain day >${report.thresholds.stale_days}d old): ` +
      names(report.details.stale));
  }
  console.log(`[coverage] report written to ${COVERAGE_PATH}`);
}

async function main() {
  const ArticleDatabase = require('../src/services/database');
  const DB_PATH = path.join(__dirname, '..', 'articles.db');
  const database = new ArticleDatabase(DB_PATH);
  try {
    await database.initialize();
  } catch (err) {
    if (/lock/i.test(err.message || '')) {
      console.error('articles.db is locked (Electron app open?) — close the app and retry.');
      process.exit(0);
    }
    throw err;
  }
  try {
    const report = await writeCoverageReport(database);
    printReport(report);
  } finally {
    try { database.db?.close(); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { computeCoverage, writeCoverageReport, printReport, COVERAGE_PATH };
