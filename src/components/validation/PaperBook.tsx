import { Badge } from "@/components/ui/Badge";
import {
  Measured,
  PaperBook as Book,
  PaperBookLine,
  PaperSegment,
  bp,
  bpAbs,
} from "@/lib/validation/paperBook";

/**
 * THE REGISTER, RENDERED — and the ladder it sits on.
 *
 * `paperLines.json` was regenerated nightly for weeks and read by nothing.
 * This is its surface, and the layout is an argument rather than a table:
 *
 *   THE BIG NUMBER IS THE UNTRUSTWORTHY ONE. The backtest column carries
 *   n=299 and t=2.00 and is deliberately the muted half. The paper column
 *   carries n=18 and cannot conclude anything, and is the emphasised half.
 *   Every instinct in dashboard design points the other way, which is exactly
 *   why the page has to push back — a reader scanning for the largest,
 *   greenest figure will find the sample the strategy was chosen on.
 *
 * Two rules hold everywhere below:
 *
 *   ONE UNIT. Basis points, for everything in return space. The signal lab's
 *   win rates are a different space and are not converted; a win rate has no
 *   basis-point value without a payoff distribution.
 *
 *   n TRAVELS WITH THE NUMBER. Every figure renders its sample size in the
 *   adjacent column. The `Measured` type makes an unpinned statistic fail to
 *   compile, and `Stat` makes it fail to render.
 */

function Stat({
  label,
  value,
  tone = "text-ink",
  hint,
}: {
  label: string;
  /** Null renders an em-dash with NO sample size — an absent number has none. */
  value: Measured | null;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 font-mono text-[11px]">
      <span className="w-[68px] shrink-0 text-ink-faint">{label}</span>
      <span className={`w-[74px] shrink-0 text-right ${value ? tone : "text-ink-faint"}`}>
        {value ? hint ?? bp(value.bp) : "—"}
      </span>
      <span className="text-ink-faint">{value ? `n=${value.n}` : ""}</span>
    </div>
  );
}

/**
 * A t-statistic beside its sample size.
 *
 * Rendered through the same three-column grid as the basis-point figures so a
 * reader's eye does not have to change gear, and so t can never appear without
 * the n it was computed from — which is the whole content of a t.
 */
function TStat({ t, n, tone }: { t: number | null; n: number; tone: string }) {
  return (
    <div className="flex items-baseline gap-2 font-mono text-[11px]">
      <span className="w-[68px] shrink-0 text-ink-faint">t</span>
      <span className={`w-[74px] shrink-0 text-right ${t === null ? "text-ink-faint" : tone}`}>
        {t === null ? "—" : `${t >= 0 ? "+" : ""}${t.toFixed(2)}`}
      </span>
      <span className="text-ink-faint">{t === null ? "" : `n=${n}`}</span>
    </div>
  );
}

/**
 * The tone a segment's headline number is allowed to take.
 *
 * `clears` is the ONLY case that gets a colour, and it gets amber rather than
 * green: reaching t=3 is a statement about a sample, not a licence to trade,
 * and green is the colour a reader reads as permission.
 */
function toneFor(seg: PaperSegment): string {
  if (seg.power === "clears") return "text-amber";
  return "text-ink-muted";
}

