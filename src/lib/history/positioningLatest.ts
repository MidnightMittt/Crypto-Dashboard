import {
  FIELD_GROUPS,
  FieldGroup,
  GROUP_FIELDS,
  PositioningPoint,
  hasGroup,
} from "./positioningHistory";
import { BaselineSet, baselinesFor } from "./positioningBaseline";

/**
 * THE PROJECTION, as pure logic.
 *
 * Lives in lib rather than in the ingest script because it is a calculation,
 * not I/O: the merge rule below is the thing that has to be right, and it was
 * wrong once in a way that silently erased gamma from every symbol. A rule
 * that matters that much belongs where it can be tested.
 *
 * scripts/ingest/buildPositioningLatest.ts is now only the file read, the
 * file write and the log line.
 */

/**
 * The latest row PLUS where each of its numbers sits in that symbol's own
 * history — the positional read, precomputed.
 *
 * It is computed HERE rather than in the API route because the history is
 * 6.5MB and the projection is 33KB. A route importing the store to rank one
 * number against it would carry the whole archive into every serverless
 * bundle, for a figure that changes once a day.
 */
export type PositioningLatestRow = PositioningPoint & {
  baselines: BaselineSet;
  /**
   * The date each GROUP was actually observed. Absent for a group never seen.
   *
   * `date` on the row is the newest of these and is NOT a claim about every
   * field. A consumer stamping every field with `date` would report gamma from
   * 08-14 as though it were observed on 08-18 — a provenance lie of exactly
   * the kind already fixed once in marketExposure.ts, where SPY's beta claimed
   * an OLS fit for a value that is 1 by definition.
   */
  observedAt: Partial<Record<FieldGroup, string>>;
  /**
   * The VENDOR's own instant per group, where the vendor publishes one.
   *
   * `observedAt` is the SESSION the group belongs to; this is when the value
   * was actually true according to whoever produced it. They differ: CBOE
   * stamps a chain 2026-08-19T20:43:18Z inside the 2026-08-19 session, and
   * only the first is an answer to "when was this true".
   */
  sourceAsOf: Partial<Record<FieldGroup, string>>;
};

/**
 * The latest observation PER GROUP, merged into one row.
 *
 * Picking a single newest row was correct only while backfill never reached
 * past live. It no longer does: a backfill row dated after the last live row
 * carries short volume and nulls for everything else, and selecting it dropped
 * gamma from every symbol — "105 symbols (0 with gamma)". Merging by group
 * keeps each provider's fields together and each one's date honest.
 */
export function buildLatest(points: PositioningPoint[]): PositioningLatestRow[] {
  const bySymbol = new Map<string, PositioningPoint[]>();
  for (const p of points) {
    bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
  }

  const rows: PositioningLatestRow[] = [];
  for (const [symbol, all] of bySymbol) {
    /*
     * Newest first, and a LIVE row ahead of a backfill on the same date — the
     * same precedence appendPoints enforces, restated so a projection can
     * never disagree with the store it projects.
     */
    const ordered = [...all].sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (a.origin === b.origin ? 0 : a.origin === "live" ? -1 : 1)
    );

    // Start from the newest row for `date`, `symbol` and `origin`, then blank
    // every grouped field so nothing survives that this merge did not choose.
    // One cast, at the boundary: the field names come from GROUP_FIELDS, which
    // is typed as keys of PositioningPoint, so the writes below are checked at
    // their source even though the assignment target is indexed.
    const merged: Record<string, unknown> = { ...ordered[0] };
    for (const g of FIELD_GROUPS) {
      for (const f of GROUP_FIELDS[g]) merged[f] = null;
    }

    const observedAt: Partial<Record<FieldGroup, string>> = {};
    const sourceAsOf: Partial<Record<FieldGroup, string>> = {};
    for (const g of FIELD_GROUPS) {
      const source = ordered.find((p) => hasGroup(p, g));
      if (!source) continue;
      for (const f of GROUP_FIELDS[g]) merged[f] = source[f];
      observedAt[g] = source.date;
      // Taken from the SAME row the fields came from, never the newest row's.
      const vendor = source.sourceAsOf?.[g];
      if (vendor) sourceAsOf[g] = vendor;
    }

    const point = merged as unknown as PositioningPoint;
    rows.push({ ...point, symbol, baselines: baselinesFor(points, point), observedAt, sourceAsOf });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
