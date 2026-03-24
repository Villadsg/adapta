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

async function screenTickers(priceTracker, config = {}, createYF = null) {
  const {
    screenTickers: tickers = [],
    screenDays = 100,
    screenLookbackDays = 5,
    screenPercentileThreshold = 95,
    screenDelayMs = 1000,
    screenMaxTickers = 0,
    benchmark = 'SPY',
  } = config;

  if (!tickers.length) {
    console.log('[Screen] No tickers configured for screening');
    return [];
  }

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

  for (let i = 0; i < list.length; i++) {
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
        continue;
      }

      // Filter out bars with null values
      const validBars = bars.filter(
        (b) => b.open != null && b.close != null && b.volume != null
      );

      if (validBars.length < 20) {
        console.log(`  [Screen] ${ticker}: skipped (only ${validBars.length} valid bars)`);
        allTickers.push({ ticker, skipped: true });
        continue;
      }

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
        let residualPct;
        if (marketReturns && d.mktReturn !== undefined) {
          const residual = d.stockReturn - (slope * d.mktReturn + intercept);
          residualPct = Math.abs(residual * 100);
        } else {
          // Fallback: raw gap
          residualPct = Math.abs((d.bar.open - d.prevClose) / d.prevClose) * 100;
        }

        products.push({
          bar: d.bar,
          prevClose: d.prevClose,
          gapPct: residualPct,
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

      // Find ALL events above threshold (for chart dots)
      const chartEvents = [];
      for (let k = 0; k < products.length; k++) {
        const entry = products[k];
        if (entry.volumeGapProduct < threshold) continue;

        const gapNeg = entry.bar.open < entry.prevClose;
        const intradayPos = entry.bar.close > entry.bar.open;
        const closedBelow = entry.bar.close < entry.prevClose;

        let cls;
        if (gapNeg) {
          cls = intradayPos ? 'negative_anticipated' : 'surprising_negative';
        } else {
          cls = closedBelow ? 'surprising_negative' : intradayPos ? 'surprising_positive' : 'positive_anticipated';
        }

        chartEvents.push({ idx: k, y: entry.bar.close, classification: cls });
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

        let classification;
        if (gapNegative) {
          classification = intradayPositive
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

      // Fetch company summary + market cap if yahoo-finance available
      let summary = '';
      let marketCap = 0;
      if (createYF) {
        try {
          const yf = createYF();
          const profile = await yf.quoteSummary(ticker, { modules: ['assetProfile', 'summaryDetail'] });
          summary = (profile.assetProfile && profile.assetProfile.longBusinessSummary) || '';
          marketCap = (profile.summaryDetail && profile.summaryDetail.marketCap) || 0;
        } catch (_) { /* ignore — summary is optional */ }
      }

      // Fetch per-strike options data for disagreement chart (nearest 3 expirations)
      let optionsStrikes = null;
      if (createYF) {
        try {
          const optSvc = new OptionsAnalysisService(null);
          const yf = createYF();
          const initialChain = await yf.options(ticker);
          const currentPrice = initialChain?.quote?.regularMarketPrice;
          const expirationDates = initialChain?.expirationDates || [];

          if (currentPrice && expirationDates.length > 0) {
            const maxExp = Math.min(2, expirationDates.length);
            const results = [];

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

            function buildExpResult(metrics, expDate) {
              const calls = metrics.allCallContracts.map(c => ({ strike: c.strike, dollarVol: c.dollarVolume, dollarOI: (c.openInterest || 0) * (c.lastPrice || 0) * 100, iv: c.normalizedIV * 100 }));
              const puts = metrics.allPutContracts.map(c => ({ strike: c.strike, dollarVol: c.dollarVolume, dollarOI: (c.openInterest || 0) * (c.lastPrice || 0) * 100, iv: c.normalizedIV * 100 }));
              return {
                label: optSvc.formatDate(expDate),
                calls, puts,
                wCallIV: Math.round(weightedIV(metrics.allCallContracts) * 10) / 10,
                wPutIV: Math.round(weightedIV(metrics.allPutContracts) * 10) / 10,
              };
            }

            // First expiration from initial fetch
            const firstMetrics = optSvc.computeExpirationMetrics(initialChain, currentPrice);
            const globalLatestTradeDay = firstMetrics?.localLatestTradeDay || '';
            if (firstMetrics) {
              results.push(buildExpResult(firstMetrics, expirationDates[0]));
            }

            // Remaining expirations
            for (let ei = 1; ei < maxExp; ei++) {
              try {
                const yf2 = createYF();
                const chain = await yf2.options(ticker, { date: expirationDates[ei] });
                if (chain) {
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
      if (bestHit) {
        allTickers.push({ ...bestHit, chartData, summary, marketCap });
      } else {
        allTickers.push({ ticker, rSquared, date: null, gap: 0, percentile: 0, classification: '', volume: 0, chartData, summary, marketCap });
      }
    } catch (err) {
      console.error(`  [Screen] ${ticker}: error — ${err.message}`);
      allTickers.push({ ticker, error: err.message });
    }
  }

  return { hits, allTickers };
}

// ~200 liquid US small/mid-cap tickers spanning defense, biotech, clean energy,
// SaaS, fintech, medtech, semiconductors, industrials, consumer, cybersecurity.
const UNIVERSE = [
  // Defense / Aerospace
  'KTOS','MRCY','RKLB','BWXT','AVAV','AXON','TDG','HEI','LDOS','BWA',
  'CACI','JOBY','LUNR','RCAT','PLTR',
  // Biotech / Pharma
  'TWST','CYTK','ARWR','IONS','EXAS','HALO','NBIX','PCVX','VKTX','KRYS',
  'SRPT','ALNY','BMRN','INCY','ARGX','EXEL','CPRX','XENE','UTHR','RARE',
  // Clean Energy
  'ENPH','SEDG','BE','FSLR','RUN','AES','CWEN','BEPC','QS','PLUG',
  'ARRY','SHLS','VST','CEG',
  // SaaS / Cloud / Software
  'AI','UPST','BRZE','CFLT','S','GTLB','DOCN','PAYC','PCTY','GLOB',
  'WIX','APPF','NTNX','JAMF','BL','SPSC','BILL','DDOG','ZS','CRWD',
  'MNDY','TOST','HUBS','VEEV','ESTC','FRSH','PTC','ASAN','PCOR','TYL',
  // Cybersecurity
  'TENB','QLYS','OKTA','VRNS','FTNT','PANW','NET','SAIL',
  // Fintech / Payments
  'SOFI','LC','AFRM','PAYO','RELY','FOUR','ACIW','VRRM','HLNE','GPN',
  'MQ','WEX','HOOD','SSNC',
  // Medtech / Healthcare
  'INSP','GKOS','NVCR','TMDX','IRTC','DOCS','ALGN','HIMS','LNTH','MEDP',
  'HQY','GMED','ISRG','DXCM','PODD','HOLX','RVMD','TFX','MMSI','PRCT',
  // Semiconductors
  'AEHR','LSCC','AMBA','SWKS','RMBS','CRUS','SLAB','ALGM','DIOD','PSTG',
  'MTSI','ONTO','FORM','NOVT','MCHP','ACLS','SITM','MPWR','MRVL','LRCX',
  // Industrials / Infrastructure
  'SAIA','TREX','ATKR','CWST','EXPO','AZEK','POWL','ESAB','SPXC','CGNX',
  'GNRC','TT','XYL','WMS','SITE','AAON','MATX',
  // Energy / Materials / Mining
  'MP','UUUU','LEU','WFRD','TDW','CALX','HAYW','IREN','NE','RIG',
  // Consumer / Retail / Food
  'CELH','SMPL','WING','ELF','SFM','DORM','OLED','DV','CARG','TTMI',
  'SHAK','BROS','CAVA','TXRH','DECK',
  // Misc growth
  'EPAM','DUOL','RDDT','RBRK','IOT','APP','KVYO','AXSM','IOVA',
];

/**
 * Revise the screening ticker list by ranking the UNIVERSE by fundamentals.
 *
 * Scoring:
 *   1. Liquidity gate: skip if averageVolume < 500K
 *   2. Revenue growth score: revenueGrowth (null/negative → 0)
 *   3. Leverage factor: 1 / (1 + debtToEquity/100)
 *   4. Final score: revenueGrowth * leverageFactor
 *   Top 50 by score descending.
 *
 * @param {Function} createYF - Factory that returns a fresh yahoo-finance2 instance
 * @param {Function} [onProgress] - Optional callback(current, total, ticker)
 * @returns {Promise<{tickers: string[], details: Array}>}
 */
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
        modules: ['financialData', 'summaryDetail'],
      });

      const fin = result.financialData || {};
      const summary = result.summaryDetail || {};

      const avgVolume = summary.averageVolume ?? 0;
      const marketCap = summary.marketCap ?? 0;

      const revenueGrowth = (fin.revenueGrowth != null && fin.revenueGrowth > 0)
        ? fin.revenueGrowth
        : 0;

      const debtToEquity = fin.debtToEquity ?? 0;
      const leverageFactor = 1 / (1 + Math.max(0, debtToEquity) / 100);

      const score = revenueGrowth * leverageFactor;

      const entry = {
        ticker,
        score,
        revenueGrowth,
        debtToEquity,
        leverageFactor,
        avgVolume,
        marketCap,
      };

      if (avgVolume < 500000) {
        console.log(`  [Revise] ${ticker}: skipped (avgVol ${(avgVolume/1e6).toFixed(2)}M < 500K)`);
        excluded.illiquid.push(entry);
        continue;
      }

      scored.push(entry);

      console.log(`  [Revise] ${ticker}: score=${score.toFixed(4)} (revGrowth=${(revenueGrowth*100).toFixed(1)}%, D/E=${debtToEquity.toFixed(0)}, avgVol=${(avgVolume/1e6).toFixed(1)}M)`);
    } catch (err) {
      console.error(`  [Revise] ${ticker}: error — ${err.message}`);
      errors.push({ ticker, error: err.message });
    }
  }

  // Sort by score descending, take top 50
  scored.sort((a, b) => b.score - a.score);
  const top50 = scored.slice(0, 50);
  const top50Set = new Set(top50.map(s => s.ticker));

  // Classify tickers that scored but didn't make the top 50 by primary weakness
  for (const s of scored) {
    if (top50Set.has(s.ticker)) continue;
    // Primary reason: no/negative revenue growth vs high leverage
    if (s.revenueGrowth === 0) {
      excluded.noGrowth.push(s);
    } else if (s.leverageFactor < 0.5) {
      // D/E > 100 → leverageFactor < 0.5 → leverage was the main drag
      excluded.highLeverage.push(s);
    } else {
      // Both contributed but growth was lower than the cutoff
      excluded.noGrowth.push(s);
    }
  }

  console.log(`[Revise] Done. ${scored.length} scored, ${errors.length} errors, top 50 selected.`);
  console.log(`[Revise] Excluded: ${excluded.illiquid.length} illiquid, ${excluded.noGrowth.length} low/no growth, ${excluded.highLeverage.length} high leverage`);

  return {
    tickers: top50.map(s => s.ticker),
    details: top50,
    excluded,
    errors,
    totalScored: scored.length,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { screenTickers, reviseTickers };
