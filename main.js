const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const ArticleDatabase = require('./src/services/database');
const nativeTabScraper = require('./src/services/nativeTabScraper');

let mainWindow;
let database;

// Tab management
const tabs = new Map(); // tabId -> BrowserView
let activeTabId = null;
let nextTabId = 1;

function createWindow() {
  // Create the main application window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false, // Remove default title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Load the control UI
  mainWindow.loadFile('src/renderer/index.html');

  // Update browser view bounds when window resizes
  mainWindow.on('resize', () => {
    if (activeTabId) {
      const browserView = tabs.get(activeTabId);
      updateBrowserViewBounds(browserView);
    }
  });

  // Also handle maximize/unmaximize events
  mainWindow.on('maximize', () => {
    if (activeTabId) {
      updateBrowserViewBounds(tabs.get(activeTabId));
    }
  });

  mainWindow.on('unmaximize', () => {
    if (activeTabId) {
      updateBrowserViewBounds(tabs.get(activeTabId));
    }
  });

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

// Position the browser view (leave space for tab bar + toolbar at top)
function updateBrowserViewBounds(browserView) {
  if (!browserView || !mainWindow) return;

  const { width, height } = mainWindow.getContentBounds();

  // Log for debugging
  console.log(`Updating browser view bounds: ${width}x${height}, content area: ${width}x${height - 116}`);

  browserView.setBounds({
    x: 0,
    y: 116, // Space for tab bar (36px) + toolbar (60px) + status bar (20px)
    width: width,
    height: height - 116
  });
}

// Create a new tab
function createTab(url = 'https://news.google.com') {
  const tabId = nextTabId++;

  const browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  tabs.set(tabId, browserView);

  // Update URL bar when navigation happens
  browserView.webContents.on('did-navigate', (event, url) => {
    const title = browserView.webContents.getTitle();
    mainWindow.webContents.send('url-changed', { tabId, url, title });
  });

  browserView.webContents.on('did-navigate-in-page', (event, url) => {
    const title = browserView.webContents.getTitle();
    mainWindow.webContents.send('url-changed', { tabId, url, title });
  });

  browserView.webContents.on('page-title-updated', (event, title) => {
    const url = browserView.webContents.getURL();
    mainWindow.webContents.send('url-changed', { tabId, url, title });
  });

  // Handle links that try to open in new windows - open them in new tabs instead
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    // Create a new tab with the URL and switch to it
    const newTabId = createTab(url);
    switchTab(newTabId);

    // Notify the renderer about the new tab
    mainWindow.webContents.send('tab-created', { tabId: newTabId, url });

    // Prevent the default window from opening
    return { action: 'deny' };
  });

  // Load URL if provided
  if (url) {
    browserView.webContents.loadURL(url);
  }

  return tabId;
}

// Switch to a tab
function switchTab(tabId) {
  const browserView = tabs.get(tabId);
  if (!browserView) return;

  // Remove current browser view
  if (activeTabId) {
    mainWindow.removeBrowserView(tabs.get(activeTabId));
  }

  // Add and position new browser view
  mainWindow.setBrowserView(browserView);
  updateBrowserViewBounds(browserView);

  activeTabId = tabId;
}

// Close a tab
function closeTab(tabId) {
  const browserView = tabs.get(tabId);
  if (!browserView) return;

  // Remove from window if it's active
  if (activeTabId === tabId) {
    mainWindow.removeBrowserView(browserView);
    activeTabId = null;
  }

  // Destroy the browser view
  browserView.webContents.destroy();
  tabs.delete(tabId);
}

// Get active tab's BrowserView
function getActiveBrowserView() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

// IPC Handlers

// Tab management
ipcMain.handle('create-tab', async (event, url) => {
  const tabId = createTab(url);
  switchTab(tabId);
  return tabId;
});

ipcMain.handle('switch-tab', async (event, tabId) => {
  switchTab(tabId);
  return tabId;
});

ipcMain.handle('close-tab', async (event, tabId) => {
  closeTab(tabId);
  return true;
});

// Navigate to URL
ipcMain.handle('navigate-to-url', async (event, url) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;

  // Allow file:// URLs for settings and other internal pages
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    url = 'https://' + url;
  }
  browserView.webContents.loadURL(url);
  return url;
});

// Open settings page
ipcMain.handle('open-settings', async (event) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;

  const path = require('path');
  const settingsPath = path.join(__dirname, 'src', 'renderer', 'settings.html');
  const settingsUrl = `file://${settingsPath}`;
  browserView.webContents.loadURL(settingsUrl);
  return settingsUrl;
});

