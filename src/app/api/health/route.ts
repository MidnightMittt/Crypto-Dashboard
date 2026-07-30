import { NextResponse } from "next/server";
import { kvConfigured, kvGet, kvSet } from "@/lib/store/kv";
import { readHistory } from "@/lib/history/store";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";
import { coinalyzeDiagnostics } from "@/lib/providers/coinalyze";

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

  /*
   * Live probe of Coinalyze.
   *
   * A configured key that returns no venues has two very different causes —
   * the key is rejected, or it's accepted but nothing maps through — and they
   * are indistinguishable from the aggregate payload. Worse, "venues sourced
   * from coinalyze" is a misleading metric now that 20 direct adapters
   * supersede it: Coinalyze can be working perfectly and still show zero,
   * because first-hand data wins and the row keeps source="direct".
   *
   * So this asks Coinalyze itself and reports the HTTP status. The key is
   * sent as a query parameter, as that API requires, and is never echoed
   * back in the response.
   */
  const coinalyzeKey = process.env.COINALYZE_API_KEY?.trim();
  let coinalyze: {
    configured: boolean;
    status: number | null;
    exchanges: number | null;
    hint?: string;
  } = { configured: Boolean(coinalyzeKey), status: null, exchanges: null };

  if (coinalyzeKey) {
    try {
      const res = await fetch(
        `https://api.coinalyze.net/v1/exchanges?api_key=${encodeURIComponent(coinalyzeKey)}`,
        { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) }
      );
      const body = await res.text();
      let count: number | null = null;
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) count = parsed.length;
      } catch {
        /* not JSON — status alone is the useful signal */
      }
      coinalyze = {
        configured: true,
        status: res.status,
        exchanges: count,
        hint:
          res.status === 401 || res.status === 403
            ? "Key rejected — regenerate at coinalyze.net/account/api-key/"
            : res.status === 429
              ? "Rate limited — 40 calls/min, each symbol counts as one"
              : res.ok
                ? "Key is valid and accepted"
                : `Unexpected HTTP ${res.status}`,
      };
    } catch (err) {
      coinalyze = {
        configured: true,
        status: null,
        exchanges: null,
        hint: `Request failed: ${err instanceof Error ? err.name : "unknown"}`,
      };
    }
  }

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
    providers: { coinalyze, coinalyzeDetail: await coinalyzeDiagnostics("BTC").catch((e) => ({ error: String(e) })) },
    keysPresent,
    env: process.env.NODE_ENV,
    now: Date.now(),
  });
}
