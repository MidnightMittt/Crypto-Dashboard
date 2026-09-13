import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RestatementNote } from "./RestatementNote";
import { SignalBreakdown } from "@/components/dashboard/SignalBreakdown";
import { MetricVerdict, Verdict } from "@/lib/signals/types";

/**
 * THE DISCLOSURE IS THE WHOLE POINT. The score already stopped counting
 * longShort; if this text does not reach the DOM, the engine is honest and the
 * reader is still looking at two opposite badges with no explanation.
 *
 * Rendered rather than grepped, per this suite's own rule, because of how this
 * particular change fails: `RestatementNote` returns null for nearly every id
 * by design, so an import that is never rendered, a prop threaded wrong, or an
 * id that does not match RESTATED_READS all produce exactly what a correct
 * build produces — nothing.
 *
 * The last test is the one that earns its keep: it renders the real
 * `SignalBreakdown` and looks for the disclosure inside it. A test that only
 * ever mounts the note in isolation keeps passing after someone deletes the
 * `<RestatementNote />` line from every surface that matters.
 */

const metric = (id: string, label: string, verdict: Verdict = "bullish"): MetricVerdict => ({
  id,
  label,
  verdict,
  confidence: 70,
  confidenceBasis: "",
  explanation: `${label} explanation`,
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("RestatementNote", () => {
  it("discloses that longShort mirrors squeezeRisk, naming the relation and the sample", () => {
    const html = render(createElement(RestatementNote, { metricId: "longShort" }));
    expect(html).toContain("Mirror of another read");
    expect(html).toContain("Squeeze Setup");
    // The measurement, not merely an assertion of non-independence.
    expect(html).toContain("1,181");
  });

  it("says which reading the score took, so a zero weight is explained rather than just shown", () => {
    const html = render(createElement(RestatementNote, { metricId: "longShort" }));
    // Apostrophes render HTML-escaped, so the assertion stops short of one.
    expect(html).toContain("the score takes Squeeze Setup");
    expect(html).toContain("without claiming a direction for it");
  });

  it("renders nothing for the module that DOES carry the axis", () => {
    // squeezeRisk is the read the score uses. Labelling it a restatement too
    // would make the pair look symmetric and leave a reader with no idea which
    // of the two the number came from.
    expect(render(createElement(RestatementNote, { metricId: "squeezeRisk" }))).toBe("");
  });

  it("renders nothing for spotPerpVolume, which now publishes no direction at all", () => {
    // It was the other half of the same defect. A disclosure here would
    // describe a directional claim it has stopped making.
    expect(render(createElement(RestatementNote, { metricId: "spotPerpVolume" }))).toBe("");
  });

  it("renders nothing for an ordinary independent voter", () => {
    expect(render(createElement(RestatementNote, { metricId: "funding" }))).toBe("");
    expect(render(createElement(RestatementNote, { metricId: "etfFlows" }))).toBe("");
  });

  it("renders nothing for an unknown id rather than throwing", () => {
    expect(render(createElement(RestatementNote, { metricId: "notAModule" }))).toBe("");
  });

  it("reaches the reader through SignalBreakdown, where the two sit as adjacent rows", () => {
    const html = render(
      createElement(SignalBreakdown, {
        metrics: [
          metric("squeezeRisk", "Squeeze Setup", "bearish"),
          metric("longShort", "Long/Short Positioning", "bullish"),
        ],
      })
    );
    // Both rows still render — the aim is not to hide the second read.
    expect(html).toContain("Squeeze Setup");
    expect(html).toContain("Long/Short Positioning");
    // And the opposite badges are explained rather than left to read as two
    // independent analysts disagreeing.
    expect(html).toContain("Mirror of another read");
  });
});
