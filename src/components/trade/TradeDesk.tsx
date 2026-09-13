"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import {
  DEFAULT_HOLD_SESSIONS,
  DeskForm,
  EMPTY_FORM,
  StageGate,
  capitalUsd,
  checkBody,
  checkGate,
  costBody,
  costGate,
  distanceBody,
  distanceGate,
  exitBody,
  exitGate,
  riskAtStop,
  stopWidthPct,
} from "@/lib/trade/desk";

/**
 * THE DESK — four endpoints behind one question, in the order they answer it.
 *
 * Request shaping and every gate live in src/lib/trade/desk.ts, where they
 * are tested. This file renders; it computes nothing a test cannot reach.
 *
 * ── Two rendering rules, both of them learned the hard way ────────────
 *
 * An unready stage says WHAT IT NEEDS. A panel greyed out with no reason is
 * indistinguishable from a broken one, and the endpoint behind it is fine.
 *
 * A refusal renders differently from a low number. `unknown` on a check is
 * amber and says so; it is not a quiet pass. The auditor's own doctrine is
 * that "no measurement exists" and "the measurement is comfortable" are
 * opposite facts, and this is the surface where they would otherwise
 * collapse into the same grey row.
 */

type Stage = "exit" | "check" | "cost" | "distance";

interface StageState {
  loading: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

const IDLE: StageState = { loading: false, data: null, error: null };

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function post(url: string, body: unknown): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const detail = [json.error, json.detail, json.hint].filter(Boolean).join(" — ");
      return { data: null, error: detail || `${url} returned ${res.status}` };
    }
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function TradeDesk() {
  const [form, setForm] = useState<DeskForm>(EMPTY_FORM);
  const [state, setState] = useState<Record<Stage, StageState>>({
    exit: IDLE,
    check: IDLE,
    cost: IDLE,
    distance: IDLE,
  });

  const gates: Record<Stage, StageGate> = {
    exit: exitGate(form),
    check: checkGate(form),
    cost: costGate(form),
    distance: distanceGate(form),
  };
  const anyReady = Object.values(gates).some((g) => g.ready);

  const set = (stage: Stage, patch: Partial<StageState>) =>
    setState((s) => ({ ...s, [stage]: { ...s[stage], ...patch } }));

  async function run() {
    const started: Stage[] = (["exit", "check", "cost", "distance"] as Stage[]).filter(
      (s) => gates[s].ready
    );
    setState((s) => {
      const next = { ...s };
      for (const stage of started) next[stage] = { loading: true, data: null, error: null };
      return next;
    });

    /*
     * Exit runs first and alone, because its reach curve supplies the target
     * rungs the distance table measures. That dependency is the reason these
     * four live on one page; running them all in parallel would make the
     * distance table answer about levels nobody proposed.
     */
    let rungs: number[] = [];
    if (gates.exit.ready) {
      const r = await post("/api/exit/design", exitBody(form));
      set("exit", { loading: false, ...r });
      const curve = (r.data?.reach_curve ?? []) as { targetPct: number; reachTimesTarget: number }[];
      rungs = [...curve]
        .sort((a, b) => b.reachTimesTarget - a.reachTimesTarget)
        .slice(0, 3)
        .map((c) => c.targetPct)
        .sort((a, b) => a - b);
    }

    await Promise.all([
      gates.check.ready
        ? post("/api/pretrade/check", checkBody(form)).then((r) => set("check", { loading: false, ...r }))
        : Promise.resolve(),
      gates.cost.ready
        ? post("/api/cost/express", costBody(form)).then((r) => set("cost", { loading: false, ...r }))
        : Promise.resolve(),
      gates.distance.ready
        ? post("/api/distance", distanceBody(form, rungs)).then((r) =>
            set("distance", { loading: false, ...r })
          )
        : Promise.resolve(),
    ]);
  }

  const width = stopWidthPct(form);
  const capital = capitalUsd(form);
  const risk = riskAtStop(form);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Field
              label="Symbol"
              value={form.symbol}
              onChange={(v) => setForm({ ...form, symbol: v })}
              placeholder="APLD"
            />
            <NumField
              label="Account value"
              value={form.accountValue}
              onChange={(v) => setForm({ ...form, accountValue: v })}
              placeholder="25000"
            />
            <NumField
              label="Shares"
              value={form.shares}
              onChange={(v) => setForm({ ...form, shares: v })}
              placeholder="400"
            />
            <NumField
              label="Entry"
              value={form.entry}
              onChange={(v) => setForm({ ...form, entry: v })}
              placeholder="12.50"
            />
            <NumField
              label="Stop"
              value={form.stop}
              onChange={(v) => setForm({ ...form, stop: v })}
              placeholder="11.25"
            />
            <NumField
              label="Hold (sessions)"
              value={form.holdSessions}
              onChange={(v) => setForm({ ...form, holdSessions: v ?? DEFAULT_HOLD_SESSIONS })}
              placeholder="20"
            />
          </div>

          {/*
            The three numbers the trader would otherwise compute in their head
            while typing, shown as they type. Nothing here is a verdict — the
            verdict costs a round trip and is deliberately below.
          */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-ink-muted">
            {capital !== null && (
              <span>
                <span className="text-ink">{usd(capital)}</span> deployed
              </span>
            )}
            {width !== null && (
              <span>
                <span className={width > 0 ? "text-ink" : "text-danger"}>{width.toFixed(1)}%</span>{" "}
                {width > 0 ? "stop" : "stop is ABOVE entry — short geometry, or a typo"}
              </span>
            )}
            {risk !== null && (
              <span>
                risking <span className="text-ink">{usd(risk.usd)}</span>
                {risk.pctOfAccount !== null && ` — ${risk.pctOfAccount.toFixed(2)}% of the account`}
              </span>
            )}
          </div>

          <button
            onClick={run}
            disabled={!anyReady}
            className="rounded-lg border border-cyan/40 bg-cyan/10 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-cyan transition-colors hover:bg-cyan/20 disabled:cursor-not-allowed disabled:border-hairline disabled:bg-transparent disabled:text-ink-faint"
          >
            Talk me out of it
          </button>
        </CardContent>
      </Card>

      <Stanza
        n={1}
        title="Where can the stop even go?"
        why="Answered from the symbol alone, before you pick a stop — so the number below is where you get one, not a mark on one you already chose."
        gate={gates.exit}
        state={state.exit}
      >
        {(d) => <ExitPanel data={d} />}
      </Stanza>

      <Stanza
        n={2}
        title="Every reason not to place it"
        why="Seven checks against the order as typed. Override a specific number if you disagree with it; never override the verdict."
        gate={gates.check}
        state={state.check}
      >
        {(d) => <CheckPanel data={d} />}
      </Stanza>

      <Stanza
        n={3}
        title="What it costs to express"
        why="The move the underlying must make before the trade beats doing nothing — entry cost and carry on one axis."
        gate={gates.cost}
        state={state.cost}
      >
        {(d) => <CostPanel data={d} />}
      </Stanza>

      <Stanza
        n={4}
        title="How often price actually touches these levels"
        why="Measured single-session touch rate for your stop and the rungs stage 1 proposed."
        gate={gates.distance}
        state={state.distance}
      >
        {(d) => <DistancePanel data={d} />}
      </Stanza>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-hairline bg-void/60 px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint/60 focus:border-cyan/50 focus:outline-none"
      />
    </label>
  );
}

