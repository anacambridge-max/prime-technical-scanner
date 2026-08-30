import { Candle, ScannerConfig, VolumeReading, VolumeTier } from "./types";

/**
 * Reference volume = average volume of the N completed 5-minute candles immediately
 * preceding the candle being evaluated. Never uses daily volume, and never uses
 * candles that come after the evaluated candle (no look-ahead).
 */
export function computeReferenceVolume(
  completedCandlesBeforeTarget: Candle[],
  lookback: number
): number | null {
  if (completedCandlesBeforeTarget.length === 0) return null;
  const window = completedCandlesBeforeTarget.slice(-lookback);
  if (window.length === 0) return null;
  const sum = window.reduce((a, c) => a + c.volume, 0);
  const avg = sum / window.length;
  return avg > 0 ? avg : null;
}

export function classifyVolumeTier(multiple: number, thresholds: ScannerConfig["volumeTierThresholds"]): VolumeTier {
  if (multiple >= thresholds.extreme) return "EXTREME";
  if (multiple >= thresholds.veryHigh) return "VERY_HIGH";
  if (multiple >= thresholds.high) return "HIGH";
  if (multiple >= thresholds.strong) return "STRONG";
  return "NORMAL";
}

/**
 * Computes the volume reading for a specific target candle, using only candles that
 * completed strictly before it as the reference window.
 */
export function computeVolumeReading(
  targetCandle: Candle,
  completedCandlesBeforeTarget: Candle[],
  config: ScannerConfig
): VolumeReading | null {
  const reference = computeReferenceVolume(completedCandlesBeforeTarget, config.volumeReferenceLookback);
  if (reference === null) return null;
  const multiple = targetCandle.volume / reference;
  return {
    currentVolume: targetCandle.volume,
    referenceVolume: reference,
    multiple,
    tier: classifyVolumeTier(multiple, config.volumeTierThresholds),
  };
}

export function formatVolumeMultiple(multiple: number): string {
  return `${multiple.toFixed(1)}x`;
}
