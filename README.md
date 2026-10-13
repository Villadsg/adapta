# Adapta

An Electron-based financial analysis browser combining semantic search, ticker screening, and options analysis. Built to identify contrarian opportunities by spotting disagreement between implied volatility and dollar volume positioning.

## Quick Start

```bash
npm install
npm start
```

## Core Features

### Ticker Screening

Screens a universe of ~200 mid-cap tickers ($6B-$50B) to detect significant recent price events. The top 50 tickers are auto-selected via fundamental ranking ("Revise the 50"), then screened for volume/gap anomalies.

Results display in an interactive table with expandable rows showing price charts, options strike charts, company summaries, and news headlines.

### Options Analysis

Per-ticker options surface visualization for the nearest two expirations, showing dollar volume, dollar open interest, and IV smile on a per-strike basis. A third expiration is fetched and stored in history for term-structure backtesting but not displayed. Designed to reveal where money is flowing relative to how the market is pricing risk.

### Implied Thesis

Optional per-run layer (checkbox in the screening modal) in which the local LLM (Qwen 3.5 via llama.cpp — the same runtime as the Model Lab insights) derives what the cluster of out-of-the-money call buyers appears to be betting on, in **one combined pass**:

| Stage | Detail |
|-------|--------|
| **Candidate selection** | Ranks tickers by OTM-call tilt — deep-OTM dollar share (%) + OTM-over-ATM call IV premium (pts) — requiring ≥ $250K nearest-expiration call dollar volume; top 8 kept |
| **Relative metrics** | Price: today's move in σ of the ticker's own last ~100 daily returns, plus its volume-gap percentile · IV: weighted OTM put IV vs OTM call IV, each side's OTM-over-ATM spread and that spread's percentile within the ticker's own IV history (≥3 records; level ranks ≥10) · Dollar volume: OTM call $ vs OTM put $ (plain-OTM split) + deep-OTM share of call $ |
| **Combined generation** | One prompt carries all candidates (business profile from Yahoo + the relative metrics) and must produce ONE collective thesis: the future outcome or shared theme that best explains the call-tilted positioning, plus what would invalidate it — or states plainly that no common outcome is plausible |
| **Grounding** | Company facts come only from the provided profiles; anything beyond them is marked "likely"/"plausibly"; numbers come only from the run. Output is hypotheses to judge, not facts |

When "Fetch news" is checked, up to 5 Finviz headlines per candidate ride along labeled as context hints only. Rendered as the "Implied Thesis" panel in the screening report (`src/services/impliedThesis.js`).

### Semantic Search

Save and search articles by meaning using **google/embeddinggemma-300m** (768-dimensional vectors). Cosine similarity scoring with category filtering.

---

## Financial Measures

### Event Detection (Screening)

| Measure | Formula | Purpose |
|---------|---------|---------|
| **Gap %** | `abs((open - prevClose) / prevClose) * 100` | Price movement magnitude at open |
| **Volume-Gap Product** | `volume * gapPct` | Combined signal — large gap on high volume = significant event |
| **Percentile Rank** | Rank of volume-gap product in historical distribution | Filters noise; default threshold at p95 |
| **Residual Gap** | `abs(stockReturn - (beta * marketReturn + alpha)) * 100` | Market-adjusted gap — strips out SPY-correlated moves |
| **R-squared (SPY)** | `1 - (SS_residual / SS_total)` from OLS regression | How much of the stock's movement is explained by the market |

### Event Classification

Events are classified by gap direction and intraday reversal:

| Classification | Logic |
|----------------|-------|
| **Surprising Positive** | Gapped down but closed above previous close |
| **Positive Anticipated** | Gapped up and held gains |
| **Negative Anticipated** | Gapped down and stayed down |
| **Surprising Negative** | Gapped up but closed below previous close |

### Fundamental Ranking ("Revise the 50")

Used to select the best 50 tickers from the ~200 universe:

| Measure | Source | Purpose |
|---------|--------|---------|
| **Revenue Growth (YoY)** | Yahoo Finance `financialData.revenueGrowth` | Growth rate — higher is better |
| **Debt-to-Equity** | Yahoo Finance `financialData.debtToEquity` | Leverage — lower is better |
| **Leverage Factor** | `1 / (1 + D/E / 100)` | Penalizes high leverage (0 to 1 scale) |
| **Revision Score** | `revenueGrowth * leverageFactor` | Final ranking metric |
| **Average Volume** | Yahoo Finance `summaryDetail.averageVolume` | Liquidity gate — minimum 500K daily |
| **Market Cap** | Yahoo Finance `summaryDetail.marketCap` | Displayed in screening table |

### Options Metrics (Per-Ticker)

#### Strike-Level Data (Nearest 2 Expirations)

| Measure | Formula | Purpose |
|---------|---------|---------|
| **Dollar Volume** | `contractVolume * lastPrice * 100` | Capital flow at each strike — where money is trading today |
| **Dollar Open Interest** | `openInterest * lastPrice * 100` | Accumulated positioning — where money has been sitting |
| **Implied Volatility** | Yahoo Finance `impliedVolatility` (annualized) | Market's expected move priced into each strike |
| **Dollar-Volume-Weighted IV** | `sum(IV * dollarVol) / sum(dollarVol)` | What IV level money is actually trading at (not simple average) |
| **IV Spread (OTM vs ATM)** | `weightedIV - atmIV` | Measures how much more (or less) OTM flow is paying vs at-the-money — positive = OTM premium |
| **IV Rank** | Percentile of current weighted IV within ticker's own history (≥10 records) | Context for how extreme today's IV is relative to that ticker's norms |
| **IV Spread Rank** | Percentile of current OTM-vs-ATM spread within ticker's own history | Context for how extreme today's skew is — a spread at p90 means the OTM premium is near historical highs |

