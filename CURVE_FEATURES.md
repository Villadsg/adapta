# Curve-Shape Options Features — Design

Feature channels that represent the per-ticker, per-day options strike chart
(the Chart.js "IV + $Vol by strike" plot in `src/main/screeningHtml.js`):
dollar-volume bars per strike (calls up, puts down, 5-day aggregated on the
nearest expiry), per-strike IV lines for both sides, and the ATM / spread /
deep-OTM header stats.

## Why scalars, not curves or pixels

- **No pixels.** The chart is rendered by this app from `options_chain_history`
  raw rows (`expiration_date, side, strike, last_price, volume,
  underlying_price`) — pixel extraction would only recover a lossy version of
  numbers we already store exactly.
- **No raw curve either.** The chart's x-axis is strike (a cross-section), but
  TimesFM consumes time series with `past_only_covariates` channels. Each day's
  cross-section must be compressed to scalars before it can be a channel.
- **No raw per-bucket channels.** The 60-channel experiment fed per-bucket DV
  ranks directly and regressed test AUROC 0.718 vs 0.825 for 14 channels at
  ~16k samples (see `python/event_dataset.py` header). The lesson is not that
  the bucket information is useless — the per-bucket DV distribution was
  flagged as "the genuinely new signal" — but that 30 loose channels overfit.
  This design compresses the same distribution into 5-7 shape descriptors with
  strong priors: about the same parameter budget the 14-channel set spends on
  options today.

## Visual element → channel map

| What the eye sees in the chart | Channel (ranked) | Stage |
|---|---|---|
| Smile tilted to one wing (put wing richer) | `iv_slope_rank` | 1 |
| U-shaped smile vs one-sided smirk | `iv_curv_rank` | 1 |
| One giant bar dominating the chart | `dv_conc_rank` | 1 |
| Volume mass sitting on the call vs put side, near vs far | `dv_com_x_rank` | 1 |
| Far-tail bars lighting up (>10% OTM) | `wing_dv_share_rank` | 1 |
| Green vs red dominance in the far bars | `wing_pcr_rank` | 2 |
| Call-wing IV line pulling away from put-wing IV line | `iv_wing_gap_rank` | 2 |

## Source data

Everything is computed from the existing `options_daily_buckets` table
(`python/options_buckets.py`) — **no new backfill phase, no schema change**:

- 5 fixed OTM moneyness buckets per side, per expiration (exp1, exp2):
  calls K/S ∈ [1.015,1.03), [1.03,1.05), [1.05,1.075), [1.075,1.10), ≥1.10;
  puts mirrored. Bucket 5 is exactly the ">10% OTM" set used by the
  `deepOTM*` metrics in phase D.
- Per bucket: `dv` (total dollar volume) and `iv` (DV-weighted BSM IV in %,
  NULL when no tradable contract).
- `load_options_buckets()` in `python/event_dataset.py` already returns this
  as a wide frame with `{exp}_{side}_b{n}_{iv,dv}` columns.

Known gaps, accepted for v1: exp3 and the ATM band (0.985–1.015) are not in
the buckets table; both are cheap to add later (`[:2]` → `[:3]` in
`options_buckets.py`; an extra bucket id). Open-interest shape is out of
scope — `options_chain_history` has no OI, only volume/last.

## Construction

### 1. Representative log-moneyness per bucket

The buckets table has no per-strike moneyness, so each bucket gets a fixed
representative x = ln(K/S), symmetric across sides:

```
b1: ±ln(1.0225) ≈ ±0.0223     b2: ±ln(1.040)  ≈ ±0.0392
b3: ±ln(1.0625) ≈ ±0.0606     b4: ±ln(1.0875) ≈ ±0.0839
b5: ±ln(1.13)   ≈ ±0.1222     (open tail; nominal centre)
```

Puts take the negative values (K/S mirrored). Slope/curvature estimates are
insensitive to the exact b5 representative within ±0.02; verify once during
evaluation (see Edge cases).

### 2. IV curve fit (per expiration, then pooled)

For each expiration with ≥3 populated IV buckets, fit a DV-weighted least
squares quadratic over the bucket points (weight = bucket DV):

```
IV(x) = b0 + b1·x + b2·x² ,   x = representative log-moneyness
```

- `iv_slope` = b1 — negative = put wing richer (classic skew).
- `iv_curv` = b2 — positive = symmetric smile, ~0 = one-sided smirk.
- Quadratic (b2 defined) requires ≥4 points with ≥2 on each wing; otherwise
  fall back to a linear fit (b1 defined, b2 = NaN). A single wing with ≥3
  populated buckets still yields a wing-only slope (b1) — that is roughly the
  existing `call_iv_spread` in fit form; b2 stays NaN.
- Pool exp1/exp2 coefficients by DV-weighted mean (weights = each expiration's
  total DV; single-expiration days use that expiration alone), mirroring
  `_dv_weighted` in `event_dataset.py` — pool at the metric level, not the
  input level, so the exp1/exp2 term structures don't blend before the fit.

### 3. Volume distribution (rolling, then pooled)

