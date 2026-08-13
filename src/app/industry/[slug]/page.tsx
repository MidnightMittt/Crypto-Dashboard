import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IndustryRead,
  describeIndustry,
  breadthDivergence,
  HORIZON_NOTE,
} from "@/lib/markets/industryIntelligence";
import { ROTATION_STATE_LABEL, ROTATION_STATE_MEANING, RotationState } from "@/lib/markets/rotation";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { FreshnessBanner } from "@/components/intelligence/FreshnessBanner";
import snapshot from "@/data/marketIntelligence.json";

/**
 * ONE INDUSTRY, IN CONTEXT.
 *
 * The page the whole hierarchy exists to make possible. It reads top-down —
 * regime, then sector, then industry, then the companies inside it — so an
 * industry is never evaluated in isolation. A leading industry inside a
 * lagging sector during a risk-off tape is a specific and unusual situation,
 * and it takes all four levels on one screen to see it.
 *
 * Everything here is snapshot output. No scoring, no ranking and no narrative
 * is produced by this file.
 */

const data = snapshot as unknown as {
  generatedAt: number;
  regime: RegimeRead | null;
  industries: IndustryRead[];
};

export function generateStaticParams() {
  return data.industries.map((i) => ({ slug: i.slug }));
}

const STATE_TONE: Record<RotationState, string> = {
  improving: "text-success",
  leading: "text-cyan",
  weakening: "text-amber",
  lagging: "text-ink-faint",
};

const REGIME_TONE: Record<string, string> = {
  "risk-on": "text-success",
  "risk-off": "text-danger",
  mixed: "text-amber",
};

