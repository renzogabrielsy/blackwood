/**
 * verify-findings.ts — framework-free proof of the honest run-findings flattener
 * (lib/sync/findings.ts::flattenRunFindings + summarizeFindings). No DB, no worker.
 *
 * THE REGRESSION IT PINS: the real run that flagged TEN things but showed ONE. The main
 * fixture reproduces that run's reconciliation channel — 1 unmapped held row + 3
 * single-source-overdue + 3 block-balance diffs + 1 grand-total diff + 1 unresolved batch
 * = 9 findings — and asserts flattenRunFindings surfaces ALL of them (not just the held one).
 *
 * Asserts:
 *   1. The real-run fixture flattens to the full count with the right per-kind breakdown.
 *   2. Each channel maps to the right kind / source / plain data (weights, batch, date).
 *   3. A source_diff also flattens (exhaustive over all five channels).
 *   4. An empty / manifest-only result → [] (guarded, never throws).
 *
 * Run:  npx tsx scripts/verify-findings.ts
 */
import assert from 'node:assert/strict'

import { createHash } from 'node:crypto'

import {
  findingIdentity,
  flattenRunFindings,
  isCostKey,
  serializeCaseForClaude,
  serializeCasesForClaude,
  serializeFindingsForClaude,
  summarizeFindings,
  type RunFinding,
  type SerializableCase,
} from '../lib/sync/findings'
import { caseFingerprint } from '../lib/sync/fingerprint'
import { canonicalHashPortable, sha256Hex } from '../lib/sync/portable-hash'
import type {
  BlockDiff,
  DeliveryHumanEdit,
  HeldRow,
  PriceNote,
  ReportNotReceived,
  SourceTabNote,
  SingleSourceOverdue,
  SourceDiff,
  SyncRunResult,
  UnpricedOverdue,
  UnresolvedBatch,
} from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ── Build the real-run fixture. ─────────────────────────────────────────────
const overdue: SingleSourceOverdue[] = ['A-1A', 'A-2B', 'B-3C'].map((block, i) => ({
  naturalKey: {
    transaction_date: '2026-07-05',
    batch: `MAR-26-BLK${i + 1}`,
    block_loc: block,
    destination: 'MAIN',
  },
  field: 'weight_kg',
  table: 'rc_out',
  source: 'movement',
  value: 1000 * (i + 1),
  provenance: 'movement sheet 2026-07-05',
  ageDays: 3 + i,
  lagDays: 2,
}))

const unresolved: UnresolvedBatch[] = [
  {
    transaction_date: '2026-07-08',
    batch_code: 'JULY-26-FEED1',
    candidates: [],
    block_loc: null,
    destination: 'MAIN',
    weight_kg: 3000,
    sources: ['gsheet'],
  },
]

const blockDiffs: BlockDiff[] = [
  { kind: 'balance', block_loc: 'A-9C', sheet_kg: 5000, computed_kg: 4200, delta: 800, detail: 'Sheet 5,000 vs app 4,200 (off by 800 kg).' },
  { kind: 'balance', block_loc: 'B-4A', sheet_kg: 1200, computed_kg: 1200, delta: 0, detail: 'Sheet and app both 1,200 kg but the Sheet flagged it.' },
  { kind: 'balance', block_loc: 'C-2B', sheet_kg: 900, computed_kg: 1500, delta: -600, detail: 'Sheet 900 vs app 1,500 (app is 600 kg higher).' },
  { kind: 'grand_total', block_loc: null, sheet_kg: 1_000_000, computed_kg: 987_500, delta: 12_500, detail: 'Total inventory: Sheet 1,000,000 vs app 987,500 (off by 12,500 kg).' },
]

const realRun: SyncRunResult = {
  reports: {
    deliveries: {
      classify: null,
      apply: {
        report_type: 'deliveries',
        ok: true,
        applied: { inserts: 40, updates: 0, replaced_dates: 0 },
        held: [
          {
            reason: 'batch code not found in the database',
            natural_key: 'RC IN · batch SEPT-26-BLK9',
            detail: 'no stored batch matches',
            kind: 'unmapped_batch_code',
            row: { supplier: 'Czarina', weight_kg: 8200, batch_code: 'SEPT-26-BLK9' },
          },
        ],
        labeled: true,
        watermark_updated: true,
        errors: [],
      },
    },
  },
  reconciliation: {
    rc_out: { diffs: [], agreements: 12, pending: 4, heldOverdue: overdue, unresolvedBatches: unresolved },
    blocking: {
      blockDiffs,
      totals: {
        sheetSumKg: 1_000_000,
        computedSumKg: 987_500,
        sheetStatedTotalKg: 1_000_000,
        delta: 12_500,
        sheetBlocks: 100,
        computedBlocks: 99,
        comparedBlocks: 99,
        negativeComputedBlocks: [],
      },
    },
  },
}

// ── 1. Full count + per-kind breakdown. ─────────────────────────────────────
check('real-run fixture flattens to all 9 findings (was: only 1 shown)', () => {
  const findings = flattenRunFindings(realRun)
  const summary = summarizeFindings(findings)
  assert.equal(summary.total, 9, `expected 9 findings, got ${summary.total}`)
  assert.equal(summary.byKind.unmapped_batch_code, 1)
  assert.equal(summary.byKind.single_source_overdue, 3)
  assert.equal(summary.byKind.unresolved_batch, 1)
  assert.equal(summary.byKind.block_diff, 4) // 3 balance + 1 grand_total
})

// ── 2. Each channel maps correctly. ─────────────────────────────────────────
check('held unmapped → kind/source/data carry the batch + weight', () => {
  const findings = flattenRunFindings(realRun)
  const held = findings.find((f) => f.kind === 'unmapped_batch_code')
  assert.ok(held)
  assert.equal(held!.data.batch_code, 'SEPT-26-BLK9')
  assert.equal(held!.data.weight_kg, 8200)
  assert.equal(held!.source, 'Delivery email (RC IN)')
  assert.ok(held!.title.includes('SEPT-26-BLK9'))
})

check('unresolved batch → attention, names JULY-26-FEED1 + FEED (null block)', () => {
  const findings = flattenRunFindings(realRun)
  const u = findings.find((f) => f.kind === 'unresolved_batch')
  assert.ok(u)
  assert.equal(u!.severity, 'attention')
  assert.equal(u!.data.batch_code, 'JULY-26-FEED1')
  assert.equal(u!.data.block_loc, null)
  assert.equal(u!.data.weight_kg, 3000)
  assert.equal(u!.location, '2026-07-08')
})

check('overdue → info, names the lone source + value', () => {
  const findings = flattenRunFindings(realRun)
  const o = findings.filter((f) => f.kind === 'single_source_overdue')
  assert.equal(o.length, 3)
  assert.equal(o[0].severity, 'info')
  assert.equal(o[0].data.source, 'movement')
  assert.ok(o[0].reason.toLowerCase().includes('movement'))
})

// The main fixture's grand_total carries NO residual fields — the shape of every run stored
// before 2026-08-12. Absent ⇒ UNKNOWN ⇒ stays `high` (fail-closed).
check('grand_total block diff with NO residual fields → stays high (legacy, fail-closed)', () => {
  const findings = flattenRunFindings(realRun)
  const grand = findings.find((f) => f.kind === 'block_diff' && f.data.subkind === 'grand_total')
  assert.ok(grand)
  assert.equal(grand!.severity, 'high')
  assert.equal(grand!.location, 'grand total')
  assert.equal(grand!.source, 'Blocking cross-check')
  assert.equal(grand!.data.delta, 12_500)
  // No fabricated reassurance: the keys are absent, not defaulted to "accounted for".
  assert.equal(grand!.data.residual_kg, undefined)
  assert.equal(grand!.data.fully_accounted, undefined)
  const balances = findings.filter((f) => f.kind === 'block_diff' && f.data.subkind === 'balance')
  assert.equal(balances.length, 3)
  assert.equal(balances[0].severity, 'attention')
})

// ── 2b. The grand-total RESIDUAL severity split (2026-08-12, Renzo's ask). ────
// `residual = delta − Σ(signed per-block gaps)`, computed by the worker engine
// (workers/sync/src/reconcile/blockBalance.ts). Zero ⇒ the total gap IS the flagged blocks
// summed ⇒ `attention`, level with those block rows. Non-zero ⇒ kilograms nothing explains
// ⇒ stays `high`.
function runWithGrandTotal(d: BlockDiff): SyncRunResult {
  return {
    reports: {},
    reconciliation: {
      blocking: {
        blockDiffs: [d],
        totals: {
          sheetSumKg: 10_322_875,
          computedSumKg: 10_286_727,
          sheetStatedTotalKg: 10_322_875,
          delta: 36_148,
          sheetBlocks: 166,
          computedBlocks: 164,
          comparedBlocks: 164,
          negativeComputedBlocks: [],
        },
      },
    },
  } as SyncRunResult
}

