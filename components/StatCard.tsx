interface StatCardProps {
  label: string;
  value: string | number;
  accent?: "confirmed" | "setup" | "watch" | "neutral";
  sub?: string;
}

const accentClasses: Record<NonNullable<StatCardProps["accent"]>, string> = {
  confirmed: "text-buy border-buy/30",
  setup: "text-setup border-setup/30",
  watch: "text-watch border-watch/30",
  neutral: "text-ink-100 border-base-600",
};

export function StatCard({ label, value, accent = "neutral", sub }: StatCardProps) {
  return (
    <div className={`rounded-md border bg-base-900 px-4 py-3 ${accentClasses[accent]}`}>
      <div className="text-2xs uppercase tracking-wider text-ink-500">{label}</div>
      <div className="num text-2xl font-semibold leading-tight mt-1">{value}</div>
      {sub && <div className="text-2xs text-ink-500 mt-0.5">{sub}</div>}
    </div>
  );
}
