import { Candle, EMAReading } from "./types";

/**
 * Standard EMA over an array of completed candle closes, oldest first.
 * Returns the EMA series aligned to the input candles (same length), using SMA seed
 * for the first `period` values.
 */
export function computeEMASeries(candles: Candle[], period: number): number[] {
  const closes = candles.map((c) => c.close);
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;

  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = seed;

  for (let i = period; i < closes.length; i++) {
    const close = closes[i];
    const prevEma = out[i - 1];
    if (close === undefined || prevEma === undefined) continue;
    out[i] = close * k + prevEma * (1 - k);
  }
  return out;
}

/**
 * Computes the latest 20 EMA reading plus its slope (rising/falling) using only
 * COMPLETED 5-minute candles, oldest first. `slopeLookback` controls how many
 * completed EMA points back we compare against to judge direction (default 3 candles
 * = 15 minutes), so we don't call a single-tick wiggle a trend.
 */
export function latestEMAReading(
  completedCandles: Candle[],
  period: number,
  slopeLookback = 3
): EMAReading | null {
  if (completedCandles.length < period) return null;
  const series = computeEMASeries(completedCandles, period);
  const lastIdx = series.length - 1;
  const current = series[lastIdx];
  if (current === undefined || Number.isNaN(current)) return null;

  // Clamp the lookback so we can still judge slope right after the EMA has just seeded,
  // instead of refusing to call a direction until `slopeLookback` extra candles exist.
  const maxLookback = lastIdx - (period - 1);
  const effectiveLookback = Math.max(1, Math.min(slopeLookback, maxLookback));
  const compareIdx = lastIdx - effectiveLookback;
  const compareValue = compareIdx >= period - 1 ? series[compareIdx] : undefined;

  let isRising = false;
  let isFalling = false;
  if (compareValue !== undefined && !Number.isNaN(compareValue)) {
    isRising = current > compareValue;
    isFalling = current < compareValue;
  }

  return { value: current, isRising, isFalling };
}
