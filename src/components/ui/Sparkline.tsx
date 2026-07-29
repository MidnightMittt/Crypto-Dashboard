"use client";

import * as React from "react";

/**
 * Minimal sparkline.
 *
 * WHY NOT RECHARTS: this replaced a `<ResponsiveContainer><LineChart>` that
 * pulled the whole of recharts — plus its d3 dependencies — into the main
 * bundle for a single 40px-tall polyline with no axes, tooltip, legend, or
 * interaction. Recharts also mounts a ResizeObserver per instance, and the
 * exchange grid renders one card per venue, so that was ~20 observers and
 * ~20 chart reconciliation trees for decoration.
 *
 * A polyline needs none of that. The viewBox does the scaling, so this stays
 * responsive without measuring anything.
 */
export function Sparkline({
  values,
  stroke,
  className,
}: {
  values: number[];
  stroke: string;
  className?: string;
}) {
  const points = React.useMemo(() => {
    if (values.length < 2) return "";

    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series has zero range; without this guard every point divides
    // by zero and the line vanishes. Draw it down the middle instead.
    const range = max - min || 1;
    const stepX = 100 / (values.length - 1);

    return values
      .map((v, i) => {
        const x = i * stepX;
        // SVG y grows downward, so invert to put high values at the top.
        const y = 100 - ((v - min) / range) * 100;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [values]);

  if (!points) return null;

  return (
    <svg
      viewBox="0 0 100 100"
      // The viewBox is square but the box is wide; without `none` the line
      // would be letterboxed instead of filling the card.
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        // Scaled by preserveAspectRatio="none", so this is set in user units
        // and vector-effect keeps it visually constant.
        strokeWidth={1.75}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
