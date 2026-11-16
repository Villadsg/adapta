// Get DOM elements
const urlBar = document.getElementById('url-bar');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const btnForecastEvent = document.getElementById('btn-forecast-event');
const forecastEventModal = document.getElementById('forecast-event-modal');
const forecastEventBody = document.getElementById('forecast-event-body');
const forecastTickerInput = document.getElementById('forecast-ticker-input');
const forecastRunBtn = document.getElementById('forecast-run-btn');
const forecastEventClose = document.getElementById('forecast-event-close');
const btnSettings = document.getElementById('btn-settings');
const tabsContainer = document.getElementById('tabs-container');
const btnNewTab = document.getElementById('btn-new-tab');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');
const toastContainer = document.getElementById('toast-container');

// Toast notification function
function showToast(title, message, type = 'success', duration = 3000, options = {}) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
  };

  const iconHtml = options.spinner
    ? '<span class="toast-spinner"></span>'
    : `<span class="toast-icon">${icons[type] || icons.info}</span>`;

  toast.innerHTML = `
    ${iconHtml}
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

  toastContainer.appendChild(toast);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  };

  if (duration > 0) setTimeout(dismiss, duration);

  return { toast, dismiss };
}

// Tab management
let currentTabId = null;
const tabs = new Map(); // tabId -> {element, title, url}

// Performance optimization: batch DOM updates
let pendingUpdates = new Map(); // tabId -> {url, title}
let rafScheduled = false;

// Create a new tab
async function createTab(url = '') {
  const tabId = await window.electronAPI.createTab(url);

  // Create tab element
  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.dataset.tabId = tabId;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = url || 'New Tab';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  tabElement.appendChild(titleSpan);
  tabElement.appendChild(closeBtn);
  tabElement.onclick = () => switchTab(tabId);

  tabsContainer.appendChild(tabElement);

  tabs.set(tabId, {
    element: tabElement,
    title: url || 'New Tab',
    url: url
  });

  switchTab(tabId);

  if (!url) {
    urlBar.focus();
    urlBar.select();
  }

  return tabId;
}

// Switch to a tab
async function switchTab(tabId) {
  if (currentTabId === tabId) return;

  // Update UI - remove active class from all tabs
  tabs.forEach((tab, id) => {
    tab.element.classList.toggle('active', id === tabId);
  });

  // Tell backend to switch tab
  await window.electronAPI.switchTab(tabId);
  currentTabId = tabId;

  // Update URL bar
  const tab = tabs.get(tabId);
  if (tab) {
    urlBar.value = tab.url || '';
  }
}

// Close a tab
async function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Remove from DOM
  tab.element.remove();
  tabs.delete(tabId);

  // Tell backend to close tab
  await window.electronAPI.closeTab(tabId);

  // If this was the active tab, switch to another
  if (currentTabId === tabId) {
    const remainingTabs = Array.from(tabs.keys());
    if (remainingTabs.length > 0) {
      await switchTab(remainingTabs[0]);
    } else {
      // No tabs left, create a new one
      await createTab();
    }
  }
}

// Update tab title
function updateTabTitle(tabId, title) {
  const tab = tabs.get(tabId);
  if (tab) {
    tab.title = title;
    const titleSpan = tab.element.querySelector('.tab-title');
    if (titleSpan) {
      titleSpan.textContent = title || 'New Tab';
    }
  }
}

// Update tab URL
function updateTabUrl(tabId, url) {
  const tab = tabs.get(tabId);
  if (tab) {
    tab.url = url;
    if (tabId === currentTabId) {
      urlBar.value = url;
    }
  }
}

// Navigation event handlers (fire-and-forget for faster response)
btnBack.addEventListener('click', () => {
  window.electronAPI.goBack();
});

btnForward.addEventListener('click', () => {
  window.electronAPI.goForward();
});

btnReload.addEventListener('click', () => {
  window.electronAPI.reload();
});

// Check if input looks like a URL
function isUrl(input) {
  // Has protocol
  if (/^https?:\/\//i.test(input)) return true;
  // Has common TLD pattern (e.g., example.com, site.org)
  if (/^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(\/|$)/.test(input)) return true;
  // localhost or IP address
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/.test(input)) return true;
  return false;
}

// URL bar navigation - optimistic update for snappy feel
urlBar.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const input = urlBar.value.trim();
    if (input) {
      let url;
      if (isUrl(input)) {
        // It's a URL - add protocol if missing
        url = input.startsWith('http://') || input.startsWith('https://')
          ? input
          : 'https://' + input;
      } else {
        // It's a search query - use Google
        url = `https://www.google.com/search?q=${encodeURIComponent(input)}`;
      }

      // Optimistic update - show URL immediately for snappy feel
      urlBar.value = url;
      urlBar.blur();

      // Fire-and-forget navigation - onUrlChanged will correct if needed
      window.electronAPI.navigateToUrl(url);
    }
  }
});

// Select all text when URL bar is focused
urlBar.addEventListener('focus', () => {
  urlBar.select();
});

// Batch DOM updates using requestAnimationFrame for better performance
function scheduleDOMUpdate(tabId, url, title) {
  pendingUpdates.set(tabId, { url, title });

  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => {
      // Process all pending updates at once (batched)
      pendingUpdates.forEach((data, tabId) => {
        const { url, title } = data;

        // Update tab URL and title
        updateTabUrl(tabId, url);
        if (title) {
          updateTabTitle(tabId, title);
        }

        // Update URL bar if this is the active tab
        if (tabId === currentTabId) {
          urlBar.value = url;
        }
      });

      pendingUpdates.clear();
      rafScheduled = false;
    });
  }
}

// Listen for URL changes from the browser view
window.electronAPI.onUrlChanged(async (data) => {
  const { tabId, url, title } = data;

  // If this is a new tab we don't know about, create it in the UI
  const isNewTab = !tabs.has(tabId);
  if (isNewTab) {
    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.dataset.tabId = tabId;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = title || url || 'New Tab';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(tabId);
    };

    tabElement.appendChild(titleSpan);
    tabElement.appendChild(closeBtn);
    tabElement.onclick = () => switchTab(tabId);

    tabsContainer.appendChild(tabElement);

    tabs.set(tabId, {
      element: tabElement,
      title: title || url || 'New Tab',
      url: url
    });

    // Switch to the new tab in the UI
    currentTabId = tabId;
    tabs.forEach((tab, id) => {
      tab.element.classList.toggle('active', id === tabId);
    });
  }

  // Schedule batched DOM update for better performance
  scheduleDOMUpdate(tabId, url, title);
});

// New tab button
btnNewTab.addEventListener('click', async () => {
  await createTab();
});

// Forecast Event modal
if (btnForecastEvent) {
  btnForecastEvent.addEventListener('click', async () => {
    await window.electronAPI.showModal();
    forecastEventModal.style.display = 'flex';
    forecastTickerInput.focus();
  });
} else {
  console.error('[Forecast] button element #btn-forecast-event not found');
}

forecastRunBtn.addEventListener('click', async () => {
  await forecastEventMagnitude();
});

forecastTickerInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    forecastEventMagnitude();
  }
});

forecastEventClose.addEventListener('click', async () => {
  forecastEventModal.style.display = 'none';
  await window.electronAPI.hideModal();
});

