import { describe, expect, it } from "vitest";
import artifactJson from "../../data/liveLedger.json";
import {
  DeclaredMethod,
  JOIN_CONTRACT,
  RawRoundTrip,
  UNLABELLED_METHOD,
  buildLiveLedger,
  labelStatusOf,
  scanFillTimes,
  unavailableLedger,
} from "./roundTrips";
import { DECLARED_METHODS } from "./methodRegister";

function trip(over: Partial<RawRoundTrip> = {}): RawRoundTrip {
  return {
    schema: "roundtrip/1.2",
    id: "TEST:2026-08-19T14:00:00Z",
    symbol: "TEST",
    instrument: "equity",
    qty: 1,
    multiplier: 1,
    entry: { price: 10, price_source: "derived_from_realized_gain", ts: null, ts_source: "unavailable" },
    exit: { price: 11, ts: "2026-08-19T14:00:00Z", venue: null, order_id: null },
    realized_usd: 1,
    hold_sessions: null,
    rules_at_entry: null,
    levels_armed_at_entry: null,
    side: "long",
    ...over,
  };
}

/** A trip labelled the way schema 1.2 labels one. */
function labelled(
  method_id: string,
  source: string,
  entryDay: string,
  over: Partial<RawRoundTrip> = {}
): RawRoundTrip {
  return trip({
    method: { method_id, source },
    entry: { price: 10, price_source: "observed", ts: `${entryDay}T14:00:00Z`, ts_source: "measured" },
    ...over,
  });
}

const REGISTER: DeclaredMethod[] = [
  { id: "overnight-miners-close-to-open", declaredOn: "2026-08-17", hasPaperPrice: true },
  { id: "ivrv-option-screen", declaredOn: "2026-09-13", hasPaperPrice: false },
];

/** Stamps spread evenly across one RTH session, in the offset given. */
function rthStamps(count: number, offsetHours: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const localMin = 10 * 60 + Math.floor((i / count) * 300); // 10:00–15:00 local
    const utcMin = (((localMin - offsetHours * 60) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(utcMin / 60)).padStart(2, "0");
    const mm = String(utcMin % 60).padStart(2, "0");
    out.push(`2026-08-19T${hh}:${mm}:00Z`);
  }
  return out;
}

describe("scanFillTimes", () => {
  it("recovers the offset a genuine fill series was recorded in", () => {
    const scan = scanFillTimes(rthStamps(40, -4));
    expect(scan.bestOffsetHours).toBe(-4);
    expect(scan.bestRthFraction).toBe(1);
    expect(scan.credible).toBe(true);
  });

  it("recovers a different offset just as well, so the answer is not hard-coded to ET", () => {
    const scan = scanFillTimes(rthStamps(40, +9));
    expect(scan.bestOffsetHours).toBe(9);
    expect(scan.credible).toBe(true);
  });

  it("refuses stamps scattered around the clock, and lands near the chance rate", () => {
    const spread: string[] = [];
    for (let h = 0; h < 24; h++) spread.push(`2026-08-19T${String(h).padStart(2, "0")}:15:00Z`);
    const scan = scanFillTimes(spread);
    expect(scan.credible).toBe(false);
    // 6.5 of every 24 hours is RTH, but stamps land on :15, so the sweep hits
    // 10:15 through 15:15 and misses 09:15 and 16:15 — six, not seven.
    expect(scan.bestRthFraction).toBeCloseTo(6 / 24, 5);
    expect(scan.bestRthFraction).toBeLessThan(scan.threshold);
  });

  it("reports zero rather than dividing by nothing on an empty series", () => {
    const scan = scanFillTimes([]);
    expect(scan.n).toBe(0);
    expect(scan.bestRthFraction).toBe(0);
    expect(scan.credible).toBe(false);
  });
});

/**
 * The join reader, which has to be right about four different ways a labelled
 * trip can still fail to be evidence.
 */