check('grand_total, residual ZERO → attention (run dc944b54 numbers)', () => {
  const findings = flattenRunFindings(
    runWithGrandTotal({
      kind: 'grand_total',
      block_loc: null,
      sheet_kg: 10_322_875,
      computed_kg: 10_286_727,
      delta: 36_148,
      accounted_block_kg: 36_148,
      accounted_block_count: 4,
      residual_kg: 0,
      fully_accounted: true,
      detail:
        'Total inventory disagrees: Sheet 10,322,875 kg vs app 10,286,727 kg (Δ 36,148 kg). ' +
        'All of it is accounted for by the 4 block(s) flagged above (Σ 36,148 kg, nothing ' +
        "unexplained) — consistent with the Sheet's Blocking tab not yet reflecting recent " +
        'feeding, so likely not urgent. Check those blocks to confirm.',
    }),
  )
  const g = findings.find((f) => f.kind === 'block_diff')
  assert.ok(g)
  assert.equal(g!.severity, 'attention', 'a fully-accounted total must stop reading as high')
  assert.equal(g!.data.residual_kg, 0)
  assert.equal(g!.data.accounted_block_kg, 36_148)
  assert.equal(g!.data.accounted_block_count, 4)
  assert.equal(g!.data.fully_accounted, true)
  assert.equal(g!.kindLabel, 'Total inventory mismatch — fully accounted for')
  assert.ok(g!.title.includes('matches the blocks already flagged'))
})

// ── 2c. The reassurance is a BADGE, not the last sentence of a paragraph. ─────
// Renzo, 2026-08-12: "it shouldnt be in the description. It should be flagged or badged as
// 'POSSIBLE MISMATCH DUE TO LAG' or something like that". So: the chip carries the reading,
// the prose states the disagreement and points at the blocks, and the nuance the label had to
// drop lives in the badge's hint.
check('grand_total, residual ZERO → carries the LAG badge, verbatim wording', () => {
  const findings = flattenRunFindings(
    runWithGrandTotal({
      kind: 'grand_total',
      block_loc: null,
      sheet_kg: 10_322_875,
      computed_kg: 10_286_727,
      delta: 36_148,
      accounted_block_kg: 36_148,
      accounted_block_count: 4,
      residual_kg: 0,
      fully_accounted: true,
      detail:
        'Total inventory disagrees: Sheet 10,322,875 kg vs app 10,286,727 kg (Δ 36,148 kg). ' +
        'All of it is accounted for by the 4 block(s) flagged above (Σ 36,148 kg, nothing ' +
        "unexplained) — consistent with the Sheet's Blocking tab not yet reflecting recent " +
        'feeding, so likely not urgent. Check those blocks to confirm.',
    }),
  )
  const g = findings.find((f) => f.kind === 'block_diff')!
  assert.equal(g.badges?.length, 1, 'a fully-accounted total must carry exactly one badge')
  assert.equal(g.badges![0].label, 'POSSIBLE MISMATCH DUE TO LAG', "Renzo's wording, verbatim")
  // Never red, never green — a badge qualifies a finding that is still open.
  assert.equal(g.badges![0].tone, 'caution')
  // The nuance moved to the hint, it was not thrown away.
  assert.ok(g.badges![0].hint.includes('consistent with'), 'hint must say consistent with')
  assert.ok(g.badges![0].hint.includes('Likely, not certain'))
  assert.ok(!/is a lag issue|due to lag\b|because the sheet lags/i.test(g.badges![0].hint))

  // The PROSE now states the disagreement + a pointer, and nothing more.
  assert.ok(g.reason.includes('Total inventory disagrees'), 'must still state the disagreement')
  assert.ok(g.reason.includes('36,148 kg'), 'must still carry the numbers')
  assert.ok(g.reason.endsWith('Check the 4 blocks flagged above.'), `got: ${g.reason}`)
  assert.ok(
    !g.reason.includes('consistent with'),
    'the badge carries that reading now — it must not also sit in the paragraph',
  )
  assert.ok(!g.reason.includes('nothing unexplained'))
})

check('grand_total with residual NON-zero → NO badge (the alarming shape stays bare)', () => {
  const findings = flattenRunFindings(
    runWithGrandTotal({
      kind: 'grand_total',
      block_loc: null,
      sheet_kg: 10_322_875,
      computed_kg: 10_286_727,
      delta: 36_148,
      accounted_block_kg: 21_148,
      accounted_block_count: 3,
      residual_kg: 15_000,
      fully_accounted: false,
      detail:
        'Total inventory disagrees: Sheet 10,322,875 kg vs app 10,286,727 kg (Δ 36,148 kg). ' +
        'The 3 block(s) flagged above account for 21,148 kg, leaving 15,000 kg NOT explained ' +
        'by any flagged block.',
    }),
  )
  const g = findings.find((f) => f.kind === 'block_diff')!
  assert.equal(g.badges, undefined, 'no badge, and the key must be ABSENT rather than []')
  // And the alarming prose is kept WHOLE — the trim applies only to the reassuring shape.
  assert.ok(g.reason.includes('15,000 kg NOT explained'), 'the unexplained kg must survive')
})

// A legacy grand_total (no residual fields) is UNKNOWN, not reassuring: no badge either.
check('legacy grand_total (no residual fields) → no badge, still high', () => {
  const findings = flattenRunFindings(realRun)
  const g = findings.find((f) => f.kind === 'block_diff' && f.data.subkind === 'grand_total')!
  assert.equal(g.severity, 'high')
  assert.equal(g.badges, undefined, 'absent data must never be badged as accounted for')
})

check('grand_total, residual NON-ZERO → stays high and names the unexplained kg', () => {
  const findings = flattenRunFindings(
    runWithGrandTotal({
      kind: 'grand_total',
      block_loc: null,
      sheet_kg: 10_322_875,
      computed_kg: 10_286_727,
      delta: 36_148,
      accounted_block_kg: 21_148,
      accounted_block_count: 3,
      residual_kg: 15_000,
      fully_accounted: false,
      detail:
        'Total inventory disagrees … The 3 block(s) flagged above account for 21,148 kg, ' +
        'leaving 15,000 kg NOT explained by any flagged block.',
    }),
  )
  const g = findings.find((f) => f.kind === 'block_diff')
  assert.ok(g)
  assert.equal(g!.severity, 'high')
  assert.equal(g!.data.residual_kg, 15_000)
  assert.equal(g!.data.fully_accounted, false)
  assert.equal(g!.kindLabel, 'Total inventory mismatch')
  assert.ok(g!.reason.includes('15,000 kg NOT explained'))
})

check('grand_total, ZERO blocks flagged → whole gap unexplained, stays high', () => {
  const findings = flattenRunFindings(
    runWithGrandTotal({
      kind: 'grand_total',
      block_loc: null,
      sheet_kg: 10_322_875,
      computed_kg: 10_286_727,
      delta: 36_148,
      accounted_block_kg: 0,
      accounted_block_count: 0,
      residual_kg: 36_148,
      fully_accounted: false,
      detail:
        'Total inventory disagrees … NO individual block was flagged, so the whole 36,148 kg ' +
        'is unexplained — the total is off but nothing above says where.',
    }),
  )
  const g = findings.find((f) => f.kind === 'block_diff')
  assert.ok(g)
  assert.equal(g!.severity, 'high', 'the most alarming shape must never be quieted')
  assert.equal(g!.data.accounted_block_count, 0)
  assert.equal(g!.data.residual_kg, 36_148)
  assert.ok(g!.reason.includes('NO individual block was flagged'))
})

// ── 3. A source_diff also flattens (exhaustive over all five channels). ──────
check('source_diff flattens too (5th channel)', () => {
  const diff: SourceDiff = {
    naturalKey: { transaction_date: '2026-06-10', batch: 'MAR-26-BLK5', block_loc: 'D-11B', destination: 'MAIN' },
    field: 'weight_kg',
    table: 'rc_out',
    sources: [
      { source: 'proposed', value: 20_932, provenance: 'proposed 2026-06-10', selfConsistent: true, corroboratedBy: [], rows: [] },
      { source: 'gsheet', value: 31_745, provenance: 'sheet', selfConsistent: false, corroboratedBy: [], rows: [] },
    ],
    recommended: { source: 'proposed', why: 'self-consistent' },
  }
  const result: SyncRunResult = { reconciliation: { rc_out: { diffs: [diff], agreements: 0 } } }
  const findings = flattenRunFindings(result)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'source_diff')
  assert.equal(findings[0].severity, 'attention')
  assert.equal((findings[0].data.sources as unknown[]).length, 2)
  assert.ok(findings[0].data.recommended)
})

