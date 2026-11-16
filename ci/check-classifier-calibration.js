#!/usr/bin/env node
/**
 * Calibration check for the news classifier (5-way categories + event tags).
 *
 * Runs a hand-labeled headline set through the ACTIVE embedding model and
 * reports accuracy, confusion pairs, top-two margin distribution (against
 * SIMILARITY_THRESHOLD) and event-tag fire rates. Compare models with:
 *
 *   node ci/check-classifier-calibration.js                       # active model
 *   EMBEDDING_MODEL=onnx-community/embeddinggemma-300m-ONNX \
 *     node ci/check-classifier-calibration.js                     # baseline
 */
const { classifyAndTagNews, classifyHeadlines } = require('../src/services/newsClassifier');
const embeddingService = require('../src/services/embeddings');

// Headlines are realistic paraphrases, not copies of the anchor texts.
// expected: technical | fear | win | macro_fear | macro_win | ambiguous
const CATEGORY_SET = [
  // ── technical ──
  { sector: 'saas',       expected: 'technical',  headline: 'Morgan Stanley raises price target on NOW to $1,150, keeps Overweight rating' },
  { sector: 'semis',      expected: 'technical',  headline: 'AMD reclaims 50-day moving average as bullish momentum builds' },
  { sector: 'biotech',    expected: 'technical',  headline: 'BofA initiates coverage of ALNY at Buy, sees roughly 30% upside' },
  { sector: 'consumer',   expected: 'technical',  headline: 'LULU looks stretched after 25% rally, RSI flashing overbought' },
  { sector: 'defense',    expected: 'technical',  headline: 'Options activity in KTOS heats up as implied volatility jumps ahead of earnings' },
  { sector: 'fintech',    expected: 'technical',  headline: 'SOFI consolidates near support ahead of next week’s print' },
  { sector: 'semis',      expected: 'technical',  headline: 'Short interest in WOLF declines for the third straight month' },
  { sector: 'general',    expected: 'technical',  headline: 'Sector rotation favors high-beta growth names this month, strategists say' },
  // ── fear (company-specific negative) ──
  { sector: 'biotech',    expected: 'fear',       headline: 'SRPT halts Duchenne trial after serious adverse event, stock plunges 40%' },
  { sector: 'semis',      expected: 'fear',       headline: 'MRVL cuts Q4 outlook on weak enterprise demand, shares slide 15%' },
  { sector: 'saas',       expected: 'fear',       headline: 'HUBS discloses churn spike in mid-market segment, new bookings miss' },
  { sector: 'defense',    expected: 'fear',       headline: 'Pentagon cancels next-generation drone competition RKLB was favored to win' },
  { sector: 'fintech',    expected: 'fear',       headline: 'UPST charge-offs surge to multi-year high as borrowers fall behind' },
  { sector: 'medtech',    expected: 'fear',       headline: 'Class action filed against ISRG alleging surgical device malfunction injuries' },
  { sector: 'consumer',   expected: 'fear',       headline: 'CMG same-store sales miss as traffic turns negative; full-year outlook cut' },
  { sector: 'cyber',      expected: 'fear',       headline: 'Zero-day in TENB platform exploited in the wild, shaking customer confidence' },
  { sector: 'energy',     expected: 'fear',       headline: 'RIG suspends dividend as offshore day rates collapse' },
  // ── win (company-specific positive) ──
  { sector: 'biotech',    expected: 'win',        headline: 'VKTX wins FDA approval for first-in-class oral obesity therapy' },
  { sector: 'semis',      expected: 'win',        headline: 'MPWR lands 800-volt power design win with major German automaker' },
  { sector: 'saas',       expected: 'win',        headline: 'DDOG closes largest deal in company history with top-ten retailer' },
  { sector: 'defense',    expected: 'win',        headline: 'AVAV awarded $380 million Army contract for Switchblade drone systems' },
  { sector: 'medtech',    expected: 'win',        headline: 'AXON posts record quarter as backlog tops $2 billion' },
  { sector: 'fintech',    expected: 'win',        headline: 'HOOD wins approval for national bank charter' },
  { sector: 'consumer',   expected: 'win',        headline: 'ELF viral TikTok product sells out, retailer reorders triple' },
  { sector: 'cleanenergy',expected: 'win',        headline: 'ENPH signs exclusive supply agreement with largest US homebuilder' },
  { sector: 'cyber',      expected: 'win',        headline: 'CRWD chosen as standard security platform by Fortune 100 consolidating vendors' },
  { sector: 'industrial', expected: 'win',        headline: 'POWL books record backlog on surging data center electrical demand' },
  // ── macro_fear (sector-wide headwind) ──
  { sector: 'biotech',    expected: 'macro_fear', headline: 'Senate committee advances drug pricing package; sector ETF slides' },
  { sector: 'semis',      expected: 'macro_fear', headline: 'Reported expansion of AI chip export curbs weighs across semiconductor names' },
  { sector: 'saas',       expected: 'macro_fear', headline: 'Enterprise software budgets face scrutiny as CIOs brace for spending cuts' },
  { sector: 'defense',    expected: 'macro_fear', headline: 'Continuing resolution threatens to delay procurement awards sector-wide' },
  { sector: 'consumer',   expected: 'macro_fear', headline: 'Consumer sentiment falls to two-year low, pressuring discretionary names' },
  { sector: 'cleanenergy',expected: 'macro_fear', headline: 'Treasury floats new solar tariff categories; developers warn of project delays' },
  // ── macro_win (sector-wide tailwind) ──
  { sector: 'semis',      expected: 'macro_win',  headline: 'CHIPS office opens third funding round for advanced packaging fabs' },
  { sector: 'defense',    expected: 'macro_win',  headline: 'NATO members pledge steeper defense spending commitments at summit' },
  { sector: 'saas',       expected: 'macro_win',  headline: 'AI infrastructure spending seen lifting software vendors through 2027' },
  { sector: 'biotech',    expected: 'macro_win',  headline: 'FDA finalizes faster approval pathway for rare disease therapies' },
  { sector: 'industrial', expected: 'macro_win',  headline: 'Grid modernization funding unlocks multi-year transformer demand' },
  { sector: 'cleanenergy',expected: 'macro_win',  headline: 'Battery storage economics cross inflection point, deployments accelerate' },
  // ── ambiguous (excluded from accuracy; observe only) ──
  { sector: 'general',    expected: 'ambiguous',  headline: 'Company to present at investor conference next week' },
  { sector: 'fintech',    expected: 'ambiguous',  headline: 'HOOD set to join S&P MidCap 400 index' },
  { sector: 'semis',      expected: 'ambiguous',  headline: 'AMD confirms keynote slot at CES' },
];

