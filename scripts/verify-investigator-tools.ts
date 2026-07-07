/**
 * verify-investigator-tools.ts — framework-free proof of the P2 investigator toolset
 * (lib/investigator/*). Covers the PURE cores (allow-list validation, query-plan
 * building, duplicate grouping, grid serialization cap) plus the file-backed read_rule
 * against the REAL rules files — WITHOUT any live network or storage.
 *
 * Run:  npx tsx scripts/verify-investigator-tools.ts
 * (No test framework at the app root — plain node:assert.)
 */
import assert from 'node:assert/strict'

import {
  isPriceColumn,
  resolveColumns,
  scrubPriceKeys,
  TABLE_ALLOWLIST,
} from '../lib/investigator/allowlist'
import {
  buildDuplicatePlan,
  buildQueryPlan,
  clampLimit,
  groupDuplicates,
  QUERY_MAX_LIMIT,
} from '../lib/investigator/query'
import { buildGridPayload } from '../lib/investigator/source'
import {
  extractDigestLine,
  extractLedgerEntry,
  normalizeRuleId,
  readRule,
} from '../lib/investigator/rules'
import { createInvestigatorTools } from '../lib/investigator/tools'

let passed = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const done = () => {
    passed++
    console.log(`  ✓ ${name}`)
  }
  const r = fn()
  return r instanceof Promise ? r.then(done) : Promise.resolve(done())
}

