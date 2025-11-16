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

  // Get current state
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),

  // Listen for URL changes
  onUrlChanged: (callback) => ipcRenderer.on('url-changed', (event, data) => callback(data)),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close')
});
