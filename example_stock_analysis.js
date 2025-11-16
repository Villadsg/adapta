/**
 * Example: Stock News Analysis
 *
 * This script demonstrates how to use the new ticker and date features
 * to analyze news articles for specific stocks and pair them with
 * historical price movements.
 */

const ArticleDatabase = require('./src/services/database');

async function main() {
  const db = new ArticleDatabase('articles.db');
  await db.initialize();

  console.log('\n=== Stock News Analysis Examples ===\n');

  // Example 1: Find all articles mentioning a specific ticker
  console.log('1. Finding all AAPL articles:');
  const aaplArticles = await db.searchByTicker('AAPL', { limit: 10 });
  console.log(`   Found ${aaplArticles.length} articles`);
  aaplArticles.forEach(article => {
    const date = article.published_date
      ? new Date(article.published_date).toLocaleDateString()
      : 'No date';
    console.log(`   - ${date}: ${article.title}`);
    console.log(`     Tickers: ${article.tickers?.join(', ') || 'None'}`);
  });

  // Example 2: Find articles for a ticker within a date range
  console.log('\n2. Finding TSLA articles from last month:');
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const tslaRecent = await db.searchByTicker('TSLA', {
    startDate: lastMonth.toISOString(),
    limit: 5
  });
  console.log(`   Found ${tslaRecent.length} articles`);
  tslaRecent.forEach(article => {
    const date = article.published_date
      ? new Date(article.published_date).toLocaleDateString()
      : 'No date';
    console.log(`   - ${date}: ${article.title}`);
  });

  // Example 3: Get all tickers mentioned in the database
  console.log('\n3. All tickers in database:');
  const allTickers = await db.getAllTickers();
  console.log(`   Found ${allTickers.length} unique tickers`);
  allTickers.slice(0, 10).forEach(({ ticker, count }) => {
    console.log(`   - ${ticker}: ${count} articles`);
  });

  // Example 4: Find similar articles for sentiment comparison
  console.log('\n4. Finding similar NVDA articles for sentiment analysis:');
  const nvdaArticles = await db.searchByTicker('NVDA', { limit: 1 });
  if (nvdaArticles.length > 0) {
    const article = nvdaArticles[0];
    console.log(`   Base article: ${article.title}`);

    // Search for similar articles using embeddings
    const similarArticles = await db.searchBySimilarity(article.content, {
      limit: 3,
      minSimilarity: 0.6
    });

    console.log(`   Found ${similarArticles.length} similar articles:`);
    similarArticles.forEach(sim => {
      console.log(`   - ${(sim.similarity * 100).toFixed(1)}%: ${sim.title}`);
    });
  }

  // Example 5: Raw SQL for advanced queries
  console.log('\n5. Articles with multiple tickers (potential multi-stock news):');
  const multiTickerQuery = `
    SELECT title, tickers, published_date
    FROM articles
    WHERE array_length(tickers) > 1
    ORDER BY published_date DESC
    LIMIT 5
  `;
  const multiTicker = await db.executeRawSQL(multiTickerQuery);
  if (multiTicker.rows) {
    multiTicker.rows.forEach(row => {
      const date = row.published_date
        ? new Date(row.published_date).toLocaleDateString()
        : 'No date';
      console.log(`   - ${date}: ${row.title}`);
      console.log(`     Tickers: ${row.tickers?.join(', ')}`);
    });
  }

  // Example 6: Query for pairing with price data
  console.log('\n6. Example: Query structure for pairing with price data:');
  console.log(`
  // Pseudo-code for pairing news with prices:
  const articles = await db.searchByTicker('AAPL', {
    startDate: '2024-01-01',
    endDate: '2024-12-31'
  });

  const analysis = articles.map(article => {
    const publishDate = new Date(article.published_date);

    // Get price data for this date and following days
    const priceOnDate = getPriceData('AAPL', publishDate);
    const priceNextDay = getPriceData('AAPL', addDays(publishDate, 1));
    const priceNextWeek = getPriceData('AAPL', addDays(publishDate, 7));

    return {
      title: article.title,
      publishDate: publishDate,
      embedding: article.embedding,
      priceChange1d: (priceNextDay - priceOnDate) / priceOnDate,
      priceChange7d: (priceNextWeek - priceOnDate) / priceOnDate,
      category: article.category // 'good' or 'not_good' for training
    };
  });

  // Now you can:
  // 1. Train ML models: embedding -> price_change
  // 2. Find correlations between similar news and price movements
  // 3. Cluster articles by embedding similarity and analyze price patterns
  `);

  await db.close();
  console.log('\n✓ Analysis complete!\n');
}

main().catch(console.error);
