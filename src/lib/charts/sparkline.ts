/**
 * SPARKLINE GEOMETRY — Roadmap Phase 2, item 5.
 *
 * The roadmap's stated purpose for these is blunt: kill the 90-second
 * TradingView exit. A reader who has to leave to see what a claim looks like
 * usually does not come back, and while they are away the page's reasoning is
 * competing with a chart that has none.
 *
 * ── Why the geometry is a pure module with tests ──────────────────────
 *
 * A sparkline is a claim about data drawn as a picture, and pictures are the
 * easiest place in this codebase to lie without anyone noticing. A misplaced
 * baseline, an autoscaled axis that exaggerates a 0.3% drift into a cliff, or
 * a shaded window off by five sessions all render as something plausible.
 * Nothing downstream can catch it, because the output is coordinates.
 *
 * So the mapping from values to coordinates is separated from the drawing and
 * pinned to hand-computable cases.
 *
 * ── The two honesty rules encoded here ────────────────────────────────
 *
 * 1. NEVER autoscale to a flat series. A series that moved 0.02% would
 *    otherwise fill the full height and read as violent. `flat` reports it so
 *    the caller can render a straight line rather than manufactured drama.
 *
 * 2. The measurement window is a RANGE, not a mark. Every claim on this page
 *    is measured over a window — "the last 60 sessions", "its own 200-session
 *    average" — and a chart that shades the whole series implies the number
 *    came from all of it.
 */

export interface SparklineGeometry {
  /** `points` for an SVG <polyline>, in the coordinate space given. */
  points: string;
  /** X of the first shaded column, and its width. Null when no window was asked for. */
  window: { x: number; width: number } | null;
  /** Where the last value sits, for the end dot. */
  last: { x: number; y: number };
  /**
   * True when the series has no meaningful range and was drawn on a
   * mid-height baseline instead of being stretched to fill the box.
   */
  flat: boolean;
  /** The extremes actually used for scaling, so a caller can label the axis. */
  min: number;
  max: number;
}

export interface SparklineOptions {
  width: number;
  height: number;
  /**
   * How many trailing values the claim was measured over. Shaded. Undefined
   * means the claim is about the whole series and nothing is shaded — which
   * is different from a window covering everything, and says so.
   */
  windowSessions?: number;
  /**
   * Sessions to EXCLUDE at the right-hand edge before the window starts.
   *
   * Exists because the platform's one validated equity signal is measured
   * over twelve months EXCLUDING the most recent month — the skip that
   * removes short-horizon reversal, which points the other way. Prose can
   * state that and readers still picture a plain trailing year. Shading the
   * real window, gap and all, makes the construction visible in the one
   * place it matters.
   */
  windowOffset?: number;
  /** Padding so the stroke and the end dot are not clipped at the edges. */
  padY?: number;
}

/**
 * Below this relative range a series is treated as flat. 0.1% of the mean is
 * beneath the resolution of a 32px-tall chart — drawing it scaled would show
 * a shape that no eye could distinguish from noise but every eye would read
 * as a trend.
 */
const FLAT_THRESHOLD = 0.001;

export function sparklineGeometry(
  values: readonly number[],
  opts: SparklineOptions
): SparklineGeometry | null {
  const { width, height, windowSessions, windowOffset = 0, padY = 2 } = opts;

  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length < 2 || width <= 0 || height <= 0) return null;

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const range = max - min;

  // See FLAT_THRESHOLD. A zero mean (a spread series crossing zero) cannot be
  // judged in relative terms, so it falls back to an absolute zero-range test.
  const flat = mean !== 0 ? range / Math.abs(mean) < FLAT_THRESHOLD : range === 0;

  const top = padY;
  const usableHeight = Math.max(0, height - padY * 2);
  const stepX = usable.length > 1 ? width / (usable.length - 1) : 0;

  const yOf = (v: number) => {
    if (flat || range === 0) return top + usableHeight / 2;
    // SVG y grows downward, so a HIGH value must map to a LOW y. Getting this
    // backwards draws every chart upside down and still looks like a chart.
    return top + usableHeight - ((v - min) / range) * usableHeight;
  };

  const coords = usable.map((v, i) => ({ x: i * stepX, y: yOf(v) }));
  const points = coords.map((c) => `${round(c.x)},${round(c.y)}`).join(" ");

  let window: SparklineGeometry["window"] = null;
  if (windowSessions !== undefined && windowSessions > 0) {
    // The window ends `windowOffset` sessions before the right edge, and is
    // clamped at both ends: one longer than the series shades the series
    // rather than extending past its left edge and implying data that is not
    // there, and an offset past the left edge shades nothing.
    const endIndex = Math.max(0, usable.length - 1 - Math.max(0, windowOffset));
    const startIndex = Math.max(0, endIndex - Math.min(windowSessions, usable.length) + 1);
    const x = startIndex * stepX;
    const right = endIndex * stepX;
    window = right > x ? { x: round(x), width: round(right - x) } : null;
  }

  return {
    points,
    window,
    last: { x: round(coords[coords.length - 1].x), y: round(coords[coords.length - 1].y) },
    flat,
    min,
    max,
  };
}

/** Two decimals is finer than any display pixel and keeps the path string short. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reduces a long series to at most `target` points for drawing.
 *
 * STRIDED, not averaged. A sparkline beside a claim about closes must be made
 * of closes — averaging buckets would smooth away the spikes a reader is
 * looking at the chart to see, and the smoothed line would still be labelled
 * as price. The last value is always kept, because the right-hand end of the
 * chart is the only point a reader will try to reconcile against the quote
 * printed next to it.
 */
export function downsample(values: readonly number[], target: number): number[] {
  if (target < 2 || values.length <= target) return [...values];

  const stride = (values.length - 1) / (target - 1);
  const out: number[] = [];
  for (let i = 0; i < target - 1; i++) out.push(values[Math.round(i * stride)]);
  out.push(values[values.length - 1]);
  return out;
}
