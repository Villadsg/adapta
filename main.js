const path = require('path');
const { spawn } = require('child_process');
// .env.local first (real keys, gitignored), then .env as fallback.
require('dotenv').config({ path: [path.join(__dirname, '.env.local'), path.join(__dirname, '.env')] });

// Patch global fetch to use a real browser User-Agent for Yahoo Finance domains.
// Yahoo now only serves fundamentals (sector/industry/market cap/financials);
// prices and options come from MarketData.app. yahoo-finance2's getCrumb.js
// hardcodes a bot-like User-Agent that Yahoo blocks with 429.
// See: https://github.com/gadicc/yahoo-finance2/issues/977
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const _origFetch = global.fetch;
global.fetch = function(url, opts = {}) {
  const urlStr = typeof url === 'string' ? url : url?.toString?.() || '';
  if (urlStr.includes('yahoo.com')) {
    opts = { ...opts };
    opts.headers = { ...opts.headers, 'User-Agent': BROWSER_UA };
  }
  return _origFetch.call(this, url, opts);
};

const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');

// Sites behind bot protection (idealista/DataDome, Yahoo, ...) flag the default
// Electron UA, which contains the app name and an "Electron/x.y" token. Identify
// as the bundled Chromium version instead; keep the real platform so the UA stays
// consistent with the sec-ch-ua / navigator.userAgentData client hints.
const UA_PLATFORM =
  process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' :
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X' :
  'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const ArticleDatabase = require('./src/services/database');
const PriceTrackingService = require('./src/services/priceTracking');
const RunArchiver = require('./src/services/runArchiver');
const StockAnalysisService = require('./src/services/stockAnalysis');
const OptionsAnalysisService = require('./src/services/optionsAnalysis');
const IBOptionsProvider = require('./src/services/ibOptionsProvider');
const articleExtractor = require('./src/services/articleExtractor');
const ChronosHoldPeriodService = require('./src/services/chronosHoldPeriod');
const TTMEventAnalysisService = require('./src/services/ttmEventAnalysis');
const TimesFMDirectionService = require('./src/services/timesfmDirection');
const TimesFMLabService = require('./src/services/timesfmLab');
const LabInsightsService = require('./src/services/labInsights');
const { OptionsBackfillService } = require('./src/services/optionsBackfill');
const { computeCoverage } = require('./ci/options-coverage');
const { loadState: loadBackfillState } = require('./ci/backfill-marketdata');
const { runImpliedThesis } = require('./src/services/impliedThesis');
const { screenTickers, reviseTickers, formatAge } = require('./ci/ticker-screen');
const { classifyTickerNews, tagTickerEvents } = require('./src/services/newsClassifier');
const YahooFinance = require('yahoo-finance2').default;

// Extracted main-process modules
const { fetchFinvizNews, extractArticleViaBrowser } = require('./src/main/articleFetch');
const { createWindow, createTab, switchTab, closeTab, getActiveBrowserView, updateBrowserViewBounds, getWindow } = require('./src/main/tabs');
const { combineHistRecord, peWelch, peStandardize, peLogisticFit, peSigmoidScore, peAUC, peCVAUC } = require('./src/main/screeningStats');
const { generateScreeningHTML } = require('./src/main/screeningHtml');

const mainWindow = () => getWindow();
let database;
let priceTracker;
let stockAnalyzer;
let optionsAnalyzer;
let chronosHoldService;
let runArchiver;
let ttmEventService;
let timesfmDirectionService;
let timesfmLabService;
let labInsightsService;
let optionsBackfillService;


// Performance optimization: debounce timers
const navigationDebounceTimers = new Map(); // tabId -> timer
let resizeTimer = null;


// IPC Handlers

// Tab management
ipcMain.handle('create-tab', async (event, url) => {
  const tabId = createTab(url);
  switchTab(tabId);
  return tabId;
});

ipcMain.handle('switch-tab', async (event, tabId) => {
  switchTab(tabId);
  return tabId;
});

ipcMain.handle('close-tab', async (event, tabId) => {
  closeTab(tabId);
  return true;
});

// Navigate to URL
ipcMain.handle('navigate-to-url', async (event, url) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;

  // Allow file:// URLs for settings and other internal pages
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    url = 'https://' + url;
  }
  browserView.webContents.loadURL(url);
  return url;
});

// Open settings page
ipcMain.handle('open-settings', async (event) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;

  const path = require('path');
  const settingsPath = path.join(__dirname, 'src', 'renderer', 'settings.html');
  const settingsUrl = `file://${settingsPath}`;
  browserView.webContents.loadURL(settingsUrl);
  return settingsUrl;
});

// Download page text
ipcMain.handle('download-text', async (event) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { error: 'No active tab' };

    // Extract clean article content using Readability.js
    const articleData = await articleExtractor.extractFromWebContents(browserView.webContents);
    const { url, title, text, publishedDate, tickers } = articleData;

    return {
      url: url,
      title: title,
      text: text,
      wordCount: text.split(/\s+/).length,
      publishedDate: publishedDate,
      tickers: tickers
    };
  } catch (error) {
    console.error('Error extracting text:', error);
    return { error: error.message };
  }
});

// Get current URL
ipcMain.handle('get-current-url', async (event) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;
  return browserView.webContents.getURL();
});

// Navigation controls
ipcMain.handle('go-back', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
});

ipcMain.handle('go-forward', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
});

ipcMain.handle('reload', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView) {
    browserView.webContents.reload();
  }
});

// Get all articles
ipcMain.handle('get-articles', async (event, categoryFilter) => {
  try {
    const articles = await database.getAllArticles(categoryFilter);
    return articles;
  } catch (error) {
    console.error('Error getting articles:', error);
    return { error: error.message };
  }
});

// Get stock statistics for settings page
ipcMain.handle('get-stock-stats', async (event) => {
  try {
    const stats = await database.getStockStats();
    return stats;
  } catch (error) {
    console.error('Error getting stock stats:', error);
    return { error: error.message };
  }
});

// Get recent news volume records
ipcMain.handle('get-recent-news-volume', async (event) => {
  try {
    const volumeData = await database.getRecentNewsVolume(20);
    return volumeData;
  } catch (error) {
    console.error('Error getting news volume:', error);
    return { error: error.message };
  }
});

// Execute raw SQL query
ipcMain.handle('execute-sql', async (event, query) => {
  try {
    const result = await database.executeRawSQL(query);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error executing SQL:', error);
    return {
      success: false,
      error: error.error || error.message,
      executionTime: error.executionTime || 0
    };
  }
});


// Clear all data
ipcMain.handle('clear-all-data', async (event) => {
  try {
    await database.clearAllData();
    return { success: true };
  } catch (error) {
    console.error('Error clearing all data:', error);
    return { success: false, error: error.message };
  }
});

// Clear news volume data
ipcMain.handle('clear-news-volume', async (event) => {
  try {
    await database.clearNewsVolume();
    return { success: true };
  } catch (error) {
    console.error('Error clearing news volume:', error);
    return { success: false, error: error.message };
  }
});

// Get setting from database
ipcMain.handle('get-setting', async (event, key, defaultValue) => {
  try {
    return await database.getSetting(key, defaultValue);
  } catch (error) {
    console.error('Error getting setting:', error);
    return defaultValue;
  }
});

// Set setting in database
ipcMain.handle('set-setting', async (event, key, value) => {
  try {
    await database.setSetting(key, value);
    return { success: true };
  } catch (error) {
    console.error('Error setting setting:', error);
    return { success: false, error: error.message };
  }
});

// Semantic search handler
ipcMain.handle('search-similarity', async (event, query, options) => {
  try {
    const results = await database.searchBySimilarity(query, options);
    return { success: true, results };
  } catch (error) {
    console.error('Error searching:', error);
    return { success: false, error: error.message };
  }
});

// Browser-based article extraction (handles JavaScript-rendered pages and consent dialogs)
ipcMain.handle('extract-article-via-browser', async (event, url, options = {}) => {
  try {
    const article = await extractArticleViaBrowser(url, options);
    return { success: true, article };
  } catch (error) {
    console.error('Error extracting article via browser:', error);
    return { success: false, error: error.message };
  }
});

// === Stock Price Tracking Handlers ===

// Fetch and save historical prices for a ticker
ipcMain.handle('fetch-historical-prices', async (event, ticker, options = {}) => {
  try {
    const result = await priceTracker.fetchAndSaveHistoricalPrices(ticker, options);
    return result;
  } catch (error) {
    console.error('Error fetching historical prices:', error);
    return { success: false, error: error.message };
  }
});

// Get price history from database
ipcMain.handle('get-price-history', async (event, ticker, options = {}) => {
  try {
    const prices = await database.getPriceHistory(ticker, options);
    return { success: true, prices };
  } catch (error) {
    console.error('Error getting price history:', error);
    return { success: false, error: error.message };
  }
});

// Get latest price for a ticker
ipcMain.handle('get-latest-price', async (event, ticker) => {
  try {
    const price = await database.getLatestPrice(ticker);
    return { success: true, price };
  } catch (error) {
    console.error('Error getting latest price:', error);
    return { success: false, error: error.message };
  }
});

