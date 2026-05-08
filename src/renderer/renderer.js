// Get DOM elements
const urlBar = document.getElementById('url-bar');
const tickerInput = document.getElementById('ticker-input');
const allStocksCheckbox = document.getElementById('all-stocks-checkbox');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const btnAnalyze = document.getElementById('btn-analyze');
const btnCountNews = document.getElementById('btn-count-news');
const btnNotGood = document.getElementById('btn-not-good');
const btnSettings = document.getElementById('btn-settings');
const statsText = document.getElementById('stats-text-bottom');
const analysisBar = document.getElementById('analysis-bar');
const analysisText = document.getElementById('analysis-text');
const tabsContainer = document.getElementById('tabs-container');
const btnNewTab = document.getElementById('btn-new-tab');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');
const toastContainer = document.getElementById('toast-container');

// TTS controls
const btnStopTts = document.getElementById('btn-stop-tts');
const btnToggleTts = document.getElementById('btn-toggle-tts');
let ttsEnabled = true;

btnStopTts.addEventListener('click', () => window.electronAPI.stopSpeaking());

btnToggleTts.addEventListener('click', async () => {
  ttsEnabled = !ttsEnabled;
  await window.electronAPI.toggleTts(ttsEnabled);
  btnToggleTts.classList.toggle('tts-disabled', !ttsEnabled);
  btnToggleTts.title = ttsEnabled ? 'TTS enabled (claude.ai)' : 'TTS disabled';
});

window.electronAPI.onTtsStateChanged((data) => {
  btnStopTts.style.display = data.speaking ? 'inline-flex' : 'none';
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') window.electronAPI.stopSpeaking();
});

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

// Auto-analysis debounce timer for "not good" detection
let autoAnalysisTimer = null;
const AUTO_ANALYSIS_DELAY = 2500; // Wait 2.5s after page load before analyzing (increased for snappier navigation)

// Navigation velocity tracking - skip analysis during rapid browsing
const navigationHistory = [];
const MAX_NAV_HISTORY = 5;
const NAV_COOLDOWN = 5000; // 5 seconds

