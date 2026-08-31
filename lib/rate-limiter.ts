import "server-only";

/**
 * Upstox's documented per-user, per-API rate limits (see
 * https://upstox.com/developer/api-documentation/rate-limiting/):
 *   25 requests / second, 250 requests / minute, 1000 requests / 30 minutes.
 *
 * The scanner's batching strategy (see lib/scanner.ts) is sized to stay comfortably
 * under these on its own, but this limiter is a defense-in-depth safety net: every
 * outbound call to api.upstox.com reserves a slot here first, so a burst (e.g. several
 * manual "Refresh" clicks in a row) self-throttles instead of provoking a real 429 from
 * Upstox, which could otherwise cascade into a temporary suspension.
 */

interface Window {
  limit: number;
  windowMs: number;
  timestamps: number[];
}

const windows: Window[] = [
  { limit: 25, windowMs: 1_000, timestamps: [] },
  { limit: 250, windowMs: 60_000, timestamps: [] },
  { limit: 1000, windowMs: 30 * 60_000, timestamps: [] },
];

function pruneAndCheck(now: number): number {
  let waitMs = 0;
  for (const w of windows) {
    while (w.timestamps.length > 0 && now - w.timestamps[0]! > w.windowMs) {
      w.timestamps.shift();
    }
    if (w.timestamps.length >= w.limit) {
      const oldest = w.timestamps[0]!;
      const wait = w.windowMs - (now - oldest) + 5;
      if (wait > waitMs) waitMs = wait;
    }
  }
  return waitMs;
}

// Serialize slot acquisition so concurrent callers (mapWithConcurrency in scanner.ts)
// don't all check-and-reserve simultaneously and blow past a window's limit.
let queue: Promise<void> = Promise.resolve();

export function acquireUpstoxSlot(): Promise<void> {
  const task = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      const wait = pruneAndCheck(now);
      if (wait <= 0) {
        const t = Date.now();
        for (const w of windows) w.timestamps.push(t);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  });
  queue = task.catch(() => undefined); // keep the chain alive even if this caller errors later
  return task;
}
