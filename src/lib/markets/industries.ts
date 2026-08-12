/**
 * THE INDUSTRY TAXONOMY — the missing link between sectors and companies.
 *
 * This file is DATA, not logic. It declares which liquid ETF proxies an
 * industry, which sector that industry rolls up into, and which companies
 * belong to it. Nothing here ranks, scores, or weights anything: the ordering
 * of industries and of companies is produced entirely by `buildRotation`,
 * the same function the sector board already uses.
 *
 * ── Why a declared membership list is not a hardcoded ranking ─────────
 *
 * The brief forbids hardcoded rankings, and rightly. Membership is a
 * different kind of statement: "NVDA is a semiconductor company" is a fact
 * about the world that has to be written down somewhere, the way "XLK proxies
 * Technology" already is. What must never be hardcoded is the ORDER, and no
 * order appears in this file. Every list below is alphabetical.
 *
 * ── What is deliberately absent ──────────────────────────────────────
 *
 * No weights. A cap-weighted industry composite would need share counts this
 * platform does not ingest, and inventing weights to make an index look
 * official is exactly the kind of fabrication the standard forbids. Industry
 * strength is read from a real, tradeable ETF whose weights the issuer
 * maintains; constituent strength is read per name. Neither pretends to be a
 * weighted basket.
 *
 * No themes. AI Infrastructure, Nuclear, Quantum and the rest are graphs
 * built ACROSS industries, and building them before industries exist is the
 * step the brief explicitly says not to skip.
 */

export interface IndustryDef {
  slug: string;
  name: string;
  /** The tradeable ETF this industry is measured through. Real, liquid, issuer-maintained weights. */
  etf: string;
  /** The sector SPDR this industry rolls up into, so the hierarchy inherits. */
  sectorEtf: string;
  sectorName: string;
  /** Why this ETF is the right proxy, and what it does and does not cover. */
  proxyNote: string;
  /**
   * Constituents, ALPHABETICAL. Not a ranking and not exhaustive — a liquid,
   * recognisable subset large enough that leadership within the industry is
   * measurable. Where a name spans two industries it is listed under the one
   * that drives its revenue.
   */
  constituents: string[];
}

