import { MetricVerdict } from "@/lib/signals/types";
import { contributionOf } from "@/lib/signals/categories";

/**
 * ONE COMPONENT FOR THE WHOLE EVIDENCE CONTRACT.
 *
 * Renders any `MetricVerdict` in full: its verdict, what supports it, what
 * argues against it, the measurements behind it, why its confidence is what it
 * is, what would flip it, and how much of the composite it actually moved.
 *
 * Deliberately keyed to the CONTRACT, not to a module. There is no
 * `MarketStructureDetail` and there will be no `EarningsDetail` — the moment a
 * surface is written per-module, the twenty-fifth module needs a
 * twenty-fifth component and the pattern the contract exists to enforce is
 * gone. Everything below reads a field that every module already declares.
 *
 * It also closes a real gap: `evidenceFor` and `supporting` were added to the
 * contract and populated by the reference module, and until now NOTHING
 * rendered them. A field no surface reads is a field that quietly rots.
 *
 * ── The one rule this component follows ───────────────────────────────
 *
 * It interprets nothing. Contribution comes from `contributionOf`, because
 * a module's share depends on which OTHER modules reported and only the
 * engine can see that. Everything else is a string the module wrote. If this
 * component ever needs to compute a number to display it, that number belongs
 * in the module's `supporting` array instead.
 */
export function EvidenceModuleDetail({
  metric,
  allMetrics,
}: {
  metric: MetricVerdict;
  /** The full set that reported, so contribution can be derived rather than declared. */
  allMetrics: MetricVerdict[];
}) {
  const { sharePct } = contributionOf(metric, allMetrics);
  const tone =
    metric.verdict === "bullish"
      ? "text-success"
      : metric.verdict === "bearish"
        ? "text-danger"
        : "text-ink-muted";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-sm font-semibold uppercase tracking-[0.06em] ${tone}`}>
          {metric.verdict}
        </span>
        <span className="text-[11px] text-ink-faint">
          Confidence {metric.confidence}% · {sharePct}% of the composite&apos;s evidence weight
        </span>
      </div>

      <p className="text-[13px] leading-relaxed text-ink">{metric.explanation}</p>

      {(metric.evidenceFor?.length || metric.conflicts.length) > 0 && (
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <ClaimList
            title="What supports this"
            mark="✓"
            markClass="text-success"
            items={metric.evidenceFor ?? []}
            /*
             * THREE STATES, not two, and collapsing them misreports the module.
             *
             *  - field ABSENT: the module predates `evidenceFor` and states its
             *    support as prose in `explanation`, already rendered above.
             *  - field PRESENT BUT EMPTY on a neutral verdict: deliberate. A
             *    neutral read's findings ARE the disagreement, and those are in
             *    `conflicts`. Padding it with observations would make an absence
             *    of structure look like a body of evidence.
             *  - field present but empty on a DIRECTIONAL verdict: a genuine
             *    gap in that module, and worth saying so plainly.
             *
             * `?? []` alone would have printed "does not itemise its support"
             * under the reference module, which itemises meticulously.
             */
            empty={
              metric.evidenceFor === undefined
                ? "Stated in the reading above; this module does not itemise its support."
                : metric.verdict === "neutral"
                  ? "Nothing — and that is the finding. A neutral reading has no support to list; what it has is the disagreement on the right."
                  : "This module states a direction without itemising what supports it."
            }
          />
          <ClaimList
            title="What argues against it"
            mark="✕"
            markClass="text-danger"
            items={metric.conflicts}
            empty="Nothing in this module's own inputs contradicts it."
          />
        </div>
      )}

      {metric.supporting && metric.supporting.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-hairline pt-3 sm:grid-cols-3 lg:grid-cols-4">
          {metric.supporting.map((s) => (
            <div key={s.label}>
              <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{s.label}</dt>
              <dd className="mt-0.5 font-mono text-xs text-ink">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-col gap-1.5 border-t border-hairline pt-3 text-[11px] leading-relaxed">
        <p className="text-ink-faint">
          <span className="text-ink-muted">Why this confidence · </span>
          {metric.confidenceBasis}
        </p>
        {metric.nextTrigger && (
          <p className="text-ink-faint">
            <span className="text-ink-muted">What would change it · </span>
            This reading {metric.nextTrigger}.
          </p>
        )}
        <p className="text-ink-faint">
          <span className="text-ink-muted">Why it matters · </span>
          {metric.whyItMatters}
        </p>
      </div>
    </div>
  );
}

function ClaimList({
  title,
  mark,
  markClass,
  items,
  empty,
}: {
  title: string;
  mark: string;
  markClass: string;
  items: string[];
  empty: string;
}) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {items.map((claim) => (
            <li key={claim} className="flex items-start gap-2 text-xs leading-relaxed text-ink">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span>{claim}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
