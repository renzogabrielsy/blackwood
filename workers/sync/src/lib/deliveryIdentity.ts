/**
 * deliveryIdentity.ts — THE one definition of "is this the same physical delivery?"
 * (L-040b, 2026-08-08). Shared by BOTH writers of `deliveries`: the email pipeline
 * (`reports/deliveries/**`) and the Google Sheet pipeline (`reports/gsheet/**`). If the
 * two paths ever disagree about what "the same row" means, they duplicate each other's
 * rows — that is BUG-016 in a different costume — so neither is allowed its own copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE OLD KEY PRODUCED DUPLICATES
 * ─────────────────────────────────────────────────────────────────────────────
 * The identity used to be `(transaction_date, batch_code, block_loc, weight_kg)`.
 * The truck plate — the one fact that actually names the physical truckload — was NOT
 * in it, and THREE mutable, human-correctable facts were. So the instant anyone
 * corrected a batch code, a block or a weight, the sync stopped recognising the row and
 * INSERTED a second one. Two confirmed incidents (`audit_logs`, `deliveries_archive`):
 *
 *   - 2026-02-04 — the Sheet had the FEB-26-BLK4 / FEB-26-BLK5 truck assignment
 *     SWAPPED. Renzo corrected it in-app; the Sheet still said the old thing, so
 *     gsheet-sync inserted a second copy of both truckloads. Removed twice, back twice.
 *   - 2026-07-08 / 07-20 / 08-05 — the Sheet writes `JULY-26-FEED1`, MC's email writes
 *     `FEEDING # 1`. Different batch code → second row. Seven such rows archived
 *     and deleted on 2026-08-07 (L-040).
 *
 * A human-edit latch would NOT have stopped either: nothing was overwritten, the sync
 * INSERTED. The bug is the identity, not the write guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE: an identity may only be built from facts that DO NOT GET CORRECTED
 * ─────────────────────────────────────────────────────────────────────────────
 * TIER 1 (preferred) — `(transaction_date, normalized truck_plate, sacks)`
 *   The plate is stamped on the truck. Sacks are counted at the gate and are not
 *   revised. Weight IS revised (ASH / wet-sack deductions land after the gate), the
 *   batch code is a naming convention two sources spell differently, and the block is
 *   a yard decision that gets corrected — none of the three belong in an identity.
 *   MEASURED on the live table (2026-08-08): 1,545 of 1,688 deliveries carry both a
 *   plate and a sack count, and this key is UNIQUE across all 1,545 — ZERO collisions,
 *   raw or normalized. Normalizing collapses 224 raw plate spellings into 183 real
 *   trucks and introduces no new collision.
 *
 * TIER 2 (fallback) — the LEGACY key `(transaction_date, batch_code, block_loc,
 *   weight_kg)`, for the 143 rows that carry no plate (mostly feed deliveries) and any
 *   row with no sack count. They are NOT dropped and they do NOT collapse onto one key:
 *   measured, the legacy key is also unique across those 143.
 *
 * The tier is the FIRST segment of the key string (`T1|…` / `T2|…`), so a tier-1 row
 * can never accidentally match a tier-2 row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PROPERTIES THAT MAKE THIS SAFE TO SHIP
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **No new duplicates are possible.** A tier-1 row that misses on its tier-1 key
 *    falls back to the LEGACY tier-2 lookup (`legacyKey`). So the set of rows that
 *    match is a strict SUPERSET of what the old key matched — the change can only ever
 *    turn an insert into a match, never the reverse.
 * 2. **The wet-sack deduction split survives.** The yard routinely pulls over-moisture
 *    sacks off a load and books them separately: `2025-04-03 / KCA 378 /
 *    MARCH-25-BLK9 / D-8D`, 471 sacks and 36 sacks, BOTH 18,827 kg. Those two rows are
 *    the ONLY pair in the whole table that collides on the LEGACY key — the old
 *    identity called them one row (and would have happily UPDATEd one into the other),
 *    while tier 1 gives them two distinct keys because the sack counts differ.
 *
 * The corollary, and the reason `MUTABLE_IDENTITY_FIELDS` exists: the three fields that
 * left the identity MUST enter the field-by-field comparison, or a corrected batch code
 * would match and then read as a silent NOOP. And because they are exactly the fields a
 * human corrects, a disagreement on any of them is NEVER auto-applied — it is FLAGGED
 * for arbitration in Sync Review (CLAUDE.md → Sync Integrity: "Disagreements are never
 * auto-resolved").
 */
