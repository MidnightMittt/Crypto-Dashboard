import { restatedRead } from "@/lib/signals/scoring";

/**
 * Discloses that a read's DIRECTION is not its own.
 *
 * Exists because of a specific way this dashboard is misleading readers, and
 * retiring the vote did not touch it. `longShort` and `squeezeRisk` are exact
 * negations — across 1,181 replayed observations where both called a direction
 * they disagreed 1,181 times, because the thresholds make agreement impossible.
 * Every surface that lists metrics renders them as two adjacent bullets with
 * opposite badges, which reads as "two independent analysts looked at this and
 * came to opposite conclusions" — the single most informative thing a
 * disagreement can mean, and here it means nothing at all. It is one number,
 * interpreted two ways, the second guaranteed to be the negation of the first.
 *
 * longShort is role `state` now, so it no longer moves the score. It still
 * renders a directional badge, which is exactly why this is needed: the score
 * stopped double-counting and the page kept presenting a structural identity
 * as a live disagreement.
 *
 * Renders nothing for modules whose direction IS their own, so it is safe to
 * drop into any metric row unconditionally — which is the point: a surface
 * cannot forget to disclose a restatement it was never told about, and the
 * next module that turns out to be a restatement is disclosed everywhere by
 * one entry in RESTATED_READS.
 *
 * Deliberately styled as neutral ink, not as a warning. It is not a risk or a
 * conflict — an amber ⚠ here would make a structural fact look like breaking
 * news about the market. Nothing is wrong; the reader is just being told what
 * they are looking at.
 */
export function RestatementNote({ metricId }: { metricId: string }) {
  const restated = restatedRead(metricId);
  if (!restated) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint/70">
      <span className="text-ink-muted">
        {restated.relation === "inverse" ? "Mirror of another read" : "Restates another read"}:
      </span>{" "}
      {restated.disclosure}
    </p>
  );
}
