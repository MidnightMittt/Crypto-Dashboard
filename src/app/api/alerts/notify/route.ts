import { NextRequest, NextResponse } from "next/server";
import { sendDiscord } from "@/lib/alerts/channels/discord";
import { sendTelegram } from "@/lib/alerts/channels/telegram";
import { sendEmail } from "@/lib/alerts/channels/email";
import { AlertChannel } from "@/types/market";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/notify
 * body: { message: string, channels: AlertChannel[], email?: string }
 *
 * Browser + sound alerts fire client-side; this route handles the three
 * channels that need a server (and a secret) to deliver.
 */
export async function POST(req: NextRequest) {
  try {
    const { message, channels, email } = (await req.json()) as {
      message: string;
      channels: AlertChannel[];
      email?: string;
    };

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const results: Record<string, boolean> = {};

    if (channels?.includes("discord")) results.discord = await sendDiscord(message);
    if (channels?.includes("telegram")) results.telegram = await sendTelegram(message);
    if (channels?.includes("email") && email) results.email = await sendEmail(message, email);

    const unconfigured = Object.entries(results)
      .filter(([, ok]) => !ok)
      .map(([channel]) => channel);

    return NextResponse.json({
      delivered: results,
      // Surfaced in the UI so an un-set env var reads as "not configured"
      // rather than silently doing nothing.
      unconfigured,
    });
  } catch (err) {
    console.error("[alerts/notify] failed:", err);
    return NextResponse.json({ error: "Could not deliver alert." }, { status: 500 });
  }
}
