'use strict';

const fs = require('fs');
const path = require('path');
const LogisticRegression = require('ml-logistic-regression');
const { Matrix } = require('ml-matrix');

class GLMAnalysisService {
  constructor(database) {
    this.database = database;
    this.model = null;
    this.featureNames = [
      'is_event', 'is_positive', 'is_surprising',
      'gap', 'logVGP', 'ivSkew', 'atmCallIV'
    ];
    this.means = null;
    this.stds = null;
  }

  /**
   * Pull ALL stock_events + sampled non-event trading days from the DB,
   * join with forward returns and options snapshots for IV features.
   * Enriches with event-log.json where ticker+date matches (for weighted IV).
   */
  async assembleTrainingData(horizonDays = 10) {
    // ── 1. Event samples: every stock_event in the DB ──────────────────
    const allEvents = await this._queryAllEvents();
    console.log(`[GLM] DB has ${allEvents.length} stock_events`);

    if (allEvents.length === 0) {
      throw new Error('No stock_events in the database. Run analysis or screening first.');
    }

    const eventIds = allEvents.map(e => e.event_id);
    const forwardReturns = await this.database.getPerEventForwardReturns(eventIds, horizonDays);

    const returnMap = new Map();
    for (const fr of forwardReturns) {
      if (!returnMap.has(fr.event_id)) returnMap.set(fr.event_id, new Map());
      returnMap.get(fr.event_id).set(fr.day, fr.cum_return);
    }

    // ── 2. Non-event samples from stock_prices ─────────────────────────
    const nonEventSamples = await this._queryNonEventSamples(horizonDays);
    console.log(`[GLM] Sampled ${nonEventSamples.length} non-event trading days`);

    // ── 3. Load event-log.json for IV enrichment ───────────────────────
    const logMap = new Map();
    try {
      const logPath = path.join(__dirname, '..', '..', 'ci', 'event-log.json');
      const rawLog = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      for (const le of rawLog) {
        logMap.set(`${le.ticker}_${le.eventDate}`, le);
      }
    } catch (_) { /* event-log missing or empty — fine, IV enrichment is optional */ }

    // ── 4. Load nearest options snapshot per (ticker, date) ────────────
    const ivMap = await this._queryIVSnapshots(allEvents, nonEventSamples);

    // ── 5. Build feature matrix ────────────────────────────────────────
    const X = [];
    const y = [];
    const usableEvents = [];

    // Event samples
    for (const ev of allEvents) {
      const dayReturns = returnMap.get(ev.event_id);
      if (!dayReturns || !dayReturns.has(horizonDays)) continue;

      const cumReturn = dayReturns.get(horizonDays);
      const iv = ivMap.get(`${ev.ticker}_${ev.event_date}`) || {};
      const logEntry = logMap.get(`${ev.ticker}_${ev.event_date}`);
      const features = this._encodeEventFeatures(ev, iv, logEntry);

      X.push(features);
      y.push(cumReturn > 0 ? 1 : 0);
      usableEvents.push({
        ticker: ev.ticker,
        eventDate: ev.event_date,
        classification: ev.classification,
        cumReturn,
        eventId: ev.event_id,
      });
    }

    // Non-event samples
    for (const ne of nonEventSamples) {
      if (!ne.cum_return_at_horizon) continue;

      const iv = ivMap.get(`${ne.ticker}_${ne.date}`) || {};
      const features = this._encodeNonEventFeatures(ne, iv);

      X.push(features);
      y.push(ne.cum_return_at_horizon > 0 ? 1 : 0);
      usableEvents.push({
        ticker: ne.ticker,
        eventDate: ne.date,
        classification: 'none',
        cumReturn: ne.cum_return_at_horizon,
        eventId: null,
      });
    }

    console.log(`[GLM] ${X.length} usable samples (${allEvents.length} event candidates, ${nonEventSamples.length} non-event candidates) at horizon=${horizonDays}d`);
    return { X, y, events: usableEvents };
  }

  // ── DB queries ──────────────────────────────────────────────────────

