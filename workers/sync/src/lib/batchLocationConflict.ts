/**
 * batchLocationConflict.ts — ONE definition of "a new batch wanted a block that is
 * already taken", for every writer that creates a `batches` row (2026-08-25, BUG-027).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INCIDENT THIS EXISTS FOR (run afac05bd, 2026-08-25)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Sheet's one NEW RC IN row (2026-08-21, Ornales, 16,840 kg, TEMP138003) named the
 * brand-new pattern-valid batch `AUG-26-BLK11` at block `D-20D`. The auto-create policy
 * derived `location_ref = 'D-20D'` and `upsertBatchIfAbsent` INSERTed it — and the DB
 * refused with 23505 on the partial unique index `idx_unique_active_batch_per_location`,
 * because `JUNE-26-BLK6` is still IN-USE at D-20D with 4,680 kg (the yard finished it and
 * reused the block the same day; the Sheet's own Blocking tab reads ERROR at D-20D).
 *
 * Two things went wrong, and this module is half of the fix for both:
 *
 *   1. THE THROW ESCAPED THE APPLY AND KILLED THE WHOLE WRITE. `applyGsheet` caught it
 *      at the mode boundary, so the run reported `applied: {inserts: 0, updates: 0}`,
 *      the watermark never moved, and the other 13 updates were lost from the result —
 *      then every subsequent run re-failed identically. A block that two batches both
 *      claim is a HUMAN ARBITRATION, which this codebase has one shape for: a held row.
 *      It is never a fatal error. (Sync Integrity, CLAUDE.md: "disagreements are never
 *      auto-resolved — the human arbitrates them in the app".)
 *
 *   2. THE RAW POSTGRES ERROR WAS THE HEADLINE. The panel showed, verbatim,
 *      `rc_in apply: upsert_batch_if_absent batches failed 23505: duplicate key value
 *      violates unique constraint "idx_unique_active_batch_per_location"` — which names
 *      neither batch, neither block, nor anything the operator could do. So the message
 *      is built HERE, once, in the words a person would use, and the raw error rides in
 *      the held row's structured `row.db_error` for the Copy button and the Excel report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE MODULE (the seam)
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE writers create a `batches` row and all three could hit this 23505:
 *   - `lib/batchAutoCreate.ts::ensureBatch` → the gsheet UNMAPPED lane AND the rc_out
 *     UNMAPPED lane (the auto-create policy path — this is the one that crashed).
 *   - `reports/gsheet/apply.ts` NEW rc_in rows → its own defensive `db.insert("batches")`.
 *   - `reports/deliveries/apply.ts` NEW rows   → the email path's defensive insert.
 * Putting the catch only in `ensureBatch` would leave the other two writing their own
 * (already divergent) sentence, and `isLocationCollision` was ALREADY duplicated
 * byte-for-byte in the last two. One module, one predicate, one lookup, one message —
 * so the four call sites cannot drift about what the conflict is or how it reads.
 *
 * NEVER a ₱/cost field: held rows are shown to every privileged role and fed to the
 * adjudicator's lookup. `current_weight` is kilograms, `avg_cost` is deliberately absent.
 */
import type { DbClient } from "./db.js";
import { fmtKg } from "../reports/held.js";

/**
 * The batch statuses the partial unique index `idx_unique_active_batch_per_location`
 * covers — i.e. what "active in a block" means to the DB. A CLOSED (or FEED) batch may
 * sit at the same `location_ref` without conflicting, so the occupant lookup must filter
 * on exactly this set or it would name the wrong batch.
 */
const ACTIVE_BATCH_STATUSES = new Set(["STORED", "IN-USE", "SUNDRYING", "SUNDRIED"]);

/**
 * `orchestrator_common.is_location_collision` (SHARED.md §3.4) — THE definition.
 * A unique-violation (23505) on the active-batch-per-location index. Was duplicated
 * verbatim in gsheet/apply.ts and deliveries/apply.ts; both now import this.
 */
export function isLocationCollision(e: unknown): boolean {
  const s = e instanceof Error ? e.message : String(e);
  return (
    s.includes("23505") &&
    (s.includes("idx_unique_active_batch_per_location") || s.includes("location_ref"))
  );
}

/** Who currently holds the block. Kilograms and dates only — never a ₱/cost field. */
export interface LocationOccupant {
  batch_code: string;
  status: string | null;
  /** `batches.current_weight` — what is still sitting in the block. */
  current_weight_kg: number | null;
  /** The occupant's most recent `rc_out.transaction_date`, or null if it was never fed. */
  last_fed_date: string | null;
}

/** Both sides of the conflict + the raw refusal, as one structured fact. */
export interface BatchLocationConflict {
  /** The batch the sync tried to create. */
  attempted_batch_code: string;
  /** The block it wanted (the derived `location_ref`, i.e. the row's block_loc). */
  location_ref: string | null;
  /** Who is already there. NULL when the lookup found nobody (or itself failed). */
  occupant: LocationOccupant | null;
  /** The verbatim Postgres refusal. Carried for the Copy button — NEVER the headline. */
  db_error: string;
}

