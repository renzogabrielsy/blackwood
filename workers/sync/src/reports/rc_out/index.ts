/**
 * index.ts — rc_out report port entrypoint.
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN parity entrypoint
 *       (src/reports/types.ts). Runs extract→classify OFFLINE against the DB
 *       snapshot and returns the classify envelope (the parity oracle unit).
 *   runReport(deps, runId, manifest, opts)       — the full two-phase orchestrator
 *       (fetch-from-storage → extract → reconcile GATES → classify → apply). DB and
 *       Gmail are injected as deps; this file never imports gmail/db directly beyond
 *       the shared lib types.
 *
 * Ground truth: sync_rc_out.py (orchestration), classify_rc_out.py (classify),
 * reconcile_rc_movement.py (gates), extract_proposed_daily.py + extract_rc_movement.py.
 */
import { readFile } from "node:fs/promises";

import type {
  ClassifyCase,
  ClassifyOpts,
  DbWindow,
  ClassifyEnvelope,
} from "../types.js";
import { loadWorkbook } from "../../lib/xlsx.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { extractProposed, extractMovement } from "./extract.js";
import { classifyRcOut, type ClassifyResult, type RcOutDbRow, type BatchLookup } from "./classify.js";
import { isKnownPatioAlias } from "../../reconcile/blockAliases.js";
import {
  reconcile,
  rcOutSumsFromRows,
  type RcOutSums,
  type ReconcileReport,
} from "./reconcile.js";
import {
  applyRcOut,
  type RcOutCompact,
  type ApplyResult,
  type GateDriftDate,
  type GateFailureDetail,
  type QuarantinedDate,
} from "./apply.js";
import { fmtKg } from "../held.js";

export const REPORT_TYPE = "rc_out";

const CODIFIED_RULES = [
  "rounding-null-zero-noop",
  "L-019",
  "L-020",
  "rc_out-drift-gate-500kg",
  "rc_out-db-duplication-gate",
  "batch_code-fallback-prefixes",
  "auto-create-pattern-valid-batch", // 2026-07-11 — reverses the old never-auto-create rule
] as const;

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------

/**
 * Runs the rc_out extract→classify pipeline offline. Reads ONLY the workbook(s) in
 * `workbookPaths` (role `primary` = PROPOSED) and the `dbWindow` snapshot; never a
 * live DB. The movement workbook role is NOT consumed here — reconciliation is
 * orchestrator-level and not part of the classify oracle (fixtures/rc_out manifest).
 *
 * `opts.since` → year = int(since[:4]); `opts.watermark` → sub-watermark guard.
 */
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const result = await runClassify(workbookPaths, dbWindow, opts);
  // The classify envelope IS the classify_rc_out.py result dict (top-level buckets +
  // summary). Cast through ClassifyEnvelope (the harness compares by value, not type).
  return result as unknown as ClassifyEnvelope;
};

