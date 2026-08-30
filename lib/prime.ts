import { latestEMAReading } from "./indicators";
import { distanceFromLevelPct } from "./levels";
import { computeVolumeReading } from "./volume";
import {
  Candle,
  Direction,
  EMAReading,
  Level,
  PDLevels,
  ScannerConfig,
  SetupType,
  SignalAudit,
  SignalStatus,
  TradeLevels,
  VolumeReading,
} from "./types";

export interface PriorConfirmedBreakout {
  setupType: SetupType;
  triggerCandleTime: string;
  triggerIndex: number;
}

export interface EvaluationInput {
  symbol: string;
  candles: Candle[]; // COMPLETED 5-min candles for today only, ascending by time, from session open
  pdLevels: PDLevels;
  config: ScannerConfig;
  priorConfirmedBreakout?: PriorConfirmedBreakout | null;
}

export interface EvaluationOutcome {
  status: SignalStatus;
  direction: Direction;
  level: Level;
  setupType: SetupType;
  reason: string;
  price: number;
  distanceFromPdhPct: number;
  distanceFromPdlPct: number;
  volume: VolumeReading | null;
  ema: EMAReading | null;
  trade: TradeLevels;
  audit: SignalAudit;
  /** Present only when this evaluation represents a freshly confirmed breakout, for continuation tracking. */
  newlyConfirmedBreakout: PriorConfirmedBreakout | null;
}

const NO_TRADE: TradeLevels = { entry: null, stopLoss: null, target: null, riskRewardRatio: 0 };

function emptyAudit(pd: PDLevels, price: number): SignalAudit {
  return {
    pdh: pd.pdh,
    pdl: pd.pdl,
    pdSourceDate: pd.sourceDate,
    triggerCandleTime: null,
    triggerCandle: null,
    volume: null,
    ema20: null,
    price,
    followThroughCandleTime: null,
    followThroughHeld: false,
    confirmationTime: null,
  };
}

function computeTradeLevels(
  direction: Direction,
  triggerCandle: Candle,
  level: number,
  rr: number
): TradeLevels {
  if (direction === "BUY") {
    const entry = triggerCandle.close;
    // SL below the breakout/retest structure: use the trigger candle's low, or the level itself
    // if the candle's low is (unusually) above the level.
    const stopLoss = Math.min(triggerCandle.low, level);
    const risk = entry - stopLoss;
    if (risk <= 0) return NO_TRADE;
    const target = entry + risk * rr;
    return { entry, stopLoss, target, riskRewardRatio: rr };
  } else {
    const entry = triggerCandle.close;
    const stopLoss = Math.max(triggerCandle.high, level);
    const risk = stopLoss - entry;
    if (risk <= 0) return NO_TRADE;
    const target = entry - risk * rr;
    return { entry, stopLoss, target, riskRewardRatio: rr };
  }
}

/**
 * Evaluates one side (BUY-around-PDH or SELL-around-PDL) for a symbol using only
 * completed candles. Returns null if there's nothing worth showing on this side.
 */
