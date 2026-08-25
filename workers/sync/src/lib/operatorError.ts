/**
 * operatorError.ts — ONE shape for every string that lands in `apply.errors[]`
 * (2026-08-25, BUG-027 part 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * `apply.errors[]` is not an internal log. `lib/sync/reducer.ts::gateErrorFrom` joins it
 * verbatim into the employee card's inline error block — the red box with the Copy button
 * that an operator reads in the Sync panel. Until now every push wrote a developer's
 * sentence, so on 2026-08-25 Renzo read:
 *
 *     rc_in apply: upsert_batch_if_absent batches failed 23505: duplicate key value
 *     violates unique constraint "idx_unique_active_batch_per_location"
 *
 * …verbatim, and said: "bruh, these errors in the sync panel have to be way more
 * understandable to a normal user."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * NO RAW DATABASE ERROR IS EVER THE HEADLINE. Every push states, in plain language:
 * WHAT could not be done, WHAT that means for the data (what was and was not saved), and
 * WHAT happens next. The raw string is KEPT — it is the thing a developer needs and the
 * Copy button exists for — but it goes on a second line, clearly labelled, underneath.
 *
 * ONE SHAPE, so the panel never has to guess which half it is looking at:
 *
 *     <plain-language headline sentence(s)>
 *     Technical detail: <the raw error, verbatim>
 *
 * A specific refusal with a known meaning gets a specific headline (a location clash is
 * held as `batch_location_conflict` and never reaches this file at all; a latch refusal
 * has its own vocabulary). Everything else gets an honest generic one — "the database
 * refused it, here is what that cost, here is what happens next" — which is still
 * infinitely more use than a constraint name.
 *
 * Pure and total: no input can make it throw, and it never inspects a ₱ value.
 */

/** The label that separates the operator's sentence from the developer's string. */
const DETAIL_PREFIX = "Technical detail: ";

/**
 * Compose one `errors[]` entry: a plain-language headline, then the raw detail on its
 * own line. `detail` may be an Error, a string, or anything — it is stringified.
 *
 * An empty/blank detail yields the headline alone rather than a dangling label.
 */
export function operatorError(headline: string, detail: unknown): string {
  const raw = (detail instanceof Error ? detail.message : String(detail ?? "")).trim();
  const head = headline.trim();
  return raw ? `${head}\n${DETAIL_PREFIX}${raw}` : head;
}

/** `unknown` → a message string, the same way every apply.ts already did it inline. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
