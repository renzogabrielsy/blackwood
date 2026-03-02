'use client'

import { useMemo } from 'react'
import { useWidgetSize } from '@/components/widgets/chart/utils'
import type { SpecialChartData, ScatterGranularity } from './types'
import {
  niceScale,
  fieldLabel,
  fieldUnit,
  aggregateScatterData,
  buildColorMap,
} from './aggregation'

/* ===================================================
   ScatterRenderer — generic SVG scatter plot
   Reads field config from SpecialChartData.fields — zero domain knowledge.
   =================================================== */

export interface ScatterRendererProps {
  data: SpecialChartData
  xField: string
  yField: string
  colorBy: string
  granularity: ScatterGranularity
  quarterFilter: string[]
  showRefLines: boolean
}

export function ScatterRenderer({
  data,
  xField,
  yField,
  colorBy,
  granularity,
  quarterFilter,
  showRefLines,
}: ScatterRendererProps) {
  const { wTier, hTier } = useWidgetSize()

  /* ---- Aggregate points ---- */
  const displayPoints = useMemo(
    () => aggregateScatterData(data, xField, yField, colorBy, granularity, quarterFilter),
    [data, xField, yField, colorBy, granularity, quarterFilter],
  )

  /* ---- Color map for colorBy values ---- */
  const colorMap = useMemo(() => {
    const uniqueValues = Array.from(new Set(displayPoints.map(p => p.colorValue)))
    return buildColorMap(uniqueValues, colorBy)
  }, [displayPoints, colorBy])

  /* ---- Axis meta ---- */
  const xLabel = fieldLabel(data.fields, xField)
  const yLabel = fieldLabel(data.fields, yField)
  const xUnit = fieldUnit(data.fields, xField)
  const yUnit = fieldUnit(data.fields, yField)

  /* ---- SVG layout constants ---- */
  const W = 300, H = 180
  const PAD_L = 32, PAD_R = 12, PAD_T = 20, PAD_B = 24
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B

  const hasData = displayPoints.length > 0

  /* ---- Axis scales ---- */
  const xScale = hasData
    ? niceScale(
        Math.min(...displayPoints.map(p => p.x)),
        Math.max(...displayPoints.map(p => p.x)),
        6,
      )
    : { axisMin: 0, axisMax: 100, ticks: [0, 20, 40, 60, 80, 100] }

  const yScaleData = hasData
    ? niceScale(
        Math.min(...displayPoints.map(p => p.y)),
        Math.max(...displayPoints.map(p => p.y)),
        5,
      )
    : { axisMin: 0, axisMax: 100, ticks: [0, 25, 50, 75, 100] }

  const xRange = xScale.axisMax - xScale.axisMin
  const yRange = yScaleData.axisMax - yScaleData.axisMin

  /* ---- Reference lines (mean) ---- */
  const xRef = hasData
    ? displayPoints.reduce((s, p) => s + p.x, 0) / displayPoints.length
    : (xScale.axisMin + xScale.axisMax) / 2
  const yRef = hasData
    ? displayPoints.reduce((s, p) => s + p.y, 0) / displayPoints.length
    : (yScaleData.axisMin + yScaleData.axisMax) / 2

  /* ---- Coordinate helpers ---- */
  const xOf = (v: number) =>
    PAD_L + ((v - xScale.axisMin) / Math.max(xRange, 1e-10)) * chartW

  const yOf = (v: number) =>
    PAD_T + chartH - ((v - yScaleData.axisMin) / Math.max(yRange, 1e-10)) * chartH

  const xRefX = xOf(xRef)
  const yRefY = yOf(yRef)

  /* ---- Visibility flags ---- */
  const showQuadrantLabels = wTier === 'lg' || wTier === 'xl'
  const showRefLineLabels = wTier !== 'sm' && wTier !== 'xs'
  void hTier // reserved for future height-based logic

  /* ---- Tick formatting ---- */
  function formatTick(v: number): string {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
    if (Math.abs(v) >= 1) return v.toFixed(1)
    return v.toFixed(2)
  }

  function formatRefLabel(v: number, unit: string): string {
    const numStr = Math.abs(v) >= 1000
      ? `${(v / 1000).toFixed(1)}k`
      : Math.abs(v) >= 1
        ? v.toFixed(1)
        : v.toFixed(2)
    return unit ? `${unit}${numStr}` : `${yLabel} ${numStr}`
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      {/* X axis label */}
      <text
        x={PAD_L + chartW / 2}
        y={H - 3}
        fontSize="7"
        fill="#71717a"
        textAnchor="middle"
      >
        {xUnit ? `${xLabel} (${xUnit})` : xLabel}
      </text>

      {/* Y axis label */}
      <text
        x="6"
        y={PAD_T + chartH / 2}
        fontSize="7"
        fill="#71717a"
        textAnchor="middle"
        transform={`rotate(-90, 6, ${PAD_T + chartH / 2})`}
      >
        {yUnit ? `${yLabel} (${yUnit})` : yLabel}
      </text>

      {/* Reference lines (mean) */}
      {showRefLines && hasData && (
        <>
          <line
            x1={xRefX} y1={PAD_T}
            x2={xRefX} y2={PAD_T + chartH}
            stroke="#f59e0b" strokeWidth="0.6" strokeDasharray="3,3" opacity="0.5"
          />
          <line
            x1={PAD_L} y1={yRefY}
            x2={PAD_L + chartW} y2={yRefY}
            stroke="#f59e0b" strokeWidth="0.6" strokeDasharray="3,3" opacity="0.5"
          />
          {showRefLineLabels && (
            <>
              <text
                x={xRefX + 2} y={PAD_T + 8}
                fontSize="5.5" fill="#f59e0b" opacity="0.6"
              >
                {xUnit}{xRef.toFixed(1)}
              </text>
              <text
                x={PAD_L + chartW - 2} y={yRefY - 2}
                fontSize="5.5" fill="#f59e0b" opacity="0.6"
                textAnchor="end"
              >
                {formatRefLabel(yRef, yUnit)}
              </text>
            </>
          )}
        </>
      )}

      {/* Quadrant labels */}
      {showQuadrantLabels && hasData && (
        <>
          <text x={PAD_L + 6}          y={PAD_T + chartH - 6} fontSize="6" fill="#71717a" opacity="0.35">low {xLabel}</text>
          <text x={PAD_L + chartW - 6} y={PAD_T + chartH - 6} fontSize="6" fill="#71717a" opacity="0.35" textAnchor="end">high {xLabel}</text>
          <text x={PAD_L + 6}          y={PAD_T + 12}          fontSize="6" fill="#71717a" opacity="0.35">low {xLabel}</text>
          <text x={PAD_L + chartW - 6} y={PAD_T + 12}          fontSize="6" fill="#71717a" opacity="0.35" textAnchor="end">high {xLabel}</text>
        </>
      )}

      {/* X axis ticks */}
      {xScale.ticks.map(v => (
        <g key={v}>
          <line
            x1={xOf(v)} y1={PAD_T + chartH}
            x2={xOf(v)} y2={PAD_T + chartH + 3}
            stroke="#71717a" strokeWidth="0.5" opacity="0.5"
          />
          <text x={xOf(v)} y={PAD_T + chartH + 11} fontSize="6.5" fill="#71717a" textAnchor="middle">
            {formatTick(v)}
          </text>
        </g>
      ))}

      {/* Y axis ticks */}
      {yScaleData.ticks.map(v => (
        <g key={v}>
          <line
            x1={PAD_L - 3} y1={yOf(v)}
            x2={PAD_L} y2={yOf(v)}
            stroke="#71717a" strokeWidth="0.5" opacity="0.5"
          />
          <text x={PAD_L - 5} y={yOf(v) + 2.5} fontSize="6.5" fill="#71717a" textAnchor="end">
            {formatTick(v)}
          </text>
        </g>
      ))}

      {/* Chart area border */}
      <rect
        x={PAD_L} y={PAD_T}
        width={chartW} height={chartH}
        fill="none" stroke="#71717a" strokeWidth="0.3" opacity="0.3"
      />

      {/* Data points */}
      {displayPoints.map((p, i) => {
        const cx = xOf(Math.max(xScale.axisMin, Math.min(xScale.axisMax, p.x)))
        const cy = yOf(Math.max(yScaleData.axisMin, Math.min(yScaleData.axisMax, p.y)))
        const color = colorMap.get(p.colorValue) ?? '#71717a'
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r="3.5"
            fill={color}
            opacity="0.75"
            stroke="white"
            strokeWidth="0.5"
          >
            <title>
              {p.label} — {xLabel}: {xUnit}{p.x.toFixed(2)} / {yLabel}: {yUnit}{p.y.toFixed(2)}
            </title>
          </circle>
        )
      })}

      {/* Empty state */}
      {!hasData && (
        <text
          x={PAD_L + chartW / 2}
          y={PAD_T + chartH / 2}
          fontSize="8"
          fill="#71717a"
          textAnchor="middle"
          dominantBaseline="middle"
          opacity="0.5"
        >
          No data
        </text>
      )}
    </svg>
  )
}
