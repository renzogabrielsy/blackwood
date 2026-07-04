/**
 * index.ts — the rc_movement_audit report port entrypoint (Wave 3, port #6).
 *
 * rc_movement_audit is the READ-ONLY WATCHDOG: it NEVER writes to the DB and NEVER labels
 * Gmail. There is NO apply phase — only classify. Do not add a write path (rc_movement_audit.md
 * §5: the Python CLI's --phase argparse only accepts "classify").
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN Wave-3 contract
 *     (src/reports/types.ts). Extracts the RC MOVEMENT workbook, reconciles it against the
 *     rc_out daily-sums snapshot via the synthetic-proposed-from-rc_out-sums trick, and
 *     returns the EXACT oracle envelope `{ok, reconcile, severity}` the parity harness diffs.
 *   runReport(deps, ...)                         — the classify-only orchestrator scaffold the
 *     DBOS worker will wire later. All IO injected via `deps`; never imports gmail/db and
 *     NEVER writes or labels (mirrors audit_rc_movement.py::phase_classify).
 *
 * Ground truth: audit_rc_movement.py (orchestrator), extract_rc_movement.py, reconcile_rc_movement.py.
 * Oracle: build_oracle.py::oracle_rc_movement_audit → `{reconcile: rep, severity: returncode, ok: returncode < 2}`.
 */
import { readFile } from "node:fs/promises";

import type {
  ClassifyCase,
  ClassifyEnvelope,
  ClassifyOpts,
  DbWindow,
} from "../types.js";
import { loadWorkbook } from "../../lib/xlsx.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { extractMovement, type MovementExtract } from "./extract.js";
import {
  reconcile,
  type ReconcileReport,
  type ProposedForReconcile,
  type RcOutSums,
} from "./reconcile.js";

export const REPORT_TYPE = "rc_movement_audit";

/**
 * The reconciler defaults (tolerance 50 / serious 500). audit_rc_movement.py does NOT
 * override these via CLI args (unlike sync_rc_out.py, which explicitly passes 50/500) — it
 * relies on reconcile_rc_movement.py's argparse defaults, which happen to be the same values
 * (rc_movement_audit.md §6 rule "reconcile-drift-math").
 */
const TOLERANCE_KG = 50.0;
const SERIOUS_DRIFT_KG = 500.0;

const CODIFIED_RULES = ["reconcile-drift-math", "L-019", "L-024"] as const;

/**
 * The oracle envelope this port must reproduce byte-for-byte after canonicalization.
 * build_oracle.py::oracle_rc_movement_audit returns exactly:
 *   { reconcile: <the reconcile report file>, severity: <returncode int>, ok: <returncode < 2> }
 * The nested `reconcile` object carries ONLY {summary, drift_dates, ok_dates} — the severity
 * lives at the TOP level (it's the reconciler's exit code, not part of its JSON report).
 */
export interface AuditEnvelope {
  ok: boolean;
  reconcile: {
    summary: ReconcileReport["summary"];
    drift_dates: ReconcileReport["drift_dates"];
    ok_dates: ReconcileReport["ok_dates"];
  };
  severity: 0 | 1 | 2;
}

/** rc_movement_audit DB-window snapshot (types.ts role key): the rc_out daily sums map. */
interface AuditDbWindow {
  rc_out_sums?: RcOutSums;
}

/**
 * Build the reconciler inputs the auditor's synthetic-proposed trick uses
 * (audit_rc_movement.py:103-106): feed the SAME rc_out sums map BOTH as the "proposed"
 * rows AND as the `--rc-out-sums-json` gate input. By construction P == O for every date,
 * so p_vs_m == o_vs_m and drift_p_vs_o == 0 everywhere (rc_movement_audit.md §1 step 7).
 */
function syntheticProposedFromSums(sums: RcOutSums): ProposedForReconcile {
  // Object.entries preserves insertion order, matching Python's `for d, v in sums.items()`;
  // the canonicalizer sorts the block/date arrays anyway, so order is not load-bearing.
  return {
    rows: Object.entries(sums).map(([d, v]) => ({ transaction_date: d, weight_kg: v })),
  };
}

