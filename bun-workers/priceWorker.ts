/**
 * Price Worker - Bun worker for Yahoo Finance API requests
 *
 * Uses Bun's native fetch for faster HTTP requests and JSON parsing.
 * Communicates with Node.js via stdin/stdout JSON messages.
 */

interface Request {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface Response {
  id?: string;
  success: boolean;
  data?: unknown;
  error?: string;
  ready?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch JSON from a URL using native fetch
 */
async function fetchJSON(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch historical stock prices from Yahoo Finance
 */
async function fetchHistoricalPrices(
  ticker: string,
  period1: number,
  period2: number,
  interval: string = '1d'
): Promise<unknown> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=${interval}`;
  return fetchJSON(url);
}

/**
 * Fetch quote summary for a ticker
 */
async function fetchQuoteSummary(ticker: string): Promise<unknown> {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
  return fetchJSON(url);
}

/**
 * Send a response to Node.js
 */
function sendResponse(response: Response): void {
  console.log(JSON.stringify(response));
}

/**
 * Handle incoming request
 */
async function handleRequest(request: Request): Promise<void> {
  const { id, type, payload } = request;

  try {
    let data: unknown;

    switch (type) {
      case 'fetchJSON':
        data = await fetchJSON(payload.url as string);
        break;

      case 'fetchHistoricalPrices':
        data = await fetchHistoricalPrices(
          payload.ticker as string,
          payload.period1 as number,
          payload.period2 as number,
          payload.interval as string
        );
        break;

      case 'fetchQuoteSummary':
        data = await fetchQuoteSummary(payload.ticker as string);
        break;

      case 'shutdown':
        sendResponse({ success: true, data: 'Shutting down' });
        process.exit(0);
        break;

      default:
        throw new Error(`Unknown request type: ${type}`);
    }

    sendResponse({ id, success: true, data });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    sendResponse({ id, success: false, error: errorMessage });
  }
}

/**
 * Process stdin line by line
 */
async function processStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const request = JSON.parse(line) as Request;
        // Handle request asynchronously (don't await to allow concurrent requests)
        handleRequest(request).catch((err) => {
          console.error(`[priceWorker] Error handling request:`, err);
        });
      } catch (err) {
        console.error(`[priceWorker] Invalid JSON:`, line);
      }
    }
  }
}

// Signal ready to parent process
sendResponse({ ready: true, success: true });

// Start processing stdin
processStdin().catch((err) => {
  console.error('[priceWorker] Fatal error:', err);
  process.exit(1);
});
