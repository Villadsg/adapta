"""TimesFM 3.0 directional forecasting for the next trading day.

The target series is log_close, centered on the last context value so that
zero reads as "no change". The only covariates are the options-derived
channels (IV/DV percentile ranks, DTE logs, weekly aggregates) — no price or
volume channels. P(up tomorrow) = 1 - CDF(0) over the model's quantile
forecast at h = 1 (the next bar after the forecast date), or --horizon if
given explicitly.

Run:
    python/venv-ttm/bin/python python/timesfm_direction_forecast.py \
        --db articles.db --ticker AAPL
"""

import argparse
import json
import sys
from datetime import timedelta

import duckdb
import numpy as np
import pandas as pd

from timesfm3 import TimesFM3Evaluator, ModelConfig
from adapta.features import ALL_OPTION_CHANNELS, FULL2_EXTRA_CHANNELS
from adapta.options import (
    build_options_features,
    load_options_buckets,
    load_options_history,
    load_options_strike_stats,
)
from adapta.utils import build_ticker_features

# Channel 0 is the target (log_close); the rest are past_only_covariates.
# Options-only by design: the price/volume block is deliberately excluded.
DIRECTION_OPTION_CHANNELS = [
    "log_close",
    *ALL_OPTION_CHANNELS,
    *FULL2_EXTRA_CHANNELS,
    "options_missing",
]

CONTEXT_LENGTH = 36  # divisible by TimesFM's patch length of 9


def load_ticker_prices(con: duckdb.DuckDBPyConnection, ticker: str) -> pd.DataFrame:
    query = """
        SELECT ticker, date, open, high, low, close, volume
        FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY fetched_at DESC) AS rn
            FROM stock_prices WHERE ticker = ?
        ) WHERE rn = 1 ORDER BY date
    """
    df = con.execute(query, [ticker]).fetchdf()
    if df.empty: return df
    df["date"] = pd.to_datetime(df["date"]).dt.date
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def build_direction_context(df, opts_df, target_date=None, channels=None):
    channels = channels or DIRECTION_OPTION_CHANNELS
    df = build_ticker_features(df, opts_df)
    if target_date is not None:
        df = df[df["date"] <= target_date - timedelta(days=1)]
        forecast_date = target_date
    else:
        forecast_date = df["date"].max() + timedelta(days=1)
    df = df.sort_values("date").reset_index(drop=True)
    if len(df) < CONTEXT_LENGTH + 1:
        raise ValueError(f"Need {CONTEXT_LENGTH+1} bars, got {len(df)}")
    window = df.iloc[-CONTEXT_LENGTH:].copy().reset_index(drop=True)
    values = window[channels].to_numpy(dtype=np.float32).copy()
    # Center log_close on the last close in the window: the forecast is then
    # directly a cumulative log return, with 0 = unchanged.
    values[:, 0] -= values[-1, 0]
    return values[:, 0], values[:, 1:].T, {
        "context_start": str(window["date"].iloc[0]),
        "context_end": str(window["date"].iloc[-1]),
        "context_days": int(len(window)),
        "forecast_date": str(forecast_date),
    }


def prob_above(quantile_values, quantile_levels, t):
    q = np.sort(np.asarray(quantile_values, dtype=float))
    cdf = np.interp(t, q, quantile_levels)
    return float(1.0 - cdf)


