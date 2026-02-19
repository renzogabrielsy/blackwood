'use client'

import { useWidgetSize } from '@/components/widgets/chart/utils'
import type { WarehouseData } from './types'

/* ===================================================
   WarehouseOccupancyWidget — WHSE occupancy bars
   =================================================== */

interface WarehouseOccupancyWidgetProps {
  data?: WarehouseData[]
}

export function WarehouseOccupancyWidget({ data = [] }: WarehouseOccupancyWidgetProps) {
  const { wTier, hTier } = useWidgetSize()

  const spacingClass = hTier === 'lg' || hTier === 'xl' ? 'space-y-3' : hTier === 'md' || hTier === 'sm' ? 'space-y-1' : 'space-y-0'

  const totals = data.reduce(
    (acc, w) => ({ occupied: acc.occupied + w.occupied, total: acc.total + w.total }),
    { occupied: 0, total: 0 },
  )
  const totalPct = totals.total > 0 ? Math.round((totals.occupied / totals.total) * 100) : 0

  return (
    <div className={spacingClass}>
      {data.map((w) => {
        const pct = Math.round((w.occupied / w.total) * 100)
        const barColor = pct >= 85 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'

        if (hTier === 'xs') {
          return (
            <div key={w.label}>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        }

        let statsContent: React.ReactNode = null
        if (wTier === 'lg' || wTier === 'xl') {
          statsContent = (
            <span className="text-[10px] text-muted-foreground font-mono ml-2">
              &#8369;{w.phpKg.toFixed(2)} &middot; MC {w.mc.toFixed(1)} &middot; ASH {w.ash.toFixed(1)}
            </span>
          )
        } else if (wTier === 'md') {
          statsContent = (
            <span className="text-[10px] text-muted-foreground font-mono ml-2">
              &#8369;{w.phpKg.toFixed(2)} &middot; MC {w.mc.toFixed(1)}
            </span>
          )
        }

        return (
          <div key={w.label} className="space-y-1">
            <div className="flex items-baseline gap-1">
              <span className="font-medium text-foreground text-xs">WHSE {w.label}</span>
              {statsContent}
              <span className="ml-auto font-mono text-muted-foreground text-xs">{w.occupied}/{w.total} ({pct}%)</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
      {hTier !== 'xs' && totals.total > 0 && (
        <div className="flex justify-between text-xs pt-1 border-t border-border">
          <span className="font-semibold text-foreground">Total</span>
          <span className="font-mono font-semibold text-foreground">{totals.occupied}/{totals.total} ({totalPct}%)</span>
        </div>
      )}
    </div>
  )
}
