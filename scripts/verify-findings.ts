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

import {
  flattenRunFindings,
  serializeCasesForClaude,
  serializeFindingsForClaude,
  summarizeFindings,
  type SerializableCase,
} from '../lib/sync/findings'
import type {
  BlockDiff,
  SingleSourceOverdue,
  SourceDiff,
  SyncRunResult,
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

check('grand_total block diff → high severity, "grand total" location', () => {
  const findings = flattenRunFindings(realRun)
  const grand = findings.find((f) => f.kind === 'block_diff' && f.data.subkind === 'grand_total')
  assert.ok(grand)
  assert.equal(grand!.severity, 'high')
  assert.equal(grand!.location, 'grand total')
  assert.equal(grand!.source, 'Blocking cross-check')
  assert.equal(grand!.data.delta, 12_500)
  const balances = findings.filter((f) => f.kind === 'block_diff' && f.data.subkind === 'balance')
  assert.equal(balances.length, 3)
  assert.equal(balances[0].severity, 'attention')
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

console.log(`\nAll ${passed} findings checks passed.`)
