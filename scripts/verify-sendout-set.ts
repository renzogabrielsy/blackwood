/**
 * verify-sendout-set.ts — framework-free assertions over the PURE customer
 * send-out-set selection (lib/shipments/requirements.ts::planSendOutSet +
 * sendOutZipBaseName), the logic behind `GET /shipments/[cardId]/download?set=sendout`.
 * No Trello, no network — the fixtures below are the REAL attachment-name lists
 * pulled from the ICTC export board on 2026-08-13, frozen here.
 *
 * Why this file exists: the set is defined by `docType()`, which is a faithful port
 * of the Python CLI and is deliberately NOT to be "fixed". So the guard cannot be
 * "docType is correct" — it has to be "the split is what we measured", pinned to
 * real filenames. A change to classify.ts that silently moves a customer doc out of
 * the send-out set (or an internal doc into it) breaks this script.
 *
 * Run: npx tsx scripts/verify-sendout-set.ts
 */
import assert from 'node:assert'

import { derivePrefix } from '@/lib/shipments/classify'
import { planSendOutSet, sendOutZipBaseName } from '@/lib/shipments/requirements'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

interface Att {
  name: string
  bytes: number | null
}
const file = (name: string): Att => ({ name, bytes: 1 })
const link = (name: string): Att => ({ name, bytes: null })

const plan = (title: string, atts: Att[]) =>
  planSendOutSet(
    title,
    atts,
    (a) => a.name,
    (a) => a.bytes != null
  )

// ── Fixture: the card in Renzo's request. 14 attachments, MAEHATA, 7/7. ──────
const CARD_260804_TITLE = '260804 MH 4X8 2 VANS'
const CARD_260804: Att[] = [
  file('MSMU 563567 5 FX45493588.pdf'),
  file('MSNU 799547 9 FX45493584.pdf'),
  file('PCA ICTC.PDF'),
  file('PACKING LIST 0145.pdf'),
  file('COMMERCIAL INVOICE  0145.pdf'),
  file('LETTER OF COMMITMENT AND UNDERTAKING.pdf'),
  file('ED - 31816.pdf'),
  file('260804 FINAL 4x8 CoA.pdf'),
  file('MATES RECEIPT OF CARGO.pdf'),
  file('AUTHORITY TO LOAD.pdf'),
  file('FUMIGATION .pdf'),
  file('MEDUPH667453_C.PDF'),
  file('CERTIFICATE OF ORIGIN OSAKA.pdf'),
  file('RECORD OF WEIGHT.pdf'),
]

console.log('\nplanSendOutSet — 260804 MH 4X8 2 VANS (the real 14-attachment card)')

check('resolves MAEHATA and reports a complete 7-of-7 set', () => {
  const p = plan(CARD_260804_TITLE, CARD_260804)
  assert.equal(p.readiness.customer, 'MAEHATA')
  assert.equal(p.readiness.hasRequirementSet, true)
  assert.equal(p.totalCount, 7)
  assert.equal(p.presentCount, 7)
  assert.equal(p.complete, true)
  assert.deepEqual(p.absent, [])
})

check('selects exactly the 7 customer docs', () => {
  const p = plan(CARD_260804_TITLE, CARD_260804)
  assert.deepEqual(
    p.selected.map((s) => s.item.name).sort(),
    [
      '260804 FINAL 4x8 CoA.pdf',
      'CERTIFICATE OF ORIGIN OSAKA.pdf',
      'COMMERCIAL INVOICE  0145.pdf',
      'FUMIGATION .pdf',
      'MEDUPH667453_C.PDF',
      'PACKING LIST 0145.pdf',
      'RECORD OF WEIGHT.pdf',
    ]
  )
})

