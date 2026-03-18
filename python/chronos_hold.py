"""
Chronos-2 Hold Period Forecasting

Uses amazon/chronos-bolt-small to forecast stock prices, then combines
with options features to compute an optimal hold period.

Input (JSON on stdin):
  {
    "prices": [close1, close2, ...],         # historical daily closes (oldest first)
    "options": {                              # current options metrics (optional)
      "putCallRatio": 0.85,
      "avgIV": 0.35,
      "ivSkew": 0.02,
      "unusualVolumeCount": 3,
      "convictionRatio": 1.2
    },
    "maxForwardDays": 60,
    "numSamples": 100
  }

Output (JSON on stdout):
  {
    "byDay": [
      { "day": 1, "medianReturn": 0.005, "p10Return": -0.02, "p90Return": 0.03,
        "probPositive": 0.62 },
      ...
    ],
    "peakDay": 12,
    "peakReturn": 0.045,
    "optionsAdjusted": {
      "byDay": [...],
      "peakDay": 8,
      "peakReturn": 0.038
    }
  }
"""

import sys
import json
import numpy as np
import torch

def load_model():
    """Load Chronos-2 (Bolt) model."""
    from chronos import BaseChronosPipeline
    pipeline = BaseChronosPipeline.from_pretrained(
        "amazon/chronos-bolt-small",
        device_map="cpu",
        torch_dtype=torch.float32,
    )
    return pipeline

def forecast(pipeline, prices, horizon, num_samples):
    """Generate probabilistic forecasts using Chronos-2."""
    context = torch.tensor(prices, dtype=torch.float32).unsqueeze(0)
    quantiles, mean = pipeline.predict_quantiles(
        context,
        prediction_length=horizon,
        quantile_levels=[0.1, 0.25, 0.5, 0.75, 0.9],
    )
    # quantiles shape: (1, horizon, 5) for [p10, p25, p50, p75, p90]
    # mean shape: (1, horizon)
    quantiles = quantiles.squeeze(0).numpy()
    mean = mean.squeeze(0).numpy()
    return quantiles, mean

def compute_hold_metrics(prices, quantiles, mean, max_days):
    """Compute return metrics for each hold day from Chronos forecasts."""
    last_price = prices[-1]
    by_day = []

    for day in range(min(max_days, len(mean))):
        p10 = float(quantiles[day, 0])
        p25 = float(quantiles[day, 1])
        p50 = float(quantiles[day, 2])
        p75 = float(quantiles[day, 3])
        p90 = float(quantiles[day, 4])
        m = float(mean[day])

        median_return = (p50 - last_price) / last_price
        mean_return = (m - last_price) / last_price
        p10_return = (p10 - last_price) / last_price
        p25_return = (p25 - last_price) / last_price
        p75_return = (p75 - last_price) / last_price
        p90_return = (p90 - last_price) / last_price

        # Probability of positive return: approximate from quantiles
        # Simple linear interpolation between quantile levels
        returns_at_quantiles = [p10_return, p25_return, median_return, p75_return, p90_return]
        quantile_levels = [0.1, 0.25, 0.5, 0.75, 0.9]
        prob_positive = 0.5  # default
        for i in range(len(returns_at_quantiles) - 1):
            if returns_at_quantiles[i] <= 0 <= returns_at_quantiles[i + 1]:
                # Linear interpolation
                span = returns_at_quantiles[i + 1] - returns_at_quantiles[i]
                if span > 0:
                    frac = (0 - returns_at_quantiles[i]) / span
                    prob_positive = 1.0 - (quantile_levels[i] + frac * (quantile_levels[i + 1] - quantile_levels[i]))
                break
        else:
            if returns_at_quantiles[0] > 0:
                prob_positive = 0.95
            elif returns_at_quantiles[-1] < 0:
                prob_positive = 0.05

        by_day.append({
            "day": day + 1,
            "medianReturn": round(median_return, 6),
            "meanReturn": round(mean_return, 6),
            "p10Return": round(p10_return, 6),
            "p25Return": round(p25_return, 6),
            "p75Return": round(p75_return, 6),
            "p90Return": round(p90_return, 6),
            "probPositive": round(prob_positive, 4),
            "forecastPrice": round(p50, 2),
        })

    return by_day

