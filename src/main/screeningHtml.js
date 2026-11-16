// Generates the standalone screening-results HTML report.
// Extracted from main.js — takes plain data arguments only.

const { TAG_LABELS: EVENT_TAG_LABELS } = require('../services/eventTags');
const { combineHistRecord } = require('./screeningStats');
const { formatAge } = require('../../ci/ticker-screen');

function generateScreeningHTML(allTickers, totalTickers, config, ivHistoryData = {}, preEventStats = {}, notes = {}, preEventByReturnBucket = null, preEventContrast = null, peLiveSlopeByTicker = {}, toDelete = [], freshness = null, suggestedTickers = [], eventsByTicker = {}, clusterResult = null, suggestedMeta = {}, clusterPageName = null) {
  const suggestedSet = new Set(suggestedTickers);
  const classColors = {
    surprising_positive: '#4caf50',
    positive_anticipated: '#8bc34a',
    negative_anticipated: '#ff9800',
    surprising_negative: '#f44336',
  };

  const classLabels = {
    surprising_positive: 'Surprising +',
    positive_anticipated: 'Anticipated +',
    negative_anticipated: 'Anticipated -',
    surprising_negative: 'Surprising -',
  };

  // ── Options delta-shape clustering (optionsClusters.js) ──
  // byTicker: {ticker: {cluster, strength}}; clusters carry the signature text.
  const clusterMeta = clusterResult && clusterResult.meta && clusterResult.meta.ok ? clusterResult.meta : null;
  const clusterByTicker = (clusterResult && clusterResult.byTicker) || {};
  const clusterById = {};
  if (clusterResult && Array.isArray(clusterResult.clusters)) {
    for (const c of clusterResult.clusters) clusterById[c.id] = c;
  }
  const CLUSTER_COLORS = ['#5b9bd5', '#c79bd5', '#5bbd9a', '#d5a15b', '#d57b9b', '#8fce6f', '#5bd0d5', '#b5a8e0'];
  const clusterColor = (id) => {
    const n = parseInt(String(id).replace(/^C/, ''), 10);
    return Number.isFinite(n) ? CLUSTER_COLORS[(n - 1) % CLUSTER_COLORS.length] : '#999';
  };
  // Client payload presence gates the "Cluster investigation" companion page
  // (clusterInvestigationHtml.js), which embeds this data for in-page re-clustering.
  const clusterClient = clusterResult && clusterResult.client ? true : null;
  // Cluster-level prominence drives the chip's background tint: the stronger a
  // cluster's average move (σ), the more saturated its chips, so significant
  // groups pop out of the table at a glance while near-quiet clusters stay pale.
  const clusterMoveMax = Math.max(1e-9, ...Object.values(clusterById).map(c => c.avgMove || 0));
  const clusterTint = (id) => {
    const c = clusterById[id];
    if (!c) return '#1e2433';
    const alpha = Math.round((0.10 + 0.50 * Math.min(1, (c.avgMove || 0) / clusterMoveMax)) * 255);
    return clusterColor(id) + alpha.toString(16).padStart(2, '0');
  };
  const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clusterChipHtml = (id, strength, move) => {
    const c = clusterById[id];
    const tip = c
      ? `${id} — n=${c.size} tickers · cluster avg move σ=${c.avgMove} · separation sil=${c.avgStrength.toFixed(2)} · ${c.signature}${move != null ? ` · this ticker: move σ=${move.toFixed(1)}` : ''}`
      : id;
    const sizeTag = c ? `<sup style="font-size:0.7em; line-height:0;">${c.size}</sup>` : '';
    return `<span class="cluster-chip" data-cluster="${id}" title="${escapeAttr(tip)}" style="display:inline-block; margin:1px 2px; padding:1px 6px; background:${clusterTint(id)}; color:${clusterColor(id)}; border:1px solid ${clusterColor(id)}; border-radius:8px; font-size:0.74em; font-weight:600; cursor:pointer; white-space:nowrap;">${id}${sizeTag}${move != null ? ' ·σ' + move.toFixed(1) : ''}${strength != null ? ' ·' + strength.toFixed(2) : ''}</span>`;
  };
  // Shape-map scatter: top-2 PCs of the normalized delta shapes. Built before
  // the panel template below so it can be dropped in as a block.
  const clusterPlotSvg = (() => {
    const plot = clusterResult && clusterResult.plot;
    if (!clusterMeta || !plot || !Array.isArray(plot.points) || plot.points.length < 2) return '';
    const W = 520, H = 520, PAD = 40;
    const xs = plot.points.map(p => p.x), ys = plot.points.map(p => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; }
    if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
    const sx = (v) => PAD + (v - x0) / (x1 - x0) * (W - 2 * PAD);
    const sy = (v) => H - PAD - (v - y0) / (y1 - y0) * (H - 2 * PAD);
    const maxMove = Math.max(1e-9, ...plot.points.map(p => p.move || 0));
    const dotR = (p) => 3 + 7 * Math.min(1, (p.move || 0) / maxMove);
    // Pre-cluster view: dots start uncolored; the inline script colors them by
    // cluster once the user picks k and applies. Every ticker is labeled — this
    // plot doubles as the "see the screened tickers" overview before clustering.
    const dots = plot.points.map(p => {
      const tip = `${p.ticker} — move σ=${p.move} (uncolored: pre-cluster view)`;
      const cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1), rr = dotR(p).toFixed(1);
      return `<g><circle class="cluster-dot" data-ticker="${p.ticker}" cx="${cx}" cy="${cy}" r="${rr}" fill="#93a1b3" fill-opacity="0.72" stroke="#93a1b3" stroke-width="1" style="cursor:pointer;"><title>${escapeAttr(tip)}</title></circle><text x="${(+cx + +rr + 3).toFixed(1)}" y="${(+cy + 3).toFixed(1)}" font-size="9.5" fill="#9aa5b4" style="pointer-events:none;">${p.ticker}</text></g>`;
    }).join('');
    const ve = plot.varExplained || [];
    return `<div style="margin-top:10px; border-top:1px solid #eee; padding-top:8px;">
  <button id="cluster-plot-toggle" type="button" style="padding:2px 10px; border:1px solid #3a4a6a; background:#1e2433; color:#8fa8d0; border-radius:4px; cursor:pointer; font-size:0.85em;">▸ Show shape map (PC1/PC2)</button>
  <div id="cluster-plot-wrap" style="display:none; margin-top:8px;">
  <div style="color:#9aa5b4; font-size:0.8em; margin-bottom:4px;">Shape map — top-2 principal components of today's delta shapes (nearby dots = similar-shaped moves, distance ≈ cosine; only ~PC1+PC2 variance is shown, so distant dots are suggestive, nearby dots are meaningful). Dot size = move strength σ. Starts uncolored (pre-cluster view); press Cluster to color by cluster — then click a dot to filter the table by its cluster.</div>
  <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:560px; height:auto; display:block; margin:0 auto; background:#12141a; border:1px solid #2a3040; border-radius:8px;">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#2e333d"/>
    <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#2e333d"/>
    <text x="${W - PAD}" y="${H - 12}" text-anchor="end" font-size="10" fill="#9aa5b4">PC1 ${ve[0] != null ? (ve[0] * 100).toFixed(0) + '%' : ''}</text>
    <text x="${PAD + 4}" y="16" font-size="10" fill="#9aa5b4">PC2 ${ve[1] != null ? (ve[1] * 100).toFixed(0) + '%' : ''}</text>
    ${dots}
  </svg></div></div>`;
  })();

  const clusterPanelHtml = !clusterMeta ? '' : `
<div id="cluster-panel" style="margin-bottom:14px; padding:12px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">
    <div style="color:#666; font-weight:600;">Options Delta-Shape Clusters
      <span style="color:#999; font-weight:normal; font-size:0.85em; margin-left:8px;">(k=${clusterMeta.k}${clusterMeta.kSource === 'manual' ? ' manual' : ' auto'} · silhouette ${clusterMeta.silhouette}${clusterMeta.weak ? ' · <b style="color:#ef6c00;">weak structure today</b>' : ''} · ${clusterMeta.n} tickers clustered vs their own 60-day baseline${clusterMeta.universe ? ` · ${escapeAttr(clusterMeta.universe)}` : ''}${clusterMeta.excludedStale || clusterMeta.excludedShort ? ` · ${clusterMeta.excludedStale} stale, ${clusterMeta.excludedShort} short-history excluded` : ''})</span>
    </div>
    ${clusterClient && clusterPageName ? `
    <button type="button" onclick="window.open('${escapeAttr(clusterPageName)}', '_blank')" style="padding:2px 12px; border:1px solid #3a4a6a; background:#1e2433; color:#8fa8d0; border-radius:4px; cursor:pointer; font-size:0.85em;">Cluster investigation…</button>` : ''}
  </div>
  <div style="color:#999; font-size:0.82em; margin-bottom:6px;">Table chips below use this run's k${clusterClient && clusterPageName ? ' — open the cluster investigation to explore other k on the same data' : ''}.</div>
  <div style="display:flex; flex-direction:column; gap:6px;">
    ${clusterResult.clusters.map(c => `
    <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
      ${clusterChipHtml(c.id, null, c.avgMove)}
      <span style="color:#888; font-size:0.82em; white-space:nowrap;">n=${c.size} · σ ${c.avgMove != null ? c.avgMove.toFixed(1) : '?'} · sil ${c.avgStrength.toFixed(2)}</span>
      <span style="color:#444; font-size:0.85em; flex:1 1 280px;">${escapeAttr(c.signature)}</span>
      <span style="color:#999; font-size:0.8em; max-width:640px;">${c.members.slice(0, 12).join(' ')}${c.members.length > 12 ? ` +${c.members.length - 12} more` : ''}</span>
    </div>`).join('')}
  </div>
  ${clusterPlotSvg}
</div>`;

  const hitCount = allTickers.filter(h => h.classification).length;
  const deleteSet = new Set(toDelete);

  // Combine IV from up to 3 expirations, weighted by dollar volume per expiration.
  // Single-pool combination across up to 3 nearest expirations.
  // Each side (OTM call / OTM put / ATM-band call / ATM-band put) is weighted
  // by its own DV, independently. The ATM side uses the band-definition IV
  // (complement of the OTM filter) now that it's available on each expiration.
  function combineExpirations(os) {
    const exps = os.filter(exp => exp && (exp.wCallIV > 0 || exp.wPutIV > 0));
    if (exps.length === 0) return null;

    const sumDV = (arr) => arr.reduce((s, c) => s + (c.dollarVol || 0), 0);
    const poolWeighted = (valueFn, weightFn) => {
      let sumVW = 0, sumW = 0;
      for (const e of exps) {
        const v = valueFn(e);
        const w = weightFn(e);
        if (v == null || !(w > 0)) continue;
        sumVW += v * w;
        sumW += w;
      }
      return sumW > 0 ? sumVW / sumW : 0;
    };

    const callIV = poolWeighted(
      (e) => (e.wCallIV > 0 ? e.wCallIV : null),
      (e) => sumDV(e.calls || []),
    );
    const putIV = poolWeighted(
      (e) => (e.wPutIV > 0 ? e.wPutIV : null),
      (e) => sumDV(e.puts || []),
    );
    const atmCallIV = poolWeighted(
      (e) => (e.atmBandCallIV != null && e.atmBandCallIV > 0 ? e.atmBandCallIV : (e.atmCallIV > 0 ? e.atmCallIV : null)),
      (e) => (e.atmCallDV != null ? e.atmCallDV : sumDV(e.calls || [])),
    );
    const atmPutIV = poolWeighted(
      (e) => (e.atmBandPutIV != null && e.atmBandPutIV > 0 ? e.atmBandPutIV : (e.atmPutIV > 0 ? e.atmPutIV : null)),
      (e) => (e.atmPutDV != null ? e.atmPutDV : sumDV(e.puts || [])),
    );

    const totalDV = exps.reduce((s, e) => s + sumDV(e.calls || []) + sumDV(e.puts || []), 0);

    return {
      callIV: Math.round(callIV * 10) / 10,
      putIV: Math.round(putIV * 10) / 10,
      atmCallIV: Math.round(atmCallIV * 10) / 10,
      atmPutIV: Math.round(atmPutIV * 10) / 10,
      ivSpreadCall: Math.round((callIV - atmCallIV) * 10) / 10,
      ivSpreadPut: Math.round((putIV - atmPutIV) * 10) / 10,
      totalDV,
    };
  }

  // Build chart data JSON and summary map for each ticker
  const chartDataMap = {};
  const summaryMap = {};
  const summarySourceMap = {}; // ticker -> 'edgar' | 'yahoo' | 'wiki'
  const newsMap = {};
  const tickerIVs = {}; // { ticker: { callIV, putIV, atmCallIV, atmPutIV, ivSpreadCall, ivSpreadPut } } — DV-weighted across expirations
  const tickerOptDV = {}; // { ticker: totalDollarVol } — sum of call+put dollar vol across all expirations
  for (const h of allTickers) {
    if (h.chartData && h.chartData.dates && h.chartData.dates.length > 0) {
      chartDataMap[h.ticker] = h.chartData;
      const os = h.chartData.optionsStrikes;
      if (os && os.length > 0) {
        const combined = combineExpirations(os);
        if (combined && (combined.callIV > 0 || combined.putIV > 0)) {
          tickerIVs[h.ticker] = combined;
        }
        if (combined && combined.totalDV > 0) tickerOptDV[h.ticker] = combined.totalDV;
      }
    }
    if (h.summary) {
      summaryMap[h.ticker] = h.summary;
      if (h.descSource) summarySourceMap[h.ticker] = h.descSource;
    }
    if (h.news && h.news.length > 0) newsMap[h.ticker] = h.news;
  }

  // Compute per-ticker IV history stats from iv_history_records (DuckDB).
  // Uses exp1 (nearest expiration) to match what's displayed. Requires >=10 records
  // so percentile rank has meaningful resolution.
  const MIN_HIST_RECORDS = 10;
  const ivHistStats = {};
  // Resolve each ticker's sector: prefer current run data, fall back to last saved record
  const tickerSectors = {};
  for (const h of allTickers) {
    if (h.sector) tickerSectors[h.ticker] = h.sector;
  }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!tickerSectors[ticker] && Array.isArray(records)) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].sector) { tickerSectors[ticker] = records[i].sector; break; }
      }
    }
  }
  // Build per-sector spread distributions from all historical records
  const sectorSpreads = {}; // { sector: { callSpreads: [], putSpreads: [] } }
  // Build per-tag spread distributions from all historical records that carry that tag.
  // A historical record can contribute to multiple tag cohorts.
  const tagSpreads = {}; // { tagId: { callSpreads: [], putSpreads: [] } }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    const sec = tickerSectors[ticker];
    if (!Array.isArray(records)) continue;
    if (sec && !sectorSpreads[sec]) sectorSpreads[sec] = { callSpreads: [], putSpreads: [] };
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      const callOk = e.callIV > 0 && e.atmCallIV != null;
      const putOk = e.putIV > 0 && e.atmPutIV != null;
      const callSpr = callOk ? e.callIV - e.atmCallIV : null;
      const putSpr = putOk ? e.putIV - e.atmPutIV : null;
      if (sec) {
        if (callOk) sectorSpreads[sec].callSpreads.push(callSpr);
        if (putOk) sectorSpreads[sec].putSpreads.push(putSpr);
      }
      const recTags = Array.isArray(r.eventTags) ? r.eventTags : null;
      if (recTags) {
        for (const tag of recTags) {
          if (!tagSpreads[tag]) tagSpreads[tag] = { callSpreads: [], putSpreads: [] };
          if (callOk) tagSpreads[tag].callSpreads.push(callSpr);
          if (putOk) tagSpreads[tag].putSpreads.push(putSpr);
        }
      }
    }
  }
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!Array.isArray(records) || records.length < MIN_HIST_RECORDS) continue;
    const callIVs = [], putIVs = [], callSpreads = [], putSpreads = [], atmCallIVs = [], atmPutIVs = [];
    for (const r of records) {
      const e = combineHistRecord(r);
      if (!e) continue;
      if (e.callIV > 0) callIVs.push(e.callIV);
      if (e.putIV > 0) putIVs.push(e.putIV);
      if (e.atmCallIV != null && e.atmCallIV > 0) atmCallIVs.push(e.atmCallIV);
      if (e.atmPutIV != null && e.atmPutIV > 0) atmPutIVs.push(e.atmPutIV);
      if (e.callIV > 0 && e.atmCallIV != null) callSpreads.push(e.callIV - e.atmCallIV);
      if (e.putIV > 0 && e.atmPutIV != null) putSpreads.push(e.putIV - e.atmPutIV);
    }
    ivHistStats[ticker] = {
      callIVs: callIVs.length >= MIN_HIST_RECORDS ? callIVs : null,
      putIVs: putIVs.length >= MIN_HIST_RECORDS ? putIVs : null,
      atmCallIVs: atmCallIVs.length >= MIN_HIST_RECORDS ? atmCallIVs : null,
      atmPutIVs: atmPutIVs.length >= MIN_HIST_RECORDS ? atmPutIVs : null,
      callSpreads: callSpreads.length >= 3 ? callSpreads : null,
      putSpreads: putSpreads.length >= 3 ? putSpreads : null,
    };
  }
  const pctRank = (arr, val) => {
    if (!arr || arr.length === 0) return null;
    let below = 0;
    for (const v of arr) if (v <= val) below++;
    return Math.round((below / arr.length) * 100);
  };

  // ── Package Suggestion: compute 2-snapshot avg call spread & pairwise correlations ──

  // Step 1: Average call spread from last 2 IV history snapshots per ticker
  const avgCallSpread2 = {};
  for (const [ticker, records] of Object.entries(ivHistoryData)) {
    if (!Array.isArray(records) || records.length === 0) continue;
    const recent = records.slice(-2);
    let sum = 0, count = 0;
    for (const r of recent) {
      const e = combineHistRecord(r);
      if (!e || e.callIV <= 0 || e.atmCallIV == null) continue;
      sum += (e.callIV - e.atmCallIV);
      count++;
    }
    if (count >= 1) avgCallSpread2[ticker] = sum / count;
  }

  // Step 2: Server-side pairwise Pearson correlation for candidate tickers
  const pkgCandidates = Object.keys(avgCallSpread2)
    .filter(t => chartDataMap[t] && chartDataMap[t].dates && chartDataMap[t].closes);

  function pearsonFromCloses(cd1, cd2) {
    const dateIdx = {};
    for (let i = 0; i < cd1.dates.length; i++) dateIdx[cd1.dates[i]] = i;
    const pairedSrc = [], pairedOther = [];
    let prevSrcIdx = -1, prevOtherIdx = -1;
    for (let j = 0; j < cd2.dates.length; j++) {
      const srcI = dateIdx[cd2.dates[j]];
      if (srcI == null) { prevOtherIdx = j; continue; }
      if (prevSrcIdx >= 0 && prevOtherIdx >= 0
          && srcI === prevSrcIdx + 1 && j === prevOtherIdx + 1) {
        if (cd1.closes[prevSrcIdx] > 0 && cd2.closes[prevOtherIdx] > 0) {
          pairedSrc.push(Math.log(cd1.closes[srcI] / cd1.closes[prevSrcIdx]));
          pairedOther.push(Math.log(cd2.closes[j] / cd2.closes[prevOtherIdx]));
        }
      }
      prevSrcIdx = srcI;
      prevOtherIdx = j;
    }
    if (pairedSrc.length < 20) return null;
    const n = pairedSrc.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let k = 0; k < n; k++) {
      sumX += pairedSrc[k]; sumY += pairedOther[k];
      sumXY += pairedSrc[k] * pairedOther[k];
      sumX2 += pairedSrc[k] * pairedSrc[k];
      sumY2 += pairedOther[k] * pairedOther[k];
    }
    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return denom > 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  }

  const pkgCorrMatrix = {};
  for (let i = 0; i < pkgCandidates.length; i++) {
    const t1 = pkgCandidates[i];
    if (!pkgCorrMatrix[t1]) pkgCorrMatrix[t1] = {};
    for (let j = i + 1; j < pkgCandidates.length; j++) {
      const t2 = pkgCandidates[j];
      if (!pkgCorrMatrix[t2]) pkgCorrMatrix[t2] = {};
      const r = pearsonFromCloses(chartDataMap[t1], chartDataMap[t2]);
      pkgCorrMatrix[t1][t2] = r;
      pkgCorrMatrix[t2][t1] = r;
    }
  }

  // Step 3: Find best 3-ticker combination (max spread, min correlation)
  let bestCombo = null;
  let bestScore = -Infinity;
  const CORR_LAMBDA = 15;
  for (let i = 0; i < pkgCandidates.length; i++) {
    for (let j = i + 1; j < pkgCandidates.length; j++) {
      for (let k = j + 1; k < pkgCandidates.length; k++) {
        const t1 = pkgCandidates[i], t2 = pkgCandidates[j], t3 = pkgCandidates[k];
        const r12 = pkgCorrMatrix[t1][t2], r13 = pkgCorrMatrix[t1][t3], r23 = pkgCorrMatrix[t2][t3];
        if (r12 == null || r13 == null || r23 == null) continue;
        const avgCorr = (Math.abs(r12) + Math.abs(r13) + Math.abs(r23)) / 3;
        const avgSpread = (avgCallSpread2[t1] + avgCallSpread2[t2] + avgCallSpread2[t3]) / 3;
        const score = avgSpread - CORR_LAMBDA * avgCorr;
        if (score > bestScore) {
          bestScore = score;
          bestCombo = {
            tickers: [t1, t2, t3],
            avgSpread, avgCorr,
            spreads: [avgCallSpread2[t1], avgCallSpread2[t2], avgCallSpread2[t3]],
            corrs: { r12, r13, r23 },
          };
        }
      }
    }
  }

  // Compute average weighted IV and ATM IV across all tickers with data
  const ivTickers = Object.keys(tickerIVs);
  let avgCallIV = 0, avgPutIV = 0, avgAtmCallIV = 0, avgAtmPutIV = 0;
  if (ivTickers.length > 0) {
    avgCallIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].callIV, 0) / ivTickers.length * 10) / 10;
    avgPutIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].putIV, 0) / ivTickers.length * 10) / 10;
    avgAtmCallIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].atmCallIV, 0) / ivTickers.length * 10) / 10;
    avgAtmPutIV = Math.round(ivTickers.reduce((s, t) => s + tickerIVs[t].atmPutIV, 0) / ivTickers.length * 10) / 10;
  }

  // Map Outcome-Contrast features by "group:label" for per-cell outcome-lean tinting.
  const contrastByKey = {};
  if (preEventContrast && preEventContrast.ok) {
    for (const u of preEventContrast.uni) contrastByKey[u.group + ':' + u.label] = u;
  }
  // Background tint reflecting which eventual-event direction a ticker's value leans toward,
  // per the Pre-Event IV → Outcome Contrast. Green = leans positive event, red = leans negative.
  // '' when no contrast data (cell falls back to its existing styling).
  const leanBg = (group, label, v) => {
    if (v == null) return '';
    const u = contrastByKey[group + ':' + label];
    if (!u || u.diff === 0) return '';
    const mid = (u.meanPos + u.meanNeg) / 2;
    const signal = (v - mid) * Math.sign(u.diff); // >0 → positive side, <0 → negative side
    if (signal === 0) return '';
    const alpha = Math.min(0.30, 0.08 + Math.abs(u.d) * 0.28); // floor + scale by |Cohen's d|
    const rgb = signal > 0 ? '72,187,120' : '245,101,101';     // existing green / red palette
    return ` background:rgba(${rgb},${alpha.toFixed(2)});`;
  };

  const rows = allTickers.map((h, idx) => {
    const hasEvent = !!h.classification;
    const color = classColors[h.classification] || '#ccc';
    const label = classLabels[h.classification] || '';
    const hasChart = !!chartDataMap[h.ticker];
    const isDeleted = deleteSet.has(h.ticker);
    const inlineStyle = (hasEvent ? '' : 'color:#aaa;') + (hasChart ? ' cursor:pointer;' : '') + (isDeleted ? ' opacity:0.4; text-decoration:line-through;' : '');

    const mcap = h.marketCap || 0;
    const mcapStr = mcap >= 1e9 ? (mcap / 1e9).toFixed(1) + 'B' : mcap >= 1e6 ? (mcap / 1e6).toFixed(0) + 'M' : '';

    const optDV = tickerOptDV[h.ticker] || 0;
    const optDVStr = optDV >= 1e9 ? '$' + (optDV / 1e9).toFixed(1) + 'B' : optDV >= 1e6 ? '$' + (optDV / 1e6).toFixed(1) + 'M' : optDV >= 1e3 ? '$' + (optDV / 1e3).toFixed(0) + 'K' : optDV > 0 ? '$' + optDV.toFixed(0) : '';

    const tiv = tickerIVs[h.ticker];
    const callSpread = tiv ? tiv.ivSpreadCall : null;
    const putSpread = tiv ? tiv.ivSpreadPut : null;
    const stats = ivHistStats[h.ticker];
    const rankTag = (r) => r != null ? ` <span style="color:#888; font-size:0.78em;">(p${r})</span>` : '';
    const sectorRankTag = (r) => r != null ? ` <span style="color:#6a8; font-size:0.78em;">[s${r}]</span>` : '';
    const tagRankTag = (r, tag) => r != null ? ` <span style="color:#d4a657; font-size:0.78em;" title="vs ${tag} cohort">{t${r}}</span>` : '';
    const callIVRank = stats && tiv ? pctRank(stats.callIVs, tiv.callIV) : null;
    const putIVRank = stats && tiv ? pctRank(stats.putIVs, tiv.putIV) : null;
    const MIN_SPREAD_RECORDS = 3;
    const callSpreadRank = stats && stats.callSpreads && stats.callSpreads.length >= MIN_SPREAD_RECORDS && callSpread != null ? pctRank(stats.callSpreads, callSpread) : null;
    const putSpreadRank = stats && stats.putSpreads && stats.putSpreads.length >= MIN_SPREAD_RECORDS && putSpread != null ? pctRank(stats.putSpreads, putSpread) : null;
    // Sector-based spread rank: percentile within all historical spreads of same sector
    const sec = tickerSectors[h.ticker];
    const secData = sec ? sectorSpreads[sec] : null;
    const callSectorRank = secData && callSpread != null && secData.callSpreads.length >= MIN_HIST_RECORDS ? pctRank(secData.callSpreads, callSpread) : null;
    const putSectorRank = secData && putSpread != null && secData.putSpreads.length >= MIN_HIST_RECORDS ? pctRank(secData.putSpreads, putSpread) : null;
    // Tag-cohort rank: percentile within historical records carrying the ticker's strongest tag.
    // Uses first tag (highest score). Requires the same MIN_HIST_RECORDS as sector to keep it meaningful.
    const primaryTag = Array.isArray(h.eventTags) && h.eventTags.length > 0 ? h.eventTags[0] : null;
    const tagData = primaryTag ? tagSpreads[primaryTag] : null;
    const callTagRank = tagData && callSpread != null && tagData.callSpreads.length >= MIN_HIST_RECORDS ? pctRank(tagData.callSpreads, callSpread) : null;
    const putTagRank = tagData && putSpread != null && tagData.putSpreads.length >= MIN_HIST_RECORDS ? pctRank(tagData.putSpreads, putSpread) : null;
    const callIVStr = tiv ? tiv.callIV.toFixed(1) + '%' + rankTag(callIVRank) : '';
    const putIVStr = tiv ? tiv.putIV.toFixed(1) + '%' + rankTag(putIVRank) : '';
    const callIVVal = tiv ? tiv.callIV : -1;
    const putIVVal = tiv ? tiv.putIV : -1;
    const callSpreadStr = callSpread != null ? (callSpread >= 0 ? '+' : '') + callSpread.toFixed(1) + rankTag(callSpreadRank) + sectorRankTag(callSectorRank) + tagRankTag(callTagRank, primaryTag) : '';
    const putSpreadStr = putSpread != null ? (putSpread >= 0 ? '+' : '') + putSpread.toFixed(1) + rankTag(putSpreadRank) + sectorRankTag(putSectorRank) + tagRankTag(putTagRank, primaryTag) : '';
    const callSpreadVal = callSpread != null ? callSpread : -9999;
    const putSpreadVal = putSpread != null ? putSpread : -9999;
    const peSl = peLiveSlopeByTicker[h.ticker];
    const callAtmSlope = peSl && peSl.callAtm != null ? peSl.callAtm : null;
    const callSprSlope = peSl && peSl.callSpr != null ? peSl.callSpr : null;
    const slopeStr = (v) => v == null ? '' : (v > 0 ? '↑ +' : v < 0 ? '↓ ' : '') + v.toFixed(0);
    const slopeColor = (v) => v == null ? '#888' : v > 0 ? 'rgba(72,187,120,0.9)' : v < 0 ? 'rgba(245,101,101,0.9)' : '#888';
    const callAtmSlopeVal = callAtmSlope != null ? callAtmSlope : -9999;
    const callSprSlopeVal = callSprSlope != null ? callSprSlope : -9999;
    const dvDelta = peSl && peSl.dvDelta != null ? peSl.dvDelta : null;
    const dvDeltaStr = dvDelta == null ? '' : (dvDelta > 0 ? '↑ +' : dvDelta < 0 ? '↓ ' : '') + dvDelta.toFixed(0);
    const dvDeltaVal = dvDelta != null ? dvDelta : -1e9;

    const cl = clusterByTicker[h.ticker];
    const clusterId = cl && cl.cluster ? cl.cluster : null;
    const clusterVal = cl && cl.strength != null ? cl.strength : -2;
    const clusterCell = clusterId
      ? `<td class="cluster-cell" data-ticker="${h.ticker}" data-v="${clusterVal}">${clusterChipHtml(clusterId, cl.strength, cl.move)}</td>`
      : `<td class="cluster-cell" data-ticker="${h.ticker}" data-v="-2" style="color:#555; font-size:0.82em;" title="Not clustered (insufficient history or stale data)">—</td>`;


    const noteText = (notes && notes[h.ticker]) ? notes[h.ticker] : '';
    const hasNote = !!noteText;
    const noteIndicator = hasNote ? ' <span title="Has note" style="font-size:0.75em;">📝</span>' : '';

    const evTags = Array.isArray(h.eventTags) ? h.eventTags : [];
    const evEvidence = h.eventTagEvidence || {};
    const tagsAttr = evTags.join(' ');
    const tagsCell = evTags.map(id => {
      const lbl = EVENT_TAG_LABELS[id] || id;
      const ev = evEvidence[id];
      const tip = ev ? `score ${ev.score} · ${ev.headline.replace(/"/g, '&quot;')}` : id;
      return `<span class="event-tag" data-tag="${id}" title="${tip}" style="display:inline-block; margin:1px 3px 1px 0; padding:1px 6px; background:#2c3a4a; color:#cdd5e0; border:1px solid #3d4f63; border-radius:8px; font-size:0.74em; cursor:pointer; white-space:nowrap;">${lbl}</span>`;
    }).join('');
    const tagsSortKey = evTags.length > 0 ? evTags[0] : 'zzz';
    const eventProb = typeof h.eventProbability === 'number' ? h.eventProbability : null;
    const eventProbStr = eventProb != null ? (eventProb * 100).toFixed(1) + '%' : '';
    const eventProbColor = eventProb == null ? '#888' : eventProb >= 0.6 ? 'rgba(245,101,101,0.9)' : eventProb >= 0.4 ? '#d4a657' : 'rgba(72,187,120,0.9)';

    const dir = h.directionForecast || null;
    const dirUp = dir && typeof dir.upProbability === 'number' ? dir.upProbability : null;
    const dirStr = dirUp != null ? (dirUp * 100).toFixed(1) + '%' : '';
    const dirColor = dirUp == null ? '#888' : dirUp >= 0.55 ? 'rgba(72,187,120,0.9)' : dirUp <= 0.45 ? 'rgba(245,101,101,0.9)' : '#d4a657';
    const dirTitle = dirUp == null ? 'TimesFM direction forecast (not scored)'
      : `TimesFM P(up) for tomorrow (${dir.forecastDate || ''}): ${dirStr}` +
        (dir.medianReturnPct != null ? ` · median ${(dir.medianReturnPct > 0 ? '+' : '') + dir.medianReturnPct.toFixed(1)}%` : '') +
        ` · next trading day`;

    // Last regular-session close vs the latest quote. Outside RTH the quote is the
    // pre/post-market print, so the delta between them is the extended-hours move.
    // Both are display-only: neither feeds the event/gap math.
    const lastCloseNum = typeof h.lastClose === 'number' && h.lastClose > 0 ? h.lastClose : null;
    const latestPriceNum = typeof h.latestPrice === 'number' && h.latestPrice > 0 ? h.latestPrice : null;
    const latestPriceVal = latestPriceNum != null ? latestPriceNum : -1;
    const extMovePct = (lastCloseNum != null && latestPriceNum != null)
      ? ((latestPriceNum - lastCloseNum) / lastCloseNum) * 100
      : null;
    // Only annotate a move once it is meaningful; sub-0.05% is quote noise.
    const extMoveShown = extMovePct != null && Math.abs(extMovePct) >= 0.05;
    const latestPriceStr = latestPriceNum != null
      ? latestPriceNum.toFixed(2) + (extMoveShown ? ` <span style="font-size:0.82em;">(${extMovePct > 0 ? '+' : ''}${extMovePct.toFixed(2)}%)</span>` : '')
      : '';
    const extMoveColor = !extMoveShown ? '#bbb' : extMovePct > 0 ? 'rgba(72,187,120,0.9)' : 'rgba(245,101,101,0.9)';
    const extTitle = (lastCloseNum != null && latestPriceNum != null)
      ? `Close ${lastCloseNum.toFixed(2)} → last ${latestPriceNum.toFixed(2)}`
      : 'Latest quoted price (includes extended hours)';

    return `<tr ${hasChart ? `class="data-row" data-ticker="${h.ticker}"` : ''} data-tags="${tagsAttr}"${clusterId ? ` data-cluster="${clusterId}"` : ''} style="${inlineStyle}">
      <td style="text-align:center; width:44px; padding:4px; white-space:nowrap;"><span class="del-mark" data-ticker="${h.ticker}" style="cursor:pointer; font-size:0.95em; color:${isDeleted ? '#e53935' : '#555'};" title="${isDeleted ? 'Marked to delete (click to unmark)' : 'Mark to delete'}">✕</span></td>
      <td data-v="${h.ticker}" style="font-weight:bold;">${h.ticker}${hasChart ? ` <span style="font-size:0.7em;color:#aaa;">▶</span> <button class="flow-modal-btn" data-ticker="${h.ticker}" style="font-size:0.72em; margin-left:2px; padding:1px 6px; border-radius:4px; border:1px solid #3a4a6a; background:#1e2433; color:#8fa8d0; cursor:pointer; vertical-align:middle;" title="Open OTM flow &amp; net win modal">📊</button>` : ''}${noteIndicator}${suggestedSet.has(h.ticker) ? ` <span style="font-size:0.68em; font-weight:600; color:#b48cff; border:1px solid #4a3a6a; background:#241f33; border-radius:4px; padding:1px 5px; vertical-align:middle;" title="${(() => { const m = suggestedMeta[h.ticker]; return m ? `Most similar company to your list (cosine ${(m.similarity * 100).toFixed(1)}%)${m.sector ? ' · ' + m.sector : ''}${m.industry ? ' · ' + m.industry : ''}` : 'Suggested for this run'; })()}">similar</span> <button class="add-screen-btn" data-ticker="${h.ticker}" style="font-size:0.72em; margin-left:4px; padding:1px 7px; border-radius:4px; border:1px solid #3a5a3a; background:#1e2b1e; color:#8fce8f; cursor:pointer; vertical-align:middle;" title="Permanently add ${h.ticker} to the screening list">＋ Add</button>` : ''}</td>
      ${clusterCell}
      <td data-v="${sec || 'zzz'}" style="font-size:0.82em; color:#888;">${sec || ''}</td>
      <td data-v="${tagsSortKey}" style="font-size:0.82em; max-width:240px;">${tagsCell}</td>
      <td data-v="${h.classification || 'zzz'}" style="color:${color}; font-weight:bold;">${label}</td>
      <td data-v="${eventProb != null ? eventProb : -1}" style="text-align:right; color:${eventProbColor}; font-weight:600;" title="TimesFM 3.0 next-day event probability">${eventProbStr}</td>
      <td data-v="${dirUp != null ? dirUp : -1}" style="text-align:right; color:${dirColor}; font-weight:600;" title="${dirTitle}">${dirStr}</td>
      <td data-v="${latestPriceVal}" style="text-align:right; color:${extMoveColor};" title="${extTitle}">${latestPriceStr}</td>
      <td data-v="${mcap}" style="text-align:right;">${mcapStr}</td>
      <td data-v="${optDV}" style="text-align:right;">${optDVStr}</td>
      <td data-v="${dvDeltaVal}" style="text-align:right; color:${slopeColor(dvDelta)}; font-size:0.88em;${leanBg('dv','Opt $Vol Δrank',dvDelta)}">${dvDeltaStr}</td>
      <td data-v="${callIVVal}" style="text-align:right; color:rgba(72,187,120,0.9);${leanBg('lvl','Call OTM',callIVRank)}">${callIVStr}</td>
      <td data-v="${callSpreadVal}" style="text-align:right; color:rgba(72,187,120,0.7); font-size:0.88em;${leanBg('lvl','Call Spr',callSpreadRank)}">${callSpreadStr}</td>
      <td data-v="${callAtmSlopeVal}" style="text-align:right; color:${slopeColor(callAtmSlope)}; font-size:0.88em;${leanBg('slp','Call ATM Δ',callAtmSlope)}">${slopeStr(callAtmSlope)}</td>
      <td data-v="${callSprSlopeVal}" style="text-align:right; color:${slopeColor(callSprSlope)}; font-size:0.88em;${leanBg('slp','Call Spr Δ',callSprSlope)}">${slopeStr(callSprSlope)}</td>
      <td data-v="${putIVVal}" style="text-align:right; color:rgba(245,101,101,0.9);${leanBg('lvl','Put OTM',putIVRank)}">${putIVStr}</td>
      <td data-v="${putSpreadVal}" style="text-align:right; color:rgba(245,101,101,0.7); font-size:0.88em;${leanBg('lvl','Put Spr',putSpreadRank)}">${putSpreadStr}</td>
    </tr>
    <tr class="chart-row" data-chart-for="${h.ticker}" style="display:none;">
      <td colspan="18" style="padding:0; background:#1a1d23;">
        <div style="display:flex; gap:12px; align-items:stretch; margin:12px 20px 8px;">
          <div id="summary-${h.ticker}" style="flex:1 1 120ch; padding:14px 18px; background:#262a33; border-left:3px solid #4a5a8a; border-radius:6px; color:#cdd5e0; font-size:0.98em; line-height:1.65; max-height:280px; overflow-y:auto;"></div>
          <div id="events-${h.ticker}" style="flex:0 1 250px; min-width:200px; max-height:280px; overflow-y:auto; background:#262a33; border-radius:6px; padding:10px 14px; color:#cdd5e0; font-size:0.88em; line-height:1.5;"></div>
        </div>
        <div style="padding:6px 20px 8px; display:flex; gap:8px; align-items:flex-start;">
          <label style="color:#aaa; font-size:0.82em; padding-top:6px; min-width:48px;">Notes</label>
          <textarea class="ticker-note" data-ticker="${h.ticker}" placeholder="Add a note about ${h.ticker}..." style="flex:1; min-height:42px; padding:6px 8px; border:1px solid #333; border-radius:4px; background:#15171c; color:#ddd; font-size:0.88em; font-family:inherit; resize:vertical;">${noteText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
          <span class="note-status" data-ticker="${h.ticker}" style="color:#888; font-size:0.78em; padding-top:8px; min-width:54px;"></span>
        </div>
        <div style="padding:12px 16px; height:480px;">
          <canvas id="chart-${h.ticker}"></canvas>
        </div>
        <div id="opts-wrap-${h.ticker}" style="display:none; padding:8px 16px 4px;">
          <div style="display:flex; justify-content:flex-end; padding:0 4px 2px;">
            <button id="opts-vol-toggle-${h.ticker}" type="button" style="background:transparent; color:#7aa2c7; border:1px solid #445; border-radius:3px; padding:2px 10px; font-size:0.8em; cursor:pointer;" title="Switch $Vol bars between 6-day accumulated and latest day only">$Vol: 6d accumulated</button>
          </div>
          <div style="display:flex; gap:8px;">
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-0-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-0-${h.ticker}"></canvas></div>
            </div>
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-1-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-1-${h.ticker}"></canvas></div>
            </div>
            <div style="flex:1; min-width:0;">
              <div id="opts-iv-label-2-${h.ticker}" style="color:#aaa; font-size:0.82em; padding:2px 4px; cursor:pointer; user-select:none;" title="Click for historical weighted IV"></div>
              <div style="height:360px;"><canvas id="opts-chart-2-${h.ticker}"></canvas></div>
            </div>
          </div>
          <div id="iv-history-wrap-${h.ticker}" style="display:none; padding:8px 0; height:420px;">
            <canvas id="iv-history-chart-${h.ticker}"></canvas>
          </div>
        </div>
        <div id="news-${h.ticker}" style="padding:4px 20px 14px;"></div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Ticker Screening Results</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #1a1d23; color: #eaeaea; }
  h1 { font-size: 1.4em; margin-bottom: 4px; color: #a8b5a2; }
  .summary { color: #a0aec0; margin-bottom: 16px; font-size: 0.95em; }
  table { width: 100%; border-collapse: collapse; background: #262a33; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
  #screen-table th { background: #2f3540; padding: 10px 12px; text-align: left; font-size: 0.85em; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none; }
  #screen-table th:hover { color: #fff; background: #3a414d; }
  #screen-table th .sort-arrow { font-size: 0.7em; margin-left: 3px; color: #5a6a8a; }
  #screen-table th.sorted-asc .sort-arrow, #screen-table th.sorted-desc .sort-arrow { color: #fff; }
  td { padding: 8px 12px; border-top: 1px solid #2e333d; font-size: 0.95em; }
  tr.data-row:hover { background: #2c303a; }
  tr:hover { background: #22252c; }
  .chart-row td { border-top: none; }
  input, textarea { background: #15171c; color: #ddd; border: 1px solid #333; }
  input::placeholder, textarea::placeholder { color: #6a7590; }
  /* Override inline light-theme colors used throughout the generated markup */
  [style*="background:#fff"] { background: #262a33 !important; }
  [style*="background: #fff"] { background: #262a33 !important; }
  [style*="background:#f7f9fc"] { background: #22252c !important; }
  [style*="background:#f9f9f9"] { background: #22252c !important; }
  [style*="background:#f5f5f5"] { background: #2f3540 !important; }
  [style*="color:#333"] { color: #eaeaea !important; }
  [style*="color:#444"] { color: #eaeaea !important; }
  [style*="color:#666"] { color: #a0aec0 !important; }
  [style*="color:#888"] { color: #8a96b0 !important; }
  [style*="color:#999"] { color: #7a8499 !important; }
  [style*="color:#aaa"] { color: #6a7590 !important; }
  [style*="color:#bbb"] { color: #5a6680 !important; }
  #fav-toast { position:fixed; bottom:20px; right:20px; padding:8px 16px; border-radius:6px; font-size:0.9em; color:#fff; opacity:0; transition:opacity 0.3s; pointer-events:none; z-index:9999; }
  #fav-toast.show { opacity:1; }
  .flow-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9000; display:none; align-items:center; justify-content:center; }
  .flow-modal-backdrop.open { display:flex; }
  .flow-modal { width:min(1200px, 94vw); height:min(86vh, 900px); background:#262a33; border:1px solid #3a4150; border-radius:12px; box-shadow:0 8px 40px rgba(0,0,0,0.6); display:flex; flex-direction:column; overflow:hidden; }
  .flow-modal-head { display:flex; align-items:baseline; gap:14px; padding:14px 18px 8px; }
  .flow-modal-title { font-weight:700; font-size:1.05em; color:#eaeaea; white-space:nowrap; }
  .flow-modal-meta { color:#8a96b0; font-size:0.85em; flex:1; }
  .flow-modal-close { background:transparent; border:1px solid #444; color:#aaa; border-radius:4px; padding:2px 10px; cursor:pointer; font-size:0.95em; }
  .flow-modal-close:hover { color:#fff; border-color:#888; }
  .flow-modal-body { flex:1; padding:4px 14px 14px; min-height:0; }
</style></head><body>
<div id="fav-toast"></div>
<div id="flow-modal" class="flow-modal-backdrop">
  <div class="flow-modal" role="dialog" aria-modal="true">
    <div class="flow-modal-head">
      <span class="flow-modal-title" id="flow-modal-title"></span>
      <span class="flow-modal-meta" id="flow-modal-meta"></span>
      <button type="button" class="flow-modal-close" id="flow-modal-close" title="Close (Esc)">✕ close</button>
    </div>
    <div class="flow-modal-body"><canvas id="flow-modal-chart"></canvas></div>
  </div>
</div>
<h1>Ticker Screening Results</h1>
<p class="summary">${hitCount} hit${hitCount !== 1 ? 's' : ''} out of ${totalTickers} tickers screened &mdash; ${config.screenLookbackDays}d lookback, p${config.screenPercentileThreshold} threshold</p>
${(() => {
  if (!freshness) return '';
  const tiers = {
    realtime: ['#2e7d32', 'Real-time'],
    delayed: ['#ef6c00', 'Delayed'],
    stale: ['#d32f2f', 'Stale'],
    'previous-session': ['#c62828', 'Previous session'],
  };
  const [color, label] = tiers[freshness.tier] || ['#666', freshness.tier];
  const fmtLocal = (iso) => new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const srcs = Object.entries(freshness.sources)
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <span style="color:#666; font-weight:600;">Data freshness:</span>
  <span style="color:${color}; font-weight:bold; margin-left:10px;">${label}</span>
  <span style="color:#666; margin-left:10px;">median age</span>
  <span style="color:${color}; font-weight:bold; margin-left:4px;">${formatAge(freshness.medianAgeMs)}</span>
  <span style="color:#999; margin-left:6px;">(mean ${formatAge(freshness.meanAgeMs)})</span>
  <span style="color:#999; margin-left:16px;">|</span>
  <span style="color:#666; font-weight:600; margin-left:16px;">Avg quote time:</span>
  <span style="color:#333; font-weight:bold; margin-left:6px;">${fmtLocal(freshness.meanQuoteTime)}</span>
  <div style="color:#999; font-size:0.85em; margin-top:5px;">
    Newest ${fmtLocal(freshness.newestQuoteTime)} (${freshness.newestTicker}) &middot;
    oldest ${fmtLocal(freshness.oldestQuoteTime)} (${freshness.oldestTicker}) &middot;
    ${freshness.sampleCount} tickers sampled &middot; ${srcs}
  </div>
</div>`;
})()}
${ivTickers.length > 0 ? `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <span style="color:#666; font-weight:600;">Avg Weighted IV (${ivTickers.length} tickers):</span>
  <span style="color:rgba(72,187,120,0.9); font-weight:bold; margin-left:10px;">Call ${avgCallIV.toFixed(1)}%</span>
  <span style="color:rgba(245,101,101,0.9); font-weight:bold; margin-left:10px;">Put ${avgPutIV.toFixed(1)}%</span>
  <span style="color:#999; margin-left:16px;">|</span>
  <span style="color:#666; font-weight:600; margin-left:16px;">Avg ATM IV:</span>
  <span style="color:rgba(72,187,120,0.7); font-weight:bold; margin-left:10px;">Call ${avgAtmCallIV.toFixed(1)}%</span>
  <span style="color:rgba(245,101,101,0.7); font-weight:bold; margin-left:10px;">Put ${avgAtmPutIV.toFixed(1)}%</span>
</div>` : ''}
<div id="portfolio-corr-box" style="margin-bottom:14px; padding:12px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <div style="color:#666; font-weight:600; margin-bottom:6px;">Portfolio Correlation Check</div>
  <div style="display:flex; align-items:center; gap:10px;">
    <input id="portfolio-corr-input" type="text" placeholder="e.g. AAPL, MSFT, NVDA" style="flex:1; padding:7px 10px; border:1px solid #ddd; border-radius:6px; font-size:0.95em; outline:none;" />
    <button id="portfolio-corr-btn" style="padding:7px 16px; border:none; border-radius:6px; background:#5b8cb8; color:#fff; font-size:0.9em; cursor:pointer;">Check</button>
  </div>
  <div id="portfolio-corr-result" style="margin-top:8px;"></div>
