"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScanResult, Signal } from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { FiltersBar, FilterState, DEFAULT_FILTERS } from "@/components/FiltersBar";
import { SignalsTable } from "@/components/SignalsTable";
import { SignalLogPanel } from "@/components/SignalLogPanel";

const REFRESH_MS = 45_000;

function applyFilters(signals: Signal[], f: FilterState): Signal[] {
  return signals.filter((s) => {
    if (f.status !== "ALL" && s.status !== f.status) return false;
    if (f.direction !== "ALL" && s.direction !== f.direction) return false;
    if (f.level !== "ALL" && s.level !== f.level) return false;
    if (f.minVolume !== 0 && s.volumeMultiple < f.minVolume) return false;
    if (f.setupType !== "ALL" && s.setupType !== f.setupType) return false;
    return true;
  });
}

export default function DashboardPage() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastGoodRef = useRef<ScanResult | null>(null);

  const runScan = useCallback(async () => {
    try {
      const res = await fetch("/api/scan", { cache: "no-store" });
      if (!res.ok) throw new Error(`Scan request failed (HTTP ${res.status})`);
      const data = (await res.json()) as ScanResult;
      lastGoodRef.current = data;
      setResult(data);
      setFetchError(null);
    } catch (err) {
      // Network/client-side failure: keep showing the last good result rather than blanking the screen.
      setFetchError(err instanceof Error ? err.message : "Failed to reach the scanner");
      if (lastGoodRef.current) setResult(lastGoodRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runScan();
    const id = setInterval(runScan, REFRESH_MS);
    return () => clearInterval(id);
  }, [runScan]);

  const filtered = result ? applyFilters(result.signals, filters) : [];
  const meta = result?.meta;

  return (
    <main className="min-h-screen px-4 py-5 md:px-8 max-w-[1600px] mx-auto">
      <Header meta={meta} loading={loading} onRefresh={runScan} fetchError={fetchError} />

      {meta?.message && (
        <div className="mt-3 rounded-md border border-setup/40 bg-setup-bg px-3 py-2 text-2xs text-setup">
          {meta.message}
        </div>
      )}
      {fetchError && (
        <div className="mt-3 rounded-md border border-sell/40 bg-sell-bg px-3 py-2 text-2xs text-sell">
          Connection issue: {fetchError}. Showing the last successful scan.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
        <StatCard label="Confirmed" value={result?.counts.confirmed ?? 0} accent="confirmed" />
        <StatCard label="Setups" value={result?.counts.setup ?? 0} accent="setup" />
        <StatCard label="Watch" value={result?.counts.watch ?? 0} accent="watch" />
        <StatCard label="NIFTY 500 Universe" value={result?.counts.universe ?? 0} />
        <StatCard
          label="Last Update"
          value={meta?.lastSuccessfulScanTime ? formatTime(meta.lastSuccessfulScanTime) : "—"}
          sub={meta?.marketStatus.replace("_", " ")}
        />
      </div>

      <FiltersBar filters={filters} onChange={setFilters} />

      <div className="mt-2 rounded-md border border-base-700 bg-base-900/40">
        <SignalsTable signals={filtered} />
      </div>

      <div className="mt-6">
        <SignalLogPanel log={result?.log ?? []} />
      </div>

      <footer className="mt-6 text-2xs text-ink-500">
        Scanner/dashboard only — no orders are placed. PDH/PDL from the prior completed
        trading day; all confirmations use completed 5-minute candles, 5-minute volume,
        and 20 EMA. Data via Upstox, server-side only.
      </footer>
    </main>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Header({
  meta,
  loading,
  onRefresh,
  fetchError,
}: {
  meta: ScanResult["meta"] | undefined;
  loading: boolean;
  onRefresh: () => void;
  fetchError: string | null;
}) {
  const isLive = meta?.marketOpen && !fetchError;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">PRIME TECHNICAL LIVE SCANNER</h1>
        <p className="text-2xs text-ink-500 mt-0.5">NIFTY 500 · 5-minute PDH/PDL breakout &amp; breakdown confirmation</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-2xs">
          <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "bg-live animate-pulse" : "bg-ink-500"}`} />
          <span className={isLive ? "text-live" : "text-ink-500"}>{isLive ? "LIVE" : "IDLE"}</span>
        </span>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-2xs border border-base-600 rounded-md px-3 py-1.5 hover:bg-base-800 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
