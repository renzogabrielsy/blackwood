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
import { rcOutReconcileCutover } from "../../lib/env.js";
import { type HeldRow, type HeldKind, rcOutKey, deliveriesKey } from "../held.js";

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
  /**
   * R4b cutover override. When true, gsheet does NOT write `rc_out` (the rc_out mode is
   * skipped whole at the apply boundary — see `applyGsheet`). When omitted, `applyGsheet`
   * resolves it from `SYNC_RCOUT_RECONCILE_CUTOVER` (default ON). rc_in is UNAFFECTED.
   * `applyFromCompact` ignores this field — the gate lives at the `applyGsheet` boundary.
   */
  cutoverRcOut?: boolean;
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
  flagged_resolved: Array<{ index: unknown; reason: string; detail: string; held?: EnrichedHeld }>;
  skipped: Array<{ index: unknown; why: string; held?: EnrichedHeld }>;
  /** Present only when a safety gate tripped (PD-2). */
  gate_failure?: { gate: string; detail: string; indexes?: unknown[] };
  /**
   * R4b — set true when this mode was SKIPPED WHOLE by the rc_out cutover (gsheet no
   * longer writes rc_out; the PROPOSED report is the sole writer). Telemetry only —
   * nothing applied, no held rows, ok stays true. Never set for rc_in.
   */
  cutover_skipped?: boolean;
}

/** The enrichment attached to a gsheet skipped/flagged entry so `applyGsheet` can
 *  build a decision-grade contract HeldRow (human key + kind + structured row). */
interface EnrichedHeld {
  kind: HeldKind;
  natural_key: string;
  row?: Record<string, unknown>;
}

export interface GsheetApplyResult {
  report_type: "gsheet";
  ok: boolean;
  inserts: number;
  updates: number;
  held: HeldRow[];
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

/** Build the enriched held payload for a gsheet NEW row (either mode). No ₱/cost. */
function enrichedNew(
  mode: "rc_in" | "rc_out",
  r: CompactNewRcIn | CompactNewRcOut,
  kind: HeldKind,
): EnrichedHeld {
  if (mode === "rc_in") {
    const nr = r as CompactNewRcIn;
    return {
      kind,
      natural_key: deliveriesKey({
        transaction_date: nr.date,
        batch_code: nr.batch_code,
        block_loc: nr.block_loc,
        weight_kg: nr.weight_kg,
        truck_plate: nr.truck_plate,
      }),
      row: {
        transaction_date: nr.date,
        batch_code: nr.batch_code,
        block_loc: nr.block_loc,
        truck_plate: nr.truck_plate,
        weight_kg: nr.weight_kg,
        sacks: nr.sacks,
      },
    };
  }
  const nr = r as CompactNewRcOut;
  return {
    kind,
    natural_key: rcOutKey({
      transaction_date: nr.date,
      batch_code_resolved: nr.batch_code,
      destination: nr.destination,
      weight_kg: nr.weight_kg,
    }),
    row: {
      transaction_date: nr.date,
      batch_code: nr.batch_code,
      batch_id: nr.batch_id,
      destination: nr.destination,
      weight_kg: nr.weight_kg,
      production_batch: nr.production_batch,
      block_loc: nr.block_loc,
    },
  };
}

/** Build the enriched held payload for a gsheet FLAGGED (cross-batch) row. No ₱/cost. */
function enrichedFlagged(mode: "rc_in" | "rc_out", r: CompactFlagged): EnrichedHeld {
  return {
    kind: "cross_batch_reassignment",
    natural_key: `${mode === "rc_in" ? "RC IN" : "RC OUT"} row ${String(r.index)}`,
    row: {
      mode,
      flag_kind: r.flag_kind ?? null,
      db_conflict_ids: r.db_conflict_ids ?? [],
      db_conflict_batches: r.db_conflict_batches ?? [],
    },
  };
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
              held: enrichedNew(mode, nr, "location_occupied"),
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
        skipped.push({
          index: nr.index,
          why: "NEW rc_out without resolved batch_id",
          held: enrichedNew(mode, nr, "unmapped_batch_code"),
        });
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
    const enriched = enrichedFlagged(mode, r);
    const decision = (r.decision ?? "skip").trim();
    if (decision === "skip") {
      skipped.push({ index: r.index, why: r.reason ?? "flagged left as skip", held: enriched });
      continue;
    }
    if (decision === "insert") {
      skipped.push({
        index: r.index,
        why: "flagged decision=insert requires re-running with this row promoted to NEW — not auto-handled here",
        held: enriched,
      });
      continue;
    }
    if (decision.startsWith("reassign:")) {
      const targetId = decision.slice("reassign:".length);
      flaggedResolved.push({
        index: r.index,
        reason: `reassign_to:${targetId}`,
        detail: "reassignment must be applied as a reviewed single UPDATE; not auto-executed",
        held: enriched,
      });
      continue;
    }
    skipped.push({ index: r.index, why: `unknown flagged decision '${decision}'`, held: enriched });
  }