// ── 3.5 Delivery PRICE channels (2026-08-07, L-039). ───────────────────────
//
// THE REGRESSION THESE PIN: the price step's only voice used to be a progress beat
// reading "Price file unavailable — proceeding without prices" — which was FALSE (the
// file was there, only the tab name was unrecognized) and which died with the run. A
// whole month of deliveries went unpriced for a week and nothing durable said so.
// These assert the notes now reach the panel, and that a REFUSAL never reads as a
// success.
function priceNote(over: Partial<PriceNote> & { kind: string }): PriceNote {
  return {
    kind: over.kind,
    detail: over.detail ?? 'detail',
    transaction_date: over.transaction_date ?? null,
    supplier: over.supplier ?? null,
    batch_code: over.batch_code ?? null,
    truck_plate: over.truck_plate ?? null,
    weight_kg: over.weight_kg ?? null,
    sacks: over.sacks ?? null,
    source_row: over.source_row ?? null,
    via: over.via ?? null,
    matched_sheet: over.matched_sheet ?? null,
    matched_row: over.matched_row ?? null,
    date_tolerance_days: over.date_tolerance_days ?? null,
    looked_for: over.looked_for ?? null,
    tabs_found: over.tabs_found ?? [],
    candidates: over.candidates ?? [],
    source_filename: over.source_filename ?? null,
    tabs_loaded: over.tabs_loaded ?? [],
    rows_loaded: over.rows_loaded ?? null,
    rows_considered: over.rows_considered ?? null,
    collided_on: over.collided_on ?? null,
    differences: over.differences ?? [],
    collisions: over.collisions ?? [],
  }
}

function priceRun(notes: PriceNote[], overdue: UnpricedOverdue[] = []): SyncRunResult {
  return {
    reports: {
      deliveries: {
        apply: {
          report_type: 'deliveries',
          ok: true,
          held: [],
          labeled: false,
          watermark_updated: false,
          errors: [],
          price_notes: notes,
          unpriced_overdue: overdue,
        },
      },
    },
  } as unknown as SyncRunResult
}

check('a tab miss is HIGH severity and carries BOTH halves (sought + found)', () => {
  const findings = flattenRunFindings(
    priceRun([
      priceNote({
        kind: 'price_tab_unresolved',
        looked_for: 'August 2026',
        tabs_found: ['Feb. 2026', 'Aug. 2026', 'July 2026'],
        detail: 'Czarina’s price file has NO tab for August 2026...',
      }),
    ]),
  )
  assert.equal(findings.length, 1)
  const f = findings[0]
  assert.equal(f.kind, 'price_tab_unresolved')
  // HIGH, because it does not un-price a row — it un-prices a whole MONTH.
  assert.equal(f.severity, 'high')
  assert.equal(f.source, 'Delivery prices (Czarina)')
  assert.equal(f.location, 'August 2026')
  assert.equal(f.data.looked_for, 'August 2026')
  assert.deepEqual(f.data.tabs_found, ['Feb. 2026', 'Aug. 2026', 'July 2026'])
  assert.ok(f.title.includes('August 2026'))
  // The message must never revive the old lie.
  assert.ok(!/unavailable/i.test(f.reason), 'must not say "unavailable"')
})

check('an ambiguous tab is HIGH and lists the candidates it refused to choose between', () => {
  const findings = flattenRunFindings(
    priceRun([
      priceNote({ kind: 'price_tab_ambiguous', looked_for: 'August 2026', candidates: ['Aug. 2026', 'Aug 2026'] }),
    ]),
  )
  assert.equal(findings[0].severity, 'high')
  assert.deepEqual(findings[0].data.candidates, ['Aug. 2026', 'Aug 2026'])
  assert.ok(findings[0].title.includes('refused'))
})

check('a fuzzy match surfaces BOTH spellings side by side, and says it WAS priced', () => {
  const findings = flattenRunFindings(
    priceRun([
      priceNote({
        kind: 'price_fuzzy_match',
        via: 'fallback',
        transaction_date: '2026-07-23',
        supplier: 'Ornales',
        batch_code: 'JULY-26-BLK9',
        truck_plate: 'T138003',
        weight_kg: 19_010,
        matched_sheet: 'July 2026',
        matched_row: 45,
        differences: [{ field: 'truck_plate', ours: 'T138003', theirs: '138003' }],
        detail: 'Priced from Czarina’s "July 2026" row 45 ... The price WAS applied.',
      }),
    ]),
  )
  const f = findings[0]
  assert.equal(f.severity, 'attention')
  assert.equal(f.location, '2026-07-23 · T138003')
  assert.equal(f.data.matched_sheet, 'July 2026')
  assert.equal(f.data.matched_row, 45)
  // Both values must survive into the panel payload.
  assert.deepEqual(f.data.differences, [{ field: 'truck_plate', ours: 'T138003', theirs: '138003' }])
  assert.ok(/priced/i.test(f.title), 'a successful fuzzy match should read as priced')
})

// ── 3.6 The L-044 channels: the WRONG WORKBOOK, and the missing report. ────
//
// THE REGRESSION THESE PIN: on 2026-08-17 the sync priced four truckloads (69,900 kg) at
// zero and reported NOTHING. The price file is fetched by SENDER only, so the clerk had
// picked up `BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx` — whose
// tabs include `AUGUST 2026`. Every L-039 check passed on it: the file opened, the month
// resolved, rows were read. Then nothing matched, and "nothing matched" was, by design,
// not a finding. The only symptom of the wrong workbook is the RESULT.
check('a 100% unmatched rate is HIGH and names the workbook it read', () => {
  const findings = flattenRunFindings(
    priceRun([
      priceNote({
        kind: 'price_no_row_matched',
        source_filename: 'BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx',
        tabs_loaded: ['AUGUST 2026'],
        tabs_found: ['MAY 2026', 'JUNE 2026', 'JULY 2026', 'AUGUST 2026'],
        looked_for: '2026-08',
        rows_loaded: 31,
        rows_considered: 4,
      }),
    ]),
  )
  assert.equal(findings.length, 1)
  const f = findings[0]
  // HIGH: this is a whole-FILE failure that does not look like one from inside the matcher.
  assert.equal(f.severity, 'high')
  assert.equal(f.kind, 'price_no_row_matched')
  // The filename is the answer, so it must be in the sentence a human reads first.
  assert.ok(f.title.includes('BDO REQUISTION'), f.title)
  assert.ok(f.title.includes('4'), f.title)
  assert.equal(f.data.source_filename, 'BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx')
  assert.deepEqual(f.data.tabs_loaded, ['AUGUST 2026'])
  assert.equal(f.data.rows_loaded, 31)
  assert.equal(f.section, 'deliveries')
})

check('no price file at all is HIGH, and never silent', () => {
  const findings = flattenRunFindings(
    priceRun([priceNote({ kind: 'price_file_missing', rows_considered: 12 })]),
  )
  assert.equal(findings[0].severity, 'high')
  assert.ok(findings[0].title.includes('12'), findings[0].title)
})

check('a FAILED overdue check reports, and never reads as "none overdue"', () => {
  const findings = flattenRunFindings(
    priceRun([
      priceNote({
        kind: 'price_overdue_check_failed',
        detail: 'The read failed with: column does not exist',
      }),
    ]),
  )
  const f = findings[0]
  // attention, not high: nothing is known to be wrong with a delivery — what broke is the
  // sync's ability to LOOK. But it must never be absent.
  assert.equal(f.severity, 'attention')
  assert.ok(/cannot say/i.test(f.title), f.title)
})

check('the two REFUSED kinds never read as "priced"', () => {
  // The wording matters: a refusal leaves the row at 0, and a title claiming otherwise
  // would be exactly the same class of lie as "Price file unavailable".
  const findings = flattenRunFindings(
    priceRun([
      priceNote({ kind: 'price_fuzzy_ambiguous', supplier: 'Tag-at', truck_plate: 'ZZZ 0001', collided_on: 'ours' }),
      priceNote({ kind: 'price_date_drift', supplier: 'Ornales', truck_plate: 'MAV 9202', date_tolerance_days: 122, matched_sheet: 'Aug. 2026' }),
    ]),
  )
  assert.equal(findings.length, 2)
  for (const f of findings) {
    assert.equal(f.severity, 'attention')
    assert.ok(/could not be priced/.test(f.title), `refusal must not read as priced: ${f.title}`)
  }
  // The drift refusal states HOW FAR away the only candidate was.
  assert.ok(findings[1].title.includes('122 days'), findings[1].title)
  assert.equal(findings[1].data.date_tolerance_days, 122)
})

