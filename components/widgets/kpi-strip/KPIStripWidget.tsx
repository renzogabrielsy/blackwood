'use client'

import Link from 'next/link'
import { useWidgetSize } from '@/components/widgets/chart/utils'

/* ===================================================
   KPI Chip — reusable stat cell
   =================================================== */

function KPIChip({ label, value, sub, showSub = true }: {
  label: string
  value: React.ReactNode
  sub: React.ReactNode
  showSub?: boolean
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm font-mono font-semibold text-foreground">{value}</span>
      {showSub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

/* ===================================================
   KPIStripWidget — main export
   =================================================== */

export function KPIStripWidget() {
  const { wTier, hTier } = useWidgetSize()
  const showSub = hTier !== 'xs' && hTier !== 'sm'

  if (wTier === 'sm' || wTier === 'xs') {
    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Inventory</span>
          <span className="text-sm font-mono font-semibold text-foreground">9,100 T</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Warehouse</span>
          <span className="text-sm font-mono font-semibold text-foreground">154/220 (70%)</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Current PHP/KG</span>
          <span className="text-sm font-mono font-semibold text-foreground flex items-center gap-1">
            <span className="text-muted-foreground">&#8369;</span>48.46
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Feb Flow</span>
          <span className="text-sm font-mono font-semibold text-emerald-500">+587 T</span>
        </div>
      </div>
    )
  }

  if (wTier === 'md') {
    return (
      <div className="grid grid-cols-2 gap-3 w-full">
        <KPIChip label="Total Inventory" value="9,100 T" sub="162 active batches" showSub={showSub} />
        <KPIChip label="Warehouse" value="154/220 (70%)" sub="occupied locations" showSub={showSub} />
        <KPIChip
          label="Current PHP/KG"
          value={<span className="flex items-center gap-1"><span className="text-muted-foreground">&#8369;</span>48.46</span>}
          sub={<span className="text-emerald-500">&#9650; +&#8369;1.74 vs Jan</span>}
          showSub={showSub}
        />
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Feb Flow</span>
          <div className="flex items-baseline gap-1 font-mono text-sm">
            <span className="text-foreground font-semibold">1,132 T</span>
            <span className="text-muted-foreground text-[10px]">in</span>
            <span className="text-muted-foreground mx-0.5">&minus;</span>
            <span className="text-foreground font-semibold">546 T</span>
            <span className="text-muted-foreground text-[10px]">out</span>
          </div>
          {showSub && <span className="text-[10px] text-emerald-500/70">net stock added</span>}
        </div>
      </div>
    )
  }

  // lg/xl: full layout with links
  return (
    <div className="flex items-center gap-5 w-full flex-wrap">
      <KPIChip label="Total Inventory" value="9,100 T" sub="162 active batches" showSub={showSub} />
      <div className="w-px h-8 bg-border" />
      <KPIChip label="Warehouse" value="154/220 (70%)" sub="occupied locations" showSub={showSub} />
      <div className="w-px h-8 bg-border" />
      <KPIChip
        label="Current PHP/KG"
        value={<span className="flex items-center gap-1"><span className="text-muted-foreground">&#8369;</span>48.46</span>}
        sub={<span className="text-emerald-500">&#9650; +&#8369;1.74 vs Jan</span>}
        showSub={showSub}
      />
      <div className="w-px h-8 bg-border" />
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Feb Flow</span>
        <div className="flex items-baseline gap-1 font-mono text-sm">
          <span className="text-foreground font-semibold">1,132 T</span>
          <span className="text-muted-foreground text-[10px]">in</span>
          <span className="text-muted-foreground mx-0.5">&minus;</span>
          <span className="text-foreground font-semibold">546 T</span>
          <span className="text-muted-foreground text-[10px]">out</span>
          <span className="text-muted-foreground mx-0.5">=</span>
          <span className="text-emerald-500 font-semibold">+587 T</span>
        </div>
        {showSub && <span className="text-[10px] text-emerald-500/70">net stock added</span>}
      </div>
      <div className="ml-auto flex items-center gap-0.5 border-l border-border pl-4">
        <Link href="/inventory" className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-foreground hover:bg-muted/50 transition-colors">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
          Inventory
        </Link>
        <Link href="/admin" className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-foreground hover:bg-muted/50 transition-colors">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
          Admin
        </Link>
      </div>
    </div>
  )
}
