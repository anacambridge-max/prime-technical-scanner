# Prime Technical Live Scanner

Intraday NIFTY 500 scanner/dashboard built on Previous Day High (PDH) / Previous Day
Low (PDL), confirmed on **completed 5-minute candles**, with 5-minute volume and 20 EMA
as confirmation filters. **This app never places or modifies any order — it is read-only.**

- Next.js 14 (App Router) + TypeScript + React + Tailwind CSS
- All Upstox calls happen server-side only (`lib/upstox.ts`); the access token is never
  sent to the browser
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
  `app/page.tsx` → `REFRESH_MS`) re-evaluates all NIFTY 500 symbols. As soon as a
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
  nifty500.ts     Universe resolution (seed symbols -> Upstox instrument keys)
  scanner.ts      Orchestrates one full scan cycle across the universe
  store.ts        Per-trading-day persistence so signals don't disappear intraday
app/
  api/scan/route.ts    GET endpoint the dashboard polls
  api/health/route.ts  Lightweight health check
  page.tsx             Dashboard UI (client component, polls /api/scan)
components/            StatCard, FiltersBar, SignalsTable, SignalLogPanel, StatusBadge
data/nifty500-seed.json  Starter symbol list — see note below
scripts/test-logic.ts    Pure-logic test suite (PDH/PDL, EMA, volume, confirmation)
```

## ⚠️ Before going live: replace the NIFTY 500 symbol list

`data/nifty500-seed.json` ships with ~200 liquid, well-known NSE large/mid-cap symbols
as a **starter universe** so the app works out of the box. It is **not** guaranteed to
be the complete, current official NIFTY 500 constituent list — index membership changes
twice a year. Before relying on this for real trading decisions, download the current
official list from NSE Indices (niftyindices.com → NIFTY 500 → constituents CSV) and
replace the contents of that JSON file with the full 500 trading symbols. The scanner
logic itself doesn't care how many symbols are in the universe.

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
