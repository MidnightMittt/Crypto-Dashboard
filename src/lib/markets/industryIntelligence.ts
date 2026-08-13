import { Bar } from "@/lib/research/types";
import {
  buildRotation,
  SectorRotation,
  RotationRead,
  RotationState,
  ROTATION_LONG_SESSIONS,
  ROTATION_SHORT_SESSIONS,
} from "./rotation";
import { IndustryDef } from "./industries";
import { earningsVeto, EarningsCalendar, EarningsVetoResult } from "./earningsVeto";
import { buildDriverRead, DriverRead } from "./driverBeta";

/**
 * INDUSTRY INTELLIGENCE — level three, and the missing link between a sector
 * and a company.
 *
 * ── This file introduces NO new engine ────────────────────────────────
 *
 * Industry strength and constituent strength are both produced by
 * `buildRotation`, the same function the sector board uses, called with a
 * different set of inputs. Rotation never knew what a "sector" was; it takes
 * a list of series and a benchmark and returns relative strength. Sectors,
 * industries and individual companies are the same measurement applied to
 * three levels of the hierarchy, which is why one function serves all three.
 *
 * The only genuinely new quantity here is BREADTH, and it is new because it
 * has no meaning at the sector level in this dataset: measuring how many of
 * an industry's members are outperforming requires members, and until this
 * phase there were none.
 *
 * ── What breadth is, and what it is not ──────────────────────────────
 *
 * The share of an industry's constituents beating the BENCHMARK over the
 * short horizon. It answers the question the ETF cannot: is this industry
 * being carried by two names or lifted broadly?
 *
 * It is not a cap-weighted statistic, because this platform ingests no share
 * counts. Every constituent counts once. That makes it a genuine breadth
 * measure rather than a second, worse copy of the ETF — the ETF already gives
 * the cap-weighted answer, and the interesting number is the one that
 * disagrees with it.
 */

export interface ConstituentRead {
  symbol: string;
  /** Relative strength vs the benchmark, both horizons, and the quadrant. */
  rotation: SectorRotation;
  /**
   * Set when the name reports earnings inside the trade-plan veto window
   * (see earningsVeto.ts — the SAME function, so the marker here and a plan
   * refusal elsewhere can never disagree about a date). A pre-event
   * relative-strength read is still true, but acting on it means holding
   * through a gap; that is worth one glance before it is worth a click.
   * Null when no report is near — or the calendar is unavailable, which is
   * indistinguishable on purpose (absence of evidence never warns).
   */
  earnings: EarningsVetoResult | null;
}

export interface IndustryRead {
  slug: string;
  name: string;
  etf: string;
  sectorEtf: string;
  sectorName: string;
  proxyNote: string;
  /**
   * What this industry is ACTUALLY long, for the few that are moved by
   * something other than their own sector (see driverBeta.ts). Null for the
   * majority, which declare no external driver — absence here means "no
   * dominant outside force claimed", not "measured and found nothing"; a
   * measured-and-found-nothing shows up as a low rho on a present read.
   */
  driver: DriverRead | null;
  /** The industry ETF's own relative strength — the headline read. */
  rotation: SectorRotation;
  /**
   * The parent sector's rotation state, INHERITED rather than recomputed.
   * Null when the sector board could not be built.
   */
  sectorState: RotationState | null;
  sectorShortRelPct: number | null;
  /**
   * Share of constituents outperforming the benchmark over the short horizon,
   * 0-100. Null when too few constituents have enough history to measure —
   * never 0, which would read as "none are outperforming".
   */
  breadthPct: number | null;
  /** How many constituents could actually be measured, so breadth is readable. */
  measured: number;
  /** Every measurable constituent, ordered by short-horizon relative strength. */
  constituents: ConstituentRead[];
}

/** Below this many measurable names, a breadth percentage is noise dressed as a statistic. */
export const MIN_BREADTH_CONSTITUENTS = 3;

export interface BuildIndustriesInputs {
  defs: IndustryDef[];
  /** US-listing loader, by plain symbol. Injected rather than imported so this module stays pure and testable — the same reason every evidence module takes its data as an argument instead of fetching. */
  loadBars: (symbol: string) => Bar[] | null;
  benchmarkBars: Bar[];
  sectorRotation: RotationRead | null;
  /**
   * Loader by full INSTRUMENT ID, for driver series that are not US listings
   * (bitcoin is BTC-USD.SPOT). Separate from `loadBars` on purpose: one takes
   * a ticker and applies the US convention, the other takes an id and applies
   * none, and collapsing them would mean guessing which a string is.
   */
  loadSeries?: (id: string) => Bar[] | null;
  earningsCalendar?: EarningsCalendar | null;
  asOf?: number;
}

/**
 * Builds every industry that has enough data, skipping the rest loudly.
 *
 * Takes a named-argument object rather than a positional list: this grew to
 * six parameters, two of them optional and both nullable, which is the shape
 * where a caller silently passes a calendar where a timestamp belongs and
 * nothing complains.
 */
