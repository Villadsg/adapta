#!/usr/bin/env node

/**
 * One-shot migration: ci/weighted-iv-history.json → iv_history_records (DuckDB).
 *
 * The JSON file was the last large regenerable artifact outside the database.
 * It is keyed {ticker: [record, ...]}; each record carries the pooled per-
 * expiration IV/DV blocks (exp1..exp3), per-strike calls/puts, and screening
 * metadata (sector, eventTags, dailyReturn). saveIVHistoryRecords stores the
 * record verbatim as JSON and lifts the queried scalars into columns, so the
 * shape every consumer reads is preserved exactly.
 *
 * Safe to re-run: rows are upserted on (ticker, date).
 *
 * Usage:
 *   node ci/migrate-iv-history-to-db.js --dry-run   # report only (default)
 *   node ci/migrate-iv-history-to-db.js --apply     # write to DuckDB
 */

const fs = require('fs');
const path = require('path');
const ArticleDatabase = require('../src/services/database');

const IV_PATH = path.join(__dirname, 'weighted-iv-history.json');
const DB_PATH = path.join(__dirname, '..', 'articles.db');

async function main() {
  const apply = process.argv.includes('--apply');

  if (!fs.existsSync(IV_PATH)) {
    console.log(`No ${path.basename(IV_PATH)} found — nothing to migrate.`);
    return;
  }

  console.log(`Reading ${path.basename(IV_PATH)} ...`);
  const history = JSON.parse(fs.readFileSync(IV_PATH, 'utf-8'));

  let tickers = 0;
  let records = 0;
  let withStrikes = 0;
  let withTags = 0;
  const bySource = {};

  for (const [, recs] of Object.entries(history)) {
    if (!Array.isArray(recs) || recs.length === 0) continue;
    tickers++;
    for (const r of recs) {
      if (!r || !r.date) continue;
      records++;
      const src = r.source || '(untagged)';
      bySource[src] = (bySource[src] || 0) + 1;
      if (Array.isArray(r.eventTags) && r.eventTags.length > 0) withTags++;
      for (const k of ['exp1', 'exp2', 'exp3']) {
        const e = r[k];
        if (e && (Array.isArray(e.calls) || Array.isArray(e.puts))) { withStrikes++; break; }
      }
    }
  }

  console.log(`  tickers:              ${tickers}`);
  console.log(`  records:              ${records}`);
  console.log(`  with per-strike data: ${withStrikes}`);
  console.log(`  with eventTags:       ${withTags}`);
  console.log('  by source:');
  for (const [src, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src.padEnd(20)} ${n}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to migrate.');
    return;
  }

  const database = new ArticleDatabase(DB_PATH);
  await database.initialize();
  try {
    const written = await database.saveIVHistoryRecords(history);
    console.log(`\nWrote ${written} records to iv_history_records.`);

    const back = await database.getIVHistoryRecords();
    const backTickers = Object.keys(back).length;
    const backRecords = Object.values(back).reduce((s, r) => s + r.length, 0);
    console.log(`Verify: ${backTickers} tickers / ${backRecords} records read back.`);
  } finally {
    await database.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
