/**
 * apply.ts — TS port of sync_gsheet.py::_apply_from_compact + phase_apply_contract
 * (read the Python as spec; specs/gsheet.md §5), WITH the PORTING_DECISIONS rulings
 * applied. This is APPLY-phase scaffolding for the DBOS worker; the parity gate is
 * CLASSIFY-only, so the three intentional deviations below are registered as dormant
 * carve-outs in expected-deviations.json (PD-2/PD-3/PD-4) for the future M3 layer.
 *
 * RULINGS IMPLEMENTED (PORTING_DECISIONS.md):
 *   #2  The Python returns a bare int `1` on the >50-NEW / confidence<0.7 gates,
 *       crashing the contract-CLI caller. The TS port returns a PROPER gate-failure
 *       envelope (nothing applied, ok:false, the gate named) — never a crash.
 *   #3  L-018: the Python `changed` loop honors ONLY top-level `skip`, never
 *       `decision`. The TS port honors `decision:"skip"` on CHANGED rows too.
 *   #4  The Python RC IN insert payload drops true_weight_kg/deduction_note even
 *       though the extractor computes them. The TS port WRITES them (aligning to the
 *       deliveries email pipeline + L-021 intent).
 *
 * Idempotency divergence PRESERVED (gsheet.md §5 / SHARED trap #4): gsheet uses PLAIN
 * db.insert(), NOT insertIfAbsent — the classifier's fresh-DB-window decision is the
 * idempotency guard. We do NOT "helpfully" re-check before insert. never-delete holds.
 */
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

export const GSHEET_FILE_ID = "1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM";

// ---------------------------------------------------------------------------
// Compact shapes (sync_gsheet.py::build_compact) — the classify→apply hand-off.
// ---------------------------------------------------------------------------
export interface CompactNewRcIn {
  kind: "NEW";
  index: unknown;
  date: string | null;
  batch_code: string | null;
  block_loc: string | null;
  weight_kg: number | null;
  supplier: string | null;
  truck_plate: string | null;
  sacks: number | null;
  remarks: string | null;
  lab_results: Record<string, unknown> | null;
  confidence: number | null;
  // PORTING_DECISIONS #4 — carried through so apply can WRITE them.
  true_weight_kg?: number | null;
  deduction_note?: string | null;
  skip?: boolean;
}

export interface CompactNewRcOut {
  kind: "NEW";
  index: unknown;
  date: string | null;
  batch_code: string | null;
  batch_id: string | null;
  destination: string | null;
  weight_kg: number | null;
  production_batch: string | null;
  block_loc: string | null;
  remarks: string | null;
  confidence: number | null;
  skip?: boolean;
}

export interface CompactChanged {
  kind: "VALUE_CHANGED";
  index: unknown;
  db_id: string;
  date: string | null;
  batch_code: string | null;
  diff: Array<{ field: string; db: unknown; sheet: unknown }>;
  block_loc?: string | null;
  destination?: string | null;
  skip?: boolean;
  decision?: string; // PORTING_DECISIONS #3 — honored on CHANGED too.
}

export interface CompactFlagged {
  kind: "FLAGGED";
  index: unknown;
  flag_kind?: string;
  reason?: string;
  db_conflict_ids?: unknown[];
  db_conflict_batches?: unknown[];
  decision?: string;
}

export interface CompactUnmapped {
  kind: "UNMAPPED";
  index: unknown;
  decision?: string;
}

export interface ModeCompact {
  mode: "rc_in" | "rc_out";
  since: string | null;
  actionable: {
    new: Array<CompactNewRcIn | CompactNewRcOut>;
    changed: CompactChanged[];
    flagged: CompactFlagged[];
    unmapped: CompactUnmapped[];
    malformed: unknown[];
  };
}

export interface ApplyDeps {
  db: DbClient;
  progress?: ProgressEmitter;
  runTs?: string;
}

/** Result of applying ONE mode. Mirrors the Python legacy result dict, plus an
 *  explicit gate-failure shape (PORTING_DECISIONS #2 — no bare-int crash). */
