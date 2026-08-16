import Link from "next/link";
import { Outcome, buildValidationReport } from "@/lib/validation/buildValidationReport";
import labJson from "@/data/signalValidation.json";
import metricStats from "@/data/backtestMetricStats.json";

/**
 * THE AUDIT — every signal measured, including the ones that failed.
 *
 * Roadmap Phase 3's exit criterion, and built BEFORE the next wave of
 * signals: a platform that cannot show its existing failures has no business
 * adding candidates.
 *
 * The headline number is deliberately unflattering. Competitors publish the
 * indicators that worked; the only durable thing here is the record that
 * includes the ones that did not — and a survival rate this low is what makes
 * the survivors worth anything.
 */

export const metadata = { title: "Validation — Leverage Terminal" };

const report = buildValidationReport({
  lab: labJson as Parameters<typeof buildValidationReport>[0]["lab"],
  moduleGrades: metricStats.moduleGrades as Parameters<typeof buildValidationReport>[0]["moduleGrades"],
});

const GROUPS: Array<{ outcome: Outcome; title: string; blurb: string; tone: string }> = [
  {
    outcome: "cleared",
    title: "Cleared the bar",
    tone: "text-success",
    blurb:
      "Beat its own baseline after costs AND survived correction for multiple testing. Clearing the bar is NOT the " +
      "same as being used: several of these are supporting variants of the one that ships, and one is explicitly " +
      "withheld. The rows marked IN USE are the only results anything on this site actually reads.",
  },
  {
    outcome: "below",
    title: "Measured worse than its own null",
    tone: "text-danger",
    blurb:
      "Not merely unproven — these read BELOW the baseline they were tested against. That is the strongest kind of " +
      "negative result and the most useful, because it says the intuition points the wrong way rather than nowhere.",
  },
  {
    outcome: "indistinct",
    title: "Cannot be told apart from chance",
    tone: "text-amber",
    blurb:
      "Measured honestly and came back inside the noise. Some are significant before costs and stop being so after " +
      "them, which is the distinction between detectable and tradeable.",
  },
  {
    outcome: "unmeasured",
    title: "Never measured",
    tone: "text-ink-faint",
    blurb:
      "No historical source exists to test these against, so no verdict is claimed. This is a statement about OUR " +
      "data, not about the signal — they are displayed as context and are never permitted to vote.",
  },
];

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

export default function ValidationPage() {
  const survival = report.totals.measured > 0 ? (report.totals.cleared / report.totals.measured) * 100 : 0;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1000px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Validation</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              Every signal measured · failures included
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/" className="hover:text-ink">
              ← Brief
            </Link>
            <Link href="/intelligence" className="hover:text-ink">
              Intelligence
            </Link>
          </nav>
        </div>

        <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 sm:px-6">
          <p className="text-2xl font-bold leading-tight text-ink">
            {report.totals.cleared} of {report.totals.measured} measured signals clear their own bar.
          </p>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
            That is a {survival.toFixed(0)}% survival rate, and it is the point rather than an apology. Anyone can
            publish the indicators that worked. The record below includes every one that did not, with the criteria
            that would have killed it written down before it was run — which is the only reason the survivors are
            worth anything.
          </p>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            The equity study corrected across all {report.equityFamilySize} declared hypotheses at once on{" "}
            {report.equityInstruments} instruments, charging {report.costPp}pp of costs to every one. Correcting only
            across survivors would undo the correction. A further {report.totals.unmeasured} modules have never been
            measured at all and are listed at the bottom rather than quietly omitted.
          </p>
        </section>

        {GROUPS.map((group) => {
          const rows = report.rows.filter((r) => r.outcome === group.outcome);
          if (rows.length === 0) return null;
          return (
            <section key={group.outcome} className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className={`text-[13px] font-semibold uppercase tracking-[0.14em] ${group.tone}`}>
                  {group.title}
                </h2>
                <span className="font-mono text-[11px] text-ink-faint">{rows.length}</span>
              </div>
              <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">{group.blurb}</p>

              <ul className="mt-3 flex flex-col divide-y divide-hairline">
                {rows.map((r) => (
                  <li key={`${r.family}-${r.id}`} className="flex flex-col gap-1.5 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono text-[13px] text-ink">{r.id}</span>
                      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{r.family}</span>
                      {r.inUse && (
                        <span className="rounded border border-success/30 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-success">
                          in use
                        </span>
                      )}
                      {r.retiredBy && (
                        <span className="rounded border border-amber/25 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-amber">
                          retired by {r.retiredBy}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ink-muted">
                      <span>
                        <span className="text-ink-faint">win</span> {pct(r.winRatePct)}
                      </span>
                      <span>
                        <span className="text-ink-faint">95% floor</span> {pct(r.lowerBoundPct)}
                      </span>
                      <span>
                        <span className="text-ink-faint">n</span> {r.n ?? "—"}
                      </span>
                      <span>
                        <span className="text-ink-faint">FDR</span> {r.survivesFdr ? "survives" : "no"}
                      </span>
                    </div>

                    {r.sentence && (
                      <p className="text-[11px] leading-relaxed text-ink-muted">{r.sentence}</p>
                    )}

                    {/* Louder than the verdict, because it outranks it. */}
                    {r.caution && (
                      <p className="rounded-md border border-amber/25 bg-amber/[0.04] px-3 py-2 text-[11px] leading-relaxed text-ink">
                        <span className="font-semibold uppercase tracking-[0.12em] text-amber">Caution</span> ·{" "}
                        {r.caution}
                      </p>
                    )}

                    {r.killCriteria && (
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        <span className="text-ink-muted">Declared before the run ·</span> {r.killCriteria}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Survivorship runs against every equity result here: the panel is today&rsquo;s instrument list, so names
          that failed and delisted are absent, which flatters a buy-the-winners finding. Treat the printed spreads as
          ceilings. Costs are charged as a flat {report.costPp}pp of win rate rather than modelled per leg, which is
          conservative for the monthly hypotheses and arguably light for the weekly ones.
        </p>
      </main>
    </div>
  );
}
