// A no-op database used for the Phase A spike (proving the engine runs on-device
// with no persistence). Reads return the "insufficient data" shape the engine
// already tolerates (null / empty arrays / neutral), and writes are ignored.
// Phase B replaces this with SupabaseDatabaseAdapter.

import type { DatabaseLike } from './engine';

export const nullDatabase: DatabaseLike = {
  // --- enrichment reads (engine tolerates empty results) ---
  getTotalEventCount: async () => 0,
  getDistinctEventTickers: async () => 0,
  getAggregatePostEventReturns: async () => [],
  getAllEventsWithOptionalFeatures: async () => [],
  findNearestOptionsSnapshot: async () => null,
  getOptionsSnapshotsByDate: async () => [],
  getPerEventForwardReturns: async () => [],
  getAllSnapshotDatesWithOptionalFeatures: async () => [],
  getForwardReturnsFromDates: async () => [],
  getArticlesByTickerAndDateRange: async () => [],
  getArticlesWithEmbeddingsByTicker: async () => [],
  getPriceHistory: async () => [],
  getLatestPrice: async () => null,

  // --- writes (ignored in Phase A) ---
  saveStockPrice: async () => ({}),
  saveStockEvents: async () => ({ saved: 0, eventIds: [] }),
  saveOptionsSnapshot: async () => ({}),
  saveEventOptionsFeatures: async () => {},
  saveSnapshotOptionsFeatures: async () => {},
  saveNewsCount: async () => ({}),
};
