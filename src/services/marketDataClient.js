/**
 * MarketData.app REST client.
 *
 * Two roles:
 *   1. Historical backfill (ci/backfill-marketdata.js) — 1y of daily candles and
 *      full historical options chains into DuckDB.
 *   2. Live provider (replacing Yahoo Finance) — daily candles, quotes, option
 *      expirations and current chains for the screening/options runtime path.
 *
 * Note: MarketData historical options data is as-traded (NOT split/dividend
 * adjusted). Fine for IV levels; be careful comparing raw strikes/prices
 * across corporate actions. Unlike the historical chain (prices only), the
 * *current* chain endpoint returns broker IV and greeks directly.
 *
 * Auth: Bearer token from MARKET_DATA_API_KEY (or MARKETDATA_API_KEY) env var.
 */

const BASE_URL = 'https://api.marketdata.app/v1';

class MarketDataClient {
  /**
   * @param {string} apiKey - MarketData.app API token
   */
  constructor(apiKey) {
    const key = apiKey || process.env.MARKET_DATA_API_KEY || process.env.MARKETDATA_API_KEY;
    if (!key) {
      throw new Error('MarketData API token is not set (MARKET_DATA_API_KEY in .env.local)');
    }
    this.apiKey = key;
    this.creditsUsed = 0;
    this.creditsRemaining = null; // last seen X-Api-RateLimit-Remaining header
    this.lastRequestCredits = null; // real credits billed for the most recent request
  }

