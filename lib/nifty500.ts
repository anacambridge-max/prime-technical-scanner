import "server-only";
import seedSymbols from "@/data/nifty500-seed.json";
import { fetchNseEquityInstrumentMaster } from "./upstox";
import { Instrument } from "./types";

/**
 * IMPORTANT: `data/nifty500-seed.json` ships with a starter set of liquid, well-known
 * NSE large/mid-cap symbols — it is NOT guaranteed to be the complete, current official
 * NIFTY 500 constituent list (index membership changes twice a year). Before relying on
 * this in production, replace that file with the latest constituent list published by
 * NSE Indices (https://www.niftyindices.com -> NIFTY 500 -> download CSV) or your data
 * vendor. The scanner logic itself does not care how many symbols are in the universe.
 */

let cachedUniverse: Instrument[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // instrument master changes rarely intraday

export async function resolveNifty500Universe(): Promise<{ instruments: Instrument[]; unresolved: string[] }> {
  const now = Date.now();
  if (cachedUniverse && now - cachedAt < CACHE_TTL_MS) {
    return { instruments: cachedUniverse, unresolved: [] };
  }

  const master = await fetchNseEquityInstrumentMaster();
  const bySymbol = new Map(master.map((m) => [m.symbol, m]));

  const instruments: Instrument[] = [];
  const unresolved: string[] = [];
  for (const symbol of seedSymbols as string[]) {
    const match = bySymbol.get(symbol);
    if (match) {
      instruments.push(match);
    } else {
      unresolved.push(symbol);
    }
  }

  cachedUniverse = instruments;
  cachedAt = now;
  return { instruments, unresolved };
}

export function clearUniverseCache(): void {
  cachedUniverse = null;
  cachedAt = 0;
}
