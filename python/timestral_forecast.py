"""Timestral event + directional forecasting (trial drop-in for TimesFM 3.0).

Same interface contract as timesfm_event_forecast.py and
timesfm_direction_forecast.py: a JSON payload on stdin ({ticker, date} or
{tickers, date}), JSON results on stdout. Context construction is imported
verbatim from those scripts so the only variable being swapped is the model.

Two Timestral details differ from its defaults, on purpose:
  - clip_nonnegative=False — the direction target is centered log_close, where
    negative values ARE the signal; clipping at 0 would forbid "down".
  - symmetric_averaging=False — matches use_symmetric_averaging=False in the
    TimesFM scripts.

Run:
    python/venv-ttm/bin/python python/timestral_forecast.py --target event \
        --tickers AVAV,QCOM
    python/venv-ttm/bin/python python/timestral_forecast.py --target direction \
        --tickers AVAV,QCOM
"""

import argparse
import json
import sys
from pathlib import Path

import duckdb
import numpy as np

from timestral import TimestralForecaster

from adapta.features import FULL2_CHANNELS, OPTIONS_ONLY_CHANNELS
from adapta.options import (
    build_options_features,
    load_options_buckets,
    load_options_history,
    load_options_strike_stats,
)
from adapta.utils import build_result
from timesfm_direction_forecast import (
    DIRECTION_OPTION_CHANNELS,
    build_direction_context,
    prob_above,
)
from timesfm_event_forecast import (
    build_context_timesfm,
    load_ticker_prices,
    load_stats,
    parse_date,
)


def resolve_device(requested):
    if requested and requested != "auto":
        return requested
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def batch_forecast(model, contexts, covariates, horizon):
    """One Timestral pass over equal-length windows.

    contexts: (B, T) target values; covariates: (B, C, T) or None.
    Returns per-sample (quantile_values, quantile_levels, median) at the final
    horizon step.
    """
    ctx = np.stack(contexts)[:, None, :]  # (B, 1, T): single target variate
    cov = np.stack(covariates) if covariates and covariates[0].size else None
    out = model.forecast(
        ctx,
        prediction_length=horizon,
        past_covariates=cov,
        symmetric_averaging=False,
        clip_nonnegative=False,
    )
    levels = np.asarray(out.quantile_levels, dtype=float)
    q = np.asarray(out.quantiles.detach().cpu(), dtype=float)[:, 0, -1, :]  # (B, Q) final step
    med = np.asarray(out.median.detach().cpu(), dtype=float)[:, 0, -1]
    return q, levels, med


def build_ticker_inputs(con, tickers, target, context_length, channels,
                        options_frames, target_date):
    """Shared ticker loop: (target series, covariate matrix, meta) per ticker."""
    all_contexts, all_covariates, all_metas, all_t_logs = [], [], [], []
    all_ok, all_errors = [], []
    opts_history, opts_buckets, opts_strike = options_frames
    for ticker in tickers:
        try:
            prices = load_ticker_prices(con, ticker)
            if prices.empty:
                raise ValueError(f"No price data for {ticker}")

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

            if target == "event":
                target_ser, cov_ser, meta = build_context_timesfm(
                    prices, context_length, target_date=target_date,
                    opts_df=ticker_opts, active_channels=channels,
                )
                t_log = float(np.log1p(meta["event_threshold"]))
            else:
                target_ser, cov_ser, meta = build_direction_context(
                    prices, ticker_opts, target_date=target_date, channels=channels,
                )
                t_log = 0.0
            all_contexts.append(target_ser)
            all_covariates.append(cov_ser)
            all_metas.append(meta)
            all_t_logs.append(t_log)
            all_ok.append(ticker)
        except Exception as e:
            all_errors.append({"ticker": ticker, "error": str(e)})
    return all_contexts, all_covariates, all_metas, all_t_logs, all_ok, all_errors