async function main() {
  // ── allow-list: table / column / price rejection ─────────────────────────
  console.log('allow-list validation:')
  await check('unknown table is rejected', () => {
    const r = resolveColumns('secret_table', undefined)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /Unknown table/)
  })
  await check('unknown column on a valid table is rejected', () => {
    const r = resolveColumns('rc_out', ['transaction_date', 'ssn'])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /"ssn" is not allowed/)
  })
  await check('price column is rejected even by name', () => {
    const r = resolveColumns('deliveries', ['cost_basis'])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /price\/cost column/)
  })
  await check('no allow-list contains a price column', () => {
    for (const [table, cols] of Object.entries(TABLE_ALLOWLIST)) {
      for (const c of cols) {
        assert.equal(isPriceColumn(c), false, `${table}.${c} is a price column and must not be listed`)
      }
    }
  })
  await check('omitting columns yields the full allow-list', () => {
    const r = resolveColumns('rc_out', undefined)
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual([...r.columns], [...TABLE_ALLOWLIST.rc_out])
  })

  // ── price-key scrubbing on a fixture row ─────────────────────────────────
  console.log('\nprice-key scrubbing:')
  await check('scrubPriceKeys strips ₱/cost keys from a returned row', () => {
    const dirty: Record<string, unknown> = {
      transaction_date: '2026-06-10',
      weight_kg: 5820,
      cost_basis: 42.5,
      avg_php_kg: 40,
      rc_out_avg_wtd_value: 1000,
      remarks: 'ok',
    }
    const clean = scrubPriceKeys(dirty)
    assert.ok(!('cost_basis' in clean))
    assert.ok(!('avg_php_kg' in clean))
    assert.ok(!('rc_out_avg_wtd_value' in clean))
    assert.equal(clean.weight_kg, 5820)
    assert.equal(clean.remarks, 'ok')
  })
  await check('scrubPriceKeys leaves a clean row untouched (same object)', () => {
    const clean = { transaction_date: '2026-06-10', weight_kg: 100 }
    assert.equal(scrubPriceKeys(clean), clean)
  })

  // ── query-plan building + limit clamping ─────────────────────────────────
  console.log('\nquery-plan building:')
  await check('a valid plan builds with filters, order, clamped limit', () => {
    const r = buildQueryPlan({
      table: 'rc_out',
      columns: ['id', 'transaction_date', 'weight_kg'],
      filters: [{ column: 'transaction_date', op: 'eq', value: '2026-06-10' }],
      order_by: { column: 'weight_kg', ascending: false },
      limit: 9999,
    })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.plan.limit, QUERY_MAX_LIMIT) // clamped from 9999
      assert.equal(r.plan.filters.length, 1)
      assert.deepEqual(r.plan.orderBy, { column: 'weight_kg', ascending: false })
    }
  })
  await check('a filter on a price column is rejected', () => {
    const r = buildQueryPlan({ table: 'deliveries', filters: [{ column: 'cost_basis', op: 'gte', value: 0 }] })
    assert.equal(r.ok, false)
  })
  await check('a bad filter op is rejected', () => {
    const r = buildQueryPlan({ table: 'rc_out', filters: [{ column: 'weight_kg', op: 'DROP', value: 1 }] })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /op "DROP" is not allowed/)
  })
  await check('"in" op requires an array value', () => {
    const r = buildQueryPlan({ table: 'rc_out', filters: [{ column: 'block_loc', op: 'in', value: 'A-1A' }] })
    assert.equal(r.ok, false)
  })
  await check('clampLimit defaults + bounds', () => {
    assert.equal(clampLimit(undefined), 50)
    assert.equal(clampLimit(0), 1)
    assert.equal(clampLimit(500), QUERY_MAX_LIMIT)
    assert.equal(clampLimit(25), 25)
  })

  // ── check_duplicates plan + grouping ─────────────────────────────────────
  console.log('\ncheck_duplicates:')
  await check('duplicate plan requires a date bound', () => {
    const r = buildDuplicatePlan({ table: 'rc_out', group_by: ['batch_id'], date_column: 'transaction_date' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /Provide either/)
  })
  await check('duplicate plan accepts a single date + valid columns', () => {
    const r = buildDuplicatePlan({
      table: 'rc_out',
      group_by: ['batch_id', 'destination', 'weight_kg'],
      date_column: 'transaction_date',
      date: '2026-06-10',
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.plan.dateFrom, '2026-06-10')
  })
  await check('groupDuplicates returns only count>1 groups with samples', () => {
    const rows = [
      { batch_id: 'b1', destination: 'MAIN', weight_kg: 5820 },
      { batch_id: 'b1', destination: 'MAIN', weight_kg: 5820 }, // dup
      { batch_id: 'b2', destination: 'MAIN', weight_kg: 3000 }, // unique
    ]
    const groups = groupDuplicates(rows, ['batch_id', 'destination', 'weight_kg'])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].count, 2)
    assert.equal(groups[0].sample.length, 2)
  })

  // ── grid serialization cap logic (pure) ──────────────────────────────────
  console.log('\ngrid serialization:')
  await check('buildGridPayload slices, stringifies, trims trailing empty cols', () => {
    const raw: unknown[][] = [
      ['DATE', 'BATCH', 'KG', null, null],
      [new Date('2026-06-10T00:00:00Z'), 'JUNE-26-FEED5', 5820, null, null],
      ['2026-06-11', 'JUNE-26-FEED5', 3000, null, null],
    ]
    const p = buildGridPayload(raw, { file: 'x.xlsx', sheets: ['Sheet1'], sheet: 'Sheet1', startRow: 1, maxRows: 100 })
    assert.equal(p.total_rows, 3)
    assert.equal(p.rows.length, 3)
    assert.equal(p.rows[0].length, 3) // trailing empty cols trimmed
    assert.equal(p.rows[1][0], '2026-06-10') // Date → ISO
    assert.equal(p.rows[1][2], '5820') // number → string
  })
  await check('start_row / max_rows page the grid', () => {
    const raw: unknown[][] = Array.from({ length: 50 }, (_, i) => [`r${i}`, i])
    const p = buildGridPayload(raw, { file: 'x', sheets: ['s'], sheet: 's', startRow: 10, maxRows: 5 })
    assert.equal(p.start_row, 10)
    assert.equal(p.rows.length, 5)
    assert.equal(p.rows[0][0], 'r9') // 1-based start_row=10 → index 9
  })
  await check('oversized payload halves rows and flags truncation', () => {
    // 400 rows × a wide-ish string → well over 40KB, forces one halving.
    const raw: unknown[][] = Array.from({ length: 400 }, (_, i) => [`row-${i}-${'x'.repeat(200)}`])
    const p = buildGridPayload(raw, { file: 'big', sheets: ['s'], sheet: 's', startRow: 1, maxRows: 300 })
    assert.equal(p.truncated, true)
    assert.ok(p.rows.length < 300)
    assert.match(p.note ?? '', /halved/)
  })
  await check('max_rows is clamped to the hard cap (300)', () => {
    const raw: unknown[][] = Array.from({ length: 1000 }, (_, i) => [i])
    const p = buildGridPayload(raw, { file: 'x', sheets: ['s'], sheet: 's', startRow: 1, maxRows: 9999 })
    assert.ok(p.rows.length <= 300)
  })

  // ── read_rule against the REAL rules files ───────────────────────────────
  console.log('\nread_rule (real files):')
  await check('normalizeRuleId zero-pads and rejects junk', () => {
    assert.equal(normalizeRuleId('l-7'), 'L-007')
    assert.equal(normalizeRuleId('L-019'), 'L-019')
    assert.equal(normalizeRuleId('nope'), null)
  })
  await check('readRule digest slices a real digest line for L-007', async () => {
    const out = JSON.parse(await readRule('L-007', false))
    assert.equal(out.rule_id, 'L-007')
    assert.equal(out.full, false)
    assert.ok(typeof out.digest === 'string' && out.digest.includes('L-007'))
  })
  await check('readRule full slices the real ledger entry for L-007', async () => {
    const out = JSON.parse(await readRule('L-007', true))
    assert.equal(out.full, true)
    assert.ok(out.entry.startsWith('### L-007'))
    assert.ok(out.entry.length > 100)
    // must stop at the next heading — not bleed into L-006/L-008
    assert.ok(!/\n### L-00[68]/.test(out.entry))
  })
  await check('readRule L-019 (settled-date duplication rule) is retrievable', async () => {
    const digest = JSON.parse(await readRule('L-019', false))
    assert.ok(digest.digest.includes('L-019'))
    const full = JSON.parse(await readRule('L-019', true))
    assert.ok(full.entry.includes('L-019'))
  })
  await check('extractLedgerEntry concatenates both same-id L-010 entries', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const ledger = await readFile(path.join(process.cwd(), '.claude/skills/sync-ictc/LEARNING_LEDGER.md'), 'utf8')
    const entry = extractLedgerEntry(ledger, 'L-010')
    assert.ok(entry)
    // there are two L-010 headings in the ledger — both must be present
    const count = (entry!.match(/### L-010/g) ?? []).length
    assert.ok(count >= 2, `expected ≥2 L-010 blocks, got ${count}`)
  })
  await check('unknown rule returns an error with nearby ids', async () => {
    const out = JSON.parse(await readRule('L-999', false))
    assert.ok(out.error)
    assert.ok(Array.isArray(out.nearby_rule_ids) && out.nearby_rule_ids.includes('L-007'))
  })
  await check('extractDigestLine returns null for an absent id', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const digest = await readFile(path.join(process.cwd(), '.claude/skills/sync-ictc/RULES_DIGEST.md'), 'utf8')
    assert.equal(extractDigestLine(digest, 'L-999'), null)
  })

  // ── factory-level arg validation (no network) ────────────────────────────
  console.log('\nfactory dispatch (arg validation, no DB):')
  await check('read_run_source errors when no run is attached', async () => {
    const tools = createInvestigatorTools({ runId: null, canViewPrices: true })
    const out = JSON.parse(await tools.execute('read_run_source', { source_key: 'rc_out' }))
    assert.equal(out.error, 'no run attached to this case')
  })
  await check('read_rule via factory rejects a malformed id (no DB touched)', async () => {
    const tools = createInvestigatorTools({ runId: 'r1', canViewPrices: false })
    const out = JSON.parse(await tools.execute('read_rule', { rule_id: 'banana' }))
    assert.match(out.error, /Invalid rule id/)
  })
  await check('unknown tool name returns an error string', async () => {
    const tools = createInvestigatorTools({ runId: 'r1', canViewPrices: true })
    const out = JSON.parse(await tools.execute('drop_table', {}))
    assert.match(out.error, /Unknown tool/)
  })
  await check('find_batches rejects a too-short query (no DB touched)', async () => {
    const tools = createInvestigatorTools({ runId: null, canViewPrices: true })
    const out = JSON.parse(await tools.execute('find_batches', { code_query: 'ab' }))
    assert.match(out.error, /at least 3 characters/)
  })
  await check('all 5 tool definitions are exposed with schemas', () => {
    const tools = createInvestigatorTools({ runId: 'r1', canViewPrices: true })
    const names = tools.definitions.map((d) => d.name).sort()
    assert.deepEqual(names, ['check_duplicates', 'find_batches', 'query_table', 'read_rule', 'read_run_source'])
    for (const d of tools.definitions) {
      assert.equal(d.input_schema.type, 'object')
    }
  })

  console.log(`\nAll ${passed} investigator-tool checks passed.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
