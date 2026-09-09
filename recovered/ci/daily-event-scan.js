#!/usr/bin/env node

/**
 * Ticker Scan — standalone CI job that, for each ticker in the
 * TICKERS env var (comma-separated), computes recent events + current
 * options metrics and sends a Telegram message.
 *
 * Run: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
 *      MARKET_DATA_API_KEY=... TWELVE_DATA_API_KEY=... EODHD_API_KEY=... \
 *      TICKERS=AXON,QCOM,NVDA node ci/daily-event-scan.js
 */

const path = require('path');
// .env.local first (real keys, gitignored), then .env as fallback.
require('dotenv').config({ path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')] });

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

const fs = require('fs');
const config = require('./config.json');
const { sendMessage } = require('./telegram');

const ArticleDatabase = require('../src/services/database');
const StockAnalysisService = require('../src/services/stockAnalysis');
const OptionsAnalysisService = require('../src/services/optionsAnalysis');
const IBOptionsProvider = require('../src/services/ibOptionsProvider');

const DB_PATH = path.join(__dirname, '..', 'data', 'events.db');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadTickers() {
  if (!process.env.TICKERS) {
    throw new Error('TICKERS env var is required (comma-separated tickers)');
  }
  return process.env.TICKERS.split(',').map((t) => t.trim()).filter(Boolean);
}

async function main() {
  const tickers = loadTickers();
  const { benchmark, days, minEvents, delayBetweenTickersMs } = config;

  console.log(`=== Ticker Scan ===`);
  console.log(`Tickers (${tickers.length}): ${tickers.join(', ')}`);
  console.log(`Benchmark: ${benchmark} | Days: ${days} | Min events: ${minEvents}`);
  console.log('');

  const database = new ArticleDatabase(DB_PATH);
  await database.initialize();

  const stockAnalyzer = new StockAnalysisService(database);
  const ibProvider = new IBOptionsProvider({ port: 4001 });
  const optionsAnalyzer = new OptionsAnalysisService(database, ibProvider);

  const sent = [];
  const failed = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if (i > 0) {
      await sleep(delayBetweenTickersMs);
    }
    console.log(`\n--- ${ticker} ---`);

    let events = [];
    let optionsData = null;

    try {
      const result = await stockAnalyzer.analyzeStock(ticker, {
        benchmark,
        days,
        minEvents,
      });
      events = result.events || [];
      console.log(`  Found ${events.length} events`);
    } catch (err) {
      console.error(`  Stock analysis failed: ${err.message}`);
    }

    try {
      optionsData = await optionsAnalyzer.analyzeCurrentOptions(ticker);
      if (optionsData) {
        console.log(
          `  Options: ${optionsData.expirations?.length || 0} expirations, ` +
            `wCallIV=${((optionsData.summary.avgCallIV || 0) * 100).toFixed(1)}% ` +
            `wPutIV=${((optionsData.summary.avgPutIV || 0) * 100).toFixed(1)}%`
        );
      }
    } catch (err) {
      console.error(`  Options analysis failed: ${err.message}`);
    }

    try {
      const message = formatTickerMessage(ticker, events, optionsData);
      console.log(`\n${message}\n`);
      await sendMessage(message);
      sent.push(ticker);
    } catch (err) {
      console.error(`  Telegram send failed: ${err.message}`);
      failed.push(ticker);
    }
  }

  console.log(`\n=== Scan Complete ===`);
  console.log(`Sent: ${sent.length}/${tickers.length}`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(', ')}`);
  }

  try {
    if (database.db) {
      database.db.close();
    }
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
