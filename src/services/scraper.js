const { chromium } = require('playwright');

class WebScraper {
  constructor() {
    this.browser = null;
  }

  /**
   * Initialize the browser instance
   */
  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  /**
   * Close the browser instance
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Extract top N press release links from Yahoo Finance
   * @param {string} ticker - Stock ticker symbol (e.g., 'AAPL', 'TSLA')
   * @param {number} limit - Maximum number of links to extract (default: 5)
   * @returns {Promise<Array>} Array of link objects with url and text
   */
  async extractYahooFinanceLinks(ticker, limit = 5) {
    await this.initialize();

    const url = `https://finance.yahoo.com/quote/${ticker}/press-releases`;
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
      console.log(`\n🔗 Extracting press releases for ${ticker} from Yahoo Finance...`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for press releases to load
      await page.waitForTimeout(2000);

      // Extract press release links
      const links = await page.evaluate(() => {
        // Look for press release links (adjust selectors based on Yahoo Finance structure)
        const anchors = Array.from(document.querySelectorAll('a[href*="/news/"]'));
        return anchors
          .map(a => ({
            url: a.href,
            text: a.textContent.trim()
          }))
          .filter(link =>
            link.url &&
            link.text &&
            link.text.length > 10 &&
            !link.text.includes('View all') &&
            (link.url.startsWith('http://') || link.url.startsWith('https://'))
          );
      });

      console.log(`   Found ${links.length} press release links`);

      // Remove duplicates and take the top N links
      const uniqueLinks = Array.from(
        new Map(links.map(link => [link.url, link])).values()
      ).slice(0, limit);

      console.log(`   Returning top ${uniqueLinks.length} press releases`);

      return uniqueLinks;
    } catch (error) {
      console.error(`Error extracting links from ${url}:`, error.message);
      throw error;
    } finally {
      await context.close();
    }
  }

  /**
   * Extract text content from a given URL
   * @param {string} url - The URL to scrape
   * @returns {Promise<Object>} Object with url, title, text, and wordCount
   */
  async extractText(url) {
    await this.initialize();

    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
      console.log(`📄 Extracting text from: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait a moment for dynamic content to load
      await page.waitForTimeout(2000);

      // Extract title and text
      const data = await page.evaluate(() => {
        // Remove script, style, and other non-content elements
        const elementsToRemove = document.querySelectorAll('script, style, nav, header, footer, aside, iframe, noscript');
        elementsToRemove.forEach(el => el.remove());

        const title = document.title;
        const text = document.body.innerText;

        return { title, text };
      });

      const wordCount = data.text.split(/\s+/).filter(w => w.length > 0).length;

      console.log(`   ✓ Extracted ${wordCount} words from: ${data.title}`);

      return {
        url,
        title: data.title,
        text: data.text,
        wordCount
      };
    } catch (error) {
      console.error(`Error extracting text from ${url}:`, error.message);
      throw error;
    } finally {
      await context.close();
    }
  }

  /**
   * Scrape top N press releases for a ticker and return the content
   * @param {string} ticker - Stock ticker symbol (e.g., 'AAPL')
   * @param {number} topN - Number of top press releases to scrape (default: 5)
   * @param {Function} onProgress - Callback function for progress updates
   * @returns {Promise<Array>} Array of scraped content objects
   */
  async scrapeYahooFinancePressReleases(ticker, topN = 5, onProgress = null) {
    try {
      // Extract press release links for the ticker
      const links = await this.extractYahooFinanceLinks(ticker, topN);

      if (links.length === 0) {
        console.log(`   No press releases found for ${ticker}`);
        return [];
      }

      console.log(`\n🤖 Scraping ${links.length} press releases for ${ticker}...`);

      const results = [];

      // Scrape each press release
      for (let i = 0; i < links.length; i++) {
        const link = links[i];

        if (onProgress) {
          onProgress({
            current: i + 1,
            total: links.length,
            url: link.url,
            linkText: link.text,
            ticker: ticker
          });
        }

        try {
          const content = await this.extractText(link.url);
          results.push({
            ...content,
            linkText: link.text,
            ticker: ticker,
            success: true
          });
        } catch (error) {
          console.error(`   ✗ Failed to scrape ${link.url}:`, error.message);
          results.push({
            url: link.url,
            linkText: link.text,
            ticker: ticker,
            success: false,
            error: error.message
          });
        }

        // Small delay between requests to be respectful
        if (i < links.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      console.log(`\n✓ Scraping complete: ${results.filter(r => r.success).length}/${results.length} succeeded`);

      return results;
    } catch (error) {
      console.error('Error in scrapeYahooFinancePressReleases:', error);
      throw error;
    }
  }
}

module.exports = WebScraper;
