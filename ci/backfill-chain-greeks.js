#!/usr/bin/env node
/**
 * Backfill per-contract IV + greeks into options_chain_history.
 *
 * The marketdata backfill (ci/backfill-marketdata.js) only derived the
 * aggregate options_daily_iv / iv_history_records tables — the per-contract
 * iv/delta/gamma/theta/vega columns in options_chain_history are all NULL.
 * This script fills them in with BSM: implied vol via bisection on the
 * contract price, greeks evaluated analytically at the solved vol.
 *
 * Conventions (mirror deriveDailyIVRows in ci/backfill-marketdata.js):
 *   - price source: mid (populated for every row), fallback last_price
 *   - T = max((expiration - date) / 365, 1/365) years
 *   - r = 0.045 constant
 *   - iv stored as annualized decimal (matching MarketData live-chain semantics)
 *   - delta/gamma raw; vega per 1 vol point (S·φ(d1)·√T / 100);
 *     theta per calendar day (annual theta / 365)
 *   - rows whose price is outside no-arbitrage bounds keep NULL iv/greeks
 *
 * Usage:
 *   node ci/backfill-chain-greeks.js              # full backfill
 *   TICKER=MU node ci/backfill-chain-greeks.js    # one ticker (testing)
 * Resume-safe: (ticker, date) chunks where iv is already populated are skipped.
 */
const path = require('path');
const duckdb = require('duckdb');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const DB_PATH = process.env.DUCKDB_PATH || path.join(__dirname, '..', 'articles.db');
const ONLY_TICKER = process.env.TICKER || null;
const RISK_FREE_RATE = 0.045;

// --- BSM (same math as ci/backfill-marketdata.js) ------------------------------
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z));
  return 0.5 * (1 + erf);
}
const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function bsmPrice(side, S, K, T, r, sigma) {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const df = Math.exp(-r * T);
  return side === 'call'
    ? S * normCdf(d1) - K * df * normCdf(d2)
    : K * df * normCdf(-d2) - S * normCdf(-d1);
}

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

function greeks(side, S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const delta = side === 'call' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S * sigma * sqrtT);
  const vega = (S * pdf * sqrtT) / 100;
  const thetaAnnual = side === 'call'
    ? -(S * pdf * sigma) / (2 * sqrtT) - r * K * df * normCdf(d2)
    : -(S * pdf * sigma) / (2 * sqrtT) + r * K * df * normCdf(-d2);
  return { delta, gamma, vega, theta: thetaAnnual / 365 };
}

// --- DB helpers ----------------------------------------------------------------
const db = new duckdb.Database(DB_PATH);
const conn = db.connect();
const run = (sql, ...params) =>
  new Promise((resolve, reject) => conn.run(sql, ...params, (e) => (e ? reject(e) : resolve())));
const all = (sql, ...params) =>
  new Promise((resolve, reject) => conn.all(sql, ...params, (e, rows) => (e ? reject(e) : resolve(rows))));

async function main() {
  const tickerFilter = ONLY_TICKER ? `AND ticker = '${ONLY_TICKER.replace(/'/g, "''")}'` : '';
  const days = await all(
    `SELECT ticker, date::TEXT AS d FROM options_chain_history
     WHERE iv IS NULL ${tickerFilter}
     GROUP BY ticker, date ORDER BY ticker, date`
  );
  console.log(`[greeks] ${days.length} (ticker, date) chunks to backfill`);

  await run(`CREATE TEMP TABLE greeks_tmp (
    ticker VARCHAR, date DATE, option_symbol VARCHAR,
    iv DOUBLE, delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE)`);

  let done = 0, solved = 0, skipped = 0;
  const t0 = Date.now();
  for (const { ticker, d } of days) {
    const date = String(d).split(' ')[0];
    const rows = await all(
      `SELECT option_symbol, expiration_date::TEXT AS exp, side, strike,
              mid, last_price, underlying_price
       FROM options_chain_history WHERE ticker = $1 AND date = $2`,
      ticker, date
    );

    const results = [];
    for (const c of rows) {
      const S = Number(c.underlying_price);
      const K = Number(c.strike);
      const price = Number(c.mid) > 0 ? Number(c.mid) : Number(c.last_price);
      const exp = String(c.exp).split(' ')[0];
      const T = Math.max((new Date(exp) - new Date(date)) / (365 * 86400000), 1 / 365);
      const iv = impliedVol(c.side, price, S, K, T, RISK_FREE_RATE);
      if (iv == null) { skipped++; continue; }
      const g = greeks(c.side, S, K, T, RISK_FREE_RATE, iv);
      results.push([ticker, date, c.option_symbol, iv, g.delta, g.gamma, g.theta, g.vega]);
      solved++;
    }

    if (results.length) {
      // Insert in sub-batches: spreading thousands of params into conn.run
      // overflows the call stack.
      for (let i = 0; i < results.length; i += 400) {
        const batch = results.slice(i, i + 400);
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        await run(`INSERT INTO greeks_tmp VALUES ${placeholders}`, ...batch.flat());
      }
      await run(
        `UPDATE options_chain_history o
         SET iv = g.iv, delta = g.delta, gamma = g.gamma, theta = g.theta, vega = g.vega
         FROM greeks_tmp g
         WHERE o.ticker = g.ticker AND o.date = g.date AND o.option_symbol = g.option_symbol`
      );
      await run('DELETE FROM greeks_tmp');
    }

    done++;
    if (done % 250 === 0 || done === days.length) {
      const rate = Math.round(done / ((Date.now() - t0) / 1000));
      console.log(`[greeks] ${done}/${days.length} chunks (${rate}/s), solved ${solved}, unsolvable ${skipped}`);
    }
  }
  console.log(`[greeks] Done. solved ${solved} contracts, unsolvable ${skipped}.`);
  db.close();
}

main().catch((err) => {
  console.error('[greeks] failed:', err);
  process.exit(1);
});
