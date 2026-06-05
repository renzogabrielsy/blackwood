'use client'

import { useState } from 'react'
import { Fragment } from 'react'
import Link from 'next/link'
import { useWidgetSize } from '@/components/widgets/chart/utils'
import type { KPIData, KPIStripSettings, KPIChipOverride } from './types'
import {
  DefaultChip,
  FlowChip,
  ProgressChip,
  RatioChip,
  getThresholdColor,
} from './chips'

/* ===================================================
   Period selector options
   =================================================== */

const PERIOD_OPTIONS: { key: NonNullable<KPIStripSettings['period']>; label: string }[] = [
  { key: 'today', label: 'D' },
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'quarter', label: 'Q' },
  { key: 'year', label: 'Y' },
]

/* ===================================================
   Settings filter + sort
   =================================================== */

function applySettings(chips: KPIData[], settings: KPIStripSettings): KPIData[] {
  const hidden = settings.hidden ?? []
  const order = settings.order ?? []

  const visible = chips.filter(c => !hidden.includes(c.label))

  if (order.length === 0) return visible

  const ordered = order
    .map(label => visible.find(c => c.label === label))
    .filter((c): c is KPIData => c !== undefined)
  const unlisted = visible.filter(c => !order.includes(c.label))
  return [...ordered, ...unlisted]
}

/* ===================================================
   Per-chip override application
   NOTE: originalLabel must be tracked BEFORE calling this,
   so callers can look up overrides by original label.
   =================================================== */

function applyChipOverrides(
  chips: KPIData[],
  overrides: Record<string, KPIChipOverride>,
): KPIData[] {
  return chips.map(chip => {
    const ov = overrides[chip.label]
    if (!ov) return chip
    return {
      ...chip,
      label: ov.labelOverride ?? chip.label,
      pinned: ov.pinned ?? chip.pinned,
    }
  })
}

/* ===================================================
   Chip dispatcher
   originalLabel is the chip's key before any labelOverride.
   =================================================== */

function renderChip(
  chip: KPIData,
  showSub: boolean,
  showSparkline: boolean,
  override?: KPIChipOverride,
): React.ReactNode {
  const tColor = getThresholdColor(chip.thresholds, chip.value)

  // Per-chip visibility flags — override narrows, never expands beyond global settings
  const effectiveShowSub = showSub && (override?.showComparison !== false)
  const effectiveShowSparkline = showSparkline && (override?.showSparkline !== false)

  let inner: React.ReactNode
  switch (chip.variant) {
    case 'flow':
      inner = <FlowChip chip={chip} />
      break
    case 'progress':
      inner = <ProgressChip chip={chip} thresholdColor={tColor} />
      break
    case 'ratio':
      inner = <RatioChip chip={chip} thresholdColor={tColor} />
      break
    default:
      inner = (
        <DefaultChip
          chip={chip}
          showSub={effectiveShowSub}
          showSparkline={effectiveShowSparkline}
          thresholdColor={tColor}
        />
      )
  }

  if (chip.drilldown?.href) {
    return (
      <Link href={chip.drilldown.href} className="block hover:opacity-80 transition-opacity">
        {inner}
      </Link>
    )
  }
  return inner
}

/* ===================================================
   KPIStripWidget — main export
   =================================================== */

interface KPIStripWidgetProps {
  data?: KPIData[]
  settings?: KPIStripSettings
  onSettingsChange?: (partial: Partial<KPIStripSettings>) => void
}

