/**
 * decision-cards.ts — 11 findings are really 4 DECISIONS.
 *
 * THE PROBLEM. `flattenRunFindings` returns an honest, flat list of everything a run
 * flagged, and the panel rendered it one prose line per entry. On run `312b3213` that was
 * eleven lines — but a person facing them has only FOUR things to decide:
 *
 *   1. one delivery a human owns, disagreed with by TWO sources (two lines, one row, one
 *      decision: keep my edit, or hand the row back);
 *   2. two prices taken from a differently-spelled row (confirm the truck, or go fix it);
 *   3. five blocks whose balance disagrees with the Sheet (acknowledge — nothing to fix
 *      in the app);
 *   4. …and a grand total whose every kilogram is already explained by those five, which
 *      was rendering as a SIXTH alarm beside them.
 *
 * This module is the ONE definition of that regrouping. It is PURE — no React, no
 * network, no `Date.now()` — so `scripts/verify-decision-cards.ts` can assert its
 * behaviour directly, and both surfaces (the Run Sync panel today, anything else later)
 * get the same cards rather than two hand-rolled groupings that drift.
 *
 * ═══ WHAT IT DOES NOT DO ══════════════════════════════════════════════════════════
 * It does not decide what the SYNC reports, and it never drops a finding. Every input
 * finding comes out inside exactly one card (or one footer), so "regroup" here means
 * regroup, never filter. The only thing that hides a card is a human's own
 * acknowledgement — see below.
 *
 * ═══ ACKNOWLEDGED UNTIL IT CHANGES ════════════════════════════════════════════════
 * `lib/sync/findings.ts::findingIdentity` gives every finding a `fingerprint` (WHICH
 * discrepancy) and a `contentHash` (WHAT it currently says). A card is acknowledged when
 * the stored hash for each of its fingerprints still equals the current one; a changed
 * hash means the situation moved since somebody looked, and the card comes back.
 *
 * ONE COMPOSITION RULE, and it exists because of a measured case. `findingIdentity`
 * deliberately gives BOTH `delivery_human_edited` findings for one delivery the SAME
 * fingerprint ("acknowledging it once answers both"), but their `contentHash` differs —
 * on run `312b3213` the emailed report says the source's remarks are `"DONE FEED"` while
 * the Sheet says they are empty, so the two findings genuinely say different things about
 * one row. A per-finding comparison would therefore never hide that card. So a card's
 * hash PER FINGERPRINT is the combination of its members': byte-identical to the single
 * hash in the ordinary one-member case (which is every other kind), and a sorted join
 * when a fingerprint really does carry two statements. This composes `findingIdentity`;
 * it does not redefine it, and nothing else may build an ack key.
 */

import {
  findingIdentity,
  type FindingBadge,
  type FindingSeverity,
  type RunFinding,
} from './findings'

// ============================================================================
// Shapes
// ============================================================================

/** The buttons a card can offer. Mirrors `acks.ts::FindingAckAction` plus the release. */
export type DecisionActionKind = 'acknowledge' | 'keep_mine' | 'take_source' | 'same_truck'

/** The four decision shapes. `other` keeps a finding's existing rendering + [Acknowledge]. */
export type DecisionCardKind =
  | 'delivery_human_edited'
  | 'price_fuzzy_match'
  | 'block_diff'
  | 'other'

/** One row of the ack ledger, as the caller holds it (`acks.ts::CurrentAck`). */
export interface AckLike {
  action: string
  contentHash: string
  acked_at: string
}

/** What `acknowledgeFinding` needs for ONE fingerprint this card speaks for. */
export interface AckTarget {
  fingerprint: string
  /** The `RunFinding.kind` — carried for readability, never for identity. */
  kind: string
  /** Composed per the rule in this file's header. */
  contentHash: string
}

/** One field two sides disagree about, already formatted for display. */
export interface FieldChange {
  field: string
  /** Plain word for the field ("notes", "weight", "price"). */
  label: string
  /** What the app holds — the human's own value. */
  yours: string
  /** What the source says. */
  source: string
  /**
   * True when the values were withheld because the field is cost-ish. The findings
   * channel is NOT price-gated, so a refused ₱ arrives by NAME ONLY; this module never
   * invents a number to fill the gap and the UI must print the label, not a value.
   */
  redacted: boolean
}

