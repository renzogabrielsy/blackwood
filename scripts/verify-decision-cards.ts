/**
 * verify-decision-cards.ts — framework-free proof of the 4-card regroup
 * (lib/sync/decision-cards.ts::buildDecisionCards). No DB, no worker, no React.
 *
 * THE REGRESSIONS IT PINS, all four measured on run `312b3213` (11 findings):
 *
 *   1. TWO `delivery_human_edited` findings for ONE delivery are ONE decision. The
 *      emailed report and the Google Sheet each raise their own, and they rendered as two
 *      unrelated prose lines about one physical truckload.
 *   2. The blocking GRAND TOTAL renders UNDER the per-block lines as a quiet footer when
 *      every kilogram is accounted for, and stays a first-class alarm when it is not.
 *      That run's total was Δ 1,531 kg with residual 0 across 5 blocks — it was crying
 *      wolf as a sixth alarm.
 *   3. "Acknowledged UNTIL IT CHANGES": an acknowledgement whose stored content hash
 *      still matches hides the card; a hash that has moved brings it back. Including the
 *      hard case — the two findings above share ONE fingerprint but say DIFFERENT things
 *      (`"DONE FEED"` vs empty), so a naive per-finding comparison could never hide them.
 *   4. NO ₱ EVER REACHES A CARD. A refused `cost_basis` arrives redacted; the card must
 *      print the field's NAME and never a number, whether or not the worker set the flag.
 *
 * Run:  npx tsx scripts/verify-decision-cards.ts
 */
import assert from 'node:assert/strict'

import { findingIdentity, flattenRunFindings, type RunFinding } from '../lib/sync/findings'
import {
  buildDecisionCards,
  cardText,
  countDecisionsNeedingYou,
  type AckLike,
  type DecisionCard,
} from '../lib/sync/decision-cards'
import type {
  BlockDiff,
  DeliveryHumanEdit,
  PriceNote,
  SyncRunResult,
} from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures — run `312b3213`, verbatim from `sync_runs.result`.
// ═══════════════════════════════════════════════════════════════════════════

const DELIVERY_ID = '046e38e3-bc43-48b9-9ff8-3761e1017c41'

/** The two findings one delivery raised — same record, DIFFERENT source values. */
const edits: DeliveryHumanEdit[] = [
  {
    section: 'gsheet',
    table: 'deliveries',
    record_id: DELIVERY_ID,
    transaction_date: '2026-08-12',
    supplier: null,
    batch_code: 'AUG-26-FEED2',
    block_loc: null,
    truck_plate: null,
    changed_fields: [{ field: 'remarks', yours: 'FEED', sheet: null }],
    outcome: 'refused_by_db',
  },
  {
    section: 'deliveries',
    table: 'deliveries',
    record_id: DELIVERY_ID,
    transaction_date: '2026-08-12',
    supplier: 'Tag-at',
    batch_code: 'AUGUST-26-FEED2',
    block_loc: null,
    truck_plate: 'KCA 378',
    changed_fields: [{ field: 'remarks', yours: 'FEED', sheet: 'DONE FEED' }],
    outcome: 'refused_by_db',
  },
]

const priceNote = (over: Partial<PriceNote> = {}): PriceNote => ({
  kind: 'price_fuzzy_match',
  detail:
    'Priced from Czarina\'s "Aug. 2026" row 28, matched on the delivery date, net weight ' +
    'and sack count. The price WAS applied — please confirm the two records are the same truckload.',
  transaction_date: '2026-08-13',
  supplier: 'RE-COOKED',
  batch_code: 'FEEDING AREA',
  truck_plate: 'GGN 249',
  weight_kg: 1615,
  sacks: 49,
  source_row: '30',
  via: 'fallback',
  matched_sheet: 'Aug. 2026',
  matched_row: 28,
  date_tolerance_days: 0,
  looked_for: null,
  tabs_found: [],
  candidates: [],
  source_filename: null,
  tabs_loaded: [],
  rows_loaded: null,
  rows_considered: null,
  collided_on: null,
  differences: [{ field: 'supplier', ours: 'RE-COOKED', theirs: 'LAPAYAG' }],
  collisions: [],
  ...over,
})

