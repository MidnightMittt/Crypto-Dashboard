"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ARC_START_DEG, describeArc, polarToCartesian, valueToAngle } from "@/lib/utils/gaugeMath";

export interface GaugeBaseProps {
  value: number;
  min: number;
  max: number;
  /** Left-to-right gradient stops, e.g. [danger, amber-dim, ink-muted, success-dim, success]. */
  colors: string[];
  size?: number;
  gaugeId: string;
  centerValue: string;
  centerLabel: string;
  compact?: boolean;
  /** True when the underlying metric is unavailable: needle greys out. */
  dimmed?: boolean;
}

/**
 * Speedometer-style needle outline, drawn pointing up from (cx, cy).
 *
 *        /\        <- sharp tip
 *       /  \
 *      |    |      <- blade, tapering
 *      |    |
 *   ===|====|===   <- hub sits here
 *       \__/       <- counterweight tail
 */
function needlePath(cx: number, cy: number, length: number): string {
  const halfBase = 4.2; // blade width where it meets the hub
  const tailLen = 17;
  const halfTail = 2.6;
  return [
    `M ${cx - halfBase} ${cy}`,
    `L ${cx} ${cy - length}`, // tip
    `L ${cx + halfBase} ${cy}`,
    `L ${cx + halfTail} ${cy + tailLen}`,
    `Q ${cx} ${cy + tailLen + 3} ${cx - halfTail} ${cy + tailLen}`,
    "Z",
  ].join(" ");
}

const CX = 130;
const CY = 138;
const R = 98;
const TRACK_WIDTH = 16;

function GaugeBaseImpl({
  value,
  min,
  max,
  colors,
  size = 260,
  gaugeId,
  centerValue,
  centerLabel,
  compact = false,
  dimmed = false,
}: GaugeBaseProps) {
  const reduceMotion = useReducedMotion();
  const angle = valueToAngle(value, min, max);
  const trackPath = describeArc(CX, CY, R, ARC_START_DEG, ARC_START_DEG + 270);
  const gradientId = `gauge-gradient-${gaugeId}`;
  const needleGradId = `gauge-needle-${gaugeId}`;

  // Tip stops just inside the coloured track — a real gauge needle nearly
  // touches the dial rather than floating short of it.
  const needleLen = R - TRACK_WIDTH / 2 - 9;
  const tickAngles = [0, 0.25, 0.5, 0.75, 1].map((p) => ARC_START_DEG + p * 270);

  return (
    <div className="relative flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 260 190" width={size} height={(size * 190) / 260} className="overflow-visible">
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={CX - R} y1={CY} x2={CX + R} y2={CY}>
            {colors.map((c, i) => (
              <stop key={c + i} offset={`${(i / (colors.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
          {/* Vertical gradient gives the blade a subtle metallic falloff
              from bright at the tip to dimmer near the hub. */}
          <linearGradient id={needleGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={dimmed ? "#4A515C" : "#FFFFFF"} />
            <stop offset="55%" stopColor={dimmed ? "#3A3F47" : "#E8EDF2"} />
            <stop offset="100%" stopColor={dimmed ? "#2A2F38" : "#9AA3B2"} />
          </linearGradient>
        </defs>

        {/* background track */}
        <path
          d={trackPath}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={TRACK_WIDTH}
          strokeLinecap="round"
        />
        {/* gradient value track */}
        <path
          d={trackPath}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={TRACK_WIDTH}
          strokeLinecap="round"
          opacity={dimmed ? 0.15 : 0.92}
        />

        {/* tick marks */}
        {tickAngles.map((a, i) => {
          const inner = polarToCartesian(CX, CY, R - TRACK_WIDTH / 2 - 12, a);
          const outer = polarToCartesian(CX, CY, R - TRACK_WIDTH / 2 - 4, a);
          return (
            <line
              key={i}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1.5}
            />
          );
        })}

        {/*
          Needle, shaped like an automotive speedometer pointer: a long
          blade tapering to a sharp tip, with a short counterweight tail
          behind the hub. The tail is what makes a real gauge needle read
          as balanced rather than as a floating stick.

          Drawn pointing straight up (12 o'clock) and rotated into place,
          which matches the angle convention in gaugeMath.ts.
        */}
        <motion.g
          style={{ originX: `${CX}px`, originY: `${CY}px`, willChange: "transform" }}
          initial={false}
          animate={{ rotate: angle }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : // Was stiffness 55 / damping 11, which is underdamped: the
                // needle oscillated for well over a second after every poll.
                // With four gauges on screen re-animating every 15s that was
                // near-continuous repainting. Critically damped and stiffer
                // settles in roughly a third of the time.
                { type: "spring", stiffness: 120, damping: 18, mass: 0.8 }
          }
        >
          {/* soft shadow cast slightly down-right, sells the raised look */}
          <path
            d={needlePath(CX, CY + 1.5, needleLen)}
            fill="rgba(0,0,0,0.45)"
            opacity={dimmed ? 0.2 : 0.6}
          />
          {/*
            Glow. This used to be an feGaussianBlur filter, which the browser
            cannot GPU-composite: it re-rasterized the needle on every frame
            of the rotation, for every gauge at once.

            A wider, low-opacity copy of the same path is plain geometry —
            it transforms with the group for free and reads almost identically
            at this size.
          */}
          {!dimmed && (
            <path
              d={needlePath(CX, CY, needleLen)}
              fill="none"
              stroke="#E8EDF2"
              strokeWidth={3}
              strokeLinejoin="round"
              opacity={0.18}
            />
          )}
          <path d={needlePath(CX, CY, needleLen)} fill={`url(#${needleGradId})`} />
          {/* highlight along the blade's leading edge */}
          <path
            d={`M ${CX - 1} ${CY - 6} L ${CX} ${CY - needleLen + 2} L ${CX + 0.6} ${CY - 6} Z`}
            fill={dimmed ? "#4A515C" : "#FFFFFF"}
            opacity={dimmed ? 0.3 : 0.55}
          />
        </motion.g>

        {/* hub: outer bezel, body, and a small centre cap */}
        <circle cx={CX} cy={CY} r={10} fill="#0A0D12" opacity={0.9} />
        <circle
          cx={CX}
          cy={CY}
          r={8}
          fill={dimmed ? "#2A2F38" : "#E8EDF2"}
          stroke="rgba(0,0,0,0.35)"
          strokeWidth={1}
        />
        <circle cx={CX} cy={CY} r={4} fill="#0A0D12" />
        <circle cx={CX} cy={CY} r={1.6} fill={dimmed ? "#3A3F47" : "#8890A0"} />
      </svg>

      <div className={compact ? "-mt-6 text-center" : "-mt-8 text-center"}>
        <div className={`font-mono font-semibold ${compact ? "text-2xl" : "text-4xl"} ${dimmed ? "text-ink-faint" : "text-ink"}`}>
          {centerValue}
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-widest text-ink-muted">{centerLabel}</div>
      </div>
    </div>
  );
}

/**
 * Memoized because the dashboard re-renders on every 15s poll with a fresh
 * payload object, which previously re-rendered all four gauges — and
 * restarted their needle animations — even when the underlying numbers were
 * byte-identical. Props here are all primitives except `colors`, which is a
 * module-level constant in each gauge, so the default shallow compare is
 * sufficient.
 */
export const GaugeBase = React.memo(GaugeBaseImpl);