The chart aggregates per-strike $Vol over the last 5 snapshots on the nearest
expiry because daily per-strike DV is sparse. The channel version uses a
3-trading-day rolling sum (`rolling(3, min_periods=1)`) of each bucket's DV
per (ticker, side, bucket) — summing exp1+exp2 — then shares
`s_b = dv_b / Σ dv` over the 10 (side, bucket) buckets:

- `dv_conc` = Σ s_b² — Herfindahl over the 10 shares. One dominant bar →
  near 1; activity spread across strikes → near 0.1.
- `dv_com_x` = Σ s_b · x_b — signed centre of mass of the bars. Negative =
  put-side mass, magnitude = how far out. Chosen over argmax (the literal
  "tallest bar") because it is continuous and robust; argmax jitters between
  adjacent strikes.
- `wing_dv_share` = s_call_b5 + s_put_b5 — fraction of DV beyond 10% OTM,
  matching the chart's far-tail bars and the `deepOTM*Pct` header stats.

### 4. Stage-2 additions

- `wing_pcr_rank`: `ln((call b4+b5 dv + ε) / (put b4+b5 dv + ε))` on the
  rolling DV, ε = 1% of total DV. One signed wing call/put-tilt channel —
  deliberately NOT a put/call pair, since the mirrored-pair pattern regressed
  AUROC before.
- `iv_wing_gap_rank`: (pooled call b4+b5 IV) − (pooled put b4+b5 IV).

## Channel set

```
CURVE_CHANNELS = [
    "iv_slope_rank", "iv_curv_rank",        # stage 1 — IV curve shape
    "dv_conc_rank", "dv_com_x_rank",        # stage 1 — volume shape
    "wing_dv_share_rank",                   # stage 1 — tail activity
    # stage 2: "wing_pcr_rank", "iv_wing_gap_rank",
]
```

All channels are within-ticker percentile-ranked and centred on 0 (−50 of the
0-100 rank), exactly like the existing options channels in
`build_options_features` — raw scales (IV %, $ DV, HHI units) never reach the
model, so no additional normalization is needed. No delta or weekly-aggregate
variants in v1; add `_delta`/`_w*` later only if the levels carry signal.

### Integration into `python/event_dataset.py`

1. `build_curve_features(buckets_df)` — implements construction 2-3 above,
   returns `[ticker, date] + CURVE_CHANNELS` with NaNs preserved.
2. Call it from `build_options_features` (it already receives `buckets_df`),
   and append `CURVE_CHANNELS` to the columns returned there.
3. In `build_ticker_features`, add `CURVE_CHANNELS` to the forward-fill
   (limit 5) / zero-fill loop alongside `ALL_OPTION_CHANNELS +
   FULL2_EXTRA_CHANNELS`. `options_missing` needs no change — curve features
   come from the same snapshots and inherit the same missingness.
4. Dataset variants: `FULL2_CHANNELS + CURVE_CHANNELS` ("full2+curve") and a
   stage-2 variant with the extra two. Build via the existing lab pipeline
   into `data/events-full2_curve/` etc.; add the matching `--channels` choice
   in `timesfm_event_backtest_multi.py`.
5. Direction model: append to `DIRECTION_CHANNELS` — `dv_com_x`, `wing_pcr`,
   `iv_wing_gap` are naturally signed and are the ones expected to matter
   most for direction.

## Evaluation plan

Run `timesfm_event_backtest_multi.py` on identical splits:

| Variant | Channels | Purpose |
|---|---|---|
| full2 (baseline) | 28 | reference AUROC |
| full2+3 | + slope, curv, conc | minimal stage-1 test |
| full2+5 | + com_x, wing_share | full stage 1 |
| options_only+curve | 21-ish + 5 | diagnostic: does shape alone carry signal? |

Acceptance: keep stage 1 only if test AUROC improves ≥ +0.005 over full2
without widening the train→test gap by more than ~0.03 (the overfit failure
mode from the 60-channel run). Stage 2 is evaluated only on top of whichever
stage-1 variant survived. No per-channel tuning against the test set.

## Edge cases

- **No snapshot / no traded contracts** (`Σ dv = 0`): volume features NaN →
  existing forward-fill handles it; `options_missing` flags the day.
- **Sparse IV** (fewer buckets than the fit requires): degrade quadratic →
  linear → wing-only slope → NaN, in that order. Never fabricate points.
- **Fit weighting**: DV weights let liquid buckets dominate, which biases the
  fit toward exactly the volume spikes `dv_conc` describes. If evaluation is
  marginal, re-run with √DV weights as a robustness check before concluding
  the signal is absent.
- **b5 representative sensitivity**: repeat the winning run with the b5
  representative at ±0.02; slope/curv ranks should be near-identical (ranks
  absorb monotone shifts).
- **Term structure**: per-expiration fits pooled at the coefficient level
  (see construction 2). If both expirations rarely qualify on the same day,
  the DV-weighted pool degenerates gracefully to single-exp values.

## Out of scope / future

- ATM-band and exp3 buckets (schema additions to `options_daily_buckets`).
- OI-based shape (needs open interest in the backfill).
- Full-curve representation via a fixed moneyness grid + PCA components — the
  principled "whole curve" alternative, but another overfit risk at 16k
  samples; revisit when the history is deeper.
- Pixel-derived anything.