  /**
   * Perform a GET request with retry/backoff on 429 and 5xx.
   *
   * Credit accounting: MarketData.app reports the real per-request cost in the
   * X-Api-RateLimit-Consumed response header (options chains are billed PER
   * CONTRACT RETURNED, so a chain request can cost hundreds of credits). When
   * the header is present it is authoritative; otherwise we fall back to the
   * caller-supplied `credits` estimate.
   *
   * @param {string} urlPath - Path including query string, e.g. /options/chain/AAPL/?date=2026-01-05
   * @param {number} [credits=1] - Fallback credit estimate when the API omits the consumed header
   * @returns {Promise<object>} Parsed JSON body
   */
  async get(urlPath, credits = 1) {
    const url = `${BASE_URL}${urlPath}`;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await sleep(1000 * attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts) {
          throw new Error(`MarketData ${res.status} after ${maxAttempts} attempts: ${urlPath}`);
        }
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(retryAfter * 1000, 1000 * attempt * attempt));
        continue;
      }

      // Real credit cost from rate-limit headers (present on success AND error
      // responses). Only reached for the final response — retried 429/5xx
      // attempts are not billed.
      this._trackCredits(res, credits);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 404 with a no_data payload means "no options for this day" — not an error
        if (res.status === 404 && body.includes('"no_data"')) {
          try { return JSON.parse(body); } catch (_) { /* fall through to error */ }
        }
        throw new Error(`MarketData ${res.status}: ${urlPath} — ${body.slice(0, 200)}`);
      }

      return res.json();
    }
  }

  /**
   * Record the real credit cost of a response from its rate-limit headers.
   * X-Api-RateLimit-Consumed is credits billed for THIS request (chains bill
   * per contract returned); X-Api-RateLimit-Remaining is the quota left.
   * Falls back to the caller's estimate when the header is absent/unparseable.
   * @param {Response} res
   * @param {number} fallbackCredits
   */
  _trackCredits(res, fallbackCredits) {
    const consumedRaw = res.headers.get('x-api-ratelimit-consumed');
    const remainingRaw = res.headers.get('x-api-ratelimit-remaining');
    const consumed = consumedRaw != null ? Number(consumedRaw) : NaN;
    const remaining = remainingRaw != null ? Number(remainingRaw) : NaN;
    this.lastRequestCredits = Number.isFinite(consumed) ? consumed : fallbackCredits;
    this.creditsUsed += this.lastRequestCredits;
    if (Number.isFinite(remaining)) this.creditsRemaining = remaining;
  }

  /**
   * Fetch daily candles for a symbol over a date range.
   * Cost: 1 credit per 1000 candles (a 1y daily pull = 1 credit).
   * @param {string} symbol
   * @param {string} from - YYYY-MM-DD
   * @param {string} to - YYYY-MM-DD
   * @returns {Promise<Array<{date: string, open: number, high: number, low: number, close: number, volume: number}>>}
   */
  async fetchDailyCandles(symbol, from, to) {
    const json = await this.get(
      `/stocks/candles/D/${encodeURIComponent(symbol)}/?from=${from}&to=${to}`
    );
    if (json.s === 'no_data' || !Array.isArray(json.t)) return [];
    if (json.s !== 'ok') {
      throw new Error(`MarketData candles error for ${symbol}: ${json.s}`);
    }
    const bars = [];
    for (let i = 0; i < json.t.length; i++) {
      bars.push({
        date: new Date(json.t[i] * 1000).toISOString().split('T')[0],
        open: json.o[i],
        high: json.h[i],
        low: json.l[i],
        close: json.c[i],
        volume: json.v[i],
      });
    }
    return bars;
  }

  /**
   * Fetch the full end-of-day options chain (all expirations) for a past trading day.
   * Cost: billed PER CONTRACT RETURNED (`expiration=all` chains for liquid tickers
   * can cost hundreds of credits). Backfill needs the full chain, so no strike
   * band is applied here; real consumption is tracked via rate-limit headers.
   * @param {string} symbol - Underlying ticker
   * @param {string} date - YYYY-MM-DD (a trading day)
   * @returns {Promise<{underlyingPrice: number|null, contracts: Array}>}
   *   contracts: {optionSymbol, expiration (YYYY-MM-DD), side, strike, bid, ask, mid,
   *   last, volume, openInterest, iv, delta, gamma, theta, vega}
   */
  async fetchHistoricalChain(symbol, date) {
    const json = await this.get(
      `/options/chain/${encodeURIComponent(symbol)}/?date=${date}&expiration=all`
    );
    if (json.s === 'no_data' || !Array.isArray(json.optionSymbol)) {
      return { underlyingPrice: null, contracts: [] };
    }
    if (json.s !== 'ok') {
      throw new Error(`MarketData chain error for ${symbol} ${date}: ${json.s}`);
    }
    const n = json.optionSymbol.length;
    const contracts = [];
    for (let i = 0; i < n; i++) {
      contracts.push({
        optionSymbol: json.optionSymbol[i],
        expiration: new Date(json.expiration[i] * 1000).toISOString().split('T')[0],
        side: json.side[i],
        strike: num(json.strike?.[i]),
        bid: num(json.bid?.[i]),
        ask: num(json.ask?.[i]),
        mid: num(json.mid?.[i]),
        last: num(json.last?.[i]),
        volume: intOrNull(json.volume?.[i]),
        openInterest: intOrNull(json.openInterest?.[i]),
        iv: num(json.iv?.[i]),
        delta: num(json.delta?.[i]),
        gamma: num(json.gamma?.[i]),
        theta: num(json.theta?.[i]),
        vega: num(json.vega?.[i]),
      });
    }
    return { underlyingPrice: num(json.underlyingPrice?.[0]), contracts };
  }

  /**
   * Current quote for a symbol.
   * Cost: 1 credit.
   * @param {string} symbol
   * @returns {Promise<{symbol: string, last: number|null, bid: number|null,
   *   ask: number|null, mid: number|null, change: number|null,
   *   changepct: number|null, volume: number|null, updated: number|null}|null>}
   */
  async fetchQuote(symbol) {
    const json = await this.get(`/stocks/quotes/${encodeURIComponent(symbol)}/`);
    if (json.s === 'no_data' || !Array.isArray(json.symbol) || json.symbol.length === 0) {
      return null;
    }
    return {
      symbol: json.symbol[0],
      last: num(json.last?.[0]),
      bid: num(json.bid?.[0]),
      ask: num(json.ask?.[0]),
      mid: num(json.mid?.[0]),
      // MarketData returns changepct as a fraction (-0.0185 = -1.85%)
      change: num(json.change?.[0]),
      changepct: num(json.changepct?.[0]),
      volume: intOrNull(json.volume?.[0]),
      updated: intOrNull(json.updated?.[0]),
    };
  }

  /**
   * Available option expiration dates for an underlying, ascending.
   * Cost: 1 credit.
   * @param {string} symbol
   * @returns {Promise<string[]>} YYYY-MM-DD strings
   */
  async fetchExpirations(symbol) {
    const json = await this.get(`/options/expirations/${encodeURIComponent(symbol)}/`);
    if (json.s === 'no_data' || !Array.isArray(json.expirations)) return [];
    return json.expirations.slice();
  }

  /**
   * Current options chain for one expiration, returned in the yahoo-finance2
   * shape so existing consumers (OptionsAnalysisService, ticker-screen) work
   * unchanged.
   *
   * Field mapping (MarketData → Yahoo):
   *   optionSymbol → contractSymbol, iv → impliedVolatility (both annualized
   *   decimals), last → lastPrice, updated → lastTradeDate (Date).
   * Greeks (delta/gamma/theta/vega) are passed through as extra fields; Yahoo
   * never supplied them, so nothing downstream depends on their absence.
   *
   * Cost: billed PER CONTRACT RETURNED — an unfiltered chain for a liquid
   * ticker costs 150–300+ credits. Pass `opts.maxOtmPct` to restrict the
   * payload server-side to strikes within ±maxOtmPct of the underlying price
   * (via the API's closed-interval `strike=low-high` filter), which cuts the
   * cost roughly proportionally to the band width.
   * @param {string} symbol - Underlying ticker
   * @param {string} [expiration] - YYYY-MM-DD; defaults to MarketData's next monthly
   * @param {string[]} [allExpirations] - Full expiration list to advertise on the
   *   returned chain. Yahoo returned every expiration on any single chain fetch and
   *   callers rely on that; MarketData needs a separate call, so the provider passes
   *   it in. Falls back to just this chain's own expiration.
   * @param {Object} [opts]
   * @param {number} [opts.maxOtmPct] - If > 0, restrict the chain server-side to
   *   strikes within [price*(1-pct), price*(1+pct)]. Omit/0 for the full chain.
   * @param {number} [opts.underlyingPrice] - Price used to compute the band. When
   *   omitted and a band is requested, a quote is fetched first (1 credit — far
   *   cheaper than the contracts an unfiltered chain would waste).
   * @returns {Promise<Object|null>} yahoo-finance2 compatible chain, or null
   */
  async fetchCurrentChain(symbol, expiration, allExpirations, opts = {}) {
    const { maxOtmPct = null, underlyingPrice: bandPrice = null } = opts || {};
    const params = [];
    if (expiration) params.push(`expiration=${encodeURIComponent(expiration)}`);

    if (maxOtmPct != null && maxOtmPct > 0) {
      let price = bandPrice;
      if (!(price > 0)) {
        const quote = await this.fetchQuote(symbol);
        price = quote?.last ?? quote?.mid ?? null;
      }
      if (price > 0) {
        const lo = Math.max(price * (1 - maxOtmPct), 0.01);
        const hi = price * (1 + maxOtmPct);
        params.push(`strike=${lo.toFixed(2)}-${hi.toFixed(2)}`);
      }
    }

    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    const json = await this.get(`/options/chain/${encodeURIComponent(symbol)}/${qs}`);
    if (json.s === 'no_data' || !Array.isArray(json.optionSymbol)) return null;
    if (json.s !== 'ok') {
      throw new Error(`MarketData chain error for ${symbol}: ${json.s}`);
    }

    const calls = [];
    const puts = [];
    let underlyingPrice = null;
    let expirationSec = null;

    for (let i = 0; i < json.optionSymbol.length; i++) {
      if (underlyingPrice == null) underlyingPrice = num(json.underlyingPrice?.[i]);
      if (expirationSec == null) expirationSec = intOrNull(json.expiration?.[i]);

      const updated = intOrNull(json.updated?.[i]);
      const contract = {
        contractSymbol: json.optionSymbol[i],
        strike: num(json.strike?.[i]),
        currency: 'USD',
        lastPrice: num(json.last?.[i]) ?? 0,
        change: null,
        percentChange: null,
        volume: intOrNull(json.volume?.[i]) ?? 0,
        openInterest: intOrNull(json.openInterest?.[i]) ?? 0,
        bid: num(json.bid?.[i]),
        ask: num(json.ask?.[i]),
        contractSize: 'REGULAR',
        expiration: expirationSec != null ? new Date(expirationSec * 1000) : null,
        lastTradeDate: updated != null ? new Date(updated * 1000) : null,
        impliedVolatility: num(json.iv?.[i]) ?? 0,
        inTheMoney: json.inTheMoney?.[i] === true,
        // MarketData extras (Yahoo had no greeks; additive only)
        delta: num(json.delta?.[i]),
        gamma: num(json.gamma?.[i]),
        theta: num(json.theta?.[i]),
        vega: num(json.vega?.[i]),
        mid: num(json.mid?.[i]),
      };

      if (json.side?.[i] === 'put') puts.push(contract);
      else calls.push(contract);
    }

    const byStrike = (a, b) => (a.strike ?? 0) - (b.strike ?? 0);
    calls.sort(byStrike);
    puts.sort(byStrike);

    const expirationDates = Array.isArray(allExpirations) && allExpirations.length > 0
      ? allExpirations.map(d => new Date(`${d}T00:00:00Z`))
      : (expirationSec != null ? [new Date(expirationSec * 1000)] : []);

    return {
      underlyingSymbol: symbol,
      expirationDates,
      strikes: [...new Set([...calls, ...puts].map(c => c.strike))].sort((a, b) => a - b),
      quote: {
        symbol,
        regularMarketPrice: underlyingPrice,
      },
      options: [{
        expirationDate: expirationSec != null ? new Date(expirationSec * 1000) : null,
        hasMiniOptions: false,
        calls,
        puts,
      }],
    };
  }
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function intOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = MarketDataClient;
