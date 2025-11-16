# Stock Analysis Features

This document describes the new features for associating news articles with stock tickers and extracting publication dates.

## Features Added

### 1. Publication Date Extraction

Articles now automatically extract publication dates from:
- Meta tags (`article:published_time`, `og:published_time`, etc.)
- `<time>` elements with `datetime` attributes
- JSON-LD structured data

**Database Field:** `published_date` (TIMESTAMP)

### 2. Stock Ticker Extraction

Articles automatically extract stock ticker symbols using multiple patterns:
- Dollar sign format: `$AAPL`, `$TSLA`
- Parentheses format: `Apple (AAPL)`, `Tesla (TSLA)`
- Stock references: `AAPL shares`, `TSLA stock`

**Database Field:** `tickers` (TEXT[] array)

### 3. New Database Methods

#### Search by Ticker
```javascript
const articles = await db.searchByTicker('AAPL', {
  categoryFilter: 'good',        // Optional: filter by category
  startDate: '2024-01-01',       // Optional: filter by date range
  endDate: '2024-12-31',
  limit: 100
});
```

#### Get All Tickers
```javascript
const tickers = await db.getAllTickers();
// Returns: [{ ticker: 'AAPL', count: 15 }, { ticker: 'TSLA', count: 12 }, ...]
```

#### Search with Date Filters
All search methods now include `published_date` in results:
```javascript
const articles = await db.getAllArticles('good', 100);
articles.forEach(article => {
  console.log(article.title);
  console.log('Published:', article.published_date);
  console.log('Tickers:', article.tickers);
});
```

## Use Cases for Stock Analysis

### 1. Pair News with Price Movements

```javascript
const articles = await db.searchByTicker('AAPL', {
  startDate: '2024-01-01',
  endDate: '2024-12-31'
});

const analysis = articles.map(article => ({
  title: article.title,
  publishDate: new Date(article.published_date),
  embedding: article.embedding,
  tickers: article.tickers,
  // Add your price data here:
  priceChange1d: getPriceChange('AAPL', article.published_date, 1),
  priceChange7d: getPriceChange('AAPL', article.published_date, 7)
}));
```

### 2. Find Correlated News Events

```javascript
// Find all articles about a stock
const baseArticles = await db.searchByTicker('NVDA');

// For each article, find semantically similar articles
for (const article of baseArticles) {
  const similar = await db.searchBySimilarity(article.content, {
    limit: 5,
    minSimilarity: 0.7
  });

  // Analyze if similar news patterns correlate with price movements
  analyzePriceCorrelation(article, similar);
}
```

### 3. Multi-Stock Event Analysis

```javascript
// Find articles mentioning multiple stocks (merger news, sector analysis, etc.)
const multiStockArticles = await db.executeRawSQL(`
  SELECT title, tickers, published_date, embedding
  FROM articles
  WHERE array_length(tickers) > 1
  ORDER BY published_date DESC
`);

// Analyze cross-stock correlations
multiStockArticles.rows.forEach(article => {
  // Get price movements for all mentioned tickers
  const priceData = article.tickers.map(ticker => ({
    ticker,
    change: getPriceChange(ticker, article.published_date, 7)
  }));

  // Analyze if multi-stock news has broader market impact
});
```

### 4. Time Series Analysis

```javascript
// Get all articles for a ticker, ordered by date
const articles = await db.searchByTicker('TSLA', {
  startDate: '2023-01-01',
  endDate: '2024-12-31',
  limit: 1000
});

// Create time series dataset
const timeSeries = articles
  .filter(a => a.published_date)
  .map(a => ({
    date: new Date(a.published_date),
    embedding: a.embedding,
    category: a.category,
    // Add price data
    price: getPrice('TSLA', a.published_date)
  }))
  .sort((a, b) => a.date - b.date);

// Now you can:
// - Train LSTM/RNN models on embedding sequences -> price predictions
// - Detect anomalies in news sentiment before price movements
// - Build trading signals based on news patterns
```

### 5. Sentiment-Price Correlation