function evaluateSide(
  direction: Direction,
  input: EvaluationInput
): EvaluationOutcome | null {
  const { candles, pdLevels, config } = input;
  if (candles.length === 0) return null;

  const levelValue = direction === "BUY" ? pdLevels.pdh : pdLevels.pdl;
  const levelName: Level = direction === "BUY" ? "PDH" : "PDL";
  const setupTypePrimary: SetupType = direction === "BUY" ? "PDH_BUY" : "PDL_SELL";
  const continuationType: SetupType = direction === "BUY" ? "BUY_CONTINUATION" : "SELL_CONTINUATION";

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const price = lastCandle.close;
  const distPdh = distanceFromLevelPct(price, pdLevels.pdh);
  const distPdl = distanceFromLevelPct(price, pdLevels.pdl);

  // Find the FIRST completed candle where a genuine breakout/breakdown crossing occurs:
  // previous completed candle closed on the "wrong" side, this one closes beyond the level.
  let triggerIndex = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const prev = i > 0 ? candles[i - 1] : null;
    const brokeNow = direction === "BUY" ? c.close > levelValue : c.close < levelValue;
    const wasOnWrongSideBefore = prev
      ? direction === "BUY"
        ? prev.close <= levelValue
        : prev.close >= levelValue
      : true; // no prior candle today: still a valid first-break if it closes beyond the level
    if (brokeNow && wasOnWrongSideBefore) {
      triggerIndex = i;
      break;
    }
  }

  const emaNow = latestEMAReading(candles, config.emaPeriod);

  // ---- No breakout yet this session: only a WATCH or nothing ----
  if (triggerIndex === -1) {
    const proximityOk =
      direction === "BUY"
        ? distPdh <= 0 && distPdh >= -config.pdhProximityPct
        : distPdl >= 0 && distPdl <= config.pdhProximityPct;
    if (!proximityOk) return null;

    const emaAligned =
      !!emaNow && (direction === "BUY" ? price > emaNow.value && emaNow.isRising : price < emaNow.value && emaNow.isFalling);

    const reason =
      direction === "BUY"
        ? emaAligned
          ? "Near PDH; price above rising 20 EMA; waiting for PDH breakout confirmation"
          : "Near PDH; waiting for PDH breakout and 20 EMA alignment"
        : emaAligned
        ? "Near PDL; price below falling 20 EMA; waiting for PDL breakdown confirmation"
        : "Near PDL; waiting for PDL breakdown and 20 EMA alignment";

    return {
      status: "WATCH",
      direction,
      level: levelName,
      setupType: setupTypePrimary,
      reason,
      price,
      distanceFromPdhPct: distPdh,
      distanceFromPdlPct: distPdl,
      volume: null,
      ema: emaNow,
      trade: NO_TRADE,
      audit: { ...emptyAudit(pdLevels, price), ema20: emaNow },
      newlyConfirmedBreakout: null,
    };
  }

  // ---- Breakout candle found: validate close-beyond-level, volume, EMA, then follow-through ----
  const triggerCandle = candles[triggerIndex];
  if (!triggerCandle) return null;
  const priorCandles = candles.slice(0, triggerIndex);
  const volume = computeVolumeReading(triggerCandle, priorCandles, config);
  const emaAtTrigger = latestEMAReading(candles.slice(0, triggerIndex + 1), config.emaPeriod);

  const closedBeyondLevel = direction === "BUY" ? triggerCandle.close > levelValue : triggerCandle.close < levelValue;
  const wickAlsoBeyond = direction === "BUY" ? triggerCandle.high > levelValue : triggerCandle.low < levelValue;

  const volumeOk = !!volume && volume.tier !== "NORMAL"; // must be at least STRONG (>=1.5x)
  const emaOk =
    !!emaAtTrigger && (direction === "BUY" ? emaAtTrigger.isRising : emaAtTrigger.isFalling) &&
    (direction === "BUY" ? triggerCandle.close > emaAtTrigger.value : triggerCandle.close < emaAtTrigger.value);

  // Follow-through window: the N completed candles strictly after the trigger candle.
  const followThroughWindow = candles.slice(triggerIndex + 1, triggerIndex + 1 + config.followThroughCandles);
  let followThroughFailed = false;
  for (const fc of followThroughWindow) {
    const held = direction === "BUY" ? fc.close > levelValue : fc.close < levelValue;
    if (!held) {
      followThroughFailed = true;
      break;
    }
  }
  const followThroughComplete = followThroughWindow.length >= config.followThroughCandles;
  const followThroughHeld = followThroughComplete && !followThroughFailed;

  const audit: SignalAudit = {
    pdh: pdLevels.pdh,
    pdl: pdLevels.pdl,
    pdSourceDate: pdLevels.sourceDate,
    triggerCandleTime: triggerCandle.timestamp,
    triggerCandle,
    volume,
    ema20: emaAtTrigger,
    price,
    followThroughCandleTime: followThroughWindow.length > 0 ? followThroughWindow[followThroughWindow.length - 1]!.timestamp : null,
    followThroughHeld,
    confirmationTime: null,
  };

  const volLabel = volume ? `${volume.multiple.toFixed(1)}X ${volume.tier.replace("_", " ")} VOLUME` : "volume unavailable";

  // Failed breakout: closed back through the level during the follow-through window.
  // Per spec, this must NEVER be confirmed. Fall back to a WATCH-style read on current conditions
  // rather than silently disappearing, so the audit trail shows why it isn't confirmed.
  if (followThroughFailed) {
    const emaAligned =
      !!emaNow && (direction === "BUY" ? price > emaNow.value && emaNow.isRising : price < emaNow.value && emaNow.isFalling);
    return {
      status: "SETUP",
      direction,
      level: levelName,
      setupType: setupTypePrimary,
      reason:
        direction === "BUY"
          ? `PDH breakout attempted but price closed back below PDH — follow-through failed, not confirmed${emaAligned ? "; still above rising 20 EMA" : ""}`
          : `PDL breakdown attempted but price closed back above PDL — follow-through failed, not confirmed${emaAligned ? "; still below falling 20 EMA" : ""}`,
      price,
      distanceFromPdhPct: distPdh,
      distanceFromPdlPct: distPdl,
      volume,
      ema: emaNow,
      trade: NO_TRADE,
      audit,
      newlyConfirmedBreakout: null,
    };
  }

  if (!closedBeyondLevel) return null; // defensive; shouldn't happen given trigger search above

  if (!volumeOk || !emaOk) {
    const missing: string[] = [];
    if (!volumeOk) missing.push("insufficient 5-min volume (<1.5x)");
    if (!emaOk) missing.push(direction === "BUY" ? "20 EMA not rising/price not above it" : "20 EMA not falling/price not below it");
    return {
      status: "SETUP",
      direction,
      level: levelName,
      setupType: setupTypePrimary,
      reason:
        direction === "BUY"
          ? `PDH breakout candle detected (${volLabel}) but ${missing.join(" and ")}; waiting for full confirmation`
          : `PDL breakdown candle detected (${volLabel}) but ${missing.join(" and ")}; waiting for full confirmation`,
      price,
      distanceFromPdhPct: distPdh,
      distanceFromPdlPct: distPdl,
      volume,
      ema: emaAtTrigger,
      trade: NO_TRADE,
      audit,
      newlyConfirmedBreakout: null,
    };
  }

  if (!followThroughComplete) {
    return {
      status: "SETUP",
      direction,
      level: levelName,
      setupType: setupTypePrimary,
      reason:
        direction === "BUY"
          ? `PDH breakout candle confirmed with ${volLabel} and price above rising 20 EMA; waiting for follow-through`
          : `PDL breakdown candle confirmed with ${volLabel} and price below falling 20 EMA; waiting for follow-through`,
      price,
      distanceFromPdhPct: distPdh,
      distanceFromPdlPct: distPdl,
      volume,
      ema: emaAtTrigger,
      trade: NO_TRADE,
      audit,
      newlyConfirmedBreakout: null,
    };
  }

  // ---- All conditions satisfied: CONFIRMED ----
  const confirmationCandle = followThroughWindow[followThroughWindow.length - 1] ?? triggerCandle;
  audit.confirmationTime = confirmationCandle.timestamp;
  const trade = computeTradeLevels(direction, triggerCandle, levelValue, config.riskRewardRatio);

  const wickNote = wickAlsoBeyond ? "" : " (close-only breakout; wick did not clear the level)";
  const reason =
    direction === "BUY"
      ? `PDH breakout + bullish follow-through + ${volLabel} + price above rising 20 EMA${wickNote}`
      : `PDL breakdown + bearish follow-through + ${volLabel} + price below falling 20 EMA${wickNote}`;

  return {
    status: "CONFIRMED",
    direction,
    level: levelName,
    setupType: setupTypePrimary,
    reason,
    price,
    distanceFromPdhPct: distPdh,
    distanceFromPdlPct: distPdl,
    volume,
    ema: emaAtTrigger,
    trade,
    audit,
    newlyConfirmedBreakout: { setupType: setupTypePrimary, triggerCandleTime: triggerCandle.timestamp, triggerIndex },
  };
}

