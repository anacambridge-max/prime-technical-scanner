import "server-only";
import { resolveFnoUniverse } from "./universe";
import {
  fetchDailyCandles,
  fetchIntraday5MinCandles,
  UpstoxAuthError,
  UpstoxRateLimitError,
} from "./upstox";
import { computePDLevels } from "./levels";
import { evaluateSymbol, DEFAULT_SCANNER_CONFIG, priorityRankFor, PriorConfirmedBreakout } from "./prime";
import { getOrCreateDayState, mergeSignalIntoState, saveDayState, DayState } from "./store";
import {
  getMarketStatus,
  istTradingDate,
  istTimeHHmm,
  previousTradingDateGuess,
  firstCandleHasClosed,
} from "./time";
import { Candle, PDLevels, ScanErrorEntry, ScanMeta, ScanResult, Signal, SignalLogEntry } from "./types";

// Upstox allows 25 req/sec, 250/min, 1000/30min PER USER (see lib/rate-limiter.ts).
// Scanning the whole ~210-stock F&O universe every poll would need ~210-420 requests
// per cycle — far over budget. Instead we rotate through the universe in small batches:
// each scan cycle only pulls live data for BATCH_SIZE symbols, cycling through the full
// universe over several polls. Combined with caching PDH/PDL once per symbol per day
// (it can't change intraday), this keeps steady-state usage to roughly BATCH_SIZE
// requests per poll — comfortably inside Upstox's limits even with headroom for retries.
const BATCH_SIZE = 20;
const CONCURRENCY = 8; // bounded parallelism within a batch; lib/rate-limiter.ts is the hard backstop

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) continue;
      results[idx] = await fn(item);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(() => worker()));
  return results;
}

interface SymbolScanOutcome {
  symbol: string;
  signal: Signal | null;
  error: ScanErrorEntry | null;
  freshPdLevels: PDLevels | null; // populated only when we had to fetch PDH/PDL this cycle
}

function priorBreakoutFromExisting(existing: Signal | undefined): PriorConfirmedBreakout | null {
  if (!existing || existing.status !== "CONFIRMED") return null;
  if (existing.setupType !== "PDH_BUY" && existing.setupType !== "PDL_SELL") return null;
  if (!existing.audit.triggerCandleTime) return null;
  return {
    setupType: existing.setupType,
    triggerCandleTime: existing.audit.triggerCandleTime,
    triggerIndex: -1, // recomputed positionally isn't needed for continuation re-checks across scans
  };
}

