'use client'

import * as React from 'react'
import { AlertTriangle, Check, Loader2, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  DiffPlanStep,
  DiffWritePlan,
} from '@/app/(app)/sync/diff-plan'
import type { RcOutSource, SourceDiff, SourceOpinion } from '@/app/(app)/sync/types'

/**
 * SourceDiffCard — R3b of the Sync Reconciliation Model.
 *
 * Rendered by CaseDetail when the selected case is `kind='source_diff'`. It shows the
 * competing source opinions for one reconciled field at one natural key, lets the
 * reviewer PICK which source's value becomes authoritative, and — on a pick — renders
 * the server-computed write plan inline as a confirm card (the same visual language as
 * ResolutionCard) before anything is written.
 *
 * All three server steps live in the parent (CasesClient): `onPick` → proposePickSource,
 * `onConfirm` → executeDiffResolution, `onDecline` → cancelProposal. This component is
 * presentation-only: it imports pure types from diff-plan.ts (client-safe) and NEVER the
 * server-only lib/investigator/resolution module. The open pick plan is restored from the
 * live transcript by the parent (findOpenPickSourcePlan), so a pending, un-confirmed pick
 * re-renders after a reload with no local state to lose.
 *
 * Recommendation is ADVISORY — the emerald ring + note say "recommended — you decide".
 */

/** Human label per rc_out reconciliation source (tenant-neutral). */
const SOURCE_LABEL: Record<RcOutSource, string> = {
  proposed: 'Proposed report',
  gsheet: 'Google Sheet',
  movement: 'Movement sheet',
}

function sourceLabel(source: RcOutSource | string): string {
  return SOURCE_LABEL[source as RcOutSource] ?? source
}

