import { NextRequest, NextResponse } from "next/server";
import { sendDiscord } from "@/lib/alerts/channels/discord";
import { WatchQuote, evaluateAll, markFired } from "@/lib/watch/levels";
import { WatchStoreUnavailable, loadLevels, saveLevels } from "@/lib/watch/store";
import { recordSweep } from "@/lib/watch/heartbeatStore";
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

/**
 * One minute of bars over the last day, INCLUDING pre- and post-market.
 *
 * Without `includePrePost` the feed carries regular hours only — 6.5 of 24
 * clock hours — so the watchdog was awake exactly when the trading loop was
 * and asleep exactly when it was not, which inverts its entire purpose. A
 * sweep at 05:35Z found every level skipped on a 597-minute-old quote while
 * two disaster stops sat armed on real positions.
 *
 * Measured on CIFR from the dead zone before the pre-market open:
 *
 *   interval=1m                    391 bars, last $17.21, 671 min old
 *   interval=1m&includePrePost     891 bars, last $17.01, 431 min old
 *
 * The extended feed does not merely arrive sooner — it saw a price 1.2%
 * LOWER that the regular feed hid completely. On a stop, that difference is
 * the whole question.
 *
 * Coverage becomes roughly 04:00-20:00 ET rather than 09:30-16:00. The
 * 20:00-04:00 gap remains genuinely unpriced: no prints exist, so the
 * staleness guard refuses, which is correct rather than a shortfall.
 */
const QUOTE_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
  `?range=1d&interval=1m&includePrePost=true`;

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
    const barCount = ts?.length ?? 0;
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
      /*
       * HOW MANY BARS THE FEED ACTUALLY RETURNED, and it settles a question
       * the code cannot answer about itself.
       *
       * `includePrePost=true` was added and the sweep still reported ages
       * consistent with the 20:00Z regular close, while the identical URL
       * from a residential connection returned 891 bars ending 23:59Z. A
       * parameter that is accepted and silently ignored looks exactly like a
       * parameter that works. Nasdaq already rejects this platform's
       * datacenter egress elsewhere in this codebase, so a provider
       * differentiating by caller is a demonstrated failure mode here, not a
       * hypothesis about one.
       *
       * ~391 bars means regular hours only and the fix is inert in
       * production; ~891 means the feed is full and the difference lies
       * elsewhere. Reported per quote so the answer arrives with the data
       * rather than needing a second investigation.
       */
      bars: barCount,
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
      // A sweep with nothing armed still ran, and must say so. Otherwise an
      // empty watchlist is indistinguishable from a dead scheduler.
      await recordSweep({ at: now.toISOString(), armed: 0, judged: 0, fired: 0, skippedStale: 0 });
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

    /*
     * The sweep records what it did before answering. "Never fired" is
     * consistent with never running and with running blind on stale quotes;
     * without this note those three are the same silence from outside.
     */
    const skippedStale = results.filter(
      (r) => r.kind === "skipped" && !r.reason.startsWith("already fired")
    ).length;
    await recordSweep({
      at: now.toISOString(),
      armed: armed.length,
      judged: armed.length - skippedStale,
      fired: fired.length,
      skippedStale,
    });

    return NextResponse.json({
      sweptAt: now.toISOString(),
      armed: armed.length,
      quoted: quotes.size,
      /*
       * The feed, described. `bars` near 391 means this caller is being
       * served regular hours only regardless of includePrePost — see
       * fetchQuote. Kept on the response rather than in logs so it can be
       * read from outside without platform access.
       */
      feed: [...quotes.values()].map((q) => ({
        symbol: q.symbol,
        bars: q.bars ?? null,
        lastBarAt: q.asOf,
        ageMinutes: Math.round(q.ageSeconds / 60),
      })),
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
