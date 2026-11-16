// Generates the standalone "cluster investigation" page — the companion to a
// screening run's report. The main report keeps the (hideable, pre-cluster)
// PC1/PC2 shape map; this page is where the clustering itself is explored: pick
// k, apply, inspect clusters, with space reserved for further development.
// It embeds clusterCore.js plus the run's shape data, so it re-clusters
// client-side with results identical to the main process for the same k.
//
// The shape map has two modes: 2D (PC1/PC2) and 3D (PC1/PC2/PC3, drag to
// rotate). Both are dependency-free SVG; 3D projects the points through a
// yaw/pitch rotation, sorts by depth, and scales dot size/opacity with depth.

const fs = require('fs');
const path = require('path');

const clusterCoreSrc = fs.readFileSync(path.join(__dirname, 'clusterCore.js'), 'utf8');

const CLUSTER_COLORS = ['#5b9bd5', '#c79bd5', '#5bbd8a', '#d5a15b', '#d57b9b', '#8fce6f', '#5bd0d5', '#b5a8e0'];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateClusterInvestigationHTML(clusterResult) {
  const client = clusterResult && clusterResult.client;
  const meta = (clusterResult && clusterResult.meta) || {};
  if (!client) return null;

  const data = { ...client, colors: CLUSTER_COLORS, asOf: meta.asOf || '', universe: meta.universe || '' };
  const dataEmbed = 'window.__CLUSTER_DATA__ = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Cluster Investigation — ${escapeHtml(meta.asOf || '')}</title>
<style>
  body { margin: 0; background: #12141a; color: #d4dae3; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 28px 48px; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  .meta { color: #9aa5b4; font-size: 0.85em; margin-bottom: 18px; }
  .card { background: #1a1d25; border: 1px solid #2a3040; border-radius: 10px; padding: 14px 16px; }
  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .controls label { font-size: 0.85em; color: #9aa5b4; }
  .controls input { width: 60px; padding: 4px 8px; background: #12141a; color: #d4dae3; border: 1px solid #2a3040; border-radius: 6px; }
  button { padding: 4px 14px; border-radius: 6px; cursor: pointer; font-size: 0.88em; }
  .btn-primary { border: 1px solid #5b9bd5; background: #5b9bd5; color: #fff; }
  .btn-ghost { border: 1px solid #2a3040; background: #1a1d25; color: #9aa5b4; }
  #cluster-status { color: #9aa5b4; font-size: 0.85em; }
  .layout { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .plot-card { flex: 0 1 680px; }
  .clusters-card { flex: 1 1 380px; min-width: 340px; }
  .card h2 { font-size: 0.95em; margin: 0 0 10px; color: #9aa5b4; font-weight: 600; }
  .plot-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .plot-head h2 { margin: 0; }
  #cluster-rows { display: flex; flex-direction: column; gap: 8px; }
  .cluster-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 6px 8px; background: #12141a; border: 1px solid #232837; border-radius: 8px; cursor: pointer; }
  .cluster-row .stats { color: #9aa5b4; font-size: 0.8em; white-space: nowrap; }
  .cluster-row .sig { color: #d4dae3; font-size: 0.84em; flex: 1 1 240px; }
  .cluster-row .members { color: #6b7a8d; font-size: 0.8em; flex: 1 1 100%; }
  .cluster-chip { display: inline-block; margin: 1px 2px; padding: 1px 8px; border-radius: 10px; font-size: 0.8em; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .hint { color: #6b7a8d; font-size: 0.82em; }
  .section { margin-top: 20px; }
  svg text { font-family: inherit; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Cluster Investigation</h1>
  <div class="meta">${escapeHtml(meta.asOf ? `as of ${meta.asOf}` : '')}${meta.universe ? ` · ${escapeHtml(meta.universe)}` : ''} · ${meta.n} tickers · run k=${meta.k}${meta.kSource === 'manual' ? ' manual' : ' auto'} · silhouette ${meta.silhouette}${meta.weak ? ' (weak structure)' : ''}</div>

  <div class="controls card">
    <label for="cluster-k">clusters k</label>
    <input id="cluster-k" type="number" min="2" max="${client.kMax}" step="1" value="${meta.k}">
    <button id="cluster-apply" class="btn-primary" type="button">Cluster</button>
    <button id="cluster-reset" class="btn-ghost" type="button">Reset view</button>
    <span id="cluster-status">Pre-cluster view — pick k and press Cluster.</span>
  </div>

  <div class="layout">
    <div class="card plot-card">
      <div class="plot-head">
        <h2>Shape map — principal components of today's delta shapes</h2>
        <button id="plot-mode" class="btn-ghost" type="button">Show 3D (PC1/PC2/PC3)</button>
      </div>
      <div id="plot-mount"></div>
      <div class="hint" style="margin-top:8px;" id="plot-hint">2D: nearby dots = similar-shaped moves (distance ≈ cosine; only ~PC1+PC2 variance is shown, so distant dots are suggestive, nearby dots are meaningful). Dot size = move strength σ. Click a dot to highlight its cluster below.</div>
    </div>
    <div class="card clusters-card">
      <h2>Clusters</h2>
      <div id="cluster-rows"><div class="hint">Press Cluster to compute clusters for the chosen k.</div></div>
    </div>
  </div>

  <div class="card section" id="cluster-dev-space">
    <h2>Notes</h2>
    <div class="hint">This page is the working space for cluster analysis on this run's data (shape rows are embedded — everything recomputes locally). Further per-cluster diagnostics can be added here.</div>
  </div>
</div>
<script>${clusterCoreSrc}<\/script>
<script>
${dataEmbed}
(function () {
  const DATA = window.__CLUSTER_DATA__;
  if (!DATA || !window.ClusterCore) return;
  const Core = window.ClusterCore;
  const mount = document.getElementById('plot-mount');
  const modeBtn = document.getElementById('plot-mode');
  const plotHint = document.getElementById('plot-hint');
  const rowsEl = document.getElementById('cluster-rows');
  const kInput = document.getElementById('cluster-k');
  const applyBtn = document.getElementById('cluster-apply');
  const resetBtn = document.getElementById('cluster-reset');
  const statusEl = document.getElementById('cluster-status');

  const colorOf = (id) => {
    const n = parseInt(String(id).replace(/^C/, ''), 10);
    return Number.isFinite(n) ? DATA.colors[(n - 1) % DATA.colors.length] : '#999';
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const l2 = (v) => { let s = 0; for (let j = 0; j < v.length; j++) s += v[j] * v[j]; return Math.sqrt(s); };
  const moves = DATA.Z.map(l2);
  const Zn = DATA.Z.map((v, i) => moves[i] > 1e-12 ? v.map(x => x / moves[i]) : v.slice());
  const Dmat = Core.distanceMatrix(Zn);

  // ── shape map: 2D (PC1/PC2) or 3D (PC1/PC2/PC3, drag to rotate) ──
  const svgNS = 'http://www.w3.org/2000/svg';
  const S = 620, PAD = 44;
  let mode = '2d';
  let yaw = -0.55, pitch = 0.32; // initial 3D viewing angle
  let dotsById = {};

  const maxMove = Math.max.apply(null, [1e-9].concat(DATA.points.map(p => p.move || 0)));
  const dotR = (p) => 3.5 + 8 * Math.min(1, (p.move || 0) / maxMove);

  // 2D scales (PC1/PC2, independent axis ranges, y flipped)
  const xs = DATA.points.map(p => p.x), ys = DATA.points.map(p => p.y);
  let x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  let y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; }
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const sx2 = (v) => PAD + (v - x0) / (x1 - x0) * (S - 2 * PAD);
  const sy2 = (v) => S - PAD - (v - y0) / (y1 - y0) * (S - 2 * PAD);

  // 3D: per-axis normalization to [-1,1], then yaw/pitch rotation. depth > 0
  // means farther from the viewer; used for size/opacity and paint order.
  const axMax = Math.max(1e-9, Math.max.apply(null, DATA.points.map(p => Math.abs(p.x || 0))));
  const ayMax = Math.max(1e-9, Math.max.apply(null, DATA.points.map(p => Math.abs(p.y || 0))));
  const azMax = Math.max(1e-9, Math.max.apply(null, DATA.points.map(p => Math.abs(p.z || 0))));
  const proj3 = (px, py, pz) => {
    const nx = (px || 0) / axMax, ny = (py || 0) / ayMax, nz = (pz || 0) / azMax;
    const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch);
    const xr = nx * ca - nz * sa, zr = nx * sa + nz * ca;
    const yr = ny * cb - zr * sb, depth = ny * sb + zr * cb;
    const scale = (S - 2 * PAD) / 2;
    return { cx: S / 2 + xr * scale, cy: S / 2 - yr * scale, depth: depth };
  };
  const depthFade = (d) => Math.max(0, Math.min(1, 1 - (d + 1) / 2.4)); // 1 near, 0 far

  const ve = DATA.varExplained || [];
  const pct = (i) => ve[i] != null ? (ve[i] * 100).toFixed(0) + '%' : '';

  const el = (name, attrs, parent) => {
    const e = document.createElementNS(svgNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || null) && parent.appendChild(e);
    return e;
  };

  const renderPlot = () => {
    dotsById = {};
    mount.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 ' + S + ' ' + S });
    svg.setAttribute('style', 'width:100%; height:auto; display:block; user-select:none; touch-action:none;');

    if (mode === '2d') {
      el('line', { x1: PAD, y1: S - PAD, x2: S - PAD, y2: S - PAD, stroke: '#2e333d' }, svg);
      el('line', { x1: PAD, y1: PAD, x2: PAD, y2: S - PAD, stroke: '#2e333d' }, svg);
      const t1 = el('text', { x: S - PAD, y: S - 14, 'font-size': '11', fill: '#9aa5b4', 'text-anchor': 'end' }, svg);
      t1.textContent = 'PC1 ' + pct(0);
      const t2 = el('text', { x: PAD + 4, y: 18, 'font-size': '11', fill: '#9aa5b4' }, svg);
      t2.textContent = 'PC2 ' + pct(1);
    } else {
      // axes triad from the origin so the rotation is readable
      const origin = proj3(0, 0, 0);
      const axes = [
        { v: [axMax, 0, 0], label: 'PC1 ' + pct(0) },
        { v: [0, ayMax, 0], label: 'PC2 ' + pct(1) },
        { v: [0, 0, azMax], label: 'PC3 ' + pct(2) },
      ];
      for (const a of axes) {
        const tip = proj3(a.v[0], a.v[1], a.v[2]);
        el('line', { x1: origin.cx, y1: origin.cy, x2: tip.cx, y2: tip.cy, stroke: '#2e333d', 'stroke-dasharray': '4 3' }, svg);
        const t = el('text', { x: tip.cx, y: tip.cy, 'font-size': '11', fill: '#9aa5b4', 'text-anchor': 'middle' }, svg);
        t.textContent = a.label;
        t.style.pointerEvents = 'none';
      }
    }

    // point positions (+depth for 3D), far points painted first
    const placed = DATA.points.map(p => {
      if (mode === '2d') return { p: p, cx: sx2(p.x), cy: sy2(p.y), depth: 0 };
      const q = proj3(p.x, p.y, p.z);
      return { p: p, cx: q.cx, cy: q.cy, depth: q.depth };
    });
    if (mode === '3d') placed.sort((a, b) => b.depth - a.depth);

    for (const pl of placed) {
      const p = pl.p;
      const fade = mode === '3d' ? depthFade(pl.depth) : 1;
      const g = el('g', {}, svg);
      const c = el('circle', {
        class: 'cluster-dot',
        'data-ticker': p.ticker,
        cx: pl.cx.toFixed(1), cy: pl.cy.toFixed(1),
        r: (dotR(p) * (0.65 + 0.55 * fade)).toFixed(1),
        fill: '#93a1b3', 'fill-opacity': (0.5 + 0.4 * fade).toFixed(2),
        stroke: '#93a1b3', 'stroke-width': '1',
      }, g);
      c.style.cursor = 'pointer';
      const title = el('title', {}, c);
      const tx = el('text', {
        x: (pl.cx + dotR(p) + 3).toFixed(1), y: (pl.cy + 3).toFixed(1),
        'font-size': '10', fill: mode === '3d' ? '#c3ccd9' : '#9aa5b4',
        opacity: (0.55 + 0.45 * fade).toFixed(2),
      }, g);
      tx.style.pointerEvents = 'none';
      tx.textContent = p.ticker;
      dotsById[p.ticker] = c;
    }

    if (mode === '3d') {
      // drag to rotate (pointer events cover mouse + touch)
      let drag = null;
      svg.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY };
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (!drag) return;
        yaw += (e.clientX - drag.x) * 0.008;
        pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - drag.y) * 0.008));
        drag = { x: e.clientX, y: e.clientY };
        renderPlot();
        paintDots();
        highlight();
      });
      const endDrag = () => { drag = null; };
      svg.addEventListener('pointerup', endDrag);
      svg.addEventListener('pointercancel', endDrag);
      svg.addEventListener('pointerleave', endDrag);
    }

    mount.appendChild(svg);
    modeBtn.textContent = mode === '2d' ? 'Show 3D (PC1/PC2/PC3)' : 'Back to 2D (PC1/PC2)';
    plotHint.textContent = mode === '2d'
      ? '2D: nearby dots = similar-shaped moves (distance ≈ cosine; only ~PC1+PC2 variance is shown, so distant dots are suggestive, nearby dots are meaningful). Dot size = move strength σ. Click a dot to highlight its cluster below.'
      : '3D: PC1/PC2/PC3 — drag to rotate. Nearby dots = similar shapes; depth fades far dots. Still a projection of the 52-dim cosine space: use it to sense separability, trust cluster membership over on-screen geometry.';
  };

  // ── clustering (same math as the main process: clusterCore.js) ──
  const runK = (k) => {
    const kk = Math.max(2, Math.min(DATA.kMax, k | 0));
    const run = Core.kmeansBest(Zn, kk, { restarts: DATA.restarts, seed: DATA.seed });
    const sil = Core.silhouette(Dmat, run.assign);
    const meanSil = sil.reduce((s, x) => s + x, 0) / sil.length;
    const assembled = Core.assembleClusters({ rows: DATA.rows, Z: DATA.Z, moves: moves, rowTickers: DATA.tickers, assign: run.assign, sil: sil });
    return { k: kk, meanSil: meanSil, clusters: assembled.clusters, byTicker: assembled.byTicker };
  };
  const clusterById = {};
  let moveMax = 1e-9;
  let activeCluster = null;
  let currentColoring = null; // byTicker map once applied; null = pre-cluster view
  const tintOf = (id) => {
    const c = clusterById[id];
    if (!c) return '#12141a';
    const alpha = Math.round((0.10 + 0.50 * Math.min(1, (c.avgMove || 0) / moveMax)) * 255);
    return colorOf(id) + alpha.toString(16).padStart(2, '0');
  };
  const chipHtml = (id) => {
    const c = clusterById[id];
    const tip = c ? id + ' — n=' + c.size + ' · avg move σ=' + c.avgMove + ' · sil=' + c.avgStrength.toFixed(2) + ' · ' + c.signature : id;
    return '<span class="cluster-chip" data-cluster="' + id + '" title="' + esc(tip) + '" style="background:' + tintOf(id) + '; color:' + colorOf(id) + '; border:1px solid ' + colorOf(id) + ';">' + id + '</span>';
  };
  const rowHtml = (c) => '<div class="cluster-row" data-cluster="' + c.id + '">' +
    chipHtml(c.id) +
    '<span class="stats">n=' + c.size + ' · σ ' + c.avgMove.toFixed(1) + ' · sil ' + c.avgStrength.toFixed(2) + '</span>' +
    '<span class="sig">' + esc(c.signature) + '</span>' +
    '<span class="members">' + c.members.join(' ') + '</span></div>';
  const highlight = () => {
    rowsEl.querySelectorAll('.cluster-row').forEach(r => {
      r.style.outline = r.getAttribute('data-cluster') === activeCluster ? '2px solid #7aa2c7' : 'none';
    });
    Object.keys(dotsById).forEach(t => {
      const dot = dotsById[t];
      const cluster = dot.getAttribute('data-cluster');
      const active = activeCluster != null && cluster === activeCluster;
      dot.setAttribute('stroke', active ? '#e8eef7' : (cluster ? colorOf(cluster) : '#93a1b3'));
      dot.setAttribute('stroke-width', active ? '2.5' : '1');
    });
  };
  // (re)color the currently rendered dots — called after apply/reset and after
  // each plot re-render (mode switch or 3D rotation frame)
  const paintDots = () => {
    for (const p of DATA.points) {
      const dot = dotsById[p.ticker];
      if (!dot) continue;
      const bt = currentColoring ? currentColoring[p.ticker] : null;
      const title = dot.querySelector('title');
      if (bt) {
        dot.setAttribute('data-cluster', bt.cluster);
        dot.setAttribute('fill', colorOf(bt.cluster));
        dot.setAttribute('stroke', colorOf(bt.cluster));
        if (title) title.textContent = p.ticker + ' — ' + bt.cluster + ' · move σ=' + bt.move + ' · sil ' + bt.strength.toFixed(2);
      } else {
        dot.removeAttribute('data-cluster');
        dot.setAttribute('fill', '#93a1b3');
        dot.setAttribute('stroke', '#93a1b3');
        if (title) title.textContent = p.ticker + ' — move σ=' + p.move + ' (uncolored: pre-cluster view)';
      }
    }
  };
  const applyClustering = (k) => {
    const res = runK(k);
    moveMax = Math.max.apply(null, [1e-9].concat(res.clusters.map(c => c.avgMove || 0)));
    for (const c of res.clusters) clusterById[c.id] = c;
    currentColoring = res.byTicker;
    paintDots();
    rowsEl.innerHTML = res.clusters.map(rowHtml).join('');
    rowsEl.querySelectorAll('.cluster-row').forEach(r => r.addEventListener('click', () => {
      const id = r.getAttribute('data-cluster');
      activeCluster = (activeCluster === id) ? null : id;
      highlight();
    }));
    activeCluster = null;
    highlight();
    statusEl.textContent = 'k=' + res.k + ' · silhouette ' + res.meanSil.toFixed(2) + (res.meanSil < DATA.weakSilhouette ? ' · weak structure' : '');
  };

  modeBtn.addEventListener('click', () => {
    mode = mode === '2d' ? '3d' : '2d';
    renderPlot();
    paintDots();
    highlight();
  });
  let applied = false;
  applyBtn.addEventListener('click', () => {
    applied = true;
    applyClustering(parseInt(kInput.value, 10) || DATA.kAuto);
  });
  kInput.addEventListener('change', () => {
    if (applied) applyClustering(parseInt(kInput.value, 10) || DATA.kAuto);
  });
  resetBtn.addEventListener('click', () => {
    applied = false;
    currentColoring = null;
    kInput.value = DATA.kAuto;
    paintDots();
    activeCluster = null;
    highlight();
    rowsEl.innerHTML = '<div class="hint">Press Cluster to compute clusters for the chosen k.</div>';
    statusEl.textContent = 'Pre-cluster view — pick k and press Cluster.';
  });

  renderPlot();
  paintDots();
})();
<\/script>
</body>
</html>`;
}

module.exports = { generateClusterInvestigationHTML };
