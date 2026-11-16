# Options delta-shape clustering — assumptions

What the screening's options clustering (`src/main/optionsClusters.js`, wired in
`main.js`) assumes about the data and the market, as of 2026-11-13.

## Universe & freshness

1. **One list.** Clusters are defined only by tickers on the screening list
   (`config.screenTickers`). No ticker outside the list can shape a cluster,
   and there is no fallback to the wider DB universe.
2. **Exact freshness.** A ticker participates only if its latest options record
   is dated the same day as the newest record in the universe. Even one day
   older → excluded as stale (`excludedStale`). A screening run writes today's
   snapshot before clustering, so the reference date is today.
3. **Minimum size.** Clustering needs ≥6 eligible tickers, otherwise it is
   skipped for the day (reason logged). With the strict freshness rule,
   illiquid names or vendor gaps can trigger this.
4. **Minimum history.** A ticker needs ≥30 shape records (`minHistory`) so it
   has a baseline to be "unusual" against. New listings are excluded
   (`excludedShort`).

## What is compared

5. **Shape, not level.** Each ticker-day is a 52-dim vector: put/call IV smile
   and put/call dollar-volume share across 13 moneyness buckets (strike/spot
   distance, 0–30%+ OTM, pooled over exp1–exp3). Puts first — the far-OTM put
   wing is the primary coordinated-positioning signal.
6. **Delta vs own baseline.** Each dimension is compared against the ticker's
   own rolling median over the last 60 records (`baselineWindow`), so clusters
   group tickers making the same kind of move *for themselves*, not tickers
   that structurally look alike (biotech skew next to biotech skew).
7. **Accumulation, not average.** Daily deltas are **summed** over the last 3
   records (`smoothDays`) — the clustered shape is the accumulated unusual
   move over ~3 days, so sustained positioning keeps its full magnitude.
8. **Missing = no change.** A dimension with no quote/trade today or no
   baseline value (≥5 needed in the window) contributes 0, never "moved to
   zero".

## How tickers are grouped

9. **Cosine distance.** Standardized rows are L2-normalized, so k-means groups
   by the *shape* of the move; a +3 vol and +10 vol move of the same shape land
   together. Magnitude is reported separately as `move` (SD-norm).
10. **Fixed k.** k is fixed (5 default; scaled to ~1 cluster per 4 tickers,
    min 2, at the screening call site since the universe is now small).
    Silhouette only grades separation quality, it does not choose k. The report
    itself opens in a pre-cluster view (uncolored PC1/PC2 dots) and lets you
    re-cluster in-page for any k 2–8 — the report embeds `clusterCore.js` (the
    exact main-process math) plus the rounded shapes, so client-side results
    match the run's clustering for the same k. A manual k can be baked into
    future runs via the "Clusters k" field in the screening modal
    (`config.clusterK`, 2–8; anything else = auto).
11. **Determinism.** Seeded RNG (k-means++ init, Lloyd, 5 restarts) — the same
    input always yields the same clustering.

## Data-quality guards (assumptions about vendor data)

12. **IV scale quirk.** Live records store per-strike IV as percent×100 while
    derived records store percent; live records are detected and rescaled, and
    only when the strike median is implausibly far from the ATM anchor.
13. **Broken ATM anchor.** If a side's whole smile sits uniformly beyond ±50
    vol from its ATM anchor, the anchor is assumed bad and that side's IV dims
    are dropped for the day rather than producing a fake delta.
14. **Spot lookback.** An options record may precede its price candle by a day
    (live-path lag), so the spot resolver looks back up to 7 days
    (`maxAgeDays`). This is a *candle-matching* tolerance only — it plays no
    role in freshness (assumption 2).
15. **OTM-only.** Strike lists are assumed pre-filtered to the OTM side; a
    defensive <1.5% OTM guard drops near-the-money strays.
