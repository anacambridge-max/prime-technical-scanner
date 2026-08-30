import "server-only";
import { Candle, Instrument } from "./types";

/**
 * Server-side Upstox API client.
 *
 * SECURITY: this file must never be imported from a "use client" component.
 * The `server-only` import above makes any accidental client-side import fail
 * the build. The access token is read exclusively from process.env and is
 * never returned to the browser.
 */

const UPSTOX_BASE_URL = "https://api.upstox.com/v3";

export class UpstoxAuthError extends Error {
  constructor(message = "Upstox access token missing, invalid, or expired") {
    super(message);
    this.name = "UpstoxAuthError";
  }
}

export class UpstoxRateLimitError extends Error {
  constructor(message = "Upstox API rate limit hit") {
    super(message);
    this.name = "UpstoxRateLimitError";
  }
}

function getAccessToken(): string {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    throw new UpstoxAuthError("UPSTOX_ACCESS_TOKEN environment variable is not set");
  }
  return token;
}

interface FetchOptions {
  retries?: number;
  backoffMs?: number;
}

/**
 * Generic authenticated GET against the Upstox API with retry/backoff.
 * Never throws for expected transient conditions the caller wants to handle per-symbol;
 * callers should catch UpstoxAuthError/UpstoxRateLimitError and normal Error separately.
 */
async function upstoxGet<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { retries = 2, backoffMs = 500 } = options;
  const token = getAccessToken();

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${UPSTOX_BASE_URL}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        // Server-side only; never cache stale market data.
        cache: "no-store",
      });

      if (res.status === 401 || res.status === 403) {
        throw new UpstoxAuthError(`Upstox rejected the access token (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        throw new UpstoxRateLimitError();
      }
      if (!res.ok) {
        throw new Error(`Upstox API error ${res.status} for ${path}`);
      }

      const json = (await res.json()) as T;
      return json;
    } catch (err) {
      lastError = err;
      if (err instanceof UpstoxAuthError) throw err; // no point retrying bad auth
      if (attempt < retries) {
        const wait = backoffMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unknown Upstox error for ${path}`);
}

interface UpstoxCandleResponse {
  status: string;
  data?: {
    candles: [string, number, number, number, number, number, number][]; // ts, o,h,l,c,vol,oi
  };
}

/**
 * Fetches intraday 5-minute candles for a single instrument, today only.
 * Marks the LAST candle as incomplete if it corresponds to the still-forming
 * current 5-minute bucket; all earlier candles returned by Upstox for
 * intraday endpoints are treated as complete.
 */
export async function fetchIntraday5MinCandles(instrumentKey: string, now: Date = new Date()): Promise<Candle[]> {
  const encodedKey = encodeURIComponent(instrumentKey);
  const json = await upstoxGet<UpstoxCandleResponse>(`/historical-candle/intraday/${encodedKey}/5minute`);

  const rows = json.data?.candles ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Upstox returns most-recent-first; normalize to ascending (oldest first).
  const ascending = [...rows].reverse();

  const bucketMs = 5 * 60 * 1000;
  const nowMs = now.getTime();

  const candles: Candle[] = [];
  for (const row of ascending) {
    const [ts, open, high, low, close, volume] = row;
    if (
      typeof ts !== "string" ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue; // skip malformed candle rather than failing the whole symbol
    }
    const candleStart = new Date(ts).getTime();
    if (Number.isNaN(candleStart)) continue;
    const isComplete = candleStart + bucketMs <= nowMs;
    candles.push({ timestamp: new Date(ts).toISOString(), open, high, low, close, volume, isComplete });
  }
  return candles;
}

/**
 * Fetches historical DAILY candles for an instrument, used to derive PDH/PDL.
 * `toDate`/`fromDate` are YYYY-MM-DD. Returns ascending (oldest first).
 */
export async function fetchDailyCandles(instrumentKey: string, fromDate: string, toDate: string): Promise<Candle[]> {
  const encodedKey = encodeURIComponent(instrumentKey);
  const json = await upstoxGet<UpstoxCandleResponse>(
    `/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`
  );
  const rows = json.data?.candles ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ascending = [...rows].reverse();

  const candles: Candle[] = [];
  for (const row of ascending) {
    const [ts, open, high, low, close, volume] = row;
    if (
      typeof ts !== "string" ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue;
    }
    candles.push({ timestamp: new Date(ts).toISOString(), open, high, low, close, volume, isComplete: true });
  }
  return candles;
}

interface UpstoxLtpResponse {
  status: string;
  data?: Record<string, { last_price: number }>;
}

export async function fetchLastPrice(instrumentKey: string): Promise<number | null> {
  const encodedKey = encodeURIComponent(instrumentKey);
  const json = await upstoxGet<UpstoxLtpResponse>(`/market-quote/ltp?instrument_key=${encodedKey}`);
  const entry = json.data ? Object.values(json.data)[0] : undefined;
  return entry ? entry.last_price : null;
}

interface UpstoxInstrumentRow {
  instrument_key: string;
  trading_symbol: string;
  name: string;
  segment: string;
  instrument_type: string;
  underlying_symbol?: string;
  underlying_key?: string;
}

/**
 * Downloads the raw Upstox NSE instrument master (JSON — fetch() handles the gzip
 * transparently). This single file contains every NSE segment (equity, F&O, index),
 * distinguished by the `segment` field, so both equity resolution and F&O universe
 * derivation read from the same download.
 */
export async function fetchNseInstrumentMasterRaw(): Promise<UpstoxInstrumentRow[]> {
  const res = await fetch("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz", {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to download Upstox instrument master (HTTP ${res.status})`);
  }
  return (await res.json()) as UpstoxInstrumentRow[];
}

/**
 * Downloads and parses the Upstox NSE instrument master, filtered to equities only.
 * Used to resolve trading symbols to instrument keys.
 */
export async function fetchNseEquityInstrumentMaster(): Promise<Instrument[]> {
  const rows = await fetchNseInstrumentMasterRaw();
  return rows
    .filter((r) => r.segment === "NSE_EQ" && r.instrument_type === "EQ")
    .map((r) => ({ symbol: r.trading_symbol, instrumentKey: r.instrument_key, name: r.name }));
}
