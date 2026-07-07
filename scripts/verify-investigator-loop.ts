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

import type Anthropic from '@anthropic-ai/sdk'

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
import { sanitizeAnthropicHistory } from '../app/(app)/sync/case-history'

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

  // ── sanitizeAnthropicHistory: the tool_use/tool_result pairing repair ─────────
  // This is the heal for the case-chat 400 bug: a stored transcript whose assistant
  // turn carries a tool_use (e.g. terminal submit_verdict) with NO following
  // tool_result must be repaired before the API replays it.
  const asstToolUse = (ids: string[]): Anthropic.MessageParam => ({
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking' },
      ...ids.map((id) => ({ type: 'tool_use' as const, id, name: 'submit_verdict', input: {} })),
    ],
  })
  const userToolResult = (ids: string[]): Anthropic.MessageParam => ({
    role: 'user',
    content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })),
  })
  const plainUser = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })

  // Extract the tool_use / tool_result ids of a message (test-local helpers).
  const toolUseIdsOf = (m: Anthropic.MessageParam): string[] =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((b) => (b as { type?: string }).type === 'tool_use').map((b) => (b as { id: string }).id)
      : []
  const toolResultIdsOf = (m: Anthropic.MessageParam): string[] =>
    m.role === 'user' && Array.isArray(m.content)
      ? m.content
          .filter((b) => typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
          .map((b) => (b as { tool_use_id: string }).tool_use_id)
      : []

  /** Assert every assistant tool_use id is answered by the very next message. */
  function assertWellPaired(msgs: Anthropic.MessageParam[]) {
    for (let i = 0; i < msgs.length; i++) {
      const opened = toolUseIdsOf(msgs[i])
      if (opened.length === 0) continue
      const answered = new Set(toolResultIdsOf(msgs[i + 1]))
      for (const id of opened) {
        assert.ok(answered.has(id), `tool_use ${id} at index ${i} is not answered by the next turn`)
      }
    }
  }

  check('sanitize: dangling tool_use at END of history gets a synthetic result', () => {
    const input: Anthropic.MessageParam[] = [
      plainUser('briefing'),
      asstToolUse(['toolu_END']),
    ]
    const out = sanitizeAnthropicHistory(input)
    assertWellPaired(out)
    // A user tool_result turn was appended answering toolu_END.
    assert.equal(out.length, 3)
    assert.deepEqual(toolResultIdsOf(out[2]), ['toolu_END'])
  })

  check('sanitize: dangling tool_use MID-history gets a result injected BEFORE the next turn', () => {
    const input: Anthropic.MessageParam[] = [
      plainUser('briefing'),
      asstToolUse(['toolu_MID']), // dangling
      plainUser('why do you think that?'), // a plain user turn, NOT a tool_result
    ]
    const out = sanitizeAnthropicHistory(input)
    assertWellPaired(out)
    // The synthetic tool_result turn is inserted at index 2, before the plain user turn.
    assert.deepEqual(toolResultIdsOf(out[2]), ['toolu_MID'])
    assert.equal(out[3].role, 'user')
    assert.equal(out[3].content, 'why do you think that?')
  })

  check('sanitize: fully-paired history passes through byte-identical', () => {
    const input: Anthropic.MessageParam[] = [
      plainUser('briefing'),
      asstToolUse(['toolu_A']),
      userToolResult(['toolu_A']),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    const out = sanitizeAnthropicHistory(input)
    assert.deepEqual(out, input)
  })

  check('sanitize: orphan tool_result (no matching tool_use) is dropped', () => {
    const input: Anthropic.MessageParam[] = [
      plainUser('briefing'),
      // A user turn carrying a tool_result whose id was never opened by the prior turn.
      userToolResult(['toolu_ORPHAN']),
      plainUser('next'),
    ]
    const out = sanitizeAnthropicHistory(input)
    // The orphan-only user turn is dropped entirely (no valid blocks remain).
    assert.equal(out.length, 2)
    assert.equal(out[0].content, 'briefing')
    assert.equal(out[1].content, 'next')
  })

  check('sanitize: multiple tool_use in one turn with PARTIAL results → only missing injected', () => {
    const input: Anthropic.MessageParam[] = [
      plainUser('briefing'),
      asstToolUse(['toolu_1', 'toolu_2', 'toolu_3']),
      userToolResult(['toolu_2']), // only #2 answered
    ]
    const out = sanitizeAnthropicHistory(input)
    assertWellPaired(out)
    // The next user turn now answers all three, with 1 + 3 injected alongside the existing 2.
    const answered = toolResultIdsOf(out[2])
    assert.deepEqual([...answered].sort(), ['toolu_1', 'toolu_2', 'toolu_3'])
  })

  check('sanitize: does NOT mutate the input array', () => {
    const input: Anthropic.MessageParam[] = [plainUser('briefing'), asstToolUse(['toolu_X'])]
    const before = JSON.stringify(input)
    sanitizeAnthropicHistory(input)
    assert.equal(JSON.stringify(input), before)
  })

  console.log(`\n  ✓ ${passed} assertions passed\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
