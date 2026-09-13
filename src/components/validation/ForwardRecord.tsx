import {
  ForwardVerdictRecord,
  MIN_INDEPENDENT_BLOCKS,
  MIN_VERDICT_N,
  VerdictCell,
  countByEngine,
  countExpired,
  rankCellsByEdge,
} from "@/lib/research/forwardVerdict";
import { formatPct } from "@/lib/utils/format";

/**
 * THE ONLY CLAIM ON THIS SITE THAT WAS WRITTEN DOWN BEFORE THE OUTCOME.
 *
 * Everything else on /validation is a study. This is the register: every
 * directional word the pages published, stamped with the price at the time,
 * scored ten sessions later against the price that followed. Nobody chose
 * these rows after seeing how they turned out, and that is the entire
 * difference between this section and the lab at the bottom of the page.
 *
 * ── Rendered from the same functions /api/record serves ───────────────
 *
 * The cell ordering, the expired count and the per-engine tally come from
 * `rankCellsByEdge` / `countExpired` / `countByEngine` in the library, which
 * the route also calls. A page that sorted these cells its own way would be
 * a second opinion about which call did best, published beside the first.
 *
 * ── The empty state is the finding, not a missing component ───────────
 *
 * At the time of writing nothing has resolved: 1,192 calls are inside their
 * windows. A section that hid itself until it had numbers would make the
 * site look like it had never made a claim, when in fact it has made twelve
 * hundred and is waiting to be judged on them. So the emptiness renders,
 * loudly, with the count of what is pending and the date it stops being an
 * excuse.
 *
 * ── Numbers without a claim are shown; claims without evidence are not ─
 *
 * A cell with one independent period still prints its hit rate, because
 * hiding it would look like there was nothing to see. What it does NOT get
 * is a verdict: `claim` carries the refusal, the row is dimmed, and it sorts
 * below every publishable cell. On this panel calls made the same day run
 * rho near 0.8, so 279 bullish calls across one date are ONE observation —
 * which is why the legacy engine's 658 resolved rows support no claim at all.
 */

function Pct({ value, dim }: { value: number | null; dim?: boolean }) {
  if (value === null) return <span className="text-ink-faint">—</span>;
  return (
    <span className={dim ? "text-ink-muted" : value >= 0 ? "text-success" : "text-danger"}>
      {formatPct(value)}
    </span>
  );
}

function CellTable({ cells }: { cells: readonly VerdictCell[] }) {
  const ranked = rankCellsByEdge(cells);
  return (
    <div className="mt-3 space-y-2">
      {ranked.map((c) => (
        <div
          key={c.verdict}
          className={`rounded-md border border-hairline px-3 py-2.5 ${
            c.publishable ? "bg-surface/40" : "bg-transparent opacity-70"
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span
              className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${
                c.publishable ? "text-ink" : "text-ink-faint"
              }`}
            >
              {c.verdict}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">
              n={c.n} · independent n={c.independentN}
            </span>
            <span className="font-mono text-[12px]">
              edge <Pct value={c.edgeVsBaselinePct} dim={!c.publishable} />
            </span>
            <span className="font-mono text-[12px] text-ink-muted">
              mean <Pct value={c.meanReturnPct} dim={!c.publishable} /> · median{" "}
              <Pct value={c.medianReturnPct} dim={!c.publishable} />
            </span>
            <span className="font-mono text-[12px] text-ink-muted">
              hit {c.hitRatePct === null ? "—" : `${c.hitRatePct.toFixed(0)}%`}
            </span>
          </div>
          {/*
            The claim, always. A number on this page without the sentence
            saying what may be concluded from it gets read as a conclusion.
          */}
          <p
            className={`mt-1.5 text-[11px] leading-relaxed ${
              c.publishable ? "text-ink-muted" : "text-amber"
            }`}
          >
            {c.claim}
          </p>
        </div>
      ))}
    </div>
  );
}

