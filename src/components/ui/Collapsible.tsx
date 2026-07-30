"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

/**
 * A titled section that can be folded away.
 *
 * Exists for the exchange grid, which renders one card per venue. At 24
 * venues that block ran to roughly 1,400px — about a third of the whole page,
 * and the section with the least information per pixel, since `OI Δ 24h` and
 * `L/S Ratio` read "—" on most cards until history accumulates.
 *
 * Collapsed by default rather than removed: the detail is genuinely useful
 * when you want it, and the heat map directly above already gives the
 * cross-venue funding picture at a glance.
 *
 * Children are only mounted when open. With 24 cards each running a countdown
 * interval, keeping them mounted-but-hidden would leave 24 timers ticking for
 * something nobody is looking at.
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown next to the toggle while collapsed, e.g. "24 venues". */
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group mb-3 flex w-full items-center gap-2 text-left"
      >
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted group-hover:text-ink">
          {title}
        </h2>
        {summary && <span className="text-[11px] text-ink-faint">{summary}</span>}
        <ChevronDown
          className={`h-3.5 w-3.5 text-ink-faint transition-transform group-hover:text-ink-muted ${
            open ? "rotate-180" : ""
          }`}
        />
        <span className="ml-auto text-[11px] text-ink-faint group-hover:text-ink-muted">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && children}
    </section>
  );
}