describe("labelStatusOf", () => {
  it("reads the nested 1.2 field the producer actually emits", () => {
    expect(
      labelStatusOf(labelled("overnight-miners-close-to-open", "declared_at_entry", "2026-08-19"), REGISTER)
    ).toBe("joins");
  });

  it("still reads the flat 1.1 spelling, so a producer can move either way", () => {
    const flat = trip({
      strategy_id: "overnight-miners-close-to-open",
      entry: { price: 10, price_source: "observed", ts: "2026-08-19T14:00:00Z", ts_source: "measured" },
    });
    expect(labelStatusOf(flat, REGISTER)).toBe("joins");
  });

  it("treats the producer's sentinel as an absence, not as a method named that", () => {
    expect(labelStatusOf(labelled(UNLABELLED_METHOD, "backfill", "2026-08-19"), REGISTER)).toBe(
      "unlabelled"
    );
  });

  /*
   * The distinction 1.2 volunteered and the contract had not asked for. A
   * label written after the outcome was known describes a trade; it does not
   * commit to one.
   */
  it("refuses a backfilled label even when the method is real and the date is fine", () => {
    expect(
      labelStatusOf(labelled("overnight-miners-close-to-open", "backfill", "2026-08-19"), REGISTER)
    ).toBe("backfilled");
  });

  it("refuses a label pointing at a method this site never declared", () => {
    expect(labelStatusOf(labelled("some-other-idea", "declared_at_entry", "2026-08-19"), REGISTER)).toBe(
      "method-not-declared"
    );
  });

  /*
   * THE CASE THAT CATCHES THE REAL LOG. The CLSK trip is labelled
   * ivrv-option-screen and declared_at_entry, and it is not evidence: the
   * screen was declared here on 2026-09-13 and the trade was entered
   * 2026-09-02. It is the trade the declaration was written about.
   */
  it("refuses a trip entered before the method it names was declared here", () => {
    expect(labelStatusOf(labelled("ivrv-option-screen", "declared_at_entry", "2026-09-02"), REGISTER)).toBe(
      "predates-declaration"
    );
    expect(labelStatusOf(labelled("ivrv-option-screen", "declared_at_entry", "2026-09-13"), REGISTER)).toBe(
      "joins"
    );
  });

  it("treats an undatable label as failing rather than passing", () => {
    const noStamp = trip({ method: { method_id: "overnight-miners-close-to-open", source: "declared_at_entry" } });
    expect(labelStatusOf(noStamp, REGISTER)).toBe("predates-declaration");
  });
});

