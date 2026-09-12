import type { ResolutionSchedule as Schedule } from "@/lib/research/ivRvSchedule";

/**
 * A COLLECTOR THAT CANNOT YET CONCLUDE ANYTHING, SAYING SO.
 *
 * This panel exists because `resolved: 0` was true, correct, and invisible.
 * The IV/RV work has been running nightly since 2026-09-10 and nothing on the
 * site said whether that was a job quietly failing or a horizon that had not
 * elapsed. Those need opposite responses and looked identical.
 *
 * The design rule here is the one the charter asks for and that a stats panel
 * usually breaks: the CONCLUSION is the largest thing on screen and the counts
 * are underneath it. A reader who takes only the headline should still come
 * away with the right action, which in this case is "do not trade this yet".
 *
 * The three counts are deliberately not two. `pending` is a sample still
 * arriving; `lost` is a sample that never will. Pooling them as "open" would
 * make the evidence look closer than it is.
 */

function Count({
  label,
  value,
  note,
  tone = "text-ink",
}: {
  label: string;
  value: number;
  note: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
      <span className={`font-mono text-[18px] leading-none ${tone}`}>{value}</span>
      <span className="text-[10px] leading-snug text-ink-faint">{note}</span>
    </div>
  );
}

export function ResolutionSchedule({
  schedule,
  reading,
  symbols,
  observationSessions,
  firstObservation,
  lastObservation,
}: {
  schedule: Schedule;
  reading: string;
  symbols: number;
  observationSessions: number;
  firstObservation: string | null;
  lastObservation: string | null;
}) {
  const s = schedule;
  const untested = s.resolved === 0;

  return (
    <section className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-amber">
          Implied against realized — collecting
        </h2>
        <span className="font-mono text-[11px] text-ink-faint">
          n={s.joined}
        </span>
      </div>

      <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">
        {untested
          ? `No forward leg has resolved. This measures nothing yet.`
          : `${s.resolved} of ${s.joined} forward legs have resolved.`}
      </p>

      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">{reading}</p>

      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        <Count
          label="resolved"
          value={s.resolved}
          tone={s.resolved > 0 ? "text-success" : "text-ink-faint"}
          note="forward leg landed — the only rows that can support a conclusion"
        />
        <Count
          label="pending"
          value={s.pending}
          tone="text-amber"
          note="waiting on time; will resolve when the bars reach"
        />
        <Count
          label="lost to gaps"
          value={s.unresolvable}
          tone={s.unresolvable > 0 ? "text-danger" : "text-ink-faint"}
          note="window elapsed with a hole in it — these never resolve"
        />
        <Count
          label="joined"
          value={s.joined}
          note={`${symbols} symbols over ${observationSessions} recorded sessions`}
        />
      </div>

      {s.sessionsUntilNextResolution !== null && (
        <div className="mt-4 rounded-md border border-line/60 bg-surface/40 px-3 py-2.5">
          <p className="text-[12px] leading-relaxed text-ink">
            <span className="uppercase tracking-[0.12em] text-ink-faint">
              {untested ? "First resolutions expected" : "Next resolutions expected"}
            </span>{" "}
            {s.projectedNextResolution ? (
              <>
                <span className="font-mono text-ink">{s.projectedNextResolution}</span>{" "}
                <span className="text-ink-muted">
                  — {s.nextResolutionCount} observation
                  {s.nextResolutionCount === 1 ? "" : "s"}, {s.sessionsUntilNextResolution} session
                  {s.sessionsUntilNextResolution === 1 ? "" : "s"} away.
                </span>
              </>
            ) : (
              <span className="text-ink-muted">
                {s.sessionsUntilNextResolution} sessions away. No calendar date:{" "}
                {s.projectionNote}.
              </span>
            )}
          </p>
          {/*
            Saying the date is projected, and from what. A resolution date is a
            claim about a day that has not happened, and the only thing making
            it more than a guess is a declared holiday table reconciled against
            the panel's own observed calendar.
          */}
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            Projected forward from {s.projectedFrom} on the declared US market calendar, which the
            suite reconciles against the panel&rsquo;s observed sessions. Each observation resolves
            exactly {s.horizonSessions} sessions after it was taken — a fixed horizon, no barrier
            and no early close, so no arm of the sample can resolve faster than another and enter
            the record first.
          </p>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Implied readings recorded {firstObservation ?? "—"} to {lastObservation ?? "—"}. Resolutions
        arrive in cohorts because the readings do, and {s.nextResolutionCount} rows landing on one
        day are nowhere near {s.nextResolutionCount} independent observations — implied vol across
        this universe moves largely as one factor. Nothing here is ranked, thresholded or screened
        on, and it will not be until the resolved count can be judged against the panel&rsquo;s
        effective breadth rather than its row count.
      </p>
    </section>
  );
}
