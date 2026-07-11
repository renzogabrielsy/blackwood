/**
 * apply.ts — TS port of sync_rc_out.py::phase_apply (read the Python as spec), extended
 * with DATE-SCOPED GATE QUARANTINE (2026-07-11 — see specs/rc_out.md "Gates & quarantine").
 *
 * Behavioral law: workers/sync/specs/rc_out.md §5.
 *   1. Quarantine check: a NEW/CHANGED row whose `transaction_date` is in
 *      `compact.quarantined_dates` is held (kind gate_failure, per-date drift detail
 *      attached), never written. Rows on every OTHER date write normally — a gate trip
 *      no longer halts the whole run (the old "write NOTHING" behavior over-blocked: a
 *      drift on stale history in the PROPOSED workbook used to freeze TODAY's feedings).
 *      A quarantined date with no actionable row this run still gets ONE summary held
 *      entry so the finding is never silently lost.
 *   2. NEW → insert_if_absent("rc_out", natural_key=(transaction_date,batch_id,
 *      destination)), then write_ingestion_audit (rc_out has NO trigger).
 *   3. VALUE_CHANGED → db.update(...), then write_ingestion_audit (UPDATE).
 *   4. flagged/unmapped/malformed → held, never written.
 *   5. Label + watermark whenever `not errors` — a quarantine hold is NOT an error (same
 *      precedent as flagged/unmapped/malformed): the email was genuinely processed, some
 *      rows just need a human decision. This preserves the CLEAN-or-DIFFS-PENDING
 *      invariant without blocking labeling/watermark on a partial hold.
 *
 * DB writes go through lib/db (DbClient). Gmail labeling is injected as a callback
 * (deps.labeler) — apply NEVER imports gmail (scope fence). Progress via lib/progress.
 */
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import type { FieldDiff } from "./classify.js";
import type { ProposedRow } from "./extract.js";
import { type HeldRow, type HeldKind, rcOutKey } from "../held.js";
import {
  ensureBatch,
  isPatternValidBatchCode,
  autoCreateAuditComment,
  autoCreateMessage,
  type AutoCreatedBatchNote,
} from "../../lib/batchAutoCreate.js";

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

/** A gate failure, optionally carrying the specific drifted dates for the adjudicator.
 *  Informational/run-summary only — see `QuarantinedDate` for the enforcement list apply
 *  actually reads. */
export interface GateFailureDetail {
  gate: string;
  detail: string;
  /** The specific dates that drove this gate's finding (date + both totals). */
  drift_dates?: GateDriftDate[];
}

/**
 * ONE transaction_date that a HARD gate found genuinely at risk to write — the DB is
 * either absent for that date or ALSO disagrees with the movement-sheet witness (see
 * index.ts::splitPvmDrift / dupDriftDates). apply holds every actionable row whose date
 * matches one of these, and writes everything else normally.
 */
export interface QuarantinedDate {
  date: string;
  /** Which gate flagged this date. */
  gate: string;
  detail: GateDriftDate;
}

/** The compact hand-off from classify → apply (sync_rc_out.py compact object). */
export interface RcOutCompact {
  report_type: string;
  since: string;
  watermark: string | null;
  /** Run-summary rollup, one entry per gate that found ANY quarantined date. */
  gate_failures: GateFailureDetail[];
  /** The enforcement list — apply holds any actionable row whose transaction_date
   *  appears here; every other date writes normally. Empty when no gate tripped (or the
   *  movement cross-check was unavailable this run). */
  quarantined_dates?: QuarantinedDate[];
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
  /** Batches auto-created this apply from a pattern-valid unmapped batch_code
   *  (2026-07-11 policy — see lib/batchAutoCreate.ts). Empty when none. */
  auto_created_batches: AutoCreatedBatchNote[];
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

/** Human-readable one-liner for a quarantined date's drift detail (used in the held
 *  row's `detail` field). Handles both gate flavors (P-vs-M drift, O-vs-M duplication). */
function driftLine(d: GateDriftDate): string {
  if (d.db_sum_kg != null || d.excess_kg != null) {
    return `${d.date}: DB ${d.db_sum_kg ?? "?"}kg vs movement ${d.movement_kg ?? "?"}kg (excess ${d.excess_kg ?? "?"}kg)`;
  }
  if (d.note) return `${d.date}: proposed ${d.proposed_kg ?? "?"}kg — ${d.note}`;
  return `${d.date}: proposed ${d.proposed_kg ?? "?"}kg vs movement ${d.movement_kg ?? "?"}kg (diff ${d.diff_kg ?? "?"}kg)`;
}

/** One held row's `detail` text, combining every gate that quarantined a given date. */
function quarantineDetailText(list: QuarantinedDate[]): string {
  return list.map((q) => `[${q.gate}] ${driftLine(q.detail)}`).join(" | ");
}

/**
 * Write ONE rc_out row exactly like the NEW loop does (insertIfAbsent + manual audit),
 * but as a standalone helper so the auto-create path (below) can reuse it without
 * disturbing the NEW loop's own progress-tick bookkeeping. `r.batch_id` must already
 * be resolved (the caller ensures this via `ensureBatch`).
 */
async function writeNewRcOutRow(
  db: DbClient,
  r: ProposedRow,
  index: unknown,
  runTs: string,
): Promise<
  | { ok: true; id: string }
  | { ok: false; reason: "already_exists" }
  | { ok: false; reason: "error"; message: string }
> {
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
    if (res.insertedCount === 0) return { ok: false, reason: "already_exists" };
    const newId = res.inserted[0].id as string;
    await db.writeIngestionAudit({
      tableName: "rc_out",
      recordId: newId,
      operation: "INSERT",
      comment: prov(runTs, index),
      snapshot: payload,
    });
    return { ok: true, id: newId };
  } catch (exc) {
    return { ok: false, reason: "error", message: errMsg(exc) };
  }
}

