import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictPanel } from "./DossierSections";
import { TickerDossier } from "@/lib/dossier/types";

/**
 * RENDER ASSERTIONS ON THE SURFACE THAT CARRIES THE TRACK RECORD.
 *
 * Two bugs shipped in one small change that tsc, lint and 2,312 tests all
 * passed: an import placed above `"use client"`, and `rankOpportunities`
 * silently dropping `lastClose` when it rebuilt rows from an explicit field
 * list. Both were visible only by loading the page.
 *
 * The two need different medicine, and conflating them would buy the wrong
 * thing:
 *
 *   the directive bug   is a BUILD error. `npm run build` catches it and
 *                       always did — it was skipped that round, not missing.
 *                       The fix is procedure, not a test.
 *   the dropped field   passes the build, passes the compiler (the field is
 *                       optional), and renders nothing. Only executing the
 *                       component catches it, and that is what this file is.
 *
 * Written with `createElement` rather than JSX so the suite needs no JSX
 * transform, no plugin and no config beyond one include glob — the smaller
 * the harness, the less there is to be wrong about.
 *
 * Rendered with `renderToStaticMarkup` rather than a DOM library on purpose:
 * it needs no jsdom, no new dependency and no environment switch, and it
 * still executes the component for real. What it cannot check is layout or
 * interaction — this is a test that the right WORDS reach the page from the
 * right data, which is precisely the failure class above.
 *
 * The surface is chosen deliberately. On 2026-08-27 this panel starts
 * carrying the first track record, and its most important behaviour is
 * REFUSING a claim when the cell cannot support one. A plumbing break there
 * would publish "bullish calls returned +2.1%" from a single independent
 * period, which is the exact harm the record was built to avoid.
 */

const dossier = (forward: NonNullable<TickerDossier["verdict"]["forward"]>): TickerDossier =>
  ({
    identity: { symbol: "MU", name: "Micron", assetClass: "equity", lastClose: 100, change24hPct: 1, asOf: 0, barsUsed: 300, provenance: "" },
    verdict: {
      emoji: "🟢",
      word: "BULLISH",
      tone: "text-success",
      sentence: "The evidence points up.",
      action: "buy",
      stars: 3,
      evidence: "moderate",
      agreementLine: "signals agree",
      evidenceGrade: { label: "ungraded", validatedWeightPct: 0, note: "" },
      conviction: { level: "moderate", cappedBy: null, sentence: "" },
      forward,
      backdrop: null,
    },
  }) as unknown as TickerDossier;

const base = {
  resolved: 125,
  open: 533,
  baselineReturnPct: 0.4,
  horizonSessions: 10,
  engineNote: null,
};

describe("VerdictPanel — the track-record line actually reaches the page", () => {
  /*
   * THE THURSDAY CASE. 48 resolved bullish calls across ONE independent
   * period. The numbers are real and the claim is not permitted.
   */
  it("REFUSES a claim when the cell cannot support one", () => {
    const html = renderToStaticMarkup(createElement(VerdictPanel, { d: dossier({
          ...base,
          mine: {
            verdict: "bullish",
            n: 48,
            independentN: 1,
            publishable: false,
            hitRatePct: 62,
            meanReturnPct: 2.1,
            edgeVsBaselinePct: 1.7,
          },
        }) }));
    expect(html).toContain("1 independent period");
    expect(html).toContain("not yet a measurement");
    expect(html).toContain("remains a hypothesis");
    // The flattering figures must NOT be presented as a record.
    expect(html).not.toContain("62%");
    expect(html).not.toContain("an edge of");
  });

  it("states the record once the cell is publishable", () => {
    const html = renderToStaticMarkup(createElement(VerdictPanel, { d: dossier({
          ...base,
          mine: {
            verdict: "bullish",
            n: 400,
            independentN: 12,
            publishable: true,
            hitRatePct: 58,
            meanReturnPct: 2.1,
            edgeVsBaselinePct: 1.7,
          },
        }) }));
    expect(html).toContain("58%");
    expect(html).toContain("an edge of");
    expect(html).not.toContain("not yet a measurement");
  });

  it("says nothing is scored yet rather than implying a result", () => {
    const html = renderToStaticMarkup(createElement(VerdictPanel, { d: dossier({ ...base, resolved: 0, mine: null }) }));
    expect(html).toContain("no scored record yet");
    expect(html).toContain("hypothesis");
  });

  /*
   * The legacy label is the engine-versioning guarantee made visible. A
   * figure from the retired engine quoted without it is the failure that
   * whole mechanism exists to prevent.
   */
  it("carries the legacy label whenever it leans on retired-engine figures", () => {
    const html = renderToStaticMarkup(createElement(VerdictPanel, { d: dossier({
          ...base,
          engineNote: "Scored on the retired chart-only engine.",
          mine: {
            verdict: "bullish",
            n: 400,
            independentN: 12,
            publishable: true,
            hitRatePct: 58,
            meanReturnPct: 2.1,
            edgeVsBaselinePct: 1.7,
          },
        }) }));
    expect(html).toContain("retired chart-only engine");
  });
});
