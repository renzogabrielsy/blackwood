/**
 * index.ts — production report port entrypoint (the heavyweight: 2 workbooks,
 * 5 record types, 6 target tables).
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts) — the FROZEN parity entrypoint
 *       (src/reports/types.ts). Runs BOTH extractors (mc + ivy roles) and all 5
 *       classifiers OFFLINE against the DB-window snapshot, then COMPOSES the five
 *       classifier result dicts into one object keyed by section — exactly the
 *       shape build_oracle.py::oracle_production produces:
 *         { runs, downtime, waste, electricity, trucks }
 *       Either workbook role may be absent (that source email didn't arrive); the
 *       missing side classifies as an empty extract, never throws.
 *   runReport(deps, runId, manifest, opts) — the full two-phase orchestrator
 *       (fetch → extract → classify → informational reconcile → apply). DB + Gmail
 *       injected as deps.
 *
 * Ground truth: sync_production.py + the 5 classify_* + 2 extract_* + reconcile_production.py.
 */
import { readFile } from "node:fs/promises";

import type { ClassifyCase, ClassifyOpts, DbWindow, ClassifyEnvelope } from "../types.js";
import type { DbClient, Row } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { loadProductionWorkbook } from "./sheet.js";
import { extractMc, type McExtract } from "./extractMc.js";
import { extractIvy, type IvyExtract } from "./extractIvy.js";
import {
  resolveRunningBatch,
  type BatchResolution,
  type ShiftBatchRow,
} from "./productionBatch.js";
import {
  classifyRuns,
  classifyDowntime,
  classifyWaste,
  classifyElectricity,
  classifyTrucks,
  type SectionResult,
  type ShiftDbRow,
  type RunDbRow,
  type DowntimeDbRow,
  type WasteDbRow,
  type ElectricityDbRow,
  type TruckDbRow,
} from "./classify.js";
import { reconcile } from "./reconcile.js";
import {
  applyProduction,
  type ProductionCompact,
  type ApplyResult,
  type ProductionBatchStart,
} from "./apply.js";

export type { ProductionHumanEdit } from "./apply.js";

export const REPORT_TYPE = "production";

const CODIFIED_RULES = [
  "rounding-null-zero-noop", "L-007", "L-014", "L-025", "L-026", "L-027", "L-028",
  "parent-shift-first-fk-order", "generated-cols-never-written",
  "batch-from-running-state",
] as const;

// ── DB-window shape the classify oracle consumes (matches fixtures/production) ──
interface ProductionDbWindow {
  shifts?: ShiftDbRow[];
  runs?: RunDbRow[];
  downtime?: DowntimeDbRow[];
  waste?: WasteDbRow[];
  electricity?: ElectricityDbRow[];
  trucks?: TruckDbRow[];
}

/** The composed classify envelope: one section per classifier result dict. */
export interface ProductionClassifyResult {
  runs: SectionResult;
  downtime: SectionResult;
  waste: SectionResult;
  electricity: SectionResult;
  trucks: SectionResult;
}

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------

export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const result = await runClassify(workbookPaths, dbWindow, opts);
  // The classify envelope IS the composed 5-section object. The harness compares
  // by value after canonicalization, so cast through ClassifyEnvelope.
  return result as unknown as ClassifyEnvelope;
};

