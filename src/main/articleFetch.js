// Article/news fetching helpers: Finviz headline scraping, consent-dialog
// clicking, and hidden-BrowserView article extraction.
// Extracted from main.js.

const { BrowserView } = require('electron');
const bunBridge = require('../services/bunBridge');
const articleExtractor = require('../services/articleExtractor');
const { JSDOM } = require('jsdom');

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

module.exports = {
  getExtractionBrowserView,
  fetchFinvizNews,
  tryClickConsent,
  extractArticleViaBrowser,
};
