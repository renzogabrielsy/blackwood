'use client'

import * as React from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { AlertTriangle, Check, Copy, Eye, EyeOff, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { FindingSeverity, RunFinding } from '@/lib/sync/findings'
import type {
  DecisionCard,
  DecisionCardsResult,
  DecisionFooter,
  DecisionGroup,
} from '@/lib/sync/decision-cards'
import type { FindingAcksApi } from './useFindingAcks'
import { FINDING_BADGE_CLASS } from './cases/labels'

/**
 * DecisionCards — the 4-card regroup, rendered.
 *
 * The panel used to print one prose line per finding, each ending in a sentence written
 * for a human ("please confirm…") beside no button at all. This renders the same findings
 * as DECISIONS: one card per thing a person has to answer, with the button that answers
 * it, and a quiet footer for the grand total whose kilograms the blocks above already
 * explain.
 *
 * Grouping, ack state and every displayed value come from `lib/sync/decision-cards.ts`
 * (pure, verified by `scripts/verify-decision-cards.ts`). This file decides only how they
 * LOOK — Excel-standard density: `text-[11px]`/`text-[10px]`, `px-2 py-1`, font-mono
 * numerics. It is an operator surface.
 *
 * TWO RULES IT MUST NOT BREAK:
 *   • Buttons are PRIVILEGED-ONLY. `isPrivileged` is passed in from the same
 *     `PRIVILEGED_ROLES.includes(role)` test that gates Run Sync — never re-derived here,
 *     and never the only gate (every action re-checks server-side).
 *   • NO ₱, EVER. The findings channel is not price-gated, so a refused price arrives
 *     redacted; the pure module renders it as "(redacted)" and this file prints whatever
 *     it is given without reaching back into `data` for a value.
 */

// ============================================================================
// Presentation tables (severity styling shared with the old flat list)
// ============================================================================

const SEVERITY_STYLE: Record<FindingSeverity, { edge: string; dot: string; label: string }> = {
  high: { edge: 'border-l-red-500/70', dot: 'bg-red-500', label: 'text-red-600 dark:text-red-400' },
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

/** What a stored answer is called on screen. */
const ACTION_LABEL: Record<string, string> = {
  acknowledge: 'acknowledged',
  keep_mine: 'keeping your edit',
  same_truck: 'same truck',
}

function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

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
  emphasis?: boolean
}

/**
 * The load-bearing numbers/identifiers of a finding, as font-mono chips. Carried over
 * verbatim from the flat list — the glance that lets an operator pinpoint a row.
 */
function dataChips(f: RunFinding): DataChip[] {
  const d = f.data
  const chips: DataChip[] = []

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

  if ('sheet_kg' in d || 'computed_kg' in d) {
    push('sheet', 'sheet_kg', true)
    push('app', 'computed_kg', true)
    push('Δ', 'delta', true)
    push('unexplained', 'residual_kg', true)
    push('sheet batch', 'sheet_batch')
    push('app batch', 'computed_batch')
    return chips
  }

  if ('source' in d && 'value' in d) {
    const src = typeof d.source === 'string' ? d.source : 'source'
    chips.push({ label: src, value: fmtChipValue('value', d.value), emphasis: true })
    push('days overdue', 'ageDays')
  }

  push('batch', 'batch_code')
  if (!('batch_code' in d)) push('batch', 'batch')
  push('date', 'transaction_date')
  push('block', 'block_loc')
  push('weight', 'weight_kg', true)
  return chips
}

/** Copy a whole decision — every finding it speaks for — as plain text. */
function copyCard(card: DecisionCard) {
  const parts: string[] = [card.title, `source: ${card.source}`, `where: ${card.location}`]
  for (const f of card.findings) {
    parts.push(`— ${f.title}`, `  why: ${f.reason}`, `  data: ${JSON.stringify(f.data)}`)
  }
  void navigator.clipboard.writeText(parts.join('\n')).then(() => {
    toast.success('Decision copied', { duration: 2000 })
  })
}

function relative(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'earlier'
  return formatDistanceToNow(d, { addSuffix: true })
}

// ============================================================================
// Card bodies — the per-kind detail the flat list could not show
// ============================================================================

/**
 * A delivery a human owns: what YOU have against what EACH source proposes.
 *
 * The old rendering put two findings for the same truckload on two unrelated lines, so
 * the reader had to notice they shared a record id. Here the row is named once and every
 * source's proposal sits beneath it, which is also exactly what the confirm step needs to
 * show before releasing.
 */
function ProposalTable({ card }: { card: DecisionCard }) {
  return (
    <div className="mt-1.5 overflow-x-auto rounded border border-border/70 bg-background/50">
      {/* Never crush, always scroll: 96 + 84 fixed = 180px + a 130px floor each for the
          two value columns → 440px. */}
      <table className="w-full min-w-[440px] table-fixed border-collapse text-[10px]">
        <colgroup>
          <col className="w-[96px]" />
          <col className="w-[84px]" />
          <col className="min-w-[130px]" />
          <col className="min-w-[130px]" />
        </colgroup>
        <thead className="bg-muted/60 text-[9px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Source</th>
            <th className="px-2 py-1 text-left font-medium">Field</th>
            <th className="px-2 py-1 text-left font-medium">Yours (kept)</th>
            <th className="px-2 py-1 text-left font-medium">Source says</th>
          </tr>
        </thead>
        <tbody>
          {card.proposals.flatMap((p) =>
            p.changes.map((c, i) => (
              <tr key={`${p.section}-${c.field}-${i}`} className="border-t border-border/50">
                <td className="px-2 py-1 align-top text-muted-foreground">
                  {i === 0 ? p.label : ''}
                </td>
                <td className="px-2 py-1 align-top text-foreground">{c.label}</td>
                <td className="px-2 py-1 align-top font-mono text-emerald-700 dark:text-emerald-400">
                  {c.redacted ? (
                    <span className="italic text-muted-foreground">price (redacted)</span>
                  ) : (
                    c.yours
                  )}
                </td>
                <td className="px-2 py-1 align-top font-mono text-amber-700 dark:text-amber-400">
                  {c.redacted ? (
                    <span className="italic text-muted-foreground">price (redacted)</span>
                  ) : (
                    c.source
                  )}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  )
}

/** The two spellings of one truckload, side by side — the whole content of the decision. */
function SpellingTable({ card }: { card: DecisionCard }) {
  if (card.spellings.length === 0) return null
  return (
    <div className="mt-1.5 overflow-x-auto rounded border border-border/70 bg-background/50">
      {/* 84px fixed + a 150px floor each side → 384px. */}
      <table className="w-full min-w-[384px] table-fixed border-collapse text-[10px]">
        <colgroup>
          <col className="w-[84px]" />
          <col className="min-w-[150px]" />
          <col className="min-w-[150px]" />
        </colgroup>
        <thead className="bg-muted/60 text-[9px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Field</th>
            <th className="px-2 py-1 text-left font-medium">Ours</th>
            <th className="px-2 py-1 text-left font-medium">Czarina&apos;s</th>
          </tr>
        </thead>
        <tbody>
          {card.spellings.map((s) => (
            <tr key={s.field} className="border-t border-border/50">
              <td className="px-2 py-1 text-foreground">{s.label}</td>
              <td className="px-2 py-1 font-mono text-foreground">{s.ours}</td>
              <td className="px-2 py-1 font-mono text-foreground">{s.theirs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============================================================================
// The action row
// ============================================================================

interface CardActionsProps {
  card: DecisionCard
  api: FindingAcksApi
  isPrivileged: boolean
}

/**
 * The buttons. Nothing here writes delivery or production data except *[Take the source]*,
 * and that one clears an ownership stamp — it changes no value on the row, which is why it
 * is safe to offer as one click behind a confirm.
 */
function CardActions({ card, api, isPrivileged }: CardActionsProps) {
  const [confirming, setConfirming] = React.useState(false)
  const busy = card.ackTargets.some((t) => api.pending.has(t.fingerprint))

  if (!isPrivileged) return null

  const ack = (action: 'acknowledge' | 'keep_mine' | 'same_truck') => {
    void api.acknowledge(card.ackTargets, action)
  }

  const confirmRelease = () => {
    void api.takeSource(card.deliveryIds, card.ackTargets).then((r) => {
      setConfirming(false)
      if (!r.ok) return
      if (r.released === 0) {
        toast.success('Already following the source — nothing to hand back', { duration: 4000 })
        return
      }
      toast.success('Handed back to the sync — the next run will apply the source value', {
        duration: 6000,
      })
    })
  }

  return (
    <div className="mt-1.5 pl-3">
      {card.cardKind === 'delivery_human_edited' ? (
        confirming ? (
          /* The ONE button here that leads to a data change gets a confirm step, and the
             confirm restates BOTH values — the thing that is about to be replaced, and
             what will replace it. */
          <div className="animate-fade-up rounded border border-amber-500/40 bg-amber-500/5 p-2">
            <p className="flex items-start gap-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Are you sure? Your edit to{' '}
                <span className="font-medium">
                  {Array.from(
                    new Set(card.proposals.flatMap((p) => p.changes.map((c) => c.label))),
                  ).join(', ') || 'this delivery'}
                </span>{' '}
                will be replaced next run.
              </span>
            </p>
            <ProposalTable card={card} />
            <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
              This button writes nothing to the delivery — it only hands the row back, so the
              next sync run may apply the source value through its normal audited path.
            </p>
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={confirmRelease}
                className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-800 transition-all duration-150 hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Undo2 className="h-3 w-3" />
                )}
                Confirm — hand it back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="rounded border border-border bg-background/60 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-all duration-150 hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <ActionButton
              busy={busy}
              icon={<Check className="h-3 w-3" />}
              label="Keep mine"
              title="My edit is right — record that, and stop showing this until the source changes."
              onClick={() => ack('keep_mine')}
            />
            <ActionButton
              busy={busy}
              variant="warn"
              icon={<Undo2 className="h-3 w-3" />}
              label="Take the source"
              title="Hand this delivery back to the sync so the next run may apply the source value."
              onClick={() => setConfirming(true)}
            />
          </div>
        )
      ) : card.cardKind === 'price_fuzzy_match' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <ActionButton
            busy={busy}
            icon={<Check className="h-3 w-3" />}
            label="Same truck"
            title="Yes — those two differently-spelled rows are the same truckload."
            onClick={() => ack('same_truck')}
          />
          <span className="text-[10px] leading-snug text-muted-foreground">
            Not the same? —{' '}
            <Link href="/inventory/rc-in" className="underline underline-offset-2 hover:text-foreground">
              fix the price in RC IN
            </Link>
            .
          </span>
        </div>
      ) : (
        <ActionButton
          busy={busy}
          icon={<Check className="h-3 w-3" />}
          label="Acknowledge"
          title="I have seen this. Stay quiet until it changes."
          onClick={() => ack('acknowledge')}
        />
      )}
    </div>
  )
}

function ActionButton({
  busy,
  icon,
  label,
  title,
  onClick,
  variant = 'default',
}: {
  busy: boolean
  icon: React.ReactNode
  label: string
  title: string
  onClick: () => void
  variant?: 'default' | 'warn'
}) {
  return (
    <button
      type="button"
      disabled={busy}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-all duration-150 disabled:opacity-50',
        variant === 'warn'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400'
          : 'border-border bg-background/60 text-foreground hover:bg-muted',
      )}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
      {label}
    </button>
  )
}

// ============================================================================
// The card
// ============================================================================

function DecisionCardView({
  card,
  api,
  isPrivileged,
  muted = false,
}: {
  card: DecisionCard
  api: FindingAcksApi
  isPrivileged: boolean
  muted?: boolean
}) {
  const sev = SEVERITY_STYLE[card.severity]
  return (
    <li
      className={cn(
        'rounded border border-l-2 border-border/70 bg-background/60 p-1.5',
        sev.edge,
        muted && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', sev.dot)} />
            <p className="text-[11px] font-medium leading-snug text-foreground">{card.title}</p>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-3">
            <span
              className={cn(
                'rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                sev.label,
              )}
            >
              {card.kindLabel}
            </span>
            {card.badges.map((b) => (
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
            {card.findings.length > 1 && (
              <span
                title="Two sources raised this about the same row — one decision answers both."
                className="rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {card.findings.length} sources
              </span>
            )}
            {/* An acknowledgement that no longer matches: the situation moved, so the card
                is back. Saying WHY is the whole value of a content hash. */}
            {card.ackStale && (
              <span
                title="You acknowledged this before, but what it says has changed since."
                className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
              >
                Changed since you looked
              </span>
            )}
            <span className="font-mono text-[9px] text-muted-foreground">{card.location}</span>
          </div>

          {card.cardKind === 'delivery_human_edited' && <div className="pl-3"><ProposalTable card={card} /></div>}
          {card.cardKind === 'price_fuzzy_match' && <div className="pl-3"><SpellingTable card={card} /></div>}

          {card.cardKind !== 'delivery_human_edited' && (
            <div className="mt-1 flex flex-wrap items-center gap-1 pl-3">
              {dataChips(card.findings[0]).map((c, i) => (
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

          {card.reason && (
            <p className="mt-1 pl-3 text-[10px] leading-snug text-muted-foreground/90">
              {card.reason}
            </p>
          )}

          {card.ack ? (
            <p className="mt-1 pl-3 text-[10px] leading-snug text-muted-foreground">
              acknowledged {relative(card.ack.ackedAt)} ·{' '}
              {ACTION_LABEL[card.ack.action] ?? card.ack.action}
            </p>
          ) : (
            <CardActions card={card} api={api} isPrivileged={isPrivileged} />
          )}
        </div>

        <button
          type="button"
          onClick={() => copyCard(card)}
          title="Copy this decision"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>
    </li>
  )
}

/** The quiet line under a group — the total whose kilograms the blocks above explain. */
function FooterLine({ footer }: { footer: DecisionFooter }) {
  const badge = footer.finding.badges?.[0]
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded border border-dashed border-border/70 bg-muted/20 px-2 py-1">
      <span className="text-[10px] leading-snug text-muted-foreground">{footer.text}</span>
      {badge && (
        <span
          title={badge.hint}
          className={cn(
            'rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            FINDING_BADGE_CLASS[badge.tone],
          )}
        >
          {badge.label}
        </span>
      )}
    </div>
  )
}

// ============================================================================
// The list
// ============================================================================

interface DecisionCardGroupsProps {
  result: DecisionCardsResult
  api: FindingAcksApi
  isPrivileged: boolean
  /** Rendered above the first group — the doorway link the panel already had. */
  groupAction?: (group: DecisionGroup) => React.ReactNode
}

export function DecisionCardGroups({
  result,
  api,
  isPrivileged,
  groupAction,
}: DecisionCardGroupsProps) {
  const [showAcked, setShowAcked] = React.useState(false)
  const acknowledged = React.useMemo(
    () => result.groups.flatMap((g) => g.acknowledged),
    [result.groups],
  )

  return (
    <div className="space-y-2.5">
      {/* The standing acks could not be read. Said out loud rather than folded into
          "nothing is acknowledged" — an empty map and a broken read look identical. */}
      {api.error && (
        <div className="flex items-start justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
          <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
            Could not load which of these you have already acknowledged, so everything is
            shown. {api.error}
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(api.error ?? '')
                .then(() => toast.success('Copied', { duration: 2000 }))
            }}
            className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted"
          >
            Copy
          </button>
        </div>
      )}

      {result.groups.map((group) => (
        <div key={group.source} className="rounded-md border border-border bg-card/50 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              {group.source}
              <span className="font-mono text-[10px] text-muted-foreground">
                ({group.cards.length})
              </span>
            </span>
            {groupAction?.(group)}
          </div>

          {group.cards.length > 0 ? (
            <ul className="space-y-1.5">
              {group.cards.map((card) => (
                <DecisionCardView
                  key={card.id}
                  card={card}
                  api={api}
                  isPrivileged={isPrivileged}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              Everything here is acknowledged.
            </p>
          )}

          {group.footers.map((f) => (
            <FooterLine key={f.id} footer={f} />
          ))}
        </div>
      ))}

      {acknowledged.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAcked((v) => !v)}
            className="inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground"
          >
            {showAcked ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {acknowledged.length} acknowledged
          </button>
          {showAcked && (
            <ul className="animate-fade-up mt-1.5 space-y-1.5">
              {acknowledged.map((card) => (
                <DecisionCardView
                  key={card.id}
                  card={card}
                  api={api}
                  isPrivileged={isPrivileged}
                  muted
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
