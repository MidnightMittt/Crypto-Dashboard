import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Scoped to the numeric core: sentiment scoring, gauge math, and formatting.
 *
 * This project has had three silent wrong-number bugs reach the dashboard
 * (a x100 unit mismatch, a self-referential percentile, a median-of-two bias)
 * — none of them crashed anything, they just produced a plausible-looking
 * wrong figure. Component rendering and network adapters are covered by
 * manual verification against live data instead, since mocking 23 exchange
 * APIs would test the mocks more than the code.
 */
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/lib/sentiment/**", "src/lib/utils/format.ts", "src/lib/utils/gaugeMath.ts", "src/lib/utils/gaugeTrail.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
