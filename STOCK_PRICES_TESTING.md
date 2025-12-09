# Stock Price Tracking - Testing Guide

## Feature Summary
A sliding sidebar that displays stock price charts and data for watched tickers.

## How to Test

### 1. Start the Application
```bash
npm start
```

### 2. Open the Stock Prices Sidebar
- Look for the **"💹 Stock Prices"** button in the toolbar (between "Mark as Not Good" and "⚙️ Settings")
- Click the button to open the sidebar panel from the right side
- The sidebar should slide in with a smooth animation

### 3. Add a Ticker to Track
- Click the **"+"** button next to the ticker dropdown
- Enter a ticker symbol (e.g., AAPL, TSLA, MSFT, GOOGL)
- The app will automatically fetch 1 year of historical price data
- Wait for the data to load (you'll see a "Fetching historical data..." message)

### 4. View Price Chart
- Once data is fetched, you should see:
  - Latest price and change % (color-coded: green for positive, red for negative)
  - Interactive price chart showing historical close prices
  - Chart displays up to 365 days of data
  - Hover over chart to see exact prices for specific dates

### 5. Test Other Features

#### Refresh Latest Price
- Select a ticker from the dropdown
- Click **"🔄 Refresh"** button
- Should fetch and display the latest few days of price data

#### Fetch Full History
- Click **"📥 Fetch History"** button
- Re-downloads full historical data for the selected ticker

#### Remove Ticker
- Click **"🗑️ Remove"** button
- Confirms before removing ticker from watchlist

### 6. Configure Auto-Polling
- Click **"⚙️ Settings"** button
- Scroll to **"Stock Price Tracking"** section
- You should see:
  - Statistics: Total price records, tickers tracked, watched tickers, date range
  - Checkbox to enable automatic price updates
  - Dropdown to select update interval (5, 15, 30, or 60 minutes)
  - Current polling status indicator
- Enable auto-polling and click **"Save Settings"**
- The app will now automatically update prices in the background

### 7. Manual Refresh All
- In Settings, click **"Refresh All Prices Now"**
- Updates latest prices for all watched tickers immediately

## Troubleshooting

### Sidebar Doesn't Open
1. Open Developer Tools (uncomment line in main.js: `mainWindow.webContents.openDevTools()`)
2. Check console for errors
3. Look for the message: `✓ Stock prices button listener attached`
4. If you see `Stock sidebar elements not found`, there's a DOM loading issue

### No Data Displayed
1. Check your internet connection (Yahoo Finance API requires internet)
2. Verify ticker symbol is valid
3. Check console for API errors
4. Some tickers may not have data available from Yahoo Finance

### Chart Not Rendering
1. Ensure Chart.js loaded successfully (check Network tab in DevTools)
2. Verify there is price data in the database (check Settings > Price Data Statistics)
3. Look for JavaScript errors in console

## Database Queries

You can use the SQL interface in Settings to inspect the data:

```sql
-- View all watched tickers
SELECT * FROM watched_tickers ORDER BY ticker;

-- View price data for a specific ticker
SELECT * FROM stock_prices WHERE ticker = 'AAPL' ORDER BY date DESC LIMIT 30;

-- Count total price records
SELECT ticker, COUNT(*) as records, MIN(date) as earliest, MAX(date) as latest
FROM stock_prices
GROUP BY ticker
ORDER BY records DESC;
```

## Expected Behavior

- ✅ Sidebar slides in from right when button clicked
- ✅ Sidebar slides out when close (×) button clicked or button clicked again
- ✅ Price chart renders with Chart.js
- ✅ Latest price shows current value and change %
- ✅ Auto-polling works in background (check console for "Polling prices..." messages)
- ✅ All data persists in DuckDB (survives app restart)
- ✅ Incremental updates only fetch new data, not full history

## Console Debug Messages

When working correctly, you should see:
```
✓ Stock prices button listener attached
Stock prices button clicked (when button clicked)
Sidebar open state: true (when sidebar opens)
📈 Fetching historical prices for AAPL...
  ✓ Fetched 252 price records for AAPL
  ✓ Saved 252 price records for AAPL (2024-01-01 to 2025-01-15)
```

## Known Limitations

- Yahoo Finance API is unofficial and may have rate limits
- Some tickers may not be available
- Historical data typically goes back ~5 years maximum
- Real-time quotes are delayed by 15 minutes
- Chart.js loaded from CDN (requires internet on first load)
