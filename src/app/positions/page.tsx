import { Metadata } from "next";
import Link from "next/link";
import { buildBookCards, PositionCardV2 } from "@/lib/positions/cards";
import { loadReads, readsById } from "@/lib/positions/readsStore";

/**
 * /positions — THE POSITION CONSOLE.
 *
 * Not a screener. One page answering, continuously: is each thing owned
 * still doing what it was bought for, and what breaks first? Built for the
 * measured failure mode — both of the fortnight's losses were broken exits
 * on positions already held, while a working screener looked on.
 *
 * The acceptance test, verbatim from the brief: two LPs with near-identical
 * sigma and coverage of 0.29x vs 4.23x — "if the console cannot make that
 * difference obvious at a glance, it is not built yet."
 */

export const metadata: Metadata = {
  title: "Positions · Leverage Terminal",
  description: "Every position held, its thesis, and what breaks first.",
};

export const dynamic = "force-dynamic";

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d);

function stateColor(c: PositionCardV2): string {
  if (c.theses.some((t) => t.state === "broken")) return "text-danger border-danger/40 bg-danger/[0.05]";
  if (c.theses.some((t) => t.state === "breaking")) return "text-amber border-amber/40 bg-amber/[0.05]";
  return "text-ink border-hairline bg-panel";
}

function CoverageBlock({ c }: { c: PositionCardV2 }) {
  if (!c.lp) return null;
  const cov = c.lp.coverage;
  const big =
    cov === null ? "—" : `${fmt(cov, cov !== null && cov < 1 ? 2 : 1)}x`;
  const color = cov === null ? "text-ink-faint" : cov < 1 ? "text-danger" : cov < 1.5 ? "text-amber" : "text-success";
  return (
    <div className="flex flex-col items-end">
      <span className={`font-mono text-3xl font-bold tabular-nums ${color}`}>{big}</span>
      <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">coverage = yield / LVR</span>
    </div>
  );
}

function LpRows({ c }: { c: PositionCardV2 }) {
  if (!c.lp) return null;
  const lp = c.lp;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3">
      <div>
        <dt className="text-ink-faint">tick · chain</dt>
        <dd className="font-mono tabular-nums">
          {Number.isNaN(lp.tick.value) ? "unreadable" : lp.tick.value}
          <span className={lp.inRange ? "text-success" : "text-danger"}> {lp.inRange ? "IN RANGE" : "OUT OF RANGE"}</span>
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">yield 6h-window · api</dt>
        <dd className="font-mono tabular-nums">
          {fmt(lp.yield.y6DailyPct)}%/day
          <span className="text-ink-faint"> (24h: {fmt(lp.yield.y24DailyPct)}%)</span>
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">decay y6/y24</dt>
        <dd className="font-mono tabular-nums">{fmt(lp.yield.decay)}</dd>
      </div>
      <div>
        <dt className="text-ink-faint">σ token-ratio · api</dt>
        <dd className="font-mono tabular-nums">
          {lp.sigmaDaily ? `${fmt(lp.sigmaDaily.value * 100, 1)}%/day over ${lp.sigmaDaily.windowHours}h` : "—"}
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">pool reserve · api</dt>
        <dd className="font-mono tabular-nums">{lp.reserveUsd ? `$${fmt(lp.reserveUsd.value, 0)}` : "—"}</dd>
      </div>
      <div>
        <dt className="text-ink-faint">basis · posted</dt>
        <dd className="font-mono tabular-nums">${String((c.posted as { basisUsd?: number }).basisUsd ?? "—")}</dd>
      </div>
    </dl>
  );
}

function Theses({ c }: { c: PositionCardV2 }) {
  if (!c.theses.length) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1">
      {c.theses.map((t) => (
        <li key={t.metric} className="flex items-baseline gap-2 text-[12px]">
          <span
            className={
              t.state === "broken"
                ? "font-semibold text-danger"
                : t.state === "breaking"
                  ? "font-semibold text-amber"
                  : t.state === "unmeasured"
                    ? "text-ink-faint"
                    : "text-success"
            }
          >
            {t.state === "broken" ? "✗ BROKEN" : t.state === "breaking" ? "⚠ 1 of 2" : t.state === "unmeasured" ? "? unmeasured" : "✓ ok"}
          </span>
          <span className="font-mono text-ink-muted">{t.rule}</span>
          <span className="font-mono tabular-nums text-ink">now {fmt(t.value)}</span>
          {t.brokenSince && <span className="text-danger">since {t.brokenSince.slice(0, 10)}</span>}
        </li>
      ))}
    </ul>
  );
}

export default async function PositionsPage() {
  const cards = await buildBookCards(readsById(loadReads()));
  const broken = cards.filter((c) => c.theses.some((t) => t.state === "broken"));

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Positions</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              is each thing owned still doing what it was bought for
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/trade" className="hover:text-ink">Trade desk</Link>
            <Link href="/validation" className="hover:text-ink">Validation</Link>
          </nav>
        </div>

        {broken.length > 0 && (
          <div className="rounded-md border border-danger/40 bg-danger/[0.06] px-4 py-3">
            <p className="text-[13px] font-semibold text-danger">
              {broken.length} thesis-broken position{broken.length === 1 ? "" : "s"} — the book&apos;s loudest fact:
            </p>
            <ul className="mt-1 text-[12px] text-ink-muted">
              {broken.map((b) => (
                <li key={b.id} className="font-mono">{b.label} — {b.headline}</li>
              ))}
            </ul>
          </div>
        )}

        {cards.map((c) => (
          <section key={c.id} className={`rounded-md border px-4 py-3 ${stateColor(c)}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-mono text-[14px] font-semibold">{c.label}</h2>
                <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{c.venue}</p>
                <p className="mt-1.5 text-[13px]">{c.headline}</p>
              </div>
              <CoverageBlock c={c} />
            </div>
            <LpRows c={c} />
            <Theses c={c} />
            {typeof c.posted.notes === "string" && (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{c.posted.notes}</p>
            )}
            {c.errors.length > 0 && (
              <ul className="mt-2 text-[11px] text-amber">
                {c.errors.map((e, i) => (
                  <li key={i}>read error: {e}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <p className="max-w-3xl text-[11px] leading-relaxed text-ink-faint">
          Theses break only on two consecutive reads, never one. Out-of-range LPs earn nothing
          regardless of pool volume, and their coverage says so. Every figure is labelled chain
          (read from the contract this request), api (GeckoTerminal), or posted (holder-supplied,
          dated). Rates always carry their window. Measurements, not instructions.
        </p>
      </main>
    </div>
  );
}
