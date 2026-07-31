import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

/**
 * Options Intelligence Engine — Phase 0 placeholder.
 *
 * This route, and everything under src/lib/options/, is entirely additive:
 * no file the crypto dashboard depends on is imported here, and nothing in
 * this directory is imported by the crypto dashboard. See
 * lib/options/types.ts for the provider interfaces this module is being
 * built around, and the phased plan for what fills this page in next.
 */
export default function OptionsPage() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-hairline bg-void/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-ink">Options Intelligence</h1>
            <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">
              Scanner · strategy · risk
            </p>
          </div>
          <Link
            href="/"
            className="text-[11px] uppercase tracking-widest text-ink-faint transition-colors hover:text-ink"
          >
            ← Crypto Dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6">
        <Card>
          <CardHeader className="flex-wrap gap-2">
            <CardTitle>Phase 0 — Scaffolding</CardTitle>
            <Badge variant="amber">Not live yet</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-0">
            <p className="text-xs leading-relaxed text-ink-muted">
              This module is being built incrementally, one validated phase at a time. Nothing
              here reads real account or market data yet — that starts once the two riskiest
              external dependencies (an unofficial Robinhood client, and Tradier) are confirmed
              working via <code className="font-mono text-ink">scripts/check-robinhood.mjs</code>{" "}
              and <code className="font-mono text-ink">scripts/check-tradier.mjs</code>.
            </p>
            <p className="text-xs leading-relaxed text-ink-muted">
              Run either script from the project root once the relevant environment variables
              are set in <code className="font-mono text-ink">.env.local</code>.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
