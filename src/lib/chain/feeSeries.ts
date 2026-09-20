import { feeRatePerDay } from "./uniV3Math";
import { PositionCard } from "./lpPosition";

/**
 * THE FEE-RATE SERIES — the real P0 deliverable.
 *
 * One row per read, persisted forever, because this RPC keeps no historical
 * state: a fee number not written down when it was read cannot be recovered by
 * re-reading the block. That makes the series an APPEND-ONLY store of the same
 * kind as the round-trip log — unreconstructable, so it goes to JSONL and is
 * only ever added to.
 *
 * ── The two things a naive series gets wrong ──────────────────────────
 *
 *  1. A NEGATIVE RATE. Cumulative fees fall to ~0 when a collect/compound
 *     pulls them. Dividing across that drop invents a negative fee rate, which
 *     is nonsense. Instead the drop is DETECTED and a `break` row is written:
 *     the fee clock reset, so the rate is null across it and the next sample
 *     measures from the fresh start. "Never a negative rate", structurally.
 *
 *  2. A SILENT GAP. If the scheduler misses runs, the rate between two distant
 *     rows is an average over a window nobody watched. The gap is carried on
 *     the row (`gap_hours`) so a reader — and the >12h alert — can see it
 *     rather than trust a smeared number.
 */

export interface FeeSeriesRow {
  /** Observation stamp, ISO 8601 UTC — the block's own timestamp. */
  ts: string;
  block: number;
  tick: number;
  /** Cumulative uncollected fees in USD at this read. Null when ETH price was unavailable. */
  fees_usd: number | null;
  /** USD/day BETWEEN this row and the previous SAMPLE row. Null on a break or first row. */
  fee_rate_usd_per_day: number | null;
  share_of_active: number;
  /** 2-hour swap volume. DEFERRED to the logs phase (needs the verified Swap topic). */
  vol_2h: number | null;
  /** "sample" is a normal read; "break" marks a detected fee-clock reset. */
  kind: "sample" | "break";
  /** Hours since the previous row — makes an under-sampled gap visible. */
  gap_hours: number | null;
  /** The ETH/USD source label behind fees_usd, or null when it was unavailable. */
  eth_usd_source: string | null;
  liquidity: string;
  note?: string;
}

/** Small tolerance: fees "dropped to ~0" if they fell below this fraction of the prior value. */
const RESET_DROP_FRACTION = 0.5;

/**
 * Build the next series row from the current card and the rows already stored.
 *
 * Pure: no I/O, no clock — everything it needs is on the card and in the prior
 * rows, so the reset logic and the rate arithmetic are unit-testable. The
 * caller appends the returned row.
 */
export function nextRow(card: PositionCard, priorRows: readonly FeeSeriesRow[]): FeeSeriesRow {
  const nowMs = Date.parse(card.observedAt);
  const feesUsd = card.feesSinceCollect.usd;
  const base: FeeSeriesRow = {
    ts: card.observedAt,
    block: Number(card.block),
    tick: card.currentTick,
    fees_usd: feesUsd,
    fee_rate_usd_per_day: null,
    share_of_active: card.shareOfActivePct,
    vol_2h: null,
    kind: "sample",
    gap_hours: null,
    eth_usd_source: card.ethUsd?.stamp.source ?? null,
    liquidity: card.liquidity,
  };

  // The previous SAMPLE row (breaks don't anchor a rate — the clock restarted).
  const prev = [...priorRows].reverse().find((r) => r.kind === "sample");
  if (!prev) return base;

  const prevMs = Date.parse(prev.ts);
  base.gap_hours = (nowMs - prevMs) / 3_600_000;

  // A fee-clock RESET: cumulative fees fell markedly. Could be a plain collect
  // or a compound (collect + re-add, which also raises L). Either way it is a
  // break, not a negative rate.
  const dropped =
    feesUsd !== null && prev.fees_usd !== null && feesUsd < prev.fees_usd * RESET_DROP_FRACTION;
  if (dropped) {
    const lRose = BigInt(card.liquidity) > BigInt(prev.liquidity);
    return {
      ...base,
      kind: "break",
      fee_rate_usd_per_day: null,
      note: lRose
        ? "fee clock reset — fees fell while liquidity rose (compound: collect + re-add)"
        : "fee clock reset — fees collected; rate measured fresh from here",
    };
  }

  // Normal sample: rate between the two reads, or null if uncomputable.
  if (feesUsd !== null && prev.fees_usd !== null) {
    base.fee_rate_usd_per_day = feeRatePerDay(
      { feesUsd: prev.fees_usd, ts: prevMs },
      { feesUsd, ts: nowMs }
    );
  }
  return base;
}

/** Parse a JSONL body into rows, skipping blank lines. Tolerant of a trailing newline. */
export function parseSeries(jsonl: string): FeeSeriesRow[] {
  return jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeeSeriesRow);
}

/** Serialize one row to a single JSONL line (no pretty-printing — one row, one line). */
export function serializeRow(row: FeeSeriesRow): string {
  return JSON.stringify(row);
}
