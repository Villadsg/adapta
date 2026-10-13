/**
 * Implied Thesis — derive what the cluster of out-of-the-money call buyers
 * appears to be betting on, in ONE combined LLM pass.
 *
 * Candidate selection is unchanged: tickers whose nearest-expiration call
 * flow looks unusual (deep-OTM dollar share and/or OTM-over-ATM IV premium,
 * with a dollar-volume noise floor) form the cluster. Each candidate is then
 * described by RELATIVE metrics only:
 *
 *   - price: today's move in standard deviations of the ticker's own last
 *     ~100 daily returns (plus its volume-gap percentile),
 *   - IV: weighted OTM put IV vs weighted OTM call IV (the put-call skew),
 *   - dollar volume: OTM call dollars vs OTM put dollars (plain OTM split),
 *     plus the deep-OTM share of call dollars.
 *
 * Finviz headlines ride along ONLY when the run fetched news, labeled as
 * context hints. The single generation must produce one collective thesis —
 * the future outcome that best explains why these particular companies show
 * call-tilted positioning — for the user to judge. Generation is injected
 * (`generate(system, user, maxNewTokens)`) so the LLM backend stays swappable
 * and the orchestration is testable without a model.
 */

const { combineHistRecord } = require('../main/screeningStats');

const DEFAULTS = Object.freeze({
  maxTickers: 8,
  minCallDollarVol: 250000, // noise floor on nearest-expiration call dollar volume
  minScore: 5,              // deep-OTM share (%) + IV-premium (pts)
  maxSummaryChars: 500,
  maxHeadlines: 5,
});

const SYSTEM_PROMPT = [
  'You are a careful markets analyst deriving what a cluster of option buyers appears to be betting on.',
  'You will be given several companies, each with its business profile and relative options metrics.',
  'Hard rules: company facts come ONLY from the provided business descriptions, sectors and industries;',
  'anything beyond them must be marked with "likely" or "plausibly". Never invent numbers — only use',
  'the metrics provided. A thesis is a hypothesis for the user to judge, not advice; no trading',
  'recommendations. Plain short sentences, no markdown, no bullet characters.',
].join(' ');

const CLASS_LABELS = {
  surprising_positive: 'Surprising Positive (gapped down, closed above prior close)',
  positive_anticipated: 'Positive Anticipated (gapped up, held the gains)',
  negative_anticipated: 'Negative Anticipated (gapped down, stayed down)',
  surprising_negative: 'Surprising Negative (gapped up, sold off)',
};

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('en-US');
const fmtSigned = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);

function sumDV(contracts) {
  let dv = 0;
  for (const c of contracts || []) dv += c.dollarVol || 0;
  return dv;
}

/**
 * Today's move relative to the ticker's own recent moves: last daily return
 * in standard deviations of the trailing daily returns.
 * @returns {Object|null} { lastReturnPct, sigma, n } — sigma null when the
 *   baseline has (near-)zero dispersion or too few closes.
 */
function priceContext(entry) {
  const closes = entry && entry.chartData && entry.chartData.closes;
  if (!Array.isArray(closes) || closes.length < 11) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  return {
    lastReturnPct: rets[rets.length - 1],
    sigma: sd > 1e-9 ? (rets[rets.length - 1] - mean) / sd : null,
    n: rets.length,
  };
}

/**
 * Percentile of `val` within `arr` (0-100). Same semantics as the report's
 * pctRank: share of historical values ≤ the current one.
 */
function pctRank(arr, val) {
  if (!arr || arr.length === 0 || val == null) return null;
  let below = 0;
  for (const v of arr) if (v <= val) below++;
  return Math.round((below / arr.length) * 100);
}

/**
 * The OTM-vs-ATM skew and IV levels, relative to the ticker's own IV history
 * (iv_history_records via combineHistRecord — the same normalizer the report
 * uses). Spread ranks need >=3 records, level ranks >=10; null otherwise.
 */
function spreadContext(entry, history) {
  const records = history && history[entry.ticker];
  if (!Array.isArray(records) || records.length === 0) return null;
  const exp = entry.chartData && entry.chartData.optionsStrikes &&
    entry.chartData.optionsStrikes[0];
  if (!exp) return null;
  const callSpreads = [], putSpreads = [], callIVs = [], putIVs = [];
  for (const r of records) {
    const e = combineHistRecord(r);
    if (!e) continue;
    if (e.callIV > 0 && e.atmCallIV != null) {
      callSpreads.push(e.callIV - e.atmCallIV);
      callIVs.push(e.callIV);
    }
    if (e.putIV > 0 && e.atmPutIV != null) {
      putSpreads.push(e.putIV - e.atmPutIV);
      putIVs.push(e.putIV);
    }
  }
  return {
    callSpreadRank: callSpreads.length >= 3 ? pctRank(callSpreads, exp.ivSpreadCall) : null,
    putSpreadRank: putSpreads.length >= 3 ? pctRank(putSpreads, exp.ivSpreadPut) : null,
    callIVRank: callIVs.length >= 10 ? pctRank(callIVs, exp.wCallIV) : null,
    putIVRank: putIVs.length >= 10 ? pctRank(putIVs, exp.wPutIV) : null,
  };
}

