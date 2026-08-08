/**
 * apply.ts — TS port of sync_deliveries.py::phase_apply (read the Python as spec).
 * Behavioral law: specs/deliveries.md §5.
 *
 *   1. NEW → defensive batch upsert (only if the resolved batch_code doesn't already
 *      exist), catching a location collision → held(reason:"location_occupied"),
 *      NEVER auto-creating a batch beyond the already-resolved code (L-006: the trigger
 *      owns current_weight — we insert current_weight=0 and never `+=`).
 *   2. deliveries INSERT via insert_if_absent, natural key
 *      (transaction_date, batch_code, truck_plate, weight_kg, sacks). 0 inserted → held.
 *   3. On insert: stampIngestionAudit — L-001 (deliveries fires an audit TRIGGER on
 *      INSERT; we UPDATE that row's provenance, never INSERT a 2nd). cost_basis is the
 *      real value OR 0 placeholder (L-008) with the placeholder note in the comment.
 *   4. VALUE_CHANGED → db.update, then stampIngestionAudit; if stamping returns false
 *      (no trigger row found), fall back to writeIngestionAudit (manual audit).
 *   5. FLAGGED (decision skip) + MALFORMED → held, never auto-written. dup_noops are
 *      silent NOOPs (like noop) — not in the write buckets.
 *   6. Label + watermark ONLY if `not errors`.
 *
 * DB via lib/db (DbClient). Gmail labeling injected as a callback (deps.labeler) —
 * apply NEVER imports gmail (scope fence). Progress via lib/progress.
 */
import type { DbClient } from "../../lib/db.js";
import { deliveriesInsertGuardColumns } from "../../lib/deliveryIdentity.js";
import { type DeliveryHumanEdit, deliveryHumanEditNote } from "../deliveryHumanEdit.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import type { DeliveryRow, LabResults } from "./extract.js";
import type { FieldDiff } from "./classify.js";
import type { PriceNote } from "./enrich.js";
import { type HeldRow, type HeldKind, deliveriesKey } from "../held.js";

/**
 * One delivery still carrying the L-008 unpriced placeholder more than a day after it
 * happened. Projected straight off `public.view_digest_unpriced_deliveries`, which owns
 * the ONE definition of "unpriced" and "overdue" — nothing here re-derives it.
 *
 * NEVER a ₱ field: every row in this list has cost_basis = 0 by construction, so there
 * is no price to carry, and the run-findings channel is not price-gated.
 */
export interface UnpricedOverdue {
  id: string;
  transaction_date: string;
  supplier: string | null;
  batch_code: string | null;
  truck_plate: string | null;
  weight_kg: number | null;
  sacks: number | null;
  /** operational_date − transaction_date, in days. Always ≥ 2 for an overdue row. */
  days_pending: number;
}

/** The compact hand-off from classify → apply. */
export interface DeliveriesCompact {
  report_type: string;
  since: string;
  watermark: string | null;
  source: {
    email_subject?: string | null;
    email_uid?: number | string | null;
    email_thread_id?: string | null;
  };
  actionable: {
    new: Array<{ index: unknown; row: DeliveryRow; notes?: string[] }>;
    changed: Array<{ index: unknown; row: DeliveryRow; db_row: Record<string, unknown>; diff: FieldDiff[] }>;
    flagged: Array<{ kind: string; index: unknown; reason?: string; decision?: string; row?: DeliveryRow }>;
    dup_noops: Array<{ index: unknown; note?: string }>;
    malformed: Array<{ reason?: string; row?: DeliveryRow }>;
  };
  batch_codes?: string[];
}

export interface DeliveriesApplyDeps {
  db: DbClient;
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
  /** --only-clean semantics: FLAGGED (decision skip) → held when true (default true). */
  onlyClean?: boolean;
}

export interface ApplyResult {
  report_type: string;
  ok: boolean;
  inserts: number;
  updates: number;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  /**
   * Everything the PRICE step wants a human to see: a tab it could not resolve, a
   * fuzzy match it accepted (with both spellings), a match that landed outside the
   * supplier's usual range. ALWAYS present (default []). Filled by `runReport`, not by
   * `applyDeliveries` — enrichment happens before apply — and folded into the run
   * findings by `lib/sync/findings.ts`, so it outlives the progress feed.
   */
  price_notes: PriceNote[];
  /**
   * Deliveries still unpriced more than a day after they happened. ALWAYS present
   * (default []). Also filled by `runReport`.
   */
  unpriced_overdue: UnpricedOverdue[];
  /**
   * Deliveries the DB refused to let this run overwrite because a human owns them (the
   * human-edit latch). ALWAYS present (default []). Rebuilt from the source every run —
   * nothing is parked — so it re-fires until the operator fixes the report or releases
   * the row. Carries no ₱ value (see `reports/deliveryHumanEdit.ts`).
   */
  delivery_human_edits: DeliveryHumanEdit[];
}

