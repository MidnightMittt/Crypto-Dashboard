/**
 * Diagnostic logging for data providers.
 *
 * Purpose: when a provider returns nothing, the failure could be at any of
 * three layers — the API call, the JSON parse, or the filtering logic that
 * decides which rows are usable. These helpers make each layer report for
 * itself so the failure can be located without guesswork.
 *
 * Enabled by default so no configuration is needed to diagnose. Set
 * DEBUG_PROVIDERS=false to silence once things are working.
 *
 * This module only observes. It never alters values, control flow, or
 * return shapes.
 */

import { PROVIDER_FETCH_TIMEOUT_MS, timeoutSignal } from "../net/timeout";

/**
 * On by default in development, off by default in production.
 *
 * These helpers log a 500-character preview of every upstream response body.
 * That's invaluable when diagnosing why a provider returned nothing, and
 * pure overhead on a deployed instance polling every 15 seconds — it burns
 * CPU serialising strings nobody reads, and floods the platform's log
 * quota. Set DEBUG_PROVIDERS=true to force it on anywhere.
 */
export function debugEnabled(): boolean {
  const explicit = process.env.DEBUG_PROVIDERS;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV !== "production";
}

/** Strips API keys from URLs before they reach the log. */
export function redact(url: string): string {
  return url
    .replace(/api_key=[^&]*/gi, "api_key=***")
    .replace(/apikey=[^&]*/gi, "apikey=***")
    .replace(/([?&]key=)[^&]*/gi, "$1***")
    // Alchemy-style keys embedded in the path segment
    .replace(/\/v1\/[A-Za-z0-9_-]{20,}\//g, "/v1/***/");
}

export function log(provider: string, message: string, ...rest: unknown[]): void {
  if (!debugEnabled()) return;
  console.log(`[${provider}] ${message}`, ...rest);
}

/** Logs a fetch: URL, status, body size, and a body preview. Returns the raw text. */
export async function loggedFetch(
  provider: string,
  url: string,
  init?: RequestInit
): Promise<{ res: Response; text: string }> {
  const started = Date.now();
  log(provider, `REQUEST  ${init?.method ?? "GET"} ${redact(url)}`);

  // Only providers use loggedFetch, and they fetch in bulk — so they get the
  // longer provider deadline rather than the tight per-adapter one.
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = Date.now() - started;

  log(
    provider,
    `RESPONSE status=${res.status} ${res.statusText || ""} bytes=${text.length} time=${ms}ms`
  );
  log(provider, `BODY[0:500] ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);

  if (!res.ok) {
    log(provider, `HTTP NOT OK — status ${res.status}. Body preview above.`);
  }

  return { res, text };
}

/** Parses JSON with logging of the resulting shape. Returns null on failure. */
export function loggedParse<T>(provider: string, text: string): T | null {
  try {
    const json = JSON.parse(text);
    const type = Array.isArray(json) ? "array" : typeof json;
    log(provider, `PARSE ok — top-level type=${type}`);

    if (Array.isArray(json)) {
      log(provider, `PARSE array length=${json.length}`);
      if (json.length > 0) {
        log(provider, `PARSE first element keys: ${Object.keys(json[0] ?? {}).join(", ")}`);
        log(provider, `PARSE first element: ${JSON.stringify(json[0]).slice(0, 500)}`);
      }
    } else if (json && typeof json === "object") {
      const keys = Object.keys(json);
      log(provider, `PARSE object keys: ${keys.join(", ")}`);
      for (const k of keys) {
        const v = (json as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          log(provider, `PARSE key "${k}" is an array of length ${v.length}`);
          if (v.length > 0) {
            log(provider, `PARSE "${k}"[0] keys: ${Object.keys(v[0] ?? {}).join(", ")}`);
            log(provider, `PARSE "${k}"[0]: ${JSON.stringify(v[0]).slice(0, 500)}`);
          }
        }
      }
    }
    return json as T;
  } catch (err) {
    log(provider, `PARSE FAILED — not valid JSON. ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Counts why rows were dropped, so filter logic can be audited in one line. */
export class DropCounter {
  private counts = new Map<string, number>();
  private samples = new Map<string, string>();

  constructor(private provider: string) {}

  drop(reason: string, sample?: unknown): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    if (sample !== undefined && !this.samples.has(reason)) {
      this.samples.set(reason, JSON.stringify(sample).slice(0, 200));
    }
  }

  report(kept: number, total: number): void {
    if (!debugEnabled()) return;
    log(this.provider, `FILTER kept=${kept} of ${total}`);
    if (this.counts.size === 0) {
      log(this.provider, "FILTER no rows dropped");
      return;
    }
    for (const [reason, count] of this.counts) {
      const sample = this.samples.get(reason);
      log(this.provider, `FILTER dropped ${count} — ${reason}${sample ? ` | e.g. ${sample}` : ""}`);
    }
  }
}
