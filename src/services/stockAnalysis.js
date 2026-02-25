/**
 * StockAnalysisService - Analyzes stock events using volume and price movements
 *
 * Identifies significant stock events by analyzing trading volume and price gaps,
 * filters out market movements using regression, and correlates events with news articles.
 */

const { linearRegression } = require('simple-statistics');
const embeddingService = require('./embeddings');
const ChronosForecastService = require('./chronosForecast');

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

    return result;
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

    // Sort to find threshold
    const products = result
      .map((bar) => bar.volumeGapProduct ?? 0)
      .filter((p) => !isNaN(p))
      .sort((a, b) => b - a);

    const threshold =
      products.length <= effectiveTargetDates
        ? 0
        : products[effectiveTargetDates - 1];

    // Mark event dates
    for (const bar of result) {
      bar.isEarningsDate = (bar.volumeGapProduct ?? 0) >= threshold;
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

      let classification;

      if (gapNegative) {
        classification = intradayPositive
          ? 'negative_anticipated'
          : 'surprising_negative';
      } else {
        classification = intradayPositive
          ? 'surprising_positive'
          : 'positive_anticipated';
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
    const stockFiltered = this.filterMarketMovements(stockData, marketData);

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
      },
    };
  }

  /**
   * Generate price forecast using Chronos-2 based on analysis results
   * @param {object} analysisResult - Result from analyzeStock()
   * @param {object} options - Forecast options
   * @returns {Promise<object>} Forecast with event context
   */
  async forecastFromAnalysis(analysisResult, options = {}) {
    const {
      days = 14,
      modelSize = 'small',
      pythonPath = 'python3',
    } = options;

    const forecaster = new ChronosForecastService({
      modelSize,
      pythonPath,
      defaultDays: days,
    });

    return forecaster.forecastFromAnalysis(analysisResult, days);
  }

  /**
   * Analyze stock and generate forecast in one call
   * @param {string} ticker - Stock ticker
   * @param {object} options - Analysis and forecast options
   * @returns {Promise<object>} Analysis with forecast
   */
  async analyzeStockWithForecast(ticker, options = {}) {
    const {
      benchmark = 'SPY',
      days = 200,
      minEvents = 15,
      dataSource = 'auto',
      forecastDays = 14,
      modelSize = 'small',
      pythonPath = 'python3',
    } = options;

    // Run standard analysis
    const analysis = await this.analyzeStock(ticker, {
      benchmark,
      days,
      minEvents,
      dataSource,
    });

    // Generate forecast
    console.log('\n=== GENERATING FORECAST ===');
    console.log(`Forecasting ${forecastDays} days with Chronos-2 (${modelSize})...`);

    try {
      const forecast = await this.forecastFromAnalysis(analysis, {
        days: forecastDays,
        modelSize,
        pythonPath,
      });

      return {
        ...analysis,
        forecast,
      };
    } catch (error) {
      console.error(`Forecast failed: ${error.message}`);
      return {
        ...analysis,
        forecast: null,
        forecastError: error.message,
      };
    }
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
   * Generate HTML analysis report
   * @param {Array} data - Full analyzed data
   * @param {Array} events - Events with related articles
   * @param {string} ticker - Stock ticker
   * @returns {string} HTML content
   */
  generateAnalysisHTML(data, events, ticker, optionsData = null) {
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
              <span class="component-score">${score}/${maxScore}</span>
              ${detailHTML ? '<span class="component-toggle">&#9654;</span>' : ''}
            </div>
          </div>
          <div class="component-bar">
            <div class="component-bar-fill" style="width:${maxScore > 0 ? (score / maxScore * 100) : 0}%;background:${barColor(score, maxScore)}"></div>
          </div>
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
        + (hasTermChart ? '<div class="detail-chart"><canvas id="termStructureChart"></canvas></div>' : '');

      const vcPerExp = c.volumeConviction.perExpiration || [];
      const hasConvictionChart = vcPerExp.length >= 2;
      const volumeDetail = hasConvictionChart
        ? '<div class="detail-chart"><canvas id="dollarConvictionChart"></canvas></div>'
        + '<div id="strikeDrilldownWrap" style="display:none; margin-top:12px;"><div class="detail-chart"><canvas id="strikeDrilldownChart"></canvas></div></div>'
        : (vcPerExp.length === 1
          ? '<div class="detail-interp">Call IV: ' + (vcPerExp[0].atmCallIV * 100).toFixed(1) + '% &middot; Put IV: ' + (vcPerExp[0].atmPutIV * 100).toFixed(1) + '%'
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

      const hvc = c.historicalVolConviction;
      const hvcHistory = hvc.history || [];
      const fmtDollar = (v) => v >= 1_000_000 ? '$' + (v / 1_000_000).toFixed(1) + 'M' : v >= 1_000 ? '$' + (v / 1_000).toFixed(0) + 'K' : '$' + v.toFixed(0);
      const hasVolConvChart = hvcHistory.length >= 2;

      const volConvDetail = '<table class="detail-table">'
        + '<tr><td>Today Call $</td><td>' + fmtDollar(hvc.totalCallDollar) + '</td></tr>'
        + '<tr><td>Today Put $</td><td>' + fmtDollar(hvc.totalPutDollar) + '</td></tr>'
        + '<tr><td>Call/Put Ratio</td><td>' + (hvc.ratio > 0 ? hvc.ratio.toFixed(2) + 'x' : 'N/A') + '</td></tr>'
        + '</table>'
        + (hvcHistory.length > 0
          ? '<table class="detail-table"><thead><tr><th>Date</th><th>Call $</th><th>Put $</th></tr></thead><tbody>'
            + hvcHistory.slice(-8).map(d =>
              '<tr><td>' + new Date(d.date).toLocaleDateString('en-US', {month:'short',day:'numeric'}) + '</td>'
              + '<td>' + fmtDollar(d.totalCallDollar) + '</td>'
              + '<td>' + fmtDollar(d.totalPutDollar) + '</td></tr>'
            ).join('') + '</tbody></table>'
          : '')
        + (hasVolConvChart ? '<div class="detail-chart"><canvas id="volConvictionChart"></canvas></div>' : '');

      const hasRatioChart = vcAllPerExp.length >= 1;
      const ratioCardHTML = hasRatioChart ? `
        <div class="ratio-chart-card">
          <h3>Call/Put Dollar Volume Ratio by Expiration</h3>
          <p class="ratio-subtitle">ITM + OTM &mdash; Click a bar to view historical ratio trend</p>
          <div class="ratio-main-chart"><canvas id="cpRatioChart"></canvas></div>
          <div id="cpRatioNoHistory" style="display:none; margin-top:12px; color:#718096; font-size:12px; text-align:center;">
            No historical data available for this expiration
          </div>
          <div id="cpRatioHistoryWrap" style="display:none; margin-top:12px;">
            <div class="ratio-main-chart"><canvas id="cpRatioHistoryChart"></canvas></div>
          </div>
        </div>` : '';

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
          ${componentHTML('Term Structure', c.termStructure.score, c.termStructure.maxScore,
            `${c.termStructure.shape} — ${c.termStructure.signal}`, termDetail, hasTermChart ? 'has-chart' : '')}
          ${componentHTML('Vol Conviction (5%+ OTM)', c.volumeConviction.score, c.volumeConviction.maxScore,
            `${c.volumeConviction.signal}${vcPerExp.length > 0 ? ' — Max VOI: ' + Math.max(...vcPerExp.map(e => Math.max(e.callVOI, e.putVOI))).toFixed(2) : ''}`, volumeDetail, hasConvictionChart ? 'has-chart' : '')}
          ${componentHTML('Vol Conviction (ITM+OTM)', c.volumeConvictionAll ? c.volumeConvictionAll.score : 0, c.volumeConvictionAll ? c.volumeConvictionAll.maxScore : 15,
            `${c.volumeConvictionAll ? c.volumeConvictionAll.signal : 'N/A'}`, volumeDetailAll, hasConvictionChartAll ? 'has-chart' : '')}
          ${componentHTML('Dollar Flow', hvc.score, hvc.maxScore,
            `${hvc.signal}${hvc.ratio > 0 ? ' — ' + hvc.ratio.toFixed(2) + 'x Call/Put' : ''}`, volConvDetail, hasVolConvChart ? 'has-chart' : '')}
        </div>
        ${calloutsHTML}
        ${ratioCardHTML}
      </div>`;
    })() : '';

    // Generate events HTML with articles
    const eventsHTML = events
      .map((event) => {
        const articlesHTML = event.articles && event.articles.length > 0
          ? event.articles
              .map((article) => {
                const uniquenessPercent = Math.round((article.uniqueness || 0.5) * 100);
                const uniquenessClass =
                  uniquenessPercent > 70 ? 'high' : uniquenessPercent > 40 ? 'medium' : 'low';

                // Publisher badge
                const publisherBadge = article.publisher
                  ? `<span class="publisher-badge">${article.publisher}</span>`
                  : '';

                // New article indicator
                const newBadge = article.isNew
                  ? '<span class="new-badge">NEW</span>'
                  : '';

                // Similarity info
                const similarityHTML = article.similarities && article.similarities.length > 0
                  ? `<div class="similarity-info">
                       <span class="sim-label">Similar to:</span>
                       ${article.similarities.slice(0, 3).map(s =>
                         `<span class="sim-item" title="${(s.title || '').replace(/"/g, '&quot;')}">${Math.round(s.similarity * 100)}%</span>`
                       ).join('')}
                     </div>`
                  : '';

                return `
                  <div class="article-item ${article.isNew ? 'new-article' : ''}">
                    <div class="article-meta">
                      <span class="article-date">${article.published_date ? new Date(article.published_date).toLocaleDateString() : 'Unknown date'}</span>
                      ${publisherBadge}
                      ${newBadge}
                      <span class="uniqueness-badge ${uniquenessClass}">Uniqueness: ${uniquenessPercent}%</span>
                    </div>
                    <a href="${article.url}" class="article-title" target="_blank">${article.title || 'Untitled'}</a>
                    ${similarityHTML}
                  </div>
                `;
              })
              .join('')
          : '<p class="no-articles">No related articles found</p>';

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
            <div class="related-articles">
              <h4>Related Articles (\u00b13 days)</h4>
              ${articlesHTML}
            </div>
          </div>
        `;
      })
      .join('');

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
    .related-articles {
      border-top: 1px solid #333;
      padding-top: 15px;
      margin-top: 10px;
    }
    .related-articles h4 {
      color: #a8b5a2;
      margin: 0 0 10px 0;
      font-size: 14px;
    }
    .article-item {
      background: #0f3460;
      padding: 12px;
      border-radius: 5px;
      margin-bottom: 8px;
    }
    .article-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 5px;
    }
    .article-date {
      color: #888;
      font-size: 12px;
    }
    .uniqueness-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: bold;
    }
    .uniqueness-badge.high {
      background: #2ecc71;
      color: #000;
    }
    .uniqueness-badge.medium {
      background: #f39c12;
      color: #000;
    }
    .uniqueness-badge.low {
      background: #95a5a6;
      color: #000;
    }
    .article-title {
      color: #74b9ff;
      text-decoration: none;
      font-size: 14px;
      display: block;
    }
    .article-title:hover {
      text-decoration: underline;
    }
    .no-articles {
      color: #666;
      font-style: italic;
      font-size: 14px;
    }
    .publisher-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #2d3748;
      color: #a0aec0;
      margin-left: 8px;
    }
    .new-badge {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #48bb78;
      color: #000;
      font-weight: bold;
      margin-left: 8px;
    }
    .new-article {
      border-left: 3px solid #48bb78;
    }
    .similarity-info {
      margin-top: 8px;
      font-size: 11px;
      color: #888;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
    }
    .sim-label {
      margin-right: 4px;
    }
    .sim-item {
      display: inline-block;
      padding: 2px 6px;
      background: #1a365d;
      border-radius: 4px;
      color: #63b3ed;
      cursor: help;
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
    .component-row.has-chart.expanded .component-detail { max-height: 1800px; }
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
    .ratio-chart-card {
      margin-top: 20px;
      background: #0f3460;
      border-radius: 8px;
      padding: 16px;
    }
    .ratio-chart-card h3 {
      color: #a8b5a2;
      margin: 0 0 4px 0;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ratio-subtitle {
      color: #718096;
      font-size: 11px;
      margin: 0 0 12px 0;
    }
    .ratio-main-chart {
      height: 280px;
    }
    .ratio-main-chart canvas {
      height: 280px !important;
    }
  </style>
</head>
<body>
  <h1>${ticker} Stock Event Analysis</h1>
  <p class="subtitle">Events detected using volume \u00d7 price gap analysis with market movement filtering</p>

  ${anticipationPanelHTML}

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

  <div class="events-section">
    <h2>Detected Events with Related Articles</h2>
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
            if (canvas.id === 'volConvictionChart' && typeof initVolConvictionChart === 'function') initVolConvictionChart();
            if (canvas.id === 'dollarConvictionChart' && typeof initDollarConvictionChart === 'function') initDollarConvictionChart();
            if (canvas.id === 'dollarConvictionChartAll' && typeof initDollarConvictionChartAll === 'function') initDollarConvictionChartAll();
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

      new Chart(document.getElementById('termStructureChart'), {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'IV Term Structure (Call / Put)', color: '#b0b0b0' }
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

    // Dollar Conviction Ratio Chart — Call$/Put$ ratio by expiration
    ${(() => {
      const vcPerExp = ea?.components?.volumeConviction?.perExpiration || [];
      if (vcPerExp.length < 2) return '';
      return `function initDollarConvictionChart() {
      const crData = ${JSON.stringify(vcPerExp)};
      const labels = crData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      let drilldownChart = null;
      const convChart = new Chart(document.getElementById('dollarConvictionChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Call $ Volume',
              data: crData.map(d => d.totalCallDollarVolume || 0),
              backgroundColor: 'rgba(72, 187, 120, 0.35)',
              borderColor: 'rgba(72, 187, 120, 0.6)',
              borderWidth: 1
            },
            {
              label: 'Put $ Volume',
              data: crData.map(d => d.totalPutDollarVolume || 0),
              backgroundColor: 'rgba(245, 101, 101, 0.35)',
              borderColor: 'rgba(245, 101, 101, 0.6)',
              borderWidth: 1
            }
          ]
        },
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
            title: { display: true, text: 'Dollar Volume by Expiration — 5%+ OTM (click bar to drill down)', color: '#b0b0b0' },
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
    }`;
    })()}

    // Dollar Conviction Ratio Chart — ITM+OTM (all contracts)
    ${(() => {
      const vcAllPerExp = ea?.components?.volumeConvictionAll?.perExpiration || [];
      if (vcAllPerExp.length < 2) return '';
      return `function initDollarConvictionChartAll() {
      const crData = ${JSON.stringify(vcAllPerExp)};
      const labels = crData.map(d => {
        const dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      let drilldownChartAll = null;
      const convChartAll = new Chart(document.getElementById('dollarConvictionChartAll'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Call $ Volume',
              data: crData.map(d => d.totalCallDollarVolume || 0),
              backgroundColor: 'rgba(72, 187, 120, 0.35)',
              borderColor: 'rgba(72, 187, 120, 0.6)',
              borderWidth: 1
            },
            {
              label: 'Put $ Volume',
              data: crData.map(d => d.totalPutDollarVolume || 0),
              backgroundColor: 'rgba(245, 101, 101, 0.35)',
              borderColor: 'rgba(245, 101, 101, 0.6)',
              borderWidth: 1
            }
          ]
        },
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
    }`;
    })()}

    // Dollar Flow Chart (Call$ vs Put$ over time) — lazy init from card expand
    ${(() => {
      const hvcData = ea?.components?.historicalVolConviction?.history || [];
      if (hvcData.length < 2) return '';
      return `
    function initVolConvictionChart() {
      const histData = ${JSON.stringify(hvcData)};

      const labels = histData.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      new Chart(document.getElementById('volConvictionChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Call $ Volume',
              data: histData.map(d => d.totalCallDollar),
              backgroundColor: 'rgba(72, 187, 120, 0.7)',
              borderColor: 'rgba(72, 187, 120, 1)',
              borderWidth: 1
            },
            {
              label: 'Put $ Volume',
              data: histData.map(d => d.totalPutDollar),
              backgroundColor: 'rgba(245, 101, 101, 0.7)',
              borderColor: 'rgba(245, 101, 101, 1)',
              borderWidth: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'OTM Dollar Volume Trend (2 Nearest Exp.)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  const v = ctx.raw;
                  return ctx.dataset.label + ': $' + (v >= 1e6 ? (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? (v/1e3).toFixed(0) + 'K' : v.toFixed(0));
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
              title: { display: true, text: 'Dollar Volume ($)', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(0) + 'K' : '$' + v; }
              },
              grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    }

    `;
    })()}

    // Call/Put Dollar Ratio by Expiration (ITM+OTM) — auto-init
    ${(() => {
      const vcRatioPerExp = ea?.components?.volumeConvictionAll?.perExpiration || [];
      if (vcRatioPerExp.length < 1) return '';

      // Slim down data for embedding (drop contracts array)
      const ratioPerExp = vcRatioPerExp.map(e => ({
        expirationDate: e.expirationDate,
        convictionRatio: e.convictionRatio || 0,
        totalCallDollarVolume: e.totalCallDollarVolume || 0,
        totalPutDollarVolume: e.totalPutDollarVolume || 0
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
          ratioHistByExp[expKey].push({
            date: new Date(snap.snapshot_date).toISOString().split('T')[0],
            ratio: pd > 0 ? cd / pd : 0
          });
        }
        for (const k of Object.keys(ratioHistByExp)) {
          ratioHistByExp[k].sort((a, b) => a.date.localeCompare(b.date));
        }
      }

      return `
    (function() {
      const cpRatioCanvas = document.getElementById('cpRatioChart');
      if (!cpRatioCanvas) return;

      const crData = ${JSON.stringify(ratioPerExp)};
      const histByExp = ${JSON.stringify(ratioHistByExp)};

      const labels = crData.map(function(d) {
        var dt = new Date(d.expirationDate);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      const ratios = crData.map(function(d) { return d.convictionRatio; });
      const barColors = ratios.map(function(r) { return r >= 1 ? 'rgba(72, 187, 120, 0.7)' : 'rgba(245, 101, 101, 0.7)'; });
      const borderColors = ratios.map(function(r) { return r >= 1 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; });

      var histChart = null;

      new Chart(cpRatioCanvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Call/Put $ Ratio',
              data: ratios,
              backgroundColor: barColors,
              borderColor: borderColors,
              borderWidth: 1,
              order: 1
            },
            {
              label: 'Neutral (1.0)',
              data: labels.map(function() { return 1.0; }),
              type: 'line',
              borderColor: 'rgba(160, 174, 192, 0.5)',
              borderWidth: 1,
              borderDash: [4, 4],
              pointRadius: 0,
              fill: false,
              order: 0
            }
          ]
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
            var histRatios = hist.map(function(d) { return d.ratio; });

            if (histChart) histChart.destroy();
            histChart = new Chart(document.getElementById('cpRatioHistoryChart'), {
              type: 'line',
              data: {
                labels: histLabels,
                datasets: [
                  {
                    label: 'Call/Put $ Ratio',
                    data: histRatios,
                    borderColor: 'rgba(99, 179, 237, 0.9)',
                    backgroundColor: 'rgba(99, 179, 237, 0.08)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: histRatios.map(function(r) { return r >= 1 ? 'rgba(72, 187, 120, 1)' : 'rgba(245, 101, 101, 1)'; }),
                    fill: true,
                    tension: 0.2
                  },
                  {
                    label: 'Neutral (1.0)',
                    data: histLabels.map(function() { return 1.0; }),
                    borderColor: 'rgba(160, 174, 192, 0.4)',
                    borderWidth: 1,
                    borderDash: [4, 4],
                    pointRadius: 0,
                    fill: false
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#b0b0b0' } },
                  title: { display: true, text: 'Historical Call/Put $ Ratio — Exp ' + labels[idx], color: '#b0b0b0' },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        if (ctx.datasetIndex === 1) return 'Neutral: 1.0x';
                        return 'Ratio: ' + ctx.raw.toFixed(2) + 'x';
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
                    title: { display: true, text: 'Call/Put $ Ratio', color: '#909090' },
                    ticks: {
                      color: '#909090',
                      callback: function(v) { return v.toFixed(1) + 'x'; }
                    },
                    grid: { color: '#2a2a4a' }
                  }
                }
              }
            });
          },
          plugins: {
            legend: { labels: { color: '#b0b0b0' } },
            title: { display: true, text: 'Call/Put Dollar Volume Ratio by Expiration (click bar for history)', color: '#b0b0b0' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  if (ctx.datasetIndex === 1) return 'Neutral: 1.0x';
                  return 'Ratio: ' + ctx.raw.toFixed(2) + 'x';
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
              title: { display: true, text: 'Call/Put $ Ratio', color: '#909090' },
              ticks: {
                color: '#909090',
                callback: function(v) { return v.toFixed(1) + 'x'; }
              },
              grid: { color: '#2a2a4a' }
            }
          }
        }
      });
    })();`;
    })()}
  </script>
</body>
</html>`;
  }
}

module.exports = StockAnalysisService;
