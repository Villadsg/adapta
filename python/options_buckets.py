#!/usr/bin/env python3
"""Derive per-moneyness-bucket options features from the raw chain history.

Reads `options_chain_history` (raw per-strike EOD chains written by
ci/backfill-marketdata.js phase C), computes BSM-implied IV per contract with
the same bisection method as phase D (impliedVol in ci/backfill-marketdata.js,
r = 4.5%), and aggregates into fixed moneyness buckets for the nearest two
expirations (exp1/exp2 — same selection rule as phase D).

Buckets are relative to the day's underlying price S:
  calls: K/S in [1.015,1.03), [1.03,1.05), [1.05,1.075), [1.075,1.10), >=1.10
  puts:  K/S in (0.97,0.985], (0.95,0.97], (0.925,0.95], (0.90,0.925], <=0.90

Output table `options_daily_buckets` (long format):
  ticker, date, exp ('exp1'|'exp2'), side ('call'|'put'), bucket (1..5),
  iv (DV-weighted mean BSM IV in %, NULL if no usable contract),
  dv (total dollar volume in the bucket, volume * last * 100)

Idempotent: rows are written with INSERT OR REPLACE per (ticker, date), so the
script can be re-run or resumed with --skip-existing.

The same pass also fills `options_daily_strike_stats` (top_dv_share,
eff_strikes, call_centroid_m, put_centroid_m — strike-level structure the
fixed buckets can't express). Use --strike-stats-only to fill just that table.

Usage:
  python/venv-ttm/bin/python python/options_buckets.py --db articles.db
"""

import argparse
import math

import duckdb
import numpy as np

RISK_FREE_RATE = 0.045

# OTM moneyness edges (K/S). Bucket i for a side covers (edges[i-1], edges[i]]
# measured in distance from the ATM boundary: calls use K/S >= 1.015, puts
# K/S <= 0.985; bucket 5 is the deep tail (>=1.10 / <=0.90).
CALL_EDGES = (1.015, 1.03, 1.05, 1.075, 1.10)
PUT_EDGES = (0.985, 0.97, 0.95, 0.925, 0.90)


def norm_cdf(x: float) -> float:
    # Abramowitz-Stegun via erf approximation — identical constants to
    # normCdf() in ci/backfill-marketdata.js so IVs match phase D.
    a1, a2, a3 = 0.254829592, -0.284496736, 1.421413741
    a4, a5, p = -1.453152027, 1.061405429, 0.3275911
    sign = -1 if x < 0 else 1
    z = abs(x) / math.sqrt(2)
    t = 1 / (1 + p * z)
    erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-z * z))
    return 0.5 * (1 + erf)


