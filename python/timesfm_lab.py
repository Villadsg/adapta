"""TimesFM 3.0 model lab: feature-adjustable backtesting environment.

Builds walk-forward samples straight from the DuckDB (no frozen JSONL
dependency), then scores one or more channel-set configurations with the
zero-shot TimesFM 3.0 model and compares them. Use it to answer "which input
features are actually necessary?" via leave-one-out ablation, or to trial a
custom channel subset before promoting it to a forecast script.

Targets
  event     P(next day is one of this ticker's own top-8% volume*|return|
            days) — the threshold is per ticker, so ~8% of each ticker's
            trading days are events regardless of its absolute scale.
  direction P(the next trading day's return is positive), scored from the
            centered log_close quantile forecast at h = 1.

Channel sets are subsets of the FULL2 feature pool. Channel 0 is the target
series; the rest are past_only_covariates. Presets exist for both targets,
--drop/--keep adjust any preset, and --ablate loo runs the baseline plus one
run per dropped covariate.

Outputs (under --out, default data/lab):
  results.json   append-only log of every lab run (config + metrics)
  report.html    standalone summary page (run table + ablation ranking)
  runs/*.csv     per-sample predictions (ticker, date, label, probability)

Example — direction ablation over the options-only feature set:
  python/venv-ttm/bin/python python/timesfm_lab.py --target direction \
      --preset options --ablate loo --step 2 --tickers AVAV,SMCI,NOW

Example — automatic parsimony search for both screening targets:
  python/venv-ttm/bin/python python/timesfm_lab.py --search --target both

Example — custom event run without the weekly aggregate channels:
  python/venv-ttm/bin/python python/timesfm_lab.py --target event \
      --name no_weekly --drop total_option_dv_log_rank_wmax,...,dv_x_iv_wmean

NOTE: run against a COPY of articles.db while the Electron app is open
(reads on the live file can crash DuckDB).
"""

import argparse
import csv
import html as html_mod
import json
import os
import sys
import time
from datetime import timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score

from adapta.features import (
    CHANNELS,
    FULL2_CHANNELS,
    FULL2_LEGACY_CHANNELS,
    PRICE_CHANNELS,
    ALL_OPTION_CHANNELS,
    FULL2_EXTRA_CHANNELS,
    WEEKLY_OPTION_CHANNELS,
    build_ticker_features,
)
from adapta.options import (
    build_options_features,
    load_options_history,
    load_options_buckets,
    load_options_strike_stats,
)
from event_dataset import (
    per_ticker_threshold,
    SKEW_CHANNELS,
    STRIKE_CHANNELS,
)

CONTEXT_LENGTH = 36  # divisible by TimesFM patch length 9

# The complete feature pool every channel set is drawn from: the union of the
# event preset channels, the direction preset channels, and the legacy
# price/volume covariates (kept so the pre-prune setup stays comparable in the
# lab). Both target series are kept in the matrix — log_event_magnitude for the
# event target, log_close for the direction target (select_channels centres it
# on the last context value so the forecast reads as cumulative return).
FEATURE_POOL = list(dict.fromkeys([
    "log_event_magnitude",
    "log_close",
    *PRICE_CHANNELS,
    *ALL_OPTION_CHANNELS,
    *FULL2_EXTRA_CHANNELS,
    "options_missing",
]))

DIRECTION_OPTIONS_COVARIATES = [*ALL_OPTION_CHANNELS, *FULL2_EXTRA_CHANNELS, "options_missing"]

PRESETS = {
    "event": {
        "full2": FULL2_CHANNELS,
        "legacy_full2": FULL2_LEGACY_CHANNELS,
        "base": CHANNELS,
        "options_only": ["log_event_magnitude", *DIRECTION_OPTIONS_COVARIATES],
        "none": ["log_event_magnitude"],
    },
    "direction": {
        "full2": ["log_close", *[c for c in FULL2_CHANNELS if c != "log_close"]],
        "options": ["log_close", *DIRECTION_OPTIONS_COVARIATES],
        "legacy_full2": ["log_close", "log_volume", "return", "gap", "range", "volatility",
                         *ALL_OPTION_CHANNELS, *FULL2_EXTRA_CHANNELS, "options_missing"],
        "none": ["log_close"],
    },
}

# UI metadata: how the feature pool is presented in the Model Lab modal.
# Groups partition the covariates; descriptions are plain-language tooltips.
CHANNEL_GROUPS = [
    ("Price & volume (legacy)", ["log_volume", "return", "gap", "range", "volatility"]),
    ("Call IV", ["call_iv_spread_rank", "call_iv_spread_delta",
                 "atm_call_iv_rank", "atm_call_iv_delta"]),
    ("Put IV", ["put_iv_spread_rank", "put_iv_spread_delta",
                "atm_put_iv_rank", "atm_put_iv_delta"]),
    ("Options flow", ["total_option_dv_log_rank", "put_call_dv_ratio_rank"]),
    ("Expiration timing", ["exp1_dte_log", "exp2_dte_log", "exp3_dte_log"]),
    ("Weekly patterns", list(WEEKLY_OPTION_CHANNELS)),
    ("Strike structure", [*SKEW_CHANNELS, *STRIKE_CHANNELS]),
    ("Status", ["options_missing"]),
]