forecastEventModal.addEventListener('click', async (e) => {
  if (e.target === forecastEventModal) {
    forecastEventModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});

async function forecastEventMagnitude() {
  const ticker = forecastTickerInput.value.trim().split(/[\s,]+/)[0]?.toUpperCase();
  console.log('[Forecast] ticker input:', ticker);
  if (!ticker) {
    showToast('Forecast Error', 'Enter a ticker first', 'error');
    return;
  }

  forecastRunBtn.disabled = true;
  forecastRunBtn.classList.add('is-loading');
  forecastRunBtn.textContent = '⏳ Running...';
  showToast('Forecasting', `Running TimesFM 3.0 for ${ticker}...`, 'info');

  try {
    console.log('[Forecast] calling IPC forecastEventMagnitude');
    const result = await window.electronAPI.forecastEventMagnitude(ticker);
    console.log('[Forecast] IPC result:', result);

    if (!result.success) {
      showToast('Forecast Error', result.error || 'Unknown error', 'error');
      forecastEventBody.innerHTML = `<p style="color: #ef5350;">Error: ${result.error}</p>`;
      return;
    }

    const prob = result.event_probability ?? 0;
    const threshold = result.event_threshold ?? 1;
    const predictedMag = result.predicted_event_magnitude ?? 0;
    const probPercent = (prob * 100).toFixed(1);
    const color = prob >= 0.5 ? '#ef5350' : (prob >= 0.25 ? '#ffca28' : '#66bb6a');

    forecastEventBody.innerHTML = `
      <div class="form-row">
        <span style="color: #4db6ac; font-weight: 600; font-size: 1.1em;">${ticker} — ${result.forecast_date}</span>
      </div>
      <div class="form-row" style="display: flex; justify-content: space-between; gap: 12px;">
        <div style="flex: 1; background: #1f2229; border-radius: 8px; padding: 12px; text-align: center;">
          <div style="font-size: 0.75em; color: #a0aec0;">Event Probability</div>
          <div style="font-size: 1.6em; font-weight: 700; color: ${color};">${probPercent}%</div>
        </div>
        <div style="flex: 1; background: #1f2229; border-radius: 8px; padding: 12px; text-align: center;">
          <div style="font-size: 0.75em; color: #a0aec0;">Signal</div>
          <div style="font-size: 1.2em; font-weight: 600; color: ${color};">${prob >= 0.5 ? 'High' : (prob >= 0.25 ? 'Elevated' : 'Low')}</div>
        </div>
      </div>
      <div class="form-row">
        <div style="background: #1f2229; border-radius: 8px; padding: 12px;">
          <div style="font-size: 0.75em; color: #a0aec0;">Estimated Volume × |Return|</div>
          <div style="font-size: 1.1em; color: #eaeaea;">${predictedMag.toLocaleString()} <span style="color: #888; font-size: 0.85em;">(threshold: ${threshold.toLocaleString()})</span></div>
        </div>
      </div>
      <div class="form-row" style="font-size: 0.8em; color: #888;">
        Context: ${result.context_days} days ending ${result.context_end}
      </div>
    `;

    showToast('Forecast Ready', `${ticker}: ${probPercent}% event probability`, 'success');
  } catch (error) {
    console.error('[Forecast] error:', error);
    showToast('Forecast Error', error.message, 'error');
    forecastEventBody.innerHTML = `<p style="color: #ef5350;">Error: ${error.message}</p>`;
  } finally {
    forecastRunBtn.disabled = false;
    forecastRunBtn.classList.remove('is-loading');
    forecastRunBtn.textContent = 'Run Forecast';
  }
}

// Settings button handler - navigate to settings page
btnSettings.addEventListener('click', async () => {
  try {
    // Open settings page
    await window.electronAPI.openSettings();
  } catch (error) {
    console.error('Error opening settings:', error);
  }
});

// Window control buttons
btnMinimize.addEventListener('click', async () => {
  await window.electronAPI.windowMinimize();
});

btnMaximize.addEventListener('click', async () => {
  await window.electronAPI.windowMaximize();
});

btnClose.addEventListener('click', async () => {
  await window.electronAPI.windowClose();
});

// ===== Ticker Screening =====

const btnScreen = document.getElementById('btn-screen');
const screenModal = document.getElementById('screening-modal');
const screenPeriod = document.getElementById('screen-period');
const screenLookbackDays = document.getElementById('screen-lookback-days');
const screenPercentile = document.getElementById('screen-percentile');
const screenCancel = document.getElementById('screen-cancel');
const screenRun = document.getElementById('screen-run');

// Local editable copy of the screening list; kept in sync with config.json
// via saveScreenList after every edit.
let screenListState = { tickers: [] };

async function persistScreenList() {
  const result = await window.electronAPI.saveScreenList(screenListState.tickers);
  if (result && result.success) {
    screenListState = { tickers: result.tickers };
  } else if (result && result.error) {
    showToast('Error', result.error, 'error');
  }
  renderScreenTickerChips();
}

function renderScreenTickerChips() {
  const wrap = document.getElementById('screen-tickers-display');
  const chips = document.getElementById('screen-tickers-chips');
  const countEl = document.getElementById('screen-tickers-count');
  if (!wrap || !chips) return;

  const { tickers } = screenListState;
  wrap.style.display = 'block';
  countEl.textContent = tickers.length
    ? `(${tickers.length})`
    : '(empty — add tickers below)';
  chips.innerHTML = '';

  if (!tickers.length) {
    chips.innerHTML = '<span style="color:#5a6577; font-size:12px; padding:4px 6px;">No tickers — type a symbol below and press Enter or Add.</span>';
    return;
  }

  for (const t of tickers.slice().sort()) {
    const chip = document.createElement('span');
    chip.title = 'In screening list';
    chip.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:5px 8px; border-radius:6px; font-size:13px; font-weight:600; user-select:none; width:100%;' +
      'background:#2a2520; color:#d4a76a; border:1px solid #3e3528;';
    chip.innerHTML = t + ' <span style="color:#ffb74d; font-weight:bold; padding:0 3px; cursor:pointer;" title="Remove">×</span>';
    chip.querySelector('span').addEventListener('click', (e) => {
      e.stopPropagation();
      screenListState.tickers = screenListState.tickers.filter(x => x !== t);
      persistScreenList();
    });
    chips.appendChild(chip);
  }
}

async function refreshScreenTickersDisplay() {
  try {
    const result = await window.electronAPI.getScreenTickers();
    screenListState = { tickers: (result && result.tickers) || [] };
  } catch (_) {
    screenListState = { tickers: [] };
  }
  renderScreenTickerChips();
}

// Add-ticker input
const screenTickerAddInput = document.getElementById('screen-ticker-add');
const screenTickerAddBtn = document.getElementById('screen-ticker-add-btn');

function addScreenTicker() {
  const t = (screenTickerAddInput.value || '').trim().toUpperCase();
  if (!t) return;
  if (screenListState.tickers.includes(t)) {
    showToast('Already in list', t + ' is already in the screening list', 'info');
    screenTickerAddInput.value = '';
    return;
  }
  screenListState.tickers.push(t);
  screenTickerAddInput.value = '';
  persistScreenList();
}

if (screenTickerAddBtn) screenTickerAddBtn.addEventListener('click', addScreenTicker);
if (screenTickerAddInput) screenTickerAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addScreenTicker();
});

let screeningActive = false;

