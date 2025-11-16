// Get DOM elements
const urlBar = document.getElementById('url-bar');
const tickerInput = document.getElementById('ticker-input');
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

// Navigation event handlers
btnBack.addEventListener('click', async () => {
  await window.electronAPI.goBack();
});

btnForward.addEventListener('click', async () => {
  await window.electronAPI.goForward();
});

btnReload.addEventListener('click', async () => {
  await window.electronAPI.reload();
});

// URL bar navigation
urlBar.addEventListener('keypress', async (e) => {
  if (e.key === 'Enter') {
    const url = urlBar.value.trim();
    if (url) {
      setStatus('Navigating...');
      const finalUrl = await window.electronAPI.navigateToUrl(url);
      urlBar.value = finalUrl;
      setStatus('Ready');
    }
  }
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

    // Step 3: Parse manual tickers from input field
    const manualTickersInput = tickerInput.value.trim();
    const manualTickers = manualTickersInput
      ? manualTickersInput.split(/[\s,]+/).map(t => t.toUpperCase()).filter(t => t.length > 0)
      : [];

    // Step 4: Save the article as 'stock_news' with merged tickers
    btnAnalyze.textContent = '💾 Saving...';
    const saveResult = await window.electronAPI.saveArticle('stock_news', manualTickers);

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
      successMsg += ` [${article.tickers.join(', ')}]`;
    }
    if (article.publishedDate) {
      const date = new Date(article.publishedDate);
      successMsg += ` (${date.toLocaleDateString()})`;
    }

    analysisText.textContent = successMsg;
    analysisText.style.color = '#4caf50'; // Green for success
    analysisText.style.display = 'inline';

    // Clear ticker input after successful save
    tickerInput.value = '';

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
    setStatus(`Marking as "Not Good"...`, 'info');

    const result = await window.electronAPI.saveArticle(category);

    if (!result.success) {
      setStatus(`Error: ${result.error}`, 'error');
      return;
    }

    const article = result.article;
    console.log(`✓ Article saved (ID: ${article.id})`, article);

    // Simple status message for 'not_good' articles (no tickers/dates)
    let statusMsg = `✓ Marked as "Not Good": ${article.title}`;

    setStatus(statusMsg, 'success');

    // Update stats
    await updateStats();

  } catch (error) {
    console.error('Error saving article:', error);
    setStatus(`Error: ${error.message}`, 'error');
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

// Helper function to update status bar (no-op since status bar removed)
function setStatus(message, type = 'info') {
  // Status bar has been removed, function kept for compatibility
}

// Settings button handler - navigate to settings page
btnSettings.addEventListener('click', async () => {
  try {
    // Open settings page
    await window.electronAPI.openSettings();
  } catch (error) {
    console.error('Error opening settings:', error);
    setStatus('Error opening settings', 'error');
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

// Initialize
(async () => {
  // Create one tab with finance.yahoo.com
  await createTab('https://finance.yahoo.com');

  setStatus('Ready');

  // Load initial stats
  await updateStats();
})();
