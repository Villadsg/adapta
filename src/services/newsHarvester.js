/**
 * NewsHarvesterService - Periodically collects news for watched tickers
 *
 * This service builds up a historical corpus of articles over time by:
 * 1. Fetching recent news for all watched tickers via Yahoo Finance
 * 2. Extracting full article content
 * 3. Storing articles with embeddings in DuckDB
 *
 * Over time, this accumulates enough data to calculate meaningful
 * uniqueness scores for articles associated with stock events.
 *
 * Supports optional Bun worker for faster batch article extraction.
 */

const YahooNewsService = require('./yahooNewsService');
const articleExtractor = require('./articleExtractor');
const bunBridge = require('./bunBridge');

class NewsHarvesterService {
  constructor(database, options = {}) {
    this.database = database;
    this.yahooNews = new YahooNewsService();
    this.isRunning = false;
    this.intervalId = null;
    this.lastHarvestTime = null;
    this.useBun = options.useBun !== false; // Default to true
    this.bunChecked = false;
    this.bunAvailable = false;
    this.stats = {
      totalHarvests: 0,
      articlesCollected: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      lastError: null
    };
  }

  /**
   * Check if Bun is available (cached check)
   * @returns {Promise<boolean>}
   */
  async checkBunAvailable() {
    if (this.bunChecked) {
      return this.bunAvailable;
    }
    this.bunChecked = true;
    this.bunAvailable = await bunBridge.isBunAvailable();
    if (this.bunAvailable && this.useBun) {
      console.log('NewsHarvester: Bun detected - using Bun workers for faster article extraction');
    }
    return this.bunAvailable;
  }

