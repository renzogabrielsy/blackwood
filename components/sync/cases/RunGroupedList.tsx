'use client'

import * as React from 'react'
import { format } from 'date-fns'
import { BadgeCheck } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SYNC_AI_REVIEW_ENABLED } from '@/lib/sync/config'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  asVerdict,
  kindLabel,
  NO_VERDICT_BADGE,
  STATUS_CHIP,
  VERDICT_BADGE,
} from './labels'
import {
  filterRowsByCluster,
  groupCasesByRun,
  isBulkSelectable,
  NO_RUN_BUCKET,
  type GroupingCase,
} from './grouping'
import { TriageSummaryCard } from './TriageSummaryCard'

/** A case row as shown in the run-grouped list (superset of the grouping input). */
export interface RunListCase extends GroupingCase {
  occurrence_count: number
  known_ruling_id: string | null
  known_ruling_summary: string | null
}

export type CaseFilter = 'all' | 'open' | 'investigated' | 'known'

interface RunGroupedListProps {
  cases: RunListCase[]
  selectedId: string | null
  onSelect: (id: string) => void
  filter: CaseFilter
  onFilterChange: (f: CaseFilter) => void
  showResolved: boolean
  onToggleResolved: (v: boolean) => void
  /** Per-run active cluster filter: runId → the cluster's case_ids (or absent). */
  clusterFilter: Record<string, string[] | null>
  onToggleCluster: (runId: string, caseIds: string[] | null) => void
  /** Selected case ids for bulk dismiss. */
  selectedForBulk: Set<string>
  onToggleBulk: (id: string, on: boolean) => void
  /** Scroll target: the section to bring into view (a deep-link run). */
  scrollToRunId: string | null
}

const ALL_FILTERS: { key: CaseFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'investigated', label: 'Investigated' },
  { key: 'known', label: 'Known' },
]

/**
 * Dormant — Sync Review is deterministic-only (Renzo 2026-07-11). With the AI
 * layer off, a case never reaches `status='investigated'` — it's just open or
 * resolved — so the "Investigated" filter chip is dropped to keep the filter
 * bar honest. Flip SYNC_AI_REVIEW_ENABLED to restore it.
 */
const FILTERS = SYNC_AI_REVIEW_ENABLED
  ? ALL_FILTERS
  : ALL_FILTERS.filter((f) => f.key !== 'investigated')

function matchesFilter(row: RunListCase, filter: CaseFilter): boolean {
  switch (filter) {
    case 'open':
      return row.status === 'open' || row.status === 'investigating'
    case 'investigated':
      return row.status === 'investigated'
    case 'known':
      return row.known_ruling_id != null
    case 'all':
    default:
      return true
  }
}

function VerdictBadge({ verdict, hasRuling }: { verdict: unknown; hasRuling: boolean }) {
  const v = asVerdict(verdict)
  const meta = v ? VERDICT_BADGE[v.verdict] : NO_VERDICT_BADGE
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        meta.className,
      )}
    >
      {hasRuling && <BadgeCheck className="h-3 w-3" />}
      {meta.label}
    </span>
  )
}

/** Section header — the run date/time + a flag count. */
function runHeaderLabel(latestAt: string, runId: string): string {
  if (runId === NO_RUN_BUCKET) return 'Older / ungrouped'
  const d = new Date(latestAt)
  if (Number.isNaN(d.getTime())) return 'Run'
  return format(d, 'yyyy-MM-dd HH:mm')
}

/**
 * The run-grouped case list (v1.1). Cases are grouped into per-run sections (newest
 * first). Each section shows its triage summary card on top (when a run_triage case
 * exists) and the run's non-triage cases as a dense, keyboard-navigable table beneath —
 * with a bulk-select checkbox per selectable row. The status filters + show-resolved
 * apply across all sections; empty state preserved.
 */
