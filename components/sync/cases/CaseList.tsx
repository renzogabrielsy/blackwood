'use client'

import * as React from 'react'
import { format } from 'date-fns'
import { BadgeCheck } from 'lucide-react'

import { cn } from '@/lib/utils'
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

/** A case row as shown in the list (superset of listOpenCases()'s OpenCaseRow). */
export interface CaseListRow {
  id: string
  report_type: string
  kind: string
  natural_key: string
  status: string
  occurrence_count: number
  last_seen_at: string
  known_ruling_id: string | null
  known_ruling_summary: string | null
  verdict: unknown
}

export type CaseFilter = 'all' | 'open' | 'investigated' | 'known'

interface CaseListProps {
  cases: CaseListRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  filter: CaseFilter
  onFilterChange: (f: CaseFilter) => void
  showResolved: boolean
  onToggleResolved: (v: boolean) => void
}

const FILTERS: { key: CaseFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'investigated', label: 'Investigated' },
  { key: 'known', label: 'Known' },
]

function matchesFilter(row: CaseListRow, filter: CaseFilter): boolean {
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

export function CaseList({
  cases,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  showResolved,
  onToggleResolved,
}: CaseListProps) {
  const rows = React.useMemo(() => {
    return cases
      .filter((r) => (showResolved ? true : r.status !== 'resolved'))
      .filter((r) => matchesFilter(r, filter))
  }, [cases, filter, showResolved])

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

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto scroll-fade-bottom">
        {rows.length === 0 ? (
          <div className="animate-fade-up p-6 text-center text-xs text-muted-foreground">
            Nothing needs review here.
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-[110px]" />
              <col />
              <col className="w-[130px]" />
              <col className="w-[44px]" />
              <col className="w-[92px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">Status</th>
                <th className="px-2 py-1 text-left font-medium">Case</th>
                <th className="px-2 py-1 text-left font-medium">Verdict</th>
                <th className="px-2 py-1 text-right font-medium" title="Times seen">
                  ×
                </th>
                <th className="px-2 py-1 text-left font-medium">Seen</th>
              </tr>
            </thead>
            <tbody>
              <TooltipProvider delayDuration={200}>
                {rows.map((row) => {
                  const chip = STATUS_CHIP[row.status] ?? {
                    label: row.status,
                    className: 'bg-muted text-muted-foreground',
                  }
                  const selected = row.id === selectedId
                  return (
                    <tr
                      key={row.id}
                      onClick={() => onSelect(row.id)}
                      className={cn(
                        'group h-8 cursor-pointer border-b border-border/60 transition-all duration-150',
                        selected ? 'bg-primary/10' : 'hover:bg-muted/50',
                      )}
                    >
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
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <VerdictBadge verdict={row.verdict} hasRuling />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[280px] bg-popover/95 backdrop-blur-lg text-xs">
                              Known issue — prior ruling: {row.known_ruling_summary}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <VerdictBadge verdict={row.verdict} hasRuling={false} />
                        )}
                      </td>
                      <td className="px-2 py-1 text-right align-top font-mono text-[11px] text-muted-foreground">
                        {row.occurrence_count}
                      </td>
                      <td className="px-2 py-1 align-top font-mono text-[10px] text-muted-foreground">
                        {row.last_seen_at ? format(new Date(row.last_seen_at), 'yyyy-MM-dd') : '—'}
                      </td>
                    </tr>
                  )
                })}
              </TooltipProvider>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
