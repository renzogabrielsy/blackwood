'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, Copy, HandHelping, Loader2, Sparkles } from 'lucide-react'

import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  metaFor,
  type AdjudicationVerdict,
  type HeldKind,
  type HeldRow,
} from '@/app/(app)/sync/types'
import type { HeldGroup } from './useSyncRun'

/**
 * A short, plant-floor phrase per held kind — what the operator sees as the tag on each
 * row. The raw kind stays available via `title` (tooltip) for debugging. Keep these
 * compact (they render as a small badge) and jargon-free.
 */
const KIND_LABEL: Record<HeldKind, string> = {
  sub_watermark_suspected_dup: 'Possible duplicate feeding',
  cross_batch_reassignment: 'Same load, different batch',
  unmapped_batch_code: 'Unknown batch code',
  unmapped_bag_type_code: 'Unknown bag type',
  location_occupied: 'Slot already occupied',
  malformed: 'Missing / bad data',
  low_confidence: 'Needs a second look',
  already_exists: 'Already saved',
  gate_failure: "Totals don't match — nothing saved",
  unmapped_or_missing_columns: 'Unknown bag-type column',
  below_since_floor: 'Older than the sync window',
  unresolved_shift: "Shift couldn't be matched",
  unresolved_batch_id: 'Unknown batch code',
  flagged: 'Set aside for review',
  other: 'Set aside for review',
}

/** The human tag for a held row — its kind's phrase, else the raw reason. */
function heldTagLabel(row: HeldRow): string {
  return row.kind ? KIND_LABEL[row.kind] : row.reason
}

interface HeldRowsProps {
  groups: HeldGroup[]
  onAdjudicate: (type: HeldGroup['type']) => void
}

const VERDICT_STYLE: Record<AdjudicationVerdict, string> = {
  apply: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  skip: 'bg-muted text-muted-foreground',
  'needs-human': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

function copyRow(row: HeldRow) {
  const parts = [
    row.natural_key,
    `kind: ${row.kind ?? 'other'}`,
    `reason: ${row.reason}`,
    row.detail,
    row.row ? `row: ${JSON.stringify(row.row)}` : '',
  ].filter(Boolean)
  void navigator.clipboard.writeText(parts.join('\n')).then(() => {
    toast.success('Row detail copied', { duration: 2000 })
  })
}

export function HeldRows({ groups, onAdjudicate }: HeldRowsProps) {
  if (groups.length === 0) return null

  const total = groups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <div className="animate-fade-up border-t border-border px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <HandHelping className="h-3.5 w-3.5 text-orange-500" />
        <h3 className="text-xs font-semibold tracking-tight text-foreground">
          Held for review
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground">({total})</span>
      </div>

      <p className="mb-2 text-[10px] leading-snug text-muted-foreground">
        These rows need judgment and were <span className="font-medium">not written</span>. Ask
        Claude for a recommendation, then apply via the sync employee in Claude Code — the app
        does not write held rows in v1.
      </p>

      <div className="space-y-2.5">
        {groups.map((group) => {
          const meta = metaFor(group.type)
          const recByKey = new Map(
            (group.recommendations ?? []).map((r) => [r.natural_key, r])
          )
          return (
            <div key={group.type} className="rounded-md border border-border bg-card/50 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-foreground">{meta.label}</span>
                <div className="flex items-center gap-1.5">
                  <Link
                    href="/sync/cases"
                    className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Open in Sync Review
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={group.adjudicating}
                    onClick={() => onAdjudicate(group.type)}
                  >
                    {group.adjudicating ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {group.recommendations ? 'Re-ask Claude' : 'Ask Claude'}
                  </Button>
                </div>
              </div>

              <ul className="space-y-1.5">
                {group.rows.map((row) => {
                  const rec = recByKey.get(row.natural_key)
                  return (
                    <li
                      key={row.natural_key}
                      className="rounded border border-border/70 bg-background/60 p-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {/* Descriptive human heading (was a raw row index). */}
                          <p className="truncate font-mono text-[11px] font-medium text-foreground">
                            {row.natural_key}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span
                              title={row.kind ?? row.reason}
                              className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              {heldTagLabel(row)}
                            </span>
                            {rec && (
                              <span
                                className={cn(
                                  'rounded px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide',
                                  VERDICT_STYLE[rec.verdict]
                                )}
                              >
                                {rec.verdict}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                            {row.detail}
                          </p>
                          {rec && rec.reason && (
                            <p className="mt-1 text-[10px] leading-snug text-foreground/80">
                              <span className="font-medium">Claude:</span> {rec.reason}
                            </p>
                          )}
                          {rec?.evidence && (
                            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/90">
                              <span className="font-medium">DB:</span> {rec.evidence}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => copyRow(row)}
                          title="Copy row detail"
                          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
