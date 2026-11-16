/**
 * Company descriptions from a three-source mix, shared by the screening
 * pipeline (ci/ticker-screen.js).
 *
 * Sources per ticker (all fetched, then merged):
 *   US-listed:  SEC EDGAR (latest 10-K, Item 1), Yahoo, Wikipedia
 *   Non-US:     Yahoo, Wikipedia, EDGAR (last — class shares like BRK.B)
 *
 * - EDGAR is the company's own words as of its latest annual report. The
 *   ticker→CIK map comes from the SEC's bulk company_tickers.json (cached on
 *   disk for a week), the latest 10-K from the submissions JSON API at
 *   data.sec.gov/submissions/ (relocated off /api/ in 2026; browse-edgar Atom
 *   feed kept as fallback), and the description is the Item 1 text of the
 *   10-K's primary document, truncated. The company's SIC description fills
 *   `industry` when Yahoo has nothing. Known gaps that fall through to Yahoo:
 *   foreign private issuers file 20-Fs, not 10-Ks (TSM, ARM, MNDY);
 *   incorporation-by-reference filers whose Item 1 lives in an exhibit
 *   (Intel); and names whose 10-K predates the submissions API's
 *   recent-filings window (very high-volume filers like Dell) or that have
 *   not filed one yet (recent listings).
 * - Yahoo (quoteSummary assetProfile) remains the source for
 *   marketCap/sector/industry and backs the summary for names EDGAR can't
 *   resolve (non-US listings, some micro-caps).
 * - Wikipedia mapping goes through Wikidata's SPARQL API (stock-exchange
 *   statement P414 with ticker-symbol qualifier P249 — no scraping): the
 *   resolved entity's English Wikipedia article is then read via the
 *   Wikipedia REST summary endpoint. Wikidata's own one-line description is
 *   the last resort.
 *
 * Results are cached in ci/description-cache.json (entries carry `source`
 * — the primary — and `sources`, the list that survived the merge). Summary
 * TTL 7 days, marketCap TTL 1 day so daily screening runs skip Yahoo on
 * warm entries.
 *
 * Multi-source merge: all usable source texts are split into sentences,
 * embedded in one batch (title: company description), and walked in
 * priority order — a sentence is kept only if its cosine to every already
 * kept sentence is below DEDUP_SIMILARITY, so paraphrased duplicates
 * (Yahoo/Wikipedia largely restate the 10-K) drop out and only genuinely
 * new meaning from later sources is appended. EDGAR Item 1 boilerplate
 * (forward-looking disclaimers, filing formalia) is pattern-filtered before
 * the embedding pass, as are MD&A variance sentences (dollar figures,
 * period-over-period changes), accounting captions and corporate trivia.
 *
 * The deduped sentences are then condensed by the local LLM
 * (LabInsightsService backend; disable with DESCRIPTION_LLM=0) into one
 * income-channel paragraph naming the products/services sold and what
 * customers pay for. When the LLM is unavailable or produces a bad answer,
 * the previous extractive income-keyword filter output is used instead.
 *
 * SEC fair-access policy: all sec.gov/data.sec.gov requests identify with a
 * contact email (EDGAR_CONTACT_EMAIL, else the project maintainer's).
 */
const fs = require('fs');
const path = require('path');
const embeddingService = require('./embeddings');

const CACHE_PATH = path.join(__dirname, '..', '..', 'ci', 'description-cache.json');
const TICKER_MAP_PATH = path.join(__dirname, '..', '..', 'ci', 'edgar-ticker-map.json');
const SUMMARY_TTL_MS = 7 * 86400e3;
const MARKETCAP_TTL_MS = 1 * 86400e3;
const TICKER_MAP_TTL_MS = 7 * 86400e3;
// Generous on purpose: the income-channel filter downstream discards most of
// what this window feeds it, so reading deeper into Item 1 only increases the
// chance of catching the revenue sentences (which often sit past the long
// opening marketing overview). The merged output is capped separately.
const ITEM1_MAX_CHARS = 12000;
const ITEM1_MIN_CHARS = 300;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGAR_UA = `Adapta screening bot ${process.env.EDGAR_CONTACT_EMAIL || 'villadsg@outlook.com'}`;

