"""
Fine-tune IBM Granite TTM-R3 backbone for next-day "big event" binary classification.

A "big event" is defined globally (top 20% of training-set event magnitudes).
The model outputs a single logit and is trained with weighted BCE.

Reads JSONL datasets produced by `ttm_event_dataset.py` and writes a
fine-tuned checkpoint to `python/models/ttm-event-r3/`.

Run:
    python/venv-ttm/bin/python python/ttm_event_finetune.py \
        --train data/ttm-events/train.jsonl \
        --val data/ttm-events/val.jsonl \
        --test data/ttm-events/test.jsonl
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset
from transformers import EarlyStoppingCallback, Trainer, TrainingArguments

from tsfm_public import TinyTimeMixerConfig, TinyTimeMixerModel


DEFAULT_MODEL_ID = "ibm-granite/granite-timeseries-ttm-r3"


class EventClassificationDataset(Dataset):
    """PyTorch dataset from TTM event-classification JSONL samples."""

    def __init__(self, jsonl_path: str, pos_repeat: int = 1):
        self.samples = []
        with open(jsonl_path, "r") as f:
            for line in f:
                s = json.loads(line)
                self.samples.append(s)
                if s.get("label") == 1 and pos_repeat > 1:
                    self.samples.extend([s] * (pos_repeat - 1))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        s = self.samples[idx]
        past = torch.tensor(s["context"]["values"], dtype=torch.float32)
        label = torch.tensor(s["label"], dtype=torch.float32)
        return {
            "past_values": past,
            "labels": label,
        }


class TTMEventClassifier(nn.Module):
    """TTM-R3 encoder + MLP classification head for event probability."""

    def __init__(self, config: TinyTimeMixerConfig, head_hidden: int = 128, dropout: float = 0.3,
                 loss_type: str = "bce", pos_weight: float = 1.0, focal_alpha: float = 0.25,
                 focal_gamma: float = 2.0):
        super().__init__()
        self.config = config
        self.loss_type = loss_type
        self.pos_weight = pos_weight
        self.focal_alpha = focal_alpha
        self.focal_gamma = focal_gamma
        self.backbone = TinyTimeMixerModel(config)

        # Flatten the full encoder output instead of mean-pooling to preserve more signal.
        self.head = nn.Sequential(
            nn.Flatten(start_dim=1),
            nn.Dropout(dropout),
            nn.LazyLinear(head_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(head_hidden, 1),
        )

    def forward(self, past_values, labels=None, **kwargs):
        # Remove keys the backbone doesn't accept
        kwargs.pop("num_items_in_batch", None)

        outputs = self.backbone(past_values, **kwargs)
        # outputs.last_hidden_state: (batch, num_channels, num_patches, d_model)
        logits = self.head(outputs.last_hidden_state).squeeze(-1)  # (batch,)

        loss = None
        if labels is not None:
            labels = labels.float()
            if self.loss_type == "focal":
                loss = self._focal_loss(logits, labels)
            else:
                loss = self._bce_loss(logits, labels)

        return {"loss": loss, "logits": logits} if loss is not None else {"logits": logits}

    def _bce_loss(self, logits, labels):
        pos_weight = torch.tensor(self.pos_weight, dtype=torch.float32, device=logits.device)
        return nn.functional.binary_cross_entropy_with_logits(logits, labels, pos_weight=pos_weight)

    def _focal_loss(self, logits, labels):
        """Focal loss for binary classification."""
        bce = nn.functional.binary_cross_entropy_with_logits(logits, labels, reduction='none')
        probs = torch.sigmoid(logits)
        p_t = probs * labels + (1 - probs) * (1 - labels)
        alpha_t = self.focal_alpha * labels + (1 - self.focal_alpha) * (1 - labels)
        loss = (alpha_t * (1 - p_t) ** self.focal_gamma * bce).mean()
        return loss





def compute_metrics(eval_pred):
    """Compute classification metrics on the validation/test set."""
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score

    predictions, labels = eval_pred
    if isinstance(predictions, tuple):
        predictions = predictions[0]
    if isinstance(labels, tuple) and len(labels) > 0:
        labels = labels[0]

    pred = 1.0 / (1.0 + np.exp(-np.asarray(predictions).flatten()))
    labels = np.asarray(labels).flatten().astype(int)

    pred_bin = (pred >= 0.5).astype(int)
    auroc = roc_auc_score(labels, pred) if len(np.unique(labels)) > 1 else 0.0

    return {
        "accuracy": round(float(accuracy_score(labels, pred_bin)), 6),
        "precision": round(float(precision_score(labels, pred_bin, zero_division=0)), 6),
        "recall": round(float(recall_score(labels, pred_bin, zero_division=0)), 6),
        "f1": round(float(f1_score(labels, pred_bin, zero_division=0)), 6),
        "auroc": round(float(auroc), 6),
    }


def load_config(args) -> TinyTimeMixerConfig:
    """Build a TTM-R3 config customized for event classification."""
    config = TinyTimeMixerConfig.from_pretrained(args.model_id)

    config.context_length = args.context_length
    config.prediction_length = args.prediction_length
    config.num_input_channels = args.num_channels
    # Channel 0 is the historical target variable (log event magnitude);
    # remaining channels are exogenous covariates.
    config.exogenous_channel_indices = list(range(1, args.num_channels))
    config.scaling = args.scaling

    # If the requested lengths are not compatible with the pretrained patch settings,
    # fall back to patch_length=1 so the model can still load (patch layers reinitialize).
    if args.context_length % config.patch_length != 0 or args.prediction_length % config.patch_length != 0:
        print(
            f"Lengths ({args.context_length}, {args.prediction_length}) not divisible by patch_length "
            f"({config.patch_length}); setting patch_length=patch_stride=1. "
            "Patch-specific pretrained weights will be reinitialized.",
            file=sys.stderr,
        )
        config.patch_length = 1
        config.patch_stride = 1

    return config


def main():
    parser = argparse.ArgumentParser(description="Fine-tune TTM-R3 for event classification")
    parser.add_argument("--train", default="data/ttm-events/train.jsonl")
    parser.add_argument("--val", default="data/ttm-events/val.jsonl")
    parser.add_argument("--test", default="data/ttm-events/test.jsonl")
    parser.add_argument("--stats", default="data/ttm-events/stats.json")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--output-dir", default="python/models/ttm-event-r3")
    parser.add_argument("--context-length", type=int, default=36)
    parser.add_argument("--prediction-length", type=int, default=1)
    parser.add_argument("--num-channels", type=int, default=None,
                        help="Number of input channels (default: read from stats.json)")
    # "none" by default: the target (volume x |return|) is driven by the ABSOLUTE
    # level of recent event magnitude, and per-window std scaling normalizes that
    # level away. Empirically scaling="std" costs ~0.20 AUROC (0.62 vs 0.83).
    parser.add_argument("--scaling", default="none", choices=["none", "std", "mean"])
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-2)
    parser.add_argument("--head-hidden", type=int, default=128)
    parser.add_argument("--dropout", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--pos-oversample", type=int, default=3,
                        help="Repeat positive training samples this many times")
    parser.add_argument("--loss", choices=["bce", "focal"], default="bce",
                        help="Classification loss function")
    parser.add_argument("--pos-weight", type=float, default=None,
                        help="BCE positive-class weight (default: sqrt(neg/pos) from stats)")
    parser.add_argument("--focal-alpha", type=float, default=0.25,
                        help="Focal-loss weight for the positive class")
    parser.add_argument("--focal-gamma", type=float, default=2.0,
                        help="Focal-loss focusing parameter")
    parser.add_argument("--pretrained", action=argparse.BooleanOptionalAction, default=False,
                        help="Initialize backbone from pretrained TTM-R3 weights")
    parser.add_argument("--freeze-backbone", action=argparse.BooleanOptionalAction, default=False,
                        help="Freeze backbone and train only the classification head")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    if not os.path.exists(args.train):
        print(f"Train file not found: {args.train}", file=sys.stderr)
        sys.exit(1)

    # Load class weight and channel count from dataset stats.
    bce_pos_weight = 1.0
    if os.path.exists(args.stats):
        with open(args.stats, "r") as f:
            stats = json.load(f)
            bce_pos_weight = stats.get("bce_pos_weight", 1.0)
            if args.num_channels is None:
                args.num_channels = stats.get("n_channels", 7)
                print(f"Loaded num_channels={args.num_channels} from {args.stats}")
        print(f"Loaded bce_pos_weight={bce_pos_weight:.3f} from {args.stats}")

    if args.num_channels is None:
        args.num_channels = 7

    pos_weight = args.pos_weight if args.pos_weight is not None else bce_pos_weight

    train_ds = EventClassificationDataset(args.train, pos_repeat=args.pos_oversample)
    val_ds = EventClassificationDataset(args.val)
    test_ds = EventClassificationDataset(args.test)
    print(f"Loaded train={len(train_ds)} val={len(val_ds)} test={len(test_ds)}")

    config = load_config(args)
    print("Loading model...")
    model = TTMEventClassifier(
        config,
        head_hidden=args.head_hidden,
        dropout=args.dropout,
        loss_type=args.loss,
        pos_weight=pos_weight,
        focal_alpha=args.focal_alpha,
        focal_gamma=args.focal_gamma,
    )

    # Initialize LazyLinear head with a dummy forward pass so parameter counts work.
    with torch.no_grad():
        model(past_values=torch.zeros(1, args.context_length, args.num_channels))

    if args.pretrained:
        pretrained = TinyTimeMixerModel.from_pretrained(args.model_id, config=config, ignore_mismatched_sizes=True)
        model.backbone.load_state_dict(pretrained.state_dict(), strict=False)
        print("Initialized backbone from pretrained TTM-R3 (patch/input layers reinitialized if lengths changed).")
    else:
        print("Training backbone from scratch.")

    if args.freeze_backbone:
        for param in model.backbone.parameters():
            param.requires_grad = False
        print("Backbone frozen; only head is trainable.")

    print(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")
    print(f"Trainable parameters: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=str(output_dir),
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        weight_decay=args.weight_decay,
        logging_dir=str(output_dir / "logs"),
        logging_strategy="epoch",
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="eval_auroc",
        greater_is_better=True,
        seed=args.seed,
        remove_unused_columns=False,
        report_to="none",
        max_grad_norm=1.0,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=5)],
    )

    print("Starting training...")
    trainer.train()

    print("\nEvaluating on test set...")
    test_results = trainer.evaluate(test_ds)
    print(json.dumps(test_results, indent=2))

    # Save final model and config
    trainer.save_model(str(output_dir / "final"))
    torch.save(model.state_dict(), output_dir / "final" / "pytorch_model.bin")
    config.save_pretrained(output_dir / "final")

    with open(output_dir / "training_info.json", "w") as f:
        json.dump({
            "model_id": args.model_id,
            "context_length": args.context_length,
            "prediction_length": args.prediction_length,
            "num_channels": args.num_channels,
            "scaling": args.scaling,
            "pos_oversample": args.pos_oversample,
            "pretrained": args.pretrained,
            "head_hidden": args.head_hidden,
            "loss_type": args.loss,
            "pos_weight": pos_weight,
            "focal_alpha": args.focal_alpha,
            "focal_gamma": args.focal_gamma,
            "test_results": test_results,
        }, f, indent=2)

    print(f"\nModel saved to {output_dir / 'final'}")


if __name__ == "__main__":
    main()
