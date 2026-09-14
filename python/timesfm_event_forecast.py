import argparse
import json
import os
import sys
from datetime import datetime, timedelta

import duckdb
import numpy as np
import pandas as pd

from timesfm3 import TimesFM3Evaluator, ModelConfig
from adapta.features import FULL2_CHANNELS, OPTIONS_ONLY_CHANNELS
from adapta.options import (
    build_options_features,
    load_options_buckets,
    load_options_history,
)
from adapta.utils import build_result, build_ticker_features


def load_stats(stats_path: str) -> dict:
    with open(stats_path, "r") as f:
        return json.load(f)

def prob_above_threshold(quantile_values, quantile_levels, t_log):
    cdf = np.interp(t_log, quantile_values, quantile_levels)
    return float(1.0 - cdf)

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

def build_context_timesfm(df, context_length, target_date=None, opts_df=None, active_channels=None):
    df = build_ticker_features(df, opts_df)
    if target_date is not None:
        latest_context = target_date - timedelta(days=1)
        df = df[df["date"] <= latest_context]
        forecast_date = target_date
    else:
        forecast_date = df["date"].max() + timedelta(days=1)
    df = df.sort_values("date").reset_index(drop=True)
    if len(df) < context_length + 1:
        raise ValueError(f"Need {context_length+1} bars, got {len(df)}")
    window = df.iloc[-context_length:].copy().reset_index(drop=True)
    values = window[active_channels].to_numpy(dtype=np.float32).copy()
    # Center log_close / log_volume when present; channel sets without them
    # (options_only) skip centering entirely.
    if "log_close" in active_channels:
        idx = active_channels.index("log_close")
        values[:, idx] -= values[-1, idx]
    if "log_volume" in active_channels:
        idx = active_channels.index("log_volume")
        values[:, idx] -= float(np.nanmedian(values[:, idx]))
    return values[:, 0], values[:, 1:].T, {
        "context_start": str(window["date"].iloc[0]),
        "context_end": str(window["date"].iloc[-1]),
        "context_days": int(len(window)),
        "forecast_date": str(forecast_date),
    }

def parse_date(s):
    if not s: return None
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try: return datetime.strptime(s, fmt).date()
        except ValueError: continue
    raise ValueError(f"Unable to parse date: {s}")

def resolve_device(requested):
    if requested and requested != "auto": return requested
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"

def main():
    parser = argparse.ArgumentParser(description="TimesFM 3.0 event forecasting")
    parser.add_argument("--db", default="articles.db")
    parser.add_argument("--model", default="google/timesfm-3.0-pytorch")
    parser.add_argument("--dataset-stats", default="data/ttm-events/stats.json")
    parser.add_argument("--ticker")
    parser.add_argument("--tickers")
    parser.add_argument("--date")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--channels", choices=["full2", "options_only"], default="full2",
                        help="Channel set fed to the model (channel 0 = target, rest = "
                             "past_only_covariates). options_only drops the price/volume "
                             "channels and skips log_close/log_volume centering.")
    args = parser.parse_args()

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

    target_date = parse_date(payload.get("date")) if payload.get("date") else None
    if not os.path.exists(args.db):
        print(json.dumps({"error": f"DB not found: {args.db}"}), file=sys.stderr)
        sys.exit(1)

    stats = load_stats(args.dataset_stats)
    event_threshold = float(stats["event_threshold"])
    t_log = float(np.log1p(event_threshold))
    context_length = stats.get("context_length", 36)
    active_channels = {"full2": FULL2_CHANNELS, "options_only": OPTIONS_ONLY_CHANNELS}[args.channels]
    device = resolve_device(args.device)

    from timesfm3 import ModelConfig
    config = ModelConfig(checkpoint_path=args.model, per_core_batch_size=32, device=device)
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)
    median_idx = int(config.median_quantile_index)

    con = duckdb.connect(args.db, read_only=True)
    try:
        opts_history = load_options_history(con)
        opts_buckets = load_options_buckets(con)
        all_contexts, all_covariates, all_metas, all_ok_tickers, all_errors = [], [], [], [], []
        tickers_to_process = batch_tickers if batch_tickers else [single_ticker]

        for ticker in tickers_to_process:
            try:
                prices = load_ticker_prices(con, ticker)
                if prices.empty:
                    all_errors.append({"ticker": ticker, "error": f"No price data for {ticker}"})
                    continue

                ticker_opts = None
                if not opts_history.empty:
                    t_buckets = None
                    if not opts_buckets.empty:
                        b = opts_buckets[opts_buckets["ticker"] == ticker]
                        if not b.empty:
                            t_buckets = b
                    t_opts = build_options_features(
                        opts_history[opts_history["ticker"] == ticker], t_buckets
                    )
                    if not t_opts.empty:
                        ticker_opts = t_opts

                target_ser, cov_ser, meta = build_context_timesfm(
                    prices,
                    context_length,
                    target_date=target_date,
                    opts_df=ticker_opts,
                    active_channels=active_channels,
                )
                all_contexts.append(target_ser)
                all_covariates.append(cov_ser)
                all_metas.append(meta)
                all_ok_tickers.append(ticker)
            except Exception as e:
                all_errors.append({"ticker": ticker, "error": str(e)})

        if not all_contexts:
            if all_errors: print(json.dumps({"errors": all_errors}), indent=2)
            return

        all_probs = np.zeros(len(all_ok_tickers))
        for start in range(0, len(all_contexts), args.batch_size):
            end = min(start + args.batch_size, len(all_contexts))
            batch_ctx = all_contexts[start:end]
            batch_cov = all_covariates[start:end]
            outputs = list(
                forecaster.predict_batch(
                    contexts=batch_ctx,
                    horizon=1,
                    past_only_covariates=batch_cov,
                    return_quantiles=True,
                    use_symmetric_averaging=False,
                )
            )
            for j, out in enumerate(outputs):
                i = start + j
                q = np.asarray(out.quantiles, dtype=float)[0]
                all_probs[i] = prob_above_threshold(q, quantile_levels, t_log)

        results = [build_result(all_ok_tickers[i], all_probs[i], event_threshold, all_metas[i]) for i in range(len(all_ok_tickers))]

        if not batch_tickers:
            if all_errors:
                print(json.dumps({"error": all_errors[0]["error"]}), file=sys.stderr)
                sys.exit(1)
            print(json.dumps(results[0], indent=2))
        else:
            print(json.dumps({"results": results, "errors": all_errors, "device": device, "count": len(results)}, indent=2))

    finally:
        con.close()

if __name__ == "__main__":
    main()