// ── Options data backfill (equivalent of `node ci/backfill-marketdata.js --phase=C`, in-process) ──
const backfillModal = document.getElementById('backfill-modal');
const backfillOpenBtn = document.getElementById('backfill-open');
const backfillCoverageSummary = document.getElementById('backfill-coverage-summary');
const backfillEstimate = document.getElementById('backfill-estimate');
const backfillStartBtn = document.getElementById('backfill-start');
const backfillCancelBtn = document.getElementById('backfill-cancel');
let backfillCoverageData = null;
// True when the backfill dialog was opened from the screening modal (which
// already called showModal) — closing it must not hide the BrowserView then.
let backfillFromScreening = false;

function fmtCredits(v) {
  if (v == null) return '?';
  return v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
}

async function refreshBackfillCoverage() {
  if (!backfillCoverageSummary) return;
  try {
    const cov = await window.electronAPI.backfillCoverage();
    if (!cov.success) {
      backfillCoverageSummary.textContent = 'Options data: coverage unavailable (' + (cov.error || 'error') + ')';
      return;
    }
    backfillCoverageData = cov;
    const stale = cov.stale.length, pending = cov.pendingBackfill.length;
    if (stale + pending === 0) {
      backfillCoverageSummary.innerHTML = 'Options data: <span style="color:#7bc47f;">' + cov.covered
        + ' covered</span> — up to date'
        + (cov.confirmedMissing ? ' · ' + cov.confirmedMissing + ' tickers have no options' : '');
    } else {
      backfillCoverageSummary.innerHTML = 'Options data: ' + cov.covered + ' covered · <span style="color:#e8b04a;">'
        + stale + ' stale</span> · <span style="color:#e8b04a;">' + pending + ' pending backfill</span>';
    }
  } catch (err) {
    backfillCoverageSummary.textContent = 'Options data: coverage unavailable';
  }
}

async function refreshBackfillEstimate() {
  if (!backfillEstimate) return;
  backfillEstimate.textContent = 'Estimating…';
  try {
    const est = await window.electronAPI.backfillEstimate();
    if (!est.success) {
      backfillEstimate.textContent = 'Estimate unavailable (' + (est.error || 'error') + ')';
      return;
    }
    if (est.missingDays === 0 && !est.staleCandles) {
      backfillEstimate.textContent = 'Up to date — nothing to fetch.';
    } else {
      const parts = [];
      if (est.missingDays > 0) {
        parts.push(est.missingDays.toLocaleString() + ' ticker-days missing across ' + est.tickers + ' tickers');
      }
      if (est.staleCandles > 0) {
        parts.push('candle refresh for ' + est.staleCandles + ' ticker(s) (≈' + est.gapDays + ' new day(s) to check)');
      }
      backfillEstimate.textContent = parts.join(' · ') + ' · ≈' + fmtCredits(est.creditsEstimate) + ' credits.'
        + ' Stored days are skipped; resumes where the last run stopped.';
    }
  } catch (err) {
    backfillEstimate.textContent = 'Estimate unavailable (' + err.message + ')';
  }
}

async function openBackfillModal(fromScreening) {
  backfillFromScreening = fromScreening;
  if (!fromScreening) await window.electronAPI.showModal();
  refreshBackfillEstimate();
  backfillModal.style.display = 'flex';
}

async function closeBackfillModal() {
  backfillModal.style.display = 'none';
  if (!backfillFromScreening) await window.electronAPI.hideModal();
}

backfillOpenBtn?.addEventListener('click', () => openBackfillModal(true));
backfillCancelBtn?.addEventListener('click', closeBackfillModal);
backfillModal?.addEventListener('click', (e) => {
  if (e.target === backfillModal) closeBackfillModal();
});

backfillStartBtn?.addEventListener('click', async () => {
  await closeBackfillModal();

  // Sticky progress toast with a Stop button (Rebuild-Ranking toast pattern)
  const toast = document.createElement('div');
  toast.className = 'toast toast-info toast-backfill-progress';
  toast.innerHTML = `
    <span class="toast-icon">⤓</span>
    <div class="toast-content">
      <div class="toast-title">Backfilling options data</div>
      <div class="toast-message">Building task list…</div>
    </div>
    <button type="button" class="toast-action">■ Stop</button>
  `;
  toast.querySelector('.toast-action').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Stopping…';
    try { await window.electronAPI.backfillCancel(); } catch (_) { /* already gone */ }
  });
  toastContainer.appendChild(toast);

  try {
    const result = await window.electronAPI.backfillStart({ tickers: null, creditCap: null });
    toast.remove();
    if (!result.success) {
      showToast('Backfill Error', result.error, 'error');
      return;
    }
    refreshBackfillCoverage();
    if (result.cancelled) {
      showToast('Backfill Stopped', 'Kept ' + result.daysFetched + ' fetched day(s) across '
        + result.tickersFilled.length + ' ticker(s) — IV history re-derived', 'info', 8000);
    } else if (result.quotaExhausted) {
      showToast('Out of Credits', 'MarketData daily credits exhausted after '
        + result.daysFetched + ' day(s) across ' + result.tickersFilled.length
        + ' ticker(s) — run again once credits reset', 'error', 10000);
    } else if (result.creditCapped) {
      showToast('Backfill Paused', 'Credit cap hit (' + fmtCredits(result.creditsUsed) + ' credits) after '
        + result.daysFetched + ' day(s) — start it again later to continue', 'info', 10000);
    } else {
      showToast('Backfill Complete', (result.candlesBars ? result.candlesBars + ' new candle bar(s) · ' : '')
        + result.daysFetched + ' ticker-days fetched across '
        + result.tickersFilled.length + ' ticker(s), ' + fmtCredits(result.creditsUsed)
        + ' credits — re-run the screening to fill the charts', 'success', 10000);
    }
  } catch (error) {
    toast.remove();
    showToast('Backfill Error', error.message, 'error');
  }
});

window.electronAPI.onBackfillProgress?.((data) => {
  const el = document.querySelector('.toast-backfill-progress .toast-message');
  if (!el) return;
  if (data.phase === 'starting') {
    el.textContent = 'Building task list…';
  } else if (data.phase === 'A') {
    el.textContent = 'Phase A: refreshing candles ' + data.done + '/' + data.total + ' — ' + (data.ticker || '');
  } else if (data.phase === 'C') {
    el.textContent = 'Phase C: ' + data.done + '/' + data.total + ' days — ' + (data.ticker || '')
      + ' · ' + fmtCredits(data.creditsUsed) + ' credits';
  } else if (data.phase === 'D') {
    el.textContent = 'Phase D: re-deriving IV history (' + (data.done || 0) + '/' + data.total + ') — ' + (data.ticker || '');
  } else if (data.phase === 'done') {
    el.textContent = 'Finishing…';
  }
});

// After a screening: if options coverage has gaps, offer a one-click backfill.
async function maybeAskBackfill() {
  try {
    await refreshBackfillCoverage();
    const cov = backfillCoverageData;
    if (!cov) return;
    const stale = cov.stale.length, pending = cov.pendingBackfill.length;
    if (stale + pending === 0) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-info toast-backfill-ask';
    toast.innerHTML = `
      <span class="toast-icon">⤓</span>
      <div class="toast-content">
        <div class="toast-title">Options data gaps detected</div>
        <div class="toast-message">${stale} stale · ${pending} pending backfill — OTM-flow charts will have empty stretches.</div>
      </div>
      <button type="button" class="toast-action toast-action-primary">Backfill now</button>
      <button type="button" class="toast-action">Later</button>
    `;
    const [yesBtn, noBtn] = toast.querySelectorAll('.toast-action');
    yesBtn.addEventListener('click', () => { toast.remove(); openBackfillModal(false); });
    noBtn.addEventListener('click', () => toast.remove());
    toastContainer.appendChild(toast);
  } catch (_) { /* never block the screening-completion flow */ }
}

