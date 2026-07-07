/**
 * verify-investigator-loop.ts — framework-free proof of the investigator loop's PURE
 * pieces + the playbook prompt layer (P3), WITHOUT the Anthropic API or a real DB.
 *
 * It asserts:
 *   - the diagnostic playbook contains each per-kind investigative recipe keyword,
 *   - the banned-jargon words never appear in the playbook's own example/instruction text
 *     that the model is told to imitate (the register discipline),
 *   - buildCaseBriefing renders drift_dates AND the known-ruling note,
 *   - parseVerdict accepts a good verdict and rejects malformed ones (wrong enum, empty
 *     summary, non-array citations, missing fields),
 *   - the out-of-budget synthesized verdict has the needs-human / low-confidence shape,
 *   - nextPosition + the message-row builders produce the right shapes/positions.
 *
 * Run:  npx tsx scripts/verify-investigator-loop.ts
 */
import assert from 'node:assert/strict'

import {
  buildInvestigatorSystem,
  buildCaseBriefing,
  BANNED_JARGON,
} from '../lib/investigator/playbook'
import {
  parseVerdict,
  synthesizeUnconvergedVerdict,
  nextPosition,
  buildSystemRow,
  buildUserRow,
  buildAssistantRow,
  buildToolRow,
  SUBMIT_VERDICT_TOOL,
  MAX_ITERATIONS,
  MAX_TOOL_CALLS,
} from '../lib/investigator/loop'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