/** Shared classify body used by BOTH classifyCase and runReport. */
async function runClassify(
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ProductionClassifyResult> {
  const win = dbWindow as ProductionDbWindow;
  const shifts = win.shifts ?? [];
  const since = String(opts.since);
  const year = parseInt(since.slice(0, 4), 10);

  // The running-batch seed is a runReport-phase input the ORCHESTRATOR resolves
  // from the live DB. The frozen parity entrypoint deliberately leaves it UNSET
  // unless a caller passes it explicitly, so every fixture runs the documented
  // cold-start path and reproduces the Python calendar derivation byte-for-byte.
  // (`ClassifyOpts` carries an index signature, so this is a legal extra knob.)
  const runningBatch =
    typeof opts.runningBatch === "string" && opts.runningBatch.trim() ? opts.runningBatch : null;

  // MC role (runs/downtime/electricity/trucks). Absent → empty extract.
  let mc: McExtract = emptyMcExtract();
  if (workbookPaths.mc) {
    const wb = await loadProductionWorkbook(await readFile(workbookPaths.mc));
    mc = extractMc(wb, year, since, { runningBatch });
  }

  // Ivy role (waste). Absent → empty extract.
  let ivy: IvyExtract = { waste: [] };
  if (workbookPaths.ivy) {
    const wb = await loadProductionWorkbook(await readFile(workbookPaths.ivy));
    ivy = extractIvy(wb, since);
  }

  return composeClassify(mc, ivy, shifts, win);
}

/** Run all 5 classifiers and compose the oracle-shaped result. */
function composeClassify(
  mc: McExtract,
  ivy: IvyExtract,
  shifts: ShiftDbRow[],
  win: ProductionDbWindow,
): ProductionClassifyResult {
  return {
    runs: classifyRuns(mc.runs, win.runs ?? [], shifts),
    downtime: classifyDowntime(mc.downtime, win.downtime ?? [], shifts),
    waste: classifyWaste(ivy.waste, win.waste ?? [], shifts),
    electricity: classifyElectricity(mc.electricity, win.electricity ?? []),
    trucks: classifyTrucks(mc.trucks, win.trucks ?? []),
  };
}

// ---------------------------------------------------------------------------
// Full orchestrator — runReport (apply-phase; DB + Gmail injected).
// ---------------------------------------------------------------------------

export interface StoredAttachmentLike {
  storagePath: string;
  filename: string;
  emailUid: number | string;
  emailSubject?: string;
  threadId?: string | null;
}

/** Per-report manifest slice: mail-clerk keys "production_mc" (MC) + "production_waste" (Ivy).
 *  These are the canonical Mail-Clerk Storage sub-keys (mailClerk.ts::mailQueries, also
 *  lib/investigator/source.ts::SOURCE_KEYS). The MC slot is "production_mc", NOT "production"
 *  — reading the bare "production" silently drops MC's workbook (2026-07-15 regression). */
export interface ProductionManifest {
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

export interface RunReportResult {
  classify: {
    report_type: string;
    ok: boolean;
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
    per_section: Record<string, number>;
  };
  apply: ApplyResult;
}

/**
 * The full production sync fused into one durable run for the worker. Computes
 * since/watermark from the live DB, fetches MC + Ivy (either may be absent),
 * extracts both, builds the DB window (shifts + denormalized children + natural-key
 * tables) the way sync_production.py does, classifies all 5 sections, runs the
 * INFORMATIONAL reconcile (never gates), and applies FK-safe.
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: ProductionManifest,
  opts: { since?: string } = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  // Watermark + since (sync_production.py:90-91). `since` is EXCLUSIVE, NOT tail-offset.
  // Anchor on the MC RUNS frontier, NOT MAX(production_shifts.transaction_date): Ivy's
  // CUMULATIVE waste workbook upserts a parent shift for every waste day of the month,
  // so a plain shifts-max watermark runs ahead of MC and makes extractMc silently drop
  // MC's own day-sheets (runs/downtime/electricity/trucks stall with no error).
  // production_runs is MC-only → its frontier is MC's true watermark. opts.since still
  // overrides; the "2025-01-01" floor still applies. See db.productionRunsFrontier().
  const watermark = await db.productionRunsFrontier();
  const since = opts.since ?? (watermark ?? "2025-01-01");
  const year = parseInt(since.slice(0, 4), 10);

  // The `production_batch` already RUNNING before this run's first sheet. `since`
  // is EXCLUSIVE at sheet level (sheets are `> since`), so every shift dated at or
  // below it is strictly before every sheet we are about to read. One small read;
  // 200 rows is ~7 months of shifts, far more than the tie-break needs.
  const priorShifts = (await db.readRows("production_shifts", {
    sinceColumn: null,
    columns: ["transaction_date", "production_batch"],
    extraFilters: {
      transaction_date: `lte.${since}`,
      order: "transaction_date.desc",
      limit: "200",
    },
  })) as ShiftBatchRow[];
  const runningBatch = resolveRunningBatch(priorShifts, since);

  const mcAtt = firstAttachment(manifest, "production_mc");
  const ivyAtt = firstAttachment(manifest, "production_waste");

  if (!mcAtt && !ivyAtt) {
    await emit?.("finalize", "Nothing new today — no production or waste report waiting.", 100);
    const emptyApply: ApplyResult = {
      report_type: REPORT_TYPE, ok: true, inserts: 0, updates: 0, held: [],
      labeled: false, watermark_updated: false, errors: [], production_batch_starts: [],
      production_human_edits: [],
    };
    return {
      classify: {
        report_type: REPORT_TYPE, ok: true,
        counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
        watermark, codified_rules_applied: CODIFIED_RULES,
        per_section: { runs: 0, downtime: 0, waste: 0, electricity: 0, trucks: 0 },
      },
      apply: emptyApply,
    };
  }

  const found = [
    mcAtt ? "production report" : null,
    ivyAtt ? "waste report" : null,
  ].filter(Boolean);
  await emit?.("fetch", `Found ${found.length} report(s): ${found.join(", ")}`, 22);

  // Extract both sides.
  await emit?.("extract", "Reading the production spreadsheet(s)…", 30);
  let mc: McExtract = emptyMcExtract();
  if (mcAtt) {
    const path = await deps.fetchToLocalPath(mcAtt.storagePath);
    mc = extractMc(await loadProductionWorkbook(await readFile(path)), year, since, {
      runningBatch,
    });
  }
  let ivy: IvyExtract = { waste: [] };
  if (ivyAtt) {
    const path = await deps.fetchToLocalPath(ivyAtt.storagePath);
    ivy = extractIvy(await loadProductionWorkbook(await readFile(path)), since);
  }

  // DB window for shifts + children (sync_production.py:146-184). lo/hi = min/max of
  // runs+downtime+waste dates padded ±3 days; if empty, lo=hi=since.
  const allDates = [
    ...mc.runs.map((r) => r.transaction_date),
    ...mc.downtime.map((r) => r.transaction_date),
    ...ivy.waste.map((r) => r.transaction_date),
  ].filter((d): d is string => !!d).map((d) => d.slice(0, 10));
  let lo: string;
  let hi: string;
  if (allDates.length > 0) {
    lo = shiftDaysISO(allDates.reduce((a, b) => (a < b ? a : b)), -3);
    hi = shiftDaysISO(allDates.reduce((a, b) => (a > b ? a : b)), 3);
  } else {
    lo = since;
    hi = since;
  }

  // Shifts: read from lo, then Python-filter <= hi.
  const shiftsAll = (await db.readRows("production_shifts", {
    sinceDate: lo,
    columns: ["id", "transaction_date", "production_batch", "shift"],
  })) as ShiftDbRow[];
  const shifts = shiftsAll.filter((s) => String(s.transaction_date ?? "").slice(0, 10) <= hi);
  const shiftById = new Map<string, ShiftDbRow>();
  for (const s of shifts) if (s.id) shiftById.set(s.id, s);

  // Child DB rows: fetch ALL (no date filter), then keep only those whose shift_id
  // resolves to an in-window shift (sync_production.py::_child_db).
  // `human_edited_at` rides along on every one of these reads (the human-edit latch,
  // migration 20260803080000) so the apply can name a disagreement it must not write,
  // at ZERO extra round trips. It is inert for classify — the classifiers read named
  // fields and echo the EMAIL row as `record`, never the DB row — so parity is untouched.
  const childDb = async (table: string, extra: string[]): Promise<Row[]> => {
    const rows = await db.readRows(table, {
      sinceColumn: null,
      columns: ["id", "shift_id", "human_edited_at", ...extra],
    });
    const out: Row[] = [];
    for (const r of rows) {
      if (shiftById.has(String(r.shift_id))) out.push(r);
    }
    return out;
  };
  const dbRuns = (await childDb("production_runs", ["customer", "grade", "ttl_kg", "sacks_bags", "remarks"])) as RunDbRow[];
  const dbDowntime = (await childDb("production_downtime", ["shift_hrs", "dt_hrs", "dt_mins", "dt_reason"])) as DowntimeDbRow[];
  const dbWaste = (await childDb("production_waste", ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg", "remarks"])) as WasteDbRow[];
  // electricity + trucks: OWN reading_date filter from lo (no upper bound).
  const dbElec = (await db.readRows("electricity_readings", {
    sinceDate: lo, sinceColumn: "reading_date",
    columns: ["id", "reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks", "human_edited_at"],
  })) as ElectricityDbRow[];
  const dbTruck = (await db.readRows("truck_readings", {
    sinceDate: lo, sinceColumn: "reading_date",
    columns: ["id", "reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks", "human_edited_at"],
  })) as TruckDbRow[];

  const humanEditedIds = collectHumanEditedIds([dbRuns, dbDowntime, dbWaste, dbElec, dbTruck]);

  await emit?.("classify", "Comparing the reports against the database…", 55);
  const classified = composeClassify(mc, ivy, shifts, {
    runs: dbRuns, downtime: dbDowntime, waste: dbWaste, electricity: dbElec, trucks: dbTruck,
  });

  // Informational reconcile — never gates.
  await emit?.("reconcile", "Running an informational production cross-check…", 80);
  reconcile(mc, ivyAtt ? ivy : null, null);

  const sections = {
    runs: classified.runs.classifications,
    downtime: classified.downtime.classifications,
    waste: classified.waste.classifications,
    electricity: classified.electricity.classifications,
    trucks: classified.trucks.classifications,
  };
  const count = (klass: string) =>
    Object.values(sections).reduce((n, sec) => n + sec.filter((c) => c.class === klass).length, 0);
  const noop = count("DUPLICATE_NOOP");
  const insert = count("NEW");
  const update = count("VALUE_CHANGED");
  const flagged = count("MALFORMED");
  // Informational only: valid-grade runs rows with a blank TOTAL-kg cell (a
  // no-production shift). Never held, never gates — reported so the day is visible.
  const skippedNoOutput = count("SKIPPED_NO_OUTPUT");

  await emit?.(
    "classify",
    `${noop} already recorded · ${insert} new · ${update} changed` +
      (flagged ? ` · ${flagged} to review` : "") +
      (skippedNoOutput ? ` · ${skippedNoOutput} no-output day(s) skipped` : ""),
    92,
  );

  // Batch changeovers (`STARTING` markers) — at most once a month. Announced for
  // human confirmation because the batch NAME exists nowhere in the workbook: the
  // sync derives it from the running batch and has nothing to verify it against.
  //
  // Suppressed only once the changeover is ALREADY FULLY INGESTED — i.e. the
  // (date, new batch) shift already carries production RUNS. A shift that exists
  // with no runs does NOT suppress it: Ivy's cumulative waste workbook opens a
  // parent shift for the new batch on its own, and that must not silence the very
  // announcement this feature exists for. In the steady state `since` (the runs
  // frontier, exclusive) already keeps an ingested changeover day out of the
  // window entirely, so this fires exactly once.
  const shiftIdsWithRuns = new Set(dbRuns.map((r) => String(r.shift_id)));
  const ingestedChangeoverKeys = new Set(
    shifts
      .filter((s) => s.id && shiftIdsWithRuns.has(String(s.id)))
      .map(
        (s) =>
          `${String(s.transaction_date ?? "").slice(0, 10)}|` +
          `${String(s.production_batch ?? "").trim().toUpperCase()}`,
      ),
  );
  const batchStarts: ProductionBatchStart[] = mc.batch.transitions.filter(
    (t) => !ingestedChangeoverKeys.has(`${t.transaction_date}|${t.new_batch.trim().toUpperCase()}`),
  );
  for (const t of batchStarts) {
    await emit?.(
      "classify",
      `New production batch ${t.new_batch} opened on ${t.transaction_date} (follows ${t.previous_batch}) — please confirm the name.`,
      93,
      undefined,
      "warn",
    );
  }
  if (mc.batch.coldStartDates.length > 0) {
    await emit?.(
      "classify",
      `No earlier production batch on record — fell back to the calendar month for ` +
        `${mc.batch.coldStartDates.length} day(s): ${mc.batch.coldStartDates.join(", ")}.`,
      93,
      undefined,
      "warn",
    );
  }

  const compact: ProductionCompact = {
    report_type: REPORT_TYPE,
    since,
    window: [lo, hi],
    source: {
      mc_subject: mcAtt?.emailSubject ?? null,
      mc_uid: mcAtt?.emailUid ?? null,
      mc_thread_id: mcAtt?.threadId ?? null,
      ivy_subject: ivyAtt?.emailSubject ?? null,
      ivy_uid: ivyAtt?.emailUid ?? null,
      ivy_thread_id: ivyAtt?.threadId ?? null,
    },
    sections,
    batch_starts: batchStarts,
    human_edited_ids: humanEditedIds,
  };

  const apply = await applyProduction(compact, {
    db, labeler: deps.labeler, progress: deps.progress, noLabel: deps.noLabel, runTs: deps.runTs,
  });

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: true,
      counts: { noop, insert, update, flagged },
      watermark,
      codified_rules_applied: CODIFIED_RULES,
      per_section: {
        runs: sections.runs.length, downtime: sections.downtime.length, waste: sections.waste.length,
        electricity: sections.electricity.length, trucks: sections.trucks.length,
      },
    },
    apply,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
/**
 * Ids of DB-window rows a human owns (`human_edited_at IS NOT NULL`) — the advisory half
 * of the human-edit latch. Read off the rows the window already fetched; the binding
 * guard is inside `fn_apply_production_upstream`'s own UPDATE, so a row that becomes
 * human-owned after this snapshot is still protected.
 */
function collectHumanEditedIds(groups: Array<Array<unknown>>): string[] {
  const out = new Set<string>();
  for (const rows of groups) {
    for (const r of rows) {
      const row = (r ?? {}) as Row;
      if (row.human_edited_at != null && row.id) out.add(String(row.id));
    }
  }
  return [...out];
}

/** The "MC's email didn't arrive" extract — every section empty, no batch plan. */
function emptyMcExtract(): McExtract {
  const batch: BatchResolution = {
    seed: null,
    plans: new Map(),
    coldStartDates: [],
    transitions: [],
  };
  return { runs: [], downtime: [], electricity: [], trucks: [], dayTotals: {}, batch };
}

function firstAttachment(manifest: ProductionManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** ISO date ± N days (UTC). */
function shiftDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
