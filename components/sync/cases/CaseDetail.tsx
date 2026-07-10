'use client'

import * as React from 'react'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCw,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OpenGroupProposal, OpenProposal } from '@/lib/investigator/resolution'
import {
  asVerdict,
  CONFIDENCE_CLASS,
  CONFIDENCE_LABEL,
  kindLabel,
  STATUS_CHIP,
  VERDICT_BADGE,
} from './labels'
import { CaseThread, type ThreadMessage } from './CaseThread'
import { CaseChatInput } from './CaseChatInput'
import { ResolutionCard } from './ResolutionCard'
import { GroupResolutionCard, type GroupMemberCase } from './GroupResolutionCard'
import { SourceDiffCard, type OpenPickPlan } from './SourceDiffCard'
import { CaseFindingDetail } from './FindingDetailCards'
import { CreateBatchCard } from './CreateBatchCard'
import { buildCreateBatchPlan, type CreateBatchPlan } from '@/lib/sync/create-batch-plan'
import type { RcOutSource, SourceDiff, SyncReportType } from '@/app/(app)/sync/types'

/** The full case row the detail pane renders (superset of the list row). */
export interface CaseDetailRow {
  id: string
  report_type: string
  kind: string
  natural_key: string
  reason: string | null
  detail: string | null
  row: unknown
  status: string
  occurrence_count: number
  known_ruling_id: string | null
  known_ruling_summary?: string | null
  verdict: unknown
}

interface CaseDetailProps {
  theCase: CaseDetailRow
  messages: ThreadMessage[]
  /** True while a run/investigation is in flight (status 'investigating'). */
  busy: boolean
  onInvestigate: () => void
  onReinvestigate: () => void
  onEscalate: () => void
  onSend: (text: string) => Promise<void>
  chatPending: boolean
  /** The open resolution proposal (P5), or null. Computed from the transcript. */
  openProposal: OpenProposal | null
  onConfirmResolution: () => Promise<void>
  onDeclineResolution: () => Promise<void>
  /** True while a resolve/decline/quick-dismiss server action is in flight. */
  resolvePending: boolean
  onQuickDismiss: () => void
  /** The open GROUP resolution proposal (v1.1), or null — only for a triage case. */
  openGroupProposal: OpenGroupProposal | null
  /** The run family's cases (to render the group card's member rows). */
  groupMembers: GroupMemberCase[]
  onConfirmGroupResolution: () => Promise<void>
  onDeclineGroupResolution: () => Promise<void>
  /** R3b — the parsed SourceDiff for a `source_diff` case, or null. */
  sourceDiff: SourceDiff | null
  /** R3b — the open, un-confirmed pick plan (restored from the transcript), or null. */
  openPickPlan: OpenPickPlan | null
  /** R3b — propose picking a source (→ proposePickSource). */
  onProposePickSource: (source: RcOutSource) => Promise<void>
  /** R3b — confirm the open pick plan (→ executeDiffResolution). */
  onConfirmDiffResolution: () => Promise<void>
  /** R3b — decline the open pick plan (→ cancelProposal). */
  onDeclineDiffResolution: () => Promise<void>
  /** Create-batch — the open, persisted create-batch proposal's plan (restored), or null. */
  openCreateBatchPlan: CreateBatchPlan | null
  /** Create-batch — propose creating the batch (→ proposeCreateBatch). */
  onCreateBatch: () => Promise<void>
  /** Create-batch — confirm the open proposal (→ executeCreateBatch). */
  onConfirmCreateBatch: () => Promise<void>
  /** Create-batch — decline the open proposal (→ cancelProposal). */
  onDeclineCreateBatch: () => Promise<void>
}

interface DriftDate {
  date: string
  proposed_kg?: number | null
  movement_kg?: number | null
  diff_kg?: number | null
  db_sum_kg?: number | null
  excess_kg?: number | null
  note?: string
}

function fmtKg(v: unknown): string {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v)
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function getDriftDates(row: unknown): DriftDate[] {
  if (!row || typeof row !== 'object') return []
  const drift = (row as { drift_dates?: unknown }).drift_dates
  return Array.isArray(drift) ? (drift as DriftDate[]) : []
}

