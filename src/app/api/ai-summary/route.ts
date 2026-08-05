import { NextRequest, NextResponse } from "next/server";
import { AggregateMarketData } from "@/types/market";
import { bandFor, COMPOSITE_BANDS, FUNDING_BANDS, LEVERAGE_HEAT_BANDS } from "@/lib/sentiment/bands";
import { formatCompactUsd } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai-summary  →  { summary: string, source: "ai" | "rules" }
 *
 * With ANTHROPIC_API_KEY set, this asks Claude to narrate the current
 * leverage environment. Without a key, it falls back to a deterministic
 * rules-based summary so the panel is never empty and the app needs
 * zero configuration to run.
 */
export async function POST(req: NextRequest) {
  const { aggregate } = (await req.json()) as { aggregate: AggregateMarketData };

  if (!aggregate) {
    return NextResponse.json({ error: "aggregate is required" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ summary: ruleBasedSummary(aggregate), source: "rules" });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system:
          "You are a derivatives market analyst. Given perpetual futures metrics, explain the current leverage environment in plain English in 3-4 sentences. Describe what the positioning data shows and what conditions it creates. Be concrete and neutral. Do not give trading advice, price predictions, or tell the reader what to do.",
        messages: [
          {
            role: "user",
            content: buildPrompt(aggregate),
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const summary = (data.content ?? [])
      .map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");

    return NextResponse.json({ summary: summary || ruleBasedSummary(aggregate), source: "ai" });
  } catch (err) {
    console.warn("[ai-summary] falling back to rules-based summary:", err);
    return NextResponse.json({ summary: ruleBasedSummary(aggregate), source: "rules" });
  }
}

function buildPrompt(a: AggregateMarketData): string {
  const topVenues = [...a.exchanges]
    .sort((x, y) => y.openInterestUsd - x.openInterestUsd)
    .slice(0, 5)
    .map((e) => `${e.exchangeId}: funding ${e.fundingRatePct.toFixed(4)}%, OI ${formatCompactUsd(e.openInterestUsd)}`)
    .join("; ");

  return [
    `Asset: ${a.asset}`,
    `Weighted funding rate: ${a.weightedFundingRatePct.toFixed(4)}% (annualized ${a.fundingAnnualizedPct.toFixed(1)}%)`,
    `Funding change 24h: ${a.fundingChange24hPct !== null ? a.fundingChange24hPct.toFixed(4) + "%" : "unavailable"}`,
    `Total open interest: ${formatCompactUsd(a.totalOpenInterestUsd)} (24h ${a.oiChange24hPct !== null ? a.oiChange24hPct.toFixed(1) + "%" : "unavailable"}, percentile ${a.oiPercentile ?? "unavailable"})`,
    `Long/short ratio: ${a.longShortRatio !== null ? a.longShortRatio.toFixed(2) : "unavailable"}`,
    `Leverage heat score: ${a.leverageHeatScore !== null ? a.leverageHeatScore + "/100" : "unavailable"}`,
    `Market bias score: ${a.marketBias ? `${a.marketBias.score}/100 (${a.marketBias.verdict})` : "unavailable"}`,
    `Largest venues — ${topVenues}`,
  ].join("\n");
}

/** Deterministic fallback — no API key needed. */
function ruleBasedSummary(a: AggregateMarketData): string {
  const fundingBand = bandFor(a.weightedFundingRatePct, FUNDING_BANDS);
  const heatBand = a.leverageHeatScore !== null ? bandFor(a.leverageHeatScore, LEVERAGE_HEAT_BANDS) : null;
  const biasBand = a.marketBias ? bandFor(a.marketBias.score, COMPOSITE_BANDS) : null;
  const priceChange = a.priceChange24hPct;

  const parts: string[] = [];

  parts.push(
    `Weighted funding across ${a.exchanges.length} live ${a.exchanges.length === 1 ? "venue" : "venues"} sits at ${a.weightedFundingRatePct.toFixed(4)}% (${a.fundingAnnualizedPct.toFixed(0)}% annualized), which reads as ${fundingBand.label.toLowerCase()}.`
  );

  if (a.oiChange24hPct !== null) {
    parts.push(
      `Open interest totals ${formatCompactUsd(a.totalOpenInterestUsd)}, ${a.oiChange24hPct >= 0 ? "up" : "down"} ${Math.abs(a.oiChange24hPct).toFixed(1)}% over 24 hours${a.oiPercentile !== null ? ` and in the ${a.oiPercentile}th percentile of its recent range` : ""}.`
    );
  } else {
    parts.push(
      `Open interest totals ${formatCompactUsd(a.totalOpenInterestUsd)}. None of the reporting venues published enough history to measure the 24-hour trend.`
    );
  }

  if (a.oiChange24hPct !== null && Math.abs(priceChange) < 1.5 && a.oiChange24hPct > 8) {
    parts.push(
      `Price has barely moved (${priceChange.toFixed(2)}%) while positions keep building — leverage is accumulating without direction, which is the classic setup for a sharp move once it resolves.`
    );
  } else if (a.leverageHeatScore !== null && heatBand) {
    parts.push(
      a.leverageHeatScore > 70
        ? `Leverage heat is ${a.leverageHeatScore}/100 (${heatBand.label.toLowerCase()}), meaning positioning has run ahead of price and the market is vulnerable to a liquidation cascade.`
        : `Leverage heat is ${a.leverageHeatScore}/100 (${heatBand.label.toLowerCase()}), so positioning is broadly in line with price action.`
    );
  }

  parts.push(
    a.marketBias && biasBand
      ? `The weighted market read reads ${a.marketBias.score}/100 — ${biasBand.label}. ${biasBand.description}`
      : "Not enough metrics have reported yet to form a weighted market read."
  );

  return parts.join(" ");
}
