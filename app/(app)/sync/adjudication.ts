/**
 * adjudication.ts — the PURE, server-import-free core of held-row adjudication.
 *
 * This is deliberately split out of actions.ts (`'use server'`) so it can be unit
 * tested with a MOCKED admin client and MOCKED anthropic — no Next server context,
 * no real DB. actions.ts::adjudicateHeldRows imports these three exports and wires
 * them to the real createAdminClient() + anthropic + auth guard.
 *
 * PRICE-GATING INVARIANT (enforced by test): no lookup here EVER selects a ₱/cost
 * column (cost_basis, avg_cost, any *_price). Held rows are write decisions, not
 * cost views. The lookups stay small + bounded (explicit .limit()).
 */
import type { HeldKind, HeldRow, SyncReportType } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// A minimal structural type for the Supabase PostgREST query builder we use — just
// the chained methods the lookups call. Lets the test hand in a spy without
// depending on the full SupabaseClient type.
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryResult {
  data: Array<Record<string, unknown>> | null
  error: { message: string } | null
}

export interface FilterBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): FilterBuilder
  ilike(column: string, pattern: string): FilterBuilder
  limit(n: number): FilterBuilder
}

export interface AdminLike {
  from(table: string): { select(columns: string): FilterBuilder }
}

// ─────────────────────────────────────────────────────────────────────────────
// The adjudicator system prompt — ADVISORY (v1 does not auto-apply).
// ─────────────────────────────────────────────────────────────────────────────

export const ADJUDICATOR_SYSTEM = `You are the Blackwood daily-sync ADVISOR. You help Renzo, who runs the
charcoal plant. He is NOT an engineer. Write the way you would explain it to him standing on
the plant floor.

Each row below was set aside during the daily sync because it needs a human eye. For each row
you get: a plain label, the row's key facts, a short plain-English note about WHY it was set
aside, and — when we could check — what the database already has. Use those facts. Never guess.

You are giving ADVICE ONLY. Nothing you say is done automatically; Renzo (or the sync employee)
still does the actual saving. Give exactly one verdict per row:

- "apply"        — safe to save; the record is genuinely missing and should go in.
- "skip"         — do NOT save; it already looks saved, or it's a source mistake to fix first.
- "needs-human"  — genuinely unclear even with the evidence; Renzo must decide.

Rules you must never break:
- Never say "apply" for an unknown batch code (a batch would have to be invented) or for a slot
  that already has an active batch in it.
- Never say "apply" when the system stopped and saved nothing for the whole report because the
  numbers didn't add up — those days have to be checked by a person first.
- For a possible-duplicate feeding: say "skip" if the database already has an identical record;
  say "apply" only if there is NO matching record (a genuine late entry); otherwise "needs-human".
- If the evidence is missing or contradicts itself, say "needs-human".

- When the database total for a day is HIGHER than the movement sheet: the verdict is almost
  always "skip" (nothing gets saved either way — the day is only being flagged). But your REASON
  must reflect what the evidence actually found, and you must NEVER blanket-say "suspected
  duplication". Read the day-by-day finding:
  - If the evidence says duplicate feedings were found in the database (a feeding appears 2+
    times), say the database has double-entered rows to investigate/remove — that is the cause
    of the overage.
  - If the evidence says NO duplicate rows exist, say the movement sheet is most likely MISSING
    feedings and the database looks correct — check the movement sheet, not the database.

HOW TO WRITE THE REASON — this matters most:
- Use plain plant language. Do NOT use these words: gate, gate failure, upstream, DB SUM,
  settled date, HALT, watermark, envelope, natural key, idempotent. Instead say things like
  "the system stopped and saved nothing for this report", "the numbers don't match",
  "already saved", "check June 10".
- NAME THE SPECIFICS. Use the exact dates, the exact two numbers and their difference, or the
  exact existing record. Never write "some dates" or "a few days" — say "June 10 and June 12".
- END WITH A CONCRETE NEXT STEP — what to physically go check, e.g. "Check June 10's feeding
  records — the daily report and the movement sheet disagree by 13,743 kg."

Good examples of the register and specificity to match:
- "Nothing was saved for RC OUT. Two days don't add up: June 10 — the daily report shows
  71,144 kg fed but the movement sheet shows 57,401 kg (13,743 kg more than the sheet).
  June 12 — the movement sheet has no entry at all. Check those two days' feeding records,
  then run RC OUT again."
- "This June 30 feeding of 5,820 kg (JUNE-26-FEED5 → MAIN) already looks saved — there's an
  identical record in the system. Almost certainly a repeat. Skip it unless you know June 30
  really had two separate 5,820 kg feedings."
- "The batch code 'JULY-26-BLK9' isn't in the system yet. Closest existing ones are
  JULY-26-BLK7 and JULY-26-BLK8. Confirm which batch this belongs to (or add it) before it
  can be saved."

Respond with ONLY a JSON array, no prose, no code fence:
[{"natural_key":"<key>","verdict":"apply"|"skip"|"needs-human","reason":"<plain, specific sentences ending in a concrete next step>"}]
Include exactly one object per held row, echoing its natural_key verbatim.`

