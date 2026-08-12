import { RankedOpportunity } from "@/lib/signals/opportunityRanking";

/** Where a row's own decision surface lives. One rule, so no two surfaces link differently. */
export function hrefFor(row: Pick<RankedOpportunity, "asset" | "assetClass">): string {
  return row.assetClass === "equity" ? `/markets/${row.asset.toLowerCase()}` : `/asset/${row.asset.toLowerCase()}`;
}

export function verdictTone(verdict: string): string {
  return verdict === "bullish" ? "text-success" : verdict === "bearish" ? "text-danger" : "text-ink-muted";
}

export const RISK_TONE: Record<string, string> = {
  high: "text-danger",
  medium: "text-amber",
  low: "text-success",
};