/** Run extract + reconcile and assemble the oracle envelope. Shared by classifyCase + runReport. */
function auditFromMovement(movement: MovementExtract, sums: RcOutSums): AuditEnvelope {
  const proposed = syntheticProposedFromSums(sums);
  const report = reconcile(
    proposed,
    { date_to_fed_kls: movement.date_to_fed_kls },
    sums,
    TOLERANCE_KG,
    SERIOUS_DRIFT_KG,
  );
  return {
    // strip the reconciler's internal `severity` field OUT of the nested report — the oracle's
    // reconcile object has only {summary, drift_dates, ok_dates}; severity is top-level.
    reconcile: {
      summary: report.summary,
      drift_dates: report.drift_dates,
      ok_dates: report.ok_dates,
    },
    severity: report.severity,
    ok: report.severity < 2, // audit_rc_movement.py:145 — ok=false ONLY on serious (severity 2).
  };
}

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------

/**
 * Reads ONLY the `movement` workbook role and the `rc_out_sums` snapshot; never a live DB.
 * Returns the `{ok, reconcile, severity}` audit envelope (the parity oracle unit).
 */
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  _opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const win = (dbWindow ?? {}) as AuditDbWindow;
  const sums: RcOutSums = win.rc_out_sums ?? {};

  const movementPath = workbookPaths.movement;
  // A missing movement workbook = no RC MOVEMENT email arrived: mirror the Python early
  // return (audit_rc_movement.py:79-89 — ok:true, note, nothing to audit). We reproduce the
  // classify-envelope-free early return as an empty-movement reconcile: with no movement fed
  // totals, every rc_out date drifts as "No RC MOVEMENT entry" — but the Python's real
  // early return short-circuits BEFORE reconcile. No fixture exercises this; be non-throwing.
  if (!movementPath) {
    const report = reconcile(
      syntheticProposedFromSums(sums),
      { date_to_fed_kls: {} },
      sums,
      TOLERANCE_KG,
      SERIOUS_DRIFT_KG,
    );
    return {
      reconcile: {
        summary: report.summary,
        drift_dates: report.drift_dates,
        ok_dates: report.ok_dates,
      },
      severity: report.severity,
      ok: report.severity < 2,
    } as unknown as ClassifyEnvelope;
  }

  const buf = await readFile(movementPath);
  const wb = await loadWorkbook(buf);
  const movement = extractMovement(wb);

  return auditFromMovement(movement, sums) as unknown as ClassifyEnvelope;
};

// ---------------------------------------------------------------------------
// Classify-only orchestrator — runReport (NO apply phase; DB + Gmail injected, NEVER writes).
// ---------------------------------------------------------------------------

export interface StoredAttachmentLike {
  storagePath: string;
  filename: string;
  emailUid: number | string;
  emailSubject?: string;
  threadId?: string | null;
}

/** Per-report manifest slice: role → attachments. rc_movement_audit uses `movement` only. */
export interface AuditManifest {
  /** key → attachments (mail clerk key: "rc_out_movement"). */
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  /** Download a stored attachment (Storage path → local file path) — injected. */
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  /** Progress emitter bound to (runId, "rc_movement_audit"). */
  progress?: ProgressEmitter;
  /**
   * The audit window floor (YYYY-MM-DD). If omitted, computed from the rc_out watermark
   * (watermark - 30 days; the auditor looks back FURTHER than a writer's -3-day tail —
   * rc_movement_audit.md §1 step 2), or "2025-01-01" on an empty table.
   */
  since?: string;
}

export interface RunReportResult {
  report_type: string;
  ok: boolean;
  /** The audit envelope (same shape classifyCase returns). null when no RC MOVEMENT email. */
  audit: AuditEnvelope | null;
  gate_failures: Array<{ gate: string; detail: string }>;
  counts: { noop: number; insert: number; update: number; flagged: number };
  watermark: string | null;
  audit_since: string | null;
  severity: "none" | "warning" | "serious" | null;
  codified_rules_applied: readonly string[];
  note?: string;
}