export function RunGroupedList({
  cases,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  showResolved,
  onToggleResolved,
  clusterFilter,
  onToggleCluster,
  selectedForBulk,
  onToggleBulk,
  scrollToRunId,
}: RunGroupedListProps) {
  // Apply the global status/resolved filters, THEN group into run sections.
  // NB: triage cases are never dropped by the status filter (they carry status
  // 'investigated'); they surface as the card regardless of the filter.
  const sections = React.useMemo(() => {
    const visible = cases.filter((r) => {
      if (r.kind === 'run_triage') return true // always keep the triage carrier
      if (!showResolved && r.status === 'resolved') return false
      return matchesFilter(r, filter)
    })
    return groupCasesByRun(visible)
  }, [cases, filter, showResolved])

  const sectionRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map())
  React.useEffect(() => {
    if (!scrollToRunId) return
    const el = sectionRefs.current.get(scrollToRunId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollToRunId, sections])

  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0)

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilterChange(f.key)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium transition-all duration-150',
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => onToggleResolved(e.target.checked)}
            className="h-3 w-3 accent-primary"
          />
          Show resolved
        </label>
      </div>

      {/* Sections */}
      <div className="min-h-0 flex-1 overflow-auto scroll-fade-bottom">
        {totalRows === 0 && sections.every((s) => !s.triage) ? (
          <div className="animate-fade-up p-6 text-center text-xs text-muted-foreground">
            Nothing needs review here.
          </div>
        ) : (
          <TooltipProvider delayDuration={200}>
            {sections.map((section) => {
              const active = clusterFilter[section.runId] ?? null
              const rows = filterRowsByCluster(section.rows, active)
              return (
                <div
                  key={section.runId}
                  ref={(el) => {
                    sectionRefs.current.set(section.runId, el)
                  }}
                  className="border-b border-border/60"
                >
                  {/* Run header */}
                  <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-muted/90 px-2 py-1 backdrop-blur-sm">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {runHeaderLabel(section.latestAt, section.runId)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground/70">
                      ({section.rows.length})
                    </span>
                  </div>

                  {/* Triage card */}
                  {section.triage && (
                    <div className="px-2 pt-2">
                      <TriageSummaryCard
                        triage={section.triage}
                        activeCaseIds={active}
                        onToggleCluster={(ids) => onToggleCluster(section.runId, ids)}
                        onDiscuss={() => onSelect(section.triage!.caseId)}
                        discussing={selectedId === section.triage.caseId}
                      />
                    </div>
                  )}

                  {/* Per-run table */}
                  {rows.length > 0 && (
                    // Never crush, always scroll: 28 + 92 + 120 fixed = 240px + a
                    // 220px floor for the flexible natural-key column → 460px.
                    <div className="mt-1 overflow-x-auto">
                    <table className="w-full min-w-[460px] table-fixed border-collapse text-xs">
                      <colgroup>
                        <col className="w-[28px]" />
                        <col className="w-[92px]" />
                        <col className="min-w-[220px]" />
                        <col className="w-[120px]" />
                      </colgroup>
                      <tbody>
                        {rows.map((row) => {
                          const chip = STATUS_CHIP[row.status] ?? {
                            label: row.status,
                            className: 'bg-muted text-muted-foreground',
                          }
                          const selected = row.id === selectedId
                          const selectable = isBulkSelectable(row)
                          const checked = selectedForBulk.has(row.id)
                          return (
                            <tr
                              key={row.id}
                              onClick={() => onSelect(row.id)}
                              className={cn(
                                'group h-8 cursor-pointer border-b border-border/40 transition-all duration-150',
                                selected ? 'bg-primary/10' : 'hover:bg-muted/50',
                              )}
                            >
                              <td
                                className="px-1.5 py-1 align-middle"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {selectable && (
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${row.natural_key}`}
                                    checked={checked}
                                    onChange={(e) => onToggleBulk(row.id, e.target.checked)}
                                    className="h-3 w-3 accent-primary"
                                  />
                                )}
                              </td>
                              <td className="px-2 py-1 align-top">
                                <span
                                  className={cn(
                                    'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                                    chip.className,
                                  )}
                                >
                                  {chip.label}
                                </span>
                              </td>
                              <td className="px-2 py-1 align-top">
                                <div className="truncate font-mono text-[11px] font-medium text-foreground">
                                  {row.natural_key}
                                </div>
                                <div className="truncate text-[10px] text-muted-foreground">
                                  {row.report_type} · {kindLabel(row.kind)}
                                </div>
                              </td>
                              <td className="px-2 py-1 align-top">
                                {row.known_ruling_id && row.known_ruling_summary ? (
                                  // "Known issue" is a genuine, human-ruled signal (a prior
                                  // resolve, not an AI verdict) — stays visible regardless
                                  // of SYNC_AI_REVIEW_ENABLED.
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex">
                                        <VerdictBadge verdict={row.verdict} hasRuling />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-[280px] bg-popover/95 text-xs backdrop-blur-lg">
                                      Known issue — prior ruling: {row.known_ruling_summary}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : SYNC_AI_REVIEW_ENABLED ? (
                                  <VerdictBadge verdict={row.verdict} hasRuling={false} />
                                ) : (
                                  // Dormant — Sync Review is deterministic-only (Renzo
                                  // 2026-07-11). No known ruling + AI off → nothing to
                                  // surface here; a case is just open/resolved. Flip
                                  // SYNC_AI_REVIEW_ENABLED to restore the verdict badge.
                                  null
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    </div>
                  )}
                </div>
              )
            })}
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}
