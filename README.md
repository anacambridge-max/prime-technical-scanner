# Prime Technical Live Scanner

Intraday **NSE F&O universe** scanner/dashboard built on Previous Day High (PDH) / Previous Day
Low (PDL), confirmed on **completed 5-minute candles**, with 5-minute volume and 20 EMA
as confirmation filters. **This app never places or modifies any order — it is read-only.**

- Next.js 14 (App Router) + TypeScript + React + Tailwind CSS
- All Upstox calls happen server-side only (`lib/upstox.ts`); the access token is never
  sent to the browser
- **The scanned universe is every NSE stock currently eligible for Futures & Options
  trading** — derived live from Upstox's own instrument master (`lib/universe.ts`),
  not a hand-maintained list. When NSE adds or removes a stock from F&O (it reviews
  this roughly twice a year), the scanner picks up the change automatically on its
  next universe refresh (every 6 hours) — nothing to edit in code.
- WATCH → SETUP → CONFIRMED state machine, matching the exact rules in the spec (no
  confirmation from volume or EMA alone — a real PDH/PDL breakout + close + volume +
  EMA + follow-through is required)
- Once a stock appears today, it stays visible for the rest of the trading day
  (`lib/store.ts`), and a CONFIRMED status is locked in even if price later reverses
- Graceful degradation: one bad symbol, a rate limit, or a temporarily empty Upstox
  response never wipes out the dashboard — the last successful scan is always retained

## How the timing works (9:15–10:00 AM and beyond)

- **09:15 IST** — market opens, first 5-minute candle starts forming.
- **09:20 IST** — the first 5-minute candle *closes*. Only from this point on can the
  scanner use a "completed candle" for anything — this app will not confirm off a
  still-forming candle.
- From 09:20 onward, every scan cycle (default every 45s, configurable in
  `app/page.tsx` → `REFRESH_MS`) re-evaluates every NSE F&O stock. As soon as a
  symbol's completed candles satisfy the full CONFIRMED sequence (breakout/breakdown →
  volume → EMA alignment → follow-through), it appears in the table and **stays there
  for the rest of the day**, even outside 9:15–10:00.
- Outside market hours / on weekends & holidays, the dashboard shows the last
  successful scan and a clear `MARKET CLOSED` state instead of generating fresh
  (necessarily stale) confirmations.

## Project layout

```
lib/
  types.ts        Shared domain types
  time.ts         Asia/Kolkata market-hours helpers (edit NSE_HOLIDAYS_2026 yearly!)
  levels.ts       PDH/PDL calculation (strictly from the prior COMPLETED day)
  indicators.ts   20 EMA on 5-minute candles
  volume.ts       5-minute volume multiple + tier classification
  prime.ts        The WATCH/SETUP/CONFIRMED state machine (the core engine)
  upstox.ts       Server-only Upstox API client (retries, auth/rate-limit handling)
  universe.ts     Resolves the live NSE F&O stock universe from Upstox's instrument master
  scanner.ts      Orchestrates one full scan cycle across the universe
  store.ts        Per-trading-day persistence so signals don't disappear intraday
app/
  api/scan/route.ts    GET endpoint the dashboard polls
  api/health/route.ts  Lightweight health check
  page.tsx             Dashboard UI (client component, polls /api/scan)
components/            StatCard, FiltersBar, SignalsTable, SignalLogPanel, StatusBadge
scripts/test-logic.ts    Pure-logic test suite (PDH/PDL, EMA, volume, confirmation)
```

## The scanned universe: NSE F&O stocks, always current

`lib/universe.ts` builds the scanner's universe by reading Upstox's own NSE instrument
master at runtime: it finds every stock-futures contract (`segment=NSE_FO`,
`instrument_type=FUT`), extracts each contract's underlying equity symbol, and resolves
that symbol to its `NSE_EQ` instrument key. Index futures (NIFTY, BANKNIFTY, etc.) are
automatically excluded since they have no underlying equity to scan.

This means there is **no static symbol list to maintain** — when NSE adds or removes a
stock from the F&O segment, the next universe refresh (cached for 6 hours) picks it up
automatically. If you'd rather scan a fixed, hand-picked list instead of "all current
F&O stocks", swap the body of `resolveFnoUniverse()` for your own symbol array.

## Setup

```bash
npm install
cp .env.example .env.local
# edit .env.local and set UPSTOX_ACCESS_TOKEN
npm run dev
```

Open http://localhost:3000.

Useful scripts:

```bash
npm run typecheck    # tsc --noEmit
npm run test:logic   # PDH/PDL, EMA, volume, and CONFIRMED-state-machine tests (no network needed)
npm run build        # production build (also type-checks)
```

### Getting an Upstox access token

Upstox access tokens are issued via OAuth and **expire every day**. For a scanner that
needs to run unattended all session, you'll want a small daily refresh step:

1. Register an app at https://developer.upstox.com and note the API key/secret.
2. Complete the OAuth login flow once to get a `code`, then exchange it for an
   access token (Upstox's `/login/authorization/token` endpoint).
3. Store that token in `UPSTOX_ACCESS_TOKEN`. Since it expires daily, either
   re-run the OAuth flow each morning before 9:15 IST, or automate it with Upstox's
   documented token endpoints in a small cron job / GitHub Action that updates the
   Vercel environment variable via the Vercel API before market open.

This app intentionally does not implement the OAuth login flow itself (it needs your
redirect URI and app credentials), only the authenticated market-data calls.

## Deploying: GitHub + Vercel

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Prime Technical Live Scanner"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. **Import into Vercel**
   - Go to https://vercel.com/new, import the GitHub repo.
   - Framework preset: Next.js (auto-detected).
   - Add environment variable `UPSTOX_ACCESS_TOKEN` in Project Settings → Environment
     Variables (do this for Production, Preview, and Development as needed).
   - Deploy.
3. **Keep the token fresh** — set a reminder or automation (see above) to update
   `UPSTOX_ACCESS_TOKEN` in Vercel before each trading day, since Upstox tokens expire
   daily. An expired token surfaces in the dashboard as a `DATA ERROR` banner rather
   than crashing the app.

### A note on persistence at scale on Vercel

`lib/store.ts` persists the day's signals to `/tmp` by default so CONFIRMED signals
don't disappear intraday. This is reliable on a single long-lived server (e.g. running
`next start` on a VPS/Docker) and works "well enough" on Vercel as long as the same
serverless instance stays warm through the day. Vercel does **not** guarantee `/tmp`
survives cold starts or is shared across scaled-out instances. If you see signals
occasionally reset intraday on Vercel, swap `FileDayStore` in `lib/store.ts` for
`@vercel/kv` or Upstash Redis — the `DayStore` interface is deliberately small (just
`load`/`save`) so this is a contained change.

## What this app deliberately does NOT do

- Place, modify, or cancel any order (scanner/dashboard only)
- Confirm a setup from volume or EMA alone, without an actual PDH/PDL close-through
- Use today's intraday high/low, or the opening range, as PDH/PDL
- Use incomplete/forming candles for confirmation
- Use daily volume for the volume condition
- Fabricate entry/target levels for WATCH or SETUP rows (`"-"` until CONFIRMED)
- Zero out the whole dashboard because one symbol or one scan cycle failed
