// Get DOM elements
const urlBar = document.getElementById('url-bar');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const btnNotGood = document.getElementById('btn-not-good');
const btnSettings = document.getElementById('btn-settings');
const statusText = document.getElementById('status-text');
const statsText = document.getElementById('stats-text');
const similarityDisplay = document.getElementById('similarity-display');
const similarityText = document.getElementById('similarity-text');
const tabsContainer = document.getElementById('tabs-container');
const btnNewTab = document.getElementById('btn-new-tab');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');
const tickerInput = document.getElementById('ticker-input');
const btnScrapeTicker = document.getElementById('btn-scrape-ticker');

// Tab management
let currentTabId = null;
const tabs = new Map(); // tabId -> {element, title, url}

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

// Automatically analyze page for similarity
async function analyzeCurrentPage() {
  try {
    setStatus('Analyzing page...', 'info');

    const result = await window.electronAPI.analyzePage();

    if (result.skipped) {
      // Internal page (settings, file://, etc.)
      similarityDisplay.style.display = 'none';
      setStatus('Ready');
      return;
    }

    if (!result.success) {
      setStatus(`Analysis error: ${result.error}`, 'error');
      similarityDisplay.style.display = 'none';
      return;
    }

    // Display similarity results
    displaySimilarityResults(result.matches);
    setStatus('Ready');

  } catch (error) {
    console.error('Error analyzing page:', error);
    setStatus(`Error: ${error.message}`, 'error');
    similarityDisplay.style.display = 'none';
  }
}

// Display similarity results inline
function displaySimilarityResults(matches) {
  if (!matches || matches.length === 0) {
    similarityText.textContent = 'No similar pages found (unique content)';
    similarityText.style.color = '#4caf50'; // Green for unique
    similarityDisplay.style.display = 'block';
    return;
  }

  const topMatch = matches[0];
  const similarityPercent = (topMatch.similarity * 100).toFixed(1);
  const matchCategory = topMatch.category === 'good' ? 'Good' : 'Not Good';

  let message = `⚠️ ${similarityPercent}% similar to "${topMatch.title}" (${matchCategory})`;

  // Show all top matches if there are multiple
  if (matches.length > 1) {
    const otherMatches = matches.slice(1, 3).map(m =>
      `${(m.similarity * 100).toFixed(1)}% ${m.category === 'good' ? 'Good' : 'Not Good'}`
    ).join(', ');
    message += ` | Others: ${otherMatches}`;
  }

  similarityText.textContent = message;
  similarityText.style.color = topMatch.similarity > 0.7 ? '#ff9800' : '#9c27b0'; // Orange for high similarity
  similarityDisplay.style.display = 'block';
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

  updateTabUrl(tabId, url);
  if (title) {
    updateTabTitle(tabId, title);
  }
  if (tabId === currentTabId) {
    urlBar.value = url;

    // Automatically analyze the page for similarity
    await analyzeCurrentPage();
  }
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

    setStatus(`✓ Marked as "Not Good": ${article.title}`, 'success');

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

// Helper function to update status bar
function setStatus(message, type = 'info') {
  statusText.textContent = message;
  statusText.className = '';

  if (type === 'success') {
    statusText.classList.add('status-success');
  } else if (type === 'error') {
    statusText.classList.add('status-error');
  }
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

// Ticker scraping functionality
btnScrapeTicker.addEventListener('click', async () => {
  const ticker = tickerInput.value.trim().toUpperCase();

  if (!ticker) {
    setStatus('Please enter a ticker symbol', 'error');
    return;
  }

  try {
    btnScrapeTicker.disabled = true;
    btnScrapeTicker.textContent = '⏳ Scraping...';
    setStatus(`Scraping press releases for ${ticker}...`, 'info');

    const result = await window.electronAPI.scrapeTickerPressReleases(ticker, 5);

    if (!result.success) {
      setStatus(`Error: ${result.error}`, 'error');
      btnScrapeTicker.disabled = false;
      btnScrapeTicker.textContent = '📰 Scrape Press Releases';
      return;
    }

    setStatus(
      `✓ Scraped ${result.saved}/${result.total} press releases for ${ticker}`,
      'success'
    );

    // Update stats
    await updateStats();

    // Clear ticker input
    tickerInput.value = '';

    btnScrapeTicker.disabled = false;
    btnScrapeTicker.textContent = '📰 Scrape Press Releases';
  } catch (error) {
    console.error('Error scraping ticker:', error);
    setStatus(`Error: ${error.message}`, 'error');
    btnScrapeTicker.disabled = false;
    btnScrapeTicker.textContent = '📰 Scrape Press Releases';
  }
});

// Allow Enter key in ticker input
tickerInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    btnScrapeTicker.click();
  }
});

// Listen for scrape progress updates
window.electronAPI.onScrapeProgress((progress) => {
  setStatus(
    `Scraping ${progress.ticker}: ${progress.current}/${progress.total} - ${progress.linkText.substring(0, 60)}...`,
    'info'
  );
});

// Initialize
(async () => {
  // Create three tabs with news.google.com
  await createTab('https://news.google.com');
  await createTab('https://news.google.com');
  await createTab('https://news.google.com');

  setStatus('Ready');

  // Load initial stats
  await updateStats();
})();