</div>
${clusterPanelHtml}
${bestCombo ? `<div style="margin-bottom:14px; padding:12px 16px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.93em;">
  <div style="color:#444; font-weight:700; margin-bottom:8px;">
    Package Suggestion
    <span style="color:#999; font-weight:normal; font-size:0.85em; margin-left:8px;">(best 3-ticker combo: max avg call spread, min pairwise correlation &mdash; 2-snapshot avg)</span>
  </div>
  <div style="display:flex; gap:24px; align-items:center; flex-wrap:wrap;">
    ${bestCombo.tickers.map((t, i) => `<div style="background:#f7f9fc; border-radius:6px; padding:8px 14px; min-width:120px;">
        <div style="font-weight:bold; font-size:1.05em; color:#333;">${t}</div>
        <div style="color:rgba(72,187,120,0.85); font-size:0.88em; margin-top:2px;">Avg C Spr: ${bestCombo.spreads[i] >= 0 ? '+' : ''}${bestCombo.spreads[i].toFixed(1)}</div>
      </div>`).join('')}
    <div style="color:#888; font-size:0.85em; line-height:1.6;">
      <div>Avg |corr|: <span style="color:${bestCombo.avgCorr < 0.3 ? '#4caf50' : bestCombo.avgCorr < 0.6 ? '#ff9800' : '#f44336'}; font-weight:600;">${bestCombo.avgCorr.toFixed(2)}</span></div>
      <div>Avg Call Spread: <span style="color:rgba(72,187,120,0.9); font-weight:600;">${bestCombo.avgSpread >= 0 ? '+' : ''}${bestCombo.avgSpread.toFixed(1)}</span></div>
      <div style="font-size:0.82em; color:#bbb;">Corr: ${bestCombo.tickers[0]}/${bestCombo.tickers[1]}=${bestCombo.corrs.r12.toFixed(2)}, ${bestCombo.tickers[0]}/${bestCombo.tickers[2]}=${bestCombo.corrs.r13.toFixed(2)}, ${bestCombo.tickers[1]}/${bestCombo.tickers[2]}=${bestCombo.corrs.r23.toFixed(2)}</div>
    </div>
  </div>
</div>` : ''}
<div id="tag-filter-bar" style="margin:8px 0 6px; min-height:22px; font-size:0.82em; color:#888; display:none;">
  Filter: <span id="tag-filter-active"></span>
  <a href="#" id="tag-filter-clear" style="margin-left:8px; color:#7aa2c7; text-decoration:none;">clear</a>
