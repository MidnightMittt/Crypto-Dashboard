/**
 * Network deadlines.
 *
 * WHY THIS EXISTS: `fetch` has no default timeout. Every upstream here is a
 * third-party API we don't control, and several of them (Binance, Bybit,
 * OKX, Drift) geo-block by IP — a blocked request often *hangs* rather than
 * refusing outright.
 *
 * The aggregator runs `Promise.all` across every adapter, and a Promise.all
 * resolves no faster than its slowest member. So one hanging venue used to
 * stall the entire dashboard: the page sat on a skeleton until that single
 * socket gave up, which could be 30s or more.
 *
 * Capping each request bounds worst-case page latency to roughly the
 * timeout, regardless of how badly any one exchange is behaving. A venue
 * that misses its deadline is simply excluded from this cycle — the same
 * treatment as any other failure, and it reappears on the next poll.
 */

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Per-HTTP-request cap.
 *
 * A healthy exchange endpoint answers in well under a second, so it's
 * tempting to set this very tight. Don't. Exchanges throttle rather than
 * fail when you poll them hard, and a throttled-but-working venue answers in
 * several seconds. A 4s cap was measured dropping venues that would have
 * returned perfectly good data at 6-7s.
 *
 * The purpose of this limit is to bound a *hang* — a geo-blocked socket that
 * never answers at all — not to enforce a latency budget on healthy
 * upstreams. Err generous; `withDeadline` in the aggregator is what keeps
 * the page responsive.
 */
export const FETCH_TIMEOUT_MS = envMs("FETCH_TIMEOUT_MS", 9_000);

/**
 * Per-adapter cap. Higher than the per-request cap because one adapter may
 * legitimately make several calls (Binance makes six). This is the backstop
 * for an adapter that chains requests rather than parallelising them.
 */
export const ADAPTER_TIMEOUT_MS = envMs("ADAPTER_TIMEOUT_MS", 12_000);

/**
 * Aggregator providers get a much longer cap than exchange adapters.
 *
 * They fetch in bulk — CoinGecko's `/derivatives?include_tickers=unexpired`
 * returns every derivative on every venue in one payload — so they are
 * legitimately slow in a way a single-symbol exchange endpoint is not. The
 * 4s adapter cap killed CoinGecko outright and cost ten venues.
 *
 * This being long doesn't make the page slow: `withDeadline` in the
 * aggregator stops us *waiting* on a provider well before this, while the
 * request itself keeps running and populates the provider's own cache. The
 * venues it covers land on the following poll instead of this one.
 */
export const PROVIDER_FETCH_TIMEOUT_MS = envMs("PROVIDER_FETCH_TIMEOUT_MS", 12_000);

/** AbortSignal that fires after `ms`. */
export function timeoutSignal(ms: number = FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Races a promise against a deadline, resolving to `fallback` if it loses.
 *
 * Note this does NOT cancel the underlying work — it stops us *waiting* on
 * it. Cancellation is the job of the AbortSignal inside the fetch itself.
 * This is the outer guard for anything that isn't a single fetch.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[timeout] ${label} exceeded ${ms}ms — excluded from this cycle`);
      resolve(fallback);
    }, ms);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when an error is an abort/timeout rather than a real upstream failure. */
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}