  async _queryAllEvents() {
    return new Promise((resolve, reject) => {
      this.database.connection.all(`
        SELECT id AS event_id, ticker, event_date::TEXT AS event_date,
               classification, strength, residual_return,
               volume_gap_product, open, close, high, low, volume
        FROM stock_events
        ORDER BY event_date
      `, (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(r => ({
          event_id: Number(r.event_id),
          ticker: r.ticker,
          event_date: r.event_date,
          classification: r.classification,
          strength: Number(r.strength) || 0,
          residual_return: Number(r.residual_return) || 0,
          volume_gap_product: Number(r.volume_gap_product) || 0,
          open: Number(r.open) || 0,
          close: Number(r.close) || 0,
          volume: Number(r.volume) || 0,
        })));
      });
    });
  }

  /**
   * Sample non-event trading days: pick every Nth price bar that is NOT
   * an event date, and compute the forward cumulative return at horizonDays.
   */
  async _queryNonEventSamples(horizonDays) {
    return new Promise((resolve, reject) => {
      this.database.connection.all(`
        WITH price_ranked AS (
          SELECT ticker, date::TEXT AS date, close, volume,
                 open, high, low,
                 LAG(close) OVER (PARTITION BY ticker ORDER BY date) AS prev_close,
                 ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date) AS rn
          FROM (
            SELECT ticker, date, close, volume, open, high, low,
                   ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY fetched_at DESC) AS drn
            FROM stock_prices
          ) deduped
          WHERE drn = 1
        ),
        non_events AS (
          SELECT p.ticker, p.date, p.close, p.volume, p.prev_close,
                 p.open, p.high, p.low, p.rn
          FROM price_ranked p
          LEFT JOIN stock_events e ON e.ticker = p.ticker AND e.event_date::TEXT = p.date
          WHERE e.id IS NULL
            AND p.prev_close IS NOT NULL
            AND p.rn % 3 = 0
        ),
        forward AS (
          SELECT ne.ticker, ne.date, ne.close AS base_close, ne.volume,
                 ne.prev_close, ne.open, ne.high, ne.low,
                 ROW_NUMBER() OVER (PARTITION BY ne.ticker, ne.date ORDER BY fp.date) AS day_offset,
                 fp.close AS fwd_close
          FROM non_events ne
          JOIN (
            SELECT ticker, date, close,
                   ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY fetched_at DESC) AS drn
            FROM stock_prices
          ) fp ON fp.ticker = ne.ticker AND fp.date > ne.date::DATE AND fp.drn = 1
        )
        SELECT ticker, date, base_close, volume, prev_close, open, high, low,
               (fwd_close - base_close) / base_close AS cum_return_at_horizon
        FROM forward
        WHERE day_offset = ${horizonDays}
      `, (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(r => ({
          ticker: r.ticker,
          date: r.date,
          close: Number(r.base_close),
          volume: Number(r.volume),
          prev_close: Number(r.prev_close),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          cum_return_at_horizon: Number(r.cum_return_at_horizon),
        })));
      });
    });
  }

  /**
   * Look up the nearest options_snapshots IV for each (ticker, date).
   * Returns Map<"TICKER_DATE", { avgCallIV, avgPutIV, atmCallIV, atmPutIV }>
   */
  async _queryIVSnapshots(events, nonEventSamples) {
    const allPairs = [
      ...events.map(e => ({ ticker: e.ticker, date: e.event_date })),
      ...nonEventSamples.map(n => ({ ticker: n.ticker, date: n.date })),
    ];
    if (allPairs.length === 0) return new Map();

    const tickers = [...new Set(allPairs.map(p => p.ticker))];
    const tickerList = tickers.map(t => `'${t.replace(/'/g, "''")}'`).join(',');

    return new Promise((resolve, reject) => {
      this.database.connection.all(`
        SELECT ticker, snapshot_date::DATE::TEXT AS snap_date,
               AVG(avg_call_iv)::DOUBLE AS avg_call_iv,
               AVG(avg_put_iv)::DOUBLE AS avg_put_iv,
               AVG(atm_call_iv)::DOUBLE AS atm_call_iv,
               AVG(atm_put_iv)::DOUBLE AS atm_put_iv
        FROM options_snapshots
        WHERE ticker IN (${tickerList})
        GROUP BY ticker, snapshot_date::DATE
      `, (err, rows) => {
        if (err) { resolve(new Map()); return; } // non-fatal — IV enrichment is optional

        // Build per-ticker date→IV map, then for each sample find nearest snapshot
        const byTicker = new Map();
        for (const r of (rows || [])) {
          if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
          byTicker.get(r.ticker).push({
            date: r.snap_date,
            avgCallIV: Number(r.avg_call_iv) || 0,
            avgPutIV: Number(r.avg_put_iv) || 0,
            atmCallIV: Number(r.atm_call_iv) || 0,
            atmPutIV: Number(r.atm_put_iv) || 0,
          });
        }
        // Sort each ticker's snapshots by date
        for (const [, snaps] of byTicker) snaps.sort((a, b) => a.date.localeCompare(b.date));

        const result = new Map();
        for (const { ticker, date } of allPairs) {
          const snaps = byTicker.get(ticker);
          if (!snaps || snaps.length === 0) continue;
          // Find closest snapshot on or before this date
          let best = null;
          for (const s of snaps) {
            if (s.date <= date) best = s;
            else break;
          }
          if (best) result.set(`${ticker}_${date}`, best);
        }
        resolve(result);
      });
    });
  }

  // ── Feature encoding ────────────────────────────────────────────────

  /**
   * Encode features for an event-day sample.
   * Uses DB columns, enriches IV from event-log if available.
   */
  _encodeEventFeatures(ev, iv, logEntry) {
    const cls = ev.classification || '';
    const isEvent = 1;
    const isPositive = (cls === 'surprising_positive' || cls === 'positive_anticipated') ? 1 : 0;
    const isSurprising = (cls === 'surprising_positive' || cls === 'surprising_negative') ? 1 : 0;

    // Gap: use strength (abs residual %) from DB, fallback to residual_return
    const gap = ev.strength || Math.abs(ev.residual_return * 100) || 0;
    const vgp = ev.volume_gap_product || 1;
    const logVGP = Math.log(Math.max(vgp, 1));

    // IV: prefer event-log's weighted IV, fall back to options_snapshots
    let callIV = 0, putIV = 0, atmCall = 0;
    if (logEntry) {
      callIV = Number(logEntry.wCallIV) || 0;
      putIV = Number(logEntry.wPutIV) || 0;
      atmCall = Number(logEntry.atmCallIV) || 0;
    } else if (iv.avgCallIV) {
      callIV = iv.avgCallIV * 100;    // stored as decimal in DB
      putIV = iv.avgPutIV * 100;
      atmCall = iv.atmCallIV * 100;
    }
    const ivSkew = callIV - putIV;

    return [isEvent, isPositive, isSurprising, gap, logVGP, ivSkew, atmCall];
  }

  /**
   * Encode features for a non-event trading day.
   */
  _encodeNonEventFeatures(ne, iv) {
    const isEvent = 0;
    const isPositive = 0;
    const isSurprising = 0;

    // "gap" for a non-event day: absolute daily return
    const gap = ne.prev_close > 0 ? Math.abs((ne.open - ne.prev_close) / ne.prev_close) * 100 : 0;
    const vgp = ne.volume * gap;
    const logVGP = Math.log(Math.max(vgp, 1));

    let callIV = 0, putIV = 0, atmCall = 0;
    if (iv.avgCallIV) {
      callIV = iv.avgCallIV * 100;
      putIV = iv.avgPutIV * 100;
      atmCall = iv.atmCallIV * 100;
    }
    const ivSkew = callIV - putIV;

    return [isEvent, isPositive, isSurprising, gap, logVGP, ivSkew, atmCall];
  }

  /**
   * Encode a single event for live prediction (from event-log or screening hit).
   * Backward-compatible with the predict() method.
   */
  encodePredictors(event) {
    const cls = event.classification || '';
    const isEvent = cls && cls !== 'none' ? 1 : 0;
    const isPositive = (cls === 'surprising_positive' || cls === 'positive_anticipated') ? 1 : 0;
    const isSurprising = (cls === 'surprising_positive' || cls === 'surprising_negative') ? 1 : 0;

    const gap = Number(event.gap) || Number(event.strength) || 0;
    const vgp = Number(event.volumeGapProduct) || Number(event.volume_gap_product) || 1;
    const logVGP = Math.log(Math.max(vgp, 1));

    const wCallIV = Number(event.wCallIV) || 0;
    const wPutIV = Number(event.wPutIV) || 0;
    const ivSkew = wCallIV - wPutIV;
    const atmCallIV = Number(event.atmCallIV) || 0;

    return [isEvent, isPositive, isSurprising, gap, logVGP, ivSkew, atmCallIV];
  }

  /**
   * Z-score standardize continuous features (indices 3+).
   * Indices 0-2 are binary indicators; skip them.
   * Appends a bias column of 1s (the library has no built-in intercept).
   */
  standardize(X, fit = true) {
    const FIRST_CONTINUOUS = 3; // is_event, is_positive, is_surprising are binary
    const n = X.length;
    const p = X[0].length;
    const result = X.map(row => [...row]);

    if (fit) {
      this.means = new Array(p).fill(0);
      this.stds = new Array(p).fill(1);

      for (let j = FIRST_CONTINUOUS; j < p; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += X[i][j];
        const mean = sum / n;

        let ssq = 0;
        for (let i = 0; i < n; i++) ssq += (X[i][j] - mean) ** 2;
        const std = Math.sqrt(ssq / n) || 1;

        this.means[j] = mean;
        this.stds[j] = std;
      }
    }

    for (let j = FIRST_CONTINUOUS; j < p; j++) {
      for (let i = 0; i < n; i++) {
        result[i][j] = (result[i][j] - this.means[j]) / this.stds[j];
      }
    }

    // Append bias column
    for (let i = 0; i < n; i++) {
      result[i].push(1);
    }

    return result;
  }

  /**
   * Train a logistic regression model using ml-logistic-regression.
   * The library uses one-vs-rest; for binary, classifiers[1] = class "1" (up).
   */
  _trainLR(Xs, y) {
    const Xm = new Matrix(Xs);
    const Ym = Matrix.columnVector(y);
    const lr = new LogisticRegression({ numSteps: 1000, learningRate: 0.1 });
    lr.train(Xm, Ym);
    return lr;
  }

  _predictLR(lr, Xs) {
    return lr.predict(new Matrix(Xs));
  }

  /**
   * Extract weight vector for the positive class (class 1 = "up").
   */
  _extractWeights(lr) {
    try {
      // classifiers[1] is for class 1 (up)
      const c = lr.classifiers[1];
      if (c && c.weights) {
        return c.weights.to1DArray ? c.weights.to1DArray() : [...c.weights];
      }
    } catch (e) {
      console.error('Could not extract weights:', e.message);
    }
    return new Array(this.featureNames.length + 1).fill(0); // +1 for bias
  }

  /**
   * Estimate P(up) for a single sample using sigmoid on class-1 weights.
   */
  _predictProbability(lr, features) {
    try {
      const weights = this._extractWeights(lr);
      let z = 0;
      for (let i = 0; i < features.length; i++) {
        z += (weights[i] || 0) * features[i];
      }
      return 1 / (1 + Math.exp(-z));
    } catch {
      return 0.5;
    }
  }

  /**
   * Train the model and evaluate with leave-one-out CV.
   * If the requested horizon has fewer than 5 usable samples, tries shorter
   * horizons down to 1 day so the model can still train on available data.
   */
  async trainModel(horizonDays = 10) {
    let X, y, events;
    let usedHorizon = horizonDays;

    ({ X, y, events } = await this.assembleTrainingData(horizonDays));

    if (X.length < 5) {
      // Try shorter horizons — recent data may not extend far enough
      let found = false;
      for (let h = horizonDays - 1; h >= 1; h--) {
        const attempt = await this.assembleTrainingData(h);
        if (attempt.X.length >= 5) {
          console.log(`[GLM] Requested horizon=${horizonDays}d had only ${X.length} usable samples; falling back to ${h}d (${attempt.X.length} samples)`);
          X = attempt.X;
          y = attempt.y;
          events = attempt.events;
          usedHorizon = h;
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(
          `Only ${X.length} usable samples even at horizon=1 day. ` +
          `Need at least 5 samples with forward price data. ` +
          `Run analysis or screening on more tickers to populate the DB.`
        );
      }
    }

    // Check that both classes are present
    const nUp = y.filter(v => v === 1).length;
    const nDown = y.filter(v => v === 0).length;
    if (nUp === 0 || nDown === 0) {
      throw new Error(`All ${X.length} samples have the same outcome. Need both up and down labels to train.`);
    }

    // Count event vs non-event
    const nEvent = events.filter(e => e.classification !== 'none').length;
    const nNonEvent = events.length - nEvent;

    // Standardize features (fit on full data)
    const Xs = this.standardize(X, true);

    // Train full model
    const lr = this._trainLR(Xs, y);
    this.model = lr;

    const weights = this._extractWeights(lr);

    // Leave-one-out cross-validation
    const looPredictions = [];
    let correct = 0;
    const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };

    for (let i = 0; i < Xs.length; i++) {
      const trainX = [...Xs.slice(0, i), ...Xs.slice(i + 1)];
      const trainY = [...y.slice(0, i), ...y.slice(i + 1)];

      // Skip if LOO fold has only one class
      const foldUp = trainY.filter(v => v === 1).length;
      if (foldUp === 0 || foldUp === trainY.length) {
        const pred = foldUp === 0 ? 0 : 1;
        const actual = y[i];
        looPredictions.push({
          ticker: events[i].ticker,
          eventDate: events[i].eventDate,
          classification: events[i].classification,
          cumReturn: events[i].cumReturn,
          predicted: pred,
          actual,
          probability: pred === 1 ? 1.0 : 0.0,
          correct: pred === actual,
        });
        if (pred === actual) correct++;
        if (pred === 1 && actual === 1) confusion.tp++;
        if (pred === 1 && actual === 0) confusion.fp++;
        if (pred === 0 && actual === 0) confusion.tn++;
        if (pred === 0 && actual === 1) confusion.fn++;
        continue;
      }

      const looLR = this._trainLR(trainX, trainY);
      const pred = this._predictLR(looLR, [Xs[i]])[0];
      const prob = this._predictProbability(looLR, Xs[i]);
      const actual = y[i];

      looPredictions.push({
        ticker: events[i].ticker,
        eventDate: events[i].eventDate,
        classification: events[i].classification,
        cumReturn: events[i].cumReturn,
        predicted: pred,
        actual,
        probability: prob,
        correct: pred === actual,
      });

      if (pred === actual) correct++;
      if (pred === 1 && actual === 1) confusion.tp++;
      if (pred === 1 && actual === 0) confusion.fp++;
      if (pred === 0 && actual === 0) confusion.tn++;
      if (pred === 0 && actual === 1) confusion.fn++;
    }

    const accuracy = correct / X.length;
    const baseRate = nUp / X.length;

    // Coefficients: weights has p features + 1 bias
    const nFeatures = this.featureNames.length;
    const coefficients = this.featureNames.map((name, i) => ({
      feature: name,
      coefficient: weights[i] ?? 0,
      oddsRatio: Math.exp(weights[i] ?? 0),
    }));
    const intercept = weights[nFeatures] ?? 0;

    return {
      horizonDays: usedHorizon,
      requestedHorizon: horizonDays,
      nEvents: X.length,
      nEventSamples: nEvent,
      nNonEventSamples: nNonEvent,
      nPositive: nUp,
      nNegative: nDown,
      coefficients,
      intercept,
      looAccuracy: accuracy,
      baseRate,
      liftOverBase: accuracy - baseRate,
      confusion,
      predictions: looPredictions,
    };
  }

  /**
   * Predict direction for a new event using the full trained model.
   */
  predict(event) {
    if (!this.model) throw new Error('Model not trained yet. Call trainModel() first.');

    const features = this.encodePredictors(event);
    if (!features) throw new Error('Could not encode event features');

    const Xs = this.standardize([features], false);
    const pred = this._predictLR(this.model, Xs)[0];
    const prob = this._predictProbability(this.model, Xs[0]);

    return {
      probability: prob,
      direction: pred === 1 ? 'up' : 'down',
    };
  }
}

module.exports = GLMAnalysisService;
