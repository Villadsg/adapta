// Browser-safe core of the delta-shape clustering: the pure math that must
// behave identically in the Electron main process (optionsClusters.js) and in
// the generated screening report's inline script (screeningHtml.js embeds this
// file's source verbatim). UMD-ish: CommonJS when required, window.ClusterCore
// when injected into a page. No Node APIs, no app state — math only.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClusterCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Moneyness bucket edges as distance from spot (see optionsClusters.js).
  const BUCKET_EDGES = [0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.175, 0.20, 0.225, 0.25, 0.275, 0.30];
  const N_BUCKETS = BUCKET_EDGES.length; // 13 — last index is the >30% tail
  const N_DIMS = 4 * N_BUCKETS;

  function bucketLabel(i) {
    if (i === N_BUCKETS - 1) return '30%+ OTM';
    const lo = BUCKET_EDGES[i] * 100, hi = BUCKET_EDGES[i + 1] * 100;
    const fmt = (v) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1));
    return `${fmt(lo)}–${fmt(hi)}% OTM`;
  }

  // Dim labels used for human-readable cluster signatures.
  const DIM_LABELS = [];
  for (const kind of ['IV', 'DV']) {
    for (const side of ['put', 'call']) {
      for (let b = 0; b < N_BUCKETS; b++) {
        DIM_LABELS.push({ side, kind, bucket: b, label: `${side} ${kind === 'IV' ? 'IV' : 'DV'} @ ${bucketLabel(b)}` });
      }
    }
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

  function distSq(a, b) {
    let s = 0;
    for (let j = 0; j < a.length; j++) { const d = a[j] - b[j]; s += d * d; }
    return s;
  }

  function kmeansOnce(X, k, rng) {
    const n = X.length, p = X[0].length;
    // k-means++ seeding
    const centers = [X[Math.floor(rng() * n)].slice()];
    const closest = new Array(n).fill(Infinity);
    while (centers.length < k) {
      const c = centers[centers.length - 1];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.min(closest[i], distSq(X[i], c));
        closest[i] = d; sum += d;
      }
      if (sum <= 1e-12) { // all points identical/near — fill with duplicates
        centers.push(X[Math.floor(rng() * n)].slice());
        continue;
      }
      let r = rng() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= closest[i]; if (r <= 0) { pick = i; break; } }
      centers.push(X[pick].slice());
    }
    const assign = new Array(n).fill(-1);
    let inertia = 0;
    for (let iter = 0; iter < 100; iter++) {
      inertia = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = distSq(X[i], centers[c]);
          if (d < bd) { bd = d; best = c; }
        }
        assign[i] = best; inertia += bd;
      }
      const sums = Array.from({ length: k }, () => new Array(p).fill(0));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < n; i++) {
        counts[assign[i]]++;
        for (let j = 0; j < p; j++) sums[assign[i]][j] += X[i][j];
      }
      let shift = 0;
      for (let c = 0; c < k; c++) {
        if (counts[c] === 0) {
          // Empty cluster: reseed at the point farthest from its center.
          let far = 0, fd = -1;
          for (let i = 0; i < n; i++) {
            const d = distSq(X[i], centers[assign[i]]);
            if (d > fd) { fd = d; far = i; }
          }
          centers[c] = X[far].slice();
          shift = Infinity;
          continue;
        }
        for (let j = 0; j < p; j++) {
          const nv = sums[c][j] / counts[c];
          shift += Math.abs(nv - centers[c][j]);
          centers[c][j] = nv;
        }
      }
      if (shift < 1e-6) break;
    }
    return { assign, inertia };
  }

  function kmeansBest(X, k, opts) {
    let best = null;
    for (let r = 0; r < opts.restarts; r++) {
      const run = kmeansOnce(X, k, mulberry32(opts.seed + r * 7919 + k * 104729));
      if (!best || run.inertia < best.inertia) best = run;
    }
    return best;
  }

  // Pairwise Euclidean distance matrix (symmetric, zero diagonal).
  function distanceMatrix(Z) {
    const n = Z.length;
    const D = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        D[i][j] = D[j][i] = Math.sqrt(distSq(Z[i], Z[j]));
      }
    }
    return D;
  }

  // Per-sample silhouette coefficients from a precomputed distance matrix.
  // Singleton clusters score 0 by convention.
  function silhouette(D, assign) {
    const n = D.length;
    const ids = [...new Set(assign)];
    const members = {};
    for (const c of ids) members[c] = [];
    for (let i = 0; i < n; i++) members[assign[i]].push(i);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const own = members[assign[i]];
      if (own.length === 1) { out[i] = 0; continue; }
      let a = 0;
      for (const j of own) a += D[i][j];
      a /= (own.length - 1);
      let b = Infinity;
      for (const c of ids) {
        if (c === assign[i]) continue;
        let m = 0;
        for (const j of members[c]) m += D[i][j];
        m /= members[c].length;
        if (m < b) b = m;
      }
      // max(a,b) === 0 happens between identical points (e.g. two all-quiet
      // tickers with zero deltas) — undefined by the formula, score them 0.
      out[i] = (b === Infinity || Math.max(a, b) === 0) ? 0 : (b - a) / Math.max(a, b);
    }
    return out;
  }

  // Human-readable signature: the dims where this cluster's standardized centroid
  // separates most, described in raw delta units (vol points / DV-share points).
  function clusterSignature(zCentroid, rawCentroid) {
    const parts = [];
    const idx = DIM_LABELS.map((_, i) => i).sort((a, b) => Math.abs(zCentroid[b]) - Math.abs(zCentroid[a]));
    for (const i of idx) {
      if (parts.length >= 3) break;
      if (Math.abs(zCentroid[i]) < 0.3) break;
      const L = DIM_LABELS[i];
      const v = rawCentroid[i] || 0;
      const mag = L.kind === 'IV'
        ? `${v >= 0 ? '+' : ''}${v.toFixed(1)} vol`
        : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}pp`;
      parts.push(`${L.label} ${mag}`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'flat / no distinctive move';
  }

  // Turn a raw k-means assignment into the report-shaped output: clusters
  // relabeled C1..Cn by size descending, with per-cluster signature, average
  // move/strength and members, plus the per-ticker map. Shared so the main
  // process and the report's inline script produce identical structures.
  function assembleClusters({ rows, Z, moves, rowTickers, assign, sil }) {
    const n = rowTickers.length;
    const sizeByOld = {};
    for (const c of assign) sizeByOld[c] = (sizeByOld[c] || 0) + 1;
    const remap = {};
    Object.keys(sizeByOld)
      .sort((a, b) => sizeByOld[b] - sizeByOld[a])
      .forEach((old, i) => { remap[old] = `C${i + 1}`; });
    const relabeled = assign.map(c => remap[c]);

    const clusterIds = [...new Set(relabeled)];
    const clusters = clusterIds.map((id) => {
      const idxs = [];
      for (let i = 0; i < n; i++) if (relabeled[i] === id) idxs.push(i);
      const rawCentroid = new Array(N_DIMS).fill(0);
      const zCentroid = new Array(N_DIMS).fill(0);
      for (const i of idxs) {
        for (let d = 0; d < N_DIMS; d++) {
          rawCentroid[d] += rows[i][d];
          zCentroid[d] += Z[i][d];
        }
      }
      for (let d = 0; d < N_DIMS; d++) { rawCentroid[d] /= idxs.length; zCentroid[d] /= idxs.length; }
      const strengths = idxs.map(i => sil[i]);
      const avgMove = idxs.reduce((s, i) => s + moves[i], 0) / idxs.length;
      return {
        id,
        size: idxs.length,
        avgStrength: strengths.reduce((s, x) => s + x, 0) / idxs.length,
        avgMove: Math.round(avgMove * 10) / 10,
        signature: clusterSignature(zCentroid, rawCentroid),
        members: idxs.map(i => rowTickers[i]).sort(),
      };
    });

    const byTicker = {};
    for (let i = 0; i < n; i++) {
      byTicker[rowTickers[i]] = {
        cluster: relabeled[i],
        strength: Math.round(sil[i] * 100) / 100,
        move: Math.round(moves[i] * 10) / 10,
      };
    }
    return { byTicker, clusters };
  }

  return {
    N_DIMS, DIM_LABELS,
    mulberry32, distSq, kmeansOnce, kmeansBest,
    distanceMatrix, silhouette, clusterSignature, assembleClusters,
  };
});