// Get price statistics
ipcMain.handle('get-price-stats', async (event) => {
  try {
    const stats = await database.getPriceStats();
    return { success: true, stats };
  } catch (error) {
    console.error('Error getting price stats:', error);
    return { success: false, error: error.message };
  }
});

// Start/stop price polling
ipcMain.handle('toggle-price-polling', async (event, enabled, intervalMinutes = 15) => {
  try {
    if (enabled) {
      priceTracker.startPolling(intervalMinutes);
      await database.setSetting('price_auto_polling', 'true');
      await database.setSetting('price_polling_interval', intervalMinutes.toString());
    } else {
      priceTracker.stopPolling();
      await database.setSetting('price_auto_polling', 'false');
    }
    return { success: true, enabled, intervalMinutes };
  } catch (error) {
    console.error('Error toggling price polling:', error);
    return { success: false, error: error.message };
  }
});

// Get polling status
ipcMain.handle('get-polling-status', async (event) => {
  try {
    const status = priceTracker.getPollingStatus();
    return { success: true, ...status };
  } catch (error) {
    console.error('Error getting polling status:', error);
    return { success: false, error: error.message };
  }
});

// Update latest price for a ticker (manual refresh)
ipcMain.handle('update-latest-price', async (event, ticker) => {
  try {
    const result = await priceTracker.updateLatestPrice(ticker);
    return result;
  } catch (error) {
    console.error('Error updating latest price:', error);
    return { success: false, error: error.message };
  }
});

