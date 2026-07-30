// Screening runner — mirrors the desktop per-ticker orchestration
// (main.js:1407-1496) minus the desktop-only steps (Chronos Python
// forecasts, quote-summary tracker). Each run enriches the shared Supabase DB by
// writing price bars, classified events, and options snapshots.

import type { Engine } from './adapters/engine';
import type { DatabaseLike } from './adapters/engine';

export interface ScreenOptions {
  benchmark?: string;
  days?: number;
  minEvents?: number;
  holdDays?: number;
  maxExpirations?: number;
  analyzeOptions?: boolean;
}

export interface ScreenResult {
  ticker: string;
  stock: any;
  options: any | null;
  empiricalHold: any | null;
  savedEvents: number;
  savedBars: number;
}

export async function screenTicker(
  engine: Engine,
  database: DatabaseLike,
  ticker: string,
  opts: ScreenOptions = {},
  onProgress?: (msg: string) => void,
): Promise<ScreenResult> {
  const {
    benchmark = 'SPY',
    days = 200,
    minEvents = 15,
    holdDays = 60,
    maxExpirations = 4,
    analyzeOptions = true,
  } = opts;
  const progress = (m: string) => onProgress?.(m);

  progress(`${ticker}: fetching prices + classifying events…`);
  const stock = await engine.stock.analyzeStock(ticker, { benchmark, days, minEvents });

  // --- enrich: price bars ---
  progress(`${ticker}: saving ${stock.data.length} price bars…`);
  for (const bar of stock.data) {
    await database.saveStockPrice(
      ticker,
      new Date(bar.date).toISOString().split('T')[0],
      { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
      'analysis',
    );
  }

  // --- enrich: classified events ---
  const startDate = new Date(stock.data[0].date).toISOString().split('T')[0];
  const endDate = new Date(stock.data[stock.data.length - 1].date).toISOString().split('T')[0];
  const saveResult = await database.saveStockEvents(ticker, stock.events, benchmark, startDate, endDate);

  // --- options (non-fatal) ---
  let options: any = null;
  if (analyzeOptions) {
    try {
      progress(`${ticker}: fetching options chain…`);
      options = await engine.options.analyzeCurrentOptions(ticker, { maxExpirations });
      if (options) {
        await engine.options.saveSnapshot(options); // enrich: options snapshots
        options.history = await engine.options.getSnapshotHistory(ticker, days);
        options.historicalVolatility = engine.stock.computeHistoricalVolatility(stock.data);
        options.rollingHV = engine.stock.computeRollingHV(stock.data, 20);
        options.eventAnticipation = engine.options.computeEventAnticipation(
          options.summary, options.expirations, options.historicalVolatility, options.history,
        );
      }
    } catch (e: any) {
      console.warn(`${ticker}: options analysis failed (non-fatal): ${e?.message}`);
      options = null;
    }
  }

  // --- enrichment reads (non-fatal; degrade to null until history accumulates) ---
  let empiricalHold: any = null;
  try {
    empiricalHold = await engine.stock.computeEmpiricalHold(database, holdDays);
  } catch (e: any) {
    console.warn(`${ticker}: empirical hold failed (non-fatal): ${e?.message}`);
  }
  if (empiricalHold && options) {
    try {
      const adjusted = await engine.stock.computeOptionsAdjustedHold(database, holdDays, options, ticker);
      if (adjusted) empiricalHold.optionsAdjusted = adjusted;
    } catch (e: any) {
      console.warn(`${ticker}: options-adjusted hold failed (non-fatal): ${e?.message}`);
    }
  }
  if (options) {
    try {
      const snapHold = await engine.stock.computeSnapshotOptimalHold(database, holdDays, options);
      if (snapHold) {
        if (!empiricalHold) empiricalHold = {};
        empiricalHold.snapshotOptimalHold = snapHold;
      }
    } catch (e: any) {
      console.warn(`${ticker}: snapshot optimal hold failed (non-fatal): ${e?.message}`);
    }
  }

  progress(`${ticker}: done ✓`);
  return {
    ticker: ticker.toUpperCase(),
    stock,
    options,
    empiricalHold,
    savedEvents: saveResult.saved,
    savedBars: stock.data.length,
  };
}
