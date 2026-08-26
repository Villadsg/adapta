"""
Back-test the fine-tuned TTM-R3 event-classification model against held-out samples.

Also computes naive baselines for comparison:
- all-negative (always predict no event)
- yesterday-repeats (predict event if yesterday was an event)
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from tsfm_public import TinyTimeMixerConfig

# Make sibling python modules importable.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from ttm_event_dataset import CHANNELS
from ttm_event_finetune import EventClassificationDataset, TTMEventClassifier


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


def main():
    parser = argparse.ArgumentParser(description="Back-test TTM-R3 event classification model")
    parser.add_argument("--test", default="data/ttm-events/test.jsonl")
    parser.add_argument("--model", default="python/models/ttm-event-r3/final")
    parser.add_argument("--output", default="python/models/ttm-event-r3/backtest.json")
    args = parser.parse_args()

    ds = EventClassificationDataset(args.test)
    if len(ds) == 0:
        print("No test samples.", file=sys.stderr)
        sys.exit(1)

    config = TinyTimeMixerConfig.from_pretrained(args.model)
    config.num_input_channels = len(CHANNELS)
    config.exogenous_channel_indices = list(range(1, len(CHANNELS)))
    model = TTMEventClassifier(config)

    state_path = Path(args.model) / "pytorch_model.bin"
    if not state_path.exists():
        state_path = Path(args.model) / "model.safetensors"
    with torch.no_grad():
        model(past_values=torch.zeros(1, config.context_length, len(CHANNELS)))
    model.load_state_dict(torch.load(state_path, map_location="cpu", weights_only=True))
    model.eval()

    probs = []
    labels = []
    yesterday_event = []
    samples_meta = []

    with torch.no_grad():
        for i in range(len(ds)):
            sample = ds[i]
            past = sample["past_values"].unsqueeze(0)
            label = int(sample["labels"].item())

            out = model(past_values=past)
            logit = float(out["logits"].squeeze().cpu().item())
            prob = 1.0 / (1.0 + np.exp(-logit))

            probs.append(prob)
            labels.append(label)

            # Naive baseline: was yesterday (last timestep) an event?
            yesterday_event.append(int(past[0, -1, 0] >= 0.0))  # log_event_magnitude >= 0 means any magnitude

            samples_meta.append({"idx": i, "prob": round(prob, 4), "label": label})

    model_metrics = metrics(probs, labels)
    all_neg_metrics = metrics(np.zeros_like(labels), labels)
    yesterday_metrics = metrics(np.array(yesterday_event), np.array(labels))

    result = {
        "n_samples": len(ds),
        "positives": int(sum(labels)),
        "model": model_metrics,
        "all_negative_baseline": all_neg_metrics,
        "yesterday_repeats_baseline": yesterday_metrics,
        "samples": samples_meta[:20],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
