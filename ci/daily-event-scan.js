#!/usr/bin/env node

/**
 * Daily Event Scan — standalone job that checks tickers for significant
 * stock events and sends Telegram notifications when detected.
 *
 * Reuses existing service files from the Electron app.
 * Run: TWELVE_DATA_API_KEY=... node ci/daily-event-scan.js
 */

require('dotenv').config();

// Patch global fetch with browser UA for Yahoo Finance (same as main.js)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const _origFetch = global.fetch;
global.fetch = function (url, opts = {}) {
  const urlStr = typeof url === 'string' ? url : url?.toString?.() || '';
  if (urlStr.includes('yahoo.com')) {
    opts = { ...opts };
    opts.headers = { ...opts.headers, 'User-Agent': BROWSER_UA };
  }
  return _origFetch.call(this, url, opts);
};

// Stub out embeddings — only used for article correlation, not needed here
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
const stubPath = require('path').resolve(__dirname, 'stubs', 'embeddings.js');
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === './embeddings' || request.endsWith('/embeddings')) {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};

const path = require('path');
const config = require('./config.json');
const { sendMessage, formatEventMessage } = require('./telegram');

const ArticleDatabase = require('../src/services/database');
const StockAnalysisService = require('../src/services/stockAnalysis');
const OptionsAnalysisService = require('../src/services/optionsAnalysis');
const PriceTrackingService = require('../src/services/priceTracking');