const blockDiff = (block: string, sheet: number, app: number): BlockDiff => ({
  kind: 'balance',
  block_loc: block,
  sheet_kg: sheet,
  computed_kg: app,
  delta: sheet - app,
  detail: `Block ${block} balance disagrees: Sheet ${sheet} kg vs app ${app} kg.`,
})

const grandTotal = (over: Partial<BlockDiff> = {}): BlockDiff => ({
  kind: 'grand_total',
  block_loc: null,
  sheet_kg: 10_394_294,
  computed_kg: 10_392_763,
  delta: 1531,
  detail: 'Total inventory disagrees: Sheet 10,394,294 kg vs app 10,392,763 kg (Δ 1,531 kg).',
  residual_kg: 0,
  fully_accounted: true,
  accounted_block_kg: 1531,
  accounted_block_count: 5,
  ...over,
})

/** The run, assembled the way the worker stores it. */
function run(opts: {
  edits?: DeliveryHumanEdit[]
  prices?: PriceNote[]
  blocks?: BlockDiff[]
}): SyncRunResult {
  return {
    reports: {
      deliveries: {
        apply: {
          delivery_human_edits: (opts.edits ?? []).filter((e) => e.section === 'deliveries'),
          price_notes: opts.prices ?? [],
        },
      },
      gsheet: {
        apply: {
          delivery_human_edits: (opts.edits ?? []).filter((e) => e.section === 'gsheet'),
        },
      },
    },
    reconciliation: opts.blocks?.length ? { blocking: { blockDiffs: opts.blocks } } : undefined,
  } as unknown as SyncRunResult
}

const realRun = run({
  edits,
  prices: [
    priceNote(),
    priceNote({
      transaction_date: '2026-08-14',
      supplier: 'Ornales',
      batch_code: 'AUGUST-26-BLK8',
      truck_plate: 'CDD 1689',
      weight_kg: 20_130,
      sacks: 620,
      matched_row: 30,
      differences: [{ field: 'truck_plate', ours: 'CDD 1689', theirs: 'CDD1889' }],
    }),
  ],
  blocks: [
    blockDiff('A-11B', 17_550, 53_790),
    blockDiff('A-5A', 52_549, 48_355),
    blockDiff('A-7A', 20_130, 29_180),
    blockDiff('D-15B', 73_870, 53_473),
    blockDiff('D-20D', 43_347, 21_117),
    grandTotal(),
  ],
})

const realFindings = flattenRunFindings(realRun)

/** Ack every fingerprint a card speaks for, at its CURRENT content. */
function ackCard(card: DecisionCard, action = 'acknowledge'): Map<string, AckLike> {
  const m = new Map<string, AckLike>()
  for (const t of card.ackTargets) {
    m.set(t.fingerprint, {
      action,
      contentHash: t.contentHash,
      acked_at: '2026-08-19T02:00:00.000Z',
    })
  }
  return m
}

function allCards(findings: readonly RunFinding[], acks?: Map<string, AckLike>): DecisionCard[] {
  const r = buildDecisionCards(findings, acks)
  return r.groups.flatMap((g) => [...g.cards, ...g.acknowledged])
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The regroup — 10 findings become 4 decisions + 1 footer.
// ═══════════════════════════════════════════════════════════════════════════

check('the fixture reproduces run 312b3213: 10 findings on the reconciliation channel', () => {
  assert.equal(realFindings.length, 10)
  const kinds = new Map<string, number>()
  for (const f of realFindings) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1)
  assert.equal(kinds.get('delivery_human_edited'), 2)
  assert.equal(kinds.get('price_fuzzy_match'), 2)
  assert.equal(kinds.get('block_diff'), 6)
})

check('two human-edit findings for ONE record collapse to ONE card', () => {
  const cards = allCards(realFindings).filter((c) => c.cardKind === 'delivery_human_edited')
  assert.equal(cards.length, 1, 'one delivery, one decision')
  assert.equal(cards[0].findings.length, 2, 'the card still speaks for BOTH findings')
  assert.deepEqual(cards[0].deliveryIds, [DELIVERY_ID])
  assert.equal(cards[0].proposals.length, 2, 'one proposal block per disagreeing source')
})