async function main() {
  console.log('\nverify-investigator-loop\n')

  const system = buildInvestigatorSystem()

  // ── Per-kind recipe keywords present in the playbook ────────────────────────
  check('playbook covers the O>M (db > movement) recipe: check_duplicates first', () => {
    assert.match(system, /check_duplicates/)
    assert.match(system, /database is correct|database looks correct|database is\b/i)
    assert.match(system, /movement sheet.*MISSING|MISSING feedings/i)
  })

  check('playbook covers the daily-report vs movement-sheet drift recipe', () => {
    assert.match(system, /daily report vs movement sheet|DAILY REPORT vs MOVEMENT SHEET/i)
    assert.match(system, /read_run_source/)
    assert.match(system, /outlier/i)
  })

  check('playbook covers the unknown-batch-code recipe (find_batches + month prefix)', () => {
    assert.match(system, /find_batches/)
    assert.match(system, /MARCH|SEPT/) // the month-prefix inconsistency examples
    assert.match(system, /never.*invent|inventing a batch/i)
  })

  check('playbook covers the suspected-duplicate / already-saved recipe', () => {
    assert.match(system, /SUSPECTED DUPLICATE|already-saved|already saved/i)
    assert.match(system, /date window|query_table/i)
  })

  check('playbook covers the fallback (row facts + read_rule)', () => {
    assert.match(system, /read_rule/)
  })

  check('playbook states the read-only / never-write boundary', () => {
    assert.match(system, /CANNOT write|read-only|READ-ONLY/i)
    assert.match(system, /never.*delete|CANNOT.*delete/i)
  })

  check('playbook mandates citing every number', () => {
    assert.match(system, /cit(e|ation)/i)
    assert.match(system, /NEVER state a number you did not|every number/i)
  })

  // ── Banned jargon absent from the imitation/example text ────────────────────
  // The playbook DECLARES the ban (so the banned words appear once, inside the ban
  // sentence). We assert each banned phrase appears ONLY in that ban declaration —
  // i.e. it never leaks into the recipe/example register the model imitates. We do
  // this by checking the ban line lists them, and that no banned word appears in the
  // "HOW TO WRITE" example phrases block after the ban.
  check('every banned-jargon word is declared in the ban list', () => {
    // The ban sentence enumerates them; each must be present in the prompt at least once.
    for (const word of BANNED_JARGON) {
      assert.ok(
        system.toLowerCase().includes(word.toLowerCase()),
        `ban list should enumerate "${word}"`,
      )
    }
  })

  check('banned jargon does not appear in the plain-language example phrases', () => {
    // Isolate the example phrases the model is told to imitate (quoted "…" snippets)
    // and assert none of them contain a banned word. This mirrors verify-adjudication's
    // register check without over-constraining the ban DECLARATION itself.
    const quoted = [...system.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())
    assert.ok(quoted.length > 0, 'playbook should contain quoted example phrases')
    for (const phrase of quoted) {
      for (const word of BANNED_JARGON) {
        // "gate" is a substring risk (e.g. "investigate") — match whole word.
        const re = new RegExp(`\\b${word.toLowerCase().replace(/ /g, '\\s+')}\\b`)
        assert.ok(
          !re.test(phrase),
          `example phrase "${phrase}" must not use banned jargon "${word}"`,
        )
      }
    }
  })

  // ── buildCaseBriefing renders drift_dates + known-ruling note ───────────────
  check('buildCaseBriefing renders drift_dates with dates + kg', () => {
    const brief = buildCaseBriefing({
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: 'rc_out gate: 1 day off',
      reason: 'daily totals did not add up',
      row: {
        drift_dates: [
          { date: '2026-06-10', db_sum_kg: 71144, movement_kg: 57401, excess_kg: 13743 },
        ],
      },
      occurrence_count: 3,
    })
    assert.match(brief, /2026-06-10/)
    assert.match(brief, /71,144/)
    assert.match(brief, /57,401/)
    assert.match(brief, /13,743/)
    assert.match(brief, /raised 3 times/i)
    assert.match(brief, /submit_verdict/)
  })

  check('buildCaseBriefing renders the known-ruling note when present', () => {
    const brief = buildCaseBriefing({
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: 'k',
      known_ruling_id: 'abc-123',
      known_ruling_summary: 'Movement sheet missing entries; database correct. Dismissed.',
    })
    assert.match(brief, /KNOWN ISSUE/i)
    assert.match(brief, /Movement sheet missing entries/)
    assert.match(brief, /if the numbers have changed/i)
  })

  check('buildCaseBriefing tolerates a row with no drift_dates', () => {
    const brief = buildCaseBriefing({
      report_type: 'deliveries',
      kind: 'unmapped_batch_code',
      natural_key: 'JULY-26-BLK9',
      row: { batch_code: 'JULY-26-BLK9', weight_kg: 5820 },
    })
    assert.match(brief, /JULY-26-BLK9/)
    assert.doesNotMatch(brief, /Day-by-day numbers/)
  })

  // ── parseVerdict: accept good, reject bad ───────────────────────────────────
  const goodVerdict = {
    verdict: 'skip',
    confidence: 'high',
    summary: 'June 10 — the movement sheet is short 13,743 kg; the database is correct. Dismiss it.',
    explanation: 'The five feedings on June 10 total 71,144 kg and none are duplicated.',
    citations: [
      { claim: '5 feedings total 71,144 kg', source: 'query_table rc_out on 2026-06-10' },
      { claim: 'no duplicate rows', source: 'check_duplicates rc_out 2026-06-10' },
    ],
  }

  check('parseVerdict accepts a well-formed verdict', () => {
    const parsed = parseVerdict(goodVerdict)
    assert.ok(parsed)
    assert.equal(parsed.verdict, 'skip')
    assert.equal(parsed.confidence, 'high')
    assert.equal(parsed.citations.length, 2)
  })

  check('parseVerdict accepts an empty citations array', () => {
    const parsed = parseVerdict({ ...goodVerdict, citations: [] })
    assert.ok(parsed)
    assert.equal(parsed.citations.length, 0)
  })

  check('parseVerdict rejects an unknown verdict enum', () => {
    assert.equal(parseVerdict({ ...goodVerdict, verdict: 'maybe' }), null)
  })

  check('parseVerdict rejects an unknown confidence enum', () => {
    assert.equal(parseVerdict({ ...goodVerdict, confidence: 'very-high' }), null)
  })

  check('parseVerdict rejects an empty summary', () => {
    assert.equal(parseVerdict({ ...goodVerdict, summary: '   ' }), null)
  })

  check('parseVerdict rejects a missing explanation', () => {
    const { explanation, ...rest } = goodVerdict
    void explanation
    assert.equal(parseVerdict(rest), null)
  })

  check('parseVerdict rejects non-array citations', () => {
    assert.equal(parseVerdict({ ...goodVerdict, citations: 'nope' }), null)
  })

  check('parseVerdict rejects a citation missing source', () => {
    assert.equal(
      parseVerdict({ ...goodVerdict, citations: [{ claim: 'x' }] }),
      null,
    )
  })

  check('parseVerdict rejects null / non-object input', () => {
    assert.equal(parseVerdict(null), null)
    assert.equal(parseVerdict('a string'), null)
  })

  // ── synthesized out-of-budget verdict ───────────────────────────────────────
  check('synthesizeUnconvergedVerdict is needs-human / low confidence', () => {
    const v = synthesizeUnconvergedVerdict()
    assert.equal(v.verdict, 'needs-human')
    assert.equal(v.confidence, 'low')
    assert.match(v.summary, /did not converge/i)
    assert.deepEqual(v.citations, [])
    // It must itself pass parseVerdict (round-trip safety).
    assert.ok(parseVerdict(v))
  })

  // ── position math + message-row builders ────────────────────────────────────
  check('nextPosition increments from null → 0, from N → N+1', () => {
    assert.equal(nextPosition(null), 0)
    assert.equal(nextPosition(0), 1)
    assert.equal(nextPosition(7), 8)
  })

  check('buildSystemRow / buildUserRow shapes', () => {
    const sys = buildSystemRow('c1', 'Investigation started', 0)
    assert.equal(sys.role, 'system')
    assert.equal(sys.content, 'Investigation started')
    assert.equal(sys.position, 0)
    assert.equal(sys.tool_calls, null)

    const user = buildUserRow('c1', 'briefing text', 1)
    assert.equal(user.role, 'user')
    assert.equal(user.position, 1)
  })

  check('buildAssistantRow carries tool_calls (or null when none)', () => {
    const withCalls = buildAssistantRow(
      'c1',
      'let me check',
      [{ id: 't1', name: 'query_table', input: { table: 'rc_out' } }],
      2,
    )
    assert.equal(withCalls.role, 'assistant')
    assert.ok(Array.isArray(withCalls.tool_calls))
    const noCalls = buildAssistantRow('c1', 'done', [], 3)
    assert.equal(noCalls.tool_calls, null)
  })

  check('buildToolRow carries tool_results (or null when none)', () => {
    const withResults = buildToolRow('c1', [{ tool_use_id: 't1', content: '{"count":5}' }], 4)
    assert.equal(withResults.role, 'tool')
    assert.equal(withResults.content, '')
    assert.ok(Array.isArray(withResults.tool_results))
    const noResults = buildToolRow('c1', [], 5)
    assert.equal(noResults.tool_results, null)
  })

  // ── submit_verdict tool definition sanity ───────────────────────────────────
  check('SUBMIT_VERDICT_TOOL schema requires the five verdict fields', () => {
    assert.equal(SUBMIT_VERDICT_TOOL.name, 'submit_verdict')
    const schema = SUBMIT_VERDICT_TOOL.input_schema as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      ['citations', 'confidence', 'explanation', 'summary', 'verdict'],
    )
  })

  check('budget constants match spec (8 iterations, 16 tool calls)', () => {
    assert.equal(MAX_ITERATIONS, 8)
    assert.equal(MAX_TOOL_CALLS, 16)
  })

  console.log(`\n  ✓ ${passed} assertions passed\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