/**
 * The classify-only auditor run (audit_rc_movement.py::phase_classify), with all IO injected.
 * NEVER writes, NEVER labels Gmail — there is no apply phase to add. This is scaffolding for
 * the DBOS worker; the parity gate only exercises classifyCase.
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: AuditManifest,
  _opts: Record<string, unknown> = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  // Watermark reads the rc_out table (the table this auditor audits — it deliberately
  // piggybacks on rc_out's watermark; it has no table of its own). rc_movement_audit.md §1/§8.
  const watermark = await db.dataWatermark("rc_out");
  let since: string;
  if (deps.since) {
    since = deps.since;
  } else if (watermark) {
    since = minusDaysISO(watermark, 30);
  } else {
    since = "2025-01-01";
  }

  await emit?.("fetch", "Checking Gmail for the raw-charcoal movement report…", 8);
  const movementAtt = firstAttachment(manifest, "rc_out_movement");
  if (!movementAtt) {
    // No RC MOVEMENT email — early return ok:true, nothing to audit (audit_rc_movement.py:79-89).
    await emit?.("finalize", "Nothing to audit — no RC MOVEMENT report found.", 100);
    return {
      report_type: REPORT_TYPE,
      ok: true,
      audit: null,
      gate_failures: [],
      counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
      watermark,
      audit_since: since,
      severity: null,
      codified_rules_applied: CODIFIED_RULES,
      note: "No RC MOVEMENT email found in window — nothing to audit.",
    };
  }

  await emit?.("fetch", `Found the report: ${movementAtt.emailSubject ?? "RC MOVEMENT"}`, 25);
  const movementPath = await deps.fetchToLocalPath(movementAtt.storagePath);

  await emit?.("extract", "Reading the movement spreadsheet…", 40);
  const movementWb = await loadWorkbook(await readFile(movementPath));
  const movement = extractMovement(movementWb);

  // rc_out daily sums for the since window (never enters an agent context) —
  // audit_rc_movement.py:50-59 _rc_out_sums: group+sum weight_kg by date[:10], round 2dp.
  const dbRows = await db.readRows("rc_out", {
    sinceDate: since,
    columns: ["transaction_date", "weight_kg"],
  });
  const sums = rcOutSumsFromRows(dbRows);

  await emit?.("reconcile", `Cross-checking ${Object.keys(sums).length} day(s) of feeding totals…`, 60);
  const audit = auditFromMovement(movement, sums);
  const driftCount = audit.reconcile.drift_dates.length;
  const okCount = audit.reconcile.ok_dates.length;

  if (audit.severity >= 2) {
    await emit?.(
      "finalize",
      `Audit done — ${driftCount} day(s) need attention (serious drift).`,
      100,
      undefined,
      "warn",
    );
  } else if (driftCount) {
    await emit?.("finalize", `Audit done — ${okCount} day(s) match, ${driftCount} minor difference(s).`, 100);
  } else {
    await emit?.("finalize", `Audit done — all ${okCount} day(s) match.`, 100);
  }

  const severityWord = (["none", "warning", "serious"] as const)[audit.severity];
  return {
    report_type: REPORT_TYPE,
    ok: audit.ok, // ok=false ONLY on serious drift; a warning keeps ok=true (informational).
    audit,
    gate_failures: audit.severity >= 2
      ? [{
          gate: "rc_movement_serious_drift",
          detail: `${audit.reconcile.summary.drift_dates} drift date(s); max_severity=serious`,
        }]
      : [],
    // counts describe DISCREPANCIES, not writes (audit_rc_movement.py:19-21):
    // noop = agreeing dates, flagged = drift dates, insert/update always 0 (never writes).
    counts: { noop: okCount, insert: 0, update: 0, flagged: driftCount },
    watermark,
    audit_since: since,
    severity: severityWord,
    codified_rules_applied: CODIFIED_RULES,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute rc_out daily sums from a snapshot of rc_out rows over the since window
 * (audit_rc_movement.py:50-59 _rc_out_sums). Grouped by date[:10], summed, rounded 2dp.
 * A weight that float() can't parse is skipped (Python's try/except continue).
 */
function rcOutSumsFromRows(rows: Array<Record<string, unknown>>): RcOutSums {
  const sums: Record<string, number> = {};
  for (const r of rows) {
    const d = String(r.transaction_date ?? "").slice(0, 10);
    const wRaw = r.weight_kg;
    // Python: float(r.get("weight_kg") or 0); a non-parseable value → except → continue.
    let w: number;
    if (wRaw === null || wRaw === undefined || wRaw === 0 || wRaw === "" || wRaw === false) {
      w = 0;
    } else if (typeof wRaw === "number") {
      if (!Number.isFinite(wRaw)) continue;
      w = wRaw;
    } else if (typeof wRaw === "string") {
      const f = Number(wRaw.trim());
      if (!Number.isFinite(f)) continue;
      w = f;
    } else {
      continue;
    }
    sums[d] = (sums[d] ?? 0) + w;
  }
  const out: RcOutSums = {};
  for (const [k, v] of Object.entries(sums)) out[k] = round2(v);
  return out;
}

function firstAttachment(manifest: AuditManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** since = watermark - N days (audit_rc_movement.py: date.fromisoformat - timedelta). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