check('the human-edit card shows EACH source\'s proposed value beneath', () => {
  const card = allCards(realFindings).find((c) => c.cardKind === 'delivery_human_edited')!
  const bySection = new Map(card.proposals.map((p) => [p.section, p]))
  assert.equal(bySection.get('deliveries')!.changes[0].source, 'DONE FEED')
  assert.equal(bySection.get('gsheet')!.changes[0].source, 'none')
  for (const p of card.proposals) assert.equal(p.changes[0].yours, 'FEED')
})

check('two human-edit findings for TWO records stay two cards', () => {
  const two = run({
    edits: [
      edits[0],
      { ...edits[1], record_id: 'ffffffff-0000-0000-0000-00000000000f' },
    ],
  })
  const cards = allCards(flattenRunFindings(two)).filter(
    (c) => c.cardKind === 'delivery_human_edited',
  )
  assert.equal(cards.length, 2, 'different deliveries are different decisions')
})

check('a fuzzy price match renders BOTH spellings, per field', () => {
  const cards = allCards(realFindings).filter((c) => c.cardKind === 'price_fuzzy_match')
  assert.equal(cards.length, 2, 'one card per note — never merged')
  const supplier = cards.find((c) => c.spellings.some((s) => s.field === 'supplier'))!
  assert.deepEqual(supplier.spellings, [
    { field: 'supplier', label: 'supplier', ours: 'RE-COOKED', theirs: 'LAPAYAG' },
  ])
  const plate = cards.find((c) => c.spellings.some((s) => s.field === 'truck_plate'))!
  assert.deepEqual(plate.spellings, [
    { field: 'truck_plate', label: 'truck plate', ours: 'CDD 1689', theirs: 'CDD1889' },
  ])
  for (const c of cards) assert.deepEqual(c.actions, ['same_truck'])
})

