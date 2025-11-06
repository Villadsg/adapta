/**
 * Native Tab-Based News Scraper
 * Uses Electron's BrowserView to scrape news links from the current page
 * and extract text from top N articles.
 */

class NativeTabScraper {
  constructor() {
    this.scrapingInProgress = false;
  }

  /**
   * Extract news links from a page's content
   * @param {Electron.WebContents} webContents - The web contents to extract from
   * @param {number} limit - Maximum number of links to extract
   * @returns {Promise<Array<{url: string, title: string}>>}
   */
  async extractNewsLinks(webContents, limit = 5) {
    try {
      const links = await webContents.executeJavaScript(`
        (function() {
          const newsLinks = [];
          const seenUrls = new Set();

          // Find all links that look like news articles
          const allLinks = document.querySelectorAll('a[href]');

          for (const link of allLinks) {
            const href = link.href;
            const text = link.textContent.trim();

            // Skip empty links, anchors, and javascript links
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
              continue;
            }

            // Skip if we've seen this URL
            if (seenUrls.has(href)) {
              continue;
            }

            // Look for news-like patterns in URL
            const newsPatterns = [
              /\\/article\\//i,
              /\\/news\\//i,
              /\\/story\\//i,
              /\\/post\\//i,
              /\\/blog\\//i,
              /\\/press-release\\//i,
              /\\d{4}\\/\\d{2}\\/\\d{2}\\//,  // Date pattern in URL
              /\\d{6,}/  // 6+ digit number (often article IDs)
            ];

            const looksLikeNews = newsPatterns.some(pattern => pattern.test(href));

            // Also check if link text looks like a headline (reasonable length)
            const textLength = text.length;
            const hasGoodTextLength = textLength >= 20 && textLength <= 200;

            if ((looksLikeNews || hasGoodTextLength) && text) {
              newsLinks.push({
                url: href,
                title: text,
                score: (looksLikeNews ? 2 : 0) + (hasGoodTextLength ? 1 : 0)
              });
              seenUrls.add(href);
            }
          }

          // Sort by score (most likely to be news first)
          newsLinks.sort((a, b) => b.score - a.score);

          // Return top N, removing score from output
          return newsLinks.slice(0, ${limit}).map(({url, title}) => ({url, title}));
        })()
      `);

      return links;
    } catch (error) {
      console.error('Error extracting news links:', error);
      throw error;
    }
  }

  /**
   * Extract text content from a page
   * @param {Electron.WebContents} webContents - The web contents to extract from
   * @returns {Promise<{title: string, text: string, url: string}>}
   */
  async extractTextFromPage(webContents) {
    try {
      const url = webContents.getURL();

      const data = await webContents.executeJavaScript(`
        (function() {
          // Remove non-content elements
          const elementsToRemove = document.querySelectorAll(
            'script, style, nav, header, footer, aside, iframe, noscript, .advertisement, .ad, .social-share'
          );

          // Clone body to avoid modifying the actual page
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

      return {
        title: data.title,
        text: data.text,
        url: url
      };
    } catch (error) {
      console.error('Error extracting text from page:', error);
      throw error;
    }
  }

  /**
   * Main scraping function - extracts news links from current page and scrapes top N
   * @param {Object} options
   * @param {Electron.WebContents} options.currentWebContents - Current active tab
   * @param {Function} options.createTab - Function to create a new tab, returns {browserView, tabId}
   * @param {Function} options.closeTab - Function to close a tab by tabId
   * @param {Function} options.onProgress - Progress callback (current, total, message)
   * @param {number} options.topN - Number of articles to scrape (default: 5)
   * @returns {Promise<Array<{title: string, text: string, url: string}>>}
   */
  async scrapeNewsFromCurrentPage({
    currentWebContents,
    createTab,
    closeTab,
    onProgress,
    topN = 5
  }) {
    if (this.scrapingInProgress) {
      throw new Error('Scraping already in progress');
    }

    this.scrapingInProgress = true;
    const scrapedArticles = [];
    const tempTabIds = [];

    try {
      // Step 1: Extract links from current page
      if (onProgress) {
        onProgress(0, topN + 1, 'Extracting news links from current page...');
      }

      const currentUrl = currentWebContents.getURL();
      const newsLinks = await this.extractNewsLinks(currentWebContents, topN);

      if (newsLinks.length === 0) {
        throw new Error('No news links found on this page. Try navigating to a news website.');
      }

      console.log(`Found ${newsLinks.length} news links on ${currentUrl}`);

      // Step 2: Scrape each news article
      for (let i = 0; i < newsLinks.length; i++) {
        const { url, title: linkTitle } = newsLinks[i];

        if (onProgress) {
          onProgress(i + 1, topN + 1, `Scraping article ${i + 1}/${newsLinks.length}: ${linkTitle.substring(0, 50)}...`);
        }

        try {
          // Create a new tab for scraping
          const { browserView, tabId } = await createTab(url);
          tempTabIds.push(tabId);

          // Wait for page to load
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Page load timeout'));
            }, 30000); // 30 second timeout

            const checkLoaded = () => {
              if (!browserView.webContents.isLoading()) {
                clearTimeout(timeout);
                resolve();
              } else {
                setTimeout(checkLoaded, 100);
              }
            };

            browserView.webContents.on('did-finish-load', () => {
              clearTimeout(timeout);
              resolve();
            });

            browserView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
              clearTimeout(timeout);
              reject(new Error(`Failed to load: ${errorDescription}`));
            });

            // Start checking
            setTimeout(checkLoaded, 100);
          });

          // Give page a moment to render dynamic content
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Extract text
          const articleData = await this.extractTextFromPage(browserView.webContents);

          // Only include articles with substantial content
          if (articleData.text.length > 200) {
            scrapedArticles.push(articleData);
            console.log(`Successfully scraped: ${articleData.title} (${articleData.text.length} chars)`);
          } else {
            console.log(`Skipped article (insufficient content): ${articleData.title}`);
          }

        } catch (error) {
          console.error(`Error scraping ${url}:`, error.message);
          // Continue with next article
        }

        // Small delay between requests to be respectful
        if (i < newsLinks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Step 3: Cleanup temporary tabs
      if (onProgress) {
        onProgress(topN + 1, topN + 1, 'Cleaning up...');
      }

      for (const tabId of tempTabIds) {
        try {
          await closeTab(tabId);
        } catch (error) {
          console.error(`Error closing tab ${tabId}:`, error);
        }
      }

      if (onProgress) {
        onProgress(topN + 1, topN + 1, `Complete! Scraped ${scrapedArticles.length} articles.`);
      }

      return scrapedArticles;

    } catch (error) {
      // Cleanup on error
      for (const tabId of tempTabIds) {
        try {
          await closeTab(tabId);
        } catch (cleanupError) {
          console.error(`Error closing tab ${tabId} during cleanup:`, cleanupError);
        }
      }
      throw error;
    } finally {
      this.scrapingInProgress = false;
    }
  }
}

module.exports = new NativeTabScraper();
