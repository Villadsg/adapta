-- Historical-aggregation enrichment reads, ported from the DuckDB SQL in
-- src/services/database.js to Postgres RPC functions. Called from the mobile
-- adapter via supabase.rpc(...). DuckDB → Postgres translations:
--   MEDIAN(x)            -> percentile_cont(0.5) within group (order by x)
--   QUANTILE_CONT(x, q)  -> percentile_cont(q)   within group (order by x)
--   QUALIFY <rn>=1       -> wrap in subquery, filter on the window value
--   ::DATE               -> ::date  (unchanged)
--
-- All functions dedupe stock_prices by (ticker, date) keeping the latest
-- fetched_at, matching the ROW_NUMBER() ... rn = 1 pattern in the originals.

-- 1) Aggregate post-event forward returns (median / p25 / p75 per classification/day)
create or replace function get_aggregate_post_event_returns(
  max_forward_days integer,
  min_events integer
) returns table (
  classification text,
  day integer,
  n_events integer,
  median_return double precision,
  p25_return double precision,
  p75_return double precision
) language sql stable as $$
  with sp_dedup as (
    select ticker, date, close from (
      select ticker, date, close,
             row_number() over (partition by ticker, date order by fetched_at desc) as rn
      from stock_prices
    ) t where rn = 1
  ),
  event_base as (
    select e.id as event_id, e.ticker, e.event_date, e.classification, sp.close as event_close
    from stock_events e
    join sp_dedup sp on sp.ticker = e.ticker and sp.date = e.event_date
  ),
  forward as (
    select eb.event_id, eb.classification,
           row_number() over (partition by eb.event_id order by sp.date) as day_offset,
           (sp.close - eb.event_close) / eb.event_close as cum_return
    from event_base eb
    join sp_dedup sp on sp.ticker = eb.ticker and sp.date > eb.event_date
  ),
  complete_events as (
    select event_id from forward group by event_id having max(day_offset) >= max_forward_days
  )
  select f.classification,
         f.day_offset::int as day,
         count(*)::int as n_events,
         percentile_cont(0.5)  within group (order by f.cum_return) as median_return,
         percentile_cont(0.25) within group (order by f.cum_return) as p25_return,
         percentile_cont(0.75) within group (order by f.cum_return) as p75_return
  from forward f
  join complete_events ce on ce.event_id = f.event_id
  where f.day_offset <= max_forward_days
  group by f.classification, f.day_offset
  having count(*) >= min_events
  order by f.classification, f.day_offset
$$;

-- 2) Per-event forward returns for a specific set of event ids
create or replace function get_per_event_forward_returns(
  event_ids bigint[],
  max_forward_days integer
) returns table (
  event_id bigint,
  classification text,
  day integer,
  cum_return double precision
) language sql stable as $$
  with sp_dedup as (
    select ticker, date, close from (
      select ticker, date, close,
             row_number() over (partition by ticker, date order by fetched_at desc) as rn
      from stock_prices
    ) t where rn = 1
  ),
  event_base as (
    select e.id as event_id, e.ticker, e.event_date, e.classification, sp.close as event_close
    from stock_events e
    join sp_dedup sp on sp.ticker = e.ticker and sp.date = e.event_date
    where e.id = any(event_ids)
  ),
  forward as (
    select eb.event_id, eb.classification,
           row_number() over (partition by eb.event_id order by sp.date) as day_offset,
           (sp.close - eb.event_close) / eb.event_close as cum_return
    from event_base eb
    join sp_dedup sp on sp.ticker = eb.ticker and sp.date > eb.event_date
  )
  select event_id, classification, day_offset::int as day, cum_return
  from forward
  where day_offset <= max_forward_days
  order by event_id, day_offset
$$;

-- 3) Forward returns from arbitrary (id, ticker, snapshotDate) entries.
--    entries is a JSON array of { id, ticker, snapshotDate }.
create or replace function get_forward_returns_from_dates(
  entries jsonb,
  max_forward_days integer
) returns table (
  id bigint,
  day integer,
  cum_return double precision
) language sql stable as $$
  with sp_dedup as (
    select ticker, date, close from (
      select ticker, date, close,
             row_number() over (partition by ticker, date order by fetched_at desc) as rn
      from stock_prices
    ) t where rn = 1
  ),
  ent as (
    select (e->>'id')::bigint as entry_id,
           e->>'ticker' as ticker,
           (e->>'snapshotDate')::date as snap_date
    from jsonb_array_elements(entries) e
  ),
  entry_base as (
    select entry_id, ticker, snap_date, base_close from (
      select en.entry_id, en.ticker, en.snap_date, sp.close as base_close,
             row_number() over (partition by en.entry_id order by sp.date desc) as rn
      from ent en
      join sp_dedup sp on sp.ticker = en.ticker and sp.date <= en.snap_date
    ) q where rn = 1
  ),
  forward as (
    select eb.entry_id,
           row_number() over (partition by eb.entry_id order by sp.date) as day_offset,
           (sp.close - eb.base_close) / eb.base_close as cum_return
    from entry_base eb
    join sp_dedup sp on sp.ticker = eb.ticker and sp.date > eb.snap_date
  )
  select entry_id as id, day_offset::int as day, cum_return
  from forward
  where day_offset <= max_forward_days
  order by entry_id, day_offset
$$;

-- 4) All events with their optional cached feature vectors
create or replace function get_all_events_with_optional_features()
returns table (
  event_id bigint,
  classification text,
  ticker text,
  event_date date,
  feature_vector double precision[],
  snapshot_lag_days integer
) language sql stable as $$
  select e.id, e.classification, e.ticker, e.event_date, eof.feature_vector, eof.snapshot_lag_days
  from stock_events e
  left join event_options_features eof on eof.event_id = e.id
$$;

-- 5) All distinct snapshot dates with their optional cached feature vectors
create or replace function get_all_snapshot_dates_with_optional_features()
returns table (
  ticker text,
  snapshot_date date,
  feature_vector double precision[]
) language sql stable as $$
  select distinct os.ticker, os.snapshot_date::date as snapshot_date, sof.feature_vector
  from options_snapshots os
  left join snapshot_options_features sof
    on sof.ticker = os.ticker and sof.snapshot_date::date = os.snapshot_date::date
  order by os.ticker, snapshot_date
$$;