btnScreen.addEventListener('click', async () => {
  if (screeningActive) {
    // While a screening is running, the button acts as a Stop button.
    btnScreen.textContent = 'Stopping...';
    btnScreen.disabled = true;
    try {
      await window.electronAPI.cancelScreening();
    } catch (err) {
      console.error('Cancel error:', err);
    }
    return;
  }
  await window.electronAPI.showModal();
  screenModal.style.display = 'flex';
  screenPeriod.value = '100';
  screenLookbackDays.value = '5';
  screenPercentile.value = '92';
  screenPeriod.focus();
  populateScreeningRuns();
  refreshScreenTickersDisplay();
  refreshBackfillCoverage();
});

screenCancel.addEventListener('click', async () => {
  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();
});

screenModal.addEventListener('click', async (e) => {
  if (e.target === screenModal) {
    screenModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});

// Rebuild Ticker List button
const screenRevise = document.getElementById('screen-revise');
const screenViewLast = document.getElementById('screen-view-last');

// View last revision results
screenViewLast.addEventListener('click', async () => {
  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();

  try {
    const result = await window.electronAPI.loadReviseResults();
    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }

    const html = generateReviseHTML(result);
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await createTab(dataUrl);
  } catch (error) {
    showToast('Error', error.message, 'error');
  }
});

// Listen for progress updates
window.electronAPI.onReviseProgress((data) => {
  const pct = Math.round((data.current / data.total) * 100);
  const existing = document.querySelector('.toast-revise-progress');
  if (existing) {
    const msg = existing.querySelector('.toast-message');
    if (msg) msg.textContent = `${data.current}/${data.total} (${pct}%) — ${data.ticker}`;
  }
});

screenRevise.addEventListener('click', async () => {
  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();

  // Show persistent progress toast
  const toast = document.createElement('div');
  toast.className = 'toast toast-info toast-revise-progress';
  toast.innerHTML = `
    <span class="toast-icon">ℹ</span>
    <div class="toast-content">
      <div class="toast-title">Rebuilding Ranking</div>
      <div class="toast-message">Ranking ~910 tickers, ~6-8 minutes...</div>
    </div>
  `;
  toastContainer.appendChild(toast);

  try {
    const result = await window.electronAPI.reviseTickers();

    // Remove progress toast
    toast.remove();

    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }

    // Generate results HTML and open in tab
    const html = generateReviseHTML(result);
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await createTab(dataUrl);

    showToast('Rebuild Complete', `Ranking updated from ${result.totalScored} scored — screening runs draw 5 random tickers from the top 100`, 'success');
  } catch (error) {
    toast.remove();
    console.error('Revise error:', error);
    showToast('Error', error.message, 'error');
  }
});