/**
 * Plain-OTM dollar split for one expiration: call dollars at strikes at or
 * above spot vs put dollars at or below spot.
 */
function otmDollarSplit(exp, price) {
  let callOtm = 0, putOtm = 0;
  if (!price || !(price > 0)) return null;
  for (const c of exp.calls || []) {
    if (c.strike >= price) callOtm += c.dollarVol || 0;
  }
  for (const p of exp.puts || []) {
    if (p.strike <= price) putOtm += p.dollarVol || 0;
  }
  return {
    callOtm,
    putOtm,
    ratio: putOtm > 0 ? callOtm / putOtm : null,
  };
}

/** Nearest-expiration relative-metric snapshot for one screened entry, or null. */
function expSnapshot(entry) {
  const exp = entry && entry.chartData && entry.chartData.optionsStrikes &&
    entry.chartData.optionsStrikes[0];
  if (!exp) return null;
  const callDollarVol = sumDV(exp.calls);
  const putDollarVol = sumDV(exp.puts);
  if (!(callDollarVol > 0)) return null;
  const spot = entry.latestPrice != null ? entry.latestPrice : entry.lastClose;
  return {
    expiration: exp.label || 'nearest',
    callDollarVol,
    putDollarVol,
    deepOTMCallPct: exp.deepOTMCallPct != null ? exp.deepOTMCallPct : 0,
    ivSpreadCall: exp.ivSpreadCall != null ? exp.ivSpreadCall : 0,
    ivSpreadPut: exp.ivSpreadPut != null ? exp.ivSpreadPut : 0,
    wCallIV: exp.wCallIV != null ? exp.wCallIV : 0,
    wPutIV: exp.wPutIV != null ? exp.wPutIV : 0,
    putCallIVSpread: (exp.wPutIV != null ? exp.wPutIV : 0) - (exp.wCallIV != null ? exp.wCallIV : 0),
    otmSplit: otmDollarSplit(exp, spot),
  };
}

/**
 * Rank entries by OTM-call tilt (deep-OTM dollar share + OTM-over-ATM IV
 * premium) and keep the loudest few, requiring meaningful call flow.
 * @returns {Array} candidate cards with profile, flow and relative metrics
 */