// Yahoo suffix → keywords looked for in the Wikidata exchange label, so
// ASML.AS resolves via the Amsterdam statement rather than a same-ticker
// listing elsewhere. Non-US chain only; missing suffixes fall back to the
// first SPARQL row that has an English Wikipedia article.
const SUFFIX_EXCHANGE_HINTS = {
  '.PA': ['amsterdam', 'paris', 'euronext'],
  '.AS': ['amsterdam', 'euronext'],
  '.MC': ['madrid', 'español', 'spanish', 'bme'],
  '.DE': ['frankfurt', 'xetra', 'germany', 'deutsche'],
  '.L': ['london'],
  '.MI': ['milan', 'italian', 'borsa'],
  '.ST': ['stockholm', 'nasdaq stockholm'],
  '.SW': ['switzerland', 'six', 'swiss'],
  '.TO': ['toronto'],
  '.CN': ['canada', 'tsx venture'],
  '.SI': ['singapore'],
  '.HK': ['hong kong'],
  '.SS': ['shanghai'],
  '.SZ': ['shenzhen'],
  '.AX': ['australia', 'asx'],
  '.T': ['tokyo', 'japan'],
  '.OL': ['oslo'],
  '.CO': ['copenhagen'],
  '.HE': ['helsinki'],
  '.IR': ['ireland', 'dublin'],
  '.BR': ['brussels', 'euronext brussels'],
  '.LS': ['lisbon', 'euronext lisbon'],
  '.VI': ['vienna', 'wiener'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw quoteSummary responses carry numbers as {raw, fmt, longFmt}; the
// yahoo-finance2 instance normalizes them to plain numbers.
const rawNum = (v) => (typeof v === 'number' ? v : (v && typeof v.raw === 'number' ? v.raw : 0));

// --- JSON cache -------------------------------------------------------------------

let cachePromise = null;
function loadCache() {
  if (!cachePromise) {
    cachePromise = new Promise((resolve) => {
      try {
        resolve(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')));
      } catch (_) {
        resolve({});
      }
    });
  }
  return cachePromise;
}

let cacheWriteQueued = false;
async function saveCache(cache) {
  if (cacheWriteQueued) return;
  cacheWriteQueued = true;
  await sleep(0); // coalesce writes triggered within the same tick
  cacheWriteQueued = false;
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(tmp, CACHE_PATH);
}

// --- SEC EDGAR ----------------------------------------------------------------------

let tickerMapPromise = null;

async function getEdgarTickerMap() {
  if (!tickerMapPromise) {
    tickerMapPromise = (async () => {
      try {
        const st = JSON.parse(fs.readFileSync(TICKER_MAP_PATH, 'utf-8'));
        if (Date.now() - new Date(st.fetchedAt).getTime() <= TICKER_MAP_TTL_MS) return st.map;
      } catch (_) { /* refetch below */ }
      const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip' },
      });
      if (!res.ok) throw new Error(`company_tickers.json: HTTP ${res.status}`);
      const raw = await res.json();
      const map = {};
      for (const row of Object.values(raw)) map[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
      const tmp = `${TICKER_MAP_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), map }, null, 2) + '\n');
      fs.renameSync(tmp, TICKER_MAP_PATH);
      return map;
    })().catch((err) => {
      tickerMapPromise = null; // retry on next call
      throw err;
    });
  }
  return tickerMapPromise;
}

const submissionsCache = new Map(); // ticker → {meta, at}

// Latest 10-K. Primary: the submissions JSON API. The SEC moved it off
// /api/ (the old data.sec.gov/api/submissions/... path 404s globally now;
// current location is data.sec.gov/submissions/CIK##########.json). Fallback:
// the browse-edgar Atom feed + per-accession directory index.json on
// www.sec.gov, in case data.sec.gov breaks again.
async function getLatest10K(ticker, cik) {
  const hit = submissionsCache.get(ticker);
  if (hit && Date.now() - hit.at < 3600e3) return hit.meta;

  let meta = null;
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip' },
    });
    if (res.ok) {
      const j = await res.json();
      const rec = j.filings?.recent;
      for (let i = 0; rec && i < rec.form.length; i++) {
        if (rec.form[i] !== '10-K') continue;
        const acc = rec.accessionNumber[i];
        meta = {
          docUrl: `https://www.sec.gov/Archives/edgar/data/${Number(j.cik)}/${acc.replace(/-/g, '')}/${rec.primaryDocument[i]}`,
          sicDescription: j.sicDescription || '',
        };
        break;
      }
    } else if (res.status !== 404) {
      throw new Error(`submissions ${ticker}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[desc] ${ticker}: submissions API failed (${err?.message || err}), falling back to Atom feed`);
  }

  if (!meta) meta = await getLatest10KAtom(ticker, cik);
  if (!meta) return null;
  submissionsCache.set(ticker, { meta, at: Date.now() });
  return meta;
}

// Fallback path: newest 10-K from the browse-edgar Atom feed; the primary
// document still has to be located via the accession's index.json.
async function getLatest10KAtom(ticker, cik) {
  const res = await fetch(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=5&output=atom`,
    { headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip' } }
  );
  if (!res.ok) throw new Error(`browse-edgar ${ticker}: HTTP ${res.status}`);
  const xml = await res.text();
  const sic = decodeEntities((xml.match(/<assigned-sic-desc>([^<]+)<\/assigned-sic-desc>/) || [])[1] || '');
  // Prefer an exact 10-K over a 10-K/A amendment; entries are newest-first.
  const entries = xml.split('<entry>').slice(1);
  const chosen =
    entries.find((e) => /<filing-type>10-K<\/filing-type>/.test(e)) || entries[0] || null;
  if (!chosen) return null;
  const acc = (chosen.match(/<accession-number>([^<]+)<\/accession-number>/) || [])[1];
  const href = (chosen.match(/<filing-href>([^<]+)<\/filing-href>/) || [])[1];
  if (!acc || !href) return null;
  return { accession: acc, dirUrl: href.slice(0, href.lastIndexOf('/') + 1), sicDescription: sic };
}

// The primary 10-K document is the largest .htm in the accession directory —
// exhibits and rendered XBRL pages (R1.htm, ...) are always far smaller.
async function getPrimaryDocUrl(dirUrl) {
  const res = await fetch(`${dirUrl}index.json`, {
    headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip' },
  });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const j = await res.json();
  const candidates = (j.directory?.item || []).filter(
    (it) => /\.html?$/i.test(it.name) && !/-index(-headers)?\.html?$/i.test(it.name) && !/^R\d+\.html?$/i.test(it.name)
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.size || 0) - (a.size || 0));
  return dirUrl + candidates[0].name;
}

// Minimal entity decode (numeric + common named). The browse-edgar Atom feed
// double-escapes some fields ("&amp;amp;"), so decode until stable.
function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', rsquo: '\u2019', lsquo: '\u2018',
    ldquo: '\u201C', rdquo: '\u201D', reg: '®', trade: '™', copy: '©',
  };
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

// Tag-strip to plain text. Every tag becomes a space, so words that lived in
// separate block elements (li, p, h2...) stay separated — textContent would
// concatenate them ("ConditionsMemory").
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ') // inline-XBRL metadata dump
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filer styles vary too much for pure heading matching. Apple repeats
// "Item 1. Business" at the section itself; Qualcomm's body never says it
// (only the TOC and an MD&A back-reference do). Strategy:
//   1. an explicit non-TOC, non-back-reference "Item 1. Business" (or bare
//      "Item 1.") heading, taking the LAST such occurrence (TOC first, body
//      heading later);
//   2. otherwise Item 1 is still the first content section — start right
//      after the table of contents (its last "Item 15/16" row).
// TOC rows are recognized by a page number followed by the next "Item"/"PART"
// entry right after the heading. The end anchor is the first Item 1A / Item 2
// mention after the start (post-TOC, remaining mentions are back-references
// inside Item 1 — an early cut is harmless given the 2000-char truncation).
// Shared heading finders for 10-K section extraction (used by Item 1 and
// Item 7). TOC rows carry a page number followed by the next Item/PART entry;
// cross-references ("...is provided in \"Part I, Item 1. Business\"") look
// like body headings but are preceded by an opening quote or a refer-to verb.
function sectionFinders(text) {
  const isTocRow = (idx) =>
    /^[\s.\u2026]*\d{1,3}\s+(Item|PART|Signature|Exhibit)/i.test(text.slice(idx, idx + 140));
  const isBackRef = (idx) => {
    const prev = text.slice(Math.max(0, idx - 70), idx);
    return /[\u201C"']\s*(Part\s+[IVX]+,\s*)?$/i.test(prev) ||
      /\b(see|under|in|provided|described|referred|forth|pursuant)\s+(to\s+)?(in\s+)?[\u201C"']?(Part\s+[IVX]+,\s*)?$/i.test(prev);
  };
  const findBy = (pattern) => {
    const hits = [];
    let m;
    const re = new RegExp(pattern, 'gi');
    while ((m = re.exec(text)) !== null) hits.push({ idx: m.index, after: m.index + m[0].length });
    return hits;
  };
  return { isTocRow, isBackRef, findBy };
}

// Trim to the last sentence boundary inside maxChars, marking the cut.
function trimToSentence(body, minChars, maxChars) {
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'));
  return (lastStop > minChars ? cut.slice(0, lastStop + 1) : cut) + ' [...]';
}

function extractItem1(html) {
  const text = htmlToText(html);
  const { isTocRow, isBackRef, findBy } = sectionFinders(text);

  let start = -1;
  // Filers separate the item number from "Business" with ".", ":" or "-"
  // (Apple: "Item 1. Business", Shopify: "Item 1: Business").
  for (const heading of ['Item\\s*1[.:\\u2014-]\\s*Business', 'Item\\s*1[.:\\u2014-]']) {
    const body = findBy(heading).filter((h) => !isTocRow(h.after) && !isBackRef(h.idx));
    if (body.length) {
      start = body[body.length - 1].idx;
      break;
    }
  }
  if (start < 0) {
    // No body heading at all (Qualcomm style): Item 1 content starts right
    // after the TOC. Its last row is Item 15/16; page footers may follow.
    const tocRows = findBy('Item\\s*1[56][A-C]?[.:\\u2014-]').filter((h) => h.idx < text.length * 0.2);
    if (tocRows.length) {
      start = tocRows[tocRows.length - 1].after;
      const lead = text.slice(start).match(/^[\s.:]*\d{0,3}\s*/);
      if (lead) start += lead[0].length;
    }
  }
  if (start < 0) return null;

  const rest = text.slice(start);
  const endMatch = rest.slice(10).match(/Item\s*1A\b|Item\s*2[.:\u2014-]\s*Properties/i);
  let body = endMatch ? rest.slice(0, 10 + endMatch.index) : rest.slice(0, ITEM1_MAX_CHARS * 2);
  body = body.replace(/^Item\s*1[.:\u2014-]\s*Business[\s.,:;-]*/i, '').trim();
  if (body.length < ITEM1_MIN_CHARS) return null;
  return trimToSentence(body, ITEM1_MIN_CHARS, ITEM1_MAX_CHARS);
}

// Item 7 (MD&A) opens with an overview that states the revenue model in
// plain terms ("We derive substantially all of our revenue from subscription
// fees...") — the income-channel sentences that Item 1's marketing prose
// often lacks. The overview sits at the head of the section, so the first
// ITEM7_MAX_CHARS capture most of what matters.
const ITEM7_MAX_CHARS = 10000;
const ITEM7_MIN_CHARS = 300;
// Coarse income-word density used to choose WHERE inside (possibly huge)
// Item 7 to read — some filers put 50k+ of accounting boilerplate before the
// revenue-model discussion.
const ITEM7_DENSITY_RE = /\b(revenue|revenues|subscri\w+|sales?|licen[cs]\w+|fees?|derives?|earns?|segment)\b/gi;

function extractItem7(html) {
  const text = htmlToText(html);
  const { isTocRow, isBackRef, findBy } = sectionFinders(text);
  const hits = findBy('Item\\s*7[.:\\u2014-]\\s*(Management.{0,3}s?\\s+Discussion|MD&A)')
    .filter((h) => !isTocRow(h.after) && !isBackRef(h.idx));
  if (!hits.length) return null;
  const rest = text.slice(hits[hits.length - 1].after);
  const endMatch = rest.slice(10).match(/Item\s*7A\b|Item\s*8[.:\u2014-]/i);
  const section = (endMatch ? rest.slice(0, 10 + endMatch.index) : rest).trim();
  if (section.length < ITEM7_MIN_CHARS) return null;

  // Slide a max-size window and keep the densest in income vocabulary; step
  // half a window so a cluster straddling a boundary isn't missed.
  if (section.length > ITEM7_MAX_CHARS) {
    let best = { score: -1, from: 0 };
    const step = Math.floor(ITEM7_MAX_CHARS / 2);
    for (let from = 0; from + ITEM7_MIN_CHARS <= section.length; from += step) {
      const win = section.slice(from, from + ITEM7_MAX_CHARS);
      const score = (win.match(ITEM7_DENSITY_RE) || []).length;
      if (score > best.score) best = { score, from };
      if (from + ITEM7_MAX_CHARS >= section.length) break;
    }
    const win = section.slice(best.from, best.from + ITEM7_MAX_CHARS);
    return trimToSentence(win, ITEM7_MIN_CHARS, ITEM7_MAX_CHARS);
  }
  return trimToSentence(section, ITEM7_MIN_CHARS, ITEM7_MAX_CHARS);
}

async function fetchEdgarDocument(ticker) {
  const map = await getEdgarTickerMap();
  // BRK-B stays BRK-B; ASML.AS → ASML (EDGAR map is US-only anyway); BF.B → BF-B
  const cik = map[ticker] || map[ticker.split('.')[0]] || map[ticker.replace('.', '-')];
  if (!cik) return null;
  const meta = await getLatest10K(ticker, cik);
  if (!meta) return null;
  const docUrl = meta.docUrl || await getPrimaryDocUrl(meta.dirUrl);
  if (!docUrl) return null;
  const res = await fetch(docUrl, {
    headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip' },
  });
  if (!res.ok) throw new Error(`10-K ${ticker}: HTTP ${res.status}`);
  return { text: await res.text(), meta };
}

async function fetchEdgarDescription(ticker) {
  const doc = await fetchEdgarDocument(ticker);
  if (!doc) return null;
  // Item 1 describes the business; Item 7 (MD&A) states the revenue model.
  // Both feed the merge — dedup removes the overlap, the income filter keeps
  // the money sentences from either section.
  const item1 = extractItem1(doc.text);
  const item7 = extractItem7(doc.text);
  const summary = [item1, item7].filter(Boolean).join(' ');
  if (!summary) return null;
  return { summary, industry: doc.meta.sicDescription, marketCap: 0, sector: '' };
}

// --- Yahoo -------------------------------------------------------------------------

let yahooAuth = null;
let yahooAuthAt = 0;

async function getYahooAuth() {
  if (yahooAuth && Date.now() - yahooAuthAt < 10 * 60e3) return yahooAuth;
  let cookie = '';
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': BROWSER_UA } });
    cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  } catch (_) { /* fc.yahoo.com 404s after setting the cookie — expected */ }
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie },
  });
  if (!r2.ok) throw new Error(`crumb fetch failed: ${r2.status}`);
  yahooAuth = { cookie, crumb: await r2.text() };
  yahooAuthAt = Date.now();
  return yahooAuth;
}

async function fetchYahooDescription(ticker, { createYF }) {
  if (createYF) {
    const yf = createYF();
    const profile = await yf.quoteSummary(ticker, { modules: ['assetProfile', 'summaryDetail'] });
    const ap = profile.assetProfile || {};
    return {
      summary: ap.longBusinessSummary || '',
      sector: ap.sector || '',
      industry: ap.industry || '',
      marketCap: rawNum(profile.summaryDetail && profile.summaryDetail.marketCap),
    };
  }
  // Manual cookie+crumb path (yahoo-finance2's own crumb fetch 429s from this host).
  const auth = await getYahooAuth();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
    `?modules=assetProfile%2CsummaryDetail&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': auth.cookie } });
  if (!res.ok) throw new Error(`quoteSummary ${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.quoteSummary?.result?.[0] || {};
  const ap = r.assetProfile || {};
  return {
    summary: ap.longBusinessSummary || '',
    sector: ap.sector || '',
    industry: ap.industry || '',
    marketCap: rawNum(r.summaryDetail && r.summaryDetail.marketCap),
  };
}

// --- Wikidata / Wikipedia ----------------------------------------------------------

async function fetchWikiDescription(ticker) {
  const suffix = (ticker.match(/\.[A-Z]{1,2}$/) || [''])[0].toLowerCase();
  const base = ticker.split('.')[0];
  // No SERVICE wikibase:labels — this endpoint rejects it with HTTP 500;
  // plain OPTIONAL rdfs:label patterns return the same strings.
  const sparql = `SELECT ?item ?itemLabel ?itemDesc ?article ?exLabel WHERE {
  ?item p:P414 ?st .
  ?st ps:P414 ?ex ; pq:P249 "${base}" .
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }
  OPTIONAL { ?item schema:description ?itemDesc . FILTER(LANG(?itemDesc) = "en") }
  OPTIONAL { ?ex rdfs:label ?exLabel . FILTER(LANG(?exLabel) = "en") }
} LIMIT 20`;
  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
    headers: { 'User-Agent': EDGAR_UA, 'Accept': 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`wikidata ${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const rows = (j.results?.bindings || []).map((b) => ({
    label: b.itemLabel?.value || '',
    desc: b.itemDesc?.value || '',
    title: b.article?.value ? decodeURIComponent(b.article.value.split('/').pop()) : '',
    exchange: b.exLabel?.value || '',
  }));
  if (!rows.length) return null;

  const hints = SUFFIX_EXCHANGE_HINTS[suffix] || [];
  const withTitle = rows.filter((r) => r.title);
  const pick = (hints.length && withTitle.find((r) => hints.some((h) => r.exchange.toLowerCase().includes(h)))) ||
    withTitle[0] || null;
  if (pick) {
    const wres = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pick.title)}`, {
      headers: { 'User-Agent': EDGAR_UA },
    });
    if (wres.ok) {
      const wj = await wres.json();
      if (wj.extract && wj.extract.length >= 100) {
        return { summary: wj.extract, wikiTitle: pick.title, sector: '', industry: '', marketCap: 0 };
      }
    }
  }
  // No usable article: Wikidata's one-liner is thin but better than nothing.
  const labeled = rows.find((r) => r.label && r.desc);
  if (labeled) {
    return { summary: `${labeled.label} — ${labeled.desc}.`, sector: '', industry: '', marketCap: 0 };
  }
  return null;
}

// --- Chain -------------------------------------------------------------------------

const EMPTY = { summary: '', sector: '', industry: '', marketCap: 0, source: '', sources: [] };

// --- Multi-source merge -----------------------------------------------------------

// Cosine above which two sentences count as the same meaning. EmbeddingGemma
// paraphrases of the same fact ("engages in the design of" vs "designs and
// sells") land in the 0.80-0.95 band; distinct facts sit well below.
const DEDUP_SIMILARITY = 0.80;

// --- Income-channel relevance filter ----------------------------------------------
// After dedup, sentences must mention how the company makes money to stay.
// Income-channel prose has a strong closed vocabulary (revenue, subscription,
// licensing, fees, sells, derives...) which filing trivia ("was formerly
// known as..."), exchange listings and marketing voice ("delivers solutions
// that help...") never use. An embedding-anchor version of this filter was
// tried and rejected: every corporate sentence scores 0.72-0.80 against both
// income and marketing anchors — the space separates topic, not the
// "describes how money is earned" relation.
const INCOME_WORD_RE = /\b(revenue|revenues|subscri\w*|licen[cs]\w*|royalt\w*|fees?|sales?|sell[s]?|sold|selling|earn\w*|income|monetiz\w*|commission\w*|take[- ]rate|pricing|payers?|lease[ds]?|reward\w*|segments?|contract\w*|manufactur\w+ (?:and|&) (?:markets?|sells)|produces? and sells|derives?|generates? (?:revenue|income|sales|fee))\b/i;
// Tax-provision sentences match INCOME_WORD_RE via "income" but are
// accounting mechanics, not income channels — unless they also carry a
// revenue word, they drop.
const TAX_RE = /\b(income tax\w*|tax provision|provision for .{0,20}income tax\w*|payroll tax\w*)\b/i;
const STRONG_INCOME_RE = /\b(revenue|revenues|subscri\w*|licen[cs]\w*|royalt\w*|fees?|sales?|sell[s]?|derives?|segment)\b/i;

function isIncomeSentence(s) {
  if (!INCOME_WORD_RE.test(s)) return false;
  if (TAX_RE.test(s) && !STRONG_INCOME_RE.test(s)) return false;
  return true;
}

// Cap on the merged description — the screening row renders it in a fixed
// scroll box, and EDGAR alone can run to the full ITEM1_MAX_CHARS.
const MERGED_MAX_CHARS = 2600;

// EDGAR Item 1 boilerplate that carries no company-specific meaning; dropped
// before the embedding pass so it can't pad the merged description.
const BOILERPLATE_RE = [
  /forward[- ]looking/i,
  /\bsafe harbor\b/i,
  /^item\s+\d/i,
  /\bform\s+10-?k\b/i,
  /\bannual report\b/i,
  /\bsecurities (and|&) exchange commission\b/i,
  /\bfiled with the\b/i,
  /\bregistered (agent|office)s?\b/i,
  /\bprincipal executive offices?\b/i,
  /\bcode of (regulations|bylaws)\b/i,
  /\brestate[dr] (certificate|memorandum|articles)/i,
  /\bstate of delaware\b/i,
  /\birs employer identification/i,
];

// MD&A variance talk reads as income vocabulary to the keyword filter
// ("revenue increased by $48.5 million", "cost of revenues as a percentage
// of revenue") but says nothing about how money is earned. Any sentence
// carrying a dollar amount drops; percentages only drop when paired with
// period-over-period/hedging language.
const DOLLAR_RE = /\$\s?\d|\b\d[\d,.]*\s*(million|billion|trillion)\b/i;
const PERCENT_RE = /\d[\d,.]*\s*%/;
const VARIANCE_RE = /\b(increas\w*|decreas\w*|declin\w*|grew|rose|fell|drop\w*|compared (to|with)|prior (year|quarter)|year ended|fluctuat\w*|anticipat\w*|expect\w*|driven by|margin)\b/i;
// Corporate trivia with no income-channel content.
const TRIVIA_RE = /\b(formerly (known as|called)|Fortune \d|S&P \d|\branked \d|was (incorporated|founded)|headquartered|changed its name|initial public offering)\b/i;
// Accounting-caption fragments ("Operating Expenses • Sales and marketing
// expenses.") and period-variance explanations ("The decrease was mainly due
// to...") match income vocabulary but describe bookkeeping, not the business.
const CAPTION_RE = /^[\w&,•\s]{5,60}(revenues?|income|expenses?)\b[.,]?\s*$/i;
const CAPTION_START_RE = /^(cost of revenues?|(sales and marketing|research and development|general and administrative|total operating|operating) expenses?|interest expense, net|other income, net|deferred revenue)/i;
const VARIANCE_START_RE = /^(the |total |an? )?(increase|decreas\w*|reduc\w*|declin\w*|change)s? (was|is|were|are|mainly|primarily|driven|due|attributable|reflect)/i;

function isNoiseSentence(raw) {
  const s = raw.replace(/^[^\w(]+/, ''); // leading bullets (◦, •) before anchors
  if (TRIVIA_RE.test(s)) return true;
  if (DOLLAR_RE.test(s)) return true;
  if (PERCENT_RE.test(s) && VARIANCE_RE.test(s)) return true;
  if (CAPTION_RE.test(s) || CAPTION_START_RE.test(s) || VARIANCE_START_RE.test(s)) return true;
  return false;
}

// Abbreviation dots that must not end a sentence ("Teradyne, Inc. was
// founded..." would otherwise split into "…Inc." + "was founded…").
const ABBR_DOT_RE = /\b(Inc|Ltd|Corp|Co|plc|S\.p\.A|J\.P|U\.S|Mr|Mrs|Ms|Dr|vs|approx|No|St|Ave)\./g;

function splitSentences(text) {
  const t = String(text)
    .replace(/\s+/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1\u0002$2') // decimal points are not sentence ends
    .replace(ABBR_DOT_RE, (m) => m.replace(/\./g, '\u0001'));
  return t.split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\u0001/g, '.').replace(/\u0002/g, '.').trim())
    .filter((s) => s.length >= 30 && s.length <= 500);
}

/**
 * Merge source texts into one deduplicated, income-channel-filtered
 * description.
 * @param {Array<[string, string]>} namedTexts - [sourceName, text] in
 *   priority order; the first source is the backbone.
 * @returns {Promise<{summary: string, sources: string[], kept: number,
 *                    dropped: number, filtered: number}>}
 */
async function mergeSummaries(namedTexts, ticker = '') {
  const perSource = namedTexts.map(([name, text]) => ({
    name,
    sentences: splitSentences(text).filter(
      (s) => !BOILERPLATE_RE.some((re) => re.test(s)) && !isNoiseSentence(s)
    ),
  }));
  const flat = [];
  for (const p of perSource) for (const s of p.sentences) flat.push({ name: p.name, text: s });

  const embeddings = await embeddingService.embedBatch(
    flat.map((x) => `title: company description | text: ${x.text}`),
    { showProgress: false }
  );

  const kept = [];
  const keptEmb = [];
  let dropped = 0;
  for (let i = 0; i < flat.length; i++) {
    const e = Float64Array.from(embeddings[i]);
    let dup = false;
    for (const ke of keptEmb) {
      let d = 0;
      for (let k = 0; k < e.length; k++) d += e[k] * ke[k]; // normalized → dot == cosine
      if (d >= DEDUP_SIMILARITY) { dup = true; break; }
    }
    if (dup) { dropped++; continue; }
    kept.push(flat[i]);
    keptEmb.push(e);
  }

  // Income-channel relevance filter on the deduped survivors. If it keeps
  // too little (a description with no income vocabulary anywhere), fall back
  // to the unfiltered deduped text rather than an empty description.
  const debug = !!process.env.DESC_DEBUG;
  const pass = kept.map((k, i) => {
    const ok = isIncomeSentence(k.text);
    if (debug) console.log(`[desc:${k.name}] ${ok ? 'KEEP' : 'drop'} :: ${k.text.slice(0, 90)}`);
    return ok;
  });
  let final = kept.filter((_, i) => pass[i]);
  let filtered = kept.length - final.length;
  const joinLen = (arr) => arr.reduce((s, k) => s + k.text.length + 1, 0);
  if (final.length < 2 || joinLen(final) < 200) {
    // No income vocabulary anywhere in the sources — cap the fallback to the
    // leading sentences rather than dumping the (marketing-heavy) full text.
    final = kept.slice(0, 4);
    filtered = 0;
  }

  // LLM condensation of the deduped sentences — replaces the extractive
  // summary (and its fallback, computed below) when it succeeds.
  if (ticker) {
    const condensed = await condenseWithLlm(ticker, kept);
    if (condensed) {
      return {
        summary: condensed.text,
        sources: condensed.names,
        kept: final.length,
        dropped,
        filtered,
        condensed: true,
      };
    }
  }

  let summary = '';
  for (const k of final) {
    if (summary.length + k.text.length + 1 > MERGED_MAX_CHARS) break;
    summary = summary ? summary + ' ' + k.text : k.text;
  }
  return {
    summary,
    sources: [...new Set(final.map((k) => k.name))],
    kept: final.length,
    dropped,
    filtered,
  };
}

// --- LLM condensation ---------------------------------------------------------------

// The lexical filter can only keep or drop whole sentences — it can't name
// the products or subscription types the sources never state in income
// vocabulary, and extracts like "deferred revenue represents amounts
// received..." still slip through. When the local LLM backend
// (LabInsightsService — llama.cpp preferred, CPU fallback) is available, the
// deduped sentences are condensed into one income-channel paragraph instead.
// Disable with DESCRIPTION_LLM=0 (the lexical path remains).
const LLM_ENABLED = process.env.DESCRIPTION_LLM !== '0';
const CONDENSE_INPUT_MAX_CHARS = 6000;
const CONDENSE_SYSTEM = [
  'You write one-paragraph income-channel summaries of companies for a stock',
  'screening tool. The user supplies sentences from the company\'s SEC filings',
  'and web sources.',
  'Explain how the company makes money: name the concrete products or services',
  'sold and, for each, what customers pay for (product sales, subscriptions,',
  'licensing, transaction fees, advertising, leases, government contracts,',
  'etc.). Be specific: give actual product names and subscription or plan',
  'types when the sources state them.',
  'Hard rules: no dollar amounts, percentages or other figures; no history,',
  'rankings, headquarters or corporate trivia; no marketing adjectives; use',
  'only facts present in the supplied sentences; one paragraph of at most',
  '120 words, plain text, no lists.',
].join(' ');

let llmService = null; // lazily created singleton; false once known unavailable
function getLlm() {
  if (!LLM_ENABLED) return null;
  if (llmService === null) {
    try {
      llmService = new (require('./labInsights'))();
    } catch (err) {
      console.warn(`[desc] LLM backend unavailable: ${err?.message || err}`);
      llmService = false;
    }
  }
  return llmService || null;
}

async function condenseWithLlm(ticker, items) {
  const llm = getLlm();
  if (!llm || items.length < 2) return null;
  const lines = [];
  const names = new Set();
  let len = 0;
  for (const it of items) {
    if (len + it.text.length > CONDENSE_INPUT_MAX_CHARS) break;
    lines.push(`- ${it.text}`);
    names.add(it.name);
    len += it.text.length;
  }
  if (lines.length < 2) return null;
  let out;
  try {
    out = await llm.runPrompt(
      CONDENSE_SYSTEM,
      `Company: ${ticker}\n\nSource sentences:\n${lines.join('\n')}`,
      340
    );
  } catch (err) {
    console.warn(`[desc] ${ticker}: LLM condensation failed (${err?.message || err})`);
    return null;
  }
  if (!out) return null;
  // Small fallback models sometimes emit markdown despite the prompt.
  out = out
    .replace(/\*\*/g, '')
    .replace(/\s*[-\u2022]\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A model that ignored the rules (figures, runaway length) is worse than
  // the lexical fallback — reject rather than clean.
  if (out.length < 150 || out.length > 1600 || /\$\s?\d/.test(out)) {
    console.warn(`[desc] ${ticker}: LLM condensation rejected (bad output shape)`);
    return null;
  }
  return { text: out, names: [...names] };
}

/**
 * Fetch a company description through the source chain, using the shared
 * ci/description-cache.json in front of it. The text (7-day TTL) and the
 * Yahoo metadata (1-day TTL) are refreshed independently, so a day-old
 * marketCap never re-downloads a 10-K.
 *
 * @param {string} ticker - Yahoo-style ticker (AAPL, ASML.AS, ...)
 * @param {Object} [opts]
 * @param {Function} [opts.createYF] - Factory for a yahoo-finance2 instance
 *   (preferred Yahoo path for the Electron app). Without it the module does
 *   the manual cookie+crumb quoteSummary call.
 * @param {boolean} [opts.needYahooMeta=true] - Also refresh marketCap via
 *   Yahoo when the cached copy is older than a day.
 * @returns {Promise<{summary: string, sector: string, industry: string,
 *                    marketCap: number, source: string, sources: string[], wikiTitle?: string}>}
 */
async function getDescription(ticker, opts = {}) {
  const t = String(ticker).toUpperCase();
  const { createYF = null, needYahooMeta = true } = opts;
  const cache = await loadCache();
  const cached = cache[t];
  const age = (at) => (at ? Date.now() - new Date(at).getTime() : Infinity);
  const summaryFresh = !!(cached && cached.summary && age(cached.fetchedAt) <= SUMMARY_TTL_MS);
  const metaFresh = !!(cached && cached.marketCap > 0 && age(cached.marketCapAt) <= MARKETCAP_TTL_MS);

  if (summaryFresh && (!needYahooMeta || metaFresh)) {
    return { ...EMPTY, ...cached };
  }

  const now = new Date().toISOString();
  let entry;
  if (summaryFresh) {
    entry = { ...cached }; // only metadata needs refreshing — skip the chain
  } else {
    const isUS = !/\.[A-Z]{1,2}$/.test(t);
    // Dot-suffixed tickers are usually non-US listings (EDGAR has no filings
    // for them), but US class shares (BF.B, BRK.B) look identical — so EDGAR
    // stays in their chain as a last step after Yahoo and Wikipedia.
    // All sources are fetched (in parallel) and merged; the order below is
    // merge priority — the first source is the backbone.
    const sources = isUS
      ? [['edgar', () => fetchEdgarDescription(t)], ['yahoo', () => fetchYahooDescription(t, { createYF })], ['wiki', () => fetchWikiDescription(t)]]
      : [['yahoo', () => fetchYahooDescription(t, { createYF })], ['wiki', () => fetchWikiDescription(t)], ['edgar', () => fetchEdgarDescription(t)]];

    const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));
    const usable = [];
    const errors = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value && res.value.summary && res.value.summary.trim().length >= 100) {
        usable.push({ name: sources[i][0], r: res.value });
      } else if (res.status === 'rejected') {
        errors.push(`${sources[i][0]}: ${res.reason?.message || res.reason}`);
      }
    });
    if (!usable.length) {
      if (errors.length) console.warn(`[desc] ${t}: all sources failed (${errors.join('; ')})`);
      return { ...EMPTY };
    }

    const primary = usable[0];
    // The merge runs even for a single usable source — dedup + boilerplate +
    // income-channel filtering apply regardless of how many sources exist.
    let merged = null;
    try {
      merged = await mergeSummaries(usable.map((u) => [u.name, u.r.summary.trim()]), t);
      console.log(`[desc] ${t} ← ${merged.sources.join('+')} (kept ${merged.kept}, dropped ${merged.dropped} dup, filtered ${merged.filtered} off-topic${merged.condensed ? ', LLM-condensed' : ''})`);
    } catch (mergeErr) {
      console.warn(`[desc] ${t}: merge failed (${mergeErr.message}) — using ${primary.name} raw`);
    }
    const summary = merged ? merged.summary : primary.r.summary.trim();
    const mergedFrom = merged ? merged.sources : [primary.name];

    entry = {
      summary,
      sector: usable.map((u) => u.r.sector).find(Boolean) || '',
      industry: usable.map((u) => u.r.industry).find(Boolean) || '',
      marketCap: usable.map((u) => u.r.marketCap).find((m) => typeof m === 'number' && m > 0) || 0,
      marketCapAt: now,
      source: primary.name,
      sources: mergedFrom,
      condensed: !!(merged && merged.condensed),
      fetchedAt: now,
    };
    const withTitle = usable.find((u) => u.r.wikiTitle);
    if (withTitle) entry.wikiTitle = withTitle.r.wikiTitle;
  }

  // Yahoo is the only source for live marketCap/sector/industry — fill or
  // refresh them from one quoteSummary, whatever won the text.
  if (needYahooMeta && !(entry.marketCap > 0 && age(entry.marketCapAt) <= MARKETCAP_TTL_MS)) {
    try {
      const y = await fetchYahooDescription(t, { createYF });
      entry = {
        ...entry,
        marketCap: y.marketCap || entry.marketCap || 0,
        sector: entry.sector || y.sector || '',
        industry: entry.industry || y.industry || '',
        marketCapAt: now,
      };
    } catch (_) { /* metadata is optional */ }
  }

  cache[t] = entry;
  await saveCache(cache);
  return { ...entry };
}

/**
 * Prefetch descriptions for many tickers (theme radar warm-up).
 * @returns {Promise<Object|null>[]} per-ticker getDescription results (null on error)
 */
async function warmDescriptions(tickers, { concurrency = 2, createYF = null, needYahooMeta = false } = {}) {
  const out = new Array(tickers.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tickers.length) }, async () => {
      while (next < tickers.length) {
        const i = next++;
        try {
          out[i] = await getDescription(tickers[i], { createYF, needYahooMeta });
        } catch (err) {
          console.warn(`  description fetch failed for ${tickers[i]}: ${err?.message || String(err)}`);
          out[i] = null;
        }
      }
    })
  );
  return out;
}

module.exports = { getDescription, warmDescriptions, fetchEdgarDocument, extractItem1, extractItem7, mergeSummaries };