/**
 * Detects a continuation setup after an earlier CONFIRMED breakout/breakdown the same day:
 * a pullback/retest that holds the breakout area, followed by a fresh continuation candle
 * with adequate volume and EMA alignment.
 */
function evaluateContinuation(direction: Direction, input: EvaluationInput): EvaluationOutcome | null {
  const prior = input.priorConfirmedBreakout;
  if (!prior) return null;
  const { candles, pdLevels, config } = input;
  const levelValue = direction === "BUY" ? pdLevels.pdh : pdLevels.pdl;
  const levelName: Level = direction === "BUY" ? "PDH" : "PDL";
  const setupType: SetupType = direction === "BUY" ? "BUY_CONTINUATION" : "SELL_CONTINUATION";

  const afterBreakout = candles.slice(prior.triggerIndex + 1);
  if (afterBreakout.length < 3) return null; // need room for pullback + continuation candle

  // Pullback: at least one candle retesting back toward (but not decisively through) the level.
  let pullbackIdx = -1;
  for (let i = 0; i < afterBreakout.length - 1; i++) {
    const c = afterBreakout[i];
    if (!c) continue;
    const retested = direction === "BUY" ? c.low <= levelValue * 1.002 && c.close >= levelValue : c.high >= levelValue * 0.998 && c.close <= levelValue;
    if (retested) {
      pullbackIdx = i;
      break;
    }
  }
  if (pullbackIdx === -1) return null;

  const continuationCandle = afterBreakout[pullbackIdx + 1];
  if (!continuationCandle) return null;
  const continuationHolds = direction === "BUY" ? continuationCandle.close > levelValue : continuationCandle.close < levelValue;
  if (!continuationHolds) return null;

  const precedingForVolume = candles.slice(0, candles.indexOf(continuationCandle));
  const volume = computeVolumeReading(continuationCandle, precedingForVolume, config);
  const ema = latestEMAReading(candles.slice(0, candles.indexOf(continuationCandle) + 1), config.emaPeriod);
  const volumeOk = !!volume && volume.tier !== "NORMAL";
  const emaOk = !!ema && (direction === "BUY" ? ema.isRising && continuationCandle.close > ema.value : ema.isFalling && continuationCandle.close < ema.value);

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle ? lastCandle.close : continuationCandle.close;
  const distPdh = distanceFromLevelPct(price, pdLevels.pdh);
  const distPdl = distanceFromLevelPct(price, pdLevels.pdl);

  const audit: SignalAudit = {
    pdh: pdLevels.pdh,
    pdl: pdLevels.pdl,
    pdSourceDate: pdLevels.sourceDate,
    triggerCandleTime: continuationCandle.timestamp,
    triggerCandle: continuationCandle,
    volume,
    ema20: ema,
    price,
    followThroughCandleTime: continuationCandle.timestamp,
    followThroughHeld: continuationHolds,
    confirmationTime: volumeOk && emaOk ? continuationCandle.timestamp : null,
  };

  if (!volumeOk || !emaOk) {
    return {
      status: "SETUP",
      direction,
      level: levelName,
      setupType,
      reason: `Pullback/retest of ${levelName} held; continuation candle forming but volume/20 EMA confirmation incomplete`,
      price,
      distanceFromPdhPct: distPdh,
      distanceFromPdlPct: distPdl,
      volume,
      ema,
      trade: NO_TRADE,
      audit,
      newlyConfirmedBreakout: null,
    };
  }

  const trade = computeTradeLevels(direction, continuationCandle, levelValue, config.riskRewardRatio);
  const volLabel = volume ? `${volume.multiple.toFixed(1)}X ${volume.tier.replace("_", " ")} VOLUME` : "";
  return {
    status: "CONFIRMED",
    direction,
    level: levelName,
    setupType,
    reason:
      direction === "BUY"
        ? `Pullback/retest held above ${levelName} + bullish continuation candle + ${volLabel} + price above rising 20 EMA`
        : `Pullback/retest held below ${levelName} + bearish continuation candle + ${volLabel} + price below falling 20 EMA`,
    price,
    distanceFromPdhPct: distPdh,
    distanceFromPdlPct: distPdl,
    volume,
    ema,
    trade,
    audit,
    newlyConfirmedBreakout: { setupType, triggerCandleTime: continuationCandle.timestamp, triggerIndex: candles.indexOf(continuationCandle) },
  };
}

