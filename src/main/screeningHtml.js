// Generates the standalone screening-results HTML report.
// Extracted from main.js — takes plain data arguments only.

const { TAG_LABELS: EVENT_TAG_LABELS } = require('../services/eventTags');

function generateScreeningHTML(allTickers, totalTickers, config, ivHistoryData = {}, preEventStats = {}, notes = {}, preEventByReturnBucket = null, preEventContrast = null, peLiveSlopeByTicker = {}, toDelete = [], freshness = null, suggestedTickers = []) {
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
    if (h.summary) summaryMap[h.ticker] = h.summary;
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

    return `<tr ${hasChart ? `class="data-row" data-ticker="${h.ticker}"` : ''} data-tags="${tagsAttr}" style="${inlineStyle}">
      <td style="text-align:center; width:44px; padding:4px; white-space:nowrap;"><span class="del-mark" data-ticker="${h.ticker}" style="cursor:pointer; font-size:0.95em; color:${isDeleted ? '#e53935' : '#555'};" title="${isDeleted ? 'Marked to delete (click to unmark)' : 'Mark to delete'}">✕</span></td>
      <td data-v="${h.ticker}" style="font-weight:bold;">${h.ticker}${hasChart ? ' <span style="font-size:0.7em;color:#aaa;">▶</span>' : ''}${noteIndicator}${suggestedSet.has(h.ticker) ? ` <span style="font-size:0.68em; font-weight:600; color:#b48cff; border:1px solid #4a3a6a; background:#241f33; border-radius:4px; padding:1px 5px; vertical-align:middle;" title="Randomly drawn from the rebuild top 100 for this run">shuffle</span> <button class="add-screen-btn" data-ticker="${h.ticker}" style="font-size:0.72em; margin-left:4px; padding:1px 7px; border-radius:4px; border:1px solid #3a5a3a; background:#1e2b1e; color:#8fce8f; cursor:pointer; vertical-align:middle;" title="Permanently add ${h.ticker} to the screening list">＋ Add</button>` : ''}</td>
      <td data-v="${sec || 'zzz'}" style="font-size:0.82em; color:#888;">${sec || ''}</td>
      <td data-v="${tagsSortKey}" style="font-size:0.82em; max-width:240px;">${tagsCell}</td>
      <td data-v="${h.classification || 'zzz'}" style="color:${color}; font-weight:bold;">${label}</td>
      <td data-v="${eventProb != null ? eventProb : -1}" style="text-align:right; color:${eventProbColor}; font-weight:600;" title="TTM-R3 next-day event probability">${eventProbStr}</td>
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
      <td colspan="16" style="padding:0; background:#1a1d23;">
        <div style="display:flex; gap:12px; align-items:stretch; margin:12px 20px 8px;">
          <div id="summary-${h.ticker}" style="flex:0 1 78ch; padding:14px 18px; background:#262a33; border-left:3px solid #4a5a8a; border-radius:6px; color:#cdd5e0; font-size:0.98em; line-height:1.65; max-height:200px; overflow-y:auto;"></div>
          <div style="flex:1 1 0; min-width:280px; height:200px; background:#262a33; border-radius:6px; padding:6px 10px;">
            <canvas id="dv-iv-chart-${h.ticker}"></canvas>
          </div>
        </div>
        <div id="dv-iv-strike-wrap-${h.ticker}" style="display:none; margin:0 20px 8px; padding:10px 14px; background:#262a33; border-left:3px solid #7aa2c7; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span id="dv-iv-strike-title-${h.ticker}" style="color:#cdd5e0; font-size:0.92em;"></span>
            <button type="button" data-strike-close="${h.ticker}" style="background:transparent; color:#888; border:1px solid #444; border-radius:3px; padding:2px 8px; font-size:0.8em; cursor:pointer;">close</button>
          </div>
          <div id="dv-iv-strike-body-${h.ticker}"></div>
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
</style></head><body>
<div id="fav-toast"></div>
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
${(() => {
  const order = [
    ['surprising_positive', 'Surprising +', '#4caf50'],
    ['positive_anticipated', 'Anticipated +', '#8bc34a'],
    ['negative_anticipated', 'Anticipated -', '#ff9800'],
    ['surprising_negative', 'Surprising -', '#f44336'],
  ];
  const any = order.some(([k]) => preEventStats[k] && preEventStats[k].n > 0);
  if (!any) return '';
  // Percentile rank, range 0–100, neutral = 50 (OTM IV rank and spread rank, calls & puts).
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 70) color = '#d32f2f';
    else if (v >= 60) color = '#ef6c00';
    else if (v <= 30) color = '#1565c0';
    else if (v <= 40) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const binColor = (center) => {
    if (center >= 70) return '#d32f2f';
    if (center >= 60) return '#ef6c00';
    if (center <= 30) return '#1565c0';
    if (center <= 40) return '#0277bd';
    return '#9e9e9e';
  };
  const MAXH = 56; // px, tallest bar
  const renderHist = (counts, mean, n, hMin, hBinW, hN) => {
    if (!n || !counts) return '<div style="color:#bbb; font-size:0.85em; padding:8px 0;">—</div>';
    const maxC = Math.max(1, ...counts);
    const bars = counts.map((c, i) => {
      const lo = hMin + i * hBinW;
      const center = lo + hBinW / 2;
      const h = c === 0 ? 0 : Math.max(2, Math.round((c / maxC) * MAXH));
      return `<div title="[${lo}, ${lo + hBinW}) — ${c}" style="flex:1; display:flex; flex-direction:column; justify-content:flex-end;">
        <div style="height:${h}px; background:${binColor(center)}; border-radius:1px 1px 0 0;"></div></div>`;
    }).join('');
    const meanPct = ((mean - hMin) / (hBinW * hN)) * 100;
    return `<div style="position:relative; min-width:200px;">
      <div style="display:flex; align-items:flex-end; gap:1px; height:${MAXH}px; border-bottom:1px solid #ddd;">${bars}</div>
      <div style="position:absolute; left:50%; top:0; bottom:18px; border-left:1px dashed #ccc;"></div>
      <div title="mean ${mean == null ? '—' : mean.toFixed(1)}" style="position:absolute; left:${meanPct}%; top:-4px; bottom:18px; border-left:2px solid #111; transform:translateX(-1px);"></div>
      <div style="display:flex; justify-content:space-between; color:#aaa; font-size:0.72em; margin-top:2px;"><span>0</span><span>50</span><span>100</span></div>
      <div style="color:#888; font-size:0.78em; margin-top:1px;">mean <b>${mean == null ? '—' : mean.toFixed(1)}</b> · n=${n}</div>
    </div>`;
  };
  const histCell = (lab, counts, mean, nn, s) => `<div><div style="color:#888; font-size:0.78em; margin-bottom:2px;">${lab}</div>${renderHist(counts, mean, nn, s.histMin, s.histBinW, s.histNBins)}</div>`;
  // #2 Anticipation trajectory: point-in-time rank by trading days before the event.
  const trajCell = (st) => (st && st.mean != null && st.n)
    ? `<td style="padding:3px 10px; text-align:right;">${fmtRank(st.mean, st.n)}</td>`
    : '<td style="padding:3px 10px; text-align:right; color:#bbb;">—</td>';
  const trajRow = (lab, tr) => {
    const slope = (tr && tr.t1.mean != null && tr.t3.mean != null) ? tr.t1.mean - tr.t3.mean : null;
    const slopeCell = slope == null
      ? '<td style="padding:3px 10px; text-align:right; color:#bbb;">—</td>'
      : `<td style="padding:3px 10px; text-align:right; font-weight:600; color:${slope >= 8 ? '#d32f2f' : slope <= -8 ? '#1565c0' : '#666'};">${slope >= 0 ? '+' : ''}${slope.toFixed(0)}</td>`;
    return `<tr><td style="padding:3px 10px; color:#888;">${lab}</td>${trajCell(tr && tr.t3)}${trajCell(tr && tr.t2)}${trajCell(tr && tr.t1)}${slopeCell}</tr>`;
  };
  const trajTable = (s) => {
    if (!s.traj) return '';
    const ms = [['callOtm', 'Call OTM'], ['callAtm', 'Call ATM'], ['callSpr', 'Call Spr'], ['putOtm', 'Put OTM'], ['putAtm', 'Put ATM'], ['putSpr', 'Put Spr']];
    const body = ms.map(([m, l]) => trajRow(l, s.traj[m])).join('');
    return `<div style="margin-top:12px;">
      <div style="color:#888; font-size:0.78em; margin-bottom:3px;">Anticipation trajectory — point-in-time rank by trading days before the event (slope = T-1 − T-3; &gt;0 = IV ramping into the event, &lt;0 = bleeding off)</div>
      <table style="border-collapse:collapse; font-size:0.9em;">
        <thead><tr style="color:#999; font-size:0.78em; text-transform:uppercase;">
          <th style="padding:3px 10px; text-align:left;">Metric</th>
          <th style="padding:3px 10px; text-align:right;">T-3</th>
          <th style="padding:3px 10px; text-align:right;">T-2</th>
          <th style="padding:3px 10px; text-align:right;">T-1</th>
          <th style="padding:3px 10px; text-align:right;">Slope</th>
        </tr></thead><tbody>${body}</tbody>
      </table></div>`;
  };
  const rows = order.map(([k, label, color]) => {
    const s = preEventStats[k] || {};
    const n = s.n || 0;
    if (n === 0) {
      return `<tr style="color:#bbb;">
        <td style="padding:6px 10px 6px 24px; font-weight:bold; color:${color};">${label}</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
        <td style="padding:6px 10px; text-align:right;">—</td>
      </tr>`;
    }
    const toggle = `var d=document.getElementById('pe-d-${k}');var o=d.style.display==='none';d.style.display=o?'':'none';this.querySelector('.pe-caret').textContent=o?'▾':'▸';`;
    return `<tr style="cursor:pointer;" onclick="${toggle}" title="Click to show the distributions">
      <td style="padding:6px 10px; font-weight:bold; color:${color};"><span class="pe-caret" style="display:inline-block; width:14px; color:#999;">▸</span>${label}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callOtmMean, s.callOtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callAtmMean, s.callAtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.callSprMean, s.callSprN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putOtmMean, s.putOtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putAtmMean, s.putAtmN)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(s.putSprMean, s.putSprN)}</td>
    </tr>
    <tr id="pe-d-${k}" style="display:none;">
      <td colspan="7" style="padding:4px 10px 12px 24px; background:#fafafa;">
        <div style="display:flex; gap:24px; flex-wrap:wrap;">
          ${histCell('Call OTM IV rank', s.callOtmHist, s.callOtmMean, s.callOtmN, s)}
          ${histCell('Call ATM IV rank', s.callAtmHist, s.callAtmMean, s.callAtmN, s)}
          ${histCell('Call spread rank', s.callSprHist, s.callSprMean, s.callSprN, s)}
          ${histCell('Put OTM IV rank', s.putOtmHist, s.putOtmMean, s.putOtmN, s)}
          ${histCell('Put ATM IV rank', s.putAtmHist, s.putAtmMean, s.putAtmN, s)}
          ${histCell('Put spread rank', s.putSprHist, s.putSprMean, s.putSprN, s)}
        </div>
        <div style="color:#aaa; font-size:0.72em; margin-top:6px;">x-axis 0…100, 50 = neutral · dashed line = 50 · black line = mean</div>
        ${trajTable(s)}
      </td>
    </tr>`;
  }).join('');
  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">Pre-Event IV Profile <span style="color:#999; font-weight:normal; font-size:0.9em;">(per-event weighted-OTM-IV, weighted-ATM-IV and IV-spread percentile ranks within that ticker's own point-in-time history, denoised by averaging the last ≤3 contiguous daily snapshots before the event then averaged across events; range 0–100, 50 = neutral, &gt;60 = elevated, &lt;40 = suppressed)</span></div>
    <div style="color:#aaa; font-size:0.78em; margin-bottom:6px;">Requires ≥10 history records before the event date. Headline = per-event mean of the last ≤3 contiguous daily snapshots before the event. (n) = events contributing. Click a row for distributions and the pre-event anticipation trajectory.</div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Classification</th>
        <th style="padding:4px 10px; text-align:right;">Call OTM</th>
        <th style="padding:4px 10px; text-align:right;">Call ATM</th>
        <th style="padding:4px 10px; text-align:right;">Call Spr</th>
        <th style="padding:4px 10px; text-align:right;">Put OTM</th>
        <th style="padding:4px 10px; text-align:right;">Put ATM</th>
        <th style="padding:4px 10px; text-align:right;">Put Spr</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
})()}
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
${(() => {
  if (!preEventByReturnBucket) return '';
  const fmtRet = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const fmtRank = (v, n) => {
    if (v == null || !n) return '<span style="color:#bbb;">—</span>';
    let color = '#666';
    if (v >= 30) color = '#d32f2f';
    else if (v >= 15) color = '#ef6c00';
    else if (v <= -30) color = '#1565c0';
    else if (v <= -15) color = '#0277bd';
    return `<span style="color:${color}; font-weight:600;">${v.toFixed(0)}</span> <span style="color:#aaa; font-size:0.85em;">(${n})</span>`;
  };
  const bLabel = (label, b) => `${label} <span style="color:#999; font-weight:normal; font-size:0.85em;">[${fmtRet(b.minReturn)} … ${fmtRet(b.maxReturn)}]</span> <span style="color:#aaa; font-size:0.85em;">n=${b.n}</span>`;
  const buckets = [
    ['Low Returns', '#1565c0', 'low'],
    ['High Returns', '#d32f2f', 'high'],
  ];

  // Original: Call/Put Δrank = R(OTM) - R(spread), averaged per bucket.
  const rows1 = buckets.map(([label, color, k]) => {
    const b = preEventByReturnBucket[k];
    return `<tr>
      <td style="padding:6px 10px; font-weight:bold; color:${color};">${bLabel(label, b)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(b.callAvgRank, b.nCallAvg)}</td>
      <td style="padding:6px 10px; text-align:right;">${fmtRank(b.putAvgRank, b.nPutAvg)}</td>
    </tr>`;
  }).join('');

  return `<div style="margin-bottom:14px; padding:10px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.92em;">
    <div style="color:#666; font-weight:600; margin-bottom:4px;">IV Profile by Daily Return Bucket <span style="color:#999; font-weight:normal; font-size:0.9em;">(median split on next-day return; per-day weighted-OTM-IV rank minus spread rank from the day before, averaged across the bucket — range -100 to +100, 0 = neutral; tests if high rank precedes high vs low next-day return)</span></div>
    <table style="border-collapse:collapse;">
      <thead><tr style="color:#888; font-size:0.8em; text-transform:uppercase;">
        <th style="padding:4px 10px; text-align:left;">Bucket</th>
        <th style="padding:4px 10px; text-align:right;">Call &Delta;rank</th>
        <th style="padding:4px 10px; text-align:right;">Put &Delta;rank</th>
      </tr></thead>
      <tbody>${rows1}</tbody>
    </table>
  </div>`;
})()}
<div id="portfolio-corr-box" style="margin-bottom:14px; padding:12px 14px; background:#fff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); font-size:0.95em;">
  <div style="color:#666; font-weight:600; margin-bottom:6px;">Portfolio Correlation Check</div>
  <div style="display:flex; align-items:center; gap:10px;">
    <input id="portfolio-corr-input" type="text" placeholder="e.g. AAPL, MSFT, NVDA" style="flex:1; padding:7px 10px; border:1px solid #ddd; border-radius:6px; font-size:0.95em; outline:none;" />
    <button id="portfolio-corr-btn" style="padding:7px 16px; border:none; border-radius:6px; background:#5b8cb8; color:#fff; font-size:0.9em; cursor:pointer;">Check</button>
  </div>
  <div id="portfolio-corr-result" style="margin-top:8px;"></div>
</div>
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
<table id="screen-table">
<thead><tr>
  <th style="width:44px; text-align:center; padding:4px;"><span class="sort-arrow"></span></th>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th>Sector<span class="sort-arrow"></span></th>
  <th>Tags<span class="sort-arrow"></span></th>
  <th>Classification<span class="sort-arrow"></span></th>
  <th style="text-align:right;" title="TTM-R3 next-day event probability">Event Prob<span class="sort-arrow"></span></th>
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

<script>
(function() {
  const chartDataMap = ${JSON.stringify(chartDataMap)};
  const summaryMap = ${JSON.stringify(summaryMap)};
  const newsMap = ${JSON.stringify(newsMap)};
  const ivHistoryMap = ${JSON.stringify(ivHistoryData)};
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

  // ── Event-tag filter ──
  // Click any tag chip to filter rows; only data-rows whose data-tags contains
  // the active tag remain visible (their chart-row sibling is hidden too).
  let activeTagFilter = null;
  function applyTagFilter() {
    const bar = document.getElementById('tag-filter-bar');
    const activeEl = document.getElementById('tag-filter-active');
    if (activeTagFilter) {
      bar.style.display = '';
      activeEl.textContent = activeTagFilter;
    } else {
      bar.style.display = 'none';
      activeEl.textContent = '';
    }
    document.querySelectorAll('tr.data-row').forEach(row => {
      const tags = (row.getAttribute('data-tags') || '').split(' ').filter(Boolean);
      const show = !activeTagFilter || tags.includes(activeTagFilter);
      row.style.display = show ? '' : 'none';
      const ticker = row.getAttribute('data-ticker');
      const chartRow = document.querySelector('tr.chart-row[data-chart-for="' + ticker + '"]');
      if (chartRow && !show) chartRow.style.display = 'none';
    });
    document.querySelectorAll('.event-tag').forEach(chip => {
      chip.style.outline = (chip.getAttribute('data-tag') === activeTagFilter) ? '2px solid #7aa2c7' : '';
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
  const clearLink = document.getElementById('tag-filter-clear');
  if (clearLink) clearLink.addEventListener('click', (e) => {
    e.preventDefault();
    activeTagFilter = null;
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
                callbacks: {
                  title: function(items) { return items[0] ? dates[items[0].parsed.x] || '' : ''; }
                }
              },
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

        // Populate company summary
        const sumEl = document.getElementById('summary-' + ticker);
        if (sumEl && summaryMap[ticker]) {
          sumEl.textContent = summaryMap[ticker];
        }

        // Render last-5-day DV (bars) + average IV (line) mini-chart next to summary
        const dvIvCanvas = document.getElementById('dv-iv-chart-' + ticker);
        const dvIvHist = ivHistoryMap[ticker];
        if (dvIvCanvas && Array.isArray(dvIvHist) && dvIvHist.length > 0) {
          const recent = dvIvHist.slice(-5);
          const labels = recent.map(r => (r.date || '').slice(5));
          const dvSeries = recent.map(r => {
            let dv = 0;
            for (const k of ['exp1', 'exp2', 'exp3']) {
              const e = r[k];
              if (!e) continue;
              dv += (e.callDV || 0) + (e.putDV || 0);
            }
            return dv;
          });
          const ivSeries = recent.map(r => {
            const c = combineHist(r);
            if (!c) return null;
            const vals = [];
            if (c.callIV > 0) vals.push(c.callIV);
            if (c.putIV > 0) vals.push(c.putIV);
            if (!vals.length) return null;
            return vals.reduce((s, v) => s + v, 0) / vals.length;
          });

          const dvIvDateMap = recent.map(r => r.date);
          const renderStrikeBreakdown = (dateStr) => {
            const rec = (ivHistoryMap[ticker] || []).find(r => r.date === dateStr);
            const wrap = document.getElementById('dv-iv-strike-wrap-' + ticker);
            const title = document.getElementById('dv-iv-strike-title-' + ticker);
            const body = document.getElementById('dv-iv-strike-body-' + ticker);
            if (!rec || !wrap || !body) return;
            const exps = ['exp1', 'exp2', 'exp3'].map(k => rec[k]).filter(e => e && (e.calls || e.puts));
            if (!exps.length) {
              body.innerHTML = '<div style="color:#888; font-size:0.85em; padding:8px 0;">No per-strike data for ' + dateStr + ' (older snapshots stored aggregates only — newer dates will populate).</div>';
              if (title) title.textContent = ticker + ' — ' + dateStr;
              wrap.style.display = 'block';
              return;
            }
            if (title) title.textContent = ticker + ' — ' + dateStr;
            body.innerHTML = exps.map((_, i) => '<div style="display:inline-block; width:48%; margin-right:1%; vertical-align:top;"><div style="height:300px;"><canvas id="strike-hist-' + ticker + '-' + dateStr + '-' + i + '"></canvas></div></div>').join('');
            wrap.style.display = 'block';
            exps.forEach((e, i) => {
              const cv = document.getElementById('strike-hist-' + ticker + '-' + dateStr + '-' + i);
              if (!cv) return;
              const strikeSet = new Set();
              (e.calls || []).forEach(c => strikeSet.add(c.strike));
              (e.puts || []).forEach(p => strikeSet.add(p.strike));
              const strikes = Array.from(strikeSet).sort((a, b) => a - b);
              const cMap = {}, pMap = {};
              (e.calls || []).forEach(c => { cMap[c.strike] = c; });
              (e.puts || []).forEach(p => { pMap[p.strike] = p; });
              new Chart(cv, {
                data: {
                  labels: strikes.map(s => '$' + s.toFixed(s >= 100 ? 0 : s >= 1 ? 1 : 2)),
                  datasets: [
                    { type: 'bar', label: 'Call $Vol', data: strikes.map(s => cMap[s] ? cMap[s].dv : 0), backgroundColor: 'rgba(72,187,120,0.55)', yAxisID: 'y' },
                    { type: 'bar', label: 'Put $Vol', data: strikes.map(s => pMap[s] ? pMap[s].dv : 0), backgroundColor: 'rgba(245,101,101,0.55)', yAxisID: 'y' },
                    { type: 'line', label: 'Call IV', data: strikes.map(s => cMap[s] && cMap[s].iv > 0 ? cMap[s].iv : null), borderColor: 'rgba(72,187,120,0.95)', backgroundColor: 'rgba(72,187,120,0.95)', borderWidth: 2, pointRadius: 2, spanGaps: true, yAxisID: 'y1' },
                    { type: 'line', label: 'Put IV', data: strikes.map(s => pMap[s] && pMap[s].iv > 0 ? pMap[s].iv : null), borderColor: 'rgba(245,101,101,0.95)', backgroundColor: 'rgba(245,101,101,0.95)', borderWidth: 2, pointRadius: 2, spanGaps: true, yAxisID: 'y1' },
                  ],
                },
                options: {
                  responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    title: { display: true, text: e.label || ('Exp ' + (i + 1)), color: '#b0b0b0', font: { size: 11 } },
                    legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                  },
                  scales: {
                    x: { ticks: { color: '#909090', font: { size: 9 }, maxRotation: 60, minRotation: 0 }, grid: { color: '#2a2a4a' } },
                    y: { position: 'left', beginAtZero: true, title: { display: true, text: '$Vol', color: '#909090', font: { size: 9 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K'; } }, grid: { color: '#2a2a4a' } },
                    y1: { position: 'right', title: { display: true, text: 'IV %', color: '#909090', font: { size: 9 } }, ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } }, grid: { drawOnChartArea: false } },
                  },
                },
              });
            });
          };

          const closeBtn = document.querySelector('button[data-strike-close="' + ticker + '"]');
          if (closeBtn) {
            closeBtn.addEventListener('click', () => {
              const wrap = document.getElementById('dv-iv-strike-wrap-' + ticker);
              if (wrap) wrap.style.display = 'none';
            });
          }

          new Chart(dvIvCanvas, {
            data: {
              labels,
              datasets: [
                {
                  type: 'bar',
                  label: 'Option $Vol',
                  data: dvSeries,
                  backgroundColor: 'rgba(122,162,199,0.55)',
                  borderColor: 'rgba(122,162,199,0.9)',
                  borderWidth: 1,
                  yAxisID: 'y',
                  order: 1,
                },
                {
                  type: 'line',
                  label: 'Avg IV',
                  data: ivSeries,
                  borderColor: 'rgba(245,180,80,0.95)',
                  backgroundColor: 'rgba(245,180,80,0.95)',
                  borderWidth: 2,
                  pointRadius: 3,
                  spanGaps: true,
                  tension: 0.2,
                  yAxisID: 'y1',
                  order: 0,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 200 },
              interaction: { mode: 'index', intersect: false },
              onClick: (evt, els, chart) => {
                let idx = els && els.length ? els[0].index : null;
                if (idx == null) {
                  const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
                  if (pts && pts.length) idx = pts[0].index;
                }
                if (idx == null) return;
                const dateStr = dvIvDateMap[idx];
                if (dateStr) renderStrikeBreakdown(dateStr);
              },
              plugins: {
                title: { display: true, text: 'Last 5d Option $Vol & Avg IV (click a day for strikes)', color: '#b0b0b0', font: { size: 11 } },
                legend: { labels: { color: '#909090', boxWidth: 10, font: { size: 9 } } },
                tooltip: {
                  callbacks: {
                    label: function(ctx) {
                      const v = ctx.raw;
                      if (v == null) return ctx.dataset.label + ': N/A';
                      if (ctx.dataset.yAxisID === 'y1') return ctx.dataset.label + ': ' + v.toFixed(1) + '%';
                      return ctx.dataset.label + ': $' + (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K');
                    },
                  },
                },
              },
              scales: {
                x: { ticks: { color: '#909090', font: { size: 9 } }, grid: { color: '#2a2a4a' } },
                y: {
                  position: 'left',
                  beginAtZero: true,
                  title: { display: true, text: '$Vol', color: '#909090', font: { size: 9 } },
                  ticks: {
                    color: '#909090', font: { size: 9 },
                    callback: function(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K'; },
                  },
                  grid: { color: '#2a2a4a' },
                },
                y1: {
                  position: 'right',
                  title: { display: true, text: 'Avg IV %', color: '#909090', font: { size: 9 } },
                  ticks: { color: '#909090', font: { size: 9 }, callback: function(v) { return v.toFixed(0) + '%'; } },
                  grid: { drawOnChartArea: false },
                },
              },
            },
          });
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

              // Nearest expiration only: replace today's per-strike $Vol with the
              // sum over the last 5 trading-day snapshots (matched by expiration
              // label across exp1/exp2/exp3, since exp1 rolls after each expiry).
              let volAggDays = 0;
              if (ei === 0 && ivHistoryMap[ticker]) {
                const recent = ivHistoryMap[ticker]
                  .filter(r => r && r.date)
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .slice(-5);
                const callAgg = {}, putAgg = {};
                for (const rec of recent) {
                  const e = ['exp1', 'exp2', 'exp3'].map(k => rec[k]).find(x => x && x.label === exp.label);
                  if (!e || (!(e.calls || []).length && !(e.puts || []).length)) continue;
                  volAggDays++;
                  (e.calls || []).forEach(c => { callAgg[c.strike] = (callAgg[c.strike] || 0) + (c.dv || 0); });
                  (e.puts || []).forEach(p => { putAgg[p.strike] = (putAgg[p.strike] || 0) + (p.dv || 0); });
                }
                if (volAggDays > 0) {
                  callDollarVol = strikes.map(s => callAgg[s] || 0);
                  putDollarVol = strikes.map(s => putAgg[s] || 0);
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

              new Chart(canvas, {
                type: 'bar',
                data: {
                  labels: strikeLabels,
                  datasets: [
                    { label: 'Call $ OI', data: callDollarOI, backgroundColor: 'rgba(72, 187, 120, 0.15)', borderColor: 'rgba(72, 187, 120, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 3, barPercentage: 0.95 },
                    { label: 'Put $ OI', data: putDollarOI, backgroundColor: 'rgba(245, 101, 101, 0.15)', borderColor: 'rgba(245, 101, 101, 0.3)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 3, barPercentage: 0.95 },
                    { label: 'Call $ Vol', data: callDollarVol, backgroundColor: 'rgba(72, 187, 120, 0.6)', borderColor: 'rgba(72, 187, 120, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'call', order: 2, barPercentage: 0.6 },
                    { label: 'Put $ Vol', data: putDollarVol, backgroundColor: 'rgba(245, 101, 101, 0.6)', borderColor: 'rgba(245, 101, 101, 0.9)', borderWidth: 1, yAxisID: 'yDollar', stack: 'put', order: 2, barPercentage: 0.6 },
                    { label: 'Call IV', data: callIV, borderColor: 'rgba(72, 187, 120, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
                    { label: 'Put IV', data: putIV, borderColor: 'rgba(245, 101, 101, 0.9)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, type: 'line', yAxisID: 'yIV', order: 1, spanGaps: true },
                  ],
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: { duration: 200 },
                  plugins: {
                    title: { display: true, text: 'Exp: ' + exp.label + (volAggDays > 0 ? ' ($Vol = ' + volAggDays + 'd agg)' : ''), color: '#b0b0b0', font: { size: 11 } },
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
})();
<\/script>
</body></html>`;
}


module.exports = { generateScreeningHTML };