export default async function IndustryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const industry = data.industries.find((i) => i.slug === slug);
  if (!industry) notFound();

  const regime = data.regime;
  const divergence = breadthDivergence(industry);
  const leading = industry.constituents.filter((c) => c.rotation.state === "leading");
  const emerging = industry.constituents.filter((c) => c.rotation.state === "improving");
  const weakening = industry.constituents.filter((c) => c.rotation.state === "weakening");
  const lagging = industry.constituents.filter((c) => c.rotation.state === "lagging");

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">{industry.name}</h1>
            <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
              {industry.etf} · {industry.sectorName}
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/industries" className="hover:text-ink">
              ← Industries
            </Link>
            <Link href="/" className="hover:text-ink">
              Intelligence
            </Link>
          </nav>
        </div>

        <FreshnessBanner generatedAt={data.generatedAt} />

        {/* ── THE INHERITANCE CHAIN, top-down ────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-4 shadow-glass backdrop-blur-xs sm:px-6">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Context, top-down
          </h2>
          <div className="mt-3 flex flex-wrap items-stretch gap-2">
            <ChainLink
              level="Risk regime"
              value={regime ? regime.regime.replace("-", "-").toUpperCase() : "unknown"}
              tone={regime ? REGIME_TONE[regime.regime] : "text-ink-faint"}
              detail={regime ? `${regime.agreeing} of ${regime.total} pairs` : "no pair could be evaluated"}
            />
            <Arrow />
            <ChainLink
              level="Sector"
              value={industry.sectorName}
              tone={industry.sectorState ? STATE_TONE[industry.sectorState] : "text-ink-faint"}
              detail={
                industry.sectorState
                  ? `${ROTATION_STATE_LABEL[industry.sectorState]}${
                      industry.sectorShortRelPct !== null
                        ? ` · ${fmt(industry.sectorShortRelPct)} 1m`
                        : ""
                    }`
                  : "not on the sector board"
              }
            />
            <Arrow />
            <ChainLink
              level="Industry"
              value={industry.name}
              tone={STATE_TONE[industry.rotation.state]}
              detail={`${ROTATION_STATE_LABEL[industry.rotation.state]} · ${fmt(industry.rotation.shortRelPct)} 1m`}
              emphasis
            />
            <Arrow />
            <ChainLink
              level="Companies"
              value={`${industry.measured} measured`}
              tone="text-ink"
              detail={industry.breadthPct === null ? "breadth unknown" : `${industry.breadthPct}% beating the index`}
            />
          </div>
        </section>

        {/* ── THE READ ───────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 shadow-glass backdrop-blur-xs sm:px-6">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className={`text-3xl font-bold uppercase leading-none ${STATE_TONE[industry.rotation.state]}`}>
              {ROTATION_STATE_LABEL[industry.rotation.state]}
            </span>
            <span className="font-mono text-sm text-ink">
              {fmt(industry.rotation.shortRelPct)} <span className="text-[10px] text-ink-faint">1 month</span>
            </span>
            <span className="font-mono text-sm text-ink-muted">
              {fmt(industry.rotation.longRelPct)} <span className="text-[10px] text-ink-faint">6 months</span>
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            {ROTATION_STATE_MEANING[industry.rotation.state]}
          </p>
          <p className="mt-3 max-w-4xl text-[14px] leading-relaxed text-ink">{describeIndustry(industry)}</p>

          {divergence && (
            <p className="mt-3 rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
              <span className="font-semibold uppercase tracking-[0.12em] text-amber">Divergence</span> ·{" "}
              {divergence}
            </p>
          )}

          <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Proxy · </span>
            {industry.proxyNote}
          </p>
        </section>

        {/* ── THE COMPANIES ──────────────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 shadow-glass backdrop-blur-xs sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Companies inside this industry
            </h2>
            <span className="font-mono text-[10px] text-ink-faint">
              {industry.measured} measured, ranked by 1-month relative strength
            </span>
          </div>

          {industry.constituents.length === 0 ? (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
              No constituent has enough price history to measure. The industry read above stands on the
              ETF alone.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <NameColumn title="Leading" tone="text-cyan" note="Ahead on both horizons" rows={leading} />
              <NameColumn title="Emerging" tone="text-success" note="Turning up against six months" rows={emerging} />
              <NameColumn title="Weakening" tone="text-amber" note="Rolling over against six months" rows={weakening} />
              <NameColumn title="Lagging" tone="text-ink-faint" note="Behind on both" rows={lagging} />
            </div>
          )}

          <p className="mt-4 border-t border-hairline pt-3 text-[10px] leading-relaxed text-ink-faint">
            These are RELATIVE STRENGTH reads, not decision-engine verdicts. The decision engine scores an
            instrument on breadth, credit, positioning and structure — inputs that exist at index level and
            not per company in this dataset. Calling these &quot;bullish&quot; would borrow authority the
            evidence here does not support. What they are is exact: each name&apos;s return minus the
            S&amp;P&apos;s, on the same two windows as every other level. {HORIZON_NOTE} An{" "}
            <span className="font-semibold text-amber">ER</span> tag means the name reports earnings within
            the next three sessions — the same window the trade-plan engine refuses plans for, because a
            stop is meaningless across a gap.
          </p>
        </section>
      </main>
    </div>
  );
}

function ChainLink({
  level,
  value,
  tone,
  detail,
  emphasis,
}: {
  level: string;
  value: string;
  tone: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`min-w-[140px] flex-1 rounded-md border px-3 py-2 ${
        emphasis ? "border-cyan/30 bg-cyan/[0.04]" : "border-hairline bg-void/40"
      }`}
    >
      <div className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{level}</div>
      <div className={`mt-0.5 text-[13px] font-semibold ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[10px] leading-relaxed text-ink-muted">{detail}</div>
    </div>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="hidden self-center text-ink-faint sm:inline">
      →
    </span>
  );
}

function NameColumn({
  title,
  tone,
  note,
  rows,
}: {
  title: string;
  tone: string;
  note: string;
  rows: Array<{
    symbol: string;
    rotation: { shortRelPct: number; longRelPct: number };
    earnings?: { date: string; sessions: number } | null;
  }>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="border-b border-hairline pb-1.5">
        <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${tone}`}>{title}</span>
        <div className="text-[9px] uppercase tracking-[0.1em] text-ink-faint">{note}</div>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-ink-faint">None.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((c) => (
            <li key={c.symbol} className="flex items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-1.5 font-mono text-[12px] text-ink">
                {c.symbol}
                {c.earnings && (
                  // Same window, same function as the trade-plan veto — a
                  // pre-event read is true but acting on it means holding
                  // through a gap.
                  <span
                    className="text-[9px] font-semibold uppercase tracking-[0.08em] text-amber"
                    title={`Reports earnings ${c.earnings.date} — ${
                      c.earnings.sessions === 0 ? "today" : `${c.earnings.sessions} session(s) away`
                    }. Inside the event window the trade-plan engine refuses plans for.`}
                  >
                    ER {c.earnings.sessions === 0 ? "today" : `${c.earnings.sessions}d`}
                  </span>
                )}
              </span>
              <span className="flex items-baseline gap-2 font-mono text-[10px]">
                <span className={c.rotation.shortRelPct >= 0 ? "text-success" : "text-danger"}>
                  {fmt(c.rotation.shortRelPct)}
                </span>
                <span className="text-ink-faint">{fmt(c.rotation.longRelPct)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
