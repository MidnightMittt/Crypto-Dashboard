import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Scoped to the numeric core: sentiment scoring, gauge math, and formatting.
 *
 * This project has had three silent wrong-number bugs reach the dashboard
 * (a x100 unit mismatch, a self-referential percentile, a median-of-two bias)
 * — none of them crashed anything, they just produced a plausible-looking
 * wrong figure.
 *
 * ── Why components were excluded, and why that exception narrowed ─────
 *
 * The original reasoning was that mocking 23 exchange APIs would test the
 * mocks more than the code. That is still true of network adapters and they
 * stay out. It was never true of a PRESENTATIONAL component handed a plain
 * object, and conflating the two cost real money's worth of confidence: two
 * bugs shipped in one small change that tsc, lint and 2,312 tests all
 * passed — an import above `"use client"`, and a ranking function silently
 * dropping a field when it rebuilt rows from an explicit list. The second
 * rendered nothing at all, and the suite could not have caught it because
 * it never looked at a component.
 *
 * So `.test.tsx` under components/ is now IN SCOPE. The rule for what
 * belongs there: render a component from a literal and assert the words a
 * reader would see. No network, no mocks, no DOM library — those tests
 * would go back to testing the harness. `renderToStaticMarkup` runs in the
 * node environment and needs neither.
 */
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts", "src/components/**/*.test.tsx", "scripts/backtest/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/lib/sentiment/**", "src/lib/utils/format.ts", "src/lib/utils/gaugeMath.ts", "src/lib/utils/gaugeTrail.ts"],
    },
  },
  /*
   * The app's tsconfig sets `jsx: preserve` for Next's own transform, which
   * leaves vite unable to parse a component. This overrides it for the test
   * run only — it changes nothing about how the app is built.
   */
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
