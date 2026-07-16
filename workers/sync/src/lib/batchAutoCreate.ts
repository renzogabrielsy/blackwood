/**
 * batchAutoCreate.ts — the sync's batch auto-create policy (Renzo, 2026-07-11).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POLICY CHANGE (reverses the prior "never auto-create a batch" hard rule)
 * ─────────────────────────────────────────────────────────────────────────────
 * The sync may now AUTO-CREATE a batch when a source (Google Sheet RC IN/RC OUT,
 * PROPOSED DAILY REPORT) names a `batch_code` that doesn't exist yet, PROVIDED the
 * code is PATTERN-VALID: a recognized month-prefix (JAN/JANUARY/…/SEPT, incl. the
 * SEPT/SEP asymmetry) + "-YY-" + a kind+number suffix (BLK6, FEED1, SUNDRY2, …).
 * A pattern-INVALID code (a likely typo, e.g. "BLKZ", "X") is NEVER auto-created —
 * it still holds/unmapped exactly as before. This regex is the ENTIRE safety guard;
 * it is deliberately conservative (letters-then-digits suffix) so a malformed code
 * can't slip through and create garbage inventory.
 *
 * The auto-created batch follows the SAME template as the human-confirmed "create
 * this batch" Sync Review action (`lib/sync/create-batch-plan.ts::deriveBatchFields`,
 * app-side). That file is MIRRORED here field-for-field, not imported — workers/sync
 * is a separate package/module graph from the Next.js app:
 *   batch_code = the code; location_ref = block_loc if it matches the DB's
 *   `chk_location_ref_format` CHECK constraint, else '' (empty = feed/no block — BUG B
 *   fix, 2026-07-11: the DB constraint is `location_ref = '' OR ~
 *   '^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$'`, so a literal 'FEED' sentinel — or any free-text
 *   block like "FOR FEEDING" — 23514s the insert); status = 'STORED'; current_weight = 0
 *   (the trigger recomputes it from deliveries − rc_out); avg_cost = null (the sync never
 *   prices a batch).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALIAS-OF-EXISTING (never create a duplicate under a month-prefix alias)
 * ─────────────────────────────────────────────────────────────────────────────
 * Before creating anything, `ensureBatch` first tries to resolve `primaryCode` (and
 * its `batchCodeFallbacks`, e.g. JUL-26-BLK6 ↔ JULY-26-BLK6) against the CALLER's
 * in-memory `lookup` (the same `batch_code → batch_id` map the classify layer
 * already builds). A hit means the physical batch already exists under a different
 * month-prefix convention — resolve to it, write nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONCURRENCY (parallel writer lanes)
 * ─────────────────────────────────────────────────────────────────────────────
 * The DB write goes through `DbClient.upsertBatchIfAbsent` — an ON CONFLICT
 * (batch_code) DO NOTHING upsert + re-select — so two PARALLEL writer lanes
 * (deliveries + rc_out both feeding a brand-new batch in the same run) can't create
 * a duplicate or crash on the race; the loser re-selects the winner's row and gets
 * `status: "race_lost_to_sibling"` (no duplicate audit log — see callers).
 */
import type { DbClient } from "./db.js";
import { batchCodeFallbacks } from "../reports/gsheet/extract.js";

// Mirrors gsheet/extract.ts::MONTH_PREFIX_ALIASES' KEYS (+ "MAY", which has no
// alias there so it never appears as a key). Kept LOCAL — same "mirror, don't
// import the parity-critical table" idiom already used by
// reconcile/blockBalance.ts::MONTH_CANONICAL and reconcile/rcOutStage.ts's
// resolveBatchId mirror — so this module stays a small, dependency-light guard
// and never risks the gsheet classify parity surface.
const MONTH_TOKENS = new Set<string>([
  "JAN", "JANUARY",
  "FEB", "FEBRUARY",
  "MAR", "MARCH",
  "APR", "APRIL",
  "MAY",
  "JUN", "JUNE",
  "JUL", "JULY",
  "AUG", "AUGUST",
  "SEP", "SEPT", "SEPTEMBER",
  "OCT", "OCTOBER",
  "NOV", "NOVEMBER",
  "DEC", "DECEMBER",
]);

