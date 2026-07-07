/**
 * rules.ts — the `read_rule` tool's file-backed reader for the L-rule ledger.
 *
 * Two static project files hold the sync's institutional knowledge (the L-001…L-033
 * learnings). This reader pulls one rule's:
 *   - DIGEST line  (from RULES_DIGEST.md, under "## Digest")  — the one-line summary
 *   - FULL entry   (from LEARNING_LEDGER.md, under "### L-0XX · …") — the whole story
 *
 * Plain fs reads (the files are static and path-anchored to process.cwd()), with a
 * small in-memory cache so a multi-lookup investigation reads each file once. Never
 * throws — an unknown/malformed rule returns a JSON error string listing nearby ids.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DIGEST_PATH = '.claude/skills/sync-ictc/RULES_DIGEST.md'
const LEDGER_PATH = '.claude/skills/sync-ictc/LEARNING_LEDGER.md'

/** L-0XX rule-id shape (case-insensitive, 3+ digits tolerated). */
export const RULE_ID_RE = /^L-\d{3,}$/i

interface FileCache {
  digest?: string
  ledger?: string
}
const cache: FileCache = {}

async function readCached(which: 'digest' | 'ledger'): Promise<string> {
  if (cache[which] != null) return cache[which] as string
  const rel = which === 'digest' ? DIGEST_PATH : LEDGER_PATH
  const abs = path.join(process.cwd(), rel)
  const text = await readFile(abs, 'utf8')
  cache[which] = text
  return text
}

/** Reset the in-memory cache (test-only helper). */
export function _clearRuleCache(): void {
  delete cache.digest
  delete cache.ledger
}

/** Normalize "l-7" / "L-007" → "L-007" (zero-padded to 3). Returns null if unparseable. */
export function normalizeRuleId(raw: string): string | null {
  const m = /^L-(\d{1,})$/i.exec(raw.trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  return `L-${String(n).padStart(3, '0')}`
}

/**
 * PURE: extract the digest line for `ruleId` from RULES_DIGEST.md's text. The digest
 * lists one bullet per rule as `- **L-0XX**  [scope]  <rule> — *symptom: …*`. Match
 * the bullet whose bold id equals ruleId. Returns the trimmed line or null.
 */
export function extractDigestLine(digestText: string, ruleId: string): string | null {
  const lines = digestText.split('\n')
  const idRe = new RegExp(`^\\s*-\\s*\\*\\*${ruleId}\\*\\*`, 'i')
  for (const l of lines) {
    if (idRe.test(l)) return l.trim()
  }
  return null
}

/**
 * PURE: slice the FULL ledger entry for `ruleId` from LEARNING_LEDGER.md's text. Each
 * entry starts at `### L-0XX · YYYY-MM-DD · <scope> · <title>` and runs until the next
 * `### ` or `## ` heading (or EOF). Returns the sliced block (heading + body) or null.
 *
 * NOTE the ledger can carry TWO entries with the same id (a later correction appended
 * under the same L-### — e.g. the two L-010 entries). We return ALL matching blocks
 * concatenated so the model sees the full history, newest-first as the file orders them.
 */
export function extractLedgerEntry(ledgerText: string, ruleId: string): string | null {
  const lines = ledgerText.split('\n')
  const headingRe = new RegExp(`^###\\s+${ruleId}\\s*·`, 'i')
  const anyBoundaryRe = /^(#{2,3})\s/
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue
    const start = i
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (anyBoundaryRe.test(lines[j])) {
        end = j
        break
      }
    }
    blocks.push(lines.slice(start, end).join('\n').trimEnd())
    i = end - 1 // continue scanning after this block (catches a second same-id entry)
  }
  if (blocks.length === 0) return null
  return blocks.join('\n\n')
}

/** PURE: gather all valid rule ids present in the digest, sorted, for "nearby ids" errors. */
export function listDigestRuleIds(digestText: string): string[] {
  const ids = new Set<string>()
  const re = /^\s*-\s*\*\*(L-\d{3,})\*\*/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(digestText)) !== null) {
    ids.add(m[1].toUpperCase())
  }
  return [...ids].sort()
}

/**
 * The `read_rule` executor. `full=false` → the digest line; `full=true` → the full
 * ledger entry. Returns a JSON STRING (never throws): success or an error object with
 * nearby valid ids.
 */
export async function readRule(rawId: string, full: boolean): Promise<string> {
  const ruleId = normalizeRuleId(rawId)
  if (!ruleId) {
    return JSON.stringify({ error: `Invalid rule id "${rawId}". Expected the form L-0XX (e.g. L-007).` })
  }
  try {
    if (full) {
      const ledger = await readCached('ledger')
      const entry = extractLedgerEntry(ledger, ruleId)
      if (entry == null) {
        const digest = await readCached('digest').catch(() => '')
        return JSON.stringify({
          error: `No full ledger entry found for ${ruleId}.`,
          nearby_rule_ids: listDigestRuleIds(digest),
        })
      }
      return JSON.stringify({ rule_id: ruleId, full: true, entry })
    }
    const digest = await readCached('digest')
    const line = extractDigestLine(digest, ruleId)
    if (line == null) {
      return JSON.stringify({
        error: `No digest line found for ${ruleId}.`,
        nearby_rule_ids: listDigestRuleIds(digest),
      })
    }
    return JSON.stringify({ rule_id: ruleId, full: false, digest: line })
  } catch (e) {
    return JSON.stringify({ error: `Could not read the rules files: ${e instanceof Error ? e.message : String(e)}` })
  }
}
