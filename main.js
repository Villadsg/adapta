require('dotenv').config();

// Patch global fetch to use a real browser User-Agent for Yahoo Finance domains.
// yahoo-finance2's getCrumb.js hardcodes a bot-like User-Agent that Yahoo blocks with 429.
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

const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const ArticleDatabase = require('./src/services/database');
const PriceTrackingService = require('./src/services/priceTracking');
const StockAnalysisService = require('./src/services/stockAnalysis');
const OptionsAnalysisService = require('./src/services/optionsAnalysis');
const PortfolioAnalysisService = require('./src/services/portfolioAnalysis');
const articleExtractor = require('./src/services/articleExtractor');
const newsScraper = require('./src/services/newsScraper');
const TickerDiscoveryService = require('./src/services/tickerDiscovery');
const ChronosHoldPeriodService = require('./src/services/chronosHoldPeriod');
const { screenTickers, reviseTickers } = require('./ci/ticker-screen');
const YahooFinance = require('yahoo-finance2').default;

let mainWindow;
let database;
let priceTracker;
let stockAnalyzer;
let optionsAnalyzer;
let portfolioAnalyzer;
let tickerDiscovery;
let chronosHoldService;

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
  }
  return extractionBrowserView;
}

/**
 * Fetch news headlines from Finviz for a given ticker.
 * Uses the hidden extraction BrowserView to load the quote page and scrape the news table.
 * @param {string} ticker
 * @returns {Promise<Array<{date: string, time: string, headline: string, url: string}>>}
 */
