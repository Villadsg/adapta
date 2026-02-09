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
   * Save all ticker news to database without date range filtering
   * This builds up the corpus regardless of event dates
   * @param {string} ticker - Stock ticker symbol
   * @param {Array} newsItems - News items from Yahoo Finance
   * @returns {Promise<Object>} Statistics {new, duplicate, failed}
   */
  async saveAllTickerNews(ticker, newsItems) {
    const articleExtractor = require('./articleExtractor');
    const stats = {
      new: 0,
      duplicate: 0,
      failed: 0
    };

    for (const news of newsItems) {
      try {
        // Check if article already exists in DB (by URL)
        const existing = await this.checkArticleExists(news.link);
        if (existing) {
          stats.duplicate++;
          continue;
        }

        // Fetch and extract article content
        let article;
        try {
          article = await articleExtractor.extractFromURL(news.link, { timeout: 15000 });
        } catch (extractError) {
          stats.failed++;
          continue;
        }

        // Skip if no meaningful content extracted
        if (!article.text || article.text.length < 100) {
          stats.failed++;
          continue;
        }

        // Use Yahoo's publish time if we couldn't extract one
        const publishedDate = article.publishedDate || (news.publishTime ? news.publishTime.toISOString() : null);

        // Ensure ticker is included
        if (!article.tickers.includes(ticker)) {
          article.tickers.push(ticker);
        }

        // Save to database (generates embedding automatically)
        await this.database.saveArticle(
          article.url,
          article.title,
          article.text,
          'stock_news',
          {
            publishedDate: publishedDate,
            tickers: article.tickers,
            generateEmbedding: true
          }
        );

        stats.new++;

        // Rate limiting: 1.5 seconds between requests to avoid blocking
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (error) {
        stats.failed++;
        // Continue with next article
      }
    }

    return stats;
  }

  /**
   * Fetch and store news articles for stock events from Yahoo Finance
   * @param {Array} events - Array of detected events
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Options
   * @returns {Promise<Array>} Events with fetched articles
   */
  async fetchEventNews(events, ticker, options = {}) {
    const { dayRange = 1, maxArticlesPerEvent = 10 } = options;

    const YahooNewsService = require('./yahooNewsService');
    const yahooNews = new YahooNewsService();

    console.log(`\nFetching Yahoo Finance news for ${ticker}...`);

    // Fetch all news for ticker
    const allNews = await yahooNews.fetchTickerNews(ticker, 100);

    if (allNews.length === 0) {
      console.log('  No news found from Yahoo Finance');
      return events;
    }

    console.log(`  Found ${allNews.length} news items`);

    // PHASE 1: Save ALL news to database to build corpus
    const saveStats = await this.saveAllTickerNews(ticker, allNews);
    console.log(`  Corpus: Saved ${saveStats.new} new, ${saveStats.duplicate} duplicate, ${saveStats.failed} failed`);

    // PHASE 2: Match saved articles to events by date range
    // Determine the date range of available news
    const newsDates = allNews.filter(n => n.publishTime).map(n => n.publishTime.getTime());
    const oldestNewsDate = newsDates.length > 0 ? new Date(Math.min(...newsDates)) : null;
    const newestNewsDate = newsDates.length > 0 ? new Date(Math.max(...newsDates)) : null;

    // Process each event
    let eventsWithNews = 0;
    let eventsOutOfRange = 0;

    for (const event of events) {
      const eventTime = new Date(event.date).getTime();
      const msPerDay = 24 * 60 * 60 * 1000;

      // Check if event is within news date range (with dayRange buffer)
      if (oldestNewsDate && newestNewsDate) {
        const inRange = eventTime >= (oldestNewsDate.getTime() - dayRange * msPerDay) &&
                       eventTime <= (newestNewsDate.getTime() + dayRange * msPerDay);
        if (!inRange) {
          eventsOutOfRange++;
          event.fetchedArticles = [];
          continue;
        }
      }

      // Filter news by date range for this event
      const relevantNews = yahooNews.filterNewsByDateRange(allNews, event.date, dayRange);

      if (relevantNews.length > 0) {
        console.log(`  Event ${event.dateStr}: ${relevantNews.length} news items in \u00b1${dayRange} day range`);
        eventsWithNews++;

        // Fetch the actual saved articles from DB that match these URLs
        // Articles were already saved in PHASE 1 with embeddings
        const eventArticles = [];
        for (const news of relevantNews) {
          const savedArticle = await this.checkArticleExists(news.link);
          if (savedArticle) {
            // Get full article with embeddings
            const fullArticle = await this.getArticleById(savedArticle.id);
            if (fullArticle) {
              eventArticles.push(fullArticle);
            }
          }
        }
        event.fetchedArticles = eventArticles;
      } else {
        event.fetchedArticles = [];
      }
    }

    // Summary
    if (eventsOutOfRange > 0) {
      console.log(`  Note: ${eventsOutOfRange} events are outside the available news date range`);
      console.log(`        Yahoo Finance only provides recent news (typically last 1-2 weeks)`);
    }
    if (eventsWithNews === 0 && events.length > 0) {
      console.log(`  No news found matching any event dates`);
    }

    return events;
  }

  /**
   * Process news items: fetch content, generate embeddings, store in DB
   * @param {Array} newsItems - News items from Yahoo Finance
   * @param {string} ticker - Stock ticker
   * @param {Date} eventDate - Associated event date
   * @returns {Promise<Array>} Processed and stored articles
   */
  async processEventNews(newsItems, ticker, eventDate) {
    const articleExtractor = require('./articleExtractor');
    const processedArticles = [];

    for (const news of newsItems) {
      try {
        // Check if article already exists in DB (by URL)
        const existing = await this.checkArticleExists(news.link);
        if (existing) {
          const existingDateStr = news.publishTime
            ? news.publishTime.toISOString().split('T')[0]
            : 'no date';
          console.log(`    Skipping [${existingDateStr}]: ${news.title.substring(0, 40)}... (exists)`);
          processedArticles.push(existing);
          continue;
        }

        // Fetch and extract article content
        const dateStr = news.publishTime
          ? news.publishTime.toISOString().split('T')[0]
          : 'no date';
        console.log(`    Fetching [${dateStr}]: ${news.title.substring(0, 50)}...`);

        let article;
        try {
          article = await articleExtractor.extractFromURL(news.link, { timeout: 15000 });
        } catch (extractError) {
          console.log(`    Failed to extract content: ${extractError.message}`);
          continue;
        }

        // Skip if no meaningful content extracted
        if (!article.text || article.text.length < 100) {
          console.log(`    Skipping: insufficient content`);
          continue;
        }

        // Use Yahoo's publish time if we couldn't extract one
        const publishedDate = article.publishedDate || (news.publishTime ? news.publishTime.toISOString() : null);

        // Ensure ticker is included
        if (!article.tickers.includes(ticker)) {
          article.tickers.push(ticker);
        }

        // Save to database (generates embedding automatically)
        const saved = await this.database.saveArticle(
          article.url,
          article.title,
          article.text,
          'stock_news',
          {
            publishedDate: publishedDate,
            tickers: article.tickers,
            generateEmbedding: true
          }
        );

        // Add metadata for display
        saved.publisher = news.publisher;
        saved.isNew = true;

        processedArticles.push(saved);

        // Rate limiting: 1.5 seconds between requests to avoid blocking
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (error) {
        console.error(`    Error processing ${news.link}: ${error.message}`);
        // Continue with next article
      }
    }

    console.log(`    Processed ${processedArticles.length} articles for this event`);
    return processedArticles;
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
  generateAnalysisHTML(data, events, ticker) {
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
  </style>
</head>
<body>
  <h1>${ticker} Stock Event Analysis</h1>
  <p class="subtitle">Events detected using volume \u00d7 price gap analysis with market movement filtering</p>

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
  </script>
</body>
</html>`;
  }
}

module.exports = StockAnalysisService;
