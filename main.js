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

const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const ArticleDatabase = require('./src/services/database');
const PriceTrackingService = require('./src/services/priceTracking');
const StockAnalysisService = require('./src/services/stockAnalysis');
const OptionsAnalysisService = require('./src/services/optionsAnalysis');
const IBOptionsProvider = require('./src/services/ibOptionsProvider');
const articleExtractor = require('./src/services/articleExtractor');
const newsScraper = require('./src/services/newsScraper');
const ChronosHoldPeriodService = require('./src/services/chronosHoldPeriod');
const GLMAnalysisService = require('./src/services/glmAnalysis');
const { screenTickers, reviseTickers } = require('./ci/ticker-screen');
const { classifyTickerNews } = require('./src/services/newsClassifier');
const YahooFinance = require('yahoo-finance2').default;
const bunBridge = require('./src/services/bunBridge');
const { JSDOM } = require('jsdom');

let mainWindow;
let database;
let priceTracker;
let stockAnalyzer;
let optionsAnalyzer;
let chronosHoldService;
let glmAnalyzer;

// TTS state
let activeTtsProcess = null;
let ttsEnabled = true;
const ttsPythonScript = path.join(__dirname, 'python', 'tts_speak.py');
const ttsVoiceRef = path.join(__dirname, 'python', 'voice_ref.wav');
const ttsVoicesDir = path.join(require('os').homedir(), 'Documents', 'adapta', 'voices');

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
 * Fetch news headlines from Finviz for a given ticker via direct HTTP (no BrowserView).
 * @param {string} ticker
 * @returns {Promise<Array<{date: string, time: string, headline: string, url: string}>>}
 */
