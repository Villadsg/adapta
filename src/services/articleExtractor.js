/**
 * Article Extractor Service
 * Shared utility for extracting clean article content using Mozilla's Readability.js
 * Used by both the news scraper and article comparison features.
 */

const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

class ArticleExtractor {
  /**
   * Extract article content from HTML using Readability.js
   * @param {string} html - The HTML content to parse
   * @param {string} url - The URL of the page (for proper link resolution)
   * @returns {Object|null} - Extracted article data or null if extraction failed
   */
  extractFromHTML(html, url) {
    try {
      // Parse with JSDOM
      const doc = new JSDOM(html, { url });

      // Use Readability to extract the article
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article) {
        // Extract published date from meta tags or structured data
        const publishedDate = this.extractPublishedDate(doc.window.document);

        return {
          title: article.title || doc.window.document.title,
          text: article.textContent.trim(),
          excerpt: article.excerpt || '',
          byline: article.byline || '',
          length: article.length || article.textContent.length,
          publishedDate: publishedDate
        };
      }

      return null;
    } catch (error) {
      console.error('Error in extractFromHTML:', error);
      return null;
    }
  }

  /**
   * Extract published date from HTML document
   * @param {Document} document - The DOM document
   * @returns {string|null} - ISO date string or null if not found
   */
  extractPublishedDate(document) {
    try {
      // Try various meta tag patterns (most reliable)
      const metaSelectors = [
        'meta[property="article:published_time"]',
        'meta[property="og:published_time"]',
        'meta[name="article:published_time"]',
        'meta[name="publishDate"]',
        'meta[name="publish_date"]',
        'meta[name="date"]',
        'meta[name="DC.date"]',
        'meta[name="dcterms.created"]',
        'meta[itemprop="datePublished"]',
        'meta[property="bt:pubDate"]'
      ];

      for (const selector of metaSelectors) {
        const meta = document.querySelector(selector);
        if (meta) {
          const content = meta.getAttribute('content');
          if (content) {
            const date = new Date(content);
            if (!isNaN(date.getTime())) {
              return date.toISOString();
            }
          }
        }
      }

      // Try time elements with datetime attribute
      const timeElement = document.querySelector('time[datetime]');
      if (timeElement) {
        const datetime = timeElement.getAttribute('datetime');
        if (datetime) {
          const date = new Date(datetime);
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        }
      }

      // Try JSON-LD structured data
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const datePublished = data.datePublished || data.publishedDate;
          if (datePublished) {
            const date = new Date(datePublished);
            if (!isNaN(date.getTime())) {
              return date.toISOString();
            }
          }
        } catch (e) {
          // Invalid JSON, continue
        }
      }

      return null;
    } catch (error) {
      console.error('Error extracting published date:', error);
      return null;
    }
  }

  /**
   * Extract article content from Electron WebContents using Readability.js
   * This is the main method that both features should use.
   * @param {Electron.WebContents} webContents - The web contents to extract from
   * @returns {Promise<{title: string, text: string, url: string, excerpt?: string, byline?: string, publishedDate?: string, tickers?: string[]}>}
   */
  async extractFromWebContents(webContents) {
    try {
      const url = webContents.getURL();

      // Get the full HTML from the page
      const html = await webContents.executeJavaScript(`
        document.documentElement.outerHTML;
      `);

      // Try Readability extraction first
      const article = this.extractFromHTML(html, url);

      if (article) {
        // Readability successfully extracted the article
        // Extract tickers from the full content
        const tickers = this.extractTickers(article.text, article.title);

        return {
          title: article.title,
          text: article.text,
          url: url,
          excerpt: article.excerpt || '',
          byline: article.byline || '',
          publishedDate: article.publishedDate || null,
          tickers: tickers
        };
      } else {
        // Fallback to basic extraction if Readability fails
        console.log(`Readability failed for ${url}, using fallback extraction`);

        const data = await webContents.executeJavaScript(`
          (function() {
            // Remove non-content elements
            const bodyClone = document.body.cloneNode(true);
            const cloneContainer = document.createElement('div');
            cloneContainer.appendChild(bodyClone);

            // Remove unwanted elements from clone
            const cloneElementsToRemove = cloneContainer.querySelectorAll(
              'script, style, nav, header, footer, aside, iframe, noscript, .advertisement, .ad, .social-share'
            );
            cloneElementsToRemove.forEach(el => el.remove());

            const title = document.title;
            const text = cloneContainer.innerText.trim();

            return { title, text };
          })()
        `);

        const tickers = this.extractTickers(data.text, data.title);

        return {
          title: data.title,
          text: data.text,
          url: url,
          publishedDate: null,
          tickers: tickers
        };
      }
    } catch (error) {
      console.error('Error extracting text from page:', error);
      throw error;
    }
  }

  /**
   * Extract stock tickers from article text
   * @param {string} text - Article text content
   * @param {string} title - Article title
   * @returns {string[]} - Array of unique ticker symbols
   */
  extractTickers(text, title = '') {
    const tickers = new Set();
    const combinedText = `${title} ${text}`;

    // Pattern 1: $TICKER format (e.g., $AAPL, $TSLA)
    const dollarPattern = /\$([A-Z]{1,5})\b/g;
    let match;
    while ((match = dollarPattern.exec(combinedText)) !== null) {
      tickers.add(match[1]);
    }

    // Pattern 2: Ticker in parentheses after company name (e.g., "Apple (AAPL)")
    const parenPattern = /\(([A-Z]{1,5})\)/g;
    while ((match = parenPattern.exec(combinedText)) !== null) {
      const potentialTicker = match[1];
      // Filter out common false positives
      if (!['NYSE', 'NASDAQ', 'USA', 'CEO', 'CFO', 'IPO', 'ETF', 'SEC'].includes(potentialTicker)) {
        tickers.add(potentialTicker);
      }
    }

    // Pattern 3: Common financial news patterns like "AAPL shares" or "TSLA stock"
    const stockPattern = /\b([A-Z]{1,5})\s+(shares|stock|equity|securities)\b/gi;
    while ((match = stockPattern.exec(combinedText)) !== null) {
      const potentialTicker = match[1].toUpperCase();
      if (!['NYSE', 'NASDAQ', 'THE', 'AND', 'FOR'].includes(potentialTicker)) {
        tickers.add(potentialTicker);
      }
    }

    return Array.from(tickers).sort();
  }

  /**
   * Extract basic text from WebContents without Readability (fastest option)
   * Use only when speed is critical and you don't need clean article content.
   * @param {Electron.WebContents} webContents - The web contents to extract from
   * @returns {Promise<{title: string, text: string, url: string}>}
   */
  async extractBasicText(webContents) {
    try {
      const url = webContents.getURL();
      const title = webContents.getTitle();

      const text = await webContents.executeJavaScript(`
        document.body.innerText;
      `);

      return { title, text, url };
    } catch (error) {
      console.error('Error extracting basic text:', error);
      throw error;
    }
  }
}

module.exports = new ArticleExtractor();
