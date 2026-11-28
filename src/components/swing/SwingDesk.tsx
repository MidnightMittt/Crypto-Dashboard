"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * THE SWING DESK.
 *
 * Four views over ONE payload from /api/swing, so the opportunity list and
 * the position marks can never describe different moments.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────
 *
 * It does not present every attractive level as a trade. The stage badge is
 * the primary visual element on every card for exactly that reason: WATCHING
 * and ENTRY CONFIRMED are different objects, and a UI that renders them
 * identically is the one that gets someone into a trade price never
 * confirmed. Confluence is shown as EVIDENCE, never as a signal.
 *
 * Mobile first: single column under `sm`, tap targets ≥44px, the stage badge
 * and the action button reachable without horizontal scrolling.
 */

type Stage =
  | "WATCHING" | "APPROACHING" | "WAITING_CONFIRMATION" | "ENTRY_CONFIRMED"
  | "ACTIVE" | "PARTIALLY_EXITED" | "COMPLETED" | "INVALIDATED";

interface Target { price: number; basis: string; rMultiple: number; closeFraction: number }
interface Factor { family: string; detail: string; price?: number }

interface Opportunity {
  id: string; asset: string; direction: "long" | "short"; state: Stage; price: number;
  plan: { entryLow: number; entryHigh: number; entryRef: number; stopPrice: number; stopBasis: string; entryBasis: string; riskRewardRatio: number };
  targets: Target[];
  trigger: { kind: string; description: string; satisfied: boolean; price: number | null };
  quality: { familyCount: number; quality: string; htfAligned: boolean; score: number; reasons: string[]; missing: string[] };
  zone: { priceLow: number; priceHigh: number; kind: string; timeframe: string; reactionCount: number } | null;
  confluence: { factors: Factor[] };
  trend: { direction: string; longSlopePct: number | null; pullbackInTrend: boolean };
  distanceAtr: number;
  sizing: { quantity: number; notional: number; riskAmount: number; stopDistancePct: number; explanation: string } | null;
  riskRefusal: string | null;
}

interface Position {
  id: string; opportunityId: string; asset: string; direction: "long" | "short"; state: Stage;
  entryPrice: number; quantity: number; remainingQuantity: number; stopPrice: number;
  targets: Target[]; realisedPnl: number; openedAt: number;
  markPrice: number | null; unrealised: number | null; remainingRisk: number;
  fills: Array<{ reason: string; price: number; quantity: number; realisedPnl: number; t: number }>;
  thesis: { reasons: string[]; familyCount: number; htfAligned: boolean; trendDirection: string };
}

interface Payload {
  generatedAt: number; backend: string; persistenceHealthy: boolean; assetsScanned: number; failures: string[];
  opportunities: Opportunity[]; positions: Position[]; watchlist: string[];
  notifications: Array<{ t: number; message: string }>;
  config: Record<string, number | number[]>;
  openCount: number;
  performance: {
    paper: {
      trades: number; wins: number; losses: number; winRatePct: number | null; netPnl: number;
      avgWinner: number | null; avgLoser: number | null; avgR: number | null; profitFactor: number | null;
      maxDrawdown: number; totalFees: number; sufficient: boolean; breakevenWinRatePct: number | null;
    };
    breakdowns: Record<string, Array<{ label: string; trades: number; winRatePct: number | null; netPnl: number; avgR: number | null; sufficient: boolean }>>;
  };
  equitiesAvailable: boolean;
}

const money = (n: number | null | undefined, dp = 2) =>
  n == null ? "—" : (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(dp));
const pct = (n: number | null | undefined, dp = 1) => (n == null ? "—" : `${n.toFixed(dp)}%`);

const STAGE: Record<Stage, { label: string; cls: string }> = {
  WATCHING:             { label: "Watching",       cls: "bg-white/5 text-white/55 border-white/10" },
  APPROACHING:          { label: "Approaching",    cls: "bg-cyan/10 text-cyan border-cyan/30" },
  WAITING_CONFIRMATION: { label: "Awaiting trigger", cls: "bg-amber/10 text-amber border-amber/30" },
  ENTRY_CONFIRMED:      { label: "Entry confirmed", cls: "bg-success/15 text-success border-success/40" },
  ACTIVE:               { label: "Active",         cls: "bg-success/15 text-success border-success/40" },
  PARTIALLY_EXITED:     { label: "Partial exit",   cls: "bg-cyan/10 text-cyan border-cyan/30" },
  COMPLETED:            { label: "Closed",         cls: "bg-white/5 text-white/45 border-white/10" },
  INVALIDATED:          { label: "Invalidated",    cls: "bg-danger/10 text-danger border-danger/30" },
};

function Badge({ state }: { state: Stage }) {
  const s = STAGE[state] ?? STAGE.WATCHING;
  return <span className={`inline-block rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.cls}`}>{s.label}</span>;
}

