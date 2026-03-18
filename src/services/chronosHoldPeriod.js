/**
 * ChronosHoldPeriodService - Uses Amazon Chronos-2 (Bolt) to forecast
 * stock prices and compute optimal hold periods.
 *
 * Spawns a Python subprocess that runs chronos-bolt-small for probabilistic
 * time-series forecasting, then combines the forecast with live options data
 * to produce risk-adjusted hold period recommendations.
 */

const { spawn } = require('child_process');
const path = require('path');

class ChronosHoldPeriodService {
  constructor(database) {
    this.database = database;
    this.pythonScript = path.join(__dirname, '..', '..', 'python', 'chronos_hold.py');
  }

  /**
   * Compute Chronos-2 based optimal hold period
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Configuration
   * @param {number} options.maxForwardDays - Max days to forecast (default 60)
   * @param {Object} options.optionsData - Live options analysis data (optional)
   * @param {Array} options.priceData - Pre-fetched price bars with .close (optional)
   * @param {number} options.contextDays - How many historical days to use (default 512)
   * @returns {Promise<Object|null>} Chronos hold period data
   */
  async computeChronosHold(ticker, options = {}) {
    const {
      maxForwardDays = 60,
      optionsData = null,
      priceData = null,
      contextDays = 512,
    } = options;

    // 1. Get historical close prices
    let prices;
    if (priceData && priceData.length > 0) {
      // Use pre-fetched data (from the analysis pipeline)
      prices = priceData
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(bar => bar.close);
    } else {
      // Fetch from database
      const rows = await this.database.getPriceHistory(ticker, {
        limit: contextDays,
        source: 'yahoo_finance',
      });
      if (!rows || rows.length < 30) {
        const analysisRows = await this.database.getPriceHistory(ticker, {
          limit: contextDays,
          source: 'analysis',
        });
        if (!analysisRows || analysisRows.length < 30) {
          console.log(`Chronos hold: insufficient price data for ${ticker} (need >= 30)`);
          return null;
        }
        prices = analysisRows
          .sort((a, b) => new Date(a.date) - new Date(b.date))
          .map(r => r.close);
      } else {
        prices = rows
          .sort((a, b) => new Date(a.date) - new Date(b.date))
          .map(r => r.close);
      }
    }

    // Trim to contextDays
    if (prices.length > contextDays) {
      prices = prices.slice(prices.length - contextDays);
    }

    console.log(`Chronos hold: forecasting ${maxForwardDays} days from ${prices.length} price observations for ${ticker}`);

    // 2. Build options features for the Python script
    let optionsFeatures = null;
    if (optionsData && optionsData.summary) {
      const s = optionsData.summary;
      optionsFeatures = {
        putCallRatio: s.putCallRatio ?? 1.0,
        avgIV: s.avgIV ?? 0.3,
        ivSkew: s.ivSkew ?? 0.0,
        unusualVolumeCount: s.unusualVolumeCount ?? 0,
        convictionRatio: s.convictionRatio ?? 1.0,
      };
    }

    // 3. Call Python subprocess
    const input = {
      prices,
      options: optionsFeatures,
      maxForwardDays,
      numSamples: 100,
    };

    const result = await this._runPython(input);
    if (!result || result.error) {
      console.error('Chronos hold: forecast failed:', result?.error || 'no output');
      return null;
    }

    // 4. Format result to match the app's hold period data structure
    const formatted = this._formatResult(result, maxForwardDays);

    console.log(`Chronos hold: peak day ${formatted.peakDay}, peak return ${(formatted.peakReturn * 100).toFixed(2)}%`);
    if (formatted.optionsAdjusted) {
      console.log(`Chronos hold (options-adjusted): peak day ${formatted.optionsAdjusted.peakDay}, peak return ${(formatted.optionsAdjusted.peakReturn * 100).toFixed(2)}%`);
    }

    return formatted;
  }

  /**
   * Run the Python chronos_hold.py script
   * @param {Object} input - JSON input for the script
   * @returns {Promise<Object|null>} Parsed JSON output
   */
  _runPython(input) {
    return new Promise((resolve) => {
      const py = spawn('python3', [this.pythonScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000, // 2 min timeout
      });

      let stdout = '';
      let stderr = '';

      py.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      py.stderr.on('data', (data) => {
        const msg = data.toString();
        stderr += msg;
        // Forward progress messages to console
        if (msg.trim()) {
          console.log(`Chronos: ${msg.trim()}`);
        }
      });

      py.on('close', (code) => {
        if (code !== 0) {
          console.error(`Chronos hold: Python exited with code ${code}`);
          if (stderr) console.error(`Chronos stderr: ${stderr}`);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          console.error('Chronos hold: failed to parse output:', e.message);
          resolve(null);
        }
      });

      py.on('error', (err) => {
        console.error('Chronos hold: failed to spawn Python:', err.message);
        resolve(null);
      });

      // Send input and close stdin
      py.stdin.write(JSON.stringify(input));
      py.stdin.end();
    });
  }

  /**
   * Format the Python output into the app's standard hold period structure
   */
  _formatResult(result, maxForwardDays) {
    const byDay = (result.byDay || []).map(d => ({
      day: d.day,
      median_return: d.medianReturn,
      mean_return: d.meanReturn,
      p10_return: d.p10Return,
      p25_return: d.p25Return,
      p75_return: d.p75Return,
      p90_return: d.p90Return,
      prob_positive: d.probPositive,
      forecast_price: d.forecastPrice,
    }));

    const formatted = {
      byDay,
      peakDay: result.peakDay,
      peakReturn: result.peakReturn,
      lastPrice: result.lastPrice,
      contextLength: result.contextLength,
      maxForwardDays,
      model: 'chronos-bolt-small',
    };

    if (result.optionsAdjusted) {
      const adj = result.optionsAdjusted;
      formatted.optionsAdjusted = {
        byDay: (adj.byDay || []).map(d => ({
          day: d.day,
          median_return: d.medianReturn,
          p10_return: d.p10Return,
          p90_return: d.p90Return,
          prob_positive: d.probPositive,
        })),
        peakDay: adj.peakDay,
        peakReturn: adj.peakReturn,
      };
    }

    return formatted;
  }
}

module.exports = ChronosHoldPeriodService;
