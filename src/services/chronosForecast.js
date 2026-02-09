/**
 * ChronosForecastService - Bridge to Amazon Chronos-2 Python forecasting
 *
 * Spawns Python subprocess to run Chronos-2 time series forecasting
 * based on historical prices and event data.
 */

const { spawn } = require('child_process');
const path = require('path');

class ChronosForecastService {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || 'python3';
    this.scriptPath = options.scriptPath || path.join(__dirname, '../../python/chronos_forecast.py');
    this.modelSize = options.modelSize || 'small'; // tiny, small, base
    this.defaultDays = options.defaultDays || 14;
  }

  /**
   * Run Python forecasting script
   * @param {string} mode - Forecast mode: forecast, with_events, post_event
   * @param {object} data - Input data (prices, events, etc.)
   * @param {number} days - Days to forecast
   * @returns {Promise<object>} Forecast results
   */
  async runForecast(mode, data, days = this.defaultDays) {
    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--mode', mode,
        '--model', this.modelSize,
        '--days', String(days),
        '--input', '-'
      ];

      console.log(`Running Chronos-2 forecast (mode=${mode}, days=${days}, model=${this.modelSize})`);

      const proc = spawn(this.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        // Log stderr for model loading progress
        console.log('[Chronos]', chunk.toString().trim());
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Chronos forecast failed (code ${code}): ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse forecast result: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Python process: ${err.message}`));
      });

      // Send input data
      proc.stdin.write(JSON.stringify(data));
      proc.stdin.end();
    });
  }

  /**
   * Basic price forecast without event context
   * @param {Array<number>} prices - Historical closing prices (oldest to newest)
   * @param {number} days - Days to forecast
   * @returns {Promise<object>} Forecast with median, confidence intervals
   */
  async forecastPrices(prices, days = this.defaultDays) {
    return this.runForecast('forecast', { prices }, days);
  }

  /**
   * Forecast with event context
   * @param {Array<number>} prices - Historical closing prices
   * @param {Array<object>} events - Past events with residual_return, strength, classification
   * @param {number} days - Days to forecast
   * @returns {Promise<object>} Forecast with event context analysis
   */
  async forecastWithEvents(prices, events, days = this.defaultDays) {
    const normalizedEvents = events.map(e => ({
      residual_return: e.residualReturn ?? e.residual_return ?? 0,
      strength: e.strength ?? e.eventStrength ?? 0,
      classification: e.classification ?? e.earningsClassification ?? 'unknown',
      date: e.dateStr ?? e.date?.toISOString?.().split('T')[0] ?? null,
    }));

    return this.runForecast('with_events', { prices, events: normalizedEvents }, days);
  }

  /**
   * Forecast immediately after an event
   * @param {Array<number>} prices - Prices up to and including event day
   * @param {object} event - The event that just occurred
   * @param {number} days - Days to forecast
   * @returns {Promise<object>} Post-event forecast with impact analysis
   */
  async forecastPostEvent(prices, event, days = this.defaultDays) {
    const normalizedEvent = {
      residual_return: event.residualReturn ?? event.residual_return ?? 0,
      strength: event.strength ?? event.eventStrength ?? 0,
      classification: event.classification ?? event.earningsClassification ?? 'unknown',
    };

    return this.runForecast('post_event', { prices, event: normalizedEvent }, days);
  }

  /**
   * Generate forecast for a stock analysis result
   * @param {object} analysisResult - Result from StockAnalysisService.analyzeStock()
   * @param {number} days - Days to forecast
   * @returns {Promise<object>} Comprehensive forecast with event context
   */
  async forecastFromAnalysis(analysisResult, days = this.defaultDays) {
    const { data, events } = analysisResult;

    // Extract closing prices (oldest to newest)
    const prices = data.map(bar => bar.close);

    // Get the most recent event (if any)
    const recentEvent = events.length > 0 ? events[0] : null;

    // Check if we're within 3 days of the most recent event
    const now = new Date();
    const isPostEvent = recentEvent &&
      (now - new Date(recentEvent.date)) / (1000 * 60 * 60 * 24) <= 3;

    if (isPostEvent) {
      console.log('Generating post-event forecast...');
      return this.forecastPostEvent(prices, recentEvent, days);
    } else if (events.length > 0) {
      console.log('Generating forecast with event context...');
      return this.forecastWithEvents(prices, events, days);
    } else {
      console.log('Generating base forecast...');
      return this.forecastPrices(prices, days);
    }
  }

  /**
   * Check if Python and dependencies are available
   * @returns {Promise<boolean>}
   */
  async checkDependencies() {
    return new Promise((resolve) => {
      const proc = spawn(this.pythonPath, ['-c', 'import chronos; print("ok")'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.on('close', (code) => {
        resolve(code === 0 && stdout.includes('ok'));
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }
}

module.exports = ChronosForecastService;
