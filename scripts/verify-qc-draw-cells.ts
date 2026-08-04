/**
 * verify-qc-draw-cells.ts — framework-free assertions over the QC Ledger's DRAFT ROW
 * (app/(app)/cenapro/qc/draw-entry-rows.tsx + the shared parsers in
 * lib/cenapro/ccc-analysis.ts). No DB, no browser, no test framework.
 *
 * QC entry became materially more powerful on 2026-08-04 — EVERY cell is now typed
 * (PLANT included, as of the third pass), dates are free text that becomes `yyyy-MM-dd`,
 * blanks arrive UNDATED, and a lab reading typed on a new row is applied to the sample
 * GROUP that row lands in. Four of those are places a silent wrongness would be
 * expensive:
 *
 *   · a date that parses to the wrong year files a receipt in the wrong month;
 *   · an editability rule that drifts back to "disabled until FLEC" makes typing down a
 *     row impossible again (WHSE/SIDE/BAGS sit BEFORE SRC in the column order);
 *   · two rows landing in one sample group with different readings must be REFUSED, not
 *     merged — last-write-wins would throw a number away without saying so;
 *   · PLANT is now an OVERRIDE, and the derived value must never be echoed back as a
 *     supplied one — a `plant_source` that always says `supplied` answers nothing. The
 *     two assertions that used to pin "PLANT is never typed and no `p_plant` is ever
 *     sent" are INVERTED below; the RPC grew `p_plant` on 2026-08-04.
 *
 * Run: npx tsx scripts/verify-qc-draw-cells.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  METRICS,
  isIsoDate,
  parseMetricValue,
  parseQcDate,
  sampleGroupKey,
  type AddPartnerDrawResult,
} from '@/lib/cenapro/ccc-analysis'
import {
  COL_COUNT,
  derivedPlant,
  draftBlocker,
  draftGroupKey,
  draftMetrics,
  draftToInput,
  effectivePlant,
  findDraftReadingConflicts,
  isMeaningfulDraft,
  isSendableDraft,
  makeBlankDraft,
  makeBlankDrafts,
  plantOverride,
  type DraftDraw,
} from '@/app/(app)/cenapro/qc/draw-entry-rows'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROWS = join(HERE, '../app/(app)/cenapro/qc/draw-entry-rows.tsx')
const LEDGER = join(HERE, '../app/(app)/cenapro/qc/qc-ledger-client.tsx')
const ACTIONS = join(HERE, '../app/(app)/cenapro/qc/actions.ts')

/**
 * Executable code only. These files' comments discuss the very identifiers the source
 * scans forbid — that is what the comments are FOR — so a raw-text scan would trip on
 * the prose explaining the rule. The `[^:]` guard keeps a `https://` inside a future
 * string from decapitating a line.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++

  console.log(`  ✓ ${name}`)
}

/** The context year every date assertion below reads a bare `6/27` against. */
const YEAR = 2026

/**
 * A row that has been DATED — the baseline for every non-date assertion below.
 *
 * `makeBlankDraft` no longer dates anything (2026-08-04), so the date is applied here
 * explicitly rather than inherited. The argument is the row's `anchorDate`, which is
 * layout only and never the receipt date.
 */
function draft(patch: Partial<DraftDraw> = {}): DraftDraw {
  return { ...makeBlankDraft('2026-06-27'), recvDate: '2026-06-27', ...patch }
}

/** A row that passes every courtesy check — the baseline the negatives deviate from. */
function goodTankDraft(patch: Partial<DraftDraw> = {}): DraftDraw {
  return draft({
    recvDate: '2026-06-27',
    src: 'TNK 1',
    mach: 'C1',
    grade: 'A',
    shift: 'D',
    wt: '12500',
    ...patch,
  })
}

// ── Dates: free text in, yyyy-MM-dd out ───────────────────────────────────────

check('a bare day-and-month takes the ledger’s context year', () => {
  const r = parseQcDate('6/27', YEAR)
  assert.ok('iso' in r, `expected 6/27 to parse, got ${JSON.stringify(r)}`)
  assert.equal(r.iso, '2026-06-27')
  // The context year is the FOCUSED MONTH's, not "now" — a different year must move it.
  const older = parseQcDate('6/27', 2024)
  assert.ok('iso' in older)
  assert.equal(older.iso, '2024-06-27')
})