function NumField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
}) {
  return (
    <Field
      label={label}
      value={value === null ? "" : String(value)}
      placeholder={placeholder}
      onChange={(raw) => {
        const t = raw.trim();
        const n = Number(t);
        onChange(t === "" || !Number.isFinite(n) ? null : n);
      }}
    />
  );
}

function Stanza({
  n,
  title,
  why,
  gate,
  state,
  children,
}: {
  n: number;
  title: string;
  why: string;
  gate: StageGate;
  state: StageState;
  children: (data: Record<string, unknown>) => React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-ink">
            <span className="font-mono text-[11px] text-ink-faint">{n}</span>
            {title}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{why}</p>
        </div>

        {!gate.ready && (
          <p className="text-[12px] text-ink-muted">
            Needs {gate.missing.join(", ")}.
          </p>
        )}
        {gate.ready && state.loading && <p className="text-[12px] text-ink-faint">Measuring…</p>}
        {gate.ready && state.error && (
          <p className="rounded-lg border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[12px] text-danger">
            {state.error}
          </p>
        )}
        {gate.ready && !state.loading && !state.error && !state.data && (
          <p className="text-[12px] text-ink-faint">Not run yet.</p>
        )}
        {state.data && children(state.data)}
      </CardContent>
    </Card>
  );
}

