/**
 * PROVENANCE — where a number came from, in one shape, platform-wide.
 *
 * This is the primitive `/api/pretrade` already serves and the dossier had
 * none of. Two contracts for one idea is how a page and its API drift, so
 * there is exactly one and both import it.
 *
 * ── Why every value needs this ────────────────────────────────────────
 *
 * A number with no provenance cannot be argued with. The concrete case: two
 * ATR figures disagreed for an hour because one used a simple mean and the
 * other Wilder smoothing, and neither declared which. `method` settles that
 * in seconds. A separate incident published three spread figures a factor of
 * ten low because a percent was carried into a basis-point column — `unit`
 * makes that visible at the point of use rather than in a comment nobody
 * rechecks.
 *
 * ── as_of is the value's own time, never the render time ──────────────
 *
 * The most common way a feed lies is by looking current. A weekend quote
 * returns Friday's book with nothing marking it stale; stamped with "now" it
 * would read as live. `as_of` is always the instant the VALUE was true.
 */

export interface Provenance {
  /** The field this describes, e.g. "atr_pct" or "net_gamma". */
  field: string;
  /** What the number is measured in. "pct", "usd", "bp", "sessions", "count". */
  unit: string;
  /** ISO instant or date the value was true. Never the time of rendering. */
  as_of: string;
  /** Where it came from, named precisely enough to go and check. */
  source: string;
  /** How it was computed. Absent only where the value is a raw passthrough. */
  method?: string;
}

/** Terse constructor — these appear in long lists and read better inline. */
export const prov = (
  field: string,
  unit: string,
  as_of: string,
  source: string,
  method?: string
): Provenance => (method ? { field, unit, as_of, source, method } : { field, unit, as_of, source });
