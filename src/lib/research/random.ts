/**
 * Deterministic pseudo-randomness for the research layer.
 *
 * Lives here rather than beside any one estimator because every resampling
 * method needs it and none of them should own it. Seeded, never
 * `Math.random`: a bootstrap p-value that changes between runs is not a
 * result, and reproducibility is a stated requirement of the framework
 * rather than a nicety.
 */

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over a cryptographic generator because research resampling needs
 * reproducibility and speed, not unpredictability, and over `Math.random`
 * because that cannot be seeded. Period is 2^32, which is far beyond the
 * few million draws a bootstrap performs.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
