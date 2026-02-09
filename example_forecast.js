/**
 * Example: Stock Price Forecasting with Chronos-2
 *
 * This script demonstrates how to use Amazon Chronos-2 for
 * stock price forecasting based on event analysis.
 *
 * Prerequisites:
 * 1. Install Python dependencies:
 *    pip install -r python/requirements.txt
 *
 * 2. Set API keys (optional, for data fetching):
 *    export TWELVE_DATA_API_KEY=your_key
 *    export EODHD_API_KEY=your_key
 */

const ArticleDatabase = require('./src/services/database');
const StockAnalysisService = require('./src/services/stockAnalysis');
const ChronosForecastService = require('./src/services/chronosForecast');

async function main() {
  const db = new ArticleDatabase('articles.db');
  await db.initialize();

  const stockAnalysis = new StockAnalysisService(db);

  console.log('\n=== Chronos-2 Stock Forecasting Examples ===\n');

  // Example 1: Basic forecast from analysis
  console.log('1. Analyzing AAPL with event detection and forecast:');
  try {
    const result = await stockAnalysis.analyzeStockWithForecast('AAPL', {
      days: 200,           // Historical data window
      minEvents: 10,       // Minimum events to detect
      forecastDays: 14,    // Days to forecast ahead
      modelSize: 'small',  // Chronos model: tiny, small, base
    });

    console.log(`   Found ${result.events.length} events`);
    console.log(`   Event classifications:`, result.stats.classifications);

    if (result.forecast) {
      console.log('\n   Forecast results:');
      console.log(`   Last price: $${result.forecast.last_price.toFixed(2)}`);
      console.log(`   14-day forecast (median): $${result.forecast.median[13].toFixed(2)}`);
      console.log(`   90% confidence: $${result.forecast.low_10[13].toFixed(2)} - $${result.forecast.high_90[13].toFixed(2)}`);

      if (result.forecast.event_context) {
        console.log('\n   Event context:');
        console.log(`   - Total events analyzed: ${result.forecast.event_context.num_events}`);
        console.log(`   - Average event return: ${(result.forecast.event_context.avg_event_return * 100).toFixed(2)}%`);
        console.log(`   - Event bias: ${result.forecast.event_context.event_bias.toFixed(2)} (-1=bearish, +1=bullish)`);
      }

      if (result.forecast.event_analysis) {
        console.log('\n   Post-event analysis:');
        console.log(`   - Classification: ${result.forecast.event_analysis.classification}`);
        console.log(`   - Event strength: ${result.forecast.event_analysis.strength.toFixed(2)}%`);
        console.log(`   - Expected continuation: ${(result.forecast.event_analysis.expected_continuation * 100).toFixed(1)}%`);
      }
    } else {
      console.log(`   Forecast error: ${result.forecastError}`);
    }
  } catch (error) {
    console.error(`   Error: ${error.message}`);
  }

  // Example 2: Direct forecast service usage
  console.log('\n2. Direct Chronos-2 forecast (with custom prices):');
  const forecaster = new ChronosForecastService({
    modelSize: 'tiny',   // Use tiny model for quick demo
    defaultDays: 7,
  });

  // Check if dependencies are installed
  const hasChronos = await forecaster.checkDependencies();
  if (!hasChronos) {
    console.log('   Chronos not installed. Install with:');
    console.log('   pip install -r python/requirements.txt');
  } else {
    // Example with synthetic data
    const prices = [100, 101, 99, 102, 104, 103, 105, 107, 106, 108, 110, 109, 111, 113];
    const forecast = await forecaster.forecastPrices(prices, 7);

    console.log(`   Input: ${prices.length} days of price data`);
    console.log(`   Last price: $${forecast.last_price.toFixed(2)}`);
    console.log(`   7-day forecast:`);
    forecast.median.forEach((price, i) => {
      const low = forecast.low_25[i].toFixed(2);
      const high = forecast.high_75[i].toFixed(2);
      console.log(`     Day ${i + 1}: $${price.toFixed(2)} (50% CI: $${low} - $${high})`);
    });
  }

  // Example 3: Post-event forecast
  console.log('\n3. Post-event forecast scenario:');
  if (hasChronos) {
    const eventPrices = [150, 152, 151, 153, 155, 140]; // Gap down on last day
    const event = {
      classification: 'surprising_negative',
      strength: 10.5,
      residual_return: -0.08,
    };

    const postEventForecast = await forecaster.forecastPostEvent(eventPrices, event, 7);

    console.log('   Scenario: Stock gapped down 10% on earnings');
    console.log(`   Event type: ${postEventForecast.event_analysis.classification}`);
    console.log(`   Forecast from $${postEventForecast.last_price.toFixed(2)}:`);
    console.log(`     Day 7 median: $${postEventForecast.median[6].toFixed(2)}`);
    console.log(`     Expected continuation: ${(postEventForecast.event_analysis.expected_continuation * 100).toFixed(1)}%`);
  }

  await db.close();
  console.log('\n=== Forecast examples complete ===\n');
}

main().catch(console.error);
