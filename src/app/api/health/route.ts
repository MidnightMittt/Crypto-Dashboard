import { NextResponse } from "next/server";
import { kvConfigured, kvGet, kvSet } from "@/lib/store/kv";
import { readHistory } from "@/lib/history/store";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — configuration and storage diagnostics.
 *
 * WHY THIS EXISTS: "the chart is empty on Vercel" has several possible
 * causes that look identical from outside — credentials absent, credentials
 * present but wrong, Redis unreachable, or simply not enough time elapsed.
 * Distinguishing them previously meant enabling verbose provider logging and
 * reading platform logs. This answers it in one request.
 *
 * SAFETY: reports only booleans, key NAMES, and counts. No credential value
 * or fragment is ever returned, so this is safe to leave enabled and safe to
 * paste into a chat.
 */
export async function GET() {
  const optionalKeys = [
    "COINALYZE_API_KEY",
    "HELIUS_API_KEY",
    "SOLANA_RPC_URL",
    "THE_GRAPH_API_KEY",
    "ALCHEMY_API_KEY",
    "JUPITER_API_KEY",
    "ANTHROPIC_API_KEY",
  ];

  // Presence only — never the value.
  const keysPresent: Record<string, boolean> = {};
  for (const k of optionalKeys) keysPresent[k] = Boolean(process.env[k]?.trim());

  // Which of the two accepted naming conventions supplied the credentials.
  const kvVars = {
    KV_REST_API_URL: Boolean(process.env.KV_REST_API_URL?.trim()),
    KV_REST_API_TOKEN: Boolean(process.env.KV_REST_API_TOKEN?.trim()),
    UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim()),
    UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN?.trim()),
  };

  /*
   * A real write-then-read round trip. `kvConfigured()` only proves the
   * variables exist; this proves the credentials actually work, which is the
   * distinction that matters when history isn't accumulating.
   */
  let kvRoundTrip: "ok" | "failed" | "not-configured" = "not-configured";
  if (kvConfigured()) {
    try {
      const probe = `health:probe:${Date.now()}`;
      await kvSet(probe, { ok: true }, 60);
      const read = await kvGet<{ ok?: boolean }>(probe);
      kvRoundTrip = read?.ok === true ? "ok" : "failed";
    } catch {
      kvRoundTrip = "failed";
    }
  }

  // How much history each asset has actually accumulated. On an ephemeral
  // filesystem these stay at 0 forever, which is the symptom this endpoint
  // was written to explain.
  const history: Record<string, number> = {};
  await Promise.all(
    ([...ALL_ASSETS, "MARKET"] as Array<AssetSymbol | "MARKET">).map(async (asset) => {
      try {
        history[asset] = (await readHistory(asset)).length;
      } catch {
        history[asset] = -1; // read threw
      }
    })
  );

  const totalPoints = Object.values(history).reduce((s, n) => s + Math.max(n, 0), 0);

  return NextResponse.json({
    storage: {
      backend: kvConfigured() ? "redis" : "filesystem",
      kvRoundTrip,
      kvVars,
      // The filesystem backend cannot persist on serverless — flagged rather
      // than left for someone to rediscover.
      warning: kvConfigured()
        ? undefined
        : "No Redis credentials found. History writes go to the local filesystem, " +
          "which does not survive on serverless — the chart and OI percentile will " +
          "stay empty. Attach an Upstash database and REDEPLOY.",
    },
    history: { pointsByAsset: history, totalPoints },
    keysPresent,
    env: process.env.NODE_ENV,
    now: Date.now(),
  });
}
