# Workflow Separation: Stock Analysis vs. Comparison Training

## Overview

The browser now has **two separate workflows** for saving articles, each with a distinct purpose:

### 1. "Mark as Not Good" Workflow (Red Button)
- **Category**: `not_good`
- **Purpose**: Comparison/training data for similarity analysis
- **Stores**: URL, title, content, embedding
- **Does NOT store**: Tickers, publication dates
- **Use case**: Building a dataset of articles to compare against

### 2. "Save Stock News" Workflow (Green Button - 📈)
- **Category**: `stock_news`
- **Purpose**: Stock analysis and price correlation research
- **Stores**: URL, title, content, embedding, **tickers**, **published_date**
- **Behavior**:
  1. Shows similarity analysis first
  2. Automatically saves article with stock data
- **Use case**: Collecting news for pairing with historical price movements

## Technical Implementation

### Backend (main.js)

```javascript
// Conditional extraction based on category
const shouldExtractStockData = (category === 'stock_news');

await database.saveArticle(url, title, text, category, {
  publishedDate: shouldExtractStockData ? publishedDate : null,
  tickers: shouldExtractStockData ? tickers : []
});
```

### Frontend (renderer.js)

**"Not Good" Button**:
- Calls `saveArticle('not_good')`
- Simple save without ticker/date extraction
- Status: "✓ Marked as Not Good: [Title]"

**"Save Stock News" Button**:
- Calls `saveStockNews()`
- Step 1: Analyze similarity
- Step 2: Save as `stock_news` with tickers/dates
- Status: "✓ Saved for stock analysis: [Title] [AAPL, TSLA] (1/15/2024)"

### Styling

- **"Save Stock News"**: Green button (#2e7d32) - indicates "save/collect"
- **"Not Good"**: Red button (#c62828) - indicates "label/categorize"

## Database Queries

### Get stock analysis articles only:
```sql
SELECT * FROM articles WHERE category = 'stock_news';
```

### Get comparison training data only:
```sql
SELECT * FROM articles WHERE category = 'not_good';
```

### Get stock news for a specific ticker:
```sql
SELECT * FROM articles
WHERE category = 'stock_news'
  AND list_contains(tickers, 'AAPL')
ORDER BY published_date DESC;
```

### Verify separation:
```sql
-- This should return 0 rows (no 'not_good' articles with tickers)
SELECT * FROM articles
WHERE category = 'not_good'
  AND tickers IS NOT NULL
  AND array_length(tickers) > 0;
```

## Benefits of Separation

1. **Clean Data**: Stock analysis data (stock_news) is separate from training data (not_good)
2. **Performance**: not_good articles don't need ticker extraction, saving processing time
3. **Storage Efficiency**: not_good articles don't store unnecessary fields
4. **Clear Intent**: Each workflow has a distinct purpose and UI
5. **Easy Querying**: Can filter by category to get exactly the data you need

## Example Workflows

### Collecting Stock News
1. Browse to financial news article
2. Click "📈 Save Stock News"
3. View similarity analysis
4. Article is saved with tickers and date
5. Use for price correlation analysis

### Building Training Data
1. Browse to article you want to compare against
2. Click "Mark as Not Good"
3. Article is saved for similarity comparison
4. No tickers/dates stored (not needed)

## Migration Notes

- Existing articles in the database keep their original category
- Old articles may have null tickers/dates (that's fine)
- New saves with `category = 'not_good'` will have empty tickers
- New saves with `category = 'stock_news'` will extract tickers/dates
