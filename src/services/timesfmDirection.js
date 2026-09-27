/**
 * TimesFM Direction Analysis Service
 *
 * Wraps `python/timesfm_direction_forecast.py`: probability of a positive
 * return on the next trading day (tomorrow), using options-only covariates.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class TimesFMDirectionService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.pythonExe = options.pythonExe || path.join(this.projectRoot, 'python', 'venv-ttm', 'bin', 'python');
    this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'python', 'timesfm_direction_forecast.py');
    this.modelDir = options.modelDir || 'google/timesfm-3.0-pytorch';
    this.dbPath = options.dbPath || path.join(this.projectRoot, 'articles.db');
    // 'auto' lets the script pick CUDA when available and fall back to CPU.
    this.device = options.device || process.env.TTM_DEVICE || 'auto';
  }

  /**
   * Run the forecast script once with the given stdin payload.
   * @private
   * @param {Object} payload - {ticker, date} or {tickers, date}
   * @returns {Promise<Object>} Parsed JSON from the script
   */
  _run(payload, channels = null) {
    return new Promise((resolve, reject) => {
      // DuckDB does not allow a second process to read the DB while the main
      // Electron process holds the write lock. Copy to a temp file first.
      const tmpDb = path.join(os.tmpdir(), `adapta_dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
      try {
        fs.copyFileSync(this.dbPath, tmpDb);
      } catch (copyErr) {
        reject(new Error(`Failed to copy database for direction forecast: ${copyErr.message}`));
        return;
      }

      const args = [
        this.scriptPath,
        '--db', tmpDb,
        '--model', this.modelDir,
        '--device', this.device,
      ];
      if (Array.isArray(channels) && channels.length > 0) {
        args.push('--channels', channels.join(','));
      }

      const child = spawn(this.pythonExe, args, {
        cwd: this.projectRoot,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('error', (err) => {
        fs.unlink(tmpDb, () => {});
        reject(new Error(`Failed to start direction forecast: ${err.message}`));
      });

      child.on('close', (code) => {
        fs.unlink(tmpDb, () => {});
        if (code !== 0) {
          reject(new Error(`Direction forecast exited with ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          resolve(result);
        } catch (parseErr) {
          reject(new Error(`Direction forecast returned invalid JSON: ${parseErr.message}\n${stdout}\n${stderr}`));
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  /**
   * Direction forecast for a single ticker.
   * @param {string} ticker
   * @param {string|null} date Optional forecast start date (YYYY-MM-DD)
   * @returns {Promise<Object>}
   */
  async forecast(ticker, date = null, channels = null) {
    return this._run({ ticker, date }, channels);
  }

  /**
   * Direction forecast for many tickers in ONE batched spawn/forward pass.
   * Tickers that cannot be scored are reported in `errors`.
   * @param {string[]} tickers
   * @param {string|null} date
   * @returns {Promise<{results: Array, errors: Array, device: string, count: number}>}
   */
  async forecastBatch(tickers, date = null, channels = null) {
    const list = (tickers || []).map(t => String(t).toUpperCase()).filter(Boolean);
    if (list.length === 0) {
      return { results: [], errors: [], device: this.device, count: 0 };
    }
    return this._run({ tickers: list, date }, channels);
  }

  /**
   * Convenience wrapper: Map of ticker → direction forecast record.
   * Failed tickers are simply absent from the map.
   * @param {string[]} tickers
   * @param {string|null} date
   * @returns {Promise<Map<string, Object>>}
   */
  async forecastRecords(tickers, date = null, channels = null) {
    const out = new Map();
    const batch = await this.forecastBatch(tickers, date, channels);
    for (const r of batch.results || []) {
      if (r.ticker && typeof r.up_probability === 'number') {
        out.set(r.ticker, r);
      }
    }
    if (batch.errors?.length > 0) {
      const preview = batch.errors.slice(0, 3).map(e => `${e.ticker}: ${e.error}`).join('; ');
      console.warn(`[Direction] ${batch.errors.length} ticker(s) could not be scored — ${preview}`);
    }
    return out;
  }
}

module.exports = TimesFMDirectionService;
