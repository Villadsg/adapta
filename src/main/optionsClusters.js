// Delta-shape clustering of the options universe for the screening report.
//
// Each ticker-day is turned into a 52-dim "shape" vector: the IV smile and the
// dollar-volume distribution across moneyness buckets (strike/spot − 1, both
// sides, pooled over exp1..exp3). Clustering runs on the *delta* shape — the
// current shape minus the ticker's own rolling baseline — so clusters group
// tickers making the same kind of unusual options move right now, rather than
// tickers that structurally look alike (biotech skew next to biotech skew).
//
// Pure Node, no Electron/app-state dependencies — same contract as
// screeningStats.js. K-means (k-means++ init, Lloyd, restarts) is implemented
// here dependency-free with a fixed k (default 5); silhouette grades the
// separation and per-ticker membership strength. Distance is cosine: rows are
// L2-normalized after standardization so k-means groups tickers by the *shape*
// of their unusual move, not its magnitude — magnitude is reported separately
// as "move" (SD-norm of the standardized delta).
//
// Design assumptions (universe, freshness, accumulation, data guards) are
// documented in docs/options-clustering-assumptions.md.

const { peStandardize } = require('./screeningStats');
// Pure clustering math shared with the report's inline script (clusterCore.js
// is embedded verbatim into the generated HTML so the page can re-cluster
// client-side with results identical to this module for the same k).
const ClusterCore = require('./clusterCore');
const { kmeansBest, distanceMatrix, silhouette, assembleClusters } = ClusterCore;

// Moneyness bucket edges as distance from spot: 0–2.5%, 2.5–5%, …, 27.5–30%,
// plus a >30% tail. IV and DV shares are computed per bucket, per side.
const BUCKET_EDGES = [0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.175, 0.20, 0.225, 0.25, 0.275, 0.30];
const N_BUCKETS = BUCKET_EDGES.length; // 13 — last index is the >30% tail

// Dimension layout of the shape vector: put IV smile, call IV smile, put DV
// shares, call DV shares. Puts first — the far-OTM put wing is the primary
// coordinated-positioning signal this feature hunts for.
const N_DIMS = 4 * N_BUCKETS;
const SIDE_ORDER = ['put', 'call'];

const DEFAULTS = {
  baselineWindow: 60,   // rolling median window (records) for each ticker's norm
  minHistory: 30,       // ticker needs this many shape records to be clustered
  smoothDays: 3,        // accumulate the delta over the last N records (sum, not average)
  minBaselineValues: 5, // non-null values a dim needs inside the window to have a baseline
  maxAgeDays: 7,        // spot-candle lookback tolerance (NOT freshness — see below)
  k: 5,                 // fixed cluster count (clamped down below ~6 eligible tickers)
  restarts: 5,
  seed: 42,
  weakSilhouette: 0.15,
};

