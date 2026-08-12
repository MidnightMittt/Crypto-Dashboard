import Link from "next/link";
import { RotationBoard } from "@/components/intelligence/RotationBoard";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { Collapsible } from "@/components/ui/Collapsible";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { RotationRead } from "@/lib/markets/rotation";
import snapshot from "@/data/marketIntelligence.json";

/**
 * MARKET INTELLIGENCE — the top of the hierarchy, and now the front door.
 *
 * The reading order is the hierarchy itself: what regime are we in, where is
 * capital moving inside it, and only then which individual instruments are
 * worth acting on. Each level is context for the one below, which is why the
 * scanner now sits a level DOWN rather than being the landing page — a ranked
 * list of setups read without knowing the regime is a list of setups you
 * cannot size.
 *
 * ── What this page is not ─────────────────────────────────────────────
 *
 * Not a second engine. The regime pairs emit ordinary `MetricVerdict`s under
 * the same contract as funding, breadth and market structure, and are
 * rendered by the same `EvidenceModuleDetail` the asset pages use. Rotation
 * emits no verdict at all — it is a level provider in the sense the evidence
 * contract already defines, producing measurements that other things consume.
 *
 * Nothing on this page is ranked by hand. Every ordering falls out of a
 * subtraction between two price series.
 */

const data = snapshot as unknown as {
  generatedAt: number;
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  rotationNarrative: string | null;
};

export const metadata = { title: "Market Intelligence — Leverage Terminal" };

const REGIME_STYLE: Record<string, { tone: string; border: string; label: string }> = {
  "risk-on": { tone: "text-success", border: "border-success/25", label: "Risk-On" },
  "risk-off": { tone: "text-danger", border: "border-danger/25", label: "Risk-Off" },
  mixed: { tone: "text-amber", border: "border-amber/25", label: "Mixed" },
};

export default function MarketIntelligencePage() {
  const { regime, rotation, rotationNarrative } = data;
  const style = regime ? REGIME_STYLE[regime.regime] : null;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Market Intelligence</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              Regime · rotation · where capital is going
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/industries" className="hover:text-ink">
              Industries
            </Link>
            <Link href="/scanner" className="hover:text-ink">
              Scanner
            </Link>
            <Link href="/markets" className="hover:text-ink">
              Markets
            </Link>
            <Link href="/crypto" className="hover:text-ink">
              Crypto
            </Link>
          </nav>
        </div>

        {/* ── LEVEL 1: THE REGIME ────────────────────────────────────────── */}
        {regime && style ? (
          <section className={`rounded-xl border ${style.border} bg-panel/60 px-5 py-6 shadow-glass backdrop-blur-xs sm:px-6`}>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Risk environment
            </h2>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className={`text-3xl font-bold uppercase leading-none tracking-[0.02em] sm:text-4xl ${style.tone}`}>
                {style.label}
              </span>
              <span className="font-mono text-[11px] text-ink-faint">
                {regime.agreeing} of {regime.total} independent pairs agree
              </span>
            </div>
            <p className="mt-3 max-w-4xl text-[14px] leading-relaxed text-ink">{regime.headline}</p>

            {/* The pairs themselves, at a glance, then in full on demand. */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {regime.metrics.map((m) => (
                <div key={m.id} className="rounded-md border border-hairline bg-void/40 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                      {m.label}
                    </span>
                    <span
                      className={`font-mono text-[10px] uppercase ${
                        m.verdict === "bullish"
                          ? "text-success"
                          : m.verdict === "bearish"
                            ? "text-danger"
                            : "text-ink-faint"
                      }`}
                    >
                      {m.verdict === "bullish" ? "risk-on" : m.verdict === "bearish" ? "risk-off" : "flat"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{m.explanation}</p>
                  <p className="mt-1 font-mono text-[9px] text-ink-faint">confidence {m.confidence}%</p>
                </div>
              ))}
            </div>

            <div className="mt-4 border-t border-hairline pt-3">
              <Collapsible
                title="How each pair is measured"
                summary="ratios, both horizons, and what would flip them"
              >
                <ul className="flex flex-col gap-5">
                  {regime.metrics.map((m) => (
                    <li key={m.id} className="border-l border-hairline pl-4">
                      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink">
                        {m.label}
                      </h3>
                      <EvidenceModuleDetail metric={m} allMetrics={regime.metrics} />
                    </li>
                  ))}
                </ul>
              </Collapsible>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-6">
            <p className="text-[13px] leading-relaxed text-ink">
              No risk pair could be evaluated. This means the underlying series are missing, not that the
              market has no appetite signal — an outage, not a reading.
            </p>
          </section>
        )}

        {/* ── LEVEL 2: WHERE CAPITAL IS MOVING ───────────────────────────── */}
        {rotation ? (
          <RotationBoard read={rotation} narrative={rotationNarrative} />
        ) : (
          <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-6">
            <p className="text-[13px] leading-relaxed text-ink">
              Rotation could not be built — the benchmark series is too short to measure anything against.
            </p>
          </section>
        )}

        {/* ── LEVEL 3: INDUSTRIES ────────────────────────────────────────── */}
        <Link
          href="/industries"
          className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-panel/60 px-5 py-4 shadow-glass backdrop-blur-xs transition-colors hover:border-cyan/40 sm:px-6"
        >
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Next level down
            </span>
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              Industries, with breadth —{" "}
              <span className="text-ink-muted">
                whether a sector&apos;s move is the whole group or three names carrying it.
              </span>
            </p>
          </div>
          <span className="text-[11px] uppercase tracking-[0.16em] text-cyan group-hover:underline">
            Open industries →
          </span>
        </Link>

        {/* ── LEVEL 4: DOWN TO INSTRUMENTS ───────────────────────────────── */}
        <Link
          href="/scanner"
          className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-panel/60 px-5 py-4 shadow-glass backdrop-blur-xs transition-colors hover:border-cyan/40 sm:px-6"
        >
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Next level down
            </span>
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              Individual instruments, ranked by the decision engine —{" "}
              <span className="text-ink-muted">
                read them against the regime above, not on their own.
              </span>
            </p>
          </div>
          <span className="text-[11px] uppercase tracking-[0.16em] text-cyan group-hover:underline">
            Open scanner →
          </span>
        </Link>

        <p className="text-[10px] leading-relaxed text-ink-faint">
          Daily closes through {new Date(data.generatedAt).toISOString().slice(0, 10)}. Regime pairs and
          sector relatives are computed from adjusted daily bars and rebuilt with the snapshot; they do
          not move intraday. Not financial advice.
        </p>
      </main>
    </div>
  );
}
