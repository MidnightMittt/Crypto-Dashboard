import { NextRequest, NextResponse } from "next/server";

/**
 * PASSWORD GATE for the swing desk.
 *
 * ── WHY ONLY THESE ROUTES ───────────────────────────────────────────────
 *
 * The swing desk shows a personal paper book — positions, equity, risk
 * settings — and exposes a POST that mutates it. Everything else in this app
 * is market analysis that is not specific to anyone, so gating it would add
 * friction for no benefit. Scope the lock to what is actually private.
 *
 * ── FAIL CLOSED IN PRODUCTION, OPEN IN DEV ──────────────────────────────
 *
 * If SWING_PASSWORD is unset:
 *   · development → allowed, so `npm run dev` needs no ceremony
 *   · production  → DENIED, with an explicit message
 *
 * The alternative — defaulting to some baked-in password, or allowing when
 * unset — means a deploy that forgets the env var is silently public. A
 * deployment that refuses to serve is a visible problem; one that quietly
 * serves your book to the internet is not.
 *
 * HTTP Basic is used deliberately: it works in every mobile browser with no
 * session handling, no cookie, and no login page to build. The password is
 * compared in constant time so the endpoint cannot be probed character by
 * character.
 */

const PROTECTED = ["/swing", "/api/swing"];

/** Constant-time compare — a length-dependent early return leaks the password. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorised(message: string, status = 401): NextResponse {
  return new NextResponse(message, {
    status,
    headers: status === 401 ? { "WWW-Authenticate": 'Basic realm="Swing Desk", charset="UTF-8"' } : {},
  });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`))) {
    return NextResponse.next();
  }

  const expected = process.env.SWING_PASSWORD?.trim();

  if (!expected) {
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    return unauthorised(
      "Swing desk is locked: SWING_PASSWORD is not set on this deployment. " +
        "Set it in the project's environment variables and redeploy.",
      503
    );
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorised("Authentication required.");

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorised("Malformed credentials.");
  }
  // Username is ignored; only the password is checked. One secret, not two.
  const password = decoded.slice(decoded.indexOf(":") + 1);
  if (!safeEqual(password, expected)) return unauthorised("Incorrect password.");

  return NextResponse.next();
}

export const config = {
  matcher: ["/swing/:path*", "/api/swing/:path*", "/swing", "/api/swing"],
};
