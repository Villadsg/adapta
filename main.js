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

    // Override tickers if provided (bypass saved list)
    if (options.overrideTickers && options.overrideTickers.length > 0) {
      config.screenTickers = options.overrideTickers;
    }

    // Filter to favorites only if requested
    if (options.favoritesOnly) {
      const favs = loadFavorites();
      if (favs.length > 0) {
        config.screenTickers = (config.screenTickers || []).filter(t => favs.includes(t));
      }
    }

    const tickers = config.screenTickers || [];
    console.log(`\nRunning ticker screening on ${tickers.length} tickers...`);

    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    const result = await screenTickers(priceTracker, config, createYF);

    // Sort allTickers: hits first (by percentile desc), then non-hits alphabetically
    result.allTickers.sort((a, b) => {
      const aHit = a.classification ? 1 : 0;
      const bHit = b.classification ? 1 : 0;
      if (aHit !== bHit) return bHit - aHit;
      if (aHit && bHit) return (b.percentile || 0) - (a.percentile || 0);
      return (a.ticker || '').localeCompare(b.ticker || '');
    });

    // Fetch top 5 Finviz news headlines per ticker (if enabled)
    if (options.fetchNews) {
      for (const entry of result.allTickers) {
        if (!entry.ticker || entry.skipped || entry.error) continue;
        try {
          const headlines = await fetchFinvizNews(entry.ticker);
          entry.news = (headlines || []).slice(0, 5);
        } catch (_) { entry.news = []; }
      }
    }

    // Save weighted IV history
    const ivHistoryPath = path.join(__dirname, 'ci', 'weighted-iv-history.json');
    let ivHistory = {};
    try { ivHistory = JSON.parse(fs.readFileSync(ivHistoryPath, 'utf-8')); } catch (_) {}
    const today = new Date().toISOString().split('T')[0];
    for (const entry of result.allTickers) {
      const od = entry.chartData?.optionsStrikes;
      if (!od || od.length === 0) continue;
      if (!ivHistory[entry.ticker]) ivHistory[entry.ticker] = [];
      const record = { date: today };
      if (od[0]) { record.exp1 = { label: od[0].label, callIV: od[0].wCallIV, putIV: od[0].wPutIV }; }
      if (od[1]) { record.exp2 = { label: od[1].label, callIV: od[1].wCallIV, putIV: od[1].wPutIV }; }
      // Replace if same date exists, otherwise append
      const existing = ivHistory[entry.ticker].findIndex(r => r.date === today);
      if (existing >= 0) ivHistory[entry.ticker][existing] = record;
      else ivHistory[entry.ticker].push(record);
    }
    fs.writeFileSync(ivHistoryPath, JSON.stringify(ivHistory, null, 2) + '\n', 'utf-8');

    // Load IV history for HTML generation
    const ivHistoryForHTML = {};
    for (const entry of result.allTickers) {
      if (ivHistory[entry.ticker]) ivHistoryForHTML[entry.ticker] = ivHistory[entry.ticker];
    }

    // Generate HTML results page
    const currentFavorites = loadFavorites();
    const html = generateScreeningHTML(result.allTickers, tickers.length, config, ivHistoryForHTML, currentFavorites);

    // Save HTML for "Latest Run Results"
    const screenResultsPath = path.join(__dirname, 'ci', 'screening-results.html');
    fs.writeFileSync(screenResultsPath, html, 'utf-8');
    console.log('[Screen] Results saved to ci/screening-results.html');

    return { success: true, filePath: screenResultsPath, hitCount: result.hits.length };
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

    // Save full results for later viewing
    const resultsPath = path.join(__dirname, 'ci', 'revise-results.json');
    const fullResults = {
      timestamp: new Date().toISOString(),
      tickers: result.tickers,
      details: result.details,
      excluded: result.excluded,
      errors: result.errors,
      totalScored: result.totalScored,
    };
    fs.writeFileSync(resultsPath, JSON.stringify(fullResults, null, 2) + '\n', 'utf-8');

    console.log(`[Revise] Saved ${result.tickers.length} tickers to config.json`);
    console.log(`[Revise] Full results saved to ci/revise-results.json`);

    return { success: true, ...fullResults };
  } catch (error) {
    console.error('Revise tickers error:', error);
    return { success: false, error: error.message };
  }
});

