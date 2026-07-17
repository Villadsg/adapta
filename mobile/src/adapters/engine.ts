// Loads the shared screening engine (src/services/stockAnalysis.js and
// optionsAnalysis.js) into the mobile webview.
//
// The engine reads its API keys from process.env at import time, so we install
// the process polyfill BEFORE dynamically importing it. Vite aliases the engine's
// Node-only deps (./embeddings, duckdb, fs, path) to browser stubs, and
// CapacitorHttp patches fetch — so the engine source itself needs no changes.

import { installProcessEnv, type AppConfig } from './config';

export interface DatabaseLike {
  [method: string]: (...args: any[]) => any;
}

export interface Engine {
  stock: any; // StockAnalysisService instance
  options: any; // OptionsAnalysisService instance
}

let enginePromise: Promise<Engine> | null = null;

export async function getEngine(cfg: AppConfig, database: DatabaseLike): Promise<Engine> {
  if (enginePromise) return enginePromise;
  installProcessEnv(cfg);

  enginePromise = (async () => {
    // Dynamic import so the process polyfill is in place before module-top-level
    // env reads execute. Paths are relative to this file (mobile/src/adapters).
    const stockMod: any = await import('../../../src/services/stockAnalysis.js');
    const optionsMod: any = await import('../../../src/services/optionsAnalysis.js');
    const StockAnalysisService = stockMod.default ?? stockMod;
    const OptionsAnalysisService = optionsMod.default ?? optionsMod;

    return {
      stock: new StockAnalysisService(database),
      // ibProvider omitted → IB path stays disabled (USE_IB_OPTIONS unset)
      options: new OptionsAnalysisService(database, null),
    } as Engine;
  })();

  return enginePromise;
}

export function resetEngine(): void {
  enginePromise = null;
}
