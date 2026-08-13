import Link from "next/link";
import {
  RankedOpportunity,
  RankingComparison,
  ACTIONABLE_OPPORTUNITY,
} from "@/lib/signals/opportunityRanking";
import { intensityLabel } from "@/lib/signals/scoring";
import { hrefFor, verdictTone, RISK_TONE } from "./shared";

/**
 * THE ANSWER, BEFORE THE TABLE.
 *
 * A ranked list makes the reader do the ranking again. This card states the
 * conclusion the engine already reached — what the best opportunity is, what
 * the trade would be, how confident it is, how risky, and why it beat the
 * runner-up — so that a user who reads nothing else has still been told the
 * one thing they came for.
 *
 * Every value is engine output. The only thing assembled here is the reading
 * order.
 */
export function TopOpportunity({
  lead,
  runnerUp,
  comparison,
  totalMarkets,
}: {
  lead: RankedOpportunity;
  runnerUp: RankedOpportunity | null;
  comparison: RankingComparison | null;
  totalMarkets: number;
}) {
  const actionable = lead.opportunity >= ACTIONABLE_OPPORTUNITY;

  if (!actionable) {
    return (
      <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-6 shadow-glass backdrop-blur-xs">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Best available
        </h2>
        <p className="mt-2 text-lg font-semibold leading-snug text-ink">
          Nothing in {totalMarkets} markets clears the bar today.
        </p>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
          The strongest read is {lead.asset} at {lead.opportunity}/100, which is below the level
          where the engine will call something an opportunity. Every tracked market is either near
          the fence or thinly evidenced. That is a reason to wait, not a reason to look harder — and
          it is the answer, not a missing one.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-cyan/25 bg-panel/60 shadow-glass backdrop-blur-xs">
      <div className="flex flex-col gap-5 px-5 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
              Best opportunity now
            </h2>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={hrefFor(lead)}
                className="font-mono text-3xl font-bold leading-none text-ink hover:text-cyan sm:text-4xl"
              >
                {lead.asset}
              </Link>
              <span
                className={`text-lg font-bold uppercase leading-none tracking-[0.04em] ${verdictTone(lead.verdict)}`}
              >
                {intensityLabel(lead.score)}
              </span>
              {lead.name && <span className="text-[11px] text-ink-faint">{lead.name}</span>}
            </div>
          </div>

          {/* The three numbers a PM asks for in order, at a size that reads across a room. */}
          <dl className="flex shrink-0 gap-6">
            <HeroStat label="Opportunity" value={`${lead.opportunity}`} suffix="/100" tone="text-cyan" />
            <HeroStat label="Data Quality" value={`${lead.confidence}%`} />
            <HeroStat
              label="Risk"
              value={lead.riskLevel ?? "—"}
              tone={lead.riskLevel ? RISK_TONE[lead.riskLevel] : undefined}
              uppercase
            />
          </dl>
        </div>

        <p className="max-w-3xl text-[14px] leading-relaxed text-ink">{lead.headline}</p>

        {lead.setup ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-hairline bg-void/40 px-4 py-3">
            <span
              className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${
                lead.setup.state === "active" ? "text-cyan" : "text-ink-muted"
              }`}
            >
              {lead.setup.state === "active" ? "Trade is live" : "Waiting for a level"}
            </span>
            <Stat label="Side" value={lead.setup.direction} />
            <Stat label="Reward / risk" value={`${lead.setup.riskReward.toFixed(2)}R`} />
            <Stat label="Quality" value={`${"★".repeat(lead.setup.stars)}${"☆".repeat(5 - lead.setup.stars)}`} />
            <Stat label="Status" value={lead.setup.status.replace(/-/g, " ")} />
            <Link
              href={hrefFor(lead)}
              className="ml-auto text-[11px] uppercase tracking-[0.14em] text-cyan hover:underline"
            >
              Full plan →
            </Link>
          </div>
        ) : (
          <p className="rounded-md border border-hairline bg-void/40 px-4 py-3 text-[12px] leading-relaxed text-ink-muted">
            <span className="font-semibold uppercase tracking-[0.12em] text-ink-faint">No plan yet</span> ·
            The read is strong enough to rank first, but structure has not produced a placeable stop
            and target. This is a market to watch, not one to enter.
          </p>
        )}

        {(lead.reasonsFor?.length || lead.reasonsAgainst?.length) && (
          <div className="grid grid-cols-1 gap-x-10 gap-y-4 sm:grid-cols-2">
            <ReasonList title="Why" mark="✓" markClass="text-success" items={lead.reasonsFor ?? []} />
            <ReasonList
              title="What argues against it"
              mark="✕"
              markClass="text-danger"
              items={lead.reasonsAgainst ?? []}
              empty="Nothing material argues the other way — which is itself unusual, and worth treating with suspicion rather than comfort."
            />
          </div>
        )}

        {/* THE DIFFERENTIATOR. Ranked lists never explain themselves. */}
        {comparison && runnerUp && (
          <div className="border-t border-hairline pt-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
              Why {comparison.lead} and not {comparison.rival}?
            </h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink">{comparison.summary}</p>
            <div className="mt-3 flex flex-col gap-2">
              {comparison.factors.map((f) => (
                <div key={f.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className="w-28 shrink-0 uppercase tracking-[0.12em] text-ink-faint">{f.label}</span>
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-hairline">
                    <span
                      className={`block h-full ${f.favoursLeader ? "bg-success" : "bg-danger"}`}
                      style={{ width: `${Math.min(100, Math.abs(f.sharePct))}%` }}
                    />
                  </span>
                  <span className={f.favoursLeader ? "text-success" : "text-danger"}>
                    {Math.abs(f.sharePct)}% of the gap
                  </span>
                  <span className="text-ink-muted">
                    {comparison.lead} {f.leadValue} vs {comparison.rival} {f.rivalValue}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2.5 text-[10px] leading-relaxed text-ink-faint">
              An exact split, not a narrative. Opportunity is conviction × evidence quality, so the
              gap between two markets decomposes into exactly these two terms — a red bar means that
              factor works AGAINST the leader and it ranks first in spite of it.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  suffix,
  tone = "text-ink",
  uppercase,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: string;
  uppercase?: boolean;
}) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-xl leading-none ${tone} ${uppercase ? "uppercase" : ""}`}>
        {value}
        {suffix && <span className="text-[11px] text-ink-faint">{suffix}</span>}
      </dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <span className="font-mono text-[12px] uppercase text-ink">{value}</span>
    </div>
  );
}

function ReasonList({
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
  empty?: string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{empty ?? "—"}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {items.map((r) => (
            <li key={r} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-muted">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