function bucketOf(dist) {
  if (!(dist >= 0)) return -1;
  for (let i = N_BUCKETS - 1; i >= 0; i--) {
    if (dist >= BUCKET_EDGES[i]) return i;
  }
  return -1;
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Deterministic RNG so a given input always yields the same clustering.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-strike IV is stored inconsistently: derived records keep percent (82.6)
// while live records keep percent×100 (6681, see slimContract in main.js).
// The quirk is exclusive to the live path, so derived records are never
// rescaled — a derived 374% junk-strike IV is a real value. Live records are
// detected by comparing the strike median against the side's ATM anchor
// (stored in percent on both paths): a ×100 encoding reads many multiples of
// ATM, a real smile never does by much.
function ivScaleFactor(ivs, atmIV, source) {
  if (ivs.length === 0) return 1;
  const med = median(ivs.slice().sort((x, y) => x - y));
  if (source !== 'marketdata-live') return 1;
  if (atmIV != null && atmIV > 0) return med > 5 * atmIV ? 100 : 1;
  return med > 250 ? 100 : 1;
}

// Build the 52-dim shape vector for one history record. Entries are null when
// the bucket has no data (no IV quoted / no DV traded) — null becomes delta 0
// later, i.e. "no change", never "moved to zero".
function buildRecordShape(record, spot) {
  if (!spot || !(spot > 0)) return null;
  const exps = [];
  for (const key of ['exp1', 'exp2', 'exp3']) {
    const e = record[key];
    if (e && (e.callIV > 0 || e.putIV > 0)) exps.push(e);
  }
  if (exps.length === 0) return null;

  const vec = new Array(N_DIMS).fill(null);
  for (let s = 0; s < SIDE_ORDER.length; s++) {
    const side = SIDE_ORDER[s]; // 'put' | 'call'
    const listKey = side === 'put' ? 'puts' : 'calls';

    // Collect this side's strikes across expirations, OTM-side guard included.
    const strikes = [];
    let totalDV = 0;
    for (const e of exps) {
      for (const c of (e[listKey] || [])) {
        const strike = Number(c.strike), dv = Number(c.dv) || 0;
        if (!(strike > 0)) continue;
        const m = strike / spot - 1;
        const dist = side === 'put' ? -m : m;
        if (dist < 0.015) continue; // defensive: lists are OTM-filtered already
        strikes.push({ dist, dv, iv: Number(c.iv) || 0 });
        totalDV += dv;
      }
    }

    const ivBase = s * N_BUCKETS;        // dims [0..12] put IV, [13..25] call IV
    const dvBase = (2 + s) * N_BUCKETS;  // dims [26..38] put DV, [39..51] call DV

    // Side ATM anchor: DV-weighted across expirations, preferring the band
    // definition. Stored in percent on both record paths — reliable.
    let poolVW = 0, poolW = 0;
    for (const e of exps) {
      const atmVal = (side === 'put' ? e.atmBandPutIV : e.atmBandCallIV)
        ?? (side === 'put' ? e.atmPutIV : e.atmCallIV);
      if (atmVal == null || !(atmVal > 0)) continue;
      const w = (side === 'put' ? e.atmPutDV : e.atmCallDV) ?? (side === 'put' ? e.putDV : e.callDV) ?? 0;
      poolVW += atmVal * (w > 0 ? w : 1);
      poolW += (w > 0 ? w : 1);
    }
    const atmIV = poolW > 0 ? poolVW / poolW : null;

    // IV smile: DV-weighted bucket IVs minus the side's pooled ATM IV.
    // The ×100 scale quirk affects ONLY the per-strike `iv` (slimContract in
    // main.js); the anchor is deliberately NOT rescaled.
    const scale = ivScaleFactor(strikes.filter(x => x.iv > 0).map(x => x.iv), atmIV, record.source);
    if (atmIV != null) {
      const w = new Array(N_BUCKETS).fill(0), wv = new Array(N_BUCKETS).fill(0);
      for (const st of strikes) {
        if (st.dv <= 0 || st.iv <= 0) continue;
        const b = bucketOf(st.dist);
        if (b < 0) continue;
        w[b] += st.dv; wv[b] += st.dv * (st.iv / scale);
      }
      for (let b = 0; b < N_BUCKETS; b++) {
        if (w[b] > 0) vec[ivBase + b] = wv[b] / w[b] - atmIV;
      }
      // Broken-anchor guard: a smile displaced uniformly across every bucket
      // (median deviation beyond ±50 vol) is a bad ATM anchor in the source
      // record, not a real curve — real smiles sit near 0 in the close buckets.
      // Drop the side's IV dims so the day contributes no fake delta.
      const smileVals = vec.slice(ivBase, ivBase + N_BUCKETS).filter(v => v != null);
      if (smileVals.length >= 2) {
        const med = median(smileVals.slice().sort((x, y) => x - y));
        if (med < -50 || med > 50) {
          for (let b = 0; b < N_BUCKETS; b++) vec[ivBase + b] = null;
        }
      }
    }

    // DV distribution: share of the side's total OTM DV per bucket (0..1).
    if (totalDV > 0) {
      const bdv = new Array(N_BUCKETS).fill(0);
      for (const st of strikes) {
        const b = bucketOf(st.dist);
        if (b >= 0) bdv[b] += st.dv;
      }
      for (let b = 0; b < N_BUCKETS; b++) {
        if (bdv[b] > 0) vec[dvBase + b] = bdv[b] / totalDV;
      }
    }
  }
  return vec;
}

// Spot for a record: exact date match, else the nearest prior close within
// maxAgeDays (live records can land a day before the candle is stored).
function makeSpotResolver(spotDates, spotCloses) {
  return function (date, maxAgeDays) {
    let lo = 0, hi = spotDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spotDates[mid] <= date) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return null;
    const days = (Date.parse(date) - Date.parse(spotDates[best])) / 86400000;
    return days <= maxAgeDays ? spotCloses[best] : null;
  };
}

// Series of shape vectors for one ticker, date-ordered.
function tickerShapeSeries(ticker, records, spotMap, opts) {
  const spotByDate = spotMap && spotMap[ticker];
  if (!spotByDate) return [];
  const dates = Object.keys(spotByDate).sort();
  const closes = dates.map(d => spotByDate[d]);
  const resolve = makeSpotResolver(dates, closes);
  const out = [];
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const r of sorted) {
    const spot = resolve(r.date, opts.maxAgeDays);
    const vec = buildRecordShape(r, spot);
    if (vec) out.push({ date: r.date, vec });
  }
  return out;
}