</div>
<div style="font-size:0.78em; color:#999; margin:4px 0 6px;">Cell background tint = which eventual-event direction this value leans toward, per the Pre-Event IV → Outcome Contrast (green = positive, red = negative; deeper = stronger effect).</div>
${clusterMeta ? `<div style="font-size:0.78em; color:#999; margin:4px 0 6px;">Cluster = group of tickers whose options posture (IV smile + dollar-volume across moneyness) shows the same unusual change vs their own 60-day baseline. Chip reading: <b>C2⁶</b> = cluster with 6 members (superscript) — chip color intensity = the cluster's average move strength, so pale chips are near-quiet clusters. ·σN = this ticker's move strength (SD-norm of the change). ·N = membership strength (silhouette, higher = more central member); hover a chip for the cluster's separation and signature. Click a chip to filter; see the cluster panel above the table.</div>` : ''}
<table id="screen-table">
<thead><tr>
  <th style="width:44px; text-align:center; padding:4px;"><span class="sort-arrow"></span></th>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th title="Delta-shape options cluster: tickers whose IV smile + DV distribution across moneyness moved the same unusual way vs their own 60-day baseline (clusters defined by the manual cluster universe when set, else the full universe; k fixed, cosine distance). ·σN = move strength (SD-norm of the change). ·N = membership strength (silhouette, higher = more central member). Click a chip to filter the table.">Cluster<span class="sort-arrow"></span></th>
  <th>Sector<span class="sort-arrow"></span></th>
  <th>Tags<span class="sort-arrow"></span></th>
  <th>Classification<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="TimesFM 3.0 next-day event probability">Event Prob<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="TimesFM 3.0 probability of a positive return tomorrow, the next trading day (options-only covariates)">P(up→1d)<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Latest quoted price, including pre-market and after-hours when the regular session is closed. % is the move vs the last regular close.">Last (ext)<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Mkt Cap<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Opt $ Vol<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of total option dollar-volume percentile rank within the ticker's own history, across the same window as the IV Δ columns: rank(T-1) − rank(T-oldest), in rank points (-100..+100). >0 = flow building into the event.">$Vol Δrank<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Call IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank, {tN} = top-tag cohort rank">C Spr<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of ATM call IV percentile rank: rank(T-1) − rank(T-oldest) over the ~3 snapshots before the event. >0 = ramping in.">ATM C Δ<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Pre-event slope of call OTM−ATM spread percentile rank: rank(T-1) − rank(T-oldest) over the ~3 snapshots before the event. >0 = ramping in.">C Spr Δ<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Put IV<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="Weighted OTM IV minus ATM IV. (pN) = self-history rank, [sN] = sector rank, {tN} = top-tag cohort rank">P Spr<span class="sort-arrow"></span></th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