/**
 * A SHORT plain-English meaning per held-kind, drawn from LEARNING_LEDGER.md /
 * RULES_DIGEST.md, so the model understands WHAT the hold means and what the call
 * hinges on. Kept terse — one or two sentences.
 */
export const KIND_MEANING: Record<HeldKind, string> = {
  sub_watermark_suspected_dup:
    'A feeding dated on or before the last day we already recorded, with no matching record found. These are usually re-entries of feedings that are already saved; the call hinges on whether the system already has this exact feeding. This is especially common at the end of a month: when a kiln run crosses into the next month the day sheet is titled with the new month ("STARTING OF JULY FEEDING"), so the same feeding can carry either month as its run label — if the day, weight, block, and batch all match a saved row and only the month label differs, it is already saved and needs no action.',
  cross_batch_reassignment:
    'The same truckload (same day, truck, and weight) is already saved under a DIFFERENT batch or location. Usually a month-boundary name change or a location correction, not a new delivery — this needs a person to correct the one existing record, never a second copy.',
  unmapped_batch_code:
    'The batch code on this row is not in the system. Never invent a batch — the code is probably a slightly different spelling of an existing batch, or the batch genuinely needs to be added by a person first.',
  unmapped_bag_type_code:
    'A bag-type code with no match in the system. Never invent a bag type — it probably matches an existing one or needs to be added.',
  location_occupied:
    'This slot already has an active batch in it. One slot holds one active batch — the old batch has to be closed or the location fixed before this can be saved.',
  batch_location_conflict:
    'A NEW batch was going to be created in a block that another batch is still marked active in, so nothing was created and this row was not saved. One block holds one active batch. This is normally the yard finishing a pile and reusing the block the same day — the fix is to close the batch that still holds the block (or correct the block on this row), never to force a second batch into it. The held row already names both batches, what is still left in the block, and when it was last fed.',
  malformed: 'A required field is missing or unreadable — usually a mistake in the source sheet to fix first.',
  low_confidence: 'The reader was not confident about this new row — read the row and decide.',
  already_exists: 'This exact record is already saved (nothing changed). Almost always safe to skip unless a value genuinely changed.',
  gate_failure:
    'The daily totals did not add up, so the system stopped and saved NOTHING for this whole report. The specific days and the two disagreeing numbers are in the evidence — tell Renzo exactly which days to check, and that nothing was saved.',
  unmapped_or_missing_columns: 'A bag-type COLUMN could not be matched to a known bag type — it has to be added or acknowledged before its movements can be saved.',
  below_since_floor: 'A day older than the current sync window — deliberately left alone to protect already-saved history. Usually safe to skip.',
  unresolved_shift: 'A production row (run/downtime/waste) whose shift could not be matched — usually a start/end-of-batch ambiguity that needs a person.',
  unresolved_batch_id: 'A new feeding whose batch code is not in the system. Same as an unknown batch code.',
  flagged: 'This row was set aside for review without a finer reason — read the detail and the row.',
  other: 'Set aside for an unknown reason — read the detail and the row.',
}

