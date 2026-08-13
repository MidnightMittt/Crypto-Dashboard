import { describe, expect, it } from "vitest";
import { buildIndustries, breadthDivergence, MIN_BREADTH_CONSTITUENTS } from "./industryIntelligence";
import { buildRotation, ROTATION_LONG_SESSIONS } from "./rotation";
import { IndustryDef } from "./industries";
import { Bar } from "@/lib/research/types";

const DAY = 86_400_000;

function series(start: number, end: number, n = ROTATION_LONG_SESSIONS + 5): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + ((end - start) * i) / (n - 1);
    return { t: i * DAY, open: c, high: c, low: c, close: c, volume: 1000 };
  });
}

const bench = series(100, 110); // benchmark: +10%

function def(constituents: string[]): IndustryDef {
  return {
    slug: "test",
    name: "Test Industry",
    etf: "ETF",
    sectorEtf: "XLK",
    sectorName: "Technology",
    proxyNote: "test",
    constituents,
  };
}

describe("buildIndustries", () => {
  it("measures breadth as the share of constituents beating the BENCHMARK, counted once each", () => {
    // Three beat +10%, one does not. 3/4 = 75%.
    const bars: Record<string, Bar[]> = {
      ETF: series(100, 120),
      A: series(100, 130),
      B: series(100, 125),
      C: series(100, 120),
      D: series(100, 105),
    };
    const [read] = buildIndustries({ defs: [def(["A", "B", "C", "D"])], loadBars: (s) => bars[s] ?? null, benchmarkBars: bench, sectorRotation: null });
    expect(read.measured).toBe(4);
    expect(read.breadthPct).toBe(75);
  });

  it("returns NULL breadth below the minimum, never 0 — unknown is not 'none are outperforming'", () => {
    const bars: Record<string, Bar[]> = { ETF: series(100, 120), A: series(100, 105) };
    const [read] = buildIndustries({ defs: [def(["A"])], loadBars: (s) => bars[s] ?? null, benchmarkBars: bench, sectorRotation: null });
    expect(read.measured).toBeLessThan(MIN_BREADTH_CONSTITUENTS);
    expect(read.breadthPct).toBeNull();
  });

  it("INHERITS the sector state rather than recomputing it", () => {
    const bars: Record<string, Bar[]> = { ETF: series(100, 120) };
    const sectorRotation = buildRotation(
      [{ symbol: "XLK", name: "Technology", bars: series(100, 130) }],
      { symbol: "SPY", name: "S&P 500", bars: bench }
    )!;
    const [read] = buildIndustries({ defs: [def([])], loadBars: (s) => bars[s] ?? null, benchmarkBars: bench, sectorRotation });
    expect(read.sectorState).toBe(sectorRotation.sectors[0].state);
    expect(read.sectorShortRelPct).toBe(sectorRotation.sectors[0].shortRelPct);
  });

  it("skips an industry whose proxy ETF is missing rather than emitting a hollow one", () => {
    expect(buildIndustries({ defs: [def(["A"])], loadBars: () => null, benchmarkBars: bench, sectorRotation: null })).toEqual([]);
  });
});

describe("breadthDivergence", () => {
  const base = {
    slug: "x", name: "X", etf: "E", sectorEtf: "XLK", sectorName: "Tech", proxyNote: "",
    driver: null,
    sectorState: null, sectorShortRelPct: null, measured: 10, constituents: [],
  };
  const rot = (shortRelPct: number) => ({
    symbol: "E", name: "X", longRelPct: 0, shortRelPct, momentumPct: 0, state: "leading" as const, shortAbsPct: 0,
  });

  it("flags an ETF outperforming while most members do not — the late-stage pattern", () => {
    const out = breadthDivergence({ ...base, rotation: rot(5), breadthPct: 20 });
    expect(out).toContain("narrow breadth");
  });

  it("flags the reverse: a lagging ETF whose members are mostly winning", () => {
    const out = breadthDivergence({ ...base, rotation: rot(-5), breadthPct: 80 });
    expect(out).toContain("masking");
  });

  it("says nothing when price and breadth agree, rather than manufacturing an observation", () => {
    expect(breadthDivergence({ ...base, rotation: rot(5), breadthPct: 80 })).toBeNull();
    expect(breadthDivergence({ ...base, rotation: rot(5), breadthPct: null })).toBeNull();
  });
});
