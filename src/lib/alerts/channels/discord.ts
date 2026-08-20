/**
 * Discord webhook relay. Set DISCORD_WEBHOOK_URL in .env.local (locally) or
 * in the Vercel dashboard, then REDEPLOY — env vars are snapshotted when a
 * build starts, so saving one changes nothing for the running deployment.
 *
 * Create one: Server Settings → Integrations → Webhooks → New Webhook.
 *
 * ── Why this asks Discord where the message landed ────────────────────
 *
 * A bare 2xx proves Discord accepted the post. It does NOT tell you which
 * channel received it, and "accepted" plus "I never saw it" is the exact
 * pair we hit on 2026-08-20: delivery reported success and the message was
 * nowhere the reader was looking. A webhook posts to the channel it was
 * created in, which is easy to get wrong and impossible to verify from a
 * status code.
 *
 * `?wait=true` makes Discord return the created message object instead of an
 * empty 204, so a successful send can report the message and channel ids it
 * actually created. That turns "it says delivered but I don't see it" from a
 * standoff into a lookup: compare the channel id against the one on screen.
 */

export interface DiscordDelivery {
  ok: boolean;
  /** HTTP status from Discord. Null when the request never completed. */
  status: number | null;
  /** Present on success: the message Discord created, and where. */
  messageId?: string;
  channelId?: string;
  /** Present on failure, with Discord's own words where it gave any. */
  error?: string;
}

export async function sendDiscordDetailed(message: string): Promise<DiscordDelivery> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    return { ok: false, status: null, error: "DISCORD_WEBHOOK_URL is not set in this deployment." };
  }

  try {
    // `wait=true` — return the created message rather than an empty 204.
    const target = url.includes("?") ? `${url}&wait=true` : `${url}?wait=true`;
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Leverage Terminal",
        embeds: [{ title: "Market alert", description: message, color: 0x2dd4e8 }],
      }),
    });

    if (!res.ok) {
      // Discord explains itself on 4xx (unknown webhook, bad token, rate
      // limit). Passing that through beats reporting a bare number.
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 404
            ? "Discord says this webhook does not exist — it was deleted or the URL is wrong."
            : res.status === 401 || res.status === 403
              ? "Discord rejected the webhook token."
              : res.status === 429
                ? "Rate limited by Discord."
                : `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | { id?: string; channel_id?: string }
      | null;
    return {
      ok: true,
      status: res.status,
      messageId: body?.id,
      channelId: body?.channel_id,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `Request failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

/** Boolean form, for callers that only decide whether to record a delivery. */
export async function sendDiscord(message: string): Promise<boolean> {
  return (await sendDiscordDetailed(message)).ok;
}