CHANNEL_DESCRIPTIONS = {
    "log_event_magnitude": "Size of recent moves: log(volume x |daily return|). The event target series.",
    "log_close": "Price level (log), centered on the last close so the forecast reads as cumulative return. The direction target series.",
    "log_volume": "Trading volume (log scale).",
    "return": "Daily close-to-close return.",
    "gap": "Overnight gap: today's open vs yesterday's close.",
    "range": "Intraday high-low range relative to close.",
    "volatility": "Rolling 20-day volatility of daily returns.",
    "call_iv_spread_rank": "OTM call IV minus ATM call IV, ranked against the ticker's own history. High = speculators bidding up calls.",
    "call_iv_spread_delta": "Day-over-day change in the call spread rank.",
    "atm_call_iv_rank": "At-the-money call IV level, ranked against history.",
    "atm_call_iv_delta": "Day-over-day change in the ATM call IV rank.",
    "put_iv_spread_rank": "OTM put IV minus ATM put IV, ranked against history. High = hedging/put bidding.",
    "put_iv_spread_delta": "Day-over-day change in the put spread rank.",
    "atm_put_iv_rank": "At-the-money put IV level, ranked against history.",
    "atm_put_iv_delta": "Day-over-day change in the ATM put IV rank.",
    "total_option_dv_log_rank": "Total options dollar volume, ranked against history — an attention/flow proxy.",
    "put_call_dv_ratio_rank": "Put vs call dollar-volume ratio, ranked — bearish vs bullish positioning tilt.",
    "exp1_dte_log": "Trading days to the nearest listed expiration (log-scaled).",
    "exp2_dte_log": "Days to the second listed expiration (log-scaled).",
    "exp3_dte_log": "Days to the third listed expiration (log-scaled).",
    "total_option_dv_log_rank_wmax": "Highest options-flow rank of the last 5 trading days.",
    "total_option_dv_log_rank_wmean": "Average options-flow rank over the last 5 trading days.",
    "atm_call_iv_rank_wmax": "Highest ATM call IV rank of the last 5 trading days.",
    "atm_put_iv_rank_wmax": "Highest ATM put IV rank of the last 5 trading days.",
    "call_iv_spread_rank_wslope": "5-day change in the call spread rank.",
    "put_iv_spread_rank_wslope": "5-day change in the put spread rank.",
    "dv_x_iv_wmean": "5-day average of min(flow rank, ATM call IV rank) — flow into cheap options.",
    "options_missing": "Flag for days with no options snapshot (fill indicator).",
    # Strike-structure channels.
    **{
        f"b{b}_put_call_dv_ratio_rank": (
            f"Put vs call dollar volume in moneyness bucket {b} (fixed OTM band, "
            "nearest two expirations), ranked — red-vs-green bar balance at that "
            "slice of the strike chart."
        )
        for b in range(1, 6)
    },
    **{
        f"b{b}_pc_iv_skew_rank": (
            f"Put IV minus call IV in moneyness bucket {b}, ranked — crash-hedging "
            "vs upside speculation at that distance from spot."
        )
        for b in range(1, 6)
    },
    "strike_conc_rank": "Share of the day's option dollar volume in the single largest contract, ranked — high = one whale order dominating the chain.",
    "eff_strikes_rank": "Effective number of active strikes (dollar-volume entropy), ranked — low = flow concentrated on a few strikes, high = spread across the chain.",
    "call_centroid_rank": "Dollar-volume-weighted distance of OTM call strikes from spot, ranked — high = call buying pushed far out of the money.",
    "put_centroid_rank": "Dollar-volume-weighted distance of OTM put strikes from spot, ranked — high = put buying pushed far out of the money.",
}


def dump_channel_meta():
    """JSON payload for the Model Lab UI (channel pool, presets, tooltips)."""
    return {
        "target_channel": {"event": "log_event_magnitude", "direction": "log_close"},
        "presets": {t: {k: list(v) for k, v in p.items()} for t, p in PRESETS.items()},
        "groups": CHANNEL_GROUPS,
        "descriptions": CHANNEL_DESCRIPTIONS,
    }


def parse_date(s):
    return pd.to_datetime(s).date() if s else None


def load_ticker_prices(con, ticker):
    query = """
        SELECT ticker, date, open, high, low, close, volume
        FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY fetched_at DESC) AS rn
            FROM stock_prices WHERE ticker = ?
        ) WHERE rn = 1 ORDER BY date
    """
    df = con.execute(query, [ticker]).fetchdf()
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"]).dt.date
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def load_expiration_labels(con):
    """(ticker, date) -> exp1 expiration date, from options_daily_iv.

    Unused now that direction labels are next-day; kept for reference."""
    try:
        raw = con.execute(
            "SELECT ticker, date, exp1_label FROM options_daily_iv WHERE exp1_label IS NOT NULL"
        ).fetchall()
    except duckdb.CatalogException:
        return {}
    out = {}
    for ticker, date, label in raw:
        exp = pd.to_datetime(str(label).split(" ")[0]).date()
        out[(ticker, pd.to_datetime(date).date())] = exp
    return out