check('the whole run is 8 cards + 1 footer, not 10 undifferentiated lines', () => {
  const r = buildDecisionCards(realFindings)
  // 1 delivery (was 2 lines) + 2 prices + 5 blocks. The 10th finding — the grand total —
  // is the footer, so the count of things asking for a decision drops 10 → 8, and the
  // four DECISION SHAPES of the assessment are all present exactly once.
  assert.equal(r.visibleCount, 8)
  assert.equal(r.acknowledgedCount, 0)
  assert.equal(r.visibleFindingCount, 9, 'the footer is not inside a card')
  const shapes = new Set(r.groups.flatMap((g) => g.cards).map((c) => c.cardKind))
  assert.deepEqual(
    [...shapes].sort(),
    ['block_diff', 'delivery_human_edited', 'price_fuzzy_match'],
    'plus the grand-total footer = the four decision shapes',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. The grand total: footer when accounted for, alarm when not.
// ═══════════════════════════════════════════════════════════════════════════

check('a FULLY ACCOUNTED grand total is a footer under the blocks, not a card', () => {
  const r = buildDecisionCards(realFindings)
  const blockGroup = r.groups.find((g) => g.footers.length > 0)
  assert.ok(blockGroup, 'the blocking group carries the footer')
  assert.equal(blockGroup!.footers.length, 1)
  assert.match(blockGroup!.footers[0].text, /Total gap 1,531 kg/)
  assert.match(blockGroup!.footers[0].text, /fully explained by the 5 blocks/)
  assert.match(blockGroup!.footers[0].text, /Nothing unexplained/)
  const grandCards = r.groups
    .flatMap((g) => [...g.cards, ...g.acknowledged])
    .filter((c) => c.findings.some((f) => f.data.subkind === 'grand_total'))
  assert.equal(grandCards.length, 0, 'it must NOT also be its own alarm')
  // …and the five per-block lines are still five cards.
  assert.equal(blockGroup!.cards.length, 5)
})

check('a grand total with a NON-ZERO residual stays a first-class alarm', () => {
  const withResidual = run({
    blocks: [
      blockDiff('A-11B', 17_550, 53_790),
      grandTotal({ residual_kg: 4200, fully_accounted: false, accounted_block_count: 1 }),
    ],
  })
  const r = buildDecisionCards(flattenRunFindings(withResidual))
  const group = r.groups[0]
  assert.equal(group.footers.length, 0, 'unexplained kilograms are never a quiet footer')
  assert.equal(group.cards.length, 2, 'the block AND the total')
  const grand = group.cards.find((c) => c.findings[0].data.subkind === 'grand_total')!
  assert.deepEqual(grand.actions, ['acknowledge'])
  assert.equal(grand.severity, 'high', 'severity is the engine\'s, untouched')
})

check('a fully-accounted total with NO blocks under it is still shown as a card', () => {
  const lonely = run({ blocks: [grandTotal({ accounted_block_count: 0 })] })
  const r = buildDecisionCards(flattenRunFindings(lonely))
  assert.equal(r.visibleCount, 1, 'a footer with nothing to sit under would be invisible')
  assert.equal(r.groups[0].footers.length, 0)
})

check('nothing is ever dropped: every finding lands in exactly one card or footer', () => {
  const r = buildDecisionCards(realFindings)
  const seen = new Set<string>()
  for (const g of r.groups) {
    for (const c of [...g.cards, ...g.acknowledged]) for (const f of c.findings) seen.add(f.key)
    for (const ft of g.footers) seen.add(ft.finding.key)
  }
  assert.equal(seen.size, realFindings.length, 'regroup means regroup, never filter')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Acknowledged until it changes.
// ═══════════════════════════════════════════════════════════════════════════

check('an acked card with an UNCHANGED hash is hidden', () => {
  const card = allCards(realFindings).find((c) => c.cardKind === 'price_fuzzy_match')!
  const r = buildDecisionCards(realFindings, ackCard(card, 'same_truck'))
  assert.equal(r.visibleCount, 7, 'one fewer decision')
  assert.equal(r.acknowledgedCount, 1)
  const hidden = r.groups.flatMap((g) => g.acknowledged)[0]
  assert.equal(hidden.ack?.action, 'same_truck')
  assert.equal(hidden.ackStale, false)
})

check('an acked card whose CONTENT changed comes back, flagged stale', () => {
  const card = allCards(realFindings).find((c) => c.cardKind === 'price_fuzzy_match')!
  const stale = new Map<string, AckLike>()
  for (const t of card.ackTargets) {
    stale.set(t.fingerprint, {
      action: 'same_truck',
      contentHash: 'a-hash-from-a-different-situation',
      acked_at: '2026-08-19T02:00:00.000Z',
    })
  }
  const r = buildDecisionCards(realFindings, stale)
  assert.equal(r.visibleCount, 8, 'back on screen')
  assert.equal(r.acknowledgedCount, 0)
  const back = r.groups.flatMap((g) => g.cards).find((c) => c.id === card.id)!
  assert.equal(back.ackStale, true, 'the UI can say WHY it is back')
})

check('the two-source human-edit card: ONE fingerprint, TWO statements, still hideable', () => {
  const card = allCards(realFindings).find((c) => c.cardKind === 'delivery_human_edited')!
  // findingIdentity deliberately folds both sources onto one fingerprint…
  const ids = card.findings.map((f) => findingIdentity(f))
  assert.equal(new Set(ids.map((i) => i.fingerprint)).size, 1, 'one row, one decision')
  // …but they say different things, so a naive per-finding compare could never match.
  assert.equal(new Set(ids.map((i) => i.contentHash)).size, 2, 'the measured hard case')
  assert.equal(card.ackTargets.length, 1, 'one ledger row, not two')
  const r = buildDecisionCards(realFindings, ackCard(card, 'keep_mine'))
  assert.equal(r.acknowledgedCount, 1, 'the composite hash makes it hideable')
  // Move ONE of the two statements → the card must return.
  const moved = flattenRunFindings(
    run({
      edits: [edits[0], { ...edits[1], changed_fields: [{ field: 'remarks', yours: 'FEED', sheet: 'FEEDING DONE' }] }],
      prices: [],
      blocks: [],
    }),
  )
  const r2 = buildDecisionCards(moved, ackCard(card, 'keep_mine'))
  assert.equal(r2.acknowledgedCount, 0, 'either source moving re-alarms the row')
  assert.equal(r2.groups.flatMap((g) => g.cards)[0].ackStale, true)
})

check('a card is not acknowledged until EVERY fingerprint it speaks for is', () => {
  const card = allCards(realFindings).find((c) => c.cardKind === 'delivery_human_edited')!
  const partial = new Map<string, AckLike>()
  // Deliberately store nothing — a card with an unanswered fingerprint stays visible.
  const r = buildDecisionCards(realFindings, partial)
  assert.equal(r.acknowledgedCount, 0)
  assert.ok(card.ackTargets.length >= 1)
})

check('an empty ack map hides nothing, and an unknown fingerprint hides nothing', () => {
  const noise = new Map<string, AckLike>([
    ['not-a-fingerprint-in-this-run', { action: 'acknowledge', contentHash: 'x', acked_at: 'z' }],
  ])
  assert.equal(buildDecisionCards(realFindings, noise).visibleCount, 8)
  assert.equal(buildDecisionCards(realFindings).visibleCount, 8)
})

check('countDecisionsNeedingYou is the panel\'s own number', () => {
  assert.deepEqual(countDecisionsNeedingYou(realFindings), { decisions: 8, flags: 9 })
  assert.deepEqual(countDecisionsNeedingYou([]), { decisions: 0, flags: 0 })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. No ₱ ever reaches a card.
// ═══════════════════════════════════════════════════════════════════════════

const PESO = /[₱]|php|cost_basis/i

check('a REDACTED cost_basis renders its NAME and never a value', () => {
  const priced = run({
    edits: [
      {
        ...edits[1],
        changed_fields: [{ field: 'cost_basis', yours: null, sheet: null, redacted: true }],
      },
    ],
  })
  const card = allCards(flattenRunFindings(priced))[0]
  assert.equal(card.proposals[0].changes[0].label, 'price')
  assert.equal(card.proposals[0].changes[0].redacted, true)
  assert.equal(card.proposals[0].changes[0].yours, '(redacted)')
  assert.equal(card.proposals[0].changes[0].source, '(redacted)')
  assert.ok(!PESO.test(cardText(card)), `₱ leaked: ${cardText(card)}`)
})

check('a cost-ish field with the flag MISSING is withheld anyway', () => {
  // Belt and braces: the strip must not depend on the worker having set `redacted`.
  const leaky = run({
    edits: [
      {
        ...edits[1],
        changed_fields: [{ field: 'cost_basis', yours: 42.5, sheet: 48.1612 }],
      },
    ],
  })
  const card = allCards(flattenRunFindings(leaky))[0]
  assert.equal(card.proposals[0].changes[0].redacted, true)
  const text = cardText(card)
  assert.ok(!text.includes('42.5'), `a price value leaked: ${text}`)
  assert.ok(!text.includes('48.16'), `a price value leaked: ${text}`)
  assert.ok(!PESO.test(text), `₱ leaked: ${text}`)
})

check('no card in the whole run mentions a peso, in any field it renders', () => {
  for (const c of allCards(realFindings)) {
    assert.ok(!/₱/.test(cardText(c)), `₱ leaked in ${c.id}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Totality + the actions contract.
// ═══════════════════════════════════════════════════════════════════════════

check('every card kind offers exactly the buttons the plan specifies', () => {
  const byKind = new Map<string, DecisionCard>()
  for (const c of allCards(realFindings)) if (!byKind.has(c.cardKind)) byKind.set(c.cardKind, c)
  assert.deepEqual(byKind.get('delivery_human_edited')!.actions, ['keep_mine', 'take_source'])
  assert.deepEqual(byKind.get('price_fuzzy_match')!.actions, ['same_truck'])
  assert.deepEqual(byKind.get('block_diff')!.actions, ['acknowledge'])
  // …and only the human-edit card ever names a delivery to release.
  for (const c of allCards(realFindings)) {
    if (c.cardKind !== 'delivery_human_edited') assert.deepEqual(c.deliveryIds, [])
  }
})

check('an empty run yields no groups and never throws', () => {
  const r = buildDecisionCards([])
  assert.deepEqual(r.groups, [])
  assert.equal(r.visibleCount, 0)
})

check('a human-edit finding with NO record_id is kept, as a generic card', () => {
  const orphan = run({ edits: [{ ...edits[0], record_id: '' }] })
  const findings = flattenRunFindings(orphan)
  assert.equal(findings.length, 1)
  const r = buildDecisionCards(findings)
  assert.equal(r.visibleCount, 1, 'never silently dropped')
  const card = r.groups[0].cards[0]
  assert.equal(card.cardKind, 'other')
  assert.deepEqual(card.actions, ['acknowledge'], 'nothing to release, so no release button')
})

console.log(`\nAll ${passed} decision-card checks passed.`)
