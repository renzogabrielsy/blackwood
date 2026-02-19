'use client'

import { useState } from 'react'
import { useWidgetSize } from '@/components/widgets/chart/utils'
import type { ScatterPoint } from './types'

/* ===================================================
   QualityScatterWidget — Quality vs Price scatter plot
   =================================================== */

interface QualityScatterWidgetProps {
  data?: ScatterPoint[]
}

export function QualityScatterWidget({ data = [] }: QualityScatterWidgetProps) {
  const { wTier, hTier } = useWidgetSize()
  const [mode, setMode] = useState<'mc' | 'ash'>('mc')

  const effectiveMode = (wTier === 'sm' || wTier === 'xs') ? 'mc' : mode

  const W = 300, H = 180, PAD_L = 28, PAD_R = 12, PAD_T = 20, PAD_B = 24
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B

  const priceMin = 26, priceMax = 50, priceRange = priceMax - priceMin
  const priceRef = 47

  const yMin = effectiveMode === 'mc' ? 10.0 : 3.2
  const yMax = effectiveMode === 'mc' ? 12.5 : 6.0
  const yRange = yMax - yMin
  const yRef = effectiveMode === 'mc' ? 11.5 : 4.0

  const xOf = (price: number) => PAD_L + ((price - priceMin) / priceRange) * chartW
  const yOf = (v: number) => PAD_T + chartH - ((v - yMin) / yRange) * chartH

  const priceRefX = xOf(priceRef)
  const yRefY = yOf(yRef)

  const quadrants = effectiveMode === 'mc'
    ? { bl: 'ideal', br: 'high MC', tl: 'cheap', tr: 'poor' }
    : { bl: 'ideal', br: 'high ASH', tl: 'cheap', tr: 'poor' }

  const xTicks = [28, 32, 36, 40, 44, 48]
  const yTicks = effectiveMode === 'mc'
    ? [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    : [3.5, 4.0, 4.5, 5.0, 5.5]

  const yLabel = effectiveMode === 'mc' ? 'MC' : 'ASH'

  const showToggle = wTier !== 'sm' && wTier !== 'xs'
  const showQuadrantLabels = wTier === 'lg' || wTier === 'xl'
  const showRefLineLabels = wTier !== 'sm' && wTier !== 'xs'
  const showLegend = hTier !== 'sm' && hTier !== 'xs'

  return (
    <div className="space-y-2">
      {showToggle && (
        <div className="flex justify-end">
          <div className="inline-flex items-center rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setMode('mc')}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-sm transition-colors ${
                effectiveMode === 'mc'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              MC
            </button>
            <button
              type="button"
              onClick={() => setMode('ash')}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-sm transition-colors ${
                effectiveMode === 'ash'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              ASH
            </button>
          </div>
        </div>
      )}

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {showLegend && (
          <>
            <circle cx="10" cy="10" r="3" fill="#60a5fa" />
            <text x="16" y="13" fontSize="7" fill="#71717a">2025</text>
            <circle cx="42" cy="10" r="3" fill="#10b981" />
            <text x="48" y="13" fontSize="7" fill="#71717a">2026</text>
          </>
        )}

        <text x={PAD_L + chartW / 2} y={H - 3} fontSize="7" fill="#71717a" textAnchor="middle">PHP/KG</text>
        <text x="6" y={PAD_T + chartH / 2} fontSize="7" fill="#71717a" textAnchor="middle" transform={`rotate(-90, 6, ${PAD_T + chartH / 2})`}>{yLabel}</text>

        <line x1={priceRefX} y1={PAD_T} x2={priceRefX} y2={PAD_T + chartH} stroke="#f59e0b" strokeWidth="0.6" strokeDasharray="3,3" opacity="0.5" />
        <line x1={PAD_L} y1={yRefY} x2={PAD_L + chartW} y2={yRefY} stroke="#f59e0b" strokeWidth="0.6" strokeDasharray="3,3" opacity="0.5" />

        {showRefLineLabels && (
          <>
            <text x={priceRefX + 2} y={PAD_T + 8} fontSize="5.5" fill="#f59e0b" opacity="0.6">&#8369;{priceRef}</text>
            <text x={PAD_L + chartW - 2} y={yRefY - 2} fontSize="5.5" fill="#f59e0b" opacity="0.6" textAnchor="end">{yLabel} {yRef}</text>
          </>
        )}

        {showQuadrantLabels && (
          <>
            <text x={PAD_L + 6} y={PAD_T + chartH - 6} fontSize="6" fill="#71717a" opacity="0.4">{quadrants.tl}</text>
            <text x={PAD_L + chartW - 6} y={PAD_T + chartH - 6} fontSize="6" fill="#71717a" opacity="0.4" textAnchor="end">{quadrants.bl}</text>
            <text x={PAD_L + 6} y={PAD_T + 12} fontSize="6" fill="#71717a" opacity="0.4">{quadrants.tr}</text>
            <text x={PAD_L + chartW - 6} y={PAD_T + 12} fontSize="6" fill="#71717a" opacity="0.4" textAnchor="end">{quadrants.br}</text>
          </>
        )}

        {xTicks.map(v => (
          <g key={v}>
            <line x1={xOf(v)} y1={PAD_T + chartH} x2={xOf(v)} y2={PAD_T + chartH + 3} stroke="#71717a" strokeWidth="0.5" opacity="0.5" />
            <text x={xOf(v)} y={PAD_T + chartH + 11} fontSize="6.5" fill="#71717a" textAnchor="middle">{v}</text>
          </g>
        ))}

        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD_L - 3} y1={yOf(v)} x2={PAD_L} y2={yOf(v)} stroke="#71717a" strokeWidth="0.5" opacity="0.5" />
            <text x={PAD_L - 5} y={yOf(v) + 2.5} fontSize="6.5" fill="#71717a" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}

        <rect x={PAD_L} y={PAD_T} width={chartW} height={chartH} fill="none" stroke="#71717a" strokeWidth="0.3" opacity="0.3" />

        {data.map((p, i) => {
          const yVal = effectiveMode === 'mc' ? p.mc : p.ash
          const cx = xOf(Math.max(priceMin, Math.min(priceMax, p.phpKg)))
          const cy = yOf(Math.max(yMin, Math.min(yMax, yVal)))
          const color = p.year === '2026' ? '#10b981' : '#60a5fa'
          return (
            <circle key={i} cx={cx} cy={cy} r="3.5" fill={color} opacity="0.75" stroke="white" strokeWidth="0.5" />
          )
        })}
      </svg>
    </div>
  )
}