// Load last Revise the 50 results from disk
ipcMain.handle('load-revise-results', async () => {
  try {
    const fs = require('fs');
    const resultsPath = path.join(__dirname, 'ci', 'revise-results.json');
    if (!fs.existsSync(resultsPath)) {
      return { success: false, error: 'No previous revision results found. Run "Revise the 50" first.' };
    }
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    return { success: true, ...data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load last screening results from disk
ipcMain.handle('load-screening-results', async () => {
  try {
    const fs = require('fs');
    const resultsPath = path.join(__dirname, 'ci', 'screening-results.html');
    if (!fs.existsSync(resultsPath)) {
      return { success: false, error: 'No previous screening results found. Run screening first.' };
    }
    return { success: true, filePath: resultsPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

const FAVORITES_PATH = path.join(__dirname, 'ci', 'screening-favorites.json');

function loadFavorites() {
  try { return JSON.parse(require('fs').readFileSync(FAVORITES_PATH, 'utf-8')); } catch (_) { return []; }
}

function saveFavorites(favs) {
  require('fs').writeFileSync(FAVORITES_PATH, JSON.stringify(favs, null, 2) + '\n', 'utf-8');
}

ipcMain.handle('toggle-favorite', async (event, ticker) => {
  const favs = loadFavorites();
  const idx = favs.indexOf(ticker);
  if (idx >= 0) { favs.splice(idx, 1); } else { favs.push(ticker); }
  saveFavorites(favs);
  return { favorites: favs };
});

ipcMain.handle('get-favorites', async () => {
  return { favorites: loadFavorites() };
});

function generateScreeningHTML(allTickers, totalTickers, config, ivHistoryData = {}, favorites = []) {
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
  const favSet = new Set(favorites);

  // Build chart data JSON and summary map for each ticker
  const chartDataMap = {};
  const summaryMap = {};
  const newsMap = {};
  const tickerIVs = {}; // { ticker: { callIV, putIV } } — nearest expiry weighted IV
  const tickerOptDV = {}; // { ticker: totalDollarVol } — sum of call+put dollar vol across strikes
  for (const h of allTickers) {
    if (h.chartData && h.chartData.dates && h.chartData.dates.length > 0) {
      chartDataMap[h.ticker] = h.chartData;
      const os = h.chartData.optionsStrikes;
      if (os && os.length > 0) {
        if (os[0].wCallIV > 0 || os[0].wPutIV > 0) {
          tickerIVs[h.ticker] = { callIV: os[0].wCallIV, putIV: os[0].wPutIV };
        }
        const exp = os[0];
        let totalDV = 0;
        for (const c of exp.calls) totalDV += c.dollarVol || 0;
        for (const p of exp.puts) totalDV += p.dollarVol || 0;
        if (totalDV > 0) tickerOptDV[h.ticker] = totalDV;
      }
    }
    if (h.summary) summaryMap[h.ticker] = h.summary;
    if (h.news && h.news.length > 0) newsMap[h.ticker] = h.news;
  }

  // Compute average weighted IV across all tickers with data
  const ivTickers = Object.keys(tickerIVs);
  let avgCallIV = 0, avgPutIV = 0;
  if (ivTickers.length > 0) {
    avgCallIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].callIV, 0) / ivTickers.length * 10) / 10;
    avgPutIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].putIV, 0) / ivTickers.length * 10) / 10;
  }

  const rows = allTickers.map((h, idx) => {
    const hasEvent = !!h.classification;
    const dateStr = h.date
      ? (h.date instanceof Date ? h.date.toISOString().split('T')[0] : new Date(h.date).toISOString().split('T')[0])
      : '';
    const color = classColors[h.classification] || '#ccc';
    const label = classLabels[h.classification] || '';
    const r2 = h.rSquared != null ? h.rSquared.toFixed(3) : '—';
    const r2Val = h.rSquared != null ? h.rSquared : -1;
    const hasChart = !!chartDataMap[h.ticker];
    const inlineStyle = (hasEvent ? '' : 'color:#aaa;') + (hasChart ? ' cursor:pointer;' : '');

    const mcap = h.marketCap || 0;
    const mcapStr = mcap >= 1e9 ? (mcap / 1e9).toFixed(1) + 'B' : mcap >= 1e6 ? (mcap / 1e6).toFixed(0) + 'M' : '';

    const optDV = tickerOptDV[h.ticker] || 0;
    const optDVStr = optDV >= 1e9 ? '$' + (optDV / 1e9).toFixed(1) + 'B' : optDV >= 1e6 ? '$' + (optDV / 1e6).toFixed(1) + 'M' : optDV >= 1e3 ? '$' + (optDV / 1e3).toFixed(0) + 'K' : optDV > 0 ? '$' + optDV.toFixed(0) : '';

    const tiv = tickerIVs[h.ticker];
    const callIVStr = tiv ? tiv.callIV.toFixed(1) + '%' : '';
    const putIVStr = tiv ? tiv.putIV.toFixed(1) + '%' : '';
    const callIVVal = tiv ? tiv.callIV : -1;
    const putIVVal = tiv ? tiv.putIV : -1;

    const isFav = favSet.has(h.ticker);

    return `<tr ${hasChart ? `class="data-row" data-ticker="${h.ticker}"` : ''} style="${inlineStyle}">
      <td style="text-align:center; width:28px; padding:4px;" data-v="${isFav ? 1 : 0}"><span class="fav-star" data-ticker="${h.ticker}" style="cursor:pointer; font-size:1.1em; color:${isFav ? '#f5c518' : '#ccc'};" title="Toggle favorite">${isFav ? '\u2605' : '\u2606'}</span></td>
      <td data-v="${h.ticker}" style="font-weight:bold;">${h.ticker}${hasChart ? ' <span style="font-size:0.7em;color:#aaa;">▶</span>' : ''}</td>
      <td data-v="${dateStr || 'zzz'}">${dateStr}</td>
      <td data-v="${h.gap || 0}">${h.gap ? h.gap.toFixed(2) + '%' : ''}</td>
      <td data-v="${h.percentile || 0}">${h.percentile ? h.percentile.toFixed(1) + '%' : ''}</td>
      <td data-v="${h.classification || 'zzz'}" style="color:${color}; font-weight:bold;">${label}</td>
      <td data-v="${h.volume || 0}" style="text-align:right;">${h.volume ? (h.volume / 1e6).toFixed(1) + 'M' : ''}</td>
      <td data-v="${r2Val}" style="text-align:right;">${r2}</td>
      <td data-v="${mcap}" style="text-align:right;">${mcapStr}</td>
      <td data-v="${optDV}" style="text-align:right;">${optDVStr}</td>
      <td data-v="${callIVVal}" style="text-align:right; color:rgba(72,187,120,0.9);">${callIVStr}</td>
      <td data-v="${putIVVal}" style="text-align:right; color:rgba(245,101,101,0.9);">${putIVStr}</td>
    </tr>
    <tr class="chart-row" data-chart-for="${h.ticker}" style="display:none;">
      <td colspan="12" style="padding:0; background:#1a1a2e;">
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
          </div>
          <div id="iv-history-wrap-${h.ticker}" style="display:none; padding:8px 0; height:200px;">
            <canvas id="iv-history-chart-${h.ticker}"></canvas>
          </div>
        </div>
        <div id="summary-${h.ticker}" style="padding:4px 20px 14px; color:#999; font-size:0.92em; line-height:1.5; max-height:140px; overflow-y:auto;"></div>
        <div id="news-${h.ticker}" style="padding:4px 20px 14px;"></div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Ticker Screening Results</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #fafafa; color: #333; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .summary { color: #666; margin-bottom: 16px; font-size: 0.95em; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  #screen-table th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-size: 0.85em; color: #666; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none; }
  #screen-table th:hover { color: #333; background: #eee; }
  #screen-table th .sort-arrow { font-size: 0.7em; margin-left: 3px; color: #bbb; }
  #screen-table th.sorted-asc .sort-arrow, #screen-table th.sorted-desc .sort-arrow { color: #333; }
  td { padding: 8px 12px; border-top: 1px solid #eee; font-size: 0.95em; }
  tr.data-row:hover { background: #f0f4ff; }
  tr:hover { background: #f9f9f9; }
  .chart-row td { border-top: none; }
</style></head><body>
<h1>Ticker Screening Results</h1>
<p class="summary">${hitCount} hit${hitCount !== 1 ? 's' : ''} out of ${totalTickers} tickers screened &mdash; ${config.screenLookbackDays}d lookback, p${config.screenPercentileThreshold} threshold</p>
${ivTickers.length > 0 ? `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <span style="color:#666; font-weight:600;">Avg Weighted IV (${ivTickers.length} tickers):</span>
  <span style="color:rgba(72,187,120,0.9); font-weight:bold; margin-left:10px;">Call ${avgCallIV.toFixed(1)}%</span>
  <span style="color:rgba(245,101,101,0.9); font-weight:bold; margin-left:10px;">Put ${avgPutIV.toFixed(1)}%</span>
</div>` : ''}
<table id="screen-table">
<thead><tr>
  <th style="width:28px; text-align:center; padding:4px;"><span class="sort-arrow"></span></th>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th>Date<span class="sort-arrow"></span></th>
  <th>Gap %<span class="sort-arrow"></span></th>
  <th>Percentile<span class="sort-arrow"></span></th>
  <th>Classification<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Volume<span class="sort-arrow"></span></th>
  <th style="text-align:right;">R&sup2; (SPY)<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Mkt Cap<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Opt $ Vol<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Call IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Put IV<span class="sort-arrow"></span></th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<script>
(function() {
  const chartDataMap = ${JSON.stringify(chartDataMap)};
  const summaryMap = ${JSON.stringify(summaryMap)};
  const newsMap = ${JSON.stringify(newsMap)};
  const ivHistoryMap = ${JSON.stringify(ivHistoryData)};
  // Favorite star click handler
  document.querySelectorAll('.fav-star').forEach(star => {
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = star.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.toggleFavorite) return;
      const result = await window.electronAPI.toggleFavorite(ticker);
      const isFav = result.favorites.includes(ticker);
      star.textContent = isFav ? '\\u2605' : '\\u2606';
      star.style.color = isFav ? '#f5c518' : '#ccc';
      star.closest('td').setAttribute('data-v', isFav ? '1' : '0');
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

        // Populate news headlines
        const newsEl = document.getElementById('news-' + ticker);
        const news = newsMap[ticker];
        if (newsEl && news && news.length > 0) {
          newsEl.innerHTML = news.map(n =>
            '<div style="margin-bottom:6px; font-size:0.95em; line-height:1.5;">' +
              '<span style="color:#666; font-size:0.85em; margin-right:6px;">' + (n.date ? n.date + ' ' : '') + (n.time || '') + '</span>' +
              '<a href="' + n.url + '" style="color:#7aa2c7; text-decoration:none;">' + n.headline + '</a>' +
            '</div>'
          ).join('');
        }

        // Render options strike charts (nearest 2 expirations side by side)
        const od = cd.optionsStrikes;
        if (od && od.length > 0) {
          const optsWrap = document.getElementById('opts-wrap-' + ticker);
          if (optsWrap) {
            optsWrap.style.display = 'block';
            const fmtDollar = (v) => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(0)+'K' : '$'+v.toFixed(0);

            for (let ei = 0; ei < Math.min(2, od.length); ei++) {
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
                ivLabel.innerHTML = '<span style="color:rgba(72,187,120,0.9);">Call IV: ' + exp.wCallIV.toFixed(1) + '%</span> | <span style="color:rgba(245,101,101,0.9);">Put IV: ' + exp.wPutIV.toFixed(1) + '%</span> <span style="color:#555; font-size:0.85em;">($-weighted)</span>';
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
              const datasets = [];
              if (hist[0].exp1) {
                datasets.push({ label: 'Exp1 Call IV', data: hist.map(r => r.exp1 ? r.exp1.callIV : null), borderColor: 'rgba(72,187,120,0.9)', borderWidth: 2, pointRadius: 3, fill: false, spanGaps: true });
                datasets.push({ label: 'Exp1 Put IV', data: hist.map(r => r.exp1 ? r.exp1.putIV : null), borderColor: 'rgba(245,101,101,0.9)', borderWidth: 2, pointRadius: 3, fill: false, spanGaps: true });
              }
              if (hist[0].exp2) {
                datasets.push({ label: 'Exp2 Call IV', data: hist.map(r => r.exp2 ? r.exp2.callIV : null), borderColor: 'rgba(72,187,120,0.4)', borderWidth: 2, pointRadius: 3, borderDash: [5,3], fill: false, spanGaps: true });
                datasets.push({ label: 'Exp2 Put IV', data: hist.map(r => r.exp2 ? r.exp2.putIV : null), borderColor: 'rgba(245,101,101,0.4)', borderWidth: 2, pointRadius: 3, borderDash: [5,3], fill: false, spanGaps: true });
              }

              ivHistChart = new Chart(histCanvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  plugins: {
                    title: { display: true, text: 'Weighted IV History — ' + ticker, color: '#b0b0b0', font: { size: 11 } },
                    legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                    tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + (ctx.raw != null ? ctx.raw.toFixed(1) + '%' : 'N/A'); } } },
                  },
                  scales: {
                    x: { ticks: { color: '#909090', font: { size: 9 } }, grid: { color: '#2a2a4a' } },
                    y: { ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } }, grid: { color: '#2a2a4a' } },
                  },
                },
              });
            }

            for (let li = 0; li < 2; li++) {
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
        ascending = (colIdx === 1 || colIdx === 5);
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
