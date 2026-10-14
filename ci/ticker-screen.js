/**
 * Ticker Screening
 *
 * Pre-screens a large list of tickers for significant price events.
 * Prices and options chains come from MarketData.app (MARKET_DATA_API_KEY).
 *
 * Fundamentals (sector, industry, market cap, business summary, and the
 * revenue/equity/leverage inputs to reviseTickers) still come from Yahoo
 * Finance via the injected `createYF` factory — MarketData serves market
 * data only and has no fundamentals endpoints. Screening works without it;
 * those fields are simply left blank.
 *
 * Algorithm: volume × |gap%| with 95th percentile threshold,
 * checked over the last 5 trading days.
 */

const OptionsAnalysisService = require('../src/services/optionsAnalysis');
const IBOptionsProvider = require('../src/services/ibOptionsProvider');
const MarketDataProvider = require('../src/services/marketDataProvider');

/**
 * Simple linear regression: y = mx + b
 * @param {Array<[number, number]>} points - Array of [x, y] pairs
 * @returns {{m: number, b: number}}
 */
function linReg(points) {
  const n = points.length;
  if (n === 0) return { m: 0, b: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sxy += x * y; sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { m: 0, b: sy / n };
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  return { m, b };
}

/**
 * Pure event detection over a bar series: residual returns vs benchmark,
 * volume × |gap| products, percentile threshold, and classified events.
 * Shared by screenTickers (live screening) and ci/backfill-marketdata.js.
 *
 * @param {Array} validBars - Bars with date/open/close/volume, oldest first
 * @param {Map<string, number>|null} marketReturns - dateStr → benchmark daily return
 * @param {number} percentileThreshold - e.g. 92
 * @returns {{rSquared: number|null, products: Array, threshold: number,
 *   chartDates: string[], chartCloses: number[], chartVolumes: number[],
 *   chartEvents: Array, dbEvents: Array}}
 *   products is empty when there is nothing usable (caller marks ticker skipped).
 */
function computeEventsFromBars(validBars, marketReturns, percentileThreshold) {
  // Compute daily returns and align with market returns
  const dailyData = [];
  for (let j = 1; j < validBars.length; j++) {
    const prevClose = validBars[j - 1].close;
    const bar = validBars[j];
    if (prevClose === 0) continue;

    const dateStr = (bar.date instanceof Date
      ? bar.date.toISOString() : new Date(bar.date).toISOString()
    ).split('T')[0];
    const stockReturn = (bar.close - prevClose) / prevClose;
    const mktReturn = marketReturns ? marketReturns.get(dateStr) : undefined;

    dailyData.push({
      bar, prevClose, dateStr, stockReturn, mktReturn,
    });
  }

  // Run per-ticker regression if we have market data
  let slope = 0, intercept = 0, rSquared = null;
  if (marketReturns) {
    const pairs = dailyData
      .filter(d => d.mktReturn !== undefined)
      .map(d => [d.mktReturn, d.stockReturn]);
    if (pairs.length > 20) {
      const reg = linReg(pairs);
      slope = reg.m;
      intercept = reg.b;

      // Compute R²
      const yMean = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      const ssTotal = pairs.reduce((s, p) => s + (p[1] - yMean) ** 2, 0);
      const ssResidual = pairs.reduce((s, p) => {
        const predicted = slope * p[0] + intercept;
        return s + (p[1] - predicted) ** 2;
      }, 0);
      rSquared = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;
    }
  }

  // Compute volumeGapProduct using residual returns
  const products = [];
  for (const d of dailyData) {
    let residualReturn;
    if (marketReturns && d.mktReturn !== undefined) {
      residualReturn = d.stockReturn - (slope * d.mktReturn + intercept);
    } else {
      // Fallback: raw open gap (signed)
      residualReturn = (d.bar.open - d.prevClose) / d.prevClose;
    }
    const residualPct = Math.abs(residualReturn * 100);

    products.push({
      bar: d.bar,
      prevClose: d.prevClose,
      gapPct: residualPct,
      residualReturn,
      volumeGapProduct: d.bar.volume * residualPct,
    });
  }

  const empty = { rSquared, products: [], threshold: 0, chartDates: [], chartCloses: [], chartVolumes: [], chartEvents: [], dbEvents: [] };
  if (products.length === 0) return empty;

  // Compute percentile threshold
  const sorted = products
    .map((p) => p.volumeGapProduct)
    .filter((v) => !isNaN(v) && v > 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) return empty;

  const thresholdIndex = Math.floor((percentileThreshold / 100) * sorted.length);
  const threshold = sorted[Math.min(thresholdIndex, sorted.length - 1)];

  // Build chart data: dates and closes for all bars
  const chartDates = products.map(p => {
    const d = p.bar.date;
    return (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).split('T')[0];
  });
  const chartCloses = products.map(p => p.bar.close);
  const chartVolumes = products.map(p => p.bar.volume);

  // Find ALL events above threshold (for chart dots) and build DB event records in parallel
  const chartEvents = [];
  const dbEvents = [];
  for (let k = 0; k < products.length; k++) {
    const entry = products[k];
    if (entry.volumeGapProduct < threshold) continue;

    const gapNeg = entry.bar.open < entry.prevClose;
    const intradayPos = entry.bar.close > entry.bar.open;
    const closedBelow = entry.bar.close < entry.prevClose;
    const closedAbove = entry.bar.close > entry.prevClose;

    let cls;
    if (gapNeg) {
      cls = closedAbove ? 'surprising_positive' : intradayPos ? 'negative_anticipated' : 'surprising_negative';
    } else {
      cls = closedBelow ? 'surprising_negative' : intradayPos ? 'surprising_positive' : 'positive_anticipated';
    }

    chartEvents.push({ idx: k, y: entry.bar.close, classification: cls });
    dbEvents.push({
      dateStr: chartDates[k],
      classification: cls,
      strength: entry.gapPct,
      residualReturn: entry.residualReturn,
      volumeGapProduct: entry.volumeGapProduct,
      open: entry.bar.open,
      high: entry.bar.high,
      low: entry.bar.low,
      close: entry.bar.close,
      volume: entry.bar.volume,
    });
  }

  return { rSquared, products, threshold, chartDates, chartCloses, chartVolumes, chartEvents, dbEvents };
}

/**
 * Newest quote timestamp in an options chain, as ms since epoch.
 *
 * MarketData maps its per-snapshot `updated` field onto each contract's
 * lastTradeDate (see marketDataClient.fetchCurrentChain), so the max across
 * contracts is when the provider last refreshed the chain. Under the IB
 * fallback lastTradeDate is a genuine per-contract trade time, so the max is
 * the most recent trade — still the right "newest data" reading, though it can
 * look stale for illiquid names that simply haven't traded.
 *
 * @param {Object} chain - yahoo-finance2 shaped chain
 * @returns {number|null} ms epoch, or null when the chain carries no timestamps
 */
function latestQuoteTime(chain) {
  const contracts = [
    ...(chain?.options?.[0]?.calls || []),
    ...(chain?.options?.[0]?.puts || []),
  ];
  let max = null;
  for (const c of contracts) {
    if (!c.lastTradeDate) continue;
    const t = c.lastTradeDate instanceof Date
      ? c.lastTradeDate.getTime()
      : new Date(c.lastTradeDate).getTime();
    if (!isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * Aggregate per-ticker freshness samples into a run-level summary.
 *
 * Reports both mean and median age: a handful of illiquid tickers can drag the
 * mean out by hours, so the median is the honest "typical" reading, and the two
 * diverging is itself the signal that some names are stale.
 *
 * @param {Array<{ticker: string, quoteTime: number, fetchedAt: number, ageMs: number, source: string}>} samples
 * @returns {Object|null} null when nothing was sampled
 */
function summarizeFreshness(samples) {
  if (!samples.length) return null;

  const ages = samples.map(s => s.ageMs).sort((a, b) => a - b);
  const mid = Math.floor(ages.length / 2);
  const medianAgeMs = ages.length % 2 === 0 ? (ages[mid - 1] + ages[mid]) / 2 : ages[mid];
  const meanAgeMs = ages.reduce((s, a) => s + a, 0) / ages.length;

  const newest = samples.reduce((a, b) => (b.quoteTime > a.quoteTime ? b : a));
  const oldest = samples.reduce((a, b) => (b.quoteTime < a.quoteTime ? b : a));

  // Mean quote timestamp — "average date and time of the newest data loaded".
  const meanQuoteTime = samples.reduce((s, x) => s + x.quoteTime, 0) / samples.length;

  const sources = {};
  for (const s of samples) sources[s.source] = (sources[s.source] || 0) + 1;

  // Classify on the median so a few stale illiquid names don't mislabel the run.
  const medianMin = medianAgeMs / 60000;
  let tier;
  if (medianMin < 2) tier = 'realtime';
  else if (medianMin < 20) tier = 'delayed';       // the classic ~15-min feed
  else if (medianMin < 12 * 60) tier = 'stale';
  else tier = 'previous-session';

  return {
    tier,
    sampleCount: samples.length,
    meanAgeMs,
    medianAgeMs,
    meanQuoteTime: new Date(meanQuoteTime).toISOString(),
    newestQuoteTime: new Date(newest.quoteTime).toISOString(),
    oldestQuoteTime: new Date(oldest.quoteTime).toISOString(),
    newestTicker: newest.ticker,
    oldestTicker: oldest.ticker,
    sources,
  };
}

/** Human-readable age, e.g. "14m 22s". */
function formatAge(ms) {
  if (ms == null || isNaN(ms)) return 'n/a';
  const neg = ms < 0;
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = h > 0 ? [`${h}h`, `${m}m`] : m > 0 ? [`${m}m`, `${s}s`] : [`${s}s`];
  return (neg ? '-' : '') + parts.join(' ');
}

async function screenTickers(priceTracker, config = {}, createYF = null, onTickerDone = null, database = null, archiver = null) {
  const {
    screenTickers: tickers = [],
    screenDays = 100,
    screenLookbackDays = 5,
    screenPercentileThreshold = 95,
    screenDelayMs = 2500,
    screenMaxTickers = 0,
    benchmark = 'SPY',
    isCancelled = null,
    excludeTickers = [],
  } = config;

  if (!tickers.length) {
    console.log('[Screen] No tickers configured for screening');
    return { hits: [], allTickers: [], runId: null };
  }

  // Start archive run (no-op if archiver is null)
  const run = archiver ? archiver.startRun({ trigger: 'manual', config }) : null;
  if (run) console.log(`[Screen] Archive run id: ${run.runId}`);

  // The screener's in-memory suggestions re-add anything matching the live
  // screen query — config.excludeTickers is the permanent opt-out for tickers
  // that were deliberately deleted (delisted / vendor has no options data).
  const excluded = new Set(excludeTickers.map(t => String(t).trim().toUpperCase()));
  const kept = tickers.filter(t => !excluded.has(String(t).trim().toUpperCase()));
  const dropped = tickers.length - kept.length;
  if (dropped > 0) console.log(`[Screen] Excluded ${dropped} ticker(s) via config.excludeTickers`);

  const list = screenMaxTickers > 0 ? kept.slice(0, screenMaxTickers) : kept;
  console.log(`[Screen] Screening ${list.length} tickers (${screenDays}d window, ${screenLookbackDays}d lookback, p${screenPercentileThreshold})`);

  // Fetch benchmark (SPY) data once for residual computation
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - screenDays * 24 * 60 * 60;

  let marketReturns = null; // Map<dateStr, dailyReturn>
  try {
    const spyBars = await priceTracker.fetchHistoricalPrices(benchmark, {
      period1, period2, interval: '1d',
    });
    if (spyBars && spyBars.length > 20) {
      const valid = spyBars.filter(b => b.close != null);
      archiver?.recordBars(run, benchmark, valid);
      marketReturns = new Map();
      for (let j = 1; j < valid.length; j++) {
        const dateStr = (valid[j].date instanceof Date
          ? valid[j].date.toISOString() : new Date(valid[j].date).toISOString()
        ).split('T')[0];
        marketReturns.set(dateStr, (valid[j].close - valid[j - 1].close) / valid[j - 1].close);
      }
      console.log(`[Screen] Fetched ${benchmark} data (${marketReturns.size} daily returns)`);
    }
  } catch (err) {
    console.error(`[Screen] Failed to fetch ${benchmark} — falling back to raw gaps: ${err.message}`);
  }

  const hits = [];
  const allTickers = []; // Every ticker with its best recent event (if any) + R²

  // Data freshness: age of each ticker's options snapshot at the moment we
  // fetched it (fetch time − provider `updated` stamp). MarketData stamps every
  // contract in a chain with the same `updated` time, so one sample per ticker
  // is enough. Tells us at a glance whether the run saw real-time or delayed
  // quotes — a paper/free MarketData plan is 15+ min behind.
  const freshnessSamples = [];

  // Shared quote source for the Last (ext) column — independent of the
  // per-ticker options block so a chain failure can't blank the price. Also
  // passed to the options service so its strike-band price hits this cache.
  const screenQuoteProvider = new MarketDataProvider();
  const ibProvider = new IBOptionsProvider({ port: 4001 });
  const optSvc = new OptionsAnalysisService(null, ibProvider, screenQuoteProvider);

  let cancelled = false;
  for (let i = 0; i < list.length; i++) {
    if (isCancelled && isCancelled()) {
      console.log(`[Screen] Cancelled after ${i}/${list.length} tickers`);
      cancelled = true;
      break;
    }
    const ticker = list[i];

    if (i > 0) {
      await sleep(screenDelayMs);
    }

    try {
      const bars = await priceTracker.fetchHistoricalPrices(ticker, {
        period1, period2, interval: '1d',
      });

      if (!bars || bars.length < 20) {
        console.log(`  [Screen] ${ticker}: skipped (only ${bars?.length ?? 0} bars)`);
        allTickers.push({ ticker, skipped: true });
        archiver?.recordTicker(run, ticker, { status: 'skipped', bars: bars?.length ?? 0 });
        continue;
      }

      // Filter out bars with null values
      const validBars = bars.filter(
        (b) => b.open != null && b.close != null && b.volume != null
      );

      if (validBars.length < 20) {
        console.log(`  [Screen] ${ticker}: skipped (only ${validBars.length} valid bars)`);
        allTickers.push({ ticker, skipped: true });
        archiver?.recordTicker(run, ticker, { status: 'skipped', bars: validBars.length });
        continue;
      }

      archiver?.recordBars(run, ticker, validBars);

      // Event detection (shared with ci/backfill-marketdata.js)
      const ev = computeEventsFromBars(validBars, marketReturns, screenPercentileThreshold);
      const { rSquared, threshold, chartDates, chartCloses, chartVolumes, chartEvents, dbEvents } = ev;
      if (ev.products.length === 0) {
        allTickers.push({ ticker, rSquared, skipped: true });
        continue;
      }
      const products = ev.products;
      const sorted = products
        .map((p) => p.volumeGapProduct)
        .filter((v) => !isNaN(v) && v > 0)
        .sort((a, b) => a - b);

      archiver?.recordEvents(run, ticker, dbEvents, benchmark);

      // Persist bars + events to DB so GLM analysis can join event-log entries against forward
      // price returns. Without this, screening and the DB drift apart and GLM training fails.
      if (database) {
        try {
          console.log(`  [Screen] ${ticker}: persisting ${products.length} bars + ${dbEvents.length} events to DB...`);
          for (const p of products) {
            const dStr = (p.bar.date instanceof Date
              ? p.bar.date.toISOString() : new Date(p.bar.date).toISOString()
            ).split('T')[0];
            await database.saveStockPrice(
              ticker,
              dStr,
              { open: p.bar.open, high: p.bar.high, low: p.bar.low, close: p.bar.close, volume: p.bar.volume },
              'screening'
            );
          }
          const startDate = chartDates[0];
          const endDate = chartDates[chartDates.length - 1];
          await database.saveStockEvents(ticker, dbEvents, benchmark, startDate, endDate);
          console.log(`  [Screen] ${ticker}: DB persist OK`);
        } catch (dbErr) {
          console.error(`  [Screen] ${ticker}: DB persist failed — ${dbErr.message}`);
        }
      } else {
        console.log(`  [Screen] ${ticker}: no database reference — skipping DB persist`);
      }

      // Check last N trading days for hits
      const recentProducts = products.slice(-screenLookbackDays);
      let bestHit = null;

      for (const entry of recentProducts) {
        if (entry.volumeGapProduct < threshold) continue;

        // Compute percentile for this bar
        const belowCount = sorted.filter((v) => v <= entry.volumeGapProduct).length;
        const percentile = (belowCount / sorted.length) * 100;

        // Classify
        const gapNegative = entry.bar.open < entry.prevClose;
        const intradayPositive = entry.bar.close > entry.bar.open;
        const closedBelowPrevClose = entry.bar.close < entry.prevClose;
        const closedAbovePrevClose = entry.bar.close > entry.prevClose;

        let classification;
        if (gapNegative) {
          classification = closedAbovePrevClose
            ? 'surprising_positive'
            : intradayPositive
              ? 'negative_anticipated'
              : 'surprising_negative';
        } else {
          classification = closedBelowPrevClose
            ? 'surprising_negative'
            : intradayPositive
              ? 'surprising_positive'
              : 'positive_anticipated';
        }

        const hit = {
          ticker,
          date: entry.bar.date,
          gap: entry.gapPct,
          volumeGapProduct: entry.volumeGapProduct,
          percentile,
          classification,
          volume: entry.bar.volume,
          rSquared,
        };

        hits.push(hit);

        // Track best hit for this ticker (highest percentile)
        if (!bestHit || percentile > bestHit.percentile) {
          bestHit = hit;
        }
      }

      // Company summary + market cap + sector/industry — Yahoo-only (MarketData
      // has no fundamentals). Optional: left blank when createYF is not supplied.
      let summary = '';
      let marketCap = 0;
      let sector = '';
      let industry = '';
      if (createYF) {
        try {
          const yf = createYF();
          const profile = await yf.quoteSummary(ticker, { modules: ['assetProfile', 'summaryDetail'] });
          summary = (profile.assetProfile && profile.assetProfile.longBusinessSummary) || '';
          marketCap = (profile.summaryDetail && profile.summaryDetail.marketCap) || 0;
          sector = (profile.assetProfile && profile.assetProfile.sector) || '';
          industry = (profile.assetProfile && profile.assetProfile.industry) || '';
        } catch (_) { /* ignore — summary is optional */ }
      }

      // Fetch per-strike options data for disagreement chart (nearest 3 expirations)
      // Uses OptionsAnalysisService.fetchOptionsChain, which is backed by
      // MarketData (IB Gateway remains an opt-in fallback via USE_IB_OPTIONS=1).
      let optionsStrikes = null;
      // Hoisted out of the options block so the screening row can show it even
      // when the chain fetch below fails. One quote per ticker feeds both the
      // Last (ext) column and the chain strike band (seeded into the shared
      // price cache), so the run spends a single quote credit per ticker.
      let currentPriceForEntry = null;
      let liveQuoteForEntry = null;
      let liveQuotePrevClose = null;
      try {
        const q = await screenQuoteProvider.client.fetchQuote(ticker);
        const px = q?.last ?? q?.mid ?? null;
        if (typeof px === 'number' && px > 0) {
          liveQuoteForEntry = px;
          screenQuoteProvider.cachePrice(ticker, px);
          if (typeof q.change === 'number') liveQuotePrevClose = px - q.change;
        }
      } catch (_) { /* column falls back to the chain quote / bar close */ }
      {
        try {
          const initialFetch = await optSvc.fetchOptionsChainWithSource(ticker);
          const initialChain = initialFetch?.chain;
          const initialSource = initialFetch?.source;
          const currentPrice = initialChain?.quote?.regularMarketPrice;
          if (typeof currentPrice === 'number' && currentPrice > 0) currentPriceForEntry = currentPrice;

          const expirationDates = initialChain?.expirationDates || [];

          // Single snapshot timestamp shared across all expirations for this ticker
          const fetchedAt = Date.now();
          const snapshotDate = new Date(fetchedAt).toISOString();

          // Sample how stale the provider's data was when it reached us.
          const quoteTime = latestQuoteTime(initialChain);
          if (quoteTime) {
            freshnessSamples.push({
              ticker,
              quoteTime,                          // provider `updated` (ms epoch)
              fetchedAt,
              ageMs: fetchedAt - quoteTime,
              source: initialSource || 'unknown',
            });
          }

          if (currentPrice && expirationDates.length > 0) {
            const maxExp = Math.min(3, expirationDates.length);
            const results = [];

            // Archive raw contracts for the initial expiration
            archiver?.recordChain(run, {
              ticker,
              snapshotDate,
              expirationDate: expirationDates[0],
              currentPrice,
              source: initialSource,
              calls: initialChain.options?.[0]?.calls || [],
              puts: initialChain.options?.[0]?.puts || [],
            });

            // Dollar-volume-weighted IV for a set of contracts
            function weightedIV(contracts) {
              let sumDvIv = 0, sumDv = 0;
              for (const c of contracts) {
                if (c.dollarVolume > 0 && c.normalizedIV > 0) {
                  sumDvIv += c.normalizedIV * 100 * c.dollarVolume;
                  sumDv += c.dollarVolume;
                }
              }
              return sumDv > 0 ? sumDvIv / sumDv : 0;
            }

            // Deep OTM concentration: % of dollar volume in strikes >10% OTM
            function deepOTMPct(contracts, price, side) {
              const totalDV = contracts.reduce((s, c) => s + c.dollarVolume, 0);
              if (totalDV <= 0) return 0;
              const deepDV = contracts.filter(c =>
                side === 'call' ? c.strike >= price * 1.10 : c.strike <= price * 0.90
              ).reduce((s, c) => s + c.dollarVolume, 0);
              return Math.round(deepDV / totalDV * 1000) / 10;
            }

            function buildExpResult(metrics, expDate) {
              const calls = metrics.callContracts.map(c => ({ strike: c.strike, dollarVol: c.dollarVolume, dollarOI: (c.openInterest || 0) * (c.lastPrice || 0) * 100, iv: c.normalizedIV * 100 }));
              const puts = metrics.putContracts.map(c => ({ strike: c.strike, dollarVol: c.dollarVolume, dollarOI: (c.openInterest || 0) * (c.lastPrice || 0) * 100, iv: c.normalizedIV * 100 }));
              const wCallIV = Math.round(weightedIV(metrics.callContracts) * 10) / 10;
              const wPutIV = Math.round(weightedIV(metrics.putContracts) * 10) / 10;
              const atmCallIVPct = Math.round((metrics.atmCallIV || 0) * 1000) / 10;
              const atmPutIVPct = Math.round((metrics.atmPutIV || 0) * 1000) / 10;

              // Complement (ATM-band) = the strikes NOT captured by the OTM filter.
              // Calls: strike < 1.015 × spot.  Puts: strike > 0.985 × spot.
              const atmCallContracts = (metrics.allCallContracts || []).filter(c => c.strike < currentPrice * 1.015);
              const atmPutContracts = (metrics.allPutContracts || []).filter(c => c.strike > currentPrice * 0.985);
              const atmBandCallIV = Math.round(weightedIV(atmCallContracts) * 10) / 10;
              const atmBandPutIV = Math.round(weightedIV(atmPutContracts) * 10) / 10;
              const atmCallDV = atmCallContracts.reduce((s, c) => s + (c.dollarVolume || 0), 0);
              const atmPutDV = atmPutContracts.reduce((s, c) => s + (c.dollarVolume || 0), 0);

              return {
                label: optSvc.formatDate(expDate),
                calls, puts,
                wCallIV, wPutIV,
                atmCallIV: atmCallIVPct,
                atmPutIV: atmPutIVPct,
                // Band-definition ATM IVs + DVs — stored alongside the single-strike atm*IV
                // so that a future switch to the band-based definition can use them directly
                // (and can be combined across expirations by their own DV).
                atmBandCallIV,
                atmBandPutIV,
                atmCallDV,
                atmPutDV,
                ivSpreadCall: Math.round((wCallIV - atmCallIVPct) * 10) / 10,
                ivSpreadPut: Math.round((wPutIV - atmPutIVPct) * 10) / 10,
                deepOTMCallPct: deepOTMPct(metrics.callContracts, currentPrice, 'call'),
                deepOTMPutPct: deepOTMPct(metrics.putContracts, currentPrice, 'put'),
              };
            }

            // First expiration from initial fetch
            const firstMetrics = optSvc.computeExpirationMetrics(initialChain, currentPrice);
            const globalLatestTradeDay = firstMetrics?.localLatestTradeDay || '';
            if (firstMetrics) {
              results.push(buildExpResult(firstMetrics, expirationDates[0]));
            }

            // Remaining expirations (use optSvc.fetchOptionsChainWithSource for IB fallback + source attribution)
            for (let ei = 1; ei < maxExp; ei++) {
              try {
                const fetched = await optSvc.fetchOptionsChainWithSource(ticker, optSvc.formatDate(expirationDates[ei]));
                const chain = fetched?.chain;
                const source = fetched?.source;
                if (chain) {
                  archiver?.recordChain(run, {
                    ticker,
                    snapshotDate,
                    expirationDate: expirationDates[ei],
                    currentPrice,
                    source,
                    calls: chain.options?.[0]?.calls || [],
                    puts: chain.options?.[0]?.puts || [],
                  });
                  const metrics = optSvc.computeExpirationMetrics(chain, currentPrice, globalLatestTradeDay);
                  if (metrics) {
                    results.push(buildExpResult(metrics, expirationDates[ei]));
                  }
                }
              } catch (_) { /* skip this expiration */ }
            }

            if (results.length > 0) optionsStrikes = results;
          }
        } catch (_) { /* options fetch failed — skip silently */ }
      }

      // Add to allTickers — with best hit data if any, otherwise just the ticker + R²
      const chartData = { dates: chartDates, closes: chartCloses, volumes: chartVolumes, events: chartEvents, optionsStrikes };
      // Last (ext) column: liveQuoteForEntry was fetched at the top of the
      // options block (independent of chain success) and includes pre/post-
      // market. The close baseline comes from the quote's `change` because
      // MarketData's daily bars include the in-progress session, which would
      // make the baseline drift with extended-hours prints.
      const lastClose = liveQuotePrevClose != null
        ? liveQuotePrevClose
        : (chartCloses.length > 0 ? chartCloses[chartCloses.length - 1] : null);
      const latestPrice = typeof liveQuoteForEntry === 'number'
        ? liveQuoteForEntry
        : (typeof currentPriceForEntry === 'number' ? currentPriceForEntry : null);
      let entry;
      if (bestHit) {
        entry = { ...bestHit, chartData, summary, marketCap, sector, industry, lastClose, latestPrice };
      } else {
        entry = { ticker, rSquared, date: null, gap: 0, percentile: 0, classification: '', volume: 0, chartData, summary, marketCap, sector, industry, lastClose, latestPrice };
      }
      allTickers.push(entry);
      archiver?.recordTicker(run, ticker, {
        rSquared,
        bars: validBars.length,
        events: dbEvents.length,
        hits: bestHit ? 1 : 0,
        status: 'ok',
      });
      if (onTickerDone) onTickerDone(entry);
    } catch (err) {
      console.error(`  [Screen] ${ticker}: error — ${err.message}`);
      const entry = { ticker, error: err.message };
      allTickers.push(entry);
      archiver?.recordTicker(run, ticker, { status: 'errored', error: err.message });
      if (onTickerDone) onTickerDone(entry);
    }
  }

  // Clean up the shared IB connection if the fallback opened it
  ibProvider.disconnect();

  const freshness = summarizeFreshness(freshnessSamples);
  if (freshness) {
    console.log(
      `[Screen] Data freshness: ${freshness.tier} — median age ${formatAge(freshness.medianAgeMs)}, ` +
      `mean ${formatAge(freshness.meanAgeMs)} across ${freshness.sampleCount} tickers`
    );
    console.log(
      `[Screen]   avg quote time ${freshness.meanQuoteTime}; ` +
      `newest ${freshness.newestQuoteTime} (${freshness.newestTicker}), ` +
      `oldest ${freshness.oldestQuoteTime} (${freshness.oldestTicker})`
    );
  } else {
    console.log('[Screen] Data freshness: no option snapshots carried timestamps');
  }

  let archiveResult = null;
  if (archiver && run) {
    try {
      archiveResult = await archiver.finishRun(run, { status: cancelled ? 'cancelled' : 'completed', freshness });
      console.log(`[Screen] Archive written: ${archiveResult.runId} (bars=${archiveResult.counts.bars}, chains=${archiveResult.counts.chains}, events=${archiveResult.counts.events})`);
    } catch (archiveErr) {
      console.error(`[Screen] Archive write failed: ${archiveErr.message}`);
    }
  }

  return { hits, allTickers, freshness, runId: archiveResult?.runId || run?.runId || null, cancelled };
}

// ~400 liquid US tickers spanning defense, biotech, clean energy,
// SaaS, fintech, medtech, semiconductors, industrials, consumer, cybersecurity.
// Mix of small-cap growth and large mid-cap ($10B-$80B+).
const UNIVERSE = [
  // ── Small / Mid-cap ──────────────────────────────────────────────────
  // Defense / Aerospace
  'KTOS','MRCY','RKLB','BWXT','AVAV','AXON','HEI','ATI',
  'CACI','JOBY','OSK','WWD',
  // Biotech / Pharma
  'TWST','CYTK','ARWR','HALO','NBIX','KRYS',
  'ALNY','BMRN','INCY','ARGX','EXEL','CPRX','UTHR','RARE',
  'RXRX','NUVB','CRSP','RNA','ALKS',
  // Clean Energy
  'SEDG','BE','FSLR','RUN','SHLS',
  // SaaS / Cloud / Software
  'UPST','BRZE','CFLT','S','GTLB','DOCN','PAYC','PCTY',
  'WIX','APPF','NTNX','JAMF','BL','SPSC','BILL','DDOG','ZS',
  'MNDY','TOST','HUBS','VEEV','ESTC','FRSH','PTC','ASAN','PCOR','TYL',
  'CWAN','TTGT','EVLV','DSGX','DBX','WK','PEGA',
  // Cybersecurity
  'TENB','QLYS','OKTA','VRNS','SAIL','CYBR',
  // Fintech / Payments
  'SOFI','LC','AFRM','PAYO','RELY','FOUR','ACIW','VRRM','HLNE',
  'MQ','WEX','HOOD','SSNC','EVER','GENI','EVR',
  // Medtech / Healthcare
  'INSP','GKOS','NVCR','TMDX','IRTC','DOCS','ALGN','HIMS','MEDP',
  'HQY','GMED','DXCM','PODD','HOLX','MMSI','PRCT',
  'BRKR','PEN',
  // Semiconductors
  'LSCC','AMBA','RMBS','CRUS','SLAB','ALGM','DIOD',
  'MTSI','ONTO','NOVT','SITM','CRDO','POWI',
  // Industrials / Infrastructure
  'SAIA','CWST','EXPO','POWL','ESAB','SPXC','CGNX',
  'AAON','DY','WCC','MLI','BLD','CSWI','MIDD','FBIN',
  // Energy / Materials / Mining
  'MP','CALX','HAYW','IREN','RIG','VNOM','MGY',
  // Consumer / Retail / Food
  'CELH','WING','ELF','SFM','DORM','CARG','TTMI',
  'SHAK','BROS','CAVA','TXRH','DECK','BIRK','CART',
  // AI / Robotics
  'SOUN','SERV','ASTS',
  // Misc growth
  'EPAM','DUOL','RDDT','RBRK','IOT','KVYO','AXSM','IOVA',

  // ── Large / Mega-cap ─────────────────────────────────────────────────
  // Defense / Aerospace
  'LHX','HII','TDG','BWA','TXT','CW','PLTR',
  'RTX','GD','NOC','SAIC','LMT','BA','HWM',
  // Biotech / Pharma
  'REGN','VRTX','GMAB','BIO',
  'ILMN','MDGL','LEGN','INSM','FOLD','TGTX','DAWN',
  'LLY','ABBV','AZN','AMGN','JAZZ','NTRA','ITCI','GILD',
  'SMMT','ASND','VRNA',
  // Clean Energy / Utilities
  'VST','CEG','AES','CWEN','NEE','ORA','FLNC','NRG',
  // SaaS / Cloud / Software
  'CRWD','PANW','NET','SNOW','MDB','TEAM','WDAY','NOW',
  'CDNS','SNPS','MANH','GWRE','DOCU','ROKU','U',
  'PATH','PINS','SNAP','TTD','GRAB','SE','SHOP',
  'MSFT','ADBE','CRM','ORCL','INTU','SAP','GDDY','ZM','TWLO','APP',
  'NICE','BSY','DT',
  // Cybersecurity
  'FTNT','RPD','FICO','CHKP',
  // Fintech / Payments
  'FIS','PYPL','MKTX','LPLA','IBKR','NDAQ',
  'CBOE','ICE','CME','MSCI','SPGI',
  'V','MA','AXP','TW','CPAY','EFX','XYZ','TROW',
  'NU','JKHY','FUTU',
  // Medtech / Healthcare
  'ISRG','EW','STE','LNTH','HSIC','XRAY',
  'WST','IDXX','IQV','ZBH','BSX','PHG','RMD','GEHC',
  'UNH','ABT','TMO','SYK','BDX','ZTS','MASI','ICLR',
  'BAX','COO','WAT',
  // Semiconductors
  'MCHP','MPWR','MRVL','LRCX','KLAC','ASML','NXPI',
  'QCOM','TER','AMKR','COHR','CEVA','SMTC',
  'NVDA','AMD','AVGO','ARM','MU','SMCI','TSM','KEYS','ANET',
  'STM','TXN',
  // Industrials / Infrastructure
  'TT','XYL','WMS','SITE','EMR','ROK','NDSN',
  'FELE','RBC','ITT','GGG','FLS','IR','AME',
  'LECO','ZWS',
  'GE','CAT','ETN','PH','URI','HUBB','ZBRA','CARR','DELL',
  'OC','PWR',
  // Energy / Materials / Mining
  'CCJ','DNN',
  'STNG','CTRA','EQT','AR','CNX',
  'SLB','TPL','RRC','CHRD','FANG',
  // Consumer / Retail / Food
  'LULU','ONON','YETI','FOXF','BURL','FIVE',
  'BOOT','DKS','ANF','AEO','MNST','COKE',
  'CMG','DASH','UBER','LYFT','ABNB',
  'COST','WMT','NKE','SBUX','MCD','PEP','DPZ','DKNG','FND',
  'ROST','TJX','CPNG','EXPE','WMG','EL','TPR','HLT',
];

/**
 * Revise the screening ticker list by ranking the universe by fundamentals.
 * The universe is the hand-picked UNIVERSE list, optionally expanded via
 * Yahoo predefined screeners (see fetchReviseUniverse).
 *
 * Scoring:
 *   1. Liquidity gate: skip if averageVolume < 200K
 *   2. Revenue growth score: revenueGrowth (null/negative → 0)
 *   3. Equity growth floor: YoY totalStockholderEquity growth, discounted by EQUITY_DISCOUNT
 *   4. Effective growth: max(revenueGrowth, EQUITY_DISCOUNT * equityGrowth)
 *   5. Leverage factor: 1 / (1 + debtToEquity/200)
 *   6. Final score: effectiveGrowth * leverageFactor
 *
 * Two independent top-N rankings (default N=20) are produced:
 *   - growth: top N by the score above
 *   - eventProne: top N by event-proneness (beta, or 52-week range as fallback)
 * The screening list written to config.json is the union of both.
 *
 * @param {Function} createYF - Factory that returns a fresh yahoo-finance2 instance
 * @param {Function} [onProgress] - Optional callback(current, total, ticker)
 * @param {Object} [options] - { useScreener = true, topN = 100 }
 * @returns {Promise<{tickers: string[], details: Array}>}
 */
const EQUITY_DISCOUNT = 0.4;

// Custom Yahoo screener (POST /v1/finance/screener) used to build the revise
// universe. Unlike yahoo-finance2's predefined screens (which only take a
// count), this endpoint accepts arbitrary filter criteria. Not exposed by
// yahoo-finance2 v3, so we call it directly with a manual cookie+crumb.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CUSTOM_SCREEN_PAGE_SIZE = 250; // max the endpoint returns per call
const CUSTOM_SCREEN_MAX_TICKERS = 2000; // safety cap on pagination
// Universe thresholds — applied BOTH to the screener query and (via a batch
// quote check) to the curated UNIVERSE list, so no ticker below the floor
// survives into the revise loop regardless of source.
const UNIVERSE_MIN_CAP = 2e9;
const UNIVERSE_MIN_AVG_VOLUME = 2e6;
// Universe criteria: US-listed equities, cap > $2B, avg 3-month volume > 2M.
// The volume floor does most of the work — illiquid names make poor screening
// candidates for either ranking (weak options chains, unreliable event math).
// Growth is deliberately NOT filtered here — the revise scoring ranks on it.
// To exclude whole sectors add e.g.:
//   { operator: 'ne', operands: ['sector', 'Financial Services'] }
const CUSTOM_SCREEN_QUERY = {
  operator: 'and',
  operands: [
    { operator: 'eq', operands: ['region', 'us'] },
    { operator: 'gt', operands: ['intradaymarketcap', UNIVERSE_MIN_CAP] },
    { operator: 'gt', operands: ['avgdailyvol3m', UNIVERSE_MIN_AVG_VOLUME] },
  ],
};

/**
 * Yahoo cookie + crumb, the same dance yahoo-finance2 does internally.
 * @returns {Promise<{cookie: string, crumb: string}>}
 */
async function fetchYahooAuth() {
  let cookie = '';
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': BROWSER_UA } });
    cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  } catch (_) { /* fc.yahoo.com 404s after setting the cookie — expected */ }
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie },
  });
  if (!r2.ok) throw new Error(`crumb fetch failed: ${r2.status}`);
  return { cookie, crumb: await r2.text() };
}