// Accumulated delta: the SUM of the last `smoothDays` daily deltas vs each
// day's own rolling baseline. Summing (not averaging) means a sustained move
// keeps its full magnitude — three days of +1 vol each is an accumulated +3,
// the total unusual shift over the window. A dim with no value today or no
// baseline contributes 0 (no change).
function deltaShape(series, opts) {
  if (series.length < opts.minHistory) return null;
  const last = Math.max(1, opts.smoothDays);
  const acc = new Array(N_DIMS).fill(0);
  let used = 0;
  for (let i = series.length - last; i < series.length; i++) {
    if (i < opts.minHistory - 1) continue;
    const win = series.slice(Math.max(0, i - opts.baselineWindow), i);
    for (let d = 0; d < N_DIMS; d++) {
      const cur = series[i].vec[d];
      if (cur == null) continue;
      const hist = win.map(x => x.vec[d]).filter(v => v != null);
      if (hist.length < opts.minBaselineValues) continue;
      const base = median(hist.slice().sort((x, y) => x - y));
      if (base == null) continue;
      acc[d] += cur - base;
    }
    used++;
  }
  if (used === 0) return null;
  return acc;
}

// ─── k-means, silhouette, signatures: see clusterCore.js (shared with the report page) ───

// ─── PCA (top-2 components) for the report's cluster scatter plot ───
// Power iteration + deflation on the covariance of the centered rows.
// Deterministic, dependency-free, and exact enough for a 2D projection.
function pca2Scores(X, nComps = 2) {
  const n = X.length, p = X[0].length;
  const mean = new Array(p).fill(0);
  for (const row of X) for (let j = 0; j < p; j++) mean[j] += row[j] / n;
  const C = X.map(row => row.map((v, j) => v - mean[j]));
  let totalVar = 0;
  for (const row of C) for (const v of row) totalVar += v * v;
  totalVar /= n;

  const comps = [];
  const residual = C.map(r => r.slice());
  for (let c = 0; c < nComps; c++) {
    // Fixed non-sparse init so the iteration is reproducible run to run.
    let v = new Array(p);
    for (let j = 0; j < p; j++) v[j] = Math.sin((j + 1) * ((c === 1 ? 1.7 : c === 2 ? 2.3 : 0.9))) + 0.1;
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    v = v.map(x => x / norm);
    let lambda = 0;
    for (let iter = 0; iter < 200; iter++) {
      const Xv = new Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < p; j++) s += residual[i][j] * v[j];
        Xv[i] = s;
      }
      const w = new Array(p).fill(0);
      for (let i = 0; i < n; i++) {
        const s = Xv[i];
        if (s === 0) continue;
        for (let j = 0; j < p; j++) w[j] += s * residual[i][j];
      }
      const wn = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      if (!(wn > 1e-12)) break;
      const vNext = w.map(x => x / wn);
      let diff = 0;
      for (let j = 0; j < p; j++) diff += Math.abs(vNext[j] - v[j]);
      v = vNext;
      lambda = wn / n;
      if (diff < 1e-10) break;
    }
    comps.push({ v, lambda });
    // Deflate: remove the found direction so the next pass gets PC2.
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < p; j++) s += residual[i][j] * v[j];
      for (let j = 0; j < p; j++) residual[i][j] -= s * v[j];
    }
  }

  const scores = C.map(row => comps.map(c => {
    let s = 0;
    for (let j = 0; j < p; j++) s += row[j] * c.v[j];
    return s;
  }));
  const varExplained = totalVar > 1e-12
    ? comps.map(c => Math.min(1, c.lambda / totalVar))
    : comps.map(() => 0);
  return { scores, varExplained };
}

/**
 * Cluster the options universe on delta-shapes.
 * @param {Object} ivHistory - {ticker: [records]} from getIVHistoryRecords()
 * @param {Object} spotMap - {ticker: {date: close}} from getCloseMapForTickers()
 * @param {Object} [overrides] - option overrides (windows, k range, seed, …)
 * @returns {{byTicker: Object, clusters: Array, meta: Object}}
 */
