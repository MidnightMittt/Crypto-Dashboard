import { LedgerChange, LedgerDiff } from "@/lib/markets/historyLedger";

/**
 * WHAT CHANGED SINCE THE LAST SESSION.
 *
 * A reader returning after a day already knows the state; what they do not
 * know is the delta. This is the first surface the signal ledger has ever
 * had — it had been write-only since it was built, accumulating for a
 * consumer that did not exist.
 *
 * ── Three states, and they must not look alike ───────────────────────
 *
 *   no ledger depth   we have no yesterday to compare against
 *   no changes        yesterday exists and nothing crossed a boundary
 *   changes           these things crossed
 *
 * The first two are opposite claims and an empty list would render them
 * identically — "quiet session" and "we cannot tell you" reading the same is
 * exactly the ambiguity the ledger exists to remove.
 */

const KIND_LABEL: Record<LedgerChange["kind"], string> = {
  regime: "Regime",
  rotation: "Sector",
  industry: "Industry",
  equity: "Index",
};

/** Slugs are for URLs; a reader should not have to decode one. */
function readable(subject: string): string {
  return subject.includes("-") && subject.toUpperCase() !== subject
    ? subject.replace(/-/g, " ")
    : subject;
}

function phrase(c: LedgerChange): string {
  if (c.from === null) return `now tracked — ${c.to}`;
  if (c.to === null) return `no longer reported (was ${c.from})`;
  return `${c.from} → ${c.to}`;
}

export function WhatChanged({ diff, entries }: { diff: LedgerDiff | null; entries: number }) {
  if (!diff) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-faint">
        <span className="text-amber">No comparison yet</span> · the signal ledger holds{" "}
        {entries === 1 ? "a single session" : `${entries} sessions`}, so there is no previous session to
        measure against. This fills in as the daily job runs — and it is deliberately blank rather than
        empty, because &ldquo;nothing changed&rdquo; and &ldquo;we cannot tell you yet&rdquo; are
        opposite claims.
      </p>
    );
  }

  if (diff.changes.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Nothing crossed a boundary between {diff.from} and {diff.to}. Readings moved, as they always do;
        none of them changed state.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-ink-faint">
        {diff.from} → {diff.to} · {diff.changes.length} state change
        {diff.changes.length === 1 ? "" : "s"}. Only crossings are listed; a reading drifting inside its
        own band is not news.
      </p>
      <ul className="flex flex-col gap-1.5">
        {diff.changes.map((c, i) => (
          <li key={`${c.kind}-${c.subject}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{KIND_LABEL[c.kind]}</span>
            <span className="font-mono text-ink">{readable(c.subject)}</span>
            <span className="text-ink-muted">{phrase(c)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
