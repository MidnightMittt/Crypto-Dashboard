/**
 * The one place the shipped calibration enters the running site.
 *
 * Separated from scorePivots.ts on purpose. That module is imported by
 * scoring.ts and therefore by nearly everything; this one statically imports a
 * JSON artifact, and pulling that into every consumer of the scoring types
 * would put a data file in bundles that only need a function signature.
 *
 * There is exactly ONE calibrated call site — the crypto aggregator, whose
 * edge-basis composite is the thing the replay reproduces. Everything else
 * keeps a hard 50, deliberately:
 *
 *   liveAnalysis.ts     the search surface, arbitrary symbols, never replayed.
 *   buildMarketsSnapshot.ts  equities on the STATE basis — a different metric
 *                       roster with a different distribution, so a pivot
 *                       measured on the crypto edge composite does not
 *                       describe it. Uncalibrated is the honest state, not an
 *                       oversight; calibrating it would need its own replay.
 *
 * `pivotsForAsset` handles the rest: an artifact stamped for a different
 * ENGINE_VERSION, or an asset that was never in the replay universe, both fall
 * back to neutral rather than applying a correction nobody measured.
 */
import artifact from "@/data/scorePivots.json";
import { ENGINE_VERSION } from "./engineVersion";
import { ScorePivotArtifact, ScorePivots, pivotsForAsset } from "./scorePivots";

const ARTIFACT = artifact as ScorePivotArtifact;

/** Pivots for one asset under the running engine, or neutral. */
export function livePivotsFor(asset: string): ScorePivots {
  return pivotsForAsset(ARTIFACT, ENGINE_VERSION, asset);
}

/** For the UI/provenance: when the shipped calibration was last measured. */
export function livePivotProvenance(): { engineVersion: string; through: string; generatedAt: string } {
  return {
    engineVersion: ARTIFACT.engineVersion,
    through: ARTIFACT.through,
    generatedAt: ARTIFACT.generatedAt,
  };
}
