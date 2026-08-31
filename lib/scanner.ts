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
import { Candle, ScanErrorEntry, ScanMeta, ScanResult, Signal, SignalLogEntry } from "./types";

const CONCURRENCY = 8; // bounded parallelism so we don't hammer Upstox / hit rate limits

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
  now: Date
): Promise<SymbolScanOutcome> {
  try {
    const [dailyCandles, intraday] = await Promise.all([
      fetchDailyCandles(instrumentKey, prevTradingDate, prevTradingDate),
      fetchIntraday5MinCandles(instrumentKey, now),
    ]);

    const pdLevels = computePDLevels(dailyCandles, prevTradingDate);
    if (!pdLevels) {
      return { symbol, signal: null, error: { symbol, reason: "PDH/PDL unavailable (no valid previous-day candle)" } };
    }

    const completedToday: Candle[] = intraday.filter((c) => c.isComplete);
    if (completedToday.length === 0) {
      return { symbol, signal: null, error: null }; // nothing to evaluate yet, not an error
    }

    const lastCandle = completedToday[completedToday.length - 1];
    if (!lastCandle) return { symbol, signal: null, error: null };

    const outcome = evaluateSymbol({
      symbol,
      candles: completedToday,
      pdLevels,
      config: DEFAULT_SCANNER_CONFIG,
      priorConfirmedBreakout: priorBreakoutFromExisting(existing),
    });

    if (!outcome) return { symbol, signal: null, error: null };

    const prevClose = dailyCandles[dailyCandles.length - 1]?.close ?? lastCandle.close;
    const changePct = prevClose !== 0 ? ((lastCandle.close - prevClose) / prevClose) * 100 : 0;
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

    return { symbol, signal, error: null };
  } catch (err) {
    if (err instanceof UpstoxAuthError) {
      return { symbol, signal: null, error: { symbol, reason: "Upstox authentication failed (check UPSTOX_ACCESS_TOKEN)" } };
    }
    if (err instanceof UpstoxRateLimitError) {
      return { symbol, signal: null, error: { symbol, reason: "Rate limited by Upstox — will retry next scan cycle" } };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { symbol, signal: null, error: { symbol, reason: message } };
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
 * Runs one full scan cycle. Never throws for per-symbol failures — those are captured
 * in meta.errors. Only throws for universe-wide failures (e.g. instrument master
 * download totally fails AND we have no cached universe), which the API route turns
 * into a DATA ERROR response while preserving the last successful scan.
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
      message,
    });
  }

  const outcomes = await mapWithConcurrency(instruments, CONCURRENCY, (inst) =>
    scanOneSymbol(inst.symbol, inst.instrumentKey, tradingDate, prevTradingDate, state.signals[`${inst.symbol}:${tradingDate}`], now)
  );

  const errors: ScanErrorEntry[] = outcomes.filter((o) => o.error).map((o) => o.error as ScanErrorEntry);
  for (const sym of unresolved) {
    errors.push({ symbol: sym, reason: "Symbol not found in Upstox instrument master" });
  }

  let newlyMerged = 0;
  for (const outcome of outcomes) {
    if (!outcome.signal) continue;
    const before = state.signals[outcome.signal.id];
    const merged = mergeSignalIntoState(state, outcome.signal);
    if (!before || before.status !== merged.status) newlyMerged++;
    // Log every scan where status changed or a CONFIRMED/SETUP signal is freshly re-evaluated.
    if (!before || before.status !== merged.status) {
      state.log.push(buildLogEntry(merged));
    }
  }
  // Keep the log bounded.
  if (state.log.length > 500) {
    state.log = state.log.slice(-500);
  }

  const scannedCount = outcomes.length;
  const errorCount = errors.length;
  const dataStatus: ScanMeta["dataStatus"] = errorCount === 0 ? "OK" : errorCount < scannedCount ? "PARTIAL" : "ERROR";

  // Surface the actual failure reason rather than a generic line, so a systemic issue
  // (wrong endpoint, bad token, rate limit) is diagnosable straight from the dashboard
  // instead of requiring a log dive.
  const reasonCounts = new Map<string, number>();
  for (const e of errors) reasonCounts.set(e.reason, (reasonCounts.get(e.reason) ?? 0) + 1);
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

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
    message: usedFallbackUniverse
      ? "Using the last known-good F&O stock list (live download from Upstox failed this cycle); scan results below are still fresh."
      : dataStatus === "ERROR"
        ? `Upstox returned no usable 5-minute candles for this scan${
            topReason ? ` — most symbols failed with: "${topReason[0]}" (${topReason[1]}/${scannedCount})` : ""
          }. Showing last successful scan.`
        : dataStatus === "PARTIAL"
        ? `${errorCount} of ${scannedCount} symbols failed this cycle${
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
