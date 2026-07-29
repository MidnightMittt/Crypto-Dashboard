/**
 * Shared math for the four speedometer-style gauges. Every gauge sweeps
 * the same 270° arc — starting bottom-left (the minimum value), running
 * clockwise up over the top and back down to bottom-right (the maximum
 * value), leaving a 90° gap at the bottom. This is the classic
 * Fear & Greed Index / automotive-speedometer layout.
 *
 * Angle convention used throughout this file: 0° = straight up (12
 * o'clock), increasing clockwise — so 90° = right (3 o'clock), 180° =
 * down (6 o'clock), 270° = left (9 o'clock). This matches how a clock
 * face reads, which keeps the trig easy to reason about.
 */

export const ARC_START_DEG = 225; // bottom-left — minimum value
export const ARC_SWEEP_DEG = 270;
export const ARC_END_DEG = ARC_START_DEG + ARC_SWEEP_DEG; // 495 (== 135°, bottom-right)

export function valueToAngle(value: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  const pct = max === min ? 0 : (clamped - min) / (max - min);
  return ARC_START_DEG + pct * ARC_SWEEP_DEG;
}

export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * SVG arc path from `startDeg` to `endDeg` (startDeg must be <= endDeg).
 * Always sweeps clockwise, matching the gauge's angle convention.
 */
export function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = polarToCartesian(cx, cy, r, startDeg);
  const end = polarToCartesian(cx, cy, r, endDeg);
  const largeArcFlag = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

/** Builds N evenly spaced sub-arcs across the gauge sweep for gradient color bands. */
export function buildColorBands(colors: string[]): Array<{ start: number; end: number; color: string }> {
  const step = ARC_SWEEP_DEG / colors.length;
  return colors.map((color, i) => ({
    start: ARC_START_DEG + i * step,
    end: ARC_START_DEG + (i + 1) * step,
    color,
  }));
}
