// Browser-native replacement for yahoo-finance2 (v3 pulls in @deno/shim-deno,
// which references fs/net/child_process and cannot run in a webview).
//
// The screening engine only uses `new YahooFinance(...).options(ticker, { date })`,
// so we implement exactly that against Yahoo's public v7 options endpoint and
// return the same shape the library produces (unix timestamps → Date objects).
// Global fetch is routed through native HTTP by CapacitorHttp on-device, which
// bypasses webview CORS.

const BASE = 'https://query2.finance.yahoo.com/v7/finance/options';

function toDate(unixSeconds) {
  return (unixSeconds || unixSeconds === 0) ? new Date(unixSeconds * 1000) : null;
}

function mapContract(c) {
  return {
    contractSymbol: c.contractSymbol,
    strike: c.strike,
    currency: c.currency,
    lastPrice: c.lastPrice,
    change: c.change,
    percentChange: c.percentChange,
    volume: c.volume,
    openInterest: c.openInterest,
    bid: c.bid,
    ask: c.ask,
    contractSize: c.contractSize,
    expiration: toDate(c.expiration),
    lastTradeDate: toDate(c.lastTradeDate),
    impliedVolatility: c.impliedVolatility,
    inTheMoney: c.inTheMoney,
  };
}

class YahooFinance {
  constructor(_opts) {
    // options like { suppressNotices } are irrelevant here.
  }

  async options(ticker, queryOptions = {}) {
    let url = `${BASE}/${encodeURIComponent(ticker)}`;
    if (queryOptions.date) {
      const d = queryOptions.date instanceof Date ? queryOptions.date : new Date(queryOptions.date);
      url += `?date=${Math.floor(d.getTime() / 1000)}`;
    }

    const res = await fetch(url, {
      headers: {
        // A browser-like UA improves the odds Yahoo serves the payload.
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Yahoo options HTTP ${res.status} for ${ticker}`);
    }
    const json = await res.json();
    const err = json?.optionChain?.error;
    if (err) throw new Error(`Yahoo options error: ${err.description || err.code || 'unknown'}`);

    const result = json?.optionChain?.result?.[0];
    if (!result) throw new Error(`Yahoo options: empty result for ${ticker}`);

    return {
      underlyingSymbol: result.underlyingSymbol,
      quote: result.quote || {},
      expirationDates: (result.expirationDates || []).map(toDate),
      strikes: result.strikes || [],
      hasMiniOptions: result.hasMiniOptions,
      options: (result.options || []).map((o) => ({
        expirationDate: toDate(o.expirationDate),
        hasMiniOptions: o.hasMiniOptions,
        calls: (o.calls || []).map(mapContract),
        puts: (o.puts || []).map(mapContract),
      })),
    };
  }
}

// yahoo-finance2 is consumed as `require('yahoo-finance2').default`.
module.exports = YahooFinance;
module.exports.default = YahooFinance;