/** Round-to-2dp numeric compare for near-match weight lookups. */
function nearWeight(w: unknown): number | null {
  const n = typeof w === 'number' ? w : w == null ? NaN : Number(w)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/**
 * One drifted date threaded onto a gate_failure held row's `row.drift_dates` by the
 * worker (rc_out index.ts / rc_movement_audit index.ts). Pure kg totals — NO ₱/cost.
 * Two flavors:
 *   - daily-report vs movement-sheet drift → {proposed_kg, movement_kg, diff_kg[, note]}
 *   - DB-vs-movement duplication (O>M)     → {db_sum_kg, movement_kg, excess_kg}
 */
export interface GateDriftDate {
  date: string
  proposed_kg?: number | null
  movement_kg?: number | null
  diff_kg?: number | null
  db_sum_kg?: number | null
  excess_kg?: number | null
  note?: string
}

/** "June 10" from "2026-06-10" (plain, no year clutter). Falls back to the raw string. */
function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const mi = parseInt(m[2], 10) - 1
  const day = parseInt(m[3], 10)
  if (mi < 0 || mi > 11) return iso
  return `${months[mi]} ${day}`
}

/** Thousands-separated integer kg (e.g. 71144 → "71,144"). Blank for null. */
function fmtKg(v: unknown): string {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v)
  if (!Number.isFinite(n)) return ''
  const rounded = Math.round(n)
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** True iff this drift date is the O>M "duplication" flavor (db_sum/excess present). */
function isDuplicationDrift(d: GateDriftDate): boolean {
  return d.db_sum_kg != null || d.excess_kg != null
}

/**
 * O>M SELF-DIAGNOSIS. For a `db_vs_movement_duplication` drift date, read `rc_out`
 * for that day and decide WHICH of two things caused the overage:
 *   - EXACT-DUPLICATE rows in the DB (same date+batch+destination+weight ≥2×) →
 *     the DB really is double-entered → lean DB-issue (investigate/remove extras).
 *   - NO duplicate rows, just M distinct feedings → the movement SHEET is short →
 *     lean movement-sheet-gap (the DB looks correct; skip is safe).
 *
 * This is the June-10 case reproduced in code: 5 distinct feedings totalling
 * 71,144 kg, zero duplicate rows, movement sheet 13,743 kg short → sheet is the
 * culprit, not the DB. Bounded (.limit(50)) and NEVER selects a ₱/cost column.
 */
