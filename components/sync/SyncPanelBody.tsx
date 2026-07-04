'use client'

import * as React from 'react'
import { FlaskConical, Play, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SYNC_REPORTS, type SyncReportType } from '@/app/(app)/sync/types'
import { SyncEmployeeCard } from './SyncEmployeeCard'
import { HeldRows } from './HeldRows'
import type { SyncRunState } from './useSyncRun'

interface SyncPanelBodyProps {
  state: SyncRunState
  run: (opts?: { dryRun?: boolean }) => void | Promise<void>
  adjudicate: (type: SyncReportType) => void
}

/**
 * The reusable Daily Sync panel content — written ONCE and shared by both the
 * (dormant) slide-out Sheet (`SyncPanel.tsx`) and the dashboard modal
 * (`SyncLauncher.tsx`). It is intentionally chrome-agnostic: no Sheet/Dialog
 * header of its own — the wrapping surface owns the title bar and close button.
 *
 * State is passed in (not owned here) so the launcher can LIFT `useSyncRun`
 * above the modal boundary — a run keeps streaming while the modal is closed,
 * and reopening shows it still live.
 */
/** HH:MM local time from an ISO timestamp, for the "already running since" note. */
function formatStarted(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function SyncPanelBody({ state, run, adjudicate }: SyncPanelBodyProps) {
  const idle = !state.running && !state.ran

  return (
    <div className="flex flex-col gap-0">
      {/* Run buttons: full run + a deliberate dry-run (classify-only). */}
      <div className="flex-none px-1 py-2.5">
        {/* Attached-to-in-flight-run banner (multi-viewer / reopen / post-refresh). */}
        {state.attached && state.running && (
          <p className="mb-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-[10px] leading-snug text-foreground/90">
            A sync is already running{state.startedAt ? ` (started ${formatStarted(state.startedAt)})` : ''}
            {' '}— watching it live.
          </p>
        )}

        <div className="flex items-stretch gap-2">
          <Button
            type="button"
            className="flex-1"
            disabled={state.running}
            onClick={() => void run()}
          >
            {state.running ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Running sync…
              </>
            ) : state.ran ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Run again
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run Sync
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={state.running}
            onClick={() => void run({ dryRun: true })}
            title="Classify only — reads the reports and shows what WOULD change, writes nothing."
          >
            <FlaskConical className="h-4 w-4" />
            Dry run
          </Button>
        </div>

        {/* Non-fatal notice (e.g. "worker asleep — queued"). */}
        {state.notice && (
          <p className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
            {state.notice}
          </p>
        )}

        {/* Overall (top-level workflow) progress line while running. */}
        {state.running && state.overall.label && (
          <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-muted-foreground tabular-nums">
            {state.overall.label}
          </p>
        )}

        {idle && (
          <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-muted-foreground">
            Classifies every report in parallel, auto-applies the clean rows, and holds anything
            that needs your judgment. <span className="font-medium">Dry run</span> classifies only —
            it writes nothing.
          </p>
        )}
      </div>

      {/* Employee cards */}
      <div className="flex-1 min-h-0 px-1 py-2.5 space-y-2">
        {SYNC_REPORTS.map((meta) => (
          <SyncEmployeeCard key={meta.type} card={state.cards[meta.type]} />
        ))}

        {/* Held rows */}
        <HeldRows groups={state.heldGroups} onAdjudicate={adjudicate} />
      </div>

      {/* Summary footer */}
      <div className="flex-none border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-1 pt-2.5">
        {state.summarizing ? (
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Summarizing the run…
          </p>
        ) : state.summary ? (
          <p className="animate-fade-up text-[11px] leading-snug text-foreground/90">
            {state.summary}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground/70">
            Run summary appears here once the sync completes.
          </p>
        )}
      </div>
    </div>
  )
}