export function KPIStripWidget({
  data = [],
  settings = {},
  onSettingsChange,
}: KPIStripWidgetProps) {
  const { wTier, hTier } = useWidgetSize()
  const [expanded, setExpanded] = useState(false)

  // Derive showSub from chipMode + hTier
  const showSub =
    settings.chipMode === 'expanded'
      ? true
      : settings.chipMode === 'compact'
        ? false
        : hTier !== 'xs' && hTier !== 'sm'

  const showSparkline = wTier !== 'xs' && wTier !== 'sm'

  // Separate chips into data chips and nav chips
  const allDataChips = data.filter(chip => chip.value !== undefined)
  const navChips = data.filter(chip => chip.value === undefined && chip.href)

  // Apply hidden/order settings — labels are still original at this point
  const filteredDataChips = applySettings(allDataChips, settings)

  // Build overrides map (keyed by original label, before any labelOverride)
  const chipOverrides = settings.chipOverrides ?? {}

  // Apply label and pinned overrides — note: we must look up overrides by
  // original label before applying labelOverride, so we track originals separately
  const originalLabels = filteredDataChips.map(c => c.label)
  const displayedDataChips = applyChipOverrides(filteredDataChips, chipOverrides)

  // Period selector row — only render when onSettingsChange is wired and we have room
  const showPeriodSelector = Boolean(onSettingsChange) && wTier !== 'xs'
  const currentPeriod = settings.period ?? 'month'

  /* ---- xs/sm: pinned-first compact layout ---- */
  if (wTier === 'sm' || wTier === 'xs') {
    const pinnedChips = displayedDataChips.filter(c => c.pinned)
    const unpinnedChips = displayedDataChips.filter(c => !c.pinned)
    const hiddenCount = unpinnedChips.length

    const visibleChips = expanded ? displayedDataChips : pinnedChips

    return (
      <div className="flex flex-col gap-2 w-full">
        {visibleChips.map((chip, i) => {
          const origLabel = originalLabels[displayedDataChips.indexOf(chip)] ?? chip.label
          return (
            <div key={chip.label ?? i}>
              {renderChip(chip, false, false, chipOverrides[origLabel])}
            </div>
          )
        })}
        {!expanded && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="self-start text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            +{hiddenCount} more
          </button>
        )}
        {expanded && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="self-start text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            Show less
          </button>
        )}
      </div>
    )
  }

  if (wTier === 'md') {
    return (
      <div className="flex flex-col gap-2 w-full">
        {showPeriodSelector && (
          <div className="flex justify-end items-center mb-1">
            <PeriodSelector
              current={currentPeriod}
              onChange={p => onSettingsChange?.({ period: p })}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 w-full">
          {displayedDataChips.map((chip, i) => {
            const origLabel = originalLabels[i] ?? chip.label
            return (
              <div key={chip.label ?? i}>
                {renderChip(chip, showSub, showSparkline, chipOverrides[origLabel])}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // lg/xl + compact height (hTier sm/xs): single row — chips left, period selector right
  if (hTier === 'sm' || hTier === 'xs') {
    return (
      <div className="flex items-center gap-4 w-full">
        {displayedDataChips.map((chip, i) => {
          const origLabel = originalLabels[i] ?? chip.label
          return (
            <Fragment key={chip.label ?? i}>
              {i > 0 && <div className="w-px h-5 bg-border shrink-0" />}
              {renderChip(chip, false, false, chipOverrides[origLabel])}
            </Fragment>
          )
        })}
        <div className="ml-auto flex items-center gap-1.5">
          {navChips.map((chip, i) => (
            <Link
              key={i}
              href={chip.href!}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              {chip.accent && (
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${chip.accent}`} />
              )}
              {chip.label}
            </Link>
          ))}
          {showPeriodSelector && (
            <PeriodSelector
              current={currentPeriod}
              onChange={p => onSettingsChange?.({ period: p })}
            />
          )}
        </div>
      </div>
    )
  }

  // lg/xl: full horizontal layout with period selector + optional nav links
  return (
    <div className="flex flex-col gap-2 w-full h-full">
      {showPeriodSelector && (
        <div className="flex items-center justify-between mb-1">
          <div /> {/* spacer */}
          <PeriodSelector
            current={currentPeriod}
            onChange={p => onSettingsChange?.({ period: p })}
          />
        </div>
      )}
      <div className="flex items-center gap-5 w-full flex-wrap flex-1">
        {displayedDataChips.map((chip, i) => {
          const origLabel = originalLabels[i] ?? chip.label
          return (
            <Fragment key={chip.label ?? i}>
              {i > 0 && <div className="w-px h-8 bg-border shrink-0" />}
              {renderChip(chip, showSub, showSparkline, chipOverrides[origLabel])}
            </Fragment>
          )
        })}
        {navChips.length > 0 && (
          <div className="ml-auto flex items-center gap-0.5 border-l border-border pl-4">
            {navChips.map((chip, i) => (
              <Link
                key={i}
                href={chip.href!}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
              >
                {chip.accent && (
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${chip.accent}`} />
                )}
                {chip.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ===================================================
   PeriodSelector — compact D/W/M/Q/Y toggle
   =================================================== */

interface PeriodSelectorProps {
  current: NonNullable<KPIStripSettings['period']>
  onChange: (period: NonNullable<KPIStripSettings['period']>) => void
}

function PeriodSelector({ current, onChange }: PeriodSelectorProps) {
  return (
    <div className="flex items-center gap-0.5">
      {PERIOD_OPTIONS.map(opt => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors ${
            current === opt.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-pressed={current === opt.key}
          aria-label={`Period: ${opt.key}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