def main():
    parser = argparse.ArgumentParser(description="Timestral event/direction forecasting")
    parser.add_argument("--db", default="articles.db")
    parser.add_argument("--model", default="mistralai/Timestral-209M")
    parser.add_argument("--target", choices=["event", "direction"], required=True)
    parser.add_argument("--dataset-stats", default="data/events/stats.json")
    parser.add_argument("--ticker")
    parser.add_argument("--tickers")
    parser.add_argument("--date")
    parser.add_argument("--horizon", type=int, default=1,
                        help="Trading-day horizon (direction only; default 1)")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--channels", default=None,
                        help="Preset name or comma list; default full2 for event, "
                             "options-only for direction (same as the TimesFM scripts)")
    args = parser.parse_args()

    if args.tickers:
        payload = {"tickers": [t.strip() for t in args.tickers.split(",") if t.strip()], "date": args.date}
    elif args.ticker:
        payload = {"ticker": args.ticker, "date": args.date}
    else:
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), file=sys.stderr)
            sys.exit(1)

    batch_tickers = payload.get("tickers")
    single_ticker = payload.get("ticker")
    if not batch_tickers and not single_ticker:
        print(json.dumps({"error": "Missing 'ticker' or 'tickers'"}), file=sys.stderr)
        sys.exit(1)

    target_date = parse_date(payload.get("date")) if payload.get("date") else None

    if args.target == "event":
        stats = load_stats(args.dataset_stats) if Path(args.dataset_stats).exists() else {}
        context_length = stats.get("context_length", 36)
        default_channels = FULL2_CHANNELS
    else:
        context_length = 36
        default_channels = DIRECTION_OPTION_CHANNELS

    if args.channels:
        channels = {"full2": FULL2_CHANNELS, "options_only": OPTIONS_ONLY_CHANNELS}.get(args.channels)
        if channels is None:
            channels = [c.strip() for c in args.channels.split(",") if c.strip()]
    else:
        channels = default_channels
    first = "log_event_magnitude" if args.target == "event" else "log_close"
    if not channels or channels[0] != first:
        print(json.dumps({"error": f"--channels must start with {first}"}), file=sys.stderr)
        sys.exit(1)

    device = resolve_device(args.device)
    model = TimestralForecaster.from_pretrained(args.model, device=device)

    con = duckdb.connect(args.db, read_only=True)
    try:
        options_frames = (
            load_options_history(con),
            load_options_buckets(con),
            load_options_strike_stats(con),
        )
        tickers_to_process = batch_tickers if batch_tickers else [single_ticker]
        all_contexts, all_covariates, all_metas, all_t_logs, all_ok, all_errors = \
            build_ticker_inputs(con, tickers_to_process, args.target, context_length,
                                channels, options_frames, target_date)

        if not all_contexts:
            print(json.dumps({"errors": all_errors}, indent=2))
            return

        horizon = args.horizon if args.target == "direction" else 1
        all_probs = np.zeros(len(all_ok))
        all_medians = np.zeros(len(all_ok))
        for start in range(0, len(all_contexts), args.batch_size):
            end = min(start + args.batch_size, len(all_contexts))
            q, levels, med = batch_forecast(
                model,
                all_contexts[start:end],
                all_covariates[start:end],
                horizon,
            )
            for j in range(end - start):
                i = start + j
                all_probs[i] = prob_above(q[j], levels, all_t_logs[i])
                all_medians[i] = med[j]

        if args.target == "event":
            results = [build_result(all_ok[i], all_probs[i],
                                    all_metas[i]["event_threshold"], all_metas[i])
                       for i in range(len(all_ok))]
        else:
            results = [{
                "ticker": all_ok[i],
                "forecast_date": all_metas[i]["forecast_date"],
                "horizon_trading_days": horizon,
                "horizon_source": "override" if args.horizon != 1 else "next_day",
                "up_probability": round(float(all_probs[i]), 4),
                "down_probability": round(1.0 - float(all_probs[i]), 4),
                "median_log_return": round(float(all_medians[i]), 6),
                "median_return_pct": round((np.expm1(float(all_medians[i]))) * 100, 4),
                "context_start": all_metas[i]["context_start"],
                "context_end": all_metas[i]["context_end"],
                "context_days": all_metas[i]["context_days"],
            } for i in range(len(all_ok))]

        if not batch_tickers:
            if all_errors:
                print(json.dumps({"error": all_errors[0]["error"]}), file=sys.stderr)
                sys.exit(1)
            print(json.dumps(results[0], indent=2))
        else:
            print(json.dumps({"results": results, "errors": all_errors,
                              "device": device, "count": len(results)}, indent=2))
    finally:
        con.close()


if __name__ == "__main__":
    main()
