/**
 * supplierCanon.ts — a FAITHFUL TypeScript mirror of the DB function
 * `public.canonical_supplier(text)`.
 *
 * ============================================================================
 * WHY A MIRROR AND NOT AN RPC
 * ============================================================================
 * The price matcher calls this once per candidate row on both sides of the join —
 * an RPC per row would be hundreds of round-trips per run, and worse, it would make
 * the matcher DB-dependent. `enrich` is a pure function today, which is what lets
 * the tab resolver and the fallback matcher be unit-tested offline against a real
 * workbook with no database at all. So: mirror, exactly as this codebase already
 * does for other parity-critical tables, and assert the two copies agree in a
 * verify script (`scripts/verify-supplier-canon.ts`, the
 * `scripts/verify-case-grouping.ts` idiom).
 *
 * THE SQL BEING MIRRORED (read from the live DB 2026-08-07, IMMUTABLE, search_path
 * pinned to public):
 *
 *   CASE
 *     WHEN p ILIKE '%tipal%' OR p ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
 *     WHEN p ILIKE '%bagui%' OR p ILIKE '%bagi%'  THEN 'BAGUIO'
 *     WHEN p ILIKE '%mercado%ornales%'  OR p ILIKE '%ornales%mercado%'
 *       OR p ILIKE '%mercado%paquibot%' OR p ILIKE '%paquibot%mercado%'
 *       OR p ILIKE '%arbelera%mercado%' OR p ILIKE '%mercado%arbelera%'
 *       OR p ILIKE '%nazarte%arbelera%' OR p ILIKE '%arbelera%nazarte%' THEN 'ORNALES'
 *     WHEN p ILIKE '%compra%paquibot%'   OR p ILIKE '%paquibot%compra%'
 *       OR p ILIKE '%suarez%paquibot%'   OR p ILIKE '%paquibot%suarez%'
 *       OR p ILIKE '%baraquel%paquibot%' OR p ILIKE '%paquibot%baraquel%' THEN 'PAQUIBOT'
 *     WHEN p ILIKE '%nazareno%' OR p ILIKE '%nazarino%' THEN 'NAZARENO'
 *     ELSE COALESCE(NULLIF(UPPER(TRIM(p)), ''), 'UNKNOWN')
 *   END
 *
 * TWO SEMANTICS THAT MUST BE COPIED EXACTLY, NOT APPROXIMATED:
 *
 * 1. `%A%B%` is ORDERED and NON-OVERLAPPING. It means "A occurs, and B occurs
 *    entirely after A ends". It is NOT `contains(A) && contains(B)`: for the input
 *    "MERCADORNALES" the 'o' is shared, so SQL matches neither `%mercado%ornales%`
 *    nor `%ornales%mercado%`, while a naive both-contained test would match. Hence
 *    `containsInOrder()` below. Each pair is written out in BOTH orders, exactly as
 *    the SQL does — do not "simplify" it to an AND.
 *
 * 2. A NULL input yields 'UNKNOWN'. In SQL every ILIKE against NULL evaluates to
 *    NULL (not TRUE), so no WHEN branch fires and the ELSE runs:
 *    COALESCE(NULLIF(UPPER(TRIM(NULL)), ''), 'UNKNOWN') → 'UNKNOWN'. Same for an
 *    empty or all-whitespace string, via the NULLIF.
 *
 * Branch ORDER is load-bearing (a CASE stops at the first TRUE): 'BAGUIO/TIPALAN'
 * must be tested before 'BAGUIO', or every Tipalan row would collapse to BAGUIO.
 *
 * If `public.canonical_supplier` is ever changed, change this file in the same
 * changeset and re-run `npx tsx scripts/verify-supplier-canon.ts`.
 */

/**
 * SQL `haystack ILIKE '%a%b%'` — case-insensitive, `a` then `b`, non-overlapping.
 * Extends to any number of needles, same semantics as extra `%` separators.
 */
function containsInOrder(haystack: string, ...needles: string[]): boolean {
  const h = haystack.toLowerCase();
  let from = 0;
  for (const n of needles) {
    const at = h.indexOf(n.toLowerCase(), from);
    if (at < 0) return false;
    from = at + n.length; // next needle must start AFTER this one ends
  }
  return true;
}

/** SQL `haystack ILIKE '%a%b%' OR haystack ILIKE '%b%a%'` — either order. */
function containsBothEitherOrder(haystack: string, a: string, b: string): boolean {
  return containsInOrder(haystack, a, b) || containsInOrder(haystack, b, a);
}

/**
 * The mirror of `public.canonical_supplier(text)`. Total: every input, including
 * null/undefined/empty, returns a non-empty canonical name ('UNKNOWN' at worst).
 */
export function canonicalSupplier(raw: string | null | undefined): string {
  // NULL / undefined → the SQL ELSE branch → 'UNKNOWN' (see note 2 above).
  if (raw === null || raw === undefined) return "UNKNOWN";
  const p = String(raw);

  if (containsInOrder(p, "tipal") || containsInOrder(p, "tipla")) return "BAGUIO/TIPALAN";
  if (containsInOrder(p, "bagui") || containsInOrder(p, "bagi")) return "BAGUIO";

  if (
    containsBothEitherOrder(p, "mercado", "ornales") ||
    containsBothEitherOrder(p, "mercado", "paquibot") ||
    containsBothEitherOrder(p, "arbelera", "mercado") ||
    containsBothEitherOrder(p, "nazarte", "arbelera")
  ) {
    return "ORNALES";
  }

  if (
    containsBothEitherOrder(p, "compra", "paquibot") ||
    containsBothEitherOrder(p, "suarez", "paquibot") ||
    containsBothEitherOrder(p, "baraquel", "paquibot")
  ) {
    return "PAQUIBOT";
  }

  if (containsInOrder(p, "nazareno") || containsInOrder(p, "nazarino")) return "NAZARENO";

  // ELSE COALESCE(NULLIF(UPPER(TRIM(p)), ''), 'UNKNOWN')
  const upper = p.trim().toUpperCase();
  return upper === "" ? "UNKNOWN" : upper;
}

/**
 * The key space `public.delivery_source_aliases` uses for `kind = 'supplier'`:
 * UPPER(TRIM(raw)), i.e. the SQL ELSE branch WITHOUT the canonical collapsing.
 *
 * The alias table is the FALLBACK for supplier variants `canonical_supplier` does
 * NOT already collapse, so it must be keyed on the raw source spellings — keying it
 * on canonical output would store degenerate PAQUIBOT→PAQUIBOT rows that say nothing.
 */
export function supplierAliasKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "UNKNOWN";
  const upper = String(raw).trim().toUpperCase();
  return upper === "" ? "UNKNOWN" : upper;
}