/**
 * Fetch US equity tickers matching CUSTOM_SCREEN_QUERY from Yahoo's custom
 * screener endpoint, paginated. Returns symbols only.
 * @returns {Promise<string[]>}
 */
async function fetchCustomScreenerTickers(auth) {
  const { cookie, crumb } = auth;

  const tickers = [];
  let offset = 0;
  while (tickers.length < CUSTOM_SCREEN_MAX_TICKERS) {
    const body = {
      size: CUSTOM_SCREEN_PAGE_SIZE,
      offset,
      sortField: 'intradaymarketcap',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      query: CUSTOM_SCREEN_QUERY,
      userId: '',
      userIdType: 'guid',
    };
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}`,
      {
        method: 'POST',
        headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`screener fetch failed: ${res.status}`);
    const json = await res.json();
    const result = json.finance?.result?.[0];
    const quotes = result?.quotes || [];
    for (const q of quotes) {
      if (q.symbol && (!q.quoteType || q.quoteType === 'EQUITY')) tickers.push(q.symbol);
    }
    if (quotes.length < CUSTOM_SCREEN_PAGE_SIZE || offset + quotes.length >= (result?.total ?? 0)) break;
    offset += CUSTOM_SCREEN_PAGE_SIZE;
    await sleep(500); // be polite between pages
  }
  console.log(`[Revise] Custom screener: ${tickers.length} US equities matched the criteria`);
  return tickers;
}

/**
 * Filter curated UNIVERSE tickers through the same cap/volume thresholds using
 * one batch quote call per chunk — curated names below the floor (or delisted)
 * are dropped instead of sneaking past the screener.
 * @param {string[]} candidates - Curated tickers NOT already in the screener result
 * @param {{cookie: string, crumb: string}} auth
 * @returns {Promise<string[]>} The subset passing the thresholds
 */
async function filterCuratedByThresholds(candidates, auth) {
  if (candidates.length === 0) return [];
  const { cookie, crumb } = auth;
  const keep = [];
  const CHUNK = 100;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const symbols = candidates.slice(i, i + CHUNK).join(',');
    const res = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } }
    );
    if (!res.ok) throw new Error(`batch quote fetch failed: ${res.status}`);
    const json = await res.json();
    for (const q of json.quoteResponse?.result || []) {
      const vol = q.averageDailyVolume3Month ?? q.regularMarketVolume ?? 0;
      if ((q.marketCap ?? 0) > UNIVERSE_MIN_CAP && vol > UNIVERSE_MIN_AVG_VOLUME) {
        keep.push(q.symbol);
      }
    }
  }
  console.log(`[Revise] Curated list: kept ${keep.length}/${candidates.length} below-screener tickers above the thresholds`);
  return keep;
}

/**
 * Build the revise universe: everything matching CUSTOM_SCREEN_QUERY, plus the
 * curated UNIVERSE names that also pass the same thresholds, deduped.
 * @returns {Promise<string[]>}
 */
async function fetchReviseUniverse() {
  let auth = null;
  let screenerTickers = null;
  try {
    auth = await fetchYahooAuth();
    screenerTickers = await fetchCustomScreenerTickers(auth);
  } catch (err) {
    console.error(`[Revise] Custom screener failed (non-fatal), using UNIVERSE only: ${err.message}`);
    return [...UNIVERSE];
  }

  const tickers = new Set(screenerTickers);
  const curatedOnly = UNIVERSE.filter(t => !tickers.has(t));
  try {
    for (const t of await filterCuratedByThresholds(curatedOnly, auth)) tickers.add(t);
  } catch (err) {
    // Batch quote failed — keep the full curated list rather than lose it
    console.error(`[Revise] Curated threshold check failed (non-fatal), keeping all curated: ${err.message}`);
    for (const t of curatedOnly) tickers.add(t);
  }
  return [...tickers];
}

async function reviseTickers(createYF, onProgress, options = {}) {
  const { useScreener = true, topN = 20 } = options;

  const universe = useScreener
    ? await fetchReviseUniverse()
    : [...UNIVERSE];
  console.log(`[Revise] Universe size: ${universe.length} tickers${useScreener ? ' (screener-expanded)' : ''}`);

  // Retry Yahoo calls on 429 with backoff — the revise loop runs at 400ms/ticker,
  // so an occasional throttle is expected; retry instead of losing the ticker.
  async function withRateLimitRetry(fn) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const is429 = /429|Too Many Requests/i.test(err?.message || '');
        if (!is429 || attempt === 3) throw err;
        await sleep(2000 * attempt);
      }
    }
  }

  const scored = [];
  const errors = [];
  const excluded = { illiquid: [], noGrowth: [], highLeverage: [] };
  const total = universe.length;

  for (let i = 0; i < total; i++) {
    const ticker = universe[i];

    if (i > 0) await sleep(400);

    if (onProgress) onProgress(i + 1, total, ticker);

    try {
      const yf = createYF();
      // Note: quoteSummary's balanceSheetHistory submodule has been empty since
      // Nov 2024 (Yahoo deprecation) — equity growth comes from
      // fundamentalsTimeSeries instead.
      // validateResult: false — Yahoo occasionally ships junk fields (e.g. the
      // string "NaN" for trailingAnnualDividendYield) that fail the library's
      // strict schema and would otherwise drop the ticker entirely. Every field
      // we read is guarded with fallbacks below.
      const result = await withRateLimitRetry(() => yf.quoteSummary(ticker, {
        modules: ['financialData', 'summaryDetail'],
      }, { validateResult: false }));

      const fin = result.financialData || {};
      const summary = result.summaryDetail || {};

      const avgVolume = summary.averageVolume ?? 0;
      const marketCap = summary.marketCap ?? 0;

      let equityGrowth = 0;
      try {
        const ts = await withRateLimitRetry(() => yf.fundamentalsTimeSeries(ticker, {
          period1: new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000),
          type: 'annual',
          module: 'balance-sheet',
        }, { validateResult: false }));
        const eqs = (Array.isArray(ts) ? ts : [])
          .filter(e => typeof e.stockholdersEquity === 'number')
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        if (eqs.length >= 2) {
          const prior = eqs[eqs.length - 2].stockholdersEquity;
          const recent = eqs[eqs.length - 1].stockholdersEquity;
          if (prior !== 0) equityGrowth = Math.max(0, (recent - prior) / Math.abs(prior));
        }
      } catch (_) { /* equity floor is optional — revenue growth still applies */ }

      const revenueGrowth = (fin.revenueGrowth != null && fin.revenueGrowth > 0)
        ? fin.revenueGrowth
        : 0;

      const effectiveGrowth = Math.max(revenueGrowth, EQUITY_DISCOUNT * equityGrowth);

      const debtToEquity = Number.isFinite(fin.debtToEquity) ? fin.debtToEquity : 0;
      const leverageFactor = 1 / (1 + Math.max(0, debtToEquity) / 200);

      const score = effectiveGrowth * leverageFactor;

      // Event-proneness: how event-rich this ticker is likely to be for the
      // volume×gap screening. Primary signal is beta; fall back to the 52-week
      // high/low range as a volatility proxy when beta is missing.
      const beta = summary.beta ?? null;
      const wkHigh = summary.fiftyTwoWeekHigh;
      const wkLow = summary.fiftyTwoWeekLow;
      const rangeProxy = (wkHigh > 0 && wkLow > 0) ? (wkHigh - wkLow) / wkLow : 0;
      const eventProneness = (beta != null && beta > 0) ? beta : rangeProxy;

      const entry = {
        ticker,
        score,
        revenueGrowth,
        equityGrowth,
        effectiveGrowth,
        debtToEquity,
        leverageFactor,
        avgVolume,
        marketCap,
        beta,
        eventProneness,
      };

      if (avgVolume < 200000) {
        console.log(`  [Revise] ${ticker}: skipped (avgVol ${(avgVolume/1e6).toFixed(2)}M < 500K)`);
        excluded.illiquid.push(entry);
        continue;
      }

      scored.push(entry);

      const growthSource = (effectiveGrowth > revenueGrowth) ? ' [eqFloor]' : '';
      console.log(`  [Revise] ${ticker}: score=${score.toFixed(4)} (revGrowth=${(revenueGrowth*100).toFixed(1)}%, eqGrowth=${(equityGrowth*100).toFixed(1)}%, effGrowth=${(effectiveGrowth*100).toFixed(1)}%${growthSource}, D/E=${debtToEquity.toFixed(0)}, avgVol=${(avgVolume/1e6).toFixed(1)}M)`);
    } catch (err) {
      console.error(`  [Revise] ${ticker}: error — ${err.message}`);
      errors.push({ ticker, error: err.message });
    }
  }

  // Two independent top-N rankings; the screening list is their union.
  scored.sort((a, b) => b.score - a.score);
  const growthTop = scored.slice(0, topN);
  const eventTop = [...scored]
    .sort((a, b) => b.eventProneness - a.eventProneness)
    .slice(0, topN);
  const growthSet = new Set(growthTop.map(s => s.ticker));
  const eventSet = new Set(eventTop.map(s => s.ticker));
  const selectedSet = new Set([...growthSet, ...eventSet]);

  // Classify tickers that scored but made neither top-N list by primary weakness
  for (const s of scored) {
    if (selectedSet.has(s.ticker)) continue;
    // Primary reason: no/negative revenue growth vs high leverage
    if (s.effectiveGrowth === 0) {
      excluded.noGrowth.push(s);
    } else if (s.leverageFactor < 0.5) {
      // D/E > 100 → leverageFactor < 0.5 → leverage was the main drag
      excluded.highLeverage.push(s);
    } else {
      // Both contributed but growth was lower than the cutoff
      excluded.noGrowth.push(s);
    }
  }

  console.log(`[Revise] Done. ${scored.length} scored, ${errors.length} errors, ${selectedSet.size} selected (top ${topN} growth + top ${topN} event-prone).`);
  console.log(`[Revise] Excluded: ${excluded.illiquid.length} illiquid, ${excluded.noGrowth.length} low/no growth, ${excluded.highLeverage.length} high leverage`);

  // details = full metric rows for every selected ticker (union of both
  // rankings), flagged with which list(s) they came from.
  const unionDetails = new Map();
  for (const s of growthTop) unionDetails.set(s.ticker, { ...s, inGrowth: true, inEvent: false });
  for (const s of eventTop) {
    if (unionDetails.has(s.ticker)) unionDetails.get(s.ticker).inEvent = true;
    else unionDetails.set(s.ticker, { ...s, inGrowth: false, inEvent: true });
  }

  // Ordered candidate ranking for flex-slot filling: interleave both lists by
  // rank so "next in line" always means best remaining in either criterion.
  const ranking = [];
  for (let i = 0; i < topN; i++) {
    if (growthTop[i] && !ranking.includes(growthTop[i].ticker)) ranking.push(growthTop[i].ticker);
    if (eventTop[i] && !ranking.includes(eventTop[i].ticker)) ranking.push(eventTop[i].ticker);
  }

  return {
    tickers: [...selectedSet],
    ranking,
    // Full scored universe, best first — the sampling pool for screening's
    // auto-suggested tickers (random 10 from top 200).
    fullRanking: scored.map(s => s.ticker),
    details: [...unionDetails.values()],
    lists: {
      growth: growthTop.map(s => s.ticker),
      eventProne: eventTop.map(s => s.ticker),
    },
    topN,
    excluded,
    errors,
    totalScored: scored.length,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { screenTickers, reviseTickers, fetchReviseUniverse, computeEventsFromBars, summarizeFreshness, formatAge };