// Each item must fire its expected tag; real tickers keep SECTOR_MAP lookup
// consistent with the sector the tag applies to.
const TAG_SET = [
  { ticker: 'VKTX', sector: 'biotech',  expectedTag: 'fda_approval',      headline: 'FDA approves company\u2019s lead therapy, first in class for rare disease' },
  { ticker: 'SRPT', sector: 'biotech',  expectedTag: 'fda_rejection',     headline: 'Regulator issues complete response letter declining approval of drug application' },
  { ticker: 'IOVA', sector: 'biotech',  expectedTag: 'clinical_readout',  headline: 'Company to report pivotal phase three topline data next month' },
  { ticker: 'UPST', sector: 'saas',     expectedTag: 'guidance_cut',      headline: 'Management lowers full-year outlook citing weakening consumer demand' },
  { ticker: 'CAVA', sector: 'consumer', expectedTag: 'guidance_raise',    headline: 'Company lifts annual revenue outlook after strong same-store sales quarter' },
  { ticker: 'MRVL', sector: 'semis',    expectedTag: 'earnings_beat',     headline: 'Quarterly results top consensus with better than expected revenue and margin' },
  { ticker: 'HUBS', sector: 'saas',     expectedTag: 'earnings_miss',     headline: 'Company falls short of estimates as revenue growth disappoints' },
  { ticker: 'TOST', sector: 'saas',     expectedTag: 'mna_target',        headline: 'Report: private equity firm circling mid-cap software company, shares jump on takeover interest' },
  { ticker: 'AVAV', sector: 'defense',  expectedTag: 'contract_win',      headline: 'Company awarded major new contract from federal agency beating rivals' },
  { ticker: 'DDOG', sector: 'saas',     expectedTag: 'layoffs',           headline: 'Restructuring plan cuts twelve percent of workforce across divisions' },
  { ticker: 'AMD',  sector: 'semis',    expectedTag: 'buyback',           headline: 'Board authorizes new multi-billion dollar share repurchase program' },
  { ticker: 'TWST', sector: 'biotech',  expectedTag: 'dilution',          headline: 'Company prices secondary stock offering at a discount to raise capital' },
  { ticker: 'ELF',  sector: 'consumer', expectedTag: 'short_report',      headline: 'Short seller publishes report alleging accounting irregularities, stock drops sharply' },
  { ticker: 'LUNR', sector: 'defense',  expectedTag: 'insider_buying',    headline: 'CEO buys five million dollars of stock in open market, filing shows' },
];

