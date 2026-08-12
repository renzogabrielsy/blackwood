'use client'

import * as React from 'react'
import Link from 'next/link'
import { Copy, HandHelping, Sparkles } from 'lucide-react'

import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { errorToast } from '@/lib/toast'
import {
  serializeFindingsForClaude,
  summarizeFindings,
  type FindingSeverity,
  type RunFinding,
} from '@/lib/sync/findings'
import { FINDING_BADGE_CLASS } from './cases/labels'

/**
 * The panel's honest "needs review" list. It renders `flattenRunFindings(state.result)` —
 * EVERYTHING a run flagged: held rows PLUS every reconciliation channel (source diffs,
 * overdue single-source facts, unresolved batches, block-balance + grand-total diffs).
 *
 * THE BUG THIS FIXES: the old section read only `apply.held`, so a run that flagged ten
 * things showed one. Now the header count is `summarizeFindings().total` (the true total),
 * and every finding is a dense, Excel-standard row that names the SOURCE (which file), the
 * TITLE, the LOCATION (row / block / date), the actual DATA values (font-mono numbers, the
 * two sides of a diff, the batch code), and the plain REASON — so the operator can pinpoint
 * and act without treating the sync as a black box.
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

/** Severity rank for ordering (high first). */
const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, attention: 1, info: 2 }

/** Left-edge accent + dot tint per severity. */
const SEVERITY_STYLE: Record<FindingSeverity, { edge: string; dot: string; label: string }> = {
  high: {
    edge: 'border-l-red-500/70',
    dot: 'bg-red-500',
    label: 'text-red-600 dark:text-red-400',
  },
  attention: {
    edge: 'border-l-amber-500/70',
    dot: 'bg-amber-500',
    label: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    edge: 'border-l-border',
    dot: 'bg-muted-foreground/50',
    label: 'text-muted-foreground',
  },
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
}

function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Format a value for a data chip (numbers get thousands separators + a kg hint if key looks like a weight). */
function fmtChipValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number' && Number.isFinite(v)) {
    const isKg = /kg|weight|delta|sheet|computed|value/i.test(key)
    return isKg ? `${fmtNumber(v)} kg` : String(v)
  }
  return String(v)
}

interface DataChip {
  label: string
  value: string
  /** Emphasize the two sides of a comparison. */
  emphasis?: boolean
}

/**
 * Pull the load-bearing numbers/identifiers out of a finding's `data` into font-mono chips —
 * the glance that lets the operator pinpoint. Handles the diff shape (competing sources),
 * the block-balance shape (sheet vs app vs Δ), and the identity shape (batch/date/block/weight).
 */
function dataChips(f: RunFinding): DataChip[] {
  const d = f.data
  const chips: DataChip[] = []

  // Competing sources (source_diff): render each side as its own chip.
  const sources = d.sources
  if (Array.isArray(sources) && sources.length > 0 && typeof sources[0] === 'object') {
    for (const s of sources as Array<Record<string, unknown>>) {
      const src = typeof s.source === 'string' ? s.source : 'source'
      chips.push({ label: src, value: fmtChipValue('value', s.value), emphasis: true })
    }
    return chips
  }

  const push = (label: string, key: string, emphasis = false) => {
    if (key in d && d[key] != null && d[key] !== '') {
      chips.push({ label, value: fmtChipValue(key, d[key]), emphasis })
    }
  }

  // Block-balance comparison (two sides + delta).
  if ('sheet_kg' in d || 'computed_kg' in d) {
    push('sheet', 'sheet_kg', true)
    push('app', 'computed_kg', true)
    push('Δ', 'delta', true)
    // The RESIDUAL — the part of a grand-total gap that NO flagged block explains, and the
    // only number here that is genuinely alarming. Present only on a grand_total that carries
    // it; `0` is a real value and must still render (hence the `!= null` test in `push`).
    push('unexplained', 'residual_kg', true)
    push('sheet batch', 'sheet_batch')
    push('app batch', 'computed_batch')
    return chips
  }

  // Single-source-overdue: the lone value + how overdue.
  if ('source' in d && 'value' in d) {
    const src = typeof d.source === 'string' ? d.source : 'source'
    chips.push({ label: src, value: fmtChipValue('value', d.value), emphasis: true })
    push('days overdue', 'ageDays')
  }

  // Identity fields (batch/date/block/weight).
  push('batch', 'batch_code')
  if (!('batch_code' in d)) push('batch', 'batch')
  push('date', 'transaction_date')
  push('block', 'block_loc')
  push('weight', 'weight_kg', true)
  return chips
}

/** Copy a full finding as plain text (persistent-error-toast philosophy: everything is copyable). */
function copyFinding(f: RunFinding) {
  const parts = [
    f.title,
    `source: ${f.source}`,
    `where: ${f.location}`,
    `why: ${f.reason}`,
    `data: ${JSON.stringify(f.data)}`,
  ]
  void navigator.clipboard.writeText(parts.join('\n')).then(() => {
    toast.success('Finding copied', { duration: 2000 })
  })
}

