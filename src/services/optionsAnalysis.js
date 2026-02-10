/**
 * OptionsAnalysisService - Fetches and analyzes options market activity
 *
 * Uses yahoo-finance2 options() method to fetch options chains, then computes
 * put/call ratios, implied volatility, and unusual volume metrics to gauge
 * market sentiment before stock events.
 */

const YahooFinance = require('yahoo-finance2').default;

// Create singleton instance with v3 configuration
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey']
});

class OptionsAnalysisService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Fetch options chain for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {string} [expirationDate] - Optional expiration date (YYYY-MM-DD)
   * @returns {Promise<Object|null>} Raw options chain or null on error
   */
  async fetchOptionsChain(ticker, expirationDate) {
    try {
      const queryOptions = {};
      if (expirationDate) {
        queryOptions.date = new Date(expirationDate);
      }
      const chain = await yahooFinance.options(ticker, queryOptions);
      return chain;
    } catch (error) {
      console.error(`Error fetching options for ${ticker}: ${error.message}`);
      return null;
    }
  }

  /**
   * Analyze current options activity for a ticker
   * Fetches nearest 2 expirations and computes aggregate metrics
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object|null>} Options analysis data or null
   */
  async analyzeCurrentOptions(ticker) {
    console.log(`\nFetching options data for ${ticker}...`);

    // Delay to avoid Yahoo Finance rate limiting (429) after prior API calls
    await new Promise(resolve => setTimeout(resolve, 2000));

    // First fetch to get available expirations and current price
    const initialChain = await this.fetchOptionsChain(ticker);
    if (!initialChain) {
      console.log(`No options data available for ${ticker}`);
      return null;
    }

    const currentPrice = initialChain.quote?.regularMarketPrice || null;
    if (!currentPrice) {
      console.log(`No current price available for ${ticker}`);
      return null;
    }

    const expirationDates = initialChain.expirationDates || [];
    if (expirationDates.length === 0) {
      console.log(`No expiration dates found for ${ticker}`);
      return null;
    }

    console.log(`  Current price: $${currentPrice}`);
    console.log(`  Available expirations: ${expirationDates.length}`);

    // Analyze nearest 2 expirations
    const nearestExpirations = expirationDates.slice(0, 2);
    const expirations = [];

    // Process first expiration from initial fetch
    const firstExpDate = nearestExpirations[0];
    const firstMetrics = this.computeExpirationMetrics(initialChain, currentPrice);
    if (firstMetrics) {
      firstMetrics.expirationDate = firstExpDate;
      expirations.push(firstMetrics);
      console.log(`  Expiration ${this.formatDate(firstExpDate)}: P/C ratio=${firstMetrics.putCallRatio.toFixed(2)}, ATM IV call=${(firstMetrics.atmCallIV * 100).toFixed(1)}%`);
    }

    // Fetch second expiration if available
    if (nearestExpirations.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
      const secondChain = await this.fetchOptionsChain(ticker, this.formatDate(nearestExpirations[1]));
      if (secondChain) {
        const secondMetrics = this.computeExpirationMetrics(secondChain, currentPrice);
        if (secondMetrics) {
          secondMetrics.expirationDate = nearestExpirations[1];
          expirations.push(secondMetrics);
          console.log(`  Expiration ${this.formatDate(nearestExpirations[1])}: P/C ratio=${secondMetrics.putCallRatio.toFixed(2)}, ATM IV call=${(secondMetrics.atmCallIV * 100).toFixed(1)}%`);
        }
      }
    }

    if (expirations.length === 0) {
      console.log(`No valid options metrics computed for ${ticker}`);
      return null;
    }

    const summary = this.computeAggregateSummary(expirations, currentPrice);

    console.log(`  Sentiment: ${summary.sentiment} (P/C=${summary.avgPutCallRatio.toFixed(2)}, ATM IV=${(summary.avgAtmIV * 100).toFixed(1)}%, unusual=${summary.totalUnusualVolume})`);

    return {
      ticker: ticker.toUpperCase(),
      currentPrice,
      snapshotDate: new Date().toISOString(),
      expirations,
      summary
    };
  }

  /**
   * Compute metrics for a single expiration's options chain
   * @param {Object} optionChain - Raw options chain from yahoo-finance2
   * @param {number} currentPrice - Current stock price
   * @returns {Object|null} Computed metrics
   */
  computeExpirationMetrics(optionChain, currentPrice) {
    const calls = optionChain.options?.[0]?.calls || [];
    const puts = optionChain.options?.[0]?.puts || [];

    if (calls.length === 0 && puts.length === 0) {
      return null;
    }

    // Volume totals
    const totalCallVolume = calls.reduce((sum, c) => sum + (c.volume || 0), 0);
    const totalPutVolume = puts.reduce((sum, p) => sum + (p.volume || 0), 0);
    const putCallRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;

    // Open interest totals
    const totalCallOI = calls.reduce((sum, c) => sum + (c.openInterest || 0), 0);
    const totalPutOI = puts.reduce((sum, p) => sum + (p.openInterest || 0), 0);
    const putCallOIRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // ATM options (closest strike to current price)
    const atmCall = this.findATMOption(calls, currentPrice);
    const atmPut = this.findATMOption(puts, currentPrice);
    const atmCallIV = atmCall?.impliedVolatility || 0;
    const atmPutIV = atmPut?.impliedVolatility || 0;

    // Average IV
    const avgCallIV = this.averageIV(calls);
    const avgPutIV = this.averageIV(puts);

    // Max volume strikes
    const maxCallVolumeStrike = this.findMaxBy(calls, 'volume')?.strike || 0;
    const maxPutVolumeStrike = this.findMaxBy(puts, 'volume')?.strike || 0;

    // Max OI strikes
    const maxCallOIStrike = this.findMaxBy(calls, 'openInterest')?.strike || 0;
    const maxPutOIStrike = this.findMaxBy(puts, 'openInterest')?.strike || 0;

    // Unusual volume count (contracts where volume > 2x openInterest)
    const allContracts = [...calls, ...puts];
    const unusualVolumeCount = allContracts.filter(c =>
      (c.volume || 0) > 2 * (c.openInterest || 1)
    ).length;

    return {
      totalCallVolume,
      totalPutVolume,
      putCallRatio,
      totalCallOI,
      totalPutOI,
      putCallOIRatio,
      atmCallIV,
      atmPutIV,
      avgCallIV,
      avgPutIV,
      maxCallVolumeStrike,
      maxPutVolumeStrike,
      maxCallOIStrike,
      maxPutOIStrike,
      unusualVolumeCount
    };
  }

  /**
   * Compute aggregate summary across expirations
   * @param {Array} expirationMetrics - Metrics per expiration
   * @param {number} currentPrice - Current stock price
   * @returns {Object} Aggregate summary with sentiment classification
   */
  computeAggregateSummary(expirationMetrics, currentPrice) {
    const totalCallVol = expirationMetrics.reduce((s, e) => s + e.totalCallVolume, 0);
    const totalPutVol = expirationMetrics.reduce((s, e) => s + e.totalPutVolume, 0);
    const avgPutCallRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;

    const totalCallOI = expirationMetrics.reduce((s, e) => s + e.totalCallOI, 0);
    const totalPutOI = expirationMetrics.reduce((s, e) => s + e.totalPutOI, 0);
    const avgPutCallOIRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Average ATM IV across expirations
    const ivValues = expirationMetrics
      .map(e => (e.atmCallIV + e.atmPutIV) / 2)
      .filter(v => v > 0);
    const avgAtmIV = ivValues.length > 0
      ? ivValues.reduce((s, v) => s + v, 0) / ivValues.length
      : 0;

    const totalUnusualVolume = expirationMetrics.reduce((s, e) => s + e.unusualVolumeCount, 0);

    // Classify sentiment
    let sentiment = 'neutral';
    let sentimentScore = 0; // -3 to +3

    // P/C ratio signal: <0.7 = bullish, >1.0 = bearish
    if (avgPutCallRatio < 0.7) sentimentScore += 1;
    else if (avgPutCallRatio > 1.0) sentimentScore -= 1;

    // P/C OI ratio signal
    if (avgPutCallOIRatio < 0.7) sentimentScore += 1;
    else if (avgPutCallOIRatio > 1.0) sentimentScore -= 1;

    // High unusual volume indicates anticipation of movement
    if (totalUnusualVolume > 5) {
      // Direction bias from P/C ratio determines if unusual vol is bullish or bearish
      if (avgPutCallRatio < 0.8) sentimentScore += 1;
      else if (avgPutCallRatio > 1.0) sentimentScore -= 1;
    }

    if (sentimentScore >= 2) sentiment = 'bullish';
    else if (sentimentScore <= -2) sentiment = 'bearish';

    return {
      totalCallVolume: totalCallVol,
      totalPutVolume: totalPutVol,
      avgPutCallRatio,
      totalCallOI,
      totalPutOI,
      avgPutCallOIRatio,
      avgAtmIV,
      totalUnusualVolume,
      sentiment,
      sentimentScore
    };
  }

  /**
   * Save options snapshot to database
   * @param {Object} optionsData - Data from analyzeCurrentOptions()
   */
  async saveSnapshot(optionsData) {
    for (const exp of optionsData.expirations) {
      await this.database.saveOptionsSnapshot(
        optionsData.ticker,
        optionsData.snapshotDate,
        this.formatDate(exp.expirationDate),
        optionsData.currentPrice,
        exp
      );
    }
    console.log(`  Saved ${optionsData.expirations.length} options snapshots for ${optionsData.ticker}`);
  }

  /**
   * Get historical snapshots for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {number} days - Number of days of history
   * @returns {Promise<Array>} Snapshot records
   */
  async getSnapshotHistory(ticker, days = 30) {
    return this.database.getOptionsSnapshots(ticker, days);
  }

  // ===== Helper methods =====

  /**
   * Find the option closest to the current price (ATM)
   * @param {Array} options - Array of option contracts
   * @param {number} currentPrice - Current stock price
   * @returns {Object|null} Closest option contract
   */
  findATMOption(options, currentPrice) {
    if (!options || options.length === 0) return null;
    let closest = options[0];
    let minDiff = Math.abs((closest.strike || 0) - currentPrice);

    for (const opt of options) {
      const diff = Math.abs((opt.strike || 0) - currentPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closest = opt;
      }
    }
    return closest;
  }

  /**
   * Compute average implied volatility from options array
   * @param {Array} options - Array of option contracts
   * @returns {number} Average IV (0 if none)
   */
  averageIV(options) {
    const ivValues = options
      .map(o => o.impliedVolatility || 0)
      .filter(v => v > 0);
    if (ivValues.length === 0) return 0;
    return ivValues.reduce((s, v) => s + v, 0) / ivValues.length;
  }

  /**
   * Find option with maximum value for a given field
   * @param {Array} options - Array of option contracts
   * @param {string} field - Field name to maximize
   * @returns {Object|null} Option with max value
   */
  findMaxBy(options, field) {
    if (!options || options.length === 0) return null;
    return options.reduce((max, opt) =>
      (opt[field] || 0) > (max[field] || 0) ? opt : max
    , options[0]);
  }

  /**
   * Format a date as YYYY-MM-DD string
   * @param {Date|string} date - Date to format
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0];
  }
}

module.exports = OptionsAnalysisService;
