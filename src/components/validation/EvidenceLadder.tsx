/**
 * THE FRAME FOR EVERYTHING UNDER IT.
 *
 * This page used to open with "8 of 24 measured signals clear their own bar",
 * which is true and reads as a summary of what we know. It is not — it is a
 * summary of one tier, the one whose numbers were computed on the same data
 * that chose the signals. Opening with it invited the reader to average the
 * page's three very different kinds of evidence into a single impression.
 *
 * So the page now opens with the ladder itself. Three tiers, three different
 * questions, and the counts side by side:
 *
 *   BACKTEST  was there ever anything here?     large n, chosen on this data
 *   PAPER     is it still there now that the    small n, out of sample,
 *             claim is fixed?                    nobody traded it
 *   LIVE      can we get that price?             empty
 *
 * They are not degrees of confidence and must not be read as a progress bar.
 * A strategy can clear the first two and die entirely on the third, because
 * the third measures something neither of the others touches.
 */

function Tier({
  index,
  name,
  question,
  headline,
  detail,
  tone,
  faded,
}: {
  index: number;
  name: string;
  question: string;
  headline: string;
  detail: string;
  tone: string;
  faded?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border border-hairline px-3 py-2.5 ${
        faded ? "bg-transparent opacity-70" : "bg-surface/40"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-ink-faint">{index}</span>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}>
          {name}
        </span>
      </div>
      <p className="text-[11px] italic leading-snug text-ink-faint">{question}</p>
      <p className="font-mono text-[13px] leading-none text-ink">{headline}</p>
      <p className="text-[10px] leading-snug text-ink-faint">{detail}</p>
    </div>
  );
}

export function EvidenceLadder({
  labMeasured,
  labCleared,
  registered,
  withPaperRecord,
  clearingOutOfSample,
}: {
  labMeasured: number;
  labCleared: number;
  registered: number;
  withPaperRecord: number;
  clearingOutOfSample: number;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 sm:px-6">
      <p className="text-2xl font-bold leading-tight text-ink">
        {clearingOutOfSample === 0
          ? "Nothing on this site has cleared its own bar out of sample."
          : `${clearingOutOfSample} of ${registered} registered strategies clear out of sample.`}
      </p>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Not because the measurements failed — because the clock has not run. Every result below
        sits on one of three rungs, and they answer different questions rather than the same
        question with more or less confidence. The page is ordered so the strongest-looking numbers
        are the ones you reach last.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Tier
          index={1}
          name="Backtest"
          question="Was there ever anything here?"
          headline={`${labCleared} of ${labMeasured} clear`}
          detail="Measured on the same history the signals were chosen from. Large samples, and they cannot test what they selected."
          tone="text-ink-faint"
          faded
        />
        <Tier
          index={2}
          name="Paper"
          question="Is it still there now the claim is fixed?"
          headline={`${clearingOutOfSample} of ${registered} clear`}
          detail={`${withPaperRecord} of ${registered} have any out-of-sample record at all. Recomputed nightly, out of sample by date — but nobody traded it.`}
          tone="text-amber"
        />
        <Tier
          index={3}
          name="Live"
          question="Can we actually get that price?"
          headline="n=0"
          detail="No declared strategy has been differenced against a real fill. Market impact and auction imbalance are invisible to every cost on this page."
          tone="text-ink-faint"
          faded
        />
      </div>
    </section>
  );
}