The key insight: when dollar volume spikes at strikes where IV is low (or vice versa), it signals disagreement — potentially a contrarian opportunity.

#### Aggregate Options Ratios

| Measure | Formula | Purpose |
|---------|---------|---------|
| **Put-Call Ratio (Volume)** | `totalPutVol / totalCallVol` | Sentiment — <0.7 bullish, >1.0 bearish |
| **Put-Call Ratio (OI)** | `totalPutOI / totalCallOI` | Longer-term positioning sentiment |
| **Conviction Ratio** | `totalCallDollarVol / totalPutDollarVol` | Capital-weighted sentiment — >2.0 call-heavy |

#### Volatility Surface

| Measure | Formula | Purpose |
|---------|---------|---------|
| **ATM IV** | IV at strike nearest current price | Baseline implied volatility |
| **IV Smile/Skew** | Per-strike IV curve across strikes | Reveals tail risk pricing asymmetry |
| **Term Structure** | ATM IV across expirations | Contango = no near-term catalyst; backwardation = event expected |
| **Term Structure Slope** | `(farIV - nearIV) / dteDiff * 30` | Rate of IV change per 30 days |

#### Event Anticipation Index (0-100)

Composite score from five components:

| Component | Weight | What It Measures |
|-----------|--------|-----------------|
| **Volatility Risk Premium** | 0-25 | IV / HV ratio — how much extra the market charges |
| **Implied Move (Straddle)** | 0-25 | Straddle price vs HV-implied move — event premium |
| **Term Structure** | 0-20 | Shape and kinks — catalyst timing signal |
| **Volume Conviction** | 0-15 | Unusual volume, dollar concentration, VOI ratio |
| **Historical Vol Conviction** | 0-15 | 24h trend in dollar volumes — building or fading |

### Historical Volatility

| Measure | Formula | Purpose |
|---------|---------|---------|
| **Annualized HV** | `stdev(dailyReturns) * sqrt(252)` | Realized volatility baseline |
| **Normal Move %** | `HV * sqrt(DTE / 252) * 100` | Expected move based on historical vol |
| **Straddle Move %** | `(atmCallPrice + atmPutPrice) / price * 100` | Market-priced expected move |
| **Event Premium %** | `straddleMove% - normalMove%` | Excess premium over what HV implies |

### Pre-Event IV Profile (Backtest Panel)

Displayed at the top of screening results. For each of the four event classifications, shows the **average point-in-time percentile rank** of Call IV, Put IV, Call Spread, and Put Spread across all logged events.

| Aspect | Detail |
|--------|--------|
| **What it answers** | "Does the IV market forecast surprise direction?" |
| **Pre-event snapshot** | Latest weighted-iv-history record strictly before the event date for that ticker |
| **Rank computation** | Percentile of snapshot within that ticker's own history up to (but not including) the event date — no lookahead |
| **Aggregation** | Mean of ranks across all qualifying events per classification |
| **Null hypothesis** | Average rank = 50 (neutral). Deviations signal the market was pricing in directional risk |
| **Minimum history** | 10 records required per ticker at event time; fewer → event excluded |

### Event Log

Each screening run appends classified events to `ci/event-log.json`, building a time-series dataset for backtesting. Each record stores ticker, event date, run date, classification, gap, percentile, volume, R², and an IV snapshot (weighted Call/Put IV, ATM Call/Put IV). Records are keyed on `{ticker, eventDate}` — re-encounters update in place.

---

## Project Structure

```
adapta/
├── main.js                          # Electron main process, IPC handlers, HTML generation
├── preload.js                       # IPC security bridge
├── ci/
│   ├── ticker-screen.js             # Screening logic, UNIVERSE list, revision ranking
│   ├── daily-event-scan.js          # GitHub Actions daily scan with Telegram alerts
│   ├── backfill-marketdata.js       # MarketData.app backfill phases A–D; --maintenance for cron
│   ├── options-coverage.js          # Classifies tickers: covered / stale / pending / confirmed options-less
│   ├── options-coverage.json        # Coverage report (generated; skip list for phase C)
│   ├── config.json                  # Screening config (tickers, thresholds)
│   ├── screening-results.html       # Latest screening output (generated)
│   ├── screening-favorites.json     # Starred tickers (generated)
│   └── event-log.json               # Classified event time-series for backtesting (generated)
├── src/
│   ├── renderer/
│   │   ├── index.html               # Main UI with screening modal
│   │   ├── styles.css               # Styling
│   │   └── renderer.js              # UI logic, tab management
│   └── services/
│       ├── optionsAnalysis.js        # Options metrics, IV analysis, event anticipation
│       ├── stockAnalysis.js          # Price data, regression, fundamentals, HV
│       ├── impliedThesis.js          # Implied Thesis: OTM call flow → LLM-derived hypotheses
│       ├── optionsBackfill.js        # In-app options chain backfill (phases C+D)
│       ├── database.js              # DuckDB operations
│       └── newsScraper.js           # Finviz headline scraping (optional)
```

## Data Sources

- **Yahoo Finance** (`yahoo-finance2`): Price history, options chains, fundamentals, company profiles
- **Finviz** (Chromium scraping, optional): News headlines per ticker

## License

MIT
