const path = require('path');
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

const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const ArticleDatabase = require('./src/services/database');
const PriceTrackingService = require('./src/services/priceTracking');
const RunArchiver = require('./src/services/runArchiver');
const StockAnalysisService = require('./src/services/stockAnalysis');
const OptionsAnalysisService = require('./src/services/optionsAnalysis');
const IBOptionsProvider = require('./src/services/ibOptionsProvider');
const articleExtractor = require('./src/services/articleExtractor');
const newsScraper = require('./src/services/newsScraper');
const ChronosHoldPeriodService = require('./src/services/chronosHoldPeriod');
const TTMEventAnalysisService = require('./src/services/ttmEventAnalysis');
const { screenTickers, reviseTickers, formatAge } = require('./ci/ticker-screen');
const { classifyTickerNews, tagTickerEvents } = require('./src/services/newsClassifier');
const { TAG_LABELS: EVENT_TAG_LABELS } = require('./src/services/eventTags');
const YahooFinance = require('yahoo-finance2').default;
const bunBridge = require('./src/services/bunBridge');
const { JSDOM } = require('jsdom');

let mainWindow;
let database;
let priceTracker;
let stockAnalyzer;
let optionsAnalyzer;
let chronosHoldService;
let runArchiver;
let ttmEventService;

// Tab management
const tabs = new Map(); // tabId -> BrowserView
let activeTabId = null;
let nextTabId = 1;

// Track analysis tabs for news updates
const analysisTabs = new Map(); // tabId -> { ticker, browserView }

// Hidden BrowserView for article extraction (reused for performance)
let extractionBrowserView = null;

/**
 * Get or create a hidden BrowserView for article extraction
 * This allows us to load pages with full JavaScript execution
 */
function getExtractionBrowserView() {
  if (!extractionBrowserView) {
    extractionBrowserView = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true // Render offscreen for better performance
      }
    });
    console.log('Created hidden BrowserView for article extraction');

    // Without a did-fail-load listener Electron prints "Failed to load URL ..."
    // to stderr for every blocked ad/tracking iframe — silence those, keep real errors
    extractionBrowserView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) { // -3 is ERR_ABORTED (cancelled/superseded load)
        console.log(`Article extraction navigation failed: ${validatedURL} - ${errorDescription}`);
      }
    });
  }
  return extractionBrowserView;
}

/**
 * Fetch news headlines from Finviz for a given ticker via direct HTTP (no BrowserView).
 * @param {string} ticker
 * @returns {Promise<Array<{date: string, time: string, headline: string, url: string}>>}
 */
async function fetchFinvizNews(ticker) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`;
  const html = await bunBridge.fetchHTML(url, { timeout: 15000 });
  const { document } = new JSDOM(html, { url }).window;

  const rows = document.querySelectorAll('.body-table-news-wrapper tr, .news-table_wrapper tr, table.fullview-news-outer tr');
  const results = [];
  let currentDate = '';
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const dateCell = cells[0].textContent.trim();
    const link = cells[1].querySelector('a');
    if (!link) continue;
    if (dateCell.includes('-')) {
      const parts = dateCell.split(/\s+/);
      currentDate = parts[0] || '';
      var time = parts[1] || '';
    } else {
      var time = dateCell;
    }
    results.push({
      date: currentDate,
      time: time || '',
      headline: link.textContent.trim(),
      url: link.href || ''
    });
  }

  console.log(`Finviz news: fetched ${results.length} headlines for ${ticker}`);
  return results;
}

/**
 * Try to click consent/cookie dialogs
 */
async function tryClickConsent(webContents) {
  const consentSelectors = [
    // Common consent button patterns
    'button[name="agree"]',
    'button.accept-all',
    'button.consent-accept',
    '[data-testid="consent-accept"]',
    '[data-testid="accept-button"]',
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[class*="consent"]',
    // Text-based matching (CSS :has-text is not standard, use JS)
  ];

  // Try CSS selectors first
  for (const selector of consentSelectors) {
    try {
      await webContents.executeJavaScript(`
        (function() {
          const btn = document.querySelector('${selector}');
          if (btn) { btn.click(); return true; }
          return false;
        })()
      `);
    } catch (e) { /* ignore */ }
  }

  // Try text-based matching
  try {
    await webContents.executeJavaScript(`
      (function() {
        const buttons = document.querySelectorAll('button, a[role="button"], [type="submit"]');
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase();
          if (text.includes('accept') || text.includes('agree') || text.includes('i agree') || text.includes('consent')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
  } catch (e) { /* ignore */ }

  // Small delay to let dialog close
  await new Promise(resolve => setTimeout(resolve, 300));
}

/**
 * Extract article content using browser-based loading
 * This handles JavaScript-rendered pages and consent dialogs
 */
async function extractArticleViaBrowser(url, options = {}) {
  const { timeout = 20000 } = options;
  const browserView = getExtractionBrowserView();

  try {
    console.log(`  [Browser] Loading: ${url.substring(0, 60)}...`);

    // Load the URL
    await browserView.webContents.loadURL(url);

    // Wait for page to be ready (domcontentloaded + small delay for JS)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to click consent dialogs
    await tryClickConsent(browserView.webContents);

    // Wait a bit more for any post-consent content to load
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Extract article using existing method
    const article = await articleExtractor.extractFromWebContents(browserView.webContents);

    console.log(`  [Browser] Extracted: "${article.title?.substring(0, 50)}..."`);
    return article;

  } catch (error) {
    console.error(`  [Browser] Failed to extract from ${url}: ${error.message}`);
    throw error;
  }
}

// Performance optimization: debounce timers
const navigationDebounceTimers = new Map(); // tabId -> timer
let resizeTimer = null;

function createWindow() {
  // Create the main application window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false, // Remove default title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.maximize();

  // Load the control UI
  mainWindow.loadFile('src/renderer/index.html');

  // Update browser view bounds when window resizes (debounced for performance)
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);

    resizeTimer = setTimeout(() => {
      if (activeTabId) {
        const browserView = tabs.get(activeTabId);
        updateBrowserViewBounds(browserView);
      }
    }, 16); // ~60fps
  });

  // Also handle maximize/unmaximize events (immediate, no debounce needed)
  mainWindow.on('maximize', () => {
    if (activeTabId) {
      updateBrowserViewBounds(tabs.get(activeTabId));
    }
  });

  mainWindow.on('unmaximize', () => {
    if (activeTabId) {
      updateBrowserViewBounds(tabs.get(activeTabId));
    }
  });

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

// Position the browser view (leave space for tab bar + toolbar at top)
function updateBrowserViewBounds(browserView) {
  if (!browserView || !mainWindow) return;

  const { width, height } = mainWindow.getContentBounds();

  browserView.setBounds({
    x: 0,
    y: 96, // Space for tab bar (36px) + toolbar (60px)
    width: width,
    height: height - 96 // Remaining space below top bars
  });
}

// Create a new tab
function createTab(url = 'https://simplywall.st/dashboard') {
  const tabId = nextTabId++;

  const browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  tabs.set(tabId, browserView);

  // Block tracking and ad domains
  const session = browserView.webContents.session;
  // Optimized: use compiled regex for faster URL blocking (3-5x faster)
  const blockPattern = new RegExp(
    'cootlogix\\.com|kueezrtb\\.com|doubleclick\\.net|' +
    'googleadservices\\.com|googlesyndication\\.com|' +
    'advertising\\.com|adsystem\\.com|adnxs\\.com|' +
    'amazon-adsystem\\.com|/sa/|/tr/|sync\\.|pixel\\.|track\\.|analytics\\.',
    'i' // case insensitive
  );

  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // Never block requests to the site's own domain — the site's API may contain
    // words like "analytics" in legitimate paths (e.g. api.simplywall.st).
    try {
      const urlHost = new URL(details.url).hostname;
      const initHost = details.initiator ? new URL(details.initiator).hostname : '';
      const rootDomain = (h) => h.split('.').slice(-2).join('.');
      if (initHost && rootDomain(urlHost) === rootDomain(initHost)) {
        return callback({});
      }
    } catch (_) {}
    // Single regex test is much faster than array iteration + toLowerCase + includes
    callback({ cancel: blockPattern.test(details.url) });
  });

  // Suppress console error messages from blocked/failed tracking URLs
  browserView.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Level 2 = error, 1 = warning, 0 = log
    if (level === 2 || level === 1) {
      // Filter out connection errors from tracking/sync domains
      if (message.includes('ERR_CONNECTION_REFUSED') ||
          message.includes('ERR_FAILED') ||
          message.includes('ERR_ABORTED')) {
        const trackingKeywords = ['sync.', 'track', 'pixel', 'analytics', 'cootlogix', 'kueezrtb'];
        if (trackingKeywords.some(keyword => message.toLowerCase().includes(keyword))) {
          // Silently ignore tracking domain errors
          return;
        }
      }
    }
    // Log other console messages for debugging (optional - can be removed)
    // console.log(`[WebContent Console] ${message}`);
  });

  // Gracefully handle failed loads from tracking URLs
  browserView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // Ignore tracking domain failures
    const trackingKeywords = ['sync.', 'track', 'pixel', 'analytics', 'cootlogix', 'kueezrtb', 'doubleclick', 'adsystem'];
    const isTrackingUrl = trackingKeywords.some(keyword => validatedURL.toLowerCase().includes(keyword));

    if (isTrackingUrl) {
      // Silently ignore tracking URL failures
      return;
    }

    // Log real navigation failures for the main page
    if (errorCode !== -3) { // -3 is ERR_ABORTED (user cancelled)
      console.log(`Navigation failed: ${validatedURL} - ${errorDescription}`);
    }
  });

  // Debounced URL update sender to prevent rapid-fire IPC messages
  function sendUrlUpdate(url, title) {
    // Clear existing timer for this tab
    if (navigationDebounceTimers.has(tabId)) {
      clearTimeout(navigationDebounceTimers.get(tabId));
    }

    // Debounce: only send after 10ms of no new events (reduced from 50ms for faster response)
    const timer = setTimeout(() => {
      mainWindow.webContents.send('url-changed', { tabId, url, title });
      navigationDebounceTimers.delete(tabId);
    }, 10);

    navigationDebounceTimers.set(tabId, timer);
  }

  // Update URL bar when navigation happens (debounced for performance)
  browserView.webContents.on('did-navigate', (event, url) => {
    sendUrlUpdate(url, browserView.webContents.getTitle());
  });

  browserView.webContents.on('did-navigate-in-page', (event, url) => {
    sendUrlUpdate(url, browserView.webContents.getTitle());
  });

  // Prevent OS dark mode from bleeding into websites
  browserView.webContents.on('did-finish-load', () => {
    browserView.webContents.insertCSS(':root { color-scheme: light only !important; }');
  });

  browserView.webContents.on('page-title-updated', (event, title) => {
    sendUrlUpdate(browserView.webContents.getURL(), title);
  });

  // Handle links that try to open in new windows - open them in new tabs instead
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    // Allow OAuth popups to open as real windows so window.opener works
    try {
      const host = new URL(url).hostname;
      if (host === 'accounts.google.com' || host === 'appleid.apple.com' ||
          host.endsWith('.auth0.com') || host.endsWith('.okta.com')) {
        return { action: 'allow' };
      }
    } catch (_) {}

    // Create a new tab with the URL and switch to it
    const newTabId = createTab(url);
    switchTab(newTabId);

    // Notify the renderer about the new tab
    mainWindow.webContents.send('tab-created', { tabId: newTabId, url });

    // Prevent the default window from opening
    return { action: 'deny' };
  });

  // Block overlay popups on simplywall.st (paywall/signup modals that appear on scroll)
  browserView.webContents.on('did-finish-load', () => {
    const currentUrl = browserView.webContents.getURL();
    if (currentUrl.includes('simplywall.st')) {
      browserView.webContents.insertCSS(`
        /* Hide paywall/signup walls and their backdrops.
           Note: deliberately NOT hiding [class*="overlay"]/[role="dialog"] —
           those also match the dashboard search dropdown and would break it. */
        [class*="paywall"], [class*="Paywall"],
        [class*="signup-wall"], [class*="SignupWall"],
        [class*="SignupGate"], [class*="signup-gate"],
        [class*="PaywallGate"] {
          display: none !important;
        }
        /* Restore scrolling if a wall locks the body */
        body, html {
          overflow: auto !important;
          position: static !important;
        }
      `);
    }
  });

  // Load URL if provided
  if (url) {
    browserView.webContents.loadURL(url);
  }

  return tabId;
}

// Switch to a tab
function switchTab(tabId) {
  const browserView = tabs.get(tabId);
  if (!browserView) return;

  // Guard: if the view's webContents was destroyed (e.g. OAuth popup closed itself),
  // clean up the tab instead of crashing
  if (browserView.webContents.isDestroyed()) {
    tabs.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
    return;
  }

  // Remove current browser view
  if (activeTabId) {
    const currentView = tabs.get(activeTabId);
    if (currentView && !currentView.webContents.isDestroyed()) {
      mainWindow.removeBrowserView(currentView);
    }
  }

  // Add and position new browser view
  mainWindow.setBrowserView(browserView);
  updateBrowserViewBounds(browserView);

  activeTabId = tabId;
}

// Close a tab
function closeTab(tabId) {
  const browserView = tabs.get(tabId);
  if (!browserView) return;

  // Remove from window if it's active
  if (activeTabId === tabId) {
    mainWindow.removeBrowserView(browserView);
    activeTabId = null;
  }

  // Destroy the browser view
  browserView.webContents.destroy();
  tabs.delete(tabId);
}

// Get active tab's BrowserView
function getActiveBrowserView() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

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