```javascript
// Get categorized articles (good/not_good) for a ticker
const goodNews = await db.searchByTicker('AAPL', {
  categoryFilter: 'good'
});

const badNews = await db.searchByTicker('AAPL', {
  categoryFilter: 'not_good'
});

// Calculate average price movements after each sentiment
const goodNewsImpact = calculateAveragePriceChange(goodNews);
const badNewsImpact = calculateAveragePriceChange(badNews);

console.log('Average price change after good news:', goodNewsImpact);
console.log('Average price change after bad news:', badNewsImpact);
```

## SQL Query Examples

### Articles by Ticker and Date Range
```sql
SELECT title, published_date, tickers, embedding
FROM articles
WHERE list_contains(tickers, 'AAPL')
  AND published_date >= '2024-01-01'
  AND published_date < '2024-02-01'
ORDER BY published_date DESC;
```

### Top Tickers by Article Count
```sql
SELECT UNNEST(tickers) as ticker, COUNT(*) as count
FROM articles
WHERE tickers IS NOT NULL
GROUP BY ticker
ORDER BY count DESC
LIMIT 10;
```

### Articles with Embeddings for a Ticker
```sql
SELECT id, title, published_date, tickers, embedding
FROM articles
WHERE list_contains(tickers, 'TSLA')
  AND embedding IS NOT NULL
ORDER BY published_date DESC;
```

### Multi-Ticker News Events
```sql
SELECT title, tickers, published_date
FROM articles
WHERE array_length(tickers) >= 2
ORDER BY published_date DESC;
```

### Articles by Date Range (All Tickers)
```sql
SELECT title, tickers, published_date
FROM articles
WHERE published_date >= '2024-01-01'
  AND published_date < '2024-02-01'
ORDER BY published_date ASC;
```

## Data Export for Analysis

You can export data to CSV/JSON for use in Python/R/Excel:

```javascript
// Export ticker-specific data
const articles = await db.searchByTicker('AAPL');
const fs = require('fs');

// CSV format
const csv = [
  'title,published_date,tickers,url',
  ...articles.map(a =>
    `"${a.title}","${a.published_date}","${a.tickers?.join(';')}","${a.url}"`
  )
].join('\n');
fs.writeFileSync('aapl_news.csv', csv);

// Or use the SQL interface to export directly:
// SELECT * FROM articles WHERE list_contains(tickers, 'AAPL')
// Then copy the results from the settings page
```

## Tips for Stock Analysis

1. **Date Accuracy**: Not all news sites provide publication dates in metadata. Check the `published_date` field - null values mean the date couldn't be extracted.

2. **Ticker Accuracy**: The automatic extraction uses common patterns but may have false positives. Review extracted tickers for your specific use case.

3. **Manual Override**: When saving articles, you can manually specify tickers and dates if needed (modify the `save-article` handler in `main.js`).

4. **Embedding Quality**: Use the full article embeddings (not chunks) for comparing news articles semantically.

5. **Time Zones**: Publication dates are stored in UTC. Convert to your local timezone or market timezone when pairing with price data.

6. **Missing Dates**: For articles without publication dates, you can use the `saved_at` timestamp as a fallback, though this represents when you saved it, not when it was published.

## Example Workflow

1. **Collect News**: Browse financial news sites and save articles using the "Not Good" button (or modify to add "Good" button)

2. **Verify Data**: Use the SQL interface in Settings to verify tickers were extracted correctly:
   ```sql
   SELECT title, tickers FROM articles LIMIT 10;
   ```

3. **Export Data**: Query for your target ticker and date range

4. **Pair with Prices**: Use the exported data with your price data source (Yahoo Finance, Alpha Vantage, etc.)

5. **Analyze**: Use embeddings + price changes to train models, find patterns, or generate trading signals

## Next Steps

- Add a UI dropdown to manually select/add tickers when saving
- Add ticker validation against a known ticker list
- Add company name → ticker mapping for better extraction
- Create a dedicated export tool for pairing with price data
- Add visualization for ticker frequency over time
