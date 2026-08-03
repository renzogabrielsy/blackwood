/**
 * verify-production-human-edit-fold.ts — framework-free proof that a production row the
 * sync REFUSED to overwrite actually reaches the operator.
 *
 * The defect (2026-08-03): the sync updated any VALUE_CHANGED production row, so a number
 * Renzo corrected in the app was silently reverted on the next run — MC's workbook still
 * said the old value. The DB now latches a human-edited row (`human_edited_at`, migration
 * `20260803080000_production_human_edit_guard.sql`) and the worker emits a
 * `production_human_edits` note per refusal. This checks the PURE app-side path from
 * there to the panel's honest findings list:
 * `lib/sync/cases-fold.ts::collectProductionHumanEdits` -> `lib/sync/findings.ts`.
 * No DB, no worker, no server context.
 *
 * Asserts:
 *   1. collectProductionHumanEdits folds the channel, guarding absent / empty /
 *      pre-feature results (a clean run must stay silent).
 *   2. flattenRunFindings emits ONE `production_human_edited` finding per refused row,
 *      keyed by (table, record id), severity `attention` — never auto-resolved.
 *   3. The finding names the row AND BOTH values, in plain language.
 *   4. The record_id survives into `data` — that is what the release action needs.
 *   5. A row refused by the DB guard (the save/sync race) says so.
 *   6. NO cost/price key ever reaches the finding data (the project-wide boundary).
 *   7. summarizeFindings counts it and the Claude serializer renders it.
 *   8. It coexists with the other channels — same run, one list.
 *
 * Run:  npx tsx scripts/verify-production-human-edit-fold.ts
 */
import assert from 'node:assert/strict'

