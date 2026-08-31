import "server-only";
import fs from "fs/promises";
import path from "path";
import { fetchNseInstrumentMasterRaw } from "./upstox";
import { Instrument } from "./types";

/**
 * The scanner's universe is every NSE stock currently eligible for Futures & Options
 * trading. Instead of maintaining a static symbol list (which goes stale every time
 * NSE reviews the F&O list, typically twice a year), this derives the current F&O
 * universe directly from Upstox's own instrument master:
 *
 *   1. Find every NSE_FO stock-futures contract (segment=NSE_FO, instrument_type=FUT).
 *   2. Read its underlying equity symbol (Upstox tags derivative rows with
 *      `underlying_symbol`; if that's ever missing, fall back to parsing it out of
 *      the trading symbol, e.g. "RELIANCE26FEBFUT" -> "RELIANCE").
 *   3. Resolve each underlying symbol to its NSE_EQ instrument key so the scanner can
 *      pull 5-minute/daily candles for it.
 *
 * Index futures (NIFTY, BANKNIFTY, FINNIFTY, etc.) naturally fall out of this list
 * because they have no matching NSE_EQ equity instrument — they're excluded from
 * `unresolved` reporting below since that's expected, not an error.
 */

const KNOWN_INDEX_UNDERLYINGS = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "NIFTY50",
]);

function deriveUnderlyingFromTradingSymbol(tradingSymbol: string): string | null {
  // Typical stock-futures trading symbol shape: SYMBOL + 2-digit year + 3-letter month + "FUT"
  const match = tradingSymbol.match(/^([A-Z&\-]+?)\d{2}[A-Z]{3}FUT$/);
  return match ? match[1]! : null;
}

let cachedUniverse: Instrument[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // F&O eligibility doesn't change intraday

// Disk-backed fallback so a transient Upstox/CDN block doesn't zero out the whole
// dashboard for the rest of the day — mirrors the philosophy in lib/store.ts. Same
// caveat applies on Vercel: reliable within a warm instance, not guaranteed across
// cold starts/scaled instances. Swap for @vercel/kv if you need stronger guarantees.
const DISK_CACHE_PATH = path.join(process.env.SCANNER_STATE_DIR || "/tmp", "prime-scanner-state", "fno-universe.json");

async function readDiskCache(): Promise<{ instruments: Instrument[]; savedAt: string } | null> {
  try {
    const raw = await fs.readFile(DISK_CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeDiskCache(instruments: Instrument[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(DISK_CACHE_PATH), { recursive: true });
    await fs.writeFile(DISK_CACHE_PATH, JSON.stringify({ instruments, savedAt: new Date().toISOString() }), "utf-8");
  } catch {
    // Best-effort only — an in-memory cache miss just means we retry the live fetch next time.
  }
}

export async function resolveFnoUniverse(): Promise<{ instruments: Instrument[]; unresolved: string[]; usedFallback: boolean }> {
  const now = Date.now();
  if (cachedUniverse && now - cachedAt < CACHE_TTL_MS) {
    return { instruments: cachedUniverse, unresolved: [], usedFallback: false };
  }

  try {
    const rows = await fetchNseInstrumentMasterRaw();

    const equities = rows.filter((r) => r.segment === "NSE_EQ" && r.instrument_type === "EQ");
    const eqBySymbol = new Map(equities.map((r) => [r.trading_symbol, r]));

    const futures = rows.filter((r) => r.segment === "NSE_FO" && r.instrument_type === "FUT");
    const underlyingSymbols = new Set<string>();
    for (const f of futures) {
      const underlying = f.underlying_symbol || deriveUnderlyingFromTradingSymbol(f.trading_symbol);
      if (underlying) underlyingSymbols.add(underlying);
    }

    const instruments: Instrument[] = [];
    const unresolved: string[] = [];
    for (const symbol of Array.from(underlyingSymbols).sort()) {
      const match = eqBySymbol.get(symbol);
      if (match) {
        instruments.push({ symbol, instrumentKey: match.instrument_key, name: match.name });
      } else if (!KNOWN_INDEX_UNDERLYINGS.has(symbol)) {
        unresolved.push(symbol);
      }
    }

    if (instruments.length === 0) {
      throw new Error("Upstox instrument master downloaded but yielded zero resolvable F&O stocks");
    }

    cachedUniverse = instruments;
    cachedAt = now;
    void writeDiskCache(instruments); // fire-and-forget; don't block the scan on disk I/O
    return { instruments, unresolved, usedFallback: false };
  } catch (err) {
    const fallback = await readDiskCache();
    if (fallback && fallback.instruments.length > 0) {
      cachedUniverse = fallback.instruments;
      cachedAt = now; // avoid hammering the failing endpoint every scan cycle
      return { instruments: fallback.instruments, unresolved: [], usedFallback: true };
    }
    throw err;
  }
}

export function clearUniverseCache(): void {
  cachedUniverse = null;
  cachedAt = 0;
}