def bsm_price(side: str, S: float, K: float, T: float, r: float, sigma: float) -> float:
    d1 = (math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    df = math.exp(-r * T)
    if side == "call":
        return S * norm_cdf(d1) - K * df * norm_cdf(d2)
    return K * df * norm_cdf(-d2) - S * norm_cdf(-d1)


def implied_vol(side: str, price: float, S: float, K: float, T: float, r: float):
    """Bisection IV (decimal); None outside no-arbitrage bounds. Port of
    impliedVol() in ci/backfill-marketdata.js."""
    if not (price > 0) or not (S > 0) or not (K > 0) or not (T > 0):
        return None
    df = math.exp(-r * T)
    intrinsic = max(0.0, S - K * df) if side == "call" else max(0.0, K * df - S)
    upper = S if side == "call" else K * df
    if price < intrinsic - 1e-9 or price >= upper:
        return None
    lo, hi = 1e-4, 5.0
    if bsm_price(side, S, K, T, r, hi) < price:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if bsm_price(side, S, K, T, r, mid) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def call_bucket(m: float):
    """Bucket 1..5 for a call at moneyness m = K/S, or None if below the OTM
    boundary."""
    if m < CALL_EDGES[0]:
        return None
    for i in range(1, len(CALL_EDGES)):
        if m < CALL_EDGES[i]:
            return i
    return 5


def put_bucket(m: float):
    """Bucket 1..5 for a put at moneyness m = K/S (mirrored), or None if above
    the OTM boundary."""
    if m > PUT_EDGES[0]:
        return None
    for i in range(1, len(PUT_EDGES)):
        if m > PUT_EDGES[i]:
            return i
    return 5


CREATE_SQL = """
CREATE TABLE IF NOT EXISTS options_daily_buckets (
    ticker VARCHAR,
    date DATE,
    exp VARCHAR,
    side VARCHAR,
    bucket INTEGER,
    iv DOUBLE,
    dv DOUBLE,
    UNIQUE(ticker, date, exp, side, bucket)
)
"""

# Per-day strike-level structure stats (the strike chart below bucket
# resolution): whale concentration, effective strike count, and the DV-weighted
# OTM placement of call and put dollar volume. Computed over ALL contracts with
# volume, not just the bucketed OTM slice.
STRIKE_STATS_SQL = """
CREATE TABLE IF NOT EXISTS options_daily_strike_stats (
    ticker VARCHAR,
    date DATE,
    top_dv_share DOUBLE,
    eff_strikes DOUBLE,
    call_centroid_m DOUBLE,
    put_centroid_m DOUBLE,
    UNIQUE(ticker, date)
)
"""


def strike_stats(contracts, spot: float):
    """(top_dv_share, eff_strikes, call_centroid_m, put_centroid_m) for one
    ticker-day, or None when there is no dollar volume.

    contracts: (exp, side, strike, last_price, volume, underlying_price) rows
    already filtered to volume > 0 and positive prices.
    """
    dvs = []
    call_w, put_w = [], []  # (dv, otm distance from ATM) per contract
    for _exp, side, strike, last, volume, _u in contracts:
        dv = float(volume) * float(last) * 100
        if dv <= 0:
            continue
        dvs.append(dv)
        m = float(strike) / spot
        if side == "call" and m >= 1.0:
            call_w.append((dv, m - 1.0))
        elif side == "put" and m <= 1.0:
            put_w.append((dv, 1.0 - m))
    total = sum(dvs)
    if total <= 0:
        return None
    top = max(dvs) / total
    p = np.array(dvs) / total
    eff = float(np.exp(-(p * np.log(p)).sum()))  # permutation entropy, per-side neutral
    def centroid(pairs):
        w = sum(x for x, _ in pairs)
        return sum(x * d for x, d in pairs) / w if w > 0 else None
    return top, eff, centroid(call_w), centroid(put_w)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="articles.db", help="Path to DuckDB database")
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip (ticker, date) pairs already present in options_daily_buckets",
    )
    parser.add_argument(
        "--strike-stats-only",
        action="store_true",
        help="Only fill options_daily_strike_stats (skip the IV/bucket derivation)",
    )
    args = parser.parse_args()

    con = duckdb.connect(args.db)
    con.execute(CREATE_SQL)
    con.execute(STRIKE_STATS_SQL)

    days = con.execute(
        "SELECT DISTINCT ticker, date::TEXT AS d FROM options_chain_history ORDER BY ticker, date"
    ).fetchall()

    if args.skip_existing:
        done = set(
            con.execute("SELECT DISTINCT ticker, date::TEXT FROM options_daily_buckets").fetchall()
        )
        done_stats = set(
            con.execute(
                "SELECT DISTINCT ticker, date::TEXT FROM options_daily_strike_stats"
            ).fetchall()
        )
        keep = []
        for t, d in days:
            key = (t, d.split(" ")[0])
            table = done_stats if args.strike_stats_only else done
            if key not in table:
                keep.append((t, d))
        days = keep

    print(f"{len(days)} ticker-days to derive")

    from datetime import date as date_cls

    insert_sql = (
        "INSERT OR REPLACE INTO options_daily_buckets "
        "(ticker, date, exp, side, bucket, iv, dv) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    stats_sql = (
        "INSERT OR REPLACE INTO options_daily_strike_stats "
        "(ticker, date, top_dv_share, eff_strikes, call_centroid_m, put_centroid_m) "
        "VALUES (?, ?, ?, ?, ?, ?)"
    )

    processed = 0
    pending = []
    pending_stats = []
    for ticker, d in days:
        day = d.split(" ")[0]
        contracts = con.execute(
            """SELECT expiration_date::TEXT AS exp, side, strike, last_price, volume,
                      underlying_price
               FROM options_chain_history
               WHERE ticker = ? AND date = ? AND volume > 0 AND last_price > 0
                 AND underlying_price > 0""",
            [ticker, day],
        ).fetchall()
        processed += 1
        if not contracts:
            continue

        S = float(contracts[0][5])

        stats = strike_stats(contracts, S)
        if stats is not None:
            pending_stats.append((ticker, day, *stats))

        if args.strike_stats_only:
            if len(pending_stats) >= 50000:
                con.executemany(stats_sql, pending_stats)
                pending_stats.clear()
            if processed % 1000 == 0:
                print(f"  derived {processed}/{len(days)} ticker-days")
            continue

        y, m, dd = (int(x) for x in day.split("-"))
        day_date = date_cls(y, m, dd)

        # acc[(exp, side, bucket)] = [iv*dv sum, dv sum]
        acc = {}
        for exp, side, strike, last, volume, _u in contracts:
            exp_day = exp.split(" ")[0]
            K = float(strike)
            last = float(last)
            dv = float(volume) * last * 100
            ey, em, ed = (int(x) for x in exp_day.split("-"))
            T = max((date_cls(ey, em, ed) - day_date).days / 365.0, 1 / 365)
            iv = implied_vol(side, last, S, K, T, RISK_FREE_RATE)
            mny = K / S
            bucket = call_bucket(mny) if side == "call" else put_bucket(mny)
            if bucket is None:
                continue
            key = (exp_day, side, bucket)
            slot = acc.setdefault(key, [0.0, 0.0])
            slot[1] += dv
            if iv is not None:
                slot[0] += iv * 100 * dv

        exps = sorted({k[0] for k in acc})[:2]
        for i, exp_day in enumerate(exps):
            label = f"exp{i + 1}"
            for side in ("call", "put"):
                for bucket in range(1, 6):
                    slot = acc.get((exp_day, side, bucket))
                    if slot is None or slot[1] <= 0:
                        continue
                    iv_w = slot[0] / slot[1] if slot[0] > 0 else None
                    pending.append((ticker, day, label, side, bucket, iv_w, slot[1]))

        if len(pending) >= 50000:
            con.executemany(insert_sql, pending)
            pending.clear()
        if processed % 1000 == 0:
            print(f"  derived {processed}/{len(days)} ticker-days")

    if pending:
        con.executemany(insert_sql, pending)
    if pending_stats:
        con.executemany(stats_sql, pending_stats)
    n = con.execute("SELECT COUNT(*) FROM options_daily_buckets").fetchone()[0]
    s = con.execute("SELECT COUNT(*) FROM options_daily_strike_stats").fetchone()[0]
    print(f"Done. options_daily_buckets holds {n} rows; "
          f"options_daily_strike_stats holds {s} rows.")


if __name__ == "__main__":
    main()
