// Pure statistics helpers for the pre-event screening pipeline:
// IV-history combination and logistic-fit/AUC evaluation.
// Extracted from main.js — no Electron or app-state dependencies.

// Older records only carry a combined `dv` (call+put) and a single-strike
// `atmCallIV` / `atmPutIV`; we fall back to that for historical continuity.
function combineHistRecord(record) {
  const exps = [];
  for (const key of ['exp1', 'exp2', 'exp3']) {
    const e = record[key];
    if (!e || (e.callIV <= 0 && e.putIV <= 0)) continue;
    exps.push(e);
  }
  if (exps.length === 0) return null;

  // If no expiration has a usable DV, fall back to equal weights across the
  // expirations that do carry a value — matches the legacy behavior and keeps
  // pre-flip history records (which have no dv/callDV/putDV) contributing.
  const poolWeighted = (valueFn, weightFn) => {
    const vals = [];
    for (const e of exps) {
      const v = valueFn(e);
      if (v == null) continue;
      const w = weightFn(e);
      vals.push({ v, w: w > 0 ? w : 0 });
    }
    if (vals.length === 0) return null;
    const sumW = vals.reduce((s, x) => s + x.w, 0);
    if (sumW > 0) return vals.reduce((s, x) => s + x.v * x.w, 0) / sumW;
    return vals.reduce((s, x) => s + x.v, 0) / vals.length;
  };

  // Fallback weight when new per-side DV is missing on older records.
  const fallbackDV = (e) => (e.dv || 0);

  const callIV = poolWeighted(
    (e) => (e.callIV > 0 ? e.callIV : null),
    (e) => (e.callDV != null ? e.callDV : fallbackDV(e)),
  ) ?? 0;
  const putIV = poolWeighted(
    (e) => (e.putIV > 0 ? e.putIV : null),
    (e) => (e.putDV != null ? e.putDV : fallbackDV(e)),
  ) ?? 0;

  const atmCallIV = poolWeighted(
    (e) => (e.atmBandCallIV != null && e.atmBandCallIV > 0 ? e.atmBandCallIV : (e.atmCallIV != null ? e.atmCallIV : null)),
    (e) => (e.atmCallDV != null ? e.atmCallDV : fallbackDV(e)),
  );
  const atmPutIV = poolWeighted(
    (e) => (e.atmBandPutIV != null && e.atmBandPutIV > 0 ? e.atmBandPutIV : (e.atmPutIV != null ? e.atmPutIV : null)),
    (e) => (e.atmPutDV != null ? e.atmPutDV : fallbackDV(e)),
  );

  return {
    callIV, putIV,
    atmCallIV,
    atmPutIV,
  };
}

// ─── Dependency-free numerics for the Pre-Event supervised contrast ───
// Small, exact-enough hand-rolls (no npm deps). All inputs are modest in size
// (≤ a few hundred rows, ≤ ~12 features), so naive implementations are fine.

// Two-sided p-value from a z/large-df-t statistic via the error function
// (Abramowitz & Stegun 7.1.26). df > 100 here, so z ≈ t is acceptable.
function peErf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function peTwoSidedP(z) {
  return 2 * (1 - 0.5 * (1 + peErf(Math.abs(z) / Math.SQRT2)));
}

// Welch contrast between two samples → mean diff, pooled-SD Cohen's d, t, p.
function peWelch(a, b) {
  const m = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const varOf = (v, mu) => v.length < 2 ? 0 : v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (v.length - 1);
  const ma = m(a), mb = m(b), va = varOf(a, ma), vb = varOf(b, mb);
  const na = a.length, nb = b.length;
  const se = Math.sqrt(va / na + vb / nb) || 1e-9;
  const t = (ma - mb) / se;
  const pooledSD = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / Math.max(1, na + nb - 2)) || 1e-9;
  return { meanA: ma, meanB: mb, diff: ma - mb, d: (ma - mb) / pooledSD, t, p: peTwoSidedP(t) };
}

// Column-wise standardize; returns Z plus the mean/std used (std floored).
function peStandardize(rows) {
  const n = rows.length, p = rows[0].length;
  const mean = new Array(p).fill(0), std = new Array(p).fill(0);
  for (const r of rows) for (let j = 0; j < p; j++) mean[j] += r[j];
  for (let j = 0; j < p; j++) mean[j] /= n;
  for (const r of rows) for (let j = 0; j < p; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j] / Math.max(1, n - 1)) || 1e-9;
  const Z = rows.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  return { Z, mean, std };
}

// Correlation matrix of already-standardized Z (= covariance of standardized).
// L2-regularized logistic regression by full-batch gradient descent.
// X is standardized (no bias column); intercept fit separately. y ∈ {0,1}.
function peLogisticFit(X, y, { iters = 800, lr = 0.1, l2 = 1.0 } = {}) {
  const n = X.length, p = X[0].length;
  const w = new Array(p).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(p).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const pr = 1 / (1 + Math.exp(-z));
      const e = pr - y[i];
      gb += e;
      for (let j = 0; j < p; j++) gw[j] += e * X[i][j];
    }
    b -= lr * gb / n;
    for (let j = 0; j < p; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n);
  }
  return { w, b };
}
function peSigmoidScore(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
}

// AUC via the Mann–Whitney rank identity (handles ties at 0.5).
function peAUC(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    const r = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[idx[k]] = r;
    i = j;
  }
  let nPos = 0, sumPos = 0;
  for (let i = 0; i < y.length; i++) if (y[i] === 1) { nPos++; sumPos += ranks[i]; }
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

// Stratified k-fold cross-validated AUC (honest, vs in-sample optimism).
function peCVAUC(X, y, k = 5, fitOpts) {
  const pos = [], neg = [];
  for (let i = 0; i < y.length; i++) (y[i] === 1 ? pos : neg).push(i);
  const folds = Array.from({ length: k }, () => []);
  pos.forEach((ix, i) => folds[i % k].push(ix));
  neg.forEach((ix, i) => folds[i % k].push(ix));
  const allScores = new Array(y.length);
  for (let f = 0; f < k; f++) {
    const test = new Set(folds[f]);
    const trX = [], trY = [];
    for (let i = 0; i < y.length; i++) if (!test.has(i)) { trX.push(X[i]); trY.push(y[i]); }
    if (!trX.length) continue;
    const m = peLogisticFit(trX, trY, fitOpts);
    for (const i of folds[f]) allScores[i] = peSigmoidScore(m, X[i]);
  }
  return peAUC(allScores, y);
}


module.exports = {
  combineHistRecord,
  peErf,
  peTwoSidedP,
  peWelch,
  peStandardize,
  peLogisticFit,
  peSigmoidScore,
  peAUC,
  peCVAUC,
};
