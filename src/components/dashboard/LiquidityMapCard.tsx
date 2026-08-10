"use client";

import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { LiquidityMapRead, LiquidityWallRead, LiquidityWallWithPersistence } from "@/types/market";
import { MetricVerdict } from "@/lib/signals/types";
import { SupportResistanceZone, ZoneStatus } from "@/lib/technicals/marketStructure";
import { WallZoneRelationship } from "@/lib/technicals/liquidityWalls";
import { PersistenceLabel } from "@/lib/store/bookSnapshotStore";
import { formatCompactUsd, formatPrice } from "@/lib/utils/format";

const STATUS_LABELS: Record<ZoneStatus, string> = {
  approaching: "approaching",
  testing: "testing now",
  rejecting: "rejected recently",
  reclaiming: "reclaiming",
  breaking: "breaking",
  inactive: "inactive",
};

const CONFLUENCE_LABELS: Record<string, string> = {
  "swing-cluster": "swing cluster",
  "volume-poc": "volume point of control",
  "value-area-edge": "value area edge",
};

/**
 * Structural read (where is price likely to move next) rather than a
 * directional one, so it deliberately carries no score or verdict badge —
 * see marketStructure.ts. Dashboard V2: no longer its own top-level card;
 * embedded as expandable raw detail behind Positioning Intelligence's
 * CategoryCard (see page.tsx), so no outer Card wrapper here.
 *
 * The zone list already surfaces the volume profile's point of control and
 * value-area edges (as their own zones, or as confluence tags on swing
 * clusters that overlap them) — no separate "Point of control" block, which
 * would just restate the same information a second way.
 */
export function LiquidityMapCard({
  liquidityMap,
  liquidationsMetric,
}: {
  liquidityMap: LiquidityMapRead | null;
  liquidationsMetric: MetricVerdict | null;
}) {
  const zones = liquidityMap?.supportResistance ?? [];
  const supports = zones
    .filter((z) => z.kind === "support")
    .sort((a, b) => b.priceHigh - a.priceHigh)
    .slice(0, 3);
  const resistances = zones
    .filter((z) => z.kind === "resistance")
    .sort((a, b) => a.priceLow - b.priceLow)
    .slice(0, 3);
  const walls = liquidityMap?.walls ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
          Liquidity Map
        </span>
        <InfoTooltip
          measures="Where price structure suggests the market is likely to move next — clustered swing highs/lows and the volume profile's point of control, not arbitrary lines."
          whyItMatters="Estimates where price is most likely to move next based on structure, not which direction is favored."
        />
      </div>

      {!liquidityMap ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Not enough daily candle history yet to map structure for this asset.
        </p>
      ) : (
        <>
          <ZoneColumn title="Resistance above" zones={resistances} tone="text-danger" walls={walls} />
          <ZoneColumn title="Support below" zones={supports} tone="text-success" walls={walls} />
        </>
      )}

      <NotableLiquidity walls={walls} />

      {liquidationsMetric && (
        <div className="border-t border-hairline pt-2.5">
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            Recent flushes
          </span>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {liquidationsMetric.explanation}
          </p>
        </div>
      )}

      <p className="border-t border-hairline pt-2.5 text-[10px] leading-relaxed text-ink-faint/75">
        Structure is estimated from trailing daily OHLCV and top-of-book depth, not a
        tick-level order book reconstruction. Support/resistance levels are historical
        reaction zones, not guarantees.
      </p>
    </div>
  );
}

