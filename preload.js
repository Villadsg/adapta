const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process
// to communicate with the main process
contextBridge.exposeInMainWorld('electronAPI', {
  // Tab management
  createTab: (url) => ipcRenderer.invoke('create-tab', url),
  switchTab: (tabId) => ipcRenderer.invoke('switch-tab', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('close-tab', tabId),

  // Navigation
  navigateToUrl: (url) => ipcRenderer.invoke('navigate-to-url', url),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  goBack: () => ipcRenderer.invoke('go-back'),
  goForward: () => ipcRenderer.invoke('go-forward'),
  reload: () => ipcRenderer.invoke('reload'),

  // Text extraction
  downloadText: () => ipcRenderer.invoke('download-text'),

  // Database operations
  analyzePage: () => ipcRenderer.invoke('analyze-page'),
  saveArticle: (category) => ipcRenderer.invoke('save-article', category),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getEmbeddingStats: () => ipcRenderer.invoke('get-embedding-stats'),
  getArticles: (categoryFilter) => ipcRenderer.invoke('get-articles', categoryFilter),

  // Settings operations
  getChunkingSettings: () => ipcRenderer.invoke('get-chunking-settings'),
  saveChunkingSettings: (settings) => ipcRenderer.invoke('save-chunking-settings', settings),
  rechunkAll: (chunkSize, overlap, strategy) => ipcRenderer.invoke('rechunk-all', chunkSize, overlap, strategy),

  // Database management
  clearVectors: () => ipcRenderer.invoke('clear-vectors'),
  clearAllData: () => ipcRenderer.invoke('clear-all-data'),

  // Get current state
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),

  // Listen for URL changes
  onUrlChanged: (callback) => ipcRenderer.on('url-changed', (event, data) => callback(data)),

  // Scraping operations
  scrapeTickerPressReleases: (ticker, topN) => ipcRenderer.invoke('scrape-ticker-press-releases', ticker, topN),
  onScrapeProgress: (callback) => ipcRenderer.on('scrape-progress', (event, data) => callback(data)),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close')
});
