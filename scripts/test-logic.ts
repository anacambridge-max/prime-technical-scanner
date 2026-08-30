/**
 * Pure-logic test suite. Run with: npm run test:logic
 * Exercises lib/levels.ts, lib/indicators.ts, lib/volume.ts, and lib/prime.ts against
 * synthetic candle data — no Upstox credentials or network access required.
 */
import { computePDLevels, distanceFromLevelPct } from "../lib/levels";
import { computeEMASeries, latestEMAReading } from "../lib/indicators";
import { computeReferenceVolume, classifyVolumeTier, computeVolumeReading } from "../lib/volume";
import { evaluateSymbol, DEFAULT_SCANNER_CONFIG } from "../lib/prime";
import { Candle, ScannerConfig } from "../lib/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}`);
  }
}

function approx(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) <= tol;
}

function candle(time: string, o: number, h: number, l: number, c: number, v: number, complete = true): Candle {
  return { timestamp: `2026-08-28T${time}:00.000Z`, open: o, high: h, low: l, close: c, volume: v, isComplete: complete };
}

// ---------------------------------------------------------------------------
console.log("\n1. PDH/PDL calculation");
{
  const daily: Candle[] = [
    { timestamp: "2026-08-27T00:00:00.000Z", open: 400, high: 410, low: 395, close: 405, volume: 1_000_000, isComplete: true },
  ];
  const pd = computePDLevels(daily, "2026-08-27");
  assert(pd !== null && approx(pd.pdh, 410) && approx(pd.pdl, 395), "computes PDH=410 / PDL=395 from prior day candle");

  const wrongDate = computePDLevels(daily, "2026-08-28");
  assert(wrongDate === null, "rejects candle whose date does not match the expected previous trading date (guards against using today's forming candle)");

  const incomplete = computePDLevels([{ ...daily[0]!, isComplete: false }], "2026-08-27");
  assert(incomplete === null, "rejects an incomplete daily candle");

  const inverted = computePDLevels([{ ...daily[0]!, high: 390, low: 400 }], "2026-08-27");
  assert(inverted === null, "rejects a malformed candle where low > high");

  assert(approx(distanceFromLevelPct(410, 400), 2.5), "distanceFromLevelPct computes % distance correctly");
}

// ---------------------------------------------------------------------------
console.log("\n2. 20 EMA");
{
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 40];
  const candles = closes.map((c, i) => candle(`09:${15 + i * 5}`.padStart(5, "0"), c, c + 1, c - 1, c, 100_000));
  const series = computeEMASeries(candles, 20);
  assert(Number.isNaN(series[18]!), "EMA is NaN before the seed period is reached");
  assert(!Number.isNaN(series[19]!), "EMA seeds (as SMA) exactly at the period length");
  const reading = latestEMAReading(candles, 20, 3);
  assert(reading !== null && reading.isRising, "EMA correctly reads as rising after a sharp up move");

  const fallingCloses = [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 5];
  const fallingCandles = fallingCloses.map((c, i) => candle(`09:${15 + i * 5}`.padStart(5, "0"), c, c + 1, c - 1, c, 100_000));
  const fallingReading = latestEMAReading(fallingCandles, 20, 3);
  assert(fallingReading !== null && fallingReading.isFalling, "EMA correctly reads as falling after a sharp down move");

  assert(latestEMAReading(candles.slice(0, 5), 20) === null, "EMA reading is null when there aren't enough candles yet");
}

// ---------------------------------------------------------------------------
console.log("\n3. Volume multiple + tiers");
{
  const thresholds: ScannerConfig["volumeTierThresholds"] = { strong: 1.5, high: 2, veryHigh: 4, extreme: 6 };
  assert(classifyVolumeTier(1.2, thresholds) === "NORMAL", "1.2x classifies as NORMAL");
  assert(classifyVolumeTier(1.5, thresholds) === "STRONG", "1.5x classifies as STRONG");
  assert(classifyVolumeTier(2.0, thresholds) === "HIGH", "2.0x classifies as HIGH");
  assert(classifyVolumeTier(4.0, thresholds) === "VERY_HIGH", "4.0x classifies as VERY_HIGH");
  assert(classifyVolumeTier(6.5, thresholds) === "EXTREME", "6.5x classifies as EXTREME");

  const priorCandles = new Array(10).fill(0).map((_, i) => candle(`09:${15 + i * 5}`, 100, 101, 99, 100, 10_000));
  const ref = computeReferenceVolume(priorCandles, 10);
  assert(ref === 10_000, "reference volume = average of prior completed candles");

  const target = candle("10:20", 100, 105, 99, 104, 24_000);
  const reading = computeVolumeReading(target, priorCandles, { ...DEFAULT_SCANNER_CONFIG, volumeTierThresholds: thresholds });
  assert(reading !== null && approx(reading.multiple, 2.4), "volume multiple = current / reference (24000/10000 = 2.4x)");
  assert(reading !== null && reading.tier === "HIGH", "2.4x volume classifies as HIGH");
}