/** One source's proposal against a delivery a human owns. */
export interface SourceProposal {
  /** `deliveries` (the emailed report) or `gsheet`. */
  section: string
  /** The finding's own plain source label ("Google Sheet — RC IN"). */
  label: string
  changes: FieldChange[]
}

/** The two spellings of one field, side by side. */
export interface Spelling {
  field: string
  label: string
  /** Our spelling. */
  ours: string
  /** Czarina's spelling. */
  theirs: string
}

/** A quiet line UNDER a group — never an alarm of its own. */
export interface DecisionFooter {
  id: string
  /** Already-composed operator sentence. */
  text: string
  /** The finding it stands for; still counted, still copyable, just not alarming. */
  finding: RunFinding
}

export interface DecisionCard {
  /** Stable across runs and unique within a run — safe as a React key. */
  id: string
  cardKind: DecisionCardKind
  severity: FindingSeverity
  title: string
  kindLabel: string
  /** Which file raised it, in plain words. */
  source: string
  location: string
  reason: string
  badges: FindingBadge[]
  /** Every finding this card speaks for. Never empty. */
  findings: RunFinding[]
  /** One per DISTINCT fingerprint — what an [Acknowledge] click writes. */
  ackTargets: AckTarget[]
  actions: DecisionActionKind[]
  /** Delivery ids for [Take the source]. Empty for every other card kind. */
  deliveryIds: string[]
  /** `delivery_human_edited` — one block per source that disagrees. */
  proposals: SourceProposal[]
  /** `price_fuzzy_match` — the differently-spelled fields. */
  spellings: Spelling[]
  /** The standing acknowledgement whose content still matches. Null otherwise. */
  ack: { action: string; ackedAt: string } | null
  /**
   * True when a standing acknowledgement EXISTS but the content has moved since. The
   * card is visible again — this is the flag that lets the UI say why.
   */
  ackStale: boolean
}

/** Cards sharing one source file, plus that group's quiet footers. */
export interface DecisionGroup {
  source: string
  /** Unacknowledged cards, loudest first. */
  cards: DecisionCard[]
  /** Acknowledged-and-unchanged cards, hidden behind the "N acknowledged" toggle. */
  acknowledged: DecisionCard[]
  footers: DecisionFooter[]
  /** Severity rank of the loudest visible card (0 = high) — the group's sort key. */
  topRank: number
}

export interface DecisionCardsResult {
  groups: DecisionGroup[]
  /** Cards a human still has to look at. THE "N need you" number. */
  visibleCount: number
  /** Cards hidden by a standing, still-matching acknowledgement. */
  acknowledgedCount: number
  /** Findings inside the visible cards — the honest flag total behind the decisions. */
  visibleFindingCount: number
}

// ============================================================================
// Small pure helpers
// ============================================================================

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, attention: 1, info: 2 }

/**
 * Plain word per delivery field.
 *
 * DELIBERATELY A LOCAL COPY of `findings.ts`'s private `DELIVERY_FIELD_LABEL` rather than
 * an import: that table is not exported, and this module may not edit `findings.ts`.
 * `scripts/verify-decision-cards.ts` pins the two entries that carry meaning here
 * (`cost_basis` → "price", `remarks` → "notes") so a silent drift is caught.
 */
const DELIVERY_FIELD_LABEL: Record<string, string> = {
  supplier: 'supplier',
  batch_code: 'batch code',
  block_loc: 'block',
  truck_plate: 'truck plate',
  sacks: 'sacks',
  weight_kg: 'weight',
  cost_basis: 'price',
  remarks: 'notes',
  lab_results: 'lab results',
}

