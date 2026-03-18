/**
 * StockAnalysisService - Analyzes stock events using volume and price movements
 *
 * Identifies significant stock events by analyzing trading volume and price gaps,
 * filters out market movements using regression, and correlates events with news articles.
 */

const { linearRegression } = require('simple-statistics');
const embeddingService = require('./embeddings');

// API keys from environment variables
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || null;
const EODHD_API_KEY = process.env.EODHD_API_KEY || null;

class StockAnalysisService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Fetch stock data from Twelve Data (primary source)
   * @param {string} ticker - Stock ticker symbol
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} Array of stock bars
   */
  async fetchFromTwelveData(ticker, startDate, endDate) {
    if (!TWELVE_DATA_API_KEY) {
      throw new Error('TWELVE_DATA_API_KEY environment variable not set');
    }

    console.log(`Fetching ${ticker} from Twelve Data...`);

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&start_date=${startDate}&end_date=${endDate}&apikey=${TWELVE_DATA_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'error') {
      throw new Error(`Twelve Data error: ${data.message}`);
    }

    if (!data.values || data.values.length === 0) {
      throw new Error(`No data returned from Twelve Data for ${ticker}`);
    }

    const bars = data.values
      .map(v => ({
        date: new Date(v.datetime),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseInt(v.volume, 10),
      }))
      .filter(bar => !isNaN(bar.volume))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const firstDate = bars.length > 0 ? bars[0].date.toISOString().split('T')[0] : 'none';
    const lastDate = bars.length > 0 ? bars[bars.length - 1].date.toISOString().split('T')[0] : 'none';
    console.log(`${ticker} data (Twelve Data): ${bars.length} days, range: ${firstDate} to ${lastDate} (requested end: ${endDate})`);
    return bars;
  }

  /**
   * Fetch stock data from EODHD (fallback)
   * @param {string} ticker - Stock ticker symbol
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} exchange - Exchange code (default: US)
   * @returns {Promise<Array>} Array of stock bars
   */
  async fetchFromEODHD(ticker, startDate, endDate, exchange = 'US') {
    if (!EODHD_API_KEY) {
      throw new Error('EODHD_API_KEY environment variable not set');
    }

    console.log(`Fetching ${ticker} from EODHD (fallback)...`);

    // EODHD format: SYMBOL.EXCHANGE (e.g., AAPL.US, VOW.XETRA, 7203.TSE)
    const symbol = ticker.includes('.') ? ticker : `${ticker}.${exchange}`;
    const url = `https://eodhd.com/api/eod/${symbol}?api_token=${EODHD_API_KEY}&fmt=json&from=${startDate}&to=${endDate}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      throw new Error(`EODHD error: ${data.error}`);
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`No data returned from EODHD for ${ticker}`);
    }

    const bars = data
      .map(d => ({
        date: new Date(d.date),
        open: parseFloat(d.open),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        close: parseFloat(d.adjusted_close || d.close),
        volume: parseInt(d.volume, 10),
      }))
      .filter(bar => !isNaN(bar.volume) && !isNaN(bar.close))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const firstDate = bars.length > 0 ? bars[0].date.toISOString().split('T')[0] : 'none';
    const lastDate = bars.length > 0 ? bars[bars.length - 1].date.toISOString().split('T')[0] : 'none';
    console.log(`${ticker} data (EODHD): ${bars.length} days, range: ${firstDate} to ${lastDate} (requested end: ${endDate})`);
    return bars;
  }

  /**
   * Fetch real-time quote from Twelve Data
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object|null>} Quote data or null if unavailable
   */
  async fetchRealtimeFromTwelveData(ticker) {
    if (!TWELVE_DATA_API_KEY) {
      return null;
    }

    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${TWELVE_DATA_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.status === 'error' || !data.close) {
        return null;
      }

      return {
        date: new Date(),
        open: parseFloat(data.open),
        high: parseFloat(data.high),
        low: parseFloat(data.low),
        close: parseFloat(data.close),
        volume: parseInt(data.volume, 10),
        isRealtime: true
      };
    } catch (error) {
      console.log(`Twelve Data realtime quote failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch real-time quote from EODHD
   * @param {string} ticker - Stock ticker symbol
   * @param {string} exchange - Exchange code (default: US)
   * @returns {Promise<Object|null>} Quote data or null if unavailable
   */
  async fetchRealtimeFromEODHD(ticker, exchange = 'US') {
    if (!EODHD_API_KEY) {
      return null;
    }

    try {
      const symbol = ticker.includes('.') ? ticker : `${ticker}.${exchange}`;
      const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_API_KEY}&fmt=json`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.code === 'NOT_FOUND' || !data.close) {
        return null;
      }

      return {
        date: new Date(data.timestamp * 1000),
        open: parseFloat(data.open),
        high: parseFloat(data.high),
        low: parseFloat(data.low),
        close: parseFloat(data.close),
        volume: parseInt(data.volume, 10),
        isRealtime: true
      };
    } catch (error) {
      console.log(`EODHD realtime quote failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if US market is closed for the day
   * @returns {boolean} True if market has closed
   */
  isUSMarketClosed() {
    const now = new Date();
    // Convert to ET (Eastern Time)
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    const dayOfWeek = etTime.getDay();

    // Market is closed on weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return true;
    }

    // Market closes at 4:00 PM ET
    return hours > 16 || (hours === 16 && minutes >= 0);
  }

  /**
   * Check if a date is a weekend
   * @param {Date} date - Date to check
   * @returns {boolean} True if weekend
   */
  isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  /**
   * Get today's date in ET timezone as YYYY-MM-DD
   * @returns {string} Today's date string
   */
  getTodayET() {
    const now = new Date();
    const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return etDate.toISOString().split('T')[0];
  }

  /**
   * Supplement EOD data with real-time quote for current day if missing
   * @param {Array} bars - EOD bar data
   * @param {string} ticker - Stock ticker symbol
   * @param {string} dataSource - Data source preference
   * @returns {Promise<Array>} Bars with today's data appended if applicable
   */
  async supplementWithRealtime(bars, ticker, dataSource = 'auto') {
    // Check if market has closed today
    if (!this.isUSMarketClosed()) {
      console.log('Market still open - skipping realtime supplement');
      return bars;
    }

    const todayET = this.getTodayET();
    const todayDate = new Date(todayET);

    // Skip if today is a weekend
    if (this.isWeekend(todayDate)) {
      console.log('Today is weekend - no trading data expected');
      return bars;
    }

    // Check if we already have today's data
    if (bars.length > 0) {
      const lastBarDate = bars[bars.length - 1].date.toISOString().split('T')[0];
      if (lastBarDate === todayET) {
        console.log('Already have today\'s data');
        return bars;
      }
    }

    console.log(`Fetching realtime quote for ${ticker} to supplement missing ${todayET} data...`);

    // Try to get realtime quote
    let realtimeBar = null;

    if (dataSource === 'twelvedata' || dataSource === 'auto') {
      realtimeBar = await this.fetchRealtimeFromTwelveData(ticker);
    }

    if (!realtimeBar && (dataSource === 'eodhd' || dataSource === 'auto')) {
      realtimeBar = await this.fetchRealtimeFromEODHD(ticker);
    }

    if (realtimeBar) {
      // Normalize the date to today (midnight)
      realtimeBar.date = todayDate;
      bars.push(realtimeBar);
      console.log(`Added realtime data for ${todayET}: close=${realtimeBar.close}, volume=${realtimeBar.volume}`);
    } else {
      console.log('Could not fetch realtime quote');
    }

    return bars;
  }

  /**
   * Fetch stock data (Twelve Data primary, EODHD fallback)
   * @param {string} ticker - Stock ticker symbol
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} dataSource - Data source: 'auto', 'twelvedata', or 'eodhd'
   * @returns {Promise<Array>} Array of stock bars
   */
  async fetchStockData(ticker, startDate, endDate, dataSource = 'auto') {
    let bars;

    // If specific source requested, try only that source
    if (dataSource === 'twelvedata') {
      if (!TWELVE_DATA_API_KEY) {
        throw new Error('TWELVE_DATA_API_KEY not set');
      }
      bars = await this.fetchFromTwelveData(ticker, startDate, endDate);
      return await this.supplementWithRealtime(bars, ticker, dataSource);
    }

    if (dataSource === 'eodhd') {
      if (!EODHD_API_KEY) {
        throw new Error('EODHD_API_KEY not set');
      }
      bars = await this.fetchFromEODHD(ticker, startDate, endDate);
      return await this.supplementWithRealtime(bars, ticker, dataSource);
    }

    // Auto mode: Try Twelve Data first, then EODHD
    let primaryError;

    // Try Twelve Data first (primary)
    if (TWELVE_DATA_API_KEY) {
      try {
        bars = await this.fetchFromTwelveData(ticker, startDate, endDate);
        return await this.supplementWithRealtime(bars, ticker, dataSource);
      } catch (error) {
        primaryError = error;
        console.log(`Twelve Data failed: ${error.message}`);
      }
    } else {
      primaryError = new Error('TWELVE_DATA_API_KEY not set');
      console.log('Twelve Data: API key not configured');
    }

    // Try EODHD as fallback
    if (EODHD_API_KEY) {
      try {
        bars = await this.fetchFromEODHD(ticker, startDate, endDate);
        return await this.supplementWithRealtime(bars, ticker, dataSource);
      } catch (eodhdError) {
        console.error(`EODHD fallback also failed: ${eodhdError.message}`);
        throw new Error(`No data available for ${ticker}: Twelve Data (${primaryError.message}), EODHD (${eodhdError.message})`);
      }
    }

    throw new Error(`No data available for ${ticker}: ${primaryError.message}. Set TWELVE_DATA_API_KEY or EODHD_API_KEY.`);
  }

  /**
   * Filter out market movements using linear regression
   * @param {Array} stockData - Stock price data
   * @param {Array} marketData - Market index data (e.g., SPY)
   * @returns {Array} Stock data with residual returns
   */
  filterMarketMovements(stockData, marketData) {
    // Create a map of market data by date string
    const marketByDate = new Map();
    for (const bar of marketData) {
      marketByDate.set(bar.date.toISOString().split('T')[0], bar);
    }

    // Align and combine data
    const combined = [];

    for (const stockBar of stockData) {
      const dateStr = stockBar.date.toISOString().split('T')[0];
      const marketBar = marketByDate.get(dateStr);
      if (marketBar) {
        combined.push({ stock: stockBar, market: marketBar });
      }
    }

    // Calculate returns
    for (let i = 1; i < combined.length; i++) {
      combined[i].stockReturn =
        (combined[i].stock.close - combined[i - 1].stock.close) /
        combined[i - 1].stock.close;
      combined[i].marketReturn =
        (combined[i].market.close - combined[i - 1].market.close) /
        combined[i - 1].market.close;
    }

    // Filter out entries without returns
    const withReturns = combined.filter(
      (c) => c.stockReturn !== undefined && c.marketReturn !== undefined
    );

    // Linear regression
    const points = withReturns.map((c) => [c.marketReturn, c.stockReturn]);
    const regression = linearRegression(points);
    const slope = regression.m;
    const intercept = regression.b;

    // Calculate R-squared
    const yMean =
      withReturns.reduce((sum, c) => sum + c.stockReturn, 0) / withReturns.length;
    const ssTotal = withReturns.reduce(
      (sum, c) => sum + Math.pow(c.stockReturn - yMean, 2),
      0
    );
    const ssResidual = withReturns.reduce((sum, c) => {
      const predicted = slope * c.marketReturn + intercept;
      return sum + Math.pow(c.stockReturn - predicted, 2);
    }, 0);
    const rSquared = 1 - ssResidual / ssTotal;

    console.log(`Market correlation (R^2): ${rSquared.toFixed(3)}`);
    console.log(`Beta coefficient: ${slope.toFixed(3)}`);

    // Build result with residuals
    const result = [];
    for (const c of combined) {
      const bar = { ...c.stock };
      if (c.stockReturn !== undefined && c.marketReturn !== undefined) {
        bar.marketReturn = c.marketReturn;
        bar.stockReturn = c.stockReturn;
        bar.residualReturn = c.stockReturn - (slope * c.marketReturn + intercept);
      }
      result.push(bar);
    }

    return { data: result, regression: { slope, intercept, rSquared } };
  }

  /**
   * Identify potential event dates using volume and gap analysis
   * @param {Array} data - Analyzed stock data
   * @param {number} targetDates - Number of events to identify
   * @param {boolean} useResiduals - Use residual returns vs price gaps
   * @returns {Array} Data with isEarningsDate flags
   */
  identifyEarningsDates(data, targetDates = 15, useResiduals = true) {
    const result = data.map((bar) => ({ ...bar }));

    if (useResiduals && result.some((bar) => bar.residualReturn !== undefined)) {
      // Use absolute residual return directly as the gap percentage
      for (const bar of result) {
        bar.residualGapPct = Math.abs((bar.residualReturn ?? 0) * 100);
        bar.volumeGapProduct = bar.volume * bar.residualGapPct;
      }
    } else {
      // Use price gap calculation
      for (let i = 1; i < result.length; i++) {
        const prevClose = result[i - 1].close;
        const gap = Math.abs(((result[i].open - prevClose) / prevClose) * 100);
        result[i].priceGapPct = gap;
        result[i].volumeGapProduct = result[i].volume * gap;
      }
    }

    // Handle edge cases
    let effectiveTargetDates = targetDates;
    if (effectiveTargetDates <= 0) {
      effectiveTargetDates = 1;
    } else if (effectiveTargetDates > result.length - 1) {
      effectiveTargetDates = result.length - 1;
    }

    // Sort to find threshold (exclude zero-product bars — no real event signal)
    const products = result
      .map((bar) => bar.volumeGapProduct ?? 0)
      .filter((p) => !isNaN(p) && p > 0)
      .sort((a, b) => b - a);

    const threshold =
      products.length <= effectiveTargetDates
        ? 0
        : products[effectiveTargetDates - 1];

    // Mark event dates — require strictly positive product to avoid
    // thinly-traded stocks where volume*gap=0 on most days.
    // When ties at the threshold exist, cap to exactly targetDates by
    // ranking all candidates and taking the top N.
    const candidates = result
      .map((bar, i) => ({ idx: i, product: bar.volumeGapProduct ?? 0 }))
      .filter((c) => c.product > 0 && c.product >= threshold)
      .sort((a, b) => b.product - a.product)
      .slice(0, effectiveTargetDates);

    const selectedIndices = new Set(candidates.map((c) => c.idx));
    for (let i = 0; i < result.length; i++) {
      result[i].isEarningsDate = selectedIndices.has(i);
    }

    const datesFound = result.filter((bar) => bar.isEarningsDate).length;
    console.log(`Identified ${datesFound} potential event dates using volume * gap formula`);

    return result;
  }

  /**
   * Classify event reactions based on gap and intraday movement
   * @param {Array} data - Data with event dates flagged
   * @returns {Array} Data with classification labels
   */
  classifyEarningsReactions(data) {
    const result = data.map((bar) => ({ ...bar }));
    const earningsIndices = [];

    for (let i = 0; i < result.length; i++) {
      if (result[i].isEarningsDate) {
        earningsIndices.push(i);
      }
    }

    for (const idx of earningsIndices) {
      if (idx === 0) {
        result[idx].earningsClassification = 'unknown';
        result[idx].eventStrength = 0;
        continue;
      }

      const prevClose = result[idx - 1].close;
      const currentOpen = result[idx].open;
      const currentClose = result[idx].close;

      const gapNegative = prevClose > currentOpen;
      const intradayPositive = currentClose > currentOpen;
      const closedBelowPrevClose = currentClose < prevClose;

      let classification;

      if (gapNegative) {
        if (!closedBelowPrevClose) {
          // Gapped down but closed above prev close — surprisingly positive
          classification = 'surprising_positive';
        } else {
          classification = intradayPositive
            ? 'negative_anticipated'
            : 'surprising_negative';
        }
      } else {
        // Gapped up, but if it fell so much that close < prev close, it's surprising negative
        if (closedBelowPrevClose) {
          classification = 'surprising_negative';
        } else {
          classification = intradayPositive
            ? 'surprising_positive'
            : 'positive_anticipated';
        }
      }

      result[idx].earningsClassification = classification;
      // Calculate strength as percentage range
      result[idx].eventStrength =
        ((result[idx].high - result[idx].low) / result[idx].low) * 100;
    }

    // Set non-event dates to 'none'
    for (const bar of result) {
      if (!bar.isEarningsDate) {
        bar.earningsClassification = 'none';
        bar.eventStrength = 0;
      }
    }

    return result;
  }

  /**
   * Compute annualized historical (realized) volatility from daily returns
   * @param {Array} data - Analyzed stock data with stockReturn values
   * @returns {Object} { annualizedHV, dailyStdDev, sampleSize }
   */
  computeHistoricalVolatility(data) {
    const dailyReturns = data
      .map(bar => bar.stockReturn)
      .filter(r => r !== undefined && r !== null && !isNaN(r));

    if (dailyReturns.length < 5) {
      return { annualizedHV: 0, dailyStdDev: 0, sampleSize: dailyReturns.length };
    }

    const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / dailyReturns.length;
    const dailyStdDev = Math.sqrt(variance);
    const annualizedHV = dailyStdDev * Math.sqrt(252);

    return { annualizedHV, dailyStdDev, sampleSize: dailyReturns.length };
  }

  /**
   * Compute rolling annualized HV time series from daily returns
   * @param {Array} data - Analyzed stock data with date and stockReturn
   * @param {number} window - Rolling window size in trading days (default 20)
   * @returns {Array} [{ date, hv }] — annualized HV at each point
   */
  computeRollingHV(data, window = 20) {
    const series = [];
    for (let i = window; i < data.length; i++) {
      const slice = data.slice(i - window, i);
      const returns = slice
        .map(bar => bar.stockReturn)
        .filter(r => r !== undefined && r !== null && !isNaN(r));
      if (returns.length < window * 0.6) continue; // need at least 60% of window filled
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
      const annualizedHV = Math.sqrt(variance) * Math.sqrt(252);
      series.push({
        date: data[i].date.toISOString().split('T')[0],
        hv: annualizedHV
      });
    }
    return series;
  }

  /**
   * Fetch quarterly fundamental data (revenue, EPS) from EODHD or Yahoo Finance
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object|null>} Quarterly fundamentals or null if unavailable
   */
  async fetchFundamentals(ticker) {
    // Try EODHD fundamentals endpoint first
    if (EODHD_API_KEY) {
      try {
        const symbol = ticker.includes('.') ? ticker : `${ticker}.US`;
        const url = `https://eodhd.com/api/fundamentals/${symbol}?api_token=${EODHD_API_KEY}&fmt=json`;
        console.log(`Fetching fundamentals for ${ticker} from EODHD...`);
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.Financials && data.Financials.Income_Statement && data.Financials.Income_Statement.quarterly) {
          const quarterly = data.Financials.Income_Statement.quarterly;
          const balanceSheet = data.Financials?.Balance_Sheet?.quarterly || {};

          // Parse quarterly income statement data
          const quarters = Object.entries(quarterly)
            .map(([key, q]) => ({
              date: q.date || key,
              revenue: parseFloat(q.totalRevenue) || 0,
              netIncome: parseFloat(q.netIncome) || 0,
              grossProfit: parseFloat(q.grossProfit) || 0,
              operatingIncome: parseFloat(q.operatingIncome) || 0,
              eps: parseFloat(q.epsDiluted || q.epsBasic) || 0,
              ebitda: parseFloat(q.ebitda) || 0,
            }))
            .filter(q => q.revenue > 0)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

          // Get last 16 quarters (4 years) max
          const recentQuarters = quarters.slice(-16);

          if (recentQuarters.length === 0) {
            console.log(`No quarterly revenue data found for ${ticker}`);
            return null;
          }

          // Compute YoY growth rates (compare to same quarter previous year)
          for (let i = 0; i < recentQuarters.length; i++) {
            if (i >= 4) {
              const prev = recentQuarters[i - 4];
              recentQuarters[i].revenueGrowthYoY = prev.revenue > 0
                ? ((recentQuarters[i].revenue - prev.revenue) / prev.revenue) * 100
                : null;
              recentQuarters[i].epsGrowthYoY = prev.eps !== 0
                ? ((recentQuarters[i].eps - prev.eps) / Math.abs(prev.eps)) * 100
                : null;
            }
          }

          // Compute gross margin and operating margin
          for (const q of recentQuarters) {
            q.grossMargin = q.revenue > 0 ? (q.grossProfit / q.revenue) * 100 : null;
            q.operatingMargin = q.revenue > 0 ? (q.operatingIncome / q.revenue) * 100 : null;
          }

          console.log(`Fetched ${recentQuarters.length} quarters of fundamental data for ${ticker}`);
          return {
            quarters: recentQuarters,
            source: 'eodhd',
          };
        }
      } catch (err) {
        console.error(`EODHD fundamentals fetch failed: ${err.message}`);
      }
    }

    // Fallback: try Twelve Data earnings endpoint for EPS at minimum
    if (TWELVE_DATA_API_KEY) {
      try {
        const url = `https://api.twelvedata.com/earnings?symbol=${encodeURIComponent(ticker)}&apikey=${TWELVE_DATA_API_KEY}`;
        console.log(`Fetching earnings for ${ticker} from Twelve Data...`);
        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'error' && data.earnings && data.earnings.length > 0) {
          const quarters = data.earnings
            .map(e => ({
              date: e.date,
              revenue: 0, // Not available from this endpoint
              netIncome: 0,
              grossProfit: 0,
              operatingIncome: 0,
              eps: parseFloat(e.eps_actual) || 0,
              epsEstimate: parseFloat(e.eps_estimate) || 0,
              epsSurprise: parseFloat(e.eps_actual) - parseFloat(e.eps_estimate) || 0,
              ebitda: 0,
            }))
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(-16);

          if (quarters.length > 0) {
            console.log(`Fetched ${quarters.length} quarters of EPS data for ${ticker} (Twelve Data)`);
            return {
              quarters,
              source: 'twelvedata',
            };
          }
        }
      } catch (err) {
        console.error(`Twelve Data earnings fetch failed: ${err.message}`);
      }
    }

    console.log(`No fundamentals data available for ${ticker}`);
    return null;
  }

  /**
   * Run full analysis pipeline
   * @param {string} ticker - Stock ticker
   * @param {Object} options - Analysis options
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeStock(ticker, options = {}) {
    const { benchmark = 'SPY', days = 200, minEvents = 15, dataSource = 'auto' } = options;

    const endDate = new Date().toISOString().split('T')[0];
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - days);
    const startDate = startDateObj.toISOString().split('T')[0];

    console.log(`\n=== STOCK ANALYSIS ===`);
    console.log(`Analyzing ${ticker} vs ${benchmark}`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    console.log(`Data source: ${dataSource}`);

    // Fetch data (with delay between requests to avoid rate limiting)
    const stockData = await this.fetchStockData(ticker, startDate, endDate, dataSource);
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay between tickers
    const marketData = await this.fetchStockData(benchmark, startDate, endDate, dataSource);

    // Filter market movements
    console.log('\nFiltering out market movements...');
    const { data: stockFiltered, regression } = this.filterMarketMovements(stockData, marketData);

    // Identify events
    console.log('\nIdentifying potential event dates...');
    const stockWithEarnings = this.identifyEarningsDates(
      stockFiltered,
      minEvents,
      true
    );

    // Classify events
    console.log('\nClassifying event reactions...');
    const stockWithClassifications = this.classifyEarningsReactions(stockWithEarnings);

    // Extract events and sort by date descending (newest first)
    const events = stockWithClassifications
      .filter((bar) => bar.isEarningsDate)
      .map((bar) => ({
        date: bar.date,
        dateStr: bar.date.toISOString().split('T')[0],
        classification: bar.earningsClassification,
        strength: bar.eventStrength,
        open: bar.open,
        close: bar.close,
        high: bar.high,
        low: bar.low,
        volume: bar.volume,
        residualReturn: bar.residualReturn,
        volumeGapProduct: bar.volumeGapProduct,
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    // Calculate stats
    const classificationCounts = {};
    for (const event of events) {
      classificationCounts[event.classification] =
        (classificationCounts[event.classification] || 0) + 1;
    }

    return {
      data: stockWithClassifications,
      events,
      stats: {
        totalEvents: events.length,
        classifications: classificationCounts,
        dateRange: { start: startDate, end: endDate },
        regression,
      },
    };
  }

  /**
   * Compute empirical hold duration from accumulated events in the database
   * @param {Object} database - Database instance with getAggregatePostEventReturns()
   * @returns {Promise<Object|null>} Empirical hold data or null if insufficient events
   */
  async computeEmpiricalHold(database, maxForwardDays = 60) {
    const totalEvents = await database.getTotalEventCount();
    if (totalEvents < 5) {
      console.log(`Empirical hold: only ${totalEvents} events in DB (need >= 5), skipping`);
      return null;
    }

    const totalStocks = await database.getDistinctEventTickers();
    const rows = await database.getAggregatePostEventReturns(maxForwardDays, 3);

    if (!rows || rows.length === 0) {
      console.log('Empirical hold: no forward return data available yet');
      return null;
    }

    // Group rows by classification (coerce BigInt to Number for JSON serialization)
    const byClassification = {};
    for (const row of rows) {
      const cls = row.classification;
      if (!byClassification[cls]) byClassification[cls] = [];
      byClassification[cls].push({
        day: Number(row.day),
        n_events: Number(row.n_events),
        median_return: Number(row.median_return),
        p25_return: Number(row.p25_return),
        p75_return: Number(row.p75_return),
      });
    }

    // For each classification, find the day with max median return (peak)
    const classifications = {};
    for (const [cls, days] of Object.entries(byClassification)) {
      if (days.length === 0) continue;
      let peakDay = 1;
      let peakReturn = -Infinity;
      for (const d of days) {
        if (d.median_return > peakReturn) {
          peakReturn = d.median_return;
          peakDay = d.day;
        }
      }
      classifications[cls] = {
        holdDays: peakDay,
        peakReturn: peakReturn * 100, // convert to percentage
        eventCount: days[0].n_events,
        byDay: days,
      };
    }

    console.log(`Empirical hold: ${totalEvents} events across ${totalStocks} stocks`);
    for (const [cls, data] of Object.entries(classifications)) {
      console.log(`  ${cls}: hold ${data.holdDays} days, peak ${data.peakReturn.toFixed(2)}%`);
    }

    return {
      classifications,
      totalEvents: Number(totalEvents),
      totalStocks: Number(totalStocks),
      maxForwardDays,
    };
  }

  /**
   * Find articles related to an event date from the accumulated corpus
   * @param {Date} eventDate - Event date
   * @param {string} ticker - Stock ticker
   * @param {number} dayRange - Days before/after to search
   * @returns {Promise<Array>} Related articles with uniqueness scores
   */
  async findRelatedArticles(eventDate, ticker, dayRange = 3) {
    try {
      // Use the new method that includes embeddings for similarity calculation
      const articles = await this.database.getArticlesByTickerAndDateRange(
        ticker,
        eventDate,
        dayRange
      );

      if (articles.length === 0) {
        return [];
      }

      // Calculate uniqueness for each article against the full corpus
      for (const article of articles) {
        article.uniqueness = await this.calculateArticleUniquenessAgainstCorpus(article, ticker);
      }

      return articles;
    } catch (error) {
      console.error(`Error finding related articles: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate how unique an article is compared to the full accumulated corpus
   * Uses the accumulated database of articles for comparison, providing more
   * accurate uniqueness scores as the corpus grows over time.
   *
   * @param {Object} article - Article with embedding
   * @param {string} ticker - Stock ticker
   * @returns {Promise<number>} Uniqueness score (0-1, higher = more unique)
   */
  async calculateArticleUniquenessAgainstCorpus(article, ticker) {
    try {
      // Get article's embedding
      let articleEmbedding = article.embedding;

      // If no embedding stored, we can't calculate uniqueness
      if (!articleEmbedding) {
        return 0.5; // Default middle value
      }

      // Parse embedding if it's a string (DuckDB returns arrays directly, but be safe)
      if (typeof articleEmbedding === 'string') {
        try {
          articleEmbedding = JSON.parse(articleEmbedding);
        } catch {
          return 0.5;
        }
      }

      // Get all articles for this ticker from the accumulated corpus (with embeddings)
      const corpusArticles = await this.database.getArticlesWithEmbeddingsByTicker(ticker, {
        excludeArticleId: article.id,
        limit: 100 // Compare against up to 100 most recent articles
      });

      if (corpusArticles.length === 0) {
        // No other articles to compare against - can't determine uniqueness
        return 0.5;
      }

      // Calculate similarity to each article in the corpus
      let maxSimilarity = 0;
      let totalSimilarity = 0;
      let comparisons = 0;

      for (const other of corpusArticles) {
        let otherEmbedding = other.embedding;

        // Parse embedding if needed
        if (typeof otherEmbedding === 'string') {
          try {
            otherEmbedding = JSON.parse(otherEmbedding);
          } catch {
            continue;
          }
        }

        if (!otherEmbedding || otherEmbedding.length !== articleEmbedding.length) {
          continue;
        }

        try {
          const similarity = embeddingService.cosineSimilarity(
            articleEmbedding,
            otherEmbedding
          );
          maxSimilarity = Math.max(maxSimilarity, similarity);
          totalSimilarity += similarity;
          comparisons++;
        } catch {
          continue;
        }
      }

      if (comparisons === 0) {
        return 0.5; // No valid comparisons possible
      }

      // Calculate uniqueness using a weighted approach:
      // - Primarily based on max similarity (how similar is the closest article?)
      // - Slightly adjusted by average similarity (overall corpus similarity)
      const avgSimilarity = totalSimilarity / comparisons;

      // Weight: 70% max similarity, 30% average similarity
      const weightedSimilarity = (maxSimilarity * 0.7) + (avgSimilarity * 0.3);

      // Uniqueness = 1 - weighted similarity
      const uniqueness = Math.max(0, Math.min(1, 1 - weightedSimilarity));

      return uniqueness;
    } catch (error) {
      console.error(`Error calculating uniqueness against corpus: ${error.message}`);
      return 0.5;
    }
  }

  /**
   * Check if article URL already exists in database
   * @param {string} url - Article URL
   * @returns {Promise<Object|null>} Existing article or null
   */
  async checkArticleExists(url) {
    return new Promise((resolve, reject) => {
      this.database.connection.all(
        'SELECT id, url, title, published_date, embedding FROM articles WHERE url = ?',
        [url],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows && rows.length > 0 ? rows[0] : null);
          }
        }
      );
    });
  }

  /**
   * Calculate pairwise similarity between articles for an event
   * @param {Array} articles - Articles (may or may not have embeddings)
   * @returns {Promise<Array>} Articles with similarity data
   */
  async calculateArticleSimilarities(articles) {
    if (!articles || articles.length < 2) {
      return (articles || []).map(a => ({
        ...a,
        similarities: [],
        avgSimilarity: null
      }));
    }

    // Get full article data with embeddings for those that don't have them
    const articlesWithEmbeddings = [];
    for (const article of articles) {
      if (article.embedding) {
        articlesWithEmbeddings.push(article);
      } else if (article.id) {
        // Fetch full article with embedding from DB
        const full = await this.getArticleById(article.id);
        if (full) {
          articlesWithEmbeddings.push({ ...article, embedding: full.embedding });
        } else {
          articlesWithEmbeddings.push(article);
        }
      } else {
        articlesWithEmbeddings.push(article);
      }
    }

    const results = [];

    for (let i = 0; i < articlesWithEmbeddings.length; i++) {
      const article = articlesWithEmbeddings[i];
      const similarities = [];

      // Parse embedding if needed
      let emb1 = article.embedding;
      if (typeof emb1 === 'string') {
        try { emb1 = JSON.parse(emb1); } catch { emb1 = null; }
      }

      if (!emb1) {
        results.push({
          ...article,
          similarities: [],
          avgSimilarity: null,
          uniqueness: 0.5
        });
        continue;
      }

      for (let j = 0; j < articlesWithEmbeddings.length; j++) {
        if (i === j) continue;

        const other = articlesWithEmbeddings[j];
        let emb2 = other.embedding;
        if (typeof emb2 === 'string') {
          try { emb2 = JSON.parse(emb2); } catch { emb2 = null; }
        }

        if (emb2 && emb1.length === emb2.length) {
          try {
            const sim = embeddingService.cosineSimilarity(emb1, emb2);
            similarities.push({
              articleId: other.id,
              title: other.title,
              similarity: sim
            });
          } catch {
            // Skip on error
          }
        }
      }

      // Calculate average similarity
      const avgSim = similarities.length > 0
        ? similarities.reduce((sum, s) => sum + s.similarity, 0) / similarities.length
        : null;

      results.push({
        ...article,
        similarities: similarities.sort((a, b) => b.similarity - a.similarity),
        avgSimilarity: avgSim,
        uniqueness: avgSim !== null ? 1 - avgSim : 0.5
      });
    }

    return results;
  }

  /**
   * Get article by ID with full data including embedding
   * @param {number} id - Article ID
   * @returns {Promise<Object|null>} Article data or null
   */
  async getArticleById(id) {
    return new Promise((resolve, reject) => {
      this.database.connection.all(
        'SELECT id, url, title, content, published_date, embedding FROM articles WHERE id = ?',
        [id],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows && rows.length > 0 ? rows[0] : null);
          }
        }
      );
    });
  }

  /**
   * Build a 25-element feature vector from options data
   * 7 features per expiration (3 nearest) + 2 aggregate features
   * @param {Object} optionsData - Options analysis result with expirations, summary, eventAnticipation
   * @returns {Float64Array} 25-element feature vector
   */
  buildOptionsFeatureVector(optionsData, referenceDate = null) {
    const vec = new Float64Array(25);
    if (!optionsData || !optionsData.expirations) return null;

    // Use referenceDate for DTE calculations (critical for historical snapshots)
    const refTime = referenceDate ? new Date(referenceDate).getTime() : Date.now();

    // Sort expirations by DTE ascending (ranked by distance from reference date)
    const sorted = [...optionsData.expirations]
      .filter(e => e.expirationDate)
      .map(e => {
        const expDate = new Date(e.expirationDate);
        const dte = Math.max(1, Math.round((expDate - refTime) / (1000 * 60 * 60 * 24)));
        return { ...e, dte };
      })
      .filter(e => e.dte > 0)
      .sort((a, b) => a.dte - b.dte)
      .slice(0, 3);

    // 8 features per expiration
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const offset = i * 8;
      vec[offset + 0] = e.totalCallDollarVolume || 0;     // OTM call dollar volume
      vec[offset + 1] = e.totalPutDollarVolume || 0;      // OTM put dollar volume
      vec[offset + 2] = e.totalCallDollarVolumeAll || 0;  // all-strikes call dollar volume
      vec[offset + 3] = e.totalPutDollarVolumeAll || 0;   // all-strikes put dollar volume
      vec[offset + 4] = e.avgCallIV || 0;                 // avg OTM call IV
      vec[offset + 5] = e.avgPutIV || 0;                  // avg OTM put IV
      vec[offset + 6] = e.avgCallIVAll || 0;              // avg all-strikes call IV
      vec[offset + 7] = e.avgPutIVAll || 0;               // avg all-strikes put IV
    }
    // Remaining expiration slots (if < 3) stay zero-filled

    // Recompute termStructureSlope from per-expiration OTM IVs
    const atmEntries = sorted
      .filter(e => (e.avgCallIV || e.avgPutIV))
      .map(e => ({ dte: e.dte, atmIV: ((e.avgCallIV || 0) + (e.avgPutIV || 0)) / 2 }))
      .filter(e => e.atmIV > 0);

    let termStructureSlope = 0;
    if (atmEntries.length >= 2) {
      const first = atmEntries[0];
      const last = atmEntries[atmEntries.length - 1];
      const dteDiff = last.dte - first.dte;
      if (dteDiff > 0) {
        termStructureSlope = ((last.atmIV - first.atmIV) / dteDiff) * 30;
      }
    }
    vec[24] = termStructureSlope;

    return vec;
  }

  /**
   * Compute cosine similarity between two vectors
   * @param {Float64Array|Array} a
   * @param {Float64Array|Array} b
   * @returns {number} Cosine similarity (-1 to 1)
   */
  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * Build a 25-element feature vector from raw DB snapshot rows
   * @param {Array} snapshotRows - Rows from getOptionsSnapshotsByDate
   * @param {string} snapshotDate - The snapshot date (for DTE calculations)
   * @returns {Float64Array|null} 25-element vector or null if no data
   */
  buildFeatureVectorFromSnapshots(snapshotRows, snapshotDate) {
    if (!snapshotRows || snapshotRows.length === 0) return null;

    const expirations = snapshotRows.map(s => ({
      expirationDate: s.expiration_date,
      totalCallDollarVolume: Number(s.total_call_dollar_volume) || 0,
      totalPutDollarVolume: Number(s.total_put_dollar_volume) || 0,
      totalCallDollarVolumeAll: Number(s.total_call_dollar_volume_all) || 0,
      totalPutDollarVolumeAll: Number(s.total_put_dollar_volume_all) || 0,
      avgCallIV: Number(s.avg_call_iv) || 0,
      avgPutIV: Number(s.avg_put_iv) || 0,
      avgCallIVAll: Number(s.avg_call_iv_all) || 0,
      avgPutIVAll: Number(s.avg_put_iv_all) || 0,
    }));

    return this.buildOptionsFeatureVector({ expirations }, snapshotDate);
  }

  /**
   * Compute options-adjusted hold duration using lazy query-time matching
   * @param {Object} database - Database instance
   * @param {number} maxForwardDays - Maximum forward days
   * @param {Object} optionsData - Current live options analysis data
   * @param {string} ticker - Current ticker being analyzed
   * @returns {Promise<Object|null>} Adjusted hold data or null
   */
  async computeOptionsAdjustedHold(database, maxForwardDays, optionsData, ticker) {
    if (!optionsData) return null;

    // 1. Build query vector from live optionsData
    const queryVec = this.buildOptionsFeatureVector(optionsData);
    if (!queryVec) return null;
    const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
    if (queryNorm === 0) return null;

    // 2. Get ALL events with optional cached vectors
    const allEvents = await database.getAllEventsWithOptionalFeatures();
    if (!allEvents || allEvents.length === 0) return null;

    // 3. For each event, resolve its feature vector (cached or lazy-build)
    const eventSimilarities = [];
    for (const event of allEvents) {
      let fv = event.feature_vector;

      // Parse if stored as string
      if (typeof fv === 'string') {
        try { fv = JSON.parse(fv); } catch { fv = null; }
      }

      // Use cached vector if valid 25-element
      if (fv && fv.length === 25) {
        // Already cached — use directly
      } else {
        // Lazy: find nearest options snapshot to this event's date
        const nearest = await database.findNearestOptionsSnapshot(event.ticker, event.event_date);
        if (!nearest) continue; // No snapshot available — skip

        const snapshotRows = await database.getOptionsSnapshotsByDate(event.ticker, nearest.snapshotDate);
        fv = this.buildFeatureVectorFromSnapshots(snapshotRows, nearest.snapshotDate);
        if (!fv) continue;

        // Cache for next time
        try {
          await database.saveEventOptionsFeatures(
            event.event_id, nearest.snapshotDate, nearest.lagDays, fv
          );
        } catch (cacheErr) {
          // Non-fatal — just skip caching
        }
      }

      const sim = this._cosineSimilarity(queryVec, fv);
      const weight = Math.max(0, sim);
      if (weight > 0) {
        eventSimilarities.push({
          eventId: event.event_id,
          classification: event.classification,
          similarity: sim,
          weight,
          lagDays: event.snapshot_lag_days || 0,
        });
      }
    }

    if (eventSimilarities.length === 0) return null;

    // 4. Get forward returns for matched events
    const matchedIds = eventSimilarities.map(e => e.eventId);
    const forwardReturns = await database.getPerEventForwardReturns(matchedIds, maxForwardDays);
    if (!forwardReturns || forwardReturns.length === 0) return null;

    // Build similarity lookup
    const simMap = new Map();
    for (const es of eventSimilarities) {
      simMap.set(es.eventId, es);
    }

    // Group forward returns by (classification, day)
    const groups = {};
    for (const r of forwardReturns) {
      const key = `${r.classification}|${r.day}`;
      if (!groups[key]) groups[key] = [];
      const es = simMap.get(r.event_id);
      if (es) {
        groups[key].push({ cum_return: r.cum_return, weight: es.weight });
      }
    }

    // 5. Compute weighted median for each (classification, day)
    const byClassification = {};
    for (const [key, entries] of Object.entries(groups)) {
      const [cls, dayStr] = key.split('|');
      const day = parseInt(dayStr);

      entries.sort((a, b) => a.cum_return - b.cum_return);
      const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
      if (totalWeight === 0) continue;

      let accum = 0;
      let median = entries[0].cum_return;
      for (const e of entries) {
        accum += e.weight;
        if (accum >= totalWeight * 0.5) {
          median = e.cum_return;
          break;
        }
      }

      accum = 0;
      let p25 = entries[0].cum_return;
      for (const e of entries) {
        accum += e.weight;
        if (accum >= totalWeight * 0.25) {
          p25 = e.cum_return;
          break;
        }
      }

      accum = 0;
      let p75 = entries[0].cum_return;
      for (const e of entries) {
        accum += e.weight;
        if (accum >= totalWeight * 0.75) {
          p75 = e.cum_return;
          break;
        }
      }

      if (!byClassification[cls]) byClassification[cls] = [];
      byClassification[cls].push({
        day,
        n_events: entries.length,
        median_return: median,
        p25_return: p25,
        p75_return: p75,
      });
    }

    // Find peak day per classification
    const classifications = {};
    for (const [cls, days] of Object.entries(byClassification)) {
      if (days.length === 0) continue;
      let peakDay = 1;
      let peakReturn = -Infinity;
      for (const d of days) {
        if (d.median_return > peakReturn) {
          peakReturn = d.median_return;
          peakDay = d.day;
        }
      }
      classifications[cls] = {
        holdDays: peakDay,
        peakReturn: peakReturn * 100,
        eventCount: days[0].n_events,
        byDay: days.sort((a, b) => a.day - b.day),
      };
    }

    // Compute aggregate stats
    const totalMatchedEvents = eventSimilarities.length;
    const avgSimilarity = eventSimilarities.reduce((s, e) => s + e.similarity, 0) / totalMatchedEvents;
    const avgSnapshotLag = eventSimilarities.reduce((s, e) => s + e.lagDays, 0) / totalMatchedEvents;

    console.log(`Options-adjusted hold: ${totalMatchedEvents} matched events, avg similarity ${(avgSimilarity * 100).toFixed(1)}%`);
    for (const [cls, data] of Object.entries(classifications)) {
      console.log(`  ${cls}: hold ${data.holdDays} days, peak ${data.peakReturn.toFixed(2)}%`);
    }

    return {
      classifications,
      totalMatchedEvents,
      avgSimilarity,
      avgSnapshotLag,
      weightedByOptions: true,
      maxForwardDays,
    };
  }

  /**
   * Compute snapshot-based optimal hold period using nearest-neighbor similarity
   * across ALL historical options snapshots (not event-based)
   * @param {Object} database - Database instance
   * @param {number} maxForwardDays - Maximum forward days
   * @param {Object} optionsData - Current live options analysis data
   * @returns {Promise<Object|null>} { byDay, peakDay, peakReturn, totalMatchedSnapshots, avgSimilarity }
   */
  async computeSnapshotOptimalHold(database, maxForwardDays, optionsData) {
    if (!optionsData) return null;

    // 1. Build query vector from live optionsData
    const queryVec = this.buildOptionsFeatureVector(optionsData);
    if (!queryVec) return null;
    const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
    if (queryNorm === 0) return null;

    // 2. Get all historical snapshots with optional cached vectors
    const allSnapshots = await database.getAllSnapshotDatesWithOptionalFeatures();
    if (!allSnapshots || allSnapshots.length === 0) return null;

    // 3. For each snapshot, resolve feature vector (cached or lazy-build + cache)
    const snapshotSimilarities = [];
    for (let idx = 0; idx < allSnapshots.length; idx++) {
      const snap = allSnapshots[idx];
      let fv = snap.feature_vector;

      // Parse if stored as string
      if (typeof fv === 'string') {
        try { fv = JSON.parse(fv); } catch { fv = null; }
      }

      // Use cached vector if valid 25-element
      if (fv && fv.length === 25) {
        // Already cached
      } else {
        // Lazy-build from raw snapshot rows
        const snapshotRows = await database.getOptionsSnapshotsByDate(snap.ticker, snap.snapshot_date);
        fv = this.buildFeatureVectorFromSnapshots(snapshotRows, snap.snapshot_date);
        if (!fv) continue;

        // Cache for next time
        try {
          await database.saveSnapshotOptionsFeatures(snap.ticker, snap.snapshot_date, fv);
        } catch (cacheErr) {
          // Non-fatal
        }
      }

      const sim = this._cosineSimilarity(queryVec, fv);
      if (sim > 0) {
        snapshotSimilarities.push({
          id: idx,
          ticker: snap.ticker,
          snapshotDate: snap.snapshot_date,
          similarity: sim,
          weight: sim,
        });
      }
    }

    if (snapshotSimilarities.length === 0) return null;

    // 4. Top-K limit: keep top 200 by similarity if too many
    snapshotSimilarities.sort((a, b) => b.similarity - a.similarity);
    const topK = snapshotSimilarities.slice(0, 200);

    // 5. Get forward returns
    const dateEntries = topK.map((s, i) => ({ id: i, ticker: s.ticker, snapshotDate: s.snapshotDate }));
    const forwardReturns = await database.getForwardReturnsFromDates(dateEntries, maxForwardDays);
    if (!forwardReturns || forwardReturns.length === 0) return null;

    // Build weight lookup by entry id
    const weightMap = new Map();
    for (let i = 0; i < topK.length; i++) {
      weightMap.set(i, topK[i].weight);
    }

    // 6. Group by day only (no classification), compute weighted median per day
    const dayGroups = {};
    for (const r of forwardReturns) {
      if (!dayGroups[r.day]) dayGroups[r.day] = [];
      const w = weightMap.get(r.id) || 0;
      if (w > 0) {
        dayGroups[r.day].push({ cum_return: r.cum_return, weight: w });
      }
    }

    const byDay = [];
    for (const [dayStr, entries] of Object.entries(dayGroups)) {
      const day = parseInt(dayStr);
      entries.sort((a, b) => a.cum_return - b.cum_return);
      const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
      if (totalWeight === 0) continue;

      let accum = 0;
      let median = entries[0].cum_return;
      for (const e of entries) {
        accum += e.weight;
        if (accum >= totalWeight * 0.5) {
          median = e.cum_return;
          break;
        }
      }

      byDay.push({ day, n_snapshots: entries.length, median_return: median });
    }

    byDay.sort((a, b) => a.day - b.day);

    // 7. Find peak day
    let peakDay = 1, peakReturn = -Infinity;
    for (const d of byDay) {
      if (d.median_return > peakReturn) {
        peakReturn = d.median_return;
        peakDay = d.day;
      }
    }

    const totalMatchedSnapshots = topK.length;
    const avgSimilarity = topK.reduce((s, e) => s + e.similarity, 0) / totalMatchedSnapshots;

    console.log(`Snapshot optimal hold: ${totalMatchedSnapshots} matched snapshots, avg similarity ${(avgSimilarity * 100).toFixed(1)}%`);

    return {
      byDay,
      peakDay,
      peakReturn: peakReturn * 100,
      totalMatchedSnapshots,
      avgSimilarity,
      maxForwardDays,
    };
  }

  /**
   * Generate HTML analysis report
   * @param {Array} data - Full analyzed data
   * @param {Array} events - Events with related articles
   * @param {string} ticker - Stock ticker
   * @returns {string} HTML content
   */
  generateAnalysisHTML(data, events, ticker, optionsData = null, empiricalHoldData = null, currentQuote = null, fundamentalsData = null, finvizNews = null) {
    const classificationColors = {
      negative_anticipated: 'orange',
      surprising_negative: 'red',
      positive_anticipated: 'lightgreen',
      surprising_positive: 'darkgreen',
      unknown: 'gray',
      none: 'blue',
    };

    // Prepare chart data
    const dates = data.map((b) => b.date.toISOString().split('T')[0]);
    const closes = data.map((b) => b.close);
    const volumes = data.map((b) => b.volume);
    const residualReturns = data.map((b) => (b.residualReturn ?? 0) * 100);
    const volumeGapProducts = data.map((b) =>
      Math.log10(Math.max(b.volumeGapProduct ?? 1, 1))
    );

    // Events data for charts
    const earningsData = data.filter((b) => b.isEarningsDate);
    const earningsScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split('T')[0],
      y: b.close,
      classification: b.earningsClassification ?? 'none',
    }));

    const earningsVolumeIndices = data
      .map((b, i) => (b.isEarningsDate ? i : -1))
      .filter((i) => i >= 0);

    const earningsResidualScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split('T')[0],
      y: (b.residualReturn ?? 0) * 100,
    }));

    const earningsVolumeGapScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split('T')[0],
      y: Math.log10(Math.max(b.volumeGapProduct ?? 1, 1)),
    }));

    const strengthData = earningsData.map((b) => ({
      date: b.date.toISOString().split('T')[0],
      strength: b.eventStrength ?? 0,
      classification: b.earningsClassification ?? 'none',
      color: classificationColors[b.earningsClassification ?? 'none'],
    }));

    const avgStrength =
      strengthData.length > 0
        ? strengthData.reduce((sum, d) => sum + d.strength, 0) / strengthData.length
        : 0;

    const threshold = earningsData.length > 0
      ? Math.min(...earningsData.map((b) => b.volumeGapProduct ?? 0))
      : 0;

    // Compute historical volatility values at method scope (used in both options section and chart)
    const hv = optionsData?.historicalVolatility?.annualizedHV || 0;
    const hvPct = (hv * 100).toFixed(1);

    // Generate Event Anticipation panel
    const ea = optionsData?.eventAnticipation;
    const anticipationPanelHTML = ea ? (() => {
      const idx = ea.compositeIndex;
      const badgeClass = idx >= 70 ? 'extreme' : idx >= 50 ? 'high' : idx >= 30 ? 'moderate' : idx >= 15 ? 'low' : 'none';
      const barColor = (score, max) => {
        const pct = max > 0 ? score / max : 0;
        if (pct >= 0.7) return '#e53e3e';
        if (pct >= 0.5) return '#dd6b20';
        if (pct >= 0.3) return '#d69e2e';
        return '#38a169';
      };

      const componentHTML = (name, score, maxScore, signal, detailHTML, extraClass = '') => `
        <div class="component-row${detailHTML ? ' expandable' : ''}${extraClass ? ' ' + extraClass : ''}">
          <div class="component-header">
            <span class="component-name">${name}</span>
            <div style="display:flex;align-items:center;gap:6px;">
              ${score !== '' ? `<span class="component-score">${score}/${maxScore}</span>` : ''}
              ${detailHTML ? '<span class="component-toggle">&#9654;</span>' : ''}
            </div>
          </div>
          ${score !== '' ? `<div class="component-bar">
            <div class="component-bar-fill" style="width:${maxScore > 0 ? (score / maxScore * 100) : 0}%;background:${barColor(score, maxScore)}"></div>
          </div>` : ''}
          <div class="component-signal">${signal}</div>
          ${detailHTML ? '<div class="component-detail">' + detailHTML + '</div>' : ''}
        </div>`;

      const c = ea.components;
      const s = optionsData?.summary || {};
      const calloutsHTML = ea.callouts.length > 0
        ? `<div class="anticipation-callouts">${ea.callouts.map(c => `<p>${c}</p>`).join('')}</div>`
        : '';

      // Term structure mini data for chart
      const termData = c.termStructure.data || [];
      const hasTermChart = termData.length >= 2;

      // --- Detail HTML for expandable component cards ---
      const hasRollingHV = (optionsData?.rollingHV?.length || 0) > 5;

      const vrpDetail = '<table class="detail-table">'
        + '<tr><td>Call IV (OTM avg)</td><td>' + ((s.avgCallIV || 0) * 100).toFixed(1) + '%</td></tr>'
        + '<tr><td>Put IV (OTM avg)</td><td>' + ((s.avgPutIV || 0) * 100).toFixed(1) + '%</td></tr>'
        + '<tr><td>Blended IV</td><td>' + ((s.avgAtmIV || 0) * 100).toFixed(1) + '%</td></tr>'
        + '<tr><td>Historical Volatility</td><td>' + hvPct + '%</td></tr>'
        + '<tr><td>VRP Ratio (IV / HV)</td><td>' + (c.vrp.ratio > 0 ? c.vrp.ratio.toFixed(2) + 'x' : 'N/A') + '</td></tr>'
        + '<tr><td>VRP Spread (IV &minus; HV)</td><td>' + (c.vrp.ratio > 0 ? (c.vrp.spread * 100).toFixed(1) + 'pp' : 'N/A') + '</td></tr>'
        + '</table>'
        + '<div class="detail-interp">&gt;1.50x Strong event premium · 1.20–1.50x Moderate · 0.80–1.20x Normal · &lt;0.80x Compression</div>'
        + (hasRollingHV ? '<div class="detail-chart"><canvas id="vrpMiniChart"></canvas></div>' : '');

      const tsData = c.termStructure.data || [];
      const termDetail = '<table class="detail-table">'
        + '<tr><td>Shape</td><td>' + c.termStructure.shape + '</td></tr>'
        + '<tr><td>Slope (per 30d)</td><td>' + (c.termStructure.slope ? (c.termStructure.slope * 100).toFixed(2) + 'pp' : 'N/A') + '</td></tr>'
        + (c.termStructure.kink ? '<tr><td>Kink detected</td><td>' + c.termStructure.kink.signal + '</td></tr>' : '')
        + '</table>'
        + (tsData.length > 0
          ? '<table class="detail-table"><thead><tr><th>Expiry</th><th>DTE</th><th>Call IV</th><th>Put IV</th></tr></thead><tbody>'
            + tsData.map(d =>
              '<tr><td>' + new Date(d.expirationDate).toLocaleDateString('en-US', {month:'short',day:'numeric'}) + '</td>'
              + '<td>' + d.daysToExpiry + 'd</td>'
              + '<td>' + ((d.callIV || 0) * 100).toFixed(1) + '%</td>'
              + '<td>' + ((d.putIV || 0) * 100).toFixed(1) + '%</td></tr>'
            ).join('') + '</tbody></table>'
          : '')
        + (hasTermChart ? '<div class="detail-chart"><canvas id="termStructureChart"></canvas></div>' : '')
        + '<div id="tsSmileWrapOTM" style="display:none;margin-top:12px;"><div class="detail-chart"><canvas id="tsSmileChartOTM"></canvas></div></div>';

      const tsDataAll = c.termStructureAll ? c.termStructureAll.data || [] : [];
      const hasTermChartAll = tsDataAll.length >= 2;
      const termDetailAll = '<table class="detail-table">'
        + '<tr><td>Shape</td><td>' + (c.termStructureAll ? c.termStructureAll.shape : 'N/A') + '</td></tr>'
        + '<tr><td>Slope (per 30d)</td><td>' + (c.termStructureAll && c.termStructureAll.slope ? (c.termStructureAll.slope * 100).toFixed(2) + 'pp' : 'N/A') + '</td></tr>'
        + (c.termStructureAll && c.termStructureAll.kink ? '<tr><td>Kink detected</td><td>' + c.termStructureAll.kink.signal + '</td></tr>' : '')
        + '</table>'
        + (tsDataAll.length > 0
          ? '<table class="detail-table"><thead><tr><th>Expiry</th><th>DTE</th><th>Call IV</th><th>Put IV</th></tr></thead><tbody>'
            + tsDataAll.map(d =>
              '<tr><td>' + new Date(d.expirationDate).toLocaleDateString('en-US', {month:'short',day:'numeric'}) + '</td>'
              + '<td>' + d.daysToExpiry + 'd</td>'
              + '<td>' + ((d.callIV || 0) * 100).toFixed(1) + '%</td>'
              + '<td>' + ((d.putIV || 0) * 100).toFixed(1) + '%</td></tr>'
            ).join('') + '</tbody></table>'
          : '')
        + (hasTermChartAll ? '<div class="detail-chart"><canvas id="termStructureChartAll"></canvas></div>' : '')
        + '<div id="tsSmileWrapAll" style="display:none;margin-top:12px;"><div class="detail-chart"><canvas id="tsSmileChartAll"></canvas></div></div>';

      const vcPerExp = c.volumeConviction.perExpiration || [];
      const hasConvictionChart = vcPerExp.length >= 2;
      const volumeDetail = hasConvictionChart
        ? '<div class="detail-chart"><canvas id="dollarConvictionChart"></canvas></div>'
        + '<div id="strikeDrilldownWrap" style="display:none; margin-top:12px;"><div class="detail-chart"><canvas id="strikeDrilldownChart"></canvas></div></div>'
        : (vcPerExp.length === 1
          ? '<div class="detail-interp">Call IV: ' + (vcPerExp[0].avgCallIV * 100).toFixed(1) + '% &middot; Put IV: ' + (vcPerExp[0].avgPutIV * 100).toFixed(1) + '%'
            + ' &middot; Conv. Ratio: ' + vcPerExp[0].convictionRatio.toFixed(2)
            + '</div>'
          : '');

      const vcAllPerExp = c.volumeConvictionAll ? c.volumeConvictionAll.perExpiration || [] : [];
      const hasConvictionChartAll = vcAllPerExp.length >= 2;
      const volumeDetailAll = hasConvictionChartAll
        ? '<div class="detail-chart"><canvas id="dollarConvictionChartAll"></canvas></div>'
        + '<div id="strikeDrilldownWrapAll" style="display:none; margin-top:12px;"><div class="detail-chart"><canvas id="strikeDrilldownChartAll"></canvas></div></div>'
        : (vcAllPerExp.length === 1
          ? '<div class="detail-interp">Conv. Ratio: ' + vcAllPerExp[0].convictionRatio.toFixed(2)
            + '</div>'
          : '');

      // Call/Put Dollar Ratio cards (own expandable component cards)
      const hasOtmRatioChart = vcPerExp.length >= 1;
      const otmRatioDetail = hasOtmRatioChart
        ? '<div class="ratio-main-chart"><canvas id="cpRatioOtmChart"></canvas></div>'
          + '<div id="cpRatioOtmNoHistory" style="display:none; margin-top:12px; color:#718096; font-size:12px; text-align:center;">No historical data available for this expiration</div>'
          + '<div id="cpRatioOtmHistoryWrap" style="display:none; margin-top:12px;"><div class="ratio-main-chart"><canvas id="cpRatioOtmHistoryChart"></canvas></div></div>'
        : '';

      const hasRatioChart = vcAllPerExp.length >= 1;
      const ratioDetail = hasRatioChart
        ? '<div class="ratio-main-chart"><canvas id="cpRatioChart"></canvas></div>'
          + '<div id="cpRatioNoHistory" style="display:none; margin-top:12px; color:#718096; font-size:12px; text-align:center;">No historical data available for this expiration</div>'
          + '<div id="cpRatioHistoryWrap" style="display:none; margin-top:12px;"><div class="ratio-main-chart"><canvas id="cpRatioHistoryChart"></canvas></div></div>'
        : '';

      const hvc = c.historicalVolConviction;
      const hvcHistory = hvc.history || [];
      const fmtDollar = (v) => v >= 1_000_000 ? '$' + (v / 1_000_000).toFixed(1) + 'M' : v >= 1_000 ? '$' + (v / 1_000).toFixed(0) + 'K' : '$' + v.toFixed(0);
      const hasVolConvChart = hvcHistory.length >= 2;

      const fmtIVGap = (v) => v !== null && v !== undefined ? (v >= 0 ? '+' : '') + v.toFixed(1) + ' pp' : 'N/A';
      const volConvDetail = '<table class="detail-table">'
        + '<tr><td>Today Call $</td><td>' + fmtDollar(hvc.totalCallDollar) + '</td></tr>'
        + '<tr><td>Today Put $</td><td>' + fmtDollar(hvc.totalPutDollar) + '</td></tr>'
        + '<tr><td>Call/Put Ratio</td><td>' + (hvc.ratio > 0 ? hvc.ratio.toFixed(2) + 'x' : 'N/A') + '</td></tr>'
        + '<tr><td>IV Gap (Call−Put)</td><td style="color:' + (hvc.ivGap !== null ? (hvc.ivGap >= 0 ? '#48bb78' : '#f56565') : '#888') + '">' + fmtIVGap(hvc.ivGap) + '</td></tr>'
        + '</table>'
        + (hvcHistory.length > 0
          ? '<table class="detail-table"><thead><tr><th>Date</th><th>Call $</th><th>Put $</th><th>IV Gap</th></tr></thead><tbody>'
            + hvcHistory.slice(-8).map(d =>
              '<tr><td>' + new Date(d.date).toLocaleDateString('en-US', {month:'short',day:'numeric'}) + '</td>'
              + '<td>' + fmtDollar(d.totalCallDollar) + '</td>'
              + '<td>' + fmtDollar(d.totalPutDollar) + '</td>'
              + '<td style="color:' + (d.ivGap !== null ? (d.ivGap >= 0 ? '#48bb78' : '#f56565') : '#888') + '">' + fmtIVGap(d.ivGap) + '</td></tr>'
            ).join('') + '</tbody></table>'
          : '')
        + (hasVolConvChart ? '<div class="detail-chart"><canvas id="volConvictionChart"></canvas></div>' : '');

      return `
      <div class="anticipation-panel">
        <h2>Event Anticipation</h2>
        <div class="anticipation-headline">
          <div class="anticipation-badge ${badgeClass}">${idx}</div>
          <div class="anticipation-level">
            <span class="level-label">${ea.compositeLevel}</span>
            <span class="level-sub">Composite Event Anticipation Index (0–100)</span>
          </div>
        </div>
        <div class="anticipation-components">
          ${componentHTML('Volatility Risk Premium', c.vrp.score, c.vrp.maxScore,
            c.vrp.ratio > 0 ? `VRP ${c.vrp.ratio.toFixed(2)}x — ${c.vrp.signal}` : c.vrp.signal, vrpDetail, hasRollingHV ? 'has-chart' : '')}
          ${componentHTML('Term Structure (OTM)', c.termStructure.score, c.termStructure.maxScore,
            `${c.termStructure.shape} — ${c.termStructure.signal}`, termDetail, hasTermChart ? 'has-chart' : '')}
          ${componentHTML('Term Structure (ITM+OTM)', c.termStructureAll ? c.termStructureAll.score : 0, c.termStructureAll ? c.termStructureAll.maxScore : 20,
            `${c.termStructureAll ? c.termStructureAll.shape + ' — ' + c.termStructureAll.signal : 'N/A'}`, termDetailAll, hasTermChartAll ? 'has-chart' : '')}
          ${componentHTML('Vol Conviction (2.5%+ OTM)', c.volumeConviction.score, c.volumeConviction.maxScore,
            `${c.volumeConviction.signal}${vcPerExp.length > 0 ? ' — Max VOI: ' + Math.max(...vcPerExp.map(e => Math.max(e.callVOI, e.putVOI))).toFixed(2) : ''}`, volumeDetail, hasConvictionChart ? 'has-chart' : '')}
          ${componentHTML('Vol Conviction (ITM+OTM)', c.volumeConvictionAll ? c.volumeConvictionAll.score : 0, c.volumeConvictionAll ? c.volumeConvictionAll.maxScore : 15,
            `${c.volumeConvictionAll ? c.volumeConvictionAll.signal : 'N/A'}`, volumeDetailAll, hasConvictionChartAll ? 'has-chart' : '')}
          ${componentHTML('Call/Put $ Ratio (OTM)', '', '',
            hasOtmRatioChart ? (() => {
              const avgR = vcPerExp.reduce((s, e) => s + (e.convictionRatio || 0), 0) / vcPerExp.length;
              const ln = avgR > 0 ? Math.log(avgR) : 0;
              return 'Avg ln(ratio): ' + ln.toFixed(2) + ' (' + avgR.toFixed(2) + 'x) — ' + vcPerExp.length + ' expirations — click bar for history';
            })() : 'No data', otmRatioDetail, hasOtmRatioChart ? 'has-chart' : '')}
          ${componentHTML('Call/Put $ Ratio (ITM+OTM)', '', '',
            hasRatioChart ? (() => {
              const avgR = vcAllPerExp.reduce((s, e) => s + (e.convictionRatio || 0), 0) / vcAllPerExp.length;
              const ln = avgR > 0 ? Math.log(avgR) : 0;
              return 'Avg ln(ratio): ' + ln.toFixed(2) + ' (' + avgR.toFixed(2) + 'x) — ' + vcAllPerExp.length + ' expirations — click bar for history';
            })() : 'No data', ratioDetail, hasRatioChart ? 'has-chart' : '')}
          ${componentHTML('Dollar Flow', hvc.score, hvc.maxScore,
            `${hvc.signal}${hvc.ratio > 0 ? ' — ' + hvc.ratio.toFixed(2) + 'x Call/Put' : ''}${hvc.ivGap !== null ? ' — IV Gap: ' + (hvc.ivGap >= 0 ? '+' : '') + hvc.ivGap.toFixed(1) + 'pp' : ''}`, volConvDetail, hasVolConvChart ? 'has-chart' : '')}
        </div>
        ${calloutsHTML}
      </div>`;
    })() : '';

    // Generate Empirical Hold Duration panel
    const holdPanelHTML = empiricalHoldData ? (() => {
      const h = empiricalHoldData;
      const adj = h.optionsAdjusted;

      const adjPanelHTML = adj ? `
        <div class="hold-adj-section">
          <h3 class="hold-adj-header">Options-Adjusted Hold <span class="hold-adj-meta">${adj.totalMatchedEvents} similar events, avg similarity ${(adj.avgSimilarity * 100).toFixed(0)}%, avg snapshot lag ${adj.avgSnapshotLag.toFixed(0)}d</span></h3>
          <div class="hold-chart-container">
            <canvas id="holdAdjReturnChart"></canvas>
          </div>
        </div>` : '';

      return `
      <div class="hold-empirical-panel">
        <h2>Post-Event Hold Duration</h2>
        <p class="hold-empirical-sub">Based on ${h.totalEvents} events across ${h.totalStocks} stock${h.totalStocks !== 1 ? 's' : ''}</p>
        <div class="hold-chart-container">
          <canvas id="holdReturnChart"></canvas>
        </div>
        ${adjPanelHTML}
      </div>`;
    })() : '';

    // Generate Snapshot Optimal Hold panel
    const snapshotHoldPanelHTML = empiricalHoldData?.snapshotOptimalHold ? (() => {
      const sh = empiricalHoldData.snapshotOptimalHold;
      return `
      <div class="hold-empirical-panel snapshot-hold-panel">
        <h2>Options-Based Optimal Hold Period</h2>
        <p class="hold-empirical-sub">Based on ${sh.totalMatchedSnapshots} similar historical snapshots (${(sh.avgSimilarity * 100).toFixed(0)}% avg similarity)</p>
        <div class="hold-chart-container">
          <canvas id="snapshotOptimalHoldChart"></canvas>
        </div>
      </div>`;
    })() : '';

    // Generate Chronos-2 Forecast Hold panel
    const chronosHoldPanelHTML = empiricalHoldData?.chronosHold ? (() => {
      const ch = empiricalHoldData.chronosHold;
      const adjLabel = ch.optionsAdjusted
        ? `<span class="chronos-adj-badge">+ Options Adjusted</span>`
        : '';
      return `
      <div class="hold-empirical-panel chronos-hold-panel">
        <h2>Chronos-2 Forecast Hold Period ${adjLabel}</h2>
        <p class="hold-empirical-sub">Model: ${ch.model} | Context: ${ch.contextLength} days | Last price: $${ch.lastPrice?.toFixed(2) ?? '?'}</p>
        <div class="hold-chart-container" style="height:320px">
          <canvas id="chronosHoldChart"></canvas>
        </div>
        ${ch.optionsAdjusted ? `
        <div class="hold-adj-section">
          <h3 class="hold-adj-header">Options-Adjusted Forecast</h3>
          <div class="hold-chart-container" style="height:280px">
            <canvas id="chronosAdjHoldChart"></canvas>
          </div>
        </div>` : ''}
      </div>`;
    })() : '';

    // Generate current quote bar HTML
    const quoteBarHTML = currentQuote ? (() => {
      const q = currentQuote;
      const changeColor = q.change >= 0 ? '#4caf50' : '#f44336';
      const changeSign = q.change >= 0 ? '+' : '';
      const fmtVol = q.volume >= 1_000_000 ? (q.volume / 1_000_000).toFixed(1) + 'M' : q.volume >= 1_000 ? (q.volume / 1_000).toFixed(0) + 'K' : q.volume;
      const fmtCap = q.marketCap ? (q.marketCap >= 1e12 ? (q.marketCap / 1e12).toFixed(2) + 'T' : q.marketCap >= 1e9 ? (q.marketCap / 1e9).toFixed(1) + 'B' : (q.marketCap / 1e6).toFixed(0) + 'M') : null;

      // Event signal section
      const es = q.eventSignal;
      const eventSignalHTML = es ? (() => {
        const likelihood = es.percentile >= 95 ? 'High' : es.percentile >= 80 ? 'Medium' : 'Low';
        const likelihoodColor = likelihood === 'High' ? '#e53e3e' : likelihood === 'Medium' ? '#d69e2e' : '#38a169';
        const fmtProduct = es.todayProduct >= 1e9 ? (es.todayProduct / 1e9).toFixed(1) + 'B' : es.todayProduct >= 1e6 ? (es.todayProduct / 1e6).toFixed(1) + 'M' : es.todayProduct >= 1e3 ? (es.todayProduct / 1e3).toFixed(0) + 'K' : es.todayProduct.toFixed(0);
        const fmtThreshold = es.threshold >= 1e9 ? (es.threshold / 1e9).toFixed(1) + 'B' : es.threshold >= 1e6 ? (es.threshold / 1e6).toFixed(1) + 'M' : es.threshold >= 1e3 ? (es.threshold / 1e3).toFixed(0) + 'K' : es.threshold.toFixed(0);
        const volRatio = es.avgEventVolume > 0 ? (q.volume / es.avgEventVolume) : 0;
        const classLabel = es.classification ? es.classification.replace(/_/g, ' ') : '';
        const classColors = { surprising_positive: '#38a169', positive_anticipated: '#68d391', negative_anticipated: '#ed8936', surprising_negative: '#e53e3e' };
        const classColor = classColors[es.classification] || '#a0aec0';

        return `
        <div class="event-signal-section">
          <div class="event-signal-header">
            <span class="event-likelihood-label">Event Likelihood:</span>
            <span class="event-likelihood-badge" style="background:${likelihoodColor}">${likelihood}</span>
            <span class="event-percentile">${es.percentile.toFixed(0)}th percentile</span>
          </div>
          <div class="event-signal-stats">
            <span class="signal-stat">Gap: ${es.gap.toFixed(2)}%</span>
            ${es.residualGap !== null ? `<span class="signal-stat">Residual: ${es.residualGap.toFixed(2)}%</span>` : ''}
            <span class="signal-stat">Vol: ${(volRatio).toFixed(1)}x avg event</span>
            <span class="signal-stat">Score: ${fmtProduct} ${es.isAboveThreshold ? '&ge;' : '&lt;'} ${fmtThreshold}</span>
            ${es.isAboveThreshold && classLabel ? `<span class="signal-classification" style="background:${classColor}">${classLabel}</span>` : ''}
          </div>
        </div>`;
      })() : '';

      return `
      <div class="current-quote-bar">
        <span class="quote-price">$${q.price.toFixed(2)}</span>
        <span class="quote-change" style="color:${changeColor}">${changeSign}${q.change.toFixed(2)} (${changeSign}${q.changePercent.toFixed(2)}%)</span>
        <span class="quote-stat">Vol: ${fmtVol}</span>
        ${fmtCap ? `<span class="quote-stat">MCap: $${fmtCap}</span>` : ''}
      </div>
      ${eventSignalHTML}`;
    })() : '';

    // Generate events HTML
    const eventsHTML = events
      .map((event) => {
        const classColor = classificationColors[event.classification] || 'gray';
        const prevIdx = data.findIndex(
          (d) => d.date.toISOString().split('T')[0] === event.dateStr
        );
        const prevClose = prevIdx > 0 ? data[prevIdx - 1].close : event.open;
        const gap = ((event.open - prevClose) / prevClose * 100).toFixed(2);
        const intraday = ((event.close - event.open) / event.open * 100).toFixed(2);
        const totalChange = ((event.close - prevClose) / prevClose * 100).toFixed(2);

        return `
          <div class="event-card">
            <div class="event-header">
              <span class="event-date">${event.dateStr}</span>
              <span class="event-classification" style="background: ${classColor}">${event.classification.replace(/_/g, ' ')}</span>
              <span class="event-strength">${event.strength.toFixed(2)}% range</span>
            </div>
            <div class="event-details">
              <div class="event-stat"><span>Gap:</span> ${gap >= 0 ? '+' : ''}${gap}%</div>
              <div class="event-stat"><span>Intraday:</span> ${intraday >= 0 ? '+' : ''}${intraday}%</div>
              <div class="event-stat"><span>Total:</span> ${totalChange >= 0 ? '+' : ''}${totalChange}%</div>
              <div class="event-stat"><span>Volume:</span> ${event.volume.toLocaleString()}</div>
            </div>
          </div>
        `;
      })
      .join('');

    // Generate Fundamentals panel HTML
    const fundamentalsPanelHTML = fundamentalsData && fundamentalsData.quarters.length > 0 ? (() => {
      const q = fundamentalsData.quarters;
      const hasRevenue = q.some(d => d.revenue > 0);
      const hasEps = q.some(d => d.eps !== 0);

      const formatNum = (n) => {
        if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toFixed(2);
      };

      const tableRows = q.map(d => {
        const revenueCell = hasRevenue ? `<td>$${formatNum(d.revenue)}</td>` : '';
        const growthCell = hasRevenue ? `<td style="color:${d.revenueGrowthYoY > 0 ? '#38a169' : d.revenueGrowthYoY < 0 ? '#e53e3e' : '#888'}">${d.revenueGrowthYoY != null ? (d.revenueGrowthYoY >= 0 ? '+' : '') + d.revenueGrowthYoY.toFixed(1) + '%' : '—'}</td>` : '';
        const grossMarginCell = hasRevenue && d.grossMargin != null ? `<td>${d.grossMargin.toFixed(1)}%</td>` : (hasRevenue ? '<td>—</td>' : '');
        const opMarginCell = hasRevenue && d.operatingMargin != null ? `<td>${d.operatingMargin.toFixed(1)}%</td>` : (hasRevenue ? '<td>—</td>' : '');
        const epsCell = hasEps ? `<td>${d.eps >= 0 ? '' : ''}${d.eps.toFixed(2)}</td>` : '';
        const epsSurpriseCell = d.epsSurprise !== undefined && d.epsEstimate ? `<td style="color:${d.epsSurprise > 0 ? '#38a169' : d.epsSurprise < 0 ? '#e53e3e' : '#888'}">${d.epsSurprise >= 0 ? '+' : ''}${d.epsSurprise.toFixed(2)}</td>` : '';

        return `<tr>
          <td>${d.date}</td>
          ${revenueCell}
          ${growthCell}
          ${grossMarginCell}
          ${opMarginCell}
          ${epsCell}
          ${epsSurpriseCell}
        </tr>`;
      }).join('');

      const revenueHeaders = hasRevenue ? '<th>Revenue</th><th>YoY Growth</th><th>Gross Margin</th><th>Op Margin</th>' : '';
      const epsHeaders = hasEps ? '<th>EPS</th>' : '';
      const epsSurpriseHeader = q.some(d => d.epsSurprise !== undefined && d.epsEstimate) ? '<th>EPS Surprise</th>' : '';

      return `
      <div class="panel fundamentals-panel">
        <h2>Quarterly Fundamentals</h2>
        <p class="panel-subtitle">Source: ${fundamentalsData.source === 'eodhd' ? 'EODHD' : 'Twelve Data'} — ${q.length} quarters</p>
        ${hasRevenue ? '<div class="chart-container"><canvas id="revenueChart"></canvas></div>' : ''}
        ${hasEps ? '<div class="chart-container"><canvas id="epsChart"></canvas></div>' : ''}
        <div class="fundamentals-table-wrapper">
          <table class="fundamentals-table">
            <thead>
              <tr>
                <th>Quarter</th>
                ${revenueHeaders}
                ${epsHeaders}
                ${epsSurpriseHeader}
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </div>`;
    })() : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ticker} Stock Event Analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eaeaea;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    h1 {
      text-align: center;
      color: #a8b5a2;
      margin-bottom: 10px;
    }
    .subtitle {
      text-align: center;
      color: #888;
      margin-bottom: 30px;
    }
    .current-quote-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;
      background: #16213e;
      border-radius: 10px;
      padding: 14px 24px;
      max-width: 700px;
      margin: 0 auto 24px auto;
      flex-wrap: wrap;
    }
    .quote-price {
      font-size: 24px;
      font-weight: bold;
      color: #fff;
    }
    .quote-change {
      font-size: 16px;
      font-weight: 600;
    }
    .quote-stat {
      font-size: 14px;
      color: #a0aec0;
    }
    .event-signal-section {
      max-width: 700px;
      margin: -16px auto 24px auto;
      background: #16213e;
      border-radius: 0 0 10px 10px;
      padding: 10px 24px 14px;
      border-top: 1px solid #2d3748;
    }
    .event-signal-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .event-likelihood-label {
      font-size: 13px;
      color: #a0aec0;
      font-weight: 600;
    }
    .event-likelihood-badge {
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
    }
    .event-percentile {
      font-size: 12px;
      color: #718096;
    }
    .event-signal-stats {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .signal-stat {
      font-size: 12px;
      color: #a0aec0;
    }
    .signal-classification {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      color: #000;
      text-transform: uppercase;
    }
    .legend {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 14px;
    }
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .chart-container {
      background: #16213e;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      max-width: 1400px;
      margin-left: auto;
      margin-right: auto;
    }
    .chart-container canvas {
      height: 400px !important;
    }
    .fundamentals-panel {
      max-width: 1400px;
      margin: 30px auto;
      background: #16213e;
      border-radius: 12px;
      padding: 24px;
      border: 1px solid #2a3a5e;
    }
    .fundamentals-panel h2 {
      color: #a8b5a2;
      margin: 0 0 4px 0;
      font-size: 20px;
    }
    .fundamentals-panel .panel-subtitle {
      color: #888;
      font-size: 12px;
      margin: 0 0 16px 0;
    }
    .fundamentals-table-wrapper {
      overflow-x: auto;
      margin-top: 16px;
    }
    .fundamentals-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .fundamentals-table th {
      background: #1a2744;
      color: #a8b5a2;
      padding: 8px 12px;
      text-align: right;
      border-bottom: 2px solid #333;
      white-space: nowrap;
    }
    .fundamentals-table th:first-child {
      text-align: left;
    }
    .fundamentals-table td {
      padding: 6px 12px;
      text-align: right;
      border-bottom: 1px solid #222;
      color: #ccc;
      white-space: nowrap;
    }
    .fundamentals-table td:first-child {
      text-align: left;
      color: #fff;
      font-weight: 500;
    }
    .fundamentals-table tbody tr:hover {
      background: #1a2744;
    }
    .events-section {
      max-width: 1400px;
      margin: 40px auto;
    }
    .events-section h2 {
      color: #a8b5a2;
      border-bottom: 2px solid #333;
      padding-bottom: 10px;
    }
    .event-card {
      background: #16213e;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 15px;
      border-left: 4px solid #4a6fa5;
    }
    .event-header {
      display: flex;
      align-items: center;
      gap: 15px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .event-date {
      font-size: 18px;
      font-weight: bold;
      color: #fff;
    }
    .event-classification {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      text-transform: uppercase;
      color: #000;
      font-weight: bold;
    }
    .event-strength {
      color: #888;
      font-size: 14px;
    }
    .event-details {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .event-stat {
      background: #0f3460;
      padding: 8px 15px;
      border-radius: 5px;
      font-size: 14px;
    }
    .event-stat span {
      color: #888;
      margin-right: 5px;
    }
    /* Event Anticipation Panel */
    .anticipation-panel {
      max-width: 1400px;
      margin: 20px auto;
      background: #16213e;
      border-radius: 10px;
      padding: 24px;
    }
    .anticipation-panel h2 {
      color: #a8b5a2;
      margin: 0 0 16px 0;
      border-bottom: 2px solid #333;
      padding-bottom: 10px;
    }
    .anticipation-headline {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .anticipation-badge {
      font-size: 32px;
      font-weight: bold;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .anticipation-badge.extreme { background: #e53e3e; color: #fff; }
    .anticipation-badge.high { background: #dd6b20; color: #fff; }
    .anticipation-badge.moderate { background: #d69e2e; color: #000; }
    .anticipation-badge.low { background: #38a169; color: #fff; }
    .anticipation-badge.none { background: #4a5568; color: #a0aec0; }
    .anticipation-level {
      font-size: 18px;
      font-weight: 600;
    }
    .anticipation-level .level-label { color: #eaeaea; }
    .anticipation-level .level-sub { color: #a0aec0; font-size: 13px; font-weight: 400; display: block; margin-top: 2px; }
    .anticipation-components {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .component-row {
      background: #0f3460;
      border-radius: 8px;
      padding: 12px 14px;
    }
    .component-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .component-name { color: #a8b5a2; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .component-score { color: #eaeaea; font-size: 13px; font-weight: bold; }
    .component-bar {
      height: 6px;
      background: #1a1a2e;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .component-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }
    .component-signal { color: #a0aec0; font-size: 11px; line-height: 1.4; }
    .component-row.expandable { cursor: pointer; }
    .component-row.expandable:hover { background: #0e2d52; }
    .component-toggle { font-size: 10px; color: #a0aec0; transition: transform 0.3s; display: inline-block; }
    .component-row.expanded .component-toggle { transform: rotate(90deg); }
    .component-detail { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; }
    .component-row.expanded .component-detail { max-height: 800px; margin-top: 10px; }
    .detail-chart { margin-top: 10px; height: 260px; }
    .detail-chart canvas { height: 260px !important; }
    .component-row.has-chart.expanded { grid-column: 1 / -1; }
    .component-row.has-chart.expanded .component-detail { max-height: 2400px; }
    .trend-dir { font-weight: 600; }
    .trend-dir.rising { color: #fc8181; }
    .trend-dir.falling { color: #48bb78; }
    .trend-dir.flat { color: #a0aec0; }
    .detail-table { width: 100%; font-size: 11px; border-collapse: collapse; margin: 8px 0; }
    .detail-table th, .detail-table td { padding: 4px 8px; border-bottom: 1px solid #1a1a2e; text-align: left; }
    .detail-table th { color: #a8b5a2; font-weight: 600; }
    .detail-table td { color: #cbd5e0; }
    .detail-interp { font-size: 11px; color: #718096; margin-top: 6px; line-height: 1.5; }
    .directional-indicator { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 20px; background: rgba(74, 111, 165, 0.12); }
    .signal-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; }
    .signal-badge.pos { background: rgba(72, 187, 120, 0.2); color: #48bb78; }
    .signal-badge.neg { background: rgba(252, 129, 129, 0.2); color: #fc8181; }
    .signal-badge.zero { background: rgba(160, 174, 192, 0.2); color: #a0aec0; }
    .anticipation-callouts {
      margin-top: 16px;
      padding: 12px 14px;
      background: rgba(74, 111, 165, 0.08);
      border-radius: 6px;
      border-left: 3px solid #4a6fa5;
    }
    .anticipation-callouts p {
      margin: 4px 0;
      font-size: 13px;
      color: #cbd5e0;
    }
    .anticipation-callouts p::before {
      content: '\u25B6 ';
      color: #4a6fa5;
      font-size: 10px;
    }
    .ratio-main-chart {
      height: 280px;
    }
    .ratio-main-chart canvas {
      height: 280px !important;
    }
    /* Optimal Hold Recommendation Panel */
    .hold-empirical-panel {
      max-width: 1400px;
      margin: 20px auto;
      background: #16213e;
      border-radius: 10px;
      padding: 24px;
      border-left: 5px solid #0f3460;
    }
    .hold-empirical-panel h2 {
      color: #a8b5a2;
      margin: 0 0 4px 0;
      border-bottom: 2px solid #333;
      padding-bottom: 10px;
    }
    .hold-empirical-sub {
      color: #a0aec0;
      font-size: 13px;
      margin: 0 0 16px 0;
    }
    .hold-cls-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 20px;
    }
    @media (max-width: 900px) {
      .hold-cls-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .hold-cls-card {
      background: #0f3460;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .hold-cls-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .hold-cls-badge {
      font-size: 36px;
      font-weight: bold;
      color: #eaeaea;
      line-height: 1;
    }
    .hold-cls-detail {
      font-size: 11px;
      color: #a0aec0;
      margin-bottom: 6px;
    }
    .hold-cls-return {
      font-size: 14px;
      font-weight: 600;
      color: #48bb78;
    }
    .hold-cls-count {
      font-size: 11px;
      color: #718096;
      margin-top: 4px;
    }
    .hold-cls-nodata {
      font-size: 13px;
      color: #4a5568;
      padding: 16px 0;
    }
    .hold-chart-container {
      height: 300px;
      margin-top: 16px;
    }
    .hold-chart-container canvas {
      height: 300px !important;
    }
    .hold-adj-section {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 2px solid #333;
    }
    .hold-adj-header {
      color: #a8b5a2;
      font-size: 16px;
      margin: 0 0 12px 0;
    }
    .hold-adj-meta {
      color: #718096;
      font-size: 12px;
      font-weight: 400;
      margin-left: 8px;
    }
    .hold-adj-card {
      border: 1px solid rgba(74, 111, 165, 0.3);
    }
    .snapshot-hold-panel {
      border-left: 4px solid #3182ce;
    }
    .snapshot-hold-card {
      border: 1px solid rgba(49, 130, 206, 0.3);
    }
    .chronos-hold-panel {
      border-left: 4px solid #e6b800;
    }
    .chronos-adj-badge {
      display: inline-block;
      background: rgba(246, 173, 85, 0.2);
      color: #f6ad55;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75em;
      margin-left: 8px;
      vertical-align: middle;
    }
  </style>
</head>
<body>
  <h1>${ticker} Stock Event Analysis</h1>
  <p class="subtitle">Events detected using volume \u00d7 price gap analysis with market movement filtering</p>

  ${quoteBarHTML}

  ${anticipationPanelHTML}

  ${holdPanelHTML}

  ${snapshotHoldPanelHTML}

  ${chronosHoldPanelHTML}

  <div class="legend">
    <div class="legend-item"><div class="legend-color" style="background: darkgreen"></div> Surprising Positive</div>
    <div class="legend-item"><div class="legend-color" style="background: lightgreen"></div> Positive Anticipated</div>
    <div class="legend-item"><div class="legend-color" style="background: orange"></div> Negative Anticipated</div>
    <div class="legend-item"><div class="legend-color" style="background: red"></div> Surprising Negative</div>
  </div>

  <div class="chart-container">
    <canvas id="priceChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="volumeChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="residualChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="volumeGapChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="strengthChart"></canvas>
  </div>

  ${fundamentalsPanelHTML}

  ${finvizNews && finvizNews.length > 0 ? `
  <div class="panel" style="margin-top:20px;">
    <h2>Recent News Headlines</h2>
    <p class="panel-subtitle">Source: Finviz — ${finvizNews.length} headlines</p>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="border-bottom:1px solid rgba(255,255,255,0.2);">
          <th style="text-align:left; padding:6px 8px; width:140px;">Date / Time</th>
          <th style="text-align:left; padding:6px 8px;">Headline</th>
        </tr>
      </thead>
      <tbody>
        ${finvizNews.map(n => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
          <td style="padding:5px 8px; white-space:nowrap; color:#888;">${n.date} ${n.time}</td>
          <td style="padding:5px 8px;"><a href="${n.url}" style="color:#63b3ed; text-decoration:none;" target="_blank">${n.headline}</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="events-section">
    <h2>Detected Events</h2>
    ${eventsHTML}
  </div>

  <script>
    const dates = ${JSON.stringify(dates)};
    const closes = ${JSON.stringify(closes)};
    const volumes = ${JSON.stringify(volumes)};
    const residualReturns = ${JSON.stringify(residualReturns)};
    const volumeGapProducts = ${JSON.stringify(volumeGapProducts)};
    const earningsScatter = ${JSON.stringify(earningsScatter)};
    const earningsVolumeIndices = ${JSON.stringify(earningsVolumeIndices)};
    const earningsResidualScatter = ${JSON.stringify(earningsResidualScatter)};
    const earningsVolumeGapScatter = ${JSON.stringify(earningsVolumeGapScatter)};
    const strengthData = ${JSON.stringify(strengthData)};
    const threshold = ${Math.log10(Math.max(threshold, 1))};
    const avgStrength = ${avgStrength};

    const classificationColors = ${JSON.stringify(classificationColors)};

    // Expandable component cards (event delegation)
    const compContainer = document.querySelector('.anticipation-components');
    if (compContainer) {
      compContainer.addEventListener('click', (e) => {
        // Don't toggle card when clicking inside a chart canvas
        if (e.target.tagName === 'CANVAS') return;
        const row = e.target.closest('.component-row.expandable');
        if (!row) return;
        row.classList.toggle('expanded');
        if (row.classList.contains('expanded')) {
          const canvases = row.querySelectorAll('canvas');
          canvases.forEach(canvas => {
            if (canvas.dataset.init) return;
            canvas.dataset.init = '1';
            if (canvas.id === 'vrpMiniChart' && typeof initVrpMiniChart === 'function') initVrpMiniChart();
            if (canvas.id === 'termStructureChart' && typeof initTermStructureChart === 'function') initTermStructureChart();
            if (canvas.id === 'termStructureChartAll' && typeof initTermStructureChartAll === 'function') initTermStructureChartAll();
            if (canvas.id === 'volConvictionChart' && typeof initVolConvictionChart === 'function') initVolConvictionChart();
            if (canvas.id === 'dollarConvictionChart' && typeof initDollarConvictionChart === 'function') initDollarConvictionChart();
            if (canvas.id === 'dollarConvictionChartAll' && typeof initDollarConvictionChartAll === 'function') initDollarConvictionChartAll();
            if (canvas.id === 'cpRatioChart' && typeof initCpRatioChart === 'function') initCpRatioChart();
            if (canvas.id === 'cpRatioOtmChart' && typeof initCpRatioOtmChart === 'function') initCpRatioOtmChart();
          });
        }
      });
    }

    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#b0b0b0' } }
      },
      scales: {
        x: {
          type: 'category',
          ticks: { color: '#909090', maxTicksLimit: 20 },
          grid: { color: '#2a2a4a' }
        },
        y: {
          ticks: { color: '#909090' },
          grid: { color: '#2a2a4a' }
        }
      }
    };

    // Chart 1: Stock Price with Events
    new Chart(document.getElementById('priceChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: '${ticker} Close Price',
            data: closes,
            borderColor: 'rgba(136, 176, 136, 0.8)',
            backgroundColor: 'rgba(136, 176, 136, 0.1)',
            borderWidth: 1,
            pointRadius: 0,
            fill: true
          },
          ...Object.keys(classificationColors).filter(c => c !== 'none').map(classification => ({
            label: classification.replace(/_/g, ' '),
            data: earningsScatter
              .filter(e => e.classification === classification)
              .map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: classificationColors[classification],
            borderColor: classificationColors[classification],
            pointRadius: 8,
            pointHoverRadius: 10
          }))
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: '${ticker} Stock Price with Detected Events', color: '#b0b0b0' }
        }
      }
    });

    // Chart 2: Volume
    const volumeColors = volumes.map((_, i) =>
      earningsVolumeIndices.includes(i) ? 'rgba(205, 100, 100, 0.8)' : 'rgba(120, 140, 160, 0.5)'
    );
    new Chart(document.getElementById('volumeChart'), {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [{
          label: 'Volume',
          data: volumes,
          backgroundColor: volumeColors,
          borderWidth: 0
        }]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Trading Volume (Highlighted = Event Dates)', color: '#b0b0b0' }
        }
      }
    });

    // Chart 3: Residual Returns
    new Chart(document.getElementById('residualChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Residual Return (%)',
            data: residualReturns,
            borderColor: 'rgba(160, 140, 180, 0.8)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Event Dates',
            data: earningsResidualScatter.map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: 'rgba(205, 100, 100, 0.9)',
            borderColor: 'rgba(205, 100, 100, 0.9)',
            pointRadius: 6
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Market-Filtered Stock Movements (Residual Returns)', color: '#b0b0b0' }
        }
      }
    });

    // Chart 4: Volume x Gap Product
    new Chart(document.getElementById('volumeGapChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Log10(Volume x Gap)',
            data: volumeGapProducts,
            borderColor: 'rgba(120, 140, 160, 0.7)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Event Dates',
            data: earningsVolumeGapScatter.map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: 'rgba(205, 100, 100, 0.9)',
            borderColor: 'rgba(205, 100, 100, 0.9)',
            pointRadius: 6
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Volume x Gap Product (Log10 Scale)', color: '#b0b0b0' }
        }
      }
    });

    // Chart 5: Event Strength
    new Chart(document.getElementById('strengthChart'), {
      type: 'bar',
      data: {
        labels: strengthData.map(d => d.date),
        datasets: [{
          label: 'Event Strength (%)',
          data: strengthData.map(d => d.strength),
          backgroundColor: strengthData.map(d => d.color),
          borderWidth: 0
        }]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Event Strength (High-Low Range) - Avg: ' + avgStrength.toFixed(2) + '%', color: '#b0b0b0' }
        }
      }
    });

    // Chart 7: Rolling HV with IV overlay — lazy init from card expand
    ${(optionsData?.rollingHV?.length || 0) > 5 ? `
    function initVrpMiniChart() {
      const rollingHV = ${JSON.stringify(optionsData.rollingHV)};
      const currentIV = ${JSON.stringify(optionsData?.summary?.avgAtmIV ? optionsData.summary.avgAtmIV * 100 : null)};
      const overallHV = ${JSON.stringify(hv * 100)};

      const hvLabels = rollingHV.map(d => d.date);
      const hvValues = rollingHV.map(d => d.hv * 100);

      const datasets = [
        {
          label: '20-Day Rolling HV (%)',
          data: hvValues,
          borderColor: 'rgba(99, 179, 237, 0.9)',
          backgroundColor: 'rgba(99, 179, 237, 0.08)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.3
        },
        {
          label: 'Full-Period HV (%)',
          data: hvLabels.map(() => overallHV),
          borderColor: 'rgba(99, 179, 237, 0.4)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false
        }
      ];

      if (currentIV !== null) {
        datasets.push({
          label: 'Current ATM IV (%)',
          data: hvLabels.map(() => currentIV),
          borderColor: 'rgba(246, 173, 85, 0.9)',
          borderWidth: 2,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false
        });
      }

      new Chart(document.getElementById('vrpMiniChart'), {
        type: 'line',
        data: { labels: hvLabels, datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'Rolling HV vs Implied Volatility', color: '#b0b0b0' }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' }
            },
            y: {
              title: { display: true, text: 'Annualized Volatility (%)', color: '#909090' },
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    }
    ` : ''}


    // Term Structure Chart (IV across expirations) — lazy init from card expand
    ${ea && (ea.components?.termStructure?.data?.length || 0) >= 2 ? `
    function initTermStructureChart() {
      const termData = ${JSON.stringify(ea.components.termStructure.data)};
      const hvLine = ${JSON.stringify(hv * 100)};

      const labels = termData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' (' + d.daysToExpiry + 'd)';
      });
      const callIVValues = termData.map(d => (d.callIV || 0) * 100);
      const putIVValues = termData.map(d => (d.putIV || 0) * 100);
      const datasets = [
        {
          label: 'Call IV (%)',
          data: callIVValues,
          borderColor: 'rgba(72, 187, 120, 0.9)',
          backgroundColor: 'rgba(72, 187, 120, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: 'rgba(72, 187, 120, 1)',
          fill: false,
          tension: 0.2
        },
        {
          label: 'Put IV (%)',
          data: putIVValues,
          borderColor: 'rgba(245, 101, 101, 0.9)',
          backgroundColor: 'rgba(245, 101, 101, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: 'rgba(245, 101, 101, 1)',
          fill: false,
          tension: 0.2
        }
      ];

      if (hvLine > 0) {
        datasets.push({
          label: 'Realized Vol (%)',
          data: labels.map(() => hvLine),
          borderColor: 'rgba(99, 179, 237, 0.8)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        });
      }

      var tsChartOTM = new Chart(document.getElementById('termStructureChart'), {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements || elements.length === 0) return;
            var idx = elements[0].index;
            if (typeof handleIVSmileClick === 'function') handleIVSmileClick(idx, 'otm');
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'IV Term Structure (Call / Put) — click a point for smile', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                footer: function() { return 'Click to view volatility smile'; }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              title: { display: true, text: 'Annualized IV (%)', color: '#909090' },
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    }
    ` : ''}

    // Term Structure Chart — ITM+OTM (all strikes) — lazy init from card expand
    ${ea && (ea.components?.termStructureAll?.data?.length || 0) >= 2 ? `
    function initTermStructureChartAll() {
      const termData = ${JSON.stringify(ea.components.termStructureAll.data)};
      const hvLine = ${JSON.stringify(hv * 100)};

      const labels = termData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' (' + d.daysToExpiry + 'd)';
      });
      const callIVValues = termData.map(d => (d.callIV || 0) * 100);
      const putIVValues = termData.map(d => (d.putIV || 0) * 100);
      const datasets = [
        {
          label: 'Call IV (%)',
          data: callIVValues,
          borderColor: 'rgba(72, 187, 120, 0.9)',
          backgroundColor: 'rgba(72, 187, 120, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: 'rgba(72, 187, 120, 1)',
          fill: false,
          tension: 0.2
        },
        {
          label: 'Put IV (%)',
          data: putIVValues,
          borderColor: 'rgba(245, 101, 101, 0.9)',
          backgroundColor: 'rgba(245, 101, 101, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: 'rgba(245, 101, 101, 1)',
          fill: false,
          tension: 0.2
        }
      ];

      if (hvLine > 0) {
        datasets.push({
          label: 'Realized Vol (%)',
          data: labels.map(() => hvLine),
          borderColor: 'rgba(99, 179, 237, 0.8)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        });
      }

      var tsChartAll = new Chart(document.getElementById('termStructureChartAll'), {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements || elements.length === 0) return;
            var idx = elements[0].index;
            if (typeof handleIVSmileClick === 'function') handleIVSmileClick(idx, 'all');
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'IV Term Structure — ITM+OTM (Call / Put) — click a point for smile', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                footer: function() { return 'Click to view volatility smile'; }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              title: { display: true, text: 'Annualized IV (%)', color: '#909090' },
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    }
    ` : ''}

    // Volatility Smile drilldown — click IV in term structure table to see IV vs strike
    ${(() => {
      const otmSmileData = ea?.components?.termStructure?.data || [];
      const allSmileData = ea?.components?.termStructureAll?.data || [];
      if (otmSmileData.length === 0 && allSmileData.length === 0) return '';
      return `
    var tsSmileDataOTM = ${JSON.stringify(otmSmileData.map(d => ({ expirationDate: d.expirationDate, daysToExpiry: d.daysToExpiry, strikeIV: d.strikeIV || [] })))};
    var tsSmileDataAll = ${JSON.stringify(allSmileData.map(d => ({ expirationDate: d.expirationDate, daysToExpiry: d.daysToExpiry, strikeIV: d.strikeIV || [] })))};
    var smileChartOTM = null;
    var smileChartAll = null;

    function renderSmileChart(canvasId, wrapId, data, expiryLabel) {
      var wrap = document.getElementById(wrapId);
      if (!wrap) return null;
      wrap.style.display = 'block';
      var canvas = document.getElementById(canvasId);
      var calls = data.filter(function(d) { return d.type === 'call'; });
      var puts = data.filter(function(d) { return d.type === 'put'; });
      var datasets = [];
      if (calls.length > 0) {
        datasets.push({
          label: 'Call IV',
          data: calls.map(function(d) { return { x: d.strike, y: d.iv * 100 }; }),
          borderColor: 'rgba(72, 187, 120, 0.9)',
          backgroundColor: 'rgba(72, 187, 120, 0.15)',
          borderWidth: 2, pointRadius: 3,
          pointBackgroundColor: 'rgba(72, 187, 120, 1)',
          fill: false, tension: 0.2, showLine: true
        });
      }
      if (puts.length > 0) {
        datasets.push({
          label: 'Put IV',
          data: puts.map(function(d) { return { x: d.strike, y: d.iv * 100 }; }),
          borderColor: 'rgba(245, 101, 101, 0.9)',
          backgroundColor: 'rgba(245, 101, 101, 0.15)',
          borderWidth: 2, pointRadius: 3,
          pointBackgroundColor: 'rgba(245, 101, 101, 1)',
          fill: false, tension: 0.2, showLine: true
        });
      }
      return new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'Volatility Smile — ' + expiryLabel, color: '#b0b0b0' }
          },
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Strike Price', color: '#909090' },
              ticks: { color: '#909090' }, grid: { color: '#2a2a4a' }
            },
            y: {
              title: { display: true, text: 'Implied Volatility (%)', color: '#909090' },
              ticks: { color: '#909090' }, grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    }

    function handleIVSmileClick(idx, tsType) {
      var isOTM = tsType === 'otm';
      var dataArr = isOTM ? tsSmileDataOTM : tsSmileDataAll;
      if (idx < 0 || idx >= dataArr.length) return;
      var entry = dataArr[idx];
      if (!entry.strikeIV || entry.strikeIV.length === 0) return;
      var label = new Date(entry.expirationDate).toLocaleDateString('en-US', {month:'short',day:'numeric'}) + ' (' + entry.daysToExpiry + 'd)';
      var canvasId = isOTM ? 'tsSmileChartOTM' : 'tsSmileChartAll';
      var wrapId = isOTM ? 'tsSmileWrapOTM' : 'tsSmileWrapAll';
      if (isOTM) {
        if (smileChartOTM) smileChartOTM.destroy();
        smileChartOTM = renderSmileChart(canvasId, wrapId, entry.strikeIV, label);
      } else {
        if (smileChartAll) smileChartAll.destroy();
        smileChartAll = renderSmileChart(canvasId, wrapId, entry.strikeIV, label);
      }
    }
    `;
    })()}

    // Dollar Conviction Ratio Chart — Call$/Put$ ratio by expiration
    ${(() => {
      const vcPerExp = ea?.components?.volumeConviction?.perExpiration || [];
      const prev24hOTM = ea?.components?.volumeConviction?.prev24hPerExpiration || [];
      if (vcPerExp.length < 2) return '';
      return `function initDollarConvictionChart() {
      const crData = ${JSON.stringify(vcPerExp)};
      const prev24hArr = ${JSON.stringify(prev24hOTM)};
      const prev24hMap = {};
      prev24hArr.forEach(function(e) { prev24hMap[e.expirationDate] = e; });
      const labels = crData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      // Faded 24h-ago data matched by expiration date (normalize key to YYYY-MM-DD)
      const faded24hCall = crData.map(function(d) { var key = new Date(d.expirationDate).toISOString().split('T')[0]; var p = prev24hMap[key]; return p ? p.totalCallDollarVolume : null; });
      const faded24hPut  = crData.map(function(d) { var key = new Date(d.expirationDate).toISOString().split('T')[0]; var p = prev24hMap[key]; return p ? p.totalPutDollarVolume : null; });
      const has24h = faded24hCall.some(function(v) { return v !== null; }) || faded24hPut.some(function(v) { return v !== null; });

      const datasets = [];
      if (has24h) {
        datasets.push(
          {
            label: 'Call $ (24h ago)',
            data: faded24hCall,
            backgroundColor: 'rgba(72, 187, 120, 0.10)',
            borderColor: 'rgba(72, 187, 120, 0.22)',
            borderWidth: 1,
            stack: 'call',
            order: 2,
            barPercentage: 1.0
          },
          {
            label: 'Put $ (24h ago)',
            data: faded24hPut,
            backgroundColor: 'rgba(245, 101, 101, 0.10)',
            borderColor: 'rgba(245, 101, 101, 0.22)',
            borderWidth: 1,
            stack: 'put',
            order: 2,
            barPercentage: 1.0
          }
        );
      }
      datasets.push(
        {
          label: 'Call $ Volume',
          data: crData.map(d => d.totalCallDollarVolume || 0),
          backgroundColor: 'rgba(72, 187, 120, 0.35)',
          borderColor: 'rgba(72, 187, 120, 0.6)',
          borderWidth: 1,
          stack: 'call',
          order: 1,
          barPercentage: 0.85
        },
        {
          label: 'Put $ Volume',
          data: crData.map(d => d.totalPutDollarVolume || 0),
          backgroundColor: 'rgba(245, 101, 101, 0.35)',
          borderColor: 'rgba(245, 101, 101, 0.6)',
          borderWidth: 1,
          stack: 'put',
          order: 1,
          barPercentage: 0.85
        }
      );

      let drilldownChart = null;
      const convChart = new Chart(document.getElementById('dollarConvictionChart'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements.length) return;
            const idx = elements[0].index;
            const exp = crData[idx];
            if (!exp || !exp.contracts || !exp.contracts.length) return;
            const expLabel = labels[idx];

            // Group contracts by strike, separating call vs put
            const strikeMap = {};
            exp.contracts.forEach(c => {
              if (!c.dollarVolume) return;
              if (!strikeMap[c.strike]) strikeMap[c.strike] = { call: 0, put: 0 };
              if (c.type === 'call') strikeMap[c.strike].call += c.dollarVolume;
              else strikeMap[c.strike].put += c.dollarVolume;
            });
            const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
            if (!strikes.length) return;
            const callData = strikes.map(s => strikeMap[s].call);
            const putData = strikes.map(s => strikeMap[s].put);
            const strikeLabels = strikes.map(s => '$' + s);

            const wrap = document.getElementById('strikeDrilldownWrap');
            wrap.style.display = 'block';

            if (drilldownChart) drilldownChart.destroy();
            drilldownChart = new Chart(document.getElementById('strikeDrilldownChart'), {
              type: 'bar',
              data: {
                labels: strikeLabels,
                datasets: [
                  {
                    label: 'Call $ Volume',
                    data: callData,
                    backgroundColor: 'rgba(72, 187, 120, 0.5)',
                    borderColor: 'rgba(72, 187, 120, 0.8)',
                    borderWidth: 1
                  },
                  {
                    label: 'Put $ Volume',
                    data: putData,
                    backgroundColor: 'rgba(245, 101, 101, 0.5)',
                    borderColor: 'rgba(245, 101, 101, 0.8)',
                    borderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#b0b0b0' } },
                  title: { display: true, text: 'Strike Breakdown — ' + expLabel, color: '#b0b0b0' },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        const v = ctx.parsed.y;
                        return ctx.dataset.label + ': $' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
                      }
                    }
                  }
                },
                scales: {
                  x: {
                    ticks: { color: '#909090' },
                    grid: { color: '#2a2a4a' }
                  },
                  y: {
                    title: { display: true, text: '$ Volume', color: '#909090' },
                    ticks: {
                      color: '#909090',
                      callback: function(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v; }
                    },
                    grid: { color: '#2a2a4a' },
                    beginAtZero: true
                  }
                }
              }
            });
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'Dollar Volume by Expiration — 2.5%+ OTM (click bar to drill down)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null || ctx.raw === undefined) return null;
                  const v = ctx.parsed.y;
                  return ctx.dataset.label + ': $' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              stacked: false,
              title: { display: true, text: '$ Volume', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v; }
              },
              grid: { color: '#2a2a4a' },
              beginAtZero: true
            }
          }
        }
      });
    }`;
    })()}

    // Dollar Conviction Ratio Chart — ITM+OTM (all contracts)
    ${(() => {
      const vcAllPerExp = ea?.components?.volumeConvictionAll?.perExpiration || [];
      const prev24hAll = ea?.components?.volumeConvictionAll?.prev24hPerExpiration || [];
      if (vcAllPerExp.length < 2) return '';
      return `function initDollarConvictionChartAll() {
      const crData = ${JSON.stringify(vcAllPerExp)};
      const prev24hArr = ${JSON.stringify(prev24hAll)};
      const prev24hMap = {};
      prev24hArr.forEach(function(e) { prev24hMap[e.expirationDate] = e; });
      const labels = crData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      // Faded 24h-ago data matched by expiration date (normalize key to YYYY-MM-DD)
      const faded24hCall = crData.map(function(d) { var key = new Date(d.expirationDate).toISOString().split('T')[0]; var p = prev24hMap[key]; return p ? p.totalCallDollarVolume : null; });
      const faded24hPut  = crData.map(function(d) { var key = new Date(d.expirationDate).toISOString().split('T')[0]; var p = prev24hMap[key]; return p ? p.totalPutDollarVolume : null; });
      const has24h = faded24hCall.some(function(v) { return v !== null; }) || faded24hPut.some(function(v) { return v !== null; });

      const datasets = [];
      if (has24h) {
        datasets.push(
          {
            label: 'Call $ (24h ago)',
            data: faded24hCall,
            backgroundColor: 'rgba(72, 187, 120, 0.10)',
            borderColor: 'rgba(72, 187, 120, 0.22)',
            borderWidth: 1,
            stack: 'call',
            order: 2,
            barPercentage: 1.0
          },
          {
            label: 'Put $ (24h ago)',
            data: faded24hPut,
            backgroundColor: 'rgba(245, 101, 101, 0.10)',
            borderColor: 'rgba(245, 101, 101, 0.22)',
            borderWidth: 1,
            stack: 'put',
            order: 2,
            barPercentage: 1.0
          }
        );
      }
      datasets.push(
        {
          label: 'Call $ Volume',
          data: crData.map(d => d.totalCallDollarVolume || 0),
          backgroundColor: 'rgba(72, 187, 120, 0.35)',
          borderColor: 'rgba(72, 187, 120, 0.6)',
          borderWidth: 1,
          stack: 'call',
          order: 1,
          barPercentage: 0.85
        },
        {
          label: 'Put $ Volume',
          data: crData.map(d => d.totalPutDollarVolume || 0),
          backgroundColor: 'rgba(245, 101, 101, 0.35)',
          borderColor: 'rgba(245, 101, 101, 0.6)',
          borderWidth: 1,
          stack: 'put',
          order: 1,
          barPercentage: 0.85
        }
      );

      let drilldownChartAll = null;
      const convChartAll = new Chart(document.getElementById('dollarConvictionChartAll'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements.length) return;
            const idx = elements[0].index;
            const exp = crData[idx];
            if (!exp || !exp.contracts || !exp.contracts.length) return;
            const expLabel = labels[idx];

            const strikeMap = {};
            exp.contracts.forEach(c => {
              if (!c.dollarVolume) return;
              if (!strikeMap[c.strike]) strikeMap[c.strike] = { call: 0, put: 0 };
              if (c.type === 'call') strikeMap[c.strike].call += c.dollarVolume;
              else strikeMap[c.strike].put += c.dollarVolume;
            });
            const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
            if (!strikes.length) return;
            const callData = strikes.map(s => strikeMap[s].call);
            const putData = strikes.map(s => strikeMap[s].put);
            const strikeLabels = strikes.map(s => '$' + s);

            const wrap = document.getElementById('strikeDrilldownWrapAll');
            wrap.style.display = 'block';

            if (drilldownChartAll) drilldownChartAll.destroy();
            drilldownChartAll = new Chart(document.getElementById('strikeDrilldownChartAll'), {
              type: 'bar',
              data: {
                labels: strikeLabels,
                datasets: [
                  {
                    label: 'Call $ Volume',
                    data: callData,
                    backgroundColor: 'rgba(72, 187, 120, 0.5)',
                    borderColor: 'rgba(72, 187, 120, 0.8)',
                    borderWidth: 1
                  },
                  {
                    label: 'Put $ Volume',
                    data: putData,
                    backgroundColor: 'rgba(245, 101, 101, 0.5)',
                    borderColor: 'rgba(245, 101, 101, 0.8)',
                    borderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#b0b0b0' } },
                  title: { display: true, text: 'Strike Breakdown — ' + expLabel, color: '#b0b0b0' },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        const v = ctx.parsed.y;
                        return ctx.dataset.label + ': $' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
                      }
                    }
                  }
                },
                scales: {
                  x: {
                    ticks: { color: '#909090' },
                    grid: { color: '#2a2a4a' }
                  },
                  y: {
                    title: { display: true, text: '$ Volume', color: '#909090' },
                    ticks: {
                      color: '#909090',
                      callback: function(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v; }
                    },
                    grid: { color: '#2a2a4a' },
                    beginAtZero: true
                  }
                }
              }
            });
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'Dollar Volume by Expiration — ITM+OTM (click bar to drill down)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null || ctx.raw === undefined) return null;
                  const v = ctx.parsed.y;
                  return ctx.dataset.label + ': $' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              stacked: false,
              title: { display: true, text: '$ Volume', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v; }
              },
              grid: { color: '#2a2a4a' },
              beginAtZero: true
            }
          }
        }
      });
    }`;
    })()}

    // Dollar Flow Chart (Call$ vs Put$ over time) — lazy init from card expand
    ${(() => {
      const hvcData = ea?.components?.historicalVolConviction?.history || [];
      if (hvcData.length < 2) return '';
      return `
    function initVolConvictionChart() {
      const histData = ${JSON.stringify(hvcData)};
      const hasIVGap = histData.some(d => d.ivGap !== null && d.ivGap !== undefined);

      const labels = histData.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      const datasets = [
        {
          label: 'Call $ Volume',
          data: histData.map(d => d.totalCallDollar),
          backgroundColor: 'rgba(72, 187, 120, 0.7)',
          borderColor: 'rgba(72, 187, 120, 1)',
          borderWidth: 1,
          yAxisID: 'y'
        },
        {
          label: 'Put $ Volume',
          data: histData.map(d => d.totalPutDollar),
          backgroundColor: 'rgba(245, 101, 101, 0.7)',
          borderColor: 'rgba(245, 101, 101, 1)',
          borderWidth: 1,
          yAxisID: 'y'
        }
      ];

      if (hasIVGap) {
        datasets.push({
          label: 'IV Gap (Call−Put)',
          data: histData.map(d => d.ivGap),
          type: 'line',
          borderColor: 'rgba(214, 158, 46, 1)',
          backgroundColor: 'rgba(214, 158, 46, 0.3)',
          pointBackgroundColor: histData.map(d => d.ivGap !== null ? (d.ivGap >= 0 ? '#48bb78' : '#f56565') : '#888'),
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.3,
          fill: false,
          yAxisID: 'yIV',
          spanGaps: true
        });
      }

      const scales = {
        x: {
          ticks: { color: '#909090' },
          grid: { color: '#2a2a4a' }
        },
        y: {
          position: 'left',
          title: { display: true, text: 'Dollar Volume ($)', color: '#909090' },
          ticks: {
            color: '#909090',
            callback: function(v) { return v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(0) + 'K' : '$' + v; }
          },
          grid: { color: '#2a2a4a' }
        }
      };

      if (hasIVGap) {
        scales.yIV = {
          position: 'right',
          title: { display: true, text: 'IV Gap (pp)', color: '#d69e2e' },
          ticks: { color: '#d69e2e', callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); } },
          grid: { drawOnChartArea: false }
        };
      }

      new Chart(document.getElementById('volConvictionChart'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'OTM Dollar Volume Trend (2 Nearest Exp.)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.dataset.yAxisID === 'yIV') {
                    const v = ctx.raw;
                    return v !== null ? 'IV Gap: ' + (v >= 0 ? '+' : '') + v.toFixed(1) + ' pp' : 'IV Gap: N/A';
                  }
                  const v = ctx.raw;
                  return ctx.dataset.label + ': $' + (v >= 1e6 ? (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? (v/1e3).toFixed(0) + 'K' : v.toFixed(0));
                }
              }
            }
          },
          scales
        }
      });
    }

    `;
    })()}

    // Call/Put Dollar Ratio by Expiration (ITM+OTM) — lazy init from card expand
    ${(() => {
      const vcRatioPerExp = ea?.components?.volumeConvictionAll?.perExpiration || [];
      if (vcRatioPerExp.length < 1) return '';

      // Slim down data for embedding (drop contracts array)
      const ratioPerExp = vcRatioPerExp.map(e => ({
        expirationDate: e.expirationDate,
        convictionRatio: e.convictionRatio || 0,
        totalCallDollarVolume: e.totalCallDollarVolume || 0,
        totalPutDollarVolume: e.totalPutDollarVolume || 0,
        avgCallIVAll: e.avgCallIVAll || 0,
        avgPutIVAll: e.avgPutIVAll || 0
      }));

      // Build per-expiration historical ratio from saved snapshots (ITM+OTM columns, fallback to OTM)
      const ratioHistByExp = {};
      if (optionsData?.history) {
        for (const snap of optionsData.history) {
          const rawExp = snap.expiration_date;
          if (!rawExp) continue;
          const expKey = new Date(rawExp).toISOString().split('T')[0];
          if (!ratioHistByExp[expKey]) ratioHistByExp[expKey] = [];
          // Prefer ITM+OTM columns; fall back to OTM-only for older snapshots
          const cd = Number(snap.total_call_dollar_volume_all) || Number(snap.total_call_dollar_volume) || 0;
          const pd = Number(snap.total_put_dollar_volume_all) || Number(snap.total_put_dollar_volume) || 0;
          // IV gap from ITM+OTM avg IV columns
          const civ = Number(snap.avg_call_iv_all) || 0;
          const piv = Number(snap.avg_put_iv_all) || 0;
          ratioHistByExp[expKey].push({
            date: new Date(snap.snapshot_date).toISOString().split('T')[0],
            ratio: pd > 0 ? cd / pd : 0,
            ivGap: (civ > 0 || piv > 0) ? (civ - piv) * 100 : null
          });
        }
        for (const k of Object.keys(ratioHistByExp)) {
          ratioHistByExp[k].sort((a, b) => a.date.localeCompare(b.date));
        }
      }

      return `
    function initCpRatioChart() {
      const cpRatioCanvas = document.getElementById('cpRatioChart');
      if (!cpRatioCanvas) return;

      const crData = ${JSON.stringify(ratioPerExp)};
      const histByExp = ${JSON.stringify(ratioHistByExp)};

      const labels = crData.map(function(d) {
        var dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      const rawRatios = crData.map(function(d) { return d.convictionRatio; });
      const ratios = rawRatios.map(function(r) { return r > 0 ? Math.log(r) : 0; });
      const barColors = ratios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 0.7)' : 'rgba(245, 101, 101, 0.7)'; });
      const borderColors = ratios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; });

      // IV gap: call IV - put IV (positive = calls more expensive)
      const ivGaps = crData.map(function(d) {
        var callIV = d.avgCallIVAll || 0;
        var putIV = d.avgPutIVAll || 0;
        if (callIV === 0 && putIV === 0) return null;
        return (callIV - putIV) * 100; // in percentage points
      });
      const hasIVGap = ivGaps.some(function(v) { return v !== null; });

      var histChart = null;

      var datasets = [
        {
          label: 'ln(Call/Put $ Ratio)',
          data: ratios,
          backgroundColor: barColors,
          borderColor: borderColors,
          borderWidth: 1,
          yAxisID: 'y',
          order: 2
        },
        {
          label: 'Neutral (0)',
          data: labels.map(function() { return 0; }),
          type: 'line',
          borderColor: 'rgba(160, 174, 192, 0.5)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          yAxisID: 'y',
          order: 0
        }
      ];

      if (hasIVGap) {
        datasets.push({
          label: 'IV Gap (Call−Put)',
          data: ivGaps,
          type: 'line',
          borderColor: '#d69e2e',
          backgroundColor: 'rgba(214, 158, 46, 0.1)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: ivGaps.map(function(v) {
            if (v === null) return 'transparent';
            return v >= 0 ? '#48bb78' : '#f56565';
          }),
          tension: 0.3,
          yAxisID: 'y1',
          order: 1
        });
      }

      new Chart(cpRatioCanvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements.length) return;
            var idx = elements[0].index;
            var exp = crData[idx];
            if (!exp) return;

            var expDateStr = new Date(exp.expirationDate).toISOString().split('T')[0];
            var hist = histByExp[expDateStr] || [];

            var noHistEl = document.getElementById('cpRatioNoHistory');
            var wrapEl = document.getElementById('cpRatioHistoryWrap');

            if (!hist.length) {
              wrapEl.style.display = 'none';
              noHistEl.style.display = 'block';
              return;
            }
            noHistEl.style.display = 'none';
            wrapEl.style.display = 'block';

            var histLabels = hist.map(function(d) {
              var dt = new Date(d.date);
              return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
            var histRatios = hist.map(function(d) { return d.ratio > 0 ? Math.log(d.ratio) : 0; });
            var histRawRatios = hist.map(function(d) { return d.ratio; });
            var histIVGaps = hist.map(function(d) { return d.ivGap; });
            var hasHistIVGap = histIVGaps.some(function(v) { return v !== null; });

            var histDatasets = [
              {
                label: 'ln(Call/Put $ Ratio)',
                data: histRatios,
                borderColor: 'rgba(99, 179, 237, 0.9)',
                backgroundColor: 'rgba(99, 179, 237, 0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: histRatios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; }),
                fill: true,
                tension: 0.2,
                yAxisID: 'y'
              },
              {
                label: 'Neutral (0)',
                data: histLabels.map(function() { return 0; }),
                borderColor: 'rgba(160, 174, 192, 0.4)',
                borderWidth: 1,
                borderDash: [4, 4],
                pointRadius: 0,
                fill: false,
                yAxisID: 'y'
              }
            ];

            if (hasHistIVGap) {
              histDatasets.push({
                label: 'IV Gap (Call\\u2212Put)',
                data: histIVGaps,
                borderColor: '#d69e2e',
                backgroundColor: 'rgba(214, 158, 46, 0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: histIVGaps.map(function(v) {
                  if (v === null) return 'transparent';
                  return v >= 0 ? '#48bb78' : '#f56565';
                }),
                tension: 0.2,
                yAxisID: 'y1'
              });
            }

            if (histChart) histChart.destroy();
            histChart = new Chart(document.getElementById('cpRatioHistoryChart'), {
              type: 'line',
              data: {
                labels: histLabels,
                datasets: histDatasets
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#b0b0b0' } },
                  title: { display: true, text: 'Historical ln(Call/Put $ Ratio) — Exp ' + labels[idx], color: '#b0b0b0' },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        if (ctx.dataset.label === 'Neutral (0)') return 'Neutral: 0';
                        if (ctx.dataset.label === 'IV Gap (Call\\u2212Put)') {
                          return 'IV Gap: ' + (ctx.raw != null ? (ctx.raw >= 0 ? '+' : '') + ctx.raw.toFixed(1) + ' pp' : 'N/A');
                        }
                        var raw = histRawRatios[ctx.dataIndex];
                        return 'ln(ratio): ' + ctx.raw.toFixed(2) + ' (raw: ' + (raw ? raw.toFixed(2) : '0') + 'x)';
                      }
                    }
                  }
                },
                scales: {
                  x: {
                    ticks: { color: '#909090' },
                    grid: { color: '#2a2a4a' }
                  },
                  y: {
                    position: 'left',
                    title: { display: true, text: 'ln(Call/Put $ Ratio)', color: '#909090' },
                    ticks: {
                      color: '#909090',
                      callback: function(v) { return v.toFixed(1); }
                    },
                    grid: { color: '#2a2a4a' }
                  },
                  y1: {
                    position: 'right',
                    display: hasHistIVGap,
                    title: { display: true, text: 'IV Gap (pp)', color: '#d69e2e' },
                    ticks: {
                      color: '#d69e2e',
                      callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }
                    },
                    grid: { drawOnChartArea: false }
                  }
                }
              }
            });
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'ln(Call/Put Dollar Volume Ratio) by Expiration (click bar for history)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.dataset.label === 'Neutral (0)') return 'Neutral: 0';
                  if (ctx.dataset.label === 'IV Gap (Call\\u2212Put)') {
                    return 'IV Gap: ' + (ctx.raw != null ? (ctx.raw >= 0 ? '+' : '') + ctx.raw.toFixed(1) + ' pp' : 'N/A');
                  }
                  var raw = rawRatios[ctx.dataIndex];
                  return 'ln(ratio): ' + ctx.raw.toFixed(2) + ' (raw: ' + (raw ? raw.toFixed(2) : '0') + 'x)';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              position: 'left',
              title: { display: true, text: 'ln(Call/Put $ Ratio)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1); }
              },
              grid: { color: '#2a2a4a' }
            },
            y1: {
              position: 'right',
              display: hasIVGap,
              title: { display: true, text: 'IV Gap (pp)', color: '#d69e2e' },
              ticks: {
                color: '#d69e2e',
                callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }
              },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }`;
    })()}

    // Call/Put Dollar Ratio by Expiration (2%+ OTM only) — lazy init from card expand
    ${(() => {
      const vcOtmPerExp = ea?.components?.volumeConviction?.perExpiration || [];
      if (vcOtmPerExp.length < 1) return '';

      const ratioOtmPerExp = vcOtmPerExp.map(e => ({
        expirationDate: e.expirationDate,
        convictionRatio: e.convictionRatio || 0,
        totalCallDollarVolume: e.totalCallDollarVolume || 0,
        totalPutDollarVolume: e.totalPutDollarVolume || 0,
        avgCallIV: e.avgCallIV || 0,
        avgPutIV: e.avgPutIV || 0
      }));

      // Build per-expiration historical ratio from saved snapshots (OTM-only columns)
      const ratioOtmHistByExp = {};
      if (optionsData?.history) {
        for (const snap of optionsData.history) {
          const rawExp = snap.expiration_date;
          if (!rawExp) continue;
          const expKey = new Date(rawExp).toISOString().split('T')[0];
          if (!ratioOtmHistByExp[expKey]) ratioOtmHistByExp[expKey] = [];
          const cd = Number(snap.total_call_dollar_volume) || 0;
          const pd = Number(snap.total_put_dollar_volume) || 0;
          // IV gap from OTM (2.5%+) avg IV columns
          const civ = Number(snap.avg_call_iv) || 0;
          const piv = Number(snap.avg_put_iv) || 0;
          ratioOtmHistByExp[expKey].push({
            date: new Date(snap.snapshot_date).toISOString().split('T')[0],
            ratio: pd > 0 ? cd / pd : 0,
            ivGap: (civ > 0 || piv > 0) ? (civ - piv) * 100 : null
          });
        }
        for (const k of Object.keys(ratioOtmHistByExp)) {
          ratioOtmHistByExp[k].sort((a, b) => a.date.localeCompare(b.date));
        }
      }

      return `
    function initCpRatioOtmChart() {
      const cpRatioOtmCanvas = document.getElementById('cpRatioOtmChart');
      if (!cpRatioOtmCanvas) return;

      const crData = ${JSON.stringify(ratioOtmPerExp)};
      const histByExp = ${JSON.stringify(ratioOtmHistByExp)};

      const labels = crData.map(function(d) {
        var dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      const rawRatios = crData.map(function(d) { return d.convictionRatio; });
      const ratios = rawRatios.map(function(r) { return r > 0 ? Math.log(r) : 0; });
      const barColors = ratios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 0.7)' : 'rgba(245, 101, 101, 0.7)'; });
      const borderColors = ratios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; });

      // IV gap: call IV - put IV using 2.5%+ OTM averages (positive = calls more expensive)
      const ivGapsOtm = crData.map(function(d) {
        var callIV = d.avgCallIV || 0;
        var putIV = d.avgPutIV || 0;
        if (callIV === 0 && putIV === 0) return null;
        return (callIV - putIV) * 100; // in percentage points
      });
      const hasIVGapOtm = ivGapsOtm.some(function(v) { return v !== null; });

      var histChart = null;

      var datasetsOtm = [
        {
          label: 'ln(Call/Put $ Ratio)',
          data: ratios,
          backgroundColor: barColors,
          borderColor: borderColors,
          borderWidth: 1,
          yAxisID: 'y',
          order: 2
        },
        {
          label: 'Neutral (0)',
          data: labels.map(function() { return 0; }),
          type: 'line',
          borderColor: 'rgba(160, 174, 192, 0.5)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          yAxisID: 'y',
          order: 0
        }
      ];

      if (hasIVGapOtm) {
        datasetsOtm.push({
          label: 'IV Gap (Call−Put)',
          data: ivGapsOtm,
          type: 'line',
          borderColor: '#d69e2e',
          backgroundColor: 'rgba(214, 158, 46, 0.1)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: ivGapsOtm.map(function(v) {
            if (v === null) return 'transparent';
            return v >= 0 ? '#48bb78' : '#f56565';
          }),
          tension: 0.3,
          yAxisID: 'y1',
          order: 1
        });
      }

      new Chart(cpRatioOtmCanvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: datasetsOtm
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: function(evt, elements) {
            if (!elements.length) return;
            var idx = elements[0].index;
            var exp = crData[idx];
            if (!exp) return;

            var expDateStr = new Date(exp.expirationDate).toISOString().split('T')[0];
            var hist = histByExp[expDateStr] || [];

            var noHistEl = document.getElementById('cpRatioOtmNoHistory');
            var wrapEl = document.getElementById('cpRatioOtmHistoryWrap');

            if (!hist.length) {
              wrapEl.style.display = 'none';
              noHistEl.style.display = 'block';
              return;
            }
            noHistEl.style.display = 'none';
            wrapEl.style.display = 'block';

            var histLabels = hist.map(function(d) {
              var dt = new Date(d.date);
              return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
            var histRatios = hist.map(function(d) { return d.ratio > 0 ? Math.log(d.ratio) : 0; });
            var histRawRatios = hist.map(function(d) { return d.ratio; });
            var histIVGapsOtm = hist.map(function(d) { return d.ivGap; });
            var hasHistIVGapOtm = histIVGapsOtm.some(function(v) { return v !== null; });

            var histDatasetsOtm = [
              {
                label: 'ln(Call/Put $ Ratio)',
                data: histRatios,
                borderColor: 'rgba(99, 179, 237, 0.9)',
                backgroundColor: 'rgba(99, 179, 237, 0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: histRatios.map(function(r) { return r >= 0 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; }),
                fill: true,
                tension: 0.2,
                yAxisID: 'y'
              },
              {
                label: 'Neutral (0)',
                data: histLabels.map(function() { return 0; }),
                borderColor: 'rgba(160, 174, 192, 0.4)',
                borderWidth: 1,
                borderDash: [4, 4],
                pointRadius: 0,
                fill: false,
                yAxisID: 'y'
              }
            ];

            if (hasHistIVGapOtm) {
              histDatasetsOtm.push({
                label: 'IV Gap (Call\\u2212Put)',
                data: histIVGapsOtm,
                borderColor: '#d69e2e',
                backgroundColor: 'rgba(214, 158, 46, 0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: histIVGapsOtm.map(function(v) {
                  if (v === null) return 'transparent';
                  return v >= 0 ? '#48bb78' : '#f56565';
                }),
                tension: 0.2,
                yAxisID: 'y1'
              });
            }

            if (histChart) histChart.destroy();
            histChart = new Chart(document.getElementById('cpRatioOtmHistoryChart'), {
              type: 'line',
              data: {
                labels: histLabels,
                datasets: histDatasetsOtm
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#b0b0b0' } },
                  title: { display: true, text: 'Historical ln(Call/Put $ Ratio) — Exp ' + labels[idx], color: '#b0b0b0' },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        if (ctx.dataset.label === 'Neutral (0)') return 'Neutral: 0';
                        if (ctx.dataset.label === 'IV Gap (Call\\u2212Put)') {
                          return 'IV Gap: ' + (ctx.raw != null ? (ctx.raw >= 0 ? '+' : '') + ctx.raw.toFixed(1) + ' pp' : 'N/A');
                        }
                        var raw = histRawRatios[ctx.dataIndex];
                        return 'ln(ratio): ' + ctx.raw.toFixed(2) + ' (raw: ' + (raw ? raw.toFixed(2) : '0') + 'x)';
                      }
                    }
                  }
                },
                scales: {
                  x: {
                    ticks: { color: '#909090' },
                    grid: { color: '#2a2a4a' }
                  },
                  y: {
                    position: 'left',
                    title: { display: true, text: 'ln(Call/Put $ Ratio)', color: '#909090' },
                    ticks: {
                      color: '#909090',
                      callback: function(v) { return v.toFixed(1); }
                    },
                    grid: { color: '#2a2a4a' }
                  },
                  y1: {
                    position: 'right',
                    display: hasHistIVGapOtm,
                    title: { display: true, text: 'IV Gap (pp)', color: '#d69e2e' },
                    ticks: {
                      color: '#d69e2e',
                      callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }
                    },
                    grid: { drawOnChartArea: false }
                  }
                }
              }
            });
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'ln(Call/Put Dollar Volume Ratio) by Expiration — 2%+ OTM (click bar for history)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.dataset.label === 'Neutral (0)') return 'Neutral: 0';
                  if (ctx.dataset.label === 'IV Gap (Call\\u2212Put)') {
                    return 'IV Gap: ' + (ctx.raw != null ? (ctx.raw >= 0 ? '+' : '') + ctx.raw.toFixed(1) + ' pp' : 'N/A');
                  }
                  var raw = rawRatios[ctx.dataIndex];
                  return 'ln(ratio): ' + ctx.raw.toFixed(2) + ' (raw: ' + (raw ? raw.toFixed(2) : '0') + 'x)';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090' },
              grid: { color: '#2a2a4a' }
            },
            y: {
              position: 'left',
              title: { display: true, text: 'ln(Call/Put $ Ratio)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1); }
              },
              grid: { color: '#2a2a4a' }
            },
            y1: {
              position: 'right',
              display: hasIVGapOtm,
              title: { display: true, text: 'IV Gap (pp)', color: '#d69e2e' },
              ticks: {
                color: '#d69e2e',
                callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }
              },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }`;
    })()}

    ${empiricalHoldData ? `
    // === Empirical Post-Event Hold Duration Chart ===
    (() => {
      const holdCanvas = document.getElementById('holdReturnChart');
      if (!holdCanvas) return;

      const holdData = ${JSON.stringify(empiricalHoldData)};
      const clsOrder = ['negative_anticipated', 'surprising_negative', 'positive_anticipated', 'surprising_positive'];
      const clsLabels = {
        negative_anticipated: 'Negative Anticipated',
        surprising_negative: 'Surprising Negative',
        positive_anticipated: 'Positive Anticipated',
        surprising_positive: 'Surprising Positive',
      };
      const clsColors = {
        negative_anticipated: 'orange',
        surprising_negative: '#e53e3e',
        positive_anticipated: 'lightgreen',
        surprising_positive: 'darkgreen',
      };

      // Find max day across all classifications, use maxForwardDays for consistent axis
      let maxDay = 0;
      for (const cls of clsOrder) {
        const d = holdData.classifications[cls];
        if (d && d.byDay) {
          for (const pt of d.byDay) {
            if (pt.day > maxDay) maxDay = pt.day;
          }
        }
      }
      if (maxDay === 0) return;
      maxDay = holdData.maxForwardDays || maxDay;
      const labels = Array.from({length: maxDay}, (_, i) => 'Day ' + (i + 1));

      const datasets = clsOrder.filter(cls => holdData.classifications[cls]).map(cls => {
        const d = holdData.classifications[cls];
        const dayMap = {};
        for (const pt of d.byDay) { dayMap[pt.day] = pt.median_return * 100; }

        const data = Array.from({length: maxDay}, (_, i) => dayMap[i + 1] ?? null);

        // Highlight peak day
        const pointRadii = data.map((_, i) => (i + 1) === d.holdDays ? 7 : 0);
        const pointBgColors = data.map((_, i) => (i + 1) === d.holdDays ? clsColors[cls] : 'transparent');

        return {
          label: clsLabels[cls],
          data,
          borderColor: clsColors[cls],
          borderWidth: 2,
          pointRadius: pointRadii,
          pointBackgroundColor: pointBgColors,
          pointBorderColor: pointBgColors,
          pointHoverRadius: 5,
          spanGaps: true,
          tension: 0.3,
          fill: false,
        };
      });

      new Chart(holdCanvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: {
              display: true,
              text: 'Median Cumulative Return by Classification (Trading Days After Event)',
              color: '#b0b0b0',
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null) return '';
                  return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + '%';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' },
            },
            y: {
              title: { display: true, text: 'Cumulative Return (%)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + '%'; }
              },
              grid: { color: '#2a2a4a' },
            },
          },
          elements: { line: { tension: 0.3 } },
        },
        plugins: [{
          id: 'zeroLine',
          afterDraw(chart) {
            const yScale = chart.scales.y;
            const ctx = chart.ctx;
            const y = yScale.getPixelForValue(0);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.chartArea.left, y);
              ctx.lineTo(chart.chartArea.right, y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }]
      });
    })();
    ` : ''}

    ${empiricalHoldData?.optionsAdjusted ? `
    // === Options-Adjusted Post-Event Hold Duration Chart ===
    (() => {
      const adjCanvas = document.getElementById('holdAdjReturnChart');
      if (!adjCanvas) return;

      const adjData = ${JSON.stringify(empiricalHoldData.optionsAdjusted)};
      const clsOrder = ['negative_anticipated', 'surprising_negative', 'positive_anticipated', 'surprising_positive'];
      const clsLabels = {
        negative_anticipated: 'Negative Anticipated',
        surprising_negative: 'Surprising Negative',
        positive_anticipated: 'Positive Anticipated',
        surprising_positive: 'Surprising Positive',
      };
      const adjClsColors = {
        negative_anticipated: 'orange',
        surprising_negative: '#e53e3e',
        positive_anticipated: 'lightgreen',
        surprising_positive: 'darkgreen',
      };

      let maxDay = 0;
      for (const cls of clsOrder) {
        const d = adjData.classifications[cls];
        if (d && d.byDay) {
          for (const pt of d.byDay) {
            if (pt.day > maxDay) maxDay = pt.day;
          }
        }
      }
      if (maxDay === 0) return;
      maxDay = adjData.maxForwardDays || maxDay;
      const adjLabels = Array.from({length: maxDay}, (_, i) => 'Day ' + (i + 1));

      const adjDatasets = clsOrder.filter(cls => adjData.classifications[cls]).map(cls => {
        const d = adjData.classifications[cls];
        const dayMap = {};
        for (const pt of d.byDay) { dayMap[pt.day] = pt.median_return * 100; }
        const data = Array.from({length: maxDay}, (_, i) => dayMap[i + 1] ?? null);
        const pointRadii = data.map((_, i) => (i + 1) === d.holdDays ? 7 : 0);
        const pointBgColors = data.map((_, i) => (i + 1) === d.holdDays ? adjClsColors[cls] : 'transparent');

        return {
          label: clsLabels[cls],
          data,
          borderColor: adjClsColors[cls],
          borderWidth: 2,
          pointRadius: pointRadii,
          pointBackgroundColor: pointBgColors,
          pointBorderColor: pointBgColors,
          pointHoverRadius: 5,
          spanGaps: true,
          tension: 0.3,
          fill: false,
        };
      });

      new Chart(adjCanvas, {
        type: 'line',
        data: { labels: adjLabels, datasets: adjDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: {
              display: true,
              text: 'Options-Adjusted Weighted Median Return (' + adjData.totalMatchedEvents + ' events, ' + (adjData.avgSimilarity * 100).toFixed(0) + '% avg similarity)',
              color: '#b0b0b0',
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null) return '';
                  return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + '%';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' },
            },
            y: {
              title: { display: true, text: 'Weighted Cumulative Return (%)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + '%'; }
              },
              grid: { color: '#2a2a4a' },
            },
          },
        },
        plugins: [{
          id: 'zeroLineAdj',
          afterDraw(chart) {
            const yScale = chart.scales.y;
            const ctx = chart.ctx;
            const y = yScale.getPixelForValue(0);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.chartArea.left, y);
              ctx.lineTo(chart.chartArea.right, y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }]
      });
    })();
    ` : ''}

    ${empiricalHoldData?.snapshotOptimalHold ? `
    // === Snapshot Optimal Hold Period Chart ===
    (() => {
      const snapCanvas = document.getElementById('snapshotOptimalHoldChart');
      if (!snapCanvas) return;

      const snapData = ${JSON.stringify(empiricalHoldData.snapshotOptimalHold)};
      if (!snapData.byDay || snapData.byDay.length === 0) return;
      const maxDay = snapData.maxForwardDays || Math.max(...snapData.byDay.map(d => d.day));
      const labels = Array.from({length: maxDay}, (_, i) => 'Day ' + (i + 1));

      const dayMap = {};
      for (const pt of snapData.byDay) { dayMap[pt.day] = pt.median_return * 100; }
      const data = Array.from({length: maxDay}, (_, i) => dayMap[i + 1] ?? null);

      const pointRadii = data.map((_, i) => (i + 1) === snapData.peakDay ? 8 : 0);
      const pointBgColors = data.map((_, i) => (i + 1) === snapData.peakDay ? '#63b3ed' : 'transparent');

      new Chart(snapCanvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Weighted Median Return',
            data,
            borderColor: '#63b3ed',
            borderWidth: 2,
            pointRadius: pointRadii,
            pointBackgroundColor: pointBgColors,
            pointBorderColor: pointBgColors,
            pointHoverRadius: 5,
            spanGaps: true,
            tension: 0.3,
            fill: false,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: {
              display: true,
              text: 'Options-Based Optimal Hold (' + snapData.totalMatchedSnapshots + ' snapshots, ' + (snapData.avgSimilarity * 100).toFixed(0) + '% avg similarity)',
              color: '#b0b0b0',
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null) return '';
                  return 'Return: ' + ctx.raw.toFixed(2) + '%';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' },
            },
            y: {
              title: { display: true, text: 'Weighted Cumulative Return (%)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + '%'; }
              },
              grid: { color: '#2a2a4a' },
            },
          },
        },
        plugins: [{
          id: 'zeroLineSnap',
          afterDraw(chart) {
            const yScale = chart.scales.y;
            const ctx = chart.ctx;
            const y = yScale.getPixelForValue(0);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.chartArea.left, y);
              ctx.lineTo(chart.chartArea.right, y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }]
      });
    })();
    ` : ''}

    ${empiricalHoldData?.chronosHold ? `
    // === Chronos-2 Forecast Hold Period Chart ===
    (() => {
      const chronosCanvas = document.getElementById('chronosHoldChart');
      if (!chronosCanvas) return;

      const chData = ${JSON.stringify(empiricalHoldData.chronosHold)};
      if (!chData.byDay || chData.byDay.length === 0) return;

      const maxDay = chData.maxForwardDays || Math.max(...chData.byDay.map(d => d.day));
      const labels = Array.from({length: maxDay}, (_, i) => 'Day ' + (i + 1));

      const dayMap = {};
      for (const pt of chData.byDay) { dayMap[pt.day] = pt; }

      const medianData = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.median_return * 100 : null;
      });
      const p10Data = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.p10_return * 100 : null;
      });
      const p90Data = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.p90_return * 100 : null;
      });
      const probData = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.prob_positive * 100 : null;
      });

      const peakRadii = medianData.map((_, i) => (i + 1) === chData.peakDay ? 8 : 0);
      const peakColors = medianData.map((_, i) => (i + 1) === chData.peakDay ? '#e6b800' : 'transparent');

      new Chart(chronosCanvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'P90 Return',
              data: p90Data,
              borderColor: 'rgba(72, 187, 120, 0.3)',
              backgroundColor: 'rgba(72, 187, 120, 0.08)',
              borderWidth: 1,
              pointRadius: 0,
              spanGaps: true,
              tension: 0.3,
              fill: '+2',
            },
            {
              label: 'Median Return',
              data: medianData,
              borderColor: '#e6b800',
              borderWidth: 2,
              pointRadius: peakRadii,
              pointBackgroundColor: peakColors,
              pointBorderColor: peakColors,
              pointHoverRadius: 5,
              spanGaps: true,
              tension: 0.3,
              fill: false,
            },
            {
              label: 'P10 Return',
              data: p10Data,
              borderColor: 'rgba(245, 101, 101, 0.3)',
              backgroundColor: 'rgba(245, 101, 101, 0.08)',
              borderWidth: 1,
              pointRadius: 0,
              spanGaps: true,
              tension: 0.3,
              fill: false,
            },
            {
              label: 'P(positive) %',
              data: probData,
              borderColor: 'rgba(99, 179, 237, 0.6)',
              borderWidth: 1,
              borderDash: [4, 4],
              pointRadius: 0,
              spanGaps: true,
              tension: 0.3,
              fill: false,
              yAxisID: 'yProb',
            },
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0', boxWidth: 12 } },
            title: {
              display: true,
              text: 'Chronos-2 Forecast (' + chData.model + ', ' + chData.contextLength + ' days context, peak: Day ' + chData.peakDay + ' @ ' + (chData.peakReturn * 100).toFixed(2) + '%)',
              color: '#b0b0b0',
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null) return '';
                  if (ctx.dataset.yAxisID === 'yProb') return 'P(+): ' + ctx.raw.toFixed(1) + '%';
                  return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + '%';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' },
            },
            y: {
              position: 'left',
              title: { display: true, text: 'Cumulative Return (%)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + '%'; }
              },
              grid: { color: '#2a2a4a' },
            },
            yProb: {
              position: 'right',
              title: { display: true, text: 'P(positive return) %', color: '#63b3ed' },
              ticks: { color: '#63b3ed', callback: function(v) { return v.toFixed(0) + '%'; } },
              grid: { display: false },
              min: 0,
              max: 100,
            },
          },
        },
        plugins: [{
          id: 'zeroLineChronos',
          afterDraw(chart) {
            const yScale = chart.scales.y;
            const ctx = chart.ctx;
            const y = yScale.getPixelForValue(0);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.chartArea.left, y);
              ctx.lineTo(chart.chartArea.right, y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }]
      });
    })();

    // === Chronos Options-Adjusted Chart ===
    ${empiricalHoldData?.chronosHold?.optionsAdjusted ? `
    (() => {
      const adjCanvas = document.getElementById('chronosAdjHoldChart');
      if (!adjCanvas) return;

      const adjData = ${JSON.stringify(empiricalHoldData.chronosHold.optionsAdjusted)};
      if (!adjData.byDay || adjData.byDay.length === 0) return;

      const maxDay = ${empiricalHoldData.chronosHold.maxForwardDays} || Math.max(...adjData.byDay.map(d => d.day));
      const labels = Array.from({length: maxDay}, (_, i) => 'Day ' + (i + 1));

      const dayMap = {};
      for (const pt of adjData.byDay) { dayMap[pt.day] = pt; }

      const medianData = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.median_return * 100 : null;
      });
      const p10Data = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.p10_return * 100 : null;
      });
      const p90Data = Array.from({length: maxDay}, (_, i) => {
        const d = dayMap[i + 1];
        return d ? d.p90_return * 100 : null;
      });

      const peakRadii = medianData.map((_, i) => (i + 1) === adjData.peakDay ? 8 : 0);
      const peakColors = medianData.map((_, i) => (i + 1) === adjData.peakDay ? '#f6ad55' : 'transparent');

      new Chart(adjCanvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'P90 (adj)',
              data: p90Data,
              borderColor: 'rgba(72, 187, 120, 0.3)',
              backgroundColor: 'rgba(72, 187, 120, 0.06)',
              borderWidth: 1,
              pointRadius: 0,
              spanGaps: true,
              tension: 0.3,
              fill: '+2',
            },
            {
              label: 'Median (adj)',
              data: medianData,
              borderColor: '#f6ad55',
              borderWidth: 2,
              pointRadius: peakRadii,
              pointBackgroundColor: peakColors,
              pointBorderColor: peakColors,
              pointHoverRadius: 5,
              spanGaps: true,
              tension: 0.3,
              fill: false,
            },
            {
              label: 'P10 (adj)',
              data: p10Data,
              borderColor: 'rgba(245, 101, 101, 0.3)',
              borderWidth: 1,
              pointRadius: 0,
              spanGaps: true,
              tension: 0.3,
              fill: false,
            },
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0', boxWidth: 12 } },
            title: {
              display: true,
              text: 'Options-Adjusted Chronos Forecast (peak: Day ' + adjData.peakDay + ' @ ' + (adjData.peakReturn * 100).toFixed(2) + '%)',
              color: '#b0b0b0',
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.raw === null) return '';
                  return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + '%';
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#909090', maxTicksLimit: 15 },
              grid: { color: '#2a2a4a' },
            },
            y: {
              title: { display: true, text: 'Adjusted Return (%)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + '%'; }
              },
              grid: { color: '#2a2a4a' },
            },
          },
        },
        plugins: [{
          id: 'zeroLineChronosAdj',
          afterDraw(chart) {
            const yScale = chart.scales.y;
            const ctx = chart.ctx;
            const y = yScale.getPixelForValue(0);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.chartArea.left, y);
              ctx.lineTo(chart.chartArea.right, y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }]
      });
    })();
    ` : ''}
    ` : ''}

    ${fundamentalsData && fundamentalsData.quarters.length > 0 ? `
    // === Fundamentals Charts ===
    (() => {
      const fundQuarters = ${JSON.stringify(fundamentalsData?.quarters || [])};
      const labels = fundQuarters.map(q => q.date);

      ${fundamentalsData && fundamentalsData.quarters.some(q => q.revenue > 0) ? `
      // Revenue + Growth chart
      const revenueCanvas = document.getElementById('revenueChart');
      if (revenueCanvas) {
        const revenues = fundQuarters.map(q => q.revenue);
        const growths = fundQuarters.map(q => q.revenueGrowthYoY != null ? q.revenueGrowthYoY : null);
        const grossMargins = fundQuarters.map(q => q.grossMargin != null ? q.grossMargin : null);

        new Chart(revenueCanvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Revenue',
                data: revenues,
                backgroundColor: revenues.map((r, i) => {
                  if (i >= 4 && revenues[i - 4] > 0) {
                    return r >= revenues[i - 4] ? 'rgba(56,161,105,0.7)' : 'rgba(229,62,62,0.7)';
                  }
                  return 'rgba(74,111,165,0.7)';
                }),
                borderColor: 'rgba(74,111,165,1)',
                borderWidth: 1,
                yAxisID: 'y',
                order: 2,
              },
              {
                label: 'YoY Revenue Growth %',
                data: growths,
                type: 'line',
                borderColor: '#d69e2e',
                backgroundColor: 'rgba(214,158,46,0.1)',
                pointRadius: 4,
                pointBackgroundColor: growths.map(g => g != null ? (g >= 0 ? '#38a169' : '#e53e3e') : 'transparent'),
                tension: 0.3,
                yAxisID: 'y1',
                order: 1,
              },
              {
                label: 'Gross Margin %',
                data: grossMargins,
                type: 'line',
                borderColor: '#805ad5',
                borderDash: [5, 3],
                pointRadius: 3,
                tension: 0.3,
                yAxisID: 'y1',
                order: 0,
              },
            ],
          },
          options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              title: { display: true, text: 'Quarterly Revenue & Growth', color: '#a8b5a2', font: { size: 16 } },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    if (ctx.dataset.yAxisID === 'y') {
                      const val = ctx.raw;
                      if (val >= 1e9) return 'Revenue: $' + (val/1e9).toFixed(2) + 'B';
                      if (val >= 1e6) return 'Revenue: $' + (val/1e6).toFixed(1) + 'M';
                      return 'Revenue: $' + val.toLocaleString();
                    }
                    return ctx.dataset.label + ': ' + (ctx.raw != null ? ctx.raw.toFixed(1) + '%' : 'N/A');
                  }
                }
              }
            },
            scales: {
              y: {
                type: 'linear',
                position: 'left',
                title: { display: true, text: 'Revenue ($)', color: '#888' },
                ticks: {
                  color: '#888',
                  callback: function(v) {
                    if (v >= 1e9) return '$' + (v/1e9).toFixed(1) + 'B';
                    if (v >= 1e6) return '$' + (v/1e6).toFixed(0) + 'M';
                    return '$' + v.toLocaleString();
                  }
                },
                grid: { color: 'rgba(255,255,255,0.05)' },
              },
              y1: {
                type: 'linear',
                position: 'right',
                title: { display: true, text: '%', color: '#888' },
                ticks: { color: '#888', callback: v => v.toFixed(0) + '%' },
                grid: { drawOnChartArea: false },
              },
              x: {
                ticks: { color: '#888', maxRotation: 45 },
                grid: { color: 'rgba(255,255,255,0.05)' },
              }
            }
          }
        });
      }
      ` : ''}

      ${fundamentalsData && fundamentalsData.quarters.some(q => q.eps !== 0) ? `
      // EPS chart
      const epsCanvas = document.getElementById('epsChart');
      if (epsCanvas) {
        const epsValues = fundQuarters.map(q => q.eps);
        const epsEstimates = fundQuarters.map(q => q.epsEstimate || null);
        const hasEstimates = epsEstimates.some(e => e != null);

        const datasets = [{
          label: 'EPS (Actual)',
          data: epsValues,
          backgroundColor: epsValues.map(e => e >= 0 ? 'rgba(56,161,105,0.7)' : 'rgba(229,62,62,0.7)'),
          borderColor: epsValues.map(e => e >= 0 ? '#38a169' : '#e53e3e'),
          borderWidth: 1,
        }];

        if (hasEstimates) {
          datasets.push({
            label: 'EPS (Estimate)',
            data: epsEstimates,
            type: 'line',
            borderColor: '#888',
            borderDash: [5, 5],
            pointRadius: 4,
            pointBackgroundColor: '#888',
            tension: 0.3,
          });
        }

        new Chart(epsCanvas, {
          type: 'bar',
          data: { labels, datasets },
          options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              title: { display: true, text: 'Quarterly EPS', color: '#a8b5a2', font: { size: 16 } },
            },
            scales: {
              y: {
                title: { display: true, text: 'EPS ($)', color: '#888' },
                ticks: { color: '#888', callback: v => '$' + v.toFixed(2) },
                grid: { color: 'rgba(255,255,255,0.05)' },
              },
              x: {
                ticks: { color: '#888', maxRotation: 45 },
                grid: { color: 'rgba(255,255,255,0.05)' },
              }
            }
          }
        });
      }
      ` : ''}
    })();
    ` : ''}

  </script>
</body>
</html>`;
  }
}

module.exports = StockAnalysisService;
