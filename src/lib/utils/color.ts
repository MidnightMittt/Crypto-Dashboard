function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Maps `value` in [min, max] onto a multi-stop color gradient, returning
 * an interpolated CSS rgb() string. Used by the funding heat map and any
 * other cell/track that needs a smooth red→gray→green style scale.
 */
export function lerpColorScale(value: number, min: number, max: number, stops: string[]): string {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const segments = stops.length - 1;
  const segPct = pct * segments;
  const idx = Math.min(segments - 1, Math.floor(segPct));
  const localT = segPct - idx;
  const c1 = hexToRgb(stops[idx]);
  const c2 = hexToRgb(stops[idx + 1]);
  const mixed: [number, number, number] = [
    Math.round(lerp(c1[0], c2[0], localT)),
    Math.round(lerp(c1[1], c2[1], localT)),
    Math.round(lerp(c1[2], c2[2], localT)),
  ];
  return rgbToCss(mixed);
}