describe("buildLiveLedger", () => {
  it("counts a declared, pre-committed, correctly-dated label as the join key", () => {
    const withKey = buildLiveLedger(
      [labelled("overnight-miners-close-to-open", "declared_at_entry", "2026-08-19")],
      REGISTER
    );
    expect(withKey.joinable).toBe(1);
    expect(withKey.blockers.find((b) => b.id === "no-method-id")).toBeUndefined();
    expect(withKey.statement).toContain("declared before the entry");
  });

  /* Every trip in exactly one bucket, so a reader can add them up. */
  it("partitions the trips, so the buckets sum to the trip count", () => {
    const led = buildLiveLedger(
      [
        labelled("overnight-miners-close-to-open", "declared_at_entry", "2026-08-19"),
        labelled(UNLABELLED_METHOD, "backfill", "2026-08-19"),
        labelled("overnight-miners-close-to-open", "backfill", "2026-08-19"),
        labelled("nope", "declared_at_entry", "2026-08-19"),
        labelled("ivrv-option-screen", "declared_at_entry", "2026-09-02"),
      ],
      REGISTER
    );
    expect(led.labelBreakdown.reduce((s, b) => s + b.trips, 0)).toBe(led.trips);
    expect(led.labelBreakdown).toEqual([
      { status: "joins", trips: 1 },
      { status: "unlabelled", trips: 1 },
      { status: "backfilled", trips: 1 },
      { status: "method-not-declared", trips: 1 },
      { status: "predates-declaration", trips: 1 },
    ]);
  });

  /*
   * A method can be declared and still have no price to difference a fill
   * against. Folding that into "joinable" would report attribution as
   * measurement.
   */
  it("separates a joined method with no paper price from a priced one", () => {
    const led = buildLiveLedger(
      [labelled("ivrv-option-screen", "declared_at_entry", "2026-09-14")],
      REGISTER
    );
    expect(led.joinable).toBe(1);
    expect(led.blockers.find((b) => b.id === "joined-method-has-no-paper-price")?.count).toBe(1);
  });

  it("does not treat a basket ticker as a join", () => {
    const led = buildLiveLedger([trip({ symbol: "RIOT" }), trip({ symbol: "APLD" })], REGISTER);
    expect(led.inDeclaredNames).toBe(2);
    expect(led.joinable).toBe(0);
    expect(led.statement).toContain("coincidence of ticker rather than a join");
  });

  it("excludes the scanned basket from the overlap, since it holds everything", () => {
    // A name in `scanned` but in no industry basket must not count as declared.
    const led = buildLiveLedger([trip({ symbol: "RIOT" })], REGISTER);
    expect(led.declaredNameBreakdown.map((b) => b.basket)).not.toContain("scanned");
    expect(led.declaredNameBreakdown).toContainEqual({ basket: "miners", trips: 1 });
  });

  it("clears the derived-price blocker only when the price was observed", () => {
    const observed = buildLiveLedger(
      [trip({ entry: { price: 10, price_source: "observed", ts: "2026-08-19T14:00:00Z", ts_source: "measured" } })],
      REGISTER
    );
    expect(observed.blockers.find((b) => b.id === "entry-price-derived")).toBeUndefined();
    expect(observed.blockers.find((b) => b.id === "no-entry-timestamp")).toBeUndefined();
  });

  /*
   * `fill` is an observation and the original predicate — anything but the
   * literal string "observed" — counted it as derived. That direction of error
   * is the harder one to notice: it understates the log rather than the
   * blocker, so nothing ever looks wrong.
   */
  it("accepts a fill as an observed price, and still refuses a reconstructed one", () => {
    const at = (price_source: string) =>
      buildLiveLedger(
        [trip({ entry: { price: 10, price_source, ts: "2026-08-19T14:00:00Z", ts_source: "measured" } })],
        REGISTER
      ).blockers.find((b) => b.id === "entry-price-derived");
    expect(at("fill")).toBeUndefined();
    expect(at("weighted_avg_of_three_fills")).toBeUndefined();
    expect(at("derived_from_realized_gain")?.count).toBe(1);
    // Not an allow-anything rule: an unrecognised source stays unobserved.
    expect(at("guessed_from_vibes")?.count).toBe(1);
  });

  it("keeps closed-only standing even on an otherwise perfect row", () => {
    const led = buildLiveLedger(
      [labelled("overnight-miners-close-to-open", "declared_at_entry", "2026-08-19", { hold_sessions: 1 })],
      REGISTER
    );
    // Everything else can be fixed by recording more; this one is about what
    // the log structurally omits, so it must not fall out with the others.
    expect(led.blockers.map((b) => b.id)).toContain("closed-only");
  });

  it("distinguishes an empty log from an unreadable one", () => {
    expect(buildLiveLedger([], REGISTER).source).toBe("read");
    expect(unavailableLedger().source).toBe("unavailable");
    expect(unavailableLedger().statement).toContain("none were seen");
  });

  it("names the question each blocker closes, not just that it blocks", () => {
    const led = buildLiveLedger([trip()], REGISTER);
    for (const b of led.blockers) {
      expect(["register-join", "execution-quality", "any-aggregate"]).toContain(b.blocks);
      expect(b.detail.length).toBeGreaterThan(40);
      expect(b.count).toBeGreaterThan(0);
      expect(b.of).toBeGreaterThanOrEqual(b.count);
    }
  });

  it("keeps realised dollars out of the statement", () => {
    const led = buildLiveLedger([trip({ realized_usd: 5000 })], REGISTER);
    expect(led.realized?.usd).toBe(5000);
    expect(led.statement).not.toContain("5000");
    expect(led.statement).not.toContain("$");
  });
});

/**
 * The register is derived, not typed out, so the failure mode is a paper line
 * that stops being recognised the day it is added. These pin the derivation.
 */