/** Small day-by-day drift table (gate cases carry these numbers on row.drift_dates). */
function DriftTable({ drift }: { drift: DriftDate[] }) {
  const hasOM = drift.some((d) => d.db_sum_kg != null)
  return (
    <div className="mt-2 overflow-x-auto rounded border border-border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Date</th>
            {hasOM ? (
              <th className="px-2 py-1 text-right font-medium">Database</th>
            ) : (
              <th className="px-2 py-1 text-right font-medium">Daily report</th>
            )}
            <th className="px-2 py-1 text-right font-medium">Movement sheet</th>
            <th className="px-2 py-1 text-right font-medium">Difference</th>
          </tr>
        </thead>
        <tbody>
          {drift.map((d, i) => (
            <tr key={`${d.date}-${i}`} className="border-t border-border/60">
              <td className="px-2 py-1 font-mono">{d.date}</td>
              <td className="px-2 py-1 text-right font-mono">
                {fmtKg(hasOM ? d.db_sum_kg : d.proposed_kg)}
              </td>
              <td className="px-2 py-1 text-right font-mono">{fmtKg(d.movement_kg)}</td>
              <td className="px-2 py-1 text-right font-mono">
                {d.excess_kg != null
                  ? `+${fmtKg(d.excess_kg)}`
                  : d.diff_kg != null
                    ? fmtKg(d.diff_kg)
                    : d.note ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VerdictCard({ verdict }: { verdict: unknown }) {
  const [open, setOpen] = React.useState(false)
  const v = asVerdict(verdict)
  if (!v) return null
  const badge = VERDICT_BADGE[v.verdict]

  return (
    <div className="animate-fade-up rounded-md border border-border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', badge.className)}>
          {badge.label}
        </span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            CONFIDENCE_CLASS[v.confidence],
          )}
        >
          {CONFIDENCE_LABEL[v.confidence]}
        </span>
        {v.model && (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{v.model}</span>
        )}
      </div>

      <p className="mt-2 text-sm font-medium leading-relaxed text-foreground">{v.summary}</p>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? 'Hide reasoning' : 'Show reasoning'}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
            {v.explanation}
          </p>
          {v.citations.length > 0 && (
            <div className="rounded border border-border/70 bg-background/50 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Backed by
              </div>
              <ul className="space-y-1">
                {v.citations.map((c, i) => (
                  <li key={i} className="text-[11px] leading-snug">
                    <span className="text-foreground">{c.claim}</span>
                    <span className="text-muted-foreground"> — {c.source}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function CaseDetail({
  theCase,
  messages,
  busy,
  onInvestigate,
  onReinvestigate,
  onEscalate,
  onSend,
  chatPending,
  openProposal,
  onConfirmResolution,
  onDeclineResolution,
  resolvePending,
  onQuickDismiss,
  openGroupProposal,
  groupMembers,
  onConfirmGroupResolution,
  onDeclineGroupResolution,
  sourceDiff,
  openPickPlan,
  onProposePickSource,
  onConfirmDiffResolution,
  onDeclineDiffResolution,
  openCreateBatchPlan,
  onCreateBatch,
  onConfirmCreateBatch,
  onDeclineCreateBatch,
}: CaseDetailProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const chip = STATUS_CHIP[theCase.status] ?? {
    label: theCase.status,
    className: 'bg-muted text-muted-foreground',
  }
  const drift = getDriftDates(theCase.row)
  const hasVerdict = asVerdict(theCase.verdict) != null
  const neverInvestigated = theCase.status === 'open' && messages.length === 0 && !hasVerdict
  const isResolved = theCase.status === 'resolved'
  const isSourceDiff = theCase.kind === 'source_diff'
  const isBatchCase =
    theCase.kind === 'unmapped_batch_code' || theCase.kind === 'unresolved_batch'

  // The create-batch plan to render: the OPEN persisted proposal's plan (confirm mode), else a
  // client-computed PREVIEW (create mode) so the reviewer sees exactly what will be inserted
  // before proposing. buildCreateBatchPlan is PURE + client-safe (imports only types).
  const createBatchPlan: CreateBatchPlan | null = React.useMemo(() => {
    if (!isBatchCase) return null
    if (openCreateBatchPlan) return openCreateBatchPlan
    return buildCreateBatchPlan({
      kind: theCase.kind,
      reportType: theCase.report_type as SyncReportType,
      row: theCase.row,
    })
  }, [isBatchCase, openCreateBatchPlan, theCase.kind, theCase.report_type, theCase.row])

  // Keep the thread pinned to the newest message as it streams in.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy])

  return (
    <div className="flex h-full flex-col">
      {/* Header + verdict (scrolls with the thread) */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-auto scroll-fade-bottom p-4"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', chip.className)}
            >
              {chip.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {theCase.report_type} · {kindLabel(theCase.kind)}
            </span>
            {theCase.occurrence_count > 1 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                seen in {theCase.occurrence_count} runs
              </span>
            )}
          </div>
          <h2 className="mt-1 font-mono text-sm font-semibold text-foreground">
            {theCase.natural_key}
          </h2>
          {theCase.reason && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{theCase.reason}</p>
          )}
          {theCase.detail && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/90">
              {theCase.detail}
            </p>
          )}
          {isResolved && theCase.known_ruling_summary && (
            <p className="mt-1.5 flex items-start gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-400">
              <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>Resolved — {theCase.known_ruling_summary}</span>
            </p>
          )}
          {!isResolved && theCase.known_ruling_id && theCase.known_ruling_summary && (
            <p className="mt-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-400">
              Known issue — ruled before: {theCase.known_ruling_summary}
            </p>
          )}
          {drift.length > 0 && <DriftTable drift={drift} />}
        </div>

        {/* R3b — the pick-source card for a source_diff case (above the generic verdict). */}
        {isSourceDiff && sourceDiff && (
          <SourceDiffCard
            diff={sourceDiff}
            naturalKeyLabel={theCase.natural_key}
            openPlan={openPickPlan}
            onPick={onProposePickSource}
            onConfirm={onConfirmDiffResolution}
            onDecline={onDeclineDiffResolution}
            pending={resolvePending}
            busy={busy}
            isResolved={isResolved}
          />
        )}

        {/* First-class detail for the reconciliation kinds (block/overdue/unmapped-batch). */}
        <CaseFindingDetail kind={theCase.kind} row={theCase.row} />

        {/* Create-batch resolution for an unmapped / unresolved batch flag. */}
        {isBatchCase && createBatchPlan && (
          <CreateBatchCard
            plan={createBatchPlan}
            hasOpenProposal={!!openCreateBatchPlan}
            onCreate={onCreateBatch}
            onConfirm={onConfirmCreateBatch}
            onDecline={onDeclineCreateBatch}
            pending={resolvePending}
            busy={busy}
            isResolved={isResolved}
          />
        )}

        {hasVerdict && <VerdictCard verdict={theCase.verdict} />}

        {/* P5 — the confirm-gated resolution card (an open, un-actioned proposal). */}
        {openProposal && !isResolved && (
          <ResolutionCard
            open={openProposal}
            caseRow={theCase.row}
            onConfirm={onConfirmResolution}
            onDecline={onDeclineResolution}
            pending={resolvePending}
          />
        )}

        {/* v1.1 — the confirm-gated GROUP resolution card (triage case, dismiss-only). */}
        {openGroupProposal && !isResolved && (
          <GroupResolutionCard
            open={openGroupProposal}
            members={groupMembers}
            onConfirm={onConfirmGroupResolution}
            onDecline={onDeclineGroupResolution}
            pending={resolvePending}
          />
        )}

        {/* Thread */}
        {messages.length > 0 ? (
          <div className="animate-fade-up pt-1">
            <CaseThread messages={messages} />
          </div>
        ) : neverInvestigated ? (
          <div className="animate-fade-up rounded-md border border-dashed border-border p-6 text-center">
            <Search className="mx-auto mb-2 h-5 w-5 text-muted-foreground/70" />
            <p className="text-sm font-medium text-foreground">Not yet investigated</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run the investigator to get a cited verdict, then chat with it here.
            </p>
          </div>
        ) : null}

        {busy && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            The investigator is working…
          </div>
        )}
      </div>

      {/* Actions bar + chat input (pinned) */}
      <div className="border-t border-border bg-background/95 p-3 backdrop-blur supports-backdrop-filter:bg-background/60">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {neverInvestigated ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onInvestigate}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Investigate
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={onReinvestigate}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              Re-investigate
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={onEscalate}>
            <Sparkles className="h-3.5 w-3.5" />
            Escalate to Opus
          </Button>

          {/* ── P5 resolve slot ──────────────────────────────────────────────
              Quick Dismiss: a one-click, human-directed dismiss (zero operational
              write) for any unresolved, non-investigating case. Apply / edit-then-apply
              come from the agent's propose_resolution → the ResolutionCard above. */}
          {!isResolved && theCase.kind !== 'run_triage' && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={busy || resolvePending}
              onClick={onQuickDismiss}
            >
              <XCircle className="h-3.5 w-3.5" />
              Quick dismiss
            </Button>
          )}
        </div>

        <CaseChatInput
          onSend={onSend}
          pending={chatPending}
          disabled={busy}
          placeholder={
            busy
              ? 'Wait for the investigator to finish…'
              : 'Ask why, or tell it to check another date…'
          }
        />
      </div>
    </div>
  )
}
