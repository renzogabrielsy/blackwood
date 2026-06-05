'use client'

import { useEffect, useRef, useState } from 'react'
import { WidgetSizeContext } from '@/components/widgets/chart/utils'
import { getWidthTier, getHeightTier } from '@/components/widgets/chart/utils'
import type { WidgetSize } from '@/components/widgets/chart/types'

/* ===================================================
   WidgetShell — generic widget frame
   Provides: title bar, collapse toggle, remove button (edit mode),
   ResizeObserver-backed WidgetSizeContext for child widgets.
   =================================================== */

interface WidgetShellProps {
  id: string
  title: string
  editMode: boolean
  onRemove: () => void
  onCollapse: () => void
  collapsed: boolean
  headerAction?: React.ReactNode
  children: React.ReactNode
}

export function WidgetShell({ title, editMode, onRemove, onCollapse, collapsed, headerAction, children }: WidgetShellProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [widgetSize, setWidgetSize] = useState<WidgetSize>({
    widthPx: 400,
    heightPx: 300,
    wTier: 'md',
    hTier: 'md',
  })

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setWidgetSize({
          widthPx: width,
          heightPx: height,
          wTier: getWidthTier(width),
          hTier: getHeightTier(height),
        })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed])

  return (
    <div className="flex flex-col h-full border border-border rounded-md bg-card overflow-hidden">
      <div className={`flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b border-border select-none ${editMode ? 'cursor-grab active:cursor-grabbing drag-handle' : ''}`}>
        {editMode && <span className="text-muted-foreground text-xs">&#10495;</span>}
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground flex-1 truncate">{title}</span>
        {headerAction}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCollapse() }}
          className="text-muted-foreground hover:text-foreground text-xs px-1 transition-colors"
          aria-label={collapsed ? 'Expand widget' : 'Collapse widget'}
        >
          {collapsed ? '\u25A1' : '\u2014'}
        </button>
        {editMode && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            className="text-muted-foreground hover:text-destructive text-xs px-1 transition-colors"
            aria-label="Remove widget"
          >
            &times;
          </button>
        )}
      </div>
      {!collapsed && (
        <div ref={contentRef} className="flex-1 overflow-hidden p-3">
          <WidgetSizeContext.Provider value={widgetSize}>
            {children}
          </WidgetSizeContext.Provider>
        </div>
      )}
    </div>
  )
}
