import { NextRequest, NextResponse } from "next/server";
import { WatchLevel, isArmed, rejectionReason } from "@/lib/watch/levels";
import { MAX_LEVELS, WatchStoreUnavailable, loadLevels, newId, saveLevels } from "@/lib/watch/store";

/**
 * THE LEVEL REGISTRY — protections that outlive the session that set them.
 *
 *   POST   /api/watch     { symbol, level, direction, note? }  -> arm
 *   GET    /api/watch                                          -> list
 *   DELETE /api/watch?id=w_...                                 -> disarm
 *
 * Exits at the broker are safe because the broker keeps running. Time-stops
 * and disaster-stops cannot be expressed as broker orders, so they live in an
 * agent's process and die with it — six hours of open positions unwatched on
 * 2026-08-20. This site runs independently of that loop, which is what makes
 * it the right custodian.
 *
 * It watches and tells you. It does not place orders, and the alert text says
 * so every time: a watcher that is wrong costs a message, an actor that is
 * wrong costs a position.
 */

export const dynamic = "force-dynamic";

function storeError(err: unknown): NextResponse | null {
  if (err instanceof WatchStoreUnavailable) {
    // 503, not 500: the request was fine, the dependency is missing, and the
    // caller should retry once it is configured rather than change anything.
    return NextResponse.json({ error: err.message, armed: false }, { status: 503 });
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const levels = await loadLevels();
    const armed = levels.filter(isArmed);
    const fired = levels.filter((l) => !isArmed(l));
    return NextResponse.json({
      armed,
      fired,
      counts: { armed: armed.length, fired: fired.length },
      /*
       * Fired but undelivered is the state worth surfacing at the top level:
       * the trigger happened and was recorded, and nobody was told. A caller
       * polling this endpoint can recover an alert a dead webhook swallowed.
       */
      undelivered: fired.filter((l) => !l.delivered).map((l) => l.id),
    });
  } catch (err) {
    return storeError(err) ?? NextResponse.json({ error: "Could not read levels." }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const reason = rejectionReason(body);
    if (reason) {
      // Explicit `armed: false` so a caller cannot read a 4xx as success.
      return NextResponse.json({ error: reason, armed: false }, { status: 400 });
    }

    const levels = await loadLevels();
    if (levels.filter(isArmed).length >= MAX_LEVELS) {
      return NextResponse.json(
        { error: `At the ${MAX_LEVELS}-level cap. Disarm something before arming more.`, armed: false },
        { status: 429 }
      );
    }

    const now = new Date();
    const level: WatchLevel = {
      id: newId(now),
      symbol: String(body.symbol).trim().toUpperCase(),
      level: Number(body.level),
      direction: body.direction as "below" | "above",
      note: typeof body.note === "string" ? body.note.slice(0, 400) : "",
      armedAt: now.toISOString(),
      firedAt: null,
      firedPrice: null,
      delivered: false,
    };

    await saveLevels([...levels, level]);
    return NextResponse.json({ armed: true, level }, { status: 201 });
  } catch (err) {
    return storeError(err) ?? NextResponse.json({ error: "Could not arm the level." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const levels = await loadLevels();
    const remaining = levels.filter((l) => l.id !== id);
    if (remaining.length === levels.length) {
      return NextResponse.json({ error: `No level with id ${id}.`, disarmed: false }, { status: 404 });
    }
    await saveLevels(remaining);
    return NextResponse.json({ disarmed: true, id });
  } catch (err) {
    return storeError(err) ?? NextResponse.json({ error: "Could not disarm." }, { status: 500 });
  }
}