check('excludes exactly the 7 internal/process docs', () => {
  const p = plan(CARD_260804_TITLE, CARD_260804)
  assert.deepEqual(
    p.excluded.map((e) => e.item.name).sort(),
    [
      'AUTHORITY TO LOAD.pdf',
      'ED - 31816.pdf',
      'LETTER OF COMMITMENT AND UNDERTAKING.pdf',
      'MATES RECEIPT OF CARGO.pdf',
      'MSMU 563567 5 FX45493588.pdf',
      'MSNU 799547 9 FX45493584.pdf',
      'PCA ICTC.PDF',
    ]
  )
  // Nothing was left out for lack of a downloadable file.
  assert.equal(
    p.excluded.every((e) => e.reason === 'not-in-set'),
    true
  )
})

check('every required doc type is covered by exactly one selected file', () => {
  const p = plan(CARD_260804_TITLE, CARD_260804)
  const byType = new Map<string, number>()
  for (const s of p.selected) byType.set(s.docType, (byType.get(s.docType) ?? 0) + 1)
  assert.deepEqual([...byType.keys()].sort(), [...p.readiness.required].sort())
  assert.equal([...byType.values()].every((n) => n === 1), true)
})

// ── Two files, one doc type: BOTH ship. Real case, the 260212 card, which carries
// `Non-Nego BL.pdf` and `Original BL.pdf` DUPLICATED (4 BL files in total). ──
console.log('\nplanSendOutSet — duplicate doc types (real 260212 card)')

const CARD_260212_TITLE = '260212 SHIPMENT - MH 8X50 1 VAN'
const CARD_260212: Att[] = [
  file('260213 Booking Confirmation - EBKG15726967.pdf'),
  file('260213 Final 8x50 CoA Feb 2026 1Q.pdf'),
  file('260213 COMMERCIAL INVOICE.pdf'),
  file('260213 PACKING LIST.pdf'),
  file('260213 MAPECON FEBRUARY 2026.pdf'),
  file('260213 CERTIFICATE OF THE  AVERAGE WEIGHT OF THE FLECON BAGS AND PALLETS.pdf'),
  file('260213 RECORD OF WEIGHT.pdf'),
  file('260213 SAMPLES COMMERCIAL INVOICE AND PACKING LIST FEB 2026 8x50 SHIPMENT 2.pdf'),
  file('Non-Nego BL.pdf'),
  file('Original BL.pdf'),
  file('Non-Nego BL.pdf'),
  file('Original BL.pdf'),
]

check('all 4 BL files and both Record-of-Weight files are included, none dropped', () => {
  const p = plan(CARD_260212_TITLE, CARD_260212)
  const bl = p.selected.filter((s) => s.docType === 'BL / Non-Nego')
  assert.equal(bl.length, 4)
  const row = p.selected.filter((s) => s.docType === 'Record of Weight')
  assert.equal(row.length, 2)
  // 4 BL + 2 RoW + CI + PL + Fumigation + CoA = 10 files for a 6-of-7 set.
  assert.equal(p.selected.length, 10)
  assert.equal(p.presentCount, 6)
  assert.equal(p.complete, false)
  assert.deepEqual(p.absent, ['Certificate of Origin'])
})

check('the proforma SAMPLES doc never counts as the Commercial Invoice / Packing List', () => {
  const p = plan(CARD_260212_TITLE, CARD_260212)
  assert.equal(
    p.selected.some((s) => s.item.name.includes('SAMPLES')),
    false
  )
  assert.equal(
    p.excluded.some((e) => e.item.name.includes('SAMPLES') && e.docType === 'Samples (proforma)'),
    true
  )
})

// ── Incomplete set: still assembles, and says so. Real MAY 13 card (3 BL files). ──
console.log('\nplanSendOutSet — incomplete set (real MAY 13 card)')

const CARD_MAY13_TITLE = 'MAY 13 - MH 8X50 1 VAN'
const CARD_MAY13: Att[] = [
  file('MEDUPH491060-REVISED.pdf'),
  file('MEDUPH491060-REVISED V2.pdf'),
  file('MEDUPH491060 TELEX RELEASE.pdf'),
]

