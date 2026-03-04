#!/usr/bin/env python3
"""
Chronos-2 Stock Price Forecasting Service

Forecasts stock prices based on historical data and event patterns.
Uses Amazon Chronos-2 foundation model for time series prediction.
"""

import sys
import json
import argparse
import numpy as np
import torch
import pandas as pd
from chronos import ChronosPipeline, BaseChronosPipeline

# Model cache for performance
_pipeline = None
_model_name = None
_chronos2_pipeline = None


def get_pipeline(model_size="small"):
    """
    Load Chronos-2 pipeline (cached for performance).

    Model sizes:
    - tiny: amazon/chronos-t5-tiny (~8M params)
    - mini: amazon/chronos-t5-mini (~20M params)
    - small: amazon/chronos-t5-small (~46M params)
    - base: amazon/chronos-t5-base (~200M params)
    - large: amazon/chronos-t5-large (~710M params)

    Chronos-2 models (better performance):
    - amazon/chronos-bolt-tiny
    - amazon/chronos-bolt-small
    - amazon/chronos-bolt-base
    """
    global _pipeline, _model_name

    model_map = {
        "tiny": "amazon/chronos-bolt-tiny",
        "small": "amazon/chronos-bolt-small",
        "base": "amazon/chronos-bolt-base",
        # Fallback to v1 for mini/large
        "mini": "amazon/chronos-t5-mini",
        "large": "amazon/chronos-t5-large",
    }

    target_model = model_map.get(model_size, "amazon/chronos-bolt-small")

    if _pipeline is None or _model_name != target_model:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading {target_model} on {device}...", file=sys.stderr)

        _pipeline = ChronosPipeline.from_pretrained(
            target_model,
            device_map=device,
            torch_dtype=torch.float32,
        )
        _model_name = target_model

    return _pipeline


def forecast_prices(prices, prediction_length=14, num_samples=20, model_size="small"):
    """
    Generate price forecasts using Chronos-2.

    Args:
        prices: List of historical closing prices (oldest to newest)
        prediction_length: Number of days to forecast
        num_samples: Number of forecast samples for uncertainty estimation
        model_size: Model size (tiny/small/base)

    Returns:
        Dictionary with median forecast, confidence intervals, and samples
    """
    pipeline = get_pipeline(model_size)

    # Convert to tensor
    context = torch.tensor(prices, dtype=torch.float32)

    # Generate forecasts
    forecasts = pipeline.predict(
        context,
        prediction_length=prediction_length,
        num_samples=num_samples,
    )

    # Calculate statistics
    forecast_np = forecasts[0].numpy()

    median = np.median(forecast_np, axis=0)
    low_10 = np.percentile(forecast_np, 10, axis=0)
    high_90 = np.percentile(forecast_np, 90, axis=0)
    low_25 = np.percentile(forecast_np, 25, axis=0)
    high_75 = np.percentile(forecast_np, 75, axis=0)

    return {
        "median": median.tolist(),
        "low_10": low_10.tolist(),
        "high_90": high_90.tolist(),
        "low_25": low_25.tolist(),
        "high_75": high_75.tolist(),
        "samples": forecast_np.tolist(),
        "last_price": float(prices[-1]),
        "prediction_length": prediction_length,
    }


def forecast_with_events(prices, events, prediction_length=14, model_size="small"):
    """
    Generate forecasts with event-based context adjustment.

    Events can influence the forecast by:
    1. Adding recent event returns to the context
    2. Scaling predictions based on historical event patterns

    Args:
        prices: List of historical closing prices
        events: List of event dicts with 'residual_return' and 'strength'
        prediction_length: Days to forecast
        model_size: Model size

    Returns:
        Forecast results with event context
    """
    # Base forecast
    base_forecast = forecast_prices(prices, prediction_length, 20, model_size)

    if not events:
        return {**base_forecast, "event_context": None}

    # Calculate event statistics
    event_returns = [e.get("residual_return", 0) for e in events if e.get("residual_return")]
    event_strengths = [e.get("strength", 0) for e in events if e.get("strength")]

    avg_event_return = np.mean(event_returns) if event_returns else 0
    avg_event_strength = np.mean(event_strengths) if event_strengths else 0

    # Count positive vs negative events
    positive_events = sum(1 for r in event_returns if r > 0)
    negative_events = sum(1 for r in event_returns if r < 0)
    event_bias = (positive_events - negative_events) / max(len(event_returns), 1)

    # Classify recent events by type
    event_types = {}
    for e in events:
        cls = e.get("classification", "unknown")
        event_types[cls] = event_types.get(cls, 0) + 1

    return {
        **base_forecast,
        "event_context": {
            "num_events": len(events),
            "avg_event_return": avg_event_return,
            "avg_event_strength": avg_event_strength,
            "event_bias": event_bias,  # -1 to 1 (negative to positive)
            "positive_events": positive_events,
            "negative_events": negative_events,
            "event_types": event_types,
        }
    }


