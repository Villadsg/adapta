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

module.exports = { sendMessage, formatEventMessage };
