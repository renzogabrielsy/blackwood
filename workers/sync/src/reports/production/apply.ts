/**
 * apply.ts — port of sync_production.py::phase_apply. FK-safe write order:
 *   1. Collect distinct shift triplets from every NEW+needs_shift_upsert child
 *      (runs+downtime+waste) and UPSERT the parent production_shifts FIRST.
 *   2. L-026 combine duplicate (shift_id, customer^, grade^) NEW run rows, then
 *      insert production_runs.
 *   3. Insert production_downtime (NO remarks col) + production_waste (8 streams +
 *      remarks) via insert_if_absent(natural_key=(shift_id,)).
 *   4. Insert electricity_readings + truck_readings (natural-key, no shift) —
 *      NEVER writing the generated columns diff_kwh/consumption_kwh/ttl_km.
 *   5. Apply ALL VALUE_CHANGED (all 5 sections), stripping generated cols defensively.
 *   6. Hold ALL MALFORMED.
 * Every table gets a MANUAL audit row via writeIngestionAudit (none of the 6
 * production-family tables has an audit trigger). Reconcile is INFORMATIONAL and
 * never gates. Watermark + label only if `not errors`; a SINGLE mark_processed call
 * labels BOTH the MC and Ivy UIDs together.
 *
 * PD-5 note: the dt_mins>=60 split is applied UPSTREAM at extract shaping
 * (extractMc.ts), so the downtime record reaching apply already carries a
 * constraint-valid dt_hrs/dt_mins — apply writes it verbatim.
 *
 * Ground truth: .claude/skills/sync-ictc/scripts/sync_production.py.
 */
import type { DbClient, Row } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

const WASTE_STREAMS = ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg"] as const;
const GENERATED_COLS = ["diff_kwh", "consumption_kwh", "ttl_km"] as const;

export interface ProductionSections {
  runs: Record<string, unknown>[];
  downtime: Record<string, unknown>[];
  waste: Record<string, unknown>[];
  electricity: Record<string, unknown>[];
  trucks: Record<string, unknown>[];
}

export interface ProductionCompact {
  report_type: string;
  since: string;
  window: [string, string];
  source: {
    mc_subject?: string | null;
    mc_uid?: number | string | null;
    mc_thread_id?: string | null;
    ivy_subject?: string | null;
    ivy_uid?: number | string | null;
    ivy_thread_id?: string | null;
  };
  sections: ProductionSections;
}

export interface HeldRow {
  reason: string;
  natural_key: string;
  detail: string;
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
}

