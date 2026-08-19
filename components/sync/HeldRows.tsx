'use client'

import * as React from 'react'
import Link from 'next/link'
import { Copy, HandHelping, Sparkles } from 'lucide-react'

import { toast } from 'sonner'
import { errorToast } from '@/lib/toast'
import { useAuth } from '@/components/providers/auth-context'
import { PRIVILEGED_ROLES } from '@/types/auth'
import {
  serializeFindingsForClaude,
  summarizeFindings,
  type RunFinding,
} from '@/lib/sync/findings'
import { buildDecisionCards } from '@/lib/sync/decision-cards'
import { DecisionCardGroups } from './DecisionCards'
import { useFindingAcks } from './useFindingAcks'

/**
 * The panel's "needs review" section. It renders `flattenRunFindings(state.result)` —
 * EVERYTHING a run flagged: held rows PLUS every reconciliation channel (source diffs,
 * overdue single-source facts, unresolved batches, block-balance + grand-total diffs).
 *
 * THE FIRST BUG THIS FIXED (2026-08-07): the old section read only `apply.held`, so a run
 * that flagged ten things showed one. The count is `summarizeFindings().total` — the true
 * total, always stated, never filtered.
 *
 * THE SECOND (2026-08-19): those ten things were ten prose lines, each ending in a
 * sentence written for a human ("please confirm…") beside no button. They are now DECISION
 * CARDS — `lib/sync/decision-cards.ts` regroups the flat list into one card per thing a
 * person must answer (two findings about one delivery become one card; the fully-accounted
 * grand total becomes a quiet footer under the blocks that explain it), and each card
 * carries the button that answers it. A card a human has acknowledged is hidden UNTIL ITS
 * CONTENT CHANGES, behind a "N acknowledged" toggle.
 *
 * The header still names the honest FINDING total, with the decision count beside it — the
 * regrouping must never look like the panel is showing less than the run found.
 */
interface HeldRowsProps {
  findings: RunFinding[]
  /** The current run id — threads into the "Ask Claude → Sync Review" doorway link. */
  runId: string | null
  /** Run operational date (yyyy-MM-dd), for the diagnosis-block header. Optional. */
  runDate?: string | null
  /** Run lifecycle status, for the diagnosis-block header. Optional. */
  status?: string | null
}

/**
 * Compact word per kind for the by-kind breakdown chip row (e.g. "3 overdue · 4 block").
 * Falls back to the finding's own plain `kindLabel` when unmapped.
 */
const SHORT_KIND: Record<string, string> = {
  block_diff: 'block',
  single_source_overdue: 'overdue',
  source_diff: 'sources disagree',
  unresolved_batch: 'unknown batch',
  unmapped_batch_code: 'unknown batch',
  unmapped_bag_type_code: 'unknown bag type',
  gate_failure: 'totals off',
  cross_batch_reassignment: 'batch moved',
  location_occupied: 'slot occupied',
  malformed: 'bad row',
  already_exists: 'already saved',
  low_confidence: 'low confidence',
  unresolved_shift: 'unmatched shift',
  unresolved_batch_id: 'unknown batch',
  batch_closed: 'closed',
  batch_close_unmatched: 'close unmatched',
  stale_stream: 'report overdue',
  delivery_human_edited: 'your edit kept',
  price_fuzzy_match: 'spelling differs',
}

/** Copy the WHOLE run's findings as a diagnosis-ready block for a Claude Code session. */
function copyAllForClaude(
  findings: RunFinding[],
  meta: { runId: string | null; runDate?: string | null; status?: string | null },
) {
  const text = serializeFindingsForClaude(findings, meta)
  void navigator.clipboard.writeText(text).then(
    () =>
      toast.success(`Copied ${findings.length} flag${findings.length === 1 ? '' : 's'}`, {
        duration: 2000,
      }),
    (err) =>
      errorToast('Could not copy the flags', {
        description: err instanceof Error ? err.message : String(err),
      }),
  )
}

export function HeldRows({ findings, runId, runDate, status }: HeldRowsProps) {
  // Owner / Admin / Dev — the SAME test that gates Run Sync itself (SyncLauncher). Never a
  // second derivation of "may this person act", and never the only gate: `acks.ts` runs
  // `requirePrivileged()` on every write and on the read.
  const { role } = useAuth()
  const isPrivileged = PRIVILEGED_ROLES.includes(role)

  const api = useFindingAcks(isPrivileged)

  const result = React.useMemo(
    () => buildDecisionCards(findings, api.acks),
    [findings, api.acks],
  )

  const breakdown = React.useMemo(() => {
    const { byKind } = summarizeFindings(findings)
    return Object.entries(byKind)
      .map(([kind, count]) => {
        const sample = findings.find((f) => f.kind === kind)
        return { kind, count, word: SHORT_KIND[kind] ?? sample?.kindLabel ?? kind }
      })
      .sort((a, b) => b.count - a.count)
  }, [findings])

  if (findings.length === 0) return null

  const total = findings.length
  const decisions = result.visibleCount
  // The doorway: land on this run's triage chat (or the run's cases) in Sync Review.
  const reviewHref = runId ? `/sync/cases?run=${encodeURIComponent(runId)}` : '/sync/cases'

  return (
    <div className="animate-fade-up border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <HandHelping className="h-3.5 w-3.5 text-orange-500" />
          <h3 className="text-xs font-semibold tracking-tight text-foreground">
            {decisions === 0
              ? `${total} flag${total === 1 ? '' : 's'} — nothing waiting on you`
              : `${decisions} ${decisions === 1 ? 'decision' : 'decisions'} need you`}
          </h3>
          {decisions > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              ({total} flag{total === 1 ? '' : 's'})
            </span>
          )}
        </div>
        {/* Copy the WHOLE run's flags as a diagnosis-ready block for Claude Code. */}
        <button
          type="button"
          onClick={() => copyAllForClaude(findings, { runId, runDate, status })}
          title="Copy every flag as a diagnosis-ready block to paste into Claude Code"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-all duration-150 hover:bg-muted"
        >
          <Copy className="h-3 w-3" />
          Copy all for Claude
        </button>
      </div>

      {/* By-kind breakdown chips (e.g. "3 overdue · 4 block · 1 unknown batch"). */}
      {breakdown.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {breakdown.map((b, i) => (
            <React.Fragment key={b.kind}>
              {i > 0 && <span className="text-[10px] text-muted-foreground/40">·</span>}
              <span className="text-[10px] text-muted-foreground">
                <span className="font-mono font-medium text-foreground">{b.count}</span> {b.word}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      <p className="mb-2 text-[10px] leading-snug text-muted-foreground">
        Every flagged item is grouped into the decision it belongs to — the source file, the
        exact row/block, the numbers, and why. Nothing here was written. Acknowledging a card
        only affects this screen: the run still reported it, and it comes back if it changes.
      </p>

      <DecisionCardGroups
        result={result}
        api={api}
        isPrivileged={isPrivileged}
        groupAction={() => (
          <Link
            href={reviewHref}
            className="inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-all duration-150 hover:bg-muted"
          >
            <Sparkles className="h-3 w-3 text-primary" />
            Ask Claude → Sync Review
          </Link>
        )}
      />
    </div>
  )
}
