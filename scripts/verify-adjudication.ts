/**
 * verify-adjudication.ts — framework-free proof that the held-row ADJUDICATION
 * evidence layer (app/(app)/sync/adjudication.ts) issues the right read-only DB
 * lookups and folds the result into a decision-grade prompt — WITHOUT a real DB,
 * the worker, or the Anthropic API.
 *
 * It imports the PURE adjudication module (no 'use server', no server-only deps)
 * and drives it with a MOCKED AdminLike client (a query spy) and hand-built held
 * rows. It asserts, for a sub_watermark_suspected_dup row:
 *   - the lookup hits `rc_out` filtered by (transaction_date, batch_id, destination)
 *   - dup PRESENT  → the prompt carries "identical feeding already exists" (skip-lean)
 *   - dup ABSENT   → the prompt carries "No rc_out row exists" (apply-lean)
 * And the price-gating invariant: NO lookup ever selects a ₱/cost column.
 *
 * Run:  npx tsx scripts/verify-adjudication.ts
 * (No test framework is configured at the app root — this uses plain assertions.)
 */
import assert from 'node:assert/strict'

import {
  ADJUDICATOR_SYSTEM,
  buildAdjudicationPrompt,
  lookupEvidence,
  type AdminLike,
  type FilterBuilder,
  type QueryResult,
} from '../app/(app)/sync/adjudication'
import type { HeldRow } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    passed++
    console.log(`  ✓ ${name}`)
  })
}

// ── A recording mock of the PostgREST builder chain ─────────────────────────
interface Call {
  table: string
  columns: string
  filters: Array<[string, string, unknown]> // [op, column, value]
}

function mockAdmin(result: QueryResult): { admin: AdminLike; calls: Call[] } {
  const calls: Call[] = []
  const admin: AdminLike = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: Call = { table, columns, filters: [] }
          calls.push(call)
          const builder: FilterBuilder = {
            eq(column, value) {
              call.filters.push(['eq', column, value])
              return builder
            },
            ilike(column, pattern) {
              call.filters.push(['ilike', column, pattern])
              return builder
            },
            limit(n) {
              call.filters.push(['limit', 'limit', n])
              return builder
            },
            then(onFulfilled) {
              return Promise.resolve(result).then(onFulfilled)
            },
          }
          return builder
        },
      }
    },
  }
  return { admin, calls }
}

// A date-routed mock: returns DIFFERENT rows per transaction_date (the O>M gate issues
// one rc_out read PER drifted date). `byDate[date]` is that day's rc_out rows.
function mockAdminByDate(byDate: Record<string, Array<Record<string, unknown>>>): {
  admin: AdminLike
  calls: Call[]
} {
  const calls: Call[] = []
  const admin: AdminLike = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: Call = { table, columns, filters: [] }
          calls.push(call)
          const builder: FilterBuilder = {
            eq(column, value) {
              call.filters.push(['eq', column, value])
              return builder
            },
            ilike(column, pattern) {
              call.filters.push(['ilike', column, pattern])
              return builder
            },
            limit(n) {
              call.filters.push(['limit', 'limit', n])
              return builder
            },
            then(onFulfilled) {
              const dateFilter = call.filters.find((f) => f[0] === 'eq' && f[1] === 'transaction_date')
              const date = dateFilter ? String(dateFilter[2]) : ''
              const result: QueryResult = { data: byDate[date] ?? [], error: null }
              return Promise.resolve(result).then(onFulfilled)
            },
          }
          return builder
        },
      }
    },
  }
  return { admin, calls }
}

// ── Fixtures — the exact case on Renzo's screen ─────────────────────────────
// rc_out sub-watermark suspected-dup: 2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg
const subWatermarkRow: HeldRow = {
  reason: 'flagged',
  natural_key: '2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg',
  detail: 'sub-watermark NEW: transaction_date 2026-06-30 <= watermark 2026-06-30 …',
  kind: 'sub_watermark_suspected_dup',
  row: {
    transaction_date: '2026-06-30',
    batch_code: 'JUNE-26-FEED5',
    batch_id: 'b-feed5-uuid',
    destination: 'MAIN',
    weight_kg: 5820,
    production_batch: null,
    block_loc: null,
  },
  source_index: 8,
}