function selectThesisCandidates(allTickers, opts = {}) {
  const { history, ...rest } = opts;
  const o = { ...DEFAULTS, ...rest };
  const scored = [];
  for (const entry of allTickers || []) {
    if (!entry || !entry.ticker || entry.skipped || entry.error) continue;
    const s = expSnapshot(entry);
    if (!s || s.callDollarVol < o.minCallDollarVol) continue;
    const score = s.deepOTMCallPct + Math.max(s.ivSpreadCall, 0);
    if (score < o.minScore) continue;
    const price = priceContext(entry);
    const headlines = Array.isArray(entry.news) && entry.news.length > 0
      ? entry.news.slice(0, o.maxHeadlines).map(n => String(n.headline || '')).filter(Boolean)
      : null;
    scored.push({
      ticker: entry.ticker,
      score,
      sector: entry.sector || '',
      industry: entry.industry || '',
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      latestPrice: entry.latestPrice != null ? entry.latestPrice : entry.lastClose,
      classification: entry.classification || '',
      gap: entry.gap || 0,
      percentile: entry.percentile || 0,
      lastReturnPct: price ? price.lastReturnPct : null,
      sigma: price ? price.sigma : null,
      sigmaN: price ? price.n : 0,
      headlines,
      expiration: s.expiration,
      callDollarVol: s.callDollarVol,
      putDollarVol: s.putDollarVol,
      deepOTMCallPct: s.deepOTMCallPct,
      ivSpreadCall: s.ivSpreadCall,
      ivSpreadPut: s.ivSpreadPut,
      wCallIV: s.wCallIV,
      wPutIV: s.wPutIV,
      putCallIVSpread: s.putCallIVSpread,
      otmSplit: s.otmSplit,
      ...(spreadContext(entry, history) || {}),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, o.maxTickers);
}

/** Trim to a word boundary so prompts stay small and end cleanly. */
function trimSummary(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '') + '…';
}

function companyBlock(c, i) {
  const where = c.sector ? ` (${c.sector}${c.industry ? ' / ' + c.industry : ''})` : '';
  const lines = [`${i + 1}. ${c.ticker}${where}`];
  lines.push(`Business: ${trimSummary(c.summary, DEFAULTS.maxSummaryChars) || 'not available'}`);
  if (c.lastReturnPct != null) {
    const sigma = c.sigma != null ? `, which is ${fmtSigned(c.sigma)}σ against its own last ${c.sigmaN} daily moves` : '';
    const vgap = c.percentile ? `; volume-gap percentile ${c.percentile}` : '';
    lines.push(`Price: last move ${fmtSigned(c.lastReturnPct)}%${sigma}${vgap}.`);
  }
  lines.push(`IV: weighted OTM call IV ${c.wCallIV.toFixed(1)}% vs OTM put IV ${c.wPutIV.toFixed(1)}% ` +
    `(puts ${fmtSigned(c.putCallIVSpread)} pts over calls).`);
  const skewBits = [];
  if (c.ivSpreadCall != null) {
    skewBits.push(`OTM call IV ${fmtSigned(c.ivSpreadCall)} pts over ATM` +
      (c.callSpreadRank != null ? ` (p${c.callSpreadRank} of its own history)` : ''));
  }
  if (c.ivSpreadPut != null) {
    skewBits.push(`OTM put IV ${fmtSigned(c.ivSpreadPut)} pts over ATM` +
      (c.putSpreadRank != null ? ` (p${c.putSpreadRank})` : ''));
  }
  if (skewBits.length) {
    lines.push(`Skew vs the body: ${skewBits.join('; ')}.`);
  }
  if (c.callIVRank != null || c.putIVRank != null) {
    const levelBits = [];
    if (c.callIVRank != null) levelBits.push(`call p${c.callIVRank}`);
    if (c.putIVRank != null) levelBits.push(`put p${c.putIVRank}`);
    lines.push(`Whole OTM IV level vs its own history: ${levelBits.join(', ')}.`);
  }
  if (c.otmSplit && c.otmSplit.ratio != null) {
    lines.push(`Flow: OTM call ${fmtMoney(c.otmSplit.callOtm)} vs OTM put ${fmtMoney(c.otmSplit.putOtm)} ` +
      `(call/put ${c.otmSplit.ratio.toFixed(2)}); ${c.deepOTMCallPct.toFixed(1)}% of call dollars sit 10%+ out of the money.`);
  }
  if (c.headlines && c.headlines.length > 0) {
    lines.push(`Headlines (context hints only): ${c.headlines.map(h => `"${h}"`).join(' | ')}`);
  }
  return lines.join('\n');
}

function combinedPrompt(candidates) {
  const lines = [
    `An options screen flagged ${candidates.length} companies with unusual out-of-the-money call ` +
      'activity. For each company: its business, then relative metrics (price vs its own recent ' +
      'moves, put-vs-call IV, OTM call-vs-put dollar volume).',
    '',
    candidates.map((c, i) => companyBlock(c, i)).join('\n\n'),
    '',
    'Task: derive ONE implied thesis for this whole cluster, under 150 words, plain sentences — ' +
      'the single future outcome or shared theme that best explains why these particular companies ' +
      'all show call-tilted positioning. Weigh what the companies do (their strengths and ' +
      'fragilities) over everything else. If no common outcome is plausible, say so plainly and ' +
      'name the most convincing individual case instead. Then note what observed development ' +
      'would invalidate the thesis.',
  ];
  return lines.join('\n');
}

/**
 * Run the derivation over a screening run's tickers: one combined generation
 * for the whole cluster.
 * @param {Array} allTickers - screening run entries
 * @param {Object} options - generate(system, user, maxNewTokens) plus DEFAULTS overrides
 * @returns {Object} { ok, reason, generatedAt, candidates, thesis, failures }
 */
async function runImpliedThesis(allTickers, options = {}) {
  const { generate, ivHistory, ...opts } = options;
  const empty = { ok: false, reason: '', candidates: [], thesis: null, failures: [] };
  if (typeof generate !== 'function') {
    return { ...empty, reason: 'No LLM generator available.' };
  }
  const candidates = selectThesisCandidates(allTickers, { ...opts, history: ivHistory });
  if (candidates.length === 0) {
    return { ...empty, reason: 'No notable OTM call activity in this run — nothing cleared the ' +
      'deep-OTM share / IV-premium screen with meaningful call dollar volume.' };
  }
  try {
    const text = ((await generate(SYSTEM_PROMPT, combinedPrompt(candidates), 320)) || '').trim();
    if (!text) {
      return { ...empty, candidates, reason: 'The LLM returned an empty thesis.' };
    }
    return { ok: true, reason: '', generatedAt: new Date().toISOString(), candidates, thesis: text, failures: [] };
  } catch (err) {
    return { ...empty, candidates, reason: err.message, failures: [{ ticker: '(collective)', error: err.message }] };
  }
}

module.exports = { DEFAULTS, SYSTEM_PROMPT, selectThesisCandidates, runImpliedThesis };