async function scanOneSymbol(
  symbol: string,
  instrumentKey: string,
  tradingDate: string,
  prevTradingDate: string,
  existing: Signal | undefined,
  cachedPdLevels: PDLevels | undefined,
  now: Date
): Promise<SymbolScanOutcome> {
  try {
    let pdLevels: PDLevels | null = cachedPdLevels ?? null;
    let freshPdLevels: PDLevels | null = null;

    // PDH/PDL never changes intraday — only spend a request on it if we don't already
    // have today's value cached from an earlier batch this same trading day.
    if (!pdLevels) {
      const dailyCandles = await fetchDailyCandles(instrumentKey, prevTradingDate, prevTradingDate);
      pdLevels = computePDLevels(dailyCandles, prevTradingDate);
      if (pdLevels) freshPdLevels = pdLevels;
    }

    if (!pdLevels) {
      return {
        symbol,
        signal: null,
        error: { symbol, reason: "PDH/PDL unavailable (no valid previous-day candle)" },
        freshPdLevels: null,
      };
    }

    const intraday = await fetchIntraday5MinCandles(instrumentKey, now);
    const completedToday: Candle[] = intraday.filter((c) => c.isComplete);
    if (completedToday.length === 0) {
      return { symbol, signal: null, error: null, freshPdLevels }; // nothing to evaluate yet, not an error
    }

    const lastCandle = completedToday[completedToday.length - 1];
    if (!lastCandle) return { symbol, signal: null, error: null, freshPdLevels };

    const outcome = evaluateSymbol({
      symbol,
      candles: completedToday,
      pdLevels,
      config: DEFAULT_SCANNER_CONFIG,
      priorConfirmedBreakout: priorBreakoutFromExisting(existing),
    });

    if (!outcome) return { symbol, signal: null, error: null, freshPdLevels };

    // Change% vs yesterday's actual close (cached alongside PDH/PDL — no extra request).
    const changePct = pdLevels.prevClose !== 0 ? ((lastCandle.close - pdLevels.prevClose) / pdLevels.prevClose) * 100 : 0;
    const nowIso = now.toISOString();

    const signal: Signal = {
      id: `${symbol}:${tradingDate}`,
      symbol,
      tradingDate,
      ltp: lastCandle.close,
      changePct,
      pdh: pdLevels.pdh,
      pdl: pdLevels.pdl,
      distanceFromPdhPct: outcome.distanceFromPdhPct,
      distanceFromPdlPct: outcome.distanceFromPdlPct,
      level: outcome.level,
      direction: outcome.direction,
      setupType: outcome.setupType,
      status: outcome.status,
      volumeMultiple: outcome.volume?.multiple ?? 0,
      volumeTier: outcome.volume?.tier ?? "NORMAL",
      ema20: outcome.ema?.value ?? 0,
      ema20Trend: outcome.ema ? (outcome.ema.isRising ? "RISING" : outcome.ema.isFalling ? "FALLING" : "FLAT") : "FLAT",
      trade: outcome.trade,
      reason: outcome.reason,
      audit: outcome.audit,
      firstDetectedAt: existing?.firstDetectedAt ?? nowIso,
      lastUpdatedAt: nowIso,
      priorityRank: priorityRankFor(outcome.status, outcome.setupType),
    };

    return { symbol, signal, error: null, freshPdLevels };
  } catch (err) {
    if (err instanceof UpstoxAuthError) {
      return {
        symbol,
        signal: null,
        error: { symbol, reason: "Upstox authentication failed (check UPSTOX_ACCESS_TOKEN)" },
        freshPdLevels: null,
      };
    }
    if (err instanceof UpstoxRateLimitError) {
      return {
        symbol,
        signal: null,
        error: { symbol, reason: "Rate limited by Upstox — will retry next scan cycle" },
        freshPdLevels: null,
      };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { symbol, signal: null, error: { symbol, reason: message }, freshPdLevels: null };
  }
}

function buildLogEntry(signal: Signal): SignalLogEntry {
  return {
    time: istTimeHHmm(new Date(signal.lastUpdatedAt)),
    timestamp: signal.lastUpdatedAt,
    symbol: signal.symbol,
    direction: signal.direction,
    level: signal.level,
    setupType: signal.setupType,
    status: signal.status,
    price: signal.ltp,
    volumeMultiple: signal.volumeMultiple,
    reason: signal.reason,
  };
}

function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    const aDist = a.direction === "BUY" ? Math.abs(a.distanceFromPdhPct) : Math.abs(a.distanceFromPdlPct);
    const bDist = b.direction === "BUY" ? Math.abs(b.distanceFromPdhPct) : Math.abs(b.distanceFromPdlPct);
    if (aDist !== bDist) return aDist - bDist;
    return b.volumeMultiple - a.volumeMultiple;
  });
}

/**
 * Runs one scan cycle: only the current rotating batch of symbols gets fresh live data
 * (see BATCH_SIZE above); every other symbol keeps its most recent result untouched, so
 * nothing disappears between its turns. Never throws for per-symbol failures — those
 * are captured in meta.errors. Only throws for universe-wide failures (e.g. instrument
 * master download totally fails AND we have no cached universe), which the API route
 * turns into a DATA ERROR response while preserving the last successful scan.
 */
