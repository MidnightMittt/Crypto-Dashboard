/**
 * The running decision engine's version, as a property of the ENGINE.
 *
 * This constant used to live in scripts/backtest/version.ts, which was fine
 * while only the replay cared. 9.1.0 changed that: src/data/scorePivots.json
 * is a calibration measured under one engine and applied by the live site, and
 * `pivotsForAsset` refuses it when the two disagree. That check needs a
 * running-engine version the site can see without importing a backtest script.
 *
 * So the constant is here and scripts/backtest/version.ts re-exports it. The
 * CHANGELOG stays there — it is a record of replay-affecting changes and it is
 * long — and that file is still the thing to read and to edit when bumping.
 * Bump there, in the same commit as the entry explaining why.
 */
export const ENGINE_VERSION = "9.1.0";