// Combine IV from a saved history record (exp1/exp2/exp3 format) using the
// single-pool scheme: each quantity is weighted across expirations by its own DV.
//
// New records (post-flip) have per-side DVs: callDV / putDV for OTM, and
// atmCallDV / atmPutDV + atmBandCallIV / atmBandPutIV for the band-based ATM.
// Older records only carry a combined `dv` (call+put) and a single-strike
// `atmCallIV` / `atmPutIV`; we fall back to that for historical continuity.
function combineHistRecord(record) {
  const exps = [];
  for (const key of ['exp1', 'exp2', 'exp3']) {
    const e = record[key];
    if (!e || (e.callIV <= 0 && e.putIV <= 0)) continue;
    exps.push(e);
  }
  if (exps.length === 0) return null;

  // If no expiration has a usable DV, fall back to equal weights across the
  // expirations that do carry a value — matches the legacy behavior and keeps
  // pre-flip history records (which have no dv/callDV/putDV) contributing.
  const poolWeighted = (valueFn, weightFn) => {
    const vals = [];
    for (const e of exps) {
      const v = valueFn(e);
      if (v == null) continue;
      const w = weightFn(e);
      vals.push({ v, w: w > 0 ? w : 0 });
    }
    if (vals.length === 0) return null;
    const sumW = vals.reduce((s, x) => s + x.w, 0);
    if (sumW > 0) return vals.reduce((s, x) => s + x.v * x.w, 0) / sumW;
    return vals.reduce((s, x) => s + x.v, 0) / vals.length;
  };

  // Fallback weight when new per-side DV is missing on older records.
  const fallbackDV = (e) => (e.dv || 0);

  const callIV = poolWeighted(
    (e) => (e.callIV > 0 ? e.callIV : null),
    (e) => (e.callDV != null ? e.callDV : fallbackDV(e)),
  ) ?? 0;
  const putIV = poolWeighted(
    (e) => (e.putIV > 0 ? e.putIV : null),
    (e) => (e.putDV != null ? e.putDV : fallbackDV(e)),
  ) ?? 0;

  const atmCallIV = poolWeighted(
    (e) => (e.atmBandCallIV != null && e.atmBandCallIV > 0 ? e.atmBandCallIV : (e.atmCallIV != null ? e.atmCallIV : null)),
    (e) => (e.atmCallDV != null ? e.atmCallDV : fallbackDV(e)),
  );
  const atmPutIV = poolWeighted(
    (e) => (e.atmBandPutIV != null && e.atmBandPutIV > 0 ? e.atmBandPutIV : (e.atmPutIV != null ? e.atmPutIV : null)),
    (e) => (e.atmPutDV != null ? e.atmPutDV : fallbackDV(e)),
  );

  return {
    callIV, putIV,
    atmCallIV,
    atmPutIV,
  };
}

// ─── Dependency-free numerics for the Pre-Event supervised contrast ───
// Small, exact-enough hand-rolls (no npm deps). All inputs are modest in size
// (≤ a few hundred rows, ≤ ~12 features), so naive implementations are fine.

// Two-sided p-value from a z/large-df-t statistic via the error function
// (Abramowitz & Stegun 7.1.26). df > 100 here, so z ≈ t is acceptable.
function peErf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function peTwoSidedP(z) {
  return 2 * (1 - 0.5 * (1 + peErf(Math.abs(z) / Math.SQRT2)));
}

// Welch contrast between two samples → mean diff, pooled-SD Cohen's d, t, p.
function peWelch(a, b) {
  const m = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const varOf = (v, mu) => v.length < 2 ? 0 : v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (v.length - 1);
  const ma = m(a), mb = m(b), va = varOf(a, ma), vb = varOf(b, mb);
  const na = a.length, nb = b.length;
  const se = Math.sqrt(va / na + vb / nb) || 1e-9;
  const t = (ma - mb) / se;
  const pooledSD = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / Math.max(1, na + nb - 2)) || 1e-9;
  return { meanA: ma, meanB: mb, diff: ma - mb, d: (ma - mb) / pooledSD, t, p: peTwoSidedP(t) };
}

// Column-wise standardize; returns Z plus the mean/std used (std floored).
function peStandardize(rows) {
  const n = rows.length, p = rows[0].length;
  const mean = new Array(p).fill(0), std = new Array(p).fill(0);
  for (const r of rows) for (let j = 0; j < p; j++) mean[j] += r[j];
  for (let j = 0; j < p; j++) mean[j] /= n;
  for (const r of rows) for (let j = 0; j < p; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j] / Math.max(1, n - 1)) || 1e-9;
  const Z = rows.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  return { Z, mean, std };
}

// Correlation matrix of already-standardized Z (= covariance of standardized).
// L2-regularized logistic regression by full-batch gradient descent.
// X is standardized (no bias column); intercept fit separately. y ∈ {0,1}.
function peLogisticFit(X, y, { iters = 800, lr = 0.1, l2 = 1.0 } = {}) {
  const n = X.length, p = X[0].length;
  const w = new Array(p).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(p).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const pr = 1 / (1 + Math.exp(-z));
      const e = pr - y[i];
      gb += e;
      for (let j = 0; j < p; j++) gw[j] += e * X[i][j];
    }
    b -= lr * gb / n;
    for (let j = 0; j < p; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n);
  }
  return { w, b };
}
function peSigmoidScore(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
}

// AUC via the Mann–Whitney rank identity (handles ties at 0.5).
function peAUC(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    const r = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[idx[k]] = r;
    i = j;
  }
  let nPos = 0, sumPos = 0;
  for (let i = 0; i < y.length; i++) if (y[i] === 1) { nPos++; sumPos += ranks[i]; }
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

// Stratified k-fold cross-validated AUC (honest, vs in-sample optimism).
function peCVAUC(X, y, k = 5, fitOpts) {
  const pos = [], neg = [];
  for (let i = 0; i < y.length; i++) (y[i] === 1 ? pos : neg).push(i);
  const folds = Array.from({ length: k }, () => []);
  pos.forEach((ix, i) => folds[i % k].push(ix));
  neg.forEach((ix, i) => folds[i % k].push(ix));
  const allScores = new Array(y.length);
  for (let f = 0; f < k; f++) {
    const test = new Set(folds[f]);
    const trX = [], trY = [];
    for (let i = 0; i < y.length; i++) if (!test.has(i)) { trX.push(X[i]); trY.push(y[i]); }
    if (!trX.length) continue;
    const m = peLogisticFit(trX, trY, fitOpts);
    for (const i of folds[f]) allScores[i] = peSigmoidScore(m, X[i]);
  }
  return peAUC(allScores, y);
}

// Ticker screening handler — supports cancellation via 'cancel-screening' IPC
let screeningCancelRequested = false;
ipcMain.handle('cancel-screening', async () => {
  screeningCancelRequested = true;
  console.log('[Screen] Cancel requested');
  return { success: true };
});

ipcMain.handle('screen-tickers', async (event, options = {}) => {
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
          const probs = await ttmEventService.forecastProbabilities(toForecast);
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

    // Generate HTML results page
    const currentNotes = loadNotes();
    const currentToDelete = loadToDelete();
    const html = generateScreeningHTML(result.allTickers, tickers.length, config, ivHistoryForHTML, preEventStats, currentNotes, preEventByReturnBucket, preEventContrast, peLiveSlopeByTicker, currentToDelete, result.freshness, suggestedTickers);

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
  }
});

