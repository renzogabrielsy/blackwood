'use client'

import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Lock,
  MinusCircle,
} from 'lucide-react'

import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { metaFor, type SyncCardState } from '@/app/(app)/sync/types'

interface SyncEmployeeCardProps {
  card: SyncCardState
}

/** Small right-aligned mono count chip. */
function Count({ label, value, tone }: { label: string; value: number; tone?: 'insert' | 'update' | 'flag' }) {
  if (value === 0) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
        tone === 'insert' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        tone === 'update' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        tone === 'flag' && 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
        !tone && 'bg-muted text-muted-foreground'
      )}
    >
      <span>{value.toLocaleString()}</span>
      <span className="uppercase tracking-wide opacity-70">{label}</span>
    </span>
  )
}

export function SyncEmployeeCard({ card }: SyncEmployeeCardProps) {
  const meta = metaFor(card.type)
  const { status, classify, apply, error } = card

  const copyError = React.useCallback(() => {
    if (!error) return
    void navigator.clipboard.writeText(error).then(() => {
      toast.success('Error copied to clipboard', { duration: 2000 })
    })
  }, [error])

  const isBusy = status === 'classifying' || status === 'applying'
  const isBad = status === 'gate-failed' || status === 'error'

  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2 text-xs transition-colors duration-150',
        isBad
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-border bg-card/60',
        status === 'done' && 'border-border/80'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground truncate">{meta.label}</span>
            {meta.readOnly && (
              <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-label="read-only" />
            )}
          </div>
          <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground truncate">
            {meta.blurb}
          </p>
        </div>

        {/* Status indicator */}
        <div className="shrink-0 pt-0.5">
          {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {isBad && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
          {status === 'idle' && <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/40" />}
        </div>
      </div>

      {/* Busy label */}
      {isBusy && (
        <p className="mt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {status === 'classifying' ? 'Classifying…' : 'Applying clean rows…'}
        </p>
      )}

      {/* Counts (classify) */}
      {classify && !isBusy && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Count label="new" value={classify.counts.insert} tone="insert" />
          <Count label="upd" value={classify.counts.update} tone="update" />
          <Count label="flag" value={classify.counts.flagged} tone="flag" />
          {classify.counts.insert === 0 &&
            classify.counts.update === 0 &&
            classify.counts.flagged === 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {classify.counts.noop.toLocaleString()} up to date
              </span>
            )}
        </div>
      )}

      {/* Applied summary */}
      {apply && (apply.applied.inserts > 0 || apply.applied.updates > 0 || apply.applied.replaced_dates.length > 0) && (
        <p className="mt-1 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
          applied {apply.applied.inserts} new
          {apply.applied.updates > 0 && `, ${apply.applied.updates} updated`}
          {apply.applied.replaced_dates.length > 0 &&
            `, ${apply.applied.replaced_dates.length} day(s) replaced`}
          {apply.labeled && ' · labeled'}
        </p>
      )}

      {/* Held note (details live in the Held section below) */}
      {apply && apply.held.length > 0 && (
        <p className="mt-1 text-[10px] text-orange-600 dark:text-orange-400">
          {apply.held.length} row{apply.held.length === 1 ? '' : 's'} held for review — see below.
        </p>
      )}

      {/* Inline error block with Copy (HARD RULE) */}
      {isBad && error && (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
              {status === 'gate-failed' ? 'Gate failed — writes halted' : 'Error'}
            </span>
            <button
              type="button"
              onClick={copyError}
              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-destructive underline hover:no-underline"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-destructive/90">
            {error}
          </pre>
        </div>
      )}
    </div>
  )
}
