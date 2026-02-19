'use client'

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { KPIData, KPIStripSettings, KPIChipOverride } from './types'

/* ===================================================
   KPIStripSettingsPopover
   Gear icon in WidgetShell's headerAction slot.
   Controls chip visibility, order, density, and per-chip overrides.
   =================================================== */

interface KPIStripSettingsPopoverProps {
  chips: KPIData[]
  settings: KPIStripSettings
  onSettingsChange: (partial: Partial<KPIStripSettings>) => void
}

export function KPIStripSettingsPopover({
  chips,
  settings,
  onSettingsChange,
}: KPIStripSettingsPopoverProps) {
  const [expandedChip, setExpandedChip] = useState<string | null>(null)

  // Only operate on data chips (those with a value)
  const dataChips = chips.filter(c => c.value !== undefined)
  const hidden = settings.hidden ?? []
  const order = settings.order ?? []
  const chipOverrides = settings.chipOverrides ?? {}

  // Build the effective ordered list for display — same logic as applySettings()
  function getOrderedChips(): KPIData[] {
    if (order.length === 0) return dataChips
    const ordered = order
      .map(label => dataChips.find(c => c.label === label))
      .filter((c): c is KPIData => c !== undefined)
    const unlisted = dataChips.filter(c => !order.includes(c.label))
    return [...ordered, ...unlisted]
  }

  const orderedChips = getOrderedChips()

  function toggleHidden(label: string) {
    const next = hidden.includes(label)
      ? hidden.filter(l => l !== label)
      : [...hidden, label]
    onSettingsChange({ hidden: next })
  }

  function moveChip(label: string, direction: 'up' | 'down') {
    // Initialize order from current ordered chip list if not set yet
    const currentOrder = order.length > 0
      ? order
      : orderedChips.map(c => c.label)

    const idx = currentOrder.indexOf(label)
    if (idx === -1) {
      // Label not in order list yet — add it and all others, then move
      const fullOrder = orderedChips.map(c => c.label)
      const newIdx = fullOrder.indexOf(label)
      const next = [...fullOrder]
      const targetIdx = direction === 'up' ? newIdx - 1 : newIdx + 1
      if (targetIdx < 0 || targetIdx >= next.length) return
      ;[next[newIdx], next[targetIdx]] = [next[targetIdx], next[newIdx]]
      onSettingsChange({ order: next })
      return
    }

    const next = [...currentOrder]
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= next.length) return
    ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
    onSettingsChange({ order: next })
  }

  function updateChipOverride(originalLabel: string, patch: Partial<KPIChipOverride>) {
    onSettingsChange({
      chipOverrides: {
        ...chipOverrides,
        [originalLabel]: {
          ...chipOverrides[originalLabel],
          ...patch,
        },
      },
    })
  }

  const chipMode = settings.chipMode ?? 'auto'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
          aria-label="KPI Strip settings"
        >
          <Settings size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-64 p-3 text-xs"
      >
        {/* Chips section */}
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Chips
        </p>
        <div className="flex flex-col gap-0.5">
          {orderedChips.map((chip, idx) => {
            // chip.label here is the ORIGINAL label (adapter output, before any override)
            const originalLabel = chip.label
            const isVisible = !hidden.includes(originalLabel)
            const isExpanded = expandedChip === originalLabel
            const ov = chipOverrides[originalLabel]

            return (
              <div key={originalLabel}>
                {/* Chip row */}
                <div className="flex items-center gap-2 py-0.5">
                  <Switch
                    checked={isVisible}
                    onCheckedChange={() => toggleHidden(originalLabel)}
                    aria-label={`Toggle ${originalLabel}`}
                    className="scale-75 origin-left"
                  />
                  <span className="flex-1 text-xs text-foreground truncate">
                    {ov?.labelOverride ?? originalLabel}
                  </span>
                  <div className="flex gap-0.5 items-center">
                    <button
                      type="button"
                      onClick={() => moveChip(originalLabel, 'up')}
                      disabled={idx === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors text-[10px] px-0.5"
                      aria-label={`Move ${originalLabel} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveChip(originalLabel, 'down')}
                      disabled={idx === orderedChips.length - 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors text-[10px] px-0.5"
                      aria-label={`Move ${originalLabel} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedChip(prev => prev === originalLabel ? null : originalLabel)}
                      className={`text-[10px] px-0.5 transition-colors ${
                        isExpanded
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${originalLabel} settings`}
                      aria-expanded={isExpanded}
                    >
                      ···
                    </button>
                  </div>
                </div>

                {/* Expanded per-chip settings panel */}
                {isExpanded && (
                  <div className="mt-1 mb-1.5 ml-2 pl-2 border-l border-border flex flex-col gap-2">
                    {/* Label override */}
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Label
                      </Label>
                      <Input
                        value={ov?.labelOverride ?? originalLabel}
                        onChange={e => {
                          const val = e.target.value
                          updateChipOverride(originalLabel, {
                            labelOverride: val === originalLabel ? undefined : val,
                          })
                        }}
                        className="h-6 text-xs px-1.5 py-0"
                        placeholder={originalLabel}
                      />
                    </div>

                    {/* Pinned toggle */}
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-muted-foreground">
                        Pinned
                      </Label>
                      <Switch
                        checked={ov?.pinned ?? chip.pinned ?? false}
                        onCheckedChange={val => updateChipOverride(originalLabel, { pinned: val })}
                        aria-label={`Pin ${originalLabel}`}
                        className="scale-75 origin-right"
                      />
                    </div>

                    {/* Show comparison toggle */}
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-muted-foreground">
                        Show comparison
                      </Label>
                      <Switch
                        checked={ov?.showComparison ?? true}
                        onCheckedChange={val => updateChipOverride(originalLabel, { showComparison: val })}
                        aria-label={`Show comparison for ${originalLabel}`}
                        className="scale-75 origin-right"
                      />
                    </div>

                    {/* Show sparkline toggle */}
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-muted-foreground">
                        Show sparkline
                      </Label>
                      <Switch
                        checked={ov?.showSparkline ?? true}
                        onCheckedChange={val => updateChipOverride(originalLabel, { showSparkline: val })}
                        aria-label={`Show sparkline for ${originalLabel}`}
                        className="scale-75 origin-right"
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Divider */}
        <div className="border-t border-border my-3" />

        {/* Display density section */}
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Display
        </p>
        <div className="flex items-center gap-1">
          {(['auto', 'compact', 'expanded'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => onSettingsChange({ chipMode: mode })}
              className={`flex-1 text-[10px] py-1 rounded capitalize transition-colors ${
                chipMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
              aria-pressed={chipMode === mode}
            >
              {mode}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