export interface ApplyDeps {
  db: DbClient;
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

function normUpper(s: unknown): string | null | undefined {
  return s !== null && s !== undefined ? String(s).trim().toUpperCase() : (s as null | undefined);
}

function prov(table: string, runTs: string, extra = ""): string {
  const base = `provenance=production-sync | Ingested by sync_production.py (lean orchestrator) into ${table} on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
}

export async function applyProduction(compact: ProductionCompact, deps: ApplyDeps): Promise<ApplyResult> {
  const { db } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const sections = compact.sections;
  const held: HeldRow[] = [];
  const errors: string[] = [];
  let inserts = 0;
  let updates = 0;

  await emit?.("apply", "Setting up production shifts…", 15);

  // ── 1. distinct shift triplets needing upsert (runs+downtime+waste NEW) ──
  const triplets = new Map<string, { transaction_date: unknown; production_batch: unknown; shift: unknown }>();
  for (const secName of ["runs", "downtime", "waste"] as const) {
    for (const c of sections[secName] ?? []) {
      if (c.class === "NEW" && c.needs_shift_upsert) {
        const rec = (c.record ?? {}) as Row;
        const key = `${rec.transaction_date ?? "null"}|${normUpper(rec.production_batch) ?? "null"}|${normUpper(rec.shift) ?? "null"}`;
        if (!triplets.has(key)) {
          triplets.set(key, {
            transaction_date: rec.transaction_date,
            production_batch: rec.production_batch,
            shift: rec.shift,
          });
        }
      }
    }
  }

  const shiftMap = new Map<string, string>();
  for (const [key, payload] of triplets) {
    try {
      const res = await db.insertIfAbsent("production_shifts", [payload as Row], [
        "transaction_date",
        "production_batch",
        "shift",
      ]);
      let sid: string | null = null;
      if (res.inserted.length > 0) {
        sid = res.inserted[0].id as string;
        await db.writeIngestionAudit({
          tableName: "production_shifts", recordId: sid, operation: "INSERT",
          comment: prov("production_shifts", runTs), snapshot: payload as Row,
        });
      } else {
        const existing = await db.selectOne(
          "production_shifts",
          {
            transaction_date: `eq.${payload.transaction_date}`,
            production_batch: `eq.${payload.production_batch}`,
            shift: `eq.${payload.shift}`,
          },
          "id",
        );
        sid = existing ? (existing.id as string) : null;
      }
      if (sid) shiftMap.set(key, sid);
    } catch (exc) {
      errors.push(`shift upsert ${key}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  const resolveShift = (c: Record<string, unknown>): string | null => {
    if (c.resolved_shift_id) return c.resolved_shift_id as string;
    const rec = (c.record ?? {}) as Row;
    const key = `${rec.transaction_date ?? "null"}|${normUpper(rec.production_batch) ?? "null"}|${normUpper(rec.shift) ?? "null"}`;
    return shiftMap.get(key) ?? null;
  };

  await emit?.("apply", "Writing production runs, downtime, and waste…", 40);

  // ── 2. runs (L-026 combine) ──
  const runNews = (sections.runs ?? []).filter((c) => c.class === "NEW");
  const combined = new Map<string, Row>();
  for (const c of runNews) {
    const sid = resolveShift(c);
    if (!sid) {
      held.push({ reason: "unresolved_shift", natural_key: JSON.stringify(c.natural_key), detail: "run NEW without resolvable shift_id" });
      continue;
    }
    const rec = (c.record ?? {}) as Row;
    const k = `${sid}|${normUpper(rec.customer)}|${normUpper(rec.grade)}`;
    if (combined.has(k)) {
      const cur = combined.get(k)!;
      cur.ttl_kg = ((cur.ttl_kg as number) || 0) + ((rec.ttl_kg as number) || 0);
      cur.sacks_bags = ((cur.sacks_bags as number) || 0) + ((rec.sacks_bags as number) || 0);
      cur.remarks = [cur.remarks, rec.remarks].filter(Boolean).join("; ");
    } else {
      combined.set(k, {
        shift_id: sid, customer: rec.customer, grade: rec.grade,
        ttl_kg: rec.ttl_kg, sacks_bags: rec.sacks_bags, remarks: rec.remarks,
      });
    }
  }
  for (const payload of combined.values()) {
    try {
      const res = await db.insertIfAbsent("production_runs", [payload], ["shift_id", "customer", "grade"]);
      if (res.inserted.length > 0) {
        const nid = res.inserted[0].id as string;
        inserts++;
        await db.writeIngestionAudit({
          tableName: "production_runs", recordId: nid, operation: "INSERT",
          comment: prov("production_runs", runTs), snapshot: payload,
        });
      } else {
        held.push({ reason: "already_exists", natural_key: `${payload.shift_id}|${payload.customer}|${payload.grade}`, detail: "idempotent skip" });
      }
    } catch (exc) {
      errors.push(`run insert ${payload.customer}/${payload.grade}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  // ── 3. downtime (no remarks col) + waste ──
  const childSpecs: Array<[keyof ProductionSections, string[], string]> = [
    ["downtime", ["shift_hrs", "dt_hrs", "dt_mins", "dt_reason"], "production_downtime"],
    ["waste", [...WASTE_STREAMS, "remarks"], "production_waste"],
  ];
  for (const [secName, cols, table] of childSpecs) {
    for (const c of sections[secName] ?? []) {
      if (c.class !== "NEW") continue;
      const sid = resolveShift(c);
      if (!sid) {
        held.push({ reason: "unresolved_shift", natural_key: secName, detail: `${secName} NEW without resolvable shift_id` });
        continue;
      }
      const rec = (c.record ?? {}) as Row;
      const payload: Row = { shift_id: sid };
      for (const col of cols) payload[col] = rec[col] ?? null;
      try {
        const res = await db.insertIfAbsent(table, [payload], ["shift_id"]);
        if (res.inserted.length > 0) {
          const nid = res.inserted[0].id as string;
          inserts++;
          await db.writeIngestionAudit({
            tableName: table, recordId: nid, operation: "INSERT",
            comment: prov(table, runTs), snapshot: payload,
          });
        } else {
          held.push({
            reason: "already_exists_or_collision", natural_key: `${secName}:${sid}`,
            detail: `${secName} UNIQUE(shift_id) already present — held (L-028/L-007 collision review)`,
          });
        }
      } catch (exc) {
        errors.push(`${secName} insert shift ${sid}: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
  }

  await emit?.("apply", "Writing electricity and truck readings…", 62);

  // ── 4. electricity + trucks (natural-key, no shift; generated cols never written) ──
  const nkSpecs: Array<[keyof ProductionSections, string, string[], string[]]> = [
    ["electricity", "electricity_readings", ["reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks"], ["reading_date", "meter"]],
    ["trucks", "truck_readings", ["reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks"], ["reading_date", "plate_no"]],
  ];
  for (const [secName, table, cols, nkey] of nkSpecs) {
    for (const c of sections[secName] ?? []) {
      if (c.class !== "NEW") continue;
      const rec = (c.record ?? {}) as Row;
      const payload: Row = {};
      for (const col of cols) payload[col] = rec[col] ?? null;
      try {
        const res = await db.insertIfAbsent(table, [payload], nkey);
        if (res.inserted.length > 0) {
          const nid = res.inserted[0].id as string;
          inserts++;
          await db.writeIngestionAudit({
            tableName: table, recordId: nid, operation: "INSERT",
            comment: prov(table, runTs), snapshot: payload,
          });
        } else {
          held.push({ reason: "already_exists", natural_key: table, detail: "idempotent skip" });
        }
      } catch (exc) {
        errors.push(`${table} insert: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
  }

  await emit?.("apply", "Applying changed rows…", 78);

  // ── 5. VALUE_CHANGED (all sections) → UPDATE + manual audit ──
  const tableFor: Record<keyof ProductionSections, string> = {
    runs: "production_runs", downtime: "production_downtime", waste: "production_waste",
    electricity: "electricity_readings", trucks: "truck_readings",
  };
  for (const secName of Object.keys(tableFor) as Array<keyof ProductionSections>) {
    const tbl = tableFor[secName];
    for (const c of sections[secName] ?? []) {
      if (c.class !== "VALUE_CHANGED" || !c.existing_id) continue;
      const diff = (c.diff ?? {}) as Record<string, unknown> | Array<{ field: string; emailValue?: unknown; dbValue?: unknown }>;
      const patch: Row = {};
      // runs/downtime/waste diff is {field:{db,email}}; electricity/trucks diff is
      // a LIST of {field,emailValue,dbValue}. Python's apply reads a dict `.new`
      // which neither shape carries, so patch ends up EMPTY for the dict shape and
      // is only meaningful when a caller provides {new:...}. We mirror: pull `new`
      // if present (dict form), else skip — then strip generated cols defensively.
      if (Array.isArray(diff)) {
        for (const entry of diff) {
          if (entry && typeof entry === "object" && "new" in entry) patch[entry.field] = (entry as { new: unknown }).new;
        }
      } else {
        for (const [f, v] of Object.entries(diff)) {
          if (v && typeof v === "object" && "new" in (v as Record<string, unknown>)) patch[f] = (v as { new: unknown }).new;
        }
      }
      for (const gen of GENERATED_COLS) delete patch[gen];
      if (Object.keys(patch).length === 0) continue;
      try {
        await db.update(tbl, { id: `eq.${c.existing_id}` }, patch);
        updates++;
        await db.writeIngestionAudit({
          tableName: tbl, recordId: c.existing_id as string, operation: "UPDATE",
          comment: prov(tbl, runTs, "UPDATE"), diff: diff as Row,
        });
      } catch (exc) {
        errors.push(`${tbl} update ${c.existing_id}: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
  }

  // ── 6. MALFORMED → held everywhere ──
  for (const secName of Object.keys(sections) as Array<keyof ProductionSections>) {
    for (const c of sections[secName] ?? []) {
      if (c.class === "MALFORMED") {
        const reasons = (c.reasons as string[] | undefined) ?? [];
        held.push({ reason: "malformed", natural_key: secName, detail: reasons.join("; ") || "malformed row held" });
      }
    }
  }

  let watermarkUpdated = false;
  let labeled = false;
  if (errors.length === 0) {
    await emit?.("apply", "Updating the audit trail…", 90);
    watermarkUpdated = await db.upsertIngestionWatermark(compact.report_type, {
      lastEmailId: compact.source?.mc_thread_id ?? null,
    });
    if (!deps.noLabel) {
      const uids = [compact.source?.mc_uid, compact.source?.ivy_uid].filter(
        (u): u is number | string => u !== null && u !== undefined && u !== "",
      );
      if (uids.length > 0 && deps.labeler) {
        await emit?.("apply", "Marking the email(s) as processed…", 95);
        labeled = await deps.labeler(uids);
      }
    }
  }

  if (errors.length > 0) {
    await emit?.("finalize", `Finished with ${errors.length} problem(s) — see details.`, 100, undefined, "warn");
  } else if (inserts || updates) {
    await emit?.("finalize", `Done — ${inserts} new, ${updates} updated.`, 100);
  } else {
    await emit?.("finalize", "Done — nothing new to write.", 100);
  }

  return {
    report_type: compact.report_type,
    ok: errors.length === 0,
    inserts,
    updates,
    held,
    labeled,
    watermark_updated: watermarkUpdated,
    errors,
  };
}
