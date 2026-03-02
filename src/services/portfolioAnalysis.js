/**
 * PortfolioAnalysisService - Portfolio diversification analysis
 *
 * Computes correlation matrices, options-implied expected returns, and scores
 * candidate stocks using a two-stage framework: diversification prior + options-implied update.
 */

const { sampleCorrelation } = require('simple-statistics');

class PortfolioAnalysisService {
  constructor(database, stockAnalyzer, optionsAnalyzer) {
    this.database = database;
    this.stockAnalyzer = stockAnalyzer;
    this.optionsAnalyzer = optionsAnalyzer;
  }

  // ── Portfolio CRUD ──────────────────────────────────────────────────

  async saveHolding(ticker, shares) {
    ticker = ticker.toUpperCase();
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO portfolio_holdings (ticker, shares)
        VALUES ($1, $2)
        ON CONFLICT (ticker) DO UPDATE SET shares = excluded.shares
      `;
      this.database.connection.run(sql, ticker, shares, (err) => {
        if (err) reject(err);
        else resolve({ ticker, shares });
      });
    });
  }

  async getHoldings() {
    return new Promise((resolve, reject) => {
      this.database.connection.all(
        'SELECT ticker, shares, added_at FROM portfolio_holdings ORDER BY added_at',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Fetch the USD exchange rate for a given currency (e.g. "DKK" → USD/DKK).
   * Returns 1.0 for USD. Caches results for the session.
   */
  async fetchFxRate(currency) {
    if (!currency || currency === 'USD') return 1.0;
    if (this._fxCache?.[currency]) return this._fxCache[currency];

    try {
      const symbol = `${currency}=X`;
      await new Promise(r => setTimeout(r, 1000));
      console.log(`Fetching FX rate for ${currency} → USD...`);
      const chain = await this.optionsAnalyzer.fetchOptionsChain(symbol);
      const rate = chain?.quote?.regularMarketPrice;
      if (rate && rate > 0) {
        const usdPerUnit = 1 / rate;
        if (!this._fxCache) this._fxCache = {};
        this._fxCache[currency] = usdPerUnit;
        console.log(`  ${currency}/USD = ${usdPerUnit.toFixed(6)}`);
        return usdPerUnit;
      }
    } catch (err) {
      console.log(`FX fetch failed for ${currency}: ${err.message}`);
    }
    console.log(`  Could not get FX rate for ${currency}, assuming 1.0`);
    return 1.0;
  }

  /**
   * Fetch latest prices and compute portfolio weights from share counts.
   * All values are converted to USD for consistent weighting.
   */
  async computeWeights(holdings) {
    const priced = [];
    for (const h of holdings) {
      try {
        const chain = await this.optionsAnalyzer.fetchOptionsChain(h.ticker);
        const price = chain?.quote?.regularMarketPrice;
        const currency = chain?.quote?.currency || 'USD';
        if (price) {
          const fxRate = await this.fetchFxRate(currency);
          const priceUsd = price * fxRate;
          priced.push({
            ticker: h.ticker, shares: h.shares,
            price, priceUsd, currency, fxRate,
            value: h.shares * priceUsd,
          });
          if (currency !== 'USD') {
            console.log(`  ${h.ticker}: ${price} ${currency} → $${priceUsd.toFixed(2)} USD`);
          }
        } else {
          console.log(`No price for ${h.ticker}, skipping weight calc`);
          priced.push({ ticker: h.ticker, shares: h.shares, price: null, priceUsd: null, currency, fxRate: 1, value: 0 });
        }
      } catch (err) {
        console.log(`Price fetch failed for ${h.ticker}: ${err.message}`);
        priced.push({ ticker: h.ticker, shares: h.shares, price: null, priceUsd: null, currency: 'USD', fxRate: 1, value: 0 });
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    const totalValue = priced.reduce((s, p) => s + p.value, 0);
    return priced.map(p => ({
      ...p,
      weight: totalValue > 0 ? (p.value / totalValue) * 100 : 0,
    }));
  }

  async removeHolding(ticker) {
    ticker = ticker.toUpperCase();
    return new Promise((resolve, reject) => {
      this.database.connection.run(
        'DELETE FROM portfolio_holdings WHERE ticker = $1',
        ticker,
        (err) => {
          if (err) reject(err);
          else resolve({ ticker });
        }
      );
    });
  }

  // ── Core Analysis ───────────────────────────────────────────────────

  /**
   * Fetch aligned daily returns for multiple tickers.
   * Inner-joins on common trading dates.
   */
  async fetchAlignedReturns(tickers, days = 200, dataSource = 'auto') {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 1.5 * 86400000).toISOString().split('T')[0];

    // Fetch price data for each ticker with rate-limit delays
    const priceMap = {};
    for (const ticker of tickers) {
      if (Object.keys(priceMap).length > 0) {
        await new Promise(r => setTimeout(r, 1500));
      }
      console.log(`Fetching price data for ${ticker}...`);
      const bars = await this.stockAnalyzer.fetchStockData(ticker, startDate, endDate, dataSource);
      priceMap[ticker] = bars;
    }

    // Find common dates across all tickers
    const dateSets = tickers.map(t =>
      new Set(priceMap[t].map(b => b.date.toISOString().split('T')[0]))
    );
    const commonDates = [...dateSets[0]].filter(d =>
      dateSets.every(s => s.has(d))
    ).sort();

    // Build aligned close prices
    const aligned = {};
    for (const ticker of tickers) {
      const byDate = {};
      for (const bar of priceMap[ticker]) {
        byDate[bar.date.toISOString().split('T')[0]] = bar.close;
      }
      aligned[ticker] = commonDates.map(d => byDate[d]);
    }

    // Compute daily log returns
    const returns = {};
    const prices = {};
    const returnDates = commonDates.slice(1);

    for (const ticker of tickers) {
      prices[ticker] = aligned[ticker];
      returns[ticker] = [];
      for (let i = 1; i < aligned[ticker].length; i++) {
        returns[ticker].push(Math.log(aligned[ticker][i] / aligned[ticker][i - 1]));
      }
    }

    return { dates: returnDates, returns, prices };
  }

  /**
   * Compute options-implied expected annualized return for a ticker.
   * Falls back to historical mean if options are unavailable.
   */
  async computeImpliedExpectedReturn(ticker, historicalReturns) {
    try {
      await new Promise(r => setTimeout(r, 2000)); // rate limit
      console.log(`Fetching options for ${ticker} implied return...`);
      const chain = await this.optionsAnalyzer.fetchOptionsChain(ticker);

      if (!chain || !chain.options?.[0]) {
        throw new Error('No options data');
      }

      const spot = chain.quote?.regularMarketPrice;
      if (!spot) throw new Error('No spot price');

      const calls = chain.options[0].calls || [];
      const puts = chain.options[0].puts || [];
      const atmCall = this.optionsAnalyzer.findATMOption(calls, spot);
      const atmPut = this.optionsAnalyzer.findATMOption(puts, spot);

      if (!atmCall || !atmPut || atmCall.lastPrice == null || atmPut.lastPrice == null) {
        throw new Error('No ATM options');
      }

      // Days to expiration
      const expDate = chain.expirationDates?.[0];
      const dte = expDate
        ? Math.max(1, (new Date(expDate) - new Date()) / 86400000)
        : 30;

      // Put-call parity forward price
      const forward = atmCall.strike + atmCall.lastPrice - atmPut.lastPrice;
      const impliedReturn = (forward / spot - 1) * (365 / dte);

      // ATM IV
      const atmIV = this.optionsAnalyzer.normalizeIV(atmCall.impliedVolatility) ||
                    this.optionsAnalyzer.normalizeIV(atmPut.impliedVolatility) || null;

      return { ticker, impliedReturn, atmIV, source: 'options', spot };
    } catch (err) {
      console.log(`Options unavailable for ${ticker} (${err.message}), using historical`);
      // Fallback: annualized historical mean
      const meanDaily = historicalReturns.reduce((s, r) => s + r, 0) / historicalReturns.length;
      return {
        ticker,
        impliedReturn: meanDaily * 252,
        atmIV: null,
        source: 'historical',
      };
    }
  }

  /**
   * Compute pairwise Pearson correlation matrix.
   */
  computeCorrelationMatrix(alignedReturns) {
    const { returns } = alignedReturns;
    const tickers = Object.keys(returns);
    const n = tickers.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const corr = sampleCorrelation(returns[tickers[i]], returns[tickers[j]]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }

    return { matrix, tickers };
  }

  /**
   * Find the optimal weight for a candidate that minimizes cross-covariance
   * with existing holdings. Only penalizes co-movement, not the candidate's
   * own volatility — so volatile-but-uncorrelated candidates score well.
   * Sweeps from 1% to 50% in 1% steps.
   */
  findOptimalWeight({ candidateTicker, holdingTickers, holdingWeights, stdDevs, matrix, idx }) {
    let bestCw = 0.01;
    let bestCross = Infinity;

    const candIdx = idx(candidateTicker);
    if (candIdx < 0) return bestCw;

    const sigmaCand = stdDevs[candidateTicker] || 0;

    for (let pct = 1; pct <= 50; pct++) {
      const cw = pct / 100;
      const scale = 1 - cw;

      let crossCovar = 0;
      for (let h = 0; h < holdingTickers.length; h++) {
        const ht = holdingTickers[h];
        const hi = idx(ht);
        if (hi < 0) continue;
        const wh = holdingWeights[h] * scale;
        crossCovar += 2 * wh * cw * (stdDevs[ht] || 0) * sigmaCand * matrix[hi][candIdx];
      }

      if (crossCovar < bestCross) {
        bestCross = crossCovar;
        bestCw = cw;
      }
    }

    return bestCw;
  }

  /**
   * Score candidate stocks using two-stage framework:
   * Stage 1: Diversification prior (variance reduction + low correlation)
   * Stage 2: Options-implied return update (Bayesian-style adjustment)
   */
  scoreCandidates({ holdings, candidates, alignedReturns, correlationMatrix, impliedReturns }) {
    const { matrix, tickers } = correlationMatrix;
    const { returns } = alignedReturns;

    // Helper: get index in correlation matrix
    const idx = (t) => tickers.indexOf(t);

    // Compute standard deviations (annualized)
    const stdDevs = {};
    for (const t of tickers) {
      const r = returns[t];
      const mean = r.reduce((s, v) => s + v, 0) / r.length;
      const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1);
      stdDevs[t] = Math.sqrt(variance * 252);
    }

    // Get expected returns from implied returns map
    const mu = {};
    for (const ir of impliedReturns) {
      mu[ir.ticker] = ir.impliedReturn;
    }

    const holdingTickers = holdings.map(h => h.ticker);
    const holdingWeights = holdings.map(h => h.weight / 100);

    // Current portfolio variance
    let currentVar = 0;
    for (let i = 0; i < holdingTickers.length; i++) {
      for (let j = 0; j < holdingTickers.length; j++) {
        const ti = holdingTickers[i], tj = holdingTickers[j];
        const ii = idx(ti), jj = idx(tj);
        if (ii < 0 || jj < 0) continue;
        currentVar += holdingWeights[i] * holdingWeights[j] *
                      stdDevs[ti] * stdDevs[tj] * matrix[ii][jj];
      }
    }
    const currentStd = Math.sqrt(Math.max(0, currentVar));

    // Stage 1: Compute diversification scores for each candidate
    const rawScores = [];
    for (const cand of candidates) {
      const ci = idx(cand);
      if (ci < 0) continue;

      // Find min-variance optimal weight
      const cw = this.findOptimalWeight({
        candidateTicker: cand, holdingTickers, holdingWeights, stdDevs, matrix, idx,
      });

      // Rescale existing weights
      const scale = 1 - cw;
      const newWeights = holdingTickers.map((_, i) => holdingWeights[i] * scale);
      const allTickers = [...holdingTickers, cand];
      const allWeights = [...newWeights, cw];

      // New portfolio variance at optimal weight
      let newVar = 0;
      for (let i = 0; i < allTickers.length; i++) {
        for (let j = 0; j < allTickers.length; j++) {
          const ti = allTickers[i], tj = allTickers[j];
          const ii = idx(ti), jj = idx(tj);
          if (ii < 0 || jj < 0) continue;
          newVar += allWeights[i] * allWeights[j] *
                    stdDevs[ti] * stdDevs[tj] * matrix[ii][jj];
        }
      }
      const newStd = Math.sqrt(Math.max(0, newVar));

      // Risk reduction %
      const riskReduction = currentStd > 0 ? ((currentStd - newStd) / currentStd) * 100 : 0;

      // Average |correlation| with portfolio holdings
      const avgCorr = holdingTickers.reduce((s, t) => {
        const hi = idx(t);
        return s + (hi >= 0 ? Math.abs(matrix[hi][ci]) : 0);
      }, 0) / holdingTickers.length;

      // Diversification score: 50% risk reduction + 50% low correlation
      const rawDivScore = 0.5 * riskReduction + 0.5 * (1 - avgCorr) * 100;
      const diversificationScore = Math.max(0, Math.min(100, rawDivScore));

      const impliedData = impliedReturns.find(ir => ir.ticker === cand);

      rawScores.push({
        ticker: cand,
        optimalWeight: cw * 100,
        impliedReturn: mu[cand] || 0,
        atmIV: impliedData?.atmIV,
        returnSource: impliedData?.source || 'unknown',
        avgCorrelation: avgCorr,
        riskReduction,
        diversificationScore,
        annualizedVol: stdDevs[cand] || 0,
        newStd,
      });
    }

    // Stage 2: Options-implied return update
    // Normalize implied returns to [-1, +1] signal
    const maxAbsReturn = rawScores.reduce((m, s) => Math.max(m, Math.abs(s.impliedReturn)), 0);

    const scores = rawScores.map(s => {
      const returnSignal = maxAbsReturn > 0 ? s.impliedReturn / maxAbsReturn : 0;
      const finalScore = Math.max(0, Math.min(100,
        s.diversificationScore * (1 + 0.3 * returnSignal)
      ));
      const adjustedWeight = Math.max(1, Math.min(50,
        s.optimalWeight * (1 + 0.3 * returnSignal)
      ));
      return { ...s, returnSignal, adjustedWeight, score: finalScore };
    });

    return {
      scores: scores.sort((a, b) => b.score - a.score),
      currentStd,
    };
  }

  /**
   * Main orchestrator: validate, fetch, compute, score, return.
   */
  async analyzeDiversification(params) {
    const {
      holdings = [],
      candidates = [],
      days = 200,
      dataSource = 'auto',
    } = params;

    if (holdings.length === 0) throw new Error('No portfolio holdings specified');
    if (candidates.length === 0) throw new Error('No candidate tickers specified');

    // Compute weights from share counts using latest prices
    console.log('\nFetching latest prices to compute portfolio weights...');
    const weightedHoldings = await this.computeWeights(holdings);
    const normalizedHoldings = weightedHoldings.map(h => ({
      ticker: h.ticker.toUpperCase(),
      shares: h.shares,
      price: h.price,
      value: h.value,
      weight: h.weight,
    }));

    const allTickers = [
      ...normalizedHoldings.map(h => h.ticker),
      ...candidates.map(c => c.toUpperCase()),
    ];
    const uniqueTickers = [...new Set(allTickers)];

    console.log(`\nDiversification analysis: ${uniqueTickers.join(', ')}`);
    console.log(`Holdings: ${normalizedHoldings.map(h => `${h.ticker}: ${h.shares} shares @ $${h.price?.toFixed(2) || '?'} = ${h.weight.toFixed(1)}%`).join(', ')}`);
    console.log(`Candidates: ${candidates.join(', ')} (auto-optimizing weights)`);

    // Fetch aligned returns
    const alignedReturns = await this.fetchAlignedReturns(uniqueTickers, days, dataSource);
    console.log(`Aligned returns: ${alignedReturns.dates.length} common trading days`);

    // Correlation matrix
    const correlationMatrix = this.computeCorrelationMatrix(alignedReturns);

    // Implied expected returns for all tickers
    const impliedReturns = [];
    for (const ticker of uniqueTickers) {
      const ir = await this.computeImpliedExpectedReturn(ticker, alignedReturns.returns[ticker]);
      impliedReturns.push(ir);
    }

    // Score candidates
    const result = this.scoreCandidates({
      holdings: normalizedHoldings,
      candidates: candidates.map(c => c.toUpperCase()),
      alignedReturns,
      correlationMatrix,
      impliedReturns,
    });

    return {
      holdings: normalizedHoldings,
      candidates: candidates.map(c => c.toUpperCase()),
      days,
      tradingDays: alignedReturns.dates.length,
      correlationMatrix,
      impliedReturns,
      ...result,
    };
  }

  // ── HTML Report ─────────────────────────────────────────────────────

  generateDiversificationHTML(result) {
    const {
      holdings, correlationMatrix, impliedReturns, scores,
      currentStd,
      days, tradingDays,
    } = result;

    // Correlation color helper
    const corrColor = (v) => {
      const abs = Math.abs(v);
      if (abs < 0.3) return '#4caf50';  // green
      if (abs < 0.6) return '#ffeb3b';  // yellow
      return '#f44336';                   // red
    };

    const corrTextColor = (v) => {
      const abs = Math.abs(v);
      return abs < 0.6 ? '#000' : '#fff';
    };

    // Build correlation heatmap table
    const { matrix, tickers } = correlationMatrix;
    let corrRows = '';
    for (let i = 0; i < tickers.length; i++) {
      let cells = `<td style="font-weight:bold; padding:6px 10px;">${tickers[i]}</td>`;
      for (let j = 0; j < tickers.length; j++) {
        const v = matrix[i][j];
        const bg = corrColor(v);
        const fg = corrTextColor(v);
        cells += `<td style="background:${bg}; color:${fg}; text-align:center; padding:6px 10px; font-weight:${i === j ? 'normal' : 'bold'}">${v.toFixed(2)}</td>`;
      }
      corrRows += `<tr>${cells}</tr>`;
    }
    const corrHeader = tickers.map(t => `<th style="padding:6px 10px;">${t}</th>`).join('');

    // Holdings table
    const holdingsRows = holdings.map(h => {
      const ir = impliedReturns.find(r => r.ticker === h.ticker);
      const priceCell = h.price
        ? (h.currency && h.currency !== 'USD'
          ? `${h.price.toFixed(2)} ${h.currency} ($${h.priceUsd.toFixed(2)})`
          : '$' + h.price.toFixed(2))
        : 'N/A';
      return `<tr>
        <td>${h.ticker}</td>
        <td>${h.shares}</td>
        <td>${priceCell}</td>
        <td>${h.value ? '$' + h.value.toFixed(0) : 'N/A'}</td>
        <td style="font-weight:bold">${h.weight.toFixed(1)}%</td>
        <td>${ir ? (ir.impliedReturn * 100).toFixed(1) + '%' : 'N/A'}</td>
        <td>${ir?.atmIV ? (ir.atmIV * 100).toFixed(1) + '%' : 'N/A'}</td>
        <td>${ir?.source || 'N/A'}</td>
      </tr>`;
    }).join('');

    // Candidates table
    const candidateRows = scores.map((s, i) => {
      const signalColor = s.returnSignal > 0.1 ? '#4caf50' : s.returnSignal < -0.1 ? '#f44336' : '#888';
      return `<tr>
        <td style="font-weight:bold">${i + 1}</td>
        <td style="font-weight:bold">${s.ticker}</td>
        <td>${(s.annualizedVol * 100).toFixed(1)}%</td>
        <td>${s.optimalWeight.toFixed(1)}%</td>
        <td>${s.adjustedWeight.toFixed(1)}%</td>
        <td>${(s.impliedReturn * 100).toFixed(1)}%</td>
        <td>${s.atmIV ? (s.atmIV * 100).toFixed(1) + '%' : 'N/A'}</td>
        <td style="color:${s.avgCorrelation < 0.4 ? '#4caf50' : s.avgCorrelation < 0.7 ? '#ff9800' : '#f44336'}">${s.avgCorrelation.toFixed(2)}</td>
        <td style="color:${s.riskReduction > 0 ? '#4caf50' : '#f44336'}">${s.riskReduction.toFixed(2)}%</td>
        <td>${s.diversificationScore.toFixed(1)}</td>
        <td style="color:${signalColor}">${s.returnSignal >= 0 ? '+' : ''}${s.returnSignal.toFixed(2)}</td>
        <td style="font-weight:bold; font-size:1.1em">${s.score.toFixed(1)}</td>
        <td style="font-size:0.85em; color:#888">${s.returnSource}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Portfolio Diversification Analysis</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #fafafa; color: #333; }
    h1 { color: #1a237e; border-bottom: 2px solid #1a237e; padding-bottom: 8px; }
    h2 { color: #283593; margin-top: 30px; }
    table { border-collapse: collapse; margin: 12px 0; width: auto; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #e8eaf6; color: #1a237e; }
    tr:nth-child(even) { background: #f5f5f5; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
    .summary-card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 16px; text-align: center; }
    .summary-card .label { font-size: 0.85em; color: #666; }
    .summary-card .value { font-size: 1.4em; font-weight: bold; color: #1a237e; margin-top: 4px; }
    .legend { font-size: 0.85em; color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Portfolio Diversification Analysis</h1>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Trading Days</div>
      <div class="value">${tradingDays}</div>
    </div>
    <div class="summary-card">
      <div class="label">Current Portfolio Risk (σ)</div>
      <div class="value">${(currentStd * 100).toFixed(1)}%</div>
    </div>
  </div>

  <h2>Portfolio Holdings</h2>
  <table>
    <tr><th>Ticker</th><th>Shares</th><th>Price</th><th>Value</th><th>Weight</th><th>Expected Return</th><th>ATM IV</th><th>Return Source</th></tr>
    ${holdingsRows}
  </table>

  <h2>Correlation Heatmap</h2>
  <table>
    <tr><th></th>${corrHeader}</tr>
    ${corrRows}
  </table>
  <div class="legend">
    <span style="color:#4caf50">■</span> Low correlation (&lt;0.3)
    <span style="color:#ffeb3b">■</span> Moderate (0.3–0.6)
    <span style="color:#f44336">■</span> High (&gt;0.6)
  </div>

  <h2>Candidate Rankings</h2>
  <p>Two-stage scoring: diversification prior (cross-covariance) + options-implied update</p>
  <table>
    <tr>
      <th>#</th><th>Ticker</th><th>Own Vol (σ)</th><th>Min-Covar Wt</th><th>Adj. Weight</th><th>Implied Return</th><th>ATM IV</th>
      <th>Avg Corr w/ Portfolio</th><th>Risk Reduction</th><th>Div. Score</th><th>Return Signal</th>
      <th>Final Score</th><th>Source</th>
    </tr>
    ${candidateRows}
  </table>
  <div class="legend">
    <strong>Stage 1 — Diversification prior:</strong> Weight is auto-optimized (1–50%) to minimize cross-covariance with holdings only (candidate's own variance excluded).
    Volatile-but-uncorrelated candidates get higher weights. Div. Score = 0.5 × risk reduction % + 0.5 × (1 − avg |correlation|) × 100, clamped [0, 100].<br>
    <strong>Stage 2 — Options-implied update:</strong> Implied returns normalized to [−1, +1] signal across candidates.
    Final Score = Div. Score × (1 + 0.3 × signal), clamped [0, 100]. Adj. Weight = Min-Var Weight × (1 + 0.3 × signal), clamped [1%, 50%]. Options can shift score and weight ±30%.<br>
    Lookback = ${days} calendar days.
  </div>

</body>
</html>`;
  }
}

module.exports = PortfolioAnalysisService;