/**
 * Read who holds `locationRef` right now: the ACTIVE batch there, its balance, and the
 * last date anything was fed out of it. Two indexed selects, both read-only.
 *
 * NEVER throws — a conflict is already an unhappy path, and failing to describe it must
 * not turn a held row back into the crash this module exists to prevent. A failed lookup
 * simply yields `null`, and the message falls back to naming the block alone.
 */
export async function lookupLocationOccupant(
  db: DbClient,
  locationRef: string | null | undefined,
): Promise<LocationOccupant | null> {
  const loc = typeof locationRef === "string" ? locationRef.trim() : "";
  if (!loc) return null;
  try {
    // The index guarantees at most ONE active batch here, but CLOSED/FEED batches may
    // share the location_ref — so read the few rows at the block and filter in TS
    // (`readRows`'s extraFilters have no `in.` operator, and one small page is cheaper
    // than teaching it one).
    const rows = await db.readRows("batches", {
      sinceColumn: null,
      columns: ["id", "batch_code", "status", "current_weight"],
      extraFilters: { location_ref: `eq.${loc}`, limit: "20" },
    });
    const occupantRow = rows.find((r) => ACTIVE_BATCH_STATUSES.has(String(r.status ?? "")));
    if (!occupantRow) return null;

    let lastFed: string | null = null;
    const occupantId = occupantRow.id == null ? null : String(occupantRow.id);
    if (occupantId) {
      const fed = await db.readRows("rc_out", {
        sinceColumn: null,
        columns: ["transaction_date"],
        extraFilters: {
          batch_id: `eq.${occupantId}`,
          order: "transaction_date.desc",
          limit: "1",
        },
      });
      const d = fed[0]?.transaction_date;
      lastFed = d == null ? null : String(d).slice(0, 10);
    }

    const w = occupantRow.current_weight;
    const weight = typeof w === "number" ? w : w == null ? null : Number(w);
    return {
      batch_code: String(occupantRow.batch_code ?? ""),
      status: occupantRow.status == null ? null : String(occupantRow.status),
      current_weight_kg: weight != null && Number.isFinite(weight) ? weight : null,
      last_fed_date: lastFed,
    };
  } catch {
    // Deliberately swallowed — see the doc comment. The caller still gets a held row.
    return null;
  }
}

/** What the blocked row IS, so the closing sentence reads like the plant talks. */
export type ConflictRowNoun = "delivery" | "feeding";

/**
 * THE message. Plain language, both batch codes, the block, the balance, the last-fed
 * date, and the ACTION — no constraint name, no SQLSTATE, no ₱.
 *
 * Pure, so the exact sentence is testable without a database.
 */
export function batchLocationConflictDetail(
  c: BatchLocationConflict,
  rowNoun: ConflictRowNoun = "delivery",
): string {
  const block = c.location_ref || "that block";
  const tail = `and the next run will file this ${rowNoun}.`;
  if (!c.occupant || !c.occupant.batch_code) {
    return (
      `New batch ${c.attempted_batch_code} wants block ${block}, but another batch is still ` +
      `marked active there, so it was not created and this ${rowNoun} was not saved. ` +
      `Check which batch owns ${block} — if that block is finished, close it ${tail}`
    );
  }
  const held = c.occupant.batch_code;
  const kg = c.occupant.current_weight_kg;
  const balance = kg == null ? "" : ` with ${fmtKg(kg)} kg left`;
  const fed = c.occupant.last_fed_date ? ` (last fed ${c.occupant.last_fed_date})` : "";
  return (
    `New batch ${c.attempted_batch_code} wants block ${block}, but ${held} is still marked ` +
    `active there${balance}${fed}. If that block is finished, close ${held} ${tail}`
  );
}

/**
 * The structured held-row payload for the conflict. Merged over the report's own
 * `row` fields by the caller, so the adjudicator keeps the date/truck/weight it already
 * had AND gains both sides of the clash. NEVER a ₱/cost field.
 */
export function batchLocationConflictRow(c: BatchLocationConflict): Record<string, unknown> {
  return {
    attempted_batch_code: c.attempted_batch_code,
    location_ref: c.location_ref,
    occupying_batch_code: c.occupant?.batch_code ?? null,
    occupying_status: c.occupant?.status ?? null,
    occupying_balance_kg: c.occupant?.current_weight_kg ?? null,
    occupying_last_fed: c.occupant?.last_fed_date ?? null,
    // The raw Postgres refusal, for the Copy button and the Excel report's Side B cell.
    // It lives HERE and never in the title/reason — that is the whole point (2026-08-25).
    db_error: c.db_error,
  };
}

/**
 * Turn a caught 23505 into the full structured conflict: look up who holds the block,
 * keep the raw refusal. Never throws (see `lookupLocationOccupant`).
 */
export async function describeBatchLocationConflict(
  db: DbClient,
  attemptedBatchCode: string,
  locationRef: string | null | undefined,
  err: unknown,
): Promise<BatchLocationConflict> {
  const loc = typeof locationRef === "string" && locationRef.trim() ? locationRef.trim() : null;
  return {
    attempted_batch_code: attemptedBatchCode,
    location_ref: loc,
    occupant: await lookupLocationOccupant(db, loc),
    db_error: err instanceof Error ? err.message : String(err),
  };
}