function ExitPanel({ data }: { data: Record<string, unknown> }) {
  const stop = data.stop as Record<string, unknown> | null;
  const curve = (data.reach_curve ?? []) as {
    targetPct: number;
    reachPct: number;
    independentN: number;
    reachTimesTarget: number;
  }[];
  const peak = data.reach_peak as { targetPct: number; caveat: string } | null;
  const definedRisk = data.defined_risk as Record<string, unknown> | null;

  /*
   * The note is the answer. It is written by stopViability as a sentence
   * naming the width, the survival rate and the floor it failed — putting a
   * bare "no_width_survives" above it would be the bare verdict the charter
   * forbids.
   */
  const survives = stop?.verdict === "viable" || stop?.narrowest_viable_pct != null;

  /*
   * When the stop refuses, the route composes defined_risk.rationale by
   * quoting the note in full and appending the prescription. Rendering both
   * printed the same forty words twice — so where the rationale already
   * contains the note, the rationale IS the paragraph and the note is
   * dropped. Checked by containment rather than by verdict, because the
   * duplication is a property of the strings, not of the branch that made
   * them, and a route that stops quoting should stop being deduplicated.
   */
  const note = stop?.note == null ? null : String(stop.note);
  const rationale = definedRisk?.rationale == null ? null : String(definedRisk.rationale);
  const quoted = note !== null && rationale !== null && rationale.includes(note);

  return (
    <div className="space-y-3">
      {note !== null && !quoted && (
        <p
          className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
            survives ? "border-hairline text-ink" : "border-amber/40 bg-amber/[0.06] text-ink"
          }`}
        >
          {note}
        </p>
      )}

      {rationale !== null && (
        <p
          className={
            quoted
              ? "rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-[12px] leading-relaxed text-ink"
              : "text-[12px] leading-relaxed text-ink-muted"
          }
        >
          {rationale}
        </p>
      )}

      {curve.length > 0 && (
        <div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                <th className="pb-1 font-medium">Target</th>
                <th className="pb-1 text-right font-medium">Reached</th>
                <th className="pb-1 text-right font-medium">Independent n</th>
                <th className="pb-1 text-right font-medium">Reach × size</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {curve.map((c) => (
                <tr
                  key={c.targetPct}
                  className={c.targetPct === peak?.targetPct ? "text-cyan" : "text-ink-muted"}
                >
                  <td className="py-0.5">+{c.targetPct}%</td>
                  <td className="py-0.5 text-right">{c.reachPct.toFixed(1)}%</td>
                  <td className="py-0.5 text-right">{c.independentN}</td>
                  <td className="py-0.5 text-right">{c.reachTimesTarget.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {peak?.caveat != null && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{peak.caveat}</p>
          )}
        </div>
      )}

      <p className="text-[11px] text-ink-faint">
        {String(data.sessions_measured ?? "—")} sessions measured, priced at{" "}
        {String(data.price_session ?? "unknown session")}.
      </p>
    </div>
  );
}

function CheckPanel({ data }: { data: Record<string, unknown> }) {
  const verdict = String(data.verdict ?? "");
  const checks = (data.checks ?? []) as { name: string; status: string; detail: string }[];

  const tone =
    verdict === "pass"
      ? "border-success/40 bg-success/[0.06] text-success"
      : verdict === "block"
        ? "border-danger/40 bg-danger/[0.06] text-danger"
        : "border-amber/40 bg-amber/[0.06] text-amber";

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border px-3 py-2 ${tone}`}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">{verdict}</span>
        <p className="mt-1 text-[12px] leading-relaxed text-ink">{String(data.summary ?? "")}</p>
      </div>

      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.name} className="flex gap-2.5 text-[12px] leading-relaxed">
            <span
              className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${
                c.status === "pass" ? "bg-success" : c.status === "fail" ? "bg-danger" : "bg-amber"
              }`}
              aria-hidden
            />
            <span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                {c.name.replace(/_/g, " ")}
                {c.status === "unknown" && " — not measured"}
              </span>
              <br />
              <span className={c.status === "pass" ? "text-ink-muted" : "text-ink"}>{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CostPanel({ data }: { data: Record<string, unknown> }) {
  const candidates = (data.candidates ?? []) as {
    label: string;
    breakeven_move_pct_all_in: number | null;
    refused: string | null;
  }[];

  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-ink">{String(data.interpretation ?? "")}</p>
      <ul className="space-y-1 font-mono text-[12px]">
        {candidates.map((c) => (
          <li key={c.label} className="flex justify-between gap-4">
            <span className="text-ink-muted">{c.label}</span>
            <span className={c.refused ? "text-amber" : "text-ink"}>
              {c.refused
                ? c.refused
                : c.breakeven_move_pct_all_in === null
                  ? "not priced"
                  : `${c.breakeven_move_pct_all_in.toFixed(4)}%`}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Equity only from this desk — an option leg needs a live quote and a theta, and this page
        holds neither. POST them to <span className="font-mono">/api/cost/express</span> to rank the
        contract against the shares on the same axis.
      </p>
    </div>
  );
}

function DistancePanel({ data }: { data: Record<string, unknown> }) {
  const rows = (data.rows ?? []) as {
    label?: string;
    level: number;
    direction: string;
    distance_pct: number;
    single_session_touch: { pct: number | null; n: number } | null;
  }[];

  return (
    <div className="space-y-2">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            <th className="pb-1 font-medium">Level</th>
            <th className="pb-1 text-right font-medium">Price</th>
            <th className="pb-1 text-right font-medium">Away</th>
            <th className="pb-1 text-right font-medium">Touched in one session</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r, i) => (
            <tr key={`${r.label}-${i}`} className="text-ink-muted">
              <td className="py-0.5">{r.label ?? r.direction}</td>
              <td className="py-0.5 text-right">{r.level}</td>
              <td className="py-0.5 text-right">{r.distance_pct.toFixed(1)}%</td>
              <td className="py-0.5 text-right text-ink">
                {r.single_session_touch?.pct == null
                  ? "not measured"
                  : `${r.single_session_touch.pct.toFixed(1)}% of ${r.single_session_touch.n}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] leading-relaxed text-ink-faint">{String(data.price_source ?? "")}</p>
    </div>
  );
}