function pct(n, d) { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(async () => {
  console.log(`Embedding model: ${embeddingService.getCacheKey()}\n`);

  // ── 5-way category classification ────────────────────────────────────
  const results = await classifyHeadlines(CATEGORY_SET);

  const scored = CATEGORY_SET.filter((it, i) => it.expected !== 'ambiguous' && results[i]);
  let correct = 0;
  const confusion = {};
  const marginsByExpected = {};
  for (let i = 0; i < CATEGORY_SET.length; i++) {
    const item = CATEGORY_SET[i];
    const r = results[i];
    if (!r) continue;
    if (item.expected === 'ambiguous') {
      console.log(`  [ambiguous] "${item.headline.slice(0, 60)}..." → ${r.category} (margin ${r.confidence.toFixed(3)})`);
      continue;
    }
    (marginsByExpected[item.expected] ||= []).push(r.confidence);
    if (r.category === item.expected) correct++;
    else {
      const key = `${item.expected} → ${r.category}`;
      confusion[key] = (confusion[key] || 0) + 1;
    }
  }

  console.log(`\n── Category accuracy: ${correct}/${scored.length} (${pct(correct, scored.length)}) ──`);
  const byCat = {};
  for (const it of scored) { byCat[it.expected] ??= { n: 0, ok: 0 }; byCat[it.expected].n++; }
  for (let i = 0; i < CATEGORY_SET.length; i++) {
    const it = CATEGORY_SET[i];
    if (it.expected === 'ambiguous' || !results[i]) continue;
    if (results[i].category === it.expected) byCat[it.expected].ok++;
  }
  for (const [cat, { n, ok }] of Object.entries(byCat)) {
    console.log(`  ${cat.padEnd(10)} ${ok}/${n} (${pct(ok, n)})  margin p50 ${(percentile([...marginsByExpected[cat]].sort((a, b) => a - b), 50) ?? 0).toFixed(3)}`);
  }
  const confusionEntries = Object.entries(confusion).sort((a, b) => b[1] - a[1]);
  if (confusionEntries.length) {
    console.log('  Top confusions:');
    for (const [pair, n] of confusionEntries.slice(0, 6)) console.log(`    ${pair}: ${n}`);
  }

  const allMargins = scored.map((it, idx) => results[CATEGORY_SET.indexOf(it)].confidence).sort((a, b) => a - b);
  console.log(`  Margin distribution (correct items): p10 ${percentile(allMargins, 10)?.toFixed(4)}  p50 ${percentile(allMargins, 50)?.toFixed(4)}  p90 ${percentile(allMargins, 90)?.toFixed(4)}`);

  // Threshold sweep: at threshold T an item is 'mixed' unless its top-two
  // margin ≥ T, so accuracy(T) counts items whose top-1 label is correct AND
  // whose margin clears T.
  const sweep = [0, 0.004, 0.006, 0.008, 0.010, 0.012, 0.015, 0.020, 0.025, 0.030];
  const top1Correct = [];
  for (let i = 0; i < CATEGORY_SET.length; i++) {
    const it = CATEGORY_SET[i];
    if (it.expected === 'ambiguous' || !results[i]) continue;
    const sorted = Object.entries(results[i])
      .filter(([k]) => k !== 'category' && k !== 'confidence')
      .sort((a, b) => b[1] - a[1]);
    if (sorted[0][0] === it.expected) top1Correct.push(results[i].confidence);
  }
  console.log(`  Top-1 correct (no mixed bucket): ${top1Correct.length}/${scored.length} (${pct(top1Correct.length, scored.length)})`);
  console.log('  Threshold sweep:');
  for (const t of sweep) {
    const ok = top1Correct.filter(m => m >= t).length;
    console.log(`    T=${t.toFixed(3)}  accuracy ${ok}/${scored.length} (${pct(ok, scored.length)})`);
  }

  // ── Event tags (end-to-end through the production entry point) ──────
  console.log('\n── Event tags ──');
  const allTickers = TAG_SET.map(t => ({ ticker: t.ticker, news: [{ headline: t.headline }] }));
  await classifyAndTagNews(allTickers);

  let fired = 0;
  for (let i = 0; i < TAG_SET.length; i++) {
    const t = TAG_SET[i];
    const entry = allTickers[i];
    const tags = entry.eventTags || [];
    const hit = tags.includes(t.expectedTag);
    if (hit) fired++;
    const ev = entry.eventTagEvidence?.[t.expectedTag];
    console.log(`  ${hit ? '✓' : '✗'} ${t.expectedTag.padEnd(16)} score ${ev ? ev.score.toFixed(3) : '  -  '} got [${tags.join(', ') || '-'}] "${t.headline.slice(0, 48)}..."`);
  }
  console.log(`  Fired: ${fired}/${TAG_SET.length} (${pct(fired, TAG_SET.length)})`);
})().catch(err => { console.error(err); process.exit(1); });
