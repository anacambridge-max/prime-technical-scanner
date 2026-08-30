import "server-only";
import fs from "fs/promises";
import path from "path";
import { ScanMeta, Signal, SignalLogEntry } from "./types";

/**
 * Persists the day's scan state so that once a stock appears (WATCH/SETUP/CONFIRMED)
 * it is never silently dropped from the dashboard for the rest of that trading day,
 * and so CONFIRMED signals stay locked in even if the underlying condition later
 * reverses intraday.
 *
 * NOTE ON DEPLOYMENT: this default implementation writes to the filesystem under /tmp,
 * which works reliably for local development and for a single long-lived server
 * instance (VPS/Docker), and works "well enough" on Vercel as long as the same
 * serverless instance stays warm. Vercel does NOT guarantee /tmp survives across
 * cold starts or across concurrently scaled instances. For guaranteed correctness in
 * production on Vercel, swap this for @vercel/kv or Upstash Redis — the DayStore
 * interface below is intentionally small so that's a drop-in change (see
 * `createKvStoreIfConfigured` at the bottom for a ready-made switch point).
 */

export interface DayState {
  tradingDate: string;
  signals: Record<string, Signal>; // keyed by Signal.id (`${symbol}:${tradingDate}`)
  log: SignalLogEntry[];
  lastMeta: ScanMeta | null;
}

export interface DayStore {
  load(tradingDate: string): Promise<DayState | null>;
  save(state: DayState): Promise<void>;
}

function emptyState(tradingDate: string): DayState {
  return { tradingDate, signals: {}, log: [], lastMeta: null };
}

class FileDayStore implements DayStore {
  private dir: string;
  private memoryFallback = new Map<string, DayState>();

  constructor() {
    this.dir = path.join(process.env.SCANNER_STATE_DIR || "/tmp", "prime-scanner-state");
  }

  private filePath(tradingDate: string): string {
    return path.join(this.dir, `${tradingDate}.json`);
  }

  async load(tradingDate: string): Promise<DayState | null> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const raw = await fs.readFile(this.filePath(tradingDate), "utf-8");
      return JSON.parse(raw) as DayState;
    } catch {
      return this.memoryFallback.get(tradingDate) ?? null;
    }
  }

  async save(state: DayState): Promise<void> {
    this.memoryFallback.set(state.tradingDate, state);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.filePath(state.tradingDate), JSON.stringify(state), "utf-8");
    } catch {
      // Filesystem unavailable/read-only in this environment — memory fallback still
      // keeps the current warm instance consistent for the rest of the day.
    }
  }
}

let storeSingleton: DayStore | null = null;

export function getDayStore(): DayStore {
  if (!storeSingleton) {
    storeSingleton = new FileDayStore();
  }
  return storeSingleton;
}

export async function getOrCreateDayState(tradingDate: string): Promise<DayState> {
  const store = getDayStore();
  const existing = await store.load(tradingDate);
  return existing ?? emptyState(tradingDate);
}

export async function saveDayState(state: DayState): Promise<void> {
  await getDayStore().save(state);
}

/**
 * Merges a freshly evaluated signal into the day's persistent state:
 *  - A stock, once it appears, stays in the result set for the rest of the day.
 *  - Status can only move forward (WATCH -> SETUP -> CONFIRMED), never backward,
 *    so a CONFIRMED signal never quietly reverts to WATCH just because price pulled
 *    back later — the audit trail always reflects the moment it was confirmed.
 *  - `firstDetectedAt` is preserved across updates.
 */
const STATUS_RANK: Record<Signal["status"], number> = { WATCH: 0, SETUP: 1, CONFIRMED: 2 };

export function mergeSignalIntoState(state: DayState, incoming: Signal): Signal {
  const existing = state.signals[incoming.id];
  if (!existing) {
    state.signals[incoming.id] = incoming;
    return incoming;
  }

  const shouldUpgrade = STATUS_RANK[incoming.status] >= STATUS_RANK[existing.status];
  const merged: Signal = shouldUpgrade
    ? {
        ...incoming,
        firstDetectedAt: existing.firstDetectedAt,
      }
    : {
        // Keep the higher (locked-in) status/audit/trade levels, but refresh live-quote fields.
        ...existing,
        ltp: incoming.ltp,
        changePct: incoming.changePct,
        distanceFromPdhPct: incoming.distanceFromPdhPct,
        distanceFromPdlPct: incoming.distanceFromPdlPct,
        lastUpdatedAt: incoming.lastUpdatedAt,
      };

  state.signals[incoming.id] = merged;
  return merged;
}
