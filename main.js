require('dotenv').config();
const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const ArticleDatabase = require('./src/services/database');
const PriceTrackingService = require('./src/services/priceTracking');
const StockAnalysisService = require('./src/services/stockAnalysis');
const NewsHarvesterService = require('./src/services/newsHarvester');
const articleExtractor = require('./src/services/articleExtractor');
const newsScraper = require('./src/services/newsScraper');

let mainWindow;
let database;
let priceTracker;
let stockAnalyzer;
let newsHarvester;

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
function createTab(url = 'https://finance.yahoo.com') {
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

// Add ticker to watchlist
ipcMain.handle('add-watched-ticker', async (event, ticker, autoUpdate = true) => {
  try {
    const result = await database.addWatchedTicker(ticker, autoUpdate);
    return { success: true, ticker: result };
  } catch (error) {
    console.error('Error adding watched ticker:', error);
    return { success: false, error: error.message };
  }
});

// Remove ticker from watchlist
ipcMain.handle('remove-watched-ticker', async (event, ticker) => {
  try {
    await database.removeWatchedTicker(ticker);
    return { success: true };
  } catch (error) {
    console.error('Error removing watched ticker:', error);
    return { success: false, error: error.message };
  }
});

// Get all watched tickers
ipcMain.handle('get-watched-tickers', async (event, autoUpdateOnly = false) => {
  try {
    const tickers = await database.getWatchedTickers(autoUpdateOnly);
    return { success: true, tickers };
  } catch (error) {
    console.error('Error getting watched tickers:', error);
    return { success: false, error: error.message };
  }
});

// Check if ticker is watched
ipcMain.handle('is-ticker-watched', async (event, ticker) => {
  try {
    const isWatched = await database.isTickerWatched(ticker);
    return { success: true, isWatched };
  } catch (error) {
    console.error('Error checking if ticker is watched:', error);
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
      fetchNews = true,
      newsDayRange = 1,
      maxArticles = 10
    } = options;

    console.log(`\nAnalyzing stock events for ${ticker}...`);
    console.log(`Options: benchmark=${benchmark}, days=${days}, minEvents=${minEvents}, dataSource=${dataSource}, fetchNews=${fetchNews}`);

    // Run analysis pipeline
    const result = await stockAnalyzer.analyzeStock(ticker, {
      benchmark,
      days,
      minEvents,
      dataSource,
    });

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

    // Generate HTML report with events and existing articles (return immediately)
    const html = stockAnalyzer.generateAnalysisHTML(
      result.data,
      result.events,
      ticker
    );

    console.log(`\nAnalysis complete: ${result.events.length} events found`);
    console.log(`Events display ready - fetching news in background...`);

    // START: Fetch news in background (don't wait, user sees events immediately)
    if (fetchNews && result.events.length > 0) {
      // Background task - doesn't block the response
      // Use setTimeout to give renderer time to create the new tab first
      setTimeout(async () => {
        // Get the BrowserView NOW (after renderer has created the tab)
        const analysisBrowserView = getActiveBrowserView();
        const analysisTabId = activeTabId;
        try {
          console.log(`\nBackground: Fetching Yahoo Finance news for events...`);
          await stockAnalyzer.fetchEventNews(result.events, ticker, {
            dayRange: newsDayRange,
            maxArticlesPerEvent: maxArticles
          });
          console.log(`\nBackground: News fetch and storage complete`);

          // Re-run article finding now that news is in the database
          console.log(`Background: Re-finding articles with newly saved news...`);
          for (const eventData of result.events) {
            const existingArticles = await stockAnalyzer.findRelatedArticles(
              eventData.date,
              ticker,
              3
            );
            eventData.articles = await stockAnalyzer.calculateArticleSimilarities(existingArticles);
          }

          // Re-generate HTML with updated articles
          const updatedHtml = stockAnalyzer.generateAnalysisHTML(
            result.data,
            result.events,
            ticker
          );

          // Load the new HTML into the BrowserView
          if (analysisBrowserView && analysisBrowserView.webContents) {
            try {
              console.log(`Background: Loading updated analysis page for ${ticker}...`);
              const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(updatedHtml);
              await analysisBrowserView.webContents.loadURL(dataUrl);
              console.log(`Background: Updated analysis page loaded successfully`);
            } catch (error) {
              console.error(`Background: Failed to load updated page: ${error.message}`);
            }
          } else {
            console.log(`Background: BrowserView not available for update`);
          }

        } catch (error) {
          console.error('Background: Error fetching news:', error.message);
        }
      }, 500); // 500ms delay to let renderer create the tab first
    }

    return {
      success: true,
      html,
      eventCount: result.events.length,
      newsLoadingInBackground: fetchNews && result.events.length > 0,
      stats: result.stats
    };
  } catch (error) {
    console.error('Error analyzing stock events:', error);
    return { success: false, error: error.message };
  }
});

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