${(() => {
  const C = preEventContrast;
  const card = (inner) => `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">${inner}</div>`;
  const head = `<div style="color:#666; font-weight:600; margin-bottom:4px;">Pre-Event IV → Outcome Contrast <span style="color:#999; font-weight:normal; font-size:0.9em;">(positive vs negative outcomes — surprising + anticipated pooled by direction; tests whether the pre-event IV configuration leans toward the eventual direction. Δ = window slope feature.)</span></div>`;
  if (!C || !C.ok) {
    return card(`${head}<div style="color:#aaa; font-size:0.85em;">${C ? C.reason : 'No data.'}</div>`);
  }
  // Effect-size / coefficient coloring: matches the Pre-Event panel's rank palette
  // — red/orange = elevated toward S+, blue = leaning toward S−, gray = weak.
  const dColor = (v) => {
    const a = Math.abs(v);
    if (v > 0) return a >= 0.5 ? '#d32f2f' : a >= 0.2 ? '#ef6c00' : '#9e9e9e';
    return a >= 0.5 ? '#1565c0' : a >= 0.2 ? '#0277bd' : '#9e9e9e';
  };
  const fmtP = (p) => p < 0.001 ? '&lt;0.001' : p.toFixed(3);
  const uniRows = C.uni.map((u) => `<tr>
    <td style="padding:5px 10px; ${u.group === 'slp' ? 'color:#888;' : 'font-weight:600;'}">${u.label}</td>
    <td style="padding:5px 10px; text-align:right;">${u.meanPos.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right;">${u.meanNeg.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right; color:${dColor(u.diff)};">${u.diff >= 0 ? '+' : ''}${u.diff.toFixed(1)}</td>
    <td style="padding:5px 10px; text-align:right; font-weight:600; color:${dColor(u.d)};">${u.d >= 0 ? '+' : ''}${u.d.toFixed(2)}</td>
    <td style="padding:5px 10px; text-align:right; ${u.p < 0.05 ? 'font-weight:600; color:#333;' : 'color:#aaa;'}">${fmtP(u.p)}</td>
  </tr>`).join('');
  const uniTable = `<div style="color:#888; font-size:0.78em; margin:8px 0 3px;">Per-feature contrast (raw, un-imputed). Cohen's d = standardized effect size; |d|≈0.2 small, 0.5 medium. Sorted by |d|.</div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.78em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Feature</th>
        <th style="padding:4px 10px; text-align:right;">Pos mean</th>
        <th style="padding:4px 10px; text-align:right;">Neg mean</th>
        <th style="padding:4px 10px; text-align:right;">Δ</th>
        <th style="padding:4px 10px; text-align:right;">Cohen's d</th>
        <th style="padding:4px 10px; text-align:right;">p</th>
      </tr></thead><tbody>${uniRows}</tbody>
    </table>`;

  return card(`${head}${uniTable}`);
})()}


