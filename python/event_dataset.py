"""Shared feature/dataset-building code for the event and direction models.

Extracted from the former ttm_event_dataset.py when the TTM-R3 fine-tuning
pipeline was removed; the TimesFM 3.0 scripts and the adapta package build
their feature channels here.

Channel 0 of a channel set is the model's target series; the rest are passed
to TimesFM as past_only_covariates.

Options history lives in DuckDB (options_daily_iv), derived from raw
marketdata.app chains by ci/backfill-marketdata.js phase D, with per-moneyness
buckets from options_daily_buckets (python/options_buckets.py).
"""

import duckdb
import numpy as np
import pandas as pd



# Options history lives in DuckDB (options_daily_iv), derived from raw
# marketdata.app chains by ci/backfill-marketdata.js phase D. The DB carries
# three expirations (exp1/exp2/exp3, exp3 added by schema migration 15).
OPTIONS_EXPIRATIONS = ("exp1", "exp2", "exp3")

# Fixed OTM moneyness buckets, derived per (ticker, date, expiration, side) by
# options_buckets.py into the options_daily_buckets table.
BUCKET_IDS = (1, 2, 3, 4, 5)
# Slimmed to dollar-volume ranks only: a 60-channel run including the bucket IV
# ranks overfit and regressed (test AUROC 0.718 vs the 14-channel 0.825). The
# per-bucket DV distribution is the genuinely new signal; bucket IV largely
# duplicates the aggregate spread/ATM channels. The IV half stays available in
# options_daily_buckets if we want to retry it with stronger regularization.
BUCKET_CHANNELS = [
    f"{exp}_{side}_b{b}_dv_rank"
    for exp in OPTIONS_EXPIRATIONS
    for side in ("call", "put")
    for b in BUCKET_IDS
]

# Per-bucket put/call relativities, both computable from options_daily_buckets:
#   put_call_dv_ratio — put DV vs call DV at the SAME moneyness (the red-vs-green
#     bar balance in the strike chart)
#   pc_iv_skew        — put IV minus call IV at the same bucket (smile asymmetry)
SKEW_CHANNELS = [
    f"b{b}_{stat}_rank"
    for b in BUCKET_IDS
    for stat in ("put_call_dv_ratio", "pc_iv_skew")
]

# Strike-level structure from options_chain_history (the bars of the strike
# chart, below bucket resolution):
#   strike_conc_rank    — share of the day's option DV in the single largest
#                         contract ("whale" bars like a single huge strike)
#   eff_strikes_rank    — DV-entropy "effective number of active strikes"
#   call_centroid_rank  — DV-weighted mean OTM distance of calls (where the
#                         green/red action sits relative to spot)
#   put_centroid_rank
STRIKE_CHANNELS = [
    "strike_conc_rank",
    "eff_strikes_rank",
    "call_centroid_rank",
    "put_centroid_rank",
]

# Weekly (5-trading-day) aggregates of the percentile-ranked options metrics.
# Computed in build_options_features on the centred ranks.
WEEKLY_OPTION_CHANNELS = [
    "total_option_dv_log_rank_wmax",   # 5d max of the total option DV rank
    "total_option_dv_log_rank_wmean",  # 5d mean of the total option DV rank
    "atm_call_iv_rank_wmax",           # 5d max of the ATM call IV rank
    "atm_put_iv_rank_wmax",            # 5d max of the ATM put IV rank
    "call_iv_spread_rank_wslope",      # 5d change in the call IV spread rank
    "put_iv_spread_rank_wslope",       # 5d change in the put IV spread rank
    "dv_x_iv_wmean",                   # 5d mean of min(DV rank, ATM call IV rank)
]

# Extra channels beyond the core options block: the third expiration's DTE,
# the weekly aggregates, and the strike-structure channels (bucket skew +
# per-contract stats).
FULL2_EXTRA_CHANNELS = (
    ["exp3_dte_log"] + WEEKLY_OPTION_CHANNELS + SKEW_CHANNELS + STRIKE_CHANNELS
)