/**
 * Port of phase_apply, extended with date-scoped quarantine (specs/rc_out.md "Gates &
 * quarantine"). Returns the apply envelope; `ok` reflects write SUCCESS (errors), not
 * whether any row was held — same precedent as flagged/unmapped/malformed holds.
 */
export async function applyRcOut(compact: RcOutCompact, deps: ApplyDeps): Promise<ApplyResult> {
  const { db } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const held: ApplyResult["held"] = [];
  const errors: string[] = [];
  const gateFailures = compact.gate_failures ?? [];

  // Date-scoped quarantine lookup: transaction_date → the QuarantinedDate record(s)
  // that flagged it (possibly from more than one gate). A row on any OTHER date writes
  // normally — a gate trip on stale/historical dates no longer blocks the whole run.
  const quarantineByDate = new Map<string, QuarantinedDate[]>();
  for (const q of compact.quarantined_dates ?? []) {
    const list = quarantineByDate.get(q.date);
    if (list) list.push(q);
    else quarantineByDate.set(q.date, [q]);
  }
  const claimedQuarantineDates = new Set<string>();

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
    const q = quarantineByDate.get(r.transaction_date);
    if (q && q.length) {
      claimedQuarantineDates.add(r.transaction_date);
      held.push({
        reason: q.map((x) => x.gate).join(", "),
        natural_key: rcOutKey(r),
        detail: quarantineDetailText(q),
        kind: "gate_failure",
        row: { ...rcOutHeldRow(r), drift_dates: q.map((x) => x.detail) },
        source_index: item.index as string | number,
      });
      continue;
    }
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
    const q = quarantineByDate.get(c.row.transaction_date);
    if (q && q.length) {
      claimedQuarantineDates.add(c.row.transaction_date);
      held.push({
        reason: q.map((x) => x.gate).join(", "),
        natural_key: rcOutKey(c.row),
        detail: quarantineDetailText(q),
        kind: "gate_failure",
        row: { ...rcOutHeldRow(c.row), drift_dates: q.map((x) => x.detail) },
        source_index: c.index as string | number,
      });
      continue;
    }
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

  // flagged / malformed → held, never auto-written (unmapped has its OWN loop below —
  // it may now auto-create + write, see lib/batchAutoCreate.ts).
  const buckets: Array<[keyof RcOutCompact["actionable"], string]> = [
    ["flagged", "flagged"],
    ["malformed", "malformed"],
  ];
  for (const [bucket, reason] of buckets) {
    for (const f of compact.actionable[bucket] ?? []) {
      const item = f as { index?: unknown; reason?: string; row?: ProposedRow };
      const row = item.row;
      // Refine the kind: a "flagged" bucket entry whose classifier reason is the
      // L-019 sub-watermark guard is the settled-date suspected-dup case; else
      // malformed/flagged.
      let kind: HeldKind;
      if (bucket === "malformed") kind = "malformed";
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

  // UNMAPPED (2026-07-11 policy — reverses "never auto-create a batch"): a
  // pattern-valid unknown batch_code is now auto-created from the template and the
  // row proceeds as a normal NEW insert IN THIS SAME RUN. A quarantined date NEVER
  // gets a fresh write (the gate still wins). A pattern-INVALID code (a likely
  // typo) still holds exactly as before.
  const batchLookup: Record<string, string> = { ...(compact.batch_lookup ?? {}) };
  const autoCreatedBatches: AutoCreatedBatchNote[] = [];
  for (const f of compact.actionable.unmapped ?? []) {
    const item = f as { index?: unknown; reason?: string; row?: ProposedRow };
    const row = item.row;
    const primaryCode = row?.batch_code_primary ?? null;
    const quarantined = row ? quarantineByDate.get(row.transaction_date) : undefined;

    if (row && !(quarantined && quarantined.length) && isPatternValidBatchCode(primaryCode)) {
      const outcome = await ensureBatch(db, primaryCode, row.block_loc, batchLookup);
      if (outcome.status !== "invalid_pattern") {
        row.batch_id = outcome.batchId;
        row.batch_code_resolved = outcome.resolvedCode;

        if (outcome.status === "created") {
          await db.writeIngestionAudit({
            tableName: "batches",
            recordId: outcome.batchId,
            operation: "INSERT",
            comment: autoCreateAuditComment({
              source: "rc_out (PROPOSED DAILY REPORT)",
              runTs,
              sourceRow: (item.index as string | number) ?? null,
            }),
            snapshot: outcome.fields as unknown as Record<string, unknown>,
          });
          const note: AutoCreatedBatchNote = {
            batch_code: outcome.resolvedCode,
            location_ref: outcome.fields.location_ref,
            transaction_date: row.transaction_date ?? null,
            block_loc: row.block_loc ?? null,
            source_row: (item.index as string | number) ?? null,
          };
          autoCreatedBatches.push(note);
          await emit?.(
            "apply",
            autoCreateMessage({
              batchCode: outcome.resolvedCode,
              locationRef: outcome.fields.location_ref,
              source: "the Proposed Daily Report (RC OUT)",
              sourceRow: (item.index as string | number) ?? null,
            }),
            88,
            undefined,
            "info",
          );
        }

        const writeRes = await writeNewRcOutRow(db, row, item.index, runTs);
        if (writeRes.ok) {
          inserts += 1;
        } else if (writeRes.reason === "already_exists") {
          held.push({
            reason: "already_exists",
            natural_key: rcOutKey(row),
            detail: "batch auto-created; idempotent skip (natural key already in DB)",
            kind: "already_exists",
            row: rcOutHeldRow(row),
            source_index: item.index as string | number,
          });
        } else {
          errors.push(`insert row ${item.index}: ${writeRes.message}`);
        }
        continue;
      }
      // invalid_pattern falls through to the held push below (shouldn't happen —
      // isPatternValidBatchCode already gated this branch — but keeps the logic honest).
    }

    held.push({
      reason: "unmapped_batch_code",
      natural_key: row ? rcOutKey(row) : String(item.index ?? ""),
      detail: item.reason ?? "requires human decision — never auto-written",
      kind: "unmapped_batch_code",
      ...(row ? { row: rcOutHeldRow(row) } : {}),
      source_index: item.index as string | number,
    });
  }

  // Any quarantined date with NO actionable row this run (nothing needed writing there
  // today) still gets ONE summary held entry — a genuinely risky finding is never lost
  // just because this run's workbook happened not to touch it (visibility is the point).
  for (const [date, list] of quarantineByDate) {
    if (claimedQuarantineDates.has(date)) continue;
    held.push({
      reason: list.map((x) => x.gate).join(", "),
      natural_key: `${date} · ${list.map((x) => x.gate).join(" + ")}`,
      detail: quarantineDetailText(list),
      kind: "gate_failure",
      row: { transaction_date: date, drift_dates: list.map((x) => x.detail) },
    });
  }

  // Label + watermark whenever not errors (sync_rc_out.py:306-315) — a quarantine hold
  // is NOT an error (see the file header); it does not block labeling/watermark.
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
  } else if (quarantineByDate.size) {
    await emit?.(
      "finalize",
      `Done — ${inserts} new, ${updates} updated, ${held.length} held for review ` +
        `(${quarantineByDate.size} date(s) quarantined by a safety gate).`,
      100,
      undefined,
      "warn",
    );
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
    gate_failures: gateFailures.length ? gateFailures : undefined,
    auto_created_batches: autoCreatedBatches,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