// Download page text
ipcMain.handle('download-text', async (event) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { error: 'No active tab' };

    const url = browserView.webContents.getURL();
    const title = browserView.webContents.getTitle();

    // Execute JavaScript in the browser view to extract text
    const text = await browserView.webContents.executeJavaScript(`
      document.body.innerText;
    `);

    return {
      url: url,
      title: title,
      text: text,
      wordCount: text.split(/\\s+/).length
    };
  } catch (error) {
    console.error('Error extracting text:', error);
    return { error: error.message };
  }
});

// Get current URL
ipcMain.handle('get-current-url', async (event) => {
  const browserView = getActiveBrowserView();
  if (!browserView) return null;
  return browserView.webContents.getURL();
});

// Navigation controls
ipcMain.handle('go-back', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
});

ipcMain.handle('go-forward', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
});

ipcMain.handle('reload', async (event) => {
  const browserView = getActiveBrowserView();
  if (browserView) {
    browserView.webContents.reload();
  }
});

// Analyze current page (extract text, generate embeddings, check similarity)
// This runs automatically when user navigates to a new page
ipcMain.handle('analyze-page', async (event) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { success: false, error: 'No active tab', matches: [] };

    const url = browserView.webContents.getURL();
    const title = browserView.webContents.getTitle();

    // Skip analysis for internal pages and non-http(s) URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: true, matches: [], skipped: true, reason: 'Internal page' };
    }

    // Extract text from current page
    const text = await browserView.webContents.executeJavaScript(`
      document.body.innerText;
    `);

    // Use title + beginning of text as query (first ~500 chars for speed)
    const queryText = `${title}. ${text.substring(0, 500)}`;

    console.log(`\n🔍 Analyzing page: ${title}`);

    // Search for similar content (top 5 matches, minimum 50% similarity)
    const results = await database.searchBySimilarity(queryText, {
      limit: 5,
      minSimilarity: 0.5
    });

    // Group results by article and get best match per article
    const articleMatches = {};
    for (const result of results) {
      const articleId = result.article_id;
      if (!articleMatches[articleId] || result.similarity > articleMatches[articleId].similarity) {
        articleMatches[articleId] = {
          articleId: result.article_id,
          title: result.article_title,
          category: result.category,
          similarity: result.similarity,
          url: result.article_url
        };
      }
    }

    // Convert to array and sort by similarity
    const topMatches = Object.values(articleMatches)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3); // Return top 3 articles

    if (topMatches.length > 0) {
      console.log(`   Found ${topMatches.length} similar articles`);
      topMatches.forEach((match, i) => {
        console.log(`   ${i + 1}. ${(match.similarity * 100).toFixed(1)}% - ${match.title} (${match.category})`);
      });
    } else {
      console.log(`   No similar articles found (unique content)`);
    }

    return {
      success: true,
      matches: topMatches,
      currentUrl: url,
      currentTitle: title,
      skipped: false
    };
  } catch (error) {
    console.error('Error analyzing page:', error);
    return {
      success: false,
      error: error.message,
      matches: []
    };
  }
});

