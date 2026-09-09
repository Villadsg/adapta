"""Zero-shot back-test of google/timesfm-3.0-pytorch, MULTIVARIATE variant.

NOTE: TimesFM 3.0 pretrained weights are licensed under the
`timesfm-non-commercial-license-v1.0` (non-commercial, non-production use only).

Parallel experiment to python/timesfm_event_backtest.py: instead of feeding
only the log_event_magnitude series, the target (channel 0) is forecast with
TimesFM 3.0's native covariate support -- the remaining channels (price/volume
+ call AND put options IV/DV ranks + DTE logs + options_missing) are passed as
past_only_covariates. Scoring is identical: P(event) from the target's
1-step-ahead quantile forecast vs T_log = log1p(event_threshold).

Uses data/ttm-events-full/test_aligned.jsonl: full-channel contexts rebuilt
from the current DB, aligned to the original data/ttm-events/test.jsonl sample
ids, labels and threshold so results are directly comparable to the univariate
TimesFM run and the fine-tuned TTM classifier.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score

from timesfm3 import ModelConfig, TimesFM3Evaluator


def metrics(probs, labels):
    probs = np.asarray(probs).flatten()
    labels = np.asarray(labels).flatten().astype(int)
    preds = (probs >= 0.5).astype(int)

    return {
        "accuracy": round(float(accuracy_score(labels, preds)), 6),
        "precision": round(float(precision_score(labels, preds, zero_division=0)), 6),
        "recall": round(float(recall_score(labels, preds, zero_division=0)), 6),
        "f1": round(float(f1_score(labels, preds, zero_division=0)), 6),
        "auroc": round(float(roc_auc_score(labels, probs)), 6) if len(np.unique(labels)) > 1 else 0.0,
    }


def prob_above_threshold(quantile_values, quantile_levels, t_log):
    """Estimate P(X >= t_log) by linear interpolation of the predicted quantiles."""
    cdf = np.interp(t_log, quantile_values, quantile_levels)
    return float(1.0 - cdf)


def main():
    parser = argparse.ArgumentParser(description="Zero-shot TimesFM 3.0 multivariate event back-test")
    parser.add_argument("--test", default="data/ttm-events-full/test_aligned.jsonl")
    parser.add_argument("--stats", default="data/ttm-events/stats.json",
                        help="stats.json carrying the event_threshold the labels were built with")
    parser.add_argument("--output", default="python/models/timesfm-3.0-event-multivariate/backtest.json")
    parser.add_argument("--checkpoint", default="google/timesfm-3.0-pytorch")
    parser.add_argument("--batch-size", type=int, default=256)
    args = parser.parse_args()

    stats = json.loads(Path(args.stats).read_text())
    event_threshold = float(stats["event_threshold"])
    t_log = float(np.log1p(event_threshold))

    samples = []
    with open(args.test) as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    if not samples:
        raise SystemExit("No test samples.")

    # Target: channel 0 (log_event_magnitude). Covariates: all other channels,
    # shaped (n_covariates, context_length) per TimesFM 3.0's past_only API.
    contexts = []
    covariates = []
    for s in samples:
        values = np.asarray(s["context"]["values"], dtype=np.float32)  # (36, n_channels)
        contexts.append(values[:, 0])
        covariates.append(values[:, 1:].T.copy())
    labels = np.array([int(s["label"]) for s in samples], dtype=int)
    yesterday_event = np.array([int(ctx[-1] >= 0.0) for ctx in contexts], dtype=int)

    config = ModelConfig(
        checkpoint_path=args.checkpoint,
        per_core_batch_size=32,
        device="cuda" if _cuda_available() else "cpu",
    )
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)
    median_idx = int(config.median_quantile_index)

    probs = np.zeros(len(samples))
    pred_median_mag = np.zeros(len(samples))
    pred_mean_mag = np.zeros(len(samples))

    t0 = time.time()
    for start in range(0, len(samples), args.batch_size):
        end = min(start + args.batch_size, len(samples))
        outputs = list(
            forecaster.predict_batch(
                contexts=contexts[start:end],
                horizon=1,
                past_only_covariates=covariates[start:end],
                return_quantiles=True,
                use_symmetric_averaging=False,
            )
        )
        for j, out in enumerate(outputs):
            q = np.asarray(out.quantiles, dtype=float)[0]  # (n_quantiles,) at horizon 1
            i = start + j
            probs[i] = prob_above_threshold(q, quantile_levels, t_log)
            pred_median_mag[i] = float(np.expm1(q[median_idx]))
            pred_mean_mag[i] = float(np.mean(np.expm1(q)))
        print(f"  [{end}/{len(samples)}] {time.time() - t0:.1f}s", flush=True)

    target_log_mag = np.array([float(np.log1p(s["target_raw"])) for s in samples])

    model_metrics = metrics(probs, labels)
    all_neg_metrics = metrics(np.zeros_like(labels), labels)
    yesterday_metrics = metrics(yesterday_event, labels)

    result = {
        "checkpoint": args.checkpoint,
        "zero_shot": True,
        "mode": "multivariate_past_covariates",
        "n_target_series": 1,
        "n_past_covariates": int(covariates[0].shape[0]),
        "covariate_channels": json.loads(Path("data/ttm-events-full/stats.json").read_text())["channels"][1:],
        "n_samples": int(len(samples)),
        "positives": int(labels.sum()),
        "event_threshold": event_threshold,
        "t_log": t_log,
        "model": model_metrics,
        "all_negative_baseline": all_neg_metrics,
        "yesterday_repeats_baseline": yesterday_metrics,
        "calibration": {
            "mean_predicted_median_magnitude": round(float(np.mean(pred_median_mag)), 4),
            "mean_predicted_mean_magnitude": round(float(np.mean(pred_mean_mag)), 4),
            "mean_actual_magnitude": round(float(np.mean([s["target_raw"] for s in samples])), 4),
            "mean_absolute_log_error": round(
                float(np.mean(np.abs(np.log1p(pred_median_mag) - target_log_mag))), 6
            ),
        },
        "samples": [
            {
                "id": s["id"],
                "prob": round(float(probs[i]), 4),
                "pred_median_magnitude": round(float(pred_median_mag[i]), 2),
                "label": int(labels[i]),
            }
            for i, s in enumerate(samples[:20])
        ],
        "runtime_seconds": round(time.time() - t0, 1),
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result, indent=2))


def _cuda_available():
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


if __name__ == "__main__":
    main()
