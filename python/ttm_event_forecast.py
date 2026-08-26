"""
Inference script for the fine-tuned TTM-R3 event-classification model.

Two modes:

1. Single ticker -- accepts a JSON object on stdin like:

       {"ticker": "AAPL", "date": "2024-01-16"}

   `date` is optional; when omitted the forecast is for the next trading day
   after the latest price bar in the database.

   Outputs a JSON object:

       {
         "ticker": "AAPL",
         "forecast_date": "2024-01-16",
         "event_probability": 0.42,
         "event_threshold": 2367125.41,
         "predicted_event_magnitude": 987654.32,
         "context_start": "2023-11-20",
         "context_end": "2024-01-15",
         "context_days": 36
       }

2. Batch -- pass a list of tickers on stdin (or --tickers A,B,C):

       {"tickers": ["AAPL", "QCOM"], "date": "2024-01-16"}

   All contexts are stacked into ONE forward pass, so the model weights and
   the ~2s of Python/torch import cost are paid once for the whole group
   rather than once per ticker. Outputs:

       {
         "results": [ {...}, {...} ],       # same shape as single-ticker
         "errors":  [ {"ticker": "X", "error": "..."} ],
         "device":  "cuda",
         "count":   2
       }

   Tickers that cannot be scored (no price data, too few bars) land in
   `errors` and never abort the run -- one bad ticker must not lose the batch.

Device: --device defaults to "auto", which selects CUDA when available and
falls back to CPU. Batched GPU inference is ~40x faster than CPU at
batch=100 (55ms vs 2.3s), while a single sample is dominated by startup cost.

Run:
    python/venv-ttm/bin/python python/ttm_event_forecast.py \
        --db articles.db --model python/models/ttm-event-r3/final \
        --dataset-stats data/ttm-events/stats.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import torch

from tsfm_public import TinyTimeMixerConfig

# Make sibling python modules importable when this script is invoked directly.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from ttm_event_dataset import (
    CHANNELS,
    build_options_features,
    build_ticker_features,
    load_options_buckets,
    load_options_history,
)
from ttm_event_finetune import TTMEventClassifier


def load_stats(stats_path: str) -> dict:
    with open(stats_path, "r") as f:
        return json.load(f)


def load_model(model_dir: str, num_channels: int):
    config = TinyTimeMixerConfig.from_pretrained(model_dir)
    config.num_input_channels = num_channels
    config.exogenous_channel_indices = list(range(1, num_channels))

    state_path = Path(model_dir) / "pytorch_model.bin"
    if not state_path.exists():
        state_path = Path(model_dir) / "model.safetensors"
    if not state_path.exists():
        raise FileNotFoundError(f"No model weights found in {model_dir}")
    state = torch.load(state_path, map_location="cpu", weights_only=True)

    # Recover the classification-head width from the checkpoint itself. Older
    # runs did not record head_hidden in training_info.json, so trusting the
    # constructor default would fail to load any model trained with a different
    # width.
    head_hidden = TTMEventClassifier.__init__.__defaults__[0]
    head_weight = state.get("head.2.weight")
    if head_weight is not None:
        head_hidden = int(head_weight.shape[0])

    model = TTMEventClassifier(config, head_hidden=head_hidden)
    # Initialize LazyLinear before loading weights.
    with torch.no_grad():
        model(past_values=torch.zeros(1, config.context_length, num_channels))
    model.load_state_dict(state)
    model.eval()
    return model, config


def load_ticker_prices(con: duckdb.DuckDBPyConnection, ticker: str) -> pd.DataFrame:
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
            WHERE ticker = ?
        )
        WHERE rn = 1
        ORDER BY date
    """
    df = con.execute(query, [ticker]).fetchdf()
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"]).dt.date
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def build_context(
    df: pd.DataFrame,
    context_length: int,
    target_date=None,
    opts_df: pd.DataFrame = None,
    active_channels: list = None,
) -> tuple[torch.Tensor, list, dict]:
    """Build a normalized context tensor for inference."""
    df = build_ticker_features(df, opts_df)

    # Determine the forecast date and the latest allowable context date.
    if target_date is not None:
        latest_context = target_date - timedelta(days=1)
        df = df[df["date"] <= latest_context]
        forecast_date = target_date
    else:
        forecast_date = df["date"].max() + timedelta(days=1)

    df = df.sort_values("date").reset_index(drop=True)
    if len(df) < context_length + 1:
        raise ValueError(
            f"Need at least {context_length + 1} historical bars for {df['ticker'].iloc[0] if not df.empty else ticker}, "
            f"got {len(df)}"
        )

    window = df.iloc[-context_length:].copy().reset_index(drop=True)
    values = window[active_channels].to_numpy(dtype=np.float32).copy()

    # Local centering (mirrors make_windows in ttm_event_dataset.py).
    last_log_close = values[-1, active_channels.index("log_close")]
    med_log_volume = float(np.nanmedian(values[:, active_channels.index("log_volume")]))
    values[:, active_channels.index("log_close")] -= last_log_close
    values[:, active_channels.index("log_volume")] -= med_log_volume

    tensor = torch.tensor(values, dtype=torch.float32).unsqueeze(0)
    meta = {
        "context_start": str(window["date"].iloc[0]),
        "context_end": str(window["date"].iloc[-1]),
        "context_days": int(len(window)),
        "forecast_date": str(forecast_date),
    }
    return tensor, window["date"].tolist(), meta