  // --- UNMAPPED: never auto-create a batch. ---
  for (const r of actionable.unmapped) {
    const decision = (r.decision ?? "skip").trim();
    const enriched: EnrichedHeld = {
      kind: "unmapped_batch_code",
      natural_key: `${mode === "rc_in" ? "RC IN" : "RC OUT"} row ${String(r.index)}`,
      row: { mode, index: r.index },
    };
    if (decision === "skip") {
      skipped.push({
        index: r.index,
        why: "unmapped left as skip — never auto-create a batch",
        held: enriched,
      });
    } else {
      skipped.push({
        index: r.index,
        why: `unmapped decision='${decision}' requires re-classify with corrected batch_code`,
        held: enriched,
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
  // R4b cutover — resolved ONCE, here at the apply boundary (not scattered). When ON
  // (default), the rc_out mode is skipped whole below so gsheet never touches rc_out.
  const cutoverRcOut = deps.cutoverRcOut ?? rcOutReconcileCutover();
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

    // ── R4b cutover: gsheet STOPS writing rc_out (the L-037 clobber fix). Skip the
    // rc_out mode WHOLE — no NEW inserts, no Sheet-wins UPDATEs, no held rows. The
    // PROPOSED report is the sole rc_out writer; reconciliation is the flagging
    // authority for gsheet↔proposed disagreements. rc_in falls through UNCHANGED.
    if (mode === "rc_out" && cutoverRcOut) {
      perMode[mode] = {
        ok: true,
        mode,
        inserted: 0,
        inserted_ids: [],
        updated: 0,
        updated_ids: [],
        new_batches_created: [],
        flagged_resolved: [],
        skipped: [],
        cutover_skipped: true,
      };
      await emit?.(
        "apply",
        "RC OUT: reconciliation owns rc_out now — gsheet skips writing it (R4b cutover).",
        15 + Math.trunc((70 * i) / modeList.length),
      );
      continue;
    }

    await emit?.("apply", `Writing ${mode === "rc_in" ? "deliveries (RC IN)" : "feedings (RC OUT)"}…`, 15 + Math.trunc((70 * i) / modeList.length));
    try {
      const res = await applyFromCompact(compact, deps);
      perMode[mode] = res;
      if (res.gate_failure) {
        // PD-2: nothing applied for this mode; record the gate, do NOT crash.
        errors.push(`${mode} apply gate: ${res.gate_failure.gate} — ${res.gate_failure.detail}`);
        held.push({
          reason: "gate_failure",
          natural_key: `${mode === "rc_in" ? "RC IN" : "RC OUT"} — ${res.gate_failure.gate}`,
          detail: res.gate_failure.detail,
          kind: "gate_failure",
        });
        continue;
      }
      totalInserts += res.inserted;
      totalUpdates += res.updated;
      for (const sk of res.skipped) {
        held.push({
          reason: "skipped",
          natural_key: sk.held?.natural_key ?? `${mode}:${sk.index}`,
          detail: sk.why,
          kind: sk.held?.kind ?? "flagged",
          ...(sk.held?.row ? { row: sk.held.row } : {}),
          source_index: sk.index as string | number,
        });
      }
      for (const fr of res.flagged_resolved) {
        held.push({
          reason: "flagged_needs_manual_apply",
          natural_key: fr.held?.natural_key ?? `${mode}:${fr.index}`,
          detail: fr.detail,
          kind: fr.held?.kind ?? "cross_batch_reassignment",
          ...(fr.held?.row ? { row: fr.held.row } : {}),
          source_index: fr.index as string | number,
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