// Revise the 100 — auto-select screening tickers by fundamentals
ipcMain.handle('revise-tickers', async (event) => {
  try {
    const fs = require('fs');

    console.log('\n[Revise] Starting ticker revision (screener-expanded universe)...');

    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const onProgress = (current, total, ticker) => {
      mainWindow.webContents.send('revise-progress', { current, total, ticker });
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

function generateScreeningHTML(allTickers, totalTickers, config, ivHistoryData = {}, preEventStats = {}, notes = {}, preEventByReturnBucket = null, preEventContrast = null, peLiveSlopeByTicker = {}, toDelete = [], freshness = null, suggestedTickers = []) {
  const suggestedSet = new Set(suggestedTickers);
  const classColors = {
    surprising_positive: '#4caf50',
    positive_anticipated: '#8bc34a',
    negative_anticipated: '#ff9800',
    surprising_negative: '#f44336',
  };

  const classLabels = {
    surprising_positive: 'Surprising +',
    positive_anticipated: 'Anticipated +',
    negative_anticipated: 'Anticipated -',
    surprising_negative: 'Surprising -',
  };

  const hitCount = allTickers.filter(h => h.classification).length;
  const deleteSet = new Set(toDelete);

  // Combine IV from up to 3 expirations, weighted by dollar volume per expiration.
  // Single-pool combination across up to 3 nearest expirations.
  // Each side (OTM call / OTM put / ATM-band call / ATM-band put) is weighted
  // by its own DV, independently. The ATM side uses the band-definition IV
  // (complement of the OTM filter) now that it's available on each expiration.
  function combineExpirations(os) {
    const exps = os.filter(exp => exp && (exp.wCallIV > 0 || exp.wPutIV > 0));
    if (exps.length === 0) return null;

    const sumDV = (arr) => arr.reduce((s, c) => s + (c.dollarVol || 0), 0);
    const poolWeighted = (valueFn, weightFn) => {
      let sumVW = 0, sumW = 0;
      for (const e of exps) {
        const v = valueFn(e);
        const w = weightFn(e);
        if (v == null || !(w > 0)) continue;
        sumVW += v * w;
        sumW += w;
      }
      return sumW > 0 ? sumVW / sumW : 0;
    };

    const callIV = poolWeighted(
      (e) => (e.wCallIV > 0 ? e.wCallIV : null),
      (e) => sumDV(e.calls || []),
    );
    const putIV = poolWeighted(
      (e) => (e.wPutIV > 0 ? e.wPutIV : null),
      (e) => sumDV(e.puts || []),
    );
    const atmCallIV = poolWeighted(
      (e) => (e.atmBandCallIV != null && e.atmBandCallIV > 0 ? e.atmBandCallIV : (e.atmCallIV > 0 ? e.atmCallIV : null)),
      (e) => (e.atmCallDV != null ? e.atmCallDV : sumDV(e.calls || [])),
    );
    const atmPutIV = poolWeighted(
      (e) => (e.atmBandPutIV != null && e.atmBandPutIV > 0 ? e.atmBandPutIV : (e.atmPutIV > 0 ? e.atmPutIV : null)),
      (e) => (e.atmPutDV != null ? e.atmPutDV : sumDV(e.puts || [])),
    );

    const totalDV = exps.reduce((s, e) => s + sumDV(e.calls || []) + sumDV(e.puts || []), 0);

    return {
      callIV: Math.round(callIV * 10) / 10,
      putIV: Math.round(putIV * 10) / 10,
      atmCallIV: Math.round(atmCallIV * 10) / 10,
      atmPutIV: Math.round(atmPutIV * 10) / 10,
      ivSpreadCall: Math.round((callIV - atmCallIV) * 10) / 10,
      ivSpreadPut: Math.round((putIV - atmPutIV) * 10) / 10,
      totalDV,
    };
  }

  // Build chart data JSON and summary map for each ticker
  const chartDataMap = {};
  const summaryMap = {};
  const newsMap = {};
  const tickerIVs = {}; // { ticker: { callIV, putIV, atmCallIV, atmPutIV, ivSpreadCall, ivSpreadPut } } — DV-weighted across expirations
  const tickerOptDV = {}; // { ticker: totalDollarVol } — sum of call+put dollar vol across all expirations
  for (const h of allTickers) {
    if (h.chartData && h.chartData.dates && h.chartData.dates.length > 0) {
      chartDataMap[h.ticker] = h.chartData;
      const os = h.chartData.optionsStrikes;
      if (os && os.length > 0) {
        const combined = combineExpirations(os);
        if (combined && (combined.callIV > 0 || combined.putIV > 0)) {
          tickerIVs[h.ticker] = combined;
        }
        if (combined && combined.totalDV > 0) tickerOptDV[h.ticker] = combined.totalDV;
      }
    }
    if (h.summary) summaryMap[h.ticker] = h.summary;
    if (h.news && h.news.length > 0) newsMap[h.ticker] = h.news;
  }

  // Compute per-ticker IV history stats from iv_history_records (DuckDB).
  // Uses exp1 (nearest expiration) to match what's displayed. Requires >=10 records
  // so percentile rank has meaningful resolution.
  const MIN_HIST_RECORDS = 10;
  const ivHistStats = {};
  // Resolve each ticker's sector: prefer current run data, fall back to last saved record
  const tickerSectors = {};
  for (const h of allTickers) {
    if (h.sector) tickerSectors[h.ticker] = h.sector;
  }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!tickerSectors[ticker] && Array.isArray(records)) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].sector) { tickerSectors[ticker] = records[i].sector; break; }
      }
    }
  }
  // Build per-sector spread distributions from all historical records
  const sectorSpreads = {}; // { sector: { callSpreads: [], putSpreads: [] } }
  // Build per-tag spread distributions from all historical records that carry that tag.
  // A historical record can contribute to multiple tag cohorts.
  const tagSpreads = {}; // { tagId: { callSpreads: [], putSpreads: [] } }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    const sec = tickerSectors[ticker];
    if (!Array.isArray(records)) continue;
    if (sec && !sectorSpreads[sec]) sectorSpreads[sec] = { callSpreads: [], putSpreads: [] };
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      const callOk = e.callIV > 0 && e.atmCallIV != null;
      const putOk = e.putIV > 0 && e.atmPutIV != null;
      const callSpr = callOk ? e.callIV - e.atmCallIV : null;
      const putSpr = putOk ? e.putIV - e.atmPutIV : null;
      if (sec) {
        if (callOk) sectorSpreads[sec].callSpreads.push(callSpr);
        if (putOk) sectorSpreads[sec].putSpreads.push(putSpr);
      }
      const recTags = Array.isArray(r.eventTags) ? r.eventTags : null;
      if (recTags) {
        for (const tag of recTags) {
          if (!tagSpreads[tag]) tagSpreads[tag] = { callSpreads: [], putSpreads: [] };
          if (callOk) tagSpreads[tag].callSpreads.push(callSpr);
          if (putOk) tagSpreads[tag].putSpreads.push(putSpr);
        }
      }
    }
  }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!Array.isArray(records) || records.length < MIN_HIST_RECORDS) continue;
    const callIVs = [], putIVs = [], callSpreads = [], putSpreads = [], atmCallIVs = [], atmPutIVs = [];
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      if (e.callIV > 0) callIVs.push(e.callIV);
      if (e.putIV > 0) putIVs.push(e.putIV);
      if (e.atmCallIV != null && e.atmCallIV > 0) atmCallIVs.push(e.atmCallIV);
      if (e.atmPutIV != null && e.atmPutIV > 0) atmPutIVs.push(e.atmPutIV);
      if (e.callIV > 0 && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
      if (e.putIV > 0 && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
    }
    ivHistStats[ticker] = {
      callIVs: callIVs.length >= MIN_HIST_RECORDS ? callIVs : null,
      putIVs: putIVs.length >= MIN_HIST_RECORDS ? putIVs : null,
      atmCallIVs: atmCallIVs.length >= MIN_HIST_RECORDS ? atmCallIVs : null,
      atmPutIVs: atmPutIVs.length >= MIN_HIST_RECORDS ? atmPutIVs : null,
      callSpreads: callSpreads.length >= 3 ? callSpreads : null,
      putSpreads: putSpreads.length >= 3 ? putSpreads : null,
    };
  }
  const pctRank = (arr, val) => {
    if (!arr || arr.length === 0) return null;
    let below = 0;
    for (const v of arr) if (v <= val) below++;
    return Math.round((below / arr.length) * 100);
  };

  // ── Package Suggestion: compute 2-snapshot avg call spread & pairwise correlations ──

  // Step 1: Average call spread from last 2 IV history snapshots per ticker
  const avgCallSpread2 = {};
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!Array.isArray(records) || records.length === 0) continue;
    const recent = records.slice(-2);
    let sum = 0, count = 0;
    for (const r of recent) {
      const e = combineHistRecord(r);
      if (!e || e.callIV <= 0 || e.atmCallIV == null) continue;
      sum += (e.callIV - e.atmCallIV);
      count++;
    }
    if (count >= 1) avgCallSpread2[ticker] = sum / count;
  }

  // Step 2: Server-side pairwise Pearson correlation for candidate tickers
  const pkgCandidates = Object.keys(avgCallSpread2)
    .filter(t => chartDataMap[t] && chartDataMap[t].dates && chartDataMap[t].closes);

  function pearsonFromCloses(cd1, cd2) {
    const dateIdx = {};
    for (let i = 0; i < cd1.dates.length; i++) dateIdx[cd1.dates[i]] = i;
    const pairedSrc = [], pairedOther = [];
    let prevSrcIdx = -1, prevOtherIdx = -1;
    for (let j = 0; j < cd2.dates.length; j++) {
      const srcI = dateIdx[cd2.dates[j]];
      if (srcI == null) { prevOtherIdx = j; continue; }
      if (prevSrcIdx >= 0 && prevOtherIdx >= 0
          && srcI === prevSrcIdx + 1 && j === prevOtherIdx + 1) {
        if (cd1.closes[prevSrcIdx] > 0 && cd2.closes[prevOtherIdx] > 0) {
          pairedSrc.push(Math.log(cd1.closes[srcI] / cd1.closes[prevSrcIdx]));
          pairedOther.push(Math.log(cd2.closes[j] / cd2.closes[prevOtherIdx]));
        }
      }
      prevSrcIdx = srcI;
      prevOtherIdx = j;
    }
    if (pairedSrc.length < 20) return null;
    const n = pairedSrc.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let k = 0; k < n; k++) {
      sumX += pairedSrc[k]; sumY += pairedOther[k];
      sumXY += pairedSrc[k] * pairedOther[k];
      sumX2 += pairedSrc[k] * pairedSrc[k];
      sumY2 += pairedOther[k] * pairedOther[k];
    }
    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return denom > 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  }

  const pkgCorrMatrix = {};
  for (let i = 0; i < pkgCandidates.length; i++) {
    const t1 = pkgCandidates[i];
    if (!pkgCorrMatrix[t1]) pkgCorrMatrix[t1] = {};
    for (let j = i + 1; j < pkgCandidates.length; j++) {
      const t2 = pkgCandidates[j];
      if (!pkgCorrMatrix[t2]) pkgCorrMatrix[t2] = {};
      const r = pearsonFromCloses(chartDataMap[t1], chartDataMap[t2]);
      pkgCorrMatrix[t1][t2] = r;
      pkgCorrMatrix[t2][t1] = r;
    }
  }

  // Step 3: Find best 3-ticker combination (max spread, min correlation)
  let bestCombo = null;
  let bestScore = -Infinity;
  const CORR_LAMBDA = 15;
  for (let i = 0; i < pkgCandidates.length; i++) {
    for (let j = i + 1; j < pkgCandidates.length; j++) {
      for (let k = j + 1; k < pkgCandidates.length; k++) {
        const t1 = pkgCandidates[i], t2 = pkgCandidates[j], t3 = pkgCandidates[k];
        const r12 = pkgCorrMatrix[t1][t2], r13 = pkgCorrMatrix[t1][t3], r23 = pkgCorrMatrix[t2][t3];
        if (r12 == null || r13 == null || r23 == null) continue;
        const avgCorr = (Math.abs(r12) + Math.abs(r13) + Math.abs(r23)) / 3;
        const avgSpread = (avgCallSpread2[t1] + avgCallSpread2[t2] + avgCallSpread2[t3]) / 3;
        const score = avgSpread - CORR_LAMBDA * avgCorr;
        if (score > bestScore) {
          bestScore = score;
          bestCombo = {
            tickers: [t1, t2, t3],
            avgSpread, avgCorr,
            spreads: [avgCallSpread2[t1], avgCallSpread2[t2], avgCallSpread2[t3]],
            corrs: { r12, r13, r23 },
          };
        }
      }
    }
  }

  // Compute average weighted IV and ATM IV across all tickers with data
  const ivTickers = Object.keys(tickerIVs);
  let avgCallIV = 0, avgPutIV = 0, avgAtmCallIV = 0, avgAtmPutIV = 0;
  if (ivTickers.length > 0) {
    avgCallIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].callIV, 0) / ivTickers.length * 10) / 10;
    avgPutIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].putIV, 0) / ivTickers.length * 10) / 10;
    avgAtmCallIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].atmCallIV, 0) / ivTickers.length * 10) / 10;
    avgAtmPutIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].atmPutIV, 0) / ivTickers.length * 10) / 10;
  }

  // Map Outcome-Contrast features by "group:label" for per-cell outcome-lean tinting.
  const contrastByKey = {};
  if (preEventContrast && preEventContrast.ok) {
    for (const u of preEventContrast.uni) contrastByKey[u.group + ':' + u.label] = u;
  }
  // Background tint reflecting which eventual-event direction a ticker's value leans toward,
  // per the Pre-Event IV → Outcome Contrast. Green = leans positive event, red = leans negative.
  // '' when no contrast data (cell falls back to its existing styling).
  const leanBg = (group, label, v) => {
    if (v == null) return '';
    const u = contrastByKey[group + ':' + label];
    if (!u || u.diff === 0) return '';
    const mid = (u.meanPos + u.meanNeg) / 2;
    const signal = (v - mid) * Math.sign(u.diff); // >0 → positive side, <0 → negative side
    if (signal === 0) return '';
    const alpha = Math.min(0.30, 0.08 + Math.abs(u.d) * 0.28); // floor + scale by |Cohen's d|
    const rgb = signal > 0 ? '72,187,120' : '245,101,101';     // existing green / red palette
    return ` background:rgba(${rgb},${alpha.toFixed(2)});`;
  };

  const rows = allTickers.map((h, idx) => {
    const hasEvent = !!h.classification;
    const color = classColors[h.classification] || '#ccc';
    const label = classLabels[h.classification] || '';
    const hasChart = !!chartDataMap[h.ticker];
    const isDeleted = deleteSet.has(h.ticker);
    const inlineStyle = (hasEvent ? '' : 'color:#aaa;') + (hasChart ? ' cursor:pointer;' : '') + (isDeleted ? ' opacity:0.4; text-decoration:line-through;' : '');

    const mcap = h.marketCap || 0;
    const mcapStr = mcap >= 1e9 ? (mcap / 1e9).toFixed(1) + 'B' : mcap >= 1e6 ? (mcap / 1e6).toFixed(0) + 'M' : '';

    const optDV = tickerOptDV[h.ticker] || 0;
    const optDVStr = optDV >= 1e9 ? '$' + (optDV / 1e9).toFixed(1) + 'B' : optDV >= 1e6 ? '$' + (optDV / 1e6).toFixed(1) + 'M' : optDV >= 1e3 ? '$' + (optDV / 1e3).toFixed(0) + 'K' : optDV > 0 ? '$' + optDV.toFixed(0) : '';

    const tiv = tickerIVs[h.ticker];
    const callSpread = tiv ? tiv.ivSpreadCall : null;
    const putSpread = tiv ? tiv.ivSpreadPut : null;
    const stats = ivHistStats[h.ticker];
    const rankTag = (r) => r != null ? ` <span style="color:#888; font-size:0.78em;">(p${r})</span>` : '';
    const sectorRankTag = (r) => r != null ? ` <span style="color:#6a8; font-size:0.78em;">[s${r}]</span>` : '';
    const tagRankTag = (r, tag) => r != null ? ` <span style="color:#d4a657; font-size:0.78em;" title="vs ${tag} cohort">{t${r}}</span>` : '';
    const callIVRank = stats && tiv ? pctRank(stats.callIVs, tiv.callIV) : null;
    const putIVRank = stats && tiv ? pctRank(stats.putIVs, tiv.putIV) : null;
    const MIN_SPREAD_RECORDS = 3;
    const callSpreadRank = stats && stats.callSpreads && stats.callSpreads.length >= MIN_SPREAD_RECORDS && callSpread != null ? pctRank(stats.callSpreads, callSpread) : null;
    const putSpreadRank = stats && stats.putSpreads && stats.putSpreads.length >= MIN_SPREAD_RECORDS && putSpread != null ? pctRank(stats.putSpreads, putSpread) : null;
    // Sector-based spread rank: percentile within all historical spreads of same sector
    const sec = tickerSectors[h.ticker];
    const secData = sec ? sectorSpreads[sec] : null;
    const callSectorRank = secData && callSpread != null && secData.callSpreads.length >= MIN_HIST_RECORDS ? pctRank(secData.callSpreads, callSpread) : null;
    const putSectorRank = secData && putSpread != null && secData.putSpreads.length >= MIN_HIST_RECORDS ? pctRank(secData.putSpreads, putSpread) : null;
    // Tag-cohort rank: percentile within historical records carrying the ticker's strongest tag.
    // Uses first tag (highest score). Requires the same MIN_HIST_RECORDS as sector to keep it meaningful.
    const primaryTag = Array.isArray(h.eventTags) && h.eventTags.length > 0 ? h.eventTags[0] : null;
    const tagData = primaryTag ? tagSpreads[primaryTag] : null;
    const callTagRank = tagData && callSpread != null && tagData.callSpreads.length >= MIN_HIST_RECORDS ? pctRank(tagData.callSpreads, callSpread) : null;
    const putTagRank = tagData && putSpread != null && tagData.putSpreads.length >= MIN_HIST_RECORDS ? pctRank(tagData.putSpreads, putSpread) : null;
    const callIVStr = tiv ? tiv.callIV.toFixed(1) + '%' + rankTag(callIVRank) : '';
    const putIVStr = tiv ? tiv.putIV.toFixed(1) + '%' + rankTag(putIVRank) : '';
    const callIVVal = tiv ? tiv.callIV : -1;
    const putIVVal = tiv ? tiv.putIV : -1;
    const callSpreadStr = callSpread != null ? (callSpread >= 0 ? '+' : '') + callSpread.toFixed(1) + rankTag(callSpreadRank) + sectorRankTag(callSectorRank) + tagRankTag(callTagRank, primaryTag) : '';
    const putSpreadStr = putSpread != null ? (putSpread >= 0 ? '+' : '') + putSpread.toFixed(1) + rankTag(putSpreadRank) + sectorRankTag(putSectorRank) + tagRankTag(putTagRank, primaryTag) : '';
    const callSpreadVal = callSpread != null ? callSpread : -9999;
    const putSpreadVal = putSpread != null ? putSpread : -9999;
    const peSl = peLiveSlopeByTicker[h.ticker];
    const callAtmSlope = peSl && peSl.callAtm != null ? peSl.callAtm : null;
    const callSprSlope = peSl && peSl.callSpr != null ? peSl.callSpr : null;
    const slopeStr = (v) => v == null ? '' : (v > 0 ? '↑ +' : v < 0 ? '↓ ' : '') + v.toFixed(0);
    const slopeColor = (v) => v == null ? '#888' : v > 0 ? 'rgba(72,187,120,0.9)' : v < 0 ? 'rgba(245,101,101,0.9)' : '#888';
    const callAtmSlopeVal = callAtmSlope != null ? callAtmSlope : -9999;
    const callSprSlopeVal = callSprSlope != null ? callSprSlope : -9999;
    const dvDelta = peSl && peSl.dvDelta != null ? peSl.dvDelta : null;
    const dvDeltaStr = dvDelta == null ? '' : (dvDelta > 0 ? '↑ +' : dvDelta < 0 ? '↓ ' : '') + dvDelta.toFixed(0);
    const dvDeltaVal = dvDelta != null ? dvDelta : -1e9;


    const noteText = (notes && notes[h.ticker]) ? notes[h.ticker] : '';
    const hasNote = !!noteText;
    const noteIndicator = hasNote ? ' <span title="Has note" style="font-size:0.75em;">📝</span>' : '';

    const evTags = Array.isArray(h.eventTags) ? h.eventTags : [];
    const evEvidence = h.eventTagEvidence || {};
    const tagsAttr = evTags.join(' ');
    const tagsCell = evTags.map(id => {
      const lbl = EVENT_TAG_LABELS[id] || id;
      const ev = evEvidence[id];
      const tip = ev ? `score ${ev.score} · ${ev.headline.replace(/"/g, '&quot;')}` : id;
      return `<span class="event-tag" data-tag="${id}" title="${tip}" style="display:inline-block; margin:1px 3px 1px 0; padding:1px 6px; background:#2c3a4a; color:#cdd5e0; border:1px solid #3d4f63; border-radius:8px; font-size:0.74em; cursor:pointer; white-space:nowrap;">${lbl}</span>`;
    }).join('');
    const tagsSortKey = evTags.length > 0 ? evTags[0] : 'zzz';
    const eventProb = typeof h.eventProbability === 'number' ? h.eventProbability : null;
    const eventProbStr = eventProb != null ? (eventProb * 100).toFixed(1) + '%' : '';
    const eventProbColor = eventProb == null ? '#888' : eventProb >= 0.6 ? 'rgba(245,101,101,0.9)' : eventProb >= 0.4 ? '#d4a657' : 'rgba(72,187,120,0.9)';

    // Last regular-session close vs the latest quote. Outside RTH the quote is the
    // pre/post-market print, so the delta between them is the extended-hours move.
    // Both are display-only: neither feeds the event/gap math.
    const lastCloseNum = typeof h.lastClose === 'number' && h.lastClose > 0 ? h.lastClose : null;
    const latestPriceNum = typeof h.latestPrice === 'number' && h.latestPrice > 0 ? h.latestPrice : null;
    const latestPriceVal = latestPriceNum != null ? latestPriceNum : -1;
    const extMovePct = (lastCloseNum != null && latestPriceNum != null)
      ? ((latestPriceNum - lastCloseNum) / lastCloseNum) * 100
      : null;
    // Only annotate a move once it is meaningful; sub-0.05% is quote noise.
    const extMoveShown = extMovePct != null && Math.abs(extMovePct) >= 0.05;
    const latestPriceStr = latestPriceNum != null
      ? latestPriceNum.toFixed(2) + (extMoveShown ? ` <span style="font-size:0.82em;">(${extMovePct > 0 ? '+' : ''}${extMovePct.toFixed(2)}%)</span>` : '')
      : '';
    const extMoveColor = !extMoveShown ? '#bbb' : extMovePct > 0 ? 'rgba(72,187,120,0.9)' : 'rgba(245,101,101,0.9)';
    const extTitle = (lastCloseNum != null && latestPriceNum != null)
      ? `Close ${lastCloseNum.toFixed(2)} → last ${latestPriceNum.toFixed(2)}`
      : 'Latest quoted price (includes extended hours)';

    return `<tr ${hasChart ? `class="data-row" data-ticker="${h.ticker}"` : ''} data-tags="${tagsAttr}" style="${inlineStyle}">
      <td style="text-align:center; width:44px; padding:4px; white-space:nowrap;"><span class="del-mark" data-ticker="${h.ticker}" style="cursor:pointer; font-size:0.95em; color:${isDeleted ? '#e53935' : '#555'};" title="${isDeleted ? 'Marked to delete (click to unmark)' : 'Mark to delete'}">✕</span></td>
      <td data-v="${h.ticker}" style="font-weight:bold;">${h.ticker}${hasChart ? ' <span style="font-size:0.7em;color:#aaa;">▶</span>' : ''}${noteIndicator}${suggestedSet.has(h.ticker) ? ` <span style="font-size:0.68em; font-weight:600; color:#b48cff; border:1px solid #4a3a6a; background:#241f33; border-radius:4px; padding:1px 5px; vertical-align:middle;" title="Randomly drawn from the rebuild top 100 for this run">shuffle</span> <button class="add-screen-btn" data-ticker="${h.ticker}" style="font-size:0.72em; margin-left:4px; padding:1px 7px; border-radius:4px; border:1px solid #3a5a3a; background:#1e2b1e; color:#8fce8f; cursor:pointer; vertical-align:middle;" title="Permanently add ${h.ticker} to the screening list">＋ Add</button>` : ''}</td>
      <td data-v="${sec || 'zzz'}" style="font-size:0.82em; color:#888;">${sec || ''}</td>
      <td data-v="${tagsSortKey}" style="font-size:0.82em; max-width:240px;">${tagsCell}</td>
      <td data-v="${h.classification || 'zzz'}" style="color:${color}; font-weight:bold;">${label}</td>
      <td data-v="${eventProb != null ? eventProb : -1}" style="text-align:right; color:${eventProbColor}; font-weight:600;" title="TTM-R3 next-day event probability">${eventProbStr}</td>
      <td data-v="${latestPriceVal}" style="text-align:right; color:${extMoveColor};" title="${extTitle}">${latestPriceStr}</td>
      <td data-v="${mcap}" style="text-align:right;">${mcapStr}</td>
      <td data-v="${optDV}" style="text-align:right;">${optDVStr}</td>
      <td data-v="${dvDeltaVal}" style="text-align:right; color:${slopeColor(dvDelta)}; font-size:0.88em;${leanBg('dv','Opt $Vol Δrank',dvDelta)}">${dvDeltaStr}</td>
      <td data-v="${callIVVal}" style="text-align:right; color:rgba(72,187,120,0.9);${leanBg('lvl','Call OTM',callIVRank)}">${callIVStr}</td>
      <td data-v="${callSpreadVal}" style="text-align:right; color:rgba(72,187,120,0.7); font-size:0.88em;${leanBg('lvl','Call Spr',callSpreadRank)}">${callSpreadStr}</td>
      <td data-v="${callAtmSlopeVal}" style="text-align:right; color:${slopeColor(callAtmSlope)}; font-size:0.88em;${leanBg('slp','Call ATM Δ',callAtmSlope)}">${slopeStr(callAtmSlope)}</td>
      <td data-v="${callSprSlopeVal}" style="text-align:right; color:${slopeColor(callSprSlope)}; font-size:0.88em;${leanBg('slp','Call Spr Δ',callSprSlope)}">${slopeStr(callSprSlope)}</td>
      <td data-v="${putIVVal}" style="text-align:right; color:rgba(245,101,101,0.9);${leanBg('lvl','Put OTM',putIVRank)}">${putIVStr}</td>
      <td data-v="${putSpreadVal}" style="text-align:right; color:rgba(245,101,101,0.7); font-size:0.88em;${leanBg('lvl','Put Spr',putSpreadRank)}">${putSpreadStr}</td>
    </tr>
    <tr class="chart-row" data-chart-for="${h.ticker}" style="display:none;">
      <td colspan="16" style="padding:0; background:#1a1d23;">
        <div style="display:flex; gap:12px; align-items:stretch; margin:12px 20px 8px;">
          <div id="summary-${h.ticker}" style="flex:0 1 78ch; padding:14px 18px; background:#262a33; border-left:3px solid #4a5a8a; border-radius:6px; color:#cdd5e0; font-size:0.98em; line-height:1.65; max-height:200px; overflow-y:auto;"></div>
          <div style="flex:1 1 0; min-width:280px; height:200px; background:#262a33; border-radius:6px; padding:6px 10px;">
            <canvas id="dv-iv-chart-${h.ticker}"></canvas>
          </div>
        </div>
        <div id="dv-iv-strike-wrap-${h.ticker}" style="display:none; margin:0 20px 8px; padding:10px 14px; background:#262a33; border-left:3px solid #7aa2c7; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span id="dv-iv-strike-title-${h.ticker}" style="color:#cdd5e0; font-size:0.92em;"></span>
            <button type="button" data-strike-close="${h.ticker}" style="background:transparent; color:#888; border:1px solid #444; border-radius:3px; padding:2px 8px; font-size:0.8em; cursor:pointer;">close</button>
          </div>
          <div id="dv-iv-strike-body-${h.ticker}"></div>
        </div>
        <div style="padding:6px 20px 8px; display:flex; gap:8px; align-items:flex-start;">
          <label style="color:#aaa; font-size:0.82em; padding-top:6px; min-width:48px;">Notes</label>
          <textarea class="ticker-note" data-ticker="${h.ticker}" placeholder="Add a note about ${h.ticker}..." style="flex:1; min-height:42px; padding:6px 8px; border:1px solid #333; border-radius:4px; background:#15171c; color:#ddd; font-size:0.88em; font-family:inherit; resize:vertical;">${noteText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
          <span class="note-status" data-ticker="${h.ticker}" style="color:#888; font-size:0.78em; padding-top:8px; min-width:54px;"></span>
        </div>
        <div style="padding:12px 16px; height:480px;">
          <canvas id="chart-${h.ticker}"></canvas>
        </div>
        <div id="opts-wrap-${h.ticker}" style="display:none; padding:8px 16px 4px;">
          <div style="display:flex; gap:8px;">
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-0-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-0-${h.ticker}"></canvas></div>
            </div>
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-1-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-1-${h.ticker}"></canvas></div>
            </div>
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-2-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-2-${h.ticker}"></canvas></div>
            </div>
          </div>
          <div id="iv-history-wrap-${h.ticker}" style="display:none; padding:8px 0; height:420px;">
            <canvas id="iv-history-chart-${h.ticker}"></canvas>
          </div>
        </div>
        <div id="news-${h.ticker}" style="padding:4px 20px 14px;"></div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Ticker Screening Results</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #1a1d23; color: #eaeaea; }
  h1 { font-size: 1.4em; margin-bottom: 4px; color: #a8b5a2; }
  .summary { color: #a0aec0; margin-bottom: 16px; font-size: 0.95em; }
  table { width: 100%; border-collapse: collapse; background: #262a33; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
  #screen-table th { background: #2f3540; padding: 10px 12px; text-align: left; font-size: 0.85em; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none; }
  #screen-table th:hover { color: #fff; background: #3a414d; }
  #screen-table th .sort-arrow { font-size: 0.7em; margin-left: 3px; color: #5a6a8a; }
  #screen-table th.sorted-asc .sort-arrow, #screen-table th.sorted-desc .sort-arrow { color: #fff; }
  td { padding: 8px 12px; border-top: 1px solid #2e333d; font-size: 0.95em; }
  tr.data-row:hover { background: #2c303a; }
  tr:hover { background: #22252c; }
  .chart-row td { border-top: none; }
  input, textarea { background: #15171c; color: #ddd; border: 1px solid #333; }
  input::placeholder, textarea::placeholder { color: #6a7590; }
  /* Override inline light-theme colors used throughout the generated markup */
  [style*="background:#fff"] { background: #262a33 !important; }
  [style*="background: #fff"] { background: #262a33 !important; }
  [style*="background:#f7f9fc"] { background: #22252c !important; }
  [style*="background:#f9f9f9"] { background: #22252c !important; }
  [style*="background:#f5f5f5"] { background: #2f3540 !important; }
  [style*="color:#333"] { color: #eaeaea !important; }
  [style*="color:#444"] { color: #eaeaea !important; }
  [style*="color:#666"] { color: #a0aec0 !important; }
  [style*="color:#888"] { color: #8a96b0 !important; }
  [style*="color:#999"] { color: #7a8499 !important; }
  [style*="color:#aaa"] { color: #6a7590 !important; }
  [style*="color:#bbb"] { color: #5a6680 !important; }
  #fav-toast { position:fixed; bottom:20px; right:20px; padding:8px 16px; border-radius:6px; font-size:0.9em; color:#fff; opacity:0; transition:opacity 0.3s; pointer-events:none; z-index:9999; }
  #fav-toast.show { opacity:1; }
</style></head><body>
<div id="fav-toast"></div>
<h1>Ticker Screening Results</h1>
<p class="summary">${hitCount} hit${hitCount !== 1 ? 's' : ''} out of ${totalTickers} tickers screened &mdash; ${config.screenLookbackDays}d lookback, p${config.screenPercentileThreshold} threshold</p>
${(() => {
  if (!freshness) return '';
  const tiers = {
    realtime: ['#2e7d32', 'Real-time'],
    delayed: ['#ef6c00', 'Delayed'],
    stale: ['#d32f2f', 'Stale'],
    'previous-session': ['#c62828', 'Previous session'],
  };
  const [color, label] = tiers[freshness.tier] || ['#666', freshness.tier];
  const fmtLocal = (iso) => new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const srcs = Object.entries(freshness.sources)
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <span style="color:#666; font-weight:600;">Data freshness:</span>
  <span style="color:${color}; font-weight:bold; margin-left:10px;">${label}</span>
  <span style="color:#666; margin-left:10px;">median age</span>
  <span style="color:${color}; font-weight:bold; margin-left:4px;">${formatAge(freshness.medianAgeMs)}</span>
  <span style="color:#999; margin-left:6px;">(mean ${formatAge(freshness.meanAgeMs)})</span>
  <span style="color:#999; margin-left:16px;">|</span>
  <span style="color:#666; font-weight:600; margin-left:16px;">Avg quote time:</span>
  <span style="color:#333; font-weight:bold; margin-left:6px;">${fmtLocal(freshness.meanQuoteTime)}</span>
  <div style="color:#999; font-size:0.85em; margin-top:5px;">
    Newest ${fmtLocal(freshness.newestQuoteTime)} (${freshness.newestTicker}) &middot;
    oldest ${fmtLocal(freshness.oldestQuoteTime)} (${freshness.oldestTicker}) &middot;
    ${freshness.sampleCount} tickers sampled &middot; ${srcs}
  </div>
</div>`;
})()}
${ivTickers.length > 0 ? `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <span style="color:#666; font-weight:600;">Avg Weighted IV (${ivTickers.length} tickers):</span>
  <span style="color:rgba(72,187,120,0.9); font-weight:bold; margin-left:10px;">Call ${avgCallIV.toFixed(1)}%</span>
  <span style="color:rgba(245,101,101,0.9); font-weight:bold; margin-left:10px;">Put ${avgPutIV.toFixed(1)}%</span>
  <span style="color:#999; margin-left:16px;">|</span>
  <span style="color:#666; font-weight:600; margin-left:16px;">Avg ATM IV:</span>
  <span style="color:rgba(72,187,120,0.7); font-weight:bold; margin-left:10px;">Call ${avgAtmCallIV.toFixed(1)}%</span>
  <span style="color:rgba(245,101,101,0.7); font-weight:bold; margin-left:10px;">Put ${avgAtmPutIV.toFixed(1)}%</span>
</div>` : ''}
${(() => {
  const order = [
    ['surprising_positive', 'Surprising +', '#4caf50'],
    ['positive_anticipated', 'Anticipated +', '#8bc34a'],
    ['negative_anticipated', 'Anticipated -', '#ff9800'],
    ['surprising_negative', 'Surprising -', '#f44336'],
  ];
  const any = order.some(([k]) => preEventStats[k] && preEventStats[k].n > 0);
  if (!any) return '';
  // Percentile rank, range 0–100, neutral = 50 (OTM IV rank and spread rank, calls & puts).
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 70) color = '#d32f2f';
    else if (v >= 60) color = '#ef6c00';
    else if (v <= 30) color = '#1565c0';
    else if (v <= 40) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const binColor = (center) => {
    if (center >= 70) return '#d32f2f';
    if (center >= 60) return '#ef6c00';
    if (center <= 30) return '#1565c0';
    if (center <= 40) return '#0277bd';
    return '#9e9e9e';
  };
  const MAXH = 56; // px, tallest bar
  const renderHist = (counts, mean, n, hMin, hBinW, hN) => {
    if (!n || !counts) return '<div style="color:#bbb; font-size:0.85em; padding:8px 0;">—</div>';
    const maxC = Math.max(1, ...counts);
    const bars = counts.map((c, i) => {
      const lo = hMin + i * hBinW;
      const center = lo + hBinW / 2;
      const h = c === 0 ? 0 : Math.max(2, Math.round((c / maxC) * MAXH));
      return `<div title="[${lo}, ${lo + hBinW}) — ${c}" style="flex:1; display:flex; flex-direction:column; justify-content:flex-end;">
        <div style="height:${h}px; background:${binColor(center)}; border-radius:1px 1px 0 0;"></div></div>`;
    }).join('');
    const meanPct = ((mean - hMin) / (hBinW * hN)) * 100;
    return `<div style="position:relative; min-width:200px;">
      <div style="display:flex; align-items:flex-end; gap:1px; height:${MAXH}px; border-bottom:1px solid #ddd;">${bars}</div>
      <div style="position:absolute; left:50%; top:0; bottom:18px; border-left:1px dashed #ccc;"></div>
      <div title="mean ${mean == null ? '—' : mean.toFixed(1)}" style="position:absolute; left:${meanPct}%; top:-4px; bottom:18px; border-left:2px solid #111; transform:translateX(-1px);"></div>
      <div style="display:flex; justify-content:space-between; color:#aaa; font-size:0.72em; margin-top:2px;"><span>0</span><span>50</span><span>100</span></div>
      <div style="color:#888; font-size:0.78em; margin-top:1px;">mean <b>${mean == null ? '—' : mean.toFixed(1)}</b> · n=${n}</div>
    </div>`;
  };
  const histCell = (lab, counts, mean, nn, s) => `<div><div style="color:#888; font-size:0.78em; margin-bottom:2px;">${lab}</div>${renderHist(counts, mean, nn, s.histMin, s.histBinW, s.histNBins)}</div>`;
  // #2 Anticipation trajectory: point-in-time rank by trading days before the event.
  const trajCell = (st) => (st && st.mean != null && st.n)
    ? `<td style="padding:3px 10px; text-align:right;">${fmtRank(st.mean, st.n)}</td>`
    : '<td style="padding:3px 10px; text-align:right; color:#bbb;">—</td>';
  const trajRow = (lab, tr) => {
    const slope = (tr && tr.t1.mean != null && tr.t3.mean != null) ? tr.t1.mean - tr.t3.mean : null;
    const slopeCell = slope == null
      ? '<td style="padding:3px 10px; text-align:right; color:#bbb;">—</td>'
      : `<td style="padding:3px 10px; text-align:right; font-weight:600; color:${slope >= 8 ? '#d32f2f' : slope <= -8 ? '#1565c0' : '#666'};">${slope >= 0 ? '+' : ''}${slope.toFixed(0)}</td>`;
    return `<tr><td style="padding:3px 10px; color:#888;">${lab}</td>${trajCell(tr && tr.t3)}${trajCell(tr && tr.t2)}${trajCell(tr && tr.t1)}${slopeCell}</tr>`;
  };
  const trajTable = (s) => {
    if (!s.traj) return '';
    const ms = [['callOtm', 'Call OTM'], ['callAtm', 'Call ATM'], ['callSpr', 'Call Spr'], ['putOtm', 'Put OTM'], ['putAtm', 'Put ATM'], ['putSpr', 'Put Spr']];
    const body = ms.map(([m, l]) => trajRow(l, s.traj[m])).join('');
    return `<div style="margin-top:12px;">
      <div style="color:#888; font-size:0.78em; margin-bottom:3px;">Anticipation trajectory — point-in-time rank by trading days before the event (slope = T-1 − T-3; &gt;0 = IV ramping into the event, &lt;0 = bleeding off)</div>
      <table style="border-collapse:collapse; font-size:0.9em;">
        <thead><tr style="color:#999; font-size:0.78em; text-transform:uppercase;">
          <th style="padding:3px 10px; text-align:left;">Metric</th>
          <th style="padding:3px 10px; text-align:right;">T-3</th>
          <th style="padding:3px 10px; text-align:right;">T-2</th>
          <th style="padding:3px 10px; text-align:right;">T-1</th>
          <th style="padding:3px 10px; text-align:right;">Slope</th>
        </tr></thead><tbody>${body}</tbody>
      </table></div>`;
  };
  const rows = order.map(([k, label, color]) => {
    const s = preEventStats[k] || {};
    const n = s.n || 0;
    if (n === 0) {
      return `<tr style="color:#bbb;">
        <td style="padding:6px 10px 6px 24px; font-weight:bold; color:${color};">${label}</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
      </tr>`;
    }
    const toggle = `var d=document.getElementById('pe-d-${k}');var o=d.style.display==='none';d.style.display=o?'':'none';this.querySelector('.pe-caret').textContent=o?'▾':'▸';`;
    return `<tr style="cursor:pointer;" onclick="${toggle}" title="Click to show the distributions">
      <td style="padding:6px 10px; font-weight:bold; color:${color};"><span class="pe-caret" style="display:inline-block; width:14px; color:#999;">▸</span>${label}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callOtmMean, s.callOtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callAtmMean, s.callAtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callSprMean, s.callSprN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putOtmMean, s.putOtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putAtmMean, s.putAtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putSprMean, s.putSprN)}</td>
    </tr>
    <tr id="pe-d-${k}" style="display:none;">
      <td colspan="7" style="padding:4px 10px 12px 24px; background:#fafafa;">
        <div style="display:flex; gap:24px; flex-wrap:wrap;">
          ${histCell('Call OTM IV rank', s.callOtmHist, s.callOtmMean, s.callOtmN, s)}
          ${histCell('Call ATM IV rank', s.callAtmHist, s.callAtmMean, s.callAtmN, s)}
          ${histCell('Call spread rank', s.callSprHist, s.callSprMean, s.callSprN, s)}
          ${histCell('Put OTM IV rank', s.putOtmHist, s.putOtmMean, s.putOtmN, s)}
          ${histCell('Put ATM IV rank', s.putAtmHist, s.putAtmMean, s.putAtmN, s)}
          ${histCell('Put spread rank', s.putSprHist, s.putSprMean, s.putSprN, s)}
        </div>
        <div style="color:#aaa; font-size:0.72em; margin-top:6px;">x-axis 0…100, 50 = neutral · dashed line = 50 · black line = mean</div>
        ${trajTable(s)}
      </td>
    </tr>`;
  }).join('');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">Pre-Event IV Profile <span style="color:#999; font-weight:normal; font-size:0.9em;">(per-event weighted-OTM-IV, weighted-ATM-IV and IV-spread percentile ranks within that ticker's own point-in-time history, denoised by averaging the last ≤3 contiguous daily snapshots before the event then averaged across events; range 0–100, 50 = neutral, &gt;60 = elevated, &lt;40 = suppressed)</span></div>
    <div style="color:#aaa; font-size:0.78em; margin-bottom:6px;">Requires ≥10 history records before the event date. Headline = per-event mean of the last ≤3 contiguous daily snapshots before the event. (n) = events contributing. Click a row for distributions and the pre-event anticipation trajectory.</div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Classification</th>
        <th style="padding:4px 10px; text-align:right;">Call OTM</th>
        <th style="padding:4px 10px; text-align:right;">Call ATM</th>
        <th style="padding:4px 10px; text-align:right;">Call Spr</th>
        <th style="padding:4px 10px; text-align:right;">Put OTM</th>
        <th style="padding:4px 10px; text-align:right;">Put ATM</th>
        <th style="padding:4px 10px; text-align:right;">Put Spr</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
})()}
${(() => {
  const C = preEventContrast;
  const card = (inner) => `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">${inner}</div>`;
  const head = `<div style="color:#666; font-weight:600; margin-bottom:4px;">Pre-Event IV → Outcome Contrast <span style="color:#999; font-weight:normal; font-size:0.9em;">(positive vs negative outcomes — surprising + anticipated pooled by direction; tests whether the pre-event IV configuration leans toward the eventual direction. Δ = window slope feature.)</span></div>`;
  if (!C || !C.ok) {
    return card(`${head}<div style="color:#aaa; font-size:0.85em;">${C ? C.reason : 'No data.'}</div>`);
  }
  // Effect-size / coefficient coloring: matches the Pre-Event panel's rank palette
  // — red/orange = elevated toward S+, blue = leaning toward S−, gray = weak.
  const dColor = (v) => {
    const a = Math.abs(v);
    if (v > 0) return a >= 0.5 ? '#d32f2f' : a >= 0.2 ? '#ef6c00' : '#9e9e9e';
    return a >= 0.5 ? '#1565c0' : a >= 0.2 ? '#0277bd' : '#9e9e9e';
  };
  const fmtP = (p) => p < 0.001 ? '&lt;0.001' : p.toFixed(3);
  const uniRows = C.uni.map((u) => `<tr>
    <td style="padding:5px 10px; ${u.group === 'slp' ? 'color:#888;' : 'font-weight:600;'}">${u.label}</td>
    <td style="padding:5px 10px; text-align:right;">${u.meanPos.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right;">${u.meanNeg.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right; color:${dColor(u.diff)};">${u.diff >= 0 ? '+' : ''}${u.diff.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right; font-weight:600; color:${dColor(u.d)};">${u.d >= 0 ? '+' : ''}${u.d.toFixed(2)}</td>
    <td style="padding:5px 10px; text-align:right; ${u.p < 0.05 ? 'font-weight:600; color:#333;' : 'color:#aaa;'}">${fmtP(u.p)}</td>
  </tr>`).join('');
  const uniTable = `<div style="color:#888; font-size:0.78em; margin:8px 0 3px;">Per-feature contrast (raw, un-imputed). Cohen's d = standardized effect size; |d|≈0.2 small, 0.5 medium. Sorted by |d|.</div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.78em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Feature</th>
        <th style="padding:4px 10px; text-align:right;">Pos mean</th>
        <th style="padding:4px 10px; text-align:right;">Neg mean</th>
        <th style="padding:4px 10px; text-align:right;">Δ</th>
        <th style="padding:4px 10px; text-align:right;">Cohen's d</th>
        <th style="padding:4px 10px; text-align:right;">p</th>
      </tr></thead><tbody>${uniRows}</tbody>
    </table>`;

  return card(`${head}${uniTable}`);
})()}
${(() => {
  if (!preEventByReturnBucket) return '';
  const fmtRet = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 30) color = '#d32f2f';
    else if (v >= 15) color = '#ef6c00';
    else if (v <= -30) color = '#1565c0';
    else if (v <= -15) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const bLabel = (label, b) => `${label} <span style="color:#999; font-weight:normal; font-size:0.85em;">[${fmtRet(b.minReturn)} … ${fmtRet(b.maxReturn)}]</span> <span style="color:#aaa; font-size:0.85em;">n=${b.n}</span>`;
  const buckets = [
    ['Low Returns', '#1565c0', 'low'],
    ['High Returns', '#d32f2f', 'high'],
  ];

  // Original: Call/Put Δrank = R(OTM) - R(spread), averaged per bucket.
  const rows1 = buckets.map(([label, color, k]) => {
    const b = preEventByReturnBucket[k];
    return `<tr>
      <td style="padding:6px 10px; font-weight:bold; color:${color};">${bLabel(label, b)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(b.callAvgRank, b.nCallAvg)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(b.putAvgRank, b.nPutAvg)}</td>
    </tr>`;
  }).join('');

  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">IV Profile by Daily Return Bucket <span style="color:#999; font-weight:normal; font-size:0.9em;">(median split on next-day return; per-day weighted-OTM-IV rank minus spread rank from the day before, averaged across the bucket — range -100 to +100, 0 = neutral; tests if high rank precedes high vs low next-day return)</span></div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Bucket</th>
        <th style="padding:4px 10px; text-align:right;">Call &Delta;rank</th>
        <th style="padding:4px 10px; text-align:right;">Put &Delta;rank</th>
      </tr></thead>
      <tbody>${rows1}</tbody>
    </table>
  </div>`;
})()}
<div id="portfolio-corr-box" style="margin-bottom:14px; padding:12px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <div style="color:#666; font-weight:600; margin-bottom:6px;">Portfolio Correlation Check</div>
  <div style="display:flex; align-items:center; gap:10px;">
    <input id="portfolio-corr-input" type="text" placeholder="e.g. AAPL, MSFT, NVDA" style="flex:1; padding:7px 10px; border:1px solid #ddd; border-radius:6px; font-size:0.95em; outline:none;" />
    <button id="portfolio-corr-btn" style="padding:7px 16px; border:none; border-radius:6px; background:#5b8cb8; color:#fff; font-size:0.9em; cursor:pointer;">Check</button>
  </div>
  <div id="portfolio-corr-result" style="margin-top:8px;"></div>
</div>
${bestCombo ? `<div style="margin-bottom:14px; padding:12px 16px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.93em;">
  <div style="color:#444; font-weight:700; margin-bottom:8px;">
    Package Suggestion
    <span style="color:#999; font-weight:normal; font-size:0.85em; margin-left:8px;">(best 3-ticker combo: max avg call spread, min pairwise correlation &mdash; 2-snapshot avg)</span>
  </div>
  <div style="display:flex; gap:24px; align-items:center; flex-wrap:wrap;">
    ${bestCombo.tickers.map((t, i) => `<div style="background:#f7f9fc; border-radius:6px; padding:8px 14px; min-width:120px;">
        <div style="font-weight:bold; font-size:1.05em; color:#333;">${t}</div>
        <div style="color:rgba(72,187,120,0.85); font-size:0.88em; margin-top:2px;">Avg C Spr: ${bestCombo.spreads[i] >= 0 ? '+' : ''}${bestCombo.spreads[i].toFixed(1)}</div>
      </div>`).join('')}
    <div style="color:#888; font-size:0.85em; line-height:1.6;">
      <div>Avg |corr|: <span style="color:${bestCombo.avgCorr < 0.3 ? '#4caf50' : bestCombo.avgCorr < 0.6 ? '#ff9800' : '#f44336'}; font-weight:600;">${bestCombo.avgCorr.toFixed(2)}</span></div>
      <div>Avg Call Spread: <span style="color:rgba(72,187,120,0.9); font-weight:600;">${bestCombo.avgSpread >= 0 ? '+' : ''}${bestCombo.avgSpread.toFixed(1)}</span></div>
      <div style="font-size:0.82em; color:#bbb;">Corr: ${bestCombo.tickers[0]}/${bestCombo.tickers[1]}=${bestCombo.corrs.r12.toFixed(2)}, ${bestCombo.tickers[0]}/${bestCombo.tickers[2]}=${bestCombo.corrs.r13.toFixed(2)}, ${bestCombo.tickers[1]}/${bestCombo.tickers[2]}=${bestCombo.corrs.r23.toFixed(2)}</div>
    </div>
  </div>
</div>` : ''}
<div id="tag-filter-bar" style="margin:8px 0 6px; min-height:22px; font-size:0.82em; color:#888; display:none;">
  Filter: <span id="tag-filter-active"></span>
  <a href="#" id="tag-filter-clear" style="margin-left:8px; color:#7aa2c7; text-decoration:none;">clear</a>
</div>
<div style="font-size:0.78em; color:#999; margin:4px 0 6px;">Cell background tint = which eventual-event direction this value leans toward, per the Pre-Event IV → Outcome Contrast (green = positive, red = negative; deeper = stronger effect).</div>
<table id="screen-table">
<thead><tr>
  <th style="width:44px; text-align:center; padding:4px;"><span class="sort-arrow"></span></th>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th>Sector<span class="sort-arrow"></span></th>
  <th>Tags<span class="sort-arrow"></span></th>
  <th>Classification<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="TTM-R3 next-day event probability">Event Prob<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Latest quoted price, including pre-market and after-hours when the regular session is closed. % is the move vs the last regular close.">Last (ext)<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Mkt Cap<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Opt $ Vol<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of total option dollar-volume percentile rank within the ticker's own history, across the same window as the IV Δ columns: rank(T-1) − rank(T-oldest), in rank points (-100..+100). >0 = flow building into the event.">$Vol Δrank<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Call IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank, {tN} = top-tag cohort rank">C Spr<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of ATM call IV percentile rank: rank(T-1) − rank(T-oldest) over the ~3 snapshots before the event. >0 = ramping in.">ATM C Δ<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of call OTM−ATM spread percentile rank: rank(T-1) − rank(T-oldest) over the ~3 snapshots before the event. >0 = ramping in.">C Spr Δ<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Put IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank, {tN} = top-tag cohort rank">P Spr<span class="sort-arrow"></span></th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<script>
(function() {
  const chartDataMap = ${JSON.stringify(chartDataMap)};
  const summaryMap = ${JSON.stringify(summaryMap)};
  const newsMap = ${JSON.stringify(newsMap)};
  const ivHistoryMap = ${JSON.stringify(ivHistoryData)};
  // Combine IV from a saved history record (exp1/exp2/exp3), weighted by dv if available.
  // Single-pool combine of a history record across expirations;
  // old records fall back to legacy combined DV + single-strike ATM.
  function combineHist(record) {
    const exps = [];
    for (const key of ['exp1', 'exp2', 'exp3']) {
      const e = record[key];
      if (!e || (e.callIV <= 0 && e.putIV <= 0)) continue;
      exps.push(e);
    }
    if (exps.length === 0) return null;

    function pool(valueFn, weightFn) {
      var vals = [];
      for (var i = 0; i < exps.length; i++) {
        var v = valueFn(exps[i]);
        if (v == null) continue;
        var w = weightFn(exps[i]);
        vals.push({ v: v, w: w > 0 ? w : 0 });
      }
      if (vals.length === 0) return null;
      var sumW = 0, sumVW = 0;
      for (var j = 0; j < vals.length; j++) { sumW += vals[j].w; sumVW += vals[j].v * vals[j].w; }
      if (sumW > 0) return sumVW / sumW;
      var sumV = 0;
      for (var k = 0; k < vals.length; k++) sumV += vals[k].v;
      return sumV / vals.length;
    }
    function legacyDV(e) { return e.dv || 0; }

    var callIV = pool(
      function(e) { return e.callIV > 0 ? e.callIV : null; },
      function(e) { return e.callDV != null ? e.callDV : legacyDV(e); }
    ) || 0;
    var putIV = pool(
      function(e) { return e.putIV > 0 ? e.putIV : null; },
      function(e) { return e.putDV != null ? e.putDV : legacyDV(e); }
    ) || 0;
    var atmCallIV = pool(
      function(e) { return (e.atmBandCallIV != null && e.atmBandCallIV > 0) ? e.atmBandCallIV : (e.atmCallIV != null ? e.atmCallIV : null); },
      function(e) { return e.atmCallDV != null ? e.atmCallDV : legacyDV(e); }
    );
    var atmPutIV = pool(
      function(e) { return (e.atmBandPutIV != null && e.atmBandPutIV > 0) ? e.atmBandPutIV : (e.atmPutIV != null ? e.atmPutIV : null); },
      function(e) { return e.atmPutDV != null ? e.atmPutDV : legacyDV(e); }
    );

    return { callIV: callIV, putIV: putIV, atmCallIV: atmCallIV, atmPutIV: atmPutIV };
  }
  // Favorite star click handler
  let favToastTimer = null;
  function showFavToast(msg, success) {
    const el = document.getElementById('fav-toast');
    el.textContent = msg;
    el.style.background = success ? '#4caf50' : '#f44336';
    el.classList.add('show');
    clearTimeout(favToastTimer);
    favToastTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  // Ticker notes: debounced autosave
  const noteTimers = {};
  document.querySelectorAll('.ticker-note').forEach(ta => {
    const ticker = ta.getAttribute('data-ticker');
    const statusEl = document.querySelector('.note-status[data-ticker="' + ticker + '"]');
    const save = async () => {
      if (!window.electronAPI || !window.electronAPI.saveNote) return;
      if (statusEl) statusEl.textContent = 'saving…';
      try {
        await window.electronAPI.saveNote(ticker, ta.value);
        if (statusEl) {
          statusEl.textContent = 'saved';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1200);
        }
        // Update note indicator next to ticker
        const row = document.querySelector('tr.data-row[data-ticker="' + ticker + '"]');
        if (row) {
          const cell = row.children[1];
          if (cell) {
            const existing = cell.querySelector('span[title="Has note"]');
            const hasText = ta.value.trim().length > 0;
            if (hasText && !existing) {
              const span = document.createElement('span');
              span.setAttribute('title', 'Has note');
              span.style.fontSize = '0.75em';
              span.textContent = ' \u{1F4DD}';
              cell.appendChild(span);
            } else if (!hasText && existing) {
              existing.remove();
            }
          }
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'failed';
      }
    };
    ta.addEventListener('input', () => {
      clearTimeout(noteTimers[ticker]);
      noteTimers[ticker] = setTimeout(save, 700);
    });
    ta.addEventListener('blur', () => {
      clearTimeout(noteTimers[ticker]);
      save();
    });
    ta.addEventListener('click', (e) => e.stopPropagation());
  });

  // ── Event-tag filter ──
  // Click any tag chip to filter rows; only data-rows whose data-tags contains
  // the active tag remain visible (their chart-row sibling is hidden too).
  let activeTagFilter = null;
  function applyTagFilter() {
    const bar = document.getElementById('tag-filter-bar');
    const activeEl = document.getElementById('tag-filter-active');
    if (activeTagFilter) {
      bar.style.display = '';
      activeEl.textContent = activeTagFilter;
    } else {
      bar.style.display = 'none';
      activeEl.textContent = '';
    }
    document.querySelectorAll('tr.data-row').forEach(row => {
      const tags = (row.getAttribute('data-tags') || '').split(' ').filter(Boolean);
      const show = !activeTagFilter || tags.includes(activeTagFilter);
      row.style.display = show ? '' : 'none';
      const ticker = row.getAttribute('data-ticker');
      const chartRow = document.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
      if (chartRow && !show) chartRow.style.display = 'none';
    });
    document.querySelectorAll('.event-tag').forEach(chip => {
      chip.style.outline = (chip.getAttribute('data-tag') === activeTagFilter) ? '2px solid #7aa2c7' : '';
    });
  }
  document.querySelectorAll('.event-tag').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = chip.getAttribute('data-tag');
      activeTagFilter = (activeTagFilter === tag) ? null : tag;
      applyTagFilter();
    });
  });
  const clearLink = document.getElementById('tag-filter-clear');
  if (clearLink) clearLink.addEventListener('click', (e) => {
    e.preventDefault();
    activeTagFilter = null;
    applyTagFilter();
  });

  document.querySelectorAll('.del-mark').forEach(mark => {
    mark.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = mark.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.toggleDelete) return;
      if (mark.dataset.busy) return;
      mark.dataset.busy = '1';
      try {
        const result = await window.electronAPI.toggleDelete(ticker);
        const isDeleted = (result.toDelete || []).includes(ticker);
        mark.style.color = isDeleted ? '#e53935' : '#555';
        mark.title = isDeleted ? 'Marked to delete (click to unmark)' : 'Mark to delete';
        const row = mark.closest('tr');
        if (row) {
          row.style.opacity = isDeleted ? '0.4' : '';
          row.style.textDecoration = isDeleted ? 'line-through' : '';
        }
        showFavToast(isDeleted ? ticker + ' marked to delete' : ticker + ' unmarked', true);
      } catch (err) {
        showFavToast('Failed to update ' + ticker, false);
      }
      delete mark.dataset.busy;
    });
  });

  document.querySelectorAll('.add-screen-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = btn.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.addScreenTicker) return;
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      try {
        const result = await window.electronAPI.addScreenTicker(ticker);
        if (result && result.success) {
          btn.disabled = true;
          btn.textContent = 'Added ✓';
          btn.style.cursor = 'default';
          btn.style.opacity = '0.7';
          showFavToast(result.alreadyPresent ? ticker + ' already in screening list' : ticker + ' added to screening list', true);
        } else {
          showFavToast('Failed to add ' + ticker + (result && result.error ? ': ' + result.error : ''), false);
        }
      } catch (err) {
        showFavToast('Failed to add ' + ticker, false);
      }
      delete btn.dataset.busy;
    });
  });

  document.querySelectorAll('.add-screen-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = btn.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.addScreenTicker) return;
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      try {
        const result = await window.electronAPI.addScreenTicker(ticker);
        if (result && result.success) {
          btn.disabled = true;
          btn.textContent = 'Added ✓';
          btn.style.cursor = 'default';
          btn.style.opacity = '0.7';
          showFavToast(result.alreadyPresent ? ticker + ' already in screening list' : ticker + ' added to screening list', true);
        } else {
          showFavToast('Failed to add ' + ticker + (result && result.error ? ': ' + result.error : ''), false);
        }
      } catch (err) {
        showFavToast('Failed to add ' + ticker, false);
      }
      delete btn.dataset.busy;
    });
  });

  document.querySelectorAll('.add-screen-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = btn.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.addScreenTicker) return;
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      try {
        const result = await window.electronAPI.addScreenTicker(ticker);
        if (result && result.success) {
          btn.disabled = true;
          btn.textContent = 'Added ✓';
          btn.style.cursor = 'default';
          btn.style.opacity = '0.7';
          showFavToast(result.alreadyPresent ? ticker + ' already in screening list' : ticker + ' added to screening list', true);
        } else {
          showFavToast('Failed to add ' + ticker + (result && result.error ? ': ' + result.error : ''), false);
        }
      } catch (err) {
        showFavToast('Failed to add ' + ticker, false);
      }
      delete btn.dataset.busy;
    });
  });

  const classColors = {
    surprising_positive: '#4caf50',
    positive_anticipated: '#8bc34a',
    negative_anticipated: '#ff9800',
    surprising_negative: '#f44336',
  };
  const classNames = {
    surprising_positive: 'Surprising +',
    positive_anticipated: 'Anticipated +',
    negative_anticipated: 'Anticipated -',
    surprising_negative: 'Surprising -',
  };

  const renderedCharts = {};

  function pairwiseCorrelation(tickerA, tickerB) {
    const cdA = chartDataMap[tickerA];
    const cdB = chartDataMap[tickerB];
    if (!cdA || !cdB || !cdA.dates || !cdB.dates) return null;

    const dateIdxA = {};
    for (let i = 0; i < cdA.dates.length; i++) dateIdxA[cdA.dates[i]] = i;

    const retA = [], retB = [];
    let prevIdxA = -1, prevIdxB = -1;
    for (let j = 0; j < cdB.dates.length; j++) {
      const idxA = dateIdxA[cdB.dates[j]];
      if (idxA == null) continue;
      if (prevIdxA >= 0 && prevIdxB >= 0 && idxA === prevIdxA + 1 && j === prevIdxB + 1) {
        if (cdA.closes[prevIdxA] > 0 && cdB.closes[prevIdxB] > 0) {
          retA.push(Math.log(cdA.closes[idxA] / cdA.closes[prevIdxA]));
          retB.push(Math.log(cdB.closes[j] / cdB.closes[prevIdxB]));
        }
      }
      prevIdxA = idxA;
      prevIdxB = j;
    }

    if (retA.length < 20) return null;

    const n = retA.length;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    for (let k = 0; k < n; k++) {
      sx += retA[k]; sy += retB[k];
      sxy += retA[k] * retB[k];
      sx2 += retA[k] * retA[k];
      sy2 += retB[k] * retB[k];
    }
    const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    return denom > 0 ? (n * sxy - sx * sy) / denom : 0;
  }

  function corrColor(r) {
    const abs = Math.abs(r);
    if (r < 0) return 'rgba(76, 175, 80, ' + (0.5 + abs * 0.5) + ')';
    if (abs < 0.3) return 'rgba(76, 175, 80, 0.7)';
    if (abs < 0.6) return 'rgba(255, 193, 7, ' + (0.6 + (abs - 0.3) * 1.3) + ')';
    return 'rgba(244, 67, 54, ' + (0.6 + (abs - 0.6) * 1.0) + ')';
  }

  // Portfolio correlation checker
  document.getElementById('portfolio-corr-btn').addEventListener('click', () => {
    const raw = document.getElementById('portfolio-corr-input').value;
    const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(t => t.length > 0);
    const resultDiv = document.getElementById('portfolio-corr-result');

    if (tickers.length < 2) {
      resultDiv.innerHTML = '<span style="color:#888; font-size:0.9em;">Enter at least 2 tickers separated by commas.</span>';
      return;
    }

    const missing = tickers.filter(t => !chartDataMap[t]);
    if (missing.length > 0) {
      resultDiv.innerHTML = '<span style="color:#c62828; font-size:0.9em;">Not in screening data: ' + missing.join(', ') + '</span>';
      return;
    }

    // Compute all pairwise correlations
    const pairs = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const r = pairwiseCorrelation(tickers[i], tickers[j]);
        pairs.push({ a: tickers[i], b: tickers[j], r });
      }
    }

    const valid = pairs.filter(p => p.r !== null);
    if (valid.length === 0) {
      resultDiv.innerHTML = '<span style="color:#888; font-size:0.9em;">Not enough overlapping data to compute correlations.</span>';
      return;
    }

    const avgCorr = valid.reduce((s, p) => s + p.r, 0) / valid.length;
    const maxCorr = Math.max(...valid.map(p => p.r));
    const minCorr = Math.min(...valid.map(p => p.r));

    // Verdict
    let verdict, verdictColor;
    if (avgCorr >= 0.7) { verdict = 'Highly correlated — low diversification'; verdictColor = '#c62828'; }
    else if (avgCorr >= 0.5) { verdict = 'Moderately correlated'; verdictColor = '#ef6c00'; }
    else if (avgCorr >= 0.3) { verdict = 'Moderately diversified'; verdictColor = '#f9a825'; }
    else { verdict = 'Well diversified — low correlation'; verdictColor = '#2e7d32'; }

    let html = '<div style="margin-bottom:6px;"><span style="font-weight:700; font-size:1.05em; color:' + verdictColor + ';">' + verdict + '</span>';
    html += '<span style="color:#888; margin-left:12px; font-size:0.9em;">avg ' + avgCorr.toFixed(3) + ' &nbsp;|&nbsp; range ' + minCorr.toFixed(3) + ' to ' + maxCorr.toFixed(3) + '</span></div>';

    // Pair table
    html += '<table style="width:100%; border-collapse:collapse; font-size:0.9em; margin-top:4px;">';
    html += '<tr style="color:#888; font-size:0.8em; text-transform:uppercase; letter-spacing:0.5px;"><th style="text-align:left; padding:4px 8px;">Pair</th><th style="text-align:right; padding:4px 8px;">Correlation</th></tr>';
    valid.sort((a, b) => b.r - a.r);
    for (const p of valid) {
      const color = corrColor(p.r);
      html += '<tr style="border-top:1px solid #eee;">' +
        '<td style="padding:4px 8px;">' + p.a + ' / ' + p.b + '</td>' +
        '<td style="padding:4px 8px; text-align:right; color:' + color + '; font-weight:600;">' + p.r.toFixed(3) + '</td>' +
        '</tr>';
    }
    const skipped = pairs.filter(p => p.r === null);
    if (skipped.length > 0) {
      for (const p of skipped) {
        html += '<tr style="border-top:1px solid #eee;">' +
          '<td style="padding:4px 8px; color:#bbb;">' + p.a + ' / ' + p.b + '</td>' +
          '<td style="padding:4px 8px; text-align:right; color:#bbb;">insufficient data</td></tr>';
      }
    }
    html += '</table>';
    resultDiv.innerHTML = html;
  });

  document.getElementById('portfolio-corr-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('portfolio-corr-btn').click();
  });

  // Click handler for data rows
  document.querySelectorAll('tr.data-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const ticker = row.getAttribute('data-ticker');
      const chartRow = document.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
      if (!chartRow) return;

      const isVisible = chartRow.style.display !== 'none';
      // Toggle arrow indicator
      const arrow = row.querySelector('td:first-child span');
      if (arrow) arrow.textContent = isVisible ? '\\u25B6' : '\\u25BC';

      if (isVisible) {
        chartRow.style.display = 'none';
        return;
      }

      chartRow.style.display = '';

      // Render chart if not yet done
      if (!renderedCharts[ticker]) {
        const cd = chartDataMap[ticker];
        if (!cd) return;

        const canvas = document.getElementById('chart-' + ticker);
        if (!canvas) return;

        // Build all datasets using numeric indices for x — avoids category/scatter misalignment
        const eventsByClass = {};
        for (const ev of cd.events) {
          if (!eventsByClass[ev.classification]) eventsByClass[ev.classification] = [];
          if (ev.idx != null && ev.idx < cd.dates.length) {
            eventsByClass[ev.classification].push({ x: ev.idx, y: ev.y });
          }
        }

        // Convert line and bar data to {x, y} indexed points so all datasets share the linear x scale
        const pricePoints = cd.closes.map((v, i) => ({ x: i, y: v }));
        const volumePoints = cd.volumes.map((v, i) => ({ x: i, y: v }));

        const datasets = [{
          label: 'Volume',
          data: volumePoints,
          type: 'bar',
          backgroundColor: 'rgba(100, 100, 180, 0.25)',
          borderColor: 'rgba(100, 100, 180, 0.4)',
          borderWidth: 1,
          yAxisID: 'yVol',
          order: 2,
        }, {
          label: ticker + ' Close',
          data: pricePoints,
          borderColor: 'rgba(136, 176, 136, 0.8)',
          backgroundColor: 'rgba(136, 176, 136, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          yAxisID: 'y',
          order: 1,
        }];

        for (const [cls, points] of Object.entries(eventsByClass)) {
          datasets.push({
            label: classNames[cls] || cls,
            data: points,
            type: 'scatter',
            backgroundColor: classColors[cls] || '#ccc',
            borderColor: classColors[cls] || '#ccc',
            pointRadius: 7,
            pointHoverRadius: 9,
            yAxisID: 'y',
            order: 0,
          });
        }

        const dates = cd.dates;
        renderedCharts[ticker] = new Chart(canvas, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
              title: { display: true, text: ticker + ' Price with Events', color: '#b0b0b0' },
              legend: { labels: { color: '#909090', boxWidth: 12, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  title: function(items) { return items[0] ? dates[items[0].parsed.x] || '' : ''; }
                }
              },
            },
            scales: {
              x: {
                type: 'linear',
                ticks: {
                  color: '#909090',
                  maxTicksLimit: 12,
                  font: { size: 10 },
                  callback: function(val) { return dates[val] || ''; },
                },
                grid: { color: '#2a2a4a' },
                min: 0,
                max: dates.length - 1,
              },
              y: {
                position: 'left',
                ticks: { color: '#909090', font: { size: 10 } },
                grid: { color: '#2a2a4a' },
              },
              yVol: {
                position: 'right',
                display: false,
                beginAtZero: true,
                max: Math.max(...(cd.volumes || [0])) * 4,
                grid: { drawOnChartArea: false },
              },
            },
          },
        });

        // Populate company summary
        const sumEl = document.getElementById('summary-' + ticker);
        if (sumEl && summaryMap[ticker]) {
          sumEl.textContent = summaryMap[ticker];
        }

        // Render last-5-day DV (bars) + average IV (line) mini-chart next to summary
        const dvIvCanvas = document.getElementById('dv-iv-chart-' + ticker);
        const dvIvHist = ivHistoryMap[ticker];
        if (dvIvCanvas && Array.isArray(dvIvHist) && dvIvHist.length > 0) {
          const recent = dvIvHist.slice(-5);
          const labels = recent.map(r => (r.date || '').slice(5));
          const dvSeries = recent.map(r => {
            let dv = 0;
            for (const k of ['exp1', 'exp2', 'exp3']) {
              const e = r[k];
              if (!e) continue;
              dv += (e.callDV || 0) + (e.putDV || 0);
            }
            return dv;
          });
          const ivSeries = recent.map(r => {
            const c = combineHist(r);
            if (!c) return null;
            const vals = [];
            if (c.callIV > 0) vals.push(c.callIV);
            if (c.putIV > 0) vals.push(c.putIV);
            if (!vals.length) return null;
            return vals.reduce((s, v) => s + v, 0) / vals.length;
          });

          const dvIvDateMap = recent.map(r => r.date);
          const renderStrikeBreakdown = (dateStr) => {
            const rec = (ivHistoryMap[ticker] || []).find(r => r.date === dateStr);
            const wrap = document.getElementById('dv-iv-strike-wrap-' + ticker);
            const title = document.getElementById('dv-iv-strike-title-' + ticker);
            const body = document.getElementById('dv-iv-strike-body-' + ticker);
            if (!rec || !wrap || !body) return;
            const exps = ['exp1', 'exp2', 'exp3'].map(k => rec[k]).filter(e => e && (e.calls || e.puts));
            if (!exps.length) {
              body.innerHTML = '<div style="color:#888; font-size:0.85em; padding:8px 0;">No per-strike data for ' + dateStr + ' (older snapshots stored aggregates only — newer dates will populate).</div>';
              if (title) title.textContent = ticker + ' — ' + dateStr;
              wrap.style.display = 'block';
              return;
            }
            if (title) title.textContent = ticker + ' — ' + dateStr;
            body.innerHTML = exps.map((_, i) => '<div style="display:inline-block; width:48%; margin-right:1%; vertical-align:top;"><div style="height:300px;"><canvas id="strike-hist-' + ticker + '-' + dateStr + '-' + i + '"></canvas></div></div>').join('');
            wrap.style.display = 'block';
            exps.forEach((e, i) => {
              const cv = document.getElementById('strike-hist-' + ticker + '-' + dateStr + '-' + i);
              if (!cv) return;
              const strikeSet = new Set();
              (e.calls || []).forEach(c => strikeSet.add(c.strike));
              (e.puts || []).forEach(p => strikeSet.add(p.strike));
              const strikes = Array.from(strikeSet).sort((a, b) => a - b);
              const cMap = {}, pMap = {};
              (e.calls || []).forEach(c => { cMap[c.strike] = c; });
              (e.puts || []).forEach(p => { pMap[p.strike] = p; });
              new Chart(cv, {
                data: {
                  labels: strikes.map(s => '$' + s.toFixed(s >= 100 ? 0 : s >= 1 ? 1 : 2)),
                  datasets: [
                    { type: 'bar', label: 'Call $Vol', data: strikes.map(s => cMap[s] ? cMap[s].dv : 0), backgroundColor: 'rgba(72,187,120,0.55)', yAxisID: 'y' },
                    { type: 'bar', label: 'Put $Vol', data: strikes.map(s => pMap[s] ? pMap[s].dv : 0), backgroundColor: 'rgba(245,101,101,0.55)', yAxisID: 'y' },
                    { type: 'line', label: 'Call IV', data: strikes.map(s => cMap[s] && cMap[s].iv > 0 ? cMap[s].iv : null), borderColor: 'rgba(72,187,120,0.95)', backgroundColor: 'rgba(72,187,120,0.95)', borderWidth: 2, pointRadius: 2, spanGaps: true, yAxisID: 'y1' },
                    { type: 'line', label: 'Put IV', data: strikes.map(s => pMap[s] && pMap[s].iv > 0 ? pMap[s].iv : null), borderColor: 'rgba(245,101,101,0.95)', backgroundColor: 'rgba(245,101,101,0.95)', borderWidth: 2, pointRadius: 2, spanGaps: true, yAxisID: 'y1' },
                  ],
                },
                options: {
                  responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    title: { display: true, text: e.label || ('Exp ' + (i + 1)), color: '#b0b0b0', font: { size: 11 } },
                    legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                  },
                  scales: {
                    x: { ticks: { color: '#909090', font: { size: 9 }, maxRotation: 60, minRotation: 0 }, grid: { color: '#2a2a4a' } },
                    y: { position: 'left', beginAtZero: true, title: { display: true, text: '$Vol', color: '#909090', font: { size: 9 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K'; } }, grid: { color: '#2a2a4a' } },
                    y1: { position: 'right', title: { display: true, text: 'IV %', color: '#909090', font: { size: 9 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } }, grid: { drawOnChartArea: false } },
                  },
                },
              });
            });
          };

          const closeBtn = document.querySelector('button[data-strike-close="' + ticker + '"]');
          if (closeBtn) {
            closeBtn.addEventListener('click', () => {
              const wrap = document.getElementById('dv-iv-strike-wrap-' + ticker);
              if (wrap) wrap.style.display = 'none';
            });
          }

          new Chart(dvIvCanvas, {
            data: {
              labels,
              datasets: [
                {
                  type: 'bar',
                  label: 'Option $Vol',
                  data: dvSeries,
                  backgroundColor: 'rgba(122,162,199,0.55)',
                  borderColor: 'rgba(122,162,199,0.9)',
                  borderWidth: 1,
                  yAxisID: 'y',
                  order: 1,
                },
                {
                  type: 'line',
                  label: 'Avg IV',
                  data: ivSeries,
                  borderColor: 'rgba(245,180,80,0.95)',
                  backgroundColor: 'rgba(245,180,80,0.95)',
                  borderWidth: 2,
                  pointRadius: 3,
                  spanGaps: true,
                  tension: 0.2,
                  yAxisID: 'y1',
                  order: 0,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 200 },
              interaction: { mode: 'index', intersect: false },
              onClick: (evt, els, chart) => {
                let idx = els && els.length ? els[0].index : null;
                if (idx == null) {
                  const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
                  if (pts && pts.length) idx = pts[0].index;
                }
                if (idx == null) return;
                const dateStr = dvIvDateMap[idx];
                if (dateStr) renderStrikeBreakdown(dateStr);
              },
              plugins: {
                title: { display: true, text: 'Last 5d Option $Vol & Avg IV (click a day for strikes)', color: '#b0b0b0', font: { size: 11 } },
                legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                tooltip: {
                  callbacks: {
                    label: function(ctx) {
                      const v = ctx.raw;
                      if (v == null) return ctx.dataset.label + ': N/A';
                      if (ctx.dataset.yAxisID === 'y1') return ctx.dataset.label + ': ' + v.toFixed(1) + '%';
                      return ctx.dataset.label + ': $' + (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K');
                    },
                  },
                },
              },
              scales: {
                x: { ticks: { color: '#909090', font: { size: 9 } }, grid: { color: '#2a2a4a' } },
                y: {
                  position: 'left',
                  beginAtZero: true,
                  title: { display: true, text: '$Vol', color: '#909090', font: { size: 9 } },
                  ticks: {
                    color: '#909090', font: { size: 9 },
                    callback: function(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K'; },
                  },
                  grid: { color: '#2a2a4a' },
                },
                y1: {
                  position: 'right',
                  title: { display: true, text: 'Avg IV %', color: '#909090', font: { size: 9 } },
                  ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } },
                  grid: { drawOnChartArea: false },
                },
              },
            },
          });
        }

        // Populate news headlines
        const newsEl = document.getElementById('news-' + ticker);
        const news = newsMap[ticker];
        if (newsEl && news && news.length > 0) {
          const catColors = { technical: '#5b9bd5', fear: '#c0392b', win: '#27ae60', macro_fear: '#e07c4f', macro_win: '#2ecc71', mixed: '#999' };
          const catLabels = { technical: 'Technical', fear: 'Fear', win: 'Win', macro_fear: 'Macro Fear', macro_win: 'Macro Win', mixed: 'Mixed' };
          const renderHeadline = (n) => {
            const badge = n.category ? '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.75em;font-weight:600;color:#fff;background:' + (catColors[n.category] || '#999') + ';margin-right:6px;vertical-align:middle;">' + (catLabels[n.category] || '') + '</span>' : '';
            return '<div style="margin-bottom:6px; font-size:0.95em; line-height:1.5;">' +
              '<span style="color:#666; font-size:0.85em; margin-right:6px;">' + (n.date ? n.date + ' ' : '') + (n.time || '') + '</span>' +
              badge +
              '<a href="' + n.url + '" target="_blank" rel="noopener" style="color:#7aa2c7; text-decoration:none;">' + n.headline + '</a>' +
            '</div>';
          };
          const DEFAULT_SHOW = 10;
          const shown = news.slice(0, DEFAULT_SHOW).map(renderHeadline).join('');
          const hidden = news.slice(DEFAULT_SHOW).map(renderHeadline).join('');
          let html = '<div>' + shown + '</div>';
          if (hidden) {
            const hiddenId = 'news-hidden-' + ticker;
            const btnId = 'news-toggle-' + ticker;
            html += '<div id="' + hiddenId + '" style="display:none;">' + hidden + '</div>';
            html += '<button id="' + btnId + '" type="button" style="margin-top:6px; background:transparent; color:#7aa2c7; border:1px solid #445; border-radius:3px; padding:3px 10px; font-size:0.85em; cursor:pointer;">Show ' + (news.length - DEFAULT_SHOW) + ' more</button>';
            newsEl.innerHTML = html;
            const btn = document.getElementById(btnId);
            const hiddenEl = document.getElementById(hiddenId);
            btn.addEventListener('click', () => {
              const isHidden = hiddenEl.style.display === 'none';
              hiddenEl.style.display = isHidden ? 'block' : 'none';
              btn.textContent = isHidden ? 'Show less' : ('Show ' + (news.length - DEFAULT_SHOW) + ' more');
            });
          } else {
            newsEl.innerHTML = html;
          }
        }

        // Render options strike charts (nearest 3 expirations side by side)
        const od = cd.optionsStrikes;
        if (od && od.length > 0) {
          const optsWrap = document.getElementById('opts-wrap-' + ticker);
          if (optsWrap) {
            optsWrap.style.display = 'block';
            const fmtDollar = (v) => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(0)+'K' : '$'+v.toFixed(0);

            for (let ei = 0; ei < Math.min(3, od.length); ei++) {
              const exp = od[ei];
              const canvas = document.getElementById('opts-chart-' + ei + '-' + ticker);
              if (!exp || !canvas) continue;

              const strikeSet = new Set();
              exp.calls.forEach(c => strikeSet.add(c.strike));
              exp.puts.forEach(p => strikeSet.add(p.strike));
              const strikes = Array.from(strikeSet).sort((a, b) => a - b);
              const strikeLabels = strikes.map(s => '$' + s.toFixed(s >= 100 ? 0 : s >= 1 ? 1 : 2));

              const callMap = {};
              exp.calls.forEach(c => { callMap[c.strike] = c; });
              const putMap = {};
              exp.puts.forEach(p => { putMap[p.strike] = p; });

              const callDollarVol = strikes.map(s => callMap[s] ? callMap[s].dollarVol : 0);
              const putDollarVol = strikes.map(s => putMap[s] ? putMap[s].dollarVol : 0);
              const callDollarOI = strikes.map(s => callMap[s] ? callMap[s].dollarOI : 0);
              const putDollarOI = strikes.map(s => putMap[s] ? putMap[s].dollarOI : 0);
              const callIV = strikes.map(s => callMap[s] && callMap[s].iv > 0 ? callMap[s].iv : null);
              const putIV = strikes.map(s => putMap[s] && putMap[s].iv > 0 ? putMap[s].iv : null);

              // Populate weighted IV label
              const ivLabel = document.getElementById('opts-iv-label-' + ei + '-' + ticker);
              if (ivLabel && (exp.wCallIV > 0 || exp.wPutIV > 0)) {
                let ivHtml = '<span style="color:rgba(72,187,120,0.9);">Call IV: ' + exp.wCallIV.toFixed(1) + '%</span>';
                if (exp.atmCallIV > 0) ivHtml += '<span style="color:#888; font-size:0.85em;"> (ATM ' + exp.atmCallIV.toFixed(1) + '%, ' + (exp.ivSpreadCall >= 0 ? '+' : '') + exp.ivSpreadCall.toFixed(1) + ' spread, ' + (exp.deepOTMCallPct || 0).toFixed(0) + '% deep)</span>';
                ivHtml += ' | <span style="color:rgba(245,101,101,0.9);">Put IV: ' + exp.wPutIV.toFixed(1) + '%</span>';
                if (exp.atmPutIV > 0) ivHtml += '<span style="color:#888; font-size:0.85em;"> (ATM ' + exp.atmPutIV.toFixed(1) + '%, ' + (exp.ivSpreadPut >= 0 ? '+' : '') + exp.ivSpreadPut.toFixed(1) + ' spread, ' + (exp.deepOTMPutPct || 0).toFixed(0) + '% deep)</span>';
                ivLabel.innerHTML = ivHtml;
              }

              new Chart(canvas, {
                type: 'bar',
                data: {
                  labels: strikeLabels,
                  datasets: [
                    { label: 'Call $ OI', data: callDollarOI, backgroundColor: 'rgba(72, 187, 120, 0.15)', borderColor: 'rgba(72, 187, 120, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 3, barPercentage: 0.95 },
                    { label: 'Put $ OI', data: putDollarOI, backgroundColor: 'rgba(245, 101, 101, 0.15)', borderColor: 'rgba(245, 101, 101, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 3, barPercentage: 0.95 },
                    { label: 'Call $ Vol', data: callDollarVol, backgroundColor: 'rgba(72, 187, 120, 0.6)', borderColor: 'rgba(72, 187, 120, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 2, barPercentage: 0.6 },
                    { label: 'Put $ Vol', data: putDollarVol, backgroundColor: 'rgba(245, 101, 101, 0.6)', borderColor: 'rgba(245, 101, 101, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 2, barPercentage: 0.6 },
                    { label: 'Call IV', data: callIV, borderColor: 'rgba(72, 187, 120, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
                    { label: 'Put IV', data: putIV, borderColor: 'rgba(245, 101, 101, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
                  ],
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  plugins: {
                    title: { display: true, text: 'Exp: ' + exp.label, color: '#b0b0b0', font: { size: 11 } },
                    legend: { display: false },
                    tooltip: {
                      callbacks: {
                        label: function(ctx) {
                          if (ctx.dataset.yAxisID === 'yIV') return ctx.dataset.label + ': ' + (ctx.raw !== null ? ctx.raw.toFixed(1) + '%' : 'N/A');
                          return ctx.dataset.label + ': ' + fmtDollar(ctx.raw);
                        }
                      }
                    },
                  },
                  scales: {
                    x: { stacked: true, ticks: { color: '#909090', font: { size: 8 }, maxRotation: 45 }, grid: { color: '#2a2a4a' } },
                    yDollar: {
                      position: 'left',
                      stacked: false,
                      ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return fmtDollar(v); } },
                      grid: { color: '#2a2a4a' },
                      beginAtZero: true,
                    },
                    yIV: {
                      position: 'right',
                      ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } },
                      grid: { drawOnChartArea: false },
                    },
                  },
                },
              });
            }

            // IV history click handler — either label toggles the history chart
            let ivHistChart = null;
            const histWrap = document.getElementById('iv-history-wrap-' + ticker);
            const histCanvas = document.getElementById('iv-history-chart-' + ticker);
            const hist = ivHistoryMap[ticker];

            function toggleHistory() {
              if (!histWrap || !histCanvas || !hist || hist.length < 2) return;
              if (histWrap.style.display !== 'none') {
                histWrap.style.display = 'none';
                return;
              }
              histWrap.style.display = 'block';
              if (ivHistChart) return; // already rendered

              const labels = hist.map(r => r.date);
              const combined = hist.map(r => combineHist(r));

              const callIVSeries = combined.map(c => c && c.callIV > 0 ? c.callIV : null);
              const putIVSeries = combined.map(c => c && c.putIV > 0 ? c.putIV : null);
              const atmCallIVSeries = combined.map(c => c && c.atmCallIV != null && c.atmCallIV > 0 ? c.atmCallIV : null);
              const atmPutIVSeries = combined.map(c => c && c.atmPutIV != null && c.atmPutIV > 0 ? c.atmPutIV : null);
              const lineBase = { type: 'line', borderWidth: 2, pointRadius: 2, fill: false, spanGaps: true, tension: 0.2 };
              const datasets = [
                { ...lineBase, label: 'Call IV', data: callIVSeries, borderColor: 'rgba(72,187,120,0.95)', backgroundColor: 'rgba(72,187,120,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Put IV', data: putIVSeries, borderColor: 'rgba(245,101,101,0.95)', backgroundColor: 'rgba(245,101,101,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Call ATM IV', data: atmCallIVSeries, borderColor: 'rgba(72,187,120,0.7)', backgroundColor: 'rgba(72,187,120,0.7)', borderDash: [2, 2], pointRadius: 1, yAxisID: 'y' },
                { ...lineBase, label: 'Put ATM IV', data: atmPutIVSeries, borderColor: 'rgba(245,101,101,0.7)', backgroundColor: 'rgba(245,101,101,0.7)', borderDash: [2, 2], pointRadius: 1, yAxisID: 'y' },
              ];

              ivHistChart = new Chart(histCanvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    title: { display: true, text: 'Weighted IV History — ' + ticker, color: '#b0b0b0', font: { size: 11 } },
                    legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                    tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + (ctx.raw != null ? ctx.raw.toFixed(1) + '%' : 'N/A'); } } },
                  },
                  scales: {
                    x: { ticks: { color: '#909090', font: { size: 9 } }, grid: { color: '#2a2a4a' } },
                    y: { position: 'left', title: { display: true, text: 'IV %', color: '#909090', font: { size: 10 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } }, grid: { color: '#2a2a4a' } },
                  },
                },
              });
            }

            for (let li = 0; li < 3; li++) {
              const lbl = document.getElementById('opts-iv-label-' + li + '-' + ticker);
              if (lbl) lbl.addEventListener('click', toggleHistory);
            }
          }
        }

      }
    });
  });

  // Sorting — skip chart rows
  const table = document.getElementById('screen-table');
  const headers = table.querySelectorAll('th');
  let currentCol = -1, ascending = true;

  headers.forEach((th, colIdx) => {
    th.addEventListener('click', () => {
      if (currentCol === colIdx) {
        ascending = !ascending;
      } else {
        currentCol = colIdx;
        ascending = (colIdx === 1);
      }

      headers.forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');

      headers.forEach(h => h.querySelector('.sort-arrow').textContent = '');
      th.querySelector('.sort-arrow').textContent = ascending ? ' \\u25B2' : ' \\u25BC';

      const tbody = table.querySelector('tbody');
      // Collect data-row + chart-row pairs
      const pairs = [];
      const dataRows = tbody.querySelectorAll('tr.data-row');
      dataRows.forEach(dr => {
        const ticker = dr.getAttribute('data-ticker');
        const chartRow = tbody.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
        pairs.push({ dataRow: dr, chartRow });
      });
      // Also collect rows without data-row class (error/skipped tickers)
      const allTrSet = new Set();
      pairs.forEach(p => { allTrSet.add(p.dataRow); if (p.chartRow) allTrSet.add(p.chartRow); });
      const otherRows = Array.from(tbody.querySelectorAll('tr')).filter(r => !allTrSet.has(r) && !r.classList.contains('chart-row'));
      otherRows.forEach(r => pairs.push({ dataRow: r, chartRow: null }));

      pairs.sort((a, b) => {
        const aVal = a.dataRow.children[colIdx]?.getAttribute('data-v') || '';
        const bVal = b.dataRow.children[colIdx]?.getAttribute('data-v') || '';
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);

        let cmp;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          cmp = aNum - bNum;
        } else {
          cmp = aVal.localeCompare(bVal);
        }
        return ascending ? cmp : -cmp;
      });

      pairs.forEach(p => {
        tbody.appendChild(p.dataRow);
        if (p.chartRow) tbody.appendChild(p.chartRow);
      });
    });
  });
})();
<\/script>
</body></html>`;
}

// Window control handlers
ipcMain.handle('window-minimize', async (event) => {
  mainWindow.minimize();
});

ipcMain.handle('window-maximize', async (event) => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('window-close', async (event) => {
  mainWindow.close();
});

// Modal support - hide/show BrowserView so modal can be seen
ipcMain.handle('show-modal', async (event) => {
  if (activeTabId) {
    const browserView = tabs.get(activeTabId);
    if (browserView) {
      mainWindow.removeBrowserView(browserView);
    }
  }
});

ipcMain.handle('hide-modal', async (event) => {
  if (activeTabId) {
    const browserView = tabs.get(activeTabId);
    if (browserView) {
      mainWindow.setBrowserView(browserView);
      updateBrowserViewBounds(browserView);
    }
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

  priceTracker.setOptionsAnalyzer(optionsAnalyzer);

  articleExtractor.setBrowserExtractor(extractArticleViaBrowser);
  console.log('✓ Browser-based article extraction enabled');

  const autoPolling = await database.getSetting('price_auto_polling', 'false');
  const pollingInterval = await database.getSetting('price_polling_interval', '15');
  if (autoPolling === 'true') {
    priceTracker.startPolling(parseInt(pollingInterval));
  }

  backendReadyResolve();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-ready');
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
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