check('an unpriced-overdue delivery is named, and escalates at 4 days', () => {
  const mk = (days: number, id: string): UnpricedOverdue => ({
    id,
    transaction_date: '2026-08-01',
    supplier: 'Ornales',
    batch_code: 'JULY-26-BLK13',
    truck_plate: 'MAV 9202',
    weight_kg: 22_375,
    sacks: 589,
    days_pending: days,
  })
  const findings = flattenRunFindings(priceRun([], [mk(2, 'id-a'), mk(7, 'id-b')]))
  assert.equal(findings.length, 2)
  assert.equal(findings[0].kind, 'unpriced_overdue')
  assert.equal(findings[0].severity, 'attention') // 2 days — late
  assert.equal(findings[1].severity, 'high') // 7 days — a broken pipe
  assert.equal(findings[0].data.delivery_id, 'id-a')
  assert.ok(findings[1].title.includes('22,375 kg'), findings[1].title)
  assert.ok(findings[1].title.includes('7 days'))
})

// ── 3.7 The report that never arrived (L-044). ─────────────────────────────
//
// THE REGRESSION THIS PINS: the deliveries run answered "no RC DELIVERIES attachment" with
// "Nothing new today — no RC DELIVERIES report waiting." at 100% progress, on the days RC
// IN was going stale. A run where nothing arrived must not be indistinguishable from a
// quiet day.
function notReceivedRun(over: Partial<ReportNotReceived> = {}): SyncRunResult {
  return {
    reports: {
      deliveries: {
        apply: {
          report_type: 'deliveries',
          ok: true,
          held: [],
          labeled: false,
          watermark_updated: false,
          errors: [],
          price_notes: [],
          unpriced_overdue: [],
          report_not_received: {
            report_type: 'deliveries',
            source_label: 'RC DELIVERIES report',
            stream: 'deliveries',
            stream_label: 'RC In (deliveries)',
            since: '2026-08-11',
            through_date: '2026-08-14',
            operational_date: '2026-08-17',
            missed_working_days: 1,
            lateness_unknown_reason: null,
            reports_next_day: false,
            as_of: '2026-08-18',
            ...over,
          },
        },
      },
    },
  } as unknown as SyncRunResult
}

check('a missing report is a FINDING, and escalates on the view\'s own number', () => {
  const sev = (missed: number | null) => {
    const f = flattenRunFindings(notReceivedRun({ missed_working_days: missed }))
    assert.equal(f.length, 1, 'exactly one finding')
    assert.equal(f[0].kind, 'report_not_received')
    assert.equal(f[0].section, 'deliveries')
    return f[0]
  }
  // 0 still FIRES — that is the case where another writer (the Google Sheet) is keeping
  // the data current while the email pipeline is quietly dead, and nothing else notices.
  assert.equal(sev(0).severity, 'info')
  assert.equal(sev(1).severity, 'info')
  assert.equal(sev(2).severity, 'attention')
  assert.equal(sev(3).severity, 'attention')
  assert.equal(sev(4).severity, 'high')
  // Unmeasurable is NOT quieter than measured-and-fine.
  assert.equal(sev(null).severity, 'attention')
})

check('the missing-report finding never reassures, and says what it searched', () => {
  const f = flattenRunFindings(notReceivedRun({ missed_working_days: 3 }))[0]
  assert.ok(!/nothing new/i.test(f.title + f.reason), 'must not revive the reassuring wording')
  assert.ok(f.title.includes('3 working days'), f.title)
  assert.ok(f.reason.includes('2026-08-11'), 'must state how far back it searched')
  assert.equal(f.data.through_date, '2026-08-14')
  assert.equal(f.data.missed_working_days, 3)
})

check('an EARLIER RUN TODAY that already ate the mail downgrades — and never silences (L-048)', () => {
  // Every primary mailbox query ends `-label:"Blackwood-Processed"`, so once one run
  // consumes the email every later run that day sees an empty mailbox. Measured
  // 2026-09-03: run cc8c66f9 ingested the RC DELIVERIES mail at 01:41Z, and f1e9f342 at
  // 03:13Z reported that none had arrived. Crying wolf on every manual Run Sync is how an
  // operator learns to skip the one finding that matters.
  const f = flattenRunFindings(
    notReceivedRun({
      missed_working_days: 3, // would be `attention` on its own
      already_processed: true,
      last_processed_at: '2026-08-18T00:41:00Z',
      last_processed_email_id: 'thread-abc',
    }),
  )
  assert.equal(f.length, 1, 'downgraded, NOT removed — silence would be the old bug in a new costume')
  assert.equal(f[0].kind, 'report_not_received')
  assert.equal(f[0].severity, 'info')
  assert.match(f[0].title, /earlier run today/i)
  assert.equal(f[0].data.already_processed, true)
  assert.equal(f[0].data.last_processed_at, '2026-08-18T00:41:00Z')
  // The unknown case must NEVER quieten the alarm.
  const unknown = flattenRunFindings(notReceivedRun({ missed_working_days: 3 }))[0]
  assert.equal(unknown.data.already_processed, false)
  assert.equal(unknown.severity, 'attention')
})

// ── 3.7b A source workbook that ARRIVED and could not be read (L-048). ────
//
// THE REGRESSION THIS PINS: run cc8c66f9 opened MC's September PROPOSED workbook, whose
// day tabs are named `Aug. 29` / `Sep. 1` / `SEP. 2`. The tab-name reader wanted a bare
// space, all three were skipped, ZERO rows came out of a workbook full of feedings, and
// the run then labeled the email processed and reported `succeeded` with NO finding at
// all. rc_out stopped dead at 2026-08-28. The skips lived only in `soft_warnings`, which
// nothing on this list reads.
function tabNote(over: Partial<SourceTabNote> = {}): SourceTabNote {
  return {
    kind: 'source_tabs_unreadable',
    report_type: 'rc_out',
    source_label: 'PROPOSED DAILY REPORT',
    filename: '260902 PROPOSED DAILY REPORT SEPTEMBER 2026.xlsx',
    tabs_total: 3,
    tabs_read: 0,
    unreadable_tabs: ['Aug. 29', 'Sep. 1', 'SEP. 2'],
    readable_tabs: [],
    rows_extracted: 0,
    source_left_unconsumed: true,
    ...over,
  }
}

function tabNoteRun(note: SourceTabNote): SyncRunResult {
  return {
    reports: {
      rc_out: {
        apply: {
          report_type: 'rc_out',
          ok: true,
          held: [],
          labeled: false,
          watermark_updated: false,
          errors: [],
          source_tab_notes: [note],
        },
      },
    },
  } as unknown as SyncRunResult
}

check('a workbook that arrived and read as NOTHING is a HIGH finding naming both lists', () => {
  const f = flattenRunFindings(tabNoteRun(tabNote()))
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, 'source_tabs_unreadable')
  assert.equal(f[0].severity, 'high')
  assert.equal(f[0].section, 'rc_out')
  assert.match(f[0].title, /Not one of the 3 tabs/)
  // Both sides, the way the price-tab finding names what it wanted AND what it found.
  for (const tab of ['Aug. 29', 'Sep. 1', 'SEP. 2']) {
    assert.ok(f[0].reason.includes(tab), `must name the tab it could not read: ${tab}`)
  }
  assert.deepEqual(f[0].data.unreadable_tabs, ['Aug. 29', 'Sep. 1', 'SEP. 2'])
  assert.equal(f[0].data.source_left_unconsumed, true)
  assert.match(f[0].reason, /left unmarked/i, 'must say the email is still there to re-read')
  for (const k of Object.keys(f[0].data)) assert.ok(!isCostKey(k), `cost-ish key: ${k}`)
})

check('a PARTIAL tab failure is attention, and names the tabs it DID read', () => {
  const f = flattenRunFindings(
    tabNoteRun(
      tabNote({
        tabs_total: 3,
        tabs_read: 2,
        unreadable_tabs: ['notes'],
        readable_tabs: ['Sep. 1', 'SEP. 2'],
        rows_extracted: 7,
        source_left_unconsumed: false,
      }),
    ),
  )[0]
  assert.equal(f.severity, 'attention')
  assert.equal(f.title, '1 of 3 tabs in PROPOSED DAILY REPORT could not be read')
  assert.ok(f.reason.includes('"Sep. 1"') && f.reason.includes('"SEP. 2"'))
  assert.ok(!/left unmarked/i.test(f.reason), 'a partial read DID consume the email')
})

