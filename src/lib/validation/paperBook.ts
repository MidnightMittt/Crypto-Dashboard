/**
 * THE PAPER BOOK — the register of declared strategies, split at the date each
 * one was written down.
 *
 * `paperLines.json` has been regenerated every night since the paper engine
 * shipped and read by nothing. That is the worst state an artefact can be in:
 * the numbers move, the diff is committed, and no reader ever sees the one
 * thing the file was built to say. This module is its display layer.
 *
 * ── It reshapes. It does not compute. ─────────────────────────────────
 *
 * Every statistic below is lifted verbatim from `paperEngine`. Nothing here
 * takes a mean, corrects a t, or decides whether a line earns anything — the
 * charter's one-engine rule, applied to the surface most tempted to break it.
 * A validation page that re-derived "is this significant" a second way would
 * be the exact defect it exists to publish.
 *
 * What it DOES add is classification and words: which tier of evidence a half
 * of a record belongs to, and one sentence per half generated from the numbers
 * beside it so the two cannot drift.
 *
 * ── The three things this surface is built to prevent ─────────────────
 *
 * 1. A BACKTEST READ AS A RECORD. The overnight leg is +30.0bp at t=2.00 over
 *    n=299, of which 281 sessions precede its own declaration. That number
 *    selected the strategy; it cannot also test it. Both halves are rendered,
 *    always, and the in-sample count is part of the label rather than a
 *    footnote.
 *
 * 2. A SIGN FLIP GOING UNNOTICED. The same leg reads −37.3bp since it was
 *    declared. Both figures were always true and they point opposite ways.
 *    `signFlip` is carried as a field so the page cannot render one without
 *    being able to say the other disagrees.
 *
 * 3. A NUMBER WITHOUT ITS SAMPLE SIZE. `Measured` pairs every basis-point
 *    figure with the n behind it in the type, so an unpinned statistic does
 *    not compile. Three of four documented spreads in this repository were
 *    once off by 10x, and the uniform-looking table was the least suspicious
 *    one.
 *
 * ── One unit ──────────────────────────────────────────────────────────
 *
 * Basis points, everywhere, for everything in return space. The signal lab's
 * win rates are NOT in return space and are not converted — a win rate has no
 * basis-point value without a payoff distribution, and inventing one to make
 * the columns match would be a worse error than the mismatch.
 */

import type { LegStats } from "@/lib/research/overnightDecomposition";
import type { PaperDeclaration, PaperLine, PaperRecord } from "@/lib/research/paperEngine";

/** The t at which this codebase calls an effect resolved. Declared, not tuned. */
export const CLEARS_AT_T = 3;

/**
 * A number and the sample behind it, welded together in the type.
 *
 * Not a convenience. A basis-point figure rendered without its n is the single
 * most repeated failure on this surface, and making it a compile error is
 * cheaper than catching it in review every time.
 */
export interface Measured {
  bp: number;
  n: number;
}

/**
 * Where a body of evidence sits on the ladder from "chose the strategy" to
 * "money moved".
 *
 * These are not degrees of confidence — they are different questions. A
 * backtest answers "was there ever anything here". A paper record answers "is
 * it still there now that the claim is fixed". Live fills answer "can we get
 * the price", which neither of the others can speak to at all.
 */
export type EvidenceTier = "backtest" | "paper" | "live";

/**
 * What a sample can and cannot say — deliberately NOT a verdict.
 *
 * `paperEngine` is explicit that a record is evidence and sets no edge. So the
 * strongest statement available here is about POWER: whether the observed mean
 * is larger than the smallest effect this many observations at this dispersion
 * could have separated from zero.
 *
 * `underpowered` is the important one. A null from a test that could not have
 * seen the effect is not evidence of absence, and a page that rendered it as a
 * failing number would be publishing silence as a finding.
 */
export type PowerState = "empty" | "no-dispersion" | "underpowered" | "clears";

export type BadgeTone = "neutral" | "amber" | "danger" | "success";

/**
 * A fact about the REGISTRATION, not about the result.
 *
 * Everything here answers "what claim is this number attached to, and when was
 * it fixed" — the questions that decide what the result means. They are badges
 * rather than prose because they must survive being skimmed.
 */
export interface RegisterBadge {
  label: string;
  tone: BadgeTone;
  /** Why this badge matters, for the title attribute. Never decorative. */
  title: string;
}

