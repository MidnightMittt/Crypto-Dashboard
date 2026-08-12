import { Bar, InstrumentMeta, Timeframe, TIMEFRAME_MS } from "./types";
import { calendarDateInZone, sessionPeriodKey } from "./session";

/**
 * INGESTION VALIDATION — every instrument must pass before it may be used.
 *
 * ── The rule this module exists to enforce ──────────────────────────────
 *
 * NO SILENT REPAIRS. Nothing here mutates, interpolates, forward-fills,
 * de-duplicates or reorders. It only reports. A pipeline that quietly fixes
 * bad data produces research that cannot be reproduced or trusted, and the
 * repair itself becomes an undocumented modelling assumption buried in an
 * ingestion script.
 *
 * The contract is therefore: validate, and refuse. A caller that wants to
 * proceed despite an error must say so explicitly and record why.
 *
 * ── Asset-agnostic by construction ──────────────────────────────────────
 *
 * Every check reads only `InstrumentMeta` and `Bar`. There is no branch on
 * asset class anywhere in this file: the differences between a crypto perp
 * and an equity ETF are entirely carried by `SessionModel` (does it gap, how
 * many bars a year, which timezone) and by `inceptionT`/`delistedT`. Adding
 * FX or futures requires no change here.
 */

export type ValidationSeverity = "error" | "warning";

export interface ValidationFinding {
  check: string;
  severity: ValidationSeverity;
  message: string;
  /** Bar index the finding refers to, when it refers to one. */
  index?: number;
  /** Timestamp the finding refers to, when it refers to one. */
  t?: number;
}

export interface ValidationReport {
  instrumentId: string;
  timeframe: Timeframe;
  barsChecked: number;
  /** False when ANY error-severity finding exists. Warnings do not fail an instrument. */
  passed: boolean;
  findings: ValidationFinding[];
  errors: number;
  warnings: number;
}

/** Weekday in the instrument's own session zone. Needed because "is this a weekend bar" is a local-calendar question, not a UTC one. */
function weekdayInZone(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(t));
}

const WEEKEND = new Set(["Sat", "Sun"]);

/**
 * Validates one instrument's bar series. Pure: returns findings, changes
 * nothing.
 *
 * `expectedCoverage` is the fraction of the theoretical bar count that must
 * be present before continuity is flagged. Daily equity data legitimately
 * misses ~9 market holidays a year, so a small shortfall is normal and a
 * large one is not.
 */
