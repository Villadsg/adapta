/**
 * News Worker - Bun worker for batch news operations
 *
 * Handles batch article fetching with concurrency control.
 * Uses Bun's native fetch for faster HTTP requests.
 * Communicates with Node.js via stdin/stdout JSON messages.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

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

interface ArticleResult {
  url: string;
  success: boolean;
  title?: string;
  text?: string;
  excerpt?: string;
  byline?: string;
  publishedDate?: string | null;
  tickers?: string[];
  wordCount?: number;
  error?: string;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract published date from HTML document
 */
function extractPublishedDate(document: Document): string | null {
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="publishDate"]',
    'meta[name="publish_date"]',
    'meta[name="date"]',
  ];

  for (const selector of metaSelectors) {
    const meta = document.querySelector(selector);
    if (meta) {
      const content = meta.getAttribute('content');
      if (content) {
        const date = new Date(content);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      }
    }
  }

  const timeElement = document.querySelector('time[datetime]');
  if (timeElement) {
    const datetime = timeElement.getAttribute('datetime');
    if (datetime) {
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  return null;
}

/**
 * Extract stock tickers from text
 */
function extractTickers(text: string, title: string = ''): string[] {
  const tickers = new Set<string>();
  const combinedText = `${title} ${text}`;

  const dollarPattern = /\$([A-Z]{1,5})\b/g;
  let match;
  while ((match = dollarPattern.exec(combinedText)) !== null) {
    tickers.add(match[1]);
  }

  const parenPattern = /\(([A-Z]{1,5})\)/g;
  const excludeList = ['NYSE', 'NASDAQ', 'USA', 'CEO', 'CFO', 'IPO', 'ETF', 'SEC'];
  while ((match = parenPattern.exec(combinedText)) !== null) {
    if (!excludeList.includes(match[1])) {
      tickers.add(match[1]);
    }
  }

  return Array.from(tickers).sort();
}

/**
 * Fetch and extract a single article
 */
async function fetchArticle(url: string, timeout: number = 15000): Promise<ArticleResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.length < 100) {
      throw new Error('Failed to extract article content');
    }

    const publishedDate = extractPublishedDate(document as unknown as Document);
    const text = article.textContent.trim();
    const tickers = extractTickers(text, article.title || '');

    return {
      url,
      success: true,
      title: article.title || '',
      text,
      excerpt: article.excerpt || '',
      byline: article.byline || '',
      publishedDate,
      tickers,
      wordCount: text.split(/\s+/).length,
    };
  } catch (error) {
    return {
      url,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Batch fetch articles with concurrency control
 */
async function batchFetchArticles(
  urls: string[],
  concurrency: number = 3,
  delayMs: number = 500
): Promise<ArticleResult[]> {
  const results: ArticleResult[] = [];
  const queue = [...urls];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;

      const result = await fetchArticle(url);
      results.push(result);

      // Rate limiting delay
      if (queue.length > 0) {
        await sleep(delayMs);
      }
    }
  }

  // Start concurrent workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
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
      case 'fetchArticle': {
        const result = await fetchArticle(
          payload.url as string,
          (payload.timeout as number) || 15000
        );
        data = result;
        break;
      }

      case 'batchFetchArticles': {
        const results = await batchFetchArticles(
          payload.urls as string[],
          (payload.concurrency as number) || 3,
          (payload.delayMs as number) || 500
        );
        data = results;
        break;
      }

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
        handleRequest(request).catch((err) => {
          console.error(`[newsWorker] Error handling request:`, err);
        });
      } catch {
        console.error(`[newsWorker] Invalid JSON:`, line);
      }
    }
  }
}

// Signal ready to parent process
sendResponse({ ready: true, success: true });

// Start processing stdin
processStdin().catch((err) => {
  console.error('[newsWorker] Fatal error:', err);
  process.exit(1);
});
