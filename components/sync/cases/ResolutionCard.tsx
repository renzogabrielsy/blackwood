'use client'

import * as React from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OpenProposal } from '@/lib/investigator/resolution'

interface ResolutionCardProps {
  open: OpenProposal
  /** The case's own set-aside row (for the old→new diff on edit_apply). */
  caseRow: unknown
  onConfirm: () => Promise<void>
  onDecline: () => Promise<void>
  pending: boolean
}

/** Badge copy per action — plain, matches the plant-floor voice. */
const ACTION_META: Record<
  OpenProposal['proposal']['action'],
  { label: string; destructive: boolean; className: string }
> = {
  dismiss: {
    label: 'Dismiss',
    destructive: false,
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  apply: {
    label: 'Apply row',
    destructive: true,
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  edit_apply: {
    label: 'Apply edited row',
    destructive: true,
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
}

function fmtValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * The confirm-gated resolution card. Rendered in the thread when the case has an
 * OPEN proposal (computed via findOpenProposal). Shows the action, the plain summary,
 * and — for edit_apply — a field:value table of the EXACT row that will be written,
 * with old→new highlighting for fields the edit changed. Confirm fires
 * executeResolution; Decline fires cancelProposal.
 */
export function ResolutionCard({ open, caseRow, onConfirm, onDecline, pending }: ResolutionCardProps) {
  const { proposal } = open
  const meta = ACTION_META[proposal.action]

  const edited = proposal.action === 'edit_apply' ? asObj(proposal.edited_row) : null
  const original = asObj(caseRow)

  // Union of keys to render for the edit table (edited row is the source of truth).
  const editKeys = edited ? Object.keys(edited) : []

  return (
    <div
      className={cn(
        'animate-fade-up rounded-md border p-3',
        meta.destructive
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-emerald-500/40 bg-emerald-500/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', meta.className)}>
          Proposed resolution · {meta.label}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
          Waiting for your confirmation
        </span>
      </div>

      <p className="mt-2 text-sm font-medium leading-relaxed text-foreground">{proposal.summary}</p>
      {proposal.reasoning && proposal.reasoning !== proposal.summary && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{proposal.reasoning}</p>
      )}

      {edited && editKeys.length > 0 && (
        <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
          <table className="w-full border-collapse text-[11px]">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Field</th>
                <th className="px-2 py-1 text-left font-medium">Value to save</th>
              </tr>
            </thead>
            <tbody>
              {editKeys.map((k) => {
                const newV = edited[k]
                const oldV = original[k]
                const changed = k in original && fmtValue(oldV) !== fmtValue(newV)
                return (
                  <tr key={k} className="border-t border-border/60">
                    <td className="px-2 py-1 font-mono text-muted-foreground">{k}</td>
                    <td className="px-2 py-1 font-mono">
                      {changed ? (
                        <span>
                          <span className="text-muted-foreground/60 line-through">{fmtValue(oldV)}</span>{' '}
                          <span className="font-semibold text-amber-600 dark:text-amber-400">
                            {fmtValue(newV)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-foreground">{fmtValue(newV)}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {meta.destructive && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          This saves a row to the database. It cannot be undone from here.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant={meta.destructive ? 'destructive' : 'default'}
          disabled={pending}
          onClick={() => void onConfirm()}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Confirm {meta.label.toLowerCase()}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void onDecline()}>
          <X className="h-3.5 w-3.5" />
          Decline
        </Button>
      </div>
    </div>
  )
}
