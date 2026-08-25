/**
 * creationRaceHolds.ts — the post-writers "creation-race" re-resolve pass (Fix 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RACE
 * ─────────────────────────────────────────────────────────────────────────────
 * runSync runs gsheet FIRST and alone, THEN deliveries / rc_out / production / flecon
 * as parallel writers. gsheet's classify checks the `batches` table for each row's
 * batch_code; for a BRAND-NEW batch it finds nothing yet → correctly refuses to
 * auto-create → holds the row `unmapped_batch_code`. But ~1s later in the SAME run the
 * delivery-email writer ingests the same physical delivery and CREATES that batch
 * (upsert-by-code). So the hold is a FALSE ALARM — the batch (and its row) exist by the
 * run's end.
 *
 * This pass runs AFTER the parallel writers complete (so the batches they created are
 * visible). It reloads a FRESH batch_code → batch_id lookup, re-resolves each gsheet
 * `unmapped_batch_code` held row, and:
 *   - RESOLVES + the row's record now exists (a sibling writer wrote it) → AUTO-CLEAR
 *     (drop the hold; the data is already correct — the hold was pure timing).
 *   - RESOLVES but NO matching record exists (batch created, this row written by nobody)
 *     → KEEP, but reclassify the reason/detail to "batch now exists — needs a write".
 *     NEVER auto-write it (that is a human policy call).
 *   - STILL doesn't resolve (a genuinely new / typo'd batch nobody created) → KEEP as
 *     `unmapped_batch_code` (the real human case).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY
 * ─────────────────────────────────────────────────────────────────────────────
 * This core is PURE except for the injected `recordExists` probe (the only DB touch,
 * and it is READ-ONLY). It NEVER writes an operational table and NEVER mutates its
 * input array — it returns a REBUILT held array + telemetry. It only REMOVES
 * confirmed-redundant holds from the run's result, so the app fan-out
 * (`ensureCasesForRun`) never opens a case for an auto-cleared row. The runSync wrapper
 * guards the whole thing in try/catch: any failure leaves the holds as-is.
 *
 * The `kind` of a reclassified row stays `unmapped_batch_code` ON PURPOSE: the frontend
 * `KIND_LABEL` map is an EXHAUSTIVE `Record<HeldKind, string>` living in components/, so
 * a brand-new kind means editing every one of those maps in the same changeset (which is
 * exactly what BUG-027 did for `batch_location_conflict`, 2026-08-25 — so it is allowed,
 * just never free). Here it would buy nothing: this is the SAME problem seen a moment
 * later, not a different one. The reclassification is carried in
 * `reason`/`detail` + a `row.batch_now_exists` marker instead (neither participates in
 * the case fingerprint, which is (reportType, kind, natural_key) — so the case identity
 * is stable across the reclassify).
 */
import { batchCodeFallbacks } from "../reports/gsheet/extract.js";

/**
 * A structurally-loose held row (matches BOTH the worker `held.ts` HeldRow — kind:
 * HeldKind — and the assembly-boundary `normalizeReport.ts` HeldRow — kind: string).
 * Using `kind?: string` here avoids narrowing friction at the runSync call site, where
 * the held array is already the normalizeReport shape.
 */
export interface HeldRowLike {
  reason: string;
  natural_key: string;
  detail: string;
  kind?: string;
  row?: Record<string, unknown>;
  source_index?: string | number;
}

/** The READ-ONLY DB probe: "did a sibling writer already write this held row's record?" */
export type RecordExistsFn = (args: {
  mode: string | null;
  resolvedCode: string;
  resolvedId: string;
  row: Record<string, unknown>;
}) => Promise<boolean>;

export interface CreationRaceOutcome {
  /** Holds dropped — false alarms whose record a sibling writer already wrote. */
  autoCleared: number;
  /** Holds kept but reclassified — batch now exists, this row written by nobody. */
  reclassified: number;
  /** Holds kept unchanged — the code STILL does not resolve (a genuine new/typo). */
  keptUnmapped: number;
  /** The rebuilt held array — present ONLY when something changed (else undefined). */
  newHeld?: HeldRowLike[];
}

/** Resolve a primary code + its regenerated fallbacks against a fresh lookup. */
function resolveCode(
  primary: string | null,
  lookup: Record<string, string>,
): { resolvedCode: string | null; resolvedId: string | null } {
  if (!primary) return { resolvedCode: null, resolvedId: null };
  const codes = [primary, ...batchCodeFallbacks(primary)];
  for (const c of codes) {
    if (c in lookup) return { resolvedCode: c, resolvedId: lookup[c] };
  }
  return { resolvedCode: null, resolvedId: null };
}

/** Build the "batch now exists but this row was not written" reclassified held row. */
function reclassifyBatchNowExists(
  h: HeldRowLike,
  primary: string | null,
  resolvedId: string,
): HeldRowLike {
  return {
    ...h,
    // kind STAYS `unmapped_batch_code` (see file header — the frontend KIND_LABEL is
    // exhaustive over HeldKind and lives in components/). Reclassification is carried
    // in reason/detail + the row marker.
    reason: "batch now exists — row not yet written",
    detail:
      `The batch '${primary ?? "?"}' now exists (a sibling writer created it during this ` +
      `run), but this specific row was not written by anyone — it needs a manual write or ` +
      `review. Not auto-written (that is a human decision).`,
    row: { ...(h.row ?? {}), batch_now_exists: true, resolved_batch_id: resolvedId },
  };
}

/**
 * Re-resolve gsheet `unmapped_batch_code` holds against a FRESH (post-writers) batch
 * lookup and auto-clear the creation-race false alarms. PURE except for the injected
 * `recordExists` probe. Never mutates `held`. Returns `newHeld` only when something
 * changed (auto-cleared or reclassified) — the caller assigns it back to the result.
 */
export async function reResolveCreationRaceHolds(
  held: readonly HeldRowLike[],
  batchLookup: Record<string, string>,
  recordExists: RecordExistsFn,
): Promise<CreationRaceOutcome> {
  let autoCleared = 0;
  let reclassified = 0;
  let keptUnmapped = 0;
  const newHeld: HeldRowLike[] = [];

  for (const h of held) {
    if (h.kind !== "unmapped_batch_code") {
      newHeld.push(h);
      continue;
    }
    const row = (h.row ?? {}) as Record<string, unknown>;
    const mode = (row.mode as string | null) ?? null;
    const primary = (row.batch_code as string | null) ?? null;

    const { resolvedCode, resolvedId } = resolveCode(primary, batchLookup);
    if (resolvedId === null || resolvedCode === null) {
      // STILL unresolved — a genuinely new / typo'd batch nobody created. The real case.
      keptUnmapped++;
      newHeld.push(h);
      continue;
    }

    const exists = await recordExists({ mode, resolvedCode, resolvedId, row });
    if (exists) {
      // FALSE ALARM — a sibling writer already wrote this row correctly. AUTO-CLEAR.
      autoCleared++;
      continue; // drop from held
    }

    // Batch now exists but this row was written by nobody → keep + reclassify.
    reclassified++;
    newHeld.push(reclassifyBatchNowExists(h, primary, resolvedId));
  }

  if (autoCleared === 0 && reclassified === 0) {
    // Nothing changed (only unchanged holds) — signal a no-op with no newHeld.
    return { autoCleared: 0, reclassified: 0, keptUnmapped };
  }
  return { autoCleared, reclassified, keptUnmapped, newHeld };
}
