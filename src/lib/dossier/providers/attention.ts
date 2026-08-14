/**
 * NEWS & SOCIAL ATTENTION — headlines and self-tagged sentiment.
 *
 * Two sources, one honesty rule for both: this module REPORTS what is
 * published and COUNTS what users tagged. It classifies nothing itself.
 * "Bullish news" as a machine judgement would be a sentiment model wearing
 * a research hat — the platform's no-hallucination rule applies to
 * classification exactly as it applies to prose. What can be stated without
 * a model: the headlines that exist, when they clustered, and how the crowd
 * that chose to self-label leans.
 */

// ── News: Yahoo Finance search, keyless ─────────────────────────────────

export interface NewsItem {
  title: string;
  publisher: string;
  publishedAt: number; // ms epoch
  url: string;
}

export interface NewsSummary {
  items: NewsItem[];
  /** How clustered coverage is: items in the last 48h vs the whole window. */
  recentCount: number;
  classificationNote: string;
}

export type NewsResult = { ok: true; summary: NewsSummary } | { ok: false; reason: string };

interface YahooSearchResponse {
  news?: Array<{ title?: string; publisher?: string; providerPublishTime?: number; link?: string }>;
}

export async function fetchNews(providerSymbol: string): Promise<NewsResult> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(providerSymbol)}&newsCount=10&quotesCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, next: { revalidate: 1_800 } }
    );
    if (!res.ok) return { ok: false, reason: `The news feed returned HTTP ${res.status}.` };
    const json = (await res.json()) as YahooSearchResponse;

    const items: NewsItem[] = (json.news ?? [])
      .filter((n) => n.title && n.link && n.providerPublishTime)
      .map((n) => ({
        title: n.title!,
        publisher: n.publisher ?? "unknown",
        publishedAt: n.providerPublishTime! * 1000,
        url: n.link!,
      }));

    if (items.length === 0) return { ok: false, reason: "The news feed returned no stories for this symbol." };

    const cutoff = Date.now() - 48 * 3_600_000;
    return {
      ok: true,
      summary: {
        items,
        recentCount: items.filter((i) => i.publishedAt >= cutoff).length,
        classificationNote:
          "Headlines are listed, not judged: this platform does not classify news as bullish or bearish, because a sentiment model's opinion would be exactly the kind of unverifiable claim the rest of this page refuses to make.",
      },
    };
  } catch (err) {
    return { ok: false, reason: `The news feed could not be reached (${err instanceof Error ? err.message : "unknown"}).` };
  }
}

// ── Social: StockTwits symbol stream, keyless ───────────────────────────

export interface SocialSummary {
  source: "StockTwits";
  sampleSize: number;
  /** How many of the sample chose to tag a direction at all. */
  taggedCount: number;
  taggedBullish: number;
  taggedBearish: number;
  /** Bullish share among the SELF-TAGGED only. Null below the floor. */
  bullishPctOfTagged: number | null;
  /** Span of the sample in hours — 30 messages in 2 hours is a different fact than 30 in 4 days. */
  sampleSpanHours: number | null;
  selfReportNote: string;
}

/** Below this many tagged messages, a percentage is noise dressed as sentiment. */
export const MIN_TAGGED = 8;

export interface StocktwitsMessage {
  created_at: string;
  entities?: { sentiment?: { basic?: string } | null };
}

/** Pure summariser, so the tagging arithmetic is testable without HTTP. */
export function summariseMessages(messages: StocktwitsMessage[]): SocialSummary {
  let bullish = 0;
  let bearish = 0;
  for (const m of messages) {
    const tag = m.entities?.sentiment?.basic;
    if (tag === "Bullish") bullish++;
    else if (tag === "Bearish") bearish++;
  }
  const tagged = bullish + bearish;

  const times = messages.map((m) => Date.parse(m.created_at)).filter(Number.isFinite);
  const spanHours =
    times.length >= 2 ? Math.round(((Math.max(...times) - Math.min(...times)) / 3_600_000) * 10) / 10 : null;

  return {
    source: "StockTwits",
    sampleSize: messages.length,
    taggedCount: tagged,
    taggedBullish: bullish,
    taggedBearish: bearish,
    bullishPctOfTagged: tagged >= MIN_TAGGED ? Math.round((bullish / tagged) * 100) : null,
    sampleSpanHours: spanHours,
    selfReportNote:
      "These are labels users chose for their own posts — self-reported enthusiasm, not measured positioning, and retail crowds are most unanimous nearest to turns. A useful temperature, never a signal.",
  };
}

export type SocialResult = { ok: true; summary: SocialSummary } | { ok: false; reason: string };

export async function fetchSocial(symbol: string): Promise<SocialResult> {
  try {
    const res = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      next: { revalidate: 900 },
    });
    if (res.status === 404) return { ok: false, reason: `StockTwits has no stream for ${symbol}.` };
    if (!res.ok) return { ok: false, reason: `StockTwits returned HTTP ${res.status}.` };
    const json = (await res.json()) as { messages?: StocktwitsMessage[] };
    const messages = json.messages ?? [];
    if (messages.length === 0) return { ok: false, reason: "StockTwits returned an empty stream." };
    return { ok: true, summary: summariseMessages(messages) };
  } catch (err) {
    return { ok: false, reason: `StockTwits could not be reached (${err instanceof Error ? err.message : "unknown"}).` };
  }
}
