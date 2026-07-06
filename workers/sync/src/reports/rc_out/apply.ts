/**
 * apply.ts — TS port of sync_rc_out.py::phase_apply (read the Python as spec).
 *
 * Behavioral law: workers/sync/specs/rc_out.md §5.
 *   1. Gate re-check: any gate_failures → write NOTHING, ok:false, held=one/gate,
 *      errors=one/gate. This travels with the classified/compact object.
 *   2. NEW → insert_if_absent("rc_out", natural_key=(transaction_date,batch_id,
 *      destination)), then write_ingestion_audit (rc_out has NO trigger).
 *   3. VALUE_CHANGED → db.update(...), then write_ingestion_audit (UPDATE).
 *   4. flagged/unmapped/malformed → held, never written.
 *   5. Label + watermark ONLY if `not errors`.
 *
 * DB writes go through lib/db (DbClient). Gmail labeling is injected as a callback
 * (deps.labeler) — apply NEVER imports gmail (scope fence). Progress via lib/progress.
 */
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import type { FieldDiff } from "./classify.js";
import type { ProposedRow } from "./extract.js";
import { type HeldRow, type HeldKind, rcOutKey } from "../held.js";

/**
 * A single drifted date threaded onto a gate failure so the app's adjudicator can
 * NAME the exact day + both numbers instead of saying "some dates". Built in index.ts
 * from the reconciler's `drift_dates`. NO ₱/cost field — pure kg totals.
 *   - proposed_vs_movement_drift_500kg → {date, proposed_kg, movement_kg, diff_kg[, note]}
 *   - db_vs_movement_duplication (O>M)  → {date, db_sum_kg, movement_kg, excess_kg}
 */
export interface GateDriftDate {
  date: string;
  /** PROPOSED (daily report) total kg for the day. */
  proposed_kg?: number | null;
  /** RC MOVEMENT (movement sheet) total kg for the day. */
  movement_kg?: number | null;
  /** proposed − movement (the disagreement), signed. */
  diff_kg?: number | null;
  /** rc_out DB sum for the day (O>M duplication case). */
  db_sum_kg?: number | null;
  /** db_sum − movement excess (O>M duplication case). */
  excess_kg?: number | null;
  /** e.g. "no movement entry" when the movement sheet has no row for the day. */
  note?: string;
}

/** A gate failure, optionally carrying the specific drifted dates for the adjudicator. */
export interface GateFailureDetail {
  gate: string;
  detail: string;
  /** The specific dates that drove the halt (date + both totals). */
  drift_dates?: GateDriftDate[];
}

/** The compact hand-off from classify → apply (sync_rc_out.py compact object). */
export interface RcOutCompact {
  report_type: string;
  since: string;
  watermark: string | null;
  gate_failures: GateFailureDetail[];
  source: { email_subject?: string | null; email_uid?: number | string | null; email_thread_id?: string | null };
  actionable: {
    new: Array<{ index: unknown; row: ProposedRow }>;
    changed: Array<{ index: unknown; row: ProposedRow; db_row: Record<string, unknown>; diff: FieldDiff[] }>;
    /** `row` carried through so held rows get a human label + structured payload. */
    flagged: Array<{ index: unknown; reason?: string; row?: ProposedRow }>;
    unmapped: Array<{ index: unknown; reason?: string; row?: ProposedRow }>;
    malformed: Array<{ index?: unknown; reason?: string; row?: ProposedRow }>;
  };
  batch_lookup?: Record<string, string>;
}

export interface ApplyDeps {
  db: DbClient;
  /** Injected Gmail labeler (deps, not a direct import). Return true iff labeled. */
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  progress?: ProgressEmitter;
  /** Suppress labeling (mirrors --no-label). */
  noLabel?: boolean;
  /** RUN timestamp string for provenance comments (mirrors oc.RUN_TS). */
  runTs?: string;
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
  gate_failures?: GateFailureDetail[];
}

const REPORT_TYPE = "rc_out";

/** The rc_out structured held-row payload (no ₱/cost — rc_out carries none). */
function rcOutHeldRow(r: ProposedRow): Record<string, unknown> {
  return {
    transaction_date: r.transaction_date,
    batch_code: r.batch_code_resolved ?? r.batch_code_primary ?? null,
    batch_id: r.batch_id ?? null,
    destination: r.destination ?? "MAIN",
    weight_kg: r.weight_kg ?? r.day_total_kg ?? null,
    production_batch: r.production_batch ?? null,
    block_loc: r.block_loc ?? null,
  };
}

