/**
 * labResults.ts — THE one rule for what a `deliveries.lab_results` WRITE carries when the
 * source states no reading (2026-09-25, L-054). Shared by both writers of `deliveries`
 * (`reports/deliveries/apply.ts` and `reports/gsheet/apply.ts`), so they cannot disagree.
 *
 * THE SCHEMA: `lab_results jsonb NOT NULL DEFAULT '{"bd":0,"fc":0,"mc":0,"vm":0,"ash":0,
 * "jis":0,"grit":0}'`. Both extractors collapse a row with no lab reading to `null`
 * (parity with the Python oracle — that null is part of the classify envelope and stays),
 * and both apply paths used to send that `null` straight to the INSERT. The database
 * refused it with 23502. On 2026-09-25 that refusal is the ONLY thing that kept three
 * scratch-arithmetic rows (449,325 / 500,000 / −50,675 kg) out of `deliveries` — a lucky
 * catch, not a rule — and it would equally have refused a GENUINE truckload booked before
 * its lab panel came back.
 *
 * WHY `{}` AND NOT THE COLUMN DEFAULT. The default is seven ZEROS under two retired key
 * names (`bd`, `jis`). A zero moisture reading is a measurement; "the lab has not reported"
 * is not. Measured 2026-09-25: of 1,790 deliveries, ZERO carry the default shape (no row has
 * `mc = 0`) and exactly ONE carries `{}` (2026-03-18, no plate). `{}` is therefore the
 * existing spelling of "no reading" — and it is the only spelling the weighted views read
 * correctly: `view_blocking_grid` computes each stat as
 *   Σ((lab_results->>'mc') × weight) ÷ Σ(weight WHERE lab_results->>'mc' IS NOT NULL),
 * so a MISSING key drops that truckload out of BOTH sides, while the all-zero default would
 * put its weight in the denominator with a 0 in the numerator and drag the pile's MC toward
 * zero — the L-008 ₱0-placeholder mistake, in lab clothing.
 */

/** A lab panel is EMPTY when it is absent, not an object, or states no numeric reading at all. */
export function isEmptyLabPanel(v: unknown): boolean {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return true;
  return !Object.values(v as Record<string, unknown>).some(
    (x) => x !== null && x !== undefined && x !== "",
  );
}

/**
 * The value an INSERT sends. Never `null`: a row with no reading is written as `{}` —
 * "no reading" — never as the column's all-zero default, which would read as "measured 0".
 */
export function labResultsForInsert(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/**
 * Should an UPDATE carry this lab panel at all? No, when the source states no reading:
 * ABSENCE IS NEVER DELETION (the rule the production-plan writer was built on, 2026-07-30).
 * A blank lab block in the source must not erase a panel the database already holds — and
 * sending it as `null` would violate NOT NULL and take the whole update batch down with it.
 * This is the same shape as the classifier's long-standing "cost_basis is skipped when the
 * extracted side is null" rule, applied at the write instead of the diff (the diff is part
 * of the parity envelope and is left exactly as the oracle computes it).
 */
export function shouldWriteLabPatch(v: unknown): boolean {
  return !isEmptyLabPanel(v);
}