/**
 * month-prefix + "-" + 2-digit year + "-" + kind letters + a number, e.g.
 * "JULY-26-BLK6", "JUL-26-FEED1", "SEPT-25-SUNDRY2". Case-insensitive. The
 * kind+number suffix is intentionally generic (any letters then any digits) —
 * BLK/FEED/SUNDRY are the observed kinds, but the month-token check (not the
 * suffix) is the real typo guard.
 */
const BATCH_CODE_PATTERN_RE = /^([A-Z]+)-(\d{2})-([A-Z]+)(\d+)$/;

/**
 * True when `code` matches the canonical month-prefix + YY + kind+number shape AND
 * the month token is a recognized prefix/alias. A non-matching code (typo,
 * malformed suffix, unknown month token) is NEVER auto-created — it stays
 * unmapped/held exactly as before this policy change.
 */
export function isPatternValidBatchCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const m = BATCH_CODE_PATTERN_RE.exec(code.trim().toUpperCase());
  if (!m) return false;
  return MONTH_TOKENS.has(m[1]);
}

/** The batch columns an auto-create derives — MIRRORS
 *  `lib/sync/create-batch-plan.ts::deriveBatchFields` field-for-field. */
export interface DerivedBatchFields {
  batch_code: string;
  location_ref: string;
  status: string;
  current_weight: number;
  avg_cost: number | null;
}

/**
 * Mirrors the DB CHECK constraint `chk_location_ref_format` on `batches.location_ref`:
 * `location_ref = '' OR location_ref ~ '^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$'`. MIRRORS
 * `lib/sync/create-batch-plan.ts::LOCATION_REF_PATTERN_RE` — keep both in sync (BUG B,
 * 2026-07-11).
 */
const LOCATION_REF_PATTERN_RE = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/;

/**
 * Derive the new batch's columns (PURE). `location_ref` is the row's block when it
 * matches the DB's `chk_location_ref_format` constraint, else '' (empty = feed/no
 * block — covers both a genuinely missing block AND a block string that isn't a valid
 * location code, e.g. "FOR FEEDING" or "16A NEAR PATHWAY"); `status` STORED;
 * `current_weight` 0 (the trigger recomputes it); `avg_cost` null (unpriced — the sync
 * never carries ₱ here).
 */
export function deriveBatchFields(
  batchCode: string,
  blockLoc: string | null | undefined,
): DerivedBatchFields {
  const block = typeof blockLoc === "string" && blockLoc.trim() ? blockLoc.trim() : null;
  const location_ref = block && LOCATION_REF_PATTERN_RE.test(block) ? block : "";
  return {
    batch_code: batchCode,
    location_ref,
    status: "STORED",
    current_weight: 0,
    avg_cost: null,
  };
}

/**
 * The human-facing label for a location_ref in run findings / progress messages / audit
 * notes. The STORED value for a feed/no-block batch is '' (BUG B, 2026-07-11) — but ''
 * reads as blank in the UI, so display it as the "FEED" label instead. NEVER feed this
 * back into a DB write (it would 23514 chk_location_ref_format); display-only.
 */
export function displayLocationRef(locationRef: string): string {
  return locationRef || "FEED";
}

/**
 * Resolve `primary` (+ its regenerated month-prefix fallbacks) against an
 * in-memory `batch_code → batch_id` lookup — the SAME primary-then-fallbacks
 * order every classify resolver uses (gsheet/classify.ts::resolveAgainstSet/
 * resolveBatchId, rc_out/classify.ts::resolveBatchId). No DB call. PURE.
 */
export function resolveAgainstLookup(
  primary: string | null | undefined,
  lookup: Readonly<Record<string, string>>,
): { batchId: string; resolvedCode: string } | null {
  if (!primary) return null;
  const codes = [primary, ...batchCodeFallbacks(primary)];
  for (const c of codes) {
    if (c in lookup) return { batchId: lookup[c], resolvedCode: c };
  }
  return null;
}

