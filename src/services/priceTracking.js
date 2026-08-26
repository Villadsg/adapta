const https = require('https');
const bunBridge = require('./bunBridge');
const MarketDataProvider = require('./marketDataProvider');

/** Source label written to stock_prices for provider-sourced bars. */
const PRICE_SOURCE = 'marketdata';

/**
 * Price Tracking Service
 * Fetches stock price data from MarketData.app and manages price updates
 *
 * Bun worker support is retained for the generic fetchJSON helper.
 */
class PriceTrackingService {
  constructor(database, options = {}) {
    this.database = database;
    this.pollingInterval = null;
    this.pollingIntervalMs = 15 * 60 * 1000; // Default 15 minutes
    this.useBun = options.useBun !== false; // Default to true, set false to disable
    this.bunChecked = false;
    this.bunAvailable = false;
    this.optionsAnalyzer = null;
    this.marketData = options.marketDataProvider || null;
  }

  /** Lazily construct the provider so an API key is only needed when fetching. */
  _getMarketData() {
    if (!this.marketData) {
      this.marketData = new MarketDataProvider();
    }
    return this.marketData;
  }

  /**
   * Set options analyzer for daily snapshot collection
   * @param {Object} analyzer - OptionsAnalysisService instance
   */
  setOptionsAnalyzer(analyzer) {
    this.optionsAnalyzer = analyzer;
  }

  /**
   * Check if Bun is available (cached check)
   * @returns {Promise<boolean>}
   */
  async checkBunAvailable() {
    if (this.bunChecked) {
      return this.bunAvailable;
    }
    this.bunChecked = true;
    this.bunAvailable = await bunBridge.isBunAvailable();
    if (this.bunAvailable && this.useBun) {
      console.log('📦 Bun detected - using Bun workers for faster HTTP requests');
    }
    return this.bunAvailable;
  }

  /**
   * Fetch historical daily stock prices from MarketData.app.
   * Bars are returned oldest-first, matching the previous Yahoo chart behaviour.
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Fetch options
   * @param {number} options.period1 - Start timestamp (seconds since epoch)
   * @param {number} options.period2 - End timestamp (seconds since epoch)
   * @returns {Promise<Array>} Array of price data
   */
  async fetchHistoricalPrices(ticker, options = {}) {
    const {
      period1 = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60), // 1 year ago
      period2 = Math.floor(Date.now() / 1000), // Now
      refresh = false, // force a full provider pull, ignoring stored bars
    } = options;

    const fromDate = new Date(period1 * 1000).toISOString().slice(0, 10);
    const toDate = new Date(period2 * 1000).toISOString().slice(0, 10);

    // Serve the window from stored bars and ask the provider only for the tail
    // after the newest stored date. Re-downloading a settled multi-month history
    // on every run is what exhausts the daily credit budget; the older bars can
    // never change (splits aside, which the backfill handles separately).
    if (this.database && !refresh) {
      let stored = [];
      try {
        stored = await this.database.getDailyBars(ticker, fromDate);
      } catch (err) {
        console.warn(`  ⚠️  ${ticker}: could not read stored bars (${err.message}) — falling back to full fetch`);
        stored = [];
      }

      if (stored.length > 0) {
        const lastStored = stored[stored.length - 1].date;
        if (lastStored >= toDate) {
          console.log(`  ✓ ${ticker}: ${stored.length} bars from DB (current through ${lastStored}, no fetch)`);
          return stored;
        }

        // Re-request from the last stored day so that day's bar is refreshed too
        // (an intraday run stores a partial bar that settles after the close).
        const tailFrom = Math.floor(new Date(`${lastStored}T00:00:00Z`).getTime() / 1000);
        console.log(`📈 ${ticker}: ${stored.length} bars from DB through ${lastStored}, fetching ${lastStored}→${toDate}...`);
        try {
          const fresh = await this._getMarketData().fetchHistoricalPrices(ticker, {
            period1: tailFrom, period2,
          });
          const merged = this._mergeBars(stored, fresh);
          console.log(`  ✓ ${ticker}: +${fresh.length} fetched, ${merged.length} bars total`);
          return merged;
        } catch (error) {
          // A failed top-up should not sink the run when the stored history is
          // still usable — the caller only loses the most recent day or two.
          console.warn(`  ⚠️  ${ticker}: top-up fetch failed (${error.message}) — using ${stored.length} stored bars`);
          return stored;
        }
      }
    }

    console.log(`📈 Fetching historical prices for ${ticker}...`);

