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
const btnAnalyzeEvents = document.getElementById('btn-analyze-events');
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

// Modal elements
const analysisModal = document.getElementById('analysis-modal');
const analysisTickerInput = document.getElementById('analysis-ticker-input');
const analysisBenchmarkInput = document.getElementById('analysis-benchmark-input');
const analysisDaysInput = document.getElementById('analysis-days-input');
const analysisEventsInput = document.getElementById('analysis-events-input');
const analysisFetchNewsCheckbox = document.getElementById('analysis-fetch-news');
const analysisAddWatchlistCheckbox = document.getElementById('analysis-add-watchlist');
const modalCancel = document.getElementById('modal-cancel');
const modalAnalyze = document.getElementById('modal-analyze');

// Watchlist elements
const watchlistContainer = document.getElementById('watchlist-container');
const corpusStats = document.getElementById('corpus-stats');
const btnHarvestNow = document.getElementById('btn-harvest-now');
const harvesterStatus = document.getElementById('harvester-status');

// Toast notification function
function showToast(title, message, type = 'success', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

  toastContainer.appendChild(toast);

  // Auto-remove after duration
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, duration);
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

// URL bar navigation
urlBar.addEventListener('keypress', async (e) => {
  if (e.key === 'Enter') {
    const input = urlBar.value.trim();
    if (input) {
      let url;
      if (isUrl(input)) {
        // It's a URL - navigate directly
        url = input;
      } else {
        // It's a search query - use DuckDuckGo
        url = `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
      }

      const finalUrl = await window.electronAPI.navigateToUrl(url);
      urlBar.value = finalUrl;
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
      analysisText.textContent = `Found tickers: ${autoTickers.join(', ')} | Analyzing similarity...`;
      analysisText.style.color = '#2196f3'; // Blue for info
      analysisText.style.display = 'inline';
    } else {
      analysisText.textContent = 'No tickers found automatically | Analyzing similarity...';
      analysisText.style.color = '#ff9800'; // Orange for warning
      analysisText.style.display = 'inline';
    }

    // Step 2: Analyze for similarity
    btnAnalyze.textContent = '⏳ Analyzing...';
    const analysisResult = await window.electronAPI.analyzePage();

    if (analysisResult.skipped) {
      // Internal page (settings, file://, etc.)
      analysisText.style.display = 'none';
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = '📈 Save Stock News';
      return;
    }

    if (!analysisResult.success) {
      analysisText.textContent = `Analysis error: ${analysisResult.error}`;
      analysisText.style.color = '#f44336';
      analysisText.style.display = 'inline';
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = '📈 Save Stock News';
      return;
    }

    // Display similarity results with tickers
    let similarityMsg = '';
    if (analysisResult.matches && analysisResult.matches.length > 0) {
      const topMatch = analysisResult.matches[0];
      const similarityPercent = (topMatch.similarity * 100).toFixed(1);
      similarityMsg = `${similarityPercent}% similar | `;
    }
    analysisText.textContent = similarityMsg + (autoTickers.length > 0
      ? `Tickers: ${autoTickers.join(', ')}`
      : 'No tickers found');
    analysisText.style.color = '#2196f3';
    analysisText.style.display = 'inline';

    // Step 3: Determine tickers - either "all stocks" or manual/auto tickers
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

    // Step 4: Save the article as 'stock_news' with tickers
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

// ===== Stock Event Analysis =====

// ===== Watchlist Management =====

// Load and render the watchlist
async function loadWatchlist() {
  try {
    const result = await window.electronAPI.getWatchedTickers(false);
    if (!result.success) {
      console.error('Error loading watchlist:', result.error);
      return;
    }

    const tickers = result.tickers || [];
    renderWatchlist(tickers);
  } catch (error) {
    console.error('Error loading watchlist:', error);
  }
}

// Render watchlist tickers
function renderWatchlist(tickers) {
  watchlistContainer.innerHTML = '';

  if (tickers.length === 0) {
    watchlistContainer.innerHTML = '<span class="watchlist-empty">No tickers in watchlist</span>';
    return;
  }

  for (const tickerRecord of tickers) {
    const tickerEl = document.createElement('span');
    tickerEl.className = 'watchlist-ticker';

    const tickerName = document.createElement('span');
    tickerName.textContent = tickerRecord.ticker;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-ticker';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${tickerRecord.ticker} from watchlist`;
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      await removeFromWatchlist(tickerRecord.ticker);
    };

    tickerEl.appendChild(tickerName);
    tickerEl.appendChild(removeBtn);
    watchlistContainer.appendChild(tickerEl);
  }
}

// Add ticker to watchlist
async function addToWatchlist(ticker) {
  try {
    const result = await window.electronAPI.addWatchedTicker(ticker.toUpperCase(), true);
    if (result.success) {
      await loadWatchlist();
      return true;
    } else {
      console.error('Error adding to watchlist:', result.error);
      return false;
    }
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    return false;
  }
}

// Remove ticker from watchlist
async function removeFromWatchlist(ticker) {
  try {
    const result = await window.electronAPI.removeWatchedTicker(ticker);
    if (result.success) {
      await loadWatchlist();
      showToast('Removed', `${ticker} removed from watchlist`, 'info', 2000);
    } else {
      console.error('Error removing from watchlist:', result.error);
    }
  } catch (error) {
    console.error('Error removing from watchlist:', error);
  }
}

// Load corpus stats
async function loadCorpusStats() {
  try {
    const result = await window.electronAPI.getCorpusStats();
    if (result.success && result.stats) {
      const stats = result.stats;
      if (stats.totalStockNews > 0) {
        corpusStats.textContent = `${stats.totalStockNews} articles | ${stats.dateSpanDays}d span`;
      } else {
        corpusStats.textContent = 'No articles yet';
      }
    }
  } catch (error) {
    console.error('Error loading corpus stats:', error);
    corpusStats.textContent = '';
  }
}

// Load harvester status
async function loadHarvesterStatus() {
  try {
    const result = await window.electronAPI.getHarvesterStatus();
    if (result.success) {
      if (result.isRunning) {
        harvesterStatus.textContent = 'Auto-harvest: ON';
        harvesterStatus.style.color = '#4caf50';
      } else if (result.lastHarvestTime) {
        const lastTime = new Date(result.lastHarvestTime);
        harvesterStatus.textContent = `Last: ${lastTime.toLocaleTimeString()}`;
      } else {
        harvesterStatus.textContent = '';
      }
    }
  } catch (error) {
    console.error('Error loading harvester status:', error);
  }
}

// Harvest now button handler
btnHarvestNow.addEventListener('click', async () => {
  try {
    btnHarvestNow.disabled = true;
    btnHarvestNow.textContent = '⏳ Harvesting...';
    harvesterStatus.textContent = 'Collecting news...';

    const result = await window.electronAPI.triggerHarvest();

    if (result.success) {
      const r = result.results;
      showToast('Harvest Complete', `${r.articlesNew} new articles collected`, 'success');
      harvesterStatus.textContent = `Done: ${r.articlesNew} new`;
      await loadCorpusStats();
    } else {
      showToast('Harvest Failed', result.error, 'error');
      harvesterStatus.textContent = 'Failed';
    }
  } catch (error) {
    console.error('Error triggering harvest:', error);
    showToast('Error', error.message, 'error');
    harvesterStatus.textContent = 'Error';
  } finally {
    btnHarvestNow.disabled = false;
    btnHarvestNow.textContent = '🔄 Harvest Now';
  }
});

// Show modal when button clicked
btnAnalyzeEvents.addEventListener('click', async () => {
  await window.electronAPI.showModal();
  analysisModal.style.display = 'flex';
  analysisTickerInput.value = '';
  analysisBenchmarkInput.value = 'SPY';
  analysisDaysInput.value = '1700';
  analysisEventsInput.value = '15';
  analysisFetchNewsCheckbox.checked = true;
  analysisAddWatchlistCheckbox.checked = true;
  analysisTickerInput.focus();

  // Load watchlist and stats when modal opens
  await Promise.all([
    loadWatchlist(),
    loadCorpusStats(),
    loadHarvesterStatus()
  ]);
});

// Cancel modal
modalCancel.addEventListener('click', async () => {
  analysisModal.style.display = 'none';
  await window.electronAPI.hideModal();
});

// Close modal on background click
analysisModal.addEventListener('click', async (e) => {
  if (e.target === analysisModal) {
    analysisModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});

// Handle Enter key in input
analysisTickerInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    modalAnalyze.click();
  } else if (e.key === 'Escape') {
    analysisModal.style.display = 'none';
    await window.electronAPI.hideModal();
  }
});

