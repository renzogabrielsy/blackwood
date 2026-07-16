'use client'

import * as React from 'react'
import {
  AlertTriangle,
  Boxes,
  Clock,
  GitCompareArrows,
  HelpCircle,
  PackagePlus,
  PackageX,
  ShieldAlert,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type {
  AttributionDiff,
  AttributionSide,
  AutoCreatedBatch,
  BlockDiff,
  SingleSourceOverdue,
  UnresolvedBatch,
} from '@/app/(app)/sync/types'
import { kindLabel } from './labels'

/**
 * FindingDetailCards — first-class detail rendering for the reconciliation case kinds that
 * previously fell back to the generic verdict card. Each reads the case `row` payload (the
 * enriched BlockDiff / SingleSourceOverdue / UnresolvedBatch, or a held row's structured
 * `row`) and shows the SOURCE, the actual DATA (font-mono, right-aligned, the two sides of a
 * comparison), the exact ROW/BLOCK, and a plain WHY — the Excel Standard, semantic tokens.
 *
 * Presentation-only + client-safe: imports only the shared contract TYPES. Rendered by
 * CaseDetail above the generic verdict card.
 */

// ── shared helpers ──────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function fmtKg(v: unknown): string {
  const n = num(v)
  return n == null ? '—' : `${Math.round(n).toLocaleString('en-US')}`
}

function fmtSignedKg(v: unknown): string {
  const n = num(v)
  if (n == null) return '—'
  const s = `${Math.round(Math.abs(n)).toLocaleString('en-US')}`
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s
}

/** Human labels for the rc_out reconciliation witnesses. */
const SOURCE_LABEL: Record<string, string> = {
  proposed: 'Proposed daily report',
  gsheet: 'Google Sheet',
  movement: 'Movement sheet',
}
function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s
}

/** A card shell matching the SourceDiffCard visual language. */
function DetailShell({
  icon,
  badge,
  badgeClass,
  hint,
  title,
  children,
}: {
  icon: React.ReactNode
  badge: string
  badgeClass: string
  hint: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="animate-fade-up rounded-md border border-border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
            badgeClass,
          )}
        >
          {icon}
          {badge}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{hint}</span>
      </div>
      <h3 className="mt-2 font-mono text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </div>
  )
}

