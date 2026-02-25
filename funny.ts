import { parseArgs } from "util";
import { mkdir, readdir, unlink, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { linearRegression } from "simple-statistics";
import yahooFinance from "yahoo-finance2";

interface StockBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface AnalyzedBar extends StockBar {
  marketReturn?: number;
  stockReturn?: number;
  residualReturn?: number;
  residualGapPct?: number;
  priceGapPct?: number;
  volumeGapProduct?: number;
  isEarningsDate?: boolean;
  earningsClassification?: string;
  eventStrength?: number;
}

type ClassificationType =
  | "negative_anticipated"
  | "surprising_negative"
  | "positive_anticipated"
  | "surprising_positive"
  | "unknown"
  | "none";

class StockAnalyzer {
  constructor() {
    // Suppress yahoo-finance2 validation warnings
    yahooFinance.suppressNotices(["yahooSurvey"]);
  }

  private getCsvFilename(
    ticker: string,
    startDate: string,
    endDate: string
  ): string {
    return `data/${ticker}_${startDate}_to_${endDate}.csv`;
  }

  async saveToCSV(
    data: StockBar[],
    ticker: string,
    startDate: string,
    endDate: string
  ): Promise<string> {
    await mkdir("data", { recursive: true });

    // Delete existing CSV files for this ticker
    const files = await readdir("data");
    for (const file of files) {
      if (file.startsWith(`${ticker}_`) && file.endsWith(".csv")) {
        await unlink(`data/${file}`);
        console.log(`Removed existing file: data/${file}`);
      }
    }

    const filename = this.getCsvFilename(ticker, startDate, endDate);
    const header = "date,open,high,low,close,volume";
    const rows = data.map(
      (bar) =>
        `${bar.date.toISOString().split("T")[0]},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`
    );
    await writeFile(filename, [header, ...rows].join("\n"));
    console.log(`Data saved to ${filename}`);
    return filename;
  }

  async loadFromCSV(
    ticker: string,
    startDate: string,
    endDate: string
  ): Promise<StockBar[] | null> {
    const filename = this.getCsvFilename(ticker, startDate, endDate);
    if (!existsSync(filename)) return null;

    console.log(`Loading ${ticker} data from ${filename}`);
    const content = await readFile(filename, "utf-8");
    const lines = content.trim().split("\n");
    const data: StockBar[] = [];

    for (let i = 1; i < lines.length; i++) {
      const [date, open, high, low, close, volume] = lines[i].split(",");
      data.push({
        date: new Date(date),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      });
    }
    return data;
  }

  async fetchStockData(
    ticker: string,
    startDate: string,
    endDate: string
  ): Promise<StockBar[]> {
    // Try CSV first
    const cached = await this.loadFromCSV(ticker, startDate, endDate);
    if (cached) return cached;

    console.log(`Fetching ${ticker} data from Yahoo Finance...`);

    try {
      const queryOptions = {
        period1: startDate,
        period2: endDate,
        interval: "1d" as const,
      };

      const result = await yahooFinance.chart(ticker, queryOptions);

      if (!result.quotes || result.quotes.length === 0) {
        throw new Error(`No data returned for ${ticker}`);
      }

      const bars: StockBar[] = result.quotes
        .filter(
          (q) =>
            q.open !== null &&
            q.high !== null &&
            q.low !== null &&
            q.close !== null &&
            q.volume !== null
        )
        .map((q) => ({
          date: new Date(q.date),
          open: q.open!,
          high: q.high!,
          low: q.low!,
          close: q.close!,
          volume: q.volume!,
        }));

      bars.sort((a, b) => a.date.getTime() - b.date.getTime());
      await this.saveToCSV(bars, ticker, startDate, endDate);
      return bars;
    } catch (error) {
      console.log(`Error fetching data from Yahoo Finance: ${error}`);
      console.log("Checking for older data files...");

      // Try to find any existing file for this ticker
      if (existsSync("data")) {
        const files = await readdir("data");
        const tickerFiles = files.filter(
          (f) => f.startsWith(`${ticker}_`) && f.endsWith(".csv")
        );
        if (tickerFiles.length > 0) {
          const latestFile = `data/${tickerFiles[tickerFiles.length - 1]}`;
          console.log(`Using most recent data file: ${latestFile}`);
          const content = await readFile(latestFile, "utf-8");
          const lines = content.trim().split("\n");
          const data: StockBar[] = [];
          for (let i = 1; i < lines.length; i++) {
            const [date, open, high, low, close, volume] = lines[i].split(",");
            data.push({
              date: new Date(date),
              open: parseFloat(open),
              high: parseFloat(high),
              low: parseFloat(low),
              close: parseFloat(close),
              volume: parseFloat(volume),
            });
          }
          return data;
        }
      }
      throw new Error(`No data available for ${ticker}`);
    }
  }

  filterMarketMovements(
    stockData: StockBar[],
    marketData: StockBar[]
  ): AnalyzedBar[] {
    // Create a map of market data by date string
    const marketByDate = new Map<string, StockBar>();
    for (const bar of marketData) {
      marketByDate.set(bar.date.toISOString().split("T")[0], bar);
    }

    // Align and combine data
    const combined: {
      stock: StockBar;
      market: StockBar;
      stockReturn?: number;
      marketReturn?: number;
    }[] = [];

    for (const stockBar of stockData) {
      const dateStr = stockBar.date.toISOString().split("T")[0];
      const marketBar = marketByDate.get(dateStr);
      if (marketBar) {
        combined.push({ stock: stockBar, market: marketBar });
      }
    }

    // Calculate returns
    for (let i = 1; i < combined.length; i++) {
      combined[i].stockReturn =
        (combined[i].stock.close - combined[i - 1].stock.close) /
        combined[i - 1].stock.close;
      combined[i].marketReturn =
        (combined[i].market.close - combined[i - 1].market.close) /
        combined[i - 1].market.close;
    }

    // Filter out entries without returns
    const withReturns = combined.filter(
      (c) => c.stockReturn !== undefined && c.marketReturn !== undefined
    );

    // Linear regression
    const points: [number, number][] = withReturns.map((c) => [
      c.marketReturn!,
      c.stockReturn!,
    ]);
    const regression = linearRegression(points);
    const slope = regression.m;
    const intercept = regression.b;

    // Calculate R-squared
    const yMean =
      withReturns.reduce((sum, c) => sum + c.stockReturn!, 0) /
      withReturns.length;
    const ssTotal = withReturns.reduce(
      (sum, c) => sum + Math.pow(c.stockReturn! - yMean, 2),
      0
    );
    const ssResidual = withReturns.reduce((sum, c) => {
      const predicted = slope * c.marketReturn! + intercept;
      return sum + Math.pow(c.stockReturn! - predicted, 2);
    }, 0);
    const rSquared = 1 - ssResidual / ssTotal;

    console.log(`Market correlation (R^2): ${rSquared.toFixed(3)}`);
    console.log(`Beta coefficient: ${slope.toFixed(3)}`);

    // Build result with residuals
    const result: AnalyzedBar[] = [];
    for (const c of combined) {
      const bar: AnalyzedBar = { ...c.stock };
      if (c.stockReturn !== undefined && c.marketReturn !== undefined) {
        bar.marketReturn = c.marketReturn;
        bar.stockReturn = c.stockReturn;
        bar.residualReturn = c.stockReturn - (slope * c.marketReturn + intercept);
      }
      result.push(bar);
    }

    return result;
  }

  identifyEarningsDates(
    data: AnalyzedBar[],
    targetDates: number = 15,
    useResiduals: boolean = true
  ): AnalyzedBar[] {
    const result = data.map((bar) => ({ ...bar }));

    let gapType: string;

    if (useResiduals && result.some((bar) => bar.residualReturn !== undefined)) {
      // Use absolute residual return directly as the gap percentage
      for (const bar of result) {
        bar.residualGapPct = Math.abs((bar.residualReturn ?? 0) * 100);
        bar.volumeGapProduct = bar.volume * bar.residualGapPct;
      }
      gapType = "residual returns";
    } else {
      // Use price gap calculation
      for (let i = 1; i < result.length; i++) {
        const prevClose = result[i - 1].close;
        const gap = Math.abs((result[i].open - prevClose) / prevClose * 100);
        result[i].priceGapPct = gap;
        result[i].volumeGapProduct = result[i].volume * gap;
      }
      gapType = "price gap";
    }

    // Handle edge cases
    let effectiveTargetDates = targetDates;
    if (effectiveTargetDates <= 0) {
      console.log("Target dates must be greater than 0, defaulting to 1");
      effectiveTargetDates = 1;
    } else if (effectiveTargetDates > result.length - 1) {
      console.log(
        `Target dates ${effectiveTargetDates} exceeds available data points, using maximum available: ${result.length - 1}`
      );
      effectiveTargetDates = result.length - 1;
    }

    // Sort to find threshold
    const products = result
      .map((bar) => bar.volumeGapProduct ?? 0)
      .filter((p) => !isNaN(p))
      .sort((a, b) => b - a);

    const threshold =
      products.length <= effectiveTargetDates
        ? 0
        : products[effectiveTargetDates - 1];

    // Mark earnings dates
    for (const bar of result) {
      bar.isEarningsDate = (bar.volumeGapProduct ?? 0) >= threshold;
    }

    const datesFound = result.filter((bar) => bar.isEarningsDate).length;

    console.log(`Using ${gapType} for gap calculation`);
    console.log(`Volume * Gap threshold: ${threshold.toFixed(2)}`);
    console.log(
      `Identified ${datesFound} potential earnings dates using volume * gap formula`
    );

    // Print top 10 dates
    const gapCol = useResiduals ? "residualGapPct" : "priceGapPct";
    const topDates = [...result]
      .sort((a, b) => (b.volumeGapProduct ?? 0) - (a.volumeGapProduct ?? 0))
      .slice(0, 10);

    console.log("\nTop 10 dates by volume * gap:");
    for (const bar of topDates) {
      const gap = (bar as Record<string, unknown>)[gapCol] as number | undefined;
      console.log(
        `${bar.date.toISOString().split("T")[0]}: Volume=${bar.volume.toLocaleString()}, Gap=${(gap ?? 0).toFixed(2)}%, Product=${(bar.volumeGapProduct ?? 0).toLocaleString()}`
      );
    }

    return result;
  }

  classifyEarningsReactions(data: AnalyzedBar[]): AnalyzedBar[] {
    const result = data.map((bar) => ({ ...bar }));
    const earningsIndices: number[] = [];

    for (let i = 0; i < result.length; i++) {
      if (result[i].isEarningsDate) {
        earningsIndices.push(i);
      }
    }

    if (earningsIndices.length === 0) {
      console.log("No earnings dates found to classify");
      return result;
    }

    for (const idx of earningsIndices) {
      if (idx === 0) {
        result[idx].earningsClassification = "unknown";
        result[idx].eventStrength = 0;
        continue;
      }

      const prevClose = result[idx - 1].close;
      const currentOpen = result[idx].open;
      const currentClose = result[idx].close;

      const gapNegative = prevClose > currentOpen;
      const intradayPositive = currentClose > currentOpen;

      let classification: ClassificationType;

      if (gapNegative) {
        classification = intradayPositive
          ? "negative_anticipated"
          : "surprising_negative";
      } else {
        classification = intradayPositive
          ? "surprising_positive"
          : "positive_anticipated";
      }

      result[idx].earningsClassification = classification;
      // Calculate strength as percentage range
      result[idx].eventStrength =
        ((result[idx].high - result[idx].low) / result[idx].low) * 100;
    }

    // Set non-earnings dates to 'none'
    for (const bar of result) {
      if (!bar.isEarningsDate) {
        bar.earningsClassification = "none";
        bar.eventStrength = 0;
      }
    }

    return result;
  }

  analyzeEarningsStatistics(data: AnalyzedBar[]): void {
    const earningsData = data.filter((bar) => bar.isEarningsDate);

    if (earningsData.length === 0) {
      console.log("No earnings data to analyze");
      return;
    }

    console.log("\n=== EARNINGS CLASSIFICATION SUMMARY ===");
    const counts: Record<string, number> = {};
    for (const bar of earningsData) {
      const cls = bar.earningsClassification ?? "unknown";
      counts[cls] = (counts[cls] ?? 0) + 1;
    }
    for (const [cls, count] of Object.entries(counts)) {
      console.log(`${cls}: ${count}`);
    }

    console.log("\n=== DETAILED EARNINGS EVENTS ===");
    for (let i = 0; i < data.length; i++) {
      const bar = data[i];
      if (!bar.isEarningsDate || i === 0) continue;

      const prevClose = data[i - 1].close;
      const gap = ((bar.open - prevClose) / prevClose) * 100;
      const intraday = ((bar.close - bar.open) / bar.open) * 100;
      const totalChange = ((bar.close - prevClose) / prevClose) * 100;

      console.log(`\nDate: ${bar.date.toISOString().split("T")[0]}`);
      console.log(`Classification: ${bar.earningsClassification}`);
      console.log(`Previous Close: $${prevClose.toFixed(2)}`);
      console.log(`Open: $${bar.open.toFixed(2)} (Gap: ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}%)`);
      console.log(`Close: $${bar.close.toFixed(2)} (Intraday: ${intraday >= 0 ? "+" : ""}${intraday.toFixed(2)}%)`);
      console.log(`Total Change: ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(2)}%`);
      console.log(`Event Strength: ${(bar.eventStrength ?? 0).toFixed(2)}%`);
      console.log(`Volume: ${bar.volume.toLocaleString()}`);
      console.log(`Volume * Gap Product: ${(bar.volumeGapProduct ?? 0).toLocaleString()}`);
    }
  }

  async saveResults(
    data: AnalyzedBar[],
    ticker: string
  ): Promise<string> {
    await mkdir("data", { recursive: true });

    // Delete existing analysis files
    const files = await readdir("data");
    for (const file of files) {
      if (file.startsWith(`${ticker}_analysis_`) && file.endsWith(".csv")) {
        await unlink(`data/${file}`);
        console.log(`Removed existing analysis file: data/${file}`);
      }
    }

    const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const filename = `data/${ticker}_analysis_${date}.csv`;

    const header =
      "date,open,high,low,close,volume,marketReturn,stockReturn,residualReturn,residualGapPct,priceGapPct,volumeGapProduct,isEarningsDate,earningsClassification,eventStrength";
    const rows = data.map((bar) =>
      [
        bar.date.toISOString().split("T")[0],
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.marketReturn ?? "",
        bar.stockReturn ?? "",
        bar.residualReturn ?? "",
        bar.residualGapPct ?? "",
        bar.priceGapPct ?? "",
        bar.volumeGapProduct ?? "",
        bar.isEarningsDate ?? false,
        bar.earningsClassification ?? "",
        bar.eventStrength ?? "",
      ].join(",")
    );

    await writeFile(filename, [header, ...rows].join("\n"));
    return filename;
  }

  async generateChart(data: AnalyzedBar[], ticker: string): Promise<string> {
    await mkdir("data", { recursive: true });

    const earningsData = data.filter((bar) => bar.isEarningsDate);
    const threshold = earningsData.length > 0
      ? Math.min(...earningsData.map((b) => b.volumeGapProduct ?? 0))
      : 0;

    const classificationColors: Record<string, string> = {
      negative_anticipated: "orange",
      surprising_negative: "red",
      positive_anticipated: "lightgreen",
      surprising_positive: "darkgreen",
      unknown: "gray",
      none: "blue",
    };

    // Prepare data for charts
    const dates = data.map((b) => b.date.toISOString().split("T")[0]);
    const closes = data.map((b) => b.close);
    const volumes = data.map((b) => b.volume);
    const residualReturns = data.map((b) => (b.residualReturn ?? 0) * 100);
    const volumeGapProducts = data.map((b) =>
      Math.log10(Math.max(b.volumeGapProduct ?? 1, 1))
    );

    // Earnings scatter data for chart 1
    const earningsScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split("T")[0],
      y: b.close,
      classification: b.earningsClassification ?? "none",
    }));

    // Earnings volume data for chart 2
    const earningsVolumeIndices = data
      .map((b, i) => (b.isEarningsDate ? i : -1))
      .filter((i) => i >= 0);

    // Earnings residual scatter for chart 3
    const earningsResidualScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split("T")[0],
      y: (b.residualReturn ?? 0) * 100,
    }));

    // Earnings volume gap scatter for chart 4
    const earningsVolumeGapScatter = earningsData.map((b) => ({
      x: b.date.toISOString().split("T")[0],
      y: Math.log10(Math.max(b.volumeGapProduct ?? 1, 1)),
    }));

    // Event strength data for chart 5
    const strengthData = earningsData.map((b) => ({
      date: b.date.toISOString().split("T")[0],
      strength: b.eventStrength ?? 0,
      classification: b.earningsClassification ?? "none",
      color: classificationColors[b.earningsClassification ?? "none"],
    }));

    const avgStrength =
      strengthData.length > 0
        ? strengthData.reduce((sum, d) => sum + d.strength, 0) / strengthData.length
        : 0;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ticker} Stock Analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #2d2d2d;
      color: #d4d4d4;
      margin: 0;
      padding: 20px;
    }
    h1 {
      text-align: center;
      color: #a8b5a2;
    }
    .chart-container {
      background: #383838;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      max-width: 1400px;
      margin-left: auto;
      margin-right: auto;
    }
    .chart-container canvas {
      height: 600px !important;
    }
    .legend {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
  </style>
</head>
<body>
  <h1>${ticker} Stock Analysis</h1>

  <div class="legend">
    <div class="legend-item"><div class="legend-color" style="background: darkgreen"></div> Surprising Positive</div>
    <div class="legend-item"><div class="legend-color" style="background: lightgreen"></div> Positive Anticipated</div>
    <div class="legend-item"><div class="legend-color" style="background: orange"></div> Negative Anticipated</div>
    <div class="legend-item"><div class="legend-color" style="background: red"></div> Surprising Negative</div>
  </div>

  <div class="chart-container">
    <canvas id="priceChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="volumeChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="residualChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="volumeGapChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="strengthChart"></canvas>
  </div>

  <script>
    const dates = ${JSON.stringify(dates)};
    const closes = ${JSON.stringify(closes)};
    const volumes = ${JSON.stringify(volumes)};
    const residualReturns = ${JSON.stringify(residualReturns)};
    const volumeGapProducts = ${JSON.stringify(volumeGapProducts)};
    const earningsScatter = ${JSON.stringify(earningsScatter)};
    const earningsVolumeIndices = ${JSON.stringify(earningsVolumeIndices)};
    const earningsResidualScatter = ${JSON.stringify(earningsResidualScatter)};
    const earningsVolumeGapScatter = ${JSON.stringify(earningsVolumeGapScatter)};
    const strengthData = ${JSON.stringify(strengthData)};
    const threshold = ${Math.log10(Math.max(threshold, 1))};
    const avgStrength = ${avgStrength};

    const classificationColors = ${JSON.stringify(classificationColors)};

    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      aspectRatio: 2,
      plugins: {
        legend: { labels: { color: '#b0b0b0' } }
      },
      scales: {
        x: {
          type: 'category',
          ticks: { color: '#909090', maxTicksLimit: 20 },
          grid: { color: '#454545' }
        },
        y: {
          ticks: { color: '#909090' },
          grid: { color: '#454545' }
        }
      }
    };

    // Chart 1: Stock Price with Earnings Events
    new Chart(document.getElementById('priceChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: '${ticker} Close Price',
            data: closes,
            borderColor: 'rgba(136, 176, 136, 0.8)',
            backgroundColor: 'rgba(136, 176, 136, 0.1)',
            borderWidth: 1,
            pointRadius: 0,
            fill: true
          },
          ...Object.keys(classificationColors).filter(c => c !== 'none').map(classification => ({
            label: classification.replace(/_/g, ' '),
            data: earningsScatter
              .filter(e => e.classification === classification)
              .map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: classificationColors[classification],
            borderColor: classificationColors[classification],
            pointRadius: 8,
            pointHoverRadius: 10
          }))
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: '${ticker} Stock Price with Earnings Events', color: '#b0b0b0' }
        }
      }
    });

    // Chart 2: Volume
    const volumeColors = volumes.map((_, i) =>
      earningsVolumeIndices.includes(i) ? 'rgba(205, 100, 100, 0.8)' : 'rgba(120, 140, 160, 0.5)'
    );
    new Chart(document.getElementById('volumeChart'), {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [{
          label: 'Volume',
          data: volumes,
          backgroundColor: volumeColors,
          borderWidth: 0
        }]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Trading Volume (Highlighted = Earnings Dates)', color: '#b0b0b0' }
        }
      }
    });

    // Chart 3: Residual Returns
    new Chart(document.getElementById('residualChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Residual Return (%)',
            data: residualReturns,
            borderColor: 'rgba(160, 140, 180, 0.8)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Earnings Dates',
            data: earningsResidualScatter.map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: 'rgba(205, 100, 100, 0.9)',
            borderColor: 'rgba(205, 100, 100, 0.9)',
            pointRadius: 6
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Market-Filtered Stock Movements (Residual Returns)', color: '#b0b0b0' },
          annotation: {
            annotations: {
              zeroLine: {
                type: 'line',
                yMin: 0,
                yMax: 0,
                borderColor: 'white',
                borderWidth: 1,
                borderDash: [5, 5]
              }
            }
          }
        }
      }
    });

    // Chart 4: Volume * Gap Product (Log Scale)
    new Chart(document.getElementById('volumeGapChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Log10(Volume * Gap)',
            data: volumeGapProducts,
            borderColor: 'rgba(120, 140, 160, 0.7)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Earnings Dates',
            data: earningsVolumeGapScatter.map(e => ({ x: e.x, y: e.y })),
            type: 'scatter',
            backgroundColor: 'rgba(205, 100, 100, 0.9)',
            borderColor: 'rgba(205, 100, 100, 0.9)',
            pointRadius: 6
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Volume * Gap Product (Log10 Scale)', color: '#b0b0b0' }
        }
      }
    });

    // Chart 5: Event Strength
    new Chart(document.getElementById('strengthChart'), {
      type: 'bar',
      data: {
        labels: strengthData.map(d => d.date),
        datasets: [{
          label: 'Event Strength (%)',
          data: strengthData.map(d => d.strength),
          backgroundColor: strengthData.map(d => d.color),
          borderWidth: 0
        }]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          title: { display: true, text: 'Event Strength (High-Low Range on Event Days) - Avg: ' + avgStrength.toFixed(2) + '%', color: '#b0b0b0' }
        }
      }
    });
  </script>
