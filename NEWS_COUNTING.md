# Semi-Automated News Counting Feature

## Overview

Track news volume over time for stock tickers - a valuable metric that often correlates with price movements and market events. This feature allows you to record article counts from financial news pages with a single click.

## How It Works

### Basic Workflow
1. Navigate to a ticker's news page (e.g., Yahoo Finance AAPL news)
2. Click "📊 Count News" button
3. System automatically:
   - Detects ticker from URL
   - Counts articles on the page
   - Saves to database with timestamp
4. See confirmation: "✓ Recorded 25 articles for AAPL (1/15/2024)"

### Supported Sources
- **Yahoo Finance** - `https://finance.yahoo.com/quote/AAPL/news`
- More sources can be added in the future (Bloomberg, CNBC, etc.)

## Database Structure

### `news_volume` Table
```sql
CREATE TABLE news_volume (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  article_count INTEGER NOT NULL,
  source TEXT,
  page_url TEXT
)
```

**Indexes:**
- `idx_news_volume_ticker` - Fast ticker lookups
- `idx_news_volume_recorded_at` - Time-based queries

## Use Cases

### 1. Track News Volume Over Time
```sql
-- Get daily news volume for AAPL over last 30 days
SELECT DATE(recorded_at) as date, article_count
FROM news_volume
WHERE ticker = 'AAPL'
  AND recorded_at >= datetime('now', '-30 days')
ORDER BY date DESC;
```

**Example output:**
```
date       | article_count
-----------|-------------
2024-01-15 | 25
2024-01-14 | 18
2024-01-13 | 12
2024-01-12 | 15
...
```

### 2. Detect News Spikes
```sql
-- Find days with unusually high news volume
SELECT ticker, DATE(recorded_at) as date, article_count
FROM news_volume
WHERE article_count > 20
ORDER BY article_count DESC;
```

**What it tells you:**
- News spikes often precede/coincide with earnings, product launches, or major events
- Can be a leading or confirming indicator for price movements

### 3. Compare Multiple Tickers
```sql
-- Compare news volume across tech stocks
SELECT
  ticker,
  DATE(recorded_at) as date,
  article_count
FROM news_volume
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'NVDA')
  AND recorded_at >= datetime('now', '-7 days')
ORDER BY date DESC, article_count DESC;
```

### 4. Pair with Your Saved Articles
```sql
-- Compare total news volume with articles you saved
SELECT
  nv.ticker,
  DATE(nv.recorded_at) as date,
  nv.article_count as total_volume,
  COUNT(a.id) as saved_articles
FROM news_volume nv
LEFT JOIN articles a
  ON DATE(a.published_date) = DATE(nv.recorded_at)
  AND list_contains(a.tickers, nv.ticker)
WHERE nv.ticker = 'AAPL'
GROUP BY date, nv.article_count
ORDER BY date DESC;
```

### 5. Export for Analysis
```sql
-- Export for pairing with price data in Python/R
SELECT
  ticker,
  DATE(recorded_at) as date,
  article_count,
  source
FROM news_volume
WHERE ticker IN ('AAPL', 'TSLA')
ORDER BY ticker, date;
```

## Practical Example: News Volume Analysis

**Scenario:** You want to track if news volume correlates with AAPL price movements

**Step 1:** Collect news counts daily
- Visit `https://finance.yahoo.com/quote/AAPL/news` every day
- Click "📊 Count News"
- Repeat for 30 days

**Step 2:** Query your data
```sql
SELECT
  DATE(recorded_at) as date,
  article_count
FROM news_volume
WHERE ticker = 'AAPL'
ORDER BY date;
```

**Step 3:** Export and pair with price data
```python
import pandas as pd
import yfinance as yf

# Your news volume data
news_volume = pd.read_sql("SELECT ...", conn)

# Get price data
aapl = yf.Ticker("AAPL")
prices = aapl.history(period="30d")

# Merge
analysis = pd.merge(
    news_volume,
    prices[['Close']],
    left_on='date',
    right_index=True
)

# Analyze correlation
correlation = analysis['article_count'].corr(analysis['Close'])
print(f"Correlation: {correlation}")
```

## Button Location

**Toolbar Layout:**
```
[URL Bar] [Ticker Input] [📈 Save Stock News] [📊 Count News] [Mark as "Not Good"] [⚙️ Settings]
```

- **📈 Save Stock News** (Green) - Saves full article with tickers/dates
- **📊 Count News** (Purple) - Just counts articles on page
- **Mark as "Not Good"** (Red) - Training data

## Error Handling

### Common Errors

**"Unsupported news source"**
- Only Yahoo Finance is currently supported
- URL must match: `finance.yahoo.com/quote/*/news`

**"Could not detect ticker from URL"**
- Make sure you're on a ticker's news page, not the main page
- URL should be: `finance.yahoo.com/quote/AAPL/news` (not just `/quote/AAPL`)

**"No articles found"**
- Page may not have finished loading - wait and try again
- Yahoo Finance may have changed their HTML structure (selectors need updating)

## Tips

1. **Consistency**: Visit at the same time each day for comparable data
2. **Multiple sources**: If Yahoo shows 25 articles, other sources may show different counts
3. **Historical data**: This tracks when YOU recorded the count, not when articles were published
4. **Combine with saved articles**: Use "Save Stock News" for deep analysis, "Count News" for volume tracking

## Technical Details

### News Scraper Logic

The scraper tries multiple CSS selectors to find articles:
```javascript
const selectors = [
  'li[data-test-locator="mega"]',  // Main news items
  'li.js-stream-content',           // Stream content
  'h3[class*="title"]',             // Article titles
  'div[data-test="article-card"]'   // Article cards
];
```

Uses the selector that finds the most elements.

### Extending to Other Sources

To add Bloomberg support:
1. Add detection in `newsScraper.js`:
   ```javascript
   if (url.includes('bloomberg.com')) return 'bloomberg';
   ```
2. Add ticker extraction:
   ```javascript
   if (source === 'bloomberg') {
     // Extract ticker from Bloomberg URL
   }
   ```
3. Add counting function:
   ```javascript
   async countBloombergArticles(webContents) {
     // Bloomberg-specific selectors
   }
   ```

## Future Automation

This semi-automated setup is designed to easily upgrade to full automation:

**Current:** Manual click on each page
**Future:** Background scheduler visits pages automatically

See `WORKFLOW_SEPARATION.md` for the automation upgrade path.

## Queries for Analysis

### View all recorded counts
```sql
SELECT * FROM news_volume ORDER BY recorded_at DESC LIMIT 20;
```

### Stats by ticker
```sql
SELECT
  ticker,
  COUNT(*) as total_records,
  AVG(article_count) as avg_count,
  MAX(article_count) as max_count,
  MIN(article_count) as min_count
FROM news_volume
GROUP BY ticker
ORDER BY total_records DESC;
```

### Recent activity
```sql
SELECT
  ticker,
  DATE(recorded_at) as date,
  article_count,
  source
FROM news_volume
WHERE recorded_at >= datetime('now', '-7 days')
ORDER BY recorded_at DESC;
```

### Identify quiet days
```sql
SELECT ticker, DATE(recorded_at) as date, article_count
FROM news_volume
WHERE article_count < 10
ORDER BY date DESC;
```