const DB_PATH = path.join(__dirname, '..', 'data', 'events.db');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tickers = process.env.TICKERS
    ? process.env.TICKERS.split(',').map((t) => t.trim())
    : config.tickers;

  const { benchmark, days, minEvents, eventPercentileThreshold, delayBetweenTickersMs } = config;

  console.log(`=== Daily Event Scan ===`);
  console.log(`Tickers: ${tickers.join(', ')}`);
  console.log(`Benchmark: ${benchmark} | Days: ${days} | Min events: ${minEvents}`);
  console.log(`Percentile threshold: ${eventPercentileThreshold}`);
  console.log('');

  // Initialize database
  const database = new ArticleDatabase(DB_PATH);
  await database.initialize();

  // Initialize services
  const stockAnalyzer = new StockAnalysisService(database);
  const optionsAnalyzer = new OptionsAnalysisService(database);
  const priceTracker = new PriceTrackingService(database, { useBun: false });

  const detectedEvents = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    if (i > 0) {
      console.log(`  (waiting ${delayBetweenTickersMs / 1000}s before next ticker...)`);
      await sleep(delayBetweenTickersMs);
    }

    console.log(`\n--- ${ticker} ---`);

    try {
      // Run stock analysis
      const result = await stockAnalyzer.analyzeStock(ticker, {
        benchmark,
        days,
        minEvents,
      });

      // Save price bars to DB
      console.log(`Saving ${result.data.length} price bars...`);
      for (const bar of result.data) {
        await database.saveStockPrice(
          ticker,
          bar.date.toISOString().split('T')[0],
          { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
          'analysis'
        );
      }

      // Save events to DB
      const startDate = result.data[0].date.toISOString().split('T')[0];
      const endDate = result.data[result.data.length - 1].date.toISOString().split('T')[0];
      await database.saveStockEvents(ticker, result.events, benchmark, startDate, endDate);

      // Get current quote
      const currentQuote = await priceTracker.getQuoteSummary(ticker);

      if (!currentQuote || !currentQuote.open || !currentQuote.previousClose || !currentQuote.volume) {
        console.log(`  No valid quote data — skipping event signal`);
        continue;
      }

      // Compute event signal (replicating main.js logic)
      const gap = Math.abs(
        ((currentQuote.open - currentQuote.previousClose) / currentQuote.previousClose) * 100
      );
      const todayProduct = currentQuote.volume * gap;

      const allProducts = result.data
        .map((b) => b.volumeGapProduct ?? 0)
        .filter((p) => !isNaN(p) && p > 0)
        .sort((a, b) => a - b);

      const eventThreshold =
        result.events.length > 0
          ? Math.min(...result.events.map((e) => e.volumeGapProduct ?? 0))
          : 0;

      const belowCount = allProducts.filter((p) => p <= todayProduct).length;
      const percentile = allProducts.length > 0 ? (belowCount / allProducts.length) * 100 : 0;

      // Compute residual gap
      let residualGap = null;
      try {
        const reg = result.stats.regression;
        if (reg) {
          const benchQuote = await priceTracker.getQuoteSummary(benchmark);
          if (benchQuote && benchQuote.previousClose) {
            const stockReturn =
              (currentQuote.price - currentQuote.previousClose) / currentQuote.previousClose;
            const marketReturn =
              (benchQuote.price - benchQuote.previousClose) / benchQuote.previousClose;
            residualGap = Math.abs(
              (stockReturn - (reg.slope * marketReturn + reg.intercept)) * 100
            );
          }
        }
      } catch (benchErr) {
        console.error('  Benchmark quote fetch failed (non-fatal):', benchErr.message);
      }

      // Classify
      let classification = null;
      if (currentQuote.previousClose && currentQuote.open) {
        const gapNegative = currentQuote.previousClose > currentQuote.open;
        const intradayPositive = currentQuote.price > currentQuote.open;
        const closedBelowPrevClose = currentQuote.price < currentQuote.previousClose;

        if (gapNegative) {
          classification = !closedBelowPrevClose
            ? 'surprising_positive'
            : intradayPositive
              ? 'negative_anticipated'
              : 'surprising_negative';
        } else {
          classification = closedBelowPrevClose
            ? 'surprising_negative'
            : intradayPositive
              ? 'surprising_positive'
              : 'positive_anticipated';
        }
      }

      const avgEventVolume =
        result.events.length > 0
          ? result.events.reduce((sum, e) => sum + e.volume, 0) / result.events.length
          : 0;

      const eventSignal = {
        gap,
        todayProduct,
        threshold: eventThreshold,
        percentile,
        residualGap,
        isAboveThreshold: todayProduct >= eventThreshold && eventThreshold > 0,
        classification,
        avgEventVolume,
      };

      console.log(
        `  Signal: gap=${gap.toFixed(2)}%, percentile=${percentile.toFixed(1)}%, ` +
          `above_threshold=${eventSignal.isAboveThreshold}`
      );

      // Check if event detected
      const isEvent =
        eventSignal.isAboveThreshold || percentile > eventPercentileThreshold;

      if (!isEvent) {
        console.log(`  No event detected.`);
        continue;
      }

      console.log(`  *** EVENT DETECTED ***`);

      // Run options analysis
      let optionsData = null;
      try {
        optionsData = await optionsAnalyzer.analyzeCurrentOptions(ticker);
        if (optionsData) {
          const historicalVolatility = stockAnalyzer.computeHistoricalVolatility(result.data);
          const history = await optionsAnalyzer.getSnapshotHistory(ticker, days);
          optionsData.eventAnticipation = optionsAnalyzer.computeEventAnticipation(
            optionsData.summary,
            optionsData.expirations,
            historicalVolatility,
            history
          );
        }
      } catch (optErr) {
        console.error('  Options analysis failed (non-fatal):', optErr.message);
      }

      // Send Telegram notification
      const message = formatEventMessage(ticker, currentQuote, eventSignal, optionsData);
      console.log(`\n${message}\n`);
      await sendMessage(message);

      detectedEvents.push({ ticker, eventSignal, optionsData });
    } catch (err) {
      console.error(`  Error processing ${ticker}:`, err.message);
    }
  }

  // Summary
  console.log(`\n=== Scan Complete ===`);
  console.log(`Tickers scanned: ${tickers.length}`);
  console.log(`Events detected: ${detectedEvents.length}`);
  if (detectedEvents.length > 0) {
    console.log(
      `Event tickers: ${detectedEvents.map((e) => e.ticker).join(', ')}`
    );
  }

  // Close database
  try {
    if (database.db) {
      database.db.close();
    }
  } catch (e) {
    // ignore close errors
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