// rc_out gate failure (proposed_vs_movement_drift_500kg) WITH the drifted dates threaded
// onto the row by the worker — the exact case on Renzo's screen (June 10 + June 12).
const gateFailureRow: HeldRow = {
  reason: 'proposed_vs_movement_drift_500kg',
  natural_key: 'proposed_vs_movement_drift_500kg',
  detail: '2 drift date(s); serious >500kg — HALT, write nothing.',
  kind: 'gate_failure',
  row: {
    gate: 'proposed_vs_movement_drift_500kg',
    drift_dates: [
      { date: '2026-06-10', proposed_kg: 71144, movement_kg: 57401, diff_kg: 13743 },
      { date: '2026-06-12', proposed_kg: 82375, movement_kg: null, note: 'no movement entry' },
    ],
  },
}

// rc_out gate failure (db_vs_movement_duplication, O>M) — the DB sum EXCEEDS the movement
// sheet for a date. The worker threads db_sum_kg/movement_kg/excess_kg (NO ₱). Two shapes:
//   - noDupOmRow  → the REAL June-10 case: 5 distinct feedings, 71,144 kg, movement short 13,743.
//   - dupOmRow    → a fabricated double-entry case: one feeding saved twice.
const noDupOmRow: HeldRow = {
  reason: 'db_vs_movement_duplication',
  natural_key: 'db_vs_movement_duplication',
  detail: '1 drift date(s); DB exceeds movement — HALT, write nothing.',
  kind: 'gate_failure',
  row: {
    gate: 'db_vs_movement_duplication',
    drift_dates: [
      { date: '2026-06-10', db_sum_kg: 71144, movement_kg: 57401, excess_kg: 13743 },
    ],
  },
}
// The June-10 DB reality: 5 DISTINCT feedings (different batch/weight), zero duplicates.
const june10DistinctFeedings = [
  { id: 'r1', transaction_date: '2026-06-10', batch_id: 'b1', destination: 'MAIN', weight_kg: 20000, batches: { batch_code: 'JUNE-26-FEED1' } },
  { id: 'r2', transaction_date: '2026-06-10', batch_id: 'b2', destination: 'MAIN', weight_kg: 18000, batches: { batch_code: 'JUNE-26-FEED2' } },
  { id: 'r3', transaction_date: '2026-06-10', batch_id: 'b3', destination: 'MAIN', weight_kg: 19601, batches: { batch_code: 'JUNE-26-FEED3' } },
  { id: 'r4', transaction_date: '2026-06-10', batch_id: 'b4', destination: 'MAIN', weight_kg: 10813, batches: { batch_code: 'JUNE-26-FEED4' } },
  { id: 'r5', transaction_date: '2026-06-10', batch_id: 'b5', destination: 'MAIN', weight_kg: 2930, batches: { batch_code: 'JUNE-26-FEED5' } },
]

const dupOmRow: HeldRow = {
  reason: 'db_vs_movement_duplication',
  natural_key: 'db_vs_movement_duplication',
  detail: '1 drift date(s); DB exceeds movement — HALT, write nothing.',
  kind: 'gate_failure',
  row: {
    gate: 'db_vs_movement_duplication',
    drift_dates: [
      { date: '2026-06-11', db_sum_kg: 30000, movement_kg: 20000, excess_kg: 10000 },
    ],
  },
}
// June-11 DB reality: the SAME feeding saved twice (exact-duplicate rows).
const june11DuplicatedFeedings = [
  { id: 'd1', transaction_date: '2026-06-11', batch_id: 'b9', destination: 'MAIN', weight_kg: 10000, batches: { batch_code: 'JUNE-26-FEED9' } },
  { id: 'd2', transaction_date: '2026-06-11', batch_id: 'b9', destination: 'MAIN', weight_kg: 10000, batches: { batch_code: 'JUNE-26-FEED9' } },
  { id: 'd3', transaction_date: '2026-06-11', batch_id: 'b8', destination: 'MAIN', weight_kg: 10000, batches: { batch_code: 'JUNE-26-FEED8' } },
]

