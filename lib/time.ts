/**
 * Centralized Asia/Kolkata timezone + NSE market-hours handling.
 * Every date/time decision in the scanner routes through here to avoid
 * scattered, inconsistent Date/string handling.
 */

const IST_TZ = "Asia/Kolkata";

const MARKET_OPEN = { hour: 9, minute: 15 };
const MARKET_CLOSE = { hour: 15, minute: 30 };
/** First 5-minute candle isn't CLOSED (and therefore usable) until 09:20 IST. */
const FIRST_CANDLE_CLOSE = { hour: 9, minute: 20 };

function istParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday, // "Mon", "Tue", ...
  };
}

/** Returns YYYY-MM-DD for the given instant, in IST wall-clock terms. */
export function istTradingDate(date: Date = new Date()): string {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function istTimeHHmm(date: Date = new Date()): string {
  const p = istParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function minutesSinceMidnight(p: { hour: number; minute: number }): number {
  return p.hour * 60 + p.minute;
}

export function isWeekend(date: Date = new Date()): boolean {
  const p = istParts(date);
  return p.weekday === "Sat" || p.weekday === "Sun";
}

/**
 * Indian market holidays (NSE trading holidays). This list must be updated yearly.
 * Kept intentionally small/explicit rather than guessed — an empty/incomplete list
 * degrades gracefully to "not a holiday" rather than silently hiding trading days.
 */
export const NSE_HOLIDAYS_2026: string[] = [
  // Populate from the official NSE holiday calendar for the current year before going live.
];

export function isMarketHoliday(date: Date = new Date()): boolean {
  return NSE_HOLIDAYS_2026.includes(istTradingDate(date));
}

export type MarketStatus = "PRE_OPEN" | "OPEN" | "CLOSED" | "HOLIDAY_OR_WEEKEND";

export function getMarketStatus(date: Date = new Date()): MarketStatus {
  if (isWeekend(date) || isMarketHoliday(date)) return "HOLIDAY_OR_WEEKEND";
  const p = istParts(date);
  const mins = minutesSinceMidnight(p);
  const open = minutesSinceMidnight(MARKET_OPEN);
  const close = minutesSinceMidnight(MARKET_CLOSE);
  if (mins < open) return "PRE_OPEN";
  if (mins > close) return "CLOSED";
  return "OPEN";
}

/** True once the first 5-minute candle of the day (09:15–09:20) has actually closed. */
export function firstCandleHasClosed(date: Date = new Date()): boolean {
  const p = istParts(date);
  const mins = minutesSinceMidnight(p);
  return mins >= minutesSinceMidnight(FIRST_CANDLE_CLOSE);
}

/** Returns the previous weekday (Mon-Fri) date string, not accounting for holidays beyond the list above. */
export function previousTradingDateGuess(fromDate: Date = new Date()): string {
  const d = new Date(fromDate.getTime());
  let guard = 0;
  do {
    d.setUTCDate(d.getUTCDate() - 1);
    guard++;
  } while ((isWeekend(d) || isMarketHoliday(d)) && guard < 10);
  return istTradingDate(d);
}