check('every shape the operators type reaches the same day', () => {
  for (const text of ['6/27', '6/27/26', '6/27/2026', '2026-06-27', '2026/6/27', '27 Jun 26', '06-27']) {
    const r = parseQcDate(text, YEAR)
    assert.ok('iso' in r, `"${text}" should be a date, got ${JSON.stringify(r)}`)
    assert.equal(r.iso, '2026-06-27', `"${text}"`)
  }
})

check('a date that is not a date is REFUSED, never guessed at', () => {
  for (const text of ['6/45', '13/2', 'abc', '2026-02-30', '--', '0/0']) {
    const r = parseQcDate(text, YEAR)
    assert.ok('error' in r, `"${text}" must be refused, got ${JSON.stringify(r)}`)
    assert.match(r.error, /is not a date/, `"${text}" should say so plainly`)
    assert.match(r.error, /2026/, `"${text}" should name the year a bare M/D would take`)
  }
})

check('an ISO SHAPE that is not a real day is caught (the Feb 30 trap)', () => {
  assert.equal(isIsoDate('2026-06-27'), true)
  assert.equal(isIsoDate('2026-02-29'), false) // 2026 is not a leap year
  assert.equal(isIsoDate('2024-02-29'), true)
  assert.equal(isIsoDate('2026-02-30'), false)
  assert.equal(isIsoDate('2026-13-01'), false)
  assert.equal(isIsoDate('6/27/2026'), false)
  assert.equal(isIsoDate(''), false)
})

check('a blank date is refused rather than fabricated', () => {
  const r = parseQcDate('   ', YEAR)
  assert.ok('error' in r)
  assert.equal(parseQcDate('', YEAR) && 'error' in parseQcDate('', YEAR), true)
})

check('draftToInput normalizes BOTH date cells on the way to the server', () => {
  const input = draftToInput(goodTankDraft({ recvDate: '6/27', prodDate: '6/25' }), YEAR)
  assert.equal(input.recvDate, '2026-06-27')
  assert.equal(input.prodDate, '2026-06-25')
  // An empty prod date stays absent — never fabricated from the receipt date.
  assert.equal(draftToInput(goodTankDraft({ prodDate: '' }), YEAR).prodDate, null)
})

check('an unreadable date is left exactly as typed, and the row is blocked', () => {
  const d = goodTankDraft({ recvDate: '6/45' })
  assert.equal(draftToInput(d, YEAR).recvDate, '6/45', 'never silently corrected')
  assert.match(String(draftBlocker(d, YEAR)), /is not a date/)
})

check('a production date after the receipt date is named before the round trip', () => {
  assert.match(
    String(draftBlocker(goodTankDraft({ recvDate: '6/27', prodDate: '6/28' }), YEAR)),
    /cannot be after/,
  )
  assert.equal(draftBlocker(goodTankDraft({ recvDate: '6/27', prodDate: '6/27' }), YEAR), null)
})

// ── Editability: what a draft row lets you type ───────────────────────────────

check('the draft row spans exactly the ledger’s columns', () => {
  const ledger = readFileSync(LEDGER, 'utf8')
  const block = /const COLS: LedgerCol\[\] = \[([\s\S]*?)\n\];/.exec(ledger)
  assert.ok(block, 'could not find the COLS table in qc-ledger-client.tsx')
  const keys = [...block[1].matchAll(/key: '([a-z]+)'/g)].map((m) => m[1])
  assert.equal(
    keys.length,
    COL_COUNT,
    `COLS has ${keys.length} columns but a draft row spans ${COL_COUNT} — the status line under a row would misalign`,
  )
  // The order the draft row's cells are written in, restated so a reshuffle trips here.
  assert.deepEqual(keys, [
    'date', 'prod', 'shift', 'grade', 'plant', 'whse', 'side', 'bags', 'src', 'mach', 'wt',
    'bd', 'ash', 'grit', 'mc',
  ])
})

