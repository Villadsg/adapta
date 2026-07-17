// Renders screening results: a sortable table plus expandable per-ticker detail
// cards with a Chart.js price chart and options metrics.

import Chart from 'chart.js/auto';
import type { ScreenResult } from '../screening';

interface Row {
  ticker: string;
  price: number | null;
  events: number;
  classification: string;
  pcr: number | null;
  atmIV: number | null;
  sentiment: string;
  hold: number | null;
  result: ScreenResult;
}

const CLASS_COLORS: Record<string, string> = {
  surprising_positive: '#3fb950',
  anticipated_positive: '#2a7f47',
  surprising_negative: '#e5534b',
  anticipated_negative: '#a63a34',
  unknown: '#8b93a1',
};

const fmt = {
  price: (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`),
  ratio: (v: number | null) => (v == null ? '—' : v.toFixed(2)),
  pct: (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`),
  hold: (v: number | null) => (v == null ? '—' : `${v}d`),
};

function toRow(r: ScreenResult): Row {
  const bars = r.stock?.data ?? [];
  const lastClose = bars.length ? bars[bars.length - 1].close : null;
  const recentEvent = r.stock?.events?.[0];
  const classification = recentEvent?.classification ?? 'unknown';
  const hold = r.empiricalHold?.classifications?.[classification]?.holdDays ?? null;
  const s = r.options?.summary;
  return {
    ticker: r.ticker,
    price: r.options?.currentPrice ?? lastClose,
    events: r.stock?.stats?.totalEvents ?? r.savedEvents ?? 0,
    classification,
    pcr: s?.avgPutCallRatio ?? null,
    atmIV: s?.avgAtmIV ?? null,
    sentiment: s?.sentiment ?? '—',
    hold,
    result: r,
  };
}

const charts: Chart[] = [];

export function renderResults(results: ScreenResult[]): void {
  charts.forEach((c) => c.destroy());
  charts.length = 0;

  const panel = document.getElementById('results-panel')!;
  const body = document.getElementById('results-body')!;
  panel.classList.remove('hidden');
  body.innerHTML = '';

  let rows = results.map(toRow);
  let sortKey: keyof Row = 'events';
  let sortDir = -1;

  const render = () => {
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey] as any;
      const bv = b[sortKey] as any;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });
    body.innerHTML = '';
    for (const row of rows) body.appendChild(dataRow(row));
  };

  document.querySelectorAll('#results-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = (th as HTMLElement).dataset.sort as keyof Row;
      if (key === sortKey) sortDir *= -1;
      else { sortKey = key; sortDir = -1; }
      render();
    });
  });

  render();
}

function dataRow(row: Row): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'data-row';
  const color = CLASS_COLORS[row.classification] ?? CLASS_COLORS.unknown;
  const shortClass = row.classification.replace(/_/g, ' ').replace('surprising', 'surp.').replace('anticipated', 'antic.');
  tr.innerHTML = `
    <td><strong>${row.ticker}</strong></td>
    <td>${fmt.price(row.price)}</td>
    <td>${row.events}</td>
    <td><span class="tag" style="background:${color}22;color:${color};">${shortClass}</span></td>
    <td>${fmt.ratio(row.pcr)}</td>
    <td>${fmt.pct(row.atmIV)}</td>
    <td>${row.sentiment}</td>
    <td>${fmt.hold(row.hold)}</td>`;

  let detail: HTMLTableRowElement | null = null;
  tr.addEventListener('click', () => {
    if (detail) {
      detail.remove();
      detail = null;
      return;
    }
    detail = detailRow(row);
    tr.after(detail);
    // Chart must be created after the canvas is in the DOM.
    requestAnimationFrame(() => drawPriceChart(row));
  });
  return tr;
}

function detailRow(row: Row): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'detail';
  const s = row.result.options?.summary;
  const opts = s
    ? `
      <div class="kv">
        <span class="k">Sentiment</span><span>${s.sentiment} (${(s.sentimentScore ?? 0).toFixed?.(2) ?? s.sentimentScore})</span>
        <span class="k">Put/Call</span><span>${fmt.ratio(s.avgPutCallRatio)}</span>
        <span class="k">ATM IV</span><span>${fmt.pct(s.avgAtmIV)}</span>
        <span class="k">Call / Put IV</span><span>${fmt.pct(s.avgCallIV)} / ${fmt.pct(s.avgPutIV)}</span>
        <span class="k">Expected move (nearest)</span><span>${s.nearestExpectedMovePct != null ? s.nearestExpectedMovePct.toFixed(1) + '%' : '—'}</span>
        <span class="k">Unusual volume</span><span>${s.totalUnusualVolume ?? '—'}</span>
        <span class="k">Conviction</span><span>${fmt.ratio(s.overallConvictionRatio)}</span>
      </div>`
    : '<div class="muted" style="margin:8px 0;">No options data.</div>';

  const eh = row.result.empiricalHold;
  const holdRows = eh?.classifications
    ? Object.entries(eh.classifications)
        .map(([cls, d]: any) => `<span class="k">${cls.replace(/_/g, ' ')}</span><span>${d.holdDays}d · peak ${d.peakReturn?.toFixed?.(1) ?? '—'}%</span>`)
        .join('')
    : '';
  const holdBlock = holdRows
    ? `<div class="kv">${holdRows}</div><div class="muted" style="font-size:11px;">from ${eh.totalEvents} events across ${eh.totalStocks} tickers</div>`
    : '<div class="muted" style="margin:8px 0;">Empirical hold: not enough accumulated history yet.</div>';

  tr.innerHTML = `
    <td colspan="8">
      <div style="padding:6px 2px;">
        <canvas id="chart-${row.ticker}" height="150"></canvas>
        <h2 style="margin-top:14px;">Options</h2>
        ${opts}
        <h2 style="margin-top:14px;">Empirical hold</h2>
        ${holdBlock}
      </div>
    </td>`;
  return tr;
}

function drawPriceChart(row: Row): void {
  const canvas = document.getElementById(`chart-${row.ticker}`) as HTMLCanvasElement | null;
  if (!canvas) return;
  const bars = row.result.stock?.data ?? [];
  const labels = bars.map((b: any) => new Date(b.date).toISOString().split('T')[0]);
  const closes = bars.map((b: any) => b.close);
  // Mark event bars with colored points.
  const pointColors = bars.map((b: any) =>
    b.isEarningsDate ? CLASS_COLORS[b.earningsClassification] ?? '#fff' : 'transparent',
  );
  const pointRadii = bars.map((b: any) => (b.isEarningsDate ? 4 : 0));

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${row.ticker} close`,
          data: closes,
          borderColor: '#4c8bf5',
          borderWidth: 1.5,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: pointRadii,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b93a1', maxTicksLimit: 6 }, grid: { color: '#1f2430' } },
        y: { ticks: { color: '#8b93a1' }, grid: { color: '#1f2430' } },
      },
    },
  });
  charts.push(chart);
}
