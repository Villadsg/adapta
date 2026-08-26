#!/usr/bin/env node
/**
 * DataApiServer — read-only HTTP access to the DuckDB store (articles.db).
 *
 * Intended to run on the machine that holds articles.db, behind the
 * Cloudflare tunnel (e.g. data.manzanaresgate.com -> localhost:8788), so a
 * laptop with a fresh git clone can run analysis over HTTPS without copying
 * the 2.9 GB database.
 *
 * Auth: shared bearer token (env DATA_API_TOKEN, required).
 * Config: DATA_API_PORT (default 8788), DATA_API_HOST (default 127.0.0.1 —
 * cloudflared proxies to it, so it should not bind publicly on its own),
 * DUCKDB_PATH (default ./articles.db).
 *
 * Endpoints:
 *   GET  /health                                  -> { ok, db }
 *   GET  /tickers                                 -> { rows: [{ ticker, rows, first, last }] }
 *   GET  /chain?ticker=MU[&date=YYYY-MM-DD][&expiration=YYYY-MM-DD][&side=call|put]
 *   GET  /daily-iv?ticker=MU[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
 *   GET  /iv-history?ticker=MU[&from=...][&to=...]
 *   POST /query  { "sql": "SELECT ..." }          -> read-only SQL (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN)
 * All JSON responses: { rows: [...] } or { error: "..." }.
 */
const http = require('http');
const path = require('path');
const duckdb = require('duckdb');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const PORT = parseInt(process.env.DATA_API_PORT || '8788', 10);
const HOST = process.env.DATA_API_HOST || '127.0.0.1';
const DB_PATH = process.env.DUCKDB_PATH || path.join(__dirname, '..', '..', 'articles.db');
const TOKEN = process.env.DATA_API_TOKEN;
const MAX_ROWS = 50000;

if (!TOKEN) {
  console.error('[DataApi] DATA_API_TOKEN is required (set it in .env.local). Refusing to start.');
  process.exit(1);
}

const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
const conn = db.connect();

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// BigInt-safe JSON (DuckDB COUNT(*) etc. come back as BigInt).
function toJsonSafe(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function send(res, status, body) {
  const payload = JSON.stringify(toJsonSafe(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Za-z0-9.\-]{1,10}$/;

function badDate(v) { return v && !DATE_RE.test(v); }
function badTicker(v) { return v && !TICKER_RE.test(v); }

const READONLY_SQL_RE = /^\s*(select|with|show|describe|explain)\b/i;
function isReadOnlySql(sql) {
  if (!READONLY_SQL_RE.test(sql)) return false;
  // No multiple statements (a single trailing ';' is fine).
  const stripped = sql.replace(/;+\s*$/, '');
  return !stripped.includes(';');
}

const routes = {
  'GET /health': async () => ({ ok: true, db: path.basename(DB_PATH) }),

  'GET /tickers': async () => ({
    rows: await runQuery(
      `SELECT ticker, count(*) AS rows, min(date) AS first, max(date) AS last
       FROM options_chain_history GROUP BY ticker ORDER BY ticker`
    ),
  }),

  'GET /chain': async (params) => {
    const ticker = params.get('ticker');
    if (!ticker || badTicker(ticker)) return { status: 400, body: { error: 'valid ticker is required' } };
    const date = params.get('date');
    const expiration = params.get('expiration');
    const side = params.get('side');
    if (badDate(date) || badDate(expiration)) return { status: 400, body: { error: 'dates must be YYYY-MM-DD' } };
    if (side && !['call', 'put'].includes(side)) return { status: 400, body: { error: 'side must be call|put' } };

    const where = ['ticker = ?'];
    const args = [ticker.toUpperCase()];
    if (date) { where.push('date = ?'); args.push(date); }
    if (expiration) { where.push('expiration_date = ?'); args.push(expiration); }
    if (side) { where.push('side = ?'); args.push(side); }
    const limit = Math.min(parseInt(params.get('limit') || String(MAX_ROWS), 10) || MAX_ROWS, MAX_ROWS);

    return {
      rows: await runQuery(
        `SELECT * FROM options_chain_history WHERE ${where.join(' AND ')}
         ORDER BY date, expiration_date, strike LIMIT ${limit}`,
        args
      ),
    };
  },

  'GET /daily-iv': async (params) => {
    const ticker = params.get('ticker');
    if (badTicker(ticker)) return { status: 400, body: { error: 'invalid ticker' } };
    const from = params.get('from');
    const to = params.get('to');
    if (badDate(from) || badDate(to)) return { status: 400, body: { error: 'dates must be YYYY-MM-DD' } };

    const where = [];
    const args = [];
    if (ticker) { where.push('ticker = ?'); args.push(ticker.toUpperCase()); }
    if (from) { where.push('date >= ?'); args.push(from); }
    if (to) { where.push('date <= ?'); args.push(to); }
    const sql = `SELECT * FROM options_daily_iv ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ticker, date LIMIT ${MAX_ROWS}`;
    return { rows: await runQuery(sql, args) };
  },

  'GET /iv-history': async (params) => {
    const ticker = params.get('ticker');
    if (badTicker(ticker)) return { status: 400, body: { error: 'invalid ticker' } };
    const from = params.get('from');
    const to = params.get('to');
    if (badDate(from) || badDate(to)) return { status: 400, body: { error: 'dates must be YYYY-MM-DD' } };

    const where = [];
    const args = [];
    if (ticker) { where.push('ticker = ?'); args.push(ticker.toUpperCase()); }
    if (from) { where.push('date >= ?'); args.push(from); }
    if (to) { where.push('date <= ?'); args.push(to); }
    const sql = `SELECT ticker, date, sector, daily_return, event_tags, record, source
                 FROM iv_history_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ticker, date LIMIT ${MAX_ROWS}`;
    return { rows: await runQuery(sql, args) };
  },
};

async function handleQueryEndpoint(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) return send(res, 413, { error: 'request body too large' });
  }
  let sql;
  try {
    sql = JSON.parse(body).sql;
  } catch {
    return send(res, 400, { error: 'body must be JSON: { "sql": "..." }' });
  }
  if (typeof sql !== 'string' || !isReadOnlySql(sql)) {
    return send(res, 400, { error: 'only single read-only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed' });
  }
  try {
    const rows = await runQuery(sql);
    send(res, 200, { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    if (key === 'POST /query') return await handleQueryEndpoint(req, res);

    const route = routes[key];
    if (!route) return send(res, 404, { error: 'not found' });

    const result = await route(url.searchParams);
    send(res, result.status || 200, result.body || result);
  } catch (err) {
    console.error('[DataApi] error:', err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[DataApi] serving ${DB_PATH} (read-only) on http://${HOST}:${PORT}`);
  console.log('[DataApi] point cloudflared at this origin, e.g. data.manzanaresgate.com -> http://127.0.0.1:' + PORT);
});
