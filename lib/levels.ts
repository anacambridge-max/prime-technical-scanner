import { Candle, PDLevels } from "./types";

/**
 * Computes Previous Day High / Previous Day Low.
 *
 * CRITICAL: this must be derived from the previous COMPLETED trading day's daily candle only.
 * It must never be confused with:
 *   - today's intraday high/low (updates every candle, not usable as PDH/PDL)
 *   - the opening range high/low (first N minutes of today)
 *
 * `dailyCandles` should be daily (1day) candles, most recent last, and the LAST entry
 * in this array must be the previous completed trading day (i.e. NOT today, since
 * today's daily candle is still forming intraday).
 */
export function computePDLevels(dailyCandles: Candle[], expectedPrevDate: string): PDLevels | null {
  if (dailyCandles.length === 0) return null;

  const prevDayCandle = dailyCandles[dailyCandles.length - 1];
  if (!prevDayCandle || !prevDayCandle.isComplete) return null;

  // Defensive check: the candle we're using must actually date to the expected previous
  // trading day, otherwise we risk silently using today's forming candle as PDH/PDL.
  const candleDate = prevDayCandle.timestamp.slice(0, 10);
  if (candleDate !== expectedPrevDate) return null;

  if (!Number.isFinite(prevDayCandle.high) || !Number.isFinite(prevDayCandle.low)) return null;
  if (prevDayCandle.high <= 0 || prevDayCandle.low <= 0) return null;
  if (prevDayCandle.low > prevDayCandle.high) return null;

  return {
    pdh: prevDayCandle.high,
    pdl: prevDayCandle.low,
    prevClose: prevDayCandle.close,
    sourceDate: candleDate,
  };
}

export function distanceFromLevelPct(price: number, level: number): number {
  if (level === 0) return 0;
  return ((price - level) / level) * 100;
}