function computeOptionsClusters(ivHistory, spotMap, overrides = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const tickers = Object.keys(ivHistory || {}).sort();
  if (tickers.length < 6) {
    return { byTicker: {}, clusters: [], meta: { ok: false, reason: `only ${tickers.length} tickers with history (need 6)` } };
  }

  // Universe reference date: newest record anywhere. A ticker is eligible
  // only if its own latest record carries that exact date — clusters describe
  // one current market moment, so anything even a day older is stale. (The
  // maxAgeDays option is only a spot-candle lookback tolerance, not freshness.)
  let newest = '';
  for (const t of tickers) {
    const recs = ivHistory[t];
    if (Array.isArray(recs) && recs.length > 0) {
      const last = recs[recs.length - 1].date || '';
      if (last > newest) newest = last;
    }
  }
  if (!newest) return { byTicker: {}, clusters: [], meta: { ok: false, reason: 'no dated records' } };

  const byTicker = {};
  const rows = [], rowTickers = [];
  let excludedStale = 0, excludedShort = 0;
  for (const t of tickers) {
    const recs = ivHistory[t];
    if (!Array.isArray(recs) || recs.length === 0) continue;
    const last = recs[recs.length - 1].date || '';
    if (last !== newest) { excludedStale++; continue; }
    const series = tickerShapeSeries(t, recs, spotMap, opts);
    const delta = deltaShape(series, opts);
    if (!delta) { excludedShort++; continue; }
    rows.push(delta);
    rowTickers.push(t);
  }

  const n = rows.length;
  if (n < 6) {
    return { byTicker: {}, clusters: [], meta: { ok: false, reason: `only ${n} eligible tickers (${excludedStale} stale, ${excludedShort} short history) — need 6` } };
  }

  const { Z } = peStandardize(rows);
  // Move strength: L2 norm of the standardized delta — how many SDs the
  // ticker's whole options posture moved vs its own baseline. Cosine
  // clustering below ignores magnitude on purpose, so this carries it.
  const moves = Z.map(v => {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[j] * v[j];
    return Math.sqrt(s);
  });
  // Cosine distance: L2-normalize each standardized row so the Euclidean
  // machinery below (k-means, silhouette) measures the *angle* between delta
  // shapes, not magnitude — a +3 vol and +10 vol move of the same shape land
  // together. Zero vectors (all-quiet days) stay zero and cluster at dist 0.
  // Centroids/signatures are still computed from the unnormalized rows and Z
  // so magnitude keeps its original units.
  const Zn = Z.map((v, i) => moves[i] > 1e-12 ? v.map(x => x / moves[i]) : v.slice());
  const D = distanceMatrix(Zn);

  // Fixed k (clamped when the universe is tiny); silhouette no longer picks k,
  // it only grades separation quality and per-ticker membership strength.
  const kUsed = Math.min(opts.k, n - 1);
  const run = kmeansBest(Zn, kUsed, opts);
  const sil = silhouette(D, run.assign);
  const meanSil = sil.reduce((s, x) => s + x, 0) / n;

  // Relabel by size descending (C1 = largest) + signatures + per-ticker map.
  const { byTicker: byTickerAssign, clusters } = assembleClusters({
    rows, Z, moves, rowTickers, assign: run.assign, sil,
  });
  Object.assign(byTicker, byTickerAssign);

  // Scatter-plot coordinates: project the normalized shapes (the same space
  // k-means saw, so dot proximity in the plot ≈ cosine similarity) onto the
  // top-2 principal components.
  const pca = pca2Scores(Zn, 3);
  const plot = {
    points: rowTickers.map((t, i) => ({
      ticker: t,
      cluster: byTicker[t].cluster,
      x: Math.round(pca.scores[i][0] * 1000) / 1000,
      y: Math.round(pca.scores[i][1] * 1000) / 1000,
      z: Math.round(pca.scores[i][2] * 1000) / 1000,
      move: Math.round(moves[i] * 10) / 10,
      strength: Math.round(sil[i] * 100) / 100,
    })),
    varExplained: pca.varExplained.map(v => Math.round(v * 1000) / 1000),
  };

  // Payload for the report's inline re-clustering script: everything the page
  // needs to re-run k-means for any k without touching the main process.
  // moves and Zn are re-derived client-side from Z (moves = L2(Z), Zn = Z/moves)
  // so only rows and Z travel. Rounded to keep the embedded JSON small; k-means
  // on the rounded values can in principle differ from this run's assignment in
  // near-tie cases, which is acceptable for an exploratory control.
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const client = {
    tickers: rowTickers,
    rows: rows.map(r => r.map(r4)),
    Z: Z.map(r => r.map(r4)),
    points: plot.points.map(p => ({ ticker: p.ticker, x: p.x, y: p.y, z: p.z })),
    varExplained: plot.varExplained,
    restarts: opts.restarts,
    seed: opts.seed,
    weakSilhouette: opts.weakSilhouette,
    kAuto: kUsed,
    kMax: Math.min(8, n - 1),
  };

  return {
    byTicker,
    clusters,
    plot,
    client,
    meta: {
      ok: true,
      k: kUsed,
      kSource: opts.kSource || 'auto',
      silhouette: Math.round(meanSil * 1000) / 1000,
      weak: meanSil < opts.weakSilhouette,
      n: rowTickers.length,
      excludedStale,
      excludedShort,
      asOf: newest,
    },
  };
}

module.exports = { computeOptionsClusters, buildRecordShape, DEFAULTS, N_DIMS, DIM_LABELS: ClusterCore.DIM_LABELS };
