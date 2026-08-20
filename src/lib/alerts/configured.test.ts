import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anyChannelConfigured, configuredChannels } from "./configured";

const VARS = [
  "DISCORD_WEBHOOK_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "RESEND_API_KEY",
  "ALERTS_EMAIL_FROM",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("configuredChannels", () => {
  it("reports every channel unconfigured when nothing is set", () => {
    expect(configuredChannels()).toEqual({ discord: false, telegram: false, email: false });
    expect(anyChannelConfigured()).toBe(false);
  });

  it("reports discord once its webhook is present", () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/x";
    expect(configuredChannels().discord).toBe(true);
    expect(anyChannelConfigured()).toBe(true);
  });

  /*
   * An empty or whitespace variable is how a half-finished dashboard edit
   * looks, and it delivers exactly as well as no variable at all. Treating it
   * as configured would report a channel as armed while every send fails.
   */
  it("treats an empty or whitespace value as unconfigured", () => {
    process.env.DISCORD_WEBHOOK_URL = "";
    expect(configuredChannels().discord).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = "   ";
    expect(configuredChannels().discord).toBe(false);
  });

  /* Both halves or neither: a bot token with no chat id cannot deliver. */
  it("requires both variables for the two-part channels", () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    expect(configuredChannels().telegram).toBe(false);
    process.env.TELEGRAM_CHAT_ID = "c";
    expect(configuredChannels().telegram).toBe(true);

    process.env.RESEND_API_KEY = "k";
    expect(configuredChannels().email).toBe(false);
    process.env.ALERTS_EMAIL_FROM = "a@b.c";
    expect(configuredChannels().email).toBe(true);
  });
});

/*
 * THE DRIFT GUARD. This module names the env vars a second time, which is a
 * duplication that would rot silently: a channel renamed its variable and
 * /api/health would keep cheerfully reporting the old one as the truth.
 * Reading the channel sources keeps the two definitions honest.
 */
describe("env names stay in step with the channel modules", () => {
  const read = (f: string) =>
    fs.readFileSync(path.join(__dirname, "channels", f), "utf8");

  it("uses the same variables the channels actually read", () => {
    const source = read("discord.ts") + read("telegram.ts") + read("email.ts");
    for (const v of VARS) {
      expect(source, `${v} is declared here but no channel reads it`).toContain(v);
    }
  });
});