// Run analysis
modalAnalyze.addEventListener('click', async () => {
  const ticker = analysisTickerInput.value.trim();
  if (!ticker) {
    analysisTickerInput.focus();
    return;
  }

  const upperTicker = ticker.toUpperCase();
  const benchmark = (analysisBenchmarkInput.value.trim() || 'SPY').toUpperCase();
  const days = parseInt(analysisDaysInput.value, 10) || 1700;
  const minEvents = parseInt(analysisEventsInput.value, 10) || 15;
  const fetchNews = analysisFetchNewsCheckbox.checked;
  const addToWatchlistChecked = analysisAddWatchlistCheckbox.checked;

  analysisModal.style.display = 'none';
  await window.electronAPI.hideModal();

  // Add to watchlist if checkbox is checked
  if (addToWatchlistChecked) {
    const added = await addToWatchlist(upperTicker);
    if (added) {
      showToast('Watchlist', `${upperTicker} added to watchlist`, 'info', 2000);
    }
  }

  try {
    const fetchNewsMsg = fetchNews ? ' Fetching news articles...' : '';
    showToast('Analyzing...', `Running event analysis for ${upperTicker} vs ${benchmark}.${fetchNewsMsg} This may take a minute...`, 'info', fetchNews ? 60000 : 10000);

    const result = await window.electronAPI.analyzeStockEvents(upperTicker, {
      benchmark,
      days,
      minEvents,
      fetchNews
    });

    if (!result.success) {
      showToast('Error', result.error, 'error');
      return;
    }

    // Open results in new tab using data URL
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(result.html);
    await createTab(dataUrl);

    showToast('Analysis Complete', `Found ${result.eventCount} events for ${upperTicker}`, 'success');

  } catch (error) {
    console.error('Error analyzing stock:', error);
    showToast('Error', error.message, 'error');
  }
});

// Initialize
(async () => {
  // Create one tab with finance.yahoo.com
  await createTab('https://finance.yahoo.com');

  // Load initial stats
  await updateStats();
})();