export interface ModeApplyResult {
  ok: boolean;
  mode: "rc_in" | "rc_out";
  inserted: number;
  inserted_ids: string[];
  updated: number;
  updated_ids: string[];
  new_batches_created: string[];
  flagged_resolved: Array<{ index: unknown; reason: string; detail: string }>;
  skipped: Array<{ index: unknown; why: string }>;
  /** Present only when a safety gate tripped (PD-2). */
  gate_failure?: { gate: string; detail: string; indexes?: unknown[] };
}

export interface GsheetApplyResult {
  report_type: "gsheet";
  ok: boolean;
  inserts: number;
  updates: number;
  held: Array<{ reason: string; natural_key: string; detail?: string }>;
  labeled: boolean; // ALWAYS false — a Sheet has no Gmail thread (gsheet.md §5).
  watermark_updated: boolean;
  errors: string[];
  per_mode: Record<string, ModeApplyResult>;
}

const REPORT_TYPE = "gsheet" as const;

function provenanceComment(mode: string, index: unknown, runTs: string, noteExtra = ""): string {
  const tab = mode === "rc_in" ? "RC IN" : "RC OUT";
  const base =
    `provenance=gsheet | Ingested by gsheet-sync (lean orchestrator) from Google Sheet ` +
    `(file ${GSHEET_FILE_ID}, tab ${tab}, row ${index}) on ${runTs}. ` +
    `Sheet = source of truth (2025+ scope).`;
  return base + (noteExtra ? ` ${noteExtra}` : "");
}

/**
 * Port of _apply_from_compact for ONE mode, with PORTING_DECISIONS #2/#3/#4.
 * Returns a typed ModeApplyResult (NEVER a bare int / crash).
 */
