import type { Metadata } from "next";
import { SwingDesk } from "@/components/swing/SwingDesk";

/**
 * /swing — the swing-trading desk.
 *
 * One page, four views, one payload. Deliberately NOT a grid of cards per
 * endpoint: the charter's first rule is that nothing appears because it
 * exists, and a swing trader's day is a sequence — what is interesting, what
 * is confirmed, what am I holding, what happened — not a dashboard of
 * independent readings.
 *
 * PAPER ONLY. No brokerage integration is reachable from this page or from
 * anything under lib/swing/.
 */
export const metadata: Metadata = {
  title: "Swing Desk",
  description: "Scan, evaluate, approve and manage paper swing trades.",
};

export default function SwingPage() {
  return (
    <main className="min-h-screen">
      <header className="border-b border-hairline px-3 py-3 sm:px-5">
        <h1 className="text-base font-bold tracking-tight">Swing Desk</h1>
        <p className="mt-0.5 text-[11px] text-white/45">
          Structure-first setups across the crypto universe. Paper execution only.
        </p>
      </header>
      <SwingDesk />
    </main>
  );
}