export function buildIndustries(inputs: BuildIndustriesInputs): IndustryRead[] {
  const {
    defs,
    loadBars,
    benchmarkBars,
    sectorRotation,
    loadSeries = () => null,
    earningsCalendar = null,
    asOf = Date.now(),
  } = inputs;
  const benchmark = { symbol: "SPY", name: "S&P 500", bars: benchmarkBars };
  const out: IndustryRead[] = [];

  for (const def of defs) {
    const etfBars = loadBars(def.etf);
    if (!etfBars) continue;

    // The industry's own read: one series against the benchmark, through the
    // same function the sector board uses.
    const etfRead = buildRotation([{ symbol: def.etf, name: def.name, bars: etfBars }], benchmark);
    if (!etfRead) continue;

    // Constituents: the identical call, with many series instead of one.
    const constituentInputs = def.constituents
      .map((sym) => ({ symbol: sym, name: sym, bars: loadBars(sym) }))
      .filter((c): c is { symbol: string; name: string; bars: Bar[] } => c.bars !== null);
    const constituentRead = buildRotation(constituentInputs, benchmark);
    const constituents: ConstituentRead[] =
      constituentRead?.sectors.map((s) => ({
        symbol: s.symbol,
        rotation: s,
        earnings: earningsVeto(s.symbol, earningsCalendar, asOf),
      })) ?? [];

    const measured = constituents.length;
    const outperforming = constituents.filter((c) => c.rotation.shortRelPct > 0).length;
    const breadthPct =
      measured >= MIN_BREADTH_CONSTITUENTS ? Math.round((outperforming / measured) * 100) : null;

    const sector = sectorRotation?.sectors.find((s) => s.symbol === def.sectorEtf) ?? null;

    /*
     * What this industry is actually long, when it declares an external
     * driver. Measured against the industry ETF (not the constituents): the
     * ETF is the group, and a per-name beta would be six numbers where the
     * decision needs one. The sector ETF is fitted alongside so the two
     * explanations compete on the same window — see driverBeta.ts.
     */
    const driverBars = def.driver ? loadSeries(def.driver.seriesId) : null;
    const driver = def.driver
      ? buildDriverRead({
          industryBars: etfBars,
          driverBars,
          sectorBars: loadBars(def.sectorEtf),
          driver: def.driver,
          sectorSymbol: def.sectorEtf,
        })
      : null;

    out.push({
      slug: def.slug,
      name: def.name,
      etf: def.etf,
      sectorEtf: def.sectorEtf,
      sectorName: def.sectorName,
      proxyNote: def.proxyNote,
      driver,
      rotation: etfRead.sectors[0],
      sectorState: sector?.state ?? null,
      sectorShortRelPct: sector?.shortRelPct ?? null,
      breadthPct,
      measured,
      constituents,
    });
  }

  // Ordered like the sector board: short-horizon relative strength, because
  // where capital is going now outranks where it has been.
  out.sort((a, b) => b.rotation.shortRelPct - a.rotation.shortRelPct || a.slug.localeCompare(b.slug));
  return out;
}

/**
 * The industry stated as a sentence, in the context of its parent.
 *
 * This is where the hierarchy earns its keep. The two most decision-relevant
 * cases are DIVERGENCES — an industry leading inside a lagging sector, or
 * lagging inside a leading one — because both are invisible from either level
 * alone and both change what a position in the sector ETF actually owns.
 */
export function describeIndustry(read: IndustryRead): string {
  const parts: string[] = [];
  const rel = fmt(read.rotation.shortRelPct);

  parts.push(
    `${read.name} is ${read.rotation.state.toUpperCase()} — ${rel} against the S&P over a month, ${fmt(read.rotation.longRelPct)} over six.`
  );

  if (read.sectorState) {
    const industryAhead = read.rotation.shortRelPct > (read.sectorShortRelPct ?? 0);
    if (read.sectorState !== read.rotation.state) {
      parts.push(
        `Its sector, ${read.sectorName}, is ${read.sectorState.toUpperCase()} — the industry and its parent are in different states, so owning ${read.sectorEtf} does not give you this exposure.`
      );
    } else {
      parts.push(
        `${read.sectorName} is in the same state, and the industry is ${industryAhead ? "ahead of" : "behind"} it by ${fmt(Math.abs(read.rotation.shortRelPct - (read.sectorShortRelPct ?? 0))).replace("+", "")}.`
      );
    }
  }

  if (read.breadthPct !== null) {
    if (read.breadthPct >= 60) {
      parts.push(
        `Breadth is broad: ${read.breadthPct}% of ${read.measured} measured names are beating the index, so the move is the industry rather than one or two members.`
      );
    } else if (read.breadthPct <= 35) {
      parts.push(
        `Breadth is narrow: only ${read.breadthPct}% of ${read.measured} measured names beat the index. The ETF is being carried by its largest holdings, and the average member is not participating.`
      );
    } else {
      parts.push(`Breadth is mixed — ${read.breadthPct}% of ${read.measured} measured names beat the index.`);
    }
  } else {
    parts.push(
      `Too few constituents have enough history to measure breadth, so whether this move is broad or narrow is unknown rather than assumed.`
    );
  }

  return parts.join(" ");
}

/**
 * The single most useful cross-level observation: an industry whose breadth
 * contradicts its price.
 *
 * A rising ETF on narrow breadth is the classic late-stage pattern, and it is
 * not visible from the ETF alone — which is the whole argument for building
 * this level.
 */
export function breadthDivergence(read: IndustryRead): string | null {
  if (read.breadthPct === null) return null;
  if (read.rotation.shortRelPct > 0 && read.breadthPct <= 35) {
    return `Outperforming on narrow breadth — the index-level strength is not shared by most members.`;
  }
  if (read.rotation.shortRelPct < 0 && read.breadthPct >= 65) {
    return `Underperforming while most members beat the index — the ETF's largest holdings are masking a healthier group.`;
  }
  return null;
}

export const HORIZON_NOTE = `Short horizon is ${ROTATION_SHORT_SESSIONS} sessions, long is ${ROTATION_LONG_SESSIONS} — the same windows the sector board uses, so the two levels are directly comparable.`;

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
