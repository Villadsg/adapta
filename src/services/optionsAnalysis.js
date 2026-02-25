/**
 * OptionsAnalysisService - Fetches and analyzes options market activity
 *
 * Uses yahoo-finance2 options() method to fetch options chains, then computes
 * put/call ratios, implied volatility, and unusual volume metrics to gauge
 * market sentiment before stock events.
 */

const YahooFinance = require('yahoo-finance2').default;

class OptionsAnalysisService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Get a fresh YahooFinance instance.
   * Creating per-call avoids stale crumb/cookie state in long-running Electron processes.
   */
  _createYF() {
    return new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  /**
   * Fetch options chain for a ticker with retry logic
   * @param {string} ticker - Stock ticker symbol
   * @param {string} [expirationDate] - Optional expiration date (YYYY-MM-DD)
   * @param {number} [retries=2] - Number of retries on failure
   * @returns {Promise<Object|null>} Raw options chain or null on error
   */
  async fetchOptionsChain(ticker, expirationDate, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const yf = this._createYF();
        const queryOptions = {};
        if (expirationDate) {
          queryOptions.date = new Date(expirationDate);
        }
        const chain = await yf.options(ticker, queryOptions);
        return chain;
      } catch (error) {
        const isLastAttempt = attempt === retries;
        if (isLastAttempt) {
          console.error(`Error fetching options for ${ticker}: ${error.message}`);
          return null;
        }
        const delay = 3000 * (attempt + 1);
        console.log(`  Options fetch attempt ${attempt + 1} failed (${error.message}), retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return null;
  }

  /**
   * Analyze current options activity for a ticker
   * Fetches nearest expirations and computes aggregate metrics
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} [options={}] - Analysis options
   * @param {number} [options.maxExpirations=4] - Number of expirations to analyze
   * @returns {Promise<Object|null>} Options analysis data or null
   */
  async analyzeCurrentOptions(ticker, options = {}) {
    const { maxExpirations = 4 } = options;

    console.log(`\nFetching options data for ${ticker}...`);

    // Delay to avoid Yahoo Finance rate limiting (429) after prior API calls
    await new Promise(resolve => setTimeout(resolve, 2000));

    // First fetch to get available expirations and current price
    const initialChain = await this.fetchOptionsChain(ticker);
    if (!initialChain) {
      console.log(`No options data available for ${ticker}`);
      return null;
    }

    const currentPrice = initialChain.quote?.regularMarketPrice || null;
    if (!currentPrice) {
      console.log(`No current price available for ${ticker}`);
      return null;
    }

    const expirationDates = initialChain.expirationDates || [];
    if (expirationDates.length === 0) {
      console.log(`No expiration dates found for ${ticker}`);
      return null;
    }

    console.log(`  Current price: $${currentPrice}`);
    console.log(`  Available expirations: ${expirationDates.length}`);

    const nearestExpirations = expirationDates.slice(0, maxExpirations);
    const expirations = [];

    // Process first expiration from initial fetch — also determines the global
    // latest trade day (nearest expiration is most liquid, so its latest trade
    // date represents "today" reliably).
    const firstExpDate = nearestExpirations[0];
    const firstMetrics = this.computeExpirationMetrics(initialChain, currentPrice);
    const globalLatestTradeDay = firstMetrics?.localLatestTradeDay || '';
    if (globalLatestTradeDay) {
      console.log(`  Global latest trade day: ${globalLatestTradeDay}`);
    }
    if (firstMetrics) {
      firstMetrics.expirationDate = firstExpDate;
      expirations.push(firstMetrics);
      console.log(`  Expiration ${this.formatDate(firstExpDate)}: P/C ratio=${firstMetrics.putCallRatio.toFixed(2)}, ATM IV call=${(firstMetrics.atmCallIV * 100).toFixed(1)}%`);
    }

    // Fetch remaining expirations individually
    for (let i = 1; i < nearestExpirations.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
      const chain = await this.fetchOptionsChain(ticker, this.formatDate(nearestExpirations[i]));
      if (chain) {
        const metrics = this.computeExpirationMetrics(chain, currentPrice, globalLatestTradeDay);
        if (metrics) {
          metrics.expirationDate = nearestExpirations[i];
          expirations.push(metrics);
          console.log(`  Expiration ${this.formatDate(nearestExpirations[i])}: P/C ratio=${metrics.putCallRatio.toFixed(2)}, ATM IV call=${(metrics.atmCallIV * 100).toFixed(1)}%`);
        }
      }
    }

    if (expirations.length === 0) {
      console.log(`No valid options metrics computed for ${ticker}`);
      return null;
    }

    const summary = this.computeAggregateSummary(expirations, currentPrice);

    console.log(`  Sentiment: ${summary.sentiment} (P/C=${summary.avgPutCallRatio.toFixed(2)}, ATM IV=${(summary.avgAtmIV * 100).toFixed(1)}%, unusual=${summary.totalUnusualVolume})`);

    return {
      ticker: ticker.toUpperCase(),
      currentPrice,
      snapshotDate: new Date().toISOString(),
      expirations,
      summary
    };
  }

  /**
   * Compute metrics for a single expiration's options chain
   * @param {Object} optionChain - Raw options chain from yahoo-finance2
   * @param {number} currentPrice - Current stock price
   * @param {string} [globalLatestTradeDay] - The most recent trade day (YYYY-MM-DD) across all expirations, used to filter stale volume
   * @returns {Object|null} Computed metrics
   */
  computeExpirationMetrics(optionChain, currentPrice, globalLatestTradeDay) {
    const calls = optionChain.options?.[0]?.calls || [];
    const puts = optionChain.options?.[0]?.puts || [];

    if (calls.length === 0 && puts.length === 0) {
      return null;
    }

    // Volume totals
    const totalCallVolume = calls.reduce((sum, c) => sum + (c.volume || 0), 0);
    const totalPutVolume = puts.reduce((sum, p) => sum + (p.volume || 0), 0);
    const putCallRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;

    // Open interest totals
    const totalCallOI = calls.reduce((sum, c) => sum + (c.openInterest || 0), 0);
    const totalPutOI = puts.reduce((sum, p) => sum + (p.openInterest || 0), 0);
    const putCallOIRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // ATM options (closest strike to current price)
    const atmCall = this.findATMOption(calls, currentPrice);
    const atmPut = this.findATMOption(puts, currentPrice);
    const atmCallIV = this.normalizeIV(atmCall?.impliedVolatility);
    const atmPutIV = this.normalizeIV(atmPut?.impliedVolatility);

    console.log(`  ATM IV raw: call=${atmCall?.impliedVolatility}, put=${atmPut?.impliedVolatility} → normalized: call=${(atmCallIV*100).toFixed(1)}%, put=${(atmPutIV*100).toFixed(1)}%`);

    // Fresh trade filter — only count volume from the latest trade day
    const allRaw = [...calls, ...puts];
    const localLatestTradeDay = allRaw.reduce((max, c) => {
      const d = c.lastTradeDate ? new Date(c.lastTradeDate).toISOString().split('T')[0] : '';
      return d > max ? d : max;
    }, '');
    const latestTradeDay = globalLatestTradeDay || localLatestTradeDay;
    const isFreshTrade = (c) => {
      if (!c.lastTradeDate || !latestTradeDay) return true;
      return new Date(c.lastTradeDate).toISOString().split('T')[0] === latestTradeDay;
    };

    // Average IV (5%+ OTM, fresh trades only — volume-weighted in averageIV)
    const otmCalls = calls.filter(c => c.strike >= currentPrice * 1.05 && isFreshTrade(c));
    const otmPuts = puts.filter(p => p.strike <= currentPrice * 0.95 && isFreshTrade(p));
    const avgCallIV = this.averageIV(otmCalls);
    const avgPutIV = this.averageIV(otmPuts);

    // Max volume strikes
    const maxCallVolumeStrike = this.findMaxBy(calls, 'volume')?.strike || 0;
    const maxPutVolumeStrike = this.findMaxBy(puts, 'volume')?.strike || 0;

    // Max OI strikes
    const maxCallOIStrike = this.findMaxBy(calls, 'openInterest')?.strike || 0;
    const maxPutOIStrike = this.findMaxBy(puts, 'openInterest')?.strike || 0;

    // Unusual volume count (contracts where volume > 2x openInterest)
    const allContracts = [...calls, ...puts];
    const unusualVolumeCount = allContracts.filter(c =>
      (c.volume || 0) > 2 * (c.openInterest || 1)
    ).length;

    // --- Dollar Volume (Conviction) ---
    const computeContractDollarVolume = (contract, type) => {
      const vol = contract.volume || 0;
      const price = contract.lastPrice || 0;
      const dollarVolume = vol * price * 100;
      const premiumPctOfStock = currentPrice > 0 ? (price / currentPrice) * 100 : 0;
      return {
        contractSymbol: contract.contractSymbol || '',
        strike: contract.strike,
        lastPrice: price,
        change: contract.change || 0,
        percentChange: contract.percentChange || 0,
        bid: contract.bid || 0,
        ask: contract.ask || 0,
        volume: vol,
        openInterest: contract.openInterest || 0,
        impliedVolatility: contract.impliedVolatility || 0,
        normalizedIV: this.normalizeIV(contract.impliedVolatility),
        inTheMoney: contract.inTheMoney || false,
        lastTradeDate: contract.lastTradeDate || null,
        dollarVolume,
        premiumPctOfStock,
        type
      };
    };

    // Deep OTM only: 5%+ out of the money
    const otmCalls2 = calls.filter(c => c.strike >= currentPrice * 1.05);
    const otmPuts2 = puts.filter(p => p.strike <= currentPrice * 0.95);
    const freshCalls = otmCalls2.filter(isFreshTrade);
    const freshPuts = otmPuts2.filter(isFreshTrade);
    console.log(`  Dollar vol filter: latestTradeDay=${latestTradeDay}, globalLatestTradeDay=${globalLatestTradeDay || 'N/A'}, OTM calls ${otmCalls2.length}→${freshCalls.length}, OTM puts ${otmPuts2.length}→${freshPuts.length}`);
    const callContracts = freshCalls.map(c => computeContractDollarVolume(c, 'call'));
    const putContracts = freshPuts.map(p => computeContractDollarVolume(p, 'put'));

    const totalCallDollarVolume = callContracts.reduce((sum, c) => sum + c.dollarVolume, 0);
    const totalPutDollarVolume = putContracts.reduce((sum, c) => sum + c.dollarVolume, 0);

    // ITM+OTM: all contracts (no strike filter)
    const allCallContracts = calls.filter(isFreshTrade).map(c => computeContractDollarVolume(c, 'call'));
    const allPutContracts = puts.filter(isFreshTrade).map(p => computeContractDollarVolume(p, 'put'));
    const totalCallDollarVolumeAll = allCallContracts.reduce((sum, c) => sum + c.dollarVolume, 0);
    const totalPutDollarVolumeAll = allPutContracts.reduce((sum, c) => sum + c.dollarVolume, 0);
    const convictionRatioAll = totalPutDollarVolumeAll > 0 ? totalCallDollarVolumeAll / totalPutDollarVolumeAll : 0;
    // Log top put contracts by dollar volume for debugging
    if (putContracts.length > 0) {
      const topPuts = [...putContracts].sort((a, b) => b.dollarVolume - a.dollarVolume).slice(0, 3);
      topPuts.forEach(p => console.log(`    Top put: strike=$${p.strike}, vol=${p.volume}, lastPrice=$${p.lastPrice}, dollarVol=$${p.dollarVolume.toFixed(0)}, lastTrade=${p.lastTradeDate}`));
    }
    const convictionRatio = totalPutDollarVolume > 0 ? totalCallDollarVolume / totalPutDollarVolume : 0;

    const allContractsByDollar = [...callContracts, ...putContracts].sort((a, b) => b.dollarVolume - a.dollarVolume);
    const hottestContract = allContractsByDollar.length > 0 ? allContractsByDollar[0] : null;

    // --- Expected Move (ATM Straddle) ---
    const atmCallPrice = atmCall?.lastPrice || 0;
    const atmPutPrice = atmPut?.lastPrice || 0;
    const expectedMoveDollar = atmCallPrice + atmPutPrice;
    const expectedMovePct = currentPrice > 0 ? (expectedMoveDollar / currentPrice) * 100 : 0;

    // --- Volume/OI Ratios ---
    const callVOI = totalCallOI > 0 ? totalCallVolume / totalCallOI : 0;
    const putVOI = totalPutOI > 0 ? totalPutVolume / totalPutOI : 0;

    // --- Volume Conviction Score (0-9) ---
    // Sub-score 1: Unusual volume intensity (% of contracts with volume > 2x OI) → 0-3
    const totalContracts = allContracts.length;
    const unusualPct = totalContracts > 0 ? unusualVolumeCount / totalContracts : 0;
    const unusualScore = unusualPct >= 0.15 ? 3 : unusualPct >= 0.08 ? 2 : unusualPct >= 0.03 ? 1 : 0;

    // Sub-score 2: Volume/OI ratio (daily volume as % of total OI) → 0-3
    const totalOI = totalCallOI + totalPutOI;
    const totalVolume = totalCallVolume + totalPutVolume;
    const voiRatio = totalOI > 0 ? totalVolume / totalOI : 0;
    const voiScore = voiRatio >= 0.5 ? 3 : voiRatio >= 0.2 ? 2 : voiRatio >= 0.05 ? 1 : 0;

    // Sub-score 3: Dollar concentration (top 5 contracts %) → 0-3
    const totalDollarVolume = totalCallDollarVolume + totalPutDollarVolume;
    const top5Dollar = allContractsByDollar.slice(0, 5).reduce((sum, c) => sum + c.dollarVolume, 0);
    const dollarConcentrationRatio = totalDollarVolume > 0 ? top5Dollar / totalDollarVolume : 0;
    const concScore = dollarConcentrationRatio >= 0.6 ? 3 : dollarConcentrationRatio >= 0.4 ? 2 : dollarConcentrationRatio >= 0.2 ? 1 : 0;

    const volumeConvictionScore = unusualScore + voiScore + concScore;

    return {
      totalCallVolume,
      totalPutVolume,
      putCallRatio,
      totalCallOI,
      totalPutOI,
      putCallOIRatio,
      atmCallIV,
      atmPutIV,
      avgCallIV,
      avgPutIV,
      maxCallVolumeStrike,
      maxPutVolumeStrike,
      maxCallOIStrike,
      maxPutOIStrike,
      unusualVolumeCount,
      expectedMoveDollar,
      expectedMovePct,
      atmCallPrice,
      atmPutPrice,
      callVOI,
      putVOI,
      volumeConvictionScore,
      unusualScore,
      voiScore,
      concScore,
      totalCallDollarVolume,
      totalPutDollarVolume,
      convictionRatio,
      hottestContract,
      callContracts,
      putContracts,
      allCallContracts,
      allPutContracts,
      totalCallDollarVolumeAll,
      totalPutDollarVolumeAll,
      convictionRatioAll,
      localLatestTradeDay
    };
  }

  /**
   * Compute aggregate summary across expirations
   * @param {Array} expirationMetrics - Metrics per expiration
   * @param {number} currentPrice - Current stock price
   * @returns {Object} Aggregate summary with sentiment classification
   */
  computeAggregateSummary(expirationMetrics, currentPrice) {
    const totalCallVol = expirationMetrics.reduce((s, e) => s + e.totalCallVolume, 0);
    const totalPutVol = expirationMetrics.reduce((s, e) => s + e.totalPutVolume, 0);
    const avgPutCallRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;

    const totalCallOI = expirationMetrics.reduce((s, e) => s + e.totalCallOI, 0);
    const totalPutOI = expirationMetrics.reduce((s, e) => s + e.totalPutOI, 0);
    const avgPutCallOIRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Average ATM IV across expirations (separate call/put and blended)
    const callIVValues = expirationMetrics
      .map(e => e.avgCallIV || e.atmCallIV || 0)
      .filter(v => v > 0);
    const putIVValues = expirationMetrics
      .map(e => e.avgPutIV || e.atmPutIV || 0)
      .filter(v => v > 0);
    const avgCallIV = callIVValues.length > 0
      ? callIVValues.reduce((s, v) => s + v, 0) / callIVValues.length : 0;
    const avgPutIV = putIVValues.length > 0
      ? putIVValues.reduce((s, v) => s + v, 0) / putIVValues.length : 0;
    const ivValues = expirationMetrics
      .map(e => (e.avgCallIV + e.avgPutIV) / 2 || (e.atmCallIV + e.atmPutIV) / 2)
      .filter(v => v > 0);
    const avgAtmIV = ivValues.length > 0
      ? ivValues.reduce((s, v) => s + v, 0) / ivValues.length
      : 0;

    const totalUnusualVolume = expirationMetrics.reduce((s, e) => s + e.unusualVolumeCount, 0);

    // Aggregate dollar volume (conviction)
    const totalCallDollarVolume = expirationMetrics.reduce((s, e) => s + (e.totalCallDollarVolume || 0), 0);
    const totalPutDollarVolume = expirationMetrics.reduce((s, e) => s + (e.totalPutDollarVolume || 0), 0);
    const overallConvictionRatio = totalPutDollarVolume > 0 ? totalCallDollarVolume / totalPutDollarVolume : 0;

    // Find hottest contract across all expirations
    let overallHottestContract = null;
    for (const exp of expirationMetrics) {
      if (exp.hottestContract && (!overallHottestContract || exp.hottestContract.dollarVolume > overallHottestContract.dollarVolume)) {
        overallHottestContract = { ...exp.hottestContract, expirationDate: exp.expirationDate };
      }
    }

    // Aggregate expected move (weighted average across expirations)
    const movePcts = expirationMetrics.map(e => e.expectedMovePct).filter(v => v > 0);
    const avgExpectedMovePct = movePcts.length > 0 ? movePcts.reduce((s, v) => s + v, 0) / movePcts.length : 0;
    // Nearest expiration expected move is most actionable
    const nearestExpectedMovePct = expirationMetrics[0]?.expectedMovePct || 0;
    const nearestExpectedMoveDollar = expirationMetrics[0]?.expectedMoveDollar || 0;

    // Cross-expiration expected move jump (detect event between expirations)
    let maxMoveJump = null;
    for (let i = 1; i < expirationMetrics.length; i++) {
      const jump = expirationMetrics[i].expectedMovePct - expirationMetrics[i - 1].expectedMovePct;
      if (maxMoveJump === null || Math.abs(jump) > Math.abs(maxMoveJump.jump)) {
        maxMoveJump = {
          jump,
          fromExpiration: expirationMetrics[i - 1].expirationDate,
          toExpiration: expirationMetrics[i].expirationDate
        };
      }
    }

    // Term structure: ATM IV per expiration with DTE
    const now = new Date();
    const termStructure = expirationMetrics
      .filter(e => e.expirationDate)
      .map(e => {
        const expDate = new Date(e.expirationDate);
        const daysToExpiry = Math.max(1, Math.round((expDate - now) / (1000 * 60 * 60 * 24)));
        const callIV = e.avgCallIV || e.atmCallIV || 0;
        const putIV = e.avgPutIV || e.atmPutIV || 0;
        const atmIV = (callIV + putIV) / 2;
        return { expirationDate: e.expirationDate, daysToExpiry, atmIV, callIV, putIV };
      })
      .filter(t => t.atmIV > 0)
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

    // Term structure slope and shape
    let termStructureSlope = 0;
    let termStructureShape = 'insufficient data';
    let maxIVJump = null;

    if (termStructure.length >= 2) {
      // Slope: IV change per 30 days between first and last
      const first = termStructure[0];
      const last = termStructure[termStructure.length - 1];
      const dteDiff = last.daysToExpiry - first.daysToExpiry;
      if (dteDiff > 0) {
        termStructureSlope = ((last.atmIV - first.atmIV) / dteDiff) * 30; // per 30 days
      }

      // Shape classification
      if (termStructureSlope > 0.005) termStructureShape = 'contango';
      else if (termStructureSlope < -0.005) termStructureShape = 'backwardation';
      else termStructureShape = 'flat';

      // Find largest IV jump per day between consecutive expirations
      for (let i = 1; i < termStructure.length; i++) {
        const ivDiff = termStructure[i].atmIV - termStructure[i - 1].atmIV;
        const daysDiff = termStructure[i].daysToExpiry - termStructure[i - 1].daysToExpiry;
        const jumpPerDay = daysDiff > 0 ? ivDiff / daysDiff : 0;
        if (maxIVJump === null || Math.abs(jumpPerDay) > Math.abs(maxIVJump.jumpPerDay)) {
          maxIVJump = {
            jumpPerDay,
            ivDiff,
            fromExpiration: termStructure[i - 1].expirationDate,
            toExpiration: termStructure[i].expirationDate,
            fromDTE: termStructure[i - 1].daysToExpiry,
            toDTE: termStructure[i].daysToExpiry
          };
        }
      }
    }

    // Max volume conviction score across expirations
    const maxVolumeConviction = Math.max(0, ...expirationMetrics.map(e => e.volumeConvictionScore || 0));

    // Classify sentiment
    let sentiment = 'neutral';
    let sentimentScore = 0; // -4 to +4

    // P/C ratio signal: <0.7 = bullish, >1.0 = bearish
    if (avgPutCallRatio < 0.7) sentimentScore += 1;
    else if (avgPutCallRatio > 1.0) sentimentScore -= 1;

    // P/C OI ratio signal
    if (avgPutCallOIRatio < 0.7) sentimentScore += 1;
    else if (avgPutCallOIRatio > 1.0) sentimentScore -= 1;

    // High unusual volume indicates anticipation of movement
    if (totalUnusualVolume > 5) {
      if (avgPutCallRatio < 0.8) sentimentScore += 1;
      else if (avgPutCallRatio > 1.0) sentimentScore -= 1;
    }

    // Conviction ratio signal: call $ >> put $ = bullish, put $ >> call $ = bearish
    if (overallConvictionRatio > 2.0) sentimentScore += 1;
    else if (overallConvictionRatio < 0.5) sentimentScore -= 1;

    if (sentimentScore >= 2) sentiment = 'bullish';
    else if (sentimentScore <= -2) sentiment = 'bearish';

    return {
      totalCallVolume: totalCallVol,
      totalPutVolume: totalPutVol,
      avgPutCallRatio,
      totalCallOI,
      totalPutOI,
      avgPutCallOIRatio,
      avgAtmIV,
      avgCallIV,
      avgPutIV,
      totalUnusualVolume,
      avgExpectedMovePct,
      nearestExpectedMovePct,
      nearestExpectedMoveDollar,
      maxMoveJump,
      totalCallDollarVolume,
      totalPutDollarVolume,
      overallConvictionRatio,
      overallHottestContract,
      termStructure,
      termStructureSlope,
      termStructureShape,
      maxIVJump,
      maxVolumeConviction,
      sentiment,
      sentimentScore
    };
  }

  /**
   * Save options snapshot to database
   * @param {Object} optionsData - Data from analyzeCurrentOptions()
   */
  async saveSnapshot(optionsData) {
    for (const exp of optionsData.expirations) {
      await this.database.saveOptionsSnapshot(
        optionsData.ticker,
        optionsData.snapshotDate,
        this.formatDate(exp.expirationDate),
        optionsData.currentPrice,
        exp
      );
    }
    console.log(`  Saved ${optionsData.expirations.length} options snapshots for ${optionsData.ticker}`);
  }

  /**
   * Get historical snapshots for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {number} days - Number of days of history
   * @returns {Promise<Array>} Snapshot records
   */
  async getSnapshotHistory(ticker, days = 30) {
    return this.database.getOptionsSnapshots(ticker, days);
  }

  // ===== Event Anticipation Metrics =====

  /**
   * Compute event anticipation metrics from options data.
   * Combines VRP, term structure, event move decomposition, volume conviction,
   * and historical trend into a composite index (0-100).
   *
   * @param {Object} summary - Aggregate summary from computeAggregateSummary
   * @param {Array} expirations - Per-expiration metrics
   * @param {Object} historicalVolatility - { annualizedHV, dailyStdDev, sampleSize }
   * @param {Array} snapshotHistory - Historical snapshots from database
   * @returns {Object} Full event anticipation object
   */
  computeEventAnticipation(summary, expirations, historicalVolatility, snapshotHistory) {
    const hv = historicalVolatility?.annualizedHV || 0;
    const avgAtmIV = summary?.avgAtmIV || 0;

    // === 1. Volatility Risk Premium (VRP) ===
    const vrpRatio = hv > 0 ? avgAtmIV / hv : 0;
    const vrpSpread = avgAtmIV - hv;
    let vrpSignal, vrpLevel;
    if (vrpRatio > 1.50) { vrpSignal = 'Strong event premium — catalyst priced in'; vrpLevel = 'high'; }
    else if (vrpRatio > 1.20) { vrpSignal = 'Moderate anticipation'; vrpLevel = 'moderate'; }
    else if (vrpRatio > 0.80) { vrpSignal = 'Normal — IV roughly matches realized vol'; vrpLevel = 'normal'; }
    else if (vrpRatio > 0) { vrpSignal = 'IV compression — post-event or complacent'; vrpLevel = 'low'; }
    else { vrpSignal = 'Insufficient data'; vrpLevel = 'unknown'; }

    // VRP score: 0-25 points
    let vrpScore;
    if (vrpRatio >= 2.0) vrpScore = 25;
    else if (vrpRatio >= 1.5) vrpScore = 20 + (vrpRatio - 1.5) * 10;
    else if (vrpRatio >= 1.2) vrpScore = 12 + (vrpRatio - 1.2) * (8 / 0.3);
    else if (vrpRatio >= 0.8) vrpScore = (vrpRatio - 0.8) * (12 / 0.4);
    else vrpScore = 0;
    vrpScore = Math.min(25, Math.max(0, vrpScore));

    // === 2. IV Term Structure Shape ===
    const termShape = summary?.termStructureShape || 'insufficient data';
    const termSlope = summary?.termStructureSlope || 0;
    const maxIVJump = summary?.maxIVJump || null;

    let termSignal;
    if (termShape === 'backwardation') termSignal = 'Near-term event anticipated (IV backwardation)';
    else if (termShape === 'contango') termSignal = 'No specific near-term catalyst (normal contango)';
    else if (termShape === 'flat') termSignal = 'Flat term structure';
    else termSignal = 'Insufficient data';

    // Check for kink (sharp IV jump between two specific expirations)
    let termKink = null;
    if (maxIVJump && Math.abs(maxIVJump.ivDiff) > 0.03) {
      termKink = {
        fromExpiration: maxIVJump.fromExpiration,
        toExpiration: maxIVJump.toExpiration,
        ivDiff: maxIVJump.ivDiff,
        signal: `Sharp IV jump between ${this.formatDate(maxIVJump.fromExpiration)} and ${this.formatDate(maxIVJump.toExpiration)} — event likely falls between these dates`
      };
    }

    // Term structure score: 0-20 points
    let termScore = 0;
    if (termShape === 'backwardation') termScore = 15 + Math.min(5, Math.abs(termSlope) * 100);
    else if (termShape === 'flat') termScore = 5;
    else termScore = 0;
    if (termKink) termScore = Math.min(20, termScore + 5);
    termScore = Math.min(20, Math.max(0, termScore));

    // === 3. Implied Event Move (Straddle Decomposition) ===
    const now = new Date();
    const eventMovePerExpiration = (expirations || []).map(exp => {
      if (!exp.expirationDate) return null;
      const expDate = new Date(exp.expirationDate);
      const dte = Math.max(1, Math.round((expDate - now) / (1000 * 60 * 60 * 24)));
      const normalMovePct = hv > 0 ? hv * Math.sqrt(dte / 252) * 100 : 0;
      const straddleMovePct = exp.expectedMovePct || 0;
      const eventPremiumPct = straddleMovePct - normalMovePct;
      const eventPremiumRatio = normalMovePct > 0 ? straddleMovePct / normalMovePct : 0;

      return {
        expirationDate: exp.expirationDate,
        dte,
        straddleMovePct,
        normalMovePct,
        eventPremiumPct,
        eventPremiumRatio
      };
    }).filter(Boolean);

    // Use nearest expiration for headline metric
    const nearestEventMove = eventMovePerExpiration.length > 0 ? eventMovePerExpiration[0] : null;
    const maxEventPremiumRatio = eventMovePerExpiration.length > 0
      ? Math.max(...eventMovePerExpiration.map(e => e.eventPremiumRatio))
      : 0;

    let eventMoveSignal;
    if (maxEventPremiumRatio > 2.0) eventMoveSignal = 'Major event priced in — straddle is 2x+ the HV-implied move';
    else if (maxEventPremiumRatio > 1.5) eventMoveSignal = 'Significant event premium in straddle';
    else if (maxEventPremiumRatio > 1.0) eventMoveSignal = 'Mild excess over HV-implied move';
    else if (maxEventPremiumRatio > 0) eventMoveSignal = 'No event premium — straddle is cheap vs realized';
    else eventMoveSignal = 'Insufficient data';

    // Event move score: 0-25 points
    let eventMoveScore;
    if (maxEventPremiumRatio >= 3.0) eventMoveScore = 25;
    else if (maxEventPremiumRatio >= 2.0) eventMoveScore = 20 + (maxEventPremiumRatio - 2.0) * 5;
    else if (maxEventPremiumRatio >= 1.5) eventMoveScore = 12 + (maxEventPremiumRatio - 1.5) * (8 / 0.5);
    else if (maxEventPremiumRatio >= 1.0) eventMoveScore = (maxEventPremiumRatio - 1.0) * (12 / 0.5);
    else eventMoveScore = 0;
    eventMoveScore = Math.min(25, Math.max(0, eventMoveScore));

    // === 4. Volume Conviction Score ===
    const maxConviction = summary?.maxVolumeConviction || 0;

    let convictionSignal;
    if (maxConviction >= 7) convictionSignal = 'Very high conviction — concentrated heavy activity';
    else if (maxConviction >= 4) convictionSignal = 'Elevated — notable positioning';
    else if (maxConviction >= 1) convictionSignal = 'Low — routine flow';
    else convictionSignal = 'Minimal';

    // Conviction score: 0-15 points
    const convictionScore = Math.min(15, (maxConviction / 9) * 15);

    // === 5. Historical Volume Conviction (dollar volume trend from snapshots) ===
    // Aggregate call/put dollar volume per snapshot date (sum across the 2 nearest expirations)
    const dollarVolHistory = [];
    if (snapshotHistory && snapshotHistory.length > 0) {
      const byDate = new Map();
      for (const snap of snapshotHistory) {
        const dateKey = new Date(snap.snapshot_date).toISOString().split('T')[0];
        if (!byDate.has(dateKey)) byDate.set(dateKey, { callDollar: 0, putDollar: 0, count: 0 });
        const entry = byDate.get(dateKey);
        // Each row is one expiration — sum the 2 nearest per date
        if (entry.count < 2) {
          entry.callDollar += Number(snap.total_call_dollar_volume) || 0;
          entry.putDollar += Number(snap.total_put_dollar_volume) || 0;
          entry.count++;
        }
      }
      for (const [date, vals] of Array.from(byDate.entries()).sort()) {
        dollarVolHistory.push({ date, totalCallDollar: vals.callDollar, totalPutDollar: vals.putDollar });
      }
    }

    // Current snapshot totals (from live expirations, 2 nearest)
    const currentCallDollar = (expirations || []).slice(0, 2)
      .reduce((s, e) => s + (e.totalCallDollarVolume || 0), 0);
    const currentPutDollar = (expirations || []).slice(0, 2)
      .reduce((s, e) => s + (e.totalPutDollarVolume || 0), 0);
    const dollarConvictionRatio = currentPutDollar > 0 ? currentCallDollar / currentPutDollar : 0;

    // Score based on total dollar volume magnitude and skew
    const totalDollar = currentCallDollar + currentPutDollar;
    let volConvictionScore = 0;
    if (totalDollar >= 10_000_000) volConvictionScore += 2;
    else if (totalDollar >= 1_000_000) volConvictionScore += 1;
    const skewRatio = Math.max(dollarConvictionRatio, dollarConvictionRatio > 0 ? 1 / dollarConvictionRatio : 0);
    if (skewRatio >= 3.0) volConvictionScore += 2;
    else if (skewRatio >= 1.5) volConvictionScore += 1;

    let volConvictionSignal;
    if (totalDollar === 0) volConvictionSignal = 'No expiration data';
    else if (dollarConvictionRatio >= 2.0) volConvictionSignal = 'Strong call-side conviction';
    else if (dollarConvictionRatio >= 1.3) volConvictionSignal = 'Moderate call-side lean';
    else if (dollarConvictionRatio <= 0.5) volConvictionSignal = 'Strong put-side conviction';
    else if (dollarConvictionRatio <= 0.77) volConvictionSignal = 'Moderate put-side lean';
    else volConvictionSignal = 'Balanced flow';

    // Volume conviction component: 0-15 points
    const trendPoints = Math.min(15, (volConvictionScore / 4) * 15);

    // === 6. Composite Event Anticipation Index (0-100) ===
    const compositeIndex = Math.round(
      Math.min(100, vrpScore + eventMoveScore + termScore + convictionScore + trendPoints)
    );

    let compositeLevel;
    if (compositeIndex >= 70) compositeLevel = 'Extreme — major event imminent';
    else if (compositeIndex >= 50) compositeLevel = 'High';
    else if (compositeIndex >= 30) compositeLevel = 'Moderate';
    else if (compositeIndex >= 15) compositeLevel = 'Low';
    else compositeLevel = 'None detected';

    return {
      compositeIndex,
      compositeLevel,
      components: {
        vrp: {
          ratio: vrpRatio,
          spread: vrpSpread,
          signal: vrpSignal,
          level: vrpLevel,
          score: Math.round(vrpScore),
          maxScore: 25
        },
        eventMove: {
          perExpiration: eventMovePerExpiration,
          nearest: nearestEventMove,
          maxPremiumRatio: maxEventPremiumRatio,
          signal: eventMoveSignal,
          score: Math.round(eventMoveScore),
          maxScore: 25
        },
        termStructure: {
          shape: termShape,
          slope: termSlope,
          kink: termKink,
          signal: termSignal,
          data: summary?.termStructure || [],
          score: Math.round(termScore),
          maxScore: 20
        },
        volumeConviction: {
          maxScore9: maxConviction,
          signal: convictionSignal,
          score: Math.round(convictionScore),
          maxScore: 15,
          perExpiration: (expirations || []).filter(e => e.expirationDate).map(e => ({
            expirationDate: e.expirationDate,
            callVOI: e.callVOI || 0,
            putVOI: e.putVOI || 0,
            totalOI: (e.totalCallOI || 0) + (e.totalPutOI || 0),
            atmCallIV: e.atmCallIV || 0,
            atmPutIV: e.atmPutIV || 0,
            convictionRatio: e.convictionRatio || 0,
            totalCallDollarVolume: e.totalCallDollarVolume || 0,
            totalPutDollarVolume: e.totalPutDollarVolume || 0,
            contracts: [...(e.callContracts || []), ...(e.putContracts || [])].map(c => ({
              strike: c.strike, dollarVolume: c.dollarVolume, type: c.type,
              lastTradeDate: c.lastTradeDate || null
            }))
          }))
        },
        volumeConvictionAll: {
          score: Math.round(convictionScore),
          maxScore: 15,
          signal: convictionSignal,
          perExpiration: (expirations || []).filter(e => e.expirationDate).map(e => ({
            expirationDate: e.expirationDate,
            convictionRatio: e.convictionRatioAll || 0,
            totalCallDollarVolume: e.totalCallDollarVolumeAll || 0,
            totalPutDollarVolume: e.totalPutDollarVolumeAll || 0,
            contracts: [...(e.allCallContracts || []), ...(e.allPutContracts || [])].map(c => ({
              strike: c.strike, dollarVolume: c.dollarVolume, type: c.type,
              lastTradeDate: c.lastTradeDate || null
            }))
          }))
        },
        historicalVolConviction: {
          history: dollarVolHistory,
          totalCallDollar: currentCallDollar,
          totalPutDollar: currentPutDollar,
          ratio: dollarConvictionRatio,
          signal: volConvictionSignal,
          score: Math.round(trendPoints),
          maxScore: 15
        }
      },
      callouts: this._generateCallouts(vrpRatio, nearestEventMove, termShape, termKink, maxConviction, hv)
    };
  }

  /**
   * Compute linear trend (slope) from [x, y] pairs
   * @param {Array} points - [[x, y], ...]
   * @returns {Object} { slope, intercept }
   */
  _computeLinearTrend(points) {
    const validPoints = points.filter(p => !isNaN(p[0]) && !isNaN(p[1]) && p[1] !== null);
    if (validPoints.length < 2) return { slope: 0, intercept: 0 };

    const n = validPoints.length;
    const sumX = validPoints.reduce((s, p) => s + p[0], 0);
    const sumY = validPoints.reduce((s, p) => s + p[1], 0);
    const sumXY = validPoints.reduce((s, p) => s + p[0] * p[1], 0);
    const sumX2 = validPoints.reduce((s, p) => s + p[0] * p[0], 0);

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: sumY / n };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  }

  /**
   * Generate human-readable callouts from event anticipation metrics
   */
  _generateCallouts(vrpRatio, nearestEventMove, termShape, termKink, maxConviction, hv) {
    const callouts = [];

    if (nearestEventMove && hv > 0) {
      callouts.push(
        `Straddle prices ${nearestEventMove.straddleMovePct.toFixed(1)}% move vs ${nearestEventMove.normalMovePct.toFixed(1)}% historical (${nearestEventMove.dte}d)`
      );
    }

    if (vrpRatio > 1.5) {
      callouts.push(`IV is ${(vrpRatio).toFixed(1)}x realized volatility — strong event premium`);
    } else if (vrpRatio > 0 && vrpRatio < 0.8) {
      callouts.push(`IV below realized vol — possible post-event compression`);
    }

    if (termShape === 'backwardation') {
      callouts.push('IV backwardation detected — near-term event anticipated');
    }

    if (termKink) {
      callouts.push(termKink.signal);
    }

    if (maxConviction >= 7) {
      callouts.push('Very high options conviction — concentrated, targeted positioning');
    }

    return callouts;
  }

  // ===== Helper methods =====

  /**
   * Normalize raw impliedVolatility from Yahoo Finance to annualized decimal.
   * Yahoo returns daily variance (σ²/day), not annualized stdev.
   * Detect format by magnitude and convert accordingly.
   * @param {number} rawIV - Raw impliedVolatility value
   * @returns {number} Annualized IV as decimal (0.30 = 30%)
   */
  normalizeIV(rawIV) {
    if (!rawIV || rawIV <= 0) return 0;
    // Raw values ≤ 0.02 are daily variance (sqrt(0.02*252) = 224% — highest plausible IV)
    // Raw values > 0.02 are already annualized decimal (2% IV min — near impossible for options)
    if (rawIV <= 0.02) {
      return Math.sqrt(rawIV * 252);
    }
    return rawIV;
  }

  /**
   * Find the option closest to the current price (ATM)
   * @param {Array} options - Array of option contracts
   * @param {number} currentPrice - Current stock price
   * @returns {Object|null} Closest option contract
   */
  findATMOption(options, currentPrice) {
    if (!options || options.length === 0) return null;
    let closest = options[0];
    let minDiff = Math.abs((closest.strike || 0) - currentPrice);

    for (const opt of options) {
      const diff = Math.abs((opt.strike || 0) - currentPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closest = opt;
      }
    }
    return closest;
  }

  /**
   * Compute average implied volatility from options array
   * @param {Array} options - Array of option contracts
   * @returns {number} Average IV (0 if none)
   */
  averageIV(options) {
    const weighted = options
      .map(o => ({ iv: this.normalizeIV(o.impliedVolatility), vol: o.volume || 0 }))
      .filter(o => o.iv > 0);
    if (weighted.length === 0) return 0;
    const totalVol = weighted.reduce((s, o) => s + o.vol, 0);
    if (totalVol === 0) {
      // No volume at all — fall back to simple average
      return weighted.reduce((s, o) => s + o.iv, 0) / weighted.length;
    }
    return weighted.reduce((s, o) => s + o.iv * o.vol, 0) / totalVol;
  }

  /**
   * Find option with maximum value for a given field
   * @param {Array} options - Array of option contracts
   * @param {string} field - Field name to maximize
   * @returns {Object|null} Option with max value
   */
  findMaxBy(options, field) {
    if (!options || options.length === 0) return null;
    return options.reduce((max, opt) =>
      (opt[field] || 0) > (max[field] || 0) ? opt : max
    , options[0]);
  }

  /**
   * Format a date as YYYY-MM-DD string
   * @param {Date|string} date - Date to format
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0];
  }
}

module.exports = OptionsAnalysisService;