async function fetchFinvizNews(ticker) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`;
  const html = await bunBridge.fetchHTML(url, { timeout: 15000 });
  const { document } = new JSDOM(html).window;

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
    height: height - 136 // 96 (top bars) + 28 (analysis bar at bottom)
  });
}

// TTS: inject MutationObserver into claude.ai tabs to detect finished responses
function injectClaudeTTS(browserView) {
  const url = browserView.webContents.getURL();
  if (!url.includes('claude.ai')) return;

  browserView.webContents.executeJavaScript(`
    (function() {
      const currentPath = location.pathname;
      if (window.__claudeTTSPath === currentPath) return;
      window.__claudeTTSPath = currentPath;

      const seen = new WeakSet();
      const seenTexts = new Set();
      const injectedAt = Date.now();

      function extractText(el) {
        // Clone so we can remove citation/source elements before reading
        const clone = el.cloneNode(true);
        // Remove citation superscripts, footnotes, and source link sections
        clone.querySelectorAll([
          'sup',                          // superscript citation numbers
          '[data-testid="citation"]',     // claude citation markers
          '[data-testid="sources"]',      // sources section
          '.citation',
          'ol li a[href]',                // numbered source links
        ].join(',')).forEach(n => n.remove());
        return (clone.innerText || clone.textContent || '').trim();
      }

      function maybeSpeak(el) {
        if (seen.has(el)) return;
        seen.add(el);
        if (Date.now() - injectedAt < 800) return;
        const raw = extractText(el);
        if (raw.length < 20) return;
        // Dedup by first 80 chars to catch double-firing mutations
        const key = raw.slice(0, 80);
        if (seenTexts.has(key)) return;
        seenTexts.add(key);
        const capped = raw
          .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, ' [code block] ')
          .replace(/[*_\`#>]/g, '')
          .replace(/\\n{2,}/g, '. ')
          .replace(/\\n/g, ' ')
          .replace(/ {2,}/g, ' ')
          .trim()
          .slice(0, 3000);
        window.electronAPI.speakText(capped);
      }

      const ASSISTANT_SEL = '[data-testid="assistant-message"][data-is-streaming="false"], [data-is-streaming="false"]:not([data-testid="human-turn"])';

      function isAssistant(el) {
        // Must have data-is-streaming="false" and not be a human turn
        if (!el.matches) return false;
        if (el.matches('[data-testid="human-turn"], [data-testid="human-message"]')) return false;
        return el.matches('[data-is-streaming="false"]');
      }

      function checkEl(el) {
        if (!el || el.nodeType !== 1) return;
        if (isAssistant(el)) maybeSpeak(el);
        const nodes = el.querySelectorAll ? el.querySelectorAll(ASSISTANT_SEL) : [];
        for (const n of nodes) {
          if (isAssistant(n)) maybeSpeak(n);
        }
      }

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            for (const node of m.addedNodes) checkEl(node);
          } else if (m.type === 'attributes' && m.attributeName === 'data-is-streaming') {
            if (m.target.getAttribute('data-is-streaming') === 'false' && isAssistant(m.target)) maybeSpeak(m.target);
          }
        }
      });

      observer.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['data-is-streaming']
      });
    })()
  `).catch(() => {});
}

// Kill TTS process group (Python + aplay child)
function killTtsProcess() {
  const proc = activeTtsProcess;
  activeTtsProcess = null;
  if (!proc) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch (_) {
    try { proc.kill('SIGKILL'); } catch (_2) {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tts-state-changed', { speaking: false });
  }
}

// Serializes TTS requests: if a spawn is in-flight (awaiting settings), queue
// only the latest text so we never run two at once.
let ttsSpawning = false;
let ttsPending = null;

// TTS: spawn OmniVoice Python subprocess to synthesize and play text
async function spawnOmniVoiceTTS(text) {
  if (!ttsEnabled || !text) return;

  // If already spawning, just replace the pending text and return
  if (ttsSpawning) {
    ttsPending = text;
    killTtsProcess();
    return;
  }

  killTtsProcess();
  ttsSpawning = true;

  try {
    const fs = require('fs');
    const payload = { text };
    const [savedVoice, savedSpeed, savedQuality] = await Promise.all([
      database ? database.getSetting('tts_voice', null).catch(() => null) : null,
      database ? database.getSetting('tts_speed', '1.2').catch(() => '1.2') : '1.2',
      database ? database.getSetting('tts_quality', '16').catch(() => '16') : '16',
    ]);
    const voicePath = savedVoice || ttsVoiceRef;
    if (fs.existsSync(voicePath)) payload.ref_audio = voicePath;
    payload.speed = parseFloat(savedSpeed) || 1.2;
    payload.num_step = parseInt(savedQuality) || 16;

    // If stop was requested during the await, bail out
    if (!ttsEnabled) { ttsSpawning = false; return; }

    const child = spawn('python3', [ttsPythonScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,  // own process group so we can kill the whole group
    });

    activeTtsProcess = child;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tts-state-changed', { speaking: true });
    }

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on('close', () => {
      if (activeTtsProcess === child) {
        activeTtsProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tts-state-changed', { speaking: false });
        }
      }
      ttsSpawning = false;
      // If a new text arrived while we were busy, speak it now
      if (ttsPending) {
        const next = ttsPending;
        ttsPending = null;
        spawnOmniVoiceTTS(next);
      }
    });

    child.on('error', (err) => {
      console.error('TTS subprocess error:', err.message);
      if (activeTtsProcess === child) activeTtsProcess = null;
      ttsSpawning = false;
      if (ttsPending) {
        const next = ttsPending;
        ttsPending = null;
        spawnOmniVoiceTTS(next);
      }
    });

  } catch (err) {
    console.error('TTS spawn error:', err.message);
    ttsSpawning = false;
  }
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
    setTimeout(() => injectClaudeTTS(browserView), 400);
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
        /* Hide overlay/modal popups and their backdrops */
        [class*="modal"], [class*="Modal"],
        [class*="overlay"], [class*="Overlay"],
        [class*="paywall"], [class*="Paywall"],
        [class*="signup-wall"], [class*="SignupWall"],
        [class*="gate"], [class*="Gate"],
        [role="dialog"],
        .ReactModal__Overlay,
        .ReactModal__Content {
          display: none !important;
        }
        /* Restore scrolling if the modal locks the body */
        body, html {
          overflow: auto !important;
          position: static !important;
        }
      `);
    }
    injectClaudeTTS(browserView);
  });

  // Right-click context menu with TTS option for selected text
  browserView.webContents.on('context-menu', (event, params) => {
    const selectedText = params.selectionText.trim();
    if (!selectedText) return;

    const menu = Menu.buildFromTemplate([
      {
        label: '🔊 Play with TTS',
        click: () => spawnOmniVoiceTTS(selectedText),
      },
    ]);
    menu.popup({ window: mainWindow });
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

// Ticker screening handler
ipcMain.handle('screen-tickers', async (event, options = {}) => {
  try {
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

    // Filter to super favorites only if requested (takes priority over favoritesOnly)
    if (options.superOnly) {
      const supers = loadSuperFavorites();
      if (supers.length > 0) {
        config.screenTickers = supers;
      }
    } else if (options.favoritesOnly) {
      // Include both regular and super favorites, even if not in the 100 list
      const favs = loadFavorites();
      const supers = loadSuperFavorites();
      const combined = Array.from(new Set([...favs, ...supers]));
      if (combined.length > 0) {
        config.screenTickers = combined;
      }
    }

    const tickers = config.screenTickers || [];
    console.log(`\nRunning ticker screening on ${tickers.length} tickers...`);

    const createYF = () => new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // Collect entries to fetch news for; fetched in parallel after screening completes
    const newsFetchEntries = [];
    const onTickerDone = options.fetchNews ? (entry) => {
      if (entry.ticker && !entry.skipped && !entry.error) newsFetchEntries.push(entry);
    } : null;
    const result = await screenTickers(priceTracker, config, createYF, onTickerDone, database);

    // Fetch Finviz headlines in parallel (HTTP, no BrowserView bottleneck)
    if (options.fetchNews && newsFetchEntries.length > 0) {
      await Promise.all(newsFetchEntries.map(async (entry) => {
        try {
          entry.news = await fetchFinvizNews(entry.ticker);
        } catch (_) { entry.news = []; }
      }));
    }

    // Sort allTickers: hits first (by percentile desc), then non-hits alphabetically
    result.allTickers.sort((a, b) => {
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
      const record = { date: today, sector: entry.sector || '' };
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
    }
    fs.writeFileSync(ivHistoryPath, JSON.stringify(ivHistory, null, 2) + '\n', 'utf-8');

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
    // deviation from 50 is the signal. Requires ≥10 prior history records per event.
    const PRE_EVENT_MIN_HIST = 10;
    const preEventByClass = {
      surprising_positive: { callIVRanks: [], putIVRanks: [], callSpreadRanks: [], putSpreadRanks: [] },
      positive_anticipated: { callIVRanks: [], putIVRanks: [], callSpreadRanks: [], putSpreadRanks: [] },
      negative_anticipated: { callIVRanks: [], putIVRanks: [], callSpreadRanks: [], putSpreadRanks: [] },
      surprising_negative: { callIVRanks: [], putIVRanks: [], callSpreadRanks: [], putSpreadRanks: [] },
    };
    const rankIn = (arr, val) => {
      if (!arr || arr.length < PRE_EVENT_MIN_HIST) return null;
      let below = 0;
      for (const v of arr) if (v <= val) below++;
      return (below / arr.length) * 100;
    };
    for (const ev of eventLog) {
      const bucket = preEventByClass[ev.classification];
      if (!bucket) continue;
      const history = ivHistory[ev.ticker];
      if (!Array.isArray(history) || history.length === 0) continue;
      // Point-in-time: only records strictly before the event date, with valid combined IV.
      const priorRecords = history.filter(r => r && r.date && combineHistRecord(r) && r.date < ev.eventDate);
      if (priorRecords.length < PRE_EVENT_MIN_HIST) continue;
      // Latest of those is the "pre-event snapshot" to be ranked.
      priorRecords.sort((a, b) => a.date.localeCompare(b.date));
      const prior = combineHistRecord(priorRecords[priorRecords.length - 1]);
      // Build historical series from the point-in-time set (includes the prior itself).
      const callIVs = [], putIVs = [], callSpreads = [], putSpreads = [];
      for (const r of priorRecords) {
        const e = combineHistRecord(r);
        if (!e) continue;
        if (e.callIV > 0) callIVs.push(e.callIV);
        if (e.putIV > 0) putIVs.push(e.putIV);
        if (e.callIV != null && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
        if (e.putIV != null && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
      }
      const cR = prior.callIV > 0 ? rankIn(callIVs, prior.callIV) : null;
      const pR = prior.putIV > 0 ? rankIn(putIVs, prior.putIV) : null;
      const cSR = (prior.callIV != null && prior.atmCallIV != null) ? rankIn(callSpreads, prior.callIV - prior.atmCallIV) : null;
      const pSR = (prior.putIV != null && prior.atmPutIV != null) ? rankIn(putSpreads, prior.putIV - prior.atmPutIV) : null;
      if (cR != null) bucket.callIVRanks.push(cR);
      if (pR != null) bucket.putIVRanks.push(pR);
      if (cSR != null) bucket.callSpreadRanks.push(cSR);
      if (pSR != null) bucket.putSpreadRanks.push(pSR);
    }
    const meanOf = (arr) => {
      if (!arr || arr.length === 0) return null;
      return arr.reduce((s, v) => s + v, 0) / arr.length;
    };
    const preEventStats = {};
    for (const [cls, data] of Object.entries(preEventByClass)) {
      preEventStats[cls] = {
        callIVRank: meanOf(data.callIVRanks),
        putIVRank: meanOf(data.putIVRanks),
        callSpreadRank: meanOf(data.callSpreadRanks),
        putSpreadRank: meanOf(data.putSpreadRanks),
        nCallIV: data.callIVRanks.length,
        nPutIV: data.putIVRanks.length,
        nCallSpread: data.callSpreadRanks.length,
        nPutSpread: data.putSpreadRanks.length,
        n: Math.max(data.callIVRanks.length, data.putIVRanks.length, data.callSpreadRanks.length, data.putSpreadRanks.length),
      };
    }

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
        if (cR == null && pR == null && cSR == null && pSR == null) continue;
        perDay.push({ signedReturn: next.dailyReturn, cR, pR, cSR, pSR });
      }
    }
    let preEventByReturnBucket = null;
    if (perDay.length >= 4) {
      perDay.sort((a, b) => a.signedReturn - b.signedReturn);
      const mid = Math.floor(perDay.length / 2);
      const makeBucket = (slice) => {
        const cR = slice.map(e => e.cR).filter(v => v != null);
        const pR = slice.map(e => e.pR).filter(v => v != null);
        const cSR = slice.map(e => e.cSR).filter(v => v != null);
        const pSR = slice.map(e => e.pSR).filter(v => v != null);
        return {
          n: slice.length,
          minReturn: slice[0].signedReturn,
          maxReturn: slice[slice.length - 1].signedReturn,
          callIVRank: meanOf(cR), putIVRank: meanOf(pR),
          callSpreadRank: meanOf(cSR), putSpreadRank: meanOf(pSR),
          nCallIV: cR.length, nPutIV: pR.length, nCallSpread: cSR.length, nPutSpread: pSR.length,
        };
      };
      preEventByReturnBucket = { low: makeBucket(perDay.slice(0, mid)), high: makeBucket(perDay.slice(mid)) };
    }

    // Generate HTML results page
    const currentFavorites = loadFavorites();
    const currentSuperFavorites = loadSuperFavorites();
    const currentNotes = loadNotes();
    const html = generateScreeningHTML(result.allTickers, tickers.length, config, ivHistoryForHTML, currentFavorites, preEventStats, currentNotes, preEventByReturnBucket, currentSuperFavorites);

    // Save HTML for "Latest Run Results" (alias) and a timestamped snapshot in ci/screening-runs/
    const screenResultsPath = path.join(__dirname, 'ci', 'screening-results.html');
    fs.writeFileSync(screenResultsPath, html, 'utf-8');

    const runsDir = path.join(__dirname, 'ci', 'screening-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
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

    return { success: true, filePath: screenResultsPath, hitCount: result.hits.length };
  } catch (error) {
    console.error('Screening error:', error);
    return { success: false, error: error.message };
  }
});

// Revise the 100 — auto-select screening tickers by fundamentals
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
      return { success: false, error: 'No previous revision results found. Run "Revise the 100" first.' };
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

// GLM Analysis — logistic regression on event features
ipcMain.handle('run-glm-analysis', async (event, options = {}) => {
  try {
    const horizonDays = options.horizonDays || 10;
    console.log(`\n[GLM] Training logistic regression with horizon=${horizonDays} days...`);
    const result = await glmAnalyzer.trainModel(horizonDays);
    const hNote = result.horizonDays !== result.requestedHorizon ? ` (fell back from ${result.requestedHorizon}d)` : '';
    console.log(`[GLM] Done. horizon=${result.horizonDays}d${hNote}, LOO accuracy: ${(result.looAccuracy * 100).toFixed(1)}% (n=${result.nEvents}: ${result.nEventSamples} events + ${result.nNonEventSamples} non-events)`);
    return { success: true, ...result };
  } catch (error) {
    console.error('GLM analysis error:', error);
    return { success: false, error: error.message };
  }
});

const FAVORITES_PATH = path.join(__dirname, 'ci', 'screening-favorites.json');
const SUPER_FAVORITES_PATH = path.join(__dirname, 'ci', 'screening-super-favorites.json');

function loadFavorites() {
  try { return JSON.parse(require('fs').readFileSync(FAVORITES_PATH, 'utf-8')); } catch (_) { return []; }
}

function saveFavorites(favs) {
  require('fs').writeFileSync(FAVORITES_PATH, JSON.stringify(favs, null, 2) + '\n', 'utf-8');
}

function loadSuperFavorites() {
  try { return JSON.parse(require('fs').readFileSync(SUPER_FAVORITES_PATH, 'utf-8')); } catch (_) { return []; }
}

function saveSuperFavorites(favs) {
  require('fs').writeFileSync(SUPER_FAVORITES_PATH, JSON.stringify(favs, null, 2) + '\n', 'utf-8');
}

// Cycles ticker through 3 states: none -> favorite -> super -> none
ipcMain.handle('toggle-favorite', async (event, ticker) => {
  const favs = loadFavorites();
  const supers = loadSuperFavorites();
  const inFav = favs.indexOf(ticker);
  const inSuper = supers.indexOf(ticker);
  if (inSuper >= 0) {
    supers.splice(inSuper, 1);
  } else if (inFav >= 0) {
    favs.splice(inFav, 1);
    supers.push(ticker);
  } else {
    favs.push(ticker);
  }
  saveFavorites(favs);
  saveSuperFavorites(supers);
  return { favorites: favs, superFavorites: supers };
});

ipcMain.handle('get-favorites', async () => {
  return { favorites: loadFavorites(), superFavorites: loadSuperFavorites() };
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

function generateScreeningHTML(allTickers, totalTickers, config, ivHistoryData = {}, favorites = [], preEventStats = {}, notes = {}, preEventByReturnBucket = null, superFavorites = []) {
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
  const superFavSet = new Set(superFavorites);

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

  // Compute per-ticker IV history stats from weighted-iv-history.json.
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
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    const sec = tickerSectors[ticker];
    if (!sec || !Array.isArray(records)) continue;
    if (!sectorSpreads[sec]) sectorSpreads[sec] = { callSpreads: [], putSpreads: [] };
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      if (e.callIV > 0 && e.atmCallIV != null) sectorSpreads[sec].callSpreads.push(e.callIV - e.atmCallIV);
      if (e.putIV > 0 && e.atmPutIV != null) sectorSpreads[sec].putSpreads.push(e.putIV - e.atmPutIV);
    }
  }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!Array.isArray(records) || records.length < MIN_HIST_RECORDS) continue;
    const callIVs = [], putIVs = [], callSpreads = [], putSpreads = [];
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      if (e.callIV > 0) callIVs.push(e.callIV);
      if (e.putIV > 0) putIVs.push(e.putIV);
      if (e.callIV > 0 && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
      if (e.putIV > 0 && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
    }
    ivHistStats[ticker] = {
      callIVs: callIVs.length >= MIN_HIST_RECORDS ? callIVs : null,
      putIVs: putIVs.length >= MIN_HIST_RECORDS ? putIVs : null,
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
    const callSpread = tiv ? tiv.ivSpreadCall : null;
    const putSpread = tiv ? tiv.ivSpreadPut : null;
    const stats = ivHistStats[h.ticker];
    const rankTag = (r) => r != null ? ` <span style="color:#888; font-size:0.78em;">(p${r})</span>` : '';
    const sectorRankTag = (r) => r != null ? ` <span style="color:#6a8; font-size:0.78em;">[s${r}]</span>` : '';
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
    const callIVStr = tiv ? tiv.callIV.toFixed(1) + '%' + rankTag(callIVRank) : '';
    const putIVStr = tiv ? tiv.putIV.toFixed(1) + '%' + rankTag(putIVRank) : '';
    const callIVVal = tiv ? tiv.callIV : -1;
    const putIVVal = tiv ? tiv.putIV : -1;
    const callSpreadStr = callSpread != null ? (callSpread >= 0 ? '+' : '') + callSpread.toFixed(1) + rankTag(callSpreadRank) + sectorRankTag(callSectorRank) : '';
    const putSpreadStr = putSpread != null ? (putSpread >= 0 ? '+' : '') + putSpread.toFixed(1) + rankTag(putSpreadRank) + sectorRankTag(putSectorRank) : '';
    const callSpreadVal = callSpread != null ? callSpread : -9999;
    const putSpreadVal = putSpread != null ? putSpread : -9999;

    const isSuper = superFavSet.has(h.ticker);
    const isFav = !isSuper && favSet.has(h.ticker);
    const favLevel = isSuper ? 2 : (isFav ? 1 : 0);
    const favColor = isSuper ? '#e53935' : (isFav ? '#f5c518' : '#ccc');
    const favGlyph = favLevel > 0 ? '★' : '☆';
    const favTitle = isSuper ? 'Super favorite (click to clear)' : (isFav ? 'Favorite (click to make super)' : 'Click to favorite');
    const noteText = (notes && notes[h.ticker]) ? notes[h.ticker] : '';
    const hasNote = !!noteText;
    const noteIndicator = hasNote ? ' <span title="Has note" style="font-size:0.75em;">📝</span>' : '';

    return `<tr ${hasChart ? `class="data-row" data-ticker="${h.ticker}"` : ''} style="${inlineStyle}">
      <td style="text-align:center; width:28px; padding:4px;" data-v="${favLevel}"><span class="fav-star" data-ticker="${h.ticker}" style="cursor:pointer; font-size:1.1em; color:${favColor};" title="${favTitle}">${favGlyph}</span></td>
      <td data-v="${h.ticker}" style="font-weight:bold;">${h.ticker}${hasChart ? ' <span style="font-size:0.7em;color:#aaa;">▶</span>' : ''}${noteIndicator}</td>
      <td data-v="${sec || 'zzz'}" style="font-size:0.82em; color:#888;">${sec || ''}</td>
      <td data-v="${dateStr || 'zzz'}">${dateStr}</td>
      <td data-v="${h.gap || 0}">${h.gap ? h.gap.toFixed(2) + '%' : ''}</td>
      <td data-v="${h.percentile || 0}">${h.percentile ? h.percentile.toFixed(1) + '%' : ''}</td>
      <td data-v="${h.classification || 'zzz'}" style="color:${color}; font-weight:bold;">${label}</td>
      <td data-v="${h.volume || 0}" style="text-align:right;">${h.volume ? (h.volume / 1e6).toFixed(1) + 'M' : ''}</td>
      <td data-v="${r2Val}" style="text-align:right;">${r2}</td>
      <td data-v="${mcap}" style="text-align:right;">${mcapStr}</td>
      <td data-v="${optDV}" style="text-align:right;">${optDVStr}</td>
      <td data-v="${callIVVal}" style="text-align:right; color:rgba(72,187,120,0.9);">${callIVStr}</td>
      <td data-v="${callSpreadVal}" style="text-align:right; color:rgba(72,187,120,0.7); font-size:0.88em;">${callSpreadStr}</td>
      <td data-v="${putIVVal}" style="text-align:right; color:rgba(245,101,101,0.9);">${putIVStr}</td>
      <td data-v="${putSpreadVal}" style="text-align:right; color:rgba(245,101,101,0.7); font-size:0.88em;">${putSpreadStr}</td>
    </tr>
    <tr class="chart-row" data-chart-for="${h.ticker}" style="display:none;">
      <td colspan="15" style="padding:0; background:#1a1d23;">
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
  // Color by deviation from 50 (neutral): >60 is elevated, <40 is suppressed.
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 65) color = '#d32f2f';
    else if (v >= 55) color = '#ef6c00';
    else if (v <= 35) color = '#1565c0';
    else if (v <= 45) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">p${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const rows = order.map(([k, label, color]) => {
    const s = preEventStats[k] || {};
    const n = s.n || 0;
    const dim = n === 0 ? ' style="color:#bbb;"' : '';
    return `<tr${dim}>
      <td style="padding:6px 10px; font-weight:bold; color:${color};">${label}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callIVRank, s.nCallIV)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putIVRank, s.nPutIV)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callSpreadRank, s.nCallSpread)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putSpreadRank, s.nPutSpread)}</td>
    </tr>`;
  }).join('');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">Pre-Event IV Profile <span style="color:#999; font-weight:normal; font-size:0.9em;">(avg percentile rank of each pre-event snapshot within that ticker's own point-in-time history; 50 = neutral, &gt;60 = elevated, &lt;40 = suppressed)</span></div>
    <div style="color:#aaa; font-size:0.78em; margin-bottom:6px;">Requires ≥10 history records before the event date. (n) = events contributing.</div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Classification</th>
        <th style="padding:4px 10px; text-align:right;">Call IV</th>
        <th style="padding:4px 10px; text-align:right;">Put IV</th>
        <th style="padding:4px 10px; text-align:right;">C Spr</th>
        <th style="padding:4px 10px; text-align:right;">P Spr</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
})()}
${(() => {
  if (!preEventByReturnBucket) return '';
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 65) color = '#d32f2f';
    else if (v >= 55) color = '#ef6c00';
    else if (v <= 35) color = '#1565c0';
    else if (v <= 45) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">p${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const fmtRet = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const buckets = [
    ['low', 'Low Returns', '#1565c0', preEventByReturnBucket.low],
    ['high', 'High Returns', '#d32f2f', preEventByReturnBucket.high],
  ];
  const rows = buckets.map(([, label, color, b]) => `<tr>
    <td style="padding:6px 10px; font-weight:bold; color:${color};">${label} <span style="color:#999; font-weight:normal; font-size:0.85em;">[${fmtRet(b.minReturn)} … ${fmtRet(b.maxReturn)}]</span> <span style="color:#aaa; font-size:0.85em;">n=${b.n}</span></td>
    <td style="padding:6px 10px; text-align:right;">${fmtRank(b.callIVRank, b.nCallIV)}</td>
    <td style="padding:6px 10px; text-align:right;">${fmtRank(b.putIVRank, b.nPutIV)}</td>
    <td style="padding:6px 10px; text-align:right;">${fmtRank(b.callSpreadRank, b.nCallSpread)}</td>
    <td style="padding:6px 10px; text-align:right;">${fmtRank(b.putSpreadRank, b.nPutSpread)}</td>
  </tr>`).join('');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">IV Profile by Daily Return Bucket <span style="color:#999; font-weight:normal; font-size:0.9em;">(median split on next-day return; average IV/spread ranks from the day before — tests if high rank precedes high vs low next-day return)</span></div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Bucket</th>
        <th style="padding:4px 10px; text-align:right;">Call IV</th>
        <th style="padding:4px 10px; text-align:right;">Put IV</th>
        <th style="padding:4px 10px; text-align:right;">C Spr</th>
        <th style="padding:4px 10px; text-align:right;">P Spr</th>
      </tr></thead>
      <tbody>${rows}</tbody>
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
<table id="screen-table">
<thead><tr>
  <th style="width:28px; text-align:center; padding:4px;"><span class="sort-arrow"></span></th>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th>Sector<span class="sort-arrow"></span></th>
  <th>Date<span class="sort-arrow"></span></th>
  <th>Gap %<span class="sort-arrow"></span></th>
  <th>Percentile<span class="sort-arrow"></span></th>
  <th>Classification<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Volume<span class="sort-arrow"></span></th>
  <th style="text-align:right;">R&sup2; (SPY)<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Mkt Cap<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Opt $ Vol<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Call IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank">C Spr<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Put IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank">P Spr<span class="sort-arrow"></span></th>
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

  document.querySelectorAll('.fav-star').forEach(star => {
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = star.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.toggleFavorite) return;
      if (star.dataset.busy) return;
      star.dataset.busy = '1';
      try {
        const result = await window.electronAPI.toggleFavorite(ticker);
        const supers = result.superFavorites || [];
        const favs = result.favorites || [];
        const isSuper = supers.includes(ticker);
        const isFav = !isSuper && favs.includes(ticker);
        const level = isSuper ? 2 : (isFav ? 1 : 0);
        star.textContent = level > 0 ? '\\u2605' : '\\u2606';
        star.style.color = isSuper ? '#e53935' : (isFav ? '#f5c518' : '#ccc');
        star.title = isSuper ? 'Super favorite (click to clear)' : (isFav ? 'Favorite (click to make super)' : 'Click to favorite');
        star.closest('td').setAttribute('data-v', String(level));
        const msg = isSuper ? ticker + ' is now a super favorite \\u2B50' : (isFav ? ticker + ' added to favorites' : ticker + ' removed from favorites');
        showFavToast(msg, true);
      } catch (err) {
        showFavToast('Failed to update ' + ticker, false);
      }
      delete star.dataset.busy;
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
              '<a href="' + n.url + '" style="color:#7aa2c7; text-decoration:none;">' + n.headline + '</a>' +
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
              const callSpreadSeries = combined.map(c => c && c.callIV > 0 && c.atmCallIV != null ? c.callIV - c.atmCallIV : null);
              const putSpreadSeries = combined.map(c => c && c.putIV > 0 && c.atmPutIV != null ? c.putIV - c.atmPutIV : null);

              const lineBase = { type: 'line', borderWidth: 2, pointRadius: 2, fill: false, spanGaps: true, tension: 0.2 };
              const datasets = [
                { ...lineBase, label: 'Call IV', data: callIVSeries, borderColor: 'rgba(72,187,120,0.95)', backgroundColor: 'rgba(72,187,120,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Put IV', data: putIVSeries, borderColor: 'rgba(245,101,101,0.95)', backgroundColor: 'rgba(245,101,101,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Call Spread (vs ATM)', data: callSpreadSeries, borderColor: 'rgba(72,187,120,0.6)', backgroundColor: 'rgba(72,187,120,0.6)', borderDash: [4, 3], yAxisID: 'y1' },
                { ...lineBase, label: 'Put Spread (vs ATM)', data: putSpreadSeries, borderColor: 'rgba(245,101,101,0.6)', backgroundColor: 'rgba(245,101,101,0.6)', borderDash: [4, 3], yAxisID: 'y1' },
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
                    y1: { position: 'right', title: { display: true, text: 'Spread %', color: '#909090', font: { size: 10 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(1) + '%'; } }, grid: { drawOnChartArea: false } },
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

// TTS IPC handlers
ipcMain.handle('list-voices', () => {
  const fs = require('fs');
  const hasTranscript = (p) => fs.existsSync(p.replace(/\.[^.]+$/, '.txt'));
  const voices = [{
    label: hasTranscript(ttsVoiceRef) ? 'Default (voice_ref.wav)' : 'Default (voice_ref.wav) ⚠ missing transcript',
    path: ttsVoiceRef
  }];
  if (fs.existsSync(ttsVoicesDir)) {
    const files = fs.readdirSync(ttsVoicesDir)
      .filter(f => /\.(wav|opus|mp3|flac)$/i.test(f))
      .map(f => {
        const p = path.join(ttsVoicesDir, f);
        return { label: hasTranscript(p) ? f : `${f} ⚠ missing transcript`, path: p };
      });
    voices.push(...files);
  }
  return voices;
});

ipcMain.handle('save-tts-audio', async (event, text) => {
  if (!text || !text.trim()) return { ok: false, error: 'empty text' };

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save audio file',
    defaultPath: 'output.mp3',
    filters: [
      { name: 'MP3 Audio', extensions: ['mp3'] },
      { name: 'M4A Audio', extensions: ['m4a'] },
    ],
  });
  if (!filePath) return { ok: false, error: 'cancelled' };

  const fs = require('fs');
  const [savedVoice, savedSpeed, savedQuality] = await Promise.all([
    database ? database.getSetting('tts_voice', null).catch(() => null) : null,
    database ? database.getSetting('tts_speed', '1.2').catch(() => '1.2') : '1.2',
    database ? database.getSetting('tts_quality', '16').catch(() => '16') : '16',
  ]);
  const voicePath = savedVoice || ttsVoiceRef;
  const payload = { text, output_file: filePath, speed: parseFloat(savedSpeed) || 1.2, num_step: parseInt(savedQuality) || 16 };
  if (fs.existsSync(voicePath)) payload.ref_audio = voicePath;

  return new Promise((resolve) => {
    const child = spawn('python3', [ttsPythonScript], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.unref();
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: true }); }
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.on('speak-text', (event, text) => {
  if (typeof text !== 'string' || !text.trim()) return;
  spawnOmniVoiceTTS(text);
});

ipcMain.on('stop-speaking', () => {
  ttsPending = null;
  ttsSpawning = false;
  killTtsProcess();
});

ipcMain.handle('toggle-tts', (event, enabled) => {
  ttsEnabled = !!enabled;
  if (!ttsEnabled) {
    ttsPending = null;
    ttsSpawning = false;
    killTtsProcess();
  }
  return { ttsEnabled };
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

  const ibProvider = new IBOptionsProvider({ port: 4002 });
  optionsAnalyzer = new OptionsAnalysisService(database, ibProvider);
  chronosHoldService = new ChronosHoldPeriodService(database);
  glmAnalyzer = new GLMAnalysisService(database);

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

  globalShortcut.register('Escape', () => {
    if (activeTtsProcess) {
      killTtsProcess();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tts-state-changed', { speaking: false });
      }
    }
  });
});

app.on('window-all-closed', async () => {
  // Kill any active TTS subprocess
  killTtsProcess();

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