export async function applyFromCompact(
  compact: ModeCompact,
  deps: ApplyDeps,
): Promise<ModeApplyResult> {
  const { db } = deps;
  const runTs = deps.runTs ?? new Date().toISOString();
  const mode = compact.mode;
  const actionable = compact.actionable;

  const insertedIds: string[] = [];
  const updatedIds: string[] = [];
  const skipped: ModeApplyResult["skipped"] = [];
  const newBatches: string[] = [];

  const base = (): ModeApplyResult => ({
    ok: true,
    mode,
    inserted: 0,
    inserted_ids: insertedIds,
    updated: 0,
    updated_ids: updatedIds,
    new_batches_created: newBatches,
    flagged_resolved: [],
    skipped,
  });

  // --- Safety gates (PORTING_DECISIONS #2 — proper envelope, no bare-int crash). ---
  const newRows = actionable.new.filter((r) => !r.skip);
  if (newRows.length > 50) {
    return {
      ...base(),
      ok: false,
      gate_failure: {
        gate: "too_many_new",
        detail: `Too many NEW rows (${newRows.length}) for auto-write. Route to manual triage.`,
      },
    };
  }
  const lowConf = newRows.filter((r) => (r.confidence ?? 1.0) < 0.7);
  if (lowConf.length) {
    return {
      ...base(),
      ok: false,
      gate_failure: {
        gate: "low_confidence",
        detail: `${lowConf.length} NEW rows below confidence 0.7 — manual review required.`,
        indexes: lowConf.map((r) => r.index),
      },
    };
  }

  // --- NEW rows ---
  for (const r of newRows) {
    if (mode === "rc_in") {
      const nr = r as CompactNewRcIn;
      const bc = nr.batch_code as string;
      const existing = await db.selectOne("batches", { batch_code: `eq.${bc}` }, "batch_code");
      if (!existing) {
        try {
          await db.insert("batches", [
            {
              batch_code: bc,
              location_ref: nr.block_loc || "",
              status: "STORED",
              current_weight: 0,
              avg_cost: 0,
            },
          ]);
          newBatches.push(bc);
        } catch (bexc) {
          if (isLocationCollision(bexc)) {
            skipped.push({
              index: nr.index,
              why:
                `location_occupied: block_loc ${nr.block_loc} already holds an active batch; ` +
                `new batch ${bc} not created — resolve the slot`,
            });
            continue;
          }
          throw bexc;
        }
      }
      const payload: Record<string, unknown> = {
        transaction_date: nr.date,
        supplier: nr.supplier,
        batch_code: bc,
        block_loc: nr.block_loc,
        truck_plate: nr.truck_plate,
        sacks: nr.sacks,
        weight_kg: nr.weight_kg,
        cost_basis: 0, // L-008 placeholder.
        remarks: nr.remarks,
        lab_results: nr.lab_results,
        // PORTING_DECISIONS #4 — WRITE these (Python apply drops them).
        true_weight_kg: nr.true_weight_kg ?? null,
        deduction_note: nr.deduction_note ?? null,
      };
      const ins = await db.insert("deliveries", [payload]);
      const newId = ins[0].id as string;
      insertedIds.push(newId);
      await db.stampIngestionAudit({
        tableName: "deliveries",
        recordId: newId,
        comment: provenanceComment(
          mode,
          nr.index,
          runTs,
          "cost_basis=0 is an UNPRICED PLACEHOLDER (L-008) — deliveries-manager to enrich from Czarina/email.",
        ),
        snapshot: payload,
      });
    } else {
      const nr = r as CompactNewRcOut;
      if (!nr.batch_id) {
        skipped.push({ index: nr.index, why: "NEW rc_out without resolved batch_id" });
        continue;
      }
      const payload: Record<string, unknown> = {
        transaction_date: nr.date,
        batch_id: nr.batch_id,
        destination: nr.destination || "MAIN",
        weight_kg: nr.weight_kg,
        remarks: nr.remarks,
        block_loc: nr.block_loc,
        production_batch: nr.production_batch,
      };
      const ins = await db.insert("rc_out", [payload]);
      const newId = ins[0].id as string;
      insertedIds.push(newId);
      await db.writeIngestionAudit({
        tableName: "rc_out",
        recordId: newId,
        operation: "INSERT",
        comment: provenanceComment(mode, nr.index, runTs),
        snapshot: payload,
      });
    }
  }

  // --- material VALUE_CHANGED (Sheet-wins) ---
  for (const r of actionable.changed) {
    // PORTING_DECISIONS #3 (L-018): honor `decision:"skip"` on CHANGED, not just `skip`.
    if (r.skip || (r.decision ?? "").trim() === "skip") {
      skipped.push({ index: r.index, why: "skip requested on changed row (skip/decision)" });
      continue;
    }
    const dbId = r.db_id;
    const patch: Record<string, unknown> = {};
    for (const d of r.diff) {
      if (d.field === "cost_basis") continue; // never written by gsheet-sync.
      patch[d.field] = d.sheet;
    }
    if (!Object.keys(patch).length) continue;
    const table = mode === "rc_in" ? "deliveries" : "rc_out";
    await db.update(table, { id: `eq.${dbId}` }, patch);
    updatedIds.push(dbId);
    const diffJson: Record<string, { old: unknown; new: unknown }> = {};
    for (const d of r.diff) diffJson[d.field] = { old: d.db, new: d.sheet };
    if (mode === "rc_in") {
      const ok = await db.stampIngestionAudit({
        tableName: "deliveries",
        recordId: dbId,
        comment: provenanceComment(
          mode,
          r.index,
          runTs,
          `Sheet-wins UPDATE diff=${JSON.stringify(diffJson)}`,
        ),
      });
      if (!ok) {
        await db.writeIngestionAudit({
          tableName: "deliveries",
          recordId: dbId,
          operation: "UPDATE",
          comment: provenanceComment(mode, r.index, runTs, "Sheet-wins UPDATE"),
          diff: diffJson,
        });
      }
    } else {
      await db.writeIngestionAudit({
        tableName: "rc_out",
        recordId: dbId,
        operation: "UPDATE",
        comment: provenanceComment(mode, r.index, runTs, "Sheet-wins UPDATE"),
        diff: diffJson,
      });
    }
  }

  // --- FLAGGED rows: ONLY per explicit decision (default skip; never delete). ---
  const flaggedResolved: ModeApplyResult["flagged_resolved"] = [];
  for (const r of actionable.flagged) {
    const decision = (r.decision ?? "skip").trim();
    if (decision === "skip") {
      skipped.push({ index: r.index, why: "flagged left as skip" });
      continue;
    }
    if (decision === "insert") {
      skipped.push({
        index: r.index,
        why: "flagged decision=insert requires re-running with this row promoted to NEW — not auto-handled here",
      });
      continue;
    }
    if (decision.startsWith("reassign:")) {
      const targetId = decision.slice("reassign:".length);
      flaggedResolved.push({
        index: r.index,
        reason: `reassign_to:${targetId}`,
        detail: "reassignment must be applied as a reviewed single UPDATE; not auto-executed",
      });
      continue;
    }
    skipped.push({ index: r.index, why: `unknown flagged decision '${decision}'` });
  }

  // --- UNMAPPED: never auto-create a batch. ---
  for (const r of actionable.unmapped) {
    const decision = (r.decision ?? "skip").trim();
    if (decision === "skip") {
      skipped.push({ index: r.index, why: "unmapped left as skip — never auto-create a batch" });
    } else {
      skipped.push({
        index: r.index,
        why: `unmapped decision='${decision}' requires re-classify with corrected batch_code`,
      });
    }
  }

  return {
    ...base(),
    ok: true,
    inserted: insertedIds.length,
    updated: updatedIds.length,
    flagged_resolved: flaggedResolved,
  };
}

