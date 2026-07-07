'use client'

import * as React from 'react'
import { MessageSquare, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TriageView } from './grouping'

interface TriageSummaryCardProps {
  triage: TriageView
  /** The currently-active cluster filter (its case_ids), or null. */
  activeCaseIds: string[] | null
  /** Toggle a cluster chip on/off (filters the section's table to its case_ids). */
  onToggleCluster: (caseIds: string[] | null) => void
  /** Open the run chat (selects the triage case). */
  onDiscuss: () => void
  /** True when the triage case is the selected case (its chat is open). */
  discussing: boolean
}

/** Tint per suggested action — dismiss-suggested = emerald, needs-attention = amber. */
function chipClasses(action: 'dismiss' | 'needs-attention', active: boolean): string {
  if (action === 'dismiss') {
    return active
      ? 'border-emerald-500/60 bg-emerald-500/25 text-emerald-700 dark:text-emerald-300'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400'
  }
  return active
    ? 'border-amber-500/60 bg-amber-500/25 text-amber-700 dark:text-amber-300'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400'
}

/**
 * The run's triage summary card, rendered at the top of a run section. Shows the
 * plain-language run summary, one chip per cluster (title + count + action tint), and a
 * "Discuss this run" button that opens the triage case's chat. Clicking a chip filters
 * the section's table to that cluster's cases (toggle off on re-click).
 */
export function TriageSummaryCard({
  triage,
  activeCaseIds,
  onToggleCluster,
  onDiscuss,
  discussing,
}: TriageSummaryCardProps) {
  // Two clusters are "the same active filter" iff their case_ids match by set.
  const isActive = React.useCallback(
    (ids: string[]) =>
      activeCaseIds != null &&
      activeCaseIds.length === ids.length &&
      ids.every((id) => activeCaseIds.includes(id)),
    [activeCaseIds],
  )

  return (
    <div className="animate-fade-up rounded-md border border-border bg-card/60 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] font-semibold tracking-tight text-foreground">
          Run summary
        </span>
        <Button
          size="xs"
          variant={discussing ? 'default' : 'outline'}
          className="ml-auto"
          onClick={onDiscuss}
        >
          <MessageSquare className="h-3 w-3" />
          Discuss this run
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-foreground/90">{triage.summary}</p>

      {triage.clusters.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {triage.clusters.map((c, i) => {
            const active = isActive(c.case_ids)
            return (
              <button
                key={`${c.title}-${i}`}
                type="button"
                onClick={() => onToggleCluster(active ? null : c.case_ids)}
                title={c.root_cause}
                className={cn(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-all duration-150',
                  chipClasses(c.suggested_action, active),
                )}
              >
                <span className="truncate max-w-[160px]">{c.title}</span>
                <span className="font-mono opacity-80">{c.case_ids.length}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
