import { SupportResistanceZone, ZoneStatus } from "@/lib/technicals/marketStructure";
import { formatPrice } from "@/lib/utils/format";

/**
 * SUPPORT / RESISTANCE, drawn to scale.
 *
 * A list of levels tells you where they are. A ladder tells you how far away
 * they are from each other and from price — which is the thing that decides
 * whether a setup has room. "Resistance at 612" and "resistance at 640" read
 * the same in a list and are completely different trades.
 *
 * ── This component computes NOTHING but pixel positions ────────────────
 *
 * No zone is filtered, ranked, re-scored or re-classified here. Strength,
 * status, confluence and timeframe are all read straight off the zone as
 * `buildSupportResistanceZones` produced them. The trade markers are passed in
 * from `buildTradePlan`'s output. The moment a chart starts deciding which
 * levels matter, there are two opinions about structure in the codebase.
 *
 * Asset-agnostic on purpose: it takes zones and prices, and a zone is a zone.
 * The crypto Liquidity Map renders the same type as a list today and can adopt
 * this without a second implementation.
 */

export interface LadderMarker {
  label: string;
  price: number;
  tone: "entry" | "stop" | "target";
}

const STATUS_LABELS: Record<ZoneStatus, string> = {
  approaching: "approaching",
  testing: "testing now",
  rejecting: "rejected recently",
  reclaiming: "reclaiming",
  breaking: "breaking",
  inactive: "inactive",
};

const MARKER_TONE: Record<LadderMarker["tone"], string> = {
  entry: "text-cyan",
  stop: "text-danger",
  target: "text-success",
};
const MARKER_BORDER: Record<LadderMarker["tone"], string> = {
  entry: "border-cyan",
  stop: "border-danger",
  target: "border-success",
};

export function StructureLadder({
  zones,
  currentPrice,
  markers = [],
  atrPct,
}: {
  zones: SupportResistanceZone[];
  currentPrice: number;
  markers?: LadderMarker[];
  /** Daily ATR as a percent of price, used only to state distance in units a trader sizes with. */
  atrPct?: number | null;
}) {
  if (zones.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-faint">
        No structural levels cleared the clustering threshold on this history. That is a real
        finding, not a gap: price has not built repeated reaction zones here, so a plan would have
        nothing to anchor a stop against.
      </p>
    );
  }

  const prices = [
    ...zones.flatMap((z) => [z.priceLow, z.priceHigh]),
    ...markers.map((m) => m.price),
    currentPrice,
  ];
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const pad = (rawMax - rawMin) * 0.06 || Math.max(rawMax * 0.01, 0.01);
  const min = rawMin - pad;
  const max = rawMax + pad;
  const span = max - min;

  /** Price -> distance from the TOP of the ladder, as a percent. High prices sit high. */
  const top = (price: number) => ((max - price) / span) * 100;

  // Nearest level either side of price — the two numbers that actually bound
  // the next move. Read off the zones rather than recomputed from bars.
  const above = zones.filter((z) => z.priceLow > currentPrice).sort((a, b) => a.priceLow - b.priceLow)[0];
  const below = zones.filter((z) => z.priceHigh < currentPrice).sort((a, b) => b.priceHigh - a.priceHigh)[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        <div className="relative h-[280px] w-full min-w-0 rounded-md border border-hairline bg-void/40">
          {zones.map((z) => {
            const bandTop = top(z.priceHigh);
            const bandHeight = Math.max(top(z.priceLow) - bandTop, 0.8);
            const isSupport = z.kind === "support";
            return (
              <div
                key={`${z.kind}-${z.priceLow}-${z.priceHigh}`}
                className={`absolute inset-x-0 border-y ${
                  isSupport ? "border-success/30 bg-success/[0.07]" : "border-danger/30 bg-danger/[0.07]"
                }`}
                style={{ top: `${bandTop}%`, height: `${bandHeight}%` }}
              >
                <span
                  className={`absolute left-1.5 top-0 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] ${
                    isSupport ? "text-success" : "text-danger"
                  }`}
                >
                  {formatPrice(z.priceLow)}–{formatPrice(z.priceHigh)}
                  <span className="ml-1.5 text-ink-faint">
                    {z.strength}/100
                    {z.timeframe === "both" ? " · 1D+4H" : ""}
                  </span>
                </span>
              </div>
            );
          })}

          {markers.map((m) => (
            <div
              key={m.label}
              className={`absolute inset-x-0 border-t border-dashed ${MARKER_BORDER[m.tone]}/60`}
              style={{ top: `${top(m.price)}%` }}
            >
              <span
                className={`absolute right-1.5 top-0 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] ${MARKER_TONE[m.tone]}`}
              >
                {m.label} {formatPrice(m.price)}
              </span>
            </div>
          ))}

          {/* Price last, so it draws over every band. */}
          <div className="absolute inset-x-0 border-t border-ink" style={{ top: `${top(currentPrice)}%` }}>
            <span className="absolute left-1.5 top-0 -translate-y-1/2 rounded bg-ink px-1 py-px font-mono text-[10px] font-semibold text-void">
              {formatPrice(currentPrice)}
            </span>
          </div>
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-ink-muted">
        {above
          ? `Nearest resistance is ${formatPrice(above.priceLow)}, ${pctAway(currentPrice, above.priceLow)} above${
              atrPct ? ` — ${(pctDistance(currentPrice, above.priceLow) / atrPct).toFixed(1)} daily ranges` : ""
            }.`
          : "No mapped resistance above price — the last structural level has been cleared, so there is nothing overhead to reject from and nothing to target."}{" "}
        {below
          ? `Nearest support is ${formatPrice(below.priceHigh)}, ${pctAway(currentPrice, below.priceHigh)} below${
              atrPct ? ` — ${(pctDistance(currentPrice, below.priceHigh) / atrPct).toFixed(1)} daily ranges` : ""
            }.`
          : "No mapped support below price, which means a stop would have to be placed on volatility alone rather than against structure."}
      </p>

      <ul className="flex flex-col gap-1.5 border-t border-hairline pt-3">
        {[...zones]
          .sort((a, b) => b.priceHigh - a.priceHigh)
          .map((z) => (
            <li
              key={`row-${z.kind}-${z.priceLow}`}
              className="flex flex-wrap items-baseline gap-x-2 text-[11px] leading-relaxed"
            >
              <span className={`w-20 shrink-0 uppercase tracking-[0.12em] ${z.kind === "support" ? "text-success" : "text-danger"}`}>
                {z.kind}
              </span>
              <span className="font-mono text-ink">
                {formatPrice(z.priceLow)}–{formatPrice(z.priceHigh)}
              </span>
              <span className="text-ink-faint">
                strength {z.strength}/100 ·{" "}
                {z.reactionCount > 0
                  ? `${z.reactionCount} reaction${z.reactionCount === 1 ? "" : "s"}`
                  : "from the volume profile"}{" "}
                · {STATUS_LABELS[z.status]}
                {z.confluence.length > 0 ? ` · ${z.confluence.join(", ")}` : ""}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

const pctDistance = (from: number, to: number) => Math.abs((to - from) / from) * 100;
const pctAway = (from: number, to: number) => `${pctDistance(from, to).toFixed(1)}%`;