async function diagnoseDuplicationDate(admin: AdminLike, d: GateDriftDate): Promise<string> {
  const day = humanDate(d.date)
  const dbKg = fmtKg(d.db_sum_kg)
  const mvKg = fmtKg(d.movement_kg)
  const exKg = fmtKg(d.excess_kg)
  // Read that day's feedings — NO ₱/cost columns. Join batches for a human batch_code.
  const { data, error } = await admin
    .from('rc_out')
    .select('id, transaction_date, batch_id, destination, weight_kg, batches(batch_code)')
    .eq('transaction_date', d.date)
    .limit(50)
  if (error) {
    // Fall back to the plain (assumption-free) phrasing if the read fails.
    return `${day} — the database has ${dbKg} kg saved but the movement sheet shows ${mvKg} kg (${exKg} kg more in the database). Could not read that day's feedings to check for duplicates — check both by hand.`
  }
  const rows = data ?? []
  const count = rows.length

  // Find EXACT-DUPLICATE rows: same (batch_id, destination, weight) appearing ≥2×.
  const groups = new Map<string, { count: number; batch: string; weight: number | null }>()
  for (const r of rows) {
    const w = nearWeight(r.weight_kg)
    const key = `${r.batch_id ?? ''}|${r.destination ?? ''}|${w ?? ''}`
    const batchRel = r.batches as { batch_code?: string } | { batch_code?: string }[] | undefined
    const batchCode = Array.isArray(batchRel) ? batchRel[0]?.batch_code : batchRel?.batch_code
    const label = batchCode ?? (r.batch_id as string | undefined) ?? 'a feeding'
    const dest = (r.destination as string | undefined) ?? 'MAIN'
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { count: 1, batch: `${label} → ${dest}`, weight: w })
  }
  const dups = [...groups.values()].filter((g) => g.count >= 2)

  if (dups.length) {
    const phrases = dups
      .map((g) => `${g.batch} ${fmtKg(g.weight)}kg appears ${g.count} times`)
      .join('; ')
    return `${day} — the database has duplicate feedings: ${phrases}. This looks like double-entry in the database and is the likely cause of the ${exKg} kg overage. Someone should check and remove the extra rows.`
  }

  // No duplicate rows → the movement sheet is most likely MISSING feedings.
  return `${day} — the database has ${count} distinct feedings totaling ${dbKg} kg; the movement sheet shows ${mvKg} kg, which is ${exKg} kg less. No duplicate rows exist, so the movement sheet is most likely MISSING feedings worth ${exKg} kg. The database looks correct — check the movement sheet, not the database.`
}

/** Render one drifted date into a plain, specific phrase for the gate_failure evidence. */
function driftLine(d: GateDriftDate): string {
  const day = humanDate(d.date)
  // Duplication flavor (DB sum above the movement sheet) — plain, no DB read. Used only
  // as a fallback; the O>M path in lookupEvidence prefers diagnoseDuplicationDate().
  if (isDuplicationDrift(d)) {
    const dbKg = fmtKg(d.db_sum_kg)
    const mvKg = fmtKg(d.movement_kg)
    const exKg = fmtKg(d.excess_kg)
    return `${day} — the system already has ${dbKg} kg saved but the movement sheet shows ${mvKg} kg (${exKg} kg more already saved than the sheet)`
  }
  // Missing movement entry.
  if (d.note === 'no movement entry' || (d.movement_kg == null && d.proposed_kg != null)) {
    const pkg = fmtKg(d.proposed_kg)
    return `${day} — the daily report shows ${pkg} kg fed but the movement sheet has no entry at all`
  }
  // Daily-report vs movement-sheet drift.
  const pkg = fmtKg(d.proposed_kg)
  const mvKg = fmtKg(d.movement_kg)
  const diff = d.diff_kg == null ? null : fmtKg(Math.abs(d.diff_kg))
  const more = d.diff_kg != null && d.diff_kg >= 0 ? 'more than' : 'less than'
  const diffPhrase = diff ? ` (${diff} kg ${more} the sheet)` : ''
  return `${day} — the daily report shows ${pkg} kg fed but the movement sheet shows ${mvKg} kg${diffPhrase}`
}

/**
 * The read-only, per-kind DB lookup — THE missing evidence. Returns a short
 * human-readable summary string (used both in the prompt and surfaced to the UI as
 * `evidence`), or null when the kind needs no lookup.
 *
 * PRICE GATING: no lookup EVER selects a ₱/cost column. Queries stay small + bounded.
 */
