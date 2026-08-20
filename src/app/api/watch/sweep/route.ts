import { NextRequest, NextResponse } from "next/server";
import { sendDiscord } from "@/lib/alerts/channels/discord";
import { WatchQuote, evaluateAll, markFired } from "@/lib/watch/levels";
import { WatchStoreUnavailable, loadLevels, saveLevels } from "@/lib/watch/store";
import { isArmed } from "@/lib/watch/levels";

/**
 * THE SWEEP — one pass over every armed level.
 *
 * Driven by a schedule rather than by the trading loop, because the trading
 * loop dying is the event this exists for. Idempotent by construction: a
 * level fires once (see levels.ts), so running twice in a minute cannot
 * double-alert, and a missed run costs latency rather than a trigger.
 *
 * ── Fire first, deliver second, and never lose the fire ───────────────
 *
 * The breach is recorded to durable storage regardless of whether the
 * notification sends. A webhook that is misconfigured, rate-limited or
 * revoked must not be able to erase the fact that a stop was hit — the level
 * is marked fired with `delivered: false`, and GET /api/watch surfaces those
 * ids under `undelivered` so a poll can recover what the push dropped.
 *
 * ── Why quotes are fetched, not read from the panel ───────────────────
 *
 * The committed bars panel is daily closes. A stop evaluated against it could
 * only fire once a day, hours after the level was crossed. This reads the
 * same keyless Yahoo chart endpoint the dossier already uses, at a one-minute
 * interval, and refuses to fire on anything older than one sweep window.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One minute of bars over the last day: the freshest keyless print available. */
const QUOTE_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
  `?range=1d&interval=1m`;

/**
 * Vercel Cron sends this header. When CRON_SECRET is set the route requires
 * it, so a public URL cannot be used to hammer Yahoo or spam the webhook.
 * Unset, the route stays open — which is correct for local testing and is
 * stated rather than hidden.
 */
function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function fetchQuote(symbol: string, now: Date): Promise<WatchQuote | null> {
  try {
    const res = await fetch(QUOTE_URL(symbol), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; regularMarketTime?: number };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const r = json.chart?.result?.[0];
    if (!r) return null;

    /*
     * Prefer the last minute bar that actually printed over meta's
     * regularMarketPrice: the meta field can carry a pre/post-market or
     * previous-session value with no indication of which, and the bar's own
     * timestamp is what makes the age check meaningful.
     */
    const closes = r.indicators?.quote?.[0]?.close;
    const ts = r.timestamp;
    let price: number | null = null;
    let asOfMs: number | null = null;
    if (closes && ts) {
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (typeof c === "number" && Number.isFinite(c)) {
          price = c;
          asOfMs = ts[i] * 1000;
          break;
        }
      }
    }
    if (price === null || asOfMs === null) {
      const p = r.meta?.regularMarketPrice;
      const t = r.meta?.regularMarketTime;
      if (typeof p !== "number" || typeof t !== "number") return null;
      price = p;
      asOfMs = t * 1000;
    }

    return {
      symbol,
      price,
      asOf: new Date(asOfMs).toISOString(),
      ageSeconds: Math.max(0, (now.getTime() - asOfMs) / 1000),
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const now = new Date();
  try {
    const levels = await loadLevels();
    const armed = levels.filter(isArmed);
    if (armed.length === 0) {
      return NextResponse.json({ sweptAt: now.toISOString(), armed: 0, fired: [], skipped: [] });
    }

    // One fetch per distinct symbol, not per level.
    const symbols = [...new Set(armed.map((l) => l.symbol))];
    const quotes = new Map<string, WatchQuote>();
    await Promise.all(
      symbols.map(async (s) => {
        const q = await fetchQuote(s, now);
        if (q) quotes.set(s, q);
      })
    );

    const results = evaluateAll(armed, quotes, now);
    const fired: Array<{ id: string; symbol: string; message: string; delivered: boolean }> = [];
    const updates = new Map<string, ReturnType<typeof markFired>>();

    for (const r of results) {
      if (r.kind !== "fired") continue;
      const delivered = await sendDiscord(r.message);
      updates.set(r.level.id, markFired(r.level, r.quote, now, delivered));
      fired.push({ id: r.level.id, symbol: r.level.symbol, message: r.message, delivered });
    }

    if (updates.size > 0) {
      await saveLevels(levels.map((l) => updates.get(l.id) ?? l));
    }

    return NextResponse.json({
      sweptAt: now.toISOString(),
      armed: armed.length,
      quoted: quotes.size,
      fired,
      // Reasons, not silence: a stuck feed must not read as a quiet market.
      skipped: results
        .filter((r) => r.kind === "skipped")
        .map((r) => ({ id: r.level.id, symbol: r.level.symbol, reason: r.kind === "skipped" ? r.reason : "" })),
    });
  } catch (err) {
    if (err instanceof WatchStoreUnavailable) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("[watch/sweep] failed:", err);
    return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
  }
}
