/**
 * Telegram notification helper for event scan alerts.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] No credentials configured — skipping notification');
    return null;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });

  const data = await res.json();

  if (!data.ok) {
    console.error('[Telegram] Send failed:', data.description);
  }

  return data;
}

function formatEventMessage(ticker, quote, eventSignal, optionsData) {
  const lines = [];

  lines.push(`<b>EVENT DETECTED: ${ticker}</b>`);
  lines.push('');
  lines.push('<b>Event Signal</b>');
  lines.push(
    `Gap: ${eventSignal.gap.toFixed(1)}% | Percentile: ${eventSignal.percentile.toFixed(1)}%`
  );
  if (eventSignal.classification) {
    lines.push(`Classification: ${eventSignal.classification}`);
  }
  lines.push(
    `Volume: ${(quote.volume / 1e6).toFixed(1)}M` +
      (eventSignal.avgEventVolume > 0
        ? ` (avg event: ${(eventSignal.avgEventVolume / 1e6).toFixed(1)}M)`
        : '')
  );

  if (optionsData && optionsData.eventAnticipation) {
    const ea = optionsData.eventAnticipation;
    lines.push('');
    lines.push(`<b>Options Anticipation: ${ea.totalScore}/${ea.maxScore}</b>`);
    const components = ea.components || {};
    const parts = Object.entries(components)
      .map(([k, v]) => `${k}: ${v.score}/${v.maxScore}`)
      .join(' | ');
    if (parts) lines.push(parts);
  }

  lines.push('');
  const prevClose = quote.previousClose;
  const price = quote.price;
  const pctChange = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(1) : '?';
  lines.push(
    `Price: $${prevClose?.toFixed(2) ?? '?'} → $${price?.toFixed(2) ?? '?'} (${pctChange > 0 ? '+' : ''}${pctChange}%)`
  );

  return lines.join('\n');
}

function formatScreeningMessage(hits) {
  if (!hits || hits.length === 0) return null;

  // Sort by percentile descending
  const sorted = [...hits].sort((a, b) => b.percentile - a.percentile);

  const lines = [];
  lines.push(`<b>SCREENING: ${sorted.length} event${sorted.length === 1 ? '' : 's'} found</b>`);
  lines.push('');

  const MAX_CHARS = 4096;
  let truncated = 0;

  for (const hit of sorted) {
    const entry = [
      `<b>${hit.ticker}</b> — ${hit.date}`,
      `Gap: ${hit.gap.toFixed(1)}% | Percentile: ${hit.percentile.toFixed(1)}%`,
      `Classification: ${hit.classification}`,
      `Volume: ${(hit.volume / 1e6).toFixed(1)}M`,
      '',
    ];

    const entryText = entry.join('\n');
    const currentText = lines.join('\n');

    if (currentText.length + entryText.length > MAX_CHARS - 50) {
      truncated = sorted.length - (sorted.indexOf(hit));
      break;
    }

    lines.push(entryText);
  }

  if (truncated > 0) {
    lines.push(`...and ${truncated} more`);
  }

  return lines.join('\n');
}

function formatDollar(n) {
  if (!n || !isFinite(n)) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatPct(n, digits = 1) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function formatSuperFavoriteMessage(ticker, events, optionsData) {
  const lines = [];
  lines.push(`<b>⭐ ${ticker}</b>`);
  lines.push('');

  const recent = (events || []).slice(0, 3);
  if (recent.length === 0) {
    lines.push('<b>Recent events:</b> none');
  } else {
    lines.push('<b>Recent events:</b>');
    for (const ev of recent) {
      const pct = ev.residualReturn != null ? (ev.residualReturn * 100) : null;
      const pctStr = pct == null ? '?' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      lines.push(`  • ${ev.dateStr} · ${ev.classification || '?'} · ${pctStr}`);
    }
  }

  lines.push('');
  lines.push('<b>Options</b>');

  if (!optionsData || !optionsData.summary) {
    lines.push('unavailable');
    return lines.join('\n');
  }

  const s = optionsData.summary;
  const expirations = optionsData.expirations || [];

  // Per-expiration ATM IVs aren't on the summary; average across expirations.
  const atmCallIVs = expirations.map((e) => e.atmCallIV).filter((v) => v && isFinite(v));
  const atmPutIVs = expirations.map((e) => e.atmPutIV).filter((v) => v && isFinite(v));
  const avgAtmCallIV = atmCallIVs.length
    ? atmCallIVs.reduce((a, b) => a + b, 0) / atmCallIVs.length
    : null;
  const avgAtmPutIV = atmPutIVs.length
    ? atmPutIVs.reduce((a, b) => a + b, 0) / atmPutIVs.length
    : null;

  const wCallIV = s.avgCallIV || null;
  const wPutIV = s.avgPutIV || null;

  const skewCall = wCallIV != null && avgAtmCallIV != null ? (wCallIV - avgAtmCallIV) : null;
  const skewPut = wPutIV != null && avgAtmPutIV != null ? (wPutIV - avgAtmPutIV) : null;

  lines.push(`Weighted OTM IV: call ${formatPct(wCallIV)} / put ${formatPct(wPutIV)}`);
  lines.push(
    `ATM→OTM skew: call ${skewCall == null ? 'n/a' : `${skewCall >= 0 ? '+' : ''}${(skewCall * 100).toFixed(1)}pp`}` +
      ` / put ${skewPut == null ? 'n/a' : `${skewPut >= 0 ? '+' : ''}${(skewPut * 100).toFixed(1)}pp`}`
  );
  const callDV = s.totalCallDollarVolume || 0;
  const putDV = s.totalPutDollarVolume || 0;
  const ratio = putDV > 0 ? (callDV / putDV).toFixed(2) : '∞';
  lines.push(`Dollar volume: call ${formatDollar(callDV)} / put ${formatDollar(putDV)} (C/P ${ratio})`);

  return lines.join('\n');
}

module.exports = {
  sendMessage,
  formatEventMessage,
  formatScreeningMessage,
  formatSuperFavoriteMessage,
};