export async function lookupEvidence(
  admin: AdminLike,
  reportType: SyncReportType,
  held: HeldRow
): Promise<string | null> {
  const kind = held.kind
  const row = held.row ?? {}
  try {
    switch (kind) {
      case 'sub_watermark_suspected_dup':
      case 'unresolved_batch_id': {
        // rc_out: is there already a row for this (date, batch_id, destination)?
        const date = row.transaction_date as string | undefined
        const batchId = row.batch_id as string | undefined
        const dest = (row.destination as string | undefined) ?? 'MAIN'
        if (!date || !batchId) return 'No batch_id/date on the held row — cannot check the DB.'
        const { data, error } = await admin
          .from('rc_out')
          .select('id, transaction_date, destination, weight_kg')
          .eq('transaction_date', date)
          .eq('batch_id', batchId)
          .eq('destination', dest)
          .limit(5)
        if (error) return `DB lookup failed: ${error.message}`
        if (!data || data.length === 0) {
          return `No rc_out row exists for ${date} / this batch / ${dest} — likely a genuine missing feeding.`
        }
        const nw = nearWeight(row.weight_kg)
        const exact = data.find((d) => nearWeight(d.weight_kg) === nw)
        if (exact) {
          return `An identical feeding already exists (id ${exact.id}, ${exact.weight_kg}kg on ${exact.transaction_date} ${exact.destination}) — suspected duplicate.`
        }
        return `${data.length} row(s) already exist for ${date}/this batch/${dest} at other weights (${data
          .map((d) => `${d.weight_kg}kg`)
          .join(', ')}); the held row's ${nw}kg is not among them.`
      }
      case 'cross_batch_reassignment': {
        // Fetch the colliding DB row(s) it matches on (date/truck/weight) — deliveries.
        if (reportType === 'deliveries') {
          const date = row.transaction_date as string | undefined
          const truck = row.truck_plate as string | undefined
          if (!date) return 'No date on the held row — cannot check the collision.'
          let q = admin
            .from('deliveries')
            .select('id, transaction_date, batch_code, block_loc, truck_plate, weight_kg')
            .eq('transaction_date', date)
            .limit(5)
          if (truck) q = q.eq('truck_plate', truck)
          const { data, error } = await q
          if (error) return `DB lookup failed: ${error.message}`
          if (!data || data.length === 0) return `No DB delivery matches ${date}${truck ? ` / ${truck}` : ''}.`
          return `Colliding DB deliveries: ${data
            .map((d) => `id ${d.id} → ${d.batch_code} @ ${d.block_loc} (${d.weight_kg}kg)`)
            .join('; ')}. Held row proposes a different batch/loc.`
        }
        // gsheet carries the conflicting DB ids/batches on the row itself.
        const ids = (row.db_conflict_ids as unknown[]) ?? []
        const batches = (row.db_conflict_batches as unknown[]) ?? []
        if (!ids.length && !batches.length) return 'Flagged as a cross-batch collision; no conflict ids on the row.'
        return `Sheet collides with DB row(s) ${JSON.stringify(ids)} under batch(es) ${JSON.stringify(batches)} — compare batch/location before reassigning.`
      }
      case 'unmapped_batch_code': {
        // List existing batch_codes near the given code (same month prefix) as candidates.
        const code = (row.batch_code as string | undefined) ?? null
        if (!code) return 'No batch code on the held row.'
        const prefix = code.split('-')[0] // e.g. "JULY" from "JULY-26-BLK9"
        const { data, error } = await admin
          .from('batches')
          .select('batch_code')
          .ilike('batch_code', `${prefix}%`)
          .limit(12)
        if (error) return `DB lookup failed: ${error.message}`
        const codes = (data ?? []).map((b) => b.batch_code)
        if (!codes.length) return `No existing batch codes start with "${prefix}" — the batch may need creating (by a human).`
        return `Candidate existing batches near "${code}": ${codes.join(', ')}. Never auto-create — pick the intended one or create it manually.`
      }
      case 'batch_location_conflict':
      case 'location_occupied': {
        // BUG-027 (2026-08-25): a `batch_location_conflict` row already CARRIES both
        // sides (the worker looked them up at the moment of the refusal). Re-read the
        // block anyway — the point of the lookup is what is true NOW, and a block the
        // operator has since closed is exactly the answer the adjudicator needs. Prefer
        // the conflict row's own `location_ref`, falling back to the row's block.
        const loc =
          (row.location_ref as string | undefined) ?? (row.block_loc as string | undefined) ?? null
        if (!loc) return 'No block_loc on the held row.'
        // Which batch currently occupies that block_loc + its status/balance (no ₱).
        const { data, error } = await admin
          .from('batches')
          .select('batch_code, status, current_weight, location_ref')
          .eq('location_ref', loc)
          .limit(5)
        if (error) return `DB lookup failed: ${error.message}`
        if (!data || data.length === 0) return `No batch currently maps to location ${loc}.`
        return `Location ${loc} is held by: ${data
          .map((b) => `${b.batch_code} (${b.status}, bal ${b.current_weight})`)
          .join('; ')}. Close/relocate before the new batch can occupy it.`
      }
      case 'unmapped_bag_type_code': {
        const codes = (row.bag_type_codes as unknown[]) ?? []
        const { data, error } = await admin
          .from('flecon_bag_types')
          .select('code, label')
          .limit(30)
        if (error) return `DB lookup failed: ${error.message}`
        const known = (data ?? []).map((t) => t.code).join(', ')
        return `Unmapped code(s) ${JSON.stringify(codes)}. Known bag-type codes: ${known}. Never auto-create — map to an existing code or register it.`
      }
      case 'gate_failure': {
        // The specific drifted dates + both totals are ON the row (threaded by the worker
        // from the reconciler). Two flavors:
        //   - proposed_vs_movement_drift_500kg → a disagreement between the two REPORTS
        //     (daily report vs movement sheet). Render straight from the row — NO DB call
        //     needed; the numbers already name the source-doc gap.
        //   - db_vs_movement_duplication (O>M) → the DB sum exceeds the movement sheet. The
        //     gate message ASSUMES duplication, but that's often wrong (the movement sheet
        //     may simply be missing feedings). SELF-DIAGNOSE per date with a read-only
        //     rc_out query: real duplicate rows → DB issue; none → movement-sheet gap.
        const drift = (row.drift_dates as GateDriftDate[] | undefined) ?? []
        if (!drift.length) {
          return 'Nothing was saved for this report because the daily totals did not add up. No per-day breakdown was attached.'
        }
        const lines = await Promise.all(
          drift.map((d) => (isDuplicationDrift(d) ? diagnoseDuplicationDate(admin, d) : Promise.resolve(driftLine(d)))),
        )
        return `Nothing was saved for this report. Days that don't add up: ${lines.join('; ')}.`
      }
      default:
        // malformed / low_confidence / already_exists / below_since_floor /
        // unmapped_or_missing_columns / unresolved_shift / flagged / other → no lookup.
        return null
    }
  } catch (e) {
    return `DB lookup error: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * Build the context-rich user prompt: per row, the human key + kind + rule meaning +
 * structured row + held detail + the DB lookup finding. `evidence[i]` is the string
 * returned by lookupEvidence for row i (or null when the kind has no lookup).
 */
export function buildAdjudicationPrompt(
  reportType: SyncReportType,
  heldRows: HeldRow[],
  evidence: Array<string | null>
): string {
  return [
    `Report type: ${reportType}`,
    '',
    'Held rows (each with its row data, rule meaning, and a read-only DB lookup):',
    ...heldRows.map((r, i) => {
      const meaning = r.kind ? KIND_MEANING[r.kind] : 'Uncategorized hold.'
      const rowJson = r.row ? JSON.stringify(r.row) : '(no structured row)'
      return [
        `${i + 1}. natural_key: ${r.natural_key}`,
        `   kind: ${r.kind ?? 'other'}`,
        `   rule meaning: ${meaning}`,
        `   row: ${rowJson}`,
        `   held detail: ${r.detail}`,
        `   DB lookup: ${evidence[i] ?? '(no lookup for this kind)'}`,
      ].join('\n')
    }),
  ].join('\n')
}
