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
  saveArticle: (category, manualTickers) => ipcRenderer.invoke('save-article', category, manualTickers),
  recordNewsCount: () => ipcRenderer.invoke('record-news-count'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getStockStats: () => ipcRenderer.invoke('get-stock-stats'),
  getRecentNewsVolume: () => ipcRenderer.invoke('get-recent-news-volume'),
  getArticles: (categoryFilter) => ipcRenderer.invoke('get-articles', categoryFilter),
  executeSQL: (query) => ipcRenderer.invoke('execute-sql', query),

  // Database management
  clearAllData: () => ipcRenderer.invoke('clear-all-data'),
  clearNewsVolume: () => ipcRenderer.invoke('clear-news-volume'),

  // Settings
  getSetting: (key, defaultValue) => ipcRenderer.invoke('get-setting', key, defaultValue),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),

  // Stock price tracking
  fetchHistoricalPrices: (ticker, options) => ipcRenderer.invoke('fetch-historical-prices', ticker, options),
  getPriceHistory: (ticker, options) => ipcRenderer.invoke('get-price-history', ticker, options),
  getLatestPrice: (ticker) => ipcRenderer.invoke('get-latest-price', ticker),
  addWatchedTicker: (ticker, autoUpdate) => ipcRenderer.invoke('add-watched-ticker', ticker, autoUpdate),
  removeWatchedTicker: (ticker) => ipcRenderer.invoke('remove-watched-ticker', ticker),
  getWatchedTickers: (autoUpdateOnly) => ipcRenderer.invoke('get-watched-tickers', autoUpdateOnly),
  isTickerWatched: (ticker) => ipcRenderer.invoke('is-ticker-watched', ticker),
  getPriceStats: () => ipcRenderer.invoke('get-price-stats'),
  togglePricePolling: (enabled, intervalMinutes) => ipcRenderer.invoke('toggle-price-polling', enabled, intervalMinutes),
  getPollingStatus: () => ipcRenderer.invoke('get-polling-status'),
  updateLatestPrice: (ticker) => ipcRenderer.invoke('update-latest-price', ticker),

  // Stock event analysis
  analyzeStockEvents: (ticker, options) => ipcRenderer.invoke('analyze-stock-events', ticker, options),

  // News harvester
  toggleNewsHarvester: (enabled, intervalMinutes) => ipcRenderer.invoke('toggle-news-harvester', enabled, intervalMinutes),
  getHarvesterStatus: () => ipcRenderer.invoke('get-harvester-status'),
  triggerHarvest: () => ipcRenderer.invoke('trigger-harvest'),
  harvestTickers: (tickers) => ipcRenderer.invoke('harvest-tickers', tickers),
  getCorpusStats: () => ipcRenderer.invoke('get-corpus-stats'),

  // Modal support (hide/show BrowserView)
  showModal: () => ipcRenderer.invoke('show-modal'),
  hideModal: () => ipcRenderer.invoke('hide-modal'),

  // Get current state
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),

  // Listen for URL changes
  onUrlChanged: (callback) => ipcRenderer.on('url-changed', (event, data) => callback(data)),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Window controls (already in the list above)
  // Removed: onNewsArticlesReady - using executeJavaScript approach instead
});
