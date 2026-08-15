import { sparklineGeometry } from "@/lib/charts/sparkline";

/**
 * A claim's own chart, beside the claim.
 *
 * Pure SVG with no client state, so it server-renders inside the dossier and
 * costs nothing at runtime. All arithmetic lives in `sparklineGeometry`; this
 * file only draws, which is why the tests for it are not React tests.
 *
 * ── What the shading means, and why it is not decoration ──────────────
 *
 * The shaded band is the SLICE THAT PRODUCED THE NUMBER printed next to it.
 * On the momentum panel that is twelve months ending one month ago, and the
 * unshaded strip at the right edge is the skipped month — a construction the
 * prose has to spend three sentences on and the picture explains instantly.
 *
 * A chart with no shading is a chart making no claim about a window, and
 * renders that way rather than shading everything.
 */
export function Sparkline({
  values,
  windowSessions,
  windowOffset,
  label,
  width = 220,
  height = 40,
  tone = "neutral",
}: {
  values: readonly number[];
  windowSessions?: number;
  windowOffset?: number;
  /** Read by screen readers, which cannot see any of this. Always required. */
  label: string;
  width?: number;
  height?: number;
  tone?: "up" | "down" | "neutral";
}) {
  const g = sparklineGeometry(values, { width, height, windowSessions, windowOffset });
  if (!g) return null;

  /*
   * currentColor, set by a Tailwind text class on the <svg>.
   *
   * The first version used `var(--color-success)`. Those custom properties do
   * not exist — this project's palette is plain hex in tailwind.config.ts —
   * so the stroke resolved to nothing and the line silently did not paint.
   * The SVG mounted, the shaded band and the end dot drew, and the chart was
   * empty. Nothing failed; it just was not there.
   *
   * Going through the theme means the colours cannot drift from the rest of
   * the page, and a missing token would fail at build rather than at a glance.
   */
  const toneClass =
    tone === "up" ? "text-success" : tone === "down" ? "text-danger" : "text-ink-muted";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={`block overflow-visible ${toneClass}`}
    >
      {g.window && (
        <rect
          x={g.window.x}
          y={0}
          width={g.window.width}
          height={height}
          className="fill-cyan/10"
        />
      )}
      <polyline
        points={g.points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        // The line must not thicken when the viewBox is stretched to fit.
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={g.last.x} cy={g.last.y} r={2} fill="currentColor" />
    </svg>
  );
}