check('the tab finding has a stable identity and re-surfaces when the tab list changes', () => {
  const a = findingIdentity(flattenRunFindings(tabNoteRun(tabNote()))[0])
  const b = findingIdentity(flattenRunFindings(tabNoteRun(tabNote()))[0])
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(a.fingerprint, b.fingerprint, 'same workbook, same identity')
  assert.equal(a.contentHash, b.contentHash, 'same situation, same content hash')
  const moved = findingIdentity(
    flattenRunFindings(tabNoteRun(tabNote({ unreadable_tabs: ['Aug. 29', 'Sep. 1'], tabs_total: 2 })))[0],
  )
  assert.equal(moved.fingerprint, a.fingerprint, 'still the same workbook')
  assert.notEqual(moved.contentHash, a.contentHash, 'a different tab list IS a different situation')
})

// ── 3.8 The freshness watch that could not run (L-044). ───────────────────
//
// THE REGRESSION THIS PINS: `findStaleStreams` ended in `catch { return [] }`, and the
// worker's service role had no SELECT grant on `view_digest_stream_status`. Every read
// since 2026-08-04 returned 42501, the catch turned it into `[]`, and Stage 3e announced
// that as "Every report stream is up to date." `stale_streams` is absent from EVERY run in
// `sync_runs` — the detector had never once fired, and nobody could tell.
check('a freshness check that could NOT run is reported, and never reads as "all clear"', () => {
  const result: SyncRunResult = {
    reconciliation: {
      stale_stream_check: {
        ok: false,
        error: 'permission denied for view view_digest_stream_status',
      },
    },
  } as unknown as SyncRunResult
  const findings = flattenRunFindings(result)
  assert.equal(findings.length, 1)
  const f = findings[0]
  assert.equal(f.kind, 'stale_stream_check_failed')
  assert.equal(f.section, 'run')
  // attention, not high: no stream is KNOWN to be late, so this must not out-shout a
  // finding about one that is. But it must never be absent.
  assert.equal(f.severity, 'attention')
  assert.ok(/cannot say/i.test(f.title), f.title)
  assert.ok(/not checked/i.test(f.reason), 'must tell the reader how to read the silence')
  // The DB's own words survive — that 42501 is the whole diagnosis.
  assert.ok(String(f.data.error).includes('permission denied'))
})

check('a HEALTHY run raises no freshness-check finding (absence = it ran)', () => {
  // The member is written only on failure, so a clean run keeps byte-identical shape.
  const clean: SyncRunResult = { reconciliation: { stale_streams: [] } } as unknown as SyncRunResult
  assert.deepEqual(flattenRunFindings(clean), [])
})

check('NO price finding ever leaks a ₱ value into the panel or the Claude block', () => {
  const findings = flattenRunFindings(
    priceRun(
      [priceNote({ kind: 'price_out_of_band', supplier: 'Ornales', truck_plate: 'KCA 378', matched_sheet: 'Aug. 2026', matched_row: 10 })],
      [{ id: 'x', transaction_date: '2026-08-01', supplier: 'Ornales', batch_code: 'B', truck_plate: 'P', weight_kg: 1, sacks: 1, days_pending: 3 }],
    ),
  )
  for (const f of findings) {
    for (const k of Object.keys(f.data)) {
      assert.ok(!/cost|price|php|peso/i.test(k), `finding data must not carry a cost key: ${k}`)
    }
  }
  // …and the serializer strips any cost-ish key as a belt-and-braces.
  const block = serializeFindingsForClaude(findings, { runId: 'r1', runDate: '2026-08-07', status: 'ok' })
  assert.ok(!/cost_basis|php_per_kg/i.test(block), 'serialized block leaked a cost field')
})

check('price channels coexist with every other channel (exhaustive fold)', () => {
  // The fold must not stop at the first channel it finds. Combine the real-run
  // reconciliation fixture with both price channels.
  const combined: SyncRunResult = {
    ...(realRun as object),
    reports: {
      ...((realRun as { reports?: object }).reports ?? {}),
      ...((priceRun(
        [priceNote({ kind: 'price_tab_unresolved', looked_for: 'August 2026', tabs_found: ['Aug. 2026'] })],
        [{ id: 'z', transaction_date: '2026-08-01', supplier: 'S', batch_code: 'B', truck_plate: 'P', weight_kg: 100, sacks: 3, days_pending: 5 }],
      ) as { reports: object }).reports),
    },
  } as unknown as SyncRunResult

  const summary = summarizeFindings(flattenRunFindings(combined))
  // The original 9 are still all there…
  assert.equal(summary.byKind.single_source_overdue, 3)
  assert.equal(summary.byKind.block_diff, 4)
  assert.equal(summary.byKind.unresolved_batch, 1)
  // …plus the two new price channels.
  assert.equal(summary.byKind.price_tab_unresolved, 1)
  assert.equal(summary.byKind.unpriced_overdue, 1)
})

// ── 4. Empty / manifest-only result → []. ───────────────────────────────────
check('empty + manifest-only results → [] (guarded, never throws)', () => {
  assert.deepEqual(flattenRunFindings({} as SyncRunResult), [])
  assert.deepEqual(flattenRunFindings({ summary: 'mail-clerk manifest, no reports' } as SyncRunResult), [])
  assert.deepEqual(flattenRunFindings({ reports: {} } as SyncRunResult), [])
  assert.equal(summarizeFindings([]).total, 0)
})

// ── 5. serializeFindingsForClaude: dense, self-contained diagnosis block. ────
check('serializeFindingsForClaude: run id + total + one line per finding + real numbers', () => {
  const findings = flattenRunFindings(realRun)
  const block = serializeFindingsForClaude(findings, {
    runId: 'run-abc-123',
    runDate: '2026-07-05',
    status: 'diffs_pending',
  })

  // The self-describing lead line + the LOAD-BEARING run id.
  assert.ok(block.startsWith('Blackwood sync flags'), 'missing lead line')
  assert.ok(block.includes('run-abc-123'), 'run id must be present (load-bearing)')
  assert.ok(block.includes('2026-07-05'), 'run date present')
  assert.ok(block.includes('diffs_pending'), 'status present')

  // The honest total (9) shows in the summary line.
  assert.ok(block.includes('Total: 9 findings'), `total line wrong:\n${block}`)

  // One dense entry line ("- [sev] …") per finding.
  const entryLines = block.split('\n').filter((l) => l.startsWith('- ['))
  assert.equal(entryLines.length, 9, `expected 9 entry lines, got ${entryLines.length}`)

  // The ACTUAL numbers survive: the held weight, the grand-total delta, the FEED weight.
  assert.ok(block.includes('8200'), 'held weight_kg 8200 must appear')
  assert.ok(block.includes('12500'), 'grand-total delta 12500 must appear')
  assert.ok(block.includes('3000'), 'unresolved FEED weight 3000 must appear')

  // Batch codes carried through for diagnosis.
  assert.ok(block.includes('SEPT-26-BLK9'), 'held batch code must appear')
  assert.ok(block.includes('JULY-26-FEED1'), 'unresolved batch code must appear')
})

check('serializeFindingsForClaude: empty run → clean-run block, no throw', () => {
  const block = serializeFindingsForClaude([], { runId: null })
  assert.ok(block.includes('Total: 0 findings'), 'empty block should state 0 findings')
  assert.ok(block.includes('unknown (no run id)'), 'null run id rendered explicitly')
})

// ── 6. serializeCasesForClaude: folds verdicts, strips cost keys. ────────────
check('serializeCasesForClaude: run id + verdict read + natural key + cost stripped', () => {
  const cases: SerializableCase[] = [
    {
      kind: 'unresolved_batch',
      report_type: 'rc_out',
      natural_key: 'JULY-26-FEED1 @ FEED · 2026-07-08',
      status: 'investigated',
      reason: 'no matching batch in the database',
      row: { batch_code: 'JULY-26-FEED1', weight_kg: 3000, cost_basis: 42.5 },
      occurrence_count: 2,
      verdict: 'needs-human',
      verdictSummary: 'Batch not found — create it or map it before this can be saved.',
    },
    {
      kind: 'source_diff',
      report_type: 'rc_out',
      natural_key: 'MAR-26-BLK5 @ D-11B · 2026-06-10',
      status: 'open',
      row: { field: 'weight_kg' },
      verdict: null,
    },
  ]
  const block = serializeCasesForClaude(cases, { runId: 'run-xyz-9', status: 'open' })

  assert.ok(block.startsWith('Blackwood sync review cases'), 'missing lead line')
  assert.ok(block.includes('run-xyz-9'), 'run id must be present')
  assert.ok(block.includes('Total: 2 cases'), `total line wrong:\n${block}`)

  // The investigator read + verdict word survive.
  assert.ok(block.includes('Batch not found'), 'verdict summary must appear')
  assert.ok(block.includes('verdict=needs-human'), 'verdict word must appear')
  assert.ok(block.includes('not yet investigated'), 'un-investigated case labeled')

  // Identity + real numbers survive.
  assert.ok(block.includes('JULY-26-FEED1'), 'batch code must appear')
  assert.ok(block.includes('weight_kg=3000'), 'weight must appear')

  // Cost is NEVER emitted.
  assert.ok(!block.includes('cost_basis'), 'cost_basis key must be stripped')
  assert.ok(!block.includes('42.5'), 'cost value must be stripped')
})

