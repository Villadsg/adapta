/**
 * Per-run "similar company" ticker suggestion for the screening pipeline.
 *
 * Replaces the old random shuffle draw: instead of 5 random names from the
 * rebuild's top 100, each saved-list screening run appends exactly 1 ticker
 * chosen by semantic similarity — the company descriptions (see
 * src/services/companyDescriptions.js) of the current screenTickers are
 * embedded (local EmbeddingGemma, src/services/embeddings.js), their centroid
 * is compared against candidate descriptions from the rebuild's fullRanking,
 * and the most similar candidate joins the run in-memory (the results page
 * offers the "＋ Add" button to make it permanent).
 *
 * Candidate embeddings persist in ci/ticker-embedding-cache.json keyed by the
 * embedding model identity (same pattern as ci/embedding-anchor-cache.json),
 * so repeat runs only embed the current list's centroid side.
 */
const fs = require('fs');
const path = require('path');
const embeddingService = require('../src/services/embeddings');
const { getDescription, warmDescriptions } = require('../src/services/companyDescriptions');

const EMBED_CACHE_PATH = path.join(__dirname, 'ticker-embedding-cache.json');
// How deep into the rebuild's full ranking to fetch+embed descriptions. The
// ranking is quality-ordered, so the top of it is where a good suggestion
// lives; this bounds first-run cost (description fetch + local embedding).
const CANDIDATE_POOL_SIZE = 30;
// Recent suggestions excluded from the pool so consecutive runs rotate.
const RECENT_MEMORY = 5;

function loadEmbedCache() {
  try {
    const st = JSON.parse(fs.readFileSync(EMBED_CACHE_PATH, 'utf-8'));
    if (st.cacheKey === embeddingService.getCacheKey()) return st.vectors || {};
  } catch (_) { /* fresh cache */ }
  return {};
}

function saveEmbedCache(vectors) {
  const tmp = `${EMBED_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ cacheKey: embeddingService.getCacheKey(), vectors }, null, 2) + '\n');
  fs.renameSync(tmp, EMBED_CACHE_PATH);
}

function centroid(vectors) {
  const dim = vectors[0].length;
  const c = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) c[i] += v[i];
  const n = vectors.length;
  for (let i = 0; i < dim; i++) c[i] /= n;
  // Re-normalize: mean of unit vectors is not unit length, and the candidate
  // vectors are normalized, so cosine == dot only against a unit centroid.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += c[i] * c[i];
  norm = Math.sqrt(norm) || 1;
  return c.map((x) => x / norm);
}

/**
 * Pick the single most similar ticker to the current screening list.
 *
 * @param {Object} args
 * @param {string[]} args.currentTickers - the saved screenTickers list
 * @param {Object} args.config - ci/config.json contents (fixedTickers,
 *   excludeTickers, lastSuggested)
 * @param {Function} [args.createYF] - yahoo-finance2 factory (description
 *   refresh path)
 * @returns {Promise<{ticker: string, similarity: number, sector: string,
 *                    industry: string} | null>} null when nothing scoreable
 */
async function suggestSimilarTicker({ currentTickers, config, createYF = null }) {
  let fullRanking = [];
  let poolIsCacheFallback = false;
  try {
    const rev = JSON.parse(fs.readFileSync(path.join(__dirname, 'revise-results.json'), 'utf-8'));
    fullRanking = rev.fullRanking || rev.ranking || [];
  } catch (_) { /* fall back to the description cache below */ }
  if (!fullRanking.length) {
    // No rebuild ranking on disk yet — every ticker we already have a cached
    // description for is a fair candidate pool. The similarity ranking itself
    // provides the ordering, so this pool is not sliced to CANDIDATE_POOL_SIZE
    // (every entry already has a description on disk — embedding is the only
    // per-ticker cost, cached after first run).
    try {
      fullRanking = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'description-cache.json'), 'utf-8')));
      poolIsCacheFallback = true;
    } catch (_) {
      return null;
    }
  }

  const current = new Set(currentTickers || []);
  const skip = new Set([
    ...(config.fixedTickers || []),
    ...(config.excludeTickers || []),
    ...(config.lastSuggested || []),
  ]);
  const candidates = fullRanking
    .filter((t) => !current.has(t) && !skip.has(t))
    .slice(0, poolIsCacheFallback ? Infinity : CANDIDATE_POOL_SIZE);
  if (!candidates.length || !current.size) return null;

  // Current-list descriptions: cache-first, no Yahoo metadata refresh — the
  // summary TTL (7 days) covers daily runs and the text is all we embed.
  const currentDescs = await Promise.all(
    [...current].map((t) => getDescription(t, { createYF, needYahooMeta: false }).catch(() => null))
  );
  const currentTexts = [];
  for (const d of currentDescs) {
    if (d && d.summary && d.summary.trim().length >= 100) currentTexts.push(d.summary.trim());
  }
  if (!currentTexts.length) return null;

  // Candidate descriptions: warm the shared cache (skips fresh entries), then
  // embed whatever came back usable.
  await warmDescriptions(candidates, { concurrency: 8, createYF, needYahooMeta: false });
  const vectors = loadEmbedCache();
  const missing = candidates.filter((t) => !vectors[t]);
  const missingDescs = await Promise.all(
    missing.map((t) => getDescription(t, { createYF, needYahooMeta: false }).catch(() => null))
  );
  const toEmbed = [];
  for (let i = 0; i < missing.length; i++) {
    const d = missingDescs[i];
    if (d && d.summary && d.summary.trim().length >= 100) {
      toEmbed.push({ ticker: missing[i], text: d.summary.trim() });
    }
  }
  if (toEmbed.length) {
    const embs = await embeddingService.embedBatch(
      toEmbed.map((x) => x.text),
      { showProgress: false }
    );
    for (let i = 0; i < toEmbed.length; i++) vectors[toEmbed[i].ticker] = embs[i];
    saveEmbedCache(vectors);
  }

  const currentEmb = await embeddingService.embedBatch(currentTexts, { showProgress: false });
  const center = centroid(currentEmb);

  let best = null;
  for (const t of candidates) {
    const v = vectors[t];
    if (!v) continue; // no description available — skip, don't guess
    const score = embeddingService.cosineSimilarity(center, v);
    if (!best || score > best.similarity) best = { ticker: t, similarity: score };
  }
  if (!best) return null;

  const d = await getDescription(best.ticker, { createYF, needYahooMeta: false }).catch(() => null);
  return { ...best, sector: (d && d.sector) || '', industry: (d && d.industry) || '' };
}

module.exports = { suggestSimilarTicker };