function ZoneColumn({
  title,
  zones,
  tone,
  walls,
}: {
  title: string;
  zones: SupportResistanceZone[];
  tone: string;
  walls: LiquidityWallRead | null;
}) {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{title}</span>
      {zones.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">None identified nearby.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5">
          {zones.map((z, i) => {
            const relationship = findZoneRelationship(z, walls);
            return (
              <li key={i} className="text-[11px] leading-relaxed">
                <span className={`font-mono ${tone}`}>{formatZoneRange(z)}</span>{" "}
                <span className="text-ink-faint">
                  {z.reactionCount > 0 ? `${z.reactionCount} touch${z.reactionCount === 1 ? "" : "es"}` : "volume-based"}
                  {z.confluence.length > 0 && ` · ${z.confluence.map((c) => CONFLUENCE_LABELS[c] ?? c).join(", ")}`}
                  {z.status !== "inactive" && ` · ${STATUS_LABELS[z.status]}`}
                </span>
                {relationship && (
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-faint/80">
                    {describeZoneRelationship(relationship, z.kind)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Matched by price range + kind rather than object identity — `walls`
 * arrives over a JSON API response, so the zone instances inside
 * `zoneRelationships` are structurally equal to but never the same
 * reference as the ones in `supportResistance` above.
 */
function findZoneRelationship(zone: SupportResistanceZone, walls: LiquidityWallRead | null): WallZoneRelationship | null {
  if (!walls) return null;
  return (
    walls.zoneRelationships.find(
      (r) => r.zone.priceLow === zone.priceLow && r.zone.priceHigh === zone.priceHigh && r.zone.kind === zone.kind
    ) ?? null
  );
}

/**
 * The one sentence this feature exists to produce: does real resting
 * liquidity back this structural level right now? Only rendered for zones
 * the visible order book actually reaches — see classifyWallVsZones' own
 * doc comment for why most zones never get a relationship at all.
 */
function describeZoneRelationship(relationship: WallZoneRelationship, kind: "support" | "resistance"): string {
  const side = kind === "support" ? "bid" : "ask";
  if (relationship.relationship === "backs" && relationship.wall) {
    return `Backed by a significant ${side} wall (${formatCompactUsd(relationship.wall.usd)} at ${formatPrice(relationship.wall.price)}).`;
  }
  if (relationship.relationship === "beyond" && relationship.wall) {
    const direction = kind === "support" ? "below" : "above";
    return `No wall right at this level, but a larger ${side} wall sits just ${direction} it (${formatCompactUsd(relationship.wall.usd)}).`;
  }
  return `No notable ${side} liquidity currently backing this level.`;
}

/**
 * Up to 2 walls per side, from the real per-level OKX book — see
 * liquidityWalls.ts's header for the methodology and its own measured
 * finding that this can only ever speak to the area right around current
 * price, not to targets further away.
 */
function NotableLiquidity({ walls }: { walls: LiquidityWallRead | null }) {
  if (!walls) return null;
  const bids = [...walls.bidWalls].sort((a, b) => b.zScore - a.zScore).slice(0, 2);
  const asks = [...walls.askWalls].sort((a, b) => b.zScore - a.zScore).slice(0, 2);

  return (
    <div className="border-t border-hairline pt-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">Notable liquidity</span>
        <InfoTooltip
          measures="Individual order-book price levels holding an unusually large resting order versus the rest of the visible book, right now — a real snapshot, not a prediction."
          whyItMatters="A large resting order can act as a magnet or an obstacle right at the current price. It says nothing about levels further away — the visible book only reaches a tiny fraction of a percent from price."
        />
      </div>
      {bids.length === 0 && asks.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          No standout liquidity concentrations in the visible book right now.
        </p>
      ) : (
        <div className="mt-1 grid grid-cols-2 gap-3">
          <WallList label="Bid" walls={bids} tone="text-success" />
          <WallList label="Ask" walls={asks} tone="text-danger" />
        </div>
      )}
    </div>
  );
}

function WallList({ label, walls, tone }: { label: string; walls: LiquidityWallWithPersistence[]; tone: string }) {
  if (walls.length === 0) {
    return (
      <div>
        <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
        <p className="mt-0.5 text-[11px] text-ink-faint">None standout.</p>
      </div>
    );
  }
  return (
    <div>
      <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <ul className="mt-0.5 flex flex-col gap-1">
        {walls.map((w, i) => (
          <li key={i} className="text-[11px] leading-relaxed">
            <span className={`font-mono ${tone}`}>{formatPrice(w.price)}</span>{" "}
            <span className="text-ink-faint">
              {formatCompactUsd(w.usd)}
              {formatPersistence(w.persistence)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Conservative terminology only — never implies intent behind a wall appearing or clearing, per this feature's own persistence methodology (see bookSnapshotStore.ts). */
function formatPersistence(p: PersistenceLabel): string {
  if (p.kind === "unavailable") return "";
  if (p.kind === "new") return " · first seen this poll";
  return ` · seen in ${p.snapshotsSeenIn}/${p.snapshotsChecked} recent polls`;
}

/** A zone with no real width (e.g. a degenerate single-bucket volume zone) collapses to one price rather than showing a redundant "$100–$100" range. */
function formatZoneRange(zone: SupportResistanceZone): string {
  if (zone.priceLow === zone.priceHigh) return formatPrice(zone.priceLow);
  return `${formatPrice(zone.priceLow)}–${formatPrice(zone.priceHigh)}`;
}