import { normBlockLoc, normNum, normIntTrunc } from "./norm.js";

/** The three facts that USED to be identity and are now compared instead. */
export const MUTABLE_IDENTITY_FIELDS = ["batch_code", "block_loc", "weight_kg"] as const;
export type MutableIdentityField = (typeof MUTABLE_IDENTITY_FIELDS)[number];

const MUTABLE_SET: ReadonlySet<string> = new Set(MUTABLE_IDENTITY_FIELDS);

/** True when `field` is one of the three formerly-key fields (a correctable fact). */
export function isMutableIdentityField(field: string): boolean {
  return MUTABLE_SET.has(field);
}

/**
 * Normalize a truck plate for COMPARISON: keep alphanumerics only, upper-case.
 * `"MAV 9202"`, `"mav9202"` and `"MAV-9202"` all become `"MAV9202"` — the same truck
 * spelled three ways in the real data. Byte-identical to the existing `_norm_truck` in
 * the L-033 guard layer (`parity_guards.py`), which is why the guard can keep using it.
 */
export function normPlate(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  let out = "";
  for (const ch of s.toUpperCase()) {
    if (/[0-9A-Z]/.test(ch)) out += ch;
  }
  return out;
}

/** `transaction_date` reduced to its `YYYY-MM-DD` head (a timestamp may arrive). */
function normDate10(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).slice(0, 10);
}

export type DeliveryIdentityTier = 1 | 2;

/** A row shape both the extract rows and the DB rows satisfy. */
export interface DeliveryIdentityRow {
  transaction_date?: unknown;
  batch_code?: unknown;
  block_loc?: unknown;
  weight_kg?: unknown;
  truck_plate?: unknown;
  sacks?: unknown;
}

export interface DeliveryIdentity {
  tier: DeliveryIdentityTier;
  /** The lookup string. `T1|…` and `T2|…` can never be equal. */
  key: string;
  /** The normalized components, for reporting/debugging (never for comparison). */
  parts: {
    date: string;
    plate: string | null;
    sacks: number | null;
    batch_code: string | null;
    block_loc: string | null;
    weight_kg: number | null;
  };
}

/**
 * TIER-1 eligibility: a non-blank normalized plate AND a present sack count.
 * Both are required — a plate alone is not an identity (one truck makes several trips),
 * and today ZERO rows carry a plate without sacks, so this clause costs nothing and
 * guarantees a future plate-only row can never collapse onto the truck.
 */
export function isTier1Eligible(row: DeliveryIdentityRow): boolean {
  return normPlate(row.truck_plate) !== "" && normIntTrunc(row.sacks) !== null;
}

/** The TIER-1 key: `T1|<date>|<plate>|<sacks>`. Null when the row is not eligible. */
export function tier1Key(row: DeliveryIdentityRow): string | null {
  if (!isTier1Eligible(row)) return null;
  return `T1|${normDate10(row.transaction_date)}|${normPlate(row.truck_plate)}|${normIntTrunc(row.sacks)}`;
}

/**
 * The TIER-2 / LEGACY key: `T2|<date>|<batch_code>|<block_loc>|<weight>`.
 * This is the OLD natural key verbatim (same normalizers, same fields) — which is what
 * makes it usable as the no-regression fallback. Always defined.
 */
export function legacyKey(row: DeliveryIdentityRow): string {
  const bc = row.batch_code === null || row.batch_code === undefined ? "" : String(row.batch_code);
  const bl = normBlockLoc(row.block_loc);
  const w = normNum(row.weight_kg, 3);
  return `T2|${normDate10(row.transaction_date)}|${bc}|${bl === null ? "" : bl}|${w === null ? "" : w}`;
}

