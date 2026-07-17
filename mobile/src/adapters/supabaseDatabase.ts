// SupabaseDatabaseAdapter — implements the interface the screening engine expects
// (see the DB-coupling inventory) against a shared Supabase/Postgres database.
//
// Scope for v1:
//   • WRITES (the "enrich the shared DB" path) are implemented fully as upserts.
//   • Simple reads (nearest snapshot, snapshot-by-date, counts, price history) are
//     implemented directly.
//   • Complex historical aggregations (post-event forward returns, KNN feature
//     joins) currently return the engine's tolerated "insufficient data" shape.
//     They are the natural next step: port the DuckDB SQL in database.js to
//     Postgres RPC functions and call them via supabase.rpc(...). Until then,
//     empirical/options-adjusted hold simply reports "not enough data", which the
//     engine already handles gracefully.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import type { DatabaseLike } from './engine';

export function createSupabaseDatabase(cfg: AppConfig): DatabaseLike {
  const sb: SupabaseClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  const up = (ticker: string) => ticker.toUpperCase();

  const adapter: DatabaseLike = {
    // ---------------------------------------------------------------- writes
    async saveStockPrice(ticker: string, date: string, priceData: any, source = 'yahoo_finance') {
      const row = {
        ticker: up(ticker),
        date,
        open: priceData.open,
        high: priceData.high,
        low: priceData.low,
        close: priceData.close,
        volume: priceData.volume,
        source,
        fetched_at: new Date().toISOString(),
      };
      const { data, error } = await sb
        .from('stock_prices')
        .upsert(row, { onConflict: 'ticker,date,source' })
        .select('id')
        .single();
      if (error) throw new Error(`saveStockPrice: ${error.message}`);
      return { id: data?.id, ticker: up(ticker), date, ...priceData };
    },

    async saveStockEvents(
      ticker: string,
      events: any[],
      benchmark = 'SPY',
      startDate: string | null = null,
      endDate: string | null = null,
    ) {
      if (startDate && endDate) {
        const { error: delErr } = await sb
          .from('stock_events')
          .delete()
          .eq('ticker', up(ticker))
          .gte('event_date', startDate)
          .lte('event_date', endDate);
        if (delErr) throw new Error(`saveStockEvents delete: ${delErr.message}`);
      }

      const rows = events
        .map((event) => {
          const dateStr = event.dateStr || (event.date ? new Date(event.date).toISOString().split('T')[0] : null);
          if (!dateStr) return null;
          return {
            ticker: up(ticker),
            event_date: dateStr,
            classification: event.classification || event.earningsClassification || 'unknown',
            strength: event.strength || event.eventStrength || 0,
            residual_return: event.residualReturn || 0,
            volume_gap_product: event.volumeGapProduct || 0,
            open: event.open || 0,
            close: event.close || 0,
            high: event.high || 0,
            low: event.low || 0,
            volume: event.volume || 0,
            benchmark: benchmark.toUpperCase(),
            analyzed_at: new Date().toISOString(),
          };
        })
        .filter(Boolean) as any[];

      if (rows.length === 0) return { saved: 0, eventIds: [] };

      const { data, error } = await sb
        .from('stock_events')
        .upsert(rows, { onConflict: 'ticker,event_date' })
        .select('id, event_date');
      if (error) throw new Error(`saveStockEvents: ${error.message}`);

      const eventIds = (data || []).map((r: any) => ({
        eventId: r.id,
        dateStr: typeof r.event_date === 'string' ? r.event_date.split('T')[0] : r.event_date,
      }));
      return { saved: eventIds.length, eventIds };
    },

    async saveOptionsSnapshot(
      ticker: string,
      snapshotDate: string,
      expirationDate: string,
      currentPrice: number,
      metrics: any,
    ) {
      const row = {
        ticker: up(ticker),
        snapshot_date: snapshotDate,
        expiration_date: expirationDate,
        current_price: currentPrice,
        total_call_volume: metrics.totalCallVolume,
        total_put_volume: metrics.totalPutVolume,
        put_call_ratio: metrics.putCallRatio,
        total_call_oi: metrics.totalCallOI,
        total_put_oi: metrics.totalPutOI,
        put_call_oi_ratio: metrics.putCallOIRatio,
        atm_call_iv: metrics.atmCallIV,
        atm_put_iv: metrics.atmPutIV,
        avg_call_iv: metrics.avgCallIV,
        avg_put_iv: metrics.avgPutIV,
        max_call_volume_strike: metrics.maxCallVolumeStrike,
        max_put_volume_strike: metrics.maxPutVolumeStrike,
        max_call_oi_strike: metrics.maxCallOIStrike,
        max_put_oi_strike: metrics.maxPutOIStrike,
        unusual_volume_count: metrics.unusualVolumeCount,
        call_voi: metrics.callVOI ?? null,
        put_voi: metrics.putVOI ?? null,
        total_call_dollar_volume: metrics.totalCallDollarVolume ?? null,
        total_put_dollar_volume: metrics.totalPutDollarVolume ?? null,
        conviction_ratio: metrics.convictionRatio ?? null,
        total_call_dollar_volume_all: metrics.totalCallDollarVolumeAll ?? null,
        total_put_dollar_volume_all: metrics.totalPutDollarVolumeAll ?? null,
        conviction_ratio_all: metrics.convictionRatioAll ?? null,
        avg_call_iv_all: metrics.avgCallIVAll ?? null,
        avg_put_iv_all: metrics.avgPutIVAll ?? null,
      };
      const { data, error } = await sb
        .from('options_snapshots')
        .upsert(row, { onConflict: 'ticker,snapshot_date,expiration_date' })
        .select('id')
        .single();
      if (error) throw new Error(`saveOptionsSnapshot: ${error.message}`);
      return { id: data?.id, ticker: up(ticker), snapshotDate, expirationDate };
    },

    async saveEventOptionsFeatures(eventId: number, snapshotDate: string, lagDays: number, featureVector: any) {
      const row = {
        event_id: eventId,
        snapshot_date: snapshotDate,
        snapshot_lag_days: lagDays,
        feature_vector: Array.from(featureVector as ArrayLike<number>),
      };
      const { error } = await sb.from('event_options_features').upsert(row, { onConflict: 'event_id' });
      if (error) throw new Error(`saveEventOptionsFeatures: ${error.message}`);
    },

    async saveSnapshotOptionsFeatures(ticker: string, snapshotDate: string, featureVector: any) {
      const row = {
        ticker: up(ticker),
        snapshot_date: snapshotDate,
        feature_vector: Array.from(featureVector as ArrayLike<number>),
      };
      const { error } = await sb
        .from('snapshot_options_features')
        .upsert(row, { onConflict: 'ticker,snapshot_date' });
      if (error) throw new Error(`saveSnapshotOptionsFeatures: ${error.message}`);
    },

    async saveNewsCount(ticker: string, articleCount: number, source: string, pageUrl: string) {
      const row = { ticker: up(ticker), article_count: articleCount, source, page_url: pageUrl };
      const { data, error } = await sb.from('news_volume').insert(row).select('id, recorded_at').single();
      if (error) throw new Error(`saveNewsCount: ${error.message}`);
      return { id: data?.id, ticker: up(ticker), articleCount, recordedAt: data?.recorded_at, source };
    },

    // ------------------------------------------------------- simple reads
    async getTotalEventCount() {
      const { count, error } = await sb.from('stock_events').select('*', { count: 'exact', head: true });
      if (error) throw new Error(`getTotalEventCount: ${error.message}`);
      return count || 0;
    },

    async getDistinctEventTickers() {
      // PostgREST has no COUNT(DISTINCT); pull ticker column and dedupe client-side.
      const { data, error } = await sb.from('stock_events').select('ticker');
      if (error) throw new Error(`getDistinctEventTickers: ${error.message}`);
      return new Set((data || []).map((r: any) => r.ticker)).size;
    },

    async findNearestOptionsSnapshot(ticker: string, eventDate: string) {
      const { data, error } = await sb
        .from('options_snapshots')
        .select('snapshot_date')
        .eq('ticker', up(ticker))
        .lte('snapshot_date', eventDate)
        .order('snapshot_date', { ascending: false })
        .limit(1);
      if (error) throw new Error(`findNearestOptionsSnapshot: ${error.message}`);
      const snap = data?.[0]?.snapshot_date;
      if (!snap) return null;
      const lagDays = Math.round(
        (new Date(eventDate).getTime() - new Date(snap).getTime()) / 86400000,
      );
      return { snapshotDate: snap, lagDays };
    },

    async getOptionsSnapshots(ticker: string, days = 30) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const { data, error } = await sb
        .from('options_snapshots')
        .select('*')
        .eq('ticker', up(ticker))
        .gte('snapshot_date', since)
        .order('snapshot_date', { ascending: true });
      if (error) throw new Error(`getOptionsSnapshots: ${error.message}`);
      return data || [];
    },

    async getOptionsSnapshotsByDate(ticker: string, snapshotDate: string) {
      const { data, error } = await sb
        .from('options_snapshots')
        .select('*')
        .eq('ticker', up(ticker))
        .eq('snapshot_date', snapshotDate);
      if (error) throw new Error(`getOptionsSnapshotsByDate: ${error.message}`);
      return data || [];
    },

    async getLatestPrice(ticker: string, source?: string) {
      let q = sb.from('stock_prices').select('date, close, volume').eq('ticker', up(ticker));
      if (source) q = q.eq('source', source);
      const { data, error } = await q.order('date', { ascending: false }).limit(1);
      if (error) throw new Error(`getLatestPrice: ${error.message}`);
      return data?.[0] || null;
    },

    async getPriceHistory(ticker: string, options: any = {}) {
      let q = sb.from('stock_prices').select('date, close, volume').eq('ticker', up(ticker));
      if (options.startDate) q = q.gte('date', options.startDate);
      if (options.endDate) q = q.lte('date', options.endDate);
      const { data, error } = await q.order('date', { ascending: true });
      if (error) throw new Error(`getPriceHistory: ${error.message}`);
      return data || [];
    },

    // ----------------------------- complex aggregations (Postgres RPCs)
    // Backed by the SQL functions in migrations/0002_rpc_functions.sql, ported
    // from the DuckDB queries in database.js.
    async getAggregatePostEventReturns(maxForwardDays = 30, minEvents = 3) {
      const { data, error } = await sb.rpc('get_aggregate_post_event_returns', {
        max_forward_days: maxForwardDays,
        min_events: minEvents,
      });
      if (error) throw new Error(`getAggregatePostEventReturns: ${error.message}`);
      return data || [];
    },

    async getPerEventForwardReturns(eventIds: number[], maxForwardDays = 60) {
      if (!eventIds || eventIds.length === 0) return [];
      const { data, error } = await sb.rpc('get_per_event_forward_returns', {
        event_ids: eventIds,
        max_forward_days: maxForwardDays,
      });
      if (error) throw new Error(`getPerEventForwardReturns: ${error.message}`);
      return (data || []).map((r: any) => ({
        event_id: Number(r.event_id),
        classification: r.classification,
        day: Number(r.day),
        cum_return: Number(r.cum_return),
      }));
    },

    async getForwardReturnsFromDates(dateEntries: any[], maxForwardDays = 60) {
      if (!dateEntries || dateEntries.length === 0) return [];
      const entries = dateEntries.map((e) => ({
        id: e.id,
        ticker: e.ticker,
        snapshotDate: new Date(e.snapshotDate).toISOString().split('T')[0],
      }));
      const { data, error } = await sb.rpc('get_forward_returns_from_dates', {
        entries,
        max_forward_days: maxForwardDays,
      });
      if (error) throw new Error(`getForwardReturnsFromDates: ${error.message}`);
      return (data || []).map((r: any) => ({
        id: Number(r.id),
        day: Number(r.day),
        cum_return: Number(r.cum_return),
      }));
    },

    async getAllEventsWithOptionalFeatures() {
      const { data, error } = await sb.rpc('get_all_events_with_optional_features');
      if (error) throw new Error(`getAllEventsWithOptionalFeatures: ${error.message}`);
      return data || [];
    },

    async getAllSnapshotDatesWithOptionalFeatures() {
      const { data, error } = await sb.rpc('get_all_snapshot_dates_with_optional_features');
      if (error) throw new Error(`getAllSnapshotDatesWithOptionalFeatures: ${error.message}`);
      return data || [];
    },

    // Article-corpus enrichment (news uniqueness) is deferred on mobile v1 —
    // embeddings are produced desktop-side. Return empty so uniqueness stays neutral.
    async getArticlesByTickerAndDateRange() { return []; },
    async getArticlesWithEmbeddingsByTicker() { return []; },
  };

  return adapter;
}
