/**
 * Ticker Screening via Yahoo Finance
 *
 * Pre-screens a large list of tickers for significant price events
 * using free Yahoo Finance data (no API key needed).
 *
 * Algorithm: volume × |gap%| with 95th percentile threshold,
 * checked over the last 5 trading days.
 */

const OptionsAnalysisService = require('../src/services/optionsAnalysis');
const IBOptionsProvider = require('../src/services/ibOptionsProvider');

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
  } = config;

  if (!tickers.length) {
    console.log('[Screen] No tickers configured for screening');
    return { hits: [], allTickers: [], runId: null };
  }

  // Start archive run (no-op if archiver is null)
  const run = archiver ? archiver.startRun({ trigger: 'manual', config }) : null;
  if (run) console.log(`[Screen] Archive run id: ${run.runId}`);

  const list = screenMaxTickers > 0 ? tickers.slice(0, screenMaxTickers) : tickers;
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

      if (products.length === 0) {
        allTickers.push({ ticker, rSquared, skipped: true });
        continue;
      }

      // Compute percentile threshold
      const sorted = products
        .map((p) => p.volumeGapProduct)
        .filter((v) => !isNaN(v) && v > 0)
        .sort((a, b) => a - b);

      if (sorted.length === 0) {
        allTickers.push({ ticker, rSquared, skipped: true });
        continue;
      }

      const thresholdIndex = Math.floor((screenPercentileThreshold / 100) * sorted.length);
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

      // Fetch company summary + market cap + sector/industry if yahoo-finance available
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
      // Uses OptionsAnalysisService.fetchOptionsChain which tries Yahoo first,
      // then falls back to IB Gateway for international tickers.
      let optionsStrikes = null;
      if (createYF) {
        try {
          const ibProvider = new IBOptionsProvider({ port: 4002 });
          const optSvc = new OptionsAnalysisService(null, ibProvider);
          const initialFetch = await optSvc.fetchOptionsChainWithSource(ticker);
          const initialChain = initialFetch?.chain;
          const initialSource = initialFetch?.source;
          const currentPrice = initialChain?.quote?.regularMarketPrice;
          const expirationDates = initialChain?.expirationDates || [];

          // Single snapshot timestamp shared across all expirations for this ticker
          const snapshotDate = new Date().toISOString();

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

          // Clean up IB connection if it was opened
          ibProvider.disconnect();
        } catch (_) { /* options fetch failed — skip silently */ }
      }

      // Add to allTickers — with best hit data if any, otherwise just the ticker + R²
      const chartData = { dates: chartDates, closes: chartCloses, volumes: chartVolumes, events: chartEvents, optionsStrikes };
      let entry;
      if (bestHit) {
        entry = { ...bestHit, chartData, summary, marketCap, sector, industry };
      } else {
        entry = { ticker, rSquared, date: null, gap: 0, percentile: 0, classification: '', volume: 0, chartData, summary, marketCap, sector, industry };
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

  let archiveResult = null;
  if (archiver && run) {
    try {
      archiveResult = await archiver.finishRun(run, { status: cancelled ? 'cancelled' : 'completed' });
      console.log(`[Screen] Archive written: ${archiveResult.runId} (bars=${archiveResult.counts.bars}, chains=${archiveResult.counts.chains}, events=${archiveResult.counts.events})`);
    } catch (archiveErr) {
      console.error(`[Screen] Archive write failed: ${archiveErr.message}`);
    }
  }

  return { hits, allTickers, runId: archiveResult?.runId || run?.runId || null, cancelled };
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
  'TWST','CYTK','ARWR','EXAS','HALO','NBIX','KRYS',
  'ALNY','BMRN','INCY','ARGX','EXEL','CPRX','UTHR','RARE',
  'RXRX','NUVB','BPMC','CRSP','MRUS','RNA','ALKS',
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
 * Revise the screening ticker list by ranking the UNIVERSE by fundamentals.
 *
 * Scoring:
 *   1. Liquidity gate: skip if averageVolume < 200K
 *   2. Revenue growth score: revenueGrowth (null/negative → 0)
 *   3. Equity growth floor: YoY totalStockholderEquity growth, discounted by EQUITY_DISCOUNT
 *   4. Effective growth: max(revenueGrowth, EQUITY_DISCOUNT * equityGrowth)
 *   5. Leverage factor: 1 / (1 + debtToEquity/200)
 *   6. Final score: effectiveGrowth * leverageFactor
 *   Top 100 by score descending.
 *
 * @param {Function} createYF - Factory that returns a fresh yahoo-finance2 instance
 * @param {Function} [onProgress] - Optional callback(current, total, ticker)
 * @returns {Promise<{tickers: string[], details: Array}>}
 */
const EQUITY_DISCOUNT = 0.4;

async function reviseTickers(createYF, onProgress) {
  const scored = [];
  const errors = [];
  const excluded = { illiquid: [], noGrowth: [], highLeverage: [] };
  const total = UNIVERSE.length;

  for (let i = 0; i < total; i++) {
    const ticker = UNIVERSE[i];

    if (i > 0) await sleep(1000);

    if (onProgress) onProgress(i + 1, total, ticker);

    try {
      const yf = createYF();
      const result = await yf.quoteSummary(ticker, {
        modules: ['financialData', 'summaryDetail', 'balanceSheetHistory'],
      });

      const fin = result.financialData || {};
      const summary = result.summaryDetail || {};

      const avgVolume = summary.averageVolume ?? 0;
      const marketCap = summary.marketCap ?? 0;

      const sheets = (result.balanceSheetHistory?.balanceSheetStatements) ?? [];
      let equityGrowth = 0;
      if (sheets.length >= 2) {
        const recent = sheets[0].totalStockholderEquity;
        const prior  = sheets[1].totalStockholderEquity;
        if (recent != null && prior != null && prior !== 0) {
          equityGrowth = Math.max(0, (recent - prior) / Math.abs(prior));
        }
      }

      const revenueGrowth = (fin.revenueGrowth != null && fin.revenueGrowth > 0)
        ? fin.revenueGrowth
        : 0;

      const effectiveGrowth = Math.max(revenueGrowth, EQUITY_DISCOUNT * equityGrowth);

      const debtToEquity = fin.debtToEquity ?? 0;
      const leverageFactor = 1 / (1 + Math.max(0, debtToEquity) / 200);

      const score = effectiveGrowth * leverageFactor;

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

  // Sort by score descending, take top 100
  scored.sort((a, b) => b.score - a.score);
  const top100 = scored.slice(0, 100);
  const top100Set = new Set(top100.map(s => s.ticker));

  // Classify tickers that scored but didn't make the top 100 by primary weakness
  for (const s of scored) {
    if (top100Set.has(s.ticker)) continue;
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

  console.log(`[Revise] Done. ${scored.length} scored, ${errors.length} errors, top 100 selected.`);
  console.log(`[Revise] Excluded: ${excluded.illiquid.length} illiquid, ${excluded.noGrowth.length} low/no growth, ${excluded.highLeverage.length} high leverage`);

  return {
    tickers: top100.map(s => s.ticker),
    details: top100,
    excluded,
    errors,
    totalScored: scored.length,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { screenTickers, reviseTickers };