/**
 * Port of phase_apply_contract: apply BOTH modes (rc_in then rc_out), sum
 * inserts/updates, map skipped/flagged_resolved into the contract `held` list,
 * upsert the watermark (report_type gsheet, last_email_id null), labeled ALWAYS false.
 * A gate failure (PD-2) surfaces as ok:false with the gate recorded in `held`/`errors`
 * — nothing from that mode is applied.
 */
export async function applyGsheet(
  modes: Record<"rc_in" | "rc_out", ModeCompact>,
  deps: ApplyDeps,
): Promise<GsheetApplyResult> {
  const emit = deps.progress;
  let totalInserts = 0;
  let totalUpdates = 0;
  const held: GsheetApplyResult["held"] = [];
  const errors: string[] = [];
  const perMode: Record<string, ModeApplyResult> = {};

  const modeList: Array<"rc_in" | "rc_out"> = ["rc_in", "rc_out"];
  for (let i = 0; i < modeList.length; i++) {
    const mode = modeList[i];
    const compact = modes[mode];
    if (!compact) continue;
    await emit?.("apply", `Writing ${mode === "rc_in" ? "deliveries (RC IN)" : "feedings (RC OUT)"}…`, 15 + Math.trunc((70 * i) / modeList.length));
    try {
      const res = await applyFromCompact(compact, deps);
      perMode[mode] = res;
      if (res.gate_failure) {
        // PD-2: nothing applied for this mode; record the gate, do NOT crash.
        errors.push(`${mode} apply gate: ${res.gate_failure.gate} — ${res.gate_failure.detail}`);
        held.push({
          reason: "gate_failure",
          natural_key: `${mode}:gate`,
          detail: res.gate_failure.detail,
        });
        continue;
      }
      totalInserts += res.inserted;
      totalUpdates += res.updated;
      for (const sk of res.skipped) {
        held.push({ reason: "skipped", natural_key: `${mode}:${sk.index}`, detail: sk.why });
      }
      for (const fr of res.flagged_resolved) {
        held.push({
          reason: "flagged_needs_manual_apply",
          natural_key: `${mode}:${fr.index}`,
          detail: fr.detail,
        });
      }
    } catch (exc) {
      errors.push(`${mode} apply: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  let watermarkUpdated = false;
  if (!errors.length) {
    await emit?.("apply", "Updating the audit trail…", 92);
    watermarkUpdated = await deps.db.upsertIngestionWatermark(REPORT_TYPE, { lastEmailId: null });
  }

  if (errors.length) {
    await emit?.("finalize", `Finished with ${errors.length} problem(s) — see details.`, 100, undefined, "warn");
  } else if (totalInserts || totalUpdates) {
    await emit?.("finalize", `Done — ${totalInserts} new, ${totalUpdates} updated.`, 100);
  } else {
    await emit?.("finalize", "Done — the sheet already matches the database.", 100);
  }

  return {
    report_type: REPORT_TYPE,
    ok: !errors.length,
    inserts: totalInserts,
    updates: totalUpdates,
    held,
    labeled: false,
    watermark_updated: watermarkUpdated,
    errors,
    per_mode: perMode,
  };
}

/** orchestrator_common.is_location_collision (SHARED.md §3.4). */
function isLocationCollision(exc: unknown): boolean {
  const s = exc instanceof Error ? exc.message : String(exc);
  return (
    s.includes("23505") &&
    (s.includes("idx_unique_active_batch_per_location") || s.includes("location_ref"))
  );
}