/** Plain word per price-note comparison field. */
const PRICE_FIELD_LABEL: Record<string, string> = {
  supplier: 'supplier',
  truck_plate: 'truck plate',
  weight_kg: 'weight',
  sacks: 'sacks',
  transaction_date: 'date',
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Is this field one whose VALUES must never be printed? The findings channel carries a
 * refused price by name only (`redacted: true`), but this test does not depend on the
 * worker having set that flag — a cost-ish NAME is enough on its own. Two independent
 * reasons to withhold, exactly as `findingIdentity` does it.
 */
function isRedactedField(field: string, flagged: unknown): boolean {
  if (flagged === true) return true
  const f = field.toLowerCase()
  return (
    f.includes('cost') ||
    f.includes('price') ||
    f.includes('php') ||
    f.includes('amount') ||
    f.includes('value')
  )
}

/** Display one side of a delivery field change. Never a ₱ — the caller gates on redaction. */
function showValue(v: unknown): string {
  if (v == null || v === '') return 'none'
  if (typeof v === 'number') return v.toLocaleString('en-US')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * The ack targets for a set of findings: one per DISTINCT fingerprint, with the content
 * hashes composed per this file's header rule.
 */
function ackTargetsFor(findings: RunFinding[]): AckTarget[] {
  const byFingerprint = new Map<string, { kind: string; hashes: string[] }>()
  for (const f of findings) {
    const { fingerprint, contentHash } = findingIdentity(f)
    const entry = byFingerprint.get(fingerprint)
    if (entry) {
      if (!entry.hashes.includes(contentHash)) entry.hashes.push(contentHash)
    } else {
      byFingerprint.set(fingerprint, { kind: f.kind, hashes: [contentHash] })
    }
  }
  return Array.from(byFingerprint.entries()).map(([fingerprint, { kind, hashes }]) => ({
    fingerprint,
    kind,
    // One statement → the hash itself, byte-identical to `findingIdentity`'s output, so
    // the ordinary case is exactly the comparison the ack ledger documents. Two → a
    // deterministic join, so either one moving re-surfaces the card.
    contentHash: hashes.length === 1 ? hashes[0] : [...hashes].sort().join('+'),
  }))
}

/**
 * Resolve a card's standing acknowledgement. Acknowledged only when EVERY fingerprint the
 * card speaks for has a stored hash equal to the current one — a card that answers two
 * questions is not answered until both are.
 */
function resolveAck(
  targets: AckTarget[],
  acks: ReadonlyMap<string, AckLike>,
): { ack: DecisionCard['ack']; ackStale: boolean } {
  let latest: AckLike | null = null
  let anyStored = false
  for (const t of targets) {
    const stored = acks.get(t.fingerprint)
    if (!stored) return { ack: null, ackStale: false }
    anyStored = true
    if (stored.contentHash !== t.contentHash) return { ack: null, ackStale: true }
    if (!latest || stored.acked_at > latest.acked_at) latest = stored
  }
  if (!anyStored || !latest) return { ack: null, ackStale: false }
  return { ack: { action: latest.action, ackedAt: latest.acked_at }, ackStale: false }
}

// ============================================================================
// Per-kind card builders
// ============================================================================

/**
 * ONE card per delivery, however many sources disagreed about it.
 *
 * The emailed RC DELIVERIES report and the Google Sheet each raise their own finding for
 * the same refused row, so the panel showed two unrelated-looking lines for one physical
 * truckload. They are one decision about one `record_id`, and they are grouped on it.
 */
function buildDeliveryHumanEditCard(recordId: string, findings: RunFinding[]): DecisionCard {
  const primary = findings[0]
  const proposals: SourceProposal[] = findings.map((f) => {
    const raw = Array.isArray(f.data.changed_fields) ? f.data.changed_fields : []
    const changes: FieldChange[] = raw.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>
      const field = str(e.field) ?? '(field)'
      const label = DELIVERY_FIELD_LABEL[field] ?? field
      if (isRedactedField(field, e.redacted)) {
        return { field, label, yours: '(redacted)', source: '(redacted)', redacted: true }
      }
      return {
        field,
        label,
        yours: showValue(e.yours),
        source: showValue(e.sheet),
        redacted: false,
      }
    })
    return { section: str(f.data.section) ?? f.section, label: f.source, changes }
  })

  const where =
    [str(primary.data.transaction_date), str(primary.data.supplier), str(primary.data.batch_code)]
      .filter(Boolean)
      .join(' · ') || primary.location

  const sourceWord = findings.length === 1 ? 'source' : `${findings.length} sources`
  return {
    id: `decision:delivery_human_edited:${recordId}`,
    cardKind: 'delivery_human_edited',
    severity: loudest(findings),
    title: `Your edit was kept — the ${sourceWord} disagree${findings.length === 1 ? 's' : ''}`,
    kindLabel: primary.kindLabel,
    source: primary.source,
    location: where,
    reason:
      'You edited this delivery in the app, so the sync left it alone. Keep your version, ' +
      'or hand the row back so the next run applies the source value.',
    badges: primary.badges ?? [],
    findings,
    ackTargets: ackTargetsFor(findings),
    actions: ['keep_mine', 'take_source'],
    deliveryIds: [recordId],
    proposals,
    spellings: [],
    ack: null,
    ackStale: false,
  }
}