// Quick check if URL is worth analyzing (skip homepages, search pages, etc.)
function shouldAttemptAnalysis(url) {
  if (!url || !url.startsWith('http')) return false;
  try {
    const urlObj = new URL(url);
    // Skip homepages
    if (urlObj.pathname === '/' || urlObj.pathname === '') return false;
    // Skip search pages
    if (urlObj.search.includes('q=') || urlObj.pathname.includes('/search')) return false;
    // Skip known search engines
    if (urlObj.hostname.includes('duckduckgo') || urlObj.hostname.includes('google.com')) return false;
    // Skip common non-article paths
    if (/^\/(login|signup|account|cart|checkout|settings)/i.test(urlObj.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// Automatically analyze page for "not good" similarity when navigating
async function autoAnalyzeForNotGood() {
  // Quick rejection based on URL
  const tab = tabs.get(currentTabId);
  if (!tab || !shouldAttemptAnalysis(tab.url)) {
    analysisText.style.display = 'none';
    return;
  }

  try {
    const result = await window.electronAPI.analyzePage();

    if (!result.success || result.skipped) {
      // Clear any previous warning
      analysisText.style.display = 'none';
      return;
    }

    // Filter for "not_good" matches only
    const notGoodMatches = (result.matches || []).filter(m => m.category === 'not_good');

    if (notGoodMatches.length > 0) {
      const topMatch = notGoodMatches[0];
      const similarityPercent = (topMatch.similarity * 100).toFixed(0);

      // Always show similarity to "not good" content
      analysisText.textContent = `${similarityPercent}% similar to "Not Good": ${topMatch.title.substring(0, 40)}${topMatch.title.length > 40 ? '...' : ''}`;
      analysisText.style.color = '#333333'; // Black
      analysisText.style.display = 'inline';
    } else {
      // No "not good" matches - clear any warning
      analysisText.style.display = 'none';
    }
  } catch (error) {
    console.error('Auto-analysis error:', error);
    analysisText.style.display = 'none';
  }
}

// Debounced version of auto-analysis with velocity tracking
function scheduleAutoAnalysis() {
  // Clear any pending analysis
  if (autoAnalysisTimer) {
    clearTimeout(autoAnalysisTimer);
  }

  // Track navigation velocity
  const now = Date.now();
  navigationHistory.push(now);
  if (navigationHistory.length > MAX_NAV_HISTORY) navigationHistory.shift();

  // Skip analysis if navigating too fast (more than 3 navigations in 5 seconds)
  const recentNavs = navigationHistory.filter(t => now - t < NAV_COOLDOWN);
  if (recentNavs.length > 3) return;

  // Schedule analysis after delay, using idle callback for better performance
  autoAnalysisTimer = setTimeout(() => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => autoAnalyzeForNotGood(), { timeout: 5000 });
    } else {
      autoAnalyzeForNotGood();
    }
  }, AUTO_ANALYSIS_DELAY);
}

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

// Save article as 'stock_news' with similarity analysis first
async function saveStockNews() {
  try {
    // Step 1: Extract article data to show tickers
    btnAnalyze.disabled = true;
    btnAnalyze.textContent = '⏳ Extracting...';
    analysisText.textContent = 'Extracting article data...';
    analysisText.style.color = '#999999';
    analysisText.style.display = 'inline';

    const articleData = await window.electronAPI.downloadText();

    if (articleData.error) {
      analysisText.textContent = `Error: ${articleData.error}`;
      analysisText.style.color = '#f44336';
      analysisText.style.display = 'inline';
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = '📈 Save Stock News';
      return;
    }

    // Show extracted tickers
    const autoTickers = articleData.tickers || [];
    if (autoTickers.length > 0) {
      analysisText.textContent = `Found tickers: ${autoTickers.join(', ')}`;
      analysisText.style.color = '#2196f3'; // Blue for info
      analysisText.style.display = 'inline';
    } else {
      analysisText.textContent = 'No tickers found automatically';
      analysisText.style.color = '#ff9800'; // Orange for warning
      analysisText.style.display = 'inline';
    }

    // Step 2: Determine tickers - either "all stocks" or manual/auto tickers
    let tickersToSave;
    if (allStocksCheckbox.checked) {
      // "All stocks" mode - use special marker
      tickersToSave = ['*'];
    } else {
      // Parse manual tickers from input field
      const manualTickersInput = tickerInput.value.trim();
      tickersToSave = manualTickersInput
        ? manualTickersInput.split(/[\s,]+/).map(t => t.toUpperCase()).filter(t => t.length > 0)
        : [];
    }

    // Step 3: Save the article as 'stock_news' with tickers
    btnAnalyze.textContent = '💾 Saving...';
    const saveResult = await window.electronAPI.saveArticle('stock_news', tickersToSave);

    if (!saveResult.success) {
      analysisText.textContent = `Error saving: ${saveResult.error}`;
      analysisText.style.color = '#f44336';
      analysisText.style.display = 'inline';
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = '📈 Save Stock News';
      return;
    }

    // Build success message with final tickers and date
    const article = saveResult.article;
    let successMsg = `✓ Saved: ${article.title}`;
    if (article.tickers && article.tickers.length > 0) {
      // Show "All Stocks" instead of "*"
      const tickerDisplay = article.tickers.includes('*') ? 'All Stocks' : article.tickers.join(', ');
      successMsg += ` [${tickerDisplay}]`;
    }
    if (article.publishedDate) {
      const date = new Date(article.publishedDate);
      successMsg += ` (${date.toLocaleDateString()})`;
    }

    analysisText.textContent = successMsg;
    analysisText.style.color = '#4caf50'; // Green for success
    analysisText.style.display = 'inline';

    // Show toast notification
    const tickerDisplay = article.tickers?.includes('*') ? 'All Stocks' : (article.tickers?.join(', ') || 'No tickers');
    showToast('Article Saved', `${article.title.substring(0, 50)}${article.title.length > 50 ? '...' : ''} [${tickerDisplay}]`, 'success');

    // Clear inputs after successful save
    tickerInput.value = '';
    allStocksCheckbox.checked = false;

    // Update stats
    await updateStats();

    // Re-enable button
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = '📈 Save Stock News';

  } catch (error) {
    console.error('Error saving stock news:', error);
    analysisText.textContent = `Error: ${error.message}`;
    analysisText.style.color = '#f44336';
    analysisText.style.display = 'inline';
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = '📈 Save Stock News';
  }
}

// Display similarity results in analysis bar
function displaySimilarityResults(matches) {
  if (!matches || matches.length === 0) {
    analysisText.textContent = '✓ Analysis complete: No similar pages found (unique content)';
    analysisText.style.color = '#4caf50'; // Green for unique
    analysisText.style.display = 'inline';
    return;
  }

  const topMatch = matches[0];
  const similarityPercent = (topMatch.similarity * 100).toFixed(1);
  const matchCategory = topMatch.category === 'good' ? 'Good' : 'Not Good';

  let message = `✓ Analysis complete: ${similarityPercent}% similar to "${topMatch.title}" (${matchCategory})`;

  // Show all top matches if there are multiple
  if (matches.length > 1) {
    const otherMatches = matches.slice(1, 3).map(m =>
      `${(m.similarity * 100).toFixed(1)}% ${m.category === 'good' ? 'Good' : 'Not Good'}`
    ).join(', ');
    message += ` | Others: ${otherMatches}`;
  }

  analysisText.textContent = message;
  analysisText.style.color = topMatch.similarity > 0.7 ? '#ff9800' : '#9c27b0'; // Orange for high similarity
  analysisText.style.display = 'inline';
}

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
          analysisText.style.display = 'none';
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

  // Auto-analysis disabled - embedding model comparison not currently in use
  // if (tabId === currentTabId && url.startsWith('http')) {
  //   scheduleAutoAnalysis();
  // }
});

