/**
 * YahooNewsService - Fetches news from Yahoo Finance for stock tickers
 *
 * Uses the yahoo-finance2 library's search API to retrieve news articles
 * related to specific stock tickers.
 */

const YahooFinance = require('yahoo-finance2').default;

// Create singleton instance with v3 configuration
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey']
});

class YahooNewsService {
  constructor() {
    // v3: Configuration is done at module level via class instantiation
  }

  /**
   * Fetch news for a ticker from Yahoo Finance search API
   * @param {string} ticker - Stock ticker symbol (e.g., 'NVDA', 'AAPL')
   * @param {number} newsCount - Number of news items to fetch (default: 50)
   * @returns {Promise<Array>} Array of news items with title, link, publisher, providerPublishTime
   */
  async fetchTickerNews(ticker, newsCount = 50) {
    try {
      console.log(`  Fetching Yahoo Finance news for ${ticker}...`);

      const result = await yahooFinance.search(ticker, {
        newsCount: newsCount,
        quotesCount: 0, // We only want news, not quotes
      });

      const news = result.news || [];
      console.log(`  Found ${news.length} news items from Yahoo Finance`);

      const mappedNews = news.map(item => {
        // Handle providerPublishTime - could be Date, seconds, milliseconds, or string
        let publishTime = null;
        const rawTime = item.providerPublishTime;

        if (rawTime) {
          if (rawTime instanceof Date) {
            publishTime = rawTime;
          } else if (typeof rawTime === 'string') {
            publishTime = new Date(rawTime);
          } else if (typeof rawTime === 'number') {
            // Check magnitude to determine if seconds or milliseconds
            // Milliseconds for 2020 is ~1.58 trillion, seconds is ~1.58 billion
            if (rawTime > 1e12) {
              // Already milliseconds
              publishTime = new Date(rawTime);
            } else {
              // Seconds - convert to milliseconds
              publishTime = new Date(rawTime * 1000);
            }
          }

          // Validate the date is reasonable (between 2000 and 2100)
          if (publishTime && (publishTime.getFullYear() < 2000 || publishTime.getFullYear() > 2100)) {
            console.warn(`  Invalid date parsed for "${item.title}": ${publishTime}, raw value: ${rawTime}`);
            publishTime = null;
          }
        }

        return {
          uuid: item.uuid,
          title: item.title,
          link: item.link,
          publisher: item.publisher,
          publishTime: publishTime,
          relatedTickers: item.relatedTickers || []
        };
      });

      // Log date range of fetched news for debugging
      if (mappedNews.length > 0) {
        const dates = mappedNews.filter(n => n.publishTime).map(n => n.publishTime);
        if (dates.length > 0) {
          const oldest = new Date(Math.min(...dates));
          const newest = new Date(Math.max(...dates));
          console.log(`  News date range: ${oldest.toISOString().split('T')[0]} to ${newest.toISOString().split('T')[0]}`);
        }
      }

      return mappedNews;
    } catch (error) {
      console.error(`  Error fetching news for ${ticker}:`, error.message);
      return [];
    }
  }

  /**
   * Filter news items by date range around an event date
   * @param {Array} newsItems - Array of news from Yahoo Finance
   * @param {Date} eventDate - Center date for filtering
   * @param {number} dayRange - Days before/after event date (default: 1)
   * @returns {Array} Filtered news items within date range
   */
  filterNewsByDateRange(newsItems, eventDate, dayRange = 1) {
    const eventTime = new Date(eventDate).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;

    const startTime = eventTime - (dayRange * msPerDay);
    const endTime = eventTime + (dayRange * msPerDay);

    return newsItems.filter(news => {
      if (!news.publishTime) return false;
      const publishTime = news.publishTime.getTime();
      return publishTime >= startTime && publishTime <= endTime;
    });
  }

  /**
   * Get news for multiple event dates
   * @param {string} ticker - Stock ticker symbol
   * @param {Array<Date>} eventDates - Array of event dates
   * @param {number} dayRange - Days before/after each event
   * @returns {Promise<Map>} Map of eventDate -> news items
   */
  async getNewsForEvents(ticker, eventDates, dayRange = 1) {
    // Fetch all news once
    const allNews = await this.fetchTickerNews(ticker, 100);

    // Filter for each event date
    const newsMap = new Map();

    for (const eventDate of eventDates) {
      const relevantNews = this.filterNewsByDateRange(allNews, eventDate, dayRange);
      newsMap.set(eventDate.toISOString().split('T')[0], relevantNews);
    }

    return newsMap;
  }
}

module.exports = YahooNewsService;
