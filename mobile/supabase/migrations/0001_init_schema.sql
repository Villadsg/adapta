-- Adapta shared screening schema (Supabase / Postgres).
--
-- Ported from the desktop DuckDB schema in src/services/database.js so the mobile
-- app and (later) the desktop app enrich one shared database. Type mapping:
--   INTEGER PK DEFAULT nextval(seq) -> BIGINT GENERATED ALWAYS AS IDENTITY
--   FLOAT[] / FLOAT[25]             -> double precision[]  (pgvector optional later)
--   TEXT[]                         -> text[]
--   DECIMAL(p,s)                   -> numeric(p,s)
--   TIMESTAMP                      -> timestamptz
--
-- The UNIQUE(...) constraints are load-bearing: the engine upserts on them.

-- ---------------------------------------------------------------------------
-- Article corpus (news uniqueness enrichment; deferred on mobile v1)
-- ---------------------------------------------------------------------------
create table if not exists articles (
  id             bigint generated always as identity primary key,
  url            text not null,
  title          text,
  content        text,
  category       text,
  domain         text,
  saved_at       timestamptz default now(),
  word_count     integer,
  embedding      double precision[],
  published_date timestamptz,
  tickers        text[]
);
create index if not exists idx_articles_category on articles(category);
create index if not exists idx_articles_published_date on articles(published_date);

create table if not exists article_chunks (
  chunk_id    bigint generated always as identity primary key,
  article_id  bigint not null references articles(id),
  chunk_text  text not null,
  chunk_index integer not null,
  embedding   double precision[],
  category    text not null,
  created_at  timestamptz default now()
);
create index if not exists idx_chunks_article_id on article_chunks(article_id);

-- ---------------------------------------------------------------------------
-- Key/value settings
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------------------
-- News volume snapshots
-- ---------------------------------------------------------------------------
create table if not exists news_volume (
  id            bigint generated always as identity primary key,
  ticker        text not null,
  recorded_at   timestamptz default now(),
  article_count integer not null,
  source        text,
  page_url      text
);
create index if not exists idx_news_volume_ticker on news_volume(ticker);

-- ---------------------------------------------------------------------------
-- Daily price bars  (written by analyzeStock)
-- ---------------------------------------------------------------------------
create table if not exists stock_prices (
  id         bigint generated always as identity primary key,
  ticker     text not null,
  date       date not null,
  open       numeric(10,2),
  high       numeric(10,2),
  low        numeric(10,2),
  close      numeric(10,2),
  volume     bigint,
  source     text,
  fetched_at timestamptz default now(),
  unique(ticker, date, source)
);
create index if not exists idx_stock_prices_ticker_date on stock_prices(ticker, date);

-- ---------------------------------------------------------------------------
-- Watchlist + portfolio
-- ---------------------------------------------------------------------------
create table if not exists watched_tickers (
  id          bigint generated always as identity primary key,
  ticker      text not null unique,
  added_at    timestamptz default now(),
  auto_update boolean default true
);

create table if not exists portfolio_holdings (
  id       bigint generated always as identity primary key,
  ticker   text not null unique,
  shares   numeric(12,4) not null,
  added_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Classified events  (written by analyzeStock)  — empirical-hold enrichment
-- ---------------------------------------------------------------------------
create table if not exists stock_events (
  id                 bigint generated always as identity primary key,
  ticker             text not null,
  event_date         date not null,
  classification     text,
  strength           numeric(8,4),
  residual_return    numeric(8,4),
  volume_gap_product numeric(18,4),
  open               numeric(10,2),
  close              numeric(10,2),
  high               numeric(10,2),
  low                numeric(10,2),
  volume             bigint,
  benchmark          text,
  analyzed_at        timestamptz default now(),
  unique(ticker, event_date)
);
create index if not exists idx_stock_events_ticker on stock_events(ticker);
create index if not exists idx_stock_events_date on stock_events(event_date);
create index if not exists idx_stock_events_classification on stock_events(classification);

-- Lazy KNN feature-vector cache keyed by event
create table if not exists event_options_features (
  event_id          bigint unique,
  snapshot_date     timestamptz,
  snapshot_lag_days integer,
  feature_vector    double precision[],
  created_at        timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Options snapshots  (written by analyzeCurrentOptions) — options-adjusted hold
-- ---------------------------------------------------------------------------
create table if not exists options_snapshots (
  id                     bigint generated always as identity primary key,
  ticker                 text not null,
  snapshot_date          timestamptz not null,
  expiration_date        date not null,
  current_price          numeric(10,2),
  total_call_volume      bigint,
  total_put_volume       bigint,
  put_call_ratio         numeric(6,3),
  total_call_oi          bigint,
  total_put_oi           bigint,
  put_call_oi_ratio      numeric(6,3),
  atm_call_iv            numeric(6,4),
  atm_put_iv             numeric(6,4),
  avg_call_iv            numeric(6,4),
  avg_put_iv             numeric(6,4),
  max_call_volume_strike numeric(10,2),
  max_put_volume_strike  numeric(10,2),
  max_call_oi_strike     numeric(10,2),
  max_put_oi_strike      numeric(10,2),
  unusual_volume_count   integer,
  -- columns added by desktop migrations (src/services/database.js:444-457)
  call_voi                     numeric(8,4),
  put_voi                      numeric(8,4),
  total_call_dollar_volume     numeric(18,2),
  total_put_dollar_volume      numeric(18,2),
  conviction_ratio             numeric(8,4),
  total_call_dollar_volume_all numeric(18,2),
  total_put_dollar_volume_all  numeric(18,2),
  conviction_ratio_all         numeric(8,4),
  avg_call_iv_all              numeric(6,4),
  avg_put_iv_all               numeric(6,4),
  unique(ticker, snapshot_date, expiration_date)
);
create index if not exists idx_options_snapshots_ticker_date on options_snapshots(ticker, snapshot_date);

-- Lazy KNN feature-vector cache keyed by snapshot
create table if not exists snapshot_options_features (
  ticker         text not null,
  snapshot_date  timestamptz not null,
  feature_vector double precision[],
  created_at     timestamptz default now(),
  unique(ticker, snapshot_date)
);
