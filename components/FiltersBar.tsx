"use client";

import { SetupType } from "@/lib/types";

export interface FilterState {
  status: "ALL" | "CONFIRMED" | "SETUP" | "WATCH";
  direction: "ALL" | "BUY" | "SELL";
  level: "ALL" | "PDH" | "PDL";
  minVolume: 0 | 1.5 | 2 | 4 | 6;
  setupType: "ALL" | SetupType;
}

export const DEFAULT_FILTERS: FilterState = {
  status: "ALL",
  direction: "ALL",
  level: "ALL",
  minVolume: 0,
  setupType: "ALL",
};

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-base-600 overflow-hidden text-2xs">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1.5 transition-colors ${
            value === opt.value ? "bg-base-600 text-ink-100" : "bg-base-900 text-ink-500 hover:text-ink-300"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function FiltersBar({ filters, onChange }: { filters: FilterState; onChange: (f: FilterState) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3 border-b border-base-700">
      <FilterGroup label="Status">
        <Segmented
          value={filters.status}
          onChange={(status) => onChange({ ...filters, status })}
          options={[
            { value: "ALL", label: "All" },
            { value: "CONFIRMED", label: "Confirmed" },
            { value: "SETUP", label: "Setup" },
            { value: "WATCH", label: "Watch" },
          ]}
        />
      </FilterGroup>

      <FilterGroup label="Direction">
        <Segmented
          value={filters.direction}
          onChange={(direction) => onChange({ ...filters, direction })}
          options={[
            { value: "ALL", label: "All" },
            { value: "BUY", label: "Buy" },
            { value: "SELL", label: "Sell" },
          ]}
        />
      </FilterGroup>

      <FilterGroup label="Level">
        <Segmented
          value={filters.level}
          onChange={(level) => onChange({ ...filters, level })}
          options={[
            { value: "ALL", label: "All" },
            { value: "PDH", label: "PDH" },
            { value: "PDL", label: "PDL" },
          ]}
        />
      </FilterGroup>

      <FilterGroup label="Volume">
        <Segmented
          value={String(filters.minVolume) as "0" | "1.5" | "2" | "4" | "6"}
          onChange={(v) => onChange({ ...filters, minVolume: Number(v) as FilterState["minVolume"] })}
          options={[
            { value: "0", label: "All" },
            { value: "1.5", label: ">=1.5x" },
            { value: "2", label: ">=2x" },
            { value: "4", label: ">=4x" },
            { value: "6", label: ">=6x" },
          ]}
        />
      </FilterGroup>

      <FilterGroup label="Setup">
        <Segmented
          value={filters.setupType}
          onChange={(setupType) => onChange({ ...filters, setupType })}
          options={[
            { value: "ALL", label: "All" },
            { value: "PDH_BUY", label: "PDH Buy" },
            { value: "PDL_SELL", label: "PDL Sell" },
            { value: "BUY_CONTINUATION", label: "Buy Cont." },
            { value: "SELL_CONTINUATION", label: "Sell Cont." },
          ]}
        />
      </FilterGroup>

      {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
        <button
          onClick={() => onChange(DEFAULT_FILTERS)}
          className="text-2xs text-ink-500 hover:text-ink-100 underline underline-offset-2 ml-auto"
        >
          Reset filters
        </button>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs uppercase tracking-wider text-ink-500">{label}</span>
      {children}
    </div>
  );
}