/** The row's OWN identity — tier 1 when eligible, else the legacy tier-2 key. */
export function deliveryIdentity(row: DeliveryIdentityRow): DeliveryIdentity {
  const t1 = tier1Key(row);
  const parts = {
    date: normDate10(row.transaction_date),
    plate: normPlate(row.truck_plate) || null,
    sacks: normIntTrunc(row.sacks),
    batch_code: row.batch_code === null || row.batch_code === undefined ? null : String(row.batch_code),
    block_loc: normBlockLoc(row.block_loc),
    weight_kg: normNum(row.weight_kg, 3),
  };
  return t1 !== null ? { tier: 1, key: t1, parts } : { tier: 2, key: legacyKey(row), parts };
}

/**
 * The lookup index over a set of DB rows. Every row is registered under its legacy
 * (tier-2) key AND, when eligible, under its tier-1 key — so a tier-2 extract row can
 * still find a plated DB row, and a tier-1 extract row can still fall back to the
 * legacy key. Insertion order is preserved within each bucket (the classifiers take
 * `[0]`, exactly as they always have).
 */
export interface DeliveryIdentityIndex<T> {
  tier1: Map<string, T[]>;
  tier2: Map<string, T[]>;
}

export function buildDeliveryIdentityIndex<T extends DeliveryIdentityRow>(
  rows: readonly T[],
): DeliveryIdentityIndex<T> {
  const tier1 = new Map<string, T[]>();
  const tier2 = new Map<string, T[]>();
  for (const r of rows) {
    const t1 = tier1Key(r);
    if (t1 !== null) push(tier1, t1, r);
    push(tier2, legacyKey(r), r);
  }
  return { tier1, tier2 };
}

export interface IdentityMatch<T> {
  rows: T[];
  /** 1 = matched on the plate/sacks identity; 2 = matched on the legacy key. */
  matchedTier: DeliveryIdentityTier;
  key: string;
  /**
   * How many DB rows share the matched key. `> 1` on a TIER-1 match means the database
   * ALREADY holds more than one row for this one truckload — a duplicate that predates
   * this run. Measured on the live table 2026-08-08: zero such buckets, so this is a
   * dormant safety net; it fires on the July fixture snapshot, which was taken before
   * the 2026-08-07 cleanup and still contains the deleted copies.
   */
  peerCount: number;
}

/**
 * Resolve one extract row against the index. TIER-1 FIRST, then the LEGACY key —
 * that ordering is what makes the change strictly duplicate-reducing (see property 1
 * in the module header). Returns null when neither lookup hits (a genuine NEW row).
 */
export function matchDelivery<T extends DeliveryIdentityRow>(
  index: DeliveryIdentityIndex<T>,
  row: DeliveryIdentityRow,
): IdentityMatch<T> | null {
  const t1 = tier1Key(row);
  if (t1 !== null) {
    const hit = index.tier1.get(t1);
    if (hit && hit.length) return { rows: hit, matchedTier: 1, key: t1, peerCount: hit.length };
  }
  const lk = legacyKey(row);
  const hit2 = index.tier2.get(lk);
  if (hit2 && hit2.length) return { rows: hit2, matchedTier: 2, key: lk, peerCount: hit2.length };
  return null;
}

/**
 * The column list for the last-instant `db.insertIfAbsent` guard (BUG-016). Mirrors the
 * tier decision so the race guard cannot disagree with the classifier: a plated row
 * with a sack count is guarded on `(transaction_date, truck_plate, sacks)`, everything
 * else on the legacy five columns.
 *
 * CAVEAT, deliberately accepted: `insertIfAbsent` compares with PostgREST `eq.`, so the
 * plate is matched on its RAW spelling — `MAV 9202` will not find `MAV9202`. That makes
 * this guard slightly weaker than the classifier's normalized match, which is fine: the
 * classifier is the primary decision and this is only the within-run race backstop.
 * The key is still strictly NARROWER than the old five-column key, so it can only
 * suppress more duplicates, never fewer. A suppression is HELD (`already_exists`),
 * never silent.
 */
export function deliveriesInsertGuardColumns(row: DeliveryIdentityRow): string[] {
  if (isTier1Eligible(row)) return ["transaction_date", "truck_plate", "sacks"];
  return ["transaction_date", "batch_code", "block_loc", "weight_kg"];
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