export const INDUSTRIES: IndustryDef[] = [
  {
    slug: "semiconductors",
    name: "Semiconductors",
    etf: "SMH",
    sectorEtf: "XLK",
    sectorName: "Technology",
    proxyNote:
      "VanEck Semiconductor. Concentrated in the largest names by design, so it tracks the industry's leaders more than its breadth — read the constituent list below for what the ETF's concentration hides.",
    constituents: ["AMAT", "AMD", "ASML", "AVGO", "INTC", "KLAC", "LRCX", "MU", "NVDA", "QCOM", "TSM", "TXN"],
  },
  {
    slug: "software",
    name: "Software",
    etf: "IGV",
    sectorEtf: "XLK",
    sectorName: "Technology",
    proxyNote:
      "iShares Expanded Tech-Software. Application and infrastructure software together; it does not separate the two, which matters because they have diverged repeatedly.",
    constituents: ["ADBE", "CRM", "MSFT", "NOW", "ORCL", "PANW", "PLTR", "SNOW"],
  },
  {
    slug: "regional-banks",
    name: "Regional Banks",
    etf: "KRE",
    sectorEtf: "XLF",
    sectorName: "Financials",
    proxyNote:
      "SPDR S&P Regional Banking, equal-weighted. That equal weighting is the point: it measures the health of the group rather than the fortunes of the three largest, which is what makes it a credit-stress read.",
    constituents: ["CFG", "FITB", "HBAN", "KEY", "MTB", "RF", "TFC", "USB"],
  },
  {
    slug: "capital-markets",
    name: "Capital Markets",
    etf: "KCE",
    sectorEtf: "XLF",
    sectorName: "Financials",
    proxyNote:
      "SPDR S&P Capital Markets. Brokers, exchanges and asset managers — the part of finance that earns on activity rather than on the rate spread.",
    constituents: ["BLK", "CME", "GS", "ICE", "MS", "SCHW"],
  },
  {
    slug: "oil-services",
    name: "Oil Services",
    etf: "OIH",
    sectorEtf: "XLE",
    sectorName: "Energy",
    proxyNote:
      "VanEck Oil Services. Drilling and equipment rather than production, so it responds to capital-expenditure intent rather than to the spot oil price.",
    constituents: ["BKR", "FTI", "HAL", "SLB"],
  },
  {
    slug: "homebuilders",
    name: "Homebuilders",
    etf: "ITB",
    sectorEtf: "XLY",
    sectorName: "Consumer Discretionary",
    proxyNote:
      "iShares U.S. Home Construction. Includes suppliers and retailers alongside builders, so it reads housing activity broadly rather than builder margins specifically.",
    constituents: ["DHI", "HD", "LEN", "LOW", "NVR", "PHM"],
  },
  {
    slug: "defense",
    name: "Aerospace & Defense",
    etf: "ITA",
    sectorEtf: "XLI",
    sectorName: "Industrials",
    proxyNote:
      "iShares U.S. Aerospace & Defense. Commercial aerospace and defence primes together — a live distinction, since the two cycles are driven by completely different buyers.",
    constituents: ["BA", "GD", "LHX", "LMT", "NOC", "RTX"],
  },
  {
    slug: "transportation",
    name: "Transportation",
    etf: "IYT",
    sectorEtf: "XLI",
    sectorName: "Industrials",
    proxyNote:
      "iShares U.S. Transportation. Rails, truckers and parcel. Long treated as a read on physical demand, which is why it is watched against the industrial average.",
    constituents: ["CSX", "FDX", "NSC", "ODFL", "UNP", "UPS"],
  },
  {
    slug: "medical-devices",
    name: "Medical Devices",
    etf: "IHI",
    sectorEtf: "XLV",
    sectorName: "Health Care",
    proxyNote:
      "iShares U.S. Medical Devices. Equipment and supplies, excluding pharma and biotech — the part of healthcare that behaves like an industrial rather than like a patent portfolio.",
    constituents: ["ABT", "BSX", "DHR", "ISRG", "MDT", "SYK"],
  },
  {
    slug: "biotech",
    name: "Biotechnology",
    etf: "XBI",
    sectorEtf: "XLV",
    sectorName: "Health Care",
    proxyNote:
      "SPDR S&P Biotech, equal-weighted. The equal weighting makes it a genuine risk-appetite read on small-cap biotech rather than a proxy for four large caps.",
    constituents: ["AMGN", "BIIB", "GILD", "REGN", "VRTX"],
  },
  {
    slug: "retail",
    name: "Retail",
    etf: "XRT",
    sectorEtf: "XLY",
    sectorName: "Consumer Discretionary",
    proxyNote:
      "SPDR S&P Retail, equal-weighted. Reads the breadth of retail rather than Amazon, which is why it can diverge sharply from the discretionary sector itself.",
    constituents: ["COST", "LULU", "ROST", "TGT", "TJX", "WMT"],
  },
  {
    slug: "gold-miners",
    name: "Gold Miners",
    etf: "GDX",
    sectorEtf: "XLB",
    sectorName: "Materials",
    proxyNote:
      "VanEck Gold Miners. A leveraged expression of the gold price rather than an independent industry — read it against GLD, not against the market, to separate operating performance from the metal.",
    constituents: ["AEM", "AU", "GOLD", "KGC", "NEM", "WPM"],
  },
  {
    slug: "copper-miners",
    name: "Copper Miners",
    etf: "COPX",
    sectorEtf: "XLB",
    sectorName: "Materials",
    proxyNote:
      "Global X Copper Miners. Widely used as a read on industrial demand and on electrification capital expenditure specifically.",
    constituents: ["FCX", "SCCO", "TECK"],
  },
  {
    slug: "utilities-power",
    name: "Power & Utilities",
    etf: "XLU",
    sectorEtf: "XLU",
    sectorName: "Utilities",
    proxyNote:
      "The Utilities sector SPDR serves as its own industry proxy — there is no more granular liquid US power-generation ETF with sufficient history. Named honestly rather than split into a finer industry the data cannot support.",
    constituents: ["AEP", "CEG", "D", "DUK", "NEE", "SO", "VST"],
  },
];

/** Every ticker the industry layer needs ingested — proxies and constituents. */
export function industryUniverse(): string[] {
  const set = new Set<string>();
  for (const i of INDUSTRIES) {
    set.add(i.etf);
    for (const c of i.constituents) set.add(c);
  }
  return [...set].sort();
}

export function findIndustry(slug: string): IndustryDef | null {
  return INDUSTRIES.find((i) => i.slug === slug) ?? null;
}

/** Industries belonging to a sector ETF, for the sector -> industry drill-down. */
export function industriesInSector(sectorEtf: string): IndustryDef[] {
  return INDUSTRIES.filter((i) => i.sectorEtf === sectorEtf);
}