check('WHSE / SIDE / BAGS are no longer locked behind a FLEC source', () => {
  const src = stripComments(readFileSync(ROWS, 'utf8'))
  // The exact gate that made typing down a row impossible: those three columns sit
  // BEFORE SRC, so an operator could not reach the cell that would unlock them.
  assert.doesNotMatch(
    src,
    /disabled=\{busy \|\| !isFlec\}/,
    'WHSE/SIDE/BAGS must not be disabled until the source reads FLEC',
  )
  assert.doesNotMatch(src, /\bisFlec\b/, 'no cell should branch its editability on the source')
  // …and the file still contains the cells, so the assertions above are not vacuous.
  for (const field of ['whse', 'side', 'bags', 'src', 'mach', 'wt']) {
    assert.match(src, new RegExp(`value=\\{draft\\.${field}\\}`), `the ${field} cell should exist`)
  }
})

check('the ONLY disabled state on a draft cell is the in-flight one', () => {
  const src = stripComments(readFileSync(ROWS, 'utf8'))
  const disables = [...src.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1].trim())
  assert.ok(disables.length > 0, 'expected the draft row to pass a disabled prop somewhere')
  for (const expr of disables) {
    // `busy` = this row is in flight. `disabled` = DraftCell forwarding its own prop.
    // Anything else is a rule about the DATA deciding whether a cell can be typed in,
    // which is exactly what Renzo asked to be removed.
    assert.ok(
      expr === 'busy' || expr === 'disabled',
      `a draft cell may only be disabled while saving, found: ${expr}`,
    )
  }
})

check('a draft row’s keystrokes never reach the saved-cell state machine', () => {
  const src = stripComments(readFileSync(ROWS, 'utf8'))
  // The draft row sits inside the grid scrollport, which carries useGridKeyboardNav's
  // handler. That handler bails only when NOTHING is selected — so without this, Tab in
  // a draft cell is preventDefault-ed into the coordinate space and a printable key
  // opens an editor on a SAVED cell and types into it.
  assert.match(src, /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/, 'the draft <tr> must contain its own keys')
  const ledger = stripComments(readFileSync(LEDGER, 'utf8'))
  assert.match(ledger, /onKeyDown=\{handleKeyDown\}/, '…and the grid host still owns the saved rows')
})

check('the four metric cells are typable, and carried on the draft row', () => {
  const src = stripComments(readFileSync(ROWS, 'utf8'))
  assert.match(src, /value=\{draft\.metrics\[metric\] \?\? ''\}/, 'metric cells must be inputs')
  assert.doesNotMatch(src, /colSpan=\{metricCount\}/, 'the metric colSpan status cell is gone')
  const d = draft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '11.6' } })
  assert.deepEqual(draftMetrics(d), { bd: '0.56', mc: '11.6' }, 'blank metric cells are dropped')
  assert.equal(draftMetrics(draft()), undefined, 'a row with no reading says nothing')
  assert.equal(isMeaningfulDraft(d), true, 'a reading alone makes a row meaningful')
})

// ── PLANT: derived by default, typable, and only SENT when overridden ─────────
//
// These four checks replace the pair that used to pin "PLANT is never typed and no
// `p_plant` is ever sent". That rule was one function's choice, not the data model:
// `cenapro_add_partner_draw` INSERTs into `cenapro.production_event`, the same table
// and the same column the Production ledger writes through an ordinary dropdown, and
// this screen transcribes partner slips that can name a plant the source does not
// predict. The RPC gained `p_plant` on 2026-08-04. What must NOT drift is the other
// half of the rule — blank still means "derive", never "clear".

check('the derivation from SRC is unchanged, and is what a blank row shows', () => {
  assert.equal(derivedPlant('TNK 1'), 'W6')
  assert.equal(derivedPlant('tnk 4'), 'W6')
  assert.equal(derivedPlant('W7'), 'W7')
  assert.equal(derivedPlant('W6'), 'W6')
  assert.equal(derivedPlant('FLEC'), '')
  assert.equal(derivedPlant(''), '')
  // Nothing typed → the cell still displays the derivation, so the common case stays
  // zero-effort and correct.
  assert.equal(effectivePlant(goodTankDraft()), 'W6')
  assert.equal(plantOverride(goodTankDraft()), '', 'an untouched plant is not an override')
})