async function fetchFinvizNews(ticker) {
  const bv = getExtractionBrowserView();
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`;

  // Load page and wait for finish
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bv.webContents.removeAllListeners('did-finish-load');
      reject(new Error(`Timed out loading Finviz news for ${ticker}`));
    }, 15000);

    bv.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });

    bv.webContents.loadURL(url).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // Wait for JS-rendered content
  await new Promise(r => setTimeout(r, 2000));

  // Extract news rows from the news table
  const headlines = await bv.webContents.executeJavaScript(`
    (function() {
      const rows = document.querySelectorAll('.body-table-news-wrapper tr, .news-table_wrapper tr, table.fullview-news-outer tr');
      const results = [];
      let currentDate = '';
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const dateCell = cells[0].innerText.trim();
        const link = cells[1].querySelector('a');
        if (!link) continue;
        // Date cell shows date for first article of the day, blank for subsequent
        if (dateCell.includes('-')) {
          // Format like "Mar-13-26" or "Mar-13" — extract date and time
          const parts = dateCell.split(/\\s+/);
          currentDate = parts[0] || '';
          var time = parts[1] || '';
        } else {
          var time = dateCell;
        }
        results.push({
          date: currentDate,
          time: time || '',
          headline: link.innerText.trim(),
          url: link.href || ''
        });
      }
      return results;
    })()
  `);

  console.log(`Finviz news: fetched ${headlines.length} headlines for ${ticker}`);
  return headlines;
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
    fullscreen: true,
    frame: false, // Remove default title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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
    height: height - 136 // 96 (top bars) + 28 (analysis bar at bottom)
  });
}

// Create a new tab
function createTab(url = 'https://finviz.com') {
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

  browserView.webContents.on('page-title-updated', (event, title) => {
    sendUrlUpdate(browserView.webContents.getURL(), title);
  });

  // Handle links that try to open in new windows - open them in new tabs instead
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    // Create a new tab with the URL and switch to it
    const newTabId = createTab(url);
    switchTab(newTabId);

    // Notify the renderer about the new tab
    mainWindow.webContents.send('tab-created', { tabId: newTabId, url });

    // Prevent the default window from opening
    return { action: 'deny' };
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

  // Remove current browser view
  if (activeTabId) {
    mainWindow.removeBrowserView(tabs.get(activeTabId));
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

// Analyze current page (extract text, generate embeddings, check similarity)
// This runs automatically when user navigates to a new page
ipcMain.handle('analyze-page', async (event) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { success: false, error: 'No active tab', matches: [] };

    const url = browserView.webContents.getURL();

    // Skip analysis for internal pages and non-http(s) URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: true, matches: [], skipped: true, reason: 'Internal page' };
    }

    // Extract clean article content using Readability.js
    const articleData = await articleExtractor.extractFromWebContents(browserView.webContents);
    const { title, text, publishedDate } = articleData;

    // Skip analysis for non-article pages (search results, front pages, etc.)
    // Use multiple signals to detect non-article pages:
    const parsedUrl = new URL(url);
    const isHomepage = parsedUrl.pathname === '/' || parsedUrl.pathname === '';
    const isSearchPage = parsedUrl.search.includes('q=') ||
                         parsedUrl.pathname.includes('/search') ||
                         parsedUrl.hostname.includes('duckduckgo');
    const hasPublishedDate = !!publishedDate;

    // Skip if: (homepage OR search page) AND no published date
    if ((isHomepage || isSearchPage) && !hasPublishedDate) {
      return {
        success: true,
        matches: [],
        skipped: true,
        reason: 'Non-article page (homepage or search results)'
      };
    }

    // Use full article text for most accurate similarity comparison
    const queryText = `${title}. ${text}`;

    console.log(`\n🔍 Analyzing page: ${title}`);
    console.log(`   Extracted ${text.length} chars of clean article content`);
    console.log(`   Comparing full article text for maximum accuracy`);

    // Search for similar content in "not_good" articles only (always show top match)
    const results = await database.searchBySimilarity(queryText, {
      limit: 5,
      minSimilarity: 0,
      categoryFilter: 'not_good'
    });

    // Group results by article and get best match per article
    const articleMatches = {};
    for (const result of results) {
      const articleId = result.article_id;
      if (!articleMatches[articleId] || result.similarity > articleMatches[articleId].similarity) {
        articleMatches[articleId] = {
          articleId: result.article_id,
          title: result.article_title,
          category: result.category,
          similarity: result.similarity,
          url: result.article_url
        };
      }
    }

    // Convert to array and sort by similarity
    const topMatches = Object.values(articleMatches)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3); // Return top 3 articles

    if (topMatches.length > 0) {
      console.log(`   Found ${topMatches.length} similar articles`);
      topMatches.forEach((match, i) => {
        console.log(`   ${i + 1}. ${(match.similarity * 100).toFixed(1)}% - ${match.title} (${match.category})`);
      });
    } else {
      console.log(`   No similar articles found (unique content)`);
    }

    return {
      success: true,
      matches: topMatches,
      currentUrl: url,
      currentTitle: title,
      skipped: false
    };
  } catch (error) {
    console.error('Error analyzing page:', error);
    return {
      success: false,
      error: error.message,
      matches: []
    };
  }
});

// Common boilerplate patterns to remove from articles (regex-based)
const BOILERPLATE_PATTERNS = [
  // Newsletter CTAs
  /sign\s+up\s+(for|to)\s+(our|the|a)?\s*newsletter/gi,
  /subscribe\s+(to|for)\s+(our|the|a)?\s*newsletter/gi,
  /get\s+(the\s+)?latest\s+news\s+(in\s+your\s+inbox|delivered)/gi,
  /join\s+our\s+mailing\s+list/gi,
  /enter\s+your\s+email/gi,

  // Cookie/Privacy notices
  /we\s+use\s+cookies/gi,
  /by\s+continuing\s+to\s+(use|browse)\s+(this\s+)?(site|website)/gi,
  /privacy\s+policy\s+and\s+terms/gi,
  /accept\s+(all\s+)?cookies/gi,
  /cookie\s+(policy|settings|preferences)/gi,

  // Social media CTAs
  /follow\s+us\s+on\s+(twitter|x|facebook|linkedin|instagram)/gi,
  /share\s+(this\s+)?(article|story|post)\s+on/gi,
  /connect\s+with\s+us/gi,
  /like\s+us\s+on\s+facebook/gi,

  // Read more / Related content
  /read\s+more\s*:/gi,
  /related\s+(articles?|stories|content|posts?)\s*:/gi,
  /you\s+(may|might)\s+also\s+like/gi,
  /recommended\s+for\s+you/gi,
  /more\s+from\s+this\s+(author|section)/gi,
  /trending\s+(now|stories)/gi,

  // Subscription prompts
  /already\s+a\s+(member|subscriber)/gi,
  /create\s+(a\s+)?free\s+account/gi,
  /start\s+your\s+free\s+trial/gi,
  /upgrade\s+to\s+premium/gi,
  /become\s+a\s+(member|subscriber)/gi,
  /unlimited\s+access/gi,

  // Comments section noise
  /leave\s+a\s+comment/gi,
  /comments?\s+are\s+closed/gi,
  /\d+\s+comments?(?:\s|$)/gi,
  /post\s+a\s+comment/gi,

  // Copyright notices
  /copyright\s+\d{4}/gi,
  /all\s+rights\s+reserved/gi,
  /\u00a9\s*\d{4}/g,

  // Ad-related
  /advertisement/gi,
  /sponsored\s+content/gi,
  /partner\s+content/gi,
];

// Helper function to clean boilerplate from articles
// Removes common patterns and sentences that appear in multiple articles
async function cleanBoilerplateWithReclean(newText, category) {
  console.log(`\n[Boilerplate Cleaner] Starting for category: ${category}`);
  console.log(`[Boilerplate Cleaner] Original text length: ${newText.length} chars`);

  const cleaningLog = {
    originalLength: newText.length,
    patternMatches: [],
    sharedSentences: [],
    existingArticlesRecleaned: [],
    finalLength: 0
  };

  // Step 1: Remove common boilerplate patterns (regex-based)
  let cleanedText = newText;
  for (const pattern of BOILERPLATE_PATTERNS) {
    const matches = cleanedText.match(pattern);
    if (matches) {
      cleaningLog.patternMatches.push({
        pattern: pattern.toString().substring(0, 50),
        count: matches.length,
        samples: matches.slice(0, 2)
      });
      cleanedText = cleanedText.replace(pattern, ' ');
    }
  }

  // Normalize whitespace after pattern removal
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  console.log(`[Boilerplate Cleaner] After pattern removal: ${cleanedText.length} chars (${cleaningLog.patternMatches.length} patterns matched)`);

  // Step 2: Find cross-article shared sentences within same category
  const existingArticles = await database.getArticlesByCategory(category);

  const splitSentences = (text) => {
    if (!text) return [];
    return text
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map(s => s.trim())
      .filter(s => s.length > 15);  // Increased threshold to reduce false positives
  };

  const newSentences = splitSentences(cleanedText);

  // Build map: sentence (lowercase) -> list of article IDs containing it
  const sentenceToArticles = new Map();
  for (const article of existingArticles) {
    const articleSentences = splitSentences(article.content);
    for (const sentence of articleSentences) {
      const key = sentence.toLowerCase().trim();
      if (!sentenceToArticles.has(key)) {
        sentenceToArticles.set(key, []);
      }
      sentenceToArticles.get(key).push(article.id);
    }
  }

  // Find sentences in new article that match existing articles
  const matchingSentences = new Set();
  const articlesToReclean = new Set();

  for (const sentence of newSentences) {
    const key = sentence.toLowerCase().trim();
    if (sentenceToArticles.has(key)) {
      matchingSentences.add(key);
      cleaningLog.sharedSentences.push(sentence.substring(0, 80) + (sentence.length > 80 ? '...' : ''));
      sentenceToArticles.get(key).forEach(id => articlesToReclean.add(id));
    }
  }

  console.log(`[Boilerplate Cleaner] Shared sentences found: ${matchingSentences.size}`);

  // Clean new article: remove matching sentences
  const cleanedNewSentences = newSentences.filter(s => !matchingSentences.has(s.toLowerCase().trim()));
  const finalText = cleanedNewSentences.join(' ');

  console.log(`[Boilerplate Cleaner] After shared sentence removal: ${finalText.length} chars`);

  // Step 3: Re-clean existing articles that had matching sentences AND regenerate embeddings
  const updatedArticleIds = [];
  for (const articleId of articlesToReclean) {
    const article = existingArticles.find(a => a.id === articleId);
    if (!article) continue;

    const articleSentences = splitSentences(article.content);
    const cleanedArticleSentences = articleSentences.filter(s => !matchingSentences.has(s.toLowerCase().trim()));
    const cleanedArticleText = cleanedArticleSentences.join(' ');

    // Only update if content actually changed and has enough remaining content
    if (cleanedArticleText !== article.content && cleanedArticleText.length > 50) {
      await database.updateArticleContent(articleId, cleanedArticleText, article.title);
      updatedArticleIds.push(articleId);
      cleaningLog.existingArticlesRecleaned.push({
        id: articleId,
        oldLength: article.content.length,
        newLength: cleanedArticleText.length
      });
      console.log(`[Boilerplate Cleaner] Re-cleaned article ID ${articleId}: ${article.content.length} -> ${cleanedArticleText.length} chars (embedding regenerated)`);
    }
  }

  cleaningLog.finalLength = finalText.length > 50 ? finalText.length : newText.length;

  // Summary log
  console.log(`[Boilerplate Cleaner] === SUMMARY ===`);
  console.log(`[Boilerplate Cleaner] Original: ${cleaningLog.originalLength} chars`);
  console.log(`[Boilerplate Cleaner] Final: ${cleaningLog.finalLength} chars`);
  console.log(`[Boilerplate Cleaner] Reduction: ${cleaningLog.originalLength - cleaningLog.finalLength} chars (${((cleaningLog.originalLength - cleaningLog.finalLength) / cleaningLog.originalLength * 100).toFixed(1)}%)`);
  console.log(`[Boilerplate Cleaner] Pattern matches: ${cleaningLog.patternMatches.length}`);
  console.log(`[Boilerplate Cleaner] Shared sentences removed: ${matchingSentences.size}`);
  console.log(`[Boilerplate Cleaner] Existing articles re-cleaned: ${updatedArticleIds.length}`);
  console.log(`[Boilerplate Cleaner] =================\n`);

  return {
    cleanedText: finalText.length > 50 ? finalText : newText,  // Fallback if too aggressive
    matchingSentences: Array.from(matchingSentences),
    updatedArticleIds,
    cleaningLog
  };
}

ipcMain.handle('save-article', async (event, category, manualTickers = []) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { success: false, error: 'No active tab' };

    // Extract clean article content using Readability.js
    const articleData = await articleExtractor.extractFromWebContents(browserView.webContents);
    let { url, title, text, publishedDate, tickers: autoTickers } = articleData;

    // Only extract tickers and dates for 'stock_news' category
    // For 'not_good' articles, skip ticker/date extraction
    const shouldExtractStockData = (category === 'stock_news');

    // Apply boilerplate cleaning for stock_news and not_good categories (NOT 'good')
    const shouldCleanBoilerplate = ['stock_news', 'not_good'].includes(category);
    let cleaningResult = null;

    if (shouldCleanBoilerplate) {
      cleaningResult = await cleanBoilerplateWithReclean(text, category);
      text = cleaningResult.cleanedText;

      // Detailed cleaning report
      console.log(`\n===== Boilerplate Cleaning Report for "${category}" =====`);
      console.log(`Article: "${title?.substring(0, 60)}${title?.length > 60 ? '...' : ''}"`);
      console.log(`Original length: ${cleaningResult.cleaningLog.originalLength} chars`);
      console.log(`Cleaned length: ${cleaningResult.cleaningLog.finalLength} chars`);

      if (cleaningResult.cleaningLog.patternMatches.length > 0) {
        console.log(`\nPatterns removed (${cleaningResult.cleaningLog.patternMatches.length}):`);
        cleaningResult.cleaningLog.patternMatches.forEach(pm => {
          console.log(`  - ${pm.pattern}: ${pm.count} match(es)`);
        });
      }

      if (cleaningResult.matchingSentences.length > 0) {
        console.log(`\nShared sentences removed: ${cleaningResult.matchingSentences.length}`);
        cleaningResult.cleaningLog.sharedSentences.slice(0, 3).forEach(s => {
          console.log(`  - "${s}"`);
        });
        if (cleaningResult.cleaningLog.sharedSentences.length > 3) {
          console.log(`  ... and ${cleaningResult.cleaningLog.sharedSentences.length - 3} more`);
        }
      }

      if (cleaningResult.updatedArticleIds.length > 0) {
        console.log(`\nExisting articles re-cleaned (with embedding regeneration):`);
        cleaningResult.cleaningLog.existingArticlesRecleaned.forEach(a => {
          console.log(`  - ID ${a.id}: ${a.oldLength} -> ${a.newLength} chars`);
        });
      }
      console.log(`================================================\n`);
    }

    // Merge auto-extracted tickers with manual tickers
    let finalTickers = [];
    if (shouldExtractStockData) {
      // Combine auto and manual tickers, remove duplicates, sort
      const tickerSet = new Set([...autoTickers, ...manualTickers]);
      finalTickers = Array.from(tickerSet).sort();
    }

    // Save article to database with embedding for full article
    const result = await database.saveArticle(url, title, text, category, {
      publishedDate: shouldExtractStockData ? publishedDate : null,
      tickers: finalTickers
    });

    console.log(`✓ Article saved with full-text embedding (ID: ${result.id}) - ${result.title}`);
    console.log(`   Category: ${category}`);
    console.log(`   Saved ${text.length} chars of clean article content`);

    if (shouldExtractStockData) {
      if (publishedDate) {
        console.log(`   Published: ${new Date(publishedDate).toLocaleDateString()}`);
      }
      if (finalTickers.length > 0) {
        console.log(`   Tickers: ${finalTickers.join(', ')}`);
        if (manualTickers.length > 0) {
          console.log(`   Manual tickers added: ${manualTickers.join(', ')}`);
        }
      }
    }

    return {
      success: true,
      article: result,
      category: category
    };
  } catch (error) {
    console.error('Error saving article:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Get database statistics
ipcMain.handle('get-stats', async (event) => {
  try {
    const stats = await database.getStats();
    return stats;
  } catch (error) {
    console.error('Error getting stats:', error);
    return { error: error.message };
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

// Record news count handler
ipcMain.handle('record-news-count', async (event) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { success: false, error: 'No active tab' };

    // Use news scraper to count articles on current page
    const result = await newsScraper.countArticles(browserView.webContents);

    if (!result.success) {
      return result; // Return error from scraper
    }

    // Save to database
    const saved = await database.saveNewsCount(
      result.ticker,
      result.count,
      result.source,
      result.url
    );

    console.log(`✓ Recorded news count: ${saved.ticker} = ${saved.articleCount} articles (${saved.source})`);

    return {
      success: true,
      ticker: saved.ticker,
      count: saved.articleCount,
      recordedAt: saved.recordedAt,
      source: saved.source
    };
  } catch (error) {
    console.error('Error recording news count:', error);
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

          if (gapNegative) {
            classification = intradayPositive ? 'negative_anticipated' : 'surprising_negative';
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

// Portfolio diversification handlers
ipcMain.handle('portfolio-get-holdings', async () => {
  try {
    const holdings = await portfolioAnalyzer.getHoldings();
    return { success: true, holdings };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('portfolio-save-holding', async (event, ticker, shares) => {
  try {
    const result = await portfolioAnalyzer.saveHolding(ticker, shares);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('portfolio-remove-holding', async (event, ticker) => {
  try {
    const result = await portfolioAnalyzer.removeHolding(ticker);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('analyze-diversification', async (event, params) => {
  try {
    console.log('\nRunning diversification analysis...');
    const result = await portfolioAnalyzer.analyzeDiversification(params);
    const html = portfolioAnalyzer.generateDiversificationHTML(result);
    return { success: true, html, result };
  } catch (error) {
    console.error('Diversification analysis error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discover-candidates', async (event, holdingTickers) => {
  try {
    console.log('\nDiscovering candidate tickers from Finviz...');
    const browserView = getExtractionBrowserView();
    const result = await tickerDiscovery.discoverCandidates(browserView, holdingTickers);
    console.log(`Discovered ${result.stats.total} candidates (${result.stats.screenerTickers} from screener, ${result.stats.holdingRelatedTickers} from holdings)`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Ticker discovery error:', error);
    return { success: false, error: error.message };
  }
});

// Ticker screening handler
ipcMain.handle('screen-tickers', async (event, options = {}) => {
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Merge user options into config
    if (options.period) config.screenDays = Math.ceil(options.period * 1.4);
    if (options.lookbackDays) config.screenLookbackDays = options.lookbackDays;
    if (options.percentileThreshold) config.screenPercentileThreshold = options.percentileThreshold;

    const tickers = config.screenTickers || [];
    console.log(`\nRunning ticker screening on ${tickers.length} tickers...`);

    const hits = await screenTickers(priceTracker, config);

    // Sort by percentile descending
    hits.sort((a, b) => b.percentile - a.percentile);

    // Generate HTML results page
    const html = generateScreeningHTML(hits, tickers.length, config);

    return { success: true, html, hitCount: hits.length };
  } catch (error) {
    console.error('Screening error:', error);
    return { success: false, error: error.message };
  }
});

// Revise the 50 — auto-select screening tickers by fundamentals
ipcMain.handle('revise-tickers', async (event) => {
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'ci', 'config.json');

    console.log('\n[Revise] Starting ticker revision from ~200 universe...');

    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const onProgress = (current, total, ticker) => {
      mainWindow.webContents.send('revise-progress', { current, total, ticker });
    };

    const result = await reviseTickers(createYF, onProgress);

    // Update config.json with new tickers
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.screenTickers = result.tickers;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    console.log(`[Revise] Saved ${result.tickers.length} tickers to config.json`);

    return {
      success: true,
      tickers: result.tickers,
      details: result.details,
      excluded: result.excluded,
      errors: result.errors,
      totalScored: result.totalScored,
    };
  } catch (error) {
    console.error('Revise tickers error:', error);
    return { success: false, error: error.message };
  }
});

function generateScreeningHTML(hits, totalTickers, config) {
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

  const rows = hits.map(h => {
    const dateStr = h.date instanceof Date
      ? h.date.toISOString().split('T')[0]
      : new Date(h.date).toISOString().split('T')[0];
    const color = classColors[h.classification] || '#999';
    const label = classLabels[h.classification] || h.classification;
    return `<tr>
      <td style="font-weight:bold;">${h.ticker}</td>
      <td>${dateStr}</td>
      <td>${h.gap.toFixed(2)}%</td>
      <td>${h.percentile.toFixed(1)}%</td>
      <td style="color:${color}; font-weight:bold;">${label}</td>
      <td style="text-align:right;">${(h.volume / 1e6).toFixed(1)}M</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Ticker Screening Results</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #fafafa; color: #333; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .summary { color: #666; margin-bottom: 16px; font-size: 0.95em; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-size: 0.85em; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-top: 1px solid #eee; font-size: 0.95em; }
  tr:hover { background: #f9f9f9; }
  .no-hits { text-align: center; padding: 40px; color: #888; font-size: 1.1em; }
</style></head><body>
<h1>Ticker Screening Results</h1>
<p class="summary">${hits.length} hit${hits.length !== 1 ? 's' : ''} out of ${totalTickers} tickers screened &mdash; ${config.screenLookbackDays}d lookback, p${config.screenPercentileThreshold} threshold</p>
${hits.length > 0 ? `<table>
<thead><tr><th>Ticker</th><th>Date</th><th>Gap %</th><th>Percentile</th><th>Classification</th><th style="text-align:right;">Volume</th></tr></thead>
<tbody>${rows}</tbody>
</table>` : '<div class="no-hits">No screening hits found in the lookback period.</div>'}
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
app.whenReady().then(async () => {
  // Initialize database
  database = new ArticleDatabase('articles.db');
  try {
    await database.initialize();
    console.log('✓ Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }

  // Initialize price tracker
  priceTracker = new PriceTrackingService(database);

  // Initialize stock analyzer
  stockAnalyzer = new StockAnalysisService(database);

  // Initialize options analyzer
  optionsAnalyzer = new OptionsAnalysisService(database);
  portfolioAnalyzer = new PortfolioAnalysisService(database, stockAnalyzer, optionsAnalyzer);
  tickerDiscovery = new TickerDiscoveryService();
  chronosHoldService = new ChronosHoldPeriodService(database);

  // Inject options analyzer into price tracker for daily snapshot collection
  priceTracker.setOptionsAnalyzer(optionsAnalyzer);

  // Inject browser-based extractor into articleExtractor for JavaScript-rendered pages
  articleExtractor.setBrowserExtractor(extractArticleViaBrowser);
  console.log('✓ Browser-based article extraction enabled');

  // Check if auto-polling is enabled in settings
  const autoPolling = await database.getSetting('price_auto_polling', 'false');
  const pollingInterval = await database.getSetting('price_polling_interval', '15');

  if (autoPolling === 'true') {
    priceTracker.startPolling(parseInt(pollingInterval));
  }

  createWindow();
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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
