# Adapta Screening — standalone Android app

A standalone Android build of the Adapta stock/options **screening** engine. It runs
the same analysis code as the desktop app (`../src/services/stockAnalysis.js` and
`optionsAnalysis.js`) on-device, and enriches a **shared Supabase database** that the
desktop app will also use (desktop migration is a later phase).

## How it works

- **Engine reuse (single source of truth).** The CommonJS engine in `../src/services`
  is imported directly and bundled by Vite. Its Node-only dependencies are aliased to
  browser stubs (`src/stubs/`): `duckdb` → empty, `./embeddings` → pure-JS
  `cosineSimilarity` only, and `yahoo-finance2` → a lightweight `.options()`
  implementation over Yahoo's v7 endpoint (the real package pulls in `@deno/shim-deno`,
  which can't run in a webview).
- **API keys** (Twelve Data / EODHD for prices) are read from
  `@capacitor/preferences` and mirrored into a `process.env` polyfill *before* the
  engine is imported, so the engine's `process.env.*` reads work unchanged
  (`src/adapters/config.ts`, `src/adapters/engine.ts`).
- **CORS** is handled by Capacitor's `CapacitorHttp` (enabled in
  `capacitor.config.ts`), which patches `fetch` to use native HTTP — so Yahoo /
  Twelve Data / EODHD calls work from the webview.
- **Database:** `src/adapters/supabaseDatabase.ts` implements the engine's DB
  interface against Supabase. Writes (price bars, events, options snapshots) enrich
  the shared DB on every run. Historical-aggregation reads (empirical / options-
  adjusted hold) currently degrade to "insufficient data" and are the next step —
  port the DuckDB SQL in `../src/services/database.js` to Postgres RPC functions.

## One-time setup

1. **Supabase project:** create one at supabase.com, then run
   `supabase/migrations/0001_init_schema.sql` in the SQL editor. Note the project
   URL and the `anon` public key.
2. **Market-data keys:** a [Twelve Data](https://twelvedata.com) key (prices) and
   optionally an [EODHD](https://eodhd.com) key (fallback).
3. **Android SDK:** install Android Studio (or the command-line SDK) and set
   `ANDROID_HOME`. Required only for building/running the APK.

## Develop

```bash
npm install
npm run dev          # Vite dev server (browser). NOTE: Yahoo/Twelve Data calls
                     # hit CORS in a plain browser — real fetches only work on-device
                     # where CapacitorHttp is active.
```

Enter your keys in the app's Settings panel (stored via Preferences). Then screen a
ticker to smoke-test the engine.

## Build & run the APK

```bash
npm run build        # Vite → dist/
npx cap sync android # copy web assets + plugins into the native project
npx cap run android  # build + install on a connected device/emulator
# or: npx cap open android  → build a signed APK/AAB from Android Studio
```

## Status / roadmap

- [x] Engine bundles and runs in a webview (Phase A)
- [x] Supabase schema + full adapter (writes, reads) + screening runner (Phase B)
- [x] Postgres RPCs for historical-aggregation enrichment reads (Phase B)
- [x] Screening UI: multi-ticker input, sortable results table, expandable
      per-ticker cards, Chart.js price charts with event markers (Phase C)
- [ ] Verify a live on-device run (needs keys + Supabase project)
- [ ] Signed APK on device (needs Android SDK + `ANDROID_HOME`)
- [ ] Migrate the desktop app onto Supabase (Phase D)
