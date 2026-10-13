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

  // Backend readiness
  waitBackendReady: () => ipcRenderer.invoke('wait-backend-ready'),

  // Database operations
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
  getPriceStats: () => ipcRenderer.invoke('get-price-stats'),
  togglePricePolling: (enabled, intervalMinutes) => ipcRenderer.invoke('toggle-price-polling', enabled, intervalMinutes),
  getPollingStatus: () => ipcRenderer.invoke('get-polling-status'),
  updateLatestPrice: (ticker) => ipcRenderer.invoke('update-latest-price', ticker),

  // Stock event analysis
  analyzeStockEvents: (ticker, options) => ipcRenderer.invoke('analyze-stock-events', ticker, options),
  getAnalyzedTickers: () => ipcRenderer.invoke('get-analyzed-tickers'),
  forecastEventMagnitude: (ticker, date) => ipcRenderer.invoke('forecast-event-magnitude', ticker, date),

  // Model lab (automatic feature search for the screening forecasts)
  labMeta: () => ipcRenderer.invoke('lab-meta'),
  labSearch: () => ipcRenderer.invoke('lab-search'),
  labBacktest: () => ipcRenderer.invoke('lab-backtest'),
  labCancel: () => ipcRenderer.invoke('lab-cancel'),
  labStatus: () => ipcRenderer.invoke('lab-status'),
  labDataset: () => ipcRenderer.invoke('lab-dataset'),
  labInsights: (kind, payload) => ipcRenderer.invoke('lab-insights', kind, payload),
  onLabLog: (callback) => ipcRenderer.on('lab-log', (event, data) => callback(data)),

  // Modal support (hide/show BrowserView)
  showModal: () => ipcRenderer.invoke('show-modal'),
  hideModal: () => ipcRenderer.invoke('hide-modal'),

  // Ticker screening
  screenTickers: (options) => ipcRenderer.invoke('screen-tickers', options),
  cancelScreening: () => ipcRenderer.invoke('cancel-screening'),
  reviseTickers: () => ipcRenderer.invoke('revise-tickers'),
  loadReviseResults: () => ipcRenderer.invoke('load-revise-results'),
  getScreenTickers: () => ipcRenderer.invoke('get-screen-tickers'),
  saveScreenList: (tickers) => ipcRenderer.invoke('save-screen-list', { tickers }),
  addScreenTicker: (ticker) => ipcRenderer.invoke('add-screen-ticker', ticker),
  loadScreeningResults: (filePath) => ipcRenderer.invoke('load-screening-results', filePath),
  listScreeningRuns: () => ipcRenderer.invoke('list-screening-runs'),

  toggleDelete: (ticker) => ipcRenderer.invoke('toggle-delete', ticker),
  onReviseProgress: (callback) => ipcRenderer.on('revise-progress', (event, data) => callback(data)),

  // Options data backfill (phases C+D in-process)
  backfillCoverage: () => ipcRenderer.invoke('backfill-coverage'),
  backfillEstimate: () => ipcRenderer.invoke('backfill-estimate'),
  backfillStart: (options) => ipcRenderer.invoke('backfill-start', options),
  backfillCancel: () => ipcRenderer.invoke('backfill-cancel'),
  backfillStatus: () => ipcRenderer.invoke('backfill-status'),
  onBackfillProgress: (callback) => ipcRenderer.on('backfill-progress', (event, data) => callback(data)),

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
