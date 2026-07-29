/** Telegram relay. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env.local.
 *  Create a bot with @BotFather, then message it once and read your chat id
 *  from https://api.telegram.org/bot<TOKEN>/getUpdates */
export async function sendTelegram(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `⚡ ${message}` }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
