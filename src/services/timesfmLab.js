/**
 * TimesFM Lab Service
 *
 * Runs `python/timesfm_lab.py --search --target both` as a child process:
 * an automatic per-target feature search that prunes each preset to the
 * smallest set that still maximizes backtest AUROC. Progress lines are
 * streamed to the UI; the final SEARCH_RESULT JSON line is parsed and
 * returned so the renderer can store the winning feature sets.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class TimesFMLabService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.pythonExe = options.pythonExe || path.join(this.projectRoot, 'python', 'venv-ttm', 'bin', 'python');
    this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'python', 'timesfm_lab.py');
    this.dbPath = options.dbPath || path.join(this.projectRoot, 'articles.db');
    this.outDir = options.outDir || path.join(this.projectRoot, 'data', 'lab');
    this.device = options.device || process.env.TTM_DEVICE || 'auto';
    this.child = null;
  }

  isRunning() {
    return this.child !== null;
  }

  cancel() {
    if (this.child) {
      this.child.kill('SIGTERM');
      return true;
    }
    return false;
  }

  /**
   * Run the feature search for both screening targets.
   * @param {(line: string) => void} onLog - receives each progress line
   * @returns {Promise<Object>} { search: { direction: {...}, event: {...} } }
   *   where each target block carries the winning channel list and its
   *   backtest AUROC.
   */
  search(onLog) {
    if (this.child) {
      return Promise.reject(new Error('A search is already in progress'));
    }

    const args = [
      this.scriptPath,
      '--db', this.dbPath,
      '--search', '--target', 'both',
      '--step', '2',
      '--max-samples', '2000',
      '--max-horizon', '30',
      '--device', this.device,
      '--out', this.outDir,
    ];
    return this._runLab(args, 'SEARCH_RESULT', onLog, 'search').then((r) => ({ search: r }));
  }

  /**
   * Backtest the current production feature setup for both targets as-is
   * (no search, no pruning) and return AUROC/accuracy/Brier per target.
   * @param {(line: string) => void} onLog
   * @returns {Promise<Object>} { backtest: { direction: {...}, event: {...} } }
   */
  backtest(onLog) {
    if (this.child) {
      return Promise.reject(new Error('A lab run is already in progress'));
    }

    const args = [
      this.scriptPath,
      '--db', this.dbPath,
      '--backtest',
      '--step', '2',
      '--max-samples', '2000',
      '--max-horizon', '30',
      '--device', this.device,
      '--out', this.outDir,
    ];
    return this._runLab(args, 'BACKTEST_RESULT', onLog, 'backtest').then((r) => ({ backtest: r }));
  }

  /**
   * Spawn the lab script on a DB snapshot and resolve the JSON object from the
   * given final marker line, streaming progress to onLog.
   * @private
   */
  _runLab(args, marker, onLog, label) {
    // Snapshot the DB: DuckDB reads on the live file crash while the app
    // holds the write lock (same reason the forecast services copy it).
    const tmpDb = path.join(os.tmpdir(), `adapta_lab_${Date.now()}.db`);
    try {
      fs.copyFileSync(this.dbPath, tmpDb);
    } catch (copyErr) {
      return Promise.reject(new Error(`Failed to copy database for lab ${label}: ${copyErr.message}`));
    }
    args[2] = tmpDb; // swap the real DB path for the snapshot copy

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonExe, args, { cwd: this.projectRoot, env: process.env });
      this.child = child;
      onLog(`$ ${path.basename(this.pythonExe)} ${args.map(a => a === tmpDb ? tmpDb.split('/').pop() : a).join(' ')}`);

      let stdout = '';
      let stderr = '';
      const emit = (buf, isErr) => {
        const text = buf.toString();
        if (isErr) { stderr += text; return; }
        stdout += text;
        for (const line of text.split('\n')) {
          if (line.trim() && !line.startsWith(marker)) {
            onLog(line.replace(/^\[(lab|data|search)\]\s*/, ''));
          }
        }
      };
      child.stdout.on('data', (d) => emit(d, false));
      child.stderr.on('data', (d) => emit(d, true));

      const finish = (err, result) => {
        this.child = null;
        fs.unlink(tmpDb, () => {});
        err ? reject(err) : resolve(result);
      };

      child.on('error', (err) => finish(new Error(`Failed to start ${label}: ${err.message}`)));

      child.on('close', (code, signal) => {
        if (signal === 'SIGTERM') {
          finish(new Error(`${label[0].toUpperCase() + label.slice(1)} cancelled`));
          return;
        }
        if (code !== 0) {
          finish(new Error(`${label[0].toUpperCase() + label.slice(1)} exited with ${code}: ${(stderr || stdout).split('\n').filter(Boolean).slice(-6).join('\n')}`));
          return;
        }
        const markerLine = stdout.split('\n').find(l => l.startsWith(marker));
        if (!markerLine) {
          finish(new Error(`${label} finished but produced no result`));
          return;
        }
        try {
          finish(null, JSON.parse(markerLine.slice(marker.length + 1)));
        } catch (parseErr) {
          finish(new Error(`${label} result could not be parsed: ${parseErr.message}`));
        }
      });
    });
  }
  /**
   * Scan the dataset and return a health summary (sample counts per target,
   * options coverage, warnings) for the lab UI. No model load.
   * @param {(line: string) => void} [onLog] - optional progress sink
   * @returns {Promise<Object>} parsed JSON from --dataset-info
   */
  datasetInfo(onLog = null) {
    const args = [this.scriptPath, '--db', this.dbPath, '--dataset-info',
      '--step', '2', '--max-samples', '2000', '--max-horizon', '30'];
    // Snapshot the DB: DuckDB reads on the live file crash while the app
    // holds the write lock.
    const tmpDb = path.join(os.tmpdir(), `adapta_labdata_${Date.now()}.db`);
    try {
      fs.copyFileSync(this.dbPath, tmpDb);
    } catch (copyErr) {
      return Promise.reject(new Error(`Failed to copy database for dataset check: ${copyErr.message}`));
    }
    args[2] = tmpDb;

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonExe, args, { cwd: this.projectRoot, env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        if (onLog) {
          for (const line of text.split('\n')) {
            if (line.trim()) onLog(line.replace(/^\[(lab|data|search)\]\s*/, ''));
          }
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const finish = (err, result) => {
        fs.unlink(tmpDb, () => {});
        err ? reject(err) : resolve(result);
      };
      child.on('error', (err) => finish(new Error(`Failed to start dataset check: ${err.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(`Dataset check exited with ${code}: ${(stderr || stdout).split('\n').filter(Boolean).slice(-4).join('\n')}`));
          return;
        }
        try {
          finish(null, JSON.parse(stdout));
        } catch (parseErr) {
          finish(new Error(`Dataset check returned invalid JSON: ${parseErr.message}\n${stdout}\n${stderr}`));
        }
      });
    });
  }
}

module.exports = TimesFMLabService;