// New tab button
btnNewTab.addEventListener('click', async () => {
  await createTab();
});

// Save article as "Not Good" (similarity already shown from auto-analysis)
async function saveArticle(category) {
  try {
    const result = await window.electronAPI.saveArticle(category);

    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }

    const article = result.article;
    console.log(`✓ Article saved (ID: ${article.id})`, article);

    // Show toast notification
    showToast('Marked as Not Good', `${article.title.substring(0, 50)}${article.title.length > 50 ? '...' : ''}`, 'info');

    // Update stats
    await updateStats();

  } catch (error) {
    console.error('Error saving article:', error);
    showToast('Error', error.message, 'error');
  }
}

btnNotGood.addEventListener('click', async () => {
  await saveArticle('not_good');
});

// Save Stock News button - analyze similarity then save with tickers/dates
btnAnalyze.addEventListener('click', async () => {
  await saveStockNews();
});

// Count News button - record article count on current page
btnCountNews.addEventListener('click', async () => {
  await recordNewsCount();
});

// Record news count from current page
async function recordNewsCount() {
  try {
    btnCountNews.disabled = true;
    btnCountNews.textContent = '⏳ Counting...';
    analysisText.textContent = 'Counting articles...';
    analysisText.style.color = '#999999';
    analysisText.style.display = 'inline';

    const result = await window.electronAPI.recordNewsCount();

    if (!result.success) {
      analysisText.textContent = `Error: ${result.error}`;
      analysisText.style.color = '#f44336';
      analysisText.style.display = 'inline';
      btnCountNews.disabled = false;
      btnCountNews.textContent = '📊 Count News';
      return;
    }

    // Display success with ticker and count
    const date = new Date(result.recordedAt).toLocaleDateString();
    analysisText.textContent = `✓ Recorded ${result.count} articles for ${result.ticker} (${date})`;
    analysisText.style.color = '#5e35b1'; // Purple to match button
    analysisText.style.display = 'inline';

    console.log(`✓ News count saved: ${result.ticker} = ${result.count} articles`);

    btnCountNews.disabled = false;
    btnCountNews.textContent = '📊 Count News';
  } catch (error) {
    console.error('Error recording news count:', error);
    analysisText.textContent = `Error: ${error.message}`;
    analysisText.style.color = '#f44336';
    analysisText.style.display = 'inline';
    btnCountNews.disabled = false;
    btnCountNews.textContent = '📊 Count News';
  }
}

