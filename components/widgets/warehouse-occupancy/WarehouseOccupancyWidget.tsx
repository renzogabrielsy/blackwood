'use client'

import { useWidgetSize } from '@/components/widgets/chart/utils'
import { WAREHOUSE_LIST } from '@/lib/widgets/mock-data'

/* ===================================================
   WarehouseOccupancyWidget — WHSE occupancy bars
   =================================================== */

export function WarehouseOccupancyWidget() {
  const { wTier, hTier } = useWidgetSize()

  const spacingClass = hTier === 'lg' || hTier === 'xl' ? 'space-y-3' : hTier === 'md' || hTier === 'sm' ? 'space-y-1' : 'space-y-0'

  return (
    <div className={spacingClass}>
      {WAREHOUSE_LIST.map((w) => {
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
      {hTier !== 'xs' && (
        <div className="flex justify-between text-xs pt-1 border-t border-border">
          <span className="font-semibold text-foreground">Total</span>
          <span className="font-mono font-semibold text-foreground">154/220 (70%)</span>
        </div>
      )}
    </div>
  )
}
