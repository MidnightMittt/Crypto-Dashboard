import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardRecord } from "./ForwardRecord";
import { ForwardVerdictRecord, VerdictCell, VerdictPrediction } from "@/lib/research/forwardVerdict";

/**
 * THE SECTION THAT CARRIES THE ONLY OUT-OF-SAMPLE CLAIM ON THE SITE.
 *
 * Same medicine as VerdictPanel.render.test.tsx and for the same reason: the
 * failures that matter here pass tsc, pass lint, and are visible only by
 * executing the component. Written with `createElement` and rendered with
 * `renderToStaticMarkup` so the suite needs no JSX transform and no jsdom.
 *
 * Three properties are asserted, and each of them is a claim rather than a
 * layout preference:
 *
 *   the empty record still renders     hiding it would make a site with 1,192
 *                                      open calls look like it had never made
 *                                      one
 *   a refused cell keeps its refusal   the numbers show, the claim does not
 *   a refused cell sorts last          the top row is read as a recommendation
 */

const cell = (over: Partial<VerdictCell> = {}): VerdictCell => ({
  verdict: "bullish",
  n: 40,
  independentN: 12,
  hitRatePct: 61,
  meanReturnPct: 2.4,
  medianReturnPct: 1.8,
  edgeVsBaselinePct: 1.2,
  claim: "Bullish calls beat the register by 1.2 points over 12 independent periods.",
  publishable: true,
  ...over,
});

const pred = (over: Partial<VerdictPrediction> = {}): VerdictPrediction => ({
  date: "2026-09-01",
  symbol: "AMD",
  verdict: "bullish",
  confidence: 60,
  closePrice: 100,
  forwardReturnPct: null,
  resolvedDate: null,
  ...over,
});

const record = (over: Partial<ForwardVerdictRecord> = {}): ForwardVerdictRecord => ({
  version: 1,
  horizonSessions: 10,
  generatedAt: 0,
  predictions: [],
  cells: [],
  baselineReturnPct: null,
  totals: { resolved: 0, open: 0 },
  ...over,
});

const render = (r: ForwardVerdictRecord) => renderToStaticMarkup(createElement(ForwardRecord, { record: r }));

describe("ForwardRecord", () => {
  /*
   * The state the section is actually in today, and the one most likely to
   * be "cleaned up" by someone who sees an empty array and adds a guard.
   * An empty register is a measurement: it says twelve hundred calls are on
   * the clock, which is a far stronger statement than a page with no
   * section on it makes.
   */
  it("renders the finding and the pending count when nothing has resolved", () => {
    const html = render(
      record({
        engine: 2,
        totals: { resolved: 0, open: 1192 },
        finding: "Nothing has resolved yet. The record is empty, which is not the same as neutral.",
        cannotYetAnswer: ["1192 calls are still inside their 10-session window."],
        predictions: [pred(), pred({ symbol: "NVDA", engine: 2 })],
      })
    );
    expect(html).toContain("which is not the same as neutral");
    expect(html).toContain("1,192");
    expect(html).toContain("still inside their window");
    expect(html).toContain("1192 calls are still inside their 10-session window.");
    // The refusal for the empty cell list, naming both thresholds.
    expect(html).toContain("No cell publishes yet");
    expect(html).toContain("30 resolved calls");
    expect(html).toContain("8 independent periods");
  });

  it("shows a refused cell's numbers AND its refusal, never the numbers alone", () => {
    const html = render(
      record({
        totals: { resolved: 206, open: 0 },
        cells: [
          cell({
            verdict: "bearish",
            n: 206,
            independentN: 1,
            edgeVsBaselinePct: 1.39,
            publishable: false,
            claim: "NO CLAIM. 206 resolved calls, but only 1 independent period.",
          }),
        ],
      })
    );
    expect(html).toContain("+1.39%");
    expect(html).toContain("independent n=1");
    expect(html).toContain("NO CLAIM.");
  });

  /*
   * A gaudy point estimate from one independent period must not take the top
   * row. Asserted by index in the markup rather than by presence, because
   * both cells are present either way — the ordering IS the finding.
   */
  it("sorts an unpublishable cell below a publishable one however flattering it looks", () => {
    const html = render(
      record({
        totals: { resolved: 300, open: 0 },
        cells: [
          cell({ verdict: "neutral", edgeVsBaselinePct: 99, independentN: 1, publishable: false }),
          cell({ verdict: "bearish", edgeVsBaselinePct: 0.1 }),
        ],
      })
    );
    expect(html.indexOf("bearish")).toBeLessThan(html.indexOf("neutral"));
  });

  /*
   * A refused number must not wear a signal colour. Green on +1.39% beside a
   * red mean of -1.49% reads as a win at a glance, and the reader who only
   * glances is exactly the one the refusal is written for.
   */
  it("paints a refused cell's figures muted rather than green or red", () => {
    const html = render(
      record({
        totals: { resolved: 206, open: 0 },
        cells: [cell({ edgeVsBaselinePct: 1.39, meanReturnPct: -1.49, publishable: false })],
      })
    );
    expect(html).toContain("text-ink-muted");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-danger");
  });

  it("labels the retired engine as adjacent evidence rather than folding it into the headline", () => {
    const html = render(
      record({
        engine: 2,
        totals: { resolved: 0, open: 1192 },
        finding: "Nothing has resolved yet.",
        legacy: {
          engine: 1,
          note: "Scored on the retired chart-only engine.",
          cells: [cell({ publishable: false, claim: "NO CLAIM." })],
          baselineReturnPct: -0.1,
          totals: { resolved: 658, open: 0 },
        },
      })
    );
    expect(html).toContain("658");
    expect(html).toContain("Scored on the retired chart-only engine.");
    // The headline is still the current engine's, not the legacy count.
    expect(html).toContain("Nothing has resolved yet.");
    expect(html).toContain("engine 2");
  });
});