<script>
(function() {
  const chartDataMap = ${JSON.stringify(chartDataMap)};
  const summaryMap = ${JSON.stringify(summaryMap)};
  const summarySourceMap = ${JSON.stringify(summarySourceMap)};
  const newsMap = ${JSON.stringify(newsMap)};
  const ivHistoryMap = ${JSON.stringify(ivHistoryData)};
  const eventsMap = ${JSON.stringify(eventsByTicker)};
  // Combine IV from a saved history record (exp1/exp2/exp3), weighted by dv if available.
  // Single-pool combine of a history record across expirations;
  // old records fall back to legacy combined DV + single-strike ATM.
  function combineHist(record) {
    const exps = [];
    for (const key of ['exp1', 'exp2', 'exp3']) {
      const e = record[key];
      if (!e || (e.callIV <= 0 && e.putIV <= 0)) continue;
      exps.push(e);
    }
    if (exps.length === 0) return null;

    function pool(valueFn, weightFn) {
      var vals = [];
      for (var i = 0; i < exps.length; i++) {
        var v = valueFn(exps[i]);
        if (v == null) continue;
        var w = weightFn(exps[i]);
        vals.push({ v: v, w: w > 0 ? w : 0 });
      }
      if (vals.length === 0) return null;
      var sumW = 0, sumVW = 0;
      for (var j = 0; j < vals.length; j++) { sumW += vals[j].w; sumVW += vals[j].v * vals[j].w; }
      if (sumW > 0) return sumVW / sumW;
      var sumV = 0;
      for (var k = 0; k < vals.length; k++) sumV += vals[k].v;
      return sumV / vals.length;
    }
    function legacyDV(e) { return e.dv || 0; }

    var callIV = pool(
      function(e) { return e.callIV > 0 ? e.callIV : null; },
      function(e) { return e.callDV != null ? e.callDV : legacyDV(e); }
    ) || 0;
    var putIV = pool(
      function(e) { return e.putIV > 0 ? e.putIV : null; },
      function(e) { return e.putDV != null ? e.putDV : legacyDV(e); }
    ) || 0;
    var atmCallIV = pool(
      function(e) { return (e.atmBandCallIV != null && e.atmBandCallIV > 0) ? e.atmBandCallIV : (e.atmCallIV != null ? e.atmCallIV : null); },
      function(e) { return e.atmCallDV != null ? e.atmCallDV : legacyDV(e); }
    );
    var atmPutIV = pool(
      function(e) { return (e.atmBandPutIV != null && e.atmBandPutIV > 0) ? e.atmBandPutIV : (e.atmPutIV != null ? e.atmPutIV : null); },
      function(e) { return e.atmPutDV != null ? e.atmPutDV : legacyDV(e); }
    );

    return { callIV: callIV, putIV: putIV, atmCallIV: atmCallIV, atmPutIV: atmPutIV };
  }
  // Favorite star click handler
  let favToastTimer = null;
  function showFavToast(msg, success) {
    const el = document.getElementById('fav-toast');
    el.textContent = msg;
    el.style.background = success ? '#4caf50' : '#f44336';
    el.classList.add('show');
    clearTimeout(favToastTimer);
    favToastTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  // Ticker notes: debounced autosave
  const noteTimers = {};
  document.querySelectorAll('.ticker-note').forEach(ta => {
    const ticker = ta.getAttribute('data-ticker');
    const statusEl = document.querySelector('.note-status[data-ticker="' + ticker + '"]');
    const save = async () => {
      if (!window.electronAPI || !window.electronAPI.saveNote) return;
      if (statusEl) statusEl.textContent = 'saving…';
      try {
        await window.electronAPI.saveNote(ticker, ta.value);
        if (statusEl) {
          statusEl.textContent = 'saved';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1200);
        }
        // Update note indicator next to ticker
        const row = document.querySelector('tr.data-row[data-ticker="' + ticker + '"]');
        if (row) {
          const cell = row.children[1];
          if (cell) {
            const existing = cell.querySelector('span[title="Has note"]');
            const hasText = ta.value.trim().length > 0;
            if (hasText && !existing) {
              const span = document.createElement('span');
              span.setAttribute('title', 'Has note');
              span.style.fontSize = '0.75em';
              span.textContent = ' \u{1F4DD}';
              cell.appendChild(span);
            } else if (!hasText && existing) {
              existing.remove();
            }
          }
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'failed';
      }
    };
    ta.addEventListener('input', () => {
      clearTimeout(noteTimers[ticker]);
      noteTimers[ticker] = setTimeout(save, 700);
    });
    ta.addEventListener('blur', () => {
      clearTimeout(noteTimers[ticker]);
      save();
    });
    ta.addEventListener('click', (e) => e.stopPropagation());
  });

  // ── Event-tag + cluster filters ──
  // Click any tag chip or cluster chip to filter rows; active filters AND
  // together. Only matching data-rows stay visible (their chart-row sibling is
  // hidden too).
  let activeTagFilter = null;
  let activeClusterFilter = null;
  function applyTagFilter() {
    const bar = document.getElementById('tag-filter-bar');
    const activeEl = document.getElementById('tag-filter-active');
    const parts = [];
    if (activeClusterFilter) parts.push(activeClusterFilter + ' (cluster)');
    if (activeTagFilter) parts.push(activeTagFilter + ' (tag)');
    if (parts.length > 0) {
      bar.style.display = '';
      activeEl.textContent = parts.join(' · ');
    } else {
      bar.style.display = 'none';
      activeEl.textContent = '';
    }
    document.querySelectorAll('tr.data-row').forEach(row => {
      const tags = (row.getAttribute('data-tags') || '').split(' ').filter(Boolean);
      const clusterOk = !activeClusterFilter || row.getAttribute('data-cluster') === activeClusterFilter;
      const tagOk = !activeTagFilter || tags.includes(activeTagFilter);
      const show = clusterOk && tagOk;
      row.style.display = show ? '' : 'none';
      const ticker = row.getAttribute('data-ticker');
      const chartRow = document.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
      if (chartRow && !show) chartRow.style.display = 'none';
    });
    document.querySelectorAll('.event-tag').forEach(chip => {
      chip.style.outline = (chip.getAttribute('data-tag') === activeTagFilter) ? '2px solid #7aa2c7' : '';
    });
    document.querySelectorAll('.cluster-chip').forEach(chip => {
      chip.style.outline = (chip.getAttribute('data-cluster') === activeClusterFilter) ? '2px solid #7aa2c7' : '';
    });
    document.querySelectorAll('.cluster-dot').forEach(dot => {
      const active = dot.getAttribute('data-cluster') === activeClusterFilter;
      dot.setAttribute('stroke', active ? '#7aa2c7' : dot.getAttribute('fill'));
      dot.setAttribute('stroke-width', active ? '2.5' : '1');
    });
  }
  document.querySelectorAll('.event-tag').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = chip.getAttribute('data-tag');
      activeTagFilter = (activeTagFilter === tag) ? null : tag;
      applyTagFilter();
    });
  });
  document.querySelectorAll('.cluster-chip, .cluster-dot').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = chip.getAttribute('data-cluster');
      activeClusterFilter = (activeClusterFilter === id) ? null : id;
      applyTagFilter();
    });
  });
  const clearLink = document.getElementById('tag-filter-clear');
  if (clearLink) clearLink.addEventListener('click', (e) => {
    e.preventDefault();
    activeTagFilter = null;
    activeClusterFilter = null;
    applyTagFilter();
  });

  document.querySelectorAll('.del-mark').forEach(mark => {
    mark.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = mark.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.toggleDelete) return;
      if (mark.dataset.busy) return;
      mark.dataset.busy = '1';
      try {
        const result = await window.electronAPI.toggleDelete(ticker);
        const isDeleted = (result.toDelete || []).includes(ticker);
        mark.style.color = isDeleted ? '#e53935' : '#555';
        mark.title = isDeleted ? 'Marked to delete (click to unmark)' : 'Mark to delete';
        const row = mark.closest('tr');
        if (row) {
          row.style.opacity = isDeleted ? '0.4' : '';
          row.style.textDecoration = isDeleted ? 'line-through' : '';
        }
        showFavToast(isDeleted ? ticker + ' marked to delete' : ticker + ' unmarked', true);
      } catch (err) {
        showFavToast('Failed to update ' + ticker, false);
      }
      delete mark.dataset.busy;
    });
  });

  document.querySelectorAll('.add-screen-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ticker = btn.getAttribute('data-ticker');
      if (!ticker || !window.electronAPI || !window.electronAPI.addScreenTicker) return;
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      try {
        const result = await window.electronAPI.addScreenTicker(ticker);
        if (result && result.success) {
          btn.disabled = true;
          btn.textContent = 'Added ✓';
          btn.style.cursor = 'default';
          btn.style.opacity = '0.7';
          showFavToast(result.alreadyPresent ? ticker + ' already in screening list' : ticker + ' added to screening list', true);
        } else {
          showFavToast('Failed to add ' + ticker + (result && result.error ? ': ' + result.error : ''), false);
        }
      } catch (err) {
        showFavToast('Failed to add ' + ticker, false);
      }
      delete btn.dataset.busy;
    });
  });

  const classColors = {
    surprising_positive: '#4caf50',
    positive_anticipated: '#8bc34a',
    negative_anticipated: '#ff9800',
    surprising_negative: '#f44336',
  };
  const classNames = {
    surprising_positive: 'Surprising +',
    positive_anticipated: 'Anticipated +',
    negative_anticipated: 'Anticipated -',
    surprising_negative: 'Surprising -',
  };

  const renderedCharts = {};

  function pairwiseCorrelation(tickerA, tickerB) {
    const cdA = chartDataMap[tickerA];
    const cdB = chartDataMap[tickerB];
    if (!cdA || !cdB || !cdA.dates || !cdB.dates) return null;

    const dateIdxA = {};
    for (let i = 0; i < cdA.dates.length; i++) dateIdxA[cdA.dates[i]] = i;

    const retA = [], retB = [];
    let prevIdxA = -1, prevIdxB = -1;
    for (let j = 0; j < cdB.dates.length; j++) {
      const idxA = dateIdxA[cdB.dates[j]];
      if (idxA == null) continue;
      if (prevIdxA >= 0 && prevIdxB >= 0 && idxA === prevIdxA + 1 && j === prevIdxB + 1) {
        if (cdA.closes[prevIdxA] > 0 && cdB.closes[prevIdxB] > 0) {
          retA.push(Math.log(cdA.closes[idxA] / cdA.closes[prevIdxA]));
          retB.push(Math.log(cdB.closes[j] / cdB.closes[prevIdxB]));
        }
      }
      prevIdxA = idxA;
      prevIdxB = j;
    }

    if (retA.length < 20) return null;

    const n = retA.length;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    for (let k = 0; k < n; k++) {
      sx += retA[k]; sy += retB[k];
      sxy += retA[k] * retB[k];
      sx2 += retA[k] * retA[k];
      sy2 += retB[k] * retB[k];
    }
    const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    return denom > 0 ? (n * sxy - sx * sy) / denom : 0;
  }

  function corrColor(r) {
    const abs = Math.abs(r);
    if (r < 0) return 'rgba(76, 175, 80, ' + (0.5 + abs * 0.5) + ')';
    if (abs < 0.3) return 'rgba(76, 175, 80, 0.7)';
    if (abs < 0.6) return 'rgba(255, 193, 7, ' + (0.6 + (abs - 0.3) * 1.3) + ')';
    return 'rgba(244, 67, 54, ' + (0.6 + (abs - 0.6) * 1.0) + ')';
  }

  // Portfolio correlation checker
  document.getElementById('portfolio-corr-btn').addEventListener('click', () => {
    const raw = document.getElementById('portfolio-corr-input').value;
    const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(t => t.length > 0);
    const resultDiv = document.getElementById('portfolio-corr-result');

    if (tickers.length < 2) {
      resultDiv.innerHTML = '<span style="color:#888; font-size:0.9em;">Enter at least 2 tickers separated by commas.</span>';
      return;
    }

    const missing = tickers.filter(t => !chartDataMap[t]);
    if (missing.length > 0) {
      resultDiv.innerHTML = '<span style="color:#c62828; font-size:0.9em;">Not in screening data: ' + missing.join(', ') + '</span>';
      return;
    }

    // Compute all pairwise correlations
    const pairs = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const r = pairwiseCorrelation(tickers[i], tickers[j]);
        pairs.push({ a: tickers[i], b: tickers[j], r });
      }
    }

    const valid = pairs.filter(p => p.r !== null);
    if (valid.length === 0) {
      resultDiv.innerHTML = '<span style="color:#888; font-size:0.9em;">Not enough overlapping data to compute correlations.</span>';
      return;
    }

    const avgCorr = valid.reduce((s, p) => s + p.r, 0) / valid.length;
    const maxCorr = Math.max(...valid.map(p => p.r));
    const minCorr = Math.min(...valid.map(p => p.r));

    // Verdict
    let verdict, verdictColor;
    if (avgCorr >= 0.7) { verdict = 'Highly correlated — low diversification'; verdictColor = '#c62828'; }
    else if (avgCorr >= 0.5) { verdict = 'Moderately correlated'; verdictColor = '#ef6c00'; }
    else if (avgCorr >= 0.3) { verdict = 'Moderately diversified'; verdictColor = '#f9a825'; }
    else { verdict = 'Well diversified — low correlation'; verdictColor = '#2e7d32'; }

    let html = '<div style="margin-bottom:6px;"><span style="font-weight:700; font-size:1.05em; color:' + verdictColor + ';">' + verdict + '</span>';
    html += '<span style="color:#888; margin-left:12px; font-size:0.9em;">avg ' + avgCorr.toFixed(3) + ' &nbsp;|&nbsp; range ' + minCorr.toFixed(3) + ' to ' + maxCorr.toFixed(3) + '</span></div>';

    // Pair table
    html += '<table style="width:100%; border-collapse:collapse; font-size:0.9em; margin-top:4px;">';
    html += '<tr style="color:#888; font-size:0.8em; text-transform:uppercase; letter-spacing:0.5px;"><th style="text-align:left; padding:4px 8px;">Pair</th><th style="text-align:right; padding:4px 8px;">Correlation</th></tr>';
    valid.sort((a, b) => b.r - a.r);
    for (const p of valid) {
      const color = corrColor(p.r);
      html += '<tr style="border-top:1px solid #eee;">' +
        '<td style="padding:4px 8px;">' + p.a + ' / ' + p.b + '</td>' +
        '<td style="padding:4px 8px; text-align:right; color:' + color + '; font-weight:600;">' + p.r.toFixed(3) + '</td>' +
        '</tr>';
    }
    const skipped = pairs.filter(p => p.r === null);
    if (skipped.length > 0) {
      for (const p of skipped) {
        html += '<tr style="border-top:1px solid #eee;">' +
          '<td style="padding:4px 8px; color:#bbb;">' + p.a + ' / ' + p.b + '</td>' +
          '<td style="padding:4px 8px; text-align:right; color:#bbb;">insufficient data</td></tr>';
      }
    }
    html += '</table>';
    resultDiv.innerHTML = html;
  });

  document.getElementById('portfolio-corr-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('portfolio-corr-btn').click();
  });

  // Click handler for data rows
  document.querySelectorAll('tr.data-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const ticker = row.getAttribute('data-ticker');
      const chartRow = document.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
      if (!chartRow) return;

      const isVisible = chartRow.style.display !== 'none';
      // Toggle arrow indicator
      const arrow = row.querySelector('td:first-child span');
      if (arrow) arrow.textContent = isVisible ? '\\u25B6' : '\\u25BC';

      if (isVisible) {
        chartRow.style.display = 'none';
        return;
      }

      chartRow.style.display = '';

      // Render chart if not yet done
      if (!renderedCharts[ticker]) {
        const cd = chartDataMap[ticker];
        if (!cd) return;

        const canvas = document.getElementById('chart-' + ticker);
        if (!canvas) return;

        // Build all datasets using numeric indices for x — avoids category/scatter misalignment
        const eventsByClass = {};
        for (const ev of cd.events) {
          if (!eventsByClass[ev.classification]) eventsByClass[ev.classification] = [];
          if (ev.idx != null && ev.idx < cd.dates.length) {
            eventsByClass[ev.classification].push({ x: ev.idx, y: ev.y });
          }
        }

        // Convert line and bar data to {x, y} indexed points so all datasets share the linear x scale
        const pricePoints = cd.closes.map((v, i) => ({ x: i, y: v }));
        const volumePoints = cd.volumes.map((v, i) => ({ x: i, y: v }));

        const datasets = [{
          label: 'Volume',
          data: volumePoints,
          type: 'bar',
          backgroundColor: 'rgba(100, 100, 180, 0.25)',
          borderColor: 'rgba(100, 100, 180, 0.4)',
          borderWidth: 1,
          yAxisID: 'yVol',
          order: 2,
        }, {
          label: ticker + ' Close',
          data: pricePoints,
          borderColor: 'rgba(136, 176, 136, 0.8)',
          backgroundColor: 'rgba(136, 176, 136, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          yAxisID: 'y',
          order: 1,
        }];

        for (const [cls, points] of Object.entries(eventsByClass)) {
          datasets.push({
            label: classNames[cls] || cls,
            data: points,
            type: 'scatter',
            backgroundColor: classColors[cls] || '#ccc',
            borderColor: classColors[cls] || '#ccc',
            pointRadius: 7,
            pointHoverRadius: 9,
            yAxisID: 'y',
            order: 0,
          });
        }

        const dates = cd.dates;
        renderedCharts[ticker] = new Chart(canvas, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
              title: { display: true, text: ticker + ' Price with Events', color: '#b0b0b0' },
              legend: { labels: { color: '#909090', boxWidth: 12, font: { size: 11 } } },
              tooltip: {
                mode: 'index',
                intersect: false,
                filter: function(item) { return item.dataset.label === 'Volume' || item.dataset.label === ticker + ' Close'; },
                callbacks: {
                  title: function(items) { return items[0] ? dates[items[0].parsed.x] || '' : ''; },
                  label: function(item) {
                    if (item.dataset.label === 'Volume') {
                      const v = item.parsed.y;
                      return ' Volume: ' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v).toLocaleString());
                    }
                    return ' Price: $' + item.parsed.y.toFixed(2);
                  }
                }
              },
              interaction: { mode: 'index', intersect: false },
            },
            scales: {
              x: {
                type: 'linear',
                ticks: {
                  color: '#909090',
                  maxTicksLimit: 12,
                  font: { size: 10 },
                  callback: function(val) { return dates[val] || ''; },
                },
                grid: { color: '#2a2a4a' },
                min: 0,
                max: dates.length - 1,
              },
              y: {
                position: 'left',
                ticks: { color: '#909090', font: { size: 10 } },
                grid: { color: '#2a2a4a' },
              },
              yVol: {
                position: 'right',
                display: false,
                beginAtZero: true,
                max: Math.max(...(cd.volumes || [0])) * 4,
                grid: { drawOnChartArea: false },
              },
            },
          },
        });

        // Populate company summary with a source tag (EDGAR / Yahoo / Wikipedia,
        // combined when the merged description drew from several)
        const sumEl = document.getElementById('summary-' + ticker);
        if (sumEl && summaryMap[ticker]) {
          const sourceLabels = { edgar: 'SEC EDGAR · 10-K Item 1', yahoo: 'Yahoo Finance', wiki: 'Wikipedia' };
          const src = summarySourceMap[ticker];
          const srcList = Array.isArray(src) ? src : (src ? [src] : []);
          const srcTag = srcList.length
            ? '<div style="display:inline-block; margin-bottom:8px; padding:1px 8px; border:1px solid #3a4a6a; border-radius:4px; background:#1e2433; color:#8fa8d0; font-size:0.78em; font-weight:600;">' + srcList.map((s) => sourceLabels[s] || s).join(' + ') + '</div>'
            : '';
          const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          sumEl.innerHTML = srcTag + '<div>' + esc(summaryMap[ticker]) + '</div>';
        }

        // Populate the upcoming-events panel (next earnings, etc.)
        const eventsEl = document.getElementById('events-' + ticker);
        if (eventsEl) {
          const ev = eventsMap[ticker];
          let htmlOut = '<div style="color:#8fa8d0; font-weight:600; font-size:0.95em; margin-bottom:6px;">Upcoming Events</div>';
          if (ev && (ev.date || ev.label)) {
            const daysStr = (ev.daysUntil != null)
              ? (ev.daysUntil <= 0 ? 'today' : 'in ' + ev.daysUntil + ' day' + (ev.daysUntil === 1 ? '' : 's'))
              : null;
            const urgency = ev.daysUntil != null && ev.daysUntil <= 7 ? '#f5b450' : '#cdd5e0';
            htmlOut += '<div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">' +
              '<span style="color:#aaa;">Next earnings</span>' +
              '<span style="font-weight:600; color:' + urgency + '; font-size:1.05em;">' + ev.label + (daysStr ? ' &middot; ' + daysStr : '') + '</span>' +
            '</div>';
            if (ev.url) {
              htmlOut += '<div style="text-align:right;"><a href="' + ev.url + '" target="_blank" rel="noopener" style="color:#7aa2c7; font-size:0.82em; text-decoration:none;">source: ' + (ev.source || 'link') + ' &#8599;</a></div>';
            }
          } else {
            htmlOut += '<div style="color:#777; font-size:0.88em;">No upcoming event data available.</div>';
          }
          htmlOut += '<div style="color:#666; font-size:0.78em; margin-top:8px; border-top:1px solid #333; padding-top:6px;">Earnings dates scraped per run; verify before trading.</div>';
          eventsEl.innerHTML = htmlOut;
        }
        // Populate news headlines
        const newsEl = document.getElementById('news-' + ticker);
        const news = newsMap[ticker];
        if (newsEl && news && news.length > 0) {
          const catColors = { technical: '#5b9bd5', fear: '#c0392b', win: '#27ae60', macro_fear: '#e07c4f', macro_win: '#2ecc71', mixed: '#999' };
          const catLabels = { technical: 'Technical', fear: 'Fear', win: 'Win', macro_fear: 'Macro Fear', macro_win: 'Macro Win', mixed: 'Mixed' };
          const renderHeadline = (n) => {
            const badge = n.category ? '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.75em;font-weight:600;color:#fff;background:' + (catColors[n.category] || '#999') + ';margin-right:6px;vertical-align:middle;">' + (catLabels[n.category] || '') + '</span>' : '';
            return '<div style="margin-bottom:6px; font-size:0.95em; line-height:1.5;">' +
              '<span style="color:#666; font-size:0.85em; margin-right:6px;">' + (n.date ? n.date + ' ' : '') + (n.time || '') + '</span>' +
              badge +
              '<a href="' + n.url + '" target="_blank" rel="noopener" style="color:#7aa2c7; text-decoration:none;">' + n.headline + '</a>' +
            '</div>';
          };
          const DEFAULT_SHOW = 10;
          const shown = news.slice(0, DEFAULT_SHOW).map(renderHeadline).join('');
          const hidden = news.slice(DEFAULT_SHOW).map(renderHeadline).join('');
          let html = '<div>' + shown + '</div>';
          if (hidden) {
            const hiddenId = 'news-hidden-' + ticker;
            const btnId = 'news-toggle-' + ticker;
            html += '<div id="' + hiddenId + '" style="display:none;">' + hidden + '</div>';
            html += '<button id="' + btnId + '" type="button" style="margin-top:6px; background:transparent; color:#7aa2c7; border:1px solid #445; border-radius:3px; padding:3px 10px; font-size:0.85em; cursor:pointer;">Show ' + (news.length - DEFAULT_SHOW) + ' more</button>';
            newsEl.innerHTML = html;
            const btn = document.getElementById(btnId);
            const hiddenEl = document.getElementById(hiddenId);
            btn.addEventListener('click', () => {
              const isHidden = hiddenEl.style.display === 'none';
              hiddenEl.style.display = isHidden ? 'block' : 'none';
              btn.textContent = isHidden ? 'Show less' : ('Show ' + (news.length - DEFAULT_SHOW) + ' more');
            });
          } else {
            newsEl.innerHTML = html;
          }
        }

        // Render options strike charts (nearest 3 expirations side by side)
        const od = cd.optionsStrikes;
        if (od && od.length > 0) {
          const optsWrap = document.getElementById('opts-wrap-' + ticker);
          if (optsWrap) {
            optsWrap.style.display = 'block';
            const fmtDollar = (v) => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(0)+'K' : '$'+v.toFixed(0);

            const expChartInfos = []; // per-expiration refs for the agg/latest $Vol toggle
            for (let ei = 0; ei < Math.min(3, od.length); ei++) {
              const exp = od[ei];
              const canvas = document.getElementById('opts-chart-' + ei + '-' + ticker);
              if (!exp || !canvas) continue;

              const strikeSet = new Set();
              exp.calls.forEach(c => strikeSet.add(c.strike));
              exp.puts.forEach(p => strikeSet.add(p.strike));
              const strikes = Array.from(strikeSet).sort((a, b) => a - b);
              const strikeLabels = strikes.map(s => '$' + s.toFixed(s >= 100 ? 0 : s >= 1 ? 1 : 2));

              const callMap = {};
              exp.calls.forEach(c => { callMap[c.strike] = c; });
              const putMap = {};
              exp.puts.forEach(p => { putMap[p.strike] = p; });

              let callDollarVol = strikes.map(s => callMap[s] ? callMap[s].dollarVol : 0);
              let putDollarVol = strikes.map(s => putMap[s] ? putMap[s].dollarVol : 0);

              // Replace today's per-strike $Vol with the sum over the last 6
              // trading-day snapshots (matched by expiration label across
              // exp1/exp2/exp3, since exp1 rolls after each expiry).
              let volAggDays = 0;
              let volAggLatest = null; // newest matched snapshot — supplies the latest-day core bars
              if (ivHistoryMap[ticker]) {
                const recent = ivHistoryMap[ticker]
                  .filter(r => r && r.date)
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .slice(-6);
                const callAgg = {}, putAgg = {};
                for (const rec of recent) {
                  const e = ['exp1', 'exp2', 'exp3'].map(k => rec[k]).find(x => x && x.label === exp.label);
                  if (!e || (!(e.calls || []).length && !(e.puts || []).length)) continue;
                  volAggDays++;
                  volAggLatest = rec;
                  (e.calls || []).forEach(c => { callAgg[c.strike] = (callAgg[c.strike] || 0) + (c.dv || 0); });
                  (e.puts || []).forEach(p => { putAgg[p.strike] = (putAgg[p.strike] || 0) + (p.dv || 0); });
                }
                if (volAggDays > 0) {
                  callDollarVol = strikes.map(s => callAgg[s] || 0);
                  putDollarVol = strikes.map(s => putAgg[s] || 0);
                }
              }
              // Latest trading day's slice of that aggregate — drawn as a narrow
              // solid core inside each agg bar so fresh single-day flow is
              // readable at a glance alongside the 6-day total.
              let callDayVol = null, putDayVol = null, dayVolDate = null;
              if (volAggLatest) {
                const e = ['exp1', 'exp2', 'exp3'].map(k => volAggLatest[k]).find(x => x && x.label === exp.label);
                if (e && ((e.calls || []).length || (e.puts || []).length)) {
                  dayVolDate = volAggLatest.date;
                  const dayCall = {}, dayPut = {};
                  (e.calls || []).forEach(c => { dayCall[c.strike] = c.dv || 0; });
                  (e.puts || []).forEach(p => { dayPut[p.strike] = p.dv || 0; });
                  callDayVol = strikes.map(s => dayCall[s] || 0);
                  putDayVol = strikes.map(s => dayPut[s] || 0);
                }
              }
              const callDollarOI = strikes.map(s => callMap[s] ? callMap[s].dollarOI : 0);
              const putDollarOI = strikes.map(s => putMap[s] ? putMap[s].dollarOI : 0);
              const callIV = strikes.map(s => callMap[s] && callMap[s].iv > 0 ? callMap[s].iv : null);
              const putIV = strikes.map(s => putMap[s] && putMap[s].iv > 0 ? putMap[s].iv : null);

              // Populate weighted IV label
              const ivLabel = document.getElementById('opts-iv-label-' + ei + '-' + ticker);
              if (ivLabel && (exp.wCallIV > 0 || exp.wPutIV > 0)) {
                let ivHtml = '<span style="color:rgba(72,187,120,0.9);">Call IV: ' + exp.wCallIV.toFixed(1) + '%</span>';
                if (exp.atmCallIV > 0) ivHtml += '<span style="color:#888; font-size:0.85em;"> (ATM ' + exp.atmCallIV.toFixed(1) + '%, ' + (exp.ivSpreadCall >= 0 ? '+' : '') + exp.ivSpreadCall.toFixed(1) + ' spread, ' + (exp.deepOTMCallPct || 0).toFixed(0) + '% deep)</span>';
                ivHtml += ' | <span style="color:rgba(245,101,101,0.9);">Put IV: ' + exp.wPutIV.toFixed(1) + '%</span>';
                if (exp.atmPutIV > 0) ivHtml += '<span style="color:#888; font-size:0.85em;"> (ATM ' + exp.atmPutIV.toFixed(1) + '%, ' + (exp.ivSpreadPut >= 0 ? '+' : '') + exp.ivSpreadPut.toFixed(1) + ' spread, ' + (exp.deepOTMPutPct || 0).toFixed(0) + '% deep)</span>';
                ivLabel.innerHTML = ivHtml;
              }

              const strikeDatasets = [
                { label: 'Call $ OI', data: callDollarOI, backgroundColor: 'rgba(72, 187, 120, 0.15)', borderColor: 'rgba(72, 187, 120, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 3, barPercentage: 0.95 },
                { label: 'Put $ OI', data: putDollarOI, backgroundColor: 'rgba(245, 101, 101, 0.15)', borderColor: 'rgba(245, 101, 101, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 3, barPercentage: 0.95 },
                { label: 'Call $ Vol', data: callDollarVol, backgroundColor: 'rgba(72, 187, 120, 0.6)', borderColor: 'rgba(72, 187, 120, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 2, barPercentage: 0.6 },
                { label: 'Put $ Vol', data: putDollarVol, backgroundColor: 'rgba(245, 101, 101, 0.6)', borderColor: 'rgba(245, 101, 101, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 2, barPercentage: 0.6 },
              ];
              if (callDayVol && putDayVol) {
                // Same stacks as the agg $Vol bars → same x slot; order 1.5 draws
                // after them (order 2) but under the IV lines (order 1), so the
                // solid bar renders as an inner core of the aggregate.
                strikeDatasets.push(
                  { label: 'Call 1d (' + dayVolDate.slice(5) + ')', data: callDayVol, backgroundColor: 'rgba(22, 101, 52, 1)', yAxisID: 'yDollar', stack: 'call', order: 1.5, barPercentage: 0.3 },
                  { label: 'Put 1d (' + dayVolDate.slice(5) + ')', data: putDayVol, backgroundColor: 'rgba(153, 27, 27, 1)', yAxisID: 'yDollar', stack: 'put', order: 1.5, barPercentage: 0.3 },
                );
              }
              strikeDatasets.push(
                { label: 'Call IV', data: callIV, borderColor: 'rgba(72, 187, 120, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
                { label: 'Put IV', data: putIV, borderColor: 'rgba(245, 101, 101, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
              );

              new Chart(canvas, {
                type: 'bar',
                data: {
                  labels: strikeLabels,
                  datasets: strikeDatasets,
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  plugins: {
                    title: { display: true, text: 'Exp: ' + exp.label + (volAggDays > 0 ? ' ($Vol = ' + volAggDays + 'd agg' + (dayVolDate ? ', core ' + dayVolDate.slice(5) + ')' : ')') : ''), color: '#b0b0b0', font: { size: 11 } },
                    legend: { display: false },
                    tooltip: {
                      callbacks: {
                        label: function(ctx) {
                          if (ctx.dataset.yAxisID === 'yIV') return ctx.dataset.label + ': ' + (ctx.raw !== null ? ctx.raw.toFixed(1) + '%' : 'N/A');
                          return ctx.dataset.label + ': ' + fmtDollar(ctx.raw);
                        }
                      }
                    },
                  },
                  scales: {
                    x: { stacked: true, ticks: { color: '#909090', font: { size: 8 }, maxRotation: 45 }, grid: { color: '#2a2a4a' } },
                    yDollar: {
                      position: 'left',
                      stacked: false,
                      ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return fmtDollar(v); } },
                      grid: { color: '#2a2a4a' },
                      beginAtZero: true,
                    },
                    yIV: {
                      position: 'right',
                      ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } },
                      grid: { drawOnChartArea: false },
                    },
                  },
                },
              });
              // new Chart(...) returns the instance in Chart.js ≥3; fall back to the registry lookup
              const expChart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(canvas) : null;
              expChartInfos.push({
                chart: expChart,
                expLabel: exp.label,
                aggCall: callDollarVol, aggPut: putDollarVol,
                dayCall: callDayVol, dayPut: putDayVol, dayDate: dayVolDate,
                aggDays: volAggDays,
                titleAgg: 'Exp: ' + exp.label + (volAggDays > 0 ? ' ($Vol = ' + volAggDays + 'd agg' + (dayVolDate ? ', core ' + dayVolDate.slice(5) + ')' : ')') : ''),
                titleLatest: 'Exp: ' + exp.label + (dayVolDate ? ' ($Vol = latest ' + dayVolDate.slice(5) + ')' : ''),
              });
            }

            // $Vol toggle: switch between 6-day accumulated bars and latest-day-only bars.
            // Chart.js re-fits the yDollar axis on update(), so the scale follows the data.
            const volToggle = document.getElementById('opts-vol-toggle-' + ticker);
            if (volToggle) {
              const toggleable = expChartInfos.some(i => i.chart && i.aggDays > 0 && i.dayCall);
              if (!toggleable) {
                volToggle.style.display = 'none';
              } else {
                let latestMode = false;
                volToggle.addEventListener('click', () => {
                  latestMode = !latestMode;
                  volToggle.textContent = latestMode ? '$Vol: latest day' : '$Vol: 6d accumulated';
                  for (const info of expChartInfos) {
                    if (!info.chart) continue;
                    for (const ds of info.chart.data.datasets) {
                      if (ds.label === 'Call $ Vol') { ds.data = latestMode && info.dayCall ? info.dayCall : info.aggCall; ds.barPercentage = latestMode ? 0.95 : 0.6; }
                      if (ds.label === 'Put $ Vol') { ds.data = latestMode && info.dayPut ? info.dayPut : info.aggPut; ds.barPercentage = latestMode ? 0.95 : 0.6; }
                      if (ds.label.indexOf(' 1d (') !== -1) ds.hidden = latestMode; // day core is redundant in latest mode
                    }
                    info.chart.options.plugins.title.text = latestMode ? info.titleLatest : info.titleAgg;
                    info.chart.update();
                  }
                });
              }
            }

            // IV history click handler — either label toggles the history chart
            let ivHistChart = null;
            const histWrap = document.getElementById('iv-history-wrap-' + ticker);
            const histCanvas = document.getElementById('iv-history-chart-' + ticker);
            const hist = ivHistoryMap[ticker];

            function toggleHistory() {
              if (!histWrap || !histCanvas || !hist || hist.length < 2) return;
              if (histWrap.style.display !== 'none') {
                histWrap.style.display = 'none';
                return;
              }
              histWrap.style.display = 'block';
              if (ivHistChart) return; // already rendered

              const labels = hist.map(r => r.date);
              const combined = hist.map(r => combineHist(r));

              const callIVSeries = combined.map(c => c && c.callIV > 0 ? c.callIV : null);
              const putIVSeries = combined.map(c => c && c.putIV > 0 ? c.putIV : null);
              const atmCallIVSeries = combined.map(c => c && c.atmCallIV != null && c.atmCallIV > 0 ? c.atmCallIV : null);
              const atmPutIVSeries = combined.map(c => c && c.atmPutIV != null && c.atmPutIV > 0 ? c.atmPutIV : null);
              const lineBase = { type: 'line', borderWidth: 2, pointRadius: 2, fill: false, spanGaps: true, tension: 0.2 };
              const datasets = [
                { ...lineBase, label: 'Call IV', data: callIVSeries, borderColor: 'rgba(72,187,120,0.95)', backgroundColor: 'rgba(72,187,120,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Put IV', data: putIVSeries, borderColor: 'rgba(245,101,101,0.95)', backgroundColor: 'rgba(245,101,101,0.95)', yAxisID: 'y' },
                { ...lineBase, label: 'Call ATM IV', data: atmCallIVSeries, borderColor: 'rgba(72,187,120,0.7)', backgroundColor: 'rgba(72,187,120,0.7)', borderDash: [2, 2], pointRadius: 1, yAxisID: 'y' },
                { ...lineBase, label: 'Put ATM IV', data: atmPutIVSeries, borderColor: 'rgba(245,101,101,0.7)', backgroundColor: 'rgba(245,101,101,0.7)', borderDash: [2, 2], pointRadius: 1, yAxisID: 'y' },
              ];

              ivHistChart = new Chart(histCanvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    title: { display: true, text: 'Weighted IV History — ' + ticker, color: '#b0b0b0', font: { size: 11 } },
                    legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                    tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + (ctx.raw != null ? ctx.raw.toFixed(1) + '%' : 'N/A'); } } },
                  },
                  scales: {
                    x: { ticks: { color: '#909090', font: { size: 9 } }, grid: { color: '#2a2a4a' } },
                    y: { position: 'left', title: { display: true, text: 'IV %', color: '#909090', font: { size: 10 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } }, grid: { color: '#2a2a4a' } },
                  },
                },
              });
            }

            for (let li = 0; li < 3; li++) {
              const lbl = document.getElementById('opts-iv-label-' + li + '-' + ticker);
              if (lbl) lbl.addEventListener('click', toggleHistory);
            }
          }
        }

      }
    });
  });

  // ── OTM flow modal: price vs daily OTM call/put $ volume + accumulated net win ──
  // Net win model: each day's OTM flow implies a crowd bias
  //   bias = (call$ − put$) / (call$ + put$)   ∈ [−1, +1]  (call-heavy = betting up)
  // and scores it against that day's close-to-close % move:
  //   netwin = bias × return — accumulated into the line. A falling price on
  // call-heavy flow pushes the line down; on put-heavy flow it pushes it up.
  const flowModalBackdrop = document.getElementById('flow-modal');
  let flowModalChart = null;

  function fmtDV(v) {
    if (v == null) return 'N/A';
    const a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
  }

  function computeFlowSeries(ticker) {
    const cd = chartDataMap[ticker];
    if (!cd || !cd.dates || cd.dates.length === 0) return null;
    const n = cd.dates.length;
    const dateIdx = {};
    for (let i = 0; i < n; i++) dateIdx[cd.dates[i]] = i;

    // Daily OTM call/put DV summed across the tracked expirations (exp1..exp3).
    // Legacy records without per-side DV can't be signed → skipped.
    const callDV = new Array(n).fill(null);
    const putDV = new Array(n).fill(null);
    for (const r of (ivHistoryMap[ticker] || [])) {
      const i = dateIdx[r.date];
      if (i == null) continue;
      let c = 0, p = 0, usable = false;
      for (const key of ['exp1', 'exp2', 'exp3']) {
        const e = r[key];
        if (!e) continue;
        if (typeof e.callDV === 'number' && typeof e.putDV === 'number') {
          c += e.callDV; p += e.putDV; usable = true;
        }
      }
      if (usable && c + p > 0) { callDV[i] = c; putDV[i] = p; }
    }

    const bias = new Array(n).fill(null);
    const cum = new Array(n).fill(null);
    let acc = 0, started = false, firstFlowIdx = -1, lastFlowIdx = -1, flowDays = 0;
    for (let i = 0; i < n; i++) {
      if (callDV[i] == null) { cum[i] = started ? acc : null; continue; }
      let ret = null;
      if (i > 0 && cd.closes[i - 1] > 0) {
        ret = (cd.closes[i] - cd.closes[i - 1]) / cd.closes[i - 1] * 100;
      }
      if (ret != null) {
        const b = (callDV[i] - putDV[i]) / (callDV[i] + putDV[i]);
        bias[i] = b;
        acc += b * ret;
        started = true;
        flowDays++;
        lastFlowIdx = i;
        if (firstFlowIdx < 0) firstFlowIdx = i;
      }
      cum[i] = started ? acc : null;
    }
    return { n, dates: cd.dates, closes: cd.closes, callDV, putDV, bias, cum, firstFlowIdx, lastFlowIdx, flowDays };
  }

  function biasLabel(b) {
    if (b == null) return 'no flow';
    if (b >= 0.15) return 'call-heavy';
    if (b <= -0.15) return 'put-heavy';
    return 'balanced';
  }

  function closeFlowModal() {
    if (!flowModalBackdrop) return;
    flowModalBackdrop.classList.remove('open');
  }

  function openFlowModal(ticker) {
    if (!flowModalBackdrop) return;
    const cd = chartDataMap[ticker];
    if (!cd) return;
    const s = computeFlowSeries(ticker);
    const titleEl = document.getElementById('flow-modal-title');
    const metaEl = document.getElementById('flow-modal-meta');
    const canvas = document.getElementById('flow-modal-chart');
    if (!canvas) return;

    titleEl.textContent = ticker + ' — Price vs OTM Options Flow';

    const pricePoints = cd.closes.map((v, i) => ({ x: i, y: v }));
    const datasets = [{
      label: ticker + ' Close',
      data: pricePoints,
      borderColor: 'rgba(136, 176, 136, 0.8)',
      backgroundColor: 'rgba(136, 176, 136, 0.08)',
      borderWidth: 1.5,
      pointRadius: 0,
      fill: true,
      yAxisID: 'y',
      order: 1,
    }];

    let metaText = 'No OTM options flow history for this ticker';
    const maxDV = Math.max(...s.callDV.map(v => v == null ? 0 : v), ...s.putDV.map(v => v == null ? 0 : v));
    if (s.flowDays > 0) {
      const callPts = [], putPts = [], winPts = [];
      for (let i = 0; i < s.n; i++) {
        if (s.callDV[i] != null) callPts.push({ x: i, y: s.callDV[i] });
        if (s.putDV[i] != null) putPts.push({ x: i, y: s.putDV[i] });
        if (s.cum[i] != null) winPts.push({ x: i, y: s.cum[i] });
      }
      datasets.unshift(
        {
          label: 'OTM Call $',
          data: callPts,
          type: 'bar',
          backgroundColor: 'rgba(72, 187, 120, 0.55)',
          borderColor: 'rgba(72, 187, 120, 0.85)',
          borderWidth: 1,
          yAxisID: 'yDV',
          order: 4,
        },
        {
          label: 'OTM Put $',
          data: putPts,
          type: 'bar',
          backgroundColor: 'rgba(245, 101, 101, 0.55)',
          borderColor: 'rgba(245, 101, 101, 0.85)',
          borderWidth: 1,
          yAxisID: 'yDV',
          order: 4,
        },
      );
      datasets.push({
        label: 'Net win (cum.)',
        data: winPts,
        borderColor: 'rgba(232, 193, 90, 0.95)',
        backgroundColor: 'rgba(232, 193, 90, 0.95)',
        borderWidth: 1.5,
        borderDash: [5, 3],
        pointRadius: 0,
        type: 'line',
        spanGaps: true,
        yAxisID: 'yWin',
        order: 2,
      });

      const fmtPts = v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' pts';
      const lastBias = s.bias[s.lastFlowIdx];
      const lastBiasColor = lastBias >= 0.15 ? '#48bb78' : lastBias <= -0.15 ? '#f56565' : '#8a96b0';
      metaText = 'Net win: <b style="color:' + (s.cum[s.lastFlowIdx] >= 0 ? '#48bb78' : '#f56565') + '">'
        + fmtPts(s.cum[s.lastFlowIdx]) + '</b>'
        + ' &middot; latest flow ' + s.dates[s.lastFlowIdx] + ': <b style="color:' + lastBiasColor + '">'
        + biasLabel(lastBias) + ' (' + (lastBias >= 0 ? '+' : '') + lastBias.toFixed(2) + ')</b>'
        + ' &middot; ' + s.flowDays + ' flow days &middot; bars: call$ vs put$';
    }
    metaEl.innerHTML = metaText;

    if (flowModalChart) { flowModalChart.destroy(); flowModalChart = null; }
    flowModalChart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: '#909090', boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: function(items) { return items[0] ? s.dates[items[0].parsed.x] || '' : ''; },
              label: function(ctx) {
                const v = ctx.parsed.y;
                if (v == null) return '';
                if (ctx.dataset.yAxisID === 'yDV') return ctx.dataset.label + ': ' + fmtDV(v);
                if (ctx.dataset.yAxisID === 'yWin') return ctx.dataset.label + ': ' + (v >= 0 ? '+' : '') + v.toFixed(2) + ' pts';
                return ctx.dataset.label + ': $' + v.toFixed(2);
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: '#909090',
              maxTicksLimit: 12,
              font: { size: 10 },
              callback: function(val) { return s.dates[val] || ''; },
            },
            grid: { color: '#2a2a4a' },
            min: 0,
            max: s.n - 1,
          },
          y: {
            position: 'left',
            title: { display: true, text: 'Price', color: '#909090', font: { size: 10 } },
            ticks: { color: '#909090', font: { size: 10 } },
            grid: { color: '#2a2a4a' },
          },
          yDV: {
            position: 'right',
            display: false,
            beginAtZero: true,
            max: maxDV * 4,
            grid: { drawOnChartArea: false },
          },
          ...(s.flowDays > 0 ? {
            yWin: {
              position: 'right',
              title: { display: true, text: 'Net win (pts)', color: '#909090', font: { size: 10 } },
              ticks: {
                color: '#e8c15a',
                font: { size: 10 },
                callback: function(v) { return (v >= 0 ? '+' : '') + v.toFixed(0); },
              },
              grid: { drawOnChartArea: false },
            },
          } : {}),
        },
      },
    });

    flowModalBackdrop.classList.add('open');
  }

  if (flowModalBackdrop) {
    document.querySelectorAll('.flow-modal-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFlowModal(btn.getAttribute('data-ticker'));
      });
    });
    document.getElementById('flow-modal-close').addEventListener('click', closeFlowModal);
    flowModalBackdrop.addEventListener('click', (e) => {
      if (e.target === flowModalBackdrop) closeFlowModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeFlowModal();
    });
  }

  // Sorting — skip chart rows
  const table = document.getElementById('screen-table');
  const headers = table.querySelectorAll('th');
  let currentCol = -1, ascending = true;

  headers.forEach((th, colIdx) => {
    th.addEventListener('click', () => {
      if (currentCol === colIdx) {
        ascending = !ascending;
      } else {
        currentCol = colIdx;
        ascending = (colIdx === 1);
      }

      headers.forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');

      headers.forEach(h => h.querySelector('.sort-arrow').textContent = '');
      th.querySelector('.sort-arrow').textContent = ascending ? ' \\u25B2' : ' \\u25BC';

      const tbody = table.querySelector('tbody');
      // Collect data-row + chart-row pairs
      const pairs = [];
      const dataRows = tbody.querySelectorAll('tr.data-row');
      dataRows.forEach(dr => {
        const ticker = dr.getAttribute('data-ticker');
        const chartRow = tbody.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
        pairs.push({ dataRow: dr, chartRow });
      });
      // Also collect rows without data-row class (error/skipped tickers)
      const allTrSet = new Set();
      pairs.forEach(p => { allTrSet.add(p.dataRow); if (p.chartRow) allTrSet.add(p.chartRow); });
      const otherRows = Array.from(tbody.querySelectorAll('tr')).filter(r => !allTrSet.has(r) && !r.classList.contains('chart-row'));
      otherRows.forEach(r => pairs.push({ dataRow: r, chartRow: null }));

      pairs.sort((a, b) => {
        const aVal = a.dataRow.children[colIdx]?.getAttribute('data-v') || '';
        const bVal = b.dataRow.children[colIdx]?.getAttribute('data-v') || '';
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);

        let cmp;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          cmp = aNum - bNum;
        } else {
          cmp = aVal.localeCompare(bVal);
        }
        return ascending ? cmp : -cmp;
      });

      pairs.forEach(p => {
        tbody.appendChild(p.dataRow);
        if (p.chartRow) tbody.appendChild(p.chartRow);
      });
    });
  });

  // Shape map starts hidden; the clustering itself is explored on the companion
  // "cluster investigation" page (see clusterInvestigationHtml.js).
  (function () {
    const plotToggle = document.getElementById("cluster-plot-toggle");
    const plotWrap = document.getElementById("cluster-plot-wrap");
    if (plotToggle && plotWrap) plotToggle.addEventListener("click", () => {
      const show = plotWrap.style.display === "none";
      plotWrap.style.display = show ? "" : "none";
      plotToggle.textContent = show ? "▾ Hide shape map (PC1/PC2)" : "▸ Show shape map (PC1/PC2)";
    });
  })();
})();
<\/script>
</body></html>`;
}


module.exports = { generateScreeningHTML };
