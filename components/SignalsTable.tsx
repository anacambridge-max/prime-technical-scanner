"use client";

import { Fragment, useState } from "react";
import { Signal } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

function fmtPrice(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function setupLabel(s: Signal): string {
  switch (s.setupType) {
    case "PDH_BUY":
      return "PDH BUY";
    case "PDL_SELL":
      return "PDL SELL";
    case "BUY_CONTINUATION":
      return "BUY CONTINUATION";
    case "SELL_CONTINUATION":
      return "SELL CONTINUATION";
  }
}

export function SignalsTable({ signals }: { signals: Signal[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (signals.length === 0) {
    return (
      <div className="py-16 text-center text-ink-500 text-sm">
        No stocks match the current filters yet. The scanner keeps every symbol it has
        seen today — try widening a filter, or wait for the next 30–60s refresh.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-2xs uppercase tracking-wider text-ink-500 border-b border-base-700 text-left">
            <th className="py-2 pr-3 font-medium">Stock</th>
            <th className="py-2 pr-3 font-medium text-right">LTP</th>
            <th className="py-2 pr-3 font-medium text-right">Chg%</th>
            <th className="py-2 pr-3 font-medium text-right">Volume</th>
            <th className="py-2 pr-3 font-medium">20 EMA</th>
            <th className="py-2 pr-3 font-medium text-right">PDH</th>
            <th className="py-2 pr-3 font-medium text-right">PDL</th>
            <th className="py-2 pr-3 font-medium">Level</th>
            <th className="py-2 pr-3 font-medium text-right">Distance</th>
            <th className="py-2 pr-3 font-medium">Setup</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium text-right">Entry</th>
            <th className="py-2 pr-3 font-medium text-right">SL</th>
            <th className="py-2 pr-3 font-medium text-right">Target</th>
            <th className="py-2 pr-3 font-medium min-w-[280px]">Reason</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => {
            const distance = s.direction === "BUY" ? s.distanceFromPdhPct : s.distanceFromPdlPct;
            const isOpen = expanded === s.id;
            return (
              <Fragment key={s.id}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : s.id)}
                  className={`border-b border-base-800 cursor-pointer hover:bg-base-900/60 ${
                    s.status === "CONFIRMED" ? (s.direction === "BUY" ? "bg-buy-bg/40" : "bg-sell-bg/40") : ""
                  }`}
                >
                  <td className="py-2 pr-3 font-semibold">{s.symbol}</td>
                  <td className="py-2 pr-3 text-right num">{fmtPrice(s.ltp)}</td>
                  <td className={`py-2 pr-3 text-right num ${s.changePct >= 0 ? "text-buy" : "text-sell"}`}>
                    {fmtPct(s.changePct)}
                  </td>
                  <td className="py-2 pr-3 text-right num">{s.volumeMultiple > 0 ? `${s.volumeMultiple.toFixed(1)}x` : "—"}</td>
                  <td className="py-2 pr-3 text-2xs">
                    {s.ema20 > 0 ? (
                      <span className={s.ema20Trend === "RISING" ? "text-buy" : s.ema20Trend === "FALLING" ? "text-sell" : "text-ink-500"}>
                        {s.ema20Trend === "RISING" ? "BULLISH" : s.ema20Trend === "FALLING" ? "BEARISH" : "FLAT"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right num text-ink-300">{fmtPrice(s.pdh)}</td>
                  <td className="py-2 pr-3 text-right num text-ink-300">{fmtPrice(s.pdl)}</td>
                  <td className="py-2 pr-3 text-2xs">{s.level}</td>
                  <td className="py-2 pr-3 text-right num">{fmtPct(distance)}</td>
                  <td className="py-2 pr-3 text-2xs whitespace-nowrap">{setupLabel(s)}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={s.status} direction={s.direction} />
                  </td>
                  <td className="py-2 pr-3 text-right num">{s.trade.entry ? fmtPrice(s.trade.entry) : "-"}</td>
                  <td className="py-2 pr-3 text-right num text-sell">{s.trade.stopLoss ? fmtPrice(s.trade.stopLoss) : "-"}</td>
                  <td className="py-2 pr-3 text-right num text-buy">{s.trade.target ? fmtPrice(s.trade.target) : "-"}</td>
                  <td className="py-2 pr-3 text-2xs text-ink-300">{s.reason}</td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-base-800 bg-base-900/80">
                    <td colSpan={15} className="p-4">
                      <SignalAuditPanel signal={s} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SignalAuditPanel({ signal }: { signal: Signal }) {
  const a = signal.audit;
  const rows: [string, string][] = [
    ["PDH", fmtPrice(a.pdh)],
    ["PDL", fmtPrice(a.pdl)],
    ["PD source date", a.pdSourceDate],
    ["Trigger candle time", a.triggerCandleTime ?? "—"],
    [
      "Trigger candle OHLC",
      a.triggerCandle
        ? `O ${fmtPrice(a.triggerCandle.open)} / H ${fmtPrice(a.triggerCandle.high)} / L ${fmtPrice(a.triggerCandle.low)} / C ${fmtPrice(
            a.triggerCandle.close
          )}`
        : "—",
    ],
    ["5-min volume", a.volume ? a.volume.currentVolume.toLocaleString("en-IN") : "—"],
    ["Reference volume", a.volume ? Math.round(a.volume.referenceVolume).toLocaleString("en-IN") : "—"],
    ["Volume multiple", a.volume ? `${a.volume.multiple.toFixed(2)}x (${a.volume.tier.replace("_", " ")})` : "—"],
    ["20 EMA @ trigger", a.ema20 ? fmtPrice(a.ema20.value) : "—"],
    ["Price", fmtPrice(a.price)],
    ["Follow-through candle time", a.followThroughCandleTime ?? "—"],
    ["Follow-through held", a.followThroughHeld ? "Yes" : "No"],
    ["Confirmation time", a.confirmationTime ?? "Not confirmed"],
    ["Entry", signal.trade.entry ? fmtPrice(signal.trade.entry) : "-"],
    ["Stop loss", signal.trade.stopLoss ? fmtPrice(signal.trade.stopLoss) : "-"],
    ["Target", signal.trade.target ? fmtPrice(signal.trade.target) : "-"],
    ["First detected today", signal.firstDetectedAt],
    ["Last updated", signal.lastUpdatedAt],
  ];

  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-ink-500 mb-2">
        Signal Details — {signal.symbol} (for comparing against TradingView / debugging false confirmations)
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-1.5 text-2xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-base-800 py-1">
            <span className="text-ink-500">{label}</span>
            <span className="num text-ink-100 text-right">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
