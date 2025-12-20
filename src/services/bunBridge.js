/**
 * BunBridge - Communication bridge between Node.js/Electron and Bun workers
 *
 * Spawns Bun worker processes and handles JSON-based IPC communication.
 * Workers are lazily spawned and kept alive for reuse.
 */

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

class BunWorker {
  constructor(workerName, workerPath) {
    this.workerName = workerName;
    this.workerPath = workerPath;
    this.process = null;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
    this.isReady = false;
    this.buffer = '';
    this.restartAttempts = 0;
    this.maxRestartAttempts = 3;
  }

  /**
   * Spawn the Bun worker process
   */
  async spawn() {
    if (this.process) {
      return; // Already running
    }

    return new Promise((resolve, reject) => {
      console.log(`[BunBridge] Spawning ${this.workerName} worker...`);

      this.process = spawn('bun', ['run', this.workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.dirname(this.workerPath)
      });

      // Handle stdout (JSON responses)
      this.process.stdout.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      // Handle stderr (logs/errors)
      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[${this.workerName}] ${msg}`);
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`[BunBridge] ${this.workerName} exited with code ${code}, signal ${signal}`);
        this.handleExit();
      });

      // Handle spawn errors
      this.process.on('error', (err) => {
        console.error(`[BunBridge] ${this.workerName} spawn error:`, err.message);
        reject(err);
      });

      // Wait for ready signal
      const readyTimeout = setTimeout(() => {
        if (!this.isReady) {
          reject(new Error(`${this.workerName} worker failed to start within timeout`));
        }
      }, 5000);

      const checkReady = (data) => {
        if (data.toString().includes('"ready":true')) {
          clearTimeout(readyTimeout);
          this.isReady = true;
          this.restartAttempts = 0;
          console.log(`[BunBridge] ${this.workerName} worker ready`);
          resolve();
        }
      };

      this.process.stdout.once('data', checkReady);
    });
  }

  /**
   * Process buffered stdout data for complete JSON messages
   */
  processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);

        if (response.id && this.pendingRequests.has(response.id)) {
          const { resolve, reject, timeout } = this.pendingRequests.get(response.id);
          clearTimeout(timeout);
          this.pendingRequests.delete(response.id);

          if (response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response.error || 'Unknown worker error'));
          }
        }
      } catch (err) {
        // Not valid JSON, might be a log message
        if (line.trim()) {
          console.log(`[${this.workerName}] ${line}`);
        }
      }
    }
  }

  /**
   * Handle worker process exit
   */
  handleExit() {
    this.isReady = false;
    this.process = null;

    // Reject all pending requests
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error('Worker process exited'));
    }
    this.pendingRequests.clear();

    // Attempt restart if within limits
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      console.log(`[BunBridge] Attempting restart ${this.restartAttempts}/${this.maxRestartAttempts}...`);
      setTimeout(() => this.spawn().catch(console.error), 1000);
    }
  }

  /**
   * Send a request to the worker and wait for response
   * @param {string} type - Request type
   * @param {Object} payload - Request payload
   * @param {number} timeoutMs - Request timeout in milliseconds
   * @returns {Promise<any>} Response data
   */
  async request(type, payload, timeoutMs = 30000) {
    if (!this.process || !this.isReady) {
      await this.spawn();
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const message = JSON.stringify({ id, type, payload }) + '\n';
      this.process.stdin.write(message);
    });
  }

  /**
   * Gracefully shutdown the worker
   */
  async shutdown() {
    if (this.process) {
      console.log(`[BunBridge] Shutting down ${this.workerName} worker...`);

      // Send shutdown signal
      try {
        this.process.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      } catch (e) {
        // Process might already be dead
      }

      // Wait a bit then force kill if needed
      await new Promise(resolve => setTimeout(resolve, 500));

      if (this.process) {
        this.process.kill('SIGTERM');
        this.process = null;
      }

      this.isReady = false;
      this.pendingRequests.clear();
    }
  }
}

class BunBridge {
  constructor() {
    this.workers = new Map();
    this.workersDir = path.join(__dirname, '../../bun-workers');
  }

  /**
   * Get or create a worker for the specified type
   * @param {string} workerName - Worker name (e.g., 'price', 'article', 'news')
   * @returns {BunWorker}
   */
  getWorker(workerName) {
    if (!this.workers.has(workerName)) {
      const workerPath = path.join(this.workersDir, `${workerName}Worker.ts`);
      this.workers.set(workerName, new BunWorker(workerName, workerPath));
    }
    return this.workers.get(workerName);
  }

  /**
   * Fetch JSON from a URL using the price worker
   * @param {string} url - URL to fetch
   * @returns {Promise<Object>} Parsed JSON response
   */
  async fetchJSON(url) {
    const worker = this.getWorker('price');
    return worker.request('fetchJSON', { url });
  }

  /**
   * Fetch HTML from a URL using the article worker
   * @param {string} url - URL to fetch
   * @param {Object} options - Fetch options
   * @returns {Promise<string>} HTML content
   */
  async fetchHTML(url, options = {}) {
    const worker = this.getWorker('article');
    return worker.request('fetchHTML', { url, ...options });
  }

  /**
   * Extract article content from a URL using the article worker
   * @param {string} url - Article URL
   * @param {Object} options - Extraction options
   * @returns {Promise<Object>} Extracted article data
   */
  async extractArticle(url, options = {}) {
    const worker = this.getWorker('article');
    return worker.request('extractArticle', { url, ...options });
  }

  /**
   * Fetch news for a ticker using the news worker
   * @param {string} ticker - Stock ticker symbol
   * @param {number} limit - Maximum articles to fetch
   * @returns {Promise<Array>} News items
   */
  async fetchTickerNews(ticker, limit = 50) {
    const worker = this.getWorker('news');
    return worker.request('fetchTickerNews', { ticker, limit });
  }

  /**
   * Batch fetch articles using the news worker
   * @param {Array<string>} urls - Article URLs to fetch
   * @returns {Promise<Array>} Extracted articles
   */
  async batchFetchArticles(urls) {
    const worker = this.getWorker('news');
    return worker.request('batchFetchArticles', { urls }, 60000); // 1 min timeout for batch
  }

  /**
   * Shutdown all workers
   */
  async shutdown() {
    console.log('[BunBridge] Shutting down all workers...');
    const shutdownPromises = [];
    for (const worker of this.workers.values()) {
      shutdownPromises.push(worker.shutdown());
    }
    await Promise.all(shutdownPromises);
    this.workers.clear();
    console.log('[BunBridge] All workers shut down');
  }

  /**
   * Check if Bun is available on the system
   * @returns {Promise<boolean>}
   */
  async isBunAvailable() {
    return new Promise((resolve) => {
      const proc = spawn('bun', ['--version'], { stdio: 'pipe' });
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    });
  }
}

// Export singleton instance
const bunBridge = new BunBridge();
module.exports = bunBridge;