function FindingCard({ f }: { f: RunFinding }) {
  const sev = SEVERITY_STYLE[f.severity]
  const chips = dataChips(f)
  return (
    <li
      className={cn(
        'rounded border border-l-2 border-border/70 bg-background/60 p-1.5',
        sev.edge,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', sev.dot)} />
            <p className="text-[11px] font-medium leading-snug text-foreground">{f.title}</p>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-3">
            <span
              className={cn(
                'rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                sev.label,
              )}
            >
              {f.kindLabel}
            </span>

            {/* Qualifying badges — the at-a-glance reading (e.g. "POSSIBLE MISMATCH DUE TO
                LAG"), which used to be the last sentence of the paragraph below. Sits
                immediately after the severity chip and is deliberately outlined, not flat,
                so the two never read as one run-on label. No animation: it must be legible
                the instant the panel paints, not a moment later. */}
            {f.badges?.map((b) => (
              <span
                key={b.label}
                title={b.hint}
                className={cn(
                  'rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                  FINDING_BADGE_CLASS[b.tone],
                )}
              >
                {b.label}
              </span>
            ))}

            <span className="font-mono text-[9px] text-muted-foreground">{f.location}</span>
          </div>

          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1 pl-3">
              {chips.map((c, i) => (
                <span
                  key={`${c.label}-${i}`}
                  className={cn(
                    'inline-flex items-baseline gap-1 rounded border px-1 py-0.5 font-mono text-[10px] tabular-nums',
                    c.emphasis
                      ? 'border-border bg-muted/60 text-foreground'
                      : 'border-transparent bg-transparent text-muted-foreground',
                  )}
                >
                  <span className="text-[8px] uppercase tracking-wide text-muted-foreground/70">
                    {c.label}
                  </span>
                  {c.value}
                </span>
              ))}
            </div>
          )}

          {f.reason && (
            <p className="mt-1 pl-3 text-[10px] leading-snug text-muted-foreground/90">
              {f.reason}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => copyFinding(f)}
          title="Copy this finding"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>
    </li>
  )
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
  const { grouped, breakdown } = React.useMemo(() => {
    const { byKind } = summarizeFindings(findings)
    // By-kind breakdown chips (compact word per kind), loudest first.
    const breakdown = Object.entries(byKind)
      .map(([kind, count]) => {
        const sample = findings.find((f) => f.kind === kind)
        return { kind, count, word: SHORT_KIND[kind] ?? sample?.kindLabel ?? kind }
      })
      .sort((a, b) => b.count - a.count)

    // Group by SOURCE (which file) — the fastest way to pinpoint. Order groups by their
    // loudest finding, then by count; sort findings inside each group by severity.
    const bySource = new Map<string, RunFinding[]>()
    for (const f of findings) {
      const list = bySource.get(f.source)
      if (list) list.push(f)
      else bySource.set(f.source, [f])
    }
    const grouped = Array.from(bySource.entries())
      .map(([source, rows]) => {
        const sorted = [...rows].sort(
          (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
        )
        const topRank = Math.min(...sorted.map((r) => SEVERITY_RANK[r.severity]))
        return { source, rows: sorted, topRank }
      })
      .sort((a, b) => a.topRank - b.topRank || b.rows.length - a.rows.length)

    return { grouped, breakdown }
  }, [findings])

  if (findings.length === 0) return null

  const total = findings.length
  // The doorway: land on this run's triage chat (or the run's cases) in Sync Review.
  const reviewHref = runId ? `/sync/cases?run=${encodeURIComponent(runId)}` : '/sync/cases'

  return (
    <div className="animate-fade-up border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <HandHelping className="h-3.5 w-3.5 text-orange-500" />
          <h3 className="text-xs font-semibold tracking-tight text-foreground">
            {total} {total === 1 ? 'thing needs' : 'things need'} review
          </h3>
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
        Every flagged item is listed below — the source file, the exact row/block, the numbers,
        and why. Nothing here was written. Open{' '}
        <span className="font-medium">Sync Review</span> to investigate and resolve.
      </p>

      <div className="space-y-2.5">
        {grouped.map((group) => (
          <div key={group.source} className="rounded-md border border-border bg-card/50 p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                {group.source}
                <span className="font-mono text-[10px] text-muted-foreground">
                  ({group.rows.length})
                </span>
              </span>
              {/* The doorway: a run-scoped deep link into Sync Review. */}
              <Link
                href={reviewHref}
                className="inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-all duration-150 hover:bg-muted"
              >
                <Sparkles className="h-3 w-3 text-primary" />
                Ask Claude → Sync Review
              </Link>
            </div>

            <ul className="space-y-1.5">
              {group.rows.map((f) => (
                <FindingCard key={f.key} f={f} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