</body>
</html>`;

    const filename = `data/${ticker}_analysis.html`;
    await writeFile(filename, html);
    return filename;
  }
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      ticker: { type: "string", default: "NVDA" },
      benchmark: { type: "string", default: "SPY" },
      days: { type: "string", default: "1700" },
      "min-events": { type: "string", default: "15" },
    },
    allowPositionals: true,
  });

  const ticker = values.ticker ?? "NVDA";
  const benchmark = values.benchmark ?? "SPY";
  const days = parseInt(values.days ?? "1700", 10);
  const minEvents = parseInt(values["min-events"] ?? "15", 10);

  const endDate = new Date().toISOString().split("T")[0];
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - days);
  const startDate = startDateObj.toISOString().split("T")[0];

  console.log("=== STOCK ANALYSIS ===");
  console.log(`Analyzing ${ticker} vs ${benchmark}`);
  console.log(`Date range: ${startDate} to ${endDate}`);

  const analyzer = new StockAnalyzer();

  try {
    // Step 1: Load stock data
    console.log("\n1. Loading stock data...");
    const stockData = await analyzer.fetchStockData(ticker, startDate, endDate);
    const marketData = await analyzer.fetchStockData(benchmark, startDate, endDate);

    console.log(`${ticker} data: ${stockData.length} days`);
    console.log(`World index data: ${marketData.length} days`);

    // Step 2: Filter out market movements
    console.log("\n2. Filtering out market movements...");
    const stockFiltered = analyzer.filterMarketMovements(stockData, marketData);

    // Step 3: Identify potential earnings dates
    console.log("\n3. Identifying potential earnings dates...");
    const stockWithEarnings = analyzer.identifyEarningsDates(
      stockFiltered,
      minEvents,
      true
    );

    // Step 4: Classify earnings reactions
    console.log("\n4. Classifying earnings reactions...");
    const stockWithClassifications =
      analyzer.classifyEarningsReactions(stockWithEarnings);

    // Analyze results
    analyzer.analyzeEarningsStatistics(stockWithClassifications);

    // Step 5: Save results
    console.log("\n5. Saving results...");
    const outputFile = await analyzer.saveResults(stockWithClassifications, ticker);
    console.log(`Results saved to: ${outputFile}`);

    // Step 6: Generate and open chart
    console.log("\n6. Generating visualizations...");
    const chartFile = await analyzer.generateChart(stockWithClassifications, ticker);
    console.log(`Chart saved to: ${chartFile}`);

    // Open the chart in the default browser
    Bun.spawn(["xdg-open", chartFile]);
  } catch (error) {
    console.error(`Error during analysis: ${error}`);
    console.log("\nPlease check your API key and internet connection.");
  }
}

main();