/** One card per fuzzy price match, with the two spellings side by side. */
function buildPriceFuzzyCard(f: RunFinding): DecisionCard {
  const raw = Array.isArray(f.data.differences) ? f.data.differences : []
  const spellings: Spelling[] = raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>
    const field = str(e.field) ?? '(field)'
    return {
      field,
      label: PRICE_FIELD_LABEL[field] ?? field,
      ours: str(e.ours) ?? '—',
      theirs: str(e.theirs) ?? '—',
    }
  })
  return {
    id: `decision:${f.key}`,
    cardKind: 'price_fuzzy_match',
    severity: f.severity,
    title: f.title,
    kindLabel: f.kindLabel,
    source: f.source,
    location: f.location,
    reason: f.reason,
    badges: f.badges ?? [],
    findings: [f],
    ackTargets: ackTargetsFor([f]),
    actions: ['same_truck'],
    deliveryIds: [],
    proposals: [],
    spellings,
    ack: null,
    ackStale: false,
  }
}

/** Any other finding: its existing rendering, plus one [Acknowledge]. */
function buildGenericCard(f: RunFinding, cardKind: DecisionCardKind = 'other'): DecisionCard {
  return {
    id: `decision:${f.key}`,
    cardKind,
    severity: f.severity,
    title: f.title,
    kindLabel: f.kindLabel,
    source: f.source,
    location: f.location,
    reason: f.reason,
    badges: f.badges ?? [],
    findings: [f],
    ackTargets: ackTargetsFor([f]),
    actions: ['acknowledge'],
    deliveryIds: [],
    proposals: [],
    spellings: [],
    ack: null,
    ackStale: false,
  }
}

function loudest(findings: RunFinding[]): FindingSeverity {
  let rank = 2
  let sev: FindingSeverity = 'info'
  for (const f of findings) {
    const r = SEVERITY_RANK[f.severity]
    if (r < rank) {
      rank = r
      sev = f.severity
    }
  }
  return sev
}

/**
 * The grand-total line, as the quiet footer it earned.
 *
 * `fully_accounted` means every kilogram of the total gap is already inside the per-block
 * lines the operator is about to read. Rendered as a sixth alarm it said nothing the five
 * had not; rendered underneath them it says the reassuring thing — which is exactly the
 * signal that was hiding in the last sentence of a red paragraph before 2026-08-12.
 */
function grandTotalFooterText(f: RunFinding): string {
  const delta = num(f.data.delta)
  const count = num(f.data.accounted_block_count)
  const gap = delta == null ? 'The total gap' : `Total gap ${fmtInt(Math.abs(delta))} kg`
  const blocks =
    count == null || count <= 0
      ? 'fully explained by the blocks flagged here'
      : `fully explained by the ${count} block${count === 1 ? '' : 's'} flagged here`
  return `${gap} — ${blocks}. Nothing unexplained.`
}

// ============================================================================
// The public API
// ============================================================================

/**
 * Regroup a run's findings into decision cards, resolve each card's standing
 * acknowledgement, and bucket them by source file.
 *
 * Pure and total: no input can make it throw, and every finding lands in exactly one
 * card or one footer.
 *
 * @param findings `flattenRunFindings(result)` — in any order.
 * @param acks     `fetchCurrentAcks()`'s map, keyed by fingerprint. An empty map is the
 *                 honest default: everything shows.
 */
