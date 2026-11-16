/**
 * UpcomingEvents — scrapes the next earnings date per ticker.
 *
 * Source: stockanalysis.com overview page, which embeds an "Earnings Date"
 * row in plain server-rendered HTML (no JS needed to read it). Requests go
 * through Electron's `net` module so they use the same Chromium network
 * stack (TLS fingerprint, HTTP/2, compression) as the app's browser windows.
 *
 * Results are cached in-process: successes for 12h, failures for 1h, so a
 * screening re-run minutes later doesn't re-hit the site.
 */

const CACHE_TTL_OK = 12 * 60 * 60 * 1000;
const CACHE_TTL_ERR = 1 * 60 * 60 * 1000;
const cache = new Map(); // ticker -> { value, expiresAt }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

function fetchWithTimeout(url, timeoutMs) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.setHeader('User-Agent', HEADERS['User-Agent']);
    req.setHeader('Accept', HEADERS['Accept']);
    req.setHeader('Accept-Language', HEADERS['Accept-Language']);
    req.end();
  });
}

// The page renders e.g. `Earnings Date</td><td class="...">Nov 2` (optionally
// followed by ", 2026" when the year is explicit, or "TBD"/"-" when unknown).
function parseEarningsDate(html) {
  const m = html.match(/Earnings Date<\/td><td[^>]*>([^<]{1,40})</);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || /^(tbd|n\/?a|-)$/i.test(raw)) return { label: raw || 'TBD' };
  const dm = raw.match(/^([A-Z][a-z]{2})\s+(\d{1,2})(?:,?\s*(\d{4}))?/);
  if (!dm) return null;
  const month = MONTHS.indexOf(dm[1]);
  const day = parseInt(dm[2], 10);
  if (month < 0 || !day) return null;
  const now = new Date();
  if (dm[3]) {
    const d = new Date(parseInt(dm[3], 10), month, day);
    return { date: d, label: raw };
  }
  // No year given: pick the nearest upcoming occurrence of this month/day.
  let year = now.getFullYear();
  let d = new Date(year, month, day);
  if (d.getTime() < now.getTime() - 45 * 24 * 60 * 60 * 1000) d = new Date(++year, month, day);
  return { date: d, label: raw };
}

async function fetchTicker(ticker, timeoutMs) {
  const url = `https://stockanalysis.com/stocks/${encodeURIComponent(ticker.toLowerCase())}/`;
  const html = await fetchWithTimeout(url, timeoutMs);
  const parsed = parseEarningsDate(html);
  if (!parsed) throw new Error('no earnings date found');
  const out = { source: 'stockanalysis.com', url };
  if (parsed.date) {
    const d = parsed.date;
    const pad = (n) => String(n).padStart(2, '0');
    out.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    out.label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    out.daysUntil = Math.round((parsed.date.getTime() - Date.now()) / 86400000);
  } else {
    out.label = parsed.label;
  }
  return out;
}

async function fetchUpcomingEvents(tickers, { concurrency = 8, timeoutMs = 12000 } = {}) {
  const result = {};
  const pending = tickers.slice();
  async function worker() {
    while (pending.length) {
      const t = pending.shift();
      const hit = cache.get(t);
      if (hit && hit.expiresAt > Date.now()) {
        if (hit.value) result[t] = hit.value;
        continue;
      }
      try {
        const value = await fetchTicker(t, timeoutMs);
        cache.set(t, { value, expiresAt: Date.now() + CACHE_TTL_OK });
        result[t] = value;
      } catch (err) {
        cache.set(t, { value: null, expiresAt: Date.now() + CACHE_TTL_ERR });
        console.warn(`[Events] ${t}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(tickers.length, 1)) }, worker));
  return result;
}

module.exports = { fetchUpcomingEvents };