// A recording mock of the Anthropic client — captures the exact prompt string it is handed
// (system + user), so we can assert the specifics reach the model. It returns a canned
// JSON array so the flow that would call anthropic can run end-to-end without the API.
interface CapturedCall {
  system: string
  user: string
}
function mockAnthropic(cannedReason: string) {
  const captured: CapturedCall[] = []
  const client = {
    messages: {
      create: async (args: {
        system: Array<{ text: string }>
        messages: Array<{ content: string }>
      }) => {
        captured.push({
          system: args.system.map((s) => s.text).join('\n'),
          user: args.messages.map((m) => m.content).join('\n'),
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  natural_key: gateFailureRow.natural_key,
                  verdict: 'skip',
                  reason: cannedReason,
                },
              ]),
            },
          ],
        }
      },
    },
  }
  return { client, captured }
}

// The exact plant-floor jargon Renzo asked us to ban from the advisor's language.
const BANNED_JARGON = [
  'gate failure',
  'gate',
  'upstream',
  'DB SUM',
  'settled date',
  'HALT',
  'watermark',
  'envelope',
  'natural key',
  'idempotent',
]

// ── Price-gating guard: no lookup may ever select a ₱/cost column ────────────
const FORBIDDEN_COLS = /cost_basis|avg_cost|avg_price|_price|php_/i