check('a TYPED plant overrides the derivation, and is what gets stored', () => {
  const typed = goodTankDraft({ plant: 'W7' }) // TNK 1 would derive W6
  assert.equal(plantOverride(typed), 'W7')
  assert.equal(effectivePlant(typed), 'W7', 'the override is the effective value')
  assert.equal(derivedPlant(typed.src), 'W6', '…and the derivation is still knowable')
  // Case/whitespace canonicalize the way the RPC canonicalizes them, so ` w6/w7 `
  // reaches the server as the real code rather than as an invalid_key.
  assert.equal(effectivePlant(goodTankDraft({ plant: ' w6/w7 ' })), 'W6/W7')
  // A FLEC draw derives NO plant, so a typed one there is a pure addition.
  assert.equal(effectivePlant(goodTankDraft({ src: 'FLEC', whse: 'WHSE 7', bags: '38' })), '')
  assert.equal(
    effectivePlant(goodTankDraft({ src: 'FLEC', whse: 'WHSE 7', bags: '38', plant: 'W6' })),
    'W6',
  )
})

check('`p_plant` is sent for an override and NEVER for a derived value', () => {
  // The whole point: echoing the derivation back would make every row return
  // `plant_source: 'supplied'`, and a verdict key with one answer answers nothing.
  assert.equal(
    draftToInput(goodTankDraft(), YEAR).plant,
    undefined,
    'a derived W6 must not be sent as a supplied one',
  )
  // Blank means DERIVE, all the way down — never "clear the plant", which would file a
  // tank draw under an empty sample-group key.
  assert.equal(draftToInput(goodTankDraft({ plant: '   ' }), YEAR).plant, undefined)
  assert.equal(draftToInput(goodTankDraft({ plant: '' }), YEAR).plant, undefined)
  // An override travels, canonicalized.
  assert.equal(draftToInput(goodTankDraft({ plant: 'W7' }), YEAR).plant, 'W7')
  assert.equal(draftToInput(goodTankDraft({ plant: ' w6/w7 ' }), YEAR).plant, 'W6/W7')

  const rows = stripComments(readFileSync(ROWS, 'utf8'))
  assert.match(rows, /set\(\{ plant:/, 'the PLANT cell writes the override')
  assert.match(rows, /plantBadgeClass/, 'and reuses the production ledger’s plant colours')

  const actions = stripComments(readFileSync(ACTIONS, 'utf8'))
  assert.match(actions, /args\.p_plant = plant/, 'the action forwards a typed plant')
  // Omitted, not explicitly null: the file's own idiom for every optional argument, and
  // the exact shape every pre-2026-08-04 call site already used.
  assert.match(actions, /if \(plant\) args\.p_plant = plant/, 'blank is OMITTED, never sent as null')
  assert.doesNotMatch(actions, /p_plant:\s*null/, 'an explicit null would be a different code path')
  // The refusal stays the server's to word — no client-side plant allowlist.
  assert.doesNotMatch(rows, /PLANT_CODES\.includes/, 'invalid_key is the RPC’s sentence, verbatim')
})

check('the three new verdict keys are typed, and read back off the RPC', () => {
  // Compile-time: the keys exist on the shared contract with the right shapes.
  const verdict: AddPartnerDrawResult = {
    ok: true,
    outcome: 'inserted',
    plant_code: 'W7',
    plant_source: 'supplied',
    plant_derived: 'W6',
    plant_notice: 'Plant W7 was entered, but TNK 1 reports to W6.',
  }
  assert.equal(verdict.plant_source, 'supplied')
  assert.equal(verdict.plant_derived, 'W6')

  const actions = stripComments(readFileSync(ACTIONS, 'utf8'))
  for (const key of ['plant_source', 'plant_derived', 'plant_notice']) {
    assert.match(actions, new RegExp(`raw\\.${key}`), `${key} must be read off the verdict`)
  }
  // A notice accompanies a SUCCESSFUL write, so it must never become a confirm gate —
  // that machinery belongs to duplicate_warning alone.
  const ledger = stripComments(readFileSync(LEDGER, 'utf8'))
  assert.match(ledger, /v\.plant_notice/, 'the ledger surfaces the notice on the row')
  assert.doesNotMatch(
    ledger,
    /needsDuplicateConfirm:\s*[^,\n]*plant_notice/,
    'a plant notice must not be turned into a confirm round trip',
  )
})

check('the sample-group mirror follows the OVERRIDDEN plant, not the derived one', () => {
  // `whse_key = coalesce(warehouse_code, plant_code)` — plant_code is the EFFECTIVE one,
  // so a typed W7 on a TNK 1 row lands in a different group and must be mirrored there.
  assert.equal(
    draftGroupKey(goodTankDraft({ plant: 'W7' }), YEAR),
    sampleGroupKey({ sample_date: '2026-06-27', source_location_code: 'TNK 1', whse_key: 'W7' }),
  )
  // …and two rows that the server would file APART are not claimed to be one here.
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft({ plant: 'W7', metrics: { bd: '0.61', ash: '', grit: '', mc: '' } })
  assert.deepEqual(findDraftReadingConflicts([a, b], YEAR), [], 'different groups never conflict')
  // On a FLEC draw the warehouse still wins, so a typed plant cannot move the group.
  const flec = { src: 'FLEC', whse: 'WHSE 7', bags: '38' }
  assert.equal(
    draftGroupKey(goodTankDraft({ ...flec, plant: 'W6' }), YEAR),
    draftGroupKey(goodTankDraft(flec), YEAR),
  )
})

// ── Blank rows arrive UNDATED (2026-08-04) ───────────────────────────────────
//
// Renzo: *"when you add draw, leave the new cells in both dates column blank."* Two
// things had to move with that, and both are load-bearing:
//
//   · `isMeaningfulDraft` used to skip `recvDate` on the premise that every blank was
//     born dated. That premise is dead — a date is now always typed, so a row with ONLY
//     a date in it must count, or Save would drop it in silence;
//   · `anchorDate` must stay independent of `recvDate`, or a row would jump between day
//     blocks (or into one that does not exist) between two keystrokes of retyping it.

check('a blank row is scaffolding, not an unsaved change — and is UNDATED', () => {
  const blanks = makeBlankDrafts(10)
  assert.equal(blanks.length, 10)
  assert.equal(blanks.every((d) => d.recvDate === ''), true, 'both date cells start blank')
  assert.equal(blanks.every((d) => d.prodDate === ''), true)
  assert.equal(blanks.every((d) => d.plant === ''), true, 'plant starts on "follow SRC"')
  assert.equal(blanks.every((d) => d.anchorDate === null), true, 'the toolbar’s ten trail the month')
  assert.equal(blanks.every((d) => !isMeaningfulDraft(d)), true)
  assert.equal(blanks.every((d) => !isSendableDraft(d, YEAR)), true)
  // Ten fresh blanks must not read as ten problems: nothing is meaningful, so the
  // "needs a date" courtesy line never renders on any of them.
  assert.equal(blanks.filter((d) => isMeaningfulDraft(d) && draftBlocker(d, YEAR)).length, 0)
})

check('a row with ONLY a date typed is MEANINGFUL — it can no longer be dropped silently', () => {
  const dated = { ...makeBlankDraft(), recvDate: '6/27' }
  assert.equal(isMeaningfulDraft(dated), true, 'a typed date is typing')
  // It is not sendable, but it is NAMED: the courtesy check moves past the date it now
  // has and asks for the next thing the RPC requires.
  assert.equal(isSendableDraft(dated, YEAR), false)
  assert.equal(draftBlocker(dated, YEAR), 'needs a source')
  // …and an undated row that has other typing in it still asks for the date first.
  assert.equal(draftBlocker(goodTankDraft({ recvDate: '' }), YEAR), 'needs a date')
  // Every other single cell alone is meaningful too, PLANT included.
  for (const patch of [
    { prodDate: '6/25' },
    { plant: 'W7' },
    { src: 'TNK 1' },
    { wt: '12500' },
  ] as Partial<DraftDraw>[]) {
    assert.equal(isMeaningfulDraft({ ...makeBlankDraft(), ...patch }), true, JSON.stringify(patch))
  }
})

check('anchorDate is LAYOUT and never tracks recvDate', () => {
  // Fixed at creation, whatever is later typed into the date cell.
  const row = makeBlankDraft('2026-06-27')
  assert.equal(row.anchorDate, '2026-06-27', 'the day block a row was opened under')
  assert.equal(row.recvDate, '', '…and it is NOT the receipt date')
  const retyped = { ...row, recvDate: '2026-07-15' }
  assert.equal(retyped.anchorDate, '2026-06-27', 'retyping the date must not move the row')

  const rows = stripComments(readFileSync(ROWS, 'utf8'))
  assert.doesNotMatch(rows, /anchorDate:[^,\n}]*recvDate/, 'anchorDate is never derived from the date')
  const ledger = stripComments(readFileSync(LEDGER, 'utf8'))
  assert.match(ledger, /d\.anchorDate === day\.date/, 'a day block selects its drafts by anchor…')
  assert.match(ledger, /d\.anchorDate === null/, '…and the trailing block takes the anchorless ones')
  assert.doesNotMatch(ledger, /d\.recvDate === day\.date/, 'never by the typed date')
})

check('the courtesy check names the missing field, in typing order', () => {
  assert.equal(draftBlocker(goodTankDraft({ recvDate: '' }), YEAR), 'needs a date')
  assert.equal(draftBlocker(goodTankDraft({ src: '' }), YEAR), 'needs a source')
  assert.equal(draftBlocker(goodTankDraft({ mach: '' }), YEAR), 'needs a machine')
  assert.equal(draftBlocker(goodTankDraft({ grade: '' }), YEAR), 'needs a grade')
  assert.equal(draftBlocker(goodTankDraft({ shift: '' }), YEAR), 'needs a shift')
  assert.equal(draftBlocker(goodTankDraft({ wt: '' }), YEAR), 'needs a weight')
  assert.equal(draftBlocker(goodTankDraft(), YEAR), null)
})

check('the source-conditional bag rules survive the unlock', () => {
  const flec = goodTankDraft({ src: 'FLEC', mach: 'C2' })
  assert.match(String(draftBlocker(flec, YEAR)), /needs a warehouse/)
  assert.match(String(draftBlocker({ ...flec, whse: 'WHSE 7' }, YEAR)), /needs a bag count/)
  assert.equal(draftBlocker({ ...flec, whse: 'WHSE 7', bags: '38' }, YEAR), null)
  // A tank draw carrying bag fields is refused BY NAME, never silently stripped.
  assert.match(
    String(draftBlocker(goodTankDraft({ bags: '38' }), YEAR)),
    /carries no warehouse, bags or side/,
  )
  assert.match(String(draftBlocker(goodTankDraft({ whse: 'WHSE 7' }), YEAR)), /carries no warehouse/)
  assert.match(String(draftBlocker(goodTankDraft({ side: 'LS' }), YEAR)), /carries no warehouse/)
})

check('a lab value outside the database’s CHECK range is named, not sent', () => {
  assert.equal(parseMetricValue('bd', '').value, null)
  assert.equal(parseMetricValue('bd', '').error, null, 'a blank metric is not an error')
  assert.equal(parseMetricValue('bd', '0.560').value, 0.56)
  // NOT stripped like a weight's thousands comma: every metric tops out at 100, so
  // `2,80` is a decimal comma and stripping it would silently mean 280.
  assert.equal(parseMetricValue('ash', '2,80').value, null)
  assert.match(String(parseMetricValue('ash', '2,80').error), /dot for the decimal point/)
  assert.equal(parseMetricValue('ash', ' 2.80 ').value, 2.8, 'surrounding space is fine')
  assert.match(String(parseMetricValue('bd', '0').error), /between over 0 and 5/)
  assert.match(String(parseMetricValue('bd', '6').error), /between over 0 and 5/)
  assert.match(String(parseMetricValue('mc', '101').error), /between 0 and 100/)
  assert.match(String(parseMetricValue('grit', 'x').error), /plain number/)
  assert.equal(parseMetricValue('mc', '0').value, 0, 'zero is a legal MC')
  // …and the row that carries it is blocked before a round trip.
  assert.match(String(draftBlocker(goodTankDraft({ metrics: { bd: '9', ash: '', grit: '', mc: '' } }), YEAR)), /BD must be/)
})

// ── One reading, one sample group ─────────────────────────────────────────────

check('the derived group key mirrors the RPC’s coalesce', () => {
  // Tank draw: no warehouse, so the group's whse_key IS the derived plant.
  assert.equal(
    draftGroupKey(goodTankDraft(), YEAR),
    sampleGroupKey({ sample_date: '2026-06-27', source_location_code: 'TNK 1', whse_key: 'W6' }),
  )
  // FLEC draw: the warehouse wins over the (absent) plant.
  assert.equal(
    draftGroupKey(goodTankDraft({ src: 'FLEC', whse: 'WHSE 7', bags: '38' }), YEAR),
    sampleGroupKey({ sample_date: '2026-06-27', source_location_code: 'FLEC', whse_key: 'WHSE 7' }),
  )
  // A whitespace-only warehouse must fall THROUGH to the plant, as `nullif` does.
  assert.equal(
    draftGroupKey(goodTankDraft({ whse: '   ' }), YEAR),
    draftGroupKey(goodTankDraft(), YEAR),
  )
  // Case and spacing are canonicalized the same way the database canonicalizes them.
  assert.equal(draftGroupKey(goodTankDraft({ src: 'tnk  1' }), YEAR), draftGroupKey(goodTankDraft(), YEAR))
  // Too blank to place → no key, and therefore no conflict claim.
  assert.equal(draftGroupKey(draft({ src: '' }), YEAR), null)
  assert.equal(draftGroupKey(draft({ recvDate: 'nope', src: 'TNK 1' }), YEAR), null)
})

check('two rows, one group, two different readings = a named refusal', () => {
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft({ metrics: { bd: '0.61', ash: '', grit: '', mc: '' } })
  const conflicts = findDraftReadingConflicts([a, b], YEAR)
  assert.equal(conflicts.length, 1, 'the disagreement must be caught')
  assert.equal(conflicts[0].metric, 'bd')
  assert.deepEqual(conflicts[0].values, ['0.56', '0.61'], 'BOTH numbers are named')
  assert.deepEqual(conflicts[0].rowIds.sort(), [a.id, b.id].sort(), 'BOTH rows are named')
  assert.match(conflicts[0].label, /2026-06-27 · TNK 1 · W6/)
})

check('the same number written differently is NOT a conflict', () => {
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft({ metrics: { bd: '0.560', ash: '', grit: '', mc: '' } })
  assert.deepEqual(findDraftReadingConflicts([a, b], YEAR), [])
})

check('different metrics on two rows of one group MERGE, they do not fight', () => {
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft({ metrics: { bd: '', ash: '', grit: '', mc: '11.6' } })
  assert.deepEqual(findDraftReadingConflicts([a, b], YEAR), [], 'a union is not a disagreement')
})

check('rows in DIFFERENT groups never conflict, however different their readings', () => {
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft({ src: 'W7', metrics: { bd: '4.9', ash: '', grit: '', mc: '' } })
  const c = goodTankDraft({ recvDate: '2026-06-28', metrics: { bd: '4.9', ash: '', grit: '', mc: '' } })
  assert.deepEqual(findDraftReadingConflicts([a, b, c], YEAR), [])
})

check('a row with no reading cannot be dragged into a conflict', () => {
  const a = goodTankDraft({ metrics: { bd: '0.56', ash: '', grit: '', mc: '' } })
  const b = goodTankDraft() // same group, says nothing about the lab
  assert.deepEqual(findDraftReadingConflicts([a, b], YEAR), [])
})

check('a row whose DRAW is already filed is never sent again', () => {
  const filed = goodTankDraft({ drawSaved: true, status: 'failed' })
  assert.equal(isSendableDraft(filed, YEAR), false, 're-sending would file the receipt twice')
  assert.equal(isMeaningfulDraft(filed), true, 'it still counts as typing a Cancel would lose')
  // …and it cannot take part in a conflict, since it is not in the next save.
  const other = goodTankDraft({ metrics: { bd: '0.61', ash: '', grit: '', mc: '' } })
  const conflicted = { ...filed, metrics: { bd: '0.56', ash: '', grit: '', mc: '' } }
  assert.deepEqual(findDraftReadingConflicts([conflicted, other], YEAR), [])
})

// ── The write path applies the reading to the group the RPC reports ───────────

check('the server keys a reading off the RPC’s own sample_group, never a re-derivation', () => {
  const src = stripComments(readFileSync(ACTIONS, 'utf8'))
  assert.match(src, /verdict\.sample_group/, 'the group identity comes from the insert verdict')
  assert.match(src, /sampleGroupKey\(\{[\s\S]*?group\.sample_date/, 'and is keyed, not rebuilt')
  assert.match(src, /reading_conflict/, 'a disagreement has its own outcome')
  assert.match(
    src,
    /expectedRowVersion: groupVersions\[bucket\.key\] \?\? null/,
    'the reading writes against the version the screen was shown — never a blind force-write',
  )
  // The draw must go in BEFORE its reading: a group does not exist until it does.
  const drawAt = src.indexOf('await addPartnerDraw(input)')
  const readingAt = src.indexOf('await writeSampleGroup(supabase, {')
  assert.ok(drawAt > 0 && readingAt > drawAt, 'the draw must be inserted before its reading')
})

check('the server refuses a date it was not handed in yyyy-MM-dd', () => {
  const src = stripComments(readFileSync(ACTIONS, 'utf8'))
  assert.match(src, /isIsoDate\(recvDate\)/, 'the receipt date shape is checked server-side')
  assert.match(src, /isIsoDate\(prodDate\)/, 'so is the production date')
  assert.doesNotMatch(
    src,
    /normalizeTypedDate/,
    'the server must NOT guess a year — only the client knows which month is on screen',
  )
})

// ── Cancelling ────────────────────────────────────────────────────────────────

check('add mode has an always-available way out', () => {
  const ledger = stripComments(readFileSync(LEDGER, 'utf8'))
  assert.match(ledger, /addingDraws \? \(/, 'Cancel renders on addingDraws alone…')
  assert.match(ledger, /Cancel adding/, '…and says so')
  assert.doesNotMatch(
    ledger,
    /totalPending > 0 \? \(\s*<Button/,
    'no exit may be gated on there being pending work — that was the trap',
  )
  assert.doesNotMatch(ledger, /clearBlankDrafts/, 'the third near-synonym control is gone')
  assert.match(ledger, /AlertDialog/, 'losing typed rows is confirmed')
  assert.match(
    ledger,
    /if \(typedDrafts > 0\) setConfirmCancel\(true\);\s*else exitAdding\(\);/,
    'and only when there is typing to lose — ten blanks must just close',
  )
})

check('no animation was added to a row, a cell or a selection', () => {
  for (const file of [ROWS, LEDGER]) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const banned of ['animate-fade-up', 'animate-fade-in', 'animate-scale-in', 'stagger-children', 'hover-lift']) {
      // The one pre-existing exception is the save-failure BANNER, which is chrome.
      const hits = [...src.matchAll(new RegExp(banned, 'g'))].length
      const allowed = banned === 'animate-fade-up' && file === LEDGER ? 1 : 0
      assert.equal(hits, allowed, `${banned} appears ${hits}× in ${file.split('/').pop()}`)
    }
  }
})

check('every metric key the ledger knows is covered above', () => {
  assert.deepEqual([...METRICS], ['bd', 'ash', 'grit', 'mc'])
})


console.log(`\n${passed} assertions passed.`)
