/**
 * WHICH ALERT CHANNELS CAN ACTUALLY DELIVER — booleans, never values.
 *
 * A delivery channel has two failure modes that look identical from outside:
 * the secret was never set, and the secret was set but the running deployment
 * predates it. Vercel snapshots environment variables when a build starts, so
 * saving a variable changes nothing until a redeploy — and the symptom of
 * skipping that step is an alert path that silently does nothing while
 * everyone believes it is armed.
 *
 * Reporting this from inside the running process is the only way to answer
 * the question honestly: it reflects what THIS deployment can see, not what
 * the dashboard lists. That distinction is the entire point.
 *
 * Booleans only. The values are secrets and never leave the process — the
 * question here is "can this deployment deliver", not "with what".
 */

export type AlertChannelName = "discord" | "telegram" | "email";

const set = (v: string | undefined): boolean => typeof v === "string" && v.trim() !== "";

/**
 * The env names are duplicated from the channel modules deliberately and
 * asserted against them by test, rather than exported from each channel:
 * a channel reads its secret at call time inside a closure, and prising that
 * out would mean changing three working modules to answer a diagnostic
 * question. The test is what keeps the two in step.
 */
export function configuredChannels(): Record<AlertChannelName, boolean> {
  return {
    discord: set(process.env.DISCORD_WEBHOOK_URL),
    telegram: set(process.env.TELEGRAM_BOT_TOKEN) && set(process.env.TELEGRAM_CHAT_ID),
    email: set(process.env.RESEND_API_KEY) && set(process.env.ALERTS_EMAIL_FROM),
  };
}

/** True when at least one channel can deliver. A watchdog with none is mute. */
export function anyChannelConfigured(): boolean {
  return Object.values(configuredChannels()).some(Boolean);
}