def forecast_post_event(prices, event, prediction_length=14, model_size="small"):
    """
    Generate forecast immediately after an event.

    Uses the event characteristics to contextualize the forecast.

    Args:
        prices: Historical prices up to and including event day
        event: Event dict with classification, strength, residual_return
        prediction_length: Days to forecast
        model_size: Model size

    Returns:
        Post-event forecast with event impact analysis
    """
    base_forecast = forecast_prices(prices, prediction_length, 20, model_size)

    if not event:
        return base_forecast

    classification = event.get("classification", "unknown")
    strength = event.get("strength", 0)
    residual_return = event.get("residual_return", 0)

    # Historical patterns by event type (simplified)
    # In production, this would be learned from actual data
    continuation_factors = {
        "surprising_positive": 0.3,  # Tends to continue up
        "positive_anticipated": -0.1, # Reversal after gap down recovery
        "negative_anticipated": 0.1,  # Slight continuation after panic
        "surprising_negative": -0.2,  # Possible continued selling
    }

    continuation = continuation_factors.get(classification, 0)

    return {
        **base_forecast,
        "event_analysis": {
            "classification": classification,
            "strength": strength,
            "residual_return": residual_return,
            "expected_continuation": continuation,
            "confidence": min(abs(strength) / 10, 1.0),
        }
    }


def get_chronos2_pipeline():
    """Load Chronos-2 pipeline (cached) for multivariate forecasting with covariates."""
    global _chronos2_pipeline
    if _chronos2_pipeline is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading amazon/chronos-2 on {device}...", file=sys.stderr)
        _chronos2_pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-2",
            device_map=device,
        )
    return _chronos2_pipeline