export interface PaperSegment {
  key: "full" | "sinceDeclared";
  /** What this half IS, including its in-sample count. */
  label: string;
  tier: EvidenceTier;
  n: number;
  firstDate: string | null;
  lastDate: string | null;
  net: Measured | null;
  gross: Measured | null;
  tStat: number | null;
  /** Smallest effect this sample could have called significant at t=3. */
  detectable: Measured | null;
  /** Round-trip cost at which the mean net return reaches zero. */
  breakeven: Measured | null;
  meanCost: Measured | null;
  /** Observations still needed for the observed mean to reach t=3. */
  sessionsToT3: number | null;
  power: PowerState;
  /** Generated from the fields above, so words and numbers cannot disagree. */
  reading: string;
  /** The engine's own caveat, passed through verbatim. */
  caveat: string | null;
}

export interface PaperBookLine {
  id: string;
  source: string;
  declaration: PaperDeclaration;
  badges: RegisterBadge[];
  /** Everything computable. Contains the selection sample when in-sample > 0. */
  full: PaperSegment;
  /** Sessions on or after the declaration. The only out-of-sample half. */
  paper: PaperSegment;
  inSampleSessions: number;
  /**
   * The two halves disagree in sign.
   *
   * Carried as a field rather than left for a reader to spot, because spotting
   * it requires holding two numbers from different columns in mind at once and
   * the flattering one is always the larger.
   */
  signFlip: boolean;
  /** Correlated instruments per observation. A basket of twelve is one bet. */
  namesPerSession: number | null;
}

/**
 * The measured cost of marking at 15:50 instead of at the close.
 *
 * The only paired number on this surface: the same nights, two entry prices,
 * differenced per date. That pairing is what makes n=12 worth printing at all
 * — most of the variance is the market move and it cancels.
 */
export interface MarkDragView {
  n: number;
  firstDate: string | null;
  lastDate: string | null;
  net: Measured | null;
  detectable: Measured | null;
  tStat: number | null;
  power: PowerState;
  reading: string;
}

export interface PaperBook {
  generatedAt: number;
  engineVersion: number;
  lines: PaperBookLine[];
  markDrag: MarkDragView | null;
  refusals: { id: string; reason: string }[];
  totals: {
    registered: number;
    /** Lines with at least one session since their own declaration. */
    withPaperRecord: number;
    /** Lines whose paper half reaches t=3. Not "lines that work". */
    clearing: number;
  };
  /** The top line, generated from `totals`. */
  headline: string;
}

// ── The artefact's own shape, as written to disk ────────────────────────

export interface PaperLinesArtifact {
  version: number;
  generatedAt: number;
  engineVersion: number;
  lines: Array<{
    id: string;
    source: string;
    line: PaperLine;
    caveatFull: string | null;
    caveatSinceDeclared: string | null;
  }>;
  markDrag: {
    n: number;
    firstDate: string | null;
    lastDate: string | null;
    net: LegStats | null;
    gross: LegStats | null;
    detectableAtT3Bp: number | null;
  } | null;
  refusals: { id: string; reason: string }[];
}

// ── Formatting, shared so every number on the surface is shaped alike ───

