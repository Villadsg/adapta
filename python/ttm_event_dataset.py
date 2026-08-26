"""
Build a binary classification dataset for TTM-R3 next-day "big event" forecasting.

A "big event" is defined as a day whose event magnitude (volume * |return|)
lands in the global top 20% of the training set. Per-ticker normalization is
removed; instead we feed log(event_magnitude + 1) as a global channel and let
TTM's internal standardization handle scale differences.

Reads from the project's DuckDB (`articles.db`) and emits sliding-window
samples. The context length is chosen to be divisible by TTM-R3's pretrained
patch size (9) so patch weights are preserved.

Output formats:
- `train.jsonl` / `val.jsonl` / `test.jsonl` lines:
  {
    "id": "AAPL_2024-01-15",
    "ticker": "AAPL",
    "date": "2024-01-15",
    "context": {
      "dates": [...],
      "values": [[...], ...]   # (context_length, n_channels)
    },
    "label": 1,                # 1 = next day is a top-20% event
    "target_raw": 1234567.89,  # next-day volume * |return|
  }

Run:
    python/venv-ttm/bin/python python/ttm_event_dataset.py --db articles.db --out data/ttm-events
"""

import argparse
import json
import math
import os
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd


# Feature channels (must match model num_input_channels).
# Channel 0 is the log event magnitude of past days; the rest are covariates.
#
# Options history lives in DuckDB (options_daily_iv), derived from raw
# marketdata.app chains by ci/backfill-marketdata.js phase D. It replaces the
# former ci/weighted-iv-history.json, which was a by-product of screening runs.
# Note the DB carries two expirations (exp1/exp2) rather than the JSON's three;
# _dv_weighted() skips missing expirations, so pooling is unchanged in form.
OPTIONS_EXPIRATIONS = ("exp1", "exp2")

# Fixed OTM moneyness buckets, derived per (ticker, date, expiration, side) by
# ttm_options_buckets.py into the options_daily_buckets table.
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

