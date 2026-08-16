import { INDUSTRIES } from "@/lib/markets/industries";
import { IndustryRead } from "@/lib/markets/industryIntelligence";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { RotationRead, RotationState } from "@/lib/markets/rotation";
import { composeMacroSummary } from "./narrative";
import { available, MacroContext, Read, unavailable } from "./types";

/**
 * EVERY TICKER ARRIVES WITH ITS CONTEXT.
 *
 * A stock is never just itself. The same chart is a different trade inside a
 * leading sector on a risk-on tape than inside a lagging one while credit is
 * deteriorating — and asking a user to go and look that up separately is
 * asking them to do the work this platform exists to do.
 *
 * Everything here is LOOKED UP, never recomputed: the risk regime, the sector
 * board and the industry reads are already built by the daily intelligence
 * snapshot, and rebuilding any of them for one ticker would create a second
 * opinion about the same market.
 *
 * The only derivation is membership — which industry, if any, a searched
 * symbol belongs to — and that is a declared fact in the taxonomy rather than
 * a judgement.
 */

/** Symbol -> the industry that lists it. Built once; the taxonomy is static. */
const INDUSTRY_OF = new Map<string, { slug: string; name: string; sectorEtf: string; sectorName: string }>();
for (const i of INDUSTRIES) {
  for (const c of [i.etf, ...i.constituents]) {
    // First declaration wins. A symbol in two industries is a taxonomy bug,
    // not something to average — and silently blending two would hide it.
    if (!INDUSTRY_OF.has(c)) {
      INDUSTRY_OF.set(c, { slug: i.slug, name: i.name, sectorEtf: i.sectorEtf, sectorName: i.sectorName });
    }
  }
}

export interface MacroInputs {
  symbol: string;
  assetClass: "equity" | "crypto";
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  industries: IndustryRead[];
  /** Volatility/rates/dollar/credit sentences from macroBackdrop.ts, when fetched. */
  backdropLines?: string[] | null;
}

export function buildMacroContext(inputs: MacroInputs): Read<MacroContext> {
  const { symbol, assetClass, regime, rotation, industries } = inputs;

  /*
   * Crypto does not inherit the equity tape. Risk-on/risk-off here is built
   * from credit and equity-beta pairs; applying it to BTC would import an
   * unrelated market's condition, which is the same category error that had
   * gold scoring on equity breadth before cross-asset instruments were
   * removed from the snapshot.
   */
  if (assetClass === "crypto") {
    return unavailable(
      "not-applicable",
      "The risk regime and sector rotation on this platform are built from equity and credit instruments. They describe the stock market, so they are deliberately not applied to crypto — a different market with different drivers."
    );
  }

  if (!regime && !rotation) {
    return unavailable(
      "no-provider",
      "The market intelligence snapshot could not be loaded, so no macro context is available for this read."
    );
  }

  const membership = INDUSTRY_OF.get(symbol) ?? null;
  const industry = membership ? (industries.find((i) => i.slug === membership.slug) ?? null) : null;
  const sector = membership && rotation ? (rotation.sectors.find((s) => s.symbol === membership.sectorEtf) ?? null) : null;

  const regimeLabel = regime?.regime ?? "mixed";
  const industryState: RotationState | null = industry?.rotation.state ?? null;
  const sectorState: RotationState | null = sector?.state ?? industry?.sectorState ?? null;

  return available(
    {
      regime: regimeLabel,
    regimeDetail: regime
      ? `${regime.agreeing} of ${regime.total} independent risk pairs agree.`
      : "The risk regime could not be built this cycle.",
    sectorName: membership?.sectorName ?? null,
    sectorState,
    sectorLine:
      membership && sectorState
        ? `${membership.sectorName} is ${sectorState} against the S&P — ${describeState(sectorState)}`
        : null,
    industryName: membership?.name ?? null,
    industryState,
    industrySlug: membership?.slug ?? null,
    industryLine: industry
      ? `${industry.name} is ${industry.rotation.state} against the S&P` +
        (industry.breadthPct !== null
          ? `, with ${industry.breadthPct}% of its companies individually beating the market.`
          : ".")
      : membership
        ? `${membership.name} is a tracked industry, but it could not be measured this cycle.`
        : null,
      summary: composeMacroSummary({
        regime: regimeLabel,
        sectorName: membership?.sectorName ?? null,
        sectorState,
        industryName: membership?.name ?? null,
        industryState,
      }),
      backdropLines: inputs.backdropLines ?? null,
    },
    /*
     * MEASURED, not merely descriptive: the regime is three independent
     * instrument pairs, the rotation board spans twelve sectors, and the
     * backdrop now carries volatility, rates, the dollar and credit. The
     * upgrade this section used to name — ingest those four legs — was
     * DELIVERED, and the tier deliberately did not rise for it: more inputs
     * make a richer description, and only a forward-tested record makes a
     * validated one. The upgrade line now names that honest last step.
     */
    "advanced",
    {
      to: "institutional",
      when: "the regime and backdrop reads are scored against their own forward record, so 'risk-off' carries a measured consequence rather than a description",
    }
  );
}

/** What each rotation state means for someone deciding, in one clause. */
function describeState(state: RotationState): string {
  switch (state) {
    case "leading":
      return "money is already here and still arriving.";
    case "improving":
      return "money is rotating in, and this is the earliest and least crowded of the four states.";
    case "weakening":
      return "money is rotating out, which is the most dangerous state to buy because the longer-term number still looks good.";
    default:
      return "money is elsewhere and has not turned.";
  }
}

/**
 * A ticker with no industry in the taxonomy still gets the regime — the tape
 * applies to everything listed on it, whether or not this platform has
 * classified the name. Exported for the page's own honesty note.
 */
export function isTrackedIndustryMember(symbol: string): boolean {
  return INDUSTRY_OF.has(symbol);
}
