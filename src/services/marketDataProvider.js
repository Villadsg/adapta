/**
 * MarketDataProvider — live market data via MarketData.app.
 *
 * Replaces Yahoo Finance as the runtime provider for prices, quotes and options
 * chains. Returns yahoo-finance2-compatible shapes so existing consumers
 * (OptionsAnalysisService, ci/ticker-screen.js, main.js) work unchanged.
 *
 * Expiration lists are cached per ticker for the life of a run: Yahoo returned
 * every expiration on any chain fetch, while MarketData needs a separate call,
 * and screening fetches ~3 chains per ticker.
 *
 * Fundamentals (sector, industry, market cap, business summary, revenue growth,
 * balance sheets) are NOT available from MarketData — those consumers keep
 * using their existing source. See getQuoteSummary().
 */

const MarketDataClient = require('./marketDataClient');

const EXP_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — expiration lists change daily at most
const PRICE_CACHE_TTL_MS = 15 * 60 * 1000; // 15m — band anchor only needs to be fresh-ish

/**
 * Default strike band for current-chain fetches: keep only strikes within
 * ±15% of the underlying price. Chains are billed per contract returned, so
 * trimming far OTM/ITM wings cuts screening costs several-fold. Set to 0/null
 * per-call to get the full chain.
 */
const DEFAULT_MAX_OTM_PCT = 0.15;

class MarketDataProvider {
  /**
   * @param {string} [apiKey] - Defaults to MARKET_DATA_API_KEY / MARKETDATA_API_KEY
   */
  constructor(apiKey) {
    const key = apiKey || process.env.MARKET_DATA_API_KEY || process.env.MARKETDATA_API_KEY;
    this.client = new MarketDataClient(key);
    this._expCache = new Map(); // ticker → { at: number, expirations: string[] }
    this._priceCache = new Map(); // ticker → { at: number, price: number }
  }

  /** Credits consumed so far by this provider's client. */
  get creditsUsed() {
    return this.client.creditsUsed;
  }

  /** Credits remaining in the current quota window, if the API reported it. */
  get creditsRemaining() {
    return this.client.creditsRemaining;
  }

  /**
   * Latest underlying price, cached briefly. Used for strike-band computation;
   * also suitable as a live/extended-hours price (the quotes endpoint returns
   * the most recent print, including pre/post-market, by default). Costs 1
   * credit on a cache miss — trivial next to an unfiltered chain (150–300+).
   * @param {string} ticker
   * @returns {Promise<number|null>}
   */
  async getUnderlyingPrice(ticker) {
    const hit = this._priceCache.get(ticker);
    if (hit && Date.now() - hit.at < PRICE_CACHE_TTL_MS) return hit.price;

    const quote = await this.client.fetchQuote(ticker);
    const price = quote?.last ?? quote?.mid ?? null;
    if (price != null) this._priceCache.set(ticker, { at: Date.now(), price });
    return price;
  }

  /**
   * Daily bars for a ticker, oldest first — drop-in for
   * PriceTrackingService.fetchHistoricalPrices (same {date, open, high, low,
   * close, volume} shape, accepting unix-second period1/period2).
   *
   * @param {string} ticker
   * @param {{period1?: number, period2?: number}} [options]
   * @returns {Promise<Array<{date: string, open: number, high: number, low: number, close: number, volume: number}>>}
   */
  async fetchHistoricalPrices(ticker, options = {}) {
    const period2 = options.period2 ?? Math.floor(Date.now() / 1000);
    const period1 = options.period1 ?? period2 - 365 * 24 * 60 * 60;
    const from = toDateStr(period1);
    const to = toDateStr(period2);
    return this.client.fetchDailyCandles(ticker, from, to);
  }

  /**
   * Current quote in the shape PriceTrackingService.getQuoteSummary returns.
   *
   * marketCap/shortName/longName are null — MarketData has no fundamentals or
   * company metadata. The Yahoo chart-endpoint version returned null for these
   * too, so this is not a regression for that call site.
   *
   * open/dayHigh/dayLow come from today's daily candle when available; the quote
   * endpoint alone does not carry them.
   *
   * @param {string} ticker
   * @returns {Promise<Object>}
   */
  async getQuoteSummary(ticker) {
    const quote = await this.client.fetchQuote(ticker);
    if (!quote) throw new Error(`No quote data found for ${ticker}`);

    const price = quote.last ?? quote.mid ?? null;
    const change = quote.change ?? null;
    // MarketData returns changepct as a fraction; callers expect percent.
    const changePercent = quote.changepct != null ? quote.changepct * 100 : 0;
    const previousClose = price != null && change != null ? price - change : null;

    let today = null;
    try {
      const to = toDateStr(Math.floor(Date.now() / 1000));
      const from = toDateStr(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);
      const bars = await this.client.fetchDailyCandles(ticker, from, to);
      today = bars.length > 0 ? bars[bars.length - 1] : null;
    } catch (_) { /* OHLC is best-effort */ }

    return {
      ticker: quote.symbol || ticker,
      price,
      change: change ?? 0,
      changePercent,
      volume: quote.volume ?? today?.volume ?? 0,
      marketCap: null,
      shortName: null,
      longName: null,
      open: today?.open ?? null,
      dayHigh: today?.high ?? null,
      dayLow: today?.low ?? null,
      previousClose,
    };
  }

  /**
   * Option expiration dates (YYYY-MM-DD, ascending), cached per ticker.
   * @param {string} ticker
   * @returns {Promise<string[]>}
   */
  async getExpirations(ticker) {
    const hit = this._expCache.get(ticker);
    if (hit && Date.now() - hit.at < EXP_CACHE_TTL_MS) return hit.expirations;

    const expirations = await this.client.fetchExpirations(ticker);
    this._expCache.set(ticker, { at: Date.now(), expirations });
    return expirations;
  }

  /**
   * Options chain in yahoo-finance2 format.
   *
   * With no expirationDate, returns the nearest expiration's chain (Yahoo's
   * behaviour — MarketData would otherwise default to the next *monthly*).
   * The returned chain always advertises the full expiration list, which
   * callers use to drive subsequent per-expiration fetches.
   *
   * @param {string} ticker
   * @param {string} [expirationDate] - YYYY-MM-DD
   * @param {Object} [options]
   * @param {number} [options.maxOtmPct=0.15] - Restrict the server-side payload
   *   to strikes within ±maxOtmPct of the underlying price (chains bill per
   *   contract returned). Pass 0/null to fetch the full chain.
   * @returns {Promise<Object|null>} Chain, or null when the ticker has no options
   */
  async fetchOptionsChain(ticker, expirationDate, options = {}) {
    const { maxOtmPct = DEFAULT_MAX_OTM_PCT } = options;
    const expirations = await this.getExpirations(ticker);
    if (expirations.length === 0) return null;

    const target = expirationDate || expirations[0];

    let underlyingPrice = null;
    if (maxOtmPct != null && maxOtmPct > 0) {
      underlyingPrice = await this.getUnderlyingPrice(ticker);
    }
    return this.client.fetchCurrentChain(ticker, target, expirations, { maxOtmPct, underlyingPrice });
  }
}

/** Unix seconds → YYYY-MM-DD (UTC). */
function toDateStr(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().split('T')[0];
}

module.exports = MarketDataProvider;
module.exports.DEFAULT_MAX_OTM_PCT = DEFAULT_MAX_OTM_PCT;
