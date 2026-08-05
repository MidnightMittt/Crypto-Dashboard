import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { swr, invalidate } from "./swr";

/**
 * `after` is mocked rather than exercised for real: a real call only works
 * inside a live Next.js request (it reads AsyncLocalStorage set up by the
 * framework), which vitest never establishes. What's under test here is
 * swr()'s own control flow — that it hands the background refresh to
 * `after()` when one is available, and falls back to fire-and-forget
 * without throwing when it isn't (e.g. `after` called outside a request,
 * which is exactly what a bare vitest run looks like). Whether Vercel
 * actually honors `waitUntil` and keeps the instance alive is a platform
 * guarantee, not something a unit test can observe — that part is checked
 * against the live deployment instead.
 */
const afterMock = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after: afterMock }));

const FRESH_MS = 1_000;
const MAX_AGE_MS = 10_000;

describe("swr", () => {
  beforeEach(() => {
    invalidate();
    afterMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a fresh value without touching the fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    await swr("k", fetcher, { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    const second = await swr("k", fetcher, { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });
    expect(second).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("on a stale hit, returns the old value immediately and registers the refresh via after()", async () => {
    const now = Date.now();
    const fetcher = vi.fn().mockResolvedValue("v1");
    vi.spyOn(Date, "now").mockReturnValue(now);
    await swr("k", fetcher, { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    // Age the entry into the stale window (between freshMs and maxAgeMs).
    vi.spyOn(Date, "now").mockReturnValue(now + FRESH_MS + 1);
    const refreshed = vi.fn().mockResolvedValue("v2");
    const stale = await swr("k", refreshed, { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    expect(stale).toBe("v1");
    expect(afterMock).toHaveBeenCalledTimes(1);
    // after() must receive the in-flight refresh, not a no-op — otherwise
    // Vercel has nothing to keep the instance alive for.
    const registered = afterMock.mock.calls[0][0];
    expect(registered).toBeInstanceOf(Promise);
    await registered;
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("recovers on the next poll once the after()-registered refresh completes", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await swr("k", vi.fn().mockResolvedValue("v1"), { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    vi.spyOn(Date, "now").mockReturnValue(now + FRESH_MS + 1);
    const stale = await swr("k", vi.fn().mockResolvedValue("v2"), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(stale).toBe("v1");

    // Simulate Vercel honoring waitUntil: the promise handed to after()
    // is allowed to finish instead of being killed mid-flight.
    await afterMock.mock.calls[0][0];

    const recovered = await swr("k", vi.fn().mockResolvedValue("v3"), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(recovered).toBe("v2");
  });

  it("falls back to fire-and-forget when after() has no request scope to attach to", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await swr("k", vi.fn().mockResolvedValue("v1"), { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    vi.spyOn(Date, "now").mockReturnValue(now + FRESH_MS + 1);
    const refreshed = vi.fn().mockResolvedValue("v2");
    const stale = await swr("k", refreshed, { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS });

    // Must not throw or block on the after() failure.
    expect(stale).toBe("v1");
    expect(afterMock).toHaveBeenCalledTimes(1);

    // The refresh itself still runs in the background, unmanaged.
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  });
});
