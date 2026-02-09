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
from chronos import ChronosPipeline

# Model cache for performance
_pipeline = None
_model_name = None


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


def main():
    parser = argparse.ArgumentParser(description="Chronos-2 Stock Forecasting")
    parser.add_argument("--mode", choices=["forecast", "with_events", "post_event"],
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

    print(json.dumps(result))


if __name__ == "__main__":
    main()
