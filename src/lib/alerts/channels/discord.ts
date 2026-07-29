/** Discord webhook relay. Set DISCORD_WEBHOOK_URL in .env.local.
 *  Create one: Server Settings → Integrations → Webhooks → New Webhook. */
export async function sendDiscord(message: string): Promise<boolean> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Leverage Terminal",
        embeds: [{ title: "Market alert", description: message, color: 0x2dd4e8 }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
