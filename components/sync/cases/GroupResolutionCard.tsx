'use client'

import * as React from 'react'
import { Check, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { OpenGroupProposal } from '@/lib/investigator/resolution'
import { kindLabel } from './labels'

/** The minimal per-case facts the card needs to render a group member row. */
export interface GroupMemberCase {
  id: string
  natural_key: string
  kind: string
}

interface GroupResolutionCardProps {
  open: OpenGroupProposal
  /** The run family's cases (to resolve each proposed id → a readable row). */
  members: GroupMemberCase[]
  onConfirm: () => Promise<void>
  onDecline: () => Promise<void>
  pending: boolean
}

/**
 * The confirm-gated GROUP resolution card (v1.1 Run Triage). Rendered in the triage
 * case's thread when findOpenGroupProposal detects an open propose_group_resolution.
 * Group proposals are dismiss-only in v1, so the action badge is always "Dismiss N
 * flags". Lists the affected cases as compact rows (natural_key + kind label). Confirm
 * fires executeGroupResolution; Decline fires cancelProposal.
 */
export function GroupResolutionCard({
  open,
  members,
  onConfirm,
  onDecline,
  pending,
}: GroupResolutionCardProps) {
  const { proposal } = open
  const byId = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const n = proposal.case_ids.length

  return (
    <div className="animate-fade-up rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          Proposed group resolution · Dismiss {n} {n === 1 ? 'flag' : 'flags'}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
          Waiting for your confirmation
        </span>
      </div>

      <p className="mt-2 text-sm font-medium leading-relaxed text-foreground">{proposal.summary}</p>
      {proposal.reasoning && proposal.reasoning !== proposal.summary && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{proposal.reasoning}</p>
      )}

      <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Flag</th>
              <th className="px-2 py-1 text-left font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {proposal.case_ids.map((id) => {
              const m = byId.get(id)
              return (
                <tr key={id} className="border-t border-border/60">
                  <td className="px-2 py-1 font-mono text-foreground">
                    {m?.natural_key ?? id}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {m ? kindLabel(m.kind) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400">
        Dismissing sets each flag aside with no change to any operational data.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => void onConfirm()}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Confirm dismiss {n} {n === 1 ? 'flag' : 'flags'}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void onDecline()}>
          <X className="h-3.5 w-3.5" />
          Decline
        </Button>
      </div>
    </div>
  )
}
