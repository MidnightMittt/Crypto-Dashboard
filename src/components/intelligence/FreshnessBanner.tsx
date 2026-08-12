"use client";

import * as React from "react";

/**
 * THE FRESHNESS SLA — the terminal must never look live when it is not.
 *
 * Client component by necessity, not preference: snapshot pages are static,
 * so any server-side staleness check would compare the snapshot against the
 * BUILD's clock — which is the snapshot's own age, i.e. always fresh. Only
 * the viewer's clock can catch the failure mode that matters: the daily
 * pipeline stopped running and no rebuild has happened since.
 *
 * Renders nothing when fresh. When stale it does not soften: a trader
 * reading a three-day-old regime as today's is worse off than one reading
 * nothing, and the banner says so in those terms.
 *
 * 60 hours, not 36: the snapshot legitimately ages ~56h between Friday's
 * 22:15 UTC run and Monday morning, and a banner that cries every weekend
 * trains everyone to ignore it. One missed weekday run past a weekend still
 * fires; a missed mid-week run fires ~36h after the data date.
 */
const STALE_AFTER_MS = 60 * 60 * 60 * 1000;

export function FreshnessBanner({ generatedAt }: { generatedAt: number }) {
  // Computed in effect so the server render (always "fresh" by construction)
  // matches initial hydration; the check runs on the viewer's clock after.
  const [staleHours, setStaleHours] = React.useState<number | null>(null);

  React.useEffect(() => {
    const check = () => {
      const age = Date.now() - generatedAt;
      setStaleHours(age > STALE_AFTER_MS ? Math.floor(age / 3_600_000) : null);
    };
    check();
    const id = setInterval(check, 5 * 60_000);
    return () => clearInterval(id);
  }, [generatedAt]);

  if (staleHours === null) return null;

  return (
    <div
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-[12px] leading-relaxed text-ink"
    >
      <span className="font-semibold uppercase tracking-[0.12em] text-danger">Stale data</span> · This
      snapshot is {staleHours} hours old — the daily pipeline has not run since{" "}
      {new Date(generatedAt).toISOString().slice(0, 10)}. Every regime, rotation and breadth reading
      below describes that session, not today&apos;s. Treat nothing on this page as current.
    </div>
  );
}