// ---------------------------------------------------------------------------
console.log("\n4. CONFIRMED BUY (PDH) — full valid sequence");
{
  const pdLevels = { pdh: 100, pdl: 90, sourceDate: "2026-08-27" };
  const base: Candle[] = [];
  // Build 20 quiet candles below PDH to seed EMA + reference volume, rising trend.
  for (let i = 0; i < 20; i++) {
    const price = 95 + i * 0.2; // rising toward PDH
    base.push(candle(`09:${15 + i * 5}`, price, price + 0.3, price - 0.3, price, 10_000));
  }
  // Breakout candle: closes above PDH with strong volume.
  const breakout = candle("11:20", 99.5, 101.5, 99.3, 101, 25_000);
  // Follow-through candle: holds above PDH.
  const followThrough = candle("11:25", 101, 102, 100.5, 101.8, 15_000);

  const candles = [...base, breakout, followThrough];
  const outcome = evaluateSymbol({ symbol: "TEST", candles, pdLevels, config: DEFAULT_SCANNER_CONFIG });
  assert(outcome !== null && outcome.status === "CONFIRMED" && outcome.direction === "BUY", "full valid breakout sequence reaches CONFIRMED BUY");
  assert(outcome !== null && outcome.setupType === "PDH_BUY", "setup type is PDH_BUY");
  assert(outcome !== null && outcome.trade.entry !== null && outcome.trade.stopLoss !== null && outcome.trade.target !== null, "CONFIRMED signal has entry/SL/target populated");
  assert(outcome !== null && outcome.trade.entry! > outcome.trade.stopLoss!, "entry is above stop loss for a BUY");
}

// ---------------------------------------------------------------------------
console.log("\n5. Must NOT confirm on high volume / above EMA alone (no breakout)");
{
  const pdLevels = { pdh: 100, pdl: 90, sourceDate: "2026-08-27" };
  const base: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const price = 96 + i * 0.18; // rising toward PDH, staying within the WATCH proximity band
    base.push(candle(`09:${15 + i * 5}`, price, price + 0.3, price - 0.3, price, 10_000));
  }
  // Last candle: huge volume, above EMA, close within 0.5% of PDH — but still below it, no breakout.
  const last = candle("12:20", 99.4, 99.7, 99.2, 99.65, 60_000);
  const candles = [...base, last];
  const outcome = evaluateSymbol({ symbol: "TEST2", candles, pdLevels, config: DEFAULT_SCANNER_CONFIG });
  assert(outcome !== null && outcome.status !== "CONFIRMED", "high volume + above EMA without a PDH breakout is never CONFIRMED");
  assert(outcome !== null && outcome.status === "WATCH", "instead classifies as WATCH");
}

// ---------------------------------------------------------------------------
console.log("\n6. Failed breakout (closes back below PDH) must NOT confirm");
{
  const pdLevels = { pdh: 100, pdl: 90, sourceDate: "2026-08-27" };
  const base: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const price = 95 + i * 0.2;
    base.push(candle(`09:${15 + i * 5}`, price, price + 0.3, price - 0.3, price, 10_000));
  }
  const breakout = candle("11:20", 99.5, 101.5, 99.3, 101, 25_000); // breaks out with volume
  const fakeout = candle("11:25", 101, 101.2, 98.5, 99, 12_000); // closes back BELOW pdh
  const candles = [...base, breakout, fakeout];
  const outcome = evaluateSymbol({ symbol: "TEST3", candles, pdLevels, config: DEFAULT_SCANNER_CONFIG });
  assert(outcome !== null && outcome.status !== "CONFIRMED", "a breakout that closes back below PDH is never CONFIRMED");
  assert(outcome !== null && /follow-through failed/i.test(outcome.reason), "reason clearly states follow-through failed");
}

// ---------------------------------------------------------------------------
console.log("\n7. CONFIRMED SELL (PDL) — full valid sequence");
{
  const pdLevels = { pdh: 110, pdl: 100, sourceDate: "2026-08-27" };
  const base: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const price = 105 - i * 0.2; // falling toward PDL
    base.push(candle(`09:${15 + i * 5}`, price, price + 0.3, price - 0.3, price, 10_000));
  }
  const breakdown = candle("11:20", 100.5, 100.7, 98.5, 99, 25_000);
  const followThrough = candle("11:25", 99, 99.2, 98, 98.3, 15_000);
  const candles = [...base, breakdown, followThrough];
  const outcome = evaluateSymbol({ symbol: "TEST4", candles, pdLevels, config: DEFAULT_SCANNER_CONFIG });
  assert(outcome !== null && outcome.status === "CONFIRMED" && outcome.direction === "SELL", "full valid breakdown sequence reaches CONFIRMED SELL");
  assert(outcome !== null && outcome.trade.entry !== null && outcome.trade.stopLoss! > outcome.trade.entry!, "entry is below stop loss for a SELL");
}

// ---------------------------------------------------------------------------
console.log("\n8. Insufficient volume on breakout -> SETUP, not CONFIRMED");
{
  const pdLevels = { pdh: 100, pdl: 90, sourceDate: "2026-08-27" };
  const base: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const price = 95 + i * 0.2;
    base.push(candle(`09:${15 + i * 5}`, price, price + 0.3, price - 0.3, price, 10_000));
  }
  const weakBreakout = candle("11:20", 99.5, 100.5, 99.3, 100.2, 11_000); // only 1.1x volume
  const candles = [...base, weakBreakout];
  const outcome = evaluateSymbol({ symbol: "TEST5", candles, pdLevels, config: DEFAULT_SCANNER_CONFIG });
  assert(outcome !== null && outcome.status === "SETUP", "breakout with insufficient volume is only SETUP");
  assert(outcome !== null && /insufficient 5-min volume/i.test(outcome.reason), "reason explains the missing volume condition");
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