def parse_date(s: str):
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unable to parse date: {s}")


def resolve_device(requested: str) -> str:
    """Map --device (default "auto") to a concrete torch device string."""
    if requested and requested != "auto":
        return requested
    return "cuda" if torch.cuda.is_available() else "cpu"


def resolve_channels(stats: dict, num_channels: int, model_dir: str) -> list:
    """
    Pick the channel list the checkpoint was actually trained with.

    Slicing the current CHANNELS is only valid when the counts agree --
    otherwise the model would silently receive features in positions it never
    saw in training, which produces confident nonsense rather than an error.
    """
    trained_channels = stats.get("channels")
    if trained_channels and len(trained_channels) == num_channels:
        return trained_channels
    if num_channels == len(CHANNELS):
        return list(CHANNELS)
    raise ValueError(
        f"Channel mismatch: checkpoint '{model_dir}' expects {num_channels} "
        f"input channels but the current feature set defines {len(CHANNELS)} "
        f"({', '.join(CHANNELS)}). Re-run ttm_event_finetune.py to retrain "
        f"this model on the current channels."
    )


def resolve_num_channels(model_dir: str, stats: dict) -> int:
    """
    Infer the channel count from the saved model config so the script stays
    compatible even if dataset stats were regenerated with more channels than
    the checkpoint was trained on.
    """
    model_config_path = Path(model_dir) / "config.json"
    if model_config_path.exists():
        with open(model_config_path, "r") as f:
            model_config = json.load(f)
        return model_config.get("num_input_channels", len(CHANNELS))
    return stats.get("n_channels", len(CHANNELS))


def build_result(ticker: str, prob: float, event_threshold: float, meta: dict,
                 target: str = "event") -> dict:
    result = {
        "ticker": ticker,
        "forecast_date": meta["forecast_date"],
        "event_probability": round(prob, 4),
        "event_threshold": round(event_threshold, 2),
        "predicted_event_magnitude": round(prob * event_threshold, 2),
        "context_start": meta["context_start"],
        "context_end": meta["context_end"],
        "context_days": meta["context_days"],
    }
    if target == "direction":
        # Threshold is 0.0 for direction models; the probability is P(up).
        result["up_probability"] = result.pop("event_probability")
        result["down_probability"] = round(1 - prob, 4)
        del result["predicted_event_magnitude"]
        del result["event_threshold"]
    return result


