'use client';

/**
 * Inline SVG primitives for the LEDGER demo (demo2).
 *
 * These are deliberately tiny, dependency-free SVG cells meant to live INSIDE
 * a dense Excel-Standard table row (~120×28). No recharts — this concept is
 * intentionally chart-library-free so it reads as a "spreadsheet with inline
 * micro-viz", visually distinct from the chart-based demos.
 *
 * All color comes from the supplier accent (passed in) or semantic tokens, so
 * the strip is theme-aware in light + dark.
 */

const W = 120;
const H = 28;
const PAD_X = 2;
const PAD_Y = 4;

/* ------------------------------------------------------------------ */
/* Price sparkline — connected line, null-gap aware                    */
/* ------------------------------------------------------------------ */

export interface SparklineProps {
  /** 12-point series; null = no delivery that month (gap, not zero). */
  data: (number | null)[];
  /** Supplier accent color for the line + end dot. */
  color: string;
  width?: number;
  height?: number;
  /** ARIA label for screen readers. */
  label?: string;
}

export function Sparkline({
  data,
  color,
  width = W,
  height = H,
  label,
}: SparklineProps) {
  const present = data
    .map((v, i) => ({ v, i }))
    .filter((d): d is { v: number; i: number } => d.v != null);

  if (present.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label ?? 'no price data'}
        className="overflow-visible"
      >
        <line
          x1={PAD_X}
          y1={height / 2}
          x2={width - PAD_X}
          y2={height / 2}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const values = present.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const innerW = width - PAD_X * 2;
  const innerH = height - PAD_Y * 2;

  const xFor = (i: number) =>
    PAD_X + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const yFor = (v: number) => PAD_Y + innerH - ((v - min) / span) * innerH;

  // Build path segments, breaking the line wherever a null appears (gaps).
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v == null) {
      if (current) {
        segments.push(current);
        current = '';
      }
      continue;
    }
    const cmd = current ? 'L' : 'M';
    current += `${current ? ' ' : ''}${cmd}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`;
  }
  if (current) segments.push(current);

  const last = present[present.length - 1];
  const lastUp = present.length >= 2 && last.v >= present[present.length - 2].v;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? 'price trend'}
      className="overflow-visible"
    >
      {/* faint baseline at the min for reference */}
      <line
        x1={PAD_X}
        y1={height - PAD_Y}
        x2={width - PAD_X}
        y2={height - PAD_Y}
        className="stroke-border/50"
        strokeWidth={1}
      />
      {segments.map((d, idx) => (
        <path
          key={idx}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {/* dashed connector across gaps so the eye still follows the trend */}
      {present.map((p, idx) => {
        if (idx === 0) return null;
        const prev = present[idx - 1];
        if (p.i - prev.i === 1) return null; // contiguous → already drawn
        return (
          <line
            key={`gap-${idx}`}
            x1={xFor(prev.i)}
            y1={yFor(prev.v)}
            x2={xFor(p.i)}
            y2={yFor(p.v)}
            stroke={color}
            strokeWidth={1}
            strokeDasharray="1.5 2"
            strokeOpacity={0.4}
          />
        );
      })}
      {/* end dot, tinted by last-move direction */}
      <circle
        cx={xFor(last.i)}
        cy={yFor(last.v)}
        r={2}
        fill={color}
        className={lastUp ? '' : ''}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Volume mini-bars — 12-bar strip                                     */
/* ------------------------------------------------------------------ */

export interface MiniBarsProps {
  /** 12-point volume series (kg). 0 = no delivery → empty slot. */
  data: number[];
  color: string;
  width?: number;
  height?: number;
  label?: string;
}

export function MiniBars({
  data,
  color,
  width = W,
  height = H,
  label,
}: MiniBarsProps) {
  const max = Math.max(...data, 1);
  const innerH = height - PAD_Y;
  const gap = 1.5;
  const slot = (width - PAD_X * 2) / data.length;
  const barW = Math.max(1.5, slot - gap);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? 'monthly volume'}
      className="overflow-visible"
    >
      {data.map((v, i) => {
        const x = PAD_X + i * slot + (slot - barW) / 2;
        if (v <= 0) {
          // empty month — faint baseline tick so gaps are visible
          return (
            <rect
              key={i}
              x={x}
              y={height - 1.5}
              width={barW}
              height={1.5}
              rx={0.5}
              className="fill-border"
            />
          );
        }
        const h = Math.max(1.5, (v / max) * innerH);
        return (
          <rect
            key={i}
            x={x}
            y={height - h}
            width={barW}
            height={h}
            rx={0.75}
            fill={color}
            fillOpacity={0.85}
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Share bar — thin horizontal proportion bar (volumeShare 0..1)       */
/* ------------------------------------------------------------------ */

export interface ShareBarProps {
  /** 0..1 share of total portfolio volume. */
  value: number;
  color: string;
  width?: number;
}

export function ShareBar({ value, color, width = 72 }: ShareBarProps) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className="relative h-1.5 overflow-hidden rounded-full bg-muted"
      style={{ width }}
      role="img"
      aria-label={`${(pct * 100).toFixed(1)}% of total volume`}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-150"
        style={{ width: `${pct * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}