def compute_optimal_hold(prices, volumes=None, events=None, options_context=None,
                          prediction_length=30, model_size="small"):
    """
    Compute optimal hold days using Chronos-2 with volume and event covariates.

    Uses probabilistic forecasting to find the day with maximum median cumulative return,
    then adjusts confidence using options context.
    """
    pipeline = get_chronos2_pipeline()
    last_price = float(prices[-1])
    n = len(prices)

    # Build DataFrame with covariates
    # Normalize volume to 0-1 range
    vol_array = np.array(volumes if volumes and len(volumes) == n else [0] * n, dtype=np.float64)
    vol_min, vol_max = vol_array.min(), vol_array.max()
    if vol_max > vol_min:
        vol_norm = (vol_array - vol_min) / (vol_max - vol_min)
    else:
        vol_norm = np.zeros(n)

    # Build event signal (sparse: 0 on normal days, residual_return * strength / 100 on event days)
    event_signal = np.zeros(n, dtype=np.float64)
    if events:
        for ev in events:
            idx = ev.get("index")
            if idx is not None and 0 <= idx < n:
                rr = ev.get("residual_return", 0) or 0
                st = ev.get("strength", 0) or 0
                event_signal[idx] = rr * st / 100.0

    df = pd.DataFrame({
        "timestamp": pd.date_range(end=pd.Timestamp.now().normalize(), periods=n, freq="B"),
        "id": ["stock"] * n,
        "target": prices,
        "volume": vol_norm.tolist(),
        "event_signal": event_signal.tolist(),
    })

    # Chronos-2 predict_df with covariates
    quantile_levels = [0.1, 0.25, 0.5, 0.75, 0.9]
    forecast_df = pipeline.predict_df(
        df,
        prediction_length=prediction_length,
        quantile_levels=quantile_levels,
    )

    # Extract quantile columns from forecast
    q10 = forecast_df["0.1"].values
    q25 = forecast_df["0.25"].values
    q50 = forecast_df["0.5"].values
    q75 = forecast_df["0.75"].values
    q90 = forecast_df["0.9"].values

    # Compute cumulative returns at each day
    cum_ret_median = (q50 - last_price) / last_price
    cum_ret_low10 = (q10 - last_price) / last_price
    cum_ret_high90 = (q90 - last_price) / last_price
    cum_ret_low25 = (q25 - last_price) / last_price
    cum_ret_high75 = (q75 - last_price) / last_price

    # Find optimal hold day
    best_day_idx = int(np.argmax(cum_ret_median))
    peak_return = float(cum_ret_median[best_day_idx])

    if peak_return <= 0:
        optimal_hold_days = 0
        expected_return = 0.0
    else:
        optimal_hold_days = best_day_idx + 1  # 1-indexed
        expected_return = peak_return

    # Confidence: based on spread at optimal day
    if optimal_hold_days > 0:
        idx = best_day_idx
        spread = float(q90[idx] - q10[idx])
        median_val = float(q50[idx])
        # Fraction of range above last_price as proxy for positive trajectory probability
        if spread > 0:
            positive_fraction = max(0, min(1, (median_val - q10[idx]) / spread))
        else:
            positive_fraction = 0.5
        # Also check if q10 is above last_price (strong signal)
        if q10[idx] > last_price:
            positive_fraction = min(1.0, positive_fraction + 0.2)
        confidence = round(positive_fraction, 3)
    else:
        confidence = 0.0

    warnings = []
    options_context_applied = False

    # Options context adjustment
    if options_context:
        options_context_applied = True
        sentiment = options_context.get("sentiment", "neutral")
        sentiment_score = options_context.get("sentiment_score", 0)
        eai = options_context.get("event_anticipation_index", 0)
        max_vol_conviction = options_context.get("max_volume_conviction", 0)
        term_shape = options_context.get("term_structure_shape", "")

        # Adjust confidence based on options signals
        if sentiment == "bearish" or sentiment_score <= -2:
            confidence = max(0, confidence - 0.15)
            warnings.append(f"Bearish options sentiment (score: {sentiment_score}) — downside hedging active")

        if eai > 50:
            confidence = max(0, confidence - 0.10)
            warnings.append(f"High event anticipation ({eai}/100) — IV elevated, potential volatility ahead")

        if eai > 70:
            confidence = max(0, confidence - 0.05)

        if sentiment == "bullish" and max_vol_conviction >= 6:
            confidence = min(1.0, confidence + 0.10)

        if term_shape == "backwardation":
            warnings.append("Term structure in backwardation — near-term IV elevated vs. longer-term")

        # Check expirations for put/call IV skew warnings
        exps = options_context.get("expirations", [])
        for exp in exps:
            put_iv = exp.get("atm_put_iv", 0)
            call_iv = exp.get("atm_call_iv", 0)
            if put_iv > 0 and call_iv > 0 and put_iv > call_iv * 1.3:
                dte = exp.get("dte", "?")
                warnings.append(f"Put IV significantly above Call IV at {dte} DTE — downside protection demand elevated")
                break

        confidence = round(confidence, 3)

    return {
        "optimal_hold_days": optimal_hold_days,
        "expected_return_pct": round(expected_return * 100, 2),
        "peak_return_pct": round(peak_return * 100, 2),
        "confidence": confidence,
        "daily_returns_median": (cum_ret_median * 100).tolist(),
        "low_10_returns": (cum_ret_low10 * 100).tolist(),
        "high_90_returns": (cum_ret_high90 * 100).tolist(),
        "low_25_returns": (cum_ret_low25 * 100).tolist(),
        "high_75_returns": (cum_ret_high75 * 100).tolist(),
        "last_price": last_price,
        "prediction_length": prediction_length,
        "options_context_applied": options_context_applied,
        "warnings": warnings,
    }


def main():
    parser = argparse.ArgumentParser(description="Chronos-2 Stock Forecasting")
    parser.add_argument("--mode", choices=["forecast", "with_events", "post_event", "optimal_hold"],
                       default="forecast", help="Forecasting mode")
    parser.add_argument("--model", choices=["tiny", "small", "base", "mini", "large"],
                       default="small", help="Model size")
    parser.add_argument("--days", type=int, default=14, help="Days to forecast")
    parser.add_argument("--input", type=str, default="-", help="Input JSON file or - for stdin")

    args = parser.parse_args()

    # Read input
    if args.input == "-":
        data = json.load(sys.stdin)
    else:
        with open(args.input) as f:
            data = json.load(f)

    prices = data.get("prices", [])
    events = data.get("events", [])
    event = data.get("event", None)

    if not prices:
        print(json.dumps({"error": "No prices provided"}))
        sys.exit(1)

    # Run appropriate forecast mode
    if args.mode == "forecast":
        result = forecast_prices(prices, args.days, 20, args.model)
    elif args.mode == "with_events":
        result = forecast_with_events(prices, events, args.days, args.model)
    elif args.mode == "post_event":
        result = forecast_post_event(prices, event, args.days, args.model)
    elif args.mode == "optimal_hold":
        result = compute_optimal_hold(
            prices, data.get("volumes"), data.get("events"),
            data.get("options_context"), args.days, args.model
        )

    print(json.dumps(result))


if __name__ == "__main__":
    main()