function Segment({ seg, emphasised }: { seg: PaperSegment; emphasised: boolean }) {
  const tone = toneFor(seg);
  return (
    <div
      className={
        emphasised
          ? "rounded-md border border-line/60 bg-surface/50 px-3 py-2.5"
          : "rounded-md border border-hairline bg-transparent px-3 py-2.5 opacity-75"
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span
          className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
            emphasised ? "text-ink" : "text-ink-faint"
          }`}
        >
          {seg.key === "full" ? "Backtest — chose the strategy" : "Paper — tests it"}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">
          {seg.firstDate ? `${seg.firstDate} → ${seg.lastDate}` : "no sessions"}
        </span>
      </div>

      <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">{seg.label}</p>

      <div className="mt-2 flex flex-col gap-0.5">
        <Stat label="net" value={seg.net} tone={tone} />
        <TStat t={seg.tStat} n={seg.n} tone={tone} />
        {/*
          The power line, directly under the t it qualifies. A mean smaller
          than this is a sample that could not have seen the effect, and
          reading it as "no effect" is the single most common misuse of a
          small record.
        */}
        <Stat
          label="resolves ≥"
          value={seg.detectable}
          hint={seg.detectable ? bpAbs(seg.detectable.bp) : undefined}
        />
        <Stat
          label="breakeven"
          value={seg.breakeven}
          hint={seg.breakeven ? bpAbs(seg.breakeven.bp) : undefined}
        />
        <Stat
          label="cost paid"
          value={seg.meanCost}
          hint={seg.meanCost ? bpAbs(seg.meanCost.bp) : undefined}
        />
      </div>

      <p
        className={`mt-2 text-[11px] leading-relaxed ${
          emphasised ? "text-ink-muted" : "text-ink-faint"
        }`}
      >
        {seg.reading}
      </p>
    </div>
  );
}

function Line({ line }: { line: PaperBookLine }) {
  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[13px] text-ink">{line.id}</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          {line.source}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {line.badges.map((b) => (
          <Badge key={b.label} variant={b.tone} title={b.title} className="normal-case">
            {b.label}
          </Badge>
        ))}
      </div>

      <p className="max-w-3xl text-[12px] leading-relaxed text-ink-muted">
        {line.declaration.statement}
      </p>

      {/*
        The flip stated ABOVE the two columns rather than left for the reader
        to derive by comparing them. Deriving it means holding two numbers from
        different columns in mind at once, and the flattering one is always the
        larger.
      */}
      {line.signFlip && (
        <p className="rounded-md border border-danger/25 bg-danger/[0.04] px-3 py-2 text-[11px] leading-relaxed text-ink">
          <span className="font-semibold uppercase tracking-[0.12em] text-danger">
            Direction disagrees
          </span>{" "}
          · The backtest reads {line.full.net ? bp(line.full.net.bp) : "—"} and the paper record
          reads {line.paper.net ? bp(line.paper.net.bp) : "—"}. Both are correct. Only the second
          one is a test, and it is not yet powered to settle the disagreement.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Segment seg={line.full} emphasised={false} />
        <Segment seg={line.paper} emphasised />
      </div>

      <details className="rounded-md border border-line/60 bg-surface/30">
        <summary className="cursor-pointer px-3 py-2 text-[11px] text-ink-muted">
          <span className="uppercase tracking-[0.12em] text-ink-faint">The declaration</span>{" "}
          <span className="text-ink-faint">
            — what was written down on {line.declaration.declaredOn}, before the numbers
          </span>
        </summary>
        <dl className="flex flex-col gap-1.5 px-3 pb-3 text-[11px] leading-relaxed">
          {[
            ["Marked on", line.declaration.entry],
            ["Marked off", line.declaration.exit],
            ["Held", `${line.declaration.holdSessions} session(s) per observation`],
            ["Cost", line.declaration.costNote],
            ["Independence", line.declaration.independenceBasis],
            ["Retires if", line.declaration.killCriteria],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-[100px] shrink-0 uppercase tracking-[0.12em] text-ink-faint">{k}</dt>
              <dd className="text-ink-muted">{v}</dd>
            </div>
          ))}
          {line.namesPerSession !== null && line.namesPerSession > 1 && (
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-[100px] shrink-0 uppercase tracking-[0.12em] text-ink-faint">
                Breadth
              </dt>
              <dd className="text-ink-muted">
                {line.namesPerSession.toFixed(1)} correlated names per observation, averaged within
                the date before the series is formed — one bet, not {Math.round(line.namesPerSession)}.
              </dd>
            </div>
          )}
        </dl>
      </details>
    </li>
  );
}

export function PaperBook({ book }: { book: Book }) {
  return (
    <section className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink">
          Paper book — declared strategies, recomputed nightly
        </h2>
        <span className="font-mono text-[11px] text-ink-faint">n={book.totals.registered}</span>
      </div>

      <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">{book.headline}</p>

      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">
        Each strategy is split at the date its claim was written down. The left column is the
        sample that SELECTED it and the right column is the only one that tests it — so the left
        column is larger, older, more significant, and worth less. Nothing here votes: a
        recomputable line is not out-of-sample however long it gets, and none of it may reach a
        forecast.
      </p>

      <ul className="mt-2 flex flex-col divide-y divide-hairline">
        {book.lines.map((l) => (
          <Line key={l.id} line={l} />
        ))}
      </ul>

      {book.markDrag && (
        <div className="mt-4 rounded-md border border-line/60 bg-surface/40 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
              Mark drag — 15:50 quote against the close
            </span>
            <span className="font-mono text-[10px] text-ink-faint">n={book.markDrag.n}</span>
          </div>
          <div className="mt-2 flex flex-col gap-0.5">
            <Stat label="drag" value={book.markDrag.net} tone="text-ink-muted" />
            <TStat t={book.markDrag.tStat} n={book.markDrag.n} tone="text-ink-muted" />
            <Stat
              label="resolves ≥"
              value={book.markDrag.detectable}
              hint={book.markDrag.detectable ? bpAbs(book.markDrag.detectable.bp) : undefined}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">{book.markDrag.reading}</p>
        </div>
      )}

      {/*
        Refusals as a list rather than an absence. A producer that quietly
        stopped emitting would otherwise look identical to a strategy that was
        never declared.
      */}
      {book.refusals.length > 0 && (
        <div className="mt-3 rounded-md border border-danger/25 bg-danger/[0.04] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-danger">
            Produced nothing this run — {book.refusals.length}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {book.refusals.map((r) => (
              <li key={r.id} className="font-mono text-[11px] text-ink-muted">
                {r.id} — <span className="font-sans text-ink-faint">{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * THE TIER WITH NOTHING IN IT, rendered anyway.
 *
 * An absent live section reads as "there is no execution problem". There is:
 * every cost above is either a modelled tick or a top-of-book quote, and
 * neither can see market impact or an auction imbalance. Saying so where the
 * live numbers would go is the only place a reader will look for it.
 *
 * This stays hand-written until the round-trip log is joined to the register.
 * The moment it carries a number it must be generated from that log, and the
 * `n=0` here is the thing that will disagree loudly if it is not.
 */
export function LiveFills() {
  return (
    <section className="rounded-xl border border-hairline bg-panel/20 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Live fills — money actually moved
        </h2>
        <span className="font-mono text-[11px] text-ink-faint">n=0</span>
      </div>
      <p className="mt-2 text-[15px] font-semibold leading-snug text-ink-muted">
        Nothing on this page has been tested against a real fill.
      </p>
      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">
        The paper book above answers &ldquo;is the effect there&rdquo;. It cannot answer
        &ldquo;can we get that price&rdquo;, and those fail independently. Every cost quoted above
        is either a modelled tick or the half-spread resting on the top of the book — neither sees
        market impact, neither sees an auction imbalance, and a basket of twelve names hitting one
        opening auction is exactly where both live. This tier is rendered empty rather than omitted
        because an omitted tier reads as a solved problem.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        It fills when the round-trip log is joined to the register, so a declared strategy&rsquo;s
        paper price and its executed price can be differenced on the same date — the same pairing
        the mark drag uses, against a fill instead of a quote.
      </p>
    </section>
  );
}
