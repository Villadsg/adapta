const https = require('https');
const bunBridge = require('./bunBridge');

/**
 * Price Tracking Service
 * Fetches stock price data from Yahoo Finance and manages price updates
 *
 * Supports optional Bun worker for faster HTTP requests.
 */
class PriceTrackingService {
  constructor(database, options = {}) {
    this.database = database;
    this.pollingInterval = null;
    this.pollingIntervalMs = 15 * 60 * 1000; // Default 15 minutes
    this.useBun = options.useBun !== false; // Default to true, set false to disable
    this.bunChecked = false;
    this.bunAvailable = false;
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
   * Fetch historical stock prices from Yahoo Finance
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Fetch options
   * @param {string} options.period1 - Start timestamp (seconds since epoch)
   * @param {string} options.period2 - End timestamp (seconds since epoch)
   * @param {string} options.interval - Data interval ('1d', '1wk', '1mo')
   * @returns {Promise<Array>} Array of price data
   */
  async fetchHistoricalPrices(ticker, options = {}) {
    const {
      period1 = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60), // 1 year ago
      period2 = Math.floor(Date.now() / 1000), // Now
      interval = '1d'
    } = options;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=${interval}`;

    console.log(`📈 Fetching historical prices for ${ticker}...`);

    try {
      const data = await this.fetchJSON(url);

      if (!data || !data.chart || !data.chart.result || data.chart.result.length === 0) {
        throw new Error(`No data found for ticker ${ticker}`);
      }

      const result = data.chart.result[0];
      const timestamps = result.timestamp;
      const quote = result.indicators.quote[0];

      if (!timestamps || !quote) {
        throw new Error(`Invalid data format for ticker ${ticker}`);
      }

      // Convert to array of price objects
      const prices = [];
      for (let i = 0; i < timestamps.length; i++) {
        const date = new Date(timestamps[i] * 1000);
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

        prices.push({
          date: dateStr,
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume[i]
        });
      }

      console.log(`  ✓ Fetched ${prices.length} price records for ${ticker}`);
      return prices;
    } catch (error) {
      console.error(`  ❌ Error fetching prices for ${ticker}:`, error.message);
      throw error;
    }
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

        await this.database.saveStockPrice(ticker, priceData.date, priceData, 'yahoo_finance');
        savedCount++;
      }

      const earliestDate = prices[prices.length - 1].date;
      const latestDate = prices[0].date;

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
        interval: '1d'
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

        await this.database.saveStockPrice(ticker, priceData.date, priceData, 'yahoo_finance');
        savedCount++;
      }

      const latestPrice = prices[0];

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
    } catch (error) {
      console.error('Error in pollPrices:', error);
    }
  }

  /**
   * Get quote summary for a ticker (current market data)
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object>} Quote data
   */
  async getQuoteSummary(ticker) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;

    try {
      const data = await this.fetchJSON(url);

      if (!data || !data.quoteResponse || !data.quoteResponse.result || data.quoteResponse.result.length === 0) {
        throw new Error(`No quote data found for ${ticker}`);
      }

      const quote = data.quoteResponse.result[0];

      return {
        ticker: quote.symbol,
        price: quote.regularMarketPrice,
        change: quote.regularMarketChange,
        changePercent: quote.regularMarketChangePercent,
        volume: quote.regularMarketVolume,
        marketCap: quote.marketCap,
        shortName: quote.shortName,
        longName: quote.longName
      };
    } catch (error) {
      console.error(`Error fetching quote for ${ticker}:`, error);
      throw error;
    }
  }

  /**
   * Fetch JSON data from URL
   * Uses Bun worker if available, falls back to Node.js https
   * @param {string} url - URL to fetch
   * @returns {Promise<Object>} Parsed JSON response
   */
  async fetchJSON(url) {
    // Try Bun worker first if available
    if (this.useBun && await this.checkBunAvailable()) {
      try {
        return await bunBridge.fetchJSON(url);
      } catch (error) {
        console.warn(`[PriceTracking] Bun worker failed, falling back to Node.js: ${error.message}`);
        // Fall through to Node.js implementation
      }
    }

    // Node.js fallback
    return this.fetchJSONNode(url);
  }

  /**
   * Fetch JSON data from URL using Node.js https (fallback)
   * @param {string} url - URL to fetch
   * @returns {Promise<Object>} Parsed JSON response
   */
  fetchJSONNode(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      }).on('error', (error) => {
        reject(error);
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