function prov(runTs: string, index: unknown, extra = ""): string {
  const base =
    `provenance=rc_out-sync | Ingested by sync_rc_out.py (lean orchestrator) ` +
    `row ${index} on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
}

/** Port of phase_apply. Returns the apply envelope; ok:false iff errors or a gate tripped. */
export async function applyRcOut(compact: RcOutCompact, deps: ApplyDeps): Promise<ApplyResult> {
  const { db } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const held: ApplyResult["held"] = [];
  const errors: string[] = [];

  // HARD gate re-check (sync_rc_out.py:232-241): write NOTHING.
  const gateFailures = compact.gate_failures ?? [];
  if (gateFailures.length) {
    await emit?.("finalize", "A safety check tripped earlier — writing nothing.", 100, undefined, "warn");
    return {
      report_type: REPORT_TYPE,
      ok: false,
      inserts: 0,
      updates: 0,
      held: gateFailures.map((g): HeldRow => ({
        reason: g.gate,
        natural_key: g.gate,
        detail: g.detail,
        kind: "gate_failure",
        // Thread the specific drifted dates onto the held row so the app adjudicator
        // can name the exact day + both numbers (no ₱/cost — pure kg totals).
        ...(g.drift_dates && g.drift_dates.length
          ? { row: { gate: g.gate, drift_dates: g.drift_dates } }
          : {}),
      })),
      labeled: false,
      watermark_updated: false,
      errors: gateFailures.map((g) => `HARD gate tripped: ${g.gate} — nothing written.`),
      gate_failures: gateFailures,
    };
  }

  let inserts = 0;
  let updates = 0;
  const newRows = compact.actionable.new;
  const chgRows = compact.actionable.changed;
  const totalWrites = Math.max(1, newRows.length + chgRows.length);
  const writeBatch = Math.max(1, Math.ceil(totalWrites / 10));
  let done = 0;
  await emit?.("apply", `Writing ${newRows.length} new and ${chgRows.length} changed feeding row(s)…`, 10);

  // NEW → INSERT (idempotent L-020), manual audit via RPC.
  for (const item of newRows) {
    const r = item.row;
    if (!r.batch_id) {
      held.push({
        reason: "unresolved_batch_id",
        natural_key: rcOutKey(r),
        detail: "NEW rc_out without resolved batch_id",
        kind: "unresolved_batch_id",
        row: rcOutHeldRow(r),
        source_index: item.index as string | number,
      });
      continue;
    }
    const payload = {
      transaction_date: r.transaction_date,
      batch_id: r.batch_id,
      destination: r.destination || "MAIN",
      weight_kg: r.weight_kg,
      remarks: r.remarks ?? null,
      block_loc: r.block_loc ?? null,
      production_batch: r.production_batch ?? null,
    };
    try {
      const res = await db.insertIfAbsent("rc_out", [payload], [
        "transaction_date",
        "batch_id",
        "destination",
      ]);
      if (res.insertedCount === 0) {
        held.push({
          reason: "already_exists",
          natural_key: rcOutKey(r),
          detail: "idempotent skip (natural key already in DB)",
          kind: "already_exists",
          row: rcOutHeldRow(r),
          source_index: item.index as string | number,
        });
        continue;
      }
      const newId = res.inserted[0].id as string;
      inserts += 1;
      await db.writeIngestionAudit({
        tableName: "rc_out",
        recordId: newId,
        operation: "INSERT",
        comment: prov(runTs, item.index),
        snapshot: payload,
      });
      done += 1;
      if (done % writeBatch === 0 || done === totalWrites) {
        await emit?.(
          "apply",
          `Writing ${done} of ${totalWrites} — ${r.weight_kg}kg fed ${r.transaction_date}`,
          10 + Math.trunc((75 * done) / totalWrites),
        );
      }
    } catch (exc) {
      errors.push(`insert row ${item.index}: ${errMsg(exc)}`);
    }
  }

  // VALUE_CHANGED → UPDATE, manual audit.
  for (const c of chgRows) {
    try {
      const patch: Record<string, unknown> = {};
      for (const d of c.diff ?? []) patch[d.field] = d.emailValue;
      if (!Object.keys(patch).length) continue;
      await db.update("rc_out", { id: `eq.${c.db_row.id}` }, patch);
      updates += 1;
      done += 1;
      if (done % writeBatch === 0 || done === totalWrites) {
        await emit?.(
          "apply",
          `Writing ${done} of ${totalWrites} — updating a feeding row`,
          10 + Math.trunc((75 * done) / totalWrites),
        );
      }
      const diffJson: Record<string, { old: unknown; new: unknown }> = {};
      for (const d of c.diff) diffJson[d.field] = { old: d.dbValue, new: d.emailValue };
      await db.writeIngestionAudit({
        tableName: "rc_out",
        recordId: c.db_row.id as string,
        operation: "UPDATE",
        comment: prov(runTs, c.index, "UPDATE"),
        diff: diffJson,
      });
    } catch (exc) {
      errors.push(`update ${c.index}: ${errMsg(exc)}`);
    }
  }

  // flagged / unmapped / malformed → held, never auto-written.
  const buckets: Array<[keyof RcOutCompact["actionable"], string]> = [
    ["flagged", "flagged"],
    ["unmapped", "unmapped_batch_code"],
    ["malformed", "malformed"],
  ];
  for (const [bucket, reason] of buckets) {
    for (const f of compact.actionable[bucket] ?? []) {
      const item = f as { index?: unknown; reason?: string; row?: ProposedRow };
      const row = item.row;
      // Refine the kind: a "flagged" bucket entry whose classifier reason is the
      // L-019 sub-watermark guard is the settled-date suspected-dup case; the
      // "unmapped" bucket is always an unmapped batch_code; else malformed/flagged.
      let kind: HeldKind;
      if (bucket === "unmapped") kind = "unmapped_batch_code";
      else if (bucket === "malformed") kind = "malformed";
      else if ((item.reason ?? "").startsWith("sub-watermark NEW"))
        kind = "sub_watermark_suspected_dup";
      else kind = "flagged";

      held.push({
        reason,
        natural_key: row ? rcOutKey(row) : String(item.index ?? ""),
        detail: item.reason ?? "requires human decision — never auto-written",
        kind,
        ...(row ? { row: rcOutHeldRow(row) } : {}),
        source_index: item.index as string | number,
      });
    }
  }

  // Label + watermark ONLY if not errors (sync_rc_out.py:306-315).
  let watermarkUpdated = false;
  let labeled = false;
  if (!errors.length) {
    await emit?.("apply", "Updating the audit trail…", 90);
    watermarkUpdated = await db.upsertIngestionWatermark(REPORT_TYPE, {
      lastEmailId: compact.source?.email_thread_id ?? null,
    });
    if (!deps.noLabel && deps.labeler) {
      const uid = compact.source?.email_uid;
      if (uid) {
        await emit?.("apply", "Marking the email as processed…", 95);
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
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
