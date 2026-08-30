import { SignalLogEntry } from "@/lib/types";

export function SignalLogPanel({ log }: { log: SignalLogEntry[] }) {
  return (
    <div className="border border-base-700 rounded-md">
      <div className="px-3 py-2 border-b border-base-700 text-2xs uppercase tracking-wider text-ink-500">
        Signal Event Log
      </div>
      <div className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-base-800">
        {log.length === 0 && <div className="px-3 py-4 text-2xs text-ink-500">No status changes logged yet today.</div>}
        {log.map((entry, i) => (
          <div key={`${entry.timestamp}-${entry.symbol}-${i}`} className="px-3 py-2 text-2xs flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="num text-ink-500 w-12">{entry.time}</span>
            <span className="font-semibold w-20">{entry.symbol}</span>
            <span className={entry.direction === "BUY" ? "text-buy w-10" : "text-sell w-10"}>{entry.direction}</span>
            <span className="text-ink-500 w-10">{entry.level}</span>
            <span className="text-ink-300 w-16">{entry.status}</span>
            <span className="num text-ink-300 w-16">{entry.price.toFixed(2)}</span>
            <span className="num text-ink-500 w-12">{entry.volumeMultiple.toFixed(1)}x</span>
            <span className="text-ink-500 flex-1 min-w-[200px]">{entry.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
