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

Usage:
  python/venv-ttm/bin/python python/ttm_options_buckets.py --db articles.db
"""

import argparse
import math

import duckdb

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="articles.db", help="Path to DuckDB database")
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip (ticker, date) pairs already present in options_daily_buckets",
    )
    args = parser.parse_args()

    con = duckdb.connect(args.db)
    con.execute(CREATE_SQL)

    days = con.execute(
        "SELECT DISTINCT ticker, date::TEXT AS d FROM options_chain_history ORDER BY ticker, date"
    ).fetchall()

    if args.skip_existing:
        done = set(
            con.execute("SELECT DISTINCT ticker, date::TEXT FROM options_daily_buckets").fetchall()
        )
        days = [(t, d) for t, d in days if (t, d.split(" ")[0]) not in done]

    print(f"{len(days)} ticker-days to derive")

    from datetime import date as date_cls

    insert_sql = (
        "INSERT OR REPLACE INTO options_daily_buckets "
        "(ticker, date, exp, side, bucket, iv, dv) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )

    processed = 0
    pending = []
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
    n = con.execute("SELECT COUNT(*) FROM options_daily_buckets").fetchone()[0]
    print(f"Done. options_daily_buckets now holds {n} rows.")


if __name__ == "__main__":
    main()
