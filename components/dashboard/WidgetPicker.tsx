'use client'

import { WIDGET_REGISTRY } from '@/components/widgets'

/* ===================================================
   WidgetPicker — "Add widget" modal
   Shows all available widget types from WIDGET_REGISTRY.
   Chart widgets can be added as multiple instances.
   All other widgets are singletons (one per dashboard).
   =================================================== */

interface WidgetPickerProps {
  open: boolean
  onClose: () => void
  visibleModules: string[]
  /** Add a singleton widget by its registry type */
  onAddSingleton: (type: string, instanceId: string) => void
  /** Add a new chart widget instance */
  onAddChart: () => void
}

export function WidgetPicker({ open, onClose, visibleModules, onAddSingleton, onAddChart }: WidgetPickerProps) {
  if (!open) return null

  // Singleton widgets (non-chart)
  const singletonDefs = WIDGET_REGISTRY.filter(w => w.type !== 'chart')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} />
      {/* Dialog */}
      <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-xl p-6 animate-modal-enter">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">Add Widget</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg px-2 transition-colors"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Chart Widget — multi-instance */}
        <div className="mb-4 pb-4 border-b border-border">
          <button
            type="button"
            onClick={() => { onAddChart(); onClose() }}
            className="w-full flex items-center gap-2 p-3 rounded-md border border-dashed border-border text-left hover:bg-muted/50 transition-colors"
          >
            <span className="text-lg">+</span>
            <div>
              <div className="text-xs font-semibold text-foreground">Add Chart Widget</div>
              <div className="text-[10px] text-muted-foreground font-mono">4&times;7 &middot; unlimited instances</div>
            </div>
          </button>
        </div>

        {/* Singleton widgets */}
        <div className="grid grid-cols-2 gap-3">
          {singletonDefs.map((def) => {
            // Singleton ID = type (one per dashboard)
            const instanceId = def.type
            const isAdded = visibleModules.includes(instanceId)
            return (
              <button
                key={def.type}
                type="button"
                onClick={() => { if (!isAdded) { onAddSingleton(def.type, instanceId); onClose() } }}
                disabled={isAdded}
                className={`flex items-center justify-between p-3 rounded-md border text-left transition-colors ${
                  isAdded
                    ? 'border-border bg-muted/30 opacity-50 cursor-not-allowed'
                    : 'border-border bg-card hover:bg-muted/50 cursor-pointer'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground truncate">{def.displayName}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {def.defaultSize.w}&times;{def.defaultSize.h}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{def.description}</div>
                </div>
                {isAdded && (
                  <span className="text-[10px] font-medium text-muted-foreground shrink-0 ml-2">Added &#10003;</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
