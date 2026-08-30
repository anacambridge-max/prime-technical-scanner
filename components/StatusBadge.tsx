import { Direction, SignalStatus } from "@/lib/types";

const statusClasses: Record<SignalStatus, string> = {
  CONFIRMED: "bg-buy-bg text-buy border-buy/40",
  SETUP: "bg-setup-bg text-setup border-setup/40",
  WATCH: "bg-watch-bg text-watch border-watch/40",
};

export function StatusBadge({ status, direction }: { status: SignalStatus; direction: Direction }) {
  const color = status === "CONFIRMED" ? (direction === "BUY" ? statusClasses.CONFIRMED : "bg-sell-bg text-sell border-sell/40") : statusClasses[status];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs font-semibold tracking-wide ${color}`}>
      {status}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: Direction }) {
  const color = direction === "BUY" ? "text-buy" : "text-sell";
  return <span className={`font-semibold ${color}`}>{direction}</span>;
}