export function ForwardRecord({ record }: { record: ForwardVerdictRecord }) {
  const expired = countExpired(record.predictions);
  const byEngine = countByEngine(record.predictions);
  const engine = record.engine ?? 1;
  const legacy = record.legacy ?? null;

  return (
    <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink">
          Forward verdict register — the site&rsquo;s own published word
        </h2>
        <span className="font-mono text-[11px] text-ink-faint">
          engine {engine} · {record.horizonSessions}-session horizon
        </span>
      </div>

      <p className="mt-2 text-2xl font-bold leading-tight text-ink">
        {record.finding ?? "This record predates the finding field."}
      </p>

      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Every directional call the pages published, written down with the price at the time and
        scored {record.horizonSessions} sessions later against the price that followed. No row was
        chosen after its outcome was known, which is what separates this from the backtest at the
        bottom of the page — and why an empty register here is worth more than a full one there.
      </p>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-ink-muted">
        <span>
          <span className="text-ink">{record.totals.resolved.toLocaleString()}</span> resolved
        </span>
        <span>
          <span className="text-ink">{record.totals.open.toLocaleString()}</span> still inside their
          window
        </span>
        {expired > 0 && (
          <span>
            <span className="text-amber">{expired.toLocaleString()}</span> expired — the symbol left
            the data set and they can never resolve
          </span>
        )}
        <span className="text-ink-faint">
          registered by engine:{" "}
          {Object.entries(byEngine)
            .map(([e, n]) => `${e} → ${n.toLocaleString()}`)
            .join(", ")}
        </span>
      </div>

      {record.cells.length > 0 ? (
        <CellTable cells={record.cells} />
      ) : (
        <p className="mt-3 rounded-md border border-hairline bg-surface/40 px-3 py-2.5 text-[12px] leading-relaxed text-ink-muted">
          No cell publishes yet. A verdict is summarised only at {MIN_VERDICT_N} resolved calls and{" "}
          {MIN_INDEPENDENT_BLOCKS} independent periods — calls made on the same day are
          cross-correlated on this panel (rho near 0.8) and windows inside{" "}
          {record.horizonSessions} sessions of each other overlap, so a large-looking sample across
          two dates is one observation wearing a large sample&rsquo;s clothes.
        </p>
      )}

      {(record.cannotYetAnswer?.length ?? 0) > 0 && (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            What this cannot answer yet
          </p>
          <ul className="mt-1.5 space-y-1">
            {record.cannotYetAnswer!.map((line) => (
              <li key={line} className="flex gap-2 text-[12px] leading-relaxed text-ink-muted">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-faint" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        The retired engine, kept and labelled rather than deleted or merged.
        Deleting it would discard 658 real resolutions; merging it into the
        headline would credit the current engine with the record of a
        computation it does not perform. Both were tempting and both are wrong.
      */}
      {legacy && (
        <details className="mt-4 rounded-md border border-hairline bg-transparent px-3 py-2.5">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Engine {legacy.engine}, retired — {legacy.totals.resolved.toLocaleString()} resolved
            calls that are not this engine&rsquo;s record
          </summary>
          <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-ink-muted">{legacy.note}</p>
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            cohort baseline{" "}
            {legacy.baselineReturnPct === null ? "—" : formatPct(legacy.baselineReturnPct)} · market
            baseline{" "}
            {legacy.marketBaselineReturnPct == null
              ? "—"
              : formatPct(legacy.marketBaselineReturnPct)}{" "}
            (mean SPY over the same windows)
          </p>
          <CellTable cells={legacy.cells} />
        </details>
      )}

      <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-ink-faint">
        Edge is measured against the COHORT baseline — this register&rsquo;s own resolved calls over
        the same windows, a mixed bullish/bearish/neutral set, not an index. The market baseline is
        mean SPY return over the same windows, carried separately so &ldquo;beat the register&rdquo;
        and &ldquo;rode the index&rdquo; never collapse into one number. Cells rank by expectancy,
        never by hit rate: on this account&rsquo;s own ledger a 91% hit rate returned +2.03% while a
        55% hit rate returned +9.99%. The same figures are served as JSON at{" "}
        <span className="font-mono">/api/record</span>.
      </p>
    </section>
  );
}
