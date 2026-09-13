import type { IvRvScreenStanding } from "@/lib/research/ivRvScreen";

/**
 * THE KILL LINE, ON THE PAGE BEFORE THE DATA THAT DECIDES IT.
 *
 * A pre-declared reclassification criterion is only worth something if it is
 * published while the answer is still unknown. Sixty-two forward legs resolve
 * on 2026-09-22; this panel exists so the sentence that judges them is legible
 * beforehand and cannot be adjusted afterwards to fit whatever they say.
 *
 * ── The number this panel exists to correct ───────────────────────────
 *
 * The obvious reading of "62 rows resolve on the 22nd" is that a hundred-row
 * bar is nearly cleared. It is not. Those 62 rows share ONE observation date,
 * so they share one 21-session forward window: they are 62 measurements of the
 * same three weeks. Every observation collected so far spans 13 sessions end
 * to end, which is less than one non-overlapping window. So the row count can
 * pass while the evidence is a single draw.
 *
 * That is why `independentWindows` is rendered at the same weight as the row
 * count and described as the binding gate. A reader who takes only the
 * headline should come away knowing the test cannot run yet — and roughly how
 * far away it is, which is months rather than days.
 *
 * ── Why the statistics are absent rather than greyed out ──────────────
 *
 * There is no correlation to hide here: `evaluateIvRvScreen` returns
 * `result: null` until every gate is met and computes nothing early, not even
 * privately. A preliminary number shown faintly is still a number a reader
 * anchors on, and one that would be quoted back after the fact as though it
 * had been the test.
 */

function Count({
  label,
  value,
  need,
  note,
  met,
}: {
  label: string;
  value: number;
  need: number;
  note: string;
  met: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
      <span className="font-mono text-[18px] leading-none">
        <span className={met ? "text-success" : "text-amber"}>{value}</span>
        <span className="text-ink-faint"> / {need}</span>
      </span>
      <span className="max-w-[15rem] text-[10px] leading-snug text-ink-faint">{note}</span>
    </div>
  );
}

const HEADLINE: Record<IvRvScreenStanding["verdict"], { text: string; tone: string }> = {
  waiting: { text: "Declared, not yet evaluable", tone: "text-amber" },
  survives: { text: "The screen survived its own kill line", tone: "text-success" },
  "inside-noise": { text: "Inside its own noise floor — reclassified", tone: "text-danger" },
};

export function ScreenKillLine({ standing }: { standing: IvRvScreenStanding }) {
  const { declaration: d, result, gates } = standing;
  const head = HEADLINE[standing.verdict];
  const gate = (id: IvRvScreenStanding["gates"][number]["id"]) => gates.find((g) => g.id === id)!;
  const rows = gate("resolved-rows");
  const windows = gate("independent-windows");
  const cross = gate("sessions-with-statistic");

  return (
    <section className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className={`text-[13px] font-semibold uppercase tracking-[0.14em] ${head.tone}`}>
          The IV/RV screen — kill line
        </h2>
        <span className="font-mono text-[11px] text-ink-faint">
          declared {d.declaredOn} · {d.id}
        </span>
      </div>

      <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">{head.text}</p>

      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">
        {standing.reading}
      </p>

      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        <Count
          label="resolved rows"
          value={rows.have}
          need={rows.need}
          met={rows.met}
          note="necessary, and on its own worth very little — the first 62 land on one date"
        />
        <Count
          label="independent windows"
          value={windows.have}
          need={windows.need}
          met={windows.met}
          note="the binding gate: observation dates whose forward windows do not overlap"
        />
        <Count
          label="sessions wide enough"
          value={cross.have}
          need={cross.need}
          met={cross.met}
          note="sessions holding enough resolved names for a rank correlation to exist"
        />
      </div>

      {/*
        The best case, and labelled as one everywhere it appears. It assumes
        collection continues on every session from here; a night the collector
        misses pushes it further out, never nearer.
      */}
      {standing.result === null && standing.earliestEvaluableInSessions !== null && (
        <div className="mt-4 rounded-md border border-line/60 bg-surface/40 px-3 py-2.5">
          <p className="text-[12px] leading-relaxed text-ink">
            <span className="uppercase tracking-[0.12em] text-ink-faint">Earliest evaluable</span>{" "}
            <span className="font-mono text-ink">
              {standing.earliestEvaluableDate ?? `+${standing.earliestEvaluableInSessions} sessions`}
            </span>{" "}
            <span className="text-ink-muted">
              — {standing.earliestEvaluableInSessions} sessions from the latest reading, and a BEST
              CASE: it assumes an implied reading is recorded every session from here, and each
              missed session moves it further out.
            </span>
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            The 62 rows resolving on 2026-09-22 are one observation date, so they are one{" "}
            {d.horizonSessions}-session forward window however many rows they contain. Three more
            non-overlapping windows have to be collected and then matured before the declared test
            can be run at all. Projected on the same declared market calendar the resolution
            schedule uses.
          </p>
        </div>
      )}

      {result !== null && (
        <div className="mt-4 rounded-md border border-line/60 bg-surface/40 px-3 py-2.5">
          <p className="font-mono text-[12px] leading-relaxed text-ink">
            rho {result.correlation.toFixed(3)} · 95% [{result.lower.toFixed(3)},{" "}
            {result.upper.toFixed(3)}] · SE {result.bootstrapSe.toFixed(3)} · n_eff{" "}
            {result.effectiveN.toFixed(1)} of {standing.resolved}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            Block bootstrap over {standing.blockPeriods} date slices per block, so a block spans a
            whole forward window. Sensitivity, reported and explicitly without a vote:{" "}
            {result.sensitivity
              .map((s) => `${s.windowSessions}-session ${s.correlation.toFixed(3)}`)
              .join(", ")}
            . A result that needs the argmax of three correlated windows is the argmax, not the
            result.
          </p>
        </div>
      )}

      <details className="group mt-3">
        <summary className="cursor-pointer list-none text-[11px] uppercase tracking-[0.12em] text-ink-faint hover:text-ink-muted">
          <span className="group-open:hidden">The declaration ▸</span>
          <span className="hidden group-open:inline">The declaration ▾</span>
        </summary>
        <div className="mt-2 space-y-2 border-l border-line/60 pl-3 text-[11px] leading-relaxed text-ink-muted">
          <p>
            <span className="uppercase tracking-[0.12em] text-ink-faint">Claim</span> {d.statement}
          </p>
          <p>
            <span className="uppercase tracking-[0.12em] text-ink-faint">Statistic</span>{" "}
            {d.statistic}
          </p>
          <p>
            <span className="uppercase tracking-[0.12em] text-ink-faint">Kill criteria</span>{" "}
            {d.killCriteria}
          </p>
          <p className="text-ink-faint">
            Implied vol sits in the denominator of the screen and the numerator of the premium, so
            a high-IV name is pushed toward a low screen and a low premium at once. That shared
            term contributes POSITIVELY to the correlation and the predicted sign is negative — it
            biases the test against the hypothesis, never toward it.
          </p>
        </div>
      </details>
    </section>
  );
}
