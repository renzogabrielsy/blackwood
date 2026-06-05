'use client'

import { useMemo } from 'react'
import { useWidgetSize } from '@/components/widgets/chart/utils'
import type { SpecialChartData } from './types'
import { aggregatePieData, GENERIC_PALETTE, fieldLabel, fieldUnit } from './aggregation'

/* ===================================================
   PieRenderer — SVG pie/donut chart
   Generic — zero domain knowledge.
   =================================================== */

export interface PieRendererProps {
  data: SpecialChartData
  valueField: string
  groupBy: string
  aggregation: 'sum' | 'avg' | 'count'
  quarterFilter: string[]
  donut?: boolean
}

const CX = 100
const CY = 100
const R = 78
const R_INNER = 50 // donut inner radius

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angle = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  }
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  innerR = 0,
): string {
  const start = polarToCartesian(cx, cy, r, startAngle)
  const end = polarToCartesian(cx, cy, r, endAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0

  if (innerR > 0) {
    const innerStart = polarToCartesian(cx, cy, innerR, startAngle)
    const innerEnd = polarToCartesian(cx, cy, innerR, endAngle)
    return [
      `M ${start.x} ${start.y}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      'Z',
    ].join(' ')
  }

  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
    'Z',
  ].join(' ')
}

export function PieRenderer({
  data,
  valueField,
  groupBy,
  aggregation,
  quarterFilter,
  donut = false,
}: PieRendererProps) {
  const { wTier } = useWidgetSize()

  const slices = useMemo(
    () => aggregatePieData(data, valueField, groupBy, aggregation, quarterFilter),
    [data, valueField, groupBy, aggregation, quarterFilter],
  )

  const showLabels = wTier === 'lg' || wTier === 'xl'
  const unit = fieldUnit(data.fields, valueField)
  const label = fieldLabel(data.fields, valueField)

  // Total for donut center label
  const total = slices.reduce((s, sl) => s + sl.value, 0)

  function formatValue(v: number): string {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`
    if (Math.abs(v) < 1 && v !== 0) return v.toFixed(2)
    return v.toFixed(1)
  }

  // Build arc segments
  let cumAngle = 0
  const segments = slices.map((sl, i) => {
    const sweep = (sl.value / Math.max(total, 1e-10)) * 360
    const startAngle = cumAngle
    const endAngle = cumAngle + sweep
    cumAngle = endAngle
    const midAngle = startAngle + sweep / 2
    const color = GENERIC_PALETTE[i % GENERIC_PALETTE.length]
    return { sl, startAngle, endAngle, midAngle, color }
  })

  if (slices.length === 0) {
    return (
      <svg viewBox="0 0 200 200" className="w-full h-full">
        <text
          x={CX} y={CY}
          fontSize="9" fill="var(--muted-foreground)" textAnchor="middle" dominantBaseline="middle"
        >
          No data
        </text>
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 200 200" className="w-full h-full">
      {/* Arc segments */}
      {segments.map(({ sl, startAngle, endAngle, midAngle, color }) => {
        // Avoid degenerate arc when segment spans full 360
        const safeEnd = endAngle >= 360 ? 359.99 : endAngle
        const d = arcPath(CX, CY, R, startAngle, safeEnd, donut ? R_INNER : 0)

        // Label position (outside arc, lg/xl only)
        const labelPt = polarToCartesian(CX, CY, R + 12, midAngle)

        return (
          <g key={sl.group}>
            <path
              d={d}
              fill={color}
              opacity="0.85"
              stroke="white"
              strokeWidth="0.8"
            >
              <title>
                {sl.group}: {unit}{formatValue(sl.value)} ({sl.percentage.toFixed(1)}%)
              </title>
            </path>
            {showLabels && sl.percentage > 5 && (
              <text
                x={labelPt.x}
                y={labelPt.y}
                fontSize="6"
                fill="var(--foreground)"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {sl.group} {sl.percentage.toFixed(0)}%
              </text>
            )}
          </g>
        )
      })}

      {/* Donut center: total value */}
      {donut && (
        <>
          <text
            x={CX} y={CY - 5}
            fontSize="11"
            fontWeight="600"
            fill="currentColor"
            textAnchor="middle"
            dominantBaseline="middle"
            className="font-mono"
          >
            {unit}{formatValue(total)}
          </text>
          <text
            x={CX} y={CY + 10}
            fontSize="7"
            fill="var(--muted-foreground)"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {label}
          </text>
        </>
      )}
    </svg>
  )
}
