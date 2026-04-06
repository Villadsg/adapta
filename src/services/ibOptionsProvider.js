/**
 * IB Gateway Options Provider
 *
 * Connects to Interactive Brokers Gateway/TWS via the @stoqey/ib package
 * to fetch options chains for international tickers (Eurex, MEFF, Euronext, HKEX, etc.).
 *
 * Returns data in yahoo-finance2-compatible format so that the existing
 * computeExpirationMetrics() in optionsAnalysis.js can consume it directly.
 *
 * Requirements:
 *   - IB Gateway or TWS running locally (port 4002 for paper, 4001 for live)
 *   - Market data subscriptions for the relevant exchanges
 */

const { IBApi, EventName, SecType, OptionType, Contract } = require('@stoqey/ib');

// Map Yahoo Finance suffixes to IB exchange + currency
const EXCHANGE_MAP = {
  '.PA': { exchange: 'SBF', currency: 'EUR', primaryExchange: 'SBF' },        // Euronext Paris
  '.AS': { exchange: 'AEB', currency: 'EUR', primaryExchange: 'AEB' },        // Euronext Amsterdam
  '.DE': { exchange: 'IBIS', currency: 'EUR', primaryExchange: 'IBIS' },      // Xetra
  '.MC': { exchange: 'BM', currency: 'EUR', primaryExchange: 'BM' },          // Bolsa de Madrid
  '.MI': { exchange: 'BVME', currency: 'EUR', primaryExchange: 'BVME' },      // Borsa Italiana
  '.L':  { exchange: 'LSE', currency: 'GBP', primaryExchange: 'LSE' },        // London
  '.SW': { exchange: 'EBS', currency: 'CHF', primaryExchange: 'EBS' },        // SIX Swiss
  '.HK': { exchange: 'SEHK', currency: 'HKD', primaryExchange: 'SEHK' },     // Hong Kong
  '.SS': { exchange: 'SEHKNTL', currency: 'CNH', primaryExchange: 'SEHKNTL' }, // Shanghai via Stock Connect
  '.SZ': { exchange: 'SEHKSZSE', currency: 'CNH', primaryExchange: 'SEHKSZSE' }, // Shenzhen via Stock Connect
};

// Options exchanges corresponding to stock exchanges
const OPTIONS_EXCHANGE_MAP = {
  '.PA': 'DTB',    // Eurex covers French underlyings
  '.AS': 'DTB',    // Eurex covers Dutch underlyings
  '.DE': 'DTB',    // Eurex (German)
  '.MC': 'MEFFRV', // MEFF (Spanish)
  '.MI': 'IDEM',   // IDEM (Italian)
  '.L':  'LSEIOB1',// ICE Futures Europe / LSE options
  '.SW': 'DTB',    // Eurex covers Swiss underlyings
  '.HK': 'SEHK',   // HKEX options
};

