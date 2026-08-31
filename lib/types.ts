/**
 * Core domain types for the Prime Technical Live Scanner.
 * Keep these independent of any UI or Upstox wire-format concerns.
 */

export type Timeframe = "5min" | "1day";

/** A single completed OHLCV candle. `isComplete` must be true before it is used for confirmation. */
export interface Candle {
  timestamp: string; // ISO 8601, Asia/Kolkata wall-clock represented in UTC internally
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isComplete: boolean;
}

export interface Instrument {
  symbol: string; // NSE trading symbol, e.g. "DABUR"
  instrumentKey: string; // Upstox instrument key, e.g. "NSE_EQ|INE066A01021"
  name: string;
}

/** Previous Day High / Low — computed strictly from the prior COMPLETED trading day. Never today's H/L. */
export interface PDLevels {
  pdh: number;
  pdl: number;
  /** Previous day's close, cached alongside PDH/PDL from the same daily candle so
   * change% can be computed without an extra Upstox request every scan cycle. */
  prevClose: number;
  sourceDate: string; // trading date (YYYY-MM-DD) the PDH/PDL were derived from
}

export type Direction = "BUY" | "SELL";
export type Level = "PDH" | "PDL";
export type SetupType =
  | "PDH_BUY"
  | "PDL_SELL"
  | "BUY_CONTINUATION"
  | "SELL_CONTINUATION";
export type SignalStatus = "WATCH" | "SETUP" | "CONFIRMED";

export type VolumeTier = "NORMAL" | "STRONG" | "HIGH" | "VERY_HIGH" | "EXTREME";

export interface VolumeReading {
  currentVolume: number;
  referenceVolume: number;
  multiple: number; // currentVolume / referenceVolume
  tier: VolumeTier;
}

export interface EMAReading {
  value: number;
  isRising: boolean;
  isFalling: boolean;
}

/** Audit trail proving exactly why a stock reached its current status. Required for CONFIRMED. */
export interface SignalAudit {
  pdh: number;
  pdl: number;
  pdSourceDate: string;
  triggerCandleTime: string | null;
  triggerCandle: Candle | null;
  volume: VolumeReading | null;
  ema20: EMAReading | null;
  price: number;
  followThroughCandleTime: string | null;
  followThroughHeld: boolean;
  confirmationTime: string | null;
}

export interface TradeLevels {
  entry: number | null;
  stopLoss: number | null;
  target: number | null;
  riskRewardRatio: number;
}

export interface Signal {
  id: string; // `${symbol}:${tradingDate}` — one active signal record per symbol per day
  symbol: string;
  tradingDate: string; // YYYY-MM-DD (Asia/Kolkata)
  ltp: number;
  changePct: number;
  pdh: number;
  pdl: number;
  distanceFromPdhPct: number;
  distanceFromPdlPct: number;
  level: Level;
  direction: Direction;
  setupType: SetupType;
  status: SignalStatus;
  volumeMultiple: number;
  volumeTier: VolumeTier;
  ema20: number;
  ema20Trend: "RISING" | "FALLING" | "FLAT";
  trade: TradeLevels;
  reason: string;
  audit: SignalAudit;
  firstDetectedAt: string; // ISO timestamp, first time this symbol appeared today — used to keep it "permanent" for the day
  lastUpdatedAt: string;
  /** Monotonic rank used for sorting: higher priority setups get a lower rank number. */
  priorityRank: number;
}

export interface ScanErrorEntry {
  symbol: string;
  reason: string;
}

export interface ScanMeta {
  scanTime: string; // ISO timestamp of this scan attempt
  lastSuccessfulScanTime: string | null;
  marketOpen: boolean;
  marketStatus: "PRE_OPEN" | "OPEN" | "CLOSED" | "HOLIDAY_OR_WEEKEND";
  universeCount: number;
  scannedCount: number;
  errorCount: number;
  dataStatus: "OK" | "PARTIAL" | "ERROR";
  errors: ScanErrorEntry[];
  usedStaleData: boolean;
  message: string | null;
  /** Human-readable rotation progress, e.g. "Batch 3/11 (symbols 41–60 of 210)" — the
   * scanner refreshes symbols in rotating batches to respect Upstox's rate limits, so
   * not every symbol updates on every cycle. Null when not applicable (market closed etc). */
  batchLabel: string | null;
}

export interface ScanResult {
  meta: ScanMeta;
  counts: {
    confirmed: number;
    setup: number;
    watch: number;
    universe: number;
  };
  signals: Signal[];
  log: SignalLogEntry[];
}

export interface SignalLogEntry {
  time: string; // HH:mm (Asia/Kolkata)
  timestamp: string; // ISO
  symbol: string;
  direction: Direction;
  level: Level;
  setupType: SetupType;
  status: SignalStatus;
  price: number;
  volumeMultiple: number;
  reason: string;
}

export interface ScannerConfig {
  volumeReferenceLookback: number; // number of prior completed 5-min candles averaged for reference volume
  volumeTierThresholds: {
    strong: number;
    high: number;
    veryHigh: number;
    extreme: number;
  };
  emaPeriod: number;
  riskRewardRatio: number;
  followThroughCandles: number; // how many subsequent completed candles must hold the level
  pdhProximityPct: number; // % distance from PDH/PDL to qualify for WATCH
}
