/**
 * News Scraper Service
 * Extracts article counts from financial news pages
 * Currently supports Yahoo Finance, extensible for other sources
 */

class NewsScraper {
  /**
   * Detect the news source from URL
   * @param {string} url - Page URL
   * @returns {string|null} Source identifier or null if unsupported
   */
  detectSource(url) {
    if (url.includes('finance.yahoo.com')) {
      return 'yahoo_finance';
    }
    // Add more sources here in the future
    // if (url.includes('bloomberg.com')) return 'bloomberg';
    // if (url.includes('cnbc.com')) return 'cnbc';

    return null;
  }

  /**
   * Extract ticker from URL
   * @param {string} url - Page URL
   * @param {string} source - Source identifier
   * @returns {string|null} Ticker symbol or null if not found
   */
  extractTickerFromUrl(url, source) {
    if (source === 'yahoo_finance') {
      // Yahoo Finance URLs: https://finance.yahoo.com/quote/AAPL/news
      const match = url.match(/\/quote\/([A-Z]+)\//i);
      return match ? match[1].toUpperCase() : null;
    }

    return null;
  }

  /**
   * Count articles on Yahoo Finance news page
   * @param {Electron.WebContents} webContents - The web contents to scrape
   * @returns {Promise<number>} Number of articles found
   */
  async countYahooFinanceArticles(webContents) {
    try {
      const count = await webContents.executeJavaScript(`
        (function() {
          // Yahoo Finance uses these selectors for news articles
          // Update these if Yahoo changes their HTML structure
          const selectors = [
            'li[data-test-locator="mega"]',  // Main news items
            'li.js-stream-content',           // Stream content items
            'h3[class*="title"]',             // Article titles
            'div[data-test="article-card"]'   // Article cards
          ];

          let maxCount = 0;

          // Try each selector and use the one that finds the most items
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > maxCount) {
              maxCount = elements.length;
            }
          }

          return maxCount;
        })()
      `);

      return count;
    } catch (error) {
      console.error('Error counting Yahoo Finance articles:', error);
      throw error;
    }
  }

  /**
   * Count articles from current page in webContents
   * @param {Electron.WebContents} webContents - The web contents to scrape
   * @returns {Promise<Object>} {ticker, count, source, url} or error
   */
  async countArticles(webContents) {
    try {
      const url = webContents.getURL();

      // Detect source
      const source = this.detectSource(url);
      if (!source) {
        return {
          success: false,
          error: 'Unsupported news source. Currently supports: Yahoo Finance'
        };
      }

      // Extract ticker from URL
      const ticker = this.extractTickerFromUrl(url, source);
      if (!ticker) {
        return {
          success: false,
          error: 'Could not detect ticker from URL. Make sure you\'re on a ticker\'s news page.'
        };
      }

      // Count articles based on source
      let count = 0;
      if (source === 'yahoo_finance') {
        count = await this.countYahooFinanceArticles(webContents);
      }

      if (count === 0) {
        return {
          success: false,
          error: 'No articles found. Page may not have loaded yet, or selectors need updating.'
        };
      }

      return {
        success: true,
        ticker: ticker,
        count: count,
        source: source,
        url: url
      };
    } catch (error) {
      console.error('Error in countArticles:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get supported sources info
   * @returns {Array<Object>} List of supported sources with details
   */
  getSupportedSources() {
    return [
      {
        id: 'yahoo_finance',
        name: 'Yahoo Finance',
        urlPattern: 'finance.yahoo.com/quote/*/news',
        example: 'https://finance.yahoo.com/quote/AAPL/news'
      }
      // Add more sources here as they're implemented
    ];
  }
}

module.exports = new NewsScraper();