# Plot-faithful channel set: the event-magnitude target plus options-derived
# channels only. The old price/volume covariates (log_close, log_volume,
# return, gap, range, volatility) were removed — nothing in the strike chart
# maps to them, and the options block carries the predictive signal. The price
# columns are still computed by build_ticker_features; they are just no longer
# fed to the models.
CHANNELS = [
    "log_event_magnitude",    # log(volume * |return| + 1) — the target
    # Options channels. All IV inputs are dollar-volume-weighted (see
    # build_options_features); levels are within-ticker percentile ranks so
    # cross-ticker IV scale differences do not leak into the model.
    "call_iv_spread_rank",       # pct-rank of (weighted OTM call IV - ATM call IV)
    "call_iv_spread_delta",      # day-over-day change in the OTM call IV spread rank
    "atm_call_iv_rank",          # pct-rank of weighted ATM call IV
    "atm_call_iv_delta",         # day-over-day change in the ATM call IV rank
    "total_option_dv_log_rank",  # pct-rank of log(total option dollar volume + 1)
    "put_call_dv_ratio_rank",    # pct-rank of put/call dollar volume ratio
    # Days until each referenced expiration, log1p-scaled and centred on
    # log1p(30) so the missing-value fill of 0.0 reads as a typical ~30d
    # expiry rather than "expires today".
    "exp1_dte_log",
    "exp2_dte_log",
    # Put mirrors, exp3 DTE, weekly aggregates, and strike-structure channels.
    *FULL2_EXTRA_CHANNELS,
    "options_missing",           # 1 if no options snapshot for this date
]

# Options-derived channels, in CHANNELS order. Used to merge, forward-fill and
# zero-fill the options block consistently in build_ticker_features.
OPTION_CHANNELS = [
    "call_iv_spread_rank",
    "call_iv_spread_delta",
    "atm_call_iv_rank",
    "atm_call_iv_delta",
    "total_option_dv_log_rank",
    "put_call_dv_ratio_rank",
    "exp1_dte_log",
    "exp2_dte_log",
]

# Put-side mirrors of the call spread/ATM channels. Not part of the event
# model's channel set (they regressed its test AUROC: 0.758 vs ~0.80), but
# computed by build_options_features and used by the direction model, where
# put/call asymmetry is the more natural signal.
PUT_OPTION_CHANNELS = [
    "put_iv_spread_rank",
    "put_iv_spread_delta",
    "atm_put_iv_rank",
    "atm_put_iv_delta",
]
ALL_OPTION_CHANNELS = OPTION_CHANNELS[:4] + PUT_OPTION_CHANNELS + OPTION_CHANNELS[4:]

# Legacy aliases. Since the price/volume channels were pruned, every event
# set is the same plot-faithful list; the distinct names are kept so old
# scripts and lab presets keep resolving.
FULL_CHANNELS = list(CHANNELS)
FULL2_CHANNELS = list(CHANNELS)
OPTIONS_ONLY_CHANNELS = list(CHANNELS)

# Direction-model channel set: log_close as the forecast target series
# (channel 0) plus the same options-derived covariates.
DIRECTION_CHANNELS = [
    "log_close",
    *ALL_OPTION_CHANNELS,
    *FULL2_EXTRA_CHANNELS,
    "options_missing",
]
N_CHANNELS = len(CHANNELS)

# Legacy price/volume covariates. Pruned from the production sets (nothing in
# the strike chart maps to them) but still computed by build_ticker_features
# and kept as a named list so the Model Lab can compare the pruned set
# head-to-head against the pre-prune setup on identical samples.
PRICE_CHANNELS = ["log_close", "log_volume", "return", "gap", "range", "volatility"]

# The pre-prune "full2" event set (target + price/volume covariates + the
# options block). Lab-only; not used by the production forecast scripts.
FULL2_LEGACY_CHANNELS = [
    "log_event_magnitude",
    *PRICE_CHANNELS,
    *ALL_OPTION_CHANNELS,
    *FULL2_EXTRA_CHANNELS,
    "options_missing",
]