// ── 7. serializeCaseForClaude: the per-case "Copy for Claude" brief. ────────
check('serializeCaseForClaude: instruction header + identity + reason + verdict + row data', () => {
  const c: SerializableCase = {
    kind: 'unresolved_batch',
    report_type: 'rc_out',
    natural_key: 'JULY-26-FEED1 @ FEED · 2026-07-08',
    status: 'open',
    reason: 'no matching batch in the database',
    row: { batch_code: 'JULY-26-FEED1', weight_kg: 3000, cost_basis: 42.5 },
    occurrence_count: 3,
    verdict: 'needs-human',
    verdictSummary: 'Batch not found — create it or map it before this can be saved.',
  }
  const block = serializeCaseForClaude(c)

  assert.ok(
    block.startsWith('Diagnose this Blackwood sync flag and recommend a resolution:'),
    'missing instruction header line',
  )
  assert.ok(block.includes('JULY-26-FEED1 @ FEED'), 'natural key must appear')
  assert.ok(block.includes('unresolved_batch'), 'kind must appear')
  assert.ok(block.includes('Seen in: 3 runs'), 'occurrence count must appear')
  assert.ok(block.includes('no matching batch in the database'), 'reason must appear')
  assert.ok(block.includes('needs-human'), 'prior verdict word must appear')
  assert.ok(block.includes('Batch not found'), 'prior verdict summary must appear')
  assert.ok(block.includes('weight_kg=3000'), 'row data must appear')

  // Cost is NEVER emitted, same discipline as every other serializer here.
  assert.ok(!block.includes('cost_basis'), 'cost_basis key must be stripped')
  assert.ok(!block.includes('42.5'), 'cost value must be stripped')
})