const REPORT_TYPE = "deliveries";

/** The deliveries structured held-row payload. NEVER includes cost_basis (₱ gate). */
function deliveriesHeldRow(r: DeliveryRow): Record<string, unknown> {
  return {
    transaction_date: r.transaction_date,
    batch_code: r.batch_code ?? null,
    block_loc: r.block_loc ?? null,
    truck_plate: r.truck_plate ?? null,
    weight_kg: r.weight_kg ?? null,
    sacks: r.sacks ?? null,
  };
}

/** Map a deliveries flagged classifier `kind` → the normalized HeldKind. */
function deliveriesFlaggedKind(kind: string): HeldKind {
  if (kind === "L033_cross_batch_loc_mismatch") return "cross_batch_reassignment";
  if (kind === "L004_block_loc_correction") return "cross_batch_reassignment";
  // L-040b — the same truckload under a corrected batch_code / block_loc / weight_kg.
  // Reuses the existing kind (HeldKind is frontend-locked; no new value invented).
  if (kind === "L040_identity_diff") return "cross_batch_reassignment";
  if (kind === "low_confidence") return "low_confidence";
  return "flagged";
}

function prov(runTs: string, index: unknown, extra = ""): string {
  const base =
    `provenance=deliveries-sync | Ingested by sync_deliveries.py (lean orchestrator) ` +
    `row ${index} on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
}

/** Local is_location_collision (orchestrator_common.is_location_collision parity):
 *  a unique-violation (23505) on the active-batch-per-location index. */
function isLocationCollision(e: unknown): boolean {
  const s = e instanceof Error ? e.message : String(e);
  return (
    s.includes("23505") &&
    (s.includes("idx_unique_active_batch_per_location") || s.includes("location_ref"))
  );
}

/** Port of phase_apply. ok:false iff any errors. */
export async function applyDeliveries(
  compact: DeliveriesCompact,
  deps: DeliveriesApplyDeps,
): Promise<ApplyResult> {
  const { db } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const onlyClean = deps.onlyClean ?? true;
  const held: ApplyResult["held"] = [];
  const errors: string[] = [];
  const humanEdits: DeliveryHumanEdit[] = [];

  let inserts = 0;
  let updates = 0;
  const newRows = compact.actionable.new;
  const chgRows = compact.actionable.changed;
  const totalWrites = Math.max(1, newRows.length + chgRows.length);
  const writeBatch = Math.max(1, Math.ceil(totalWrites / 10));
  let done = 0;
  await emit?.("apply", `Writing ${newRows.length} new and ${chgRows.length} changed delivery row(s)…`, 10);

  // NEW → defensive batch upsert + deliveries INSERT + trigger-audit stamp (L-001).
  for (const item of newRows) {
    const r = item.row;
    const bc = r.batch_code;
    try {
      // Defensive batch upsert: only if the resolved batch_code doesn't already exist.
      if (bc) {
        const existing = await db.selectOne("batches", { batch_code: `eq.${bc}` }, "batch_code");
        if (!existing) {
          try {
            await db.insert("batches", [
              {
                batch_code: bc,
                location_ref: r.block_loc ?? "",
                status: "STORED",
                current_weight: 0,
                avg_cost: 0,
              },
            ]);
          } catch (bexc) {
            if (isLocationCollision(bexc)) {
              held.push({
                reason: "location_occupied",
                natural_key: deliveriesKey(r),
                detail:
                  `block_loc ${r.block_loc ?? null} already holds an active batch; ` +
                  `new batch ${bc} not created and this delivery was not written. ` +
                  `Resolve which batch owns this slot (close the prior batch or fix the ` +
                  `location) via the sync employee, then re-run.`,
                kind: "location_occupied",
                row: deliveriesHeldRow(r),
                source_index: item.index as string | number,
              });
              continue;
            }
            throw bexc;
          }
        }
      }

      const payload: Record<string, unknown> = {
        transaction_date: r.transaction_date,
        supplier: r.supplier ?? null,
        batch_code: bc,
        block_loc: r.block_loc ?? null,
        truck_plate: r.truck_plate ?? null,
        sacks: r.sacks ?? null,
        weight_kg: r.weight_kg,
        cost_basis: r.cost_basis !== null && r.cost_basis !== undefined ? r.cost_basis : 0, // L-008
        remarks: r.remarks ?? null,
        lab_results: (r.lab_results as LabResults | null) ?? null,
        true_weight_kg: r.true_weight_kg ?? null, // L-021
        deduction_note: r.deduction_note ?? null, // L-021
      };
      // L-040b — the race guard now mirrors the classifier's tier decision
      // (lib/deliveryIdentity.ts). Shared with reports/gsheet/apply.ts so the two
      // writers of `deliveries` cannot disagree about what "the same row" is.
      const res = await db.insertIfAbsent(
        "deliveries",
        [payload],
        deliveriesInsertGuardColumns(payload),
      );
      if (res.insertedCount === 0) {
        held.push({
          reason: "already_exists",
          natural_key: deliveriesKey(r),
          detail: "idempotent skip (natural key already in DB)",
          kind: "already_exists",
          row: deliveriesHeldRow(r),
          source_index: item.index as string | number,
        });
        continue;
      }
      const newId = res.inserted[0].id as string;
      inserts += 1;
      const note =
        r.cost_basis !== null && r.cost_basis !== undefined
          ? ""
          : "cost_basis=0 UNPRICED PLACEHOLDER (L-008) — deliveries pricing enrich pending.";
      await db.stampIngestionAudit({
        tableName: "deliveries",
        recordId: newId,
        comment: prov(runTs, item.index, note),
        snapshot: payload,
      });
      done += 1;
      if (done % writeBatch === 0 || done === totalWrites) {
        await emit?.(
          "apply",
          `Writing ${done} of ${totalWrites} — ${bc} @ ${r.block_loc ?? null}`,
          10 + Math.trunc((70 * done) / totalWrites),
        );
      }
    } catch (exc) {
      errors.push(`insert row ${item.index}: ${errMsg(exc)}`);
    }
  }

  // VALUE_CHANGED → CONDITIONAL update via fn_apply_delivery_upstream, then the
  // trigger-audit stamp (fallback manual).
  //
  // THE LATCH (2026-08-08). This used to be a bare `db.update("deliveries", {id}, patch)`,
  // so an emailed report could revert a correction an operator had made in the app. The
  // RPC carries `human_edited_at IS NULL` inside its OWN UPDATE, so a save that landed
  // between the classify read above and this call still wins and comes back
  // `human_edited`. There is no read-then-write on this path, and no advisory pre-check:
  // unlike production's (dormant) writer this one is live, so the RPC is always called for
  // a real diff and a refusal is therefore always visible.
  //
  // ONE op per delivery — ops are keyed off distinct `db_row.id`s from a per-row loop.
  const ops: Array<Record<string, unknown>> = [];
  const opMeta = new Map<
    string,
    { index: unknown; diff: FieldDiff[]; dbRow: Record<string, unknown> }
  >();
  for (const c of chgRows) {
    const patch: Record<string, unknown> = {};
    for (const d of c.diff ?? []) patch[d.field] = d.emailValue;
    if (!Object.keys(patch).length) continue;
    const id = String(c.db_row.id);
    ops.push({ id, patch });
    opMeta.set(id, { index: c.index, diff: c.diff ?? [], dbRow: c.db_row });
  }

  if (ops.length) {
    let outcomes: Array<{ id: string; outcome: string }> = [];
    try {
      outcomes = await db.applyDeliveryUpstream(ops);
    } catch (exc) {
      errors.push(`deliveries conditional update failed: ${errMsg(exc)}`);
    }
    for (const res of outcomes) {
      const meta = opMeta.get(res.id);
      if (!meta) continue;
      if (res.outcome === "human_edited") {
        // Identity from the DB row (what the app actually holds and the operator sees),
        // values from the classifier's own diff: `dbValue` is theirs, `emailValue` is the
        // report's.
        humanEdits.push(
          deliveryHumanEditNote(
            "deliveries",
            res.id,
            meta.dbRow,
            meta.diff.map((d) => ({ field: d.field, yours: d.dbValue, sheet: d.emailValue })),
          ),
        );
        continue;
      }
      if (res.outcome !== "applied") {
        // missing / empty_patch / unsupported_field / not_applied — nothing was written and
        // it is NOT a human-arbitration case, so it must surface as a real problem
        // (errors[] also blocks the watermark bump + the Gmail label).
        errors.push(`update ${meta.index}: not applied (${res.outcome})`);
        continue;
      }
      try {
        updates += 1;
        done += 1;
        if (done % writeBatch === 0 || done === totalWrites) {
          await emit?.(
            "apply",
            `Writing ${done} of ${totalWrites} — updating a delivery`,
            10 + Math.trunc((70 * done) / totalWrites),
          );
        }
        const diffJson: Record<string, { old: unknown; new: unknown }> = {};
        for (const d of meta.diff) diffJson[d.field] = { old: d.dbValue, new: d.emailValue };
        const stamped = await db.stampIngestionAudit({
          tableName: "deliveries",
          recordId: res.id,
          comment: prov(runTs, meta.index, `UPDATE diff=${JSON.stringify(diffJson)}`),
        });
        if (!stamped) {
          await db.writeIngestionAudit({
            tableName: "deliveries",
            recordId: res.id,
            operation: "UPDATE",
            comment: prov(runTs, meta.index, "UPDATE"),
            diff: diffJson,
          });
        }
      } catch (exc) {
        errors.push(`update ${meta.index}: ${errMsg(exc)}`);
      }
    }
  }

  for (const h of humanEdits) {
    await emit?.(
      "apply",
      `${h.transaction_date ?? "A delivery"}${h.truck_plate ? ` (${h.truck_plate})` : ""}: you ` +
        `edited this in the app, so the report's different value was NOT written — please ` +
        `confirm which is right.`,
      80,
      undefined,
      "warn",
    );
  }

  // FLAGGED (decision skip under --only-clean) + MALFORMED → held. dup_noops are
  // silent NOOPs (not written, not held — like the noop bucket).
  for (const f of compact.actionable.flagged ?? []) {
    if (onlyClean && (f.decision || "skip") === "skip") {
      const row = f.row;
      held.push({
        reason: f.kind,
        natural_key: row ? deliveriesKey(row) : String(f.index ?? ""),
        detail: f.reason ?? "requires human decision — never auto-written",
        kind: deliveriesFlaggedKind(f.kind),
        ...(row ? { row: deliveriesHeldRow(row) } : {}),
        source_index: f.index as string | number,
      });
    }
  }
  for (const m of compact.actionable.malformed ?? []) {
    const row = m.row;
    held.push({
      reason: "malformed",
      natural_key: row ? deliveriesKey(row) : "malformed row",
      detail: m.reason ?? "malformed row held",
      kind: "malformed",
      ...(row ? { row: deliveriesHeldRow(row) } : {}),
      ...(row?._source_row != null ? { source_index: row._source_row as string | number } : {}),
    });
  }

  // Label + watermark ONLY if not errors. non_held_unapplied = bool(errors) (spec §5).
  const nonHeldUnapplied = errors.length > 0;
  let watermarkUpdated = false;
  let labeled = false;
  if (!errors.length) {
    await emit?.("apply", "Updating the audit trail…", 88);
    watermarkUpdated = await db.upsertIngestionWatermark(REPORT_TYPE, {
      lastEmailId: compact.source?.email_thread_id ?? null,
    });
    if (!nonHeldUnapplied && !deps.noLabel && deps.labeler) {
      const uid = compact.source?.email_uid;
      if (uid) {
        await emit?.("apply", "Marking the email as processed…", 94);
        labeled = await deps.labeler([uid]);
      }
    }
  }

  if (errors.length) {
    await emit?.("finalize", `Finished with ${errors.length} problem(s) — see details.`, 100, undefined, "warn");
  } else if (inserts || updates) {
    await emit?.("finalize", `Done — ${inserts} new, ${updates} updated.`, 100);
  } else {
    await emit?.("finalize", "Done — nothing new to write.", 100);
  }

  return {
    report_type: REPORT_TYPE,
    ok: errors.length === 0,
    inserts,
    updates,
    held,
    labeled,
    watermark_updated: watermarkUpdated,
    errors,
    // Filled by runReport (enrichment runs before apply); defaults keep every other
    // caller and every hand-built test fixture valid.
    price_notes: [],
    unpriced_overdue: [],
    delivery_human_edits: humanEdits,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