def resolve_device(requested):
    if requested and requested != "auto": return requested
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def main():
    parser = argparse.ArgumentParser(description="TimesFM 3.0 next-day direction forecasting")
    parser.add_argument("--db", default="articles.db")
    parser.add_argument("--model", default="google/timesfm-3.0-pytorch")
    parser.add_argument("--ticker")
    parser.add_argument("--tickers")
    parser.add_argument("--date", help="Forecast start date (default: next bar after latest data)")
    parser.add_argument("--horizon", type=int, default=1,
                        help="Trading-day horizon (default: 1 = the next trading day)")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--channels",
                        help="Comma-separated channel list (channel 0 must be log_close). "
                             "Default: the options-only production set. Used by screening when "
                             "the Model Lab promotes a validated feature set.")
    args = parser.parse_args()

    channels = DIRECTION_OPTION_CHANNELS
    if args.channels:
        channels = [c.strip() for c in args.channels.split(",") if c.strip()]
        if not channels or channels[0] != "log_close":
            print(json.dumps({"error": "--channels must start with log_close"}), file=sys.stderr)
            sys.exit(1)

    if args.tickers:
        payload = {"tickers": [t.strip() for t in args.tickers.split(",") if t.strip()], "date": args.date}
    elif args.ticker:
        payload = {"ticker": args.ticker, "date": args.date}
    else:
        try: payload = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), file=sys.stderr)
            sys.exit(1)

    batch_tickers = payload.get("tickers")
    single_ticker = payload.get("ticker")
    if not batch_tickers and not single_ticker:
        print(json.dumps({"error": "Missing 'ticker' or 'tickers'"}), file=sys.stderr)
        sys.exit(1)

    target_date = pd.to_datetime(payload["date"]).date() if payload.get("date") else None
    device = resolve_device(args.device)

    config = ModelConfig(checkpoint_path=args.model, per_core_batch_size=32, device=device)
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)

    con = duckdb.connect(args.db, read_only=True)
    try:
        opts_history = load_options_history(con)
        opts_buckets = load_options_buckets(con)
        opts_strike = load_options_strike_stats(con)
        all_contexts, all_covariates, all_metas, all_horizons = [], [], [], []
        all_horizon_sources = []
        all_ok_tickers, all_errors = [], []
        tickers_to_process = batch_tickers if batch_tickers else [single_ticker]

        for ticker in tickers_to_process:
            try:
                prices = load_ticker_prices(con, ticker)
                if prices.empty:
                    raise ValueError(f"No price data for {ticker}")

                as_of = (target_date - timedelta(days=1)) if target_date else prices["date"].max()

                ticker_opts = None
                if not opts_history.empty:
                    t_buckets = None
                    if not opts_buckets.empty:
                        b = opts_buckets[opts_buckets["ticker"] == ticker]
                        if not b.empty:
                            t_buckets = b
                    t_opts = build_options_features(
                        opts_history[opts_history["ticker"] == ticker], t_buckets,
                        opts_strike[opts_strike["ticker"] == ticker]
                        if not opts_strike.empty else None,
                    )
                    if not t_opts.empty:
                        ticker_opts = t_opts

                target_ser, cov_ser, meta = build_direction_context(
                    prices, ticker_opts, target_date=target_date, channels=channels
                )
                forecast_date = pd.to_datetime(meta["forecast_date"]).date()
                horizon = args.horizon
                horizon_source = "override" if args.horizon != 1 else "next_day"

                all_contexts.append(target_ser)
                all_covariates.append(cov_ser)
                all_metas.append(meta)
                all_horizons.append(horizon)
                all_horizon_sources.append(horizon_source)
                all_ok_tickers.append(ticker)
            except Exception as e:
                all_errors.append({"ticker": ticker, "error": str(e)})

        if not all_contexts:
            if all_errors: print(json.dumps({"errors": all_errors}, indent=2))
            return

        results = []
        for start in range(0, len(all_contexts), args.batch_size):
            end = min(start + args.batch_size, len(all_contexts))
            batch_ctx = all_contexts[start:end]
            batch_cov = all_covariates[start:end]
            batch_h = all_horizons[start:end]
            # predict_batch requires a single horizon per call; group by horizon.
            for h in sorted(set(batch_h)):
                idx = [i for i in range(start, end) if all_horizons[i] == h]
                outputs = list(
                    forecaster.predict_batch(
                        contexts=[all_contexts[i] for i in idx],
                        horizon=h,
                        past_only_covariates=[all_covariates[i] for i in idx],
                        return_quantiles=True,
                        use_symmetric_averaging=False,
                    )
                )
                for j, i in enumerate(idx):
                    q = np.asarray(outputs[j].quantiles, dtype=float)[-1]  # quantiles at the final step
                    up_prob = prob_above(q, quantile_levels, 0.0)
                    median = float(np.asarray(outputs[j].forecast, dtype=float).flatten()[-1]) \
                        if outputs[j].forecast is not None else float(np.interp(0.5, quantile_levels, np.sort(q)))
                    results.append({
                        "ticker": all_ok_tickers[i],
                        "forecast_date": all_metas[i]["forecast_date"],
                        "horizon_trading_days": all_horizons[i],
                        "horizon_source": all_horizon_sources[i],
                        "up_probability": round(up_prob, 4),
                        "down_probability": round(1.0 - up_prob, 4),
                        "median_log_return": round(median, 6),
                        "median_return_pct": round((np.expm1(median)) * 100, 4),
                        "context_start": all_metas[i]["context_start"],
                        "context_end": all_metas[i]["context_end"],
                        "context_days": all_metas[i]["context_days"],
                    })

        results.sort(key=lambda r: all_ok_tickers.index(r["ticker"]))
        if not batch_tickers:
            if all_errors:
                print(json.dumps({"error": all_errors[0]["error"]}), file=sys.stderr)
                sys.exit(1)
            print(json.dumps(results[0], indent=2))
        else:
            print(json.dumps({"results": results, "errors": all_errors, "device": device,
                              "count": len(results)}, indent=2))

    finally:
        con.close()

if __name__ == "__main__":
    main()
