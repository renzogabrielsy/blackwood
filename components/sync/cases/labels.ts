/**
 * labels.ts — pure, client-safe presentation maps for the Sync Review page.
 *
 * The KIND_LABEL phrases mirror components/sync/HeldRows.tsx (one plain plant-floor
 * phrase per held kind). The verdict styling matches the app's verdict semantics:
 * skip = a source-sheet issue (the DB is right → green), apply = a row genuinely
 * needs saving (amber), needs-human = ambiguous (red).
 *
 * No server imports here — this file is imported by client components.
 */
import type { HeldKind } from '@/app/(app)/sync/types'

/** Short plant-floor phrase per held kind. Kept in sync with HeldRows.tsx. */
export const KIND_LABEL: Record<HeldKind, string> = {
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

/** Human phrase for a kind string (tolerant of unknown/legacy kinds). */
export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return 'Set aside for review'
  return KIND_LABEL[kind as HeldKind] ?? kind
}

export type Verdict = 'apply' | 'skip' | 'needs-human'
export type Confidence = 'high' | 'medium' | 'low'

/** The persisted verdict shape written onto sync_held_cases.verdict (P3). */
export interface CaseVerdictPayload {
  verdict: Verdict
  confidence: Confidence
  summary: string
  explanation: string
  citations: Array<{ claim: string; source: string }>
  model?: string
  investigated_at?: string
  tool_call_count?: number
}

/** Badge label + classes per verdict (the plain reading, not the raw word). */
export const VERDICT_BADGE: Record<Verdict, { label: string; className: string }> = {
  skip: {
    label: 'Source-sheet issue',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  apply: {
    label: 'Should be saved',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  'needs-human': {
    label: 'Needs a person',
    className: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
}

/** The "not yet investigated" badge (no verdict). */
export const NO_VERDICT_BADGE = {
  label: 'Not yet investigated',
  className: 'bg-muted text-muted-foreground',
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

export const CONFIDENCE_CLASS: Record<Confidence, string> = {
  high: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  low: 'bg-muted text-muted-foreground',
}

/** Status chip styling for a case's lifecycle status. */
export const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
  investigating: {
    label: 'Investigating…',
    className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  investigated: {
    label: 'Investigated',
    className: 'bg-muted text-muted-foreground',
  },
  resolved: {
    label: 'Resolved',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
}

/** Narrow an unknown JSONB verdict into a typed payload (or null). */
export function asVerdict(v: unknown): CaseVerdictPayload | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.verdict !== 'apply' && o.verdict !== 'skip' && o.verdict !== 'needs-human') return null
  if (o.confidence !== 'high' && o.confidence !== 'medium' && o.confidence !== 'low') return null
  if (typeof o.summary !== 'string' || typeof o.explanation !== 'string') return null
  const citations = Array.isArray(o.citations)
    ? (o.citations as Array<{ claim?: unknown; source?: unknown }>)
        .filter((c) => c && typeof c.claim === 'string' && typeof c.source === 'string')
        .map((c) => ({ claim: c.claim as string, source: c.source as string }))
    : []
  return {
    verdict: o.verdict,
    confidence: o.confidence,
    summary: o.summary,
    explanation: o.explanation,
    citations,
    model: typeof o.model === 'string' ? o.model : undefined,
    investigated_at: typeof o.investigated_at === 'string' ? o.investigated_at : undefined,
    tool_call_count: typeof o.tool_call_count === 'number' ? o.tool_call_count : undefined,
  }
}
