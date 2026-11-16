"""Head-to-head zero-shot trial: Timestral-209M vs TimesFM 3.0.

Builds walk-forward samples with the Model Lab's own builder (identical
features, centering, labels, and thresholds), scores both models on the exact
same samples for both targets, and reports the lab's metrics side by side.

Run:
    python/venv-ttm/bin/python python/timestral_trial.py --db /tmp/adapta_trial.db
"""

import argparse
import json
import time
from pathlib import Path

import duckdb
import numpy as np
import torch

from timesfm3 import ModelConfig, TimesFM3Evaluator
from timestral import TimestralForecaster

from timesfm_lab import (
    PRESETS,
    build_samples,
    compute_metrics,
    prob_above,
    select_channels,
)


def score_timesfm(samples, ctxs, cov, checkpoint, batch_size, device):
    config = ModelConfig(checkpoint_path=checkpoint, per_core_batch_size=64, device=device)
    forecaster = TimesFM3Evaluator(config)
    levels = np.asarray(config.quantiles, dtype=float)
    probs = np.zeros(len(samples))
    t0 = time.time()
    for start in range(0, len(samples), batch_size):
        end = min(start + batch_size, len(samples))
        outputs = list(
            forecaster.predict_batch(
                contexts=ctxs[start:end],
                horizon=1,
                past_only_covariates=[cov[i] for i in range(start, end)] if cov is not None else None,
                return_quantiles=True,
                use_symmetric_averaging=False,
            )
        )
        for j, out in enumerate(outputs):
            q = np.asarray(out.quantiles, dtype=float)[-1]
            probs[start + j] = prob_above(q, levels, samples[start + j]["t_log"])
        print(f"  [timesfm] {end}/{len(samples)} ({time.time() - t0:.0f}s)", flush=True)
    return probs