export type EnsureBatchOutcome =
  | { status: "invalid_pattern" }
  | { status: "existing_alias"; batchId: string; resolvedCode: string }
  | { status: "created"; batchId: string; resolvedCode: string; fields: DerivedBatchFields }
  | { status: "race_lost_to_sibling"; batchId: string; resolvedCode: string; fields: DerivedBatchFields };

/**
 * Ensure a batch exists for `primaryCode`, auto-creating it from the template when
 * it is a genuinely-new, pattern-valid code. `lookup` is MUTATED in place with the
 * resolved code(s) → batchId so a later call in the SAME apply pass (a second row
 * naming the same brand-new batch) resolves via `existing_alias` without another
 * DB round trip. Returns:
 *   - `invalid_pattern`      → caller keeps the existing unmapped/hold behavior.
 *   - `existing_alias`       → `lookup` already had this code (or a month-prefix
 *     alias of it) — no write, just the resolved id.
 *   - `created`              → this call created the batch (write the audit log +
 *     the info finding).
 *   - `race_lost_to_sibling` → the code existed by the time the upsert ran (a
 *     PARALLEL writer lane created it a moment earlier this same run) — the batch
 *     is there; this call was not the creator (no duplicate audit entry).
 */
export async function ensureBatch(
  db: DbClient,
  primaryCode: string | null | undefined,
  blockLoc: string | null | undefined,
  lookup: Record<string, string>,
): Promise<EnsureBatchOutcome> {
  if (!primaryCode) return { status: "invalid_pattern" };

  const existing = resolveAgainstLookup(primaryCode, lookup);
  if (existing) {
    lookup[primaryCode] = existing.batchId;
    return { status: "existing_alias", batchId: existing.batchId, resolvedCode: existing.resolvedCode };
  }

  if (!isPatternValidBatchCode(primaryCode)) return { status: "invalid_pattern" };

  const fields = deriveBatchFields(primaryCode, blockLoc);
  const res = await db.upsertBatchIfAbsent(fields as unknown as Record<string, unknown>);

  // Seed the lookup with EVERY alias (primary + regenerated fallbacks) so a sibling
  // row referencing the same batch under a different month-prefix convention
  // resolves without another round trip.
  for (const c of [primaryCode, ...batchCodeFallbacks(primaryCode)]) lookup[c] = res.id;

  return res.created
    ? { status: "created", batchId: res.id, resolvedCode: primaryCode, fields }
    : { status: "race_lost_to_sibling", batchId: res.id, resolvedCode: primaryCode, fields };
}

/** A note describing one auto-created batch — carried on the apply result (info
 *  finding) and used to build the batches-table audit log comment. NEVER a ₱/cost. */
export interface AutoCreatedBatchNote {
  batch_code: string;
  location_ref: string;
  /** gsheet only — which tab produced the row. Absent for the PROPOSED rc_out lane. */
  mode?: "rc_in" | "rc_out";
  transaction_date: string | null;
  block_loc: string | null;
  source_row: string | number | null;
}

/** Plain-English provenance comment for the `batches` audit_logs row (requirement 3). */
export function autoCreateAuditComment(args: {
  source: string; // e.g. "gsheet (RC IN)" | "rc_out (PROPOSED DAILY REPORT)"
  runTs: string;
  sourceRow: string | number | null;
}): string {
  return (
    `provenance=auto-create | Batch auto-created by the sync (pattern-valid unknown ` +
    `batch code policy, 2026-07-11) from ${args.source}` +
    (args.sourceRow != null ? `, row ${args.sourceRow}` : "") +
    ` on ${args.runTs}.`
  );
}

/** Plain-English progress/finding message (requirement 4) — matches the exact
 *  format given in the spec: 'Auto-created batch JULY-26-BLK6 (C-11A) from Google
 *  Sheet RC IN row 1228'. */
export function autoCreateMessage(args: {
  batchCode: string;
  locationRef: string;
  source: string; // e.g. "Google Sheet RC IN" | "Proposed Daily Report (RC OUT)"
  sourceRow: string | number | null;
}): string {
  const rowPart = args.sourceRow != null ? ` row ${args.sourceRow}` : "";
  return `Auto-created batch ${args.batchCode} (${args.locationRef}) from ${args.source}${rowPart}`;
}