ipcMain.handle('save-article', async (event, category) => {
  try {
    const browserView = getActiveBrowserView();
    if (!browserView) return { success: false, error: 'No active tab' };

    const url = browserView.webContents.getURL();
    const title = browserView.webContents.getTitle();

    // Execute JavaScript in the browser view to extract text
    const text = await browserView.webContents.executeJavaScript(`
      document.body.innerText;
    `);

    // Save article to database with embedding for full article
    const result = await database.saveArticle(url, title, text, category);
    console.log(`✓ Article saved with full-text embedding (ID: ${result.id}) - ${result.title}`);

    return {
      success: true,
      article: result
    };
  } catch (error) {
    console.error('Error saving article:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Get database statistics
ipcMain.handle('get-stats', async (event) => {
  try {
    const stats = await database.getStats();
    return stats;
  } catch (error) {
    console.error('Error getting stats:', error);
    return { error: error.message };
  }
});

// Get all articles
ipcMain.handle('get-articles', async (event, categoryFilter) => {
  try {
    const articles = await database.getAllArticles(categoryFilter);
    return articles;
  } catch (error) {
    console.error('Error getting articles:', error);
    return { error: error.message };
  }
});

// Settings IPC handlers
ipcMain.handle('get-chunking-settings', async (event) => {
  try {
    const settings = await database.getChunkingSettings();
    return settings;
  } catch (error) {
    console.error('Error getting chunking settings:', error);
    return { error: error.message };
  }
});

ipcMain.handle('save-chunking-settings', async (event, settings) => {
  try {
    await database.setSetting('chunk_size', settings.chunkSize.toString());
    await database.setSetting('chunk_overlap', settings.chunkOverlap.toString());
    await database.setSetting('chunk_strategy', settings.chunkStrategy);
    console.log(`✓ Settings saved: ${settings.chunkSize} tokens, ${settings.chunkOverlap} overlap, ${settings.chunkStrategy} strategy`);
    return { success: true };
  } catch (error) {
    console.error('Error saving chunking settings:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rechunk-all', async (event, chunkSize, overlap, strategy) => {
  try {
    await database.rechunkAllArticles(chunkSize, overlap, strategy);
    return { success: true };
  } catch (error) {
    console.error('Error re-chunking:', error);
    return { success: false, error: error.message };
  }
});

// Clear vectors only
ipcMain.handle('clear-vectors', async (event) => {
  try {
    await database.clearVectors();
    return { success: true };
  } catch (error) {
    console.error('Error clearing vectors:', error);
    return { success: false, error: error.message };
  }
});

// Clear all data
ipcMain.handle('clear-all-data', async (event) => {
  try {
    await database.clearAllData();
    return { success: true };
  } catch (error) {
    console.error('Error clearing all data:', error);
    return { success: false, error: error.message };
  }
});

// Semantic search handler
ipcMain.handle('search-similarity', async (event, query, options) => {
  try {
    const results = await database.searchBySimilarity(query, options);
    return { success: true, results };
  } catch (error) {
    console.error('Error searching:', error);
    return { success: false, error: error.message };
  }
});

// Window control handlers
ipcMain.handle('window-minimize', async (event) => {
  mainWindow.minimize();
});

ipcMain.handle('window-maximize', async (event) => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('window-close', async (event) => {
  mainWindow.close();
});

// Get embedding statistics
ipcMain.handle('get-embedding-stats', async (event) => {
  try {
    const stats = await database.getEmbeddingStats();
    return stats;
  } catch (error) {
    console.error('Error getting embedding stats:', error);
    return { error: error.message };
  }
});

// Scrape news from current page using native tabs
ipcMain.handle('scrape-current-page-news', async (event, topN = 5) => {
  try {
    console.log(`\n🚀 Starting native tab scrape from current page (top ${topN})`);

    const browserView = getActiveBrowserView();
    if (!browserView) {
      return { success: false, error: 'No active tab' };
    }

    const currentUrl = browserView.webContents.getURL();
    const currentTitle = browserView.webContents.getTitle();

    console.log(`   Current page: ${currentTitle}`);
    console.log(`   URL: ${currentUrl}`);

    // Use native tab scraper
    const articles = await nativeTabScraper.scrapeNewsFromCurrentPage({
      currentWebContents: browserView.webContents,
      createTab: (url) => {
        return new Promise((resolve) => {
          const tabId = createTab(url);
          const newBrowserView = tabs.get(tabId);
          resolve({ browserView: newBrowserView, tabId });
        });
      },
      closeTab: (tabId) => {
        return new Promise((resolve) => {
          closeTab(tabId);
          resolve();
        });
      },
      onProgress: (current, total, message) => {
        // Send progress updates to renderer
        mainWindow.webContents.send('scrape-progress', {
          current,
          total,
          message,
          progress: Math.round((current / total) * 100)
        });
        console.log(`   [${current}/${total}] ${message}`);
      },
      topN
    });

    // Save scraped articles to database
    const savedArticles = [];

    for (const article of articles) {
      try {
        // Extract domain from URL for category
        const urlObj = new URL(article.url);
        const domain = urlObj.hostname.replace('www.', '');

        // Save article with domain as category
        const saved = await database.saveArticle(
          article.url,
          article.title,
          article.text,
          `news:${domain}`
        );

        console.log(`✓ Saved: ${saved.title} (ID: ${saved.id})`);

        savedArticles.push({
          id: saved.id,
          title: saved.title,
          url: saved.url
        });
      } catch (error) {
        console.error(`Error saving article ${article.url}:`, error.message);
      }
    }

    console.log(`\n✅ Scraping complete: ${savedArticles.length}/${articles.length} articles saved`);

    return {
      success: true,
      sourceUrl: currentUrl,
      sourceTitle: currentTitle,
      total: articles.length,
      saved: savedArticles.length,
      articles: savedArticles
    };
  } catch (error) {
    console.error('Error scraping current page news:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// App lifecycle
app.whenReady().then(async () => {
  // Initialize database
  database = new ArticleDatabase('articles.db');
  try {
    await database.initialize();
    console.log('✓ Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }

  createWindow();
});

app.on('window-all-closed', async () => {
  // Close database connection
  if (database) {
    await database.close();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