class IBOptionsProvider {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 4002; // 4002 = paper trading, 4001 = live
    this.clientId = options.clientId || 0;
    this.ib = null;
    this.connected = false;
    this._nextReqId = 1000;
    this._pendingRequests = new Map();
    this._connectPromise = null;
    this._connectFailed = false;
  }

  _getReqId() {
    return this._nextReqId++;
  }

  /**
   * Connect to IB Gateway. Returns true if connected, false if Gateway isn't running.
   */
  async connect() {
    if (this.connected) return true;
    if (this._connectFailed) return false; // Don't retry after a failed connection attempt
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve) => {
      try {
        this.ib = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });

        let resolved = false;
        const resolveOnce = (val) => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(val); } };

        const timeout = setTimeout(() => {
          console.log('[IB] Connection timeout — IB Gateway not running?');
          this._connectFailed = true;
          this._cleanup();
          resolveOnce(false);
        }, 5000);

        this.ib.on(EventName.connected, () => {
          this.connected = true;
          console.log('[IB] Connected to IB Gateway');
          resolveOnce(true);
        });

        this.ib.on(EventName.error, (err, code, reqId) => {
          // Connection refused means Gateway isn't running
          if (code === -1 || code === 502 || err?.code === 'ECONNREFUSED') {
            console.log('[IB] Cannot connect — IB Gateway not running');
            this._connectFailed = true;
            this._cleanup();
            resolveOnce(false);
            return;
          }
          // Route errors to pending requests
          if (reqId >= 0 && this._pendingRequests.has(reqId)) {
            const req = this._pendingRequests.get(reqId);
            req.onError?.(err, code);
          } else if (code !== 2104 && code !== 2106 && code !== 2158) {
            // Ignore data farm connection messages
            console.error(`[IB] Error: code=${code}, ${err?.message || err}`);
          }
        });

        this.ib.on(EventName.disconnected, () => {
          this.connected = false;
          this._connectPromise = null;
          console.log('[IB] Disconnected from IB Gateway');
        });

        this.ib.connect();
      } catch (err) {
        console.error(`[IB] Connection error: ${err.message}`);
        resolve(false);
      }
    });

    return this._connectPromise;
  }

  _cleanup() {
    this.connected = false;
    this._connectPromise = null;
    if (this.ib) {
      try { this.ib.disconnect(); } catch (_) {}
      this.ib = null;
    }
  }

  disconnect() {
    this._cleanup();
  }

  /**
   * Check if IB Gateway is reachable (non-blocking quick check).
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Parse a Yahoo-style ticker into IB contract params.
   * e.g. "AIR.PA" -> { symbol: "AIR", exchange: "SBF", currency: "EUR" }
   *      "AAPL"   -> { symbol: "AAPL", exchange: "SMART", currency: "USD" }
   */
  _parseTickerToContract(yahooTicker) {
    for (const [suffix, info] of Object.entries(EXCHANGE_MAP)) {
      if (yahooTicker.endsWith(suffix)) {
        return {
          symbol: yahooTicker.slice(0, -suffix.length),
          ...info,
        };
      }
    }
    // Default: US stock
    return { symbol: yahooTicker, exchange: 'SMART', currency: 'USD', primaryExchange: '' };
  }

  _getOptionsExchange(yahooTicker) {
    for (const [suffix, exchange] of Object.entries(OPTIONS_EXCHANGE_MAP)) {
      if (yahooTicker.endsWith(suffix)) return exchange;
    }
    return ''; // Let IB figure it out for US tickers
  }

  /**
   * Get contract details (resolves conId needed for options chain lookup).
   */
  async _getContractDetails(contract) {
    if (!this.connected) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const reqId = this._getReqId();
      const results = [];

      this.ib.on(EventName.contractDetails, (id, details) => {
        if (id === reqId) results.push(details);
      });

      this.ib.on(EventName.contractDetailsEnd, (id) => {
        if (id === reqId) {
          this._pendingRequests.delete(reqId);
          resolve(results);
        }
      });

      this._pendingRequests.set(reqId, {
        onError: (err, code) => {
          this._pendingRequests.delete(reqId);
          reject(new Error(`contractDetails error ${code}: ${err?.message || err}`));
        }
      });

      this.ib.reqContractDetails(reqId, contract);
    });
  }

  /**
   * Get available option expirations and strikes for an underlying.
   */
  async _getOptionParams(underlyingSymbol, underlyingConId) {
    if (!this.connected) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const reqId = this._getReqId();
      const results = [];

      this.ib.on(EventName.securityDefinitionOptionParameter, (id, exchange, underlyingConIdResp, tradingClass, multiplier, expirations, strikes) => {
        if (id === reqId) {
          results.push({ exchange, tradingClass, multiplier, expirations: [...expirations], strikes: [...strikes] });
        }
      });

      this.ib.on(EventName.securityDefinitionOptionParameterEnd, (id) => {
        if (id === reqId) {
          this._pendingRequests.delete(reqId);
          resolve(results);
        }
      });

      this._pendingRequests.set(reqId, {
        onError: (err, code) => {
          this._pendingRequests.delete(reqId);
          reject(new Error(`optionParams error ${code}: ${err?.message || err}`));
        }
      });

      this.ib.reqSecDefOptParams(reqId, underlyingSymbol, '', SecType.STK, underlyingConId);
    });
  }

  /**
   * Request a snapshot of market data for a single option contract.
   * Returns { bid, ask, last, volume, openInterest, impliedVol, delta, gamma, theta, vega }
   */
  async _getOptionSnapshot(contract, timeoutMs = 8000) {
    if (!this.connected) throw new Error('Not connected');

    return new Promise((resolve) => {
      const reqId = this._getReqId();
      const data = {
        bid: 0, ask: 0, last: 0, volume: 0, close: 0,
        openInterest: 0, impliedVol: 0, delta: 0, gamma: 0, theta: 0, vega: 0,
        modelIV: 0,
      };
      let receivedTicks = 0;

      const timeout = setTimeout(() => {
        this.ib.cancelMktData(reqId);
        this._pendingRequests.delete(reqId);
        resolve(receivedTicks > 0 ? data : null);
      }, timeoutMs);

      // Tick price events
      this.ib.on(EventName.tickPrice, (id, tickType, value) => {
        if (id !== reqId) return;
        receivedTicks++;
        // TickType: 1=bid, 2=ask, 4=last, 9=close
        if (tickType === 1) data.bid = value;
        else if (tickType === 2) data.ask = value;
        else if (tickType === 4) data.last = value;
        else if (tickType === 9) data.close = value;
      });

      // Tick size events
      this.ib.on(EventName.tickSize, (id, tickType, value) => {
        if (id !== reqId) return;
        receivedTicks++;
        // TickType: 8=volume, 27=optionCallOpenInterest, 28=optionPutOpenInterest
        if (tickType === 8) data.volume = value;
        else if (tickType === 27 || tickType === 28) data.openInterest = value;
      });

      // Tick option computation (Greeks + IV)
      this.ib.on(EventName.tickOptionComputation, (id, tickType, tickAttrib, iv, delta, optPrice, pvDiv, gamma, vega, theta, undPrice) => {
        if (id !== reqId) return;
        receivedTicks++;
        // tickType 13 = model option computation
        if (tickType === 13 || tickType === 10 || tickType === 11 || tickType === 12) {
          if (iv > 0 && iv < 10) data.impliedVol = iv;  // Sanity check
          if (delta !== undefined && Math.abs(delta) <= 1) data.delta = delta;
          if (gamma !== undefined) data.gamma = gamma;
          if (theta !== undefined) data.theta = theta;
          if (vega !== undefined) data.vega = vega;
          if (tickType === 13) data.modelIV = iv;
        }
      });

      // Snapshot end
      this.ib.on(EventName.tickSnapshotEnd, (id) => {
        if (id === reqId) {
          clearTimeout(timeout);
          this.ib.cancelMktData(reqId);
          this._pendingRequests.delete(reqId);
          resolve(receivedTicks > 0 ? data : null);
        }
      });

      this._pendingRequests.set(reqId, {
        onError: (err, code) => {
          clearTimeout(timeout);
          this._pendingRequests.delete(reqId);
          // 10167 = no market data permissions, 10090 = no data
          resolve(null);
        }
      });

      // Request snapshot (snapshot=true, regulatorySnapshot=false)
      // Generic tick 106 = impliedVol, 100 = optionVolume, 101 = optionOpenInterest
      this.ib.reqMktData(reqId, contract, '106', true, false);
    });
  }

  /**
   * Fetch options chain for a Yahoo-style ticker and return yahoo-finance2 compatible format.
   *
   * @param {string} yahooTicker - e.g. "AIR.PA", "IDR.MC", "ASML.AS", or "AAPL"
   * @param {Object} [opts] - { date: Date } for specific expiration
   * @returns {Object|null} yahoo-finance2 compatible options chain, or null
   */
  async fetchOptionsChain(yahooTicker, opts = {}) {
    const connected = await this.connect();
    if (!connected) return null;

    const contractInfo = this._parseTickerToContract(yahooTicker);
    console.log(`[IB] Fetching options for ${yahooTicker} → ${contractInfo.symbol} on ${contractInfo.exchange}`);

    // Step 1: Get underlying contract details (need conId)
    const stockContract = {
      symbol: contractInfo.symbol,
      secType: SecType.STK,
      exchange: contractInfo.exchange,
      currency: contractInfo.currency,
    };
    if (contractInfo.primaryExchange) {
      stockContract.primaryExch = contractInfo.primaryExchange;
    }

    let conId, currentPrice;
    try {
      const details = await this._getContractDetails(stockContract);
      if (!details || details.length === 0) {
        // Try with SMART exchange as fallback
        stockContract.exchange = 'SMART';
        const details2 = await this._getContractDetails(stockContract);
        if (!details2 || details2.length === 0) {
          console.log(`[IB] No contract found for ${yahooTicker}`);
          return null;
        }
        conId = details2[0].contract.conId;
      } else {
        conId = details[0].contract.conId;
      }
    } catch (err) {
      console.error(`[IB] Contract lookup failed for ${yahooTicker}: ${err.message}`);
      return null;
    }

    // Get current price via snapshot
    try {
      const priceSnap = await this._getOptionSnapshot(stockContract, 5000);
      currentPrice = priceSnap?.last || priceSnap?.close || priceSnap?.bid || 0;
    } catch (_) {
      currentPrice = 0;
    }

    // Step 2: Get available expirations and strikes
    let optionParams;
    try {
      optionParams = await this._getOptionParams(contractInfo.symbol, conId);
    } catch (err) {
      console.error(`[IB] Option params failed for ${yahooTicker}: ${err.message}`);
      return null;
    }

    if (!optionParams || optionParams.length === 0) {
      console.log(`[IB] No options available for ${yahooTicker}`);
      return null;
    }

    // Pick the best exchange (prefer the mapped options exchange)
    const preferredExchange = this._getOptionsExchange(yahooTicker);
    let bestParams = optionParams[0];
    if (preferredExchange) {
      const match = optionParams.find(p => p.exchange === preferredExchange);
      if (match) bestParams = match;
    }

    // Sort expirations chronologically
    const allExpirations = bestParams.expirations
      .map(e => e.toString()) // "20260417" format from IB
      .sort();

    // Pick target expiration
    let targetExpStr;
    if (opts.date) {
      const target = opts.date instanceof Date ? opts.date : new Date(opts.date);
      const targetStr = target.toISOString().split('T')[0].replace(/-/g, '');
      // Find closest expiration to requested date
      targetExpStr = allExpirations.reduce((best, exp) =>
        Math.abs(parseInt(exp) - parseInt(targetStr)) < Math.abs(parseInt(best) - parseInt(targetStr)) ? exp : best
      , allExpirations[0]);
    } else {
      // Use nearest expiration
      const now = new Date().toISOString().split('T')[0].replace(/-/g, '');
      targetExpStr = allExpirations.find(e => e >= now) || allExpirations[0];
    }

    console.log(`[IB] Using expiration ${targetExpStr}, ${bestParams.strikes.length} strikes available`);

    // Step 3: Filter strikes to reasonable range around current price (if we know it)
    let strikes = bestParams.strikes.sort((a, b) => a - b);
    if (currentPrice > 0) {
      const lower = currentPrice * 0.75;
      const upper = currentPrice * 1.25;
      strikes = strikes.filter(s => s >= lower && s <= upper);
      console.log(`[IB] Filtered to ${strikes.length} strikes around $${currentPrice.toFixed(2)}`);
    }
    // Cap at 40 strikes to avoid excessive API calls
    if (strikes.length > 40) {
      const mid = strikes.findIndex(s => s >= currentPrice) || Math.floor(strikes.length / 2);
      const start = Math.max(0, mid - 20);
      strikes = strikes.slice(start, start + 40);
    }

    // Step 4: Fetch snapshots for each strike (calls and puts)
    const calls = [];
    const puts = [];
    const expDateFormatted = `${targetExpStr.slice(0, 4)}-${targetExpStr.slice(4, 6)}-${targetExpStr.slice(6, 8)}`;

    // Batch requests with small delays to respect rate limits
    for (const strike of strikes) {
      const makeContract = (right) => ({
        symbol: contractInfo.symbol,
        secType: SecType.OPT,
        exchange: bestParams.exchange || 'SMART',
        currency: contractInfo.currency,
        lastTradeDateOrContractMonth: targetExpStr,
        strike,
        right,
        multiplier: bestParams.multiplier || '100',
      });

      // Fetch call and put in parallel
      const [callSnap, putSnap] = await Promise.all([
        this._getOptionSnapshot(makeContract(OptionType.Call), 6000),
        this._getOptionSnapshot(makeContract(OptionType.Put), 6000),
      ]);

      if (callSnap) {
        calls.push(this._formatAsYahooContract(strike, 'call', callSnap, yahooTicker, expDateFormatted, currentPrice));
      }
      if (putSnap) {
        puts.push(this._formatAsYahooContract(strike, 'put', putSnap, yahooTicker, expDateFormatted, currentPrice));
      }

      // Small delay between strike batches
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[IB] Got ${calls.length} calls, ${puts.length} puts for ${yahooTicker} exp ${expDateFormatted}`);

    // Build expiration dates list (convert "20260417" -> Date)
    const expirationDates = allExpirations.map(e =>
      new Date(`${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}T00:00:00Z`)
    );

    // Return in yahoo-finance2 compatible format
    return {
      underlyingSymbol: yahooTicker,
      expirationDates,
      quote: {
        regularMarketPrice: currentPrice,
        symbol: yahooTicker,
      },
      options: [{
        expirationDate: new Date(`${expDateFormatted}T00:00:00Z`),
        calls,
        puts,
      }],
    };
  }

  /**
   * Format an IB snapshot as a yahoo-finance2 option contract object.
   */
  _formatAsYahooContract(strike, type, snap, ticker, expDate, currentPrice) {
    const lastPrice = snap.last || snap.close || ((snap.bid + snap.ask) / 2) || 0;
    const inTheMoney = type === 'call' ? strike < currentPrice : strike > currentPrice;

    return {
      contractSymbol: `${ticker}${expDate.replace(/-/g, '')}${type === 'call' ? 'C' : 'P'}${strike}`,
      strike,
      currency: 'EUR',
      lastPrice,
      change: 0,
      percentChange: 0,
      bid: snap.bid || 0,
      ask: snap.ask || 0,
      volume: snap.volume || 0,
      openInterest: snap.openInterest || 0,
      impliedVolatility: snap.impliedVol || snap.modelIV || 0,
      inTheMoney,
      lastTradeDate: new Date(),
      // Extra IB-specific data (won't break Yahoo consumers)
      delta: snap.delta || 0,
      gamma: snap.gamma || 0,
      theta: snap.theta || 0,
      vega: snap.vega || 0,
    };
  }

  /**
   * Get the current price for a Yahoo-style ticker via IB.
   */
  async getCurrentPrice(yahooTicker) {
    const connected = await this.connect();
    if (!connected) return null;

    const contractInfo = this._parseTickerToContract(yahooTicker);
    const contract = {
      symbol: contractInfo.symbol,
      secType: SecType.STK,
      exchange: contractInfo.exchange,
      currency: contractInfo.currency,
    };

    const snap = await this._getOptionSnapshot(contract, 5000);
    return snap?.last || snap?.close || null;
  }
}

module.exports = IBOptionsProvider;