def options_adjust(by_day, options):
    """Adjust forecast returns using options market signals."""
    if not options:
        return None

    pcr = options.get("putCallRatio", 1.0)
    avg_iv = options.get("avgIV", 0.3)
    iv_skew = options.get("ivSkew", 0.0)
    unusual_vol = options.get("unusualVolumeCount", 0)
    conviction = options.get("convictionRatio", 1.0)

    # Sentiment score from options: negative = bearish, positive = bullish
    # High PCR = bearish, high IV = uncertainty, positive skew = bearish
    sentiment = 0.0
    sentiment -= (pcr - 1.0) * 0.3       # PCR > 1 is bearish
    sentiment -= iv_skew * 2.0            # positive skew (puts > calls IV) is bearish
    sentiment -= (unusual_vol / 10) * 0.1 # unusual activity adds uncertainty
    if conviction > 1.5:
        sentiment -= 0.1  # aggressive OTM activity = bearish signal
    elif conviction < 0.7:
        sentiment += 0.1  # conservative positioning = bullish

    # IV-based volatility scaling: high IV = widen range, scale down confidence
    iv_scale = max(0.5, min(2.0, avg_iv / 0.3))

    adjusted = []
    for d in by_day:
        # Shift median return by sentiment, scale spread by IV
        adj_median = d["medianReturn"] + sentiment * 0.001 * d["day"]
        adj_p10 = d["medianReturn"] - (d["medianReturn"] - d["p10Return"]) * iv_scale + sentiment * 0.001 * d["day"]
        adj_p90 = d["medianReturn"] + (d["p90Return"] - d["medianReturn"]) * iv_scale + sentiment * 0.001 * d["day"]

        # Adjusted probability
        adj_prob = max(0.02, min(0.98, d["probPositive"] + sentiment * 0.05))

        adjusted.append({
            "day": d["day"],
            "medianReturn": round(adj_median, 6),
            "p10Return": round(adj_p10, 6),
            "p90Return": round(adj_p90, 6),
            "probPositive": round(adj_prob, 4),
        })

    return adjusted

def main():
    data = json.load(sys.stdin)
    prices = data["prices"]
    options = data.get("options")
    max_days = data.get("maxForwardDays", 60)
    num_samples = data.get("numSamples", 100)

    if len(prices) < 30:
        print(json.dumps({"error": "Need at least 30 price observations"}))
        sys.exit(1)

    # Load model and forecast
    sys.stderr.write("Loading Chronos-2 model...\n")
    pipeline = load_model()

    sys.stderr.write(f"Forecasting {max_days} days from {len(prices)} observations...\n")
    quantiles, mean = forecast(pipeline, prices, max_days, num_samples)

    # Compute base metrics
    by_day = compute_hold_metrics(prices, quantiles, mean, max_days)

    # Find peak day (best risk-adjusted: median return * prob_positive)
    best_score = -float("inf")
    peak_day = 1
    peak_return = 0.0
    for d in by_day:
        score = d["medianReturn"] * d["probPositive"]
        if score > best_score:
            best_score = score
            peak_day = d["day"]
            peak_return = d["medianReturn"]

    result = {
        "byDay": by_day,
        "peakDay": peak_day,
        "peakReturn": peak_return,
        "lastPrice": prices[-1],
        "contextLength": len(prices),
    }

    # Options adjustment
    adj_by_day = options_adjust(by_day, options)
    if adj_by_day:
        adj_best = -float("inf")
        adj_peak_day = 1
        adj_peak_return = 0.0
        for d in adj_by_day:
            score = d["medianReturn"] * d["probPositive"]
            if score > adj_best:
                adj_best = score
                adj_peak_day = d["day"]
                adj_peak_return = d["medianReturn"]

        result["optionsAdjusted"] = {
            "byDay": adj_by_day,
            "peakDay": adj_peak_day,
            "peakReturn": adj_peak_return,
        }

    print(json.dumps(result))
    sys.stderr.write("Done.\n")

if __name__ == "__main__":
    main()