// Update statistics display
async function updateStats() {
  try {
    const stats = await window.electronAPI.getStats();
    if (!stats.error) {
      statsText.textContent = `Not Good: ${stats.not_good}`;
    }
  } catch (error) {
    console.error('Error updating stats:', error);
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

async function refreshSuperFavoritesDisplay() {
  const wrap = document.getElementById('super-favorites-display');
  const chips = document.getElementById('super-favorites-chips');
  const countEl = document.getElementById('super-favorites-count');
  if (!wrap || !chips) return;
  try {
    const result = await window.electronAPI.getFavorites();
    const supers = (result && result.superFavorites) || [];
    if (supers.length === 0) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    countEl.textContent = '(' + supers.length + ')';
    chips.innerHTML = supers
      .slice()
      .sort()
      .map(t => '<span style="padding: 2px 8px; background: #2f1518; color: #ef9a9a; border: 1px solid #5a2a2e; border-radius: 4px; font-size: 11px; font-weight: 500;">' + t + '</span>')
      .join('');
  } catch (_) {
    wrap.style.display = 'none';
  }
}

btnScreen.addEventListener('click', async () => {
  await window.electronAPI.showModal();
  screenModal.style.display = 'flex';
  screenPeriod.value = '100';
  screenLookbackDays.value = '5';
  screenPercentile.value = '92';
  screenPeriod.focus();
  populateScreeningRuns();
  refreshSuperFavoritesDisplay();
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

// Revise the 100 button
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
      <div class="toast-title">Revising the 50</div>
      <div class="toast-message">Analyzing ~200 tickers, ~3-4 minutes...</div>
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

    showToast('Revision Complete', `Selected ${result.tickers.length} tickers from ${result.totalScored} scored`, 'success');
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

    return `<tr${rowStyle}>
      <td data-v="${d.ticker}" style="font-weight:bold;">${d.ticker}</td>
      <td data-v="${statusOrder}" style="color:${st.color}; font-weight:bold;">${st.label}</td>
      <td data-v="${d.revenueGrowth || 0}">${d.revenueGrowth != null ? (d.revenueGrowth * 100).toFixed(1) + '%' : '—'}</td>
      <td data-v="${d.equityGrowth || 0}">${d.equityGrowth != null ? (d.equityGrowth * 100).toFixed(1) + '%' : '—'}</td>
      <td data-v="${d.debtToEquity || 0}">${d.debtToEquity != null ? d.debtToEquity.toFixed(0) : '—'}</td>
      <td data-v="${d.leverageFactor || 0}">${d.leverageFactor != null ? d.leverageFactor.toFixed(3) : '—'}</td>
      <td data-v="${d.score || 0}">${d.score != null && d.score >= 0 ? (d.score * 100).toFixed(2) : '—'}</td>
      <td data-v="${d.avgVolume || 0}" style="text-align:right;">${d.avgVolume ? (d.avgVolume / 1e6).toFixed(1) + 'M' : '—'}</td>
      <td data-v="${d.marketCap || 0}" style="text-align:right;">${fmtCap(d.marketCap)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Revise the 100 — Results</title>
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
<h1>Revise the 100 — All Tickers</h1>
<p class="summary">${nTotal} tickers analyzed${timestamp ? ' on ' + timestamp : ''}. ${selectedSet.size} selected for screening.</p>

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
  <th>Rev Growth<span class="sort-arrow"></span></th>
  <th>Eq Growth<span class="sort-arrow"></span></th>
  <th>D/E<span class="sort-arrow"></span></th>
  <th>Lev Factor<span class="sort-arrow"></span></th>
  <th>Score<span class="sort-arrow"></span></th>
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
  const overrideRaw = document.getElementById('screen-override-tickers').value.trim();
  const overrideTickers = overrideRaw
    ? overrideRaw.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
    : null;
  const fetchNews = document.getElementById('screen-fetch-news').checked;
  const favoritesOnly = document.getElementById('screen-favorites-only').checked;
  const superOnly = document.getElementById('screen-super-only').checked;

  screenModal.style.display = 'none';
  await window.electronAPI.hideModal();

  const tickerCount = overrideTickers ? overrideTickers.length : (superOnly ? 'super favorites' : (favoritesOnly ? 'favorites' : 'all'));
  const screenBtn = document.getElementById('btn-screen');
  const screenBtnOriginal = screenBtn.textContent;
  screenBtn.classList.add('is-loading');
  screenBtn.disabled = true;
  screenBtn.textContent = `Screening ${tickerCount}...`;

  try {
    const result = await window.electronAPI.screenTickers({ period, lookbackDays, percentileThreshold, overrideTickers, fetchNews, favoritesOnly, superOnly });

    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }

    await createTab('file://' + result.filePath);
    showToast('Screening Complete', `Found ${result.hitCount} hit${result.hitCount !== 1 ? 's' : ''}`, 'success');
  } catch (error) {
    console.error('Screening error:', error);
    showToast('Error', error.message, 'error');
  } finally {
    screenBtn.classList.remove('is-loading');
    screenBtn.disabled = false;
    screenBtn.textContent = screenBtnOriginal;
  }
});

// ===== Flowstate Analysis =====

const btnFlowstate = document.getElementById('btn-flowstate');
const fsModal = document.getElementById('flowstate-modal');
const fsCancel = document.getElementById('flowstate-cancel');
const fsRun = document.getElementById('flowstate-run');
const fsTickers = document.getElementById('flowstate-tickers');
const fsContext = document.getElementById('flowstate-context');
const fsBand = document.getElementById('flowstate-band');
const fsMode = document.getElementById('flowstate-mode');
const fsNDaysField = document.getElementById('flowstate-backtest-days-field');
const fsNDays = document.getElementById('flowstate-ndays');
const fsResults = document.getElementById('flowstate-results');

btnFlowstate.addEventListener('click', async () => {
  await window.electronAPI.showModal();
  fsModal.style.display = 'flex';
  fsResults.style.display = 'none';
});

fsCancel.addEventListener('click', async () => {
  fsModal.style.display = 'none';
  await window.electronAPI.hideModal();
});

fsModal.addEventListener('click', async (e) => {
  if (e.target === fsModal) {
    fsModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});

fsMode.addEventListener('change', () => {
  fsNDaysField.style.display = fsMode.value === 'backtest' ? '' : 'none';
});

fsRun.addEventListener('click', async () => {
  const tickersRaw = (fsTickers.value || '').trim();
  if (!tickersRaw) {
    showToast('Flowstate', 'Enter at least one ticker', 'error');
    return;
  }
  const tickers = tickersRaw.split(/[,\s]+/).map(t => t.toUpperCase()).filter(Boolean);
  const contextDays = parseInt(fsContext.value);
  const [qLowIdx, qHighIdx] = fsBand.value.split(',').map(Number);
  const mode = fsMode.value;

  fsRun.disabled = true;
  fsRun.textContent = 'Running...';
  fsResults.style.display = 'none';

  try {
    if (mode === 'forecast') {
      const result = await window.electronAPI.runFlowstateForecast({ tickers, contextDays, qLowIdx, qHighIdx });
      if (!result.success) { showToast('Flowstate Error', result.error, 'error'); return; }
      renderFlowstateForecast(result);
    } else {
      if (tickers.length !== 1) {
        showToast('Flowstate', 'Backtest mode takes a single ticker', 'error');
        return;
      }
      const nDays = parseInt(fsNDays.value);
      const result = await window.electronAPI.runFlowstateBacktest({ ticker: tickers[0], contextDays, nDays, qLowIdx, qHighIdx });
      if (!result.success) { showToast('Flowstate Error', result.error, 'error'); return; }
      renderFlowstateBacktest(result);
    }
  } catch (error) {
    showToast('Flowstate Error', error.message, 'error');
  } finally {
    fsRun.disabled = false;
    fsRun.textContent = 'Run';
  }
});

function renderFlowstateForecast(result) {
  const { forecasts, skipped, params } = result;
  const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
  const pct = (x, d = 2) => (x == null ? '—' : (Number(x) * 100).toFixed(d) + '%');
  const skippedHtml = skipped && skipped.length
    ? `<div style="color:#888; font-size:0.85em; margin-bottom:8px;">Skipped: ${skipped.map(s => `${s.ticker} (${s.reason})`).join(', ')}</div>`
    : '';
  const rows = forecasts.map(f => {
    if (f.error) return `<tr><td><strong>${f.ticker}</strong></td><td colspan="6" style="color:#f44336;">${f.error}</td></tr>`;
    const dirColor = f.medianReturnPct > 0 ? '#4caf50' : f.medianReturnPct < 0 ? '#f44336' : '#333';
    return `<tr>
      <td><strong>${f.ticker}</strong></td>
      <td>${f.asOf}</td>
      <td>${fmt(f.lastClose)}</td>
      <td style="color:#f44336;">${fmt(f.low)}</td>
      <td style="color:${dirColor}; font-weight:600;">${fmt(f.median)}</td>
      <td style="color:#4caf50;">${fmt(f.high)}</td>
      <td style="color:${dirColor};">${pct(f.medianReturnPct)}</td>
      <td>${pct(f.bandPct)}</td>
    </tr>`;
  }).join('');
  fsResults.innerHTML = `
    <div style="margin-bottom: 8px; padding: 10px; background: #f9f9f9; border-radius: 6px; font-size: 0.9em;">
      <strong>${params.model}</strong> @ ${params.revision} · ${params.device} · context=${params.contextDays}d ·
      band=q${(params.qLowLevel*100).toFixed(0)}/q${(params.qHighLevel*100).toFixed(0)}
    </div>
    ${skippedHtml}
    <table class="glm-table">
      <thead><tr><th>Ticker</th><th>As of</th><th>Last close</th><th>Low</th><th>Median</th><th>High</th><th>Median Δ%</th><th>Band width</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  fsResults.style.display = 'block';
}

function renderFlowstateBacktest(result) {
  const { ticker, nDays, mae, rmse, maePct, coverage, nominalCoverage, directionalHitRate, days, qLowLevel, qHighLevel } = result;
  const covColor = Math.abs(coverage - nominalCoverage) < 0.1 ? '#4caf50' : '#ff9800';
  const hitColor = directionalHitRate == null ? '#888' : directionalHitRate > 0.5 ? '#4caf50' : '#f44336';
  const fmt = (x, d = 3) => (x == null ? '—' : Number(x).toFixed(d));
  const rows = days.map(d => {
    const errColor = Math.abs(d.error) < (mae * 0.5) ? '#4caf50' : Math.abs(d.error) > (mae * 1.5) ? '#f44336' : '#333';
    const bandColor = d.inBand ? '#4caf50' : '#f44336';
    const dirOk = d.realizedDir === d.predDir;
    return `<tr>
      <td>${d.date}</td>
      <td>${fmt(d.prevClose, 2)}</td>
      <td>${fmt(d.realized, 2)}</td>
      <td style="color:#f44336;">${fmt(d.low, 2)}</td>
      <td>${fmt(d.median, 2)}</td>
      <td style="color:#4caf50;">${fmt(d.high, 2)}</td>
      <td style="color:${errColor};">${fmt(d.error, 3)}</td>
      <td style="color:${bandColor};">${d.inBand ? '✓' : '✗'}</td>
      <td style="color:${dirOk ? '#4caf50' : '#f44336'};">${d.predDir} / ${d.realizedDir}</td>
    </tr>`;
  }).join('');
  fsResults.innerHTML = `
    <div style="margin-bottom: 12px; padding: 10px; background: #f9f9f9; border-radius: 6px;">
      <strong>${ticker} — ${nDays}-day walk-forward</strong><br>
      MAE: <strong>${fmt(mae, 3)}</strong> (${(maePct * 100).toFixed(2)}% of last close) ·
      RMSE: ${fmt(rmse, 3)} ·
      Band coverage: <span style="color:${covColor}; font-weight:600;">${(coverage * 100).toFixed(1)}%</span> (nominal ${(nominalCoverage * 100).toFixed(0)}%, q${(qLowLevel*100).toFixed(0)}–q${(qHighLevel*100).toFixed(0)}) ·
      Directional hit-rate: <span style="color:${hitColor}; font-weight:600;">${directionalHitRate == null ? 'n/a' : (directionalHitRate * 100).toFixed(1) + '%'}</span>
    </div>
    <details>
      <summary style="cursor: pointer; font-weight: 600;">Per-day predictions (${days.length})</summary>
      <table class="glm-table" style="margin-top: 8px;">
        <thead><tr><th>Date</th><th>Prev close</th><th>Realized</th><th>Low</th><th>Median</th><th>High</th><th>Err</th><th>In band</th><th>Pred / Real dir</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  fsResults.style.display = 'block';
}

// Initialize
(async () => {
  // Tab creation doesn't require DB — start it immediately.
  // Open simplywall.st first (active by default), then claude.ai and lichess.org,
  // and switch back to simplywall.st so it remains the focused tab on startup.
  const simplywallTabId = await createTab('https://simplywall.st/dashboard');
  await createTab('https://claude.ai');
  await createTab('https://lichess.org');
  await switchTab(simplywallTabId);

  // Stats require DB — wait for backend readiness
  await window.electronAPI.waitBackendReady();
  await updateStats();
})();