/**
 * Evaluates a symbol end-to-end for the day so far. Priority order (per spec):
 * 1. CONFIRMED PDH BUY  2. CONFIRMED PDL SELL  3. CONFIRMED BUY CONTINUATION
 * 4. CONFIRMED SELL CONTINUATION  5. PDH/PDL SETUP  6. WATCH
 */
export function evaluateSymbol(input: EvaluationInput): EvaluationOutcome | null {
  const buyPrimary = evaluateSide("BUY", input);
  const sellPrimary = evaluateSide("SELL", input);
  const buyContinuation = evaluateContinuation("BUY", input);
  const sellContinuation = evaluateContinuation("SELL", input);

  const candidates = [buyPrimary, sellPrimary, buyContinuation, sellContinuation].filter(
    (c): c is EvaluationOutcome => c !== null
  );
  if (candidates.length === 0) return null;

  const rank = (c: EvaluationOutcome): number => {
    if (c.status === "CONFIRMED" && c.setupType === "PDH_BUY") return 1;
    if (c.status === "CONFIRMED" && c.setupType === "PDL_SELL") return 2;
    if (c.status === "CONFIRMED" && c.setupType === "BUY_CONTINUATION") return 3;
    if (c.status === "CONFIRMED" && c.setupType === "SELL_CONTINUATION") return 4;
    if (c.status === "SETUP") return 5;
    return 6; // WATCH
  };

  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? null;
}

export function priorityRankFor(status: SignalStatus, setupType: SetupType): number {
  if (status === "CONFIRMED" && setupType === "PDH_BUY") return 1;
  if (status === "CONFIRMED" && setupType === "PDL_SELL") return 2;
  if (status === "CONFIRMED" && setupType === "BUY_CONTINUATION") return 3;
  if (status === "CONFIRMED" && setupType === "SELL_CONTINUATION") return 4;
  if (status === "SETUP") return 5;
  return 6;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  volumeReferenceLookback: 10,
  volumeTierThresholds: { strong: 1.5, high: 2.0, veryHigh: 4.0, extreme: 6.0 },
  emaPeriod: 20,
  riskRewardRatio: 2,
  followThroughCandles: 1,
  pdhProximityPct: 0.5,
};