/** A dense two-column key/value grid (Excel-standard field readout). */
function FieldGrid({ rows }: { rows: Array<{ label: string; value: React.ReactNode; mono?: boolean }> }) {
  const visible = rows.filter((r) => r.value != null && r.value !== '')
  if (visible.length === 0) return null
  return (
    <div className="mt-2 overflow-hidden rounded border border-border">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {visible.map((r, i) => (
            <tr key={`${r.label}-${i}`} className="border-t border-border/60 first:border-t-0">
              <td className="w-[130px] bg-muted/40 px-2 py-1 text-left align-top text-[10px] uppercase tracking-wide text-muted-foreground">
                {r.label}
              </td>
              <td
                className={cn(
                  'px-2 py-1 text-left align-top text-foreground',
                  r.mono && 'font-mono tabular-nums',
                )}
              >
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── block_diff ───────────────────────────────────────────────────────────────

function asBlockDiff(row: unknown): BlockDiff | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (o.kind !== 'balance' && o.kind !== 'batch_mismatch' && o.kind !== 'multi_batch' && o.kind !== 'grand_total') {
    return null
  }
  return o as unknown as BlockDiff
}

function BlockDiffDetail({ d }: { d: BlockDiff }) {
  const isGrand = d.kind === 'grand_total'
  const badge =
    d.kind === 'grand_total'
      ? 'Total inventory mismatch'
      : d.kind === 'batch_mismatch'
        ? 'Block holds a different batch'
        : d.kind === 'multi_batch'
          ? 'Block has multiple active batches'
          : 'Block balance mismatch'

  const where = isGrand ? 'Grand total (all blocks)' : `Block ${d.block_loc ?? '?'}`

  return (
    <DetailShell
      icon={<Boxes className="h-3 w-3" />}
      badge={badge}
      badgeClass={
        isGrand
          ? 'bg-red-500/15 text-red-600 dark:text-red-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      }
      hint="Blocking cross-check"
      title={where}
    >
      {/* The two balances + the delta, side by side. */}
      <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Where</th>
              <th className="w-[110px] px-2 py-1 text-right font-medium">Sheet (kg)</th>
              <th className="w-[110px] px-2 py-1 text-right font-medium">App (kg)</th>
              <th className="w-[110px] px-2 py-1 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border/60">
              <td className="px-2 py-1 font-mono text-foreground">{isGrand ? 'Grand total' : d.block_loc}</td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {fmtKg(d.sheet_kg)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {fmtKg(d.computed_kg)}
              </td>
              <td
                className={cn(
                  'px-2 py-1 text-right font-mono tabular-nums font-semibold',
                  num(d.delta) === 0
                    ? 'text-muted-foreground'
                    : 'text-red-600 dark:text-red-400',
                )}
              >
                {fmtSignedKg(d.delta)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Batch-identity fields for batch_mismatch / multi_batch. */}
      <FieldGrid
        rows={[
          { label: 'Sheet batch', value: str(d.sheet_batch), mono: true },
          { label: 'App batch', value: str(d.computed_batch), mono: true },
          {
            label: 'Active batches',
            value: d.active_batch_count != null ? String(d.active_batch_count) : null,
            mono: true,
          },
        ]}
      />

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{d.detail}</p>
    </DetailShell>
  )
}

// ── single_source_overdue ─────────────────────────────────────────────────────

function asOverdue(row: unknown): SingleSourceOverdue | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (!o.naturalKey || typeof o.naturalKey !== 'object') return null
  if (typeof o.source !== 'string') return null
  return o as unknown as SingleSourceOverdue
}

function OverdueDetail({ o }: { o: SingleSourceOverdue }) {
  const k = o.naturalKey
  const field = o.field === 'weight_kg' ? 'weight' : o.field
  const value = o.field === 'weight_kg' ? `${fmtKg(o.value)} kg` : String(o.value ?? '—')
  const title = `${k.batch ?? '(feed)'} @ ${k.block_loc ?? '(feed)'}`

  return (
    <DetailShell
      icon={<Clock className="h-3 w-3" />}
      badge="Only one source reported"
      badgeClass="bg-amber-500/15 text-amber-600 dark:text-amber-400"
      hint="RC OUT · awaiting a second witness"
      title={title}
    >
      <FieldGrid
        rows={[
          { label: 'Reported by', value: sourceLabel(o.source) },
          { label: field, value, mono: true },
          { label: 'Date', value: k.transaction_date, mono: true },
          { label: 'Batch', value: k.batch, mono: true },
          { label: 'Block', value: k.block_loc, mono: true },
          {
            label: 'Destination',
            value: k.destination && k.destination !== 'MAIN' ? k.destination : null,
            mono: true,
          },
          { label: 'Days overdue', value: String(o.ageDays), mono: true },
        ]}
      />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Only the <span className="font-medium text-foreground">{sourceLabel(o.source)}</span> has
        this feeding. The other source that would confirm it never arrived — it&apos;s been{' '}
        <span className="font-medium text-foreground">{o.ageDays} day(s)</span>. Either it&apos;s a
        genuine feeding no one else recorded, or the second report is simply late.
      </p>
    </DetailShell>
  )
}

// ── attribution_diff ───────────────────────────────────────────────────────────

function asAttributionDiff(row: unknown): AttributionDiff | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (typeof o.transaction_date !== 'string') return null
  if (!o.proposed || typeof o.proposed !== 'object') return null
  if (!o.gsheet || typeof o.gsheet !== 'object') return null
  return o as unknown as AttributionDiff
}

/** Short identity for one side — code preferred over the raw batch id. */
function attributionSideName(s: AttributionSide): string {
  return s.batch_code ?? s.batch ?? '(no batch)'
}

function AttributionDiffDetail({ a }: { a: AttributionDiff }) {
  const destPart = a.destination && a.destination !== 'MAIN' ? ` → ${a.destination}` : ''

  return (
    <DetailShell
      icon={<GitCompareArrows className="h-3 w-3" />}
      badge="Sources disagree on attribution"
      badgeClass="bg-blue-500/15 text-blue-600 dark:text-blue-400"
      hint="RC OUT · same feeding, different batch/block"
      title={`${fmtKg(a.weight_kg)} kg on ${a.transaction_date}${destPart}`}
    >
      <div className="mt-2 overflow-x-auto rounded border border-border bg-background/50">
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Source</th>
              <th className="px-2 py-1 text-left font-medium">Batch</th>
              <th className="px-2 py-1 text-left font-medium">Block</th>
              <th className="w-[92px] px-2 py-1 text-right font-medium">Weight (kg)</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                { label: 'Proposed report', side: a.proposed },
                { label: 'Google Sheet', side: a.gsheet },
              ] as const
            ).map(({ label, side }) => (
              <tr key={label} className="border-t border-border/60 align-top">
                <td className="px-2 py-1 font-medium text-foreground">{label}</td>
                <td className="px-2 py-1 font-mono text-foreground">{attributionSideName(side)}</td>
                <td className="px-2 py-1 font-mono text-foreground">{side.block_loc ?? '(feed)'}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                  {fmtKg(side.weight_kg)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Both sources report <span className="font-medium text-foreground">{fmtKg(a.weight_kg)} kg</span>{' '}
        on <span className="font-medium text-foreground">{a.transaction_date}</span>, but disagree on
        which batch/block it came from. This is very likely the SAME physical feeding — pick which
        attribution is correct outside this pass, or dismiss with a note (chat below).
      </p>
    </DetailShell>
  )
}

// ── unmapped_batch_code / unresolved_batch ────────────────────────────────────

/** Read whatever identity fields a batch case row carries (UnresolvedBatch OR a held row's row). */
interface BatchRowView {
  batch_code: string | null
  transaction_date: string | null
  block_loc: string | null
  destination: string | null
  supplier: string | null
  weight_kg: number | null
  candidates: string[]
  sources: string[]
}

function readBatchRow(row: unknown): BatchRowView {
  const o = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<
    string,
    unknown
  >
  const candidates = Array.isArray(o.candidates) ? (o.candidates as unknown[]).map(String) : []
  const sources = Array.isArray(o.sources) ? (o.sources as unknown[]).map(String) : []
  return {
    batch_code: str(o.batch_code),
    transaction_date: str(o.transaction_date),
    block_loc: str(o.block_loc),
    destination: str(o.destination),
    supplier: str(o.supplier),
    weight_kg: num(o.weight_kg),
    candidates,
    sources,
  }
}

function isUnresolvedBatch(row: unknown): row is UnresolvedBatch {
  return !!row && typeof row === 'object' && Array.isArray((row as UnresolvedBatch).candidates)
}

function UnmappedBatchDetail({ row }: { row: unknown }) {
  const v = readBatchRow(row)
  const ambiguous = isUnresolvedBatch(row) && v.candidates.length >= 2
  const why = ambiguous
    ? `The code "${v.batch_code ?? '?'}" matches ${v.candidates.length} existing batches, so the sync can't tell which one this belongs to.`
    : `The batch "${v.batch_code ?? '?'}" doesn't exist in the database yet, so this row has nowhere to land.`

  return (
    <DetailShell
      icon={<PackageX className="h-3 w-3" />}
      badge={ambiguous ? 'Batch is ambiguous' : "Batch doesn't exist yet"}
      badgeClass="bg-amber-500/15 text-amber-600 dark:text-amber-400"
      hint="Batch mapping"
      title={v.batch_code ?? '(no batch code)'}
    >
      <FieldGrid
        rows={[
          { label: 'Date', value: v.transaction_date, mono: true },
          { label: 'Supplier', value: v.supplier },
          { label: 'Block', value: v.block_loc, mono: true },
          {
            label: 'Destination',
            value: v.destination && v.destination !== 'MAIN' ? v.destination : null,
            mono: true,
          },
          {
            label: 'Weight',
            value: v.weight_kg != null ? `${fmtKg(v.weight_kg)} kg` : null,
            mono: true,
          },
          {
            label: 'Reported by',
            value: v.sources.length > 0 ? v.sources.map(sourceLabel).join(', ') : null,
          },
          {
            label: 'Possible matches',
            value: v.candidates.length > 0 ? `${v.candidates.length}` : null,
            mono: true,
          },
        ]}
      />
      <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span>{why}</span>
      </p>
    </DetailShell>
  )
}

// ── gate_failure ───────────────────────────────────────────────────────────────

interface GateFailureRowView {
  transaction_date: string | null
  batch_code: string | null
  block_loc: string | null
  destination: string | null
  weight_kg: number | null
  production_batch: string | null
  driftCount: number
}

function readGateFailureRow(row: unknown): GateFailureRowView {
  const o = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<
    string,
    unknown
  >
  const drift = Array.isArray(o.drift_dates) ? (o.drift_dates as unknown[]) : []
  return {
    transaction_date: str(o.transaction_date),
    batch_code: str(o.batch_code),
    block_loc: str(o.block_loc),
    destination: str(o.destination),
    weight_kg: num(o.weight_kg),
    production_batch: str(o.production_batch),
    driftCount: drift.length,
  }
}

function GateFailureDetail({
  row,
  naturalKey,
}: {
  row: unknown
  naturalKey?: string | null
}) {
  const v = readGateFailureRow(row)
  const title = v.batch_code ?? naturalKey ?? v.transaction_date ?? 'Gate check failed'
  const who = v.batch_code ? `batch ${v.batch_code}` : v.transaction_date ? v.transaction_date : 'this run'

  return (
    <DetailShell
      icon={<ShieldAlert className="h-3 w-3" />}
      badge="Totals don't match — nothing saved"
      badgeClass="bg-red-500/15 text-red-600 dark:text-red-400"
      hint="Sync gate check"
      title={title}
    >
      <FieldGrid
        rows={[
          { label: 'Date', value: v.transaction_date, mono: true },
          { label: 'Batch', value: v.batch_code, mono: true },
          { label: 'Block', value: v.block_loc, mono: true },
          {
            label: 'Destination',
            value: v.destination && v.destination !== 'MAIN' ? v.destination : null,
            mono: true,
          },
          {
            label: 'Weight',
            value: v.weight_kg != null ? `${fmtKg(v.weight_kg)} kg` : null,
            mono: true,
          },
          { label: 'Production batch', value: v.production_batch, mono: true },
          {
            label: 'Flagged dates',
            value: v.driftCount > 0 ? String(v.driftCount) : null,
            mono: true,
          },
        ]}
      />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The totals for {who} didn&apos;t reconcile between sources, so the sync held everything
        back rather than risk writing the wrong numbers.
      </p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
        <span>
          Check the flagged date(s) against the movement sheet and the proposed/daily report
          (numbers above, if any). Once the totals agree, the next sync run applies this
          automatically — nothing to fix directly in the database.
        </span>
      </p>
    </DetailShell>
  )
}

// ── cross_batch_reassignment ────────────────────────────────────────────────────

interface CrossBatchRowView {
  batch_code: string | null
  transaction_date: string | null
  block_loc: string | null
  truck_plate: string | null
  weight_kg: number | null
  sacks: number | null
  mode: string | null
  conflictBatches: string[]
}

function readCrossBatchRow(row: unknown): CrossBatchRowView {
  const o = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<
    string,
    unknown
  >
  const conflicts = Array.isArray(o.db_conflict_batches)
    ? (o.db_conflict_batches as unknown[]).map(String)
    : []
  return {
    batch_code: str(o.batch_code),
    transaction_date: str(o.transaction_date),
    block_loc: str(o.block_loc),
    truck_plate: str(o.truck_plate),
    weight_kg: num(o.weight_kg),
    sacks: num(o.sacks),
    mode: str(o.mode),
    conflictBatches: conflicts,
  }
}

function CrossBatchReassignmentDetail({
  row,
  naturalKey,
}: {
  row: unknown
  naturalKey?: string | null
}) {
  const v = readCrossBatchRow(row)
  const title = v.batch_code ?? naturalKey ?? 'Batch/block reassignment'

  return (
    <DetailShell
      icon={<GitCompareArrows className="h-3 w-3" />}
      badge="Same load, different batch"
      badgeClass="bg-blue-500/15 text-blue-600 dark:text-blue-400"
      hint={v.mode ? `${v.mode === 'rc_in' ? 'RC IN' : 'RC OUT'} · batch mapping` : 'Batch mapping'}
      title={title}
    >
      <FieldGrid
        rows={[
          { label: 'Date', value: v.transaction_date, mono: true },
          { label: 'Batch', value: v.batch_code, mono: true },
          { label: 'Block', value: v.block_loc, mono: true },
          { label: 'Truck plate', value: v.truck_plate, mono: true },
          {
            label: 'Weight',
            value: v.weight_kg != null ? `${fmtKg(v.weight_kg)} kg` : null,
            mono: true,
          },
          { label: 'Sacks', value: v.sacks != null ? String(v.sacks) : null, mono: true },
          {
            label: 'Conflicts with',
            value: v.conflictBatches.length > 0 ? v.conflictBatches.join(', ') : null,
            mono: true,
          },
        ]}
      />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        This load&apos;s batch/block doesn&apos;t match what&apos;s already on file for it — it may
        genuinely have moved blocks, or the source report may be carrying the wrong code.
      </p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span>
          Confirm which batch/block this load actually belongs to, then correct the row in RC
          IN/RC OUT — or dismiss if the reassignment is expected.
        </span>
      </p>
    </DetailShell>
  )
}

// ── batch_auto_created ────────────────────────────────────────────────────────

function asAutoCreatedBatch(row: unknown): AutoCreatedBatch | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (typeof o.batch_code !== 'string' || typeof o.location_ref !== 'string') return null
  return o as unknown as AutoCreatedBatch
}

function BatchAutoCreatedDetail({ note }: { note: AutoCreatedBatch }) {
  const isFeed = note.location_ref === ''

  return (
    <DetailShell
      icon={<PackagePlus className="h-3 w-3" />}
      badge="New batch created automatically"
      badgeClass="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      hint="Visibility only — nothing to do"
      title={note.batch_code}
    >
      <FieldGrid
        rows={[
          { label: 'Location', value: isFeed ? '(feed / no block)' : note.location_ref, mono: true },
          { label: 'Date', value: note.transaction_date, mono: true },
          { label: 'Block', value: note.block_loc, mono: true },
          {
            label: 'Source row',
            value: note.source_row != null ? String(note.source_row) : null,
            mono: true,
          },
        ]}
      />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The batch code was new but pattern-valid (a real month + year + block/feed number), so
        the sync created it and wrote the row automatically.
      </p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span>
          Nothing needed — informational only. Double-check the code is correct next time
          you&apos;re in Blocking/RC IN.
        </span>
      </p>
    </DetailShell>
  )
}

// ── generic fallback (every other held kind) ────────────────────────────────────

/** Title-case a snake_case JSON key into a field label ("truck_plate" → "Truck Plate"). */
function fieldLabel(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const COST_KEY_RE = /cost|price|php|peso/i

function GenericHeldDetail({
  kind,
  row,
  reason,
  detail,
  naturalKey,
}: {
  kind: string
  row: unknown
  reason?: string | null
  detail?: string | null
  naturalKey?: string | null
}) {
  const o = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<
    string,
    unknown
  >
  const fields = Object.entries(o)
    .filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && !COST_KEY_RE.test(k))
    .map(([k, v]) => ({ label: fieldLabel(k), value: String(v), mono: typeof v === 'number' }))

  const summary = reason || detail || 'This needs a look — see the details below.'

  return (
    <DetailShell
      icon={<HelpCircle className="h-3 w-3" />}
      badge={kindLabel(kind)}
      badgeClass="bg-amber-500/15 text-amber-600 dark:text-amber-400"
      hint="Sync flag"
      title={naturalKey ?? kindLabel(kind)}
    >
      <FieldGrid rows={fields} />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span>
          Review the row in the source report, correct it if needed, then re-sync — or dismiss if
          this flag is a false positive.
        </span>
      </p>
    </DetailShell>
  )
}

// ── public switch ─────────────────────────────────────────────────────────────

/**
 * Render the first-class, deterministic-only detail for a case kind — the SAME dense
 * 3-part shape (badge + plain summary, a compact fact table, a plain "what this means /
 * what to do" line) for every kind, so nothing falls back to blank when the AI verdict
 * card is dormant (`SYNC_AI_REVIEW_ENABLED=false`, see `lib/sync/config.ts`).
 *
 * `source_diff` and `run_triage` return null on purpose — they have their OWN dedicated
 * cards rendered elsewhere in `CaseDetail.tsx` (`SourceDiffCard`, `TriageSummaryCard` /
 * `GroupResolutionCard`) and must never be duplicated here. Every other kind — the four
 * reconciliation kinds with bespoke renderers, PLUS every remaining `HeldKind` — gets a
 * card via `GenericHeldDetail`, which reads whatever fields the row actually carries.
 */
export function CaseFindingDetail({
  kind,
  row,
  reason,
  detail,
  naturalKey,
}: {
  kind: string
  row: unknown
  reason?: string | null
  detail?: string | null
  naturalKey?: string | null
}) {
  if (kind === 'block_diff') {
    const d = asBlockDiff(row)
    return d ? <BlockDiffDetail d={d} /> : null
  }
  if (kind === 'single_source_overdue') {
    const o = asOverdue(row)
    return o ? <OverdueDetail o={o} /> : null
  }
  if (kind === 'attribution_diff') {
    const a = asAttributionDiff(row)
    return a ? <AttributionDiffDetail a={a} /> : null
  }
  if (kind === 'unmapped_batch_code' || kind === 'unresolved_batch') {
    return <UnmappedBatchDetail row={row} />
  }
  if (kind === 'gate_failure') {
    return <GateFailureDetail row={row} naturalKey={naturalKey} />
  }
  if (kind === 'cross_batch_reassignment') {
    return <CrossBatchReassignmentDetail row={row} naturalKey={naturalKey} />
  }
  if (kind === 'batch_auto_created') {
    const note = asAutoCreatedBatch(row)
    return note ? <BatchAutoCreatedDetail note={note} /> : null
  }
  if (kind === 'source_diff' || kind === 'run_triage') return null

  return (
    <GenericHeldDetail kind={kind} row={row} reason={reason} detail={detail} naturalKey={naturalKey} />
  )
}
