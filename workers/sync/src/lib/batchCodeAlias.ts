/**
 * batchCodeAlias.ts — THE one definition of "these two batch codes are the SAME code,
 * spelled differently" (2026-08-13, L-042).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Blackwood's `batch_code` month prefix has TWO live conventions and always has —
 * `MARCH-26-BLK6` and `MAR-26-BLK6` are one batch (memory: "batch codes inconsistent").
 * `batchCodeFallbacks` (a port of `extract_gsheet.py::batch_code_fallbacks`) already
 * encodes the alias table; what did NOT exist was a single predicate that answers
 * "is this pair merely a spelling difference?", so every consumer compared RAW STRINGS.
 *
 * That gap is exactly what turned the operator's `FEEDING # 1` shorthand into a held
 * case. The deliveries extractor derives a FEED code from the delivery month using the
 * FULL month name (`AUGUST-26-FEED1`), while the live convention for August feed batches
 * is `AUG-26-FEED1` (measured on `batches`, 2026-08-13: feed batches read `AUG-…`,
 * `JULY-…`, `JUNE-…`, `FEB-…` — the same split `MONTH_PREFIX_ALIASES` describes). Under
 * the two-tier identity (`deliveryIdentity.ts`) the email row MATCHES the existing DB row
 * on tier 1 (same date, plate and sacks) and then "disagrees" on `batch_code` — so a
 * pure naming-convention difference became a `cross_batch_reassignment` held case asking
 * a human to arbitrate between two spellings of one batch.
 *
 * A MONTH-PREFIX ALIAS IS NOT A DISAGREEMENT. It is a naming convention, and the system
 * already knows the table.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is NOT a fuzzy matcher and it invents nothing. `JULY-26-BLK9` and `JUNE-26-BLK9`
 * are DIFFERENT MONTHS and stay a real disagreement (both deliveries parity fixtures
 * turn on exactly that pair — the L-033 month-boundary phantom — and neither is
 * collapsed here). Only the prefix pairs in `MONTH_PREFIX_ALIASES` collapse, and only
 * when the year and the whole suffix are byte-identical.
 *
 * Mirrored in Python by `classify_deliveries.py::batch_code_alias_equal` and
 * `parity_guards.py::_alias_of` — the parity harness compares them.
 */
import { batchCodeFallbacks } from "../reports/gsheet/extract.js";

/** `null`/`undefined`/blank → null; otherwise the trimmed, upper-cased code. */
function normCode(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.toUpperCase() : null;
}

/**
 * Every spelling of `code` this project recognises, INCLUDING the code itself, upper-cased
 * and de-duplicated in first-seen order. A code with no recognised month prefix yields
 * just itself — the function never widens a code it does not understand.
 */
export function batchCodeSpellings(code: unknown): string[] {
  const primary = normCode(code);
  if (primary === null) return [];
  const out = [primary];
  for (const fb of batchCodeFallbacks(primary)) {
    const n = normCode(fb);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Are `a` and `b` the same batch code, allowing ONLY a month-prefix alias?
 *
 * The alias table is not symmetric for every month (`SEPT → SEPTEMBER`, `SEP →
 * SEPTEMBER`, `SEPTEMBER → SEPT`), so both directions are tried and the union is used.
 * Nothing new is invented: `SEP` and `SEPT` do NOT collapse into each other, because the
 * table does not say they do.
 *
 * Two blanks are equal (both "no code"); a blank and a code are not.
 */
export function batchCodeAliasEqual(a: unknown, b: unknown): boolean {
  const na = normCode(a);
  const nb = normCode(b);
  if (na === null || nb === null) return na === nb;
  if (na === nb) return true;
  return batchCodeSpellings(na).includes(nb) || batchCodeSpellings(nb).includes(na);
}

/**
 * Prefer the spelling the DATABASE actually uses.
 *
 * Returns an alias of `code` that EXISTS in `knownCodes` when `code` itself does not, and
 * `null` otherwise. It can only ever point at a batch that ALREADY EXISTS — it never
 * invents a code and never overrides a code that already resolves — which is the same
 * safety property the L-033b remark hint has (`cand in batch_codes` or nothing).
 *
 * Case handling: `knownCodes` is matched case-insensitively, but the value RETURNED is
 * the DB's own spelling, so a write lands on the existing row rather than beside it.
 */
export function resolveKnownBatchCodeAlias(
  code: unknown,
  knownCodes: ReadonlySet<string>,
): string | null {
  const primary = normCode(code);
  if (primary === null) return null;
  const byUpper = new Map<string, string>();
  for (const k of knownCodes) {
    const n = normCode(k);
    if (n !== null && !byUpper.has(n)) byUpper.set(n, k);
  }
  if (byUpper.has(primary)) return null; // already resolves — nothing to prefer
  for (const cand of batchCodeSpellings(primary)) {
    if (cand === primary) continue;
    const hit = byUpper.get(cand);
    if (hit !== undefined) return hit;
  }
  return null;
}
