/**
 * Ticker Screening via Yahoo Finance
 *
 * Pre-screens a large list of tickers for significant price events
 * using free Yahoo Finance data (no API key needed).
 *
 * Algorithm: volume × |gap%| with 95th percentile threshold,
 * checked over the last 5 trading days.
 */

async function screenTickers(priceTracker, config = {}) {
  const {
    screenTickers: tickers = [],
    screenDays = 100,
    screenLookbackDays = 5,
    screenPercentileThreshold = 95,
    screenDelayMs = 1000,
    screenMaxTickers = 0,
  } = config;

  if (!tickers.length) {
    console.log('[Screen] No tickers configured for screening');
    return [];
  }

  const list = screenMaxTickers > 0 ? tickers.slice(0, screenMaxTickers) : tickers;
  console.log(`[Screen] Screening ${list.length} tickers (${screenDays}d window, ${screenLookbackDays}d lookback, p${screenPercentileThreshold})`);

  const hits = [];

  for (let i = 0; i < list.length; i++) {
    const ticker = list[i];

    if (i > 0) {
      await sleep(screenDelayMs);
    }

    try {
      const period2 = Math.floor(Date.now() / 1000);
      const period1 = period2 - screenDays * 24 * 60 * 60;

      const bars = await priceTracker.fetchHistoricalPrices(ticker, {
        period1,
        period2,
        interval: '1d',
      });

      if (!bars || bars.length < 20) {
        console.log(`  [Screen] ${ticker}: skipped (only ${bars?.length ?? 0} bars)`);
        continue;
      }

      // Filter out bars with null values
      const validBars = bars.filter(
        (b) => b.open != null && b.close != null && b.volume != null
      );

      if (validBars.length < 20) {
        console.log(`  [Screen] ${ticker}: skipped (only ${validBars.length} valid bars)`);
        continue;
      }

      // Compute volumeGapProduct for each bar (need previous close)
      const products = [];
      for (let j = 1; j < validBars.length; j++) {
        const prevClose = validBars[j - 1].close;
        const bar = validBars[j];
        if (prevClose === 0) continue;

        const gapPct = Math.abs((bar.open - prevClose) / prevClose) * 100;
        const volumeGapProduct = bar.volume * gapPct;

        products.push({
          index: j,
          bar,
          prevClose,
          gapPct,
          volumeGapProduct,
        });
      }

      if (products.length === 0) continue;

      // Compute percentile threshold
      const sorted = products
        .map((p) => p.volumeGapProduct)
        .filter((v) => !isNaN(v) && v > 0)
        .sort((a, b) => a - b);

      if (sorted.length === 0) continue;

      const thresholdIndex = Math.floor((screenPercentileThreshold / 100) * sorted.length);
      const threshold = sorted[Math.min(thresholdIndex, sorted.length - 1)];

      // Check last N trading days
      const recentProducts = products.slice(-screenLookbackDays);

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

        hits.push({
          ticker,
          date: entry.bar.date,
          gap: entry.gapPct,
          volumeGapProduct: entry.volumeGapProduct,
          percentile,
          classification,
          volume: entry.bar.volume,
        });
      }
    } catch (err) {
      console.error(`  [Screen] ${ticker}: error — ${err.message}`);
    }
  }

  return hits;
}

// ~200 liquid US small/mid-cap tickers spanning defense, biotech, clean energy,
// SaaS, fintech, medtech, semiconductors, industrials, consumer, cybersecurity.
const UNIVERSE = [
  // Defense / Aerospace
  'KTOS','MRCY','RKLB','BWXT','AVAV','AXON','TDG','HEI','LDOS','BWA',
  'AJRD','JOBY','LUNR','RCAT','PLTR',
  // Biotech / Pharma
  'TWST','SDGR','ARWR','IONS','EXAS','HALO','NBIX','PCVX','VKTX','KRYS',
  'SRPT','ALNY','BMRN','INCY','ARGX','BPMC','CPRX','XENE','RCKT','RARE',
  // Clean Energy
  'ENPH','SEDG','BE','FSLR','RUN','NOVA','STEM','CHPT','QS','PLUG',
  'ARRY','SHLS','EVGO','BLNK',
  // SaaS / Cloud / Software
  'AI','UPST','BRZE','CFLT','S','GTLB','DOCN','PAYC','PCTY','GLOB',
  'WIX','APPF','NTNX','JAMF','BL','SPSC','BILL','DDOG','ZS','CRWD',
  'MNDY','TOST','HUBS','VEEV','ESTC','FRSH','SMAR','ASAN','PCOR','ALTR',
  // Cybersecurity
  'TENB','QLYS','RPD','VRNS','FTNT','PANW','CYBR','SAIL',
  // Fintech / Payments
  'SOFI','LC','AFRM','PAYO','RELY','FOUR','ACIW','VRRM','HLNE','SQ',
  'MQ','LPRO','PSFE','OLO',
  // Medtech / Healthcare
  'INSP','GKOS','NVCR','TMDX','IRTC','DOCS','GDRX','HIMS','LNTH','MEDP',
  'HQY','GMED','ISRG','DXCM','PODD','SWAV','RVMD','NARI','SILK','PRCT',
  // Semiconductors
  'AEHR','LSCC','AMBA','CEVA','RMBS','CRUS','SLAB','ALGM','DIOD','PSTG',
  'MTSI','ONTO','FORM','NOVT','WOLF','ACLS','SITM','MPWR','MRVL','LRCX',
  // Industrials / Infrastructure
  'SAIA','TREX','ATKR','CWST','EXPO','FOXF','POWL','ESAB','SPXC','CGNX',
  'GNRC','TT','XYL','WMS','SITE','AAON','MATX',
  // Energy / Materials / Mining
  'MP','UUUU','LEU','WFRD','TDW','CALX','HAYW','IREN','NE','RIG',
  // Consumer / Retail / Food
  'CELH','SMPL','VITL','ELF','SFM','DORM','OLED','DV','CARG','TTMI',
  'SHAK','BROS','CAVA','DTC','XPOF',
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