// Analyze stock events
ipcMain.handle('analyze-stock-events', async (event, ticker, options = {}) => {
  try {
    const {
      benchmark = 'SPY',
      days = 200,
      minEvents = 15,
      dataSource = 'auto',
      analyzeOptions = false,
      maxExpirations = 4,
      holdDays = 60,
      fetchFundamentals = true,
    } = options;

    console.log(`\nAnalyzing stock events for ${ticker}...`);
    console.log(`Options: benchmark=${benchmark}, days=${days}, minEvents=${minEvents}, dataSource=${dataSource}, fundamentals=${fetchFundamentals}`);

    // Run analysis pipeline
    const result = await stockAnalyzer.analyzeStock(ticker, {
      benchmark,
      days,
      minEvents,
      dataSource,
    });

    // Save prices to database for empirical hold computation
    console.log(`\nSaving ${result.data.length} price bars to database...`);
    for (const bar of result.data) {
      await database.saveStockPrice(
        ticker,
        bar.date.toISOString().split('T')[0],
        { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
        'analysis'
      );
    }

    // Save events to database (delete stale events within analysis window first)
    const startDate = result.data[0].date.toISOString().split('T')[0];
    const endDate = result.data[result.data.length - 1].date.toISOString().split('T')[0];
    const saveResult = await database.saveStockEvents(ticker, result.events, benchmark, startDate, endDate);

    // Find related articles from existing DB for each event (fast, immediate)
    console.log(`\nFinding related articles for ${result.events.length} events...`);
    for (const eventData of result.events) {
      // Get existing DB articles
      const existingArticles = await stockAnalyzer.findRelatedArticles(
        eventData.date,
        ticker,
        3
      );

      // Calculate similarities between articles
      eventData.articles = await stockAnalyzer.calculateArticleSimilarities(existingArticles);
      eventData.fetchedArticles = []; // Start with no fetched articles
    }

    // Options analysis (if enabled)
    let optionsData = null;
    if (analyzeOptions) {
      try {
        optionsData = await optionsAnalyzer.analyzeCurrentOptions(ticker, { maxExpirations });
        if (optionsData) {
          await optionsAnalyzer.saveSnapshot(optionsData);
          optionsData.history = await optionsAnalyzer.getSnapshotHistory(ticker, days);
          optionsData.historicalVolatility = stockAnalyzer.computeHistoricalVolatility(result.data);
          optionsData.rollingHV = stockAnalyzer.computeRollingHV(result.data, 20);
          optionsData.eventAnticipation = optionsAnalyzer.computeEventAnticipation(
            optionsData.summary, optionsData.expirations,
            optionsData.historicalVolatility, optionsData.history
          );
        }
      } catch (optErr) {
        console.error('Options analysis failed (non-fatal):', optErr.message);
      }
    }

    // Compute empirical hold duration from accumulated events
    let empiricalHoldData = null;
    try {
      empiricalHoldData = await stockAnalyzer.computeEmpiricalHold(database, holdDays);
    } catch (holdErr) {
      console.error('Empirical hold computation failed (non-fatal):', holdErr.message);
    }

    // Compute options-adjusted hold if options data available
    if (empiricalHoldData && optionsData) {
      try {
        const adjusted = await stockAnalyzer.computeOptionsAdjustedHold(database, holdDays, optionsData, ticker);
        if (adjusted) {
          empiricalHoldData.optionsAdjusted = adjusted;
        }
      } catch (adjErr) {
        console.error('Options-adjusted hold failed (non-fatal):', adjErr.message);
      }
    }

    // Compute snapshot-based optimal hold if options data available
    if (optionsData) {
      try {
        const snapshotHold = await stockAnalyzer.computeSnapshotOptimalHold(database, holdDays, optionsData);
        if (snapshotHold) {
          if (!empiricalHoldData) empiricalHoldData = {};
          empiricalHoldData.snapshotOptimalHold = snapshotHold;
        }
      } catch (snapErr) {
        console.error('Snapshot optimal hold failed (non-fatal):', snapErr.message);
      }
    }

    // Compute Chronos-2 forecasted hold period
    try {
      const chronosHold = await chronosHoldService.computeChronosHold(ticker, {
        maxForwardDays: holdDays,
        optionsData,
        priceData: result.data,
      });
      if (chronosHold) {
        if (!empiricalHoldData) empiricalHoldData = {};
        empiricalHoldData.chronosHold = chronosHold;
      }
    } catch (chronosErr) {
      console.error('Chronos hold computation failed (non-fatal):', chronosErr.message);
    }

    // Fetch current day quote and compute event signal (non-fatal)
    let currentQuote = null;
    try {
      currentQuote = await priceTracker.getQuoteSummary(ticker);

      // Compute today's event signal if we have the necessary fields
      if (currentQuote && currentQuote.open && currentQuote.previousClose && currentQuote.volume) {
        const gap = Math.abs(((currentQuote.open - currentQuote.previousClose) / currentQuote.previousClose) * 100);
        const todayProduct = currentQuote.volume * gap;

        // Get threshold and percentile from analysis data
        const allProducts = result.data
          .map(b => b.volumeGapProduct ?? 0)
          .filter(p => !isNaN(p) && p > 0)
          .sort((a, b) => a - b);
        const eventThreshold = result.events.length > 0
          ? Math.min(...result.events.map(e => e.volumeGapProduct ?? 0))
          : 0;
        const belowCount = allProducts.filter(p => p <= todayProduct).length;
        const percentile = allProducts.length > 0 ? (belowCount / allProducts.length) * 100 : 0;

        // Compute residual gap using regression + benchmark quote
        let residualGap = null;
        try {
          const reg = result.stats.regression;
          if (reg) {
            const benchQuote = await priceTracker.getQuoteSummary(benchmark);
            if (benchQuote && benchQuote.previousClose) {
              const stockReturn = (currentQuote.price - currentQuote.previousClose) / currentQuote.previousClose;
              const marketReturn = (benchQuote.price - benchQuote.previousClose) / benchQuote.previousClose;
              residualGap = Math.abs((stockReturn - (reg.slope * marketReturn + reg.intercept)) * 100);
            }
          }
        } catch (benchErr) {
          console.error('Benchmark quote fetch for residual failed (non-fatal):', benchErr.message);
        }

        // Classify what today would look like as an event
        let classification = null;
        if (currentQuote.previousClose && currentQuote.open) {
          const gapNegative = currentQuote.previousClose > currentQuote.open;
          const intradayPositive = currentQuote.price > currentQuote.open;
          const closedBelowPrevClose = currentQuote.price < currentQuote.previousClose;
          const closedAbovePrevClose = currentQuote.price > currentQuote.previousClose;

          if (gapNegative) {
            classification = closedAbovePrevClose ? 'surprising_positive'
              : intradayPositive ? 'negative_anticipated' : 'surprising_negative';
          } else {
            classification = closedBelowPrevClose ? 'surprising_negative'
              : intradayPositive ? 'surprising_positive' : 'positive_anticipated';
          }
        }

        // Compute average event volume for comparison
        const avgEventVolume = result.events.length > 0
          ? result.events.reduce((sum, e) => sum + e.volume, 0) / result.events.length
          : 0;

        currentQuote.eventSignal = {
          gap,
          todayProduct,
          threshold: eventThreshold,
          percentile,
          residualGap,
          isAboveThreshold: todayProduct >= eventThreshold && eventThreshold > 0,
          classification,
          avgEventVolume,
        };

        console.log(`Today's event signal: gap=${gap.toFixed(2)}%, product=${todayProduct.toFixed(0)}, threshold=${eventThreshold.toFixed(0)}, percentile=${percentile.toFixed(1)}%`);
      }
    } catch (quoteErr) {
      console.error('Current quote fetch failed (non-fatal):', quoteErr.message);
    }

    // Fetch quarterly fundamentals (non-fatal)
    let fundamentalsData = null;
    if (fetchFundamentals) {
      try {
        fundamentalsData = await stockAnalyzer.fetchFundamentals(ticker);
      } catch (fundErr) {
        console.error('Fundamentals fetch failed (non-fatal):', fundErr.message);
      }
    }

    // Fetch Finviz news if any event occurred in the last 3 days
    let finvizNews = null;
    try {
      const now = new Date();
      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const hasRecentEvent = result.events.some(e => new Date(e.date) >= threeDaysAgo);
      if (hasRecentEvent) {
        console.log('Recent event detected — fetching Finviz news headlines...');
        finvizNews = await fetchFinvizNews(ticker);
      }
    } catch (newsErr) {
      console.error('Finviz news fetch failed (non-fatal):', newsErr.message);
    }

    // Generate HTML report with events and existing articles (return immediately)
    const html = stockAnalyzer.generateAnalysisHTML(
      result.data,
      result.events,
      ticker,
      optionsData,
      empiricalHoldData,
      currentQuote,
      fundamentalsData,
      finvizNews
    );

    console.log(`\nAnalysis complete: ${result.events.length} events found`);

    return {
      success: true,
      html,
      eventCount: result.events.length,
      stats: result.stats
    };
  } catch (error) {
    console.error('Error analyzing stock events:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-analyzed-tickers', async () => {
  try {
    const tickers = await database.getAnalyzedTickers();
    return { success: true, tickers };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Forecast next-day event magnitude using the fine-tuned TTM-R3 model.
ipcMain.handle('forecast-event-magnitude', async (event, ticker, date = null) => {
  try {
    if (!ttmEventService) {
      return { success: false, error: 'TTM event service not initialized' };
    }
    const result = await ttmEventService.forecast(ticker, date);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error forecasting event magnitude:', error);
    return { success: false, error: error.message };
  }
});

// Model lab: feature-adjustable TimesFM backtests streamed to the UI.

// Channel/preset metadata for the lab UI, extracted from the Python source of
// truth once per app session and cached.
let labMetaCache = null;
ipcMain.handle('lab-meta', async () => {
  if (labMetaCache) return labMetaCache;
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(timesfmLabService.pythonExe,
        [timesfmLabService.scriptPath, '--dump-channels'],
        { cwd: __dirname, env: process.env });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    });
    labMetaCache = JSON.parse(stdout);
    return labMetaCache;
  } catch (error) {
    console.error('[Lab] meta extraction failed:', error.message);
    return { error: error.message };
  }
});

ipcMain.handle('lab-search', async (event) => {
  try {
    if (!timesfmLabService) {
      return { success: false, error: 'Lab service not initialized' };
    }
    if (timesfmLabService.isRunning()) {
      return { success: false, error: 'A search is already in progress' };
    }
    const sender = event.sender;
    const result = await timesfmLabService.search((line) => {
      if (!sender.isDestroyed()) sender.send('lab-log', { line });
    });
    return { success: true, ...result };
  } catch (error) {
    console.error('[Lab] search failed:', error.message);
    return { success: false, error: error.message };
  }
});

// Backtest the current production feature setup for both targets as-is.
ipcMain.handle('lab-backtest', async (event) => {
  try {
    if (!timesfmLabService) {
      return { success: false, error: 'Lab service not initialized' };
    }
    if (timesfmLabService.isRunning()) {
      return { success: false, error: 'A lab run is already in progress' };
    }
    const sender = event.sender;
    const result = await timesfmLabService.backtest((line) => {
      if (!sender.isDestroyed()) sender.send('lab-log', { line });
    });
    return { success: true, ...result };
  } catch (error) {
    console.error('[Lab] backtest failed:', error.message);
    return { success: false, error: error.message };
  }
});

// Local-LLM narration of search results / dataset checks (advisory text only).
ipcMain.handle('lab-insights', async (event, kind, payload) => {
  try {
    if (!labInsightsService) {
      return { success: false, error: 'Insights service not initialized' };
    }
    const text = kind === 'dataset'
      ? await labInsightsService.datasetInsights(payload || {})
      : await labInsightsService.searchInsights(payload || {});
    if (!text) return { success: false, error: 'Empty response from insight model' };
    return { success: true, text };
  } catch (error) {
    console.error('[Insights] generation failed:', error.message);
    return { success: false, error: error.message };
  }
});

// Dataset health summary for the lab UI (sample counts, coverage, warnings).
ipcMain.handle('lab-dataset', async () => {
  try {
    if (!timesfmLabService) {
      return { success: false, error: 'Lab service not initialized' };
    }
    return { success: true, info: await timesfmLabService.datasetInfo() };
  } catch (error) {
    console.error('[Lab] dataset check failed:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('lab-cancel', async () => {
  if (timesfmLabService && timesfmLabService.cancel()) {
    console.log('[Lab] Cancel requested');
    return { success: true };
  }
  return { success: false, error: 'No search in progress' };
});

ipcMain.handle('lab-status', async () => {
  return { running: !!(timesfmLabService && timesfmLabService.isRunning()) };
});

// Combine IV from a saved history record (exp1/exp2/exp3 format) using the
// single-pool scheme: each quantity is weighted across expirations by its own DV.
//
// New records (post-flip) have per-side DVs: callDV / putDV for OTM, and
// atmCallDV / atmPutDV + atmBandCallIV / atmBandPutIV for the band-based ATM.
// Ticker screening handler — supports cancellation via 'cancel-screening' IPC
let screeningCancelRequested = false;
// True while a screening run is in the main process. The options backfill and
// the screening both hammer the MarketData API and write to articles.db, so
// they run mutually exclusive.
let screeningActive = false;
ipcMain.handle('cancel-screening', async () => {
  screeningCancelRequested = true;
  console.log('[Screen] Cancel requested');
  return { success: true };
});

// ── Options data backfill (phases C+D of ci/backfill-marketdata.js, in-process) ──
// Coverage = per-ticker chain-data classification from ci/options-coverage.js:
// stale means chain history exists but ends >14 days ago (the flow-modal gaps),
// pending_backfill means little/no chain history yet.
ipcMain.handle('backfill-coverage', async () => {
  try {
    if (!database) return { success: false, error: 'Database not ready yet' };
    const report = await computeCoverage(database, loadBackfillState());
    return {
      success: true,
      generated: report.generated,
      covered: (report.details.covered || []).length,
      coveredList: report.details.covered || [],
      stale: report.details.stale || [],
      pendingBackfill: report.details.pending_backfill || [],
      confirmedMissing: (report.details.confirmed_missing || []).length,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('backfill-start', async (event, options = {}) => {
  try {
    if (!optionsBackfillService) return { success: false, error: 'Backend not ready yet' };
    const tickers = options.tickers == null ? null : [...new Set(
      (Array.isArray(options.tickers) ? options.tickers : [])
        .map(t => String(t).trim().toUpperCase())
        .filter(Boolean)
    )];
    const creditCap = Number(options.creditCap) > 0 ? Number(options.creditCap) : null;
    return await optionsBackfillService.start({ tickers, creditCap, isScreeningActive: () => screeningActive });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('backfill-estimate', async () => {
  try {
    if (!optionsBackfillService) return { success: false, error: 'Backend not ready yet' };
    return await optionsBackfillService.estimate();
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('backfill-cancel', async () => {
  if (!optionsBackfillService) return { success: false, error: 'Backend not ready yet' };
  return optionsBackfillService.cancel();
});

ipcMain.handle('backfill-status', async () => {
  if (!optionsBackfillService) return { success: false, error: 'Backend not ready yet' };
  return { success: true, ...optionsBackfillService.getStatus() };
});

ipcMain.handle('screen-tickers', async (event, options = {}) => {
  if (optionsBackfillService && optionsBackfillService.isRunning()) {
    return { success: false, error: 'An options backfill is running — wait for it to finish (or stop it) before screening' };
  }
  screeningActive = true;
  try {
    screeningCancelRequested = false;
    await backendReadyPromise;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Merge user options into config
    if (options.period) config.screenDays = Math.ceil(options.period * 1.4);
    if (options.lookbackDays) config.screenLookbackDays = options.lookbackDays;
    if (options.percentileThreshold) config.screenPercentileThreshold = options.percentileThreshold;

    // Override tickers if provided (bypass saved list)
    if (options.overrideTickers && options.overrideTickers.length > 0) {
      config.screenTickers = options.overrideTickers;
    }

    // Shuffle draw: on saved-list runs, add 5 random tickers from the top 100
    // of the latest rebuild's full ranking (shuffled, excluding the current list
    // and the previous run's draw so draws rotate). The draw is persisted to
    // config.lastShuffleDraw so the next run can exclude it.
    // The tickers are only suggested for this run — they are NOT saved into
    // screenTickers; the results page offers an "Add" button per suggestion.
    let suggestedTickers = [];
    const isSavedListRun = !options.overrideTickers || options.overrideTickers.length === 0;
    if (isSavedListRun) {
      try {
        const resultsPath = path.join(__dirname, 'ci', 'revise-results.json');
        if (fs.existsSync(resultsPath)) {
          const rev = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
          const top100 = (rev.fullRanking || rev.ranking || []).slice(0, 100);
          const current = new Set(config.screenTickers || []);
          const lastDraw = new Set(config.lastShuffleDraw || []);
          const pool = top100.filter(t => !current.has(t) && !lastDraw.has(t));
          // Fisher-Yates shuffle, take 5
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          suggestedTickers = pool.slice(0, 5);
          if (suggestedTickers.length > 0) {
            // Persist only the draw (so the next run excludes it) — the drawn
            // tickers join this run in-memory but stay out of screenTickers
            // unless the user clicks "Add" on the results page. Re-read the
            // file so per-run option merges above (screenDays etc.) and any
            // concurrent "Add" writes are not persisted/lost here.
            const diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            diskConfig.lastShuffleDraw = suggestedTickers;
            fs.writeFileSync(configPath, JSON.stringify(diskConfig, null, 2) + '\n', 'utf-8');
            config.screenTickers = [...(config.screenTickers || []), ...suggestedTickers];
            console.log(`[Screen] Drew ${suggestedTickers.length} shuffle tickers (rebuild top 100): ${suggestedTickers.join(', ')}`);
          }
        }
      } catch (suggErr) {
        console.error(`[Screen] Suggested-ticker sampling failed (non-fatal): ${suggErr.message}`);
      }
    }

    const tickers = config.screenTickers || [];
    console.log(`\nRunning ticker screening on ${tickers.length} tickers...`);

    config.isCancelled = () => screeningCancelRequested;

    // Yahoo supplies fundamentals only (sector/industry/market cap/summary).
    // Prices and options chains come from MarketData.app.
    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // Collect entries to fetch news for; fetched in parallel after screening completes
    const newsFetchEntries = [];
    const onTickerDone = options.fetchNews ? (entry) => {
      if (entry.ticker && !entry.skipped && !entry.error) newsFetchEntries.push(entry);
    } : null;
    const result = await screenTickers(priceTracker, config, createYF, onTickerDone, database, runArchiver);

    // Fetch Finviz headlines in parallel (HTTP, no BrowserView bottleneck)
    if (options.fetchNews && newsFetchEntries.length > 0) {
      await Promise.all(newsFetchEntries.map(async (entry) => {
        try {
          entry.news = await fetchFinvizNews(entry.ticker);
        } catch (err) {
          console.warn(`[screen-tickers] news fetch failed for ${entry.ticker}:`, err.message || err);
          entry.news = [];
        }
      }));
    }

    // Sort allTickers: fixed (saved-list) and chosen (override) tickers first,
    // shuffle-drawn suggestions last. Within each group: hits first (by
    // percentile desc), then non-hits alphabetically.
    const suggestedSet = new Set(suggestedTickers);
    result.allTickers.sort((a, b) => {
      const aSug = suggestedSet.has(a.ticker) ? 1 : 0;
      const bSug = suggestedSet.has(b.ticker) ? 1 : 0;
      if (aSug !== bSug) return aSug - bSug;
      const aHit = a.classification ? 1 : 0;
      const bHit = b.classification ? 1 : 0;
      if (aHit !== bHit) return bHit - aHit;
      if (aHit && bHit) return (b.percentile || 0) - (a.percentile || 0);
      return (a.ticker || '').localeCompare(b.ticker || '');
    });

    // Classify headlines from title text only (no article extraction)
    if (options.fetchNews) {
      try {
        await classifyTickerNews(result.allTickers);
      } catch (err) {
        console.error('[Screen] News classification failed:', err.message);
      }
      try {
        await tagTickerEvents(result.allTickers);
      } catch (err) {
        console.error('[Screen] Event tagging failed:', err.message);
      }

      // Patch tags into run.json (archiver wrote it before classification ran).
      if (result.runId) {
        try {
          const runJsonPath = path.join(__dirname, 'ci', 'screening-runs', `run-${result.runId}.run.json`);
          const meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8'));
          const tagMap = new Map();
          for (const e of result.allTickers) {
            if (Array.isArray(e.eventTags) && e.eventTags.length > 0) tagMap.set(e.ticker, e.eventTags);
          }
          if (Array.isArray(meta.tickers)) {
            for (const t of meta.tickers) {
              const tags = tagMap.get(t.ticker);
              if (tags) t.eventTags = tags;
            }
          }
          fs.writeFileSync(runJsonPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch (err) {
          console.error('[Screen] Failed to patch run.json with tags:', err.message);
        }
      }
    }

    // Feature sets promoted from the Model Lab, if any: per-target channel
    // lists that override the production defaults for both forecasts.
    // Target-only sets (length 1) are valid — the search prunes to them when
    // no covariate earns its keep; the python side handles no-covariate input.
    let labChannels = {};
    try {
      labChannels = (await database.getSetting('screening.channels', {})) || {};
    } catch (_) { /* defaults are fine */ }
    const isValidChannels = (list, targetChannel) =>
      Array.isArray(list) && list.length >= 1 && list[0] === targetChannel;
    const eventChannels = isValidChannels(labChannels.event, 'log_event_magnitude') ? labChannels.event : null;
    const directionChannels = isValidChannels(labChannels.direction, 'log_close') ? labChannels.direction : null;
    if (eventChannels) console.log(`[Screen] Event forecast using lab feature set (${eventChannels.length} channels)`);
    if (directionChannels) console.log(`[Screen] Direction forecast using lab feature set (${directionChannels.length} channels)`);

    // Enrich every screened ticker with its next-day TTM event probability.
    // All tickers go through ONE batched forward pass (GPU when available), so
    // the model weights and Python startup are paid once for the whole run —
    // this is what makes it affordable for full runs,
    // not just a handful of custom tickers.
    if (ttmEventService) {
      const tickerMap = new Map();
      for (const entry of result.allTickers) {
        if (entry.ticker && !entry.skipped && !entry.error) {
          tickerMap.set(entry.ticker, entry);
        }
      }
      const toForecast = [...tickerMap.keys()];

      if (toForecast.length > 0) {
        console.log(`[Screen] Running batched TTM event forecast for ${toForecast.length} ticker(s)...`);
        const t0 = Date.now();
        try {
          const probs = await ttmEventService.forecastProbabilities(toForecast, null, eventChannels);
          for (const [ticker, prob] of probs) {
            const entry = tickerMap.get(ticker);
            if (entry) entry.eventProbability = prob;
          }
          console.log(`[Screen] TTM forecast: ${probs.size}/${toForecast.length} scored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
          console.error(`[Screen] TTM batch forecast failed: ${err.message}`);
        }
      }
    }

    // Direction forecast: probability of a positive return on the next
    // trading day (options-only covariates).
    if (timesfmDirectionService) {
      const tickerMap = new Map();
      for (const entry of result.allTickers) {
        if (entry.ticker && !entry.skipped && !entry.error) {
          tickerMap.set(entry.ticker, entry);
        }
      }
      const toForecast = [...tickerMap.keys()];

      if (toForecast.length > 0) {
        console.log(`[Screen] Running batched TimesFM direction forecast for ${toForecast.length} ticker(s)...`);
        const t0 = Date.now();
        try {
          const recs = await timesfmDirectionService.forecastRecords(toForecast, null, directionChannels);
          for (const [ticker, rec] of recs) {
            const entry = tickerMap.get(ticker);
            if (entry) entry.directionForecast = {
              upProbability: rec.up_probability,
              downProbability: rec.down_probability,
              medianReturnPct: rec.median_return_pct,
              horizonTradingDays: rec.horizon_trading_days,
              forecastDate: rec.forecast_date,
            };
          }
          console.log(`[Screen] Direction forecast: ${recs.size}/${toForecast.length} scored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
          console.error(`[Screen] Direction batch forecast failed: ${err.message}`);
        }
      }
    }

    // Save weighted IV history. Records live in DuckDB (iv_history_records);
    // only today's snapshot is written back, while `ivHistory` keeps the full
    // series in memory for the stats/HTML consumers further down.
    const ivHistory = await database.getIVHistoryRecords();
    const todaysRecords = {};
    const today = new Date().toISOString().split('T')[0];
    for (const entry of result.allTickers) {
      const od = entry.chartData?.optionsStrikes;
      if (!od || od.length === 0) continue;
      if (!ivHistory[entry.ticker]) ivHistory[entry.ticker] = [];
      // Tag the provider so IV history stays self-describing: mixing
      // broker-reported IV with BSM-derived IV corrupts IV ranks/spreads, so
      // every record declares its source. Phase D rewrites all MarketData-
      // covered tickers as 'derived-bsm'; live runs write 'marketdata-live'.
      const record = { date: today, source: 'marketdata-live', sector: entry.sector || '' };
      if (Array.isArray(entry.eventTags) && entry.eventTags.length > 0) {
        record.eventTags = entry.eventTags.slice();
      }
      // Store today's close-to-previous-close return (%) for any-day return-bucket analysis.
      const closes = entry.chartData?.closes;
      if (Array.isArray(closes) && closes.length >= 2) {
        const c1 = closes[closes.length - 1], c0 = closes[closes.length - 2];
        if (typeof c0 === 'number' && typeof c1 === 'number' && c0 > 0) {
          record.dailyReturn = ((c1 - c0) / c0) * 100;
        }
      }
      const expCallDV = (exp) => {
        let dv = 0;
        for (const c of (exp.calls || [])) dv += c.dollarVol || 0;
        return dv;
      };
      const expPutDV = (exp) => {
        let dv = 0;
        for (const p of (exp.puts || [])) dv += p.dollarVol || 0;
        return dv;
      };
      const slimContract = (c) => ({
        strike: c.strike,
        dv: Math.round(c.dollarVol || 0),
        iv: c.iv > 0 ? Math.round(c.iv * 1000) / 10 : 0,
      });
      const buildExpRecord = (e) => {
        const callDV = expCallDV(e);
        const putDV = expPutDV(e);
        return {
          label: e.label,
          callIV: e.wCallIV,
          putIV: e.wPutIV,
          atmCallIV: e.atmCallIV,
          atmPutIV: e.atmPutIV,
          // Band-definition ATM (complement of the OTM filter) — stored now so a future
          // switch to band-based ATM can re-derive single-pool spreads from history.
          atmBandCallIV: e.atmBandCallIV ?? null,
          atmBandPutIV: e.atmBandPutIV ?? null,
          atmCallDV: e.atmCallDV ?? 0,
          atmPutDV: e.atmPutDV ?? 0,
          deepOTMCallPct: e.deepOTMCallPct,
          deepOTMPutPct: e.deepOTMPutPct,
          callDV,
          putDV,
          dv: callDV + putDV, // retained for back-compat with older readers
          // Per-strike snapshot — enables historical strike×(DV, IV) drill-downs.
          // IV stored as percent (one decimal) to keep the JSON compact.
          calls: (e.allCallContracts || e.calls || []).map(slimContract),
          puts: (e.allPutContracts || e.puts || []).map(slimContract),
        };
      };
      if (od[0]) record.exp1 = buildExpRecord(od[0]);
      if (od[1]) record.exp2 = buildExpRecord(od[1]);
      if (od[2]) record.exp3 = buildExpRecord(od[2]);
      // Replace if same date exists, otherwise append
      const existing = ivHistory[entry.ticker].findIndex(r => r.date === today);
      if (existing >= 0) ivHistory[entry.ticker][existing] = record;
      else ivHistory[entry.ticker].push(record);
      todaysRecords[entry.ticker] = [record];
    }
    try {
      const savedIV = await database.saveIVHistoryRecords(todaysRecords);
      console.log(`[Screen] IV history: ${savedIV} record(s) saved to iv_history_records`);
    } catch (err) {
      console.error(`[Screen] Failed to save IV history: ${err.message}`);
    }

    // Append classified events to the persistent event log for backtesting.
    // Each {ticker, eventDate} is unique — re-encountering the same event updates the
    // record in place (bar revisions or IV snapshot refreshes). This builds a time-series
    // dataset that can be joined with future price data to compute forward returns, or
    // with IV history to study spread dynamics around classified events.
    const eventLogPath = path.join(__dirname, 'ci', 'event-log.json');
    let eventLog = [];
    try { eventLog = JSON.parse(fs.readFileSync(eventLogPath, 'utf-8')); } catch (_) {}
    const eventIndex = new Map();
    eventLog.forEach((e, i) => eventIndex.set(`${e.ticker}|${e.eventDate}`, i));

    const runDate = new Date().toISOString().split('T')[0];
    let eventsAdded = 0, eventsUpdated = 0;
    for (const entry of result.allTickers) {
      if (!entry.classification) continue;
      const ed = entry.date instanceof Date ? entry.date : new Date(entry.date);
      if (isNaN(ed.getTime())) continue;
      const eventDate = ed.toISOString().split('T')[0];
      const os0 = entry.chartData?.optionsStrikes?.[0];
      const record = {
        ticker: entry.ticker,
        eventDate,
        runDate,
        classification: entry.classification,
        gap: entry.gap,
        percentile: entry.percentile,
        volume: entry.volume,
        volumeGapProduct: entry.volumeGapProduct,
        rSquared: entry.rSquared,
        wCallIV: os0 ? os0.wCallIV : null,
        wPutIV: os0 ? os0.wPutIV : null,
        atmCallIV: os0 ? os0.atmCallIV : null,
        atmPutIV: os0 ? os0.atmPutIV : null,
      };
      const key = `${entry.ticker}|${eventDate}`;
      if (eventIndex.has(key)) {
        eventLog[eventIndex.get(key)] = record;
        eventsUpdated++;
      } else {
        eventLog.push(record);
        eventIndex.set(key, eventLog.length - 1);
        eventsAdded++;
      }
    }
    fs.writeFileSync(eventLogPath, JSON.stringify(eventLog, null, 2) + '\n', 'utf-8');
    console.log(`[Screen] Event log: ${eventsAdded} new, ${eventsUpdated} updated (total ${eventLog.length})`);

    // Load IV history for HTML generation
    const ivHistoryForHTML = {};
    for (const entry of result.allTickers) {
      if (ivHistory[entry.ticker]) ivHistoryForHTML[entry.ticker] = ivHistory[entry.ticker];
    }

    // Aggregate pre-event IV profile across all logged events, grouped by classification.
    // Uses point-in-time percentile rank: for each event, we rank the latest pre-event IV
    // snapshot against that ticker's own history strictly before the event date (no lookahead).
    // Averaging ranks across events normalizes away cross-ticker IV-level differences —
    // deviation from 0 is the signal. Requires ≥10 prior history records per event.
    const PRE_EVENT_MIN_HIST = 10;
    const PE_WINDOW = 3;        // use up to the last 3 contiguous pre-event snapshots
    const PE_MAX_GAP_DAYS = 4;  // 1 trading day + weekend + 1 day tolerance (calendar-offset alignment)
    const PE_METRICS = ['callOtm', 'callAtm', 'callSpr', 'putOtm', 'putAtm', 'putSpr'];
    const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
    // Per-event we record the weighted-OTM-IV percentile rank, the weighted-ATM-IV
    // percentile rank, and the IV-spread percentile rank separately (each 0–100,
    // neutral = 50), for calls and puts.
    const mkPE = () => ({ callOtm: [], callAtm: [], callSpr: [], putOtm: [], putAtm: [], putSpr: [] });
    const preEventByClass = {
      surprising_positive: mkPE(),
      positive_anticipated: mkPE(),
      negative_anticipated: mkPE(),
      surprising_negative: mkPE(),
    };
    // #2 Trajectory: per metric, the rank at each of T-1 / T-2 / T-3 trading days
    // before the event, kept separate so the term structure of anticipation is visible.
    const mkTraj = () => { const o = {}; for (const m of PE_METRICS) o[m] = { t1: [], t2: [], t3: [] }; return o; };
    const trajByClass = {
      surprising_positive: mkTraj(),
      positive_anticipated: mkTraj(),
      negative_anticipated: mkTraj(),
      surprising_negative: mkTraj(),
    };
    const rankIn = (arr, val) => {
      if (!arr || arr.length < PRE_EVENT_MIN_HIST) return null;
      let below = 0;
      for (const v of arr) if (v <= val) below++;
      return (below / arr.length) * 100;
    };
    // Per-event feature vectors for the supervised contrast
    // (one row per event: denoised level ranks + window slopes + class label).
    const peEventFeatures = [];
    // Total option dollar volume of a history record (sum across expirations,
    // with legacy fallback to the top-level combined `dv`).
    const recTotalDV = (r) => {
      let dv = 0, any = false;
      for (const key of ['exp1', 'exp2', 'exp3']) {
        const e = r[key];
        if (!e) continue;
        if (e.dv != null) { dv += e.dv; any = true; }
        else if (e.callDV != null || e.putDV != null) { dv += (e.callDV || 0) + (e.putDV || 0); any = true; }
      }
      if (!any && r.dv != null) { dv = r.dv; any = true; }
      return any ? dv : null;
    };
    for (const ev of eventLog) {
      const bucket = preEventByClass[ev.classification];
      const tBucket = trajByClass[ev.classification];
      if (!bucket) continue;
      const history = ivHistory[ev.ticker];
      if (!Array.isArray(history) || history.length === 0) continue;
      // Point-in-time: only records strictly before the event date, with valid combined IV.
      const priorRecords = history.filter(r => r && r.date && combineHistRecord(r) && r.date < ev.eventDate);
      if (priorRecords.length < PRE_EVENT_MIN_HIST) continue;
      priorRecords.sort((a, b) => a.date.localeCompare(b.date));
      // Ranking population: the full strictly-before-event series. This is the same
      // population the single-snapshot method ranked the day-before snapshot against
      // (which already included the snapshot itself), so every window snapshot —
      // all within ~a week — is ranked consistently and the ≥10 min-history
      // guarantee is preserved for T-2 / T-3 as well.
      const callIVs = [], putIVs = [], atmCallIVs = [], atmPutIVs = [], callSpreads = [], putSpreads = [];
      // Dollar-volume ranking population: the same strictly-before-event series, so each
      // window snapshot's total option $vol is ranked within the ticker's own history —
      // exactly mirroring the IV rank features (removes cross-ticker liquidity/scale bias).
      const dvHistory = [];
      for (const r of priorRecords) {
        const e = combineHistRecord(r);
        if (!e) continue;
        if (e.callIV > 0) callIVs.push(e.callIV);
        if (e.putIV > 0) putIVs.push(e.putIV);
        if (e.atmCallIV != null && e.atmCallIV > 0) atmCallIVs.push(e.atmCallIV);
        if (e.atmPutIV != null && e.atmPutIV > 0) atmPutIVs.push(e.atmPutIV);
        if (e.callIV != null && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
        if (e.putIV != null && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
        const dv = recTotalDV(r);
        if (dv != null) dvHistory.push(dv);
      }
      const ranksOf = (p) => ({
        callOtm: p.callIV > 0 ? rankIn(callIVs, p.callIV) : null,
        callAtm: (p.atmCallIV != null && p.atmCallIV > 0) ? rankIn(atmCallIVs, p.atmCallIV) : null,
        callSpr: (p.callIV != null && p.atmCallIV != null) ? rankIn(callSpreads, p.callIV - p.atmCallIV) : null,
        putOtm: p.putIV > 0 ? rankIn(putIVs, p.putIV) : null,
        putAtm: (p.atmPutIV != null && p.atmPutIV > 0) ? rankIn(atmPutIVs, p.atmPutIV) : null,
        putSpr: (p.putIV != null && p.atmPutIV != null) ? rankIn(putSpreads, p.putIV - p.atmPutIV) : null,
      });
      // Build the window most-recent-first, walking back only while the gap to the
      // previously accepted date stays within tolerance. A data gap truncates the
      // window rather than mislabeling, e.g., a 5-day-stale record as "T-2".
      const window = [];
      const dvWindow = [];
      let prevDate = ev.eventDate;
      for (let i = priorRecords.length - 1; i >= 0 && window.length < PE_WINDOW; i--) {
        const d = priorRecords[i].date;
        if (dayDiff(d, prevDate) > PE_MAX_GAP_DAYS) break;
        window.push(ranksOf(combineHistRecord(priorRecords[i]))); // [0]=T-1, [1]=T-2, [2]=T-3
        dvWindow.push(rankIn(dvHistory, recTotalDV(priorRecords[i]))); // [0]=T-1 rank … (0–100)
        prevDate = d;
      }
      if (window.length === 0) continue;
      // #1 Denoise: per-event mean of each metric's rank across the window. Still one
      // observation per event, so cross-event independence (and n) is preserved.
      const peLvl = {}, peSlp = {};
      for (const m of PE_METRICS) {
        const vals = window.map(w => w[m]).filter(v => v != null);
        if (vals.length) {
          const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
          bucket[m].push(mean);
          peLvl[m] = mean;
        } else peLvl[m] = null;
        // Slope across the available window (most-recent − oldest); >0 = ramping in.
        const a = window[0][m], b = window[window.length - 1][m];
        peSlp[m] = (window.length >= 2 && a != null && b != null) ? a - b : null;
      }
      // Option $vol percentile-rank slope across the same window (T-1 − T-oldest), in rank
      // points (-100..+100) — same definition as the IV slope features. >0 = flow building.
      const dvA = dvWindow[0], dvB = dvWindow[dvWindow.length - 1];
      const dvDelta = (dvWindow.length >= 2 && dvA != null && dvB != null) ? dvA - dvB : null;
      peEventFeatures.push({ cls: ev.classification, lvl: peLvl, slp: peSlp, dvDelta });
      // #2 Trajectory: keep each slot separate for the term-structure view.
      const slots = ['t1', 't2', 't3'];
      for (let s = 0; s < window.length; s++) {
        for (const m of PE_METRICS) {
          const v = window[s][m];
          if (v != null) tBucket[m][slots[s]].push(v);
        }
      }
    }

    // Live recent-window slopes surfaced as the ATM C Δ / C SPR Δ / $VOL ΔRANK columns.
    // Unlike peSlopeByTicker (anchored to each ticker's last earnings event, hence static
    // between events), this walks the most recent contiguous window ending at the newest
    // snapshot — so the columns move each run as new snapshots land. Ranks are computed
    // within the ticker's own full history, mirroring the level columns' population.
    const peLiveSlopeByTicker = {};
    for (const [ticker, history] of Object.entries(ivHistory)) {
      if (!Array.isArray(history) || history.length < PRE_EVENT_MIN_HIST) continue;
      // Full-history ranking populations (same construction as the event-window path).
      const sorted = history.filter(r => r && r.date && combineHistRecord(r))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (sorted.length < PRE_EVENT_MIN_HIST) continue;
      const atmCallIVs = [], callSpreads = [], dvHistory = [];
      for (const r of sorted) {
        const e = combineHistRecord(r);
        if (e.atmCallIV != null && e.atmCallIV > 0) atmCallIVs.push(e.atmCallIV);
        if (e.callIV != null && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
        const dv = recTotalDV(r);
        if (dv != null) dvHistory.push(dv);
      }
      // Walk the most recent contiguous window (newest first), truncating on a data gap.
      const winAtm = [], winSpr = [], winDv = [];
      let prevDate = null;
      for (let i = sorted.length - 1; i >= 0 && winAtm.length < PE_WINDOW; i--) {
        const d = sorted[i].date;
        if (prevDate != null && dayDiff(d, prevDate) > PE_MAX_GAP_DAYS) break;
        const e = combineHistRecord(sorted[i]);
        winAtm.push((e.atmCallIV != null && e.atmCallIV > 0) ? rankIn(atmCallIVs, e.atmCallIV) : null);
        winSpr.push((e.callIV != null && e.atmCallIV != null) ? rankIn(callSpreads, e.callIV - e.atmCallIV) : null);
        winDv.push(rankIn(dvHistory, recTotalDV(sorted[i])));
        prevDate = d;
      }
      // Slope across the available window (most-recent − oldest); >0 = ramping in.
      const slope = (w) => (w.length >= 2 && w[0] != null && w[w.length - 1] != null) ? w[0] - w[w.length - 1] : null;
      peLiveSlopeByTicker[ticker] = { callAtm: slope(winAtm), callSpr: slope(winSpr), dvDelta: slope(winDv) };
    }

    const meanOf = (arr) => {
      if (!arr || arr.length === 0) return null;
      return arr.reduce((s, v) => s + v, 0) / arr.length;
    };
    const trajStat = (arr) => ({ mean: meanOf(arr), n: arr.length });
    // Rank distribution: 20 bins of width 5 spanning 0 … 100 (for the expandable per-class detail).
    const PE_HIST_MIN = 0, PE_HIST_BIN_W = 5, PE_HIST_NBINS = 20;
    const peHistOf = (vals) => {
      const counts = new Array(PE_HIST_NBINS).fill(0);
      for (const v of vals) {
        let idx = Math.floor((v - PE_HIST_MIN) / PE_HIST_BIN_W);
        if (idx < 0) idx = 0;
        if (idx >= PE_HIST_NBINS) idx = PE_HIST_NBINS - 1;
        counts[idx]++;
      }
      return counts;
    };
    const preEventStats = {};
    for (const [cls, data] of Object.entries(preEventByClass)) {
      preEventStats[cls] = {
        callOtmMean: meanOf(data.callOtm), callOtmN: data.callOtm.length, callOtmHist: peHistOf(data.callOtm),
        callAtmMean: meanOf(data.callAtm), callAtmN: data.callAtm.length, callAtmHist: peHistOf(data.callAtm),
        callSprMean: meanOf(data.callSpr), callSprN: data.callSpr.length, callSprHist: peHistOf(data.callSpr),
        putOtmMean: meanOf(data.putOtm), putOtmN: data.putOtm.length, putOtmHist: peHistOf(data.putOtm),
        putAtmMean: meanOf(data.putAtm), putAtmN: data.putAtm.length, putAtmHist: peHistOf(data.putAtm),
        putSprMean: meanOf(data.putSpr), putSprN: data.putSpr.length, putSprHist: peHistOf(data.putSpr),
        n: Math.max(data.callOtm.length, data.callAtm.length, data.callSpr.length, data.putOtm.length, data.putAtm.length, data.putSpr.length),
        histMin: PE_HIST_MIN, histBinW: PE_HIST_BIN_W, histNBins: PE_HIST_NBINS,
        traj: (() => {
          const t = trajByClass[cls], o = {};
          for (const m of PE_METRICS) o[m] = { t1: trajStat(t[m].t1), t2: trajStat(t[m].t2), t3: trajStat(t[m].t3) };
          return o;
        })(),
      };
    }

    // ── Pre-Event supervised contrast: positive vs negative outcomes, pooling the
    // surprising and anticipated classes by direction so all directional events count.
    // Answers "which IV combination precedes which eventual direction".
    const preEventContrast = (() => {
      const featDefs = [];
      for (const m of PE_METRICS) featDefs.push({ key: m, group: 'lvl' });
      for (const m of PE_METRICS) featDefs.push({ key: m, group: 'slp' });
      featDefs.push({ key: 'dvDelta', group: 'dv' });
      const labelOf = (m) => ({
        callOtm: 'Call OTM', callAtm: 'Call ATM', callSpr: 'Call Spr',
        putOtm: 'Put OTM', putAtm: 'Put ATM', putSpr: 'Put Spr',
      }[m]);
      const fLabel = (d) => (d.group === 'dv' ? 'Opt $Vol Δrank' : labelOf(d.key) + (d.group === 'slp' ? ' Δ' : ''));
      const rawVal = (ev, d) => (d.group === 'dv' ? ev.dvDelta : d.group === 'lvl' ? ev.lvl[d.key] : ev.slp[d.key]);

      // Column means over all events that have the value (for imputation).
      const colMean = featDefs.map((d) => {
        const vs = peEventFeatures.map((e) => rawVal(e, d)).filter((v) => v != null);
        return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;
      });
      const usable = featDefs.map((_, j) => colMean[j] != null);
      const cols = featDefs.map((d, j) => ({ d, j })).filter(({ j }) => usable[j]);
      if (peEventFeatures.length < 30 || cols.length < 2) {
        return { ok: false, reason: 'Not enough events with pre-event feature vectors yet.' };
      }
      let missCells = 0, totalCells = 0;
      const matAll = peEventFeatures.map((e) => cols.map(({ d, j }) => {
        const v = rawVal(e, d);
        totalCells++;
        if (v == null) { missCells++; return colMean[j]; }
        return v;
      }));

      // Univariate Welch contrast on raw (un-imputed) values — no imputation bias.
      // Grouped by eventual direction: positive (surprising + anticipated) vs
      // negative (surprising + anticipated), so the anticipated classes contribute n.
      const posIdx = [], negIdx = [];
      peEventFeatures.forEach((e, i) => {
        if (e.cls === 'surprising_positive' || e.cls === 'positive_anticipated') posIdx.push(i);
        else if (e.cls === 'surprising_negative' || e.cls === 'negative_anticipated') negIdx.push(i);
      });
      if (posIdx.length < 20 || negIdx.length < 20) {
        return { ok: false, reason: `Too few directional events (Pos ${posIdx.length}, Neg ${negIdx.length}; need ≥20 each).` };
      }
      const uni = cols.map(({ d }) => {
        const a = posIdx.map((i) => rawVal(peEventFeatures[i], d)).filter((v) => v != null);
        const b = negIdx.map((i) => rawVal(peEventFeatures[i], d)).filter((v) => v != null);
        if (a.length < 10 || b.length < 10) return null;
        const w = peWelch(a, b);
        return { label: fLabel(d), group: d.group, meanPos: w.meanA, meanNeg: w.meanB, diff: w.diff, d: w.d, p: w.p, nPos: a.length, nNeg: b.length };
      }).filter(Boolean).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));

      // Multivariate logistic on standardized imputed matrix (positive vs negative direction).
      const subRows = [...posIdx, ...negIdx].map((i) => matAll[i]);
      const subY = [...posIdx.map(() => 1), ...negIdx.map(() => 0)];
      const { Z: subZ, mean: subMean, std: subStd } = peStandardize(subRows);
      const model = peLogisticFit(subZ, subY, { iters: 1000, lr: 0.15, l2: 1.0 });
      const inScores = subZ.map((r) => peSigmoidScore(model, r));
      const auc = peAUC(inScores, subY);
      const cvAuc = peCVAUC(subZ, subY, 5, { iters: 1000, lr: 0.15, l2: 1.0 });
      const coefs = cols.map(({ d }, k) => ({ label: fLabel(d), w: model.w[k] }))
        .sort((x, y) => Math.abs(y.w) - Math.abs(x.w));

      return {
        ok: true,
        uni,
        logit: { coefs, auc, cvAuc, nPos: posIdx.length, nNeg: negIdx.length, missFrac: totalCells ? missCells / totalCells : 0 },
      };
    })();

    // IV Profile by Daily Return Bucket: for every (ticker, day T) in IV history, rank that
    // day's IV/spread against the ticker's full history and pair with day T+1's return.
    // Tests whether high rank on T precedes high vs low next-day returns. No event gating.
    const perDay = [];
    for (const [ticker, history] of Object.entries(ivHistory)) {
      if (!Array.isArray(history) || history.length < PRE_EVENT_MIN_HIST) continue;
      const sorted = history.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const callIVs = [], putIVs = [], callSpreads = [], putSpreads = [];
      for (const r of sorted) {
        const e = combineHistRecord(r);
        if (!e) continue;
        if (e.callIV > 0) callIVs.push(e.callIV);
        if (e.putIV > 0) putIVs.push(e.putIV);
        if (e.callIV != null && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
        if (e.putIV != null && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
      }
      for (let i = 0; i < sorted.length - 1; i++) {
        const rec = sorted[i];
        const next = sorted[i + 1];
        if (!next || typeof next.dailyReturn !== 'number') continue;
        const today = combineHistRecord(rec);
        if (!today) continue;
        const cR = today.callIV > 0 ? rankIn(callIVs, today.callIV) : null;
        const pR = today.putIV > 0 ? rankIn(putIVs, today.putIV) : null;
        const cSR = (today.callIV != null && today.atmCallIV != null) ? rankIn(callSpreads, today.callIV - today.atmCallIV) : null;
        const pSR = (today.putIV != null && today.atmPutIV != null) ? rankIn(putSpreads, today.putIV - today.atmPutIV) : null;
        // Per-day weighted-OTM-IV rank minus spread rank (range -100 to +100, neutral = 0);
        // these are then averaged across the bucket. ATM IV rank is not used.
        const callAvg = (cR != null && cSR != null) ? cR - cSR : null;
        const putAvg = (pR != null && pSR != null) ? pR - pSR : null;
        if (callAvg == null && putAvg == null) continue;
        perDay.push({ signedReturn: next.dailyReturn, callAvg, putAvg });
      }
    }
    let preEventByReturnBucket = null;
    if (perDay.length >= 4) {
      perDay.sort((a, b) => a.signedReturn - b.signedReturn);
      const mid = Math.floor(perDay.length / 2);
      const makeBucket = (slice) => {
        const callAvg = slice.map(e => e.callAvg).filter(v => v != null);
        const putAvg = slice.map(e => e.putAvg).filter(v => v != null);
        return {
          n: slice.length,
          minReturn: slice[0].signedReturn,
          maxReturn: slice[slice.length - 1].signedReturn,
          callAvgRank: meanOf(callAvg), putAvgRank: meanOf(putAvg),
          nCallAvg: callAvg.length, nPutAvg: putAvg.length,
        };
      };
      const lo = perDay.slice(0, mid), hi = perDay.slice(mid);
      preEventByReturnBucket = { low: makeBucket(lo), high: makeBucket(hi) };
    }

    // Implied Thesis: a local LLM reads each flagged company's business
    // profile next to its OTM call flow and derives what the buyers appear
    // to be betting on, then names the common thread across the cluster.
    // Purely advisory text for the report — never gates the run itself.
    let impliedThesis = null;
    if (options.impliedThesis && !result.cancelled && labInsightsService) {
      try {
        console.log('[Screen] Deriving implied thesis from OTM call activity...');
        const t0 = Date.now();
        impliedThesis = await runImpliedThesis(result.allTickers, {
          generate: (system, user, maxNewTokens) => labInsightsService.runPrompt(system, user, maxNewTokens),
          ivHistory,
        });
        console.log(`[Screen] Implied thesis: ${impliedThesis.candidates.length} ticker(s), ` +
          `${impliedThesis.thesis ? 'thesis derived' : 'no thesis'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (thesisErr) {
        console.error(`[Screen] Implied thesis failed: ${thesisErr.message}`);
        impliedThesis = { ok: false, reason: thesisErr.message };
      }
    }

    // Generate HTML results page
    const currentNotes = loadNotes();
    const currentToDelete = loadToDelete();
    const html = generateScreeningHTML(result.allTickers, tickers.length, config, ivHistoryForHTML, preEventStats, currentNotes, preEventByReturnBucket, preEventContrast, peLiveSlopeByTicker, currentToDelete, result.freshness, suggestedTickers, impliedThesis);

    // Save HTML for "Latest Run Results" (alias) and a timestamped snapshot in ci/screening-runs/
    const screenResultsPath = path.join(__dirname, 'ci', 'screening-results.html');
    fs.writeFileSync(screenResultsPath, html, 'utf-8');

    const runsDir = path.join(__dirname, 'ci', 'screening-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    // Use the archiver's runId so the HTML pairs with its run.json sidecar
    // (run-<runId>.html / run-<runId>.run.json).
    const ts = result.runId || new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(runsDir, `run-${ts}.html`);
    fs.writeFileSync(snapshotPath, html, 'utf-8');

    // Prune to 6 most recent snapshots
    try {
      const entries = fs.readdirSync(runsDir)
        .filter((f) => f.startsWith('run-') && f.endsWith('.html'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(runsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of entries.slice(6)) {
        fs.unlinkSync(path.join(runsDir, old.f));
      }
    } catch (pruneErr) {
      console.warn('[Screen] Failed to prune old run snapshots:', pruneErr.message);
    }

    console.log(`[Screen] Results saved to ci/screening-results.html (snapshot: ${path.basename(snapshotPath)})`);

    return { success: true, filePath: screenResultsPath, hitCount: result.hits.length, cancelled: !!result.cancelled };
  } catch (error) {
    console.error('Screening error:', error);
    return { success: false, error: error.message };
  } finally {
    screeningActive = false;
  }
});

// Revise the 100 — auto-select screening tickers by fundamentals
ipcMain.handle('revise-tickers', async (event) => {
  try {
    const fs = require('fs');

    console.log('\n[Revise] Starting ticker revision (screener-expanded universe)...');

    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const onProgress = (current, total, ticker) => {
      mainWindow()?.webContents.send('revise-progress', { current, total, ticker });
    };

    const result = await reviseTickers(createYF, onProgress);

    // The rebuild only refreshes the ranking (ci/revise-results.json), which
    // serves as the pool for the per-run shuffle draw. It does NOT touch
    // config.json — the screening list is managed by the user (plus explicit
    // "Add" clicks from shuffled-in suggestions).
    const resultsPath = path.join(__dirname, 'ci', 'revise-results.json');
    const fullResults = {
      timestamp: new Date().toISOString(),
      tickers: result.tickers,
      details: result.details,
      lists: result.lists,
      ranking: result.ranking,
      fullRanking: result.fullRanking,
      topN: result.topN,
      excluded: result.excluded,
      errors: result.errors,
      totalScored: result.totalScored,
    };
    fs.writeFileSync(resultsPath, JSON.stringify(fullResults, null, 2) + '\n', 'utf-8');

    console.log(`[Revise] Full results saved to ci/revise-results.json (${result.totalScored} tickers scored)`);

    return { success: true, ...fullResults };
  } catch (error) {
    console.error('Revise tickers error:', error);
    return { success: false, error: error.message };
  }
});

// Get the saved screening ticker list
ipcMain.handle('get-screen-tickers', async () => {
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { success: true, tickers: config.screenTickers || [] };
  } catch (error) {
    return { success: false, error: error.message, tickers: [] };
  }
});

// Save an edited screening list
ipcMain.handle('save-screen-list', async (event, { tickers } = {}) => {
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const norm = (arr) => [...new Set((arr || []).map(t => String(t).trim().toUpperCase()).filter(Boolean))];
    config.screenTickers = norm(tickers);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { success: true, tickers: config.screenTickers };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Permanently add a single ticker to the screening list (used by the "Add"
// button next to shuffled-in suggestions on the results page).
ipcMain.handle('add-screen-ticker', async (event, ticker) => {
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const t = String(ticker || '').trim().toUpperCase();
    if (!t) return { success: false, error: 'Empty ticker', tickers: config.screenTickers || [] };
    const list = config.screenTickers || [];
    const alreadyPresent = list.includes(t);
    if (!alreadyPresent) {
      list.push(t);
      config.screenTickers = list;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    }
    return { success: true, tickers: list, alreadyPresent };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load last rebuild results from disk
ipcMain.handle('load-revise-results', async () => {
  try {
    const fs = require('fs');
    const resultsPath = path.join(__dirname, 'ci', 'revise-results.json');
    if (!fs.existsSync(resultsPath)) {
      return { success: false, error: 'No previous results found. Run "Rebuild Ticker List" first.' };
    }
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    return { success: true, ...data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load a screening run from disk — either the latest alias, or a specific snapshot path.
ipcMain.handle('load-screening-results', async (event, requestedPath) => {
  try {
    const fs = require('fs');
    const runsDir = path.join(__dirname, 'ci', 'screening-runs');
    const latestAlias = path.join(__dirname, 'ci', 'screening-results.html');

    let targetPath = requestedPath || latestAlias;

    // Safety: if a path is provided, require it to live inside ci/screening-runs or equal the alias.
    if (requestedPath) {
      const resolved = path.resolve(requestedPath);
      const allowedDir = path.resolve(runsDir);
      if (!resolved.startsWith(allowedDir + path.sep) && resolved !== path.resolve(latestAlias)) {
        return { success: false, error: 'Invalid screening results path.' };
      }
      targetPath = resolved;
    }

    if (!fs.existsSync(targetPath)) {
      return { success: false, error: 'No previous screening results found. Run screening first.' };
    }
    return { success: true, filePath: targetPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// List the most recent screening run snapshots (newest first, up to 3).
ipcMain.handle('list-screening-runs', async () => {
  try {
    const fs = require('fs');
    const runsDir = path.join(__dirname, 'ci', 'screening-runs');
    if (!fs.existsSync(runsDir)) {
      return { success: true, runs: [] };
    }
    const runs = fs.readdirSync(runsDir)
      .filter((f) => f.startsWith('run-') && f.endsWith('.html'))
      .map((f) => {
        const full = path.join(runsDir, f);
        const mtime = fs.statSync(full).mtimeMs;
        return { filename: f, filePath: full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 6)
      .map((r) => ({
        filePath: r.filePath,
        label: new Date(r.mtime).toLocaleString(),
        timestamp: r.mtime,
      }));
    return { success: true, runs };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

const TO_DELETE_PATH = path.join(__dirname, 'ci', 'screening-to-delete.json');

function loadToDelete() {
  try { return JSON.parse(require('fs').readFileSync(TO_DELETE_PATH, 'utf-8')); } catch (_) { return []; }
}

function saveToDelete(list) {
  require('fs').writeFileSync(TO_DELETE_PATH, JSON.stringify(list, null, 2) + '\n', 'utf-8');
}

// Toggles a ticker's "to delete" flag on/off (independent of favorite state).
ipcMain.handle('toggle-delete', async (event, ticker) => {
  const list = loadToDelete();
  const idx = list.indexOf(ticker);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(ticker);
  saveToDelete(list);
  return { toDelete: list };
});

const NOTES_PATH = path.join(__dirname, 'ci', 'screening-notes.json');

function loadNotes() {
  try { return JSON.parse(require('fs').readFileSync(NOTES_PATH, 'utf-8')); } catch (_) { return {}; }
}

function saveNotes(notes) {
  require('fs').writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2) + '\n', 'utf-8');
}

ipcMain.handle('get-notes', async () => {
  return { notes: loadNotes() };
});

ipcMain.handle('save-note', async (event, ticker, note) => {
  const notes = loadNotes();
  const trimmed = (note || '').trim();
  if (trimmed) {
    notes[ticker] = trimmed;
  } else {
    delete notes[ticker];
  }
  saveNotes(notes);
  return { ok: true, notes };
});

// Window control handlers
ipcMain.handle('window-minimize', async (event) => {
  mainWindow().minimize();
});

ipcMain.handle('window-maximize', async (event) => {
  if (mainWindow().isMaximized()) {
    mainWindow().unmaximize();
  } else {
    mainWindow().maximize();
  }
});

ipcMain.handle('window-close', async (event) => {
  mainWindow().close();
});

// Modal support - hide/show BrowserView so modal can be seen
ipcMain.handle('show-modal', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView) {
    mainWindow()?.removeBrowserView(browserView);
  }
});

ipcMain.handle('hide-modal', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView) {
    mainWindow()?.setBrowserView(browserView);
    updateBrowserViewBounds(browserView);
  }
});

// Get embedding statistics
ipcMain.handle('get-embedding-stats', async (event) => {
  try {
    const stats = await database.getEmbeddingStats();
    return stats;
  } catch (error) {
    console.error('Error getting embedding stats:', error);
    return { error: error.message };
  }
});

// App lifecycle
let backendReadyResolve;
const backendReadyPromise = new Promise((r) => { backendReadyResolve = r; });
ipcMain.handle('wait-backend-ready', () => backendReadyPromise);

async function initBackend() {
  database = new ArticleDatabase('articles.db');
  try {
    await database.initialize();
    console.log('✓ Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    return;
  }

  priceTracker = new PriceTrackingService(database);
  stockAnalyzer = new StockAnalysisService(database);

  const ibProvider = new IBOptionsProvider({ port: 4001 });
  optionsAnalyzer = new OptionsAnalysisService(database, ibProvider);
  chronosHoldService = new ChronosHoldPeriodService(database);
  runArchiver = new RunArchiver({
    outputDir: path.join(__dirname, 'ci', 'screening-runs'),
  });
  ttmEventService = new TTMEventAnalysisService();
  timesfmDirectionService = new TimesFMDirectionService();
  timesfmLabService = new TimesFMLabService();
  labInsightsService = new LabInsightsService();
  optionsBackfillService = new OptionsBackfillService(database, (payload) => {
    const win = mainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('backfill-progress', payload);
  });

  priceTracker.setOptionsAnalyzer(optionsAnalyzer);

  articleExtractor.setBrowserExtractor(extractArticleViaBrowser);
  console.log('✓ Browser-based article extraction enabled');

  const autoPolling = await database.getSetting('price_auto_polling', 'false');
  const pollingInterval = await database.getSetting('price_polling_interval', '15');
  if (autoPolling === 'true') {
    priceTracker.startPolling(parseInt(pollingInterval));
  }

  backendReadyResolve();
  if (mainWindow() && !mainWindow().isDestroyed()) {
    mainWindow()?.webContents.send('backend-ready');
  }
}

app.whenReady().then(() => {
  createWindow();
  initBackend();
});

app.on('window-all-closed', async () => {
  // Stop price polling
  if (priceTracker) {
    priceTracker.stopPolling();
  }

  // Close database connection
  if (database) {
    await database.close();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (labInsightsService && labInsightsService.shutdown) labInsightsService.shutdown();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