function Side({ d }: { d: "long" | "short" }) {
  return (
    <span className={`text-[11px] font-bold uppercase tracking-wider ${d === "long" ? "text-success" : "text-danger"}`}>
      {d}
    </span>
  );
}

export function SwingDesk() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"opps" | "active" | "watch" | "journal">("opps");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/swing?assets=6", { cache: "no-store" });
      if (!r.ok) throw new Error(`scan failed (${r.status})`);
      setData(await r.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "scan failed");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const r = await fetch("/api/swing/action", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? "action failed");
      else { setErr(null); await load(); }
    } finally { setBusy(null); }
  };

  const opps = data?.opportunities ?? [];
  const live = useMemo(() => (data?.positions ?? []).filter(p => p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED"), [data]);
  const closed = useMemo(() => (data?.positions ?? []).filter(p => p.state === "COMPLETED"), [data]);
  const watched = useMemo(() => opps.filter(o => data?.watchlist.includes(o.id)), [opps, data]);

  const overview = useMemo(() => {
    const byAsset = new Map<string, Opportunity[]>();
    for (const o of opps) {
      if (!byAsset.has(o.asset)) byAsset.set(o.asset, []);
      byAsset.get(o.asset)!.push(o);
    }
    return [...byAsset.entries()].map(([asset, list]) => ({
      asset,
      price: list[0]?.price ?? 0,
      trend: list[0]?.trend.direction ?? "unknown",
      best: list.slice().sort((a, b) => b.quality.score - a.quality.score)[0] ?? null,
      conflicted: list.some(x => x.direction === "long") && list.some(x => x.direction === "short"),
    }));
  }, [opps]);

  if (!data && !err) return <div className="p-6 text-sm text-white/50">Scanning the market…</div>;

  return (
    <div className="mx-auto w-full max-w-4xl px-3 pb-24 pt-4 sm:px-5">
      {/* ── market overview strip ─────────────────────────────────────── */}
      <div className="mb-4 overflow-x-auto">
        <div className="flex gap-2 min-w-min">
          {overview.map(a => (
            <div key={a.asset} className="shrink-0 rounded-lg border border-hairline bg-panel px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold">{a.asset}</span>
                <span className="font-mono text-xs text-white/60">{money(a.price)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-wider">
                <span className={a.trend === "up" ? "text-success" : a.trend === "down" ? "text-danger" : "text-white/40"}>
                  trend {a.trend}
                </span>
                {a.conflicted && <span className="text-amber">mixed</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {err && <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{err}</div>}

      {/* ── tabs ──────────────────────────────────────────────────────── */}
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-hairline bg-panel p-1">
        {([["opps", `Opportunities ${opps.length}`], ["active", `Active ${live.length}`],
           ["watch", `Watchlist ${watched.length}`], ["journal", `Journal ${closed.length}`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`min-h-[40px] flex-1 whitespace-nowrap rounded px-3 text-xs font-semibold transition ${
              tab === k ? "bg-panel-hi text-cyan" : "text-white/50 hover:text-white/80"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "opps" && (
        <div className="space-y-2">
          {opps.length === 0 && <Empty>No qualifying setups right now. That is a result, not a failure.</Empty>}
          {opps.map(o => (
            <OppCard key={o.id} o={o} open={openId === o.id} onToggle={() => setOpenId(openId === o.id ? null : o.id)}
              watched={!!data?.watchlist.includes(o.id)} busy={busy}
              onWatch={() => act({ action: "watch", opportunityId: o.id }, `w:${o.id}`)}
              onApprove={() => act({ action: "approve", opportunityId: o.id, asset: o.asset }, `a:${o.id}`)} />
          ))}
        </div>
      )}

      {tab === "watch" && (
        <div className="space-y-2">
          {watched.length === 0 && <Empty>Nothing on the watchlist. Star a setup to keep it here.</Empty>}
          {watched.map(o => (
            <OppCard key={o.id} o={o} open={openId === o.id} onToggle={() => setOpenId(openId === o.id ? null : o.id)}
              watched busy={busy}
              onWatch={() => act({ action: "watch", opportunityId: o.id }, `w:${o.id}`)}
              onApprove={() => act({ action: "approve", opportunityId: o.id, asset: o.asset }, `a:${o.id}`)} />
          ))}
        </div>
      )}

      {tab === "active" && (
        <div className="space-y-2">
          {live.length === 0 && <Empty>No open paper positions.</Empty>}
          {live.map(p => <PositionCard key={p.id} p={p} />)}
        </div>
      )}

      {tab === "journal" && <Journal data={data!} closed={closed} />}

      <div className="mt-6 text-[10px] leading-relaxed text-white/35">
        PAPER TRADING ONLY — no brokerage integration exists in this workflow.
        State persisted via <span className="font-mono">{data?.backend}</span>.
        {data && !data.persistenceHealthy && (
          <span className="ml-1 font-semibold text-danger">
            PERSISTENCE BROKEN — serverless without KV; positions will not survive. Configure KV_REST_API_URL / KV_REST_API_TOKEN.
          </span>
        )}
        Scanned {data?.assetsScanned} assets{data?.failures.length ? `, ${data.failures.length} failed` : ""}.
        {data && !data.equitiesAvailable && " Equities unavailable — no live candle path."}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-hairline bg-panel px-4 py-8 text-center text-sm text-white/45">{children}</div>;
}

function OppCard({ o, open, onToggle, watched, onWatch, onApprove, busy }: {
  o: Opportunity; open: boolean; onToggle: () => void; watched: boolean;
  onWatch: () => void; onApprove: () => void; busy: string | null;
}) {
  const canApprove = o.state === "ENTRY_CONFIRMED" && !o.riskRefusal && !!o.sizing;
  return (
    <div className="rounded-lg border border-hairline bg-panel">
      <button onClick={onToggle} className="flex w-full items-start gap-3 p-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{o.asset}</span>
            <Side d={o.direction} />
            <Badge state={o.state} />
            {o.quality.htfAligned && <span className="text-[10px] uppercase tracking-wider text-cyan">HTF aligned</span>}
          </div>
          <div className="mt-1.5 font-mono text-xs text-white/60">
            {money(o.price)} · entry {money(o.plan.entryLow)}–{money(o.plan.entryHigh)} · stop {money(o.plan.stopPrice)} · {o.plan.riskRewardRatio.toFixed(1)}R
          </div>
          <div className="mt-1 text-[11px] text-white/45">
            {o.trigger.satisfied ? "✓ trigger fired" : `needs: ${o.trigger.description}`}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-lg font-bold text-cyan">{o.quality.score}</div>
          <div className="text-[9px] uppercase tracking-wider text-white/35">rank</div>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-hairline px-3 py-3 text-xs">
          <Section title="Why this is interesting">
            <ul className="space-y-1">
              {o.confluence.factors.map((f, i) => (
                <li key={i} className="text-white/70"><span className="text-cyan">·</span> {f.detail}</li>
              ))}
              {o.trend.pullbackInTrend && <li className="text-white/70"><span className="text-cyan">·</span> pulling back to the fast EMA inside an established trend</li>}
            </ul>
            <p className="mt-2 text-[10px] text-white/35">
              {o.quality.familyCount} independent {o.quality.familyCount === 1 ? "family" : "families"} of evidence
              ({o.quality.quality}). Evidence, not a signal — confluence alone never triggers an entry.
            </p>
          </Section>

          <Section title="What is still required">
            {o.quality.missing.length === 0
              ? <p className="text-success">Nothing — the trigger has fired and risk checks pass.</p>
              : <ul className="space-y-1">{o.quality.missing.map((m, i) => <li key={i} className="text-amber/90">· {m}</li>)}</ul>}
          </Section>

          <Section title="The plan">
            <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-3">
              <Cell k="Entry" v={`${money(o.plan.entryLow)}–${money(o.plan.entryHigh)}`} />
              <Cell k="Stop" v={money(o.plan.stopPrice)} tone="danger" />
              {o.targets.map((t, i) => (
                <Cell key={i} k={`TP${i + 1} · ${(t.closeFraction * 100).toFixed(0)}%`} v={`${money(t.price)}  ${t.rMultiple.toFixed(1)}R`} tone="success" />
              ))}
            </div>
            <p className="mt-2 text-[10px] text-white/40">Stop basis: {o.plan.stopBasis}</p>
            {o.targets.length < 3 && (
              <p className="mt-1 text-[10px] text-amber/80">Only {o.targets.length} defensible targets — a third was not invented.</p>
            )}
          </Section>

          {o.sizing && (
            <Section title="Risk">
              <p className="text-white/70">{o.sizing.explanation}</p>
            </Section>
          )}
          {o.riskRefusal && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-danger">{o.riskRefusal}</div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={onWatch} disabled={busy !== null}
              className="min-h-[44px] flex-1 rounded border border-hairline bg-panel-hi px-3 text-xs font-semibold text-white/70 disabled:opacity-40">
              {watched ? "★ On watchlist" : "☆ Watch"}
            </button>
            <button onClick={onApprove} disabled={!canApprove || busy !== null}
              title={canApprove ? "Open a PAPER position" : "Only a confirmed, risk-passing setup can be approved"}
              className="min-h-[44px] flex-1 rounded border border-success/40 bg-success/15 px-3 text-xs font-bold text-success disabled:border-white/10 disabled:bg-white/5 disabled:text-white/30">
              {busy === `a:${o.id}` ? "Opening…" : "Approve paper trade"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PositionCard({ p }: { p: Position }) {
  const hit = new Set(p.fills.filter(f => f.reason.startsWith("tp")).map(f => f.reason));
  const total = (p.realisedPnl ?? 0) + (p.unrealised ?? 0);
  return (
    <div className="rounded-lg border border-hairline bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">{p.asset}</span>
        <Side d={p.direction} />
        <Badge state={p.state} />
        <span className={`ml-auto font-mono text-sm font-bold ${total >= 0 ? "text-success" : "text-danger"}`}>
          {total >= 0 ? "+" : ""}{money(total)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
        <Cell k="Entry" v={money(p.entryPrice)} />
        <Cell k="Mark" v={money(p.markPrice)} />
        <Cell k="Stop" v={money(p.stopPrice)} tone="danger" />
        <Cell k="Risk left" v={money(p.remainingRisk)} />
        <Cell k="Realised" v={money(p.realisedPnl)} />
        <Cell k="Unrealised" v={money(p.unrealised)} />
        <Cell k="Size left" v={`${((p.remainingQuantity / p.quantity) * 100).toFixed(0)}%`} />
      </div>
      <div className="mt-2 flex gap-1">
        {p.targets.map((t, i) => {
          const done = hit.has(`tp${i + 1}`);
          return (
            <div key={i} className={`flex-1 rounded px-2 py-1 text-center text-[10px] ${
              done ? "bg-success/20 text-success" : "bg-white/5 text-white/40"}`}>
              TP{i + 1} {done ? "✓" : money(t.price)}
            </div>
          );
        })}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-white/35">Thesis at entry</summary>
        <ul className="mt-1 space-y-0.5 text-[11px] text-white/60">
          {p.thesis.reasons.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      </details>
    </div>
  );
}

function Journal({ data, closed }: { data: Payload; closed: Position[] }) {
  const s = data.performance.paper;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-hairline bg-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/50">Paper trading</span>
          {!s.sufficient && (
            <span className="rounded border border-amber/30 bg-amber/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber">
              {s.trades} trades — too few to establish anything
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
          <Cell k="Trades" v={String(s.trades)} />
          <Cell k="Win rate" v={pct(s.winRatePct)} />
          <Cell k="Net P&L" v={money(s.netPnl)} tone={s.netPnl >= 0 ? "success" : "danger"} />
          <Cell k="Avg R" v={s.avgR == null ? "—" : s.avgR.toFixed(2)} />
          <Cell k="Avg winner" v={money(s.avgWinner)} />
          <Cell k="Avg loser" v={money(s.avgLoser)} />
          <Cell k="Profit factor" v={s.profitFactor == null ? "—" : s.profitFactor.toFixed(2)} />
          <Cell k="Max drawdown" v={money(s.maxDrawdown)} />
          <Cell k="Fees paid" v={money(s.totalFees)} />
          <Cell k="Breakeven WR" v={pct(s.breakevenWinRatePct)} />
        </div>
        {s.breakevenWinRatePct != null && s.winRatePct != null && (
          <p className={`mt-2 text-[11px] ${s.winRatePct >= s.breakevenWinRatePct ? "text-success" : "text-danger"}`}>
            {s.winRatePct >= s.breakevenWinRatePct
              ? `Above the ${pct(s.breakevenWinRatePct)} breakeven implied by the realised payoff ratio.`
              : `Below the ${pct(s.breakevenWinRatePct)} breakeven implied by the realised payoff ratio.`}
          </p>
        )}
        <p className="mt-2 text-[10px] text-white/35">
          Paper results only. Not combined with research or backtest figures — they are different kinds of claim.
        </p>
      </div>

      {Object.entries(data.performance.breakdowns).map(([name, rows]) => (
        rows.length > 0 && (
          <div key={name} className="rounded-lg border border-hairline bg-panel p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/50">
              {name.replace(/^by/, "By ").replace(/([A-Z])/g, " $1").trim()}
            </div>
            <div className="space-y-1">
              {rows.map(r => (
                <div key={r.label} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-white/70">{r.label}</span>
                  <span className="text-white/45">{r.trades}t</span>
                  <span className="w-12 text-right text-white/70">{pct(r.winRatePct, 0)}</span>
                  <span className={`w-16 text-right ${r.netPnl >= 0 ? "text-success" : "text-danger"}`}>{money(r.netPnl)}</span>
                  {!r.sufficient && <span className="text-[9px] uppercase text-amber/70">thin</span>}
                </div>
              ))}
            </div>
          </div>
        )
      ))}

      {closed.length === 0 && <Empty>No completed paper trades yet.</Empty>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{title}</div>
      {children}
    </div>
  );
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: "success" | "danger" }) {
  return (
    <div className="rounded bg-panel-hi px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-white/35">{k}</div>
      <div className={`mt-0.5 ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-white/85"}`}>{v}</div>
    </div>
  );
}
