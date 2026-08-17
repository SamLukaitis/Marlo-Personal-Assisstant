// Yahoo Finance's chart endpoint — public and keyless, which is the whole reason it's used here
// (every alternative worth having wants an API key and a paid tier above a low free quota). It's
// an undocumented endpoint though, so treat every call as best-effort: a symbol that fails is
// dropped rather than failing the whole briefing, same posture as news.ts.
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// Yahoo returns 403/429 to clients that don't look like browsers.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string | null;
}

// Shown to users who turn markets on without naming anything specific — three headline indices
// rather than individual stocks, since "how are markets doing" is the default question.
export const DEFAULT_SYMBOLS = ["^GSPC", "^IXIC", "^FTSE"];

// Yahoo's own shortName for indices is unfriendly ("S&P 500" is fine, but "^IXIC" often comes
// back as "NASDAQ Composite (^IXIC)"). These are the ones we ship as defaults, so name them.
const FRIENDLY_NAMES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq",
  "^FTSE": "FTSE 100",
  "^DJI": "Dow Jones",
  "^N225": "Nikkei 225",
  "^STOXX50E": "Euro Stoxx 50",
};

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        shortName?: string;
        longName?: string;
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
    }>;
  };
}

// Symbols come from user input, and they land in a URL path segment. Anything that isn't a
// plausible ticker is rejected outright rather than escaped — it can't be a real symbol anyway.
const SYMBOL_PATTERN = /^[A-Z0-9^.\-=]{1,12}$/;

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

async function fetchQuote(symbol: string): Promise<Quote | null> {
  const res = await fetch(`${CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as ChartResponse;
  const meta = data.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const previous = meta?.chartPreviousClose ?? meta?.previousClose;
  if (price === undefined || previous === undefined || !previous) return null;

  const change = price - previous;
  return {
    symbol,
    name: FRIENDLY_NAMES[symbol] ?? meta?.shortName ?? meta?.longName ?? symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round((change / previous) * 10000) / 100,
    currency: meta?.currency ?? null,
  };
}

export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  const valid = symbols.map(normalizeSymbol).filter((s): s is string => s !== null);
  if (!valid.length) return [];

  const results = await Promise.allSettled(valid.map(fetchQuote));
  return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}
