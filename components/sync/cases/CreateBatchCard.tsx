'use client'

import * as React from 'react'
import { AlertTriangle, Check, Loader2, PackagePlus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FEED_LOCATION_REF, type CreateBatchPlan } from '@/lib/sync/create-batch-plan'

/**
 * CreateBatchCard — the human-confirmed "create this batch" resolution of an
 * `unmapped_batch_code` / `unresolved_batch` case (the ONE sanctioned exception to
 * "never auto-create a batch"). Mirrors SourceDiffCard's propose→confirm shape:
 *
 *   1. No open proposal yet → show the derived batch (code + fields + the row it will
 *      write) as a PREVIEW, with a "Create this batch" button → onCreate (proposeCreateBatch).
 *   2. An open proposal exists (restored from the transcript by the parent) → the SAME
 *      readout becomes a confirm card: Confirm → executeCreateBatch, Decline → cancelProposal.
 *
 * Presentation-only + client-safe: imports the PURE plan type + the FEED marker from
 * create-batch-plan.ts (never a server-only module). All three server steps live in the
 * parent (CasesClient); errors there go through errorToast (persist + Copy).
 */

interface CreateBatchCardProps {
  /** The plan to render — the persisted open proposal's plan, or the client-computed preview. */
  plan: CreateBatchPlan
  /** True when this plan is the OPEN, persisted proposal (→ confirm mode). */
  hasOpenProposal: boolean
  /** Propose creating the batch (→ proposeCreateBatch). */
  onCreate: () => Promise<void>
  /** Confirm the open proposal (→ executeCreateBatch). */
  onConfirm: () => Promise<void>
  /** Decline the open proposal (→ cancelProposal). */
  onDecline: () => Promise<void>
  /** True while a propose/confirm/decline server action is in flight. */
  pending: boolean
  /** True while the case is investigating (locks the controls). */
  busy: boolean
  /** Resolved cases render read-only. */
  isResolved: boolean
}

function fmtKg(v: unknown): string {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${Math.round(n).toLocaleString('en-US')}`
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/** A dense key/value readout row. */
function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value == null || value === '') return null
  return (
    <tr className="border-t border-border/60 first:border-t-0">
      <td className="w-[130px] bg-muted/40 px-2 py-1 text-left align-top text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </td>
      <td
        className={cn('px-2 py-1 text-left align-top text-foreground', mono && 'font-mono tabular-nums')}
      >
        {value}
      </td>
    </tr>
  )
}

/** The row the writer will re-attempt, as a compact readout (identity fields only, never ₱). */
function UnblockRow({ plan }: { plan: CreateBatchPlan }) {
  const row = (plan.unblock ?? {}) as Record<string, unknown>
  const date = str(row.transaction_date)
  const block = str(row.block_loc)
  const dest = str(row.destination)
  const supplier = str(row.supplier)
  const weight = row.weight_kg
  const laneLabel =
    plan.writerLane === 'deliveries'
      ? 'Delivery (RC IN)'
      : plan.writerLane === 'rc_out'
        ? 'Feeding (RC OUT)'
        : '—'

  return (
    <div className="mt-2 overflow-hidden rounded border border-border">
      <div className="bg-muted/50 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Row it will write · {laneLabel}
      </div>
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          <Field label="Date" value={date} mono />
          <Field label="Supplier" value={supplier} />
          <Field label="Block" value={block} mono />
          <Field label="Destination" value={dest && dest !== 'MAIN' ? dest : null} mono />
          <Field label="Weight" value={weight != null ? `${fmtKg(weight)} kg` : null} mono />
        </tbody>
      </table>
    </div>
  )
}

export function CreateBatchCard({
  plan,
  hasOpenProposal,
  onCreate,
  onConfirm,
  onDecline,
  pending,
  busy,
  isResolved,
}: CreateBatchCardProps) {
  const disabled = busy || pending || isResolved
  const willWriteRow = !plan.ambiguous && plan.unblock != null && plan.writerLane != null

  return (
    <div className="animate-fade-up rounded-md border border-border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
          <PackagePlus className="h-3 w-3" />
          Create this batch
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {hasOpenProposal ? 'Waiting for your confirmation' : 'The one sanctioned way to add a batch'}
        </span>
      </div>

      <h3 className="mt-2 font-mono text-sm font-semibold text-foreground">{plan.batch_code}</h3>

      {/* Derived batch fields — exactly what will be inserted. */}
      <div className="mt-2 overflow-hidden rounded border border-border">
        <div className="bg-muted/50 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          New batch
        </div>
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            <Field label="Batch code" value={plan.fields.batch_code} mono />
            <Field
              label="Location"
              value={
                plan.isFeed ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono">{FEED_LOCATION_REF}</span>
                    <span className="rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      feed batch
                    </span>
                  </span>
                ) : (
                  plan.fields.location_ref
                )
              }
              mono={!plan.isFeed}
            />
            <Field label="Status" value={plan.fields.status} mono />
            <Field label="Starting weight" value={`${fmtKg(plan.fields.current_weight)} kg`} mono />
            <Field label="Cost" value="Unpriced (pricing is email-side)" />
          </tbody>
        </table>
      </div>

      {/* What row (if any) this create unblocks. */}
      {willWriteRow ? (
        <UnblockRow plan={plan} />
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            {plan.note ??
              'This creates the batch only — the row(s) that reference it will write on the next sync.'}
          </span>
        </p>
      )}

      {willWriteRow && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          This creates the batch and saves the row above. It cannot be undone from here.
        </p>
      )}

      {/* Controls: propose (create mode) or confirm/decline (open-proposal mode). */}
      {!isResolved && (
        <div className="mt-3 flex items-center gap-2">
          {hasOpenProposal ? (
            <>
              <Button size="sm" variant="destructive" disabled={pending || busy} onClick={() => void onConfirm()}>
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Confirm — create batch
              </Button>
              <Button size="sm" variant="outline" disabled={pending || busy} onClick={() => void onDecline()}>
                <X className="h-3.5 w-3.5" />
                Decline
              </Button>
            </>
          ) : (
            <Button size="sm" variant="default" disabled={disabled} onClick={() => void onCreate()}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="h-3.5 w-3.5" />}
              Create this batch
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