def score_timestral(samples, ctxs, cov, model_id, batch_size, device):
    model = TimestralForecaster.from_pretrained(model_id, device=device)
    ctx = np.stack(ctxs)[:, None, :]
    probs = np.zeros(len(samples))
    t0 = time.time()
    start = 0
    # Variate attention over ~40 covariate channels is memory-hungry; halve the
    # batch on CUDA OOM (the RTX 5070 Ti fits ~32-64 series per pass).
    while start < len(samples):
        bs = min(batch_size, len(samples) - start)
        while True:
            try:
                out = model.forecast(
                    ctx[start:start + bs],
                    prediction_length=1,
                    past_covariates=cov[start:start + bs] if cov is not None else None,
                    symmetric_averaging=False,
                    clip_nonnegative=False,
                )
                break
            except torch.OutOfMemoryError:
                if bs <= 1:
                    raise
                bs = max(1, bs // 2)
                torch.cuda.empty_cache()
                print(f"  [timestral] OOM, retrying with batch {bs}", flush=True)
        levels = np.asarray(out.quantile_levels, dtype=float)
        q = np.asarray(out.quantiles.detach().cpu(), dtype=float)[:, 0, -1, :]
        for j in range(bs):
            probs[start + j] = prob_above(q[j], levels, samples[start + j]["t_log"])
        start += bs
        print(f"  [timestral] {start}/{len(samples)} ({time.time() - t0:.0f}s)", flush=True)
    return probs


def run_target(target, con, args, device):
    preset = args.preset or ("full2" if target == "event" else "options")
    channels = list(PRESETS[target][preset])

    tickers = args.tickers or [r[0] for r in con.execute(
        "SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker").fetchall()]
    print(f"[trial] {target}: building samples over {len(tickers)} tickers "
          f"(preset={preset}, {len(channels)} channels)...", flush=True)
    samples = build_samples(con, tickers, target, args.start, args.end, args.step, 1)
    if not samples:
        print(f"[trial] {target}: no samples built, skipping", flush=True)
        return None
    if len(samples) > args.max_samples:
        sel = np.linspace(0, len(samples) - 1, args.max_samples).astype(int)
        samples = [samples[i] for i in sel]
    labels = [s["label"] for s in samples]
    print(f"[trial] {target}: {len(samples)} samples, positive rate "
          f"{float(np.mean(labels)):.3f}, {samples[0]['date']} .. {samples[-1]['date']}", flush=True)

    ctxs, cov = select_channels(samples, channels)

    print(f"[trial] {target}: scoring TimesFM 3.0...", flush=True)
    tfm_probs = score_timesfm(samples, ctxs, cov, args.timesfm_model, args.batch_size, device)
    torch.cuda.empty_cache()
    print(f"[trial] {target}: scoring Timestral...", flush=True)
    tsr_probs = score_timestral(samples, ctxs, cov, args.timestral_model, args.timestral_batch, device)
    torch.cuda.empty_cache()

    down_baseline = compute_metrics(np.zeros(len(labels)), labels)
    return {
        "target": target,
        "preset": preset,
        "n_samples": len(samples),
        "date_range": [str(samples[0]["date"]), str(samples[-1]["date"])],
        "tickers": len(set(s["ticker"] for s in samples)),
        "timesfm": compute_metrics(tfm_probs, labels),
        "timestral": compute_metrics(tsr_probs, labels),
        "always_negative_baseline": down_baseline,
        "corr_probs": round(float(np.corrcoef(tfm_probs, tsr_probs)[0, 1]), 4),
        "samples": [{
            "ticker": s["ticker"], "date": str(s["date"]), "label": s["label"],
            "timesfm_prob": round(float(tfm_probs[i]), 4),
            "timestral_prob": round(float(tsr_probs[i]), 4),
        } for i, s in enumerate(samples)],
    }


def main():
    parser = argparse.ArgumentParser(description="Timestral vs TimesFM head-to-head trial")
    parser.add_argument("--db", default="articles.db")
    parser.add_argument("--timesfm-model", default="google/timesfm-3.0-pytorch")
    parser.add_argument("--timestral-model", default="mistralai/Timestral-209M")
    parser.add_argument("--target", choices=["event", "direction", "both"], default="both")
    parser.add_argument("--preset", default=None)
    parser.add_argument("--tickers", default=None, help="Comma-separated; default all")
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--step", type=int, default=2)
    parser.add_argument("--max-samples", type=int, default=2500)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--timestral-batch", type=int, default=64,
                        help="Timestral batch size (variate attention over covariates "
                             "is memory-hungry; auto-halves on CUDA OOM)")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--out", default="data/timestral-trial.json")
    args = parser.parse_args()
    args.tickers = [t.strip().upper() for t in args.tickers.split(",")] if args.tickers else None

    device = "cuda" if (args.device == "auto" and torch.cuda.is_available()) else \
        (args.device if args.device != "auto" else "cpu")

    con = duckdb.connect(args.db, read_only=True)
    try:
        targets = ["event", "direction"] if args.target == "both" else [args.target]
        report = {}
        for target in targets:
            report[target] = run_target(target, con, args, device)
    finally:
        con.close()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print("\n=== Head-to-head (zero-shot, identical samples) ===")
    for target, r in report.items():
        if r is None:
            continue
        print(f"\n[{target}] n={r['n_samples']} over {r['tickers']} tickers "
              f"({r['date_range'][0]} .. {r['date_range'][1]}), preset={r['preset']}")
        header = f"{'':22s}{'auroc':>8s}{'accuracy':>10s}{'brier':>8s}"
        print(header)
        for name in ("timesfm", "timestral", "always_negative_baseline"):
            m = r[name]
            print(f"{name:22s}{m['auroc']!s:>8}{m['accuracy']!s:>10}{m['brier']!s:>8}")
        print(f"prob correlation: {r['corr_probs']}")
    print(f"\nfull report: {out_path}")


if __name__ == "__main__":
    main()