check('a 1-of-7 card still produces a downloadable set', () => {
  const p = plan(CARD_MAY13_TITLE, CARD_MAY13)
  assert.equal(p.selected.length, 3)
  assert.equal(p.presentCount, 1)
  assert.equal(p.totalCount, 7)
  assert.equal(p.complete, false)
  assert.deepEqual(p.absent, [
    'Certificate of Origin',
    'Commercial Invoice',
    'Packing List',
    'Fumigation',
    'CoA',
    'Record of Weight',
  ])
})

// ── The link-attachment hole: present for readiness, unshippable in a ZIP. ──
console.log('\nplanSendOutSet — a required doc attached as a LINK, not a file')

check('a link-only required doc is reported ABSENT even though readiness counts it present', () => {
  const p = plan('260804 MH 4X8 2 VANS', [
    ...CARD_260804.filter((a) => a.name !== 'CERTIFICATE OF ORIGIN OSAKA.pdf'),
    link('CERTIFICATE OF ORIGIN OSAKA.pdf'),
  ])
  // The card's own chip still reads 7/7 — the doc IS attached.
  assert.deepEqual(p.readiness.missing, [])
  assert.equal(p.readiness.complete, true)
  // But nothing shippable covers it, so the ZIP must not claim to be complete.
  assert.deepEqual(p.absent, ['Certificate of Origin'])
  assert.equal(p.presentCount, 6)
  assert.equal(p.complete, false)
  assert.equal(
    p.excluded.some((e) => e.reason === 'not-a-file' && e.docType === 'Certificate of Origin'),
    true
  )
})

// ── No resolvable customer / no requirement set: refuse, never an empty ZIP. ──
console.log('\nplanSendOutSet — no requirement set')

check('an unresolvable customer yields no set and selects nothing', () => {
  const p = plan('260901 SHIPMENT - SOMECO 2X40', [file('COMMERCIAL INVOICE.pdf'), file('PACKING LIST.pdf')])
  assert.equal(p.readiness.customer, null)
  assert.equal(p.readiness.hasRequirementSet, false)
  assert.equal(p.selected.length, 0)
  assert.equal(p.totalCount, 0)
  assert.equal(p.complete, false)
  // Every attachment is accounted for — nothing vanishes.
  assert.equal(p.excluded.length, 2)
})

check('an empty card with a known customer has nothing to download', () => {
  const p = plan(CARD_260804_TITLE, [])
  assert.equal(p.readiness.hasRequirementSet, true)
  assert.equal(p.selected.length, 0)
  assert.equal(p.absent.length, 7)
})

// ── Filenames: the set must never be mistaken for the all-attachments ZIP. ──
console.log('\nsendOutZipBaseName')

check('a complete set names the shipment number and the customer', () => {
  assert.equal(
    sendOutZipBaseName(CARD_260804_TITLE, derivePrefix(CARD_260804_TITLE), 'MAEHATA', 7, 7),
    '260804 MAEHATA SEND-OUT SET'
  )
})

check('a partial set says PARTIAL in the filename', () => {
  assert.equal(
    sendOutZipBaseName(CARD_260212_TITLE, derivePrefix(CARD_260212_TITLE), 'MAEHATA', 6, 7),
    '260212 MAEHATA SEND-OUT SET (PARTIAL 6 of 7)'
  )
})

check('a legacy title with no derivable YYMMDD leads with the card title, not a fake date', () => {
  assert.equal(derivePrefix(CARD_MAY13_TITLE), null)
  assert.equal(
    sendOutZipBaseName(CARD_MAY13_TITLE, derivePrefix(CARD_MAY13_TITLE), 'MAEHATA', 1, 7),
    'MAY 13 - MH 8X50 1 VAN MAEHATA SEND-OUT SET (PARTIAL 1 of 7)'
  )
})

check('the set filename is never equal to the all-attachments filename', () => {
  for (const [title, present, total] of [
    [CARD_260804_TITLE, 7, 7],
    [CARD_MAY13_TITLE, 1, 7],
  ] as const) {
    assert.notEqual(sendOutZipBaseName(title, derivePrefix(title), 'MAEHATA', present, total), title)
  }
})

console.log(`\n${passed} checks passed.\n`)
