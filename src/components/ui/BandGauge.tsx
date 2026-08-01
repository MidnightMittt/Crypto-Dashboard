import { SentimentBand } from "@/types/market";
import { bandPosition } from "@/lib/sentiment/bands";

/**
 * Small, simple gauge for a metric that already has an established
 * SentimentBand[] table (FUNDING_BANDS, OI_BANDS, LEVERAGE_HEAT_BANDS,
 * LONG_SHORT_BANDS, DOMINANCE_ROTATION_BANDS) and a Badge already showing
 * that same band's label elsewhere on the card. This doesn't introduce a
 * second, possibly-disagreeing scoring system — it visualizes the position
 * behind the label the badge already shows, using the SAME band table and
 * (where one already exists) the same colors the card's own big radial
 * gauge already uses for that band, e.g. OI_BANDS' 5 colors already used by
 * OpenInterestGauge's GaugeBase.
 *
 * See ui/LeanGauge.tsx for the sibling component used where there's no
 * pre-existing band table — Coinbase Premium, Deribit Options, stablecoin
 * flow.
 */
export function BandGauge({
  value,
  bands,
  colors,
}: {
  value: number;
  bands: SentimentBand[];
  colors: string[];
}) {
  const { position, index, label } = bandPosition(value, bands);
  const color = colors[index] ?? colors[colors.length - 1] ?? "#8890A0";
  const gradient = colors.join(", ");

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative h-1.5 w-full rounded-full" style={{ background: `linear-gradient(to right, ${gradient})` }}>
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-void"
          style={{ left: `${position}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
        {label}
      </span>
    </div>
  );
}