def forecast_batch(
    tickers: list,
    con: duckdb.DuckDBPyConnection,
    model,
    context_length: int,
    event_threshold: float,
    active_channels: list,
    device: str,
    target_date=None,
    target: str = "event",
) -> tuple[list, list]:
    """
    Score many tickers in a single batched forward pass.

    Contexts are built per ticker (each needs its own price history and local
    centering), then stacked so the model runs once. Returns (results, errors).
    """
    opts_history = load_options_history(con)
    opts_buckets = load_options_buckets(con)

    contexts = []
    metas = []
    ok_tickers = []
    errors = []

    for ticker in tickers:
        try:
            prices = load_ticker_prices(con, ticker)
            if prices.empty:
                errors.append({"ticker": ticker, "error": f"No price data for {ticker}"})
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

            tensor, _dates, meta = build_context(
                prices,
                context_length,
                target_date=target_date,
                opts_df=ticker_opts,
                active_channels=active_channels,
            )
            contexts.append(tensor)
            metas.append(meta)
            ok_tickers.append(ticker)
        except Exception as e:  # noqa: BLE001 - one bad ticker must not kill the batch
            errors.append({"ticker": ticker, "error": str(e)})

    if not contexts:
        return [], errors

    # One forward pass for the whole group -- this is the entire point of batch mode.
    batch = torch.cat(contexts, dim=0).to(device)
    with torch.no_grad():
        outputs = model(past_values=batch)
        logits = outputs["logits"].squeeze(-1).float().cpu()
    probs = torch.sigmoid(logits).tolist()
    if isinstance(probs, float):  # squeeze collapses a batch of 1
        probs = [probs]

    results = [
        build_result(t, p, event_threshold, m, target=target)
        for t, p, m in zip(ok_tickers, probs, metas)
    ]
    return results, errors


def main():
    parser = argparse.ArgumentParser(description="Forecast next-day event probability with TTM-R3")
    parser.add_argument("--db", default="articles.db", help="Path to DuckDB database")
    parser.add_argument("--model", default="python/models/ttm-event-r3/final", help="Fine-tuned model directory")
    parser.add_argument("--dataset-stats", default="data/ttm-events/stats.json", help="Dataset stats with event threshold")
    parser.add_argument("--ticker", help="Ticker to forecast (or read from stdin)")
    parser.add_argument("--tickers", help="Comma-separated tickers for batch mode")
    parser.add_argument("--date", help="Target date to forecast (YYYY-MM-DD); defaults to next trading day")
    parser.add_argument("--device", default="auto", help="torch device: auto (default), cpu, or cuda")
    args = parser.parse_args()

    # Read input from CLI or stdin.
    if args.tickers:
        payload = {"tickers": [t.strip() for t in args.tickers.split(",") if t.strip()], "date": args.date}
    elif args.ticker:
        payload = {"ticker": args.ticker, "date": args.date}
    else:
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON on stdin: {e}"}), file=sys.stderr)
            sys.exit(1)

    # Batch mode when 'tickers' is present; otherwise single-ticker mode.
    batch_tickers = payload.get("tickers")
    if batch_tickers is not None and not isinstance(batch_tickers, list):
        print(json.dumps({"error": "'tickers' must be a list"}), file=sys.stderr)
        sys.exit(1)

    single_ticker = payload.get("ticker")
    if not batch_tickers and not single_ticker:
        print(json.dumps({"error": "Missing 'ticker' or 'tickers'"}), file=sys.stderr)
        sys.exit(1)

    try:
        target_date = parse_date(payload.get("date")) if payload.get("date") else None
    except ValueError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.db):
        print(json.dumps({"error": f"Database not found: {args.db}"}), file=sys.stderr)
        sys.exit(1)

    stats = load_stats(args.dataset_stats)
    context_length = stats.get("context_length", 36)
    event_threshold = stats.get("event_threshold", 1.0)
    target = stats.get("target", "event")
    num_channels = resolve_num_channels(args.model, stats)

    try:
        active_channels = resolve_channels(stats, num_channels, args.model)
    except ValueError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    device = resolve_device(args.device)
    model, config = load_model(args.model, num_channels)
    model = model.to(device)

    tickers = [t.upper() for t in (batch_tickers if batch_tickers else [single_ticker])]

    con = duckdb.connect(args.db, read_only=True)
    try:
        results, errors = forecast_batch(
            tickers, con, model, context_length, event_threshold,
            active_channels, device, target_date=target_date, target=target,
        )
    finally:
        con.close()

    # Single-ticker mode keeps its original flat output shape so existing
    # callers (and the renderer) are unaffected.
    if not batch_tickers:
        if errors:
            print(json.dumps({"error": errors[0]["error"]}), file=sys.stderr)
            sys.exit(1)
        print(json.dumps(results[0], indent=2))
        return

    print(json.dumps({
        "results": results,
        "errors": errors,
        "device": device,
        "count": len(results),
    }, indent=2))


if __name__ == "__main__":
    main()