/** A signed basis-point figure. The only return unit this surface uses. */
export function bp(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}bp`;
}

/** An unsigned basis-point figure, for costs and detection floors. */
export function bpAbs(v: number): string {
  return `${v.toFixed(1)}bp`;
}

const measure = (v: number | null | undefined, n: number): Measured | null =>
  v === null || v === undefined ? null : { bp: v, n };

function powerOf(record: PaperRecord): PowerState {
  if (record.n === 0) return "empty";
  if (!record.net) return "no-dispersion";
  return Math.abs(record.net.tStat) >= CLEARS_AT_T ? "clears" : "underpowered";
}

/**
 * One sentence about a half of a record, built from that half's own numbers.
 *
 * Written to be correct when read alone, because it will be. The rule it
 * follows throughout: state what the sample CANNOT say before stating what it
 * appears to say, since the second is the part a reader will keep.
 */
function segmentReading(
  record: PaperRecord,
  tier: EvidenceTier,
  inSampleSessions: number
): string {
  const declaredOn = record.declaration.declaredOn;

  if (record.n === 0) {
    return (
      `No sessions on or after the ${declaredOn} declaration. ` +
      `The paper record has not started — everything known about this strategy is the sample it was chosen on.`
    );
  }
  if (!record.net) {
    return `${record.n} session${record.n === 1 ? "" : "s"} — too few to estimate dispersion, so no statistic is offered.`;
  }

  const mean = bp(record.net.meanBp);
  const t = record.net.tStat.toFixed(2);
  const span = `n=${record.n}, ${record.firstDate} to ${record.lastDate}`;

  if (tier === "backtest" && inSampleSessions > 0) {
    return (
      `${mean} per observation at t=${t} (${span}). ` +
      `${inSampleSessions} of those ${record.n} sessions precede the ${declaredOn} declaration: ` +
      `this is the sample that SELECTED the strategy and it cannot also test it.`
    );
  }

  const floor = record.detectableAtT3Bp;
  if (Math.abs(record.net.tStat) < CLEARS_AT_T) {
    const needs =
      record.sessionsToT3 !== null
        ? ` At this mean and dispersion it would take about ${record.sessionsToT3} observations to reach t=3.`
        : "";
    return (
      `Indistinguishable from zero in either direction: ${mean} at t=${t} (${span})` +
      (floor !== null
        ? `, inside the ${bpAbs(floor)} this sample could have resolved at t=${CLEARS_AT_T}`
        : "") +
      `. That is silence, not a negative result.${needs}`
    );
  }
  return (
    `${mean} per observation at t=${t} (${span}) — past the ${CLEARS_AT_T}-sigma bar this codebase uses` +
    (floor !== null ? `, which this sample sets at ${bpAbs(floor)}` : "") +
    `. Statistically separated from zero; that is not the same as tradeable.`
  );
}

function toSegment(
  record: PaperRecord,
  key: PaperSegment["key"],
  inSampleSessions: number
): PaperSegment {
  const tier: EvidenceTier = key === "full" ? "backtest" : "paper";
  const n = record.n;
  const label =
    key === "full"
      ? inSampleSessions > 0
        ? `Everything computable — n=${n}, of which ${inSampleSessions} precede the declaration`
        : `Everything computable — n=${n}, none of it before the declaration`
      : `Since declared ${record.declaration.declaredOn} — n=${n}`;

  return {
    key,
    label,
    tier,
    n,
    firstDate: record.firstDate,
    lastDate: record.lastDate,
    net: measure(record.net?.meanBp, n),
    gross: measure(record.gross?.meanBp, n),
    tStat: record.net?.tStat ?? null,
    detectable: measure(record.detectableAtT3Bp, n),
    breakeven: measure(record.breakevenCostBp, n),
    meanCost: measure(record.meanCostBp, n),
    sessionsToT3: record.sessionsToT3,
    power: powerOf(record),
    reading: segmentReading(record, tier, inSampleSessions),
    caveat: null,
  };
}

/**
 * The registration facts, as badges.
 *
 * Ordered so the two that change what every number means — the declaration
 * date and whether the cost is measured or assumed — come before the warnings.
 * A reader who stops after two badges has the two that matter most.
 */
function badgesFor(line: PaperLine, signFlip: boolean): RegisterBadge[] {
  const d = line.full.declaration;
  const badges: RegisterBadge[] = [
    {
      label: `registered ${d.declaredOn}`,
      tone: "neutral",
      title:
        "The date the claim was fixed in words. Sessions before it are the sample the strategy " +
        "was chosen on; sessions after it are the only ones that test it.",
    },
    {
      label: `fp ${line.full.definitionFingerprint} · engine v${line.full.engineVersion}`,
      tone: "neutral",
      title:
        "A hash of the declared statement, and the version of the arithmetic. Both are printed " +
        "because this record is recomputed nightly rather than appended: a redefinition would " +
        "otherwise rewrite its own history into agreement with itself, and the only trace would " +
        "be a changed hash in the committed diff.",
    },
    d.costBasis === "measured"
      ? {
          label: "cost measured",
          tone: "success",
          title: `Charged from a recorded book rather than assumed. ${d.costNote}`,
        }
      : {
          label: "cost modelled",
          tone: "amber",
          title: `The cost is an assumption, not an observation. ${d.costNote}`,
        },
  ];

  if (line.sinceDeclared.n === 0) {
    badges.push({
      label: "no paper record",
      tone: "danger",
      title:
        `Every one of the ${line.full.n} sessions precedes the ${d.declaredOn} declaration. ` +
        "Nothing here is out-of-sample.",
    });
  } else if (powerOf(line.sinceDeclared) === "underpowered") {
    badges.push({
      label: "underpowered",
      tone: "amber",
      title:
        "The paper record cannot yet separate its own mean from zero. Read it as silence rather " +
        "than as a result in either direction.",
    });
  }

  if (signFlip) {
    badges.push({
      label: "sign flips",
      tone: "danger",
      title:
        "The backtest and the paper record disagree about direction. Both numbers are correct; " +
        "only the second one is a test.",
    });
  }
  return badges;
}

function dragReading(d: NonNullable<PaperLinesArtifact["markDrag"]>): string {
  if (!d.net) {
    return `Paired on ${d.n} date${d.n === 1 ? "" : "s"} — too few to estimate dispersion.`;
  }
  const mean = bp(d.net.meanBp);
  const t = d.net.tStat.toFixed(2);
  const floor = d.detectableAtT3Bp;
  const direction =
    d.net.meanBp >= 0
      ? "the 15:50 mark entered BETTER than the close on average"
      : "the 15:50 mark entered WORSE than the close on average";
  if (Math.abs(d.net.tStat) < CLEARS_AT_T) {
    return (
      `${mean} per night at t=${t}, paired on ${d.n} dates (${d.firstDate} to ${d.lastDate}) — ` +
      `${direction}, but inside the ${floor !== null ? bpAbs(floor) : "unknown"} this many pairs ` +
      `could resolve. Not yet a measurement of execution cost; a placeholder for one.`
    );
  }
  return (
    `${mean} per night at t=${t}, paired on ${d.n} dates (${d.firstDate} to ${d.lastDate}): ` +
    `${direction}. Paired per date, so the market move cancels and this is the entry price alone.`
  );
}

/**
 * Build the display model.
 *
 * `caveatFull` and `caveatSinceDeclared` are carried through verbatim from the
 * artefact rather than regenerated. `paperCaveat` runs at build time against
 * the full session list; re-running it here would need `sessions` shipped to
 * the browser, and re-implementing it would be a second definition of the same
 * warning.
 */
export function buildPaperBook(artifact: PaperLinesArtifact): PaperBook {
  const lines: PaperBookLine[] = artifact.lines.map((entry) => {
    const { line } = entry;
    const fullMean = line.full.net?.meanBp ?? null;
    const paperMean = line.sinceDeclared.net?.meanBp ?? null;
    const signFlip =
      fullMean !== null && paperMean !== null && Math.sign(fullMean) !== Math.sign(paperMean);

    const full = toSegment(line.full, "full", line.inSampleSessions);
    const paper = toSegment(line.sinceDeclared, "sinceDeclared", line.inSampleSessions);
    full.caveat = entry.caveatFull;
    paper.caveat = entry.caveatSinceDeclared;

    return {
      id: entry.id,
      source: entry.source,
      declaration: line.full.declaration,
      badges: badgesFor(line, signFlip),
      full,
      paper,
      inSampleSessions: line.inSampleSessions,
      signFlip,
      namesPerSession: line.full.meanNamesPerSession,
    };
  });

  /*
   * Ordered by whether a line HAS a paper record, then by how long that record
   * is — and never by how well any of them did. Sorting by result would put
   * the best-looking number on top regardless of whether it means anything,
   * which is the habit this whole surface exists to break.
   */
  lines.sort(
    (a, b) => b.paper.n - a.paper.n || a.id.localeCompare(b.id)
  );

  const withPaperRecord = lines.filter((l) => l.paper.n > 0).length;
  const clearing = lines.filter((l) => l.paper.power === "clears").length;

  return {
    generatedAt: artifact.generatedAt,
    engineVersion: artifact.engineVersion,
    lines,
    markDrag: artifact.markDrag
      ? {
          n: artifact.markDrag.n,
          firstDate: artifact.markDrag.firstDate,
          lastDate: artifact.markDrag.lastDate,
          net: measure(artifact.markDrag.net?.meanBp, artifact.markDrag.n),
          detectable: measure(artifact.markDrag.detectableAtT3Bp, artifact.markDrag.n),
          tStat: artifact.markDrag.net?.tStat ?? null,
          power: !artifact.markDrag.net
            ? artifact.markDrag.n === 0
              ? "empty"
              : "no-dispersion"
            : Math.abs(artifact.markDrag.net.tStat) >= CLEARS_AT_T
              ? "clears"
              : "underpowered",
          reading: dragReading(artifact.markDrag),
        }
      : null,
    refusals: artifact.refusals,
    totals: { registered: lines.length, withPaperRecord, clearing },
    headline: headlineFor(lines.length, withPaperRecord, clearing),
  };
}

/**
 * The top line.
 *
 * Leads with the count that is zero, because it is. A headline reading
 * "6 strategies registered" is true and would be read as progress; the number
 * a trader needs first is how many of them have said anything out of sample.
 */
export function headlineFor(registered: number, withPaperRecord: number, clearing: number): string {
  if (registered === 0) return "No strategy is registered. There is no paper book.";
  if (withPaperRecord === 0) {
    return (
      `${clearing === 0 ? "None" : String(clearing)} of ${registered} registered strategies ` +
      `has said anything out of sample — every session on record precedes its own declaration.`
    );
  }
  return (
    `${clearing} of ${registered} registered strategies clear t=${CLEARS_AT_T} out of sample. ` +
    `${withPaperRecord} ${withPaperRecord === 1 ? "has" : "have"} a paper record at all; the rest are backtest only.`
  );
}