def build_samples(con, tickers, target, start, end, step, max_horizon):
    """Walk-forward samples with the FULL feature matrix per window.

    Channel selection happens later (per config), so ablation runs share the
    same sample set. Returns a list of dicts:
      {ticker, date, values (36 x n_pool), label, horizon, t_log}

    Event labels are RELATIVE per ticker: a day is an event when its magnitude
    reaches the ticker's own 95th percentile, computed on the ticker's history
    BEFORE that day (expanding window, no future leakage). Samples without
    enough prior history for a threshold are skipped.
    """
    opts_history = load_options_history(con)
    opts_buckets = load_options_buckets(con)
    opts_strike = load_options_strike_stats(con)
    samples = []
    for ticker in tickers:
        prices = load_ticker_prices(con, ticker)
        if len(prices) < CONTEXT_LENGTH + 2:
            continue
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
        feats = build_ticker_features(prices, ticker_opts)
        mags = feats["event_magnitude"].to_numpy(dtype=float) if target == "event" else None

        # Index of trading dates eligible as forecast start days.
        dates = feats["date"].tolist()
        for i in range(CONTEXT_LENGTH, len(feats), step):
            d = dates[i]
            if start and d < start:
                continue
            if end and d > end:
                continue
            row = feats.iloc[i]
            ctx_row = feats.iloc[i - 1]
            rec = {
                "ticker": ticker,
                "date": d,
                "values": feats.iloc[i - CONTEXT_LENGTH:i][FEATURE_POOL].to_numpy(dtype=np.float32).copy(),
            }
            if target == "event":
                thr = per_ticker_threshold(mags[:i])  # ticker's own past only
                if thr is None:
                    continue
                rec["label"] = int(float(mags[i]) >= thr)
                rec["horizon"] = 1
                rec["t_log"] = float(np.log1p(thr))
            else:
                rec["t_log"] = 0.0
                # Next trading day's close vs the context window's last close.
                next_close = float(row["close"])
                ctx_close = float(ctx_row["close"])
                if not (ctx_close > 0 and next_close > 0):
                    continue
                rec["label"] = int(np.log(next_close / ctx_close) > 0.0)
                rec["horizon"] = 1
            samples.append(rec)

    return samples


def select_channels(samples, channels):
    """Slice each sample's feature matrix down to `channels` and apply the
    centering rules shared with the forecast scripts."""
    idx = [FEATURE_POOL.index(c) for c in channels]
    i_close = channels.index("log_close") if "log_close" in channels else None
    i_vol = channels.index("log_volume") if "log_volume" in channels else None
    ctxs, covs = [], []
    for s in samples:
        v = s["values"][:, idx].copy()
        if i_close is not None:
            v[:, i_close] -= v[-1, i_close]
        if i_vol is not None:
            v[:, i_vol] -= float(np.nanmedian(v[:, i_vol]))
        ctxs.append(v[:, 0])
        covs.append(v[:, 1:].T)
    cov = np.stack(covs) if covs and covs[0].size else None
    return ctxs, cov


def prob_above(quantile_values, quantile_levels, t):
    q = np.sort(np.asarray(quantile_values, dtype=float))
    return float(1.0 - np.interp(t, q, quantile_levels))


def score_configs(forecaster, quantile_levels, samples, specs, batch_size=256):
    """Zero-shot TimesFM pass over all samples for every channel config.

    A predict_batch call takes a single horizon and a uniform covariate
    width, so jobs are grouped by (n_covariates, horizon) and all configs
    sharing a group — e.g. every leave-one-out run — are merged into shared
    GPU batches. An N-config ablation therefore costs a fraction of the
    model launches of N sequential passes; per-series math is unchanged.

    Event samples carry their own per-ticker t_log (log1p of the ticker's
    threshold); direction samples use 0.0.

    Returns one (probs, per-sample rows) pair per config, aligned with specs.
    """

    prepared = []
    for name, channels in specs:
        ctxs, cov = select_channels(samples, channels)
        prepared.append({
            "name": name, "ctxs": ctxs, "cov": cov,
            "probs": np.zeros(len(samples)),
        })

    groups = {}
    for ci, cfg in enumerate(prepared):
        # cov is stacked (n_samples, n_cov, ctx_len); group by covariate width.
        n_cov = 0 if cfg["cov"] is None else cfg["cov"].shape[1]
        for si, s in enumerate(samples):
            groups.setdefault((n_cov, s["horizon"]), []).append((ci, si))

    total = sum(len(v) for v in groups.values())
    done = 0
    t0 = time.time()
    for (n_cov, horizon), items in sorted(groups.items()):
        for b0 in range(0, len(items), batch_size):
            chunk = items[b0:b0 + batch_size]
            outputs = list(
                forecaster.predict_batch(
                    contexts=[prepared[ci]["ctxs"][si] for ci, si in chunk],
                    horizon=horizon,
                    past_only_covariates=[prepared[ci]["cov"][si] for ci, si in chunk] if n_cov else None,
                    return_quantiles=True,
                    use_symmetric_averaging=False,
                )
            )
            for j, (ci, si) in enumerate(chunk):
                q = np.asarray(outputs[j].quantiles, dtype=float)[-1]  # final step
                prepared[ci]["probs"][si] = prob_above(q, quantile_levels, samples[si]["t_log"])
            done += len(chunk)
            print(f"[lab] scored {done}/{total} series ({time.time() - t0:.0f}s)", flush=True)

    results = []
    for cfg in prepared:
        rows = [{
            "ticker": s["ticker"], "date": str(s["date"]),
            "horizon": s["horizon"], "label": s["label"],
            "probability": round(float(cfg["probs"][i]), 6),
        } for i, s in enumerate(samples)]
        results.append((cfg["probs"], rows))
    return results


