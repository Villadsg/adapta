"""
IBM Granite Flowstate-R1 forecaster.

NOTE: Flowstate-R1 is **univariate only** — it accepts a single price channel
per series. Exogenous features (IV, event flags, volume, etc.) cannot be fed
to the model directly; they are handled by a post-hoc calibration layer in
the Node service instead.

Input (JSON on stdin):
{
  "requests": [
    {
      "id": "AAPL_2026-05-06",
      "series": [c1, c2, ..., cN],           # univariate close prices, oldest first
      "realized": <float|null>               # next-day realized close, for backtest scoring
    }, ...
  ],
  "scale_factor": 1.0,                       # daily bars; tune {0.5, 1.0, 2.0}
  "prediction_length": 1,
  "quantile_low_idx": 0,                     # 0=q10
  "quantile_high_idx": 8,                    # 8=q90
  "median_idx": 4                            # 4=q50
}

Output (JSON on stdout):
{
  "results": [
    {
      "id": "...",
      "quantiles": [q10, q20, ..., q90],     # for channel 0 (price), at the prediction step
      "low": <float>,
      "median": <float>,
      "high": <float>,
      "realized": <float|null>,
      "error": <float|null>                  # realized - median (if realized provided)
    }
  ],
  "model": "ibm-granite/granite-timeseries-flowstate-r1",
  "revision": "r1.1",
  "n_quantiles": 9,
  "context_length": <int>,
  "n_channels": <int>
}
"""

import sys
import json
import math

import numpy as np
import torch
from tsfm_public import FlowStateForPrediction


MODEL_ID = "ibm-granite/granite-timeseries-flowstate-r1"
REVISION = "r1.1"


def load_model(device: str):
    sys.stderr.write(f"Loading {MODEL_ID}@{REVISION} on {device}...\n")
    model = FlowStateForPrediction.from_pretrained(MODEL_ID, revision=REVISION).to(device)
    model.eval()
    return model


def build_batch(requests):
    """Stack univariate series into a (batch, context_length, 1) tensor.

    Flowstate's `FlowStateForPrediction` defaults to `batch_first=True`, so
    the batch dimension comes first. Truncates each request to the shortest
    common context length so all samples in the batch share dimensions.
    """
    if not requests:
        raise ValueError("requests is empty")

    context_length = min(len(r["series"]) for r in requests)
    if context_length < 32:
        raise ValueError(f"context_length too short: {context_length} (need >= 32)")

    batch = np.zeros((len(requests), context_length, 1), dtype=np.float32)
    for b, req in enumerate(requests):
        arr = np.asarray(req["series"], dtype=np.float32)
        batch[b, :, 0] = arr[-context_length:]
    return batch, context_length, 1


def main():
    payload = json.load(sys.stdin)
    requests = payload.get("requests") or []
    scale_factor = float(payload.get("scale_factor", 1.0))
    prediction_length = int(payload.get("prediction_length", 1))
    q_low = int(payload.get("quantile_low_idx", 0))
    q_high = int(payload.get("quantile_high_idx", 8))
    q_med = int(payload.get("median_idx", 4))

    if not requests:
        print(json.dumps({"error": "no requests"}))
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        model = load_model(device)
    except Exception as e:
        print(json.dumps({"error": f"model load failed: {e}"}))
        sys.exit(1)

    try:
        batch_np, context_length, n_channels = build_batch(requests)  # n_channels always 1
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    series = torch.from_numpy(batch_np).to(device)

    sys.stderr.write(
        f"Forecasting batch={len(requests)} ctx={context_length} "
        f"channels={n_channels} pred_len={prediction_length}...\n"
    )

    with torch.no_grad():
        out = model(
            series,
            scale_factor=scale_factor,
            prediction_length=prediction_length,
            batch_first=True,
        )

    # quantile_outputs: (batch, quantiles, prediction_length, n_channels)
    pred = out.quantile_outputs.detach().cpu().float().numpy()
    n_q = pred.shape[1]

    results = []
    for b, req in enumerate(requests):
        # Take target channel (0) at the last forecast step.
        step = prediction_length - 1
        q_vals = pred[b, :, step, 0].tolist()
        # Defensive bounds in case the caller picked an out-of-range index.
        lo = q_vals[max(0, min(n_q - 1, q_low))]
        hi = q_vals[max(0, min(n_q - 1, q_high))]
        med = q_vals[max(0, min(n_q - 1, q_med))]

        realized = req.get("realized")
        err = None
        if realized is not None and isinstance(realized, (int, float)) and not math.isnan(realized):
            err = float(realized) - float(med)

        results.append({
            "id": req.get("id"),
            "quantiles": [round(v, 6) for v in q_vals],
            "low": round(lo, 6),
            "median": round(med, 6),
            "high": round(hi, 6),
            "realized": realized,
            "error": round(err, 6) if err is not None else None,
        })

    print(json.dumps({
        "results": results,
        "model": MODEL_ID,
        "revision": REVISION,
        "n_quantiles": int(n_q),
        "context_length": int(context_length),
        "n_channels": int(n_channels),
        "scale_factor": scale_factor,
        "prediction_length": prediction_length,
        "device": device,
    }))


if __name__ == "__main__":
    main()
