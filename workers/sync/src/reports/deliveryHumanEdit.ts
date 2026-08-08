/**
 * deliveryHumanEdit.ts — THE one way a refused delivery UPDATE becomes an operator-facing
 * note (the deliveries human-edit latch, 2026-08-08).
 *
 * Shared by BOTH writers of `deliveries`: the email pipeline (`reports/deliveries/**`) and
 * the Google Sheet pipeline (`reports/gsheet/**`), for the same reason
 * `lib/deliveryIdentity.ts` is shared — if the two paths described the same refusal
 * differently, a Sheet refusal and an email refusal would read as two unrelated problems.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REFUSAL MUST BE LOUD
 * ─────────────────────────────────────────────────────────────────────────────
 * The DB now refuses to overwrite a delivery a human corrected. A refusal that nobody is
 * told about is a NEW silence: the source still says the old thing, so the sync would
 * quietly decline the same write on every run, forever, and the operator would never learn
 * that their correction and the Sheet disagree. Both sources are CUMULATIVE, so nothing is
 * parked in the DB — the note is rebuilt from the source every run and keeps re-firing
 * until the human either fixes the source or hands the row back with
 * `fn_release_delivery_rows`. That is the project rule ("disagreements are never
 * auto-resolved — the human arbitrates them"), applied to the one table that had a LIVE
 * unguarded writer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ₱ SAFETY — THE ONE THING THAT MAKES THIS FILE MORE THAN A MAPPER
 * ─────────────────────────────────────────────────────────────────────────────
 * `cost_basis` IS one of the nine fields the latch can refuse, and the run-findings channel
 * is NOT price-gated (it feeds the Sync panel, the Excel report and the digest without a
 * `canViewPrices()` check anywhere). So a refused price must appear by NAME ONLY.
 *
 * `formatFindingData`'s cost-key strip cannot save us here: it skips a top-level key whose
 * NAME looks cost-ish, and these values would be nested inside a `changed_fields` value
 * whose own key is `changed_fields`. The strip therefore has to happen HERE, where the note
 * is built, before anything leaves the worker process. `REDACTED_FIELDS` is that list, and
 * `deliveryHumanEditNote` is the only constructor — build a note any other way and the
 * redaction is not applied.
 */
import type { DeliveryIdentityRow } from "../lib/deliveryIdentity.js";

/** `yours` = what the app holds, `sheet` = what the source says. */
export interface DeliveryHumanEditField {
  field: string;
  yours: unknown;
  sheet: unknown;
  /** True when the VALUES were withheld and only the field name is reported. */
  redacted?: boolean;
}

/** One delivery the DB refused to let the sync overwrite. Mirrors `app/(app)/sync/types.ts::DeliveryHumanEdit`. */
export interface DeliveryHumanEdit {
  section: "deliveries" | "gsheet";
  table: string;
  record_id: string;
  transaction_date: string | null;
  supplier: string | null;
  batch_code: string | null;
  block_loc: string | null;
  truck_plate: string | null;
  changed_fields: DeliveryHumanEditField[];
  outcome: string;
}

/**
 * Fields whose VALUES may never ride the findings channel. Only ₱ today.
 * `lib/sync/findings.ts::isCostKey` is the canonical definition of "cost-ish" for a
 * key NAME; this is the deliberately tiny, explicit column list for the one shape that
 * definition cannot reach. Keep them in agreement.
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set(["cost_basis"]);

/** A row shape both extract rows and DB rows satisfy (identity fields + supplier). */
export interface DeliveryNoteRow extends DeliveryIdentityRow {
  supplier?: unknown;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

/**
 * Build the note for ONE refused delivery.
 *
 * `row` supplies the identity the operator recognises (date · supplier · batch · block ·
 * plate). `diff` is the classifier's own field list; each entry needs a `field` plus the
 * two sides under whichever names that pipeline uses, which is why the caller passes them
 * already normalized to `{ field, yours, sheet }`.
 *
 * `outcome` is always `refused_by_db`: the guard lives in the UPDATE's own WHERE, so the
 * database is literally what declined the write.
 */
export function deliveryHumanEditNote(
  section: "deliveries" | "gsheet",
  recordId: string,
  row: DeliveryNoteRow | null | undefined,
  diff: readonly DeliveryHumanEditField[],
): DeliveryHumanEdit {
  const r = row ?? {};
  return {
    section,
    table: "deliveries",
    record_id: recordId,
    transaction_date: str(r.transaction_date)?.slice(0, 10) ?? null,
    supplier: str(r.supplier),
    batch_code: str(r.batch_code),
    block_loc: str(r.block_loc),
    truck_plate: str(r.truck_plate),
    changed_fields: diff.map((f) =>
      REDACTED_FIELDS.has(f.field)
        ? { field: f.field, yours: null, sheet: null, redacted: true }
        : { field: f.field, yours: f.yours, sheet: f.sheet },
    ),
    outcome: "refused_by_db",
  };
}