  /**
   * Start the harvester with periodic collection
   * @param {Object} options - Harvester options
   * @param {number} options.intervalMinutes - Minutes between harvests (default: 60)
   * @param {boolean} options.runImmediately - Run harvest immediately on start (default: true)
   */
  start(options = {}) {
    const { intervalMinutes = 60, runImmediately = true } = options;

    if (this.isRunning) {
      console.log('NewsHarvester: Already running');
      return;
    }

    console.log(`NewsHarvester: Starting with ${intervalMinutes} minute interval`);
    this.isRunning = true;

    // Run immediately if requested
    if (runImmediately) {
      this.harvest().catch(err => {
        console.error('NewsHarvester: Initial harvest failed:', err.message);
      });
    }

    // Set up periodic harvesting
    this.intervalId = setInterval(() => {
      this.harvest().catch(err => {
        console.error('NewsHarvester: Periodic harvest failed:', err.message);
      });
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop the harvester
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('NewsHarvester: Stopped');
  }

  /**
   * Run a single harvest cycle for all watched tickers
   * @returns {Promise<Object>} Harvest results
   */
  async harvest() {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    console.log('\n=== NEWS HARVEST CYCLE ===');
    console.log(`Time: ${new Date().toISOString()}`);

    const results = {
      tickersProcessed: 0,
      articlesNew: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      errors: []
    };

    try {
      // Get all watched tickers with auto_update enabled
      const watchedTickers = await this.database.getWatchedTickers(true);

      if (watchedTickers.length === 0) {
        console.log('NewsHarvester: No watched tickers to harvest');
        return results;
      }

      console.log(`NewsHarvester: Processing ${watchedTickers.length} tickers`);

      // Process each ticker
      for (const tickerRecord of watchedTickers) {
        const ticker = tickerRecord.ticker;

        try {
          const tickerResults = await this.harvestTicker(ticker);
          results.tickersProcessed++;
          results.articlesNew += tickerResults.new;
          results.articlesDuplicate += tickerResults.duplicate;
          results.articlesFailed += tickerResults.failed;
        } catch (error) {
          console.error(`NewsHarvester: Error processing ${ticker}:`, error.message);
          results.errors.push({ ticker, error: error.message });
        }

        // Rate limiting between tickers
        await this.delay(2000);
      }

      // Update stats
      this.stats.totalHarvests++;
      this.stats.articlesCollected += results.articlesNew;
      this.stats.articlesDuplicate += results.articlesDuplicate;
      this.stats.articlesFailed += results.articlesFailed;
      this.lastHarvestTime = new Date();

      console.log('\n=== HARVEST COMPLETE ===');
      console.log(`Tickers processed: ${results.tickersProcessed}`);
      console.log(`New articles: ${results.articlesNew}`);
      console.log(`Duplicates skipped: ${results.articlesDuplicate}`);
      console.log(`Failed: ${results.articlesFailed}`);

      return results;

    } catch (error) {
      this.stats.lastError = error.message;
      throw error;
    }
  }

  /**
   * Harvest news for a single ticker
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<Object>} Results for this ticker
   */
  async harvestTicker(ticker) {
    console.log(`\nHarvesting news for ${ticker}...`);

    const results = {
      new: 0,
      duplicate: 0,
      failed: 0
    };

    // Fetch news from Yahoo Finance
    const newsItems = await this.yahooNews.fetchTickerNews(ticker, 50);

    if (newsItems.length === 0) {
      console.log(`  No news found for ${ticker}`);
      return results;
    }

    console.log(`  Found ${newsItems.length} news items`);

    // Filter out existing articles first
    const newNewsItems = [];
    for (const news of newsItems) {
      const exists = await this.articleExists(news.link);
      if (exists) {
        results.duplicate++;
      } else {
        newNewsItems.push(news);
      }
    }

    if (newNewsItems.length === 0) {
      console.log(`  All articles already exist`);
      return results;
    }

    console.log(`  ${newNewsItems.length} new articles to process`);

    // Try batch extraction with Bun if available
    if (this.useBun && await this.checkBunAvailable()) {
      return this.harvestTickerBatch(ticker, newNewsItems, results);
    }

    // Fallback to sequential processing
    return this.harvestTickerSequential(ticker, newNewsItems, results);
  }

  /**
   * Harvest articles using Bun batch processing
   * @private
   */
  async harvestTickerBatch(ticker, newsItems, results) {
    const urls = newsItems.map(n => n.link);

    try {
      console.log(`  Using Bun batch extraction for ${urls.length} articles...`);
      const articles = await bunBridge.batchFetchArticles(urls);

      // Process results
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        const news = newsItems[i];

        if (!article.success) {
          const dateStr = news.publishTime
            ? news.publishTime.toISOString().split('T')[0]
            : 'no date';
          console.log(`    Failed [${dateStr}]: ${news.title.substring(0, 40)}...`);
          results.failed++;
          continue;
        }

        // Skip if no meaningful content
        if (!article.text || article.text.length < 100) {
          results.failed++;
          continue;
        }

        // Prepare ticker list
        const tickers = [...(article.tickers || [])];
        if (!tickers.includes(ticker)) {
          tickers.push(ticker);
        }

        // Use Yahoo's publish time if extraction didn't find one
        const publishedDate = article.publishedDate ||
          (news.publishTime ? news.publishTime.toISOString() : null);

        try {
          // Save to database with embedding
          await this.database.saveArticle(
            article.url,
            article.title,
            article.text,
            'stock_news',
            {
              publishedDate: publishedDate,
              tickers: tickers,
              generateEmbedding: true
            }
          );

          const dateStr = news.publishTime
            ? news.publishTime.toISOString().split('T')[0]
            : 'no date';
          console.log(`    Saved [${dateStr}]: ${(article.title || news.title).substring(0, 50)}...`);
          results.new++;
        } catch (error) {
          console.error(`    Error saving article: ${error.message}`);
          results.failed++;
        }
      }
    } catch (error) {
      console.warn(`  Bun batch extraction failed: ${error.message}, falling back to sequential`);
      return this.harvestTickerSequential(ticker, newsItems, results);
    }

    console.log(`  ${ticker}: ${results.new} new, ${results.duplicate} duplicate, ${results.failed} failed`);
    return results;
  }

  /**
   * Harvest articles sequentially (fallback method)
   * @private
   */
  async harvestTickerSequential(ticker, newsItems, results) {
    for (const news of newsItems) {
      try {
        // Extract article content
        const dateStr = news.publishTime
          ? news.publishTime.toISOString().split('T')[0]
          : 'no date';
        let article;
        try {
          article = await articleExtractor.extractFromURL(news.link, {
            timeout: 15000
          });
        } catch (extractError) {
          console.log(`    Failed [${dateStr}]: ${news.title.substring(0, 40)}...`);
          results.failed++;
          continue;
        }

        // Skip if no meaningful content
        if (!article.text || article.text.length < 100) {
          results.failed++;
          continue;
        }

        // Prepare ticker list
        const tickers = [...(article.tickers || [])];
        if (!tickers.includes(ticker)) {
          tickers.push(ticker);
        }

        // Use Yahoo's publish time if extraction didn't find one
        const publishedDate = article.publishedDate ||
          (news.publishTime ? news.publishTime.toISOString() : null);

        // Save to database with embedding
        await this.database.saveArticle(
          article.url,
          article.title,
          article.text,
          'stock_news',
          {
            publishedDate: publishedDate,
            tickers: tickers,
            generateEmbedding: true
          }
        );

        console.log(`    Saved [${dateStr}]: ${(article.title || news.title).substring(0, 50)}...`);
        results.new++;

        // Rate limiting between articles
        await this.delay(1500);

      } catch (error) {
        console.error(`    Error processing article: ${error.message}`);
        results.failed++;
      }
    }

    console.log(`  ${ticker}: ${results.new} new, ${results.duplicate} duplicate, ${results.failed} failed`);
    return results;
  }

  /**
   * Check if an article URL already exists in the database
   * @param {string} url - Article URL
   * @returns {Promise<boolean>} True if exists
   */
  async articleExists(url) {
    return new Promise((resolve, reject) => {
      this.database.connection.all(
        'SELECT COUNT(*) as count FROM articles WHERE url = ?',
        [url],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]?.count > 0);
        }
      );
    });
  }

  /**
   * Get harvester status and statistics
   * @returns {Object} Current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastHarvestTime: this.lastHarvestTime,
      stats: { ...this.stats }
    };
  }

  /**
   * Manually trigger a harvest for specific tickers
   * @param {Array<string>} tickers - Ticker symbols to harvest
   * @returns {Promise<Object>} Harvest results
   */
  async harvestTickers(tickers) {
    console.log(`\n=== MANUAL HARVEST: ${tickers.join(', ')} ===`);

    const results = {
      tickersProcessed: 0,
      articlesNew: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      errors: []
    };

    for (const ticker of tickers) {
      try {
        const tickerResults = await this.harvestTicker(ticker.toUpperCase());
        results.tickersProcessed++;
        results.articlesNew += tickerResults.new;
        results.articlesDuplicate += tickerResults.duplicate;
        results.articlesFailed += tickerResults.failed;
      } catch (error) {
        results.errors.push({ ticker, error: error.message });
      }

      await this.delay(2000);
    }

    return results;
  }

  /**
   * Utility delay function
   * @param {number} ms - Milliseconds to wait
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = NewsHarvesterService;