/** Shared classify body used by BOTH classifyCase and runReport. */
async function runClassify(
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyResult> {
  const primaryPath = workbookPaths.primary;
  const win = dbWindow as {
    rc_out?: RcOutDbRow[];
    batch_lookup?: BatchLookup;
  };
  const batchLookup: BatchLookup = win.batch_lookup ?? {};
  const dbRows: RcOutDbRow[] = win.rc_out ?? [];
  const watermark = opts.watermark ?? null;

  // A missing primary workbook = the PROPOSED email did not arrive: classify an
  // empty extract (mirrors sync_rc_out.py early-return producing zero rows), NOT throw.
  if (!primaryPath) {
    return classifyRcOut({ extractedRows: [], batchLookup, dbRows, watermark });
  }

  const year = parseInt(String(opts.since).slice(0, 4), 10);
  const buf = await readFile(primaryPath);
  const wb = await loadWorkbook(buf);
  const proposed = extractProposed(wb, year);

  return classifyRcOut({ extractedRows: proposed.rows, batchLookup, dbRows, watermark });
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

/** Per-report manifest slice: role → attachments. rc_out uses `primary` + `movement`. */
export interface RcOutManifest {
  /** key → attachments (mail clerk keys: "rc_out" primary, "rc_out_movement" auxiliary). */
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  /** Download a stored attachment (Storage path → local file path) — injected. */
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  /** Gmail labeler — injected (apply never imports gmail). */
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  /** Progress emitter bound to (runId, "rc_out"). */
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

export interface RunReportResult {
  classify: {
    report_type: string;
    ok: boolean;
    gate_failures: GateFailureDetail[];
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
    /** Informational, non-holding notes (month-boundary label variance, L-034). The
     *  reportWorkflow threads these into classifyExtra so they survive normalizeReport. */
    soft_warnings: string[];
  };
  apply: ApplyResult;
}

/**
 * The full rc_out sync (sync_rc_out.py phase_classify + phase_apply fused into one
 * durable run for the worker). Computes `since`/`watermark` from the live DB, extracts
 * PROPOSED + (optional) RC MOVEMENT, runs the TWO HARD GATES, classifies, and applies.
 *
 * Gate semantics (rc_out.md "Gates & quarantine", 2026-07-11): a gate trip is DATE-SCOPED
 * quarantine, not a run-wide halt. Each gate identifies the specific transaction_date(s)
 * genuinely at risk (the DB is absent or ALSO disagrees with the movement-sheet witness);
 * apply holds only the actionable rows on those dates and writes every other date
 * normally. `classify.ok` is false whenever ANY date was quarantined (informs
 * CLEAN-vs-DIFFS-PENDING), but that no longer implies "nothing was written."
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: RcOutManifest,
  opts: { since?: string } = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  // Watermark + since (sync_rc_out.py:90-92).
  const watermark = await db.dataWatermark("rc_out");
  const since = opts.since ?? (watermark ? minusDaysISO(watermark, 3) : "2025-01-01");

  // Locate workbooks from the manifest (mail clerk keys → classify roles).
  const primaryAtt = firstAttachment(manifest, "rc_out");
  const movementAtt = firstAttachment(manifest, "rc_out_movement");

  if (!primaryAtt) {
    // No PROPOSED email — early return ok:true, nothing to ingest (sync_rc_out.py:98-106).
    await emit?.("finalize", "Nothing new today — no PROPOSED DAILY REPORT waiting.", 100);
    const emptyApply: ApplyResult = {
      report_type: REPORT_TYPE,
      ok: true,
      inserts: 0,
      updates: 0,
      held: [],
      labeled: false,
      watermark_updated: false,
      errors: [],
      auto_created_batches: [],
    };
    return {
      classify: {
        report_type: REPORT_TYPE,
        ok: true,
        gate_failures: [],
        counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
        watermark,
        codified_rules_applied: CODIFIED_RULES,
        soft_warnings: [],
      },
      apply: emptyApply,
    };
  }

  await emit?.("fetch", `Found the report: ${primaryAtt.emailSubject ?? "PROPOSED DAILY REPORT"}`, 15);
  const primaryPath = await deps.fetchToLocalPath(primaryAtt.storagePath);

  // Extract PROPOSED (all sheets, year from since[:4]).
  const year = parseInt(since.slice(0, 4), 10);
  await emit?.("extract", "Reading the daily feeding spreadsheet…", 28);
  const proposedWb = await loadWorkbook(await readFile(primaryPath));
  const proposedAll = extractProposed(proposedWb, year);

  // DATE-SETTLEMENT LEDGER (2026-07-12): a settled date has its DB total already
  // corroborated by the RC MOVEMENT sheet (see rc_out_date_settlements, populated by
  // workflows/runSync.ts::persistSettlements). Drop those rows BEFORE the gate
  // reconcile() calls and BEFORE classify — a settled date gets no extract-compare,
  // no classify, no gate eval, no held/flagged rows, full stop.
  //
  // PATIO WRITE-SKIP (2026-07-13, data-integrity fix): rc_out's natural key is
  // (transaction_date, batch_id, destination) — NO block_loc (see apply.ts:13). A
  // PROPOSED row at a known patio alias (src/reconcile/blockAliases.ts —
  // `isKnownPatioAlias`) is really the Sheet's SUNDRY batch at a coded PCA/PCB block;
  // PROPOSED mis-derives a BLK batch code for it from (block_date, block_no), and that
  // phantom row then COLLIDES on the natural key with a genuine, unrelated block feeding
  // attributed to the same derived batch — clobbering the real row every run (live proof:
  // rc_out row 0238c58d flip-flopped 6× between "JAN-26-BLK17 @ A-11B" (real) and
  // "JAN-26-BLK17 @ 15A MIDDLE SIDE" (patio duplicate of MARCH-26-SUNDRY7 @ PCA-15C)).
  // These feedings are Sheet-owned: PROPOSED cannot attribute the correct SUNDRY batch,
  // and the feeding already exists as the Sheet's SUNDRY row, so writing them can only
  // duplicate/clobber. Dropped here, same as a settled row, BEFORE gates and classify.
  //
  // Both skips share ONE filter pass. classifyCase (the parity-frozen entrypoint) is
  // untouched; this filter lives only here, in the live orchestrator, which has DB
  // access classifyCase does not.
  const settledDates = await db.readSettledDates();
  let skippedSettledCount = 0;
  let skippedPatioCount = 0;
  const proposedRows = proposedAll.rows.filter((r) => {
    if (settledDates.has(r.transaction_date)) {
      skippedSettledCount++;
      return false;
    }
    if (isKnownPatioAlias(r.block_loc)) {
      skippedPatioCount++;
      return false;
    }
    return true;
  });
  const proposed = { ...proposedAll, rows: proposedRows };
  if (skippedSettledCount > 0) {
    await emit?.(
      "classify",
      `Skipped ${skippedSettledCount} row(s) on already-settled date(s) — no re-check needed.`,
      30,
    );
  }
  if (skippedPatioCount > 0) {
    await emit?.(
      "classify",
      `Skipped ${skippedPatioCount} patio feeding(s) on the write path — Sheet-owned SUNDRY blocks, ` +
        `proposed can't attribute them (they remain the Sheet's records).`,
      30,
    );
  }

  // GATES (only when the RC MOVEMENT cross-check is present). Date-scoped quarantine
  // (not a run-wide halt): a gate trip marks ONLY the affected transaction_date(s) as
  // unsafe to write; apply still writes NEW/CHANGED rows for every clean date. See the
  // "Gates & quarantine" section of specs/rc_out.md.
  const gateFailures: GateFailureDetail[] = [];
  const quarantinedDates = new Map<string, QuarantinedDate[]>();
  const gateSoftWarnings: string[] = [];
  if (movementAtt) {
    await emit?.("reconcile", "Cross-checking feeding totals against the movement sheet…", 42);
    const movementPath = await deps.fetchToLocalPath(movementAtt.storagePath);
    const movementWb = await loadWorkbook(await readFile(movementPath));
    const movement = extractMovement(movementWb);

    // DB sums fetched ONCE — feed both GATE 2 (O-vs-M excess) and GATE 1's witness-
    // corroboration check (does the DB already match the movement sheet on a date
    // PROPOSED disagrees with?).
    const dbSumRows = await db.readRows("rc_out", {
      sinceDate: since,
      columns: ["transaction_date", "weight_kg"],
    });
    const dbSums: RcOutSums = rcOutSumsFromRows(dbSumRows);

    // GATE 1 — PROPOSED vs RC MOVEMENT. Run WITHOUT sums so this gate's own severity
    // stays free of O-vs-M bleed-through (that is GATE 2's job — see below). A serious
    // drift date is quarantined UNLESS the DB itself already matches the movement sheet
    // (a second witness corroborates the DB — the disagreement is stale PROPOSED history,
    // not a write risk).
    const rep1 = reconcile({ rows: proposed.rows }, movement, null, TOLERANCE_KG, SERIOUS_DRIFT_KG);
    const pvm = splitPvmDrift(rep1, dbSums, TOLERANCE_KG);
    gateSoftWarnings.push(...pvm.attention);
    if (pvm.quarantine.length) {
      gateFailures.push({
        gate: "proposed_vs_movement_drift_500kg",
        detail:
          `${pvm.quarantine.length} date(s) with a serious PROPOSED-vs-MOVEMENT drift the ` +
          `DB does not corroborate — quarantined; other dates still written.`,
        drift_dates: pvm.quarantine,
      });
      for (const d of pvm.quarantine) {
        addQuarantine(quarantinedDates, d.date, "proposed_vs_movement_drift_500kg", d);
      }
    }

    // GATE 2 — DB-vs-RC-MOVEMENT duplication. Isolated to REAL O-vs-M excess entries
    // only (dupDriftDates filters on excess_o_vs_m_kg — never tripped by a P-vs-M drift
    // riding along in the same reconcile pass, which used to leave this gate's held row
    // with no per-date detail whenever the trip was actually a GATE-1-shaped disagreement).
    const rep2 = reconcile({ rows: proposed.rows }, movement, dbSums, TOLERANCE_KG, SERIOUS_DRIFT_KG);
    const dup = dupDriftDates(rep2);
    if (dup.length) {
      gateFailures.push({
        gate: "db_vs_movement_duplication",
        detail:
          "rc_out DB SUM exceeds RC MOVEMENT (O>M) on a settled date — suspected duplication; date(s) quarantined.",
        drift_dates: dup,
      });
      for (const d of dup) {
        addQuarantine(quarantinedDates, d.date, "db_vs_movement_duplication", d);
      }
    }
  } else {
    await emit?.("reconcile", "No movement cross-check available — proceeding without drift gates.", 42, undefined, "warn");
  }

  // Classify (offline against a fresh snapshot). Build the DB window the same way the
  // orchestrator does: batch_lookup over ALL batches, rc_out over the since window.
  await emit?.("classify", "Comparing the report against the database…", 58);
  const batchRows = await db.readRows("batches", { columns: ["batch_code", "id"], sinceColumn: null });
  const batchLookup: BatchLookup = {};
  for (const b of batchRows) {
    const code = b.batch_code;
    if (code) batchLookup[String(code)] = String(b.id);
  }
  // L-034 (compare-set window): the JULY workbook permanently carries its "JUNE 30"
  // sheet, so the extractor yields rows OLDER than `since` (= watermark − 3d). Fetching
  // the dedup compare-set at the `since` floor leaves those settled rows compared against
  // a snapshot that CANNOT contain their saved copy → a recurring false sub-watermark
  // hold every run. Widen the floor to cover the OLDEST extracted row's date so every
  // incoming row is compared against its own settled DB copy. Bounded (never earlier than
  // the extract's own min), so this does not read the whole table.
  const extractMin = minExtractDate(proposed.rows);
  const compareSince = extractMin && extractMin < since ? extractMin : since;
  const dbRows = (await db.readRows("rc_out", {
    sinceDate: compareSince,
    columns: ["id", "transaction_date", "batch_id", "production_batch", "destination", "weight_kg", "block_loc", "remarks"],
  })) as RcOutDbRow[];

  const classified = classifyRcOut({
    extractedRows: proposed.rows,
    batchLookup,
    dbRows,
    watermark,
  });
  const s = classified.summary;

  const gateTripped = gateFailures.length > 0;
  await emit?.(
    "classify",
    `${s.noop_count} already recorded · ${s.new_count} new · ${s.changed_count} changed`,
    90,
  );

  // L-034 month-boundary label-variance notes + GATE-1 witness-corroboration attention
  // notes (item 2 above) both ride the SAME informational, non-holding channel: they
  // surface on the live feed as a `warn`-level beat and travel in the classify block's
  // `soft_warnings` so they reach the app without gating anything.
  const softWarnings = [...classified.soft_warnings.map((w) => w.message), ...gateSoftWarnings];
  for (const msg of softWarnings) {
    await emit?.("classify", msg, 90, undefined, "warn");
  }

  // Build the compact hand-off and run apply.
  const compact: RcOutCompact = {
    report_type: REPORT_TYPE,
    since,
    watermark,
    gate_failures: gateFailures,
    quarantined_dates: Array.from(quarantinedDates.values()).flat(),
    source: {
      email_subject: primaryAtt.emailSubject ?? null,
      email_uid: primaryAtt.emailUid,
      email_thread_id: primaryAtt.threadId ?? null,
    },
    actionable: {
      new: classified.new,
      changed: classified.changed,
      flagged: classified.flagged.map((f) => ({ index: f.index, reason: f.reason, row: f.row })),
      unmapped: classified.unmapped.map((u) => ({ index: u.index, reason: u.reason, row: u.row })),
      malformed: classified.malformed.map((m) => ({ reason: m.reason, row: m.row })),
    },
    batch_lookup: batchLookup,
  };

  const apply = await applyRcOut(compact, {
    db,
    labeler: deps.labeler,
    progress: deps.progress,
    noLabel: deps.noLabel,
    runTs: deps.runTs,
  });

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: !gateTripped,
      gate_failures: gateFailures,
      counts: {
        noop: s.noop_count,
        insert: s.new_count,
        update: s.changed_count,
        flagged: s.flagged_count + s.unmapped_count + s.malformed_count,
      },
      watermark,
      codified_rules_applied: CODIFIED_RULES,
      soft_warnings: softWarnings,
    },
    apply,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstAttachment(manifest: RcOutManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** Min transaction_date (lexicographic over zero-padded ISO) across extracted rows;
 *  null when there are none. Used to widen the dedup compare-set floor (L-034). */
function minExtractDate(rows: Array<{ transaction_date?: string | null }>): string | null {
  let m: string | null = null;
  for (const r of rows) {
    const d = r.transaction_date;
    if (d && (m === null || d < m)) m = d;
  }
  return m;
}

const SERIOUS_DRIFT_KG = 500;
const TOLERANCE_KG = 50;

/** Add one quarantine record for `date`, keyed off a Map so multiple gates tripping the
 *  same date accumulate rather than overwrite. */
function addQuarantine(
  map: Map<string, QuarantinedDate[]>,
  date: string,
  gate: string,
  detail: GateDriftDate,
): void {
  const entry: QuarantinedDate = { date, gate, detail };
  const list = map.get(date);
  if (list) list.push(entry);
  else map.set(date, [entry]);
}

/**
 * GATE 1 split — for each date with a serious PROPOSED-vs-MOVEMENT gap (or no movement
 * entry at all), decide whether it is safe to write:
 *   - `quarantine`: the DB is absent for the date, OR the DB's own sum for the date ALSO
 *     disagrees with the movement sheet (beyond `toleranceKg`) — writing here risks
 *     propagating a bad value, so the date is held back.
 *   - `attention`: the DB's sum for the date already matches the movement sheet within
 *     tolerance. A second witness (the DB itself) corroborates the DB, so the PROPOSED
 *     disagreement is stale report history (old day-tabs the workbook still carries),
 *     never a write risk. Downgraded to an informational, non-blocking note.
 * A missing movement entry can never be corroborated (no second witness to compare
 * against) — always quarantined, matching the prior conservative behavior.
 */
export function splitPvmDrift(
  rep: ReconcileReport,
  dbSums: RcOutSums,
  toleranceKg: number,
): { quarantine: GateDriftDate[]; attention: string[] } {
  const quarantine: GateDriftDate[] = [];
  const attention: string[] = [];
  for (const e of rep.drift_dates) {
    const missingMovement = e.proposed_sum_kg !== null && e.rc_movement_kg === null;
    const seriousGap =
      e.drift_p_vs_m_kg !== null && Math.abs(e.drift_p_vs_m_kg) > SERIOUS_DRIFT_KG;
    if (!missingMovement && !seriousGap) continue;

    if (missingMovement) {
      quarantine.push({
        date: e.date,
        proposed_kg: e.proposed_sum_kg,
        movement_kg: e.rc_movement_kg,
        diff_kg: e.drift_p_vs_m_kg,
        note: "no movement entry",
      });
      continue;
    }

    const dbKg = Object.prototype.hasOwnProperty.call(dbSums, e.date) ? dbSums[e.date] : null;
    const mKg = e.rc_movement_kg;
    const corroborated = dbKg !== null && mKg !== null && Math.abs(dbKg - mKg) <= toleranceKg;
    if (corroborated) {
      attention.push(
        `Proposed history disagrees with the movement sheet on ${e.date} ` +
          `(proposed ${fmtKg(e.proposed_sum_kg)} kg vs movement ${fmtKg(mKg)} kg), but the ` +
          `database already matches the movement sheet (${fmtKg(dbKg)} kg) — informational, ` +
          `no action needed.`,
      );
      continue;
    }

    quarantine.push({
      date: e.date,
      proposed_kg: e.proposed_sum_kg,
      movement_kg: e.rc_movement_kg,
      diff_kg: e.drift_p_vs_m_kg,
    });
  }
  return { quarantine, attention };
}

/**
 * GATE 2 detail: the dates where the rc_out DB sum materially EXCEEDS the movement sheet
 * (suspected already-saved duplicate feedings). Carries the DB sum, the movement total,
 * and the excess. Pure kg totals, no ₱.
 */
export function dupDriftDates(rep: ReconcileReport): GateDriftDate[] {
  const out: GateDriftDate[] = [];
  for (const e of rep.drift_dates) {
    if (e.excess_o_vs_m_kg === null || e.excess_o_vs_m_kg <= SERIOUS_DRIFT_KG) continue;
    out.push({
      date: e.date,
      db_sum_kg: e.rc_out_existing_kg,
      movement_kg: e.rc_movement_kg,
      excess_kg: e.excess_o_vs_m_kg,
    });
  }
  return out;
}

/** since = watermark - N days (sync_rc_out.py: date.fromisoformat - timedelta). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