# Target definition
EVENT_QUANTILE = 0.92  # a ticker's own top 8% of days are "events" — relative, not global
CONTEXT_LENGTH = 36    # divisible by TTM-R3 patch_length = 9
MIN_THRESHOLD_DAYS = 60  # trading days of history needed before a per-ticker threshold is trusted


def per_ticker_threshold(magnitudes, quantile=EVENT_QUANTILE, min_days=MIN_THRESHOLD_DAYS):
    """Event threshold from a ticker's OWN history: the `quantile` percentile
    of its event magnitudes, so ~top (1 - quantile) of its trading days count
    as event days regardless of the ticker's absolute volume/price scale.
    Returns None when there is too little history to trust the quantile."""
    vals = np.asarray(magnitudes, dtype=float)
    vals = vals[np.isfinite(vals) & (vals > 0)]
    if len(vals) < min_days:
        return None
    return float(np.quantile(vals, quantile))


def _pos(value):
    """Return value as a float when it is a usable positive number, else None."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _otm_call_iv(e):
    return _pos(e.get("callIV"))


def _otm_put_iv(e):
    return _pos(e.get("putIV"))


def _atm_iv(e, band_key, strike_key):
    """Prefer the band-definition ATM IV; fall back to the single-strike ATM.

    Mirrors main.js exactly: the band value is used only when present and
    positive, otherwise the single-strike value is used whenever it is present
    at all -- including when it is 0, which main.js keeps rather than skips.
    """
    band = _pos(e.get(band_key))
    if band is not None:
        return band
    strike = e.get(strike_key)
    if strike is None:
        return None
    try:
        return float(strike)
    except (TypeError, ValueError):
        return None


def _atm_call_iv(e):
    return _atm_iv(e, "atmBandCallIV", "atmCallIV")


def _atm_put_iv(e):
    return _atm_iv(e, "atmBandPutIV", "atmPutIV")


def _fallback_dv(e):
    """Combined call+put DV carried by older (pre-flip) history records."""
    return float(e.get("dv") or 0.0)


def _call_weight(e):
    return float(e["callDV"]) if e.get("callDV") is not None else _fallback_dv(e)


def _put_weight(e):
    return float(e["putDV"]) if e.get("putDV") is not None else _fallback_dv(e)


def _atm_call_weight(e):
    return float(e["atmCallDV"]) if e.get("atmCallDV") is not None else _fallback_dv(e)


def _atm_put_weight(e):
    return float(e["atmPutDV"]) if e.get("atmPutDV") is not None else _fallback_dv(e)


def _dv_weighted(exp1, exp2, exp3, value_fn, weight_fn):
    """Dollar-volume-weighted mean of a quantity across the three expirations.

    Mirrors poolWeighted() in main.js: expirations lacking a usable value are
    skipped, and when no expiration carries a positive weight we fall back to an
    equal-weighted mean so pre-flip records (which have no DV) still contribute.
    """
    pairs = []
    for e in (exp1, exp2, exp3):
        if not e:
            continue
        # Match main.js: skip expirations with no usable IV on either side.
        if _otm_call_iv(e) is None and _otm_put_iv(e) is None:
            continue
        v = value_fn(e)
        if v is None:
            continue
        w = weight_fn(e)
        pairs.append((v, w if w > 0 else 0.0))

    if not pairs:
        return None
    total_w = sum(w for _, w in pairs)
    if total_w > 0:
        return sum(v * w for v, w in pairs) / total_w
    return sum(v for v, _ in pairs) / len(pairs)


def _expiration_dict(row: pd.Series, prefix: str) -> dict:
    """Reshape one exp{N}_* column group into the dict the pooling helpers expect.

    The helpers (_otm_call_iv, _call_weight, ...) were written against the JSON
    record shape and are shared with the weighting logic in main.js. Rather than
    duplicate that logic for the DB layout, map the columns back onto the same
    keys. options_daily_iv carries no ATM band or deep-OTM columns, so the band
    keys stay absent and _atm_iv falls through to the single-strike value.
    """
    def _num(col):
        v = row.get(f"{prefix}_{col}")
        return None if pd.isna(v) else float(v)

    call_dv = _num("call_dv") or 0.0
    put_dv = _num("put_dv") or 0.0

    return {
        "callIV": _num("call_iv"),
        "putIV": _num("put_iv"),
        "atmCallIV": _num("atm_call_iv"),
        "atmPutIV": _num("atm_put_iv"),
        "callDV": call_dv,
        "putDV": put_dv,
        # ATM dollar volume is not broken out in the DB; reuse the side DV so
        # ATM pooling weights match the OTM weighting instead of falling back to
        # an unweighted mean.
        "atmCallDV": call_dv,
        "atmPutDV": put_dv,
        "dv": call_dv + put_dv,
    }


def load_options_history(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Load daily consolidated options metrics from DuckDB (options_daily_iv).

    Returns a DataFrame indexed by (ticker, date) with one row per calendar day.
    Rows are already unique per (ticker, date) in the DB; we defensively keep the
    last one anyway.
    """
    try:
        raw = con.execute(
            "SELECT * FROM options_daily_iv ORDER BY ticker, date"
        ).fetch_df()
    except duckdb.CatalogException:
        return pd.DataFrame()

    if raw.empty:
        return pd.DataFrame()

    rows = []
    for _, r in raw.iterrows():
        exps = [_expiration_dict(r, p) for p in OPTIONS_EXPIRATIONS]

        total_dv = sum(e["dv"] for e in exps)
        call_dv = sum(e["callDV"] for e in exps)
        put_dv = sum(e["putDV"] for e in exps)

        # Pool the expirations with dollar-volume weights, mirroring
        # combineHistRecord() in main.js so the model sees the same weighted
        # IV the rest of the app reports.
        exp1, exp2, exp3 = exps
        call_iv = _dv_weighted(exp1, exp2, exp3, _otm_call_iv, _call_weight)
        put_iv = _dv_weighted(exp1, exp2, exp3, _otm_put_iv, _put_weight)
        atm_call_iv = _dv_weighted(exp1, exp2, exp3, _atm_call_iv, _atm_call_weight)
        atm_put_iv = _dv_weighted(exp1, exp2, exp3, _atm_put_iv, _atm_put_weight)

        # Days until each referenced expiration (log-scaled). The expN
        # labels alone hide whether "exp1" is 3 or 40 days out.
        day = pd.to_datetime(r["date"]).date()
        dtes = []
        for p in OPTIONS_EXPIRATIONS:
            label = r.get(f"{p}_label")
            if label is None or (isinstance(label, float) and pd.isna(label)) or pd.isna(label):
                dtes.append(np.nan)
                continue
            exp_day = pd.to_datetime(str(label).split(" ")[0]).date()
            dtes.append(float(np.log1p(max((exp_day - day).days, 0))))

        rows.append({
            "ticker": r["ticker"],
            "date": day,
            "call_iv": call_iv,
            "atm_call_iv": atm_call_iv,
            "put_iv": put_iv,
            "atm_put_iv": atm_put_iv,
            "total_option_dv": total_dv,
            "call_dv": call_dv,
            "put_dv": put_dv,
            "exp1_dte_log": dtes[0],
            "exp2_dte_log": dtes[1],
            "exp3_dte_log": dtes[2],
            # Not available in options_daily_iv; kept for column compatibility.
            "deep_otm_call_pct": None,
            "deep_otm_put_pct": None,
        })

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df = df.sort_values(["ticker", "date"]).drop_duplicates(subset=["ticker", "date"], keep="last")
    return df