CHANNELS = [
    "log_event_magnitude",    # log(volume * |return| + 1)
    "log_close",              # log(close), centered on last value in window
    "log_volume",             # log(volume), centered on median of window
    "return",                 # close-to-close log return
    "gap",                    # (open - prev_close) / prev_close
    "range",                  # (high - low) / close
    "volatility",             # rolling std of returns over window
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
    # NOTE: put-side mirrors (put_iv_spread_rank/delta, atm_put_iv_rank/delta)
    # and the per-moneyness-bucket DV ranks (BUCKET_CHANNELS) were tested
    # against this channel set and regressed test AUROC (put side 0.758,
    # buckets 0.72-0.75, vs ~0.80 here) at the current ~16k training samples.
    # The code stays in build_options_features; re-add the channels here when
    # the history is deeper.
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

# Direction-model channel set: drops log_event_magnitude (direction-agnostic
# by construction — it encodes move SIZE, not sign) and adds the put-side
# mirrors to the call channels.
DIRECTION_CHANNELS = [
    "log_close",
    "log_volume",
    "return",
    "gap",
    "range",
    "volatility",
    *ALL_OPTION_CHANNELS,
    "options_missing",
]
N_CHANNELS = len(CHANNELS)

# Target definition
EVENT_QUANTILE = 0.80  # top 20% of training-set event magnitudes are "events"
CONTEXT_LENGTH = 36    # divisible by TTM-R3 patch_length = 9


def load_prices(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Load all price bars from stock_prices, keeping the latest close per (ticker, date)."""
    query = """
        SELECT
            ticker,
            date,
            open,
            high,
            low,
            close,
            volume
        FROM (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY fetched_at DESC) AS rn
            FROM stock_prices
        )
        WHERE rn = 1
        ORDER BY ticker, date
    """
    df = con.execute(query).fetchdf()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def load_events(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Load historical stock events keyed by (ticker, date)."""
    query = """
        SELECT ticker, event_date, classification,
               residual_return, volume_gap_product
        FROM stock_events
    """
    df = con.execute(query).fetchdf()
    df["event_date"] = pd.to_datetime(df["event_date"]).dt.date
    df["residual_return"] = pd.to_numeric(df["residual_return"], errors="coerce")
    df["volume_gap_product"] = pd.to_numeric(df["volume_gap_product"], errors="coerce")
    return df


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
        # IV the rest of the app reports. _dv_weighted takes three positional
        # expirations; pass None for the third since the DB carries two.
        exp1, exp2 = exps
        call_iv = _dv_weighted(exp1, exp2, None, _otm_call_iv, _call_weight)
        put_iv = _dv_weighted(exp1, exp2, None, _otm_put_iv, _put_weight)
        atm_call_iv = _dv_weighted(exp1, exp2, None, _atm_call_iv, _atm_call_weight)
        atm_put_iv = _dv_weighted(exp1, exp2, None, _atm_put_iv, _atm_put_weight)

        # Days until each referenced expiration (log-scaled). The exp1/exp2
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


def build_options_features(
    opts_df: pd.DataFrame, buckets_df: pd.DataFrame = None
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

    # Centre log-DTE on log1p(30) (~30 days, a typical exp1/exp2 distance) so
    # the 0.0 missing-value fill reads as "typical expiry", not "expires today".
    for col in ("exp1_dte_log", "exp2_dte_log"):
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

    # Centre the rank levels on 0 (ranks are 0-100) so that the 0.0 used for
    # unobserved days sits at the middle of the distribution rather than at the
    # bottom of it. Without this, a missing snapshot would read as "lowest IV
    # spread on record" instead of "no information".
    for col in ("call_iv_spread_rank", "put_iv_spread_rank",
                "atm_call_iv_rank", "atm_put_iv_rank",
                "total_option_dv_log_rank", "put_call_dv_ratio_rank",
                *BUCKET_CHANNELS):
        if col in df.columns:
            df[col] = df[col] - 50.0
        else:
            df[col] = np.nan

    # NaNs are deliberately preserved here: build_ticker_features forward-fills
    # them across non-snapshot days and only then zero-fills, so filling now
    # would both defeat the forward-fill and mask the options_missing flag.
    return df[["ticker", "date"] + ALL_OPTION_CHANNELS]


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
        for col in ALL_OPTION_CHANNELS:
            if col not in df.columns:
                df[col] = np.nan
            df[col] = df.groupby("ticker")[col].transform(lambda x: x.ffill(limit=5))
        # A date is non-missing if it was directly observed OR successfully filled.
        df["options_missing"] = df[ALL_OPTION_CHANNELS].isna().all(axis=1).astype(float)
        for col in ALL_OPTION_CHANNELS:
            df[col] = df[col].fillna(0.0).astype(float)
    else:
        for col in ALL_OPTION_CHANNELS:
            df[col] = 0.0
        df["options_missing"] = 1.0

    # Replace NaNs with 0 so TTM does not see missing numerics.
    for col in ["return", "gap", "range", "volatility", "log_volume", "log_close", "event_magnitude", "log_event_magnitude"]:
        df[col] = df[col].fillna(0.0)

    return df


def make_windows(
    df: pd.DataFrame,
    context_length: int,
    feature_cols: list[str],
    target: str = "event",
) -> list[dict]:
    """Create sliding-window samples from a single ticker dataframe.

    target="event"     -> target_raw is the day's event magnitude; labels are
                          assigned later via a global quantile threshold.
    target="direction" -> target_raw is the day's close-to-close log return;
                          label is its sign (1 = up), assigned in main().
    """
    df = df.sort_values("date").reset_index(drop=True)
    samples = []
    n = len(df)
    if n < context_length + 1:
        return samples

    values_all = df[feature_cols].to_numpy(dtype=np.float32)

    for i in range(context_length, n):
        window = values_all[i - context_length:i]
        target_row = df.iloc[i]

        # Local centering for log_close and log_volume
        window_local = window.copy()
        last_log_close = window[-1, feature_cols.index("log_close")]
        med_log_volume = float(np.nanmedian(window[:, feature_cols.index("log_volume")]))
        window_local[:, feature_cols.index("log_close")] -= last_log_close
        window_local[:, feature_cols.index("log_volume")] -= med_log_volume

        target_raw = (
            float(target_row["event_magnitude"])
            if target == "event"
            else float(target_row["return"])
        )

        sample = {
            "id": f"{target_row['ticker']}_{target_row['date']}",
            "ticker": target_row["ticker"],
            "date": str(target_row["date"]),
            "context": {
                "dates": [str(d) for d in df["date"].iloc[i - context_length:i].tolist()],
                "values": window_local.tolist(),
            },
            "target_raw": target_raw,
            "label": 0,  # filled in after the global threshold is computed
        }
        samples.append(sample)

    return samples


def split_samples(samples: list[dict], train_ratio: float = 0.7, val_ratio: float = 0.15) -> tuple:
    """Chronological split with date-disjoint folds.

    Sorting by (ticker, date) and slicing would partition the data by ticker
    alphabetically rather than by time -- train would hold one set of tickers and
    test an entirely disjoint set, all covering the same dates. That measures
    cross-ticker generalization, not next-day forecasting, and lets the model see
    the future of every test date during training.

    Splitting on date boundaries instead keeps every ticker in all three folds
    while guaranteeing that no training sample post-dates a validation or test
    sample. Cut points snap to date boundaries so a single date never straddles
    two folds.
    """
    samples_sorted = sorted(samples, key=lambda s: (s["date"], s["ticker"]))
    dates = sorted({s["date"] for s in samples_sorted})
    if not dates:
        return [], [], []

    n_dates = len(dates)
    n_train_dates = int(n_dates * train_ratio)
    n_val_dates = int(n_dates * val_ratio)
    train_end = dates[n_train_dates] if n_train_dates < n_dates else None
    val_end = dates[n_train_dates + n_val_dates] if n_train_dates + n_val_dates < n_dates else None

    train, val, test = [], [], []
    for s in samples_sorted:
        if train_end is None or s["date"] < train_end:
            train.append(s)
        elif val_end is None or s["date"] < val_end:
            val.append(s)
        else:
            test.append(s)
    return train, val, test


def apply_labels(samples: list[dict], threshold: float) -> None:
    """Assign binary labels based on the global event-magnitude threshold."""
    for s in samples:
        s["label"] = 1 if s["target_raw"] >= threshold else 0


def write_jsonl(samples: list[dict], path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for s in samples:
            f.write(json.dumps(s) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Build TTM-R3 binary event dataset")
    parser.add_argument("--db", default="articles.db", help="Path to DuckDB database")
    parser.add_argument("--out", default="data/ttm-events", help="Output directory")
    parser.add_argument("--context-length", type=int, default=CONTEXT_LENGTH, help="History window length")
    parser.add_argument("--event-quantile", type=float, default=EVENT_QUANTILE, help="Global event threshold quantile")
    parser.add_argument("--target", choices=["event", "direction"], default="event",
                        help="event: predict top-quantile volume*|return| days; "
                             "direction: predict the sign of the next-day return")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"Database not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    con = duckdb.connect(args.db, read_only=True)
    try:
        prices = load_prices(con)
        events = load_events(con)
        # Options history also comes from the DB, so read it before closing.
        opts_history = load_options_history(con)
        opts_buckets = load_options_buckets(con)
    finally:
        con.close()

    if prices.empty:
        print("No price data found.", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(prices)} price rows across {prices['ticker'].nunique()} tickers")
    print(f"Loaded {len(events)} historical events")

    # Pre-compute percentile-ranked options features.
    if not opts_history.empty:
        opts_history = build_options_features(opts_history, opts_buckets)
        print(f"Loaded options history for {opts_history['ticker'].nunique()} tickers / {len(opts_history)} rows")
        if opts_buckets.empty:
            print("No options_daily_buckets table; bucket channels will be zeroed.")
    else:
        print("No options history found; options channels will be zeroed.")

    # Build features per ticker
    ticker_frames = []
    for ticker, grp in prices.groupby("ticker"):
        ticker_opts = opts_history[opts_history["ticker"] == ticker] if not opts_history.empty else None
        framed = build_ticker_features(grp, ticker_opts)
        # Where historical volume_gap_product exists, prefer it for the target.
        merged = grp[["ticker", "date"]].merge(
            events[["ticker", "event_date", "volume_gap_product"]],
            left_on=["ticker", "date"],
            right_on=["ticker", "event_date"],
            how="left",
        )
        framed["event_magnitude"] = merged["volume_gap_product"].fillna(framed["event_magnitude"])
        framed["log_event_magnitude"] = np.log1p(framed["event_magnitude"])
        ticker_frames.append(framed)

    prices = pd.concat(ticker_frames, ignore_index=True)

    # Build windows
    channels = DIRECTION_CHANNELS if args.target == "direction" else CHANNELS
    all_samples = []
    for ticker, grp in prices.groupby("ticker"):
        samples = make_windows(grp, args.context_length, channels, target=args.target)
        all_samples.extend(samples)

    if not all_samples:
        print("No samples generated. Check context length and available data.", file=sys.stderr)
        sys.exit(1)

    train, val, test = split_samples(all_samples)

    if args.target == "direction":
        # Label = sign of the next-day log return. No threshold to learn from
        # the train fold; store 0.0 so downstream tooling has a value.
        threshold = 0.0
        apply_labels(train, threshold)
        apply_labels(val, threshold)
        apply_labels(test, threshold)
    else:
        # Global threshold comes from training labels only to avoid leakage.
        train_magnitudes = [s["target_raw"] for s in train]
        threshold = float(np.quantile(train_magnitudes, args.event_quantile))
        apply_labels(train, threshold)
        apply_labels(val, threshold)
        apply_labels(test, threshold)

    out_dir = Path(args.out)
    write_jsonl(train, out_dir / "train.jsonl")
    write_jsonl(val, out_dir / "val.jsonl")
    write_jsonl(test, out_dir / "test.jsonl")

    train_labels = [s["label"] for s in train]
    pos = sum(train_labels)
    neg = len(train_labels) - pos
    class_weight = neg / pos if pos > 0 else 1.0
    bce_pos_weight = math.sqrt(class_weight)

    stats = {
        "target": args.target,
        "tickers": sorted(prices["ticker"].unique().tolist()),
        "context_length": args.context_length,
        "n_channels": len(channels),
        "channels": channels,
        "event_quantile": args.event_quantile,
        "event_threshold": threshold,
        "train_samples": len(train),
        "val_samples": len(val),
        "test_samples": len(test),
        "train_positives": pos,
        "train_negatives": neg,
        "class_weight": round(class_weight, 4),
        "bce_pos_weight": round(bce_pos_weight, 4),
    }
    with open(out_dir / "stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print(f"Wrote {len(train)} train / {len(val)} val / {len(test)} test samples to {out_dir}")
    print(f"Global event threshold (top {(1 - args.event_quantile) * 100:.0f}%): {threshold:,.2f}")
    print(f"Train positives: {pos} ({pos / len(train):.1%}), negatives: {neg}")
    print(f"Class weight (neg/pos): {class_weight:.3f}")
    print(f"Channels: {channels}")


if __name__ == "__main__":
    main()