check('serializeCaseForClaude: minimal case (no verdict, no row) never throws', () => {
  const c: SerializableCase = {
    kind: 'other',
    report_type: 'deliveries',
    natural_key: 'row 4',
  }
  const block = serializeCaseForClaude(c)
  assert.ok(block.includes('Diagnose this Blackwood sync flag'), 'header present')
  assert.ok(block.includes('row 4'), 'natural key present')
  assert.ok(!block.includes('Prior investigator verdict'), 'no verdict line when absent')
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. FINDING IDENTITY — the ack ledger's two strings (2026-08-19).
//
// `findingIdentity` gives every finding, durable-case-backed or not, a stable
// `fingerprint` (WHICH discrepancy) and a `contentHash` (WHAT it currently says).
// The pair is what makes "acknowledged UNTIL IT CHANGES" possible for the five
// findings per run that are recomputed every time and stored nowhere.
//
// The load-bearing claims asserted below:
//   a. the browser-safe SHA-256 is byte-identical to node:crypto (this is the whole
//      safety argument for hand-rolling a hash at all);
//   b. a held-row finding's fingerprint IS its durable case's fingerprint — one
//      identity, not two;
//   c. identity survives a different run; content does not survive a real change;
//   d. two sources disagreeing about ONE delivery is ONE decision, not two;
//   e. no ₱ can reach either string, even if a cost value starts arriving unredacted.
// ═══════════════════════════════════════════════════════════════════════════════

const HEX64 = /^[0-9a-f]{64}$/

// ── (a) The portable SHA-256 is the real SHA-256. ───────────────────────────
check('portable sha256 === node:crypto sha256 (edge lengths + multi-byte UTF-8)', () => {
  const corpus = [
    '',
    'a',
    'abc',
    'x'.repeat(55), // one byte short of a padded block
    'x'.repeat(56), // forces a second block
    'x'.repeat(63),
    'x'.repeat(64), // exact block boundary
    'x'.repeat(65),
    'x'.repeat(4096),
    'MAV 9202 · ₱ — 日本語 🚚', // peso sign, em dash, CJK, emoji
    JSON.stringify({ a: 1, b: [1, 2, 3], c: null }),
  ]
  for (const input of corpus) {
    assert.equal(
      sha256Hex(input),
      createHash('sha256').update(input).digest('hex'),
      `sha256 mismatch for a ${input.length}-char input`,
    )
  }
})

check('portable canonicalHash === fingerprint.ts canonicalHash on a real case object', () => {
  // The exact canonical shape `caseFingerprint` builds for a non-gate held row.
  const canonical = { reportType: 'gsheet', kind: 'cross_batch_reassignment', natural_key: 'x · y' }
  assert.equal(
    canonicalHashPortable(canonical),
    createHash('sha256')
      .update(JSON.stringify({ kind: canonical.kind, natural_key: canonical.natural_key, reportType: canonical.reportType }))
      .digest('hex'),
    'canonicalization must sort keys recursively, exactly as fingerprint.ts does',
  )
})

// ── (b) ONE identity: a held finding reuses its durable case's fingerprint. ──
function heldRun(reportType: 'gsheet' | 'deliveries', held: HeldRow) {
  return {
    reports: {
      [reportType]: {
        apply: {
          report_type: reportType,
          ok: true,
          held: [held],
          labeled: false,
          watermark_updated: false,
          errors: [],
        },
      },
    },
  } as unknown as SyncRunResult
}

check('cross_batch_reassignment fingerprint IS the durable case fingerprint (not a second one)', () => {
  const held: HeldRow = {
    reason: 'the Sheet moved this delivery to a different batch',
    natural_key: 'RC IN · 2026-08-05 · AAV 6111 · 19,185 kg',
    detail: 'Sheet says AUG-26-RECOOKED1; the app has FEEDING AREA',
    kind: 'cross_batch_reassignment',
    row: { batch_code: 'AUG-26-RECOOKED1', weight_kg: 19_185, cost_basis: 49.5 },
  }
  const f = flattenRunFindings(heldRun('gsheet', held)).find(
    (x) => x.kind === 'cross_batch_reassignment',
  )
  assert.ok(f, 'the held row must flatten to a finding')
  const id = findingIdentity(f!)
  assert.match(id.fingerprint, HEX64)
  assert.match(id.contentHash, HEX64)
  assert.equal(
    id.fingerprint,
    caseFingerprint('gsheet', held),
    'the ack fingerprint must EQUAL sync_held_cases.fingerprint — one identity, never two',
  )
})

check('every held kind reuses its case fingerprint (exhaustive over the fixture kinds)', () => {
  const kinds: HeldRow['kind'][] = ['unmapped_batch_code', 'location_occupied', 'batch_location_conflict', 'malformed', 'already_exists']
  for (const kind of kinds) {
    const held: HeldRow = {
      reason: 'r',
      natural_key: `RC IN · ${kind} · row 12`,
      detail: 'd',
      kind,
      row: { batch_code: 'AUG-26-BLK3', weight_kg: 100 },
    }
    const f = flattenRunFindings(heldRun('deliveries', held))[0]
    assert.equal(
      findingIdentity(f).fingerprint,
      caseFingerprint('deliveries', held),
      `${kind}: ack fingerprint diverged from the case fingerprint`,
    )
  }
})

// ── (c) Identity is stable across runs; content tracks the situation. ────────
check('the same finding hashes identically in two runs with different run ids', () => {
  const d: BlockDiff = {
    kind: 'balance',
    block_loc: 'A-9C',
    sheet_kg: 5000,
    computed_kg: 4200,
    delta: 800,
    detail: 'Sheet 5,000 vs app 4,200 (off by 800 kg).',
  }
  const runA = runWithGrandTotal(d)
  const runB = JSON.parse(JSON.stringify(runWithGrandTotal(d))) as SyncRunResult
  // Simulate the run-varying junk a real result carries around the finding.
  ;(runA as unknown as Record<string, unknown>).runId = '312b3213-aaaa'
  ;(runB as unknown as Record<string, unknown>).runId = '99999999-bbbb'

  const a = findingIdentity(flattenRunFindings(runA)[0])
  const b = findingIdentity(flattenRunFindings(runB)[0])
  assert.equal(a.fingerprint, b.fingerprint, 'fingerprint must not depend on the run')
  assert.equal(a.contentHash, b.contentHash, 'contentHash must not depend on the run')
})

check('a CHANGED delta changes contentHash but NOT fingerprint (ack until it changes)', () => {
  const base: BlockDiff = {
    kind: 'balance',
    block_loc: 'A-9C',
    sheet_kg: 5000,
    computed_kg: 4200,
    delta: 800,
    detail: 'off by 800 kg',
  }
  const moved: BlockDiff = { ...base, computed_kg: 3100, delta: 1900, detail: 'off by 1,900 kg' }

  const a = findingIdentity(flattenRunFindings(runWithGrandTotal(base))[0])
  const b = findingIdentity(flattenRunFindings(runWithGrandTotal(moved))[0])
  assert.equal(a.fingerprint, b.fingerprint, 'the same block is the same discrepancy')
  assert.notEqual(a.contentHash, b.contentHash, 'a new gap must re-alarm an acknowledged block')
})

check('sub-kg jitter does NOT re-alarm an acknowledged block (rounded to integer kg)', () => {
  const base: BlockDiff = { kind: 'balance', block_loc: 'A-9C', sheet_kg: 5000, computed_kg: 4200, delta: 800, detail: 'x' }
  const jitter: BlockDiff = { ...base, computed_kg: 4200.4, delta: 799.6, detail: 'x' }
  assert.equal(
    findingIdentity(flattenRunFindings(runWithGrandTotal(base))[0]).contentHash,
    findingIdentity(flattenRunFindings(runWithGrandTotal(jitter))[0]).contentHash,
  )
})

check('two different blocks never share a fingerprint, and neither do two subkinds on one block', () => {
  const seen = new Set<string>()
  const diffs: BlockDiff[] = [
    { kind: 'balance', block_loc: 'A-9C', sheet_kg: 1, computed_kg: 2, delta: -1, detail: 'x' },
    { kind: 'balance', block_loc: 'B-4A', sheet_kg: 1, computed_kg: 2, delta: -1, detail: 'x' },
    { kind: 'batch_mismatch', block_loc: 'A-9C', sheet_kg: 1, computed_kg: 2, delta: -1, detail: 'x', sheet_batch: 'P', computed_batch: 'Q' },
    { kind: 'grand_total', block_loc: null, sheet_kg: 9, computed_kg: 8, delta: 1, detail: 'x' },
  ]
  for (const d of diffs) {
    const fp = findingIdentity(flattenRunFindings(runWithGrandTotal(d))[0]).fingerprint
    assert.ok(!seen.has(fp), `collision on ${d.kind} ${d.block_loc ?? 'grand total'}`)
    seen.add(fp)
  }
  assert.equal(seen.size, 4)
})

// ── (d) One delivery, two sources, ONE decision. ─────────────────────────────
function deliveryEdit(over: Partial<DeliveryHumanEdit> = {}): DeliveryHumanEdit {
  return {
    section: over.section ?? 'deliveries',
    table: 'deliveries',
    record_id: over.record_id ?? '11111111-2222-3333-4444-555555555555',
    transaction_date: over.transaction_date ?? '2026-08-14',
    supplier: over.supplier ?? 'Lapayag',
    batch_code: over.batch_code ?? 'AUG-26-BLK1',
    block_loc: over.block_loc ?? 'A-7C',
    truck_plate: over.truck_plate ?? 'CDD 1689',
    changed_fields: over.changed_fields ?? [{ field: 'remarks', yours: 'FEED', sheet: 'FEEDING' }],
    outcome: over.outcome ?? 'refused_by_db',
  }
}

function deliveryEditRun(edits: DeliveryHumanEdit[]): SyncRunResult {
  const bySection: Record<string, DeliveryHumanEdit[]> = {}
  for (const e of edits) (bySection[e.section] ??= []).push(e)
  const reports: Record<string, unknown> = {}
  for (const [section, list] of Object.entries(bySection)) {
    reports[section] = {
      apply: {
        report_type: section,
        ok: true,
        held: [],
        labeled: false,
        watermark_updated: false,
        errors: [],
        delivery_human_edits: list,
      },
    }
  }
  return { reports } as unknown as SyncRunResult
}

check('delivery_human_edited: TWO sources, ONE record_id → ONE fingerprint (one decision)', () => {
  const findings = flattenRunFindings(
    deliveryEditRun([deliveryEdit({ section: 'deliveries' }), deliveryEdit({ section: 'gsheet' })]),
  ).filter((f) => f.kind === 'delivery_human_edited')
  assert.equal(findings.length, 2, 'both sources still raise their own finding')
  assert.notEqual(findings[0].key, findings[1].key, 'and they are still two rendered rows')
  assert.equal(
    findingIdentity(findings[0]).fingerprint,
    findingIdentity(findings[1]).fingerprint,
    'but acknowledging the delivery once must answer both',
  )
})

check('delivery_human_edited: a different delivery is a different fingerprint', () => {
  const a = flattenRunFindings(deliveryEditRun([deliveryEdit({ record_id: 'aaaaaaaa-0000-0000-0000-000000000001' })]))[0]
  const b = flattenRunFindings(deliveryEditRun([deliveryEdit({ record_id: 'bbbbbbbb-0000-0000-0000-000000000002' })]))[0]
  assert.notEqual(findingIdentity(a).fingerprint, findingIdentity(b).fingerprint)
})

check('delivery_human_edited: a NEW disagreeing field re-alarms an acknowledged row', () => {
  const a = flattenRunFindings(deliveryEditRun([deliveryEdit()]))[0]
  const b = flattenRunFindings(
    deliveryEditRun([
      deliveryEdit({
        changed_fields: [
          { field: 'remarks', yours: 'FEED', sheet: 'FEEDING' },
          { field: 'sacks', yours: 540, sheet: 334 },
        ],
      }),
    ]),
  )[0]
  assert.equal(findingIdentity(a).fingerprint, findingIdentity(b).fingerprint)
  assert.notEqual(findingIdentity(a).contentHash, findingIdentity(b).contentHash)
})

check('delivery_human_edited: field ORDER is not a change (canonical sort)', () => {
  const fields = [
    { field: 'sacks', yours: 540, sheet: 334 },
    { field: 'remarks', yours: 'FEED', sheet: 'FEEDING' },
  ]
  const a = flattenRunFindings(deliveryEditRun([deliveryEdit({ changed_fields: fields })]))[0]
  const b = flattenRunFindings(deliveryEditRun([deliveryEdit({ changed_fields: [...fields].reverse() })]))[0]
  assert.equal(findingIdentity(a).contentHash, findingIdentity(b).contentHash)
})

// ── (e) No ₱ can reach either string. ────────────────────────────────────────
check('a cost_basis refusal leaks NO ₱ into either string, redacted or not', () => {
  // The shape the worker actually sends today: both sides nulled, `redacted: true`.
  const redacted = flattenRunFindings(
    deliveryEditRun([
      deliveryEdit({ changed_fields: [{ field: 'cost_basis', yours: null, sheet: null, redacted: true }] }),
    ]),
  )[0]
  // The shape a future writer might send if BOTH upstream strips were removed in one
  // edit. This module is the third defence and must behave identically.
  const leaking = flattenRunFindings(
    deliveryEditRun([
      deliveryEdit({ changed_fields: [{ field: 'cost_basis', yours: 39.99, sheet: 11.01, redacted: false }] }),
    ]),
  )[0]

  const a = findingIdentity(redacted)
  const b = findingIdentity(leaking)
  assert.equal(a.fingerprint, b.fingerprint, 'identity never depended on the price')
  assert.equal(
    a.contentHash,
    b.contentHash,
    'a ₱ VALUE must not participate in the hash — only the FACT that the price field differs',
  )
  // Both outputs are pure hex: nothing legible, no glyph, no digits of a peso figure.
  for (const s of [a.fingerprint, a.contentHash, b.fingerprint, b.contentHash]) {
    assert.match(s, HEX64)
    assert.ok(!s.includes('₱'), 'no peso glyph')
  }
})

check('a cost-named key anywhere in `data` is stripped from the content hash', () => {
  const withCost: RunFinding = {
    key: 'made_up:1',
    kind: 'made_up',
    kindLabel: 'x',
    source: 'x',
    title: 'x',
    location: 'x',
    data: { batch_code: 'AUG-26-BLK1', cost_basis: 42.5, php_kg: 39.99, weight_kg: 100 },
    reason: 'x',
    severity: 'info',
    section: 'run',
  }
  const without: RunFinding = { ...withCost, data: { batch_code: 'AUG-26-BLK1', weight_kg: 100 } }
  assert.equal(findingIdentity(withCost).contentHash, findingIdentity(without).contentHash)
})

// ── Price notes: the spelling is what differs, so it cannot be the identity. ──
check('price_fuzzy_match: identity is date + NORMALIZED plate + sacks', () => {
  const spellings = ['CDD 1689', 'cdd-1689', 'CDD1689']
  const ids = spellings.map(
    (plate) =>
      findingIdentity(
        flattenRunFindings(
          priceRun([
            priceNote({
              kind: 'price_fuzzy_match',
              transaction_date: '2026-07-23',
              truck_plate: plate,
              sacks: 540,
              supplier: 'Ornales',
              differences: [{ field: 'truck_plate', ours: plate, theirs: '1689' }],
            }),
          ]),
        )[0],
      ).fingerprint,
  )
  assert.equal(new Set(ids).size, 1, 'one truck spelled three ways is ONE acknowledgement')
})

check('price_fuzzy_match: a different truck, date or sack count is a different fingerprint', () => {
  const base = { kind: 'price_fuzzy_match', transaction_date: '2026-07-23', truck_plate: 'CDD 1689', sacks: 540 }
  const variants = [
    base,
    { ...base, truck_plate: 'AAV 6111' },
    { ...base, transaction_date: '2026-07-24' },
    { ...base, sacks: 334 },
  ]
  const ids = variants.map(
    (v) => findingIdentity(flattenRunFindings(priceRun([priceNote(v)]))[0]).fingerprint,
  )
  assert.equal(new Set(ids).size, 4)
})

check('price: a file-level note keys on the MONTH, not on a truckload', () => {
  const a = findingIdentity(
    flattenRunFindings(priceRun([priceNote({ kind: 'price_tab_unresolved', looked_for: 'August 2026', tabs_found: ['Aug. 2026'] })]))[0],
  )
  const b = findingIdentity(
    flattenRunFindings(priceRun([priceNote({ kind: 'price_tab_unresolved', looked_for: 'August 2026', tabs_found: ['Aug. 2026', 'July 2026'] })]))[0],
  )
  const c = findingIdentity(
    flattenRunFindings(priceRun([priceNote({ kind: 'price_tab_unresolved', looked_for: 'September 2026' })]))[0],
  )
  assert.equal(a.fingerprint, b.fingerprint, 'same month = same acknowledgement')
  assert.notEqual(a.contentHash, b.contentHash, 'a different set of tabs in the file IS a change')
  assert.notEqual(a.fingerprint, c.fingerprint, 'a different month is a different problem')
})

// ── The clock is not a change. ───────────────────────────────────────────────
check('an unpriced delivery ageing by a day does NOT re-alarm (days_pending is volatile)', () => {
  const mk = (days: number) =>
    findingIdentity(
      flattenRunFindings(
        priceRun([], [
          {
            id: 'dddddddd-0000-0000-0000-000000000001',
            transaction_date: '2026-08-14',
            supplier: 'Lapayag',
            batch_code: 'AUG-26-BLK1',
            truck_plate: 'CDD 1689',
            weight_kg: 19_010,
            sacks: 540,
            days_pending: days,
          },
        ]),
      ).find((f) => f.kind === 'unpriced_overdue')!,
    )
  const day2 = mk(2)
  const day3 = mk(3)
  assert.equal(day2.fingerprint, day3.fingerprint)
  assert.equal(day2.contentHash, day3.contentHash, 'one more day is not a new situation')
})

// ── Totality: every finding the fixtures produce gets a well-formed identity. ─
check('every finding in every fixture yields two 64-hex strings, and no two collide', () => {
  const findings = [
    ...flattenRunFindings(realRun),
    ...flattenRunFindings(deliveryEditRun([deliveryEdit(), deliveryEdit({ section: 'gsheet', record_id: 'ffffffff-0000-0000-0000-00000000000f' })])),
  ]
  assert.ok(findings.length >= 10, 'fixture set should be non-trivial')
  const fps = new Set<string>()
  for (const f of findings) {
    const id = findingIdentity(f)
    assert.match(id.fingerprint, HEX64, `bad fingerprint for ${f.key}`)
    assert.match(id.contentHash, HEX64, `bad contentHash for ${f.key}`)
    fps.add(id.fingerprint)
  }
  // The two delivery_human_edited rows here carry DIFFERENT record_ids, so nothing is
  // deliberately folded and every finding must land on its own fingerprint. An accidental
  // collision would silently make one acknowledgement answer two unrelated problems.
  assert.equal(fps.size, findings.length, 'unexpected fingerprint collision')
})

// ── BUG-027 — the block clash a person can act on (2026-08-25). ──────────────
//
// The whole point of the new kind is that the finding READS like a person wrote it and
// the raw Postgres refusal is data, not a headline. Both halves are asserted here, plus
// the ack-ledger contract every held row must satisfy.
function blockClashHeld(over: Partial<HeldRow> = {}): HeldRow {
  return {
    reason: 'batch_location_conflict',
    natural_key: '2026-08-21 · AUG-26-BLK11 · D-20D · 16,840 kg · TEMP138003',
    detail:
      'New batch AUG-26-BLK11 wants block D-20D, but JUNE-26-BLK6 is still marked active ' +
      'there with 4,680 kg left (last fed 2026-08-21). If that block is finished, close ' +
      'JUNE-26-BLK6 and the next run will file this delivery.',
    kind: 'batch_location_conflict',
    row: {
      transaction_date: '2026-08-21',
      batch_code: 'AUG-26-BLK11',
      block_loc: 'D-20D',
      truck_plate: 'TEMP138003',
      weight_kg: 16_840,
      attempted_batch_code: 'AUG-26-BLK11',
      location_ref: 'D-20D',
      occupying_batch_code: 'JUNE-26-BLK6',
      occupying_status: 'IN-USE',
      occupying_balance_kg: 4_680,
      occupying_last_fed: '2026-08-21',
      db_error:
        'upsert_batch_if_absent batches failed 23505: duplicate key value violates unique ' +
        'constraint "idx_unique_active_batch_per_location"',
    },
    ...over,
  }
}

check('batch_location_conflict: the headline names both batches and carries no SQLSTATE', () => {
  const f = flattenRunFindings(heldRun('gsheet', blockClashHeld()))[0]
  assert.equal(f.kind, 'batch_location_conflict')
  assert.equal(f.kindLabel, 'Two batches want the same block')
  assert.equal(f.severity, 'attention')
  for (const line of [f.title, f.kindLabel, f.reason]) {
    assert.ok(!line.includes('23505'), `a SQLSTATE reached an operator-facing line: ${line}`)
    assert.ok(
      !line.includes('idx_unique_active_batch_per_location'),
      `a constraint name reached an operator-facing line: ${line}`,
    )
  }
  assert.ok(f.title.includes('AUG-26-BLK11'), 'the title must name the batch that wanted the block')
  assert.ok(f.title.includes('JUNE-26-BLK6'), 'the title must name the batch that holds it')
  assert.ok(f.title.includes('D-20D'), 'the title must name the block')
  // The reason is the worker's ONE sentence, verbatim — never a re-derivation.
  assert.equal(f.reason, blockClashHeld().detail)
  assert.ok(f.reason.includes('close JUNE-26-BLK6'), 'the reason must state the action')
})

check('batch_location_conflict: the raw refusal rides in data, for the Copy button', () => {
  const f = flattenRunFindings(heldRun('gsheet', blockClashHeld()))[0]
  assert.ok(String(f.data.db_error).includes('23505'), 'the raw error must be preserved somewhere')
  assert.equal(f.data.occupying_batch_code, 'JUNE-26-BLK6')
  assert.equal(f.data.occupying_balance_kg, 4_680)
  assert.equal(f.data.occupying_last_fed, '2026-08-21')
  // Still no PHP anywhere in the payload.
  for (const k of Object.keys(f.data)) assert.ok(!isCostKey(k), `cost-ish key on a held finding: ${k}`)
})

check('batch_location_conflict: fingerprint IS the durable case fingerprint, and is run-stable', () => {
  const held = blockClashHeld()
  const f = flattenRunFindings(heldRun('gsheet', held))[0]
  const id = findingIdentity(f)
  assert.match(id.fingerprint, HEX64)
  assert.equal(
    id.fingerprint,
    caseFingerprint('gsheet', held),
    'the ack fingerprint must EQUAL sync_held_cases.fingerprint — one identity, never two',
  )
  // Run two: the occupant has been fed again, so the numbers moved. Same discrepancy,
  // so the SAME fingerprint — and a different contentHash, which is what re-surfaces it.
  const later = flattenRunFindings(
    heldRun('gsheet', blockClashHeld({ row: { ...blockClashHeld().row, occupying_balance_kg: 3_100, occupying_last_fed: '2026-08-24' } })),
  )[0]
  const laterId = findingIdentity(later)
  assert.equal(laterId.fingerprint, id.fingerprint, 'the identity must survive the numbers moving')
  assert.notEqual(laterId.contentHash, id.contentHash, 'a changed balance IS a changed situation')
})


console.log(`\nAll ${passed} findings checks passed.`)