def _pct_rank(series: pd.Series) -> pd.Series:
    """Percentile rank of each value within the series (0-100), ignoring NaNs."""
    valid = series.dropna()
    if len(valid) < 2:
        return pd.Series(np.nan, index=series.index)
    ranks = valid.rank(method="average", pct=True) * 100
    return ranks.reindex(series.index)


def load_options_buckets(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Load per-moneyness-bucket options metrics from DuckDB (options_daily_buckets).

    Returns a wide DataFrame with one row per (ticker, date) and columns
    {exp}_{side}_b{bucket}_{iv,dv} holding the raw DV-weighted BSM IV (%) and
    dollar volume per bucket. Empty DataFrame when the table is missing.
    """
    try:
        raw = con.execute(
            "SELECT * FROM options_daily_buckets ORDER BY ticker, date"
        ).fetch_df()
    except duckdb.CatalogException:
        return pd.DataFrame()

    if raw.empty:
        return pd.DataFrame()

    raw["col"] = (
        raw["exp"] + "_" + raw["side"] + "_b" + raw["bucket"].astype(str)
    )
    iv = raw.pivot_table(
        index=["ticker", "date"], columns="col", values="iv", aggfunc="last"
    ).add_suffix("_iv")
    dv = raw.pivot_table(
        index=["ticker", "date"], columns="col", values="dv", aggfunc="last"
    ).add_suffix("_dv")
    wide = iv.join(dv).reset_index()
    wide["date"] = pd.to_datetime(wide["date"]).dt.date
    return wide


def load_options_strike_stats(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Load per-day strike-level stats from DuckDB (options_daily_strike_stats).

    One row per (ticker, date) with the raw columns top_dv_share, eff_strikes,
    call_centroid_m, put_centroid_m computed by python/options_buckets.py from
    the raw contracts in options_chain_history. Empty DataFrame when the table
    is missing (strike stats not yet backfilled).
    """
    try:
        wide = con.execute(
            "SELECT * FROM options_daily_strike_stats ORDER BY ticker, date"
        ).fetch_df()
    except duckdb.CatalogException:
        return pd.DataFrame()
    if wide.empty:
        return pd.DataFrame()
    wide["date"] = pd.to_datetime(wide["date"]).dt.date
    return wide


def build_options_features(
    opts_df: pd.DataFrame, buckets_df: pd.DataFrame = None,
    strike_stats_df: pd.DataFrame = None,
) -> pd.DataFrame:
    """Compute percentile-ranked options features and their day-over-day deltas.

    Raw IV levels and dollar volumes vary enormously across tickers and regimes.
    Converting each metric to a within-ticker percentile rank removes cross-ticker
    scale differences and makes the features directly comparable.
    """
    if opts_df.empty:
        return opts_df

    df = opts_df.copy().sort_values(["ticker", "date"])
    df["call_iv_spread"] = df["call_iv"] - df["atm_call_iv"]
    df["put_iv_spread"] = df["put_iv"] - df["atm_put_iv"]
    df["total_option_dv_log"] = np.log1p(df["total_option_dv"].fillna(0))
    df["put_call_dv_ratio"] = np.where(
        df["call_dv"] > 0,
        df["put_dv"] / df["call_dv"],
        np.nan,
    )

    # Convert to within-ticker percentile ranks.
    rank_cols = ["call_iv_spread", "put_iv_spread", "atm_call_iv", "atm_put_iv",
                 "total_option_dv_log", "put_call_dv_ratio"]
    for col in rank_cols:
        df[f"{col}_rank"] = df.groupby("ticker")[col].transform(_pct_rank)

    # Day-over-day deltas of the percentile ranks (these are the "delta" features).
    df["call_iv_spread_delta"] = df.groupby("ticker")["call_iv_spread_rank"].diff()
    df["atm_call_iv_delta"] = df.groupby("ticker")["atm_call_iv_rank"].diff()
    df["put_iv_spread_delta"] = df.groupby("ticker")["put_iv_spread_rank"].diff()
    df["atm_put_iv_delta"] = df.groupby("ticker")["atm_put_iv_rank"].diff()

    # Centre log-DTE on log1p(30) (~30 days, a typical exp1/exp2/exp3 distance) so
    # the 0.0 missing-value fill reads as "typical expiry", not "expires today".
    for col in ("exp1_dte_log", "exp2_dte_log", "exp3_dte_log"):
        if col not in df.columns:
            df[col] = np.nan
        df[col] = df[col] - np.log1p(30.0)

    # Per-moneyness-bucket ranks. Raw values are DV-weighted BSM IV (%) and
    # dollar volume per bucket; both are pct-ranked within the ticker like the
    # aggregate channels above (dv is log-transformed first).
    if buckets_df is not None and not buckets_df.empty:
        df = df.merge(buckets_df, on=["ticker", "date"], how="left")
        for ch in BUCKET_CHANNELS:
            raw_col = ch[: -len("_rank")]
            if raw_col not in df.columns:
                df[ch] = np.nan
                continue
            if raw_col.endswith("_dv"):
                df[raw_col] = np.log1p(df[raw_col].fillna(0))
            df[ch] = df.groupby("ticker")[raw_col].transform(_pct_rank)

        # Put/call relativities at matched moneyness, pooled over exp1+exp2
        # (the bucket table covers the two nearest expirations). The DV ratio
        # is the red-vs-green bar balance at one moneyness slice; the IV skew
        # is put IV minus call IV there.
        for b in BUCKET_IDS:
            def _col(name):
                return df[name] if name in df.columns else pd.Series(np.nan, index=df.index)
            call_dv = sum(_col(f"exp{e}_call_b{b}_dv") for e in (1, 2))
            put_dv = sum(_col(f"exp{e}_put_b{b}_dv") for e in (1, 2))
            call_iv = pd.concat([_col(f"exp{e}_call_b{b}_iv") for e in (1, 2)], axis=1).mean(axis=1)
            put_iv = pd.concat([_col(f"exp{e}_put_b{b}_iv") for e in (1, 2)], axis=1).mean(axis=1)
            df[f"b{b}_put_call_dv_ratio"] = np.where(call_dv > 0, put_dv / call_dv, np.nan)
            df[f"b{b}_pc_iv_skew"] = put_iv - call_iv
            # exp1/exp2 bucket columns are absent when the bucket table is
            # missing entirely; normalise to NaN so the rank below is NaN too.
            for raw in (f"b{b}_put_call_dv_ratio", f"b{b}_pc_iv_skew"):
                df[raw] = df[raw].replace([np.inf, -np.inf], np.nan)
                df[f"{raw}_rank"] = df.groupby("ticker")[raw].transform(_pct_rank)

    # Strike-level structure from the raw chains (whale concentration,
    # effective strike count, OTM placement of call/put dollar volume).
    if strike_stats_df is not None and not strike_stats_df.empty:
        df = df.merge(strike_stats_df, on=["ticker", "date"], how="left")
    else:
        for raw in ("top_dv_share", "eff_strikes", "call_centroid_m", "put_centroid_m"):
            if raw not in df.columns:
                df[raw] = np.nan
    strike_ranks = {
        "top_dv_share": "strike_conc_rank",
        "eff_strikes": "eff_strikes_rank",
        "call_centroid_m": "call_centroid_rank",
        "put_centroid_m": "put_centroid_rank",
    }
    for raw, ch in strike_ranks.items():
        df[ch] = df.groupby("ticker")[raw].transform(_pct_rank)

    # Centre the rank levels on 0 (ranks are 0-100) so that the 0.0 used for
    # unobserved days sits at the middle of the distribution rather than at the
    # bottom of it. Without this, a missing snapshot would read as "lowest IV
    # spread on record" instead of "no information".
    for col in ("call_iv_spread_rank", "put_iv_spread_rank",
                "atm_call_iv_rank", "atm_put_iv_rank",
                "total_option_dv_log_rank", "put_call_dv_ratio_rank",
                *BUCKET_CHANNELS, *SKEW_CHANNELS, *STRIKE_CHANNELS):
        if col in df.columns:
            df[col] = df[col] - 50.0
        else:
            df[col] = np.nan

    # NaNs are deliberately preserved here: build_ticker_features forward-fills
    # them across non-snapshot days and only then zero-fills, so filling now
    # would both defeat the forward-fill and mask the options_missing flag.

    # Weekly (5-trading-day) aggregates of the centred ranks.
    grp = df.groupby("ticker")
    df["total_option_dv_log_rank_wmax"] = grp["total_option_dv_log_rank"].transform(
        lambda x: x.rolling(5, min_periods=1).max()
    )
    df["total_option_dv_log_rank_wmean"] = grp["total_option_dv_log_rank"].transform(
        lambda x: x.rolling(5, min_periods=1).mean()
    )
    df["atm_call_iv_rank_wmax"] = grp["atm_call_iv_rank"].transform(
        lambda x: x.rolling(5, min_periods=1).max()
    )
    df["atm_put_iv_rank_wmax"] = grp["atm_put_iv_rank"].transform(
        lambda x: x.rolling(5, min_periods=1).max()
    )
    df["call_iv_spread_rank_wslope"] = grp["call_iv_spread_rank"].diff(5)
    df["put_iv_spread_rank_wslope"] = grp["put_iv_spread_rank"].diff(5)
    # Joint DV-and-IV stress: high only when both the DV rank and the ATM call
    # IV rank are high (min as a smooth "and"), smoothed over the week.
    df["_dv_x_iv"] = np.minimum(df["total_option_dv_log_rank"], df["atm_call_iv_rank"])
    df["dv_x_iv_wmean"] = df.groupby("ticker")["_dv_x_iv"].transform(
        lambda x: x.rolling(5, min_periods=1).mean()
    )
    df = df.drop(columns=["_dv_x_iv"])

    return df[["ticker", "date"] + ALL_OPTION_CHANNELS + FULL2_EXTRA_CHANNELS]


def compute_event_magnitude(row) -> float:
    """Event magnitude proxy: volume * |close-to-close residual return|."""
    ret = row["return"]
    vol = row["volume"]
    if pd.isna(ret) or pd.isna(vol):
        return 0.0
    return float(vol) * abs(float(ret))


def build_ticker_features(df: pd.DataFrame, opts_df: pd.DataFrame = None) -> pd.DataFrame:
    """Add engineered features for a single ticker's price bars."""
    df = df.copy().sort_values("date").reset_index(drop=True)

    # Basic returns
    df["prev_close"] = df["close"].shift(1)
    df["return"] = np.log(df["close"] / df["prev_close"].replace(0, np.nan))
    df["gap"] = (df["open"] - df["prev_close"]) / df["prev_close"].replace(0, np.nan)
    df["range"] = (df["high"] - df["low"]) / df["close"].replace(0, np.nan)

    # Volume features
    df["log_volume"] = np.log(df["volume"].replace(0, np.nan))

    # Rolling volatility (annualized-ish, but we keep it unitless here)
    df["volatility"] = df["return"].rolling(window=20, min_periods=5).std() * np.sqrt(252)

    df["log_close"] = np.log(df["close"].replace(0, np.nan))

    # Event magnitude and log-transformed version used as a channel.
    df["event_magnitude"] = df.apply(compute_event_magnitude, axis=1)
    df["log_event_magnitude"] = np.log1p(df["event_magnitude"])

    # Merge options features if available.
    if opts_df is not None and not opts_df.empty:
        df["date"] = pd.to_datetime(df["date"]).dt.date
        df = df.merge(
            opts_df,
            left_on=["ticker", "date"],
            right_on=["ticker", "date"],
            how="left",
        )
        # Forward-fill options features up to 5 trading days so a missing snapshot
        # does not immediately zero out the signal. The missing flag reflects
        # whether any value within the fill window was actually observed.
        for col in ALL_OPTION_CHANNELS + FULL2_EXTRA_CHANNELS:
            if col not in df.columns:
                df[col] = np.nan
            df[col] = df.groupby("ticker")[col].transform(lambda x: x.ffill(limit=5))
        # A date is non-missing if it was directly observed OR successfully filled.
        df["options_missing"] = df[ALL_OPTION_CHANNELS].isna().all(axis=1).astype(float)
        for col in ALL_OPTION_CHANNELS + FULL2_EXTRA_CHANNELS:
            df[col] = df[col].fillna(0.0).astype(float)
    else:
        for col in ALL_OPTION_CHANNELS + FULL2_EXTRA_CHANNELS:
            df[col] = 0.0
        df["options_missing"] = 1.0

    # Replace NaNs with 0 so TTM does not see missing numerics.
    for col in ["return", "gap", "range", "volatility", "log_volume", "log_close", "event_magnitude", "log_event_magnitude"]:
        df[col] = df[col].fillna(0.0)

    return df