def compute_metrics(probs, labels):
    labels = np.asarray(labels, dtype=int)
    probs = np.asarray(probs, dtype=float)
    preds = (probs >= 0.5).astype(int)
    try:
        auroc = round(float(roc_auc_score(labels, probs)), 4)
    except ValueError:
        auroc = None
    return {
        "n": int(len(labels)),
        "positives": int(labels.sum()),
        "positive_rate": round(float(labels.mean()), 4) if len(labels) else None,
        "auroc": auroc,
        "accuracy": round(float(accuracy_score(labels, preds)), 4),
        "brier": round(float(brier_score_loss(labels, probs)), 4),
    }


def write_csv(rows, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["ticker", "date", "horizon", "label", "probability"])
        w.writeheader()
        w.writerows(rows)


VERDICTS = (
    ("unnecessary", 2, "dropping it does not hurt (or improves) the score"),
    ("neutral", 0, "little effect either way"),
    ("important", 1, "dropping it clearly worsens the score"),
)


def verdict_for(delta, tol_drop, tol_hurt):
    if delta > tol_drop:
        return VERDICTS[0]
    if delta < -tol_hurt:
        return VERDICTS[2]
    return VERDICTS[1]


def write_report(out_dir, run_block):
    """Standalone HTML summary of the latest lab run block."""
    target = run_block["target"]
    runs = run_block["runs"]
    metric = "auroc"

    def fmt(v):
        return "—" if v is None else f"{v:.4f}"

    rows_html = ""
    for r in runs:
        rows_html += (
            f"<tr><td>{html_mod.escape(r['name'])}</td>"
            f"<td style='text-align:right;'>{r['n_channels']}</td>"
            f"<td style='text-align:right;'>{fmt(r['metrics'].get(metric))}</td>"
            f"<td style='text-align:right;'>{fmt(r['metrics'].get('accuracy'))}</td>"
            f"<td style='text-align:right;'>{fmt(r['metrics'].get('brier'))}</td>"
            f"<td style='text-align:right;'>{r['metrics']['n']}</td></tr>"
        )
    abl_html = ""
    if run_block.get("ablation"):
        base = next(r for r in runs if r["name"] == run_block["ablation"]["baseline"])
        base_score = base["metrics"].get(metric)
        abl_rows = []
        for a in run_block["ablation"]["dropped"]:
            r = next(x for x in runs if x["name"] == a["run"])
            s = r["metrics"].get(metric)
            delta = None if (s is None or base_score is None) else round(s - base_score, 4)
            abl_rows.append((a["channel"], s, delta, a["verdict"], a["note"]))
        # Most important first: largest score loss when dropped.
        abl_rows.sort(key=lambda x: (0 if x[2] is None else -x[2]))
        for ch, s, delta, verdict, note in abl_rows:
            dstr = "—" if delta is None else f"{delta:+.4f}"
            color = "#8fce8f" if verdict == "unnecessary" else "#d4a657" if verdict == "neutral" else "#f66"
            abl_html += (
                f"<tr><td>{html_mod.escape(ch)}</td>"
                f"<td style='text-align:right;'>{fmt(s)}</td>"
                f"<td style='text-align:right;'>{dstr}</td>"
                f"<td style='color:{color};'>{verdict}</td>"
                f"<td style='color:#888;font-size:0.85em;'>{html_mod.escape(note)}</td></tr>"
            )
    abl_section = ""
    if abl_html:
        abl_section = f"""
<h2>Leave-one-out ablation vs <code>{html_mod.escape(run_block['ablation']['baseline'])}</code></h2>
<p>Ranked by importance: features at the top hurt most when dropped.
<code>unnecessary</code> = removal does not reduce {metric} (candidate to cut);
<code>important</code> = removal clearly reduces it.</p>
<table>
<thead><tr><th>Dropped channel</th><th>{metric}</th><th>Δ vs baseline</th><th>Verdict</th><th></th></tr></thead>
<tbody>{abl_html}</tbody></table>"""

    doc = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TimesFM lab — {target}</title>