    try {
      const prices = await this._getMarketData().fetchHistoricalPrices(ticker, { period1, period2 });
      console.log(`  ✓ Fetched ${prices.length} price records for ${ticker}`);
      return prices;
    } catch (error) {
      console.error(`  ❌ Error fetching prices for ${ticker}:`, error.message);
      throw error;
    }
  }

  /**
   * Merge freshly fetched bars over stored ones, keyed by date (fresh wins), and
   * return them oldest-first.
   * @param {Array} stored
   * @param {Array} fresh
   * @returns {Array}
   */
  _mergeBars(stored, fresh) {
    const byDate = new Map();
    for (const b of stored) {
      if (b && b.date) byDate.set(b.date, b);
    }
    for (const b of (fresh || [])) {
      if (!b || !b.date) continue;
      const key = b.date instanceof Date
        ? b.date.toISOString().slice(0, 10)
        : String(b.date).split('T')[0].split(' ')[0];
      byDate.set(key, { ...b, date: key });
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /**
   * Fetch and save historical prices to database
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} Result with count and date range
   */
  async fetchAndSaveHistoricalPrices(ticker, options = {}) {
    try {
      const prices = await this.fetchHistoricalPrices(ticker, options);

      if (prices.length === 0) {
        return { success: true, count: 0, message: 'No prices found' };
      }

      let savedCount = 0;
      for (const priceData of prices) {
        // Skip records with null values
        if (priceData.close === null || priceData.open === null) {
          continue;
        }

        await this.database.saveStockPrice(ticker, priceData.date, priceData, PRICE_SOURCE);
        savedCount++;
      }

      // Bars are oldest-first
      const earliestDate = prices[0].date;
      const latestDate = prices[prices.length - 1].date;

      console.log(`  ✓ Saved ${savedCount} price records for ${ticker} (${earliestDate} to ${latestDate})`);

      return {
        success: true,
        count: savedCount,
        earliestDate,
        latestDate
      };
    } catch (error) {
      console.error(`Error in fetchAndSaveHistoricalPrices for ${ticker}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update latest price for a ticker (incremental update)
   * Fetches only the last 5 days to get the latest price
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object>} Result object
   */
  async updateLatestPrice(ticker) {
    try {
      // Fetch last 5 days to ensure we get latest price
      const fiveDaysAgo = Math.floor(Date.now() / 1000) - (5 * 24 * 60 * 60);
      const now = Math.floor(Date.now() / 1000);

      const prices = await this.fetchHistoricalPrices(ticker, {
        period1: fiveDaysAgo,
        period2: now,
      });

      if (prices.length === 0) {
        return { success: false, message: 'No recent prices found' };
      }

      // Save only new prices
      let savedCount = 0;
      for (const priceData of prices) {
        if (priceData.close === null || priceData.open === null) {
          continue;
        }

        await this.database.saveStockPrice(ticker, priceData.date, priceData, PRICE_SOURCE);
        savedCount++;
      }

      // Bars are oldest-first
      const latestPrice = prices[prices.length - 1];

      return {
        success: true,
        savedCount,
        latestPrice
      };
    } catch (error) {
      console.error(`Error updating latest price for ${ticker}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Start automatic price polling for all watched tickers
   * @param {number} intervalMinutes - Polling interval in minutes
   */
  startPolling(intervalMinutes = 15) {
    // Stop existing polling if any
    this.stopPolling();

    this.pollingIntervalMs = intervalMinutes * 60 * 1000;

    console.log(`📊 Starting price polling every ${intervalMinutes} minutes`);

    // Run immediately
    this.pollPrices();

    // Set interval for future polls
    this.pollingInterval = setInterval(() => {
      this.pollPrices();
    }, this.pollingIntervalMs);
  }

  /**
   * Stop automatic price polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log('📊 Stopped price polling');
    }
  }

  /**
   * Poll prices for all watched tickers with auto_update enabled
   * @returns {Promise<void>}
   */
  async pollPrices() {
    try {
      const watchedTickers = await this.database.getWatchedTickers(true); // Only auto-update enabled

      if (watchedTickers.length === 0) {
        console.log('  No tickers to update');
        return;
      }

      console.log(`\n📊 Polling prices for ${watchedTickers.length} tickers...`);

      for (const { ticker } of watchedTickers) {
        const result = await this.updateLatestPrice(ticker);

        if (result.success) {
          console.log(`  ✓ ${ticker}: Updated (${result.savedCount} new records)`);
        } else {
          console.log(`  ⚠️  ${ticker}: ${result.error || result.message}`);
        }

        // Rate limiting: wait 500ms between requests
        await this.sleep(500);
      }

      console.log('✓ Price polling complete\n');

      // Collect daily options snapshots after price polling
      await this.pollOptionsSnapshots();
    } catch (error) {
      console.error('Error in pollPrices:', error);
    }
  }

  /**
   * Poll options snapshots for watched tickers (daily, after 4:15 PM ET)
   * Collects options snapshots so events can be matched to nearby snapshots
   */
  async pollOptionsSnapshots() {
    if (!this.optionsAnalyzer) return;

    // Check time: only run after 4:15 PM ET on weekdays
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    const dayOfWeek = etTime.getDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) return; // Weekend
    if (hours < 16 || (hours === 16 && minutes < 15)) return; // Before 4:15 PM ET

    try {
      const watchedTickers = await this.database.getWatchedTickers(true);
      if (watchedTickers.length === 0) return;

      console.log(`\n📊 Polling options snapshots for ${watchedTickers.length} tickers...`);

      for (const { ticker } of watchedTickers) {
        try {
          // Check if we already have today's snapshot
          const latest = await this.database.getLatestOptionsSnapshot(ticker);
          if (latest && latest.length > 0) {
            const latestDate = new Date(latest[0].snapshot_date).toISOString().split('T')[0];
            const todayDate = etTime.toISOString().split('T')[0];
            if (latestDate === todayDate) {
              console.log(`  ✓ ${ticker}: Already have today's snapshot`);
              continue;
            }
          }

          const optionsData = await this.optionsAnalyzer.analyzeCurrentOptions(ticker, { maxExpirations: 4 });
          if (optionsData) {
            await this.optionsAnalyzer.saveSnapshot(optionsData);
            console.log(`  ✓ ${ticker}: Options snapshot saved`);
          }
        } catch (err) {
          console.log(`  ⚠️  ${ticker}: Options snapshot failed: ${err.message}`);
        }

        // Rate limiting: wait 3 seconds between tickers
        await this.sleep(3000);
      }

      console.log('✓ Options snapshot polling complete\n');
    } catch (error) {
      console.error('Error in pollOptionsSnapshots:', error);
    }
  }

  /**
   * Get quote summary for a ticker (current market data)
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object>} Quote data
   */
  async getQuoteSummary(ticker) {
    try {
      // marketCap/shortName/longName come back null — MarketData carries no
      // company metadata. The previous Yahoo chart-endpoint implementation
      // returned null for those fields too, so callers are unaffected.
      return await this._getMarketData().getQuoteSummary(ticker);
    } catch (error) {
      console.error(`Error fetching quote for ${ticker}:`, error);
      throw error;
    }
  }

  /**
   * Fetch JSON data from URL with retry + exponential backoff.
   * Tries Bun worker first, then Node.js https on each attempt.
   * @param {string} url - URL to fetch
   * @param {Object} [opts]
   * @param {number} [opts.maxAttempts=3]
   * @param {number} [opts.timeoutMs=15000]
   * @returns {Promise<Object>} Parsed JSON response
   */
  async fetchJSON(url, opts = {}) {
    const { maxAttempts = 3, timeoutMs = 15000 } = opts;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.useBun && await this.checkBunAvailable()) {
          try {
            return await bunBridge.fetchJSON(url);
          } catch (error) {
            const msg = error?.message || String(error) || 'unknown Bun worker error';
            console.warn(`[PriceTracking] Bun worker failed (attempt ${attempt}/${maxAttempts}), falling back to Node.js: ${msg}`);
          }
        }
        return await this.fetchJSONNode(url, timeoutMs);
      } catch (error) {
        lastError = error;
        const msg = error?.message || String(error) || 'unknown network error';
        if (attempt < maxAttempts) {
          const backoff = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000...
          console.warn(`[PriceTracking] fetch failed (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${backoff}ms`);
          await this.sleep(backoff);
        }
      }
    }

    const finalMsg = lastError?.message || String(lastError) || 'fetch failed';
    throw new Error(finalMsg);
  }

  /**
   * Fetch JSON data from URL using Node.js https (fallback).
   * @param {string} url - URL to fetch
   * @param {number} [timeoutMs=15000] - Request timeout
   * @returns {Promise<Object>} Parsed JSON response
   */
  fetchJSONNode(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const opts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        timeout: timeoutMs
      };
      const req = https.get(url, opts, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume(); // drain
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()));
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      req.on('error', (error) => {
        reject(new Error(error?.message || error?.code || 'network error'));
      });
    });
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if polling is active
   * @returns {boolean} True if polling is active
   */
  isPolling() {
    return this.pollingInterval !== null;
  }

  /**
   * Get polling status and configuration
   * @returns {Object} Polling status
   */
  getPollingStatus() {
    return {
      isActive: this.isPolling(),
      intervalMinutes: this.pollingIntervalMs / (60 * 1000)
    };
  }
}

module.exports = PriceTrackingService;