export async function runScan(now: Date = new Date()): Promise<ScanResult> {
  const tradingDate = istTradingDate(now);
  const prevTradingDate = previousTradingDateGuess(now);
  const marketStatus = getMarketStatus(now);

  const state: DayState = await getOrCreateDayState(tradingDate);
  const scanTimeIso = now.toISOString();

  if (marketStatus === "HOLIDAY_OR_WEEKEND" || marketStatus === "PRE_OPEN") {
    return buildResultFromState(state, {
      scanTime: scanTimeIso,
      lastSuccessfulScanTime: state.lastMeta?.lastSuccessfulScanTime ?? null,
      marketOpen: false,
      marketStatus,
      universeCount: state.lastMeta?.universeCount ?? 0,
      scannedCount: 0,
      errorCount: 0,
      dataStatus: "OK",
      errors: [],
      usedStaleData: false,
      batchLabel: null,
      message:
        marketStatus === "HOLIDAY_OR_WEEKEND"
          ? "Market is closed (weekend/holiday). Showing last available scan, if any."
          : "Pre-market. Scanning begins at 09:15 IST once the first 5-minute candle closes at 09:20 IST.",
    });
  }

  if (marketStatus === "OPEN" && !firstCandleHasClosed(now)) {
    return buildResultFromState(state, {
      scanTime: scanTimeIso,
      lastSuccessfulScanTime: state.lastMeta?.lastSuccessfulScanTime ?? null,
      marketOpen: true,
      marketStatus,
      universeCount: state.lastMeta?.universeCount ?? 0,
      scannedCount: 0,
      errorCount: 0,
      dataStatus: "OK",
      errors: [],
      usedStaleData: false,
      batchLabel: null,
      message: "Market open. Waiting for the first 5-minute candle (09:15–09:20 IST) to complete before confirming any setup.",
    });
  }

  let instruments;
  let unresolved: string[] = [];
  let usedFallbackUniverse = false;
  try {
    const universe = await resolveFnoUniverse();
    instruments = universe.instruments;
    unresolved = universe.unresolved;
    usedFallbackUniverse = universe.usedFallback;
  } catch (err) {
    // Total universe failure with no disk fallback available either: keep showing the
    // last successful scan rather than zeroing out, and surface the real reason so
    // it's actionable (e.g. "HTTP 403" means the CDN is blocking this server's requests).
    const detail = err instanceof Error ? err.message : "unknown error";
    const message = `Upstox instrument master could not be downloaded (${detail}). Showing last successful scan.`;
    return buildResultFromState(state, {
      scanTime: scanTimeIso,
      lastSuccessfulScanTime: state.lastMeta?.lastSuccessfulScanTime ?? null,
      marketOpen: marketStatus === "OPEN",
      marketStatus,
      universeCount: state.lastMeta?.universeCount ?? 0,
      scannedCount: 0,
      errorCount: 1,
      dataStatus: "ERROR",
      errors: [{ symbol: "UNIVERSE", reason: detail }],
      usedStaleData: true,
      batchLabel: null,
      message,
    });
  }

  if (instruments.length === 0) {
    return buildResultFromState(state, {
      scanTime: scanTimeIso,
      lastSuccessfulScanTime: state.lastMeta?.lastSuccessfulScanTime ?? null,
      marketOpen: marketStatus === "OPEN",
      marketStatus,
      universeCount: 0,
      scannedCount: 0,
      errorCount: 0,
      dataStatus: "OK",
      errors: [],
      usedStaleData: false,
      batchLabel: null,
      message: "F&O universe resolved to zero stocks this cycle. Showing last successful scan.",
    });
  }

  // Rotate through the universe in fixed-size batches so each scan cycle only spends a
  // small, budget-safe number of Upstox requests. The cursor persists across cycles.
  const cursor = state.scanCursor % instruments.length;
  const batch: typeof instruments = [];
  for (let i = 0; i < Math.min(BATCH_SIZE, instruments.length); i++) {
    const inst = instruments[(cursor + i) % instruments.length];
    if (inst) batch.push(inst);
  }

  const outcomes = await mapWithConcurrency(batch, CONCURRENCY, (inst) =>
    scanOneSymbol(
      inst.symbol,
      inst.instrumentKey,
      tradingDate,
      prevTradingDate,
      state.signals[`${inst.symbol}:${tradingDate}`],
      state.pdLevelsCache[inst.symbol],
      now
    )
  );

  const errors: ScanErrorEntry[] = outcomes.filter((o) => o.error).map((o) => o.error as ScanErrorEntry);
  // Unresolved symbols are only worth reporting once, not on every batch that happens
  // to overlap with them — but since they're not part of `instruments` at all, they
  // never enter the rotation; report them every cycle is harmless and keeps them visible.
  for (const sym of unresolved) {
    errors.push({ symbol: sym, reason: "Symbol not found in Upstox instrument master" });
  }

  for (const outcome of outcomes) {
    if (outcome.freshPdLevels) {
      state.pdLevelsCache[outcome.symbol] = outcome.freshPdLevels;
    }
    if (!outcome.signal) continue;
    const before = state.signals[outcome.signal.id];
    const merged = mergeSignalIntoState(state, outcome.signal);
    if (!before || before.status !== merged.status) {
      state.log.push(buildLogEntry(merged));
    }
  }
  // Keep the log bounded.
  if (state.log.length > 500) {
    state.log = state.log.slice(-500);
  }

  state.scanCursor = (cursor + batch.length) % instruments.length;

  const scannedCount = outcomes.length;
  const errorCount = errors.length;
  const dataStatus: ScanMeta["dataStatus"] = errorCount === 0 ? "OK" : errorCount < scannedCount ? "PARTIAL" : "ERROR";

  // Surface the actual failure reason rather than a generic line, so a systemic issue
  // (wrong endpoint, bad token, rate limit) is diagnosable straight from the dashboard
  // instead of requiring a log dive.
  const reasonCounts = new Map<string, number>();
  for (const e of errors) reasonCounts.set(e.reason, (reasonCounts.get(e.reason) ?? 0) + 1);
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const totalBatches = Math.ceil(instruments.length / BATCH_SIZE);
  const currentBatchNumber = Math.floor(cursor / BATCH_SIZE) + 1;
  const batchLabel = `Batch ${currentBatchNumber}/${totalBatches} (symbols ${cursor + 1}\u2013${cursor + batch.length} of ${instruments.length}) — rotating to respect Upstox's rate limits`;

  const meta: ScanMeta = {
    scanTime: scanTimeIso,
    lastSuccessfulScanTime: scanTimeIso,
    marketOpen: marketStatus === "OPEN",
    marketStatus,
    universeCount: instruments.length,
    scannedCount,
    errorCount,
    dataStatus,
    errors: errors.slice(0, 50),
    usedStaleData: false,
    batchLabel,
    message: usedFallbackUniverse
      ? "Using the last known-good F&O stock list (live download from Upstox failed this cycle); scan results below are still fresh."
      : dataStatus === "ERROR"
        ? `Upstox returned no usable 5-minute candles for this batch${
            topReason ? ` — most symbols failed with: "${topReason[0]}" (${topReason[1]}/${scannedCount})` : ""
          }. Other symbols still show their last successful result.`
        : dataStatus === "PARTIAL"
        ? `${errorCount} of ${scannedCount} symbols in this batch failed${
            topReason ? ` — most common reason: "${topReason[0]}" (${topReason[1]})` : ""
          }; showing results for the rest.`
        : null,
  };

  state.lastMeta = meta;
  await saveDayState(state);

  return buildResultFromState(state, meta);
}

function buildResultFromState(state: DayState, meta: ScanMeta): ScanResult {
  const allSignals = Object.values(state.signals);
  const sorted = sortSignals(allSignals);
  const confirmed = sorted.filter((s) => s.status === "CONFIRMED").length;
  const setup = sorted.filter((s) => s.status === "SETUP").length;
  const watch = sorted.filter((s) => s.status === "WATCH").length;

  return {
    meta,
    counts: { confirmed, setup, watch, universe: meta.universeCount },
    signals: sorted,
    log: [...state.log].reverse().slice(0, 100),
  };
}