<style>
  body {{ background:#14171c; color:#cdd5e0; font-family: -apple-system, 'Segoe UI', sans-serif; margin:24px; }}
  h1 {{ font-size:1.3em; }} h2 {{ font-size:1.05em; margin-top:28px; }}
  table {{ border-collapse:collapse; margin-top:10px; }}
  th, td {{ border:1px solid #2c3440; padding:5px 12px; font-size:0.9em; }}
  th {{ color:#999; text-transform:uppercase; font-size:0.75em; }}
  code {{ background:#1e242c; padding:1px 5px; border-radius:4px; }}
  .meta {{ color:#888; font-size:0.85em; }}
</style></head><body>
<h1>TimesFM 3.0 lab — {target} target</h1>
<p class="meta">started {run_block['started']} · model {html_mod.escape(run_block['model'])} ·
device {run_block['device']} · preset {html_mod.escape(run_block['preset'])} ·
samples {run_block['n_samples']} over {run_block['n_tickers']} tickers</p>
<h2>Runs</h2>
<table>
<thead><tr><th>Run</th><th>Channels</th><th>AUROC</th><th>Accuracy</th><th>Brier</th><th>n</th></tr></thead>
<tbody>{rows_html}</tbody></table>
{abl_section}
</body></html>"""
    path = out_dir / "report.html"
    path.write_text(doc, encoding="utf-8")
    return path


def search_target(name, args, forecaster, quantile_levels):
    """Greedy backward-elimination feature search for one target.

    Each round scores the current set plus one run per dropped covariate (all
    merged into shared batches by score_configs). A covariate is dropped when
    removing it does not cost more than --search-cost AUROC. Every scored set
    is a candidate under the penalized objective AUROC - cost*n_features, so
    over-pruned rounds never win: the best candidate across all rounds is the
    answer.
    """
    base = list(PRESETS[name][args.preset or ("full2" if name == "event" else "options")])
    target_channel = base[0]
    lam = args.search_cost

    con = duckdb.connect(args.db, read_only=True)
    try:
        if args.tickers:
            tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        else:
            tickers = [r[0] for r in con.execute(
                "SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker"
            ).fetchall()]
        print(f"[search] {name}: building samples over {len(tickers)} tickers...", flush=True)
        samples = build_samples(
            con, tickers, name, parse_date(args.start), parse_date(args.end),
            args.step, args.max_horizon,
        )
    finally:
        con.close()
    if not samples:
        raise SystemExit(f"No samples built for target {name} — check tickers/date range/options coverage.")
    if len(samples) > args.max_samples:
        sel = np.linspace(0, len(samples) - 1, args.max_samples).astype(int)
        samples = [samples[i] for i in sel]
    labels = [s["label"] for s in samples]
    print(f"[search] {name}: {len(samples)} samples, positive rate {np.mean(labels):.3f}, "
          f"starting from {len(base)} channels", flush=True)

    current = list(base)
    best = None  # (penalized score, auroc, channels)
    baseline_auroc = None
    rounds_done = 0

    def consider(channels, auroc):
        nonlocal best
        if auroc is None:
            return
        pen = auroc - lam * len(channels)
        if best is None or pen > best[0] + 1e-12:
            best = (pen, auroc, list(channels))

    decisions = {}  # channel -> AUROC delta from the most recent round it was judged in
    for rnd in range(1, args.search_rounds + 1):
        rounds_done = rnd
        specs = [("current", current)]
        for c in current[1:]:
            specs.append((f"drop={c}", [x for x in current if x != c]))
        if len(current) > 1:
            specs.append(("target_only", [target_channel]))

        scored = score_configs(
            forecaster, quantile_levels, samples, specs, args.batch_size,
        )
        aurocs = [compute_metrics(probs, labels)["auroc"] for probs, _ in scored]
        base_a = aurocs[0]
        if baseline_auroc is None:
            baseline_auroc = base_a
        consider(current, base_a)
        for (nm, chs), a in zip(specs, aurocs):
            consider(chs, a)
            if nm.startswith("drop=") and a is not None and base_a is not None:
                decisions[nm.split("=", 1)[1]] = round(a - base_a, 4)

        droppable = [
            nm.split("=", 1)[1] for (nm, _), a in zip(specs, aurocs)
            if nm.startswith("drop=") and a is not None and base_a is not None
            and a - base_a > -lam
        ]
        if len(current) == 1 or not droppable:
            break
        print(f"[search] {name} round {rnd}: AUROC {base_a} with {len(current)} channels — "
              f"dropping {len(droppable)}: {', '.join(droppable)}", flush=True)
        current = [c for c in current if c == target_channel or c not in set(droppable)]

    _, auroc, channels = best
    print(f"[search] {name}: best set = {len(channels)} channels, AUROC {auroc} "
          f"(baseline {baseline_auroc} with {len(base)})", flush=True)
    final = set(channels)
    decision_list = sorted(
        ({"channel": ch, "delta_auroc": d, "kept": ch in final} for ch, d in decisions.items()),
        key=lambda d: (not d["kept"], -(d["delta_auroc"])),
    )
    return {
        "channels": channels,
        "n_channels": len(channels),
        "auroc": auroc,
        "baseline_auroc": baseline_auroc,
        "baseline_n_channels": len(base),
        "n_samples": len(samples),
        "n_tickers": len(set(s["ticker"] for s in samples)),
        "rounds": rounds_done,
        "feature_cost": lam,
        "decisions": decision_list,
    }


def dataset_info(args):
    """Dataset health summary for the Model Lab UI: universe, date range,
    per-target sample counts (same walk-forward sampling the search uses),
    options coverage, and plain-language warnings. Loads no model."""
    from datetime import date as _date

    out = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
           "pool_size": len(FEATURE_POOL), "warnings": []}
    db_path = Path(args.db)
    if not db_path.exists():
        return {"error": f"Database not found: {args.db}", "warnings": ["Database not found"]}

    con = duckdb.connect(args.db, read_only=True)
    try:
        row = con.execute(
            "SELECT COUNT(*), COUNT(DISTINCT ticker), MIN(date), MAX(date) FROM stock_prices"
        ).fetchone()
        n_rows, n_tickers, d_min, d_max = row
        if not n_rows:
            return {"error": "stock_prices is empty", "warnings": ["No price data in the database"]}
        d_min = pd.to_datetime(d_min).date()
        d_max = pd.to_datetime(d_max).date()
        out["db"] = {"price_rows": int(n_rows), "tickers": int(n_tickers),
                     "date_min": str(d_min), "date_max": str(d_max)}

        days_old = (_date.today() - d_max).days
        if days_old > 7:
            out["warnings"].append(
                f"Newest price data is {days_old} days old ({d_max}) — search runs on stale history.")

        opts = con.execute(
            "SELECT COUNT(DISTINCT ticker) FROM options_daily_iv"
        ).fetchone()[0]
        out["options"] = {"tickers_with_options": int(opts or 0)}
        no_opts = [t[0] for t in con.execute(
            "SELECT DISTINCT ticker FROM stock_prices WHERE ticker NOT IN "
            "(SELECT DISTINCT ticker FROM options_daily_iv) ORDER BY ticker"
        ).fetchall()]
        if no_opts:
            names = ", ".join(no_opts[:5]) + ("…" if len(no_opts) > 5 else "")
            out["warnings"].append(
                f"{len(no_opts)} ticker(s) have no options data at all ({names}) — "
                "their options features are fill values.")

        tickers = [r[0] for r in con.execute(
            "SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker"
        ).fetchall()]

        i_missing = FEATURE_POOL.index("options_missing")
        out["targets"] = {}
        for target in ("direction", "event"):
            # Progress goes to stderr so stdout stays pure JSON for the service.
            print(f"[data] building {target} samples for the health check...", file=sys.stderr, flush=True)
            samples = build_samples(
                con, tickers, target, parse_date(args.start), parse_date(args.end),
                args.step, args.max_horizon,
            )
            if len(samples) > args.max_samples:
                sel = np.linspace(0, len(samples) - 1, args.max_samples).astype(int)
                samples = [samples[i] for i in sel]
            if not samples:
                out["targets"][target] = {"samples": 0, "available": False}
                out["warnings"].append(f"No {target} samples could be built — "
                                       "check price data coverage.")
                continue
            labels = np.asarray([s["label"] for s in samples], dtype=float)
            miss = float(np.mean([s["values"][:, i_missing].mean() for s in samples]))
            rec = {
                "available": True,
                "samples": len(samples),
                "tickers": len(set(s["ticker"] for s in samples)),
                "positive_rate": round(float(labels.mean()), 4),
                "options_missing_pct": round(miss * 100, 1),
            }
            if target == "direction":
                rec["median_horizon_days"] = int(np.median([s["horizon"] for s in samples]))
            else:
                # Event thresholds are per ticker (each ticker's own top 8%);
                # report a representative value across the sample set.
                rec["median_threshold"] = round(float(np.median(
                    [float(np.expm1(s["t_log"])) for s in samples])), 2)
            out["targets"][target] = rec

            if rec["samples"] < 500:
                out["warnings"].append(
                    f"Only {rec['samples']} {target} samples — AUROC estimates will be noisy "
                    "and the search may cut useful features.")
            if rec["positive_rate"] < 0.05 or rec["positive_rate"] > 0.95:
                out["warnings"].append(
                    f"{target} positive rate is {rec['positive_rate']:.0%} — very one-sided "
                    "labels make AUROC unreliable.")
            if rec["options_missing_pct"] > 30:
                out["warnings"].append(
                    f"Options data missing on {rec['options_missing_pct']:.0f}% of {target} "
                    "feature days — options features are mostly fill values.")
    finally:
        con.close()
    return out


def run_search(args, device):
    """Search parsimonious feature sets for one or both targets and print the
    result as a single SEARCH_RESULT JSON line for the lab service."""
    # Imported here (not at module top) so --dump-channels and --help stay fast.
    from timesfm3 import ModelConfig, TimesFM3Evaluator

    config = ModelConfig(checkpoint_path=args.model,
                         per_core_batch_size=args.per_core_batch, device=device)
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)

    targets = ["direction", "event"] if args.target == "both" else [args.target]
    out = {}
    for t in targets:
        out[t] = search_target(t, args, forecaster, quantile_levels)
    print("SEARCH_RESULT " + json.dumps(out), flush=True)


def run_backtest(args, device):
    """Score both targets' current production presets (direction: options,
    event: full2) and print one BACKTEST_RESULT JSON line for the lab UI."""
    from timesfm3 import ModelConfig, TimesFM3Evaluator

    config = ModelConfig(checkpoint_path=args.model,
                         per_core_batch_size=args.per_core_batch, device=device)
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)

    con = duckdb.connect(args.db, read_only=True)
    try:
        if args.tickers:
            tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        else:
            tickers = [r[0] for r in con.execute(
                "SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker"
            ).fetchall()]
        built = {}
        for target in ("direction", "event"):
            print(f"[lab] building {target} samples...", file=sys.stderr, flush=True)
            built[target] = build_samples(
                con, tickers, target, parse_date(args.start), parse_date(args.end),
                args.step, args.max_horizon,
            )
    finally:
        con.close()

    out = {}
    for target, samples in built.items():
        preset = "options" if target == "direction" else "full2"
        channels = list(PRESETS[target][preset])
        if not samples:
            out[target] = {"available": False, "preset": preset,
                           "channels": channels, "n_channels": len(channels)}
            continue
        if len(samples) > args.max_samples:
            sel = np.linspace(0, len(samples) - 1, args.max_samples).astype(int)
            samples = [samples[i] for i in sel]
        labels = [s["label"] for s in samples]
        print(f"[lab] backtesting {target}: {len(channels)} channels, "
              f"{len(samples)} samples, positive rate {np.mean(labels):.3f}", flush=True)
        [(probs, _rows)] = score_configs(
            forecaster, quantile_levels, samples, [(preset, channels)], args.batch_size,
        )
        metrics = compute_metrics(probs, labels)
        print(f"[lab] {target}: auroc={metrics['auroc']} acc={metrics['accuracy']} "
              f"brier={metrics['brier']}", flush=True)
        out[target] = {
            "available": True,
            "preset": preset,
            "channels": channels,
            "n_channels": len(channels),
            "metrics": metrics,
            "n_samples": len(samples),
            "n_tickers": len(set(s["ticker"] for s in samples)),
            "positive_rate": round(float(np.mean(labels)), 4),
        }
    print("BACKTEST_RESULT " + json.dumps(out), flush=True)


def main():
    parser = argparse.ArgumentParser(description="TimesFM 3.0 feature-lab / backtest environment")
    parser.add_argument("--db", default="articles.db")
    parser.add_argument("--model", default="google/timesfm-3.0-pytorch")
    parser.add_argument("--target", choices=["event", "direction", "both"], default="direction")
    parser.add_argument("--preset", default=None,
                        help="Channel-set preset (event: full2/base/options_only/none; "
                             "direction: full2/options/none). Default: full2 for event, "
                             "options for direction")
    parser.add_argument("--drop", default="", help="Comma-separated covariates to remove from the preset")
    parser.add_argument("--keep", default="", help="If set, keep ONLY these covariates (+ the target)")
    parser.add_argument("--name", default=None, help="Label for a single custom run")
    parser.add_argument("--ablate", choices=["none", "loo"], default="none",
                        help="loo: baseline + one run per dropped covariate")
    parser.add_argument("--tol-drop", type=float, default=0.002,
                        help="AUROC gain above which a dropped feature is 'unnecessary'")
    parser.add_argument("--tol-hurt", type=float, default=0.005,
                        help="AUROC loss beyond which a dropped feature is 'important'")
    parser.add_argument("--tickers", default="", help="Comma-separated; default: all with enough data")
    parser.add_argument("--start", default=None, help="First forecast date (YYYY-MM-DD)")
    parser.add_argument("--end", default=None, help="Last forecast date (YYYY-MM-DD)")
    parser.add_argument("--step", type=int, default=2,
                        help="Sample every Nth trading day per ticker (runtime control)")
    parser.add_argument("--max-samples", type=int, default=2000,
                        help="Evenly downsample the sample pool to at most this many")
    parser.add_argument("--max-horizon", type=int, default=30,
                        help="Ignored for direction (fixed at 1 trading day); kept for compatibility")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--per-core-batch", type=int, default=64,
                        help="Series per model forward pass; larger = fewer GPU launches")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--out", default="data/lab")
    parser.add_argument("--search", action="store_true",
                        help="Automatic feature search: greedily prune each target's preset to "
                             "the smallest set that still maximizes AUROC (penalized by "
                             "--search-cost per feature). Prints a final SEARCH_RESULT JSON "
                             "line instead of writing results.json/report.html.")
    parser.add_argument("--backtest", action="store_true",
                        help="Score both targets' current production presets as-is and print a "
                             "final BACKTEST_RESULT JSON line (no search, no pruning).")
    parser.add_argument("--search-cost", type=float, default=0.002,
                        help="AUROC a feature must add to earn its place in the search")
    parser.add_argument("--search-rounds", type=int, default=4,
                        help="Max leave-one-out pruning rounds per target in the search")
    parser.add_argument("--dump-channels", action="store_true",
                        help="Print the channel pool/presets/descriptions as JSON and exit "
                             "(used by the Model Lab UI; fast — no model load)")
    parser.add_argument("--dataset-info", action="store_true",
                        help="Scan the dataset and print a JSON health summary (sample counts, "
                             "options coverage, warnings) for the Model Lab UI. Builds the same "
                             "walk-forward samples the search would score, but loads no model.")
    args = parser.parse_args()

    if args.dump_channels:
        print(json.dumps(dump_channel_meta()))
        return

    if args.dataset_info:
        print(json.dumps(dataset_info(args)))
        return

    device = args.device
    if device == "auto":
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"

    if args.search:
        run_search(args, device)
        return

    if args.backtest:
        run_backtest(args, device)
        return

    preset = args.preset or ("full2" if args.target == "event" else "options")
    base_channels = list(PRESETS[args.target][preset])
    target_channel = base_channels[0]
    drop = {c.strip() for c in args.drop.split(",") if c.strip()}
    keep = {c.strip() for c in args.keep.split(",") if c.strip()}
    if drop or keep:
        preset = f"{preset}+custom"
    if keep:
        base_channels = [target_channel] + [c for c in base_channels[1:] if c in keep]
    if drop:
        base_channels = [c for c in base_channels if c == target_channel or c not in drop]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    runs_dir = out_dir / "runs"
    runs_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")

    con = duckdb.connect(args.db, read_only=True)
    try:
        if args.tickers:
            tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        else:
            tickers = [r[0] for r in con.execute(
                "SELECT DISTINCT ticker FROM stock_prices ORDER BY ticker"
            ).fetchall()]
        print(f"[lab] target={args.target} preset={preset} channels={len(base_channels)} "
              f"tickers={len(tickers)} device={device}", flush=True)
        samples = build_samples(
            con, tickers, args.target, parse_date(args.start), parse_date(args.end),
            args.step, args.max_horizon,
        )
    finally:
        con.close()

    if not samples:
        raise SystemExit("No samples built — check tickers/date range/options coverage.")
    if len(samples) > args.max_samples:
        sel = np.linspace(0, len(samples) - 1, args.max_samples).astype(int)
        samples = [samples[i] for i in sel]
        print(f"[lab] downsampled to {len(samples)} samples", flush=True)
    labels = [s["label"] for s in samples]
    print(f"[lab] {len(samples)} samples, positive rate {np.mean(labels):.3f}, "
          f"{len(set(s['ticker'] for s in samples))} tickers", flush=True)

    # Run configs: custom single run, or baseline (+ optional leave-one-out).
    run_specs = []
    if args.name:
        run_specs.append((args.name, base_channels))
    else:
        run_specs.append((preset, base_channels))
        if args.ablate == "loo":
            run_specs.append((f"{preset}|target_only", [target_channel]))
            for c in base_channels[1:]:
                run_specs.append((f"{preset}|drop={c}", [c0 for c0 in base_channels if c0 != c]))

    # Imported here (not at module top) so --dump-channels and --help stay fast.
    from timesfm3 import ModelConfig, TimesFM3Evaluator

    config = ModelConfig(checkpoint_path=args.model, per_core_batch_size=args.per_core_batch, device=device)
    forecaster = TimesFM3Evaluator(config)
    quantile_levels = np.asarray(config.quantiles, dtype=float)

    runs = []
    seen_names = {}
    specs = []
    for name, channels in run_specs:
        seen_names[name] = seen_names.get(name, 0) + 1
        if seen_names[name] > 1:
            name = f"{name}#{seen_names[name]}"
        specs.append((name, channels))

    # All configs are scored in one merged pass: configs with the same
    # covariate width share GPU batches per horizon group.
    t_score = time.time()
    scored = score_configs(
        forecaster, quantile_levels, samples, specs, args.batch_size,
    )
    for (name, channels), (probs, rows) in zip(specs, scored):
        metrics = compute_metrics(probs, labels)
        write_csv(rows, runs_dir / f"{ts}_{name.replace('|', '_').replace('/', '_')}.csv")
        runs.append({"name": name, "channels": channels, "n_channels": len(channels),
                     "metrics": metrics})
        print(f"[lab] {name}: auroc={metrics['auroc']} acc={metrics['accuracy']} "
              f"brier={metrics['brier']}", flush=True)
    print(f"[lab] {len(specs)} config(s) scored in {time.time() - t_score:.1f}s", flush=True)

    run_block = {
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        "target": args.target,
        "model": args.model,
        "device": device,
        "preset": preset,
        "tolerances": {"drop": args.tol_drop, "hurt": args.tol_hurt},
        "n_samples": len(samples),
        "n_tickers": len(set(s["ticker"] for s in samples)),
        "step": args.step,
        "start": args.start,
        "end": args.end,
        "runs": runs,
        "ablation": None,
    }

    if args.ablate == "loo" and not args.name:
        dropped = []
        for r in runs:
            if r["name"].startswith(f"{preset}|drop="):
                channel = r["name"].split("=", 1)[1]
                s = r["metrics"].get("auroc")
                base_score = runs[0]["metrics"].get("auroc")
                delta = None if (s is None or base_score is None) else round(s - base_score, 4)
                verdict, _, note = (
                    verdict_for(delta, args.tol_drop, args.tol_hurt) if delta is not None
                    else ("neutral", 0, "not evaluable (degenerate labels)")
                )
                dropped.append({"channel": channel, "run": r["name"], "delta_auroc": delta,
                                "verdict": verdict, "note": note})
        run_block["ablation"] = {"baseline": preset, "dropped": dropped}

    results_path = out_dir / "results.json"
    history = json.loads(results_path.read_text()) if results_path.exists() else []
    history.append(run_block)
    results_path.write_text(json.dumps(history, indent=2))

    report_path = write_report(out_dir, run_block)
    print(f"[lab] wrote {results_path}", flush=True)
    print(f"[lab] wrote {report_path}", flush=True)


if __name__ == "__main__":
    main()