// === News Harvester Handlers ===

// Start/stop news harvester
ipcMain.handle('toggle-news-harvester', async (event, enabled, intervalMinutes = 60) => {
  try {
    if (enabled) {
      newsHarvester.start({ intervalMinutes, runImmediately: false });
      await database.setSetting('news_harvester_enabled', 'true');
      await database.setSetting('news_harvester_interval', intervalMinutes.toString());
    } else {
      newsHarvester.stop();
      await database.setSetting('news_harvester_enabled', 'false');
    }
    return { success: true, enabled, intervalMinutes };
  } catch (error) {
    console.error('Error toggling news harvester:', error);
    return { success: false, error: error.message };
  }
});

// Get harvester status
ipcMain.handle('get-harvester-status', async (event) => {
  try {
    const status = newsHarvester.getStatus();
    return { success: true, ...status };
  } catch (error) {
    console.error('Error getting harvester status:', error);
    return { success: false, error: error.message };
  }
});

// Manually trigger a harvest
ipcMain.handle('trigger-harvest', async (event) => {
  try {
    const results = await newsHarvester.harvest();
    return { success: true, results };
  } catch (error) {
    console.error('Error triggering harvest:', error);
    return { success: false, error: error.message };
  }
});

// Harvest specific tickers
ipcMain.handle('harvest-tickers', async (event, tickers) => {
  try {
    const results = await newsHarvester.harvestTickers(tickers);
    return { success: true, results };
  } catch (error) {
    console.error('Error harvesting tickers:', error);
    return { success: false, error: error.message };
  }
});

// Get corpus statistics
ipcMain.handle('get-corpus-stats', async (event) => {
  try {
    const stats = await database.getCorpusStats();
    return { success: true, stats };
  } catch (error) {
    console.error('Error getting corpus stats:', error);
    return { success: false, error: error.message };
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

  // Inject browser-based extractor into articleExtractor for JavaScript-rendered pages
  articleExtractor.setBrowserExtractor(extractArticleViaBrowser);
  console.log('✓ Browser-based article extraction enabled');

  // Initialize news harvester
  newsHarvester = new NewsHarvesterService(database);

  // Check if auto-polling is enabled in settings
  const autoPolling = await database.getSetting('price_auto_polling', 'false');
  const pollingInterval = await database.getSetting('price_polling_interval', '15');

  if (autoPolling === 'true') {
    priceTracker.startPolling(parseInt(pollingInterval));
  }

  // Check if watchlist auto-harvest is enabled (defaults to true)
  const watchlistAutoHarvest = await database.getSetting('watchlist_auto_harvest', 'true');

  if (watchlistAutoHarvest === 'true') {
    const INITIAL_DELAY_MS = 10 * 60 * 1000;  // 10 minutes
    const HOURLY_INTERVAL = 60;                // 60 minutes

    console.log('NewsHarvester: Will start in 10 minutes, then run hourly');

    setTimeout(() => {
      console.log('NewsHarvester: Starting initial harvest after 10-minute delay');
      newsHarvester.start({
        intervalMinutes: HOURLY_INTERVAL,
        runImmediately: true  // Run immediately when timer fires
      });
    }, INITIAL_DELAY_MS);
  }

  createWindow();
});

app.on('window-all-closed', async () => {
  // Stop price polling
  if (priceTracker) {
    priceTracker.stopPolling();
  }

  // Stop news harvester
  if (newsHarvester) {
    newsHarvester.stop();
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