/** Format an integer kg value with thousands separators (right-aligned, font-mono). */
function fmtKg(v: unknown): string {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${Math.round(n).toLocaleString('en-US')}`
}

/** Render a source opinion's competing value (kg number, or a raw string, or —). */
function fmtOpinionValue(v: SourceOpinion['value']): string {
  if (v == null) return '—'
  if (typeof v === 'number') return fmtKg(v)
  return String(v)
}

/** Short human label per plan-step op (no numbers — the numeric columns carry those). */
const OP_META: Record<DiffPlanStep['op'], { label: string; className: string }> = {
  noop: { label: 'Keep', className: 'bg-muted text-muted-foreground' },
  edit: { label: 'Correct', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  insert: { label: 'Add', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  remove: { label: 'Zero out', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
}

/** A plain leg label for a plan step's feeding (batch @ block → dest). */
function stepLegLabel(step: DiffPlanStep): string {
  if (step.leg) {
    const parts = [step.leg.batch_code ?? '(no batch)']
    if (step.leg.block_loc) parts.push(`@ ${step.leg.block_loc}`)
    if (step.leg.destination && step.leg.destination !== 'MAIN') {
      parts.push(`→ ${step.leg.destination}`)
    }
    return parts.join(' ')
  }
  return step.op === 'remove' ? 'Over-stated feeding' : 'Feeding'
}

/** Safely narrow an unknown case row into a SourceDiff (or null). */
export function asSourceDiff(row: unknown): SourceDiff | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (!o.naturalKey || typeof o.naturalKey !== 'object') return null
  if (typeof o.field !== 'string') return null
  if (!Array.isArray(o.sources)) return null
  const sources = (o.sources as unknown[]).filter(
    (s): s is SourceOpinion =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as Record<string, unknown>).source === 'string',
  )
  if (sources.length === 0) return null
  return o as unknown as SourceDiff
}

/** The open, persisted pick plan restored from the transcript (parent-computed). */
export interface OpenPickPlan {
  source: RcOutSource
  plan: DiffWritePlan
}

interface SourceDiffCardProps {
  diff: SourceDiff
  /** The case's human natural-key label (e.g. "MARCH-26-BLK5 @ D-11B · 2026-06-10 · weight"). */
  naturalKeyLabel: string
  /** The open, un-confirmed pick plan (restored from the live transcript), or null. */
  openPlan: OpenPickPlan | null
  /** Propose picking a source (→ proposePickSource). Resolves when the proposal is saved. */
  onPick: (source: RcOutSource) => Promise<void>
  /** Confirm the open pick plan (→ executeDiffResolution). */
  onConfirm: () => Promise<void>
  /** Decline the open pick plan (→ cancelProposal). */
  onDecline: () => Promise<void>
  /** True while a confirm/decline server action is in flight. */
  pending: boolean
  /** True while the case is investigating (locks the pick controls). */
  busy: boolean
  /** Resolved cases render read-only (no pick controls, no confirm card). */
  isResolved: boolean
}

/**
 * The comparison table: one row per competing source, with value (kg, font-mono,
 * right-aligned), a self-consistency chip, a corroboration chip, provenance (truncated +
 * tooltip), and — when no plan is open — a per-source "Use this value" pick button. The
 * recommended source's row carries a subtle emerald ring + a "Recommended" badge.
 */
function ComparisonTable({
  diff,
  onPick,
  proposingSource,
  disabled,
  showPickColumn,
  chosenSource,
}: {
  diff: SourceDiff
  onPick: (source: RcOutSource) => void
  proposingSource: RcOutSource | null
  disabled: boolean
  showPickColumn: boolean
  chosenSource: RcOutSource | null
}) {
  const recommended = diff.recommended?.source ?? null

  return (
    <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
      <table className="w-full table-fixed border-collapse text-[11px]">
        <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-[130px] px-2 py-1 text-left font-medium">Source</th>
            <th className="w-[92px] px-2 py-1 text-right font-medium">Value (kg)</th>
            <th className="w-[84px] px-2 py-1 text-center font-medium">Consistent</th>
            <th className="w-[120px] px-2 py-1 text-left font-medium">Corroborated</th>
            <th className="px-2 py-1 text-left font-medium">Provenance</th>
            {showPickColumn && <th className="w-[104px] px-2 py-1 text-right font-medium">Pick</th>}
          </tr>
        </thead>
        <tbody>
          {diff.sources.map((s) => {
            const isRecommended = recommended === s.source
            const isChosen = chosenSource === s.source
            return (
              <tr
                key={s.source}
                className={cn(
                  'border-t border-border/60 align-top',
                  isRecommended && 'bg-emerald-500/5 ring-1 ring-inset ring-emerald-500/40',
                  isChosen && !isRecommended && 'bg-amber-500/5 ring-1 ring-inset ring-amber-500/40',
                )}
              >
                <td className="px-2 py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-medium text-foreground">{sourceLabel(s.source)}</span>
                    {isRecommended && (
                      <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        Recommended
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                  {fmtOpinionValue(s.value)}
                </td>
                <td className="px-2 py-1 text-center">
                  {s.selfConsistent ? (
                    <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-2.5 w-2.5" />
                      OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 rounded bg-red-500/15 px-1 py-px text-[10px] font-medium text-red-600 dark:text-red-400">
                      <X className="h-2.5 w-2.5" />
                      Fails
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {s.corroboratedBy.length > 0 ? (
                    <span className="inline-flex rounded bg-emerald-500/10 px-1 py-px text-[10px] text-emerald-700 dark:text-emerald-400">
                      by {s.corroboratedBy.map(sourceLabel).join(', ')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className="px-2 py-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block max-w-[200px] cursor-default truncate text-muted-foreground">
                        {s.provenance || '—'}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[320px] text-xs">
                      {s.provenance || 'No provenance recorded.'}
                    </TooltipContent>
                  </Tooltip>
                </td>
                {showPickColumn && (
                  <td className="px-2 py-1 text-right">
                    <Button
                      size="xs"
                      variant={isRecommended ? 'default' : 'outline'}
                      disabled={disabled}
                      onClick={() => onPick(s.source)}
                    >
                      {proposingSource === s.source ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                      Use this
                    </Button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The confirm card — the server-computed DiffWritePlan rendered inline (ResolutionCard's
 * visual language). Lists each step (op badge + feeding + before→after kg, font-mono),
 * the current→resulting block/day sum, and — on a clean plan — a destructive Confirm.
 * An AMBIGUOUS plan shows NO Confirm: it routes the reviewer to edit-then-apply in chat.
 */
function PickPlanConfirm({
  source,
  plan,
  onConfirm,
  onDecline,
  pending,
}: {
  source: RcOutSource
  plan: DiffWritePlan
  onConfirm: () => Promise<void>
  onDecline: () => Promise<void>
  pending: boolean
}) {
  const ambiguous = plan.ambiguous
  const changes = plan.steps.filter((s) => s.op !== 'noop')

  return (
    <div
      className={cn(
        'animate-fade-up mt-3 rounded-md border p-3',
        ambiguous
          ? 'border-red-500/40 bg-red-500/5'
          : plan.hasChanges
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-emerald-500/40 bg-emerald-500/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-medium',
            ambiguous
              ? 'bg-red-500/15 text-red-600 dark:text-red-400'
              : plan.hasChanges
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
          )}
        >
          Proposed resolution · Pick {sourceLabel(source)}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
          {ambiguous ? 'Cannot auto-apply' : 'Waiting for your confirmation'}
        </span>
      </div>

      {ambiguous ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The feedings don&apos;t map cleanly onto {sourceLabel(source)}, so it isn&apos;t
            safe to guess which leg becomes which.{' '}
            {plan.suggestion ? <span className="text-muted-foreground">{plan.suggestion} </span> : null}
            Use the chat below to edit the exact rows (edit-then-apply).
          </span>
        </p>
      ) : (
        <>
          {changes.length > 0 ? (
            <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
              <table className="w-full table-fixed border-collapse text-[11px]">
                <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-[76px] px-2 py-1 text-left font-medium">Change</th>
                    <th className="px-2 py-1 text-left font-medium">Feeding</th>
                    <th className="w-[84px] px-2 py-1 text-right font-medium">Before</th>
                    <th className="w-[84px] px-2 py-1 text-right font-medium">After</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((step, i) => {
                    const meta = OP_META[step.op]
                    const before = step.from_weight_kg
                    const after =
                      step.op === 'remove' ? 0 : step.op === 'insert' || step.op === 'edit' ? step.to_weight_kg : step.from_weight_kg
                    return (
                      <tr key={`${step.op}-${step.db_id ?? i}`} className="border-t border-border/60">
                        <td className="px-2 py-1">
                          <span className={cn('rounded px-1 py-px text-[10px] font-medium', meta.className)}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-2 py-1 font-mono text-foreground">{stepLegLabel(step)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {step.op === 'insert' ? '—' : fmtKg(before)}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-1 text-right font-mono tabular-nums',
                            step.op === 'noop' ? 'text-muted-foreground' : 'font-semibold text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {fmtKg(after)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
              {sourceLabel(source)} already matches the database exactly — picking this records the
              decision; no feeding changes.
            </p>
          )}

          <div className="mt-2 flex items-center justify-between rounded border border-border/70 bg-background/50 px-2 py-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Block / day total
            </span>
            <span className="font-mono text-xs tabular-nums text-foreground">
              <span className="text-muted-foreground/70">{fmtKg(plan.currentSumKg)}</span>
              {' → '}
              <span className="font-semibold">{fmtKg(plan.resultingSumKg)}</span>
              <span className="ml-1 text-muted-foreground"> kg</span>
            </span>
          </div>

          {plan.hasChanges && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              This saves feedings to the database. It cannot be undone from here.
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex items-center gap-2">
        {!ambiguous && (
          <Button
            size="sm"
            variant={plan.hasChanges ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Confirm pick
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void onDecline()}>
          <X className="h-3.5 w-3.5" />
          {ambiguous ? 'Dismiss this plan' : 'Decline'}
        </Button>
      </div>
    </div>
  )
}

export function SourceDiffCard({
  diff,
  naturalKeyLabel,
  openPlan,
  onPick,
  onConfirm,
  onDecline,
  pending,
  busy,
  isResolved,
}: SourceDiffCardProps) {
  // Which source's "Use this value" button is mid-propose (local — the confirm card,
  // once the plan lands in the transcript, is driven by `openPlan` from the parent).
  const [proposingSource, setProposingSource] = React.useState<RcOutSource | null>(null)

  const handlePick = React.useCallback(
    (source: RcOutSource) => {
      setProposingSource(source)
      void onPick(source).finally(() => setProposingSource(null))
    },
    [onPick],
  )

  const hasOpenPlan = !!openPlan && !isResolved
  const proposing = proposingSource !== null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="animate-fade-up rounded-md border border-border bg-card/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
            Sources disagree
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Pick the value that&apos;s right — you decide
          </span>
        </div>

        <h3 className="mt-2 font-mono text-sm font-semibold text-foreground">{naturalKeyLabel}</h3>

        {diff.recommended && (
          <p className="mt-1.5 flex items-start gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-400">
            <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              <span className="font-medium">Recommended — you decide: </span>
              pick {sourceLabel(diff.recommended.source)}. {diff.recommended.why}
            </span>
          </p>
        )}

        <ComparisonTable
          diff={diff}
          onPick={handlePick}
          proposingSource={proposingSource}
          disabled={busy || pending || proposing || hasOpenPlan || isResolved}
          showPickColumn={!hasOpenPlan && !isResolved}
          chosenSource={openPlan?.source ?? null}
        />

        {hasOpenPlan && openPlan && (
          <PickPlanConfirm
            source={openPlan.source}
            plan={openPlan.plan}
            onConfirm={onConfirm}
            onDecline={onDecline}
            pending={pending}
          />
        )}
      </div>
    </TooltipProvider>
  )
}
