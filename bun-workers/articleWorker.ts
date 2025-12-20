/**
 * Article Worker - Bun worker for HTML fetching and article extraction
 *
 * Uses Bun's native fetch for faster HTTP requests.
 * Optionally uses Readability for article extraction.
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

interface FetchHTMLOptions {
  timeout?: number;
  maxRedirects?: number;
}

interface Article {
  title: string;
  text: string;
  excerpt: string;
  byline: string;
  publishedDate: string | null;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

/**
 * Fetch HTML from a URL with redirect handling
 */
async function fetchHTML(url: string, options: FetchHTMLOptions = {}): Promise<string> {
  const { timeout = 15000, maxRedirects = 5 } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
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
    'meta[name="DC.date"]',
    'meta[name="dcterms.created"]',
    'meta[itemprop="datePublished"]',
    'meta[property="bt:pubDate"]',
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

  // Try time elements with datetime attribute
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

  // Try JSON-LD structured data
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const datePublished = data.datePublished || data.publishedDate;
      if (datePublished) {
        const date = new Date(datePublished);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      }
    } catch {
      // Invalid JSON, continue
    }
  }

  return null;
}

/**
 * Extract article content from HTML using Readability
 */
function extractArticle(html: string, url: string): Article | null {
  try {
    const { document } = parseHTML(html);

    // Use Readability to extract the article
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    if (article) {
      const publishedDate = extractPublishedDate(document as unknown as Document);

      return {
        title: article.title || document.title || '',
        text: article.textContent?.trim() || '',
        excerpt: article.excerpt || '',
        byline: article.byline || '',
        publishedDate,
      };
    }

    return null;
  } catch (error) {
    console.error('[articleWorker] Error extracting article:', error);
    return null;
  }
}

/**
 * Extract stock tickers from article text
 */
function extractTickers(text: string, title: string = ''): string[] {
  const tickers = new Set<string>();
  const combinedText = `${title} ${text}`;

  // Pattern 1: $TICKER format (e.g., $AAPL, $TSLA)
  const dollarPattern = /\$([A-Z]{1,5})\b/g;
  let match;
  while ((match = dollarPattern.exec(combinedText)) !== null) {
    tickers.add(match[1]);
  }

  // Pattern 2: Ticker in parentheses after company name (e.g., "Apple (AAPL)")
  const parenPattern = /\(([A-Z]{1,5})\)/g;
  const excludeList = ['NYSE', 'NASDAQ', 'USA', 'CEO', 'CFO', 'IPO', 'ETF', 'SEC'];
  while ((match = parenPattern.exec(combinedText)) !== null) {
    const potentialTicker = match[1];
    if (!excludeList.includes(potentialTicker)) {
      tickers.add(potentialTicker);
    }
  }

  // Pattern 3: Common financial news patterns like "AAPL shares" or "TSLA stock"
  const stockPattern = /\b([A-Z]{1,5})\s+(shares|stock|equity|securities)\b/gi;
  const excludeWords = ['NYSE', 'NASDAQ', 'THE', 'AND', 'FOR'];
  while ((match = stockPattern.exec(combinedText)) !== null) {
    const potentialTicker = match[1].toUpperCase();
    if (!excludeWords.includes(potentialTicker)) {
      tickers.add(potentialTicker);
    }
  }

  return Array.from(tickers).sort();
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
      case 'fetchHTML': {
        const html = await fetchHTML(
          payload.url as string,
          {
            timeout: (payload.timeout as number) || 15000,
            maxRedirects: (payload.maxRedirects as number) || 5,
          }
        );
        data = html;
        break;
      }

      case 'extractArticle': {
        const url = payload.url as string;
        const html = await fetchHTML(url, {
          timeout: (payload.timeout as number) || 15000,
        });

        const article = extractArticle(html, url);

        if (!article) {
          throw new Error('Readability failed to extract article content');
        }

        const tickers = extractTickers(article.text, article.title);

        data = {
          title: article.title,
          text: article.text,
          url,
          excerpt: article.excerpt,
          byline: article.byline,
          publishedDate: article.publishedDate,
          tickers,
          wordCount: article.text.split(/\s+/).length,
        };
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
          console.error(`[articleWorker] Error handling request:`, err);
        });
      } catch {
        console.error(`[articleWorker] Invalid JSON:`, line);
      }
    }
  }
}

// Signal ready to parent process
sendResponse({ ready: true, success: true });

// Start processing stdin
processStdin().catch((err) => {
  console.error('[articleWorker] Fatal error:', err);
  process.exit(1);
});