export function validateBars(
  meta: InstrumentMeta,
  bars: Bar[],
  timeframe: Timeframe,
  opts: { expectedCoverage?: number } = {}
): ValidationReport {
  const findings: ValidationFinding[] = [];
  const add = (check: string, severity: ValidationSeverity, message: string, index?: number, t?: number) =>
    findings.push({ check, severity, message, index, t });

  const expectedCoverage = opts.expectedCoverage ?? 0.9;

  if (bars.length === 0) {
    add("non-empty", "error", "No bars supplied. An instrument with no data cannot be validated or used.");
    return { instrumentId: meta.id, timeframe, barsChecked: 0, passed: false, findings, errors: 1, warnings: 0 };
  }

  // ── 1. Sorted timestamps, and 2. duplicates ───────────────────────────
  // Checked together because both are violations of the same invariant —
  // strictly ascending time — and reporting them separately would double-
  // report a single malformed row.
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t === bars[i - 1].t) {
      add("duplicates", "error", `Duplicate timestamp ${new Date(bars[i].t).toISOString()} at index ${i}.`, i, bars[i].t);
    } else if (bars[i].t < bars[i - 1].t) {
      add("sorted", "error", `Timestamps out of order at index ${i}: ${new Date(bars[i].t).toISOString()} precedes ${new Date(bars[i - 1].t).toISOString()}.`, i, bars[i].t);
    }
  }

  // ── 3. OHLC sanity ────────────────────────────────────────────────────
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const finite = [b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x));
    if (!finite) {
      add("ohlc-finite", "error", `Non-finite OHLC at index ${i}.`, i, b.t);
      continue;
    }
    if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) {
      add("ohlc-positive", "error", `Non-positive price at index ${i}. Prices must be strictly positive; a zero or negative print is a data error, not a market event.`, i, b.t);
    }
    if (b.high < b.low) {
      add("ohlc-range", "error", `High ${b.high} below low ${b.low} at index ${i}.`, i, b.t);
    }
    if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
      add("ohlc-containment", "error", `High/low do not contain open/close at index ${i} (O ${b.open} H ${b.high} L ${b.low} C ${b.close}).`, i, b.t);
    }
  }

  // ── 4. Volume sanity ──────────────────────────────────────────────────
  const volumes = bars.map((b) => b.volume);
  for (let i = 0; i < bars.length; i++) {
    const v = volumes[i];
    if (v === null) continue; // legitimately absent for some instruments
    if (!Number.isFinite(v)) add("volume-finite", "error", `Non-finite volume at index ${i}.`, i, bars[i].t);
    else if (v < 0) add("volume-non-negative", "error", `Negative volume ${v} at index ${i}.`, i, bars[i].t);
  }
  const present = volumes.filter((v): v is number => v !== null);
  if (present.length > 0 && present.every((v) => v === 0)) {
    // A warning, not an error: some legitimate series carry no volume. But
    // an all-zero column masquerading as data would silently disable every
    // volume-based feature, so it must be surfaced.
    add("volume-all-zero", "warning", "Every volume is zero. If this instrument genuinely has no volume, the provider should emit null rather than 0 so volume features report unavailable instead of computing on a fabricated zero.");
  }

  // ── 5. Session validation ─────────────────────────────────────────────
  if (meta.sessionModel.kind === "session-based") {
    for (let i = 0; i < bars.length; i++) {
      // A session-based instrument must not print a bar on a weekend in its
      // own timezone. Stepping back 1ms matches the session-key rule so a
      // bar closing exactly at midnight is attributed consistently.
      const day = weekdayInZone(bars[i].t - 1, meta.sessionModel.timezone);
      if (WEEKEND.has(day)) {
        add("session-weekday", "error", `Bar at index ${i} closes on a ${day} in ${meta.sessionModel.timezone}, but ${meta.id} is session-based and should not trade at the weekend.`, i, bars[i].t);
      }
    }
  }

  // ── 6. Timezone / session-key validation ──────────────────────────────
  // At daily resolution two bars must never map to the same session key. If
  // they do, the session model is wrong for this instrument, and the panel
  // estimator would silently treat two independent days as contemporaneous.
  if (timeframe === "1D") {
    const seen = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) {
      const key = sessionPeriodKey(bars[i].t, meta.sessionModel);
      const prior = seen.get(key);
      if (prior !== undefined) {
        add("session-key-collision", "error",
          `Bars at indices ${prior} and ${i} both map to session ${calendarDateInZone(bars[i].t - 1, meta.sessionModel.timezone)}. The declared SessionModel is wrong for this instrument, or the series is not daily.`, i, bars[i].t);
      } else {
        seen.set(key, i);
      }
    }
  }

  // ── 7. Missing bars / calendar continuity ─────────────────────────────
  const spanMs = bars[bars.length - 1].t - bars[0].t;
  if (spanMs > 0) {
    if (meta.sessionModel.kind === "continuous") {
      // A continuous market has no excuse for a gap: every bar should follow
      // the last by exactly one interval.
      const step = TIMEFRAME_MS[timeframe];
      for (let i = 1; i < bars.length; i++) {
        const gap = bars[i].t - bars[i - 1].t;
        if (gap > step * 1.5) {
          add("continuity", "error", `Missing ${Math.round(gap / step) - 1} bar(s) before index ${i} in a continuous market (gap ${(gap / step).toFixed(1)} intervals).`, i, bars[i].t);
        }
      }
    } else if (timeframe === "1D") {
      // Session markets legitimately skip weekends and holidays, so the
      // per-gap test would be pure noise. Coverage against the declared
      // bars-per-year is the meaningful aggregate check.
      const years = spanMs / (365 * 86_400_000);
      const expected = years * meta.sessionModel.barsPerYear;
      const coverage = expected > 0 ? bars.length / expected : 1;
      if (coverage < expectedCoverage) {
        add("continuity", "error", `Only ${bars.length} bars over ${years.toFixed(2)} years; expected about ${Math.round(expected)} at ${meta.sessionModel.barsPerYear}/year (coverage ${(100 * coverage).toFixed(1)}%, floor ${(100 * expectedCoverage).toFixed(0)}%). The series has material gaps.`);
      }
      // A gap longer than a week exceeds any US market holiday closure and
      // indicates missing data rather than a calendar effect.
      for (let i = 1; i < bars.length; i++) {
        const gapDays = (bars[i].t - bars[i - 1].t) / 86_400_000;
        if (gapDays > 7.5) {
          add("continuity-gap", "warning", `Gap of ${gapDays.toFixed(1)} days before index ${i}. Longer than any regular market closure — verify against the exchange calendar.`, i, bars[i].t);
        }
      }
    }
  }

  // ── 8. Listing-window bounds ──────────────────────────────────────────
  // Guards against providers back-filling synthetic history before an
  // instrument existed, and against bars after a delisting. Designed for
  // delisted instruments even though none are ingested yet.
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t < meta.inceptionT) {
      add("listing-window", "error", `Bar at index ${i} (${new Date(bars[i].t).toISOString()}) precedes declared inception ${new Date(meta.inceptionT).toISOString()}.`, i, bars[i].t);
    }
    if (meta.delistedT !== null && bars[i].t > meta.delistedT) {
      add("listing-window", "error", `Bar at index ${i} follows declared delisting ${new Date(meta.delistedT).toISOString()}.`, i, bars[i].t);
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    instrumentId: meta.id,
    timeframe,
    barsChecked: bars.length,
    passed: errors === 0,
    findings,
    errors,
    warnings,
  };
}

/**
 * Throws unless the series is clean.
 *
 * The loud path, for ingestion. Returning a report that a caller might
 * ignore is fine for diagnostics; admitting an instrument into the research
 * universe requires this.
 */
export function assertValid(meta: InstrumentMeta, bars: Bar[], timeframe: Timeframe, opts?: { expectedCoverage?: number }): void {
  const report = validateBars(meta, bars, timeframe, opts);
  if (report.passed) return;
  const detail = report.findings
    .filter((f) => f.severity === "error")
    .slice(0, 10)
    .map((f) => `  - [${f.check}] ${f.message}`)
    .join("\n");
  throw new Error(
    `[ingest] ${meta.id} ${timeframe} failed validation with ${report.errors} error(s):\n${detail}` +
      (report.errors > 10 ? `\n  ...and ${report.errors - 10} more.` : "")
  );
}

/** Compact one-line summary for ingestion logs. */
export function summarizeReport(report: ValidationReport): string {
  return `${report.instrumentId} ${report.timeframe}: ${report.barsChecked} bars, ${report.passed ? "PASS" : "FAIL"} (${report.errors} errors, ${report.warnings} warnings)`;
}