function generateReviseHTML(result) {
  const ex = result.excluded || { illiquid: [], noGrowth: [], highLeverage: [] };
  const nIlliquid = ex.illiquid.length;
  const nNoGrowth = ex.noGrowth.length;
  const nHighLev = ex.highLeverage.length;
  const nErrors = (result.errors || []).length;
  const selectedSet = new Set(result.tickers || []);

  function fmtCap(v) {
    if (!v) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    return v.toLocaleString();
  }

  // Status labels and sort-order values for each category
  const statusMap = {
    selected:     { label: 'Selected',       color: '#4caf50', order: 0 },
    illiquid:     { label: 'Illiquid',        color: '#2196f3', order: 1 },
    noGrowth:     { label: 'Low Growth',      color: '#ff9800', order: 2 },
    highLeverage: { label: 'High Leverage',   color: '#f44336', order: 3 },
    error:        { label: 'Error',           color: '#999',    order: 4 },
  };

  // Build a unified list of all tickers
  const allEntries = [];

  // Selected (top 100)
  for (const d of result.details) {
    allEntries.push({ ...d, status: 'selected' });
  }
  // Excluded groups
  for (const d of ex.illiquid) {
    allEntries.push({ ...d, status: 'illiquid' });
  }
  for (const d of ex.noGrowth) {
    allEntries.push({ ...d, status: 'noGrowth' });
  }
  for (const d of ex.highLeverage) {
    allEntries.push({ ...d, status: 'highLeverage' });
  }
  // Errors
  for (const e of (result.errors || [])) {
    allEntries.push({ ticker: e.ticker, score: -1, revenueGrowth: 0, equityGrowth: 0, effectiveGrowth: 0, debtToEquity: 0, leverageFactor: 0, avgVolume: 0, marketCap: 0, status: 'error', errorMsg: e.error });
  }

  const nTotal = allEntries.length;
  const timestamp = result.timestamp ? new Date(result.timestamp).toLocaleString() : '';

  const rows = allEntries.map(d => {
    const st = statusMap[d.status];
    const isSelected = d.status === 'selected';
    const rowStyle = isSelected ? '' : ' style="color:#999;"';
    const statusOrder = st.order;

    // Which ranking(s) selected this ticker (old results files have no flags —
    // treat all selected as growth-list members)
    const inGrowth = d.inGrowth !== false;
    const inEvent = d.inEvent === true;
    const listBadge = isSelected
      ? (inGrowth && inEvent ? 'G + EP' : inEvent ? 'EP' : 'G')
      : '—';
    const listOrder = isSelected ? (inGrowth && inEvent ? 2 : inEvent ? 1 : 0) : -1;

    return `<tr${rowStyle}>
      <td data-v="${d.ticker}" style="font-weight:bold;">${d.ticker}</td>
      <td data-v="${statusOrder}" style="color:${st.color}; font-weight:bold;">${st.label}</td>
      <td data-v="${listOrder}">${listBadge}</td>
      <td data-v="${d.revenueGrowth || 0}">${d.revenueGrowth != null ? (d.revenueGrowth * 100).toFixed(1) + '%' : '—'}</td>
      <td data-v="${d.equityGrowth || 0}">${d.equityGrowth != null ? (d.equityGrowth * 100).toFixed(1) + '%' : '—'}</td>
      <td data-v="${d.debtToEquity || 0}">${d.debtToEquity != null ? d.debtToEquity.toFixed(0) : '—'}</td>
      <td data-v="${d.leverageFactor || 0}">${d.leverageFactor != null ? d.leverageFactor.toFixed(3) : '—'}</td>
      <td data-v="${d.score || 0}">${d.score != null && d.score >= 0 ? (d.score * 100).toFixed(2) : '—'}</td>
      <td data-v="${d.eventProneness || 0}">${d.eventProneness != null && d.eventProneness > 0 ? d.eventProneness.toFixed(2) : '—'}</td>
      <td data-v="${d.avgVolume || 0}" style="text-align:right;">${d.avgVolume ? (d.avgVolume / 1e6).toFixed(1) + 'M' : '—'}</td>
      <td data-v="${d.marketCap || 0}" style="text-align:right;">${fmtCap(d.marketCap)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Rebuild Ticker List — Results</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #fafafa; color: #333; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .summary { color: #666; margin-bottom: 16px; font-size: 0.95em; }
  .exclusion-summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .excl-card { background: #fff; border-radius: 8px; padding: 14px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); min-width: 140px; }
  .excl-card .count { font-size: 1.8em; font-weight: bold; }
  .excl-card .label { font-size: 0.85em; color: #666; margin-top: 2px; }
  .excl-card.illiquid .count { color: #2196f3; }
  .excl-card.no-growth .count { color: #ff9800; }
  .excl-card.high-lev .count { color: #f44336; }
  .excl-card.errors .count { color: #999; }
  .excl-card.selected .count { color: #4caf50; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
  th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-size: 0.85em; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  #revise-table th { cursor: pointer; user-select: none; }
  #revise-table th:hover { color: #333; background: #eee; }
  #revise-table th .sort-arrow { font-size: 0.7em; margin-left: 3px; color: #bbb; }
  #revise-table th.sorted-asc .sort-arrow, #revise-table th.sorted-desc .sort-arrow { color: #333; }
  td { padding: 8px 12px; border-top: 1px solid #eee; font-size: 0.95em; }
  tr:hover { background: #f9f9f9; }
</style></head><body>
<h1>Rebuild Ticker List — All Tickers</h1>
<p class="summary">${nTotal} tickers analyzed${timestamp ? ' on ' + timestamp : ''}. The rebuild only refreshes the ranking — screening runs draw 5 random tickers from the top 100 (excluding your list and the previous draw). List column: G = growth, EP = event-prone.</p>

<div class="exclusion-summary">
  <div class="excl-card selected"><div class="count">${selectedSet.size}</div><div class="label">Selected</div></div>
  <div class="excl-card illiquid"><div class="count">${nIlliquid}</div><div class="label">Illiquid</div></div>
  <div class="excl-card no-growth"><div class="count">${nNoGrowth}</div><div class="label">Low Growth</div></div>
  <div class="excl-card high-lev"><div class="count">${nHighLev}</div><div class="label">High Leverage</div></div>
  <div class="excl-card errors"><div class="count">${nErrors}</div><div class="label">Errors</div></div>
</div>

<table id="revise-table">
<thead><tr>
  <th>Ticker<span class="sort-arrow"></span></th>
  <th>Status<span class="sort-arrow"></span></th>
  <th>Lists<span class="sort-arrow"></span></th>
  <th>Rev Growth<span class="sort-arrow"></span></th>
  <th>Eq Growth<span class="sort-arrow"></span></th>
  <th>D/E<span class="sort-arrow"></span></th>
  <th>Lev Factor<span class="sort-arrow"></span></th>
  <th>Score<span class="sort-arrow"></span></th>
  <th title="Event-proneness: beta, or 52-week range as fallback">EP<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Avg Vol<span class="sort-arrow"></span></th>
  <th style="text-align:right;">Mkt Cap<span class="sort-arrow"></span></th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<script>
(function() {
  const table = document.getElementById('revise-table');
  const headers = table.querySelectorAll('th');
  let currentCol = -1, ascending = true;

  headers.forEach((th, colIdx) => {
    th.addEventListener('click', () => {
      if (currentCol === colIdx) {
        ascending = !ascending;
      } else {
        currentCol = colIdx;
        ascending = (colIdx === 0 || colIdx === 1); // Ticker/Status default ascending
      }

      headers.forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');

      headers.forEach(h => h.querySelector('.sort-arrow').textContent = '');
      th.querySelector('.sort-arrow').textContent = ascending ? ' \\u25B2' : ' \\u25BC';

      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));

      rows.sort((a, b) => {
        const aVal = a.children[colIdx].getAttribute('data-v');
        const bVal = b.children[colIdx].getAttribute('data-v');
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

      rows.forEach(r => tbody.appendChild(r));
    });
  });
})();
</script>
</body></html>`;
}

// View a screening run — the dropdown lists the 3 most recent runs, newest first.
const screenViewSelect = document.getElementById('screen-view-screening');

async function populateScreeningRuns() {
  try {
    const result = await window.electronAPI.listScreeningRuns();
    // Remove all options except the placeholder
    for (let i = screenViewSelect.options.length - 1; i >= 1; i--) {
      screenViewSelect.remove(i);
    }
    screenViewSelect.selectedIndex = 0;

    if (!result.success || !result.runs || result.runs.length === 0) return;

    result.runs.forEach((run, idx) => {
      const opt = document.createElement('option');
      opt.value = run.filePath;
      opt.textContent = idx === 0 ? `Latest — ${run.label}` : run.label;
      screenViewSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to list screening runs:', err);
  }
}

screenViewSelect.addEventListener('change', async () => {
  const filePath = screenViewSelect.value;
  if (!filePath) return;

  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();

  try {
    const result = await window.electronAPI.loadScreeningResults(filePath);
    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }
    await createTab('file://' + result.filePath);
  } catch (error) {
    showToast('Error', error.message, 'error');
  } finally {
    screenViewSelect.selectedIndex = 0; // reset so reselecting same option re-fires
  }
});

screenRun.addEventListener('click', async () => {
  const period = parseInt(screenPeriod.value, 10) || 100;
  const lookbackDays = parseInt(screenLookbackDays.value, 10) || 5;
  const percentileThreshold = parseInt(screenPercentile.value, 10) || 92;
  // Empty / invalid → 'auto' (main process scales k to the universe size).
  const clusterKRaw = parseInt(document.getElementById('screen-cluster-k').value, 10);
  const clusterK = Number.isInteger(clusterKRaw) && clusterKRaw >= 2 && clusterKRaw <= 8 ? clusterKRaw : 'auto';
  const overrideRaw = document.getElementById('screen-override-tickers').value.trim();
  const overrideTickers = overrideRaw
    ? overrideRaw.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
    : null;
  const fetchNews = document.getElementById('screen-fetch-news').checked;

  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();

  const tickerCount = overrideTickers ? overrideTickers.length : 'all';
  const screenBtn = document.getElementById('btn-screen');
  const screenBtnOriginal = screenBtn.textContent;
  screenBtn.classList.add('is-loading');
  screenBtn.textContent = `⏹ Stop (${tickerCount})`;
  screeningActive = true;

  try {
    const result = await window.electronAPI.screenTickers({ period, lookbackDays, percentileThreshold, clusterK, overrideTickers, fetchNews });

    if (!result.success) {
      const isCancel = result.cancelled || /cancel/i.test(result.error || '');
      showToast(isCancel ? 'Screening Stopped' : 'Error', result.error || 'Cancelled', isCancel ? 'info' : 'error');
      return;
    }

    if (result.cancelled) {
      showToast('Screening Stopped', `Partial results: ${result.hitCount || 0} hit${result.hitCount === 1 ? '' : 's'}`, 'info');
    } else {
      showToast('Screening Complete', `Found ${result.hitCount} hit${result.hitCount !== 1 ? 's' : ''}`, 'success');
    }
    if (result.filePath) await createTab('file://' + result.filePath);
    maybeAskBackfill();
  } catch (error) {
    console.error('Screening error:', error);
    showToast('Error', error.message, 'error');
  } finally {
    screeningActive = false;
    screenBtn.classList.remove('is-loading');
    screenBtn.disabled = false;
    screenBtn.textContent = screenBtnOriginal;
  }
});

// Initialize
(async () => {
  // Tab creation doesn't require DB — start it immediately.
  // Open simplywall.st as the only startup tab.
  await createTab('https://simplywall.st/dashboard');
})();


// ---- Model Lab (minimal feature sets for the screening forecasts) ----
const btnLab = document.getElementById('btn-lab');
const labModal = document.getElementById('lab-modal');
const labSearchBtn = document.getElementById('lab-search');
const labBacktestBtn = document.getElementById('lab-backtest');
const labCloseBtn = document.getElementById('lab-close');
const labCancelRunBtn = document.getElementById('lab-cancel-run');
const labResetBtn = document.getElementById('lab-reset');
const labLog = document.getElementById('lab-log');
const labGroups = document.getElementById('lab-groups');
const labReviewModal = document.getElementById('lab-review-modal');
const labReviewGroups = document.getElementById('lab-review-groups');
const labReviewAcceptBtn = document.getElementById('lab-review-accept');
const labReviewDeclineBtn = document.getElementById('lab-review-decline');
let labPendingSearch = null; // search result awaiting accept/decline

const labEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const labFmt = (v) => (v == null ? '—' : Number(v).toFixed(4));
let labMeta = null;

// The two screening forecast groups. `preset` names the production default
// each group falls back to until a search has chosen something better.
const LAB_GROUP_INFO = {
  direction: {
    title: 'Direction → tomorrow',
    blurb: 'Will the price be higher tomorrow? (P(up→1d) column)',
    preset: 'options',
  },
  event: {
    title: 'Big event tomorrow',
    blurb: "Is tomorrow one of this ticker's own top-8% volume × move days? (Event Prob column)",
    preset: 'full2',
  },
};

async function labScreeningChannels() {
  try {
    return (await window.electronAPI.getSetting('screening.channels', {})) || {};
  } catch (_) {
    return {};
  }
}

function labFeatureRow(ch, targetCh) {
  const desc = (labMeta && labMeta.descriptions && labMeta.descriptions[ch]) || '';
  const isTarget = ch === targetCh;
  return `<div class="lab-feature${isTarget ? ' target' : ''}">
    <span class="lab-feature-name">${labEsc(ch)}${isTarget ? '<em>target</em>' : ''}</span>
    <span class="lab-feature-desc">${labEsc(desc)}</span>
  </div>`;
}

function labFeatureList(channels) {
  // One row per feature, grouped by category; the target series leads the
  // list. The container scrolls when the rows outgrow the modal.
  const targetCh = channels[0];
  const active = new Set(channels);
  const seen = new Set([targetCh]);
  let html = labFeatureRow(targetCh, targetCh);
  for (const [group, members] of (labMeta && labMeta.groups) || []) {
    const present = members.filter(c => active.has(c) && !seen.has(c));
    if (!present.length) continue;
    present.forEach(c => seen.add(c));
    html += `<div class="lab-feature-group-label">${labEsc(group)}</div>` +
      present.map(c => labFeatureRow(c, targetCh)).join('');
  }
  const rest = channels.filter(c => !seen.has(c));
  if (rest.length) {
    html += `<div class="lab-feature-group-label">Other</div>` +
      rest.map(c => labFeatureRow(c, targetCh)).join('');
  }
  return html;
}

// Tags marking where a pool feature is currently used.
function labTagHtml(target, on) {
  const label = target === 'direction' ? 'dir' : 'event';
  const tip = target === 'direction'
    ? 'Used in the direction → tomorrow prediction'
    : 'Used in the event prediction';
  return `<span class="lab-tag ${target}${on ? '' : ' off'}"${on ? ` title="${tip}"` : ' aria-hidden="true"'}>${label}</span>`;
}

function labPoolRow(ch, targetChs, usedIn) {
  const desc = (labMeta && labMeta.descriptions && labMeta.descriptions[ch]) || '';
  const targetFor = targetChs[ch]; // 'direction' | 'event' | undefined
  return `<div class="lab-feature lab-feature-pool${targetFor ? ' target' : ''}">
    <span class="lab-feature-name">${labEsc(ch)}${targetFor ? '<em>target</em>' : ''}</span>
    <span class="lab-feature-desc">${labEsc(desc)}</span>
    <span class="lab-feature-tags">${labTagHtml('direction', usedIn.direction.has(ch))}${labTagHtml('event', usedIn.event.has(ch))}</span>
  </div>`;
}

function labPoolList(directionChannels, eventChannels) {
  // The complete pool the search draws from: both target series plus every
  // grouped covariate. Rows carry dir/event tags for current membership.
  const usedIn = {
    direction: new Set(directionChannels),
    event: new Set(eventChannels),
  };
  const targetChs = {};
  if (directionChannels[0]) targetChs[directionChannels[0]] = 'direction';
  if (eventChannels[0]) targetChs[eventChannels[0]] = 'event';
  const seen = new Set(Object.keys(targetChs));
  let html = `<div class="lab-feature-group-label">Target series</div>` +
    [...seen].map(ch => labPoolRow(ch, targetChs, usedIn)).join('');
  for (const [group, members] of (labMeta && labMeta.groups) || []) {
    const present = members.filter(c => !seen.has(c));
    if (!present.length) continue;
    present.forEach(c => seen.add(c));
    html += `<div class="lab-feature-group-label">${labEsc(group)}</div>` +
      present.map(c => labPoolRow(c, targetChs, usedIn)).join('');
  }
  return html;
}

async function renderLabGroups() {
  if (!labGroups || !labMeta) return;
  const saved = await labScreeningChannels();
  const current = {}; // target -> channel list currently in use
  for (const target of Object.keys(LAB_GROUP_INFO)) {
    const info = LAB_GROUP_INFO[target];
    const presetCh = (labMeta.presets[target] || {})[info.preset] || [];
    const custom = Array.isArray(saved[target]) && saved[target].length >= 1 ? saved[target] : null;
    current[target] = { channels: custom || presetCh, custom, info };
  }

  let html = '';
  for (const [target, { channels, custom, info }] of Object.entries(current)) {
    const auroc = custom ? saved[target + 'Auroc'] : null;
    const source = custom
      ? `chosen by search ${labEsc(saved[target + 'SavedAt'] || '')}` +
        (auroc != null ? ` · backtest AUROC ${labFmt(auroc)}` : '')
      : 'production default';
    html += `<div class="lab-group"><details class="lab-collapse">
      <summary>
        <span class="lab-chevron" aria-hidden="true"></span>
        <b>${labEsc(info.title)}</b>
        <span class="lab-group-meta">${channels.length} features · ${source}</span>
      </summary>
      <div class="lab-group-sub">${labEsc(info.blurb)}</div>
      <div class="lab-feature-list">${labFeatureList(channels)}</div>
    </details></div>`;
  }

  html += `<div class="lab-group"><details id="lab-dataset" class="lab-collapse">
    <summary>
      <span class="lab-chevron" aria-hidden="true"></span>
      <b>Dataset</b>
      <span class="lab-group-meta">checking…</span>
    </summary>
    <div class="lab-group-sub">Automatic health check of the data behind the search — sample sizes, coverage and warnings.</div>
    <div class="lab-feature-list lab-dataset-body" style="display:block;">
      <div style="color:#6b7a8d;font-size:0.8em;padding:6px 12px;">Checking dataset…</div>
    </div>
  </details></div>`;

  const poolSize = new Set([...current.direction.channels, ...current.event.channels]).size;
  const poolTotal = Math.max(poolSize,
    2 + ((labMeta.groups || []).reduce((n, [, m]) => n + m.length, 0)));
  html += `<div class="lab-group"><details class="lab-collapse">
    <summary>
      <span class="lab-chevron" aria-hidden="true"></span>
      <b>Feature pool</b>
      <span class="lab-group-meta">${poolTotal} features searched through</span>
    </summary>
    <div class="lab-group-sub">Every feature the search can choose from. Tags show which predictions currently use each one.</div>
    <div class="lab-feature-list">${labPoolList(current.direction.channels, current.event.channels)}</div>
  </details></div>`;
  labGroups.innerHTML = html;
}

async function openLabModal() {
  await window.electronAPI.showModal();
  labModal.style.display = 'flex';
  if (!labMeta) {
    labGroups.innerHTML = '<div style="color:#6b7a8d;font-size:0.85em;">Loading current features…</div>';
    const meta = await window.electronAPI.labMeta();
    if (!meta || meta.error) {
      labGroups.innerHTML = `<div style="color:#f66;font-size:0.85em;">Could not load feature metadata: ${labEsc(meta?.error || 'unknown error')}</div>`;
      return;
    }
    labMeta = meta;
  }
  await renderLabGroups();
  labRenderDataset(); // async health check; fills its own section
}

async function labRenderDataset() {
  const box = document.getElementById('lab-dataset');
  if (!box) return;
  const body = box.querySelector('.lab-dataset-body');
  const metaEl = box.querySelector('.lab-group-meta');
  const checked = (info) => {
    const t = (info && info.generated_at || '').split(' ')[1] || '';
    return `checked ${labEsc(t)}`;
  };

  let res;
  try {
    res = await window.electronAPI.labDataset();
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!res.success || !res.info || res.info.error) {
    const msg = (res.info && res.info.error) || res.error || 'unknown error';
    metaEl.textContent = 'check failed';
    body.innerHTML = `<div class="lab-warn">⚠ Dataset check failed: ${labEsc(msg)}</div>`;
    return;
  }

  const info = res.info;
  const row = (k, v) => `<div class="lab-ds-row"><span>${k}</span><span>${labEsc(v)}</span></div>`;
  let html = '';
  if (info.db) {
    html += row('Price history', `${info.db.tickers} tickers · ${info.db.date_min} → ${info.db.date_max} · ${Number(info.db.price_rows).toLocaleString()} rows`);
  }
  if (info.options && info.db) {
    html += row('Options coverage', `${info.options.tickers_with_options}/${info.db.tickers} tickers with options data`);
  }
  const labels = { direction: 'Direction samples', event: 'Event samples' };
  for (const [target, label] of Object.entries(labels)) {
    const r = (info.targets || {})[target];
    if (!r) continue;
    if (!r.available) {
      html += row(label, 'not available');
    } else {
      let v = `${Number(r.samples).toLocaleString()} samples · ${r.tickers} tickers · ${(r.positive_rate * 100).toFixed(1)}% positive`;
      if (r.median_horizon_days) v += ` · median horizon ${r.median_horizon_days}d`;
      html += row(label, v);
    }
  }
  if (info.pool_size) html += row('Feature pool', `${info.pool_size} variables searched through`);
  const evt = (info.targets || {}).event;
  if (evt && evt.available) {
    html += row('Event rule', `per ticker: own top 8% of trading days` +
      (evt.median_threshold ? ` · median threshold ${Number(evt.median_threshold).toLocaleString()}` : ''));
  }

  const warns = info.warnings || [];
  if (warns.length) {
    html += warns.map(w => `<div class="lab-warn">⚠ ${labEsc(w)}</div>`).join('');
    html += `<div class="lab-insights" id="lab-dataset-ai" style="border-top:1px solid #2a303b;"></div>`;
  } else {
    html += `<div class="lab-ok">✓ No warnings — dataset looks healthy.</div>`;
  }
  body.innerHTML = html;
  metaEl.textContent = warns.length
    ? `${warns.length} warning${warns.length > 1 ? 's' : ''} · ${checked(info)}`
    : `healthy · ${checked(info)}`;
  if (warns.length) {
    labFetchInsights('dataset', info, document.getElementById('lab-dataset-ai'));
  }
}

async function runLabSearch() {
  labSearchBtn.disabled = true;
  labSearchBtn.textContent = '⏳ Searching…';
  if (labBacktestBtn) labBacktestBtn.disabled = true;
  labCancelRunBtn.style.display = '';
  labResetBtn.style.display = 'none';
  labLog.style.display = 'block';
  labLog.textContent = '';
  try {
    const res = await window.electronAPI.labSearch();
    if (!res || !res.success) {
      showToast('Lab Error', (res && res.error) || 'Search failed', 'error', 6000);
      return;
    }
    // Hand the result to the review modal — nothing is stored until Accept.
    const s = res.search || {};
    const hasResult = ['direction', 'event'].some(t => s[t] && Array.isArray(s[t].channels));
    if (!hasResult) {
      showToast('Model Lab', 'Search finished (no changes).', 'info', 5000);
      return;
    }
    await showLabReview(s);
  } catch (err) {
    showToast('Lab Error', err.message || String(err), 'error', 6000);
  } finally {
    labSearchBtn.disabled = false;
    labSearchBtn.textContent = 'Search';
    if (labBacktestBtn) labBacktestBtn.disabled = false;
    labCancelRunBtn.style.display = 'none';
    labResetBtn.style.display = '';
  }
}

// ---- Backtest: score the current feature setup for both targets as-is ----
async function runLabBacktest() {
  labBacktestBtn.disabled = true;
  labBacktestBtn.textContent = '⏳ Backtesting…';
  labSearchBtn.disabled = true;
  labCancelRunBtn.style.display = '';
  labLog.style.display = 'block';
  labLog.textContent = '';
  try {
    const res = await window.electronAPI.labBacktest();
    if (!res || !res.success) {
      showToast('Lab Error', (res && res.error) || 'Backtest failed', 'error', 6000);
      return;
    }
    const bt = res.backtest || {};
    const lines = ['', '── Backtest result (current setup, walk-forward) ──'];
    for (const target of ['direction', 'event']) {
      const t = bt[target];
      const title = (LAB_GROUP_INFO[target] || {}).title || target;
      if (!t || !t.available) {
        lines.push(`${title}: not available (no samples)`);
        continue;
      }
      const m = t.metrics || {};
      lines.push(
        `${title}: AUROC ${labFmt(m.auroc)} · accuracy ${(m.accuracy * 100).toFixed(1)}%` +
        ` · Brier ${labFmt(m.brier)} · ${Number(t.n_samples).toLocaleString()} samples` +
        ` · ${t.n_channels} features (${t.preset} preset)`
      );
    }
    labLog.textContent += lines.join('\n') + '\n';
    labLog.scrollTop = labLog.scrollHeight;
    const d = bt.direction && bt.direction.metrics ? bt.direction.metrics.auroc : null;
    const e = bt.event && bt.event.metrics ? bt.event.metrics.auroc : null;
    showToast('Model Lab',
      `Backtest done — direction AUROC ${d != null ? labFmt(d) : 'n/a'}, event AUROC ${e != null ? labFmt(e) : 'n/a'}`,
      'info', 6000);
  } catch (err) {
    showToast('Lab Error', err.message || String(err), 'error', 6000);
  } finally {
    labBacktestBtn.disabled = false;
    labBacktestBtn.textContent = 'Backtest';
    labSearchBtn.disabled = false;
    labCancelRunBtn.style.display = 'none';
  }
}

// ---- Local-LLM insights (optional layer over the deterministic summary) ----
async function labFetchInsights(kind, payload, box) {
  if (!box || !window.electronAPI.labInsights) return;
  box.innerHTML = '<span class="lab-insights-label">AI insights</span>Analyzing — the first request may take a minute while the model loads…';
  try {
    const res = await window.electronAPI.labInsights(kind, payload);
    if (!res || !res.success || !res.text) throw new Error((res && res.error) || 'unavailable');
    box.innerHTML = `<span class="lab-insights-label">AI insights</span>${labEsc(res.text)}`;
  } catch (_) {
    box.innerHTML = ''; // model unavailable — the deterministic summary stands alone
  }
}

// ---- Search review: show proposed feature sets, accept or decline ----
async function showLabReview(search) {
  labPendingSearch = search;
  const saved = await labScreeningChannels();
  let html = '';
  const summaryLines = [];
  const aiTargets = {};
  for (const target of ['direction', 'event']) {
    const t = search[target];
    const info = LAB_GROUP_INFO[target];
    const presetCh = (labMeta.presets[target] || {})[info.preset] || [];
    const current = (Array.isArray(saved[target]) && saved[target].length >= 1 ? saved[target] : null) || presetCh;

    // A target-only proposal (length 1) is legitimate — the search's honest
    // verdict when no covariate earns its keep (e.g. event: 28→1, AUROC up).
    if (!t || !Array.isArray(t.channels) || t.channels.length < 1) {
      html += `<div class="lab-group"><details open class="lab-collapse">
        <summary><span class="lab-chevron" aria-hidden="true"></span><b>${labEsc(info.title)}</b>
          <span class="lab-group-meta">no proposal</span></summary>
        <div class="lab-group-sub">${labEsc(info.blurb)}</div>
      </details></div>`;
      continue;
    }

    const newSet = new Set(t.channels);
    const removed = current.filter(c => !newSet.has(c));
    const added = t.channels.filter(c => !current.includes(c));
    const meta = `${current.length} → ${t.n_channels} features` +
      (t.auroc != null ? ` · AUROC ${labFmt(t.baseline_auroc)} → ${labFmt(t.auroc)}` : '');

    let rows = '';
    for (const ch of current) {
      const isTarget = ch === current[0];
      const gone = !newSet.has(ch);
      const desc = (labMeta.descriptions && labMeta.descriptions[ch]) || '';
      rows += `<div class="lab-feature${isTarget ? ' target' : ''}${gone ? ' removed' : ''}">
        <span class="lab-feature-name">${labEsc(ch)}${isTarget ? '<em>target</em>' : ''}</span>
        <span class="lab-feature-desc">${labEsc(desc)}</span>
      </div>`;
    }
    for (const ch of added) {
      const desc = (labMeta.descriptions && labMeta.descriptions[ch]) || '';
      rows += `<div class="lab-feature added">
        <span class="lab-feature-name">${labEsc(ch)}</span>
        <span class="lab-feature-desc">${labEsc(desc)}</span>
      </div>`;
    }

    const changes = [];
    if (removed.length) changes.push(`${removed.length} removed`);
    if (added.length) changes.push(`${added.length} added`);
    const changeLabel = changes.length ? changes.join(', ') : 'no changes';
    html += `<div class="lab-group"><details open class="lab-collapse">
      <summary><span class="lab-chevron" aria-hidden="true"></span><b>${labEsc(info.title)}</b>
        <span class="lab-group-meta">${labEsc(changeLabel)} · ${labEsc(meta)}</span></summary>
      <div class="lab-group-sub">${labEsc(info.blurb)}</div>
      <div class="lab-feature-list">${rows}</div>
    </details></div>`;

    // Deterministic one-liner: every number comes straight from the search.
    const removedDetailed = (t.decisions || [])
      .filter(d => !d.kept)
      .map(d => `${d.channel} (${d.delta_auroc >= 0 ? '+' : ''}${Number(d.delta_auroc).toFixed(4)})`);
    summaryLines.push(`${info.title}: ${current.length} → ${t.n_channels} features · ` +
      `AUROC ${labFmt(t.baseline_auroc)} → ${labFmt(t.auroc)}` +
      (removedDetailed.length ? ` — removed ${removedDetailed.join(', ')} (Δ AUROC when removed).` : ' — no removals.'));
    aiTargets[target] = { ...t, title: info.title };
  }
  html += `<div class="lab-insights-block">
    <div class="lab-summary">${summaryLines.map(labEsc).join('<br>')}</div>
    <div class="lab-insights" id="lab-review-ai"></div>
  </div>`;
  labReviewGroups.innerHTML = html;
  labReviewModal.style.display = 'flex';
  const aiBox = document.getElementById('lab-review-ai');
  if (aiBox) {
    labFetchInsights('search', {
      targets: aiTargets,
      descriptions: (labMeta && labMeta.descriptions) || {},
    }, aiBox);
  }
}

if (labReviewAcceptBtn) labReviewAcceptBtn.addEventListener('click', async () => {
  if (!labPendingSearch) return;
  try {
    const saved = await labScreeningChannels();
    const stamp = new Date().toLocaleString();
    const parts = [];
    for (const target of ['direction', 'event']) {
      const t = labPendingSearch[target];
      if (t && Array.isArray(t.channels) && t.channels.length >= 1) {
        saved[target] = t.channels;
        saved[target + 'SavedAt'] = stamp;
        saved[target + 'Auroc'] = t.auroc;
        parts.push(`${target}: ${t.baseline_n_channels}→${t.n_channels} features` +
          (t.auroc != null ? ` (AUROC ${labFmt(t.auroc)})` : ''));
      }
    }
    await window.electronAPI.setSetting('screening.channels', saved);
    labPendingSearch = null;
    labReviewModal.style.display = 'none';
    await renderLabGroups();
    labRenderDataset();
    showToast('Model Lab', parts.join(' · ') || 'Feature sets updated.', 'success', 7000);
  } catch (err) {
    showToast('Error', err.message || String(err), 'error', 5000);
  }
});

if (labReviewDeclineBtn) labReviewDeclineBtn.addEventListener('click', () => {
  labPendingSearch = null;
  labReviewModal.style.display = 'none';
  showToast('Model Lab', 'Kept the previous feature sets.', 'info', 4000);
});

if (btnLab) btnLab.addEventListener('click', openLabModal);
if (labSearchBtn) labSearchBtn.addEventListener('click', runLabSearch);
if (labBacktestBtn) labBacktestBtn.addEventListener('click', runLabBacktest);
if (labCancelRunBtn) labCancelRunBtn.addEventListener('click', async () => {
  await window.electronAPI.labCancel();
});
if (labResetBtn) labResetBtn.addEventListener('click', async () => {
  try {
    const saved = await labScreeningChannels();
    for (const target of ['direction', 'event']) {
      delete saved[target];
      delete saved[target + 'SavedAt'];
      delete saved[target + 'Auroc'];
    }
    await window.electronAPI.setSetting('screening.channels', saved);
    await renderLabGroups();
    showToast('Model Lab', 'Both feature groups reverted to production defaults.', 'info', 4000);
  } catch (err) {
    showToast('Error', err.message || String(err), 'error', 5000);
  }
});
if (labCloseBtn) labCloseBtn.addEventListener('click', async () => {
  labModal.style.display = 'none';
  await window.electronAPI.hideModal();
});
if (labModal) labModal.addEventListener('click', async (e) => {
  if (e.target === labModal) {
    labModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});
if (window.electronAPI.onLabLog) {
  window.electronAPI.onLabLog((data) => {
    if (labLog && data && data.line) {
      labLog.textContent += data.line + '\n';
      labLog.scrollTop = labLog.scrollHeight;
    }
  });
}
