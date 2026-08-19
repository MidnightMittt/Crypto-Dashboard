import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PositioningHistory, PositioningPoint } from "../../src/lib/history/positioningHistory";
import { BaselineSet, baselinesFor } from "../../src/lib/history/positioningBaseline";

/**
 * THE LATEST POSITIONING ROW PER SYMBOL — a small artefact for a fast route.
 *
 * positioningHistory.json is 6.4MB and grows daily. Importing it into a
 * serverless route means parsing all of it on every cold start to answer a
 * question about one session, which is the wrong trade for an endpoint whose
 * entire purpose is to collapse a slow assembly into one quick call.
 *
 * This derives one row per symbol — about twelve — and nothing else. The full
 * history remains the source of truth and is what /api/positioning serves;
 * this is a projection of it, regenerated whenever the recorder runs so the
 * two cannot drift.
 *
 *   npx tsx scripts/ingest/buildPositioningLatest.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(__dirname_, "..", "..", "src", "data", "positioningHistory.json");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "positioningLatest.json");

/**
 * The latest row PLUS where each of its numbers sits in that symbol's own
 * history — the positional read, precomputed.
 *
 * It is computed HERE rather than in the API route because the history is
 * 6.5MB and the projection is 33KB. A route importing the store to rank one
 * number against it would carry the whole archive into every serverless
 * bundle, for a figure that changes once a day.
 */
export type PositioningLatestRow = PositioningPoint & { baselines: BaselineSet };

export function buildLatest(points: PositioningPoint[]): PositioningLatestRow[] {
  const bySymbol = new Map<string, PositioningPoint>();
  for (const p of points) {
    const prior = bySymbol.get(p.symbol);
    /*
     * Latest DATE wins, and a live row beats a backfill on the same date —
     * the same precedence appendPoints enforces, restated here so a
     * projection can never disagree with the store it projects.
     */
    if (!prior || p.date > prior.date || (p.date === prior.date && p.origin === "live")) {
      bySymbol.set(p.symbol, p);
    }
  }
  return [...bySymbol.values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((p) => ({ ...p, baselines: baselinesFor(points, p) }));
}

function main(): void {
  if (!fs.existsSync(IN)) {
    console.log("[positioning-latest] no history yet — nothing to project.");
    return;
  }
  const history = JSON.parse(fs.readFileSync(IN, "utf8")) as PositioningHistory;
  const latest = buildLatest(history.points ?? []);
  fs.writeFileSync(
    OUT,
    JSON.stringify({ version: 1, generatedAt: Date.now(), points: latest }, null, 0)
  );
  const withGamma = latest.filter((p) => p.netGexUsdPer1Pct !== null).length;
  console.log(
    `[positioning-latest] ${latest.length} symbols (${withGamma} with gamma) -> ${OUT}`
  );
}

main();
