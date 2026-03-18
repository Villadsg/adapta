/**
 * Ticker Discovery Service
 * Discovers candidate tickers for diversification by scraping Finviz
 * using the app's hidden BrowserView (full Chromium engine).
 */

class TickerDiscoveryService {
  /**
   * Load a URL in the BrowserView and wait for it to finish loading.
   * @param {Electron.BrowserView} browserView
   * @param {string} url
   * @param {number} timeout - ms to wait before giving up
   */
  async loadPage(browserView, url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browserView.webContents.removeAllListeners('did-finish-load');
        reject(new Error(`Timed out loading ${url}`));
      }, timeout);

      browserView.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });

      browserView.webContents.loadURL(url).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Extract ticker symbols from the current page by finding all links
   * to Finviz quote pages (href containing "quote.ashx?t=").
   * @param {Electron.BrowserView} browserView
   * @returns {Promise<string[]>} Array of ticker symbols found
   */
  async extractTickersFromPage(browserView) {
    const tickers = await browserView.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="quote.ashx?t="]');
        const tickers = [];
        const re = /quote\\.ashx\\?t=([A-Z][A-Z0-9.]{0,9})/;
        for (const a of links) {
          const m = a.getAttribute('href').match(re);
          if (m) tickers.push(m[1]);
        }
        return tickers;
      })()
    `);
    return tickers;
  }

  /**
   * Discover tickers from Finviz screener pages (most active, top gainers).
   * The news page (news.ashx) only links to external articles, not quote pages,
   * so we use screener pages which are full of quote.ashx?t= ticker links.
   * @param {Electron.BrowserView} browserView
   * @returns {Promise<Array<{ticker: string, frequency: number}>>}
   */
  async discoverFromFinvizScreener(browserView) {
    const screenerPages = [
      'https://finviz.com/screener.ashx?v=111&s=ta_mostactive',
      'https://finviz.com/screener.ashx?v=111&s=ta_topgainers',
    ];

    const freq = {};

    for (const url of screenerPages) {
      try {
        await this.loadPage(browserView, url);
        // Extra wait for JS-rendered content
        await new Promise(r => setTimeout(r, 2000));

        const tickers = await this.extractTickersFromPage(browserView);
        console.log(`Ticker discovery: found ${tickers.length} ticker links on ${url.split('s=')[1]}`);

        for (const t of tickers) {
          freq[t] = (freq[t] || 0) + 1;
        }
      } catch (err) {
        console.error(`Ticker discovery: failed to scrape ${url}:`, err.message);
      }

      // Brief delay between pages
      await new Promise(r => setTimeout(r, 1500));
    }

    return Object.entries(freq)
      .map(([ticker, frequency]) => ({ ticker, frequency }))
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Discover tickers related to existing holdings by loading each
   * holding's Finviz quote page and extracting mentioned tickers.
   * @param {Electron.BrowserView} browserView
   * @param {string[]} holdingTickers
   * @returns {Promise<Array<{ticker: string, frequency: number, foundVia: string[]}>>}
   */
  async discoverFromHoldings(browserView, holdingTickers) {
    const holdingSet = new Set(holdingTickers.map(t => t.toUpperCase()));
    const found = {}; // ticker -> { frequency, foundVia: Set }

    for (const holding of holdingTickers) {
      try {
        const quoteUrl = `https://finviz.com/quote.ashx?t=${holding}`;
        await this.loadPage(browserView, quoteUrl);
        await new Promise(r => setTimeout(r, 2000));

        // Check if Finviz redirected to search (ticker not in their database)
        const currentUrl = browserView.webContents.getURL();
        if (currentUrl.includes('search.ashx') || !currentUrl.includes('quote.ashx')) {
          console.log(`Ticker discovery: ${holding} not found on Finviz (redirected), skipping`);
          continue;
        }

        const tickers = await this.extractTickersFromPage(browserView);

        for (const t of tickers) {
          if (holdingSet.has(t)) continue;
          if (!found[t]) found[t] = { frequency: 0, foundVia: new Set() };
          found[t].frequency++;
          found[t].foundVia.add(holding);
        }
      } catch (err) {
        console.error(`Ticker discovery: failed to load page for ${holding}:`, err.message);
      }

      // Rate limit: 2s between holdings
      if (holdingTickers.indexOf(holding) < holdingTickers.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return Object.entries(found)
      .map(([ticker, data]) => ({
        ticker,
        frequency: data.frequency,
        foundVia: Array.from(data.foundVia),
      }))
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Orchestrator: discover candidates from both Finviz news and holdings.
   * @param {Electron.BrowserView} browserView
   * @param {string[]} holdingTickers
   * @param {Object} options
   * @param {number} options.maxCandidates - Max candidates to return (default 15)
   * @returns {Promise<{candidates: Array, stats: Object}>}
   */
  async discoverCandidates(browserView, holdingTickers, { maxCandidates = 15 } = {}) {
    const holdingSet = new Set(holdingTickers.map(t => t.toUpperCase()));

    // Step 1: Discover from screener pages (most active + top gainers)
    console.log('Ticker discovery: scraping Finviz screener pages...');
    let screenerResults = [];
    try {
      screenerResults = await this.discoverFromFinvizScreener(browserView);
      // Filter out holdings
      screenerResults = screenerResults.filter(r => !holdingSet.has(r.ticker));
    } catch (err) {
      console.error('Ticker discovery: screener pages failed:', err.message);
    }

    // Step 2: Discover from holdings
    console.log(`Ticker discovery: scraping ${holdingTickers.length} holding pages...`);
    let holdingResults = [];
    try {
      holdingResults = await this.discoverFromHoldings(browserView, holdingTickers);
    } catch (err) {
      console.error('Ticker discovery: holdings pages failed:', err.message);
    }

    // Step 3: Merge results
    const merged = {}; // ticker -> { screenerFreq, holdingFreq, foundVia, bothSources }
    for (const r of screenerResults) {
      merged[r.ticker] = { screenerFreq: r.frequency, holdingFreq: 0, foundVia: [], bothSources: false };
    }
    for (const r of holdingResults) {
      if (merged[r.ticker]) {
        merged[r.ticker].holdingFreq = r.frequency;
        merged[r.ticker].foundVia = r.foundVia;
        merged[r.ticker].bothSources = true;
      } else {
        merged[r.ticker] = { screenerFreq: 0, holdingFreq: r.frequency, foundVia: r.foundVia, bothSources: false };
      }
    }

    // Sort: both sources first, then by total frequency
    const candidates = Object.entries(merged)
      .map(([ticker, data]) => ({
        ticker,
        totalFrequency: data.screenerFreq + data.holdingFreq,
        ...data,
      }))
      .sort((a, b) => {
        if (a.bothSources !== b.bothSources) return b.bothSources - a.bothSources;
        return b.totalFrequency - a.totalFrequency;
      })
      .slice(0, maxCandidates);

    return {
      candidates,
      stats: {
        screenerTickers: screenerResults.length,
        holdingRelatedTickers: holdingResults.length,
        total: candidates.length,
      },
    };
  }
}

module.exports = TickerDiscoveryService;
