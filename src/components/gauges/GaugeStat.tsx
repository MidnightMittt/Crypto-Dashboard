import type { ReactNode } from "react";

export function GaugeStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="font-mono text-sm text-ink">{value}</span>
    </div>
  );
}