export function buildDecisionCards(
  findings: readonly RunFinding[],
  acks: ReadonlyMap<string, AckLike> = new Map(),
): DecisionCardsResult {
  const cards: DecisionCard[] = []
  const footers = new Map<string, DecisionFooter[]>()

  // ── 1. Deliveries a human owns: one card per record_id, across every source. ──
  const humanEdits = new Map<string, RunFinding[]>()
  // ── 2. Blocking: per-block lines vs the grand total, decided together. ────────
  const perBlock: RunFinding[] = []
  const grandTotals: RunFinding[] = []
  const rest: RunFinding[] = []

  for (const f of findings) {
    if (f.kind === 'delivery_human_edited') {
      const recordId = str(f.data.record_id)
      if (recordId) {
        const list = humanEdits.get(recordId)
        if (list) list.push(f)
        else humanEdits.set(recordId, [f])
        continue
      }
      // No record_id — nothing to group on and nothing to release. Falls through to a
      // generic card rather than being silently dropped.
      rest.push(f)
      continue
    }
    if (f.kind === 'block_diff') {
      if (str(f.data.subkind) === 'grand_total') grandTotals.push(f)
      else perBlock.push(f)
      continue
    }
    rest.push(f)
  }

  for (const [recordId, list] of humanEdits) {
    cards.push(buildDeliveryHumanEditCard(recordId, list))
  }
  for (const f of perBlock) cards.push(buildGenericCard(f, 'block_diff'))
  for (const f of grandTotals) {
    // A fully-accounted total with blocks to sit under is a FOOTER; with nothing to sit
    // under, or with kilograms no flagged block explains, it stays a first-class alarm.
    const fullyAccounted = f.data.fully_accounted === true
    if (fullyAccounted && perBlock.length > 0) {
      const list = footers.get(f.source)
      const footer: DecisionFooter = {
        id: `footer:${f.key}`,
        text: grandTotalFooterText(f),
        finding: f,
      }
      if (list) list.push(footer)
      else footers.set(f.source, [footer])
    } else {
      cards.push(buildGenericCard(f, 'block_diff'))
    }
  }
  for (const f of rest) {
    cards.push(f.kind === 'price_fuzzy_match' ? buildPriceFuzzyCard(f) : buildGenericCard(f))
  }

  // ── 3. Resolve each card's standing acknowledgement. ─────────────────────────
  for (const card of cards) {
    const { ack, ackStale } = resolveAck(card.ackTargets, acks)
    card.ack = ack
    card.ackStale = ackStale
  }

  // ── 4. Bucket by source file, loudest group first (the panel's existing shape). ──
  const bySource = new Map<string, DecisionGroup>()
  const ensure = (source: string): DecisionGroup => {
    const existing = bySource.get(source)
    if (existing) return existing
    const created: DecisionGroup = {
      source,
      cards: [],
      acknowledged: [],
      footers: footers.get(source) ?? [],
      topRank: 3,
    }
    bySource.set(source, created)
    return created
  }
  // A group can exist for footers alone (every block card acknowledged) — create those
  // buckets first so a footer is never lost with its group.
  for (const source of footers.keys()) ensure(source)
  for (const card of cards) {
    const group = ensure(card.source)
    if (card.ack) group.acknowledged.push(card)
    else {
      group.cards.push(card)
      group.topRank = Math.min(group.topRank, SEVERITY_RANK[card.severity])
    }
  }

  const groups = Array.from(bySource.values())
    .map((g) => ({
      ...g,
      cards: [...g.cards].sort(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
      ),
      acknowledged: [...g.acknowledged].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.topRank - b.topRank || b.cards.length - a.cards.length)

  let visibleCount = 0
  let acknowledgedCount = 0
  let visibleFindingCount = 0
  for (const g of groups) {
    visibleCount += g.cards.length
    acknowledgedCount += g.acknowledged.length
    for (const c of g.cards) visibleFindingCount += c.findings.length
  }

  return { groups, visibleCount, acknowledgedCount, visibleFindingCount }
}

/**
 * THE "N need you" number for the dashboard: how many decisions on this run are still
 * waiting. Same comparison as the panel, by construction — it IS the panel's count.
 */
export function countDecisionsNeedingYou(
  findings: readonly RunFinding[],
  acks: ReadonlyMap<string, AckLike> = new Map(),
): { decisions: number; flags: number } {
  const r = buildDecisionCards(findings, acks)
  return { decisions: r.visibleCount, flags: r.visibleFindingCount }
}

/** Every string a card renders, for the price-leak assertion in the verify script. */
export function cardText(card: DecisionCard): string {
  const parts = [card.title, card.kindLabel, card.source, card.location, card.reason]
  for (const b of card.badges) parts.push(b.label, b.hint)
  for (const p of card.proposals) {
    parts.push(p.label)
    for (const c of p.changes) parts.push(c.label, c.yours, c.source)
  }
  for (const s of card.spellings) parts.push(s.label, s.ours, s.theirs)
  return parts.join(' | ')
}