import { collectProductionHumanEdits } from '../lib/sync/cases-fold'
import {
  flattenRunFindings,
  summarizeFindings,
  serializeFindingsForClaude,
} from '../lib/sync/findings'
import type { ProductionHumanEdit, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function edit(overrides: Partial<ProductionHumanEdit> = {}): ProductionHumanEdit {
  return {
    section: 'runs',
    table: 'production_runs',
    record_id: 'R-1',
    transaction_date: '2026-06-30',
    production_batch: 'JUNE-26',
    shift: 'M',
    meter: null,
    plate_no: null,
    changed_fields: [{ field: 'ttl_kg', yours: 13685, sheet: 13680 }],
    outcome: 'known_before_write',
    ...overrides,
  }
}

function runWith(edits: ProductionHumanEdit[]): SyncRunResult {
  return {
    reports: {
      production: {
        classify: null,
        apply: {
          report_type: 'production',
          ok: true,
          applied: { inserts: 3, updates: 0, replaced_dates: 0 },
          held: [],
          labeled: true,
          watermark_updated: true,
          errors: [],
          production_human_edits: edits,
        },
      },
    },
  } as unknown as SyncRunResult
}

// ---------------------------------------------------------------------------
check('1. collectProductionHumanEdits folds the channel and guards every absence', () => {
  assert.deepEqual(collectProductionHumanEdits(runWith([edit()])), [edit()])
  assert.deepEqual(collectProductionHumanEdits(runWith([])), [])
  assert.deepEqual(
    collectProductionHumanEdits({
      reports: { production: { classify: null, apply: { held: [] } } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(
    collectProductionHumanEdits({
      reports: { production: { classify: null, apply: null } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(collectProductionHumanEdits({} as SyncRunResult), [])
})

// ---------------------------------------------------------------------------
check('2. ONE finding per refused row, keyed by table+id, severity attention', () => {
  const findings = flattenRunFindings(
    runWith([
      edit(),
      edit({
        section: 'trucks',
        table: 'truck_readings',
        record_id: 'T-9',
        production_batch: null,
        shift: null,
        plate_no: 'AAV 6111',
        changed_fields: [{ field: 'end_km', yours: 16020.5, sheet: 16020.9 }],
      }),
    ]),
  )
  const refused = findings.filter((f) => f.kind === 'production_human_edited')
  assert.equal(refused.length, 2)
  assert.deepEqual(refused.map((f) => f.key), [
    'production_human_edited:production_runs:R-1',
    'production_human_edited:truck_readings:T-9',
  ])
  for (const f of refused) {
    assert.equal(f.severity, 'attention')
    assert.equal(f.source, 'Production report')
    assert.equal(f.kindLabel, 'Row you edited — the report disagrees')
  }
  // A clean run says nothing.
  assert.deepEqual(
    flattenRunFindings(runWith([])).filter((f) => f.kind === 'production_human_edited'),
    [],
  )
})

// ---------------------------------------------------------------------------
check('3. the finding names the row AND both values in plain language', () => {
  const [f] = flattenRunFindings(runWith([edit()]))
  assert.match(f.title, /2026-06-30/)
  assert.match(f.title, /production output/) // the section, not "runs"
  assert.match(f.title, /total kg/) // the field, not "ttl_kg"
  assert.equal(f.location, '2026-06-30 · JUNE-26 · M')
  // BOTH sides, in the operator's direction: mine -> what the report says.
  assert.match(f.reason, /13,685/)
  assert.match(f.reason, /13,680/)
  assert.match(f.reason, /did NOT overwrite it/)
  assert.match(f.reason, /hand\s+this row back/)

  // Multiple changed fields read as a list, not a blob.
  const [multi] = flattenRunFindings(
    runWith([
      edit({
        changed_fields: [
          { field: 'ttl_kg', yours: 100, sheet: 200 },
          { field: 'sacks_bags', yours: 4, sheet: 8 },
        ],
      }),
    ]),
  )
  assert.match(multi.title, /total kg and sacks\/bags/)
  assert.match(multi.reason, /total kg 100 → 200; sacks\/bags 4 → 8/)
})

// ---------------------------------------------------------------------------
check('4. the record_id survives into data (the release action needs it)', () => {
  const [f] = flattenRunFindings(runWith([edit()]))
  assert.equal(f.data.record_id, 'R-1')
  assert.equal(f.data.table, 'production_runs')
  assert.equal(f.data.section, 'runs')
  assert.deepEqual(f.data.changed_fields, [{ field: 'ttl_kg', yours: 13685, sheet: 13680 }])
})

// ---------------------------------------------------------------------------
check('5. a row refused by the DB guard (the race) says so', () => {
  const [f] = flattenRunFindings(runWith([edit({ outcome: 'refused_by_db' })]))
  assert.match(f.reason, /while the sync was running/)
  assert.match(f.reason, /your save won/)
  assert.equal(f.data.outcome, 'refused_by_db')

  // The ordinary case does NOT claim a race happened.
  const [plain] = flattenRunFindings(runWith([edit()]))
  assert.ok(!/while the sync was running/.test(plain.reason))
})

// ---------------------------------------------------------------------------
check('6. no cost/price key ever reaches the finding data', () => {
  const [f] = flattenRunFindings(runWith([edit()]))
  for (const key of Object.keys(f.data)) {
    assert.ok(!/cost|price|php|peso/i.test(key), `cost-ish key leaked: ${key}`)
  }
})

// ---------------------------------------------------------------------------
check('7. summarizeFindings counts it and the Claude serializer renders it', () => {
  const findings = flattenRunFindings(runWith([edit()]))
  const { total, byKind } = summarizeFindings(findings)
  assert.equal(total, 1)
  assert.equal(byKind.production_human_edited, 1)

  const text = serializeFindingsForClaude(findings, {
    runId: 'RUN-1',
    runDate: '2026-08-03',
    status: 'succeeded',
  })
  assert.match(text, /\[production_human_edited\]/)
  assert.match(text, /your edit kept/) // the compact SHORT_KIND word
  assert.match(text, /record_id=R-1/)
})

// ---------------------------------------------------------------------------
check('8. it coexists with the other channels in ONE list', () => {
  const result = runWith([edit()]) as SyncRunResult
  result.reports!.production!.apply!.held = [
    {
      reason: 'malformed',
      natural_key: '2026-06-30 · JUNE-26 · M · runs',
      detail: 'bad row',
      kind: 'malformed',
    },
  ]
  result.reports!.production!.apply!.production_batch_starts = [
    {
      transaction_date: '2026-08-01',
      new_batch: 'AUGUST',
      previous_batch: 'JULY',
      derivation: 'sequence',
      source_sheet: '08-01-26',
    },
  ]
  const kinds = flattenRunFindings(result).map((f) => f.kind)
  assert.deepEqual(kinds, ['malformed', 'production_batch_started', 'production_human_edited'])
})

console.log(`\nAll ${passed} production-human-edit-fold checks passed.`)