describe("DECLARED_METHODS", () => {
  it("carries every declared paper line, each with its own declaration date", () => {
    expect(DECLARED_METHODS.length).toBeGreaterThan(1);
    for (const m of DECLARED_METHODS) {
      expect(m.id).toBeTruthy();
      expect(m.declaredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(DECLARED_METHODS.filter((m) => m.hasPaperPrice).length).toBeGreaterThan(0);
  });

  it("holds the IV/RV screen as declared-but-unpriced", () => {
    const screen = DECLARED_METHODS.find((m) => m.id === "ivrv-option-screen");
    expect(screen).toBeDefined();
    expect(screen!.hasPaperPrice).toBe(false);
  });

  it("has no duplicate ids, since a duplicate would silently pick a date", () => {
    expect(new Set(DECLARED_METHODS.map((m) => m.id)).size).toBe(DECLARED_METHODS.length);
  });
});

describe("JOIN_CONTRACT", () => {
  it("ties every requested field to the question it unlocks", () => {
    expect(JOIN_CONTRACT.length).toBeGreaterThan(0);
    for (const c of JOIN_CONTRACT) {
      expect(["register-join", "execution-quality", "any-aggregate"]).toContain(c.unlocks);
      expect(c.why.length).toBeGreaterThan(60);
    }
  });

  /*
   * The contract has to name the field the producer EMITS, not the one it was
   * first asked for. A contract still asking for `strategy_id` while the
   * reader accepts `method.method_id` is a document that reads as a defect
   * report on working code — which is how the last round of this went.
   */
  it("names the field schema 1.2 actually carries", () => {
    const join = JOIN_CONTRACT.filter((c) => c.unlocks === "register-join");
    expect(join.some((c) => c.field.includes("method.method_id"))).toBe(true);
    expect(join.some((c) => c.field.includes("method.source"))).toBe(true);
  });

  it("names the half that is this site's job, not the producer's", () => {
    expect(JOIN_CONTRACT.some((c) => c.field.includes("declaration") && c.field.includes("predates"))).toBe(
      true
    );
  });
});

/*
 * Against the committed artefact, not a fixture. A fixture proves the
 * arithmetic; these prove the arithmetic ran on the real log and that the
 * page's central claim is still true of it.
 */
describe("the committed ledger", () => {
  const { ledger } = artifactJson as unknown as { ledger: ReturnType<typeof buildLiveLedger> };

  it("has read the log", () => {
    expect(ledger.source).toBe("read");
    expect(ledger.trips).toBeGreaterThan(0);
  });

  /*
   * Still zero, and the reason has moved. It used to be that no row carried a
   * key; now one does, and it fails on the date instead. Asserting both keeps
   * the page from reverting to "no key exists" once more rows are labelled.
   */
  it("has no joinable trip, and the count is no longer the whole log", () => {
    expect(ledger.joinable).toBe(0);
    const unlabelled = ledger.blockers.find((b) => b.id === "no-method-id")!;
    expect(unlabelled.count).toBeGreaterThan(0);
    expect(unlabelled.count).toBeLessThan(ledger.trips);
  });

  it("catches the labelled trip on the declaration date rather than the column", () => {
    expect(ledger.blockers.find((b) => b.id === "label-predates-declaration")?.count).toBe(1);
    expect(ledger.blockers.find((b) => b.id === "method-not-declared")).toBeUndefined();
  });

  it("partitions every trip, so the breakdown is checkable against the total", () => {
    expect(ledger.labelBreakdown.reduce((s, b) => s + b.trips, 0)).toBe(ledger.trips);
  });

  it("still finds the overlap that must not be mistaken for a join", () => {
    expect(ledger.inDeclaredNames).toBeGreaterThan(0);
    expect(ledger.inDeclaredNames).toBeLessThan(ledger.trips);
  });

  it("rejects the exit stamps as fill times by a wide margin, not a narrow one", () => {
    expect(ledger.fillTimes.credible).toBe(false);
    // Near chance is the claim. A near-threshold reading would mean the
    // convention is merely undocumented rather than the stamps being non-fills.
    expect(ledger.fillTimes.bestRthFraction).toBeLessThan(0.5);
    expect(ledger.fillTimes.bestRthFraction).toBeGreaterThan(ledger.fillTimes.chanceFraction - 0.05);
  });

  it("carries no per-trade detail into the repository", () => {
    const text = JSON.stringify(artifactJson);
    expect(text).not.toContain("roundtrip/1.1\",\"id\"");
    expect(text).not.toMatch(/"order_id"/);
    expect(text).not.toMatch(/"realized_usd"/);
    expect(artifactJson).not.toHaveProperty("ledger.rows");
  });

  it("records where it was read from without naming the operator's account", () => {
    const hint = (artifactJson as { sourceHint: string }).sourceHint;
    expect(hint.startsWith("~") || !hint.includes("/")).toBe(true);
    expect(hint).not.toContain("/Users/");
  });
});
