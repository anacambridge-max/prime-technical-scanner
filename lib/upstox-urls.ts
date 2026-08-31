/**
 * Pure Upstox v3 URL path builders. Deliberately has no "server-only" import and no
 * side effects so it can be unit-tested directly (see scripts/test-logic.ts) — this is
 * exactly the kind of thing that's easy to get subtly wrong (v3 uses a unit/interval
 * shape, e.g. "minutes/5" and "days/1", NOT the old v2 shorthand like "5minute"/"day")
 * and silently break every single symbol in a scan.
 */

export function intradayCandlePath(instrumentKey: string): string {
  const encodedKey = encodeURIComponent(instrumentKey);
  return `/historical-candle/intraday/${encodedKey}/minutes/5`;
}

export function dailyCandlePath(instrumentKey: string, fromDate: string, toDate: string): string {
  const encodedKey = encodeURIComponent(instrumentKey);
  return `/historical-candle/${encodedKey}/days/1/${toDate}/${fromDate}`;
}

export function ltpPath(instrumentKey: string): string {
  const encodedKey = encodeURIComponent(instrumentKey);
  return `/market-quote/ltp?instrument_key=${encodedKey}`;
}