async function main() {
  console.log('\n  Held-row adjudication evidence harness\n')

  // 1. dup PRESENT → the lookup filters correctly + evidence says "identical … exists".
  await check('sub_watermark dup PRESENT → issues (date,batch_id,destination) lookup + "identical" evidence', async () => {
    const { admin, calls } = mockAdmin({
      data: [
        { id: 'abc123', transaction_date: '2026-06-30', destination: 'MAIN', weight_kg: 5820 },
      ],
      error: null,
    })
    const ev = await lookupEvidence(admin, 'rc_out', subWatermarkRow)
    // The lookup hit rc_out with exactly the three eq filters.
    assert.equal(calls.length, 1, 'exactly one DB lookup issued')
    assert.equal(calls[0].table, 'rc_out')
    const eqs = calls[0].filters.filter((f) => f[0] === 'eq')
    assert.deepEqual(
      eqs.map((f) => [f[1], f[2]]),
      [
        ['transaction_date', '2026-06-30'],
        ['batch_id', 'b-feed5-uuid'],
        ['destination', 'MAIN'],
      ],
      'filters on transaction_date + batch_id + destination'
    )
    assert.ok(calls[0].filters.some((f) => f[0] === 'limit'), 'query is bounded (.limit)')
    assert.match(ev ?? '', /identical feeding already exists/i)
    assert.match(ev ?? '', /abc123/)
    // Evidence must flow into the prompt (skip-lean signal present).
    const prompt = buildAdjudicationPrompt('rc_out', [subWatermarkRow], [ev])
    assert.match(prompt, /identical feeding already exists/i, 'prompt carries the "existing row" evidence')
    assert.match(
      prompt,
      /last day we already recorded/i,
      'prompt carries the (plain) rule meaning',
    )
    assert.match(prompt, /2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg/, 'prompt carries the human key')
  })

  // 2. dup ABSENT → evidence says "No rc_out row exists" (apply-lean).
  await check('sub_watermark dup ABSENT → "No rc_out row exists" evidence (apply-lean)', async () => {
    const { admin } = mockAdmin({ data: [], error: null })
    const ev = await lookupEvidence(admin, 'rc_out', subWatermarkRow)
    assert.match(ev ?? '', /No rc_out row exists/i)
    assert.match(ev ?? '', /genuine missing feeding/i)
    const prompt = buildAdjudicationPrompt('rc_out', [subWatermarkRow], [ev])
    assert.match(prompt, /No rc_out row exists/i, 'prompt carries the "no match" evidence')
  })

  // 3. Price-gating: across EVERY kind, no lookup selects a ₱/cost column.
  await check('price gating — no lookup selects a ₱/cost column (all kinds)', async () => {
    const kinds: HeldRow[] = [
      subWatermarkRow,
      {
        reason: 'L033', natural_key: 'x', detail: '', kind: 'cross_batch_reassignment',
        row: { transaction_date: '2026-07-02', truck_plate: 'MAN 3625' },
      },
      { reason: 'u', natural_key: 'x', detail: '', kind: 'unmapped_batch_code', row: { batch_code: 'JULY-26-BLK9' } },
      { reason: 'loc', natural_key: 'x', detail: '', kind: 'location_occupied', row: { block_loc: 'A-19C' } },
      { reason: 'bag', natural_key: 'x', detail: '', kind: 'unmapped_bag_type_code', row: { bag_type_codes: ['XYZ'] } },
    ]
    for (const held of kinds) {
      const { admin, calls } = mockAdmin({ data: [], error: null })
      await lookupEvidence(admin, held.kind === 'cross_batch_reassignment' ? 'deliveries' : 'rc_out', held)
      for (const c of calls) {
        assert.ok(
          !FORBIDDEN_COLS.test(c.columns),
          `lookup on ${c.table} selected a forbidden ₱/cost column: "${c.columns}"`
        )
      }
    }
  })

  // 4. No-DB-lookup kinds issue zero queries. malformed/low_confidence return null (no
  //    evidence at all); gate_failure renders from the row (non-null) but still hits no DB.
  await check('no-lookup kinds (malformed/low_confidence/gate_failure) issue zero DB queries', async () => {
    for (const kind of ['malformed', 'low_confidence'] as const) {
      const { admin, calls } = mockAdmin({ data: [], error: null })
      const ev = await lookupEvidence(admin, 'rc_out', { reason: kind, natural_key: 'x', detail: '', kind })
      assert.equal(ev, null, `${kind} → null evidence`)
      assert.equal(calls.length, 0, `${kind} → no DB query`)
    }
    // gate_failure with NO drift_dates on the row → a plain fallback line, still no DB query.
    const { admin, calls } = mockAdmin({ data: [], error: null })
    const ev = await lookupEvidence(admin, 'rc_out', {
      reason: 'gate_failure', natural_key: 'x', detail: '', kind: 'gate_failure',
    })
    assert.equal(calls.length, 0, 'gate_failure → no DB query')
    assert.match(ev ?? '', /Nothing was saved/i, 'gate_failure → plain fallback evidence, not null')
  })

  // 5. gate_failure WITH drift_dates → evidence + PROMPT carry the exact dates + both numbers.
  await check('gate_failure drift → evidence names June 10/12 with both totals (no DB query)', async () => {
    const { admin, calls } = mockAdmin({ data: [], error: null })
    const ev = await lookupEvidence(admin, 'rc_out', gateFailureRow)
    // gate_failure renders from the row — it must NOT hit the DB.
    assert.equal(calls.length, 0, 'gate_failure issues no DB query (renders from the row)')
    // Evidence names the specific days + both raw numbers.
    assert.match(ev ?? '', /June 10/, 'evidence names June 10')
    assert.match(ev ?? '', /June 12/, 'evidence names June 12')
    assert.match(ev ?? '', /71,144/, 'evidence carries the daily-report total 71,144')
    assert.match(ev ?? '', /57,401/, 'evidence carries the movement-sheet total 57,401')
    assert.match(ev ?? '', /no entry/i, 'evidence flags the missing movement entry for June 12')
  })

  // 5b. O>M gate, NO duplicates (the real June-10 case) → evidence self-diagnoses the
  //     movement sheet as the culprit, NOT the database. Issues ONE rc_out read per date,
  //     filtered on transaction_date, selecting NO ₱/cost column.
  await check('O>M gate, no duplicates (June-10) → "No duplicate rows … movement sheet … missing … DB looks correct"', async () => {
    const { admin, calls } = mockAdminByDate({ '2026-06-10': june10DistinctFeedings })
    const ev = await lookupEvidence(admin, 'rc_out', noDupOmRow)
    // Exactly one DB read, on rc_out, filtered by transaction_date, bounded, no ₱ column.
    assert.equal(calls.length, 1, 'exactly one rc_out read (one per drifted date)')
    assert.equal(calls[0].table, 'rc_out')
    assert.ok(
      calls[0].filters.some((f) => f[0] === 'eq' && f[1] === 'transaction_date' && f[2] === '2026-06-10'),
      'query filters on transaction_date = 2026-06-10',
    )
    assert.ok(calls[0].filters.some((f) => f[0] === 'limit'), 'query is bounded (.limit)')
    assert.ok(!FORBIDDEN_COLS.test(calls[0].columns), `O>M read selected a ₱/cost column: "${calls[0].columns}"`)
    // The diagnosis: no duplicates → movement sheet is short, DB is correct.
    assert.match(ev ?? '', /No duplicate rows/i, 'evidence states no duplicate rows exist')
    assert.match(ev ?? '', /movement sheet is most likely MISSING/i, 'evidence leans movement-sheet gap')
    assert.match(ev ?? '', /database looks correct|DB looks correct/i, 'evidence exonerates the database')
    assert.match(ev ?? '', /5 distinct feedings/i, 'evidence names the distinct-feeding count')
    assert.match(ev ?? '', /71,144/, 'evidence carries the DB sum 71,144')
    assert.match(ev ?? '', /13,743/, 'evidence carries the excess 13,743')
    // It must NOT blanket-assume duplication.
    assert.doesNotMatch(ev ?? '', /suspected duplicat/i, 'evidence does NOT blanket-assume duplication')
  })

  // 5c. O>M gate, duplicates PRESENT → evidence names the duplicate feeding + lean DB-issue.
  await check('O>M gate, duplicates present → "duplicate feedings … appears N times" (DB-issue lean)', async () => {
    const { admin, calls } = mockAdminByDate({ '2026-06-11': june11DuplicatedFeedings })
    const ev = await lookupEvidence(admin, 'rc_out', dupOmRow)
    assert.equal(calls.length, 1, 'exactly one rc_out read')
    assert.equal(calls[0].table, 'rc_out')
    assert.ok(
      calls[0].filters.some((f) => f[0] === 'eq' && f[1] === 'transaction_date' && f[2] === '2026-06-11'),
      'query filters on transaction_date = 2026-06-11',
    )
    assert.ok(!FORBIDDEN_COLS.test(calls[0].columns), `O>M read selected a ₱/cost column: "${calls[0].columns}"`)
    assert.match(ev ?? '', /duplicate feedings/i, 'evidence flags duplicate feedings')
    assert.match(ev ?? '', /appears 2 times/i, 'evidence names how many times the feeding appears')
    assert.match(ev ?? '', /JUNE-26-FEED9/, 'evidence names the duplicated batch')
    assert.match(ev ?? '', /double-entry in the database/i, 'evidence leans DB double-entry')
    assert.match(ev ?? '', /remove the extra rows/i, 'evidence gives the concrete next step')
  })

  // 6. The specifics reach the MODEL: build the prompt the way adjudicateHeldRows does
  //    (lookupEvidence → buildAdjudicationPrompt) and hand it to a mocked anthropic.
  await check('mocked anthropic receives a prompt carrying the exact dates + both numbers', async () => {
    const { admin } = mockAdmin({ data: [], error: null })
    const ev = await lookupEvidence(admin, 'rc_out', gateFailureRow)
    const prompt = buildAdjudicationPrompt('rc_out', [gateFailureRow], [ev])

    const { client, captured } = mockAnthropic(
      'Nothing was saved for RC OUT. June 10 and June 12 do not add up. Check those two days.',
    )
    // Mirror the single-completion call in adjudicateHeldRows (no tool loop).
    await client.messages.create({
      system: [{ text: ADJUDICATOR_SYSTEM }],
      messages: [{ content: prompt }],
    })
    assert.equal(captured.length, 1, 'the model was called exactly once')
    const sent = captured[0].user
    assert.match(sent, /2026-06-10/, 'prompt carries the ISO date 2026-06-10')
    assert.match(sent, /71144|71,144/, 'prompt carries the daily-report number 71144')
    assert.match(sent, /57401|57,401/, 'prompt carries the movement-sheet number 57401')
    // And the plain-English rendered evidence rode along.
    assert.match(sent, /June 10/, 'prompt carries the human-rendered "June 10"')
  })

  // 7. The system prompt's GOOD EXAMPLES (the register the model copies) are jargon-free,
  //    and the ban instruction is present. We test the examples block only — the ban line
  //    itself deliberately quotes the forbidden words, so testing the whole prompt would be
  //    self-defeating.
  await check('ADJUDICATOR_SYSTEM examples are jargon-free + the ban instruction is present', () => {
    // The ban instruction must be present so the model is told to avoid the words.
    assert.match(ADJUDICATOR_SYSTEM, /Do NOT use these words/i, 'the ban instruction is present')

    // Isolate the good-examples block (the concrete reason text the model emulates). It runs
    // from the "Good examples" heading to the JSON-array response instruction.
    const start = ADJUDICATOR_SYSTEM.indexOf('Good examples')
    const end = ADJUDICATOR_SYSTEM.indexOf('Respond with ONLY')
    assert.ok(start >= 0 && end > start, 'the examples block is present and precedes the response spec')
    const examples = ADJUDICATOR_SYSTEM.slice(start, end).toLowerCase()

    for (const word of BANNED_JARGON) {
      assert.ok(
        !examples.includes(word.toLowerCase()),
        `banned jargon "${word}" leaked into the ADJUDICATOR_SYSTEM examples — the model copies these`,
      )
    }
  })

  // 8. BEFORE/AFTER demo for the June-10 O>M row — prints the old assumption-baked line
  //    vs the new self-diagnosed evidence, so the behavior change is visible in the run.
  await check('BEFORE/AFTER — June-10 O>M evidence self-diagnoses instead of assuming duplication', async () => {
    // BEFORE: the old code rendered the drift date with ZERO DB calls, baking in the
    // "more already saved than the sheet" duplication assumption. Reproduce that string.
    const before =
      'Nothing was saved for this report. Days that don\'t add up: ' +
      'June 10 — the system already has 71,144 kg saved but the movement sheet shows ' +
      '57,401 kg (13,743 kg more already saved than the sheet).'
    // AFTER: the new code reads rc_out for June 10 (5 distinct feedings, no dupes).
    const { admin } = mockAdminByDate({ '2026-06-10': june10DistinctFeedings })
    const after = await lookupEvidence(admin, 'rc_out', noDupOmRow)
    console.log('\n    BEFORE (assumed duplication, no DB read):')
    console.log(`      ${before}`)
    console.log('    AFTER (self-diagnosed via rc_out read):')
    console.log(`      ${after}\n`)
    assert.ok(before.includes('more already saved than the sheet'), 'before baked in the duplication assumption')
    assert.match(after ?? '', /movement sheet is most likely MISSING/i, 'after diagnoses the movement-sheet gap')
  })

  console.log(`\n  ✓ ${passed} assertions passed\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
