/**
 * workbook.ts — build the Excel sync report for one run.
 *
 * PURE (no DB, no network, no filesystem): everything it needs is handed in, and it hands
 * back a Buffer plus the counts describing what it wrote. That makes it unit-testable with
 * synthetic runs AND runnable against a real historical run by a script that only supplies
 * the reads (see `scripts/gen-run-report.ts`).
 *
 * WHAT RENZO ASKED FOR, and what each part answers:
 *   "All the loud things you said (warnings but proceeding to enrich etc) should be
 *    reported in the excel sheet for an easier way for me to digest and track."
 *
 *   - Summary sheet          — the whole run in one screen: is it clean, what needs a look,
 *                              and per-section written / refused / warned / errored.
 *   - One sheet per section  — every finding for that lane, one row each.
 *   - Awaiting Review sheet  — the durable cases still waiting on a human decision.
 *   - Run Log sheet          — every progress beat, filterable by level. This is where a
 *                              warning that never became a finding lives, and it is
 *                              precisely where the August price outage was hiding: one
 *                              `warn` beat saying "Price file unavailable" that did not
 *                              outlive the run.
 *
 * THE FINDING LIST IS NOT RE-DERIVED HERE. It comes from the app's
 * `flattenRunFindings` via `./findingsBridge.ts` — one definition, shared with the panel,
 * so the workbook can never disagree with the screen.
 *
 * ============================ NO PESO VALUE IS EMITTED ============================
 * The report is price-free BY CONSTRUCTION, and that is a design decision rather than an
 * omission:
 *   - The finding vocabulary it is built from carries no cost field ANYWHERE, on purpose
 *     (see `app/(app)/sync/types.ts::PriceNote` — "NEVER CARRIES A ₱/COST VALUE,
 *     deliberately" — and `RunFinding.data`'s own contract). Even the price findings
 *     identify the row and describe the problem in words; the number stays in RC IN behind
 *     `canViewPrices()`.
 *   - The one raw input that CAN carry money is `sync_held_cases.row` (a delivery's held
 *     row includes `cost_basis`). It is emitted only through `formatFindingData`, which
 *     strips any cost-ish key using `isCostKey` — the same single definition the app uses.
 *   - `auditPriceFree()` then re-checks every string this module actually wrote. If it ever
 *     finds money, `containsPrices` comes back TRUE, the DB row records that, and the
 *     download gate engages by itself. The claim is enforced, not asserted.
 *
 * Consequence, stated plainly: there is no accounting-format currency column, because
 * there is no currency column. Numbers (weights, days, counts) are right-aligned with
 * thousands separators.
 */
import ExcelJS from "exceljs";

import {
  flattenRunFindings,
  formatFindingData,
  isCostKey,
  type FindingSection,
  type FindingSeverity,
  type RunFinding,
  type AppSyncRunResult,
} from "./findingsBridge.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One `sync_run_events` row, exactly as read back (every field defensive-nullable). */
export interface ReportEventRow {
  report_type: string | null;
  stage: string | null;
  pct: number | null;
  label: string | null;
  detail: string | null;
  level: string | null;
  at: string | null;
}

/** One `sync_held_cases` row this run touched. `row` is raw jsonb — cost-stripped on emit. */
export interface ReportCaseRow {
  report_type: string | null;
  kind: string | null;
  natural_key: string | null;
  status: string | null;
  reason: string | null;
  detail: string | null;
  row: unknown;
  occurrence_count: number | null;
  created_at: string | null;
  last_seen_at: string | null;
  known_ruling_id: string | null;
}

export interface SyncReportInput {
  runId: string;
  /** `succeeded` | `partial` | `failed` | `cancelled` | … (free text, rendered as-is). */
  runStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
  dryRun: boolean;
  /**
   * The assembled run result. NULL for a crashed or stopped run — the workbook still
   * generates (Summary + Run Log carry real value exactly then), it just has no findings.
   */
  result: AppSyncRunResult | null;
  events: ReportEventRow[];
  cases: ReportCaseRow[];
  /** `sync_runs.error` — the crash text, when there is one. */
  runError?: string | null;
  generatorVersion: string;
}

export interface BuiltWorkbook {
  buffer: Buffer;
  /** Sheet name -> DATA row count (header excluded; the "nothing flagged" placeholder is 0). */
  sheetCounts: Record<string, number>;
  findingCount: number;
  /** Progress beats at `warn` level. */
  warnCount: number;
  /** Progress beats at `error` level (the level added 2026-08-07). */
  errorCount: number;
  /** FALSE only when `auditPriceFree` confirmed no money reached any cell. */
  containsPrices: boolean;
}

// ---------------------------------------------------------------------------
// Section registry — the sheet order Renzo reads in.
// ---------------------------------------------------------------------------

interface SectionDef {
  key: FindingSection;
  sheet: string;
  /** The `sync_runs.result.reports` key, when the section IS a report. */
  reportKey: string | null;
  /** The `sync_run_events.report_type` values that belong to this section. */
  eventTypes: string[];
  /** One line under the sheet title on Summary — what this lane is. */
  blurb: string;
}

const SECTIONS: readonly SectionDef[] = [
  {
    key: "deliveries",
    sheet: "Deliveries",
    reportKey: "deliveries",
    eventTypes: ["deliveries"],
    blurb: "RC DELIVERIES email + Czarina price matching",
  },
  {
    key: "rc_out",
    sheet: "RC OUT",
    reportKey: "rc_out",
    eventTypes: ["rc_out"],
    blurb: "PROPOSED DAILY REPORT feedings + the three-witness cross-check",
  },
  {
    key: "gsheet",
    sheet: "Google Sheet",
    reportKey: "gsheet",
    eventTypes: ["gsheet"],
    blurb: "The shared Sheet's RC IN + RC OUT tabs, and batch closes",
  },
  {
    key: "blocking",
    sheet: "Blocking",
    reportKey: null,
    eventTypes: [],
    blurb: "Sheet Blocking tab vs the balance the app computes",
  },
  {
    key: "rc_movement",
    sheet: "RC Movement",
    reportKey: "rc_movement",
    eventTypes: ["rc_movement", "rc_movement_audit"],
    blurb: "Read-only feeding-total watchdog (never writes)",
  },
  {
    key: "production",
    sheet: "Production",
    reportKey: "production",
    eventTypes: ["production"],
    blurb: "MC + Ivy reports, the plan, electricity and trucks",
  },
  {
    key: "flecon",
    sheet: "FLECON",
    reportKey: "flecon",
    eventTypes: ["flecon"],
    blurb: "Empty bag stock (replace-by-date)",
  },
  {
    key: "run",
    sheet: "Run",
    reportKey: null,
    eventTypes: ["_run"],
    blurb: "The sync run itself, not any one report",
  },
] as const;

const AWAITING_SHEET = "Awaiting Review";
const LOG_SHEET = "Run Log";
const SUMMARY_SHEET = "Summary";

/** Event report_type -> section. Unknown types land on `run` rather than being dropped. */
function sectionForEventType(reportType: string | null): FindingSection {
  const rt = (reportType ?? "").trim();
  for (const s of SECTIONS) {
    if (s.eventTypes.includes(rt)) return s.key;
  }
  return "run";
}

// ---------------------------------------------------------------------------
// Formatting helpers (deterministic; no locale surprises)
// ---------------------------------------------------------------------------

const SEVERITY_TEXT: Record<FindingSeverity, string> = {
  high: "HIGH",
  attention: "ATTENTION",
  info: "info",
};

/** Severity sort weight — loudest first inside a sheet. */
const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, attention: 1, info: 2 };

/** Solid fills per severity. Colour is a BONUS — the text column is the real signal. */
const SEVERITY_FILL: Record<FindingSeverity, string> = {
  high: "FFF4C7C3",
  attention: "FFFCE8B2",
  info: "FFEFEFEF",
};

const HEADER_FILL = "FF1F2933";
const TITLE_FILL = "FFE8EAED";

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A plain `YYYY-MM-DD` -> a real Excel date cell value, pinned to UTC NOON.
 *
 * A calendar date has no timezone, but exceljs must turn it into a serial number, and a
 * Date at UTC midnight can land on the previous day once a viewer's offset is applied.
 * Noon puts twelve hours of slack on both sides, so no realistic offset can cross the day
 * boundary. Anything that is not exactly `YYYY-MM-DD` is returned as text rather than
 * guessed at.
 */
function dateCell(v: unknown): Date | string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return s;
  return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
}

/**
 * A timestamptz -> `YYYY-MM-DD HH:mm:ss` in ASIA/MANILA, as TEXT.
 *
 * Text, not a date cell, for two reasons: an instant genuinely has a timezone and Renzo
 * reads Manila time (the run at 02:47Z is his 10:47), and ISO-ordered text sorts and
 * filters chronologically anyway. Doing the offset arithmetic into a serial number would
 * be the one place a silent hour-shift could hide.
 */
const MANILA_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function manilaText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts: Record<string, string> = {};
  for (const p of MANILA_FMT.formatToParts(d)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

/** Whole seconds -> "5m 46s" / "48s". */
function durationText(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "";
  const a = new Date(startedAt).getTime();
  const b = new Date(finishedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "";
  const secs = Math.round((b - a) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * Is this case still waiting on a human?
 *
 * `resolved` is the ONE terminal status — `investigated` means the investigator has had a
 * look and formed a verdict, which is precisely the state that still needs a person to agree
 * or disagree (the Sync Review list treats it the same way: only `resolved` is hidden behind
 * "Show resolved"). Counting only `open` here would have reported "0 cases awaiting a
 * decision" on a run whose Awaiting Review sheet held 61 of them.
 */
function isAwaitingDecision(status: string | null): boolean {
  const s = (status ?? "").toLowerCase();
  return s !== "resolved" && s !== "dismissed";
}

/** Compact scalar for a Side A / Side B cell. Objects are JSON so nothing is lost. */
function sideValue(v: unknown): string {
  if (v == null || v === "") return "none";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Finding -> row projection
// ---------------------------------------------------------------------------

/**
 * The keys that get their OWN column, so `Details` carries only what is left. Keeping this
 * list next to the column definitions is what stops the same fact appearing twice.
 */
const PROMOTED_KEYS = new Set([
  "transaction_date",
  "plan_date",
  "through_date",
  "batch_code",
  "batch",
  "new_batch",
  "weight_kg",
  "days_pending",
  "ageDays",
  "missed_working_days",
  "date_tolerance_days",
  // Consumed by Side A / Side B.
  "sources",
  "differences",
  "changed_fields",
  "current",
  "proposed",
  "gsheet",
  "sheet_kg",
  "computed_kg",
  "sheet_batch",
  "computed_batch",
  "tabs_found",
  "candidates",
  "looked_for",
]);

interface Sides {
  a: string;
  b: string;
}

const NO_SIDES: Sides = { a: "", b: "" };

/**
 * BOTH VALUES, SIDE BY SIDE — the column pair Renzo specifically asked for ("every fuzzy
 * match, with BOTH values side by side"), generalized to every two-sided finding the sync
 * can raise. Each cell carries `who: what`, so a reader never has to remember which column
 * means which source.
 *
 * Returns blanks for a one-sided finding. Never throws: every field is read defensively
 * because `data` ultimately comes from jsonb.
 */
export function sidesForFinding(f: RunFinding): Sides {
  const d = f.data ?? {};

  // Price spelling disagreements: ours vs Czarina's, field by field.
  const differences = Array.isArray(d.differences) ? d.differences : null;
  if (differences && differences.length) {
    const ours: string[] = [];
    const theirs: string[] = [];
    for (const raw of differences) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const field = str(e.field) ?? "value";
      ours.push(`${field} ${sideValue(e.ours)}`);
      theirs.push(`${field} ${sideValue(e.theirs)}`);
    }
    return { a: `ours: ${ours.join("; ")}`, b: `Czarina: ${theirs.join("; ")}` };
  }

  // A price tab that could not be resolved (or resolved twice): what it wanted vs what the
  // file actually has. This is the pair that would have made the August outage obvious.
  const tabsFound = Array.isArray(d.tabs_found) ? (d.tabs_found as unknown[]) : null;
  const candidates = Array.isArray(d.candidates) ? (d.candidates as unknown[]) : null;
  if (f.kind === "price_tab_unresolved" || f.kind === "price_tab_ambiguous") {
    const wanted = str(d.looked_for) ?? "that month";
    const found = (candidates && candidates.length ? candidates : (tabsFound ?? []))
      .map((t) => String(t))
      .join(", ");
    return { a: `looked for: ${wanted}`, b: found ? `file has: ${found}` : "" };
  }

  // rc_out: two or three witnesses on one field.
  const sources = Array.isArray(d.sources) ? d.sources : null;
  if (sources && sources.length >= 2) {
    const field = str(d.field) ?? "value";
    const render = (raw: unknown) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      return `${str(s.source) ?? "?"}: ${field} ${sideValue(s.value)}`;
    };
    return { a: render(sources[0]), b: sources.slice(1).map(render).join(" | ") };
  }

  // Blocking cross-check: the Sheet against the app's own arithmetic.
  if (f.kind === "block_diff") {
    const sheetBatch = str(d.sheet_batch);
    const appBatch = str(d.computed_batch);
    if (d.subkind === "batch_mismatch" && (sheetBatch || appBatch)) {
      return { a: `sheet: ${sheetBatch ?? "none"}`, b: `app: ${appBatch ?? "none"}` };
    }
    const sheetKg = num(d.sheet_kg);
    const appKg = num(d.computed_kg);
    if (sheetKg != null || appKg != null) {
      return {
        a: `sheet: ${sheetKg == null ? "none" : `${Math.round(sheetKg).toLocaleString("en-US")} kg`}`,
        b: `app: ${appKg == null ? "none" : `${Math.round(appKg).toLocaleString("en-US")} kg`}`,
      };
    }
    return NO_SIDES;
  }

  // rc_out attribution: same feeding, two different batch/block stories.
  if (f.kind === "attribution_diff") {
    const side = (raw: unknown, label: string) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const code = str(s.batch_code) ?? str(s.batch) ?? "no batch";
      const block = str(s.block_loc) ?? "feed";
      return `${label}: ${code} @ ${block}`;
    };
    return { a: side(d.proposed, "proposed"), b: side(d.gsheet, "sheet") };
  }

  // A production row a human owns: the changed fields carry both values already.
  if (f.kind === "production_human_edited" && Array.isArray(d.changed_fields)) {
    const yours: string[] = [];
    const sheet: string[] = [];
    for (const raw of d.changed_fields) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const field = str(e.field) ?? "value";
      yours.push(`${field} ${sideValue(e.yours)}`);
      sheet.push(`${field} ${sideValue(e.sheet)}`);
    }
    return { a: `yours: ${yours.join("; ")}`, b: `report: ${sheet.join("; ")}` };
  }

  // A plan day a human owns: `changed_fields` is a name list, values live in current/proposed.
  if (f.kind === "schedule_conflict" && Array.isArray(d.changed_fields)) {
    const cur = (d.current ?? {}) as Record<string, unknown>;
    const prop = (d.proposed ?? {}) as Record<string, unknown>;
    const yours: string[] = [];
    const theirs: string[] = [];
    for (const raw of d.changed_fields) {
      const field = str(raw);
      if (!field) continue;
      yours.push(`${field} ${sideValue(cur[field])}`);
      theirs.push(`${field} ${sideValue(prop[field])}`);
    }
    if (yours.length) return { a: `yours: ${yours.join("; ")}`, b: `Joseph: ${theirs.join("; ")}` };
  }

  return NO_SIDES;
}

/** "How late / how far", in days — whichever of the four day-ish fields the kind carries. */
function daysForFinding(f: RunFinding): number | null {
  const d = f.data ?? {};
  return (
    num(d.days_pending) ??
    num(d.ageDays) ??
    num(d.missed_working_days) ??
    num(d.date_tolerance_days)
  );
}

/** Everything not already promoted to its own column, cost-stripped. */
function detailsForFinding(f: RunFinding): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.data ?? {})) {
    if (PROMOTED_KEYS.has(k)) continue;
    rest[k] = v;
  }
  return formatFindingData(rest);
}

interface FindingColumn {
  header: string;
  key: string;
  width: number;
  numFmt?: string;
  align?: "left" | "right" | "center";
  wrap?: boolean;
}

/**
 * ONE column shape for every section sheet. Uniform on purpose: the sheets differ in which
 * rows they hold, never in how to read a row, so muscle memory carries across all eight.
 */
const FINDING_COLUMNS: readonly FindingColumn[] = [
  { header: "Severity", key: "severity", width: 11, align: "center" },
  { header: "What", key: "what", width: 36 },
  { header: "Source", key: "source", width: 30 },
  { header: "Date", key: "date", width: 12, numFmt: "yyyy-mm-dd", align: "center" },
  { header: "Where", key: "where", width: 24 },
  { header: "Batch", key: "batch", width: 18 },
  { header: "Weight (kg)", key: "weight", width: 13, numFmt: "#,##0", align: "right" },
  { header: "Days", key: "days", width: 7, numFmt: "#,##0", align: "right" },
  { header: "Side A", key: "sideA", width: 34, wrap: true },
  { header: "Side B", key: "sideB", width: 34, wrap: true },
  { header: "Headline", key: "headline", width: 58, wrap: true },
  { header: "Why", key: "why", width: 80, wrap: true },
  { header: "Details", key: "details", width: 70, wrap: true },
] as const;

// ---------------------------------------------------------------------------
// Per-section counts (written / refused / warned / errored)
// ---------------------------------------------------------------------------

interface SectionStats {
  ran: boolean;
  inserts: number | null;
  updates: number | null;
  replacedDates: number | null;
  held: number | null;
  flagged: number | null;
  noop: number | null;
  gateFailures: number;
  applyErrors: number;
  warns: number;
  errors: number;
  findings: number;
  high: number;
  attention: number;
  status: string;
}

function emptyStats(): SectionStats {
  return {
    ran: false,
    inserts: null,
    updates: null,
    replacedDates: null,
    held: null,
    flagged: null,
    noop: null,
    gateFailures: 0,
    applyErrors: 0,
    warns: 0,
    errors: 0,
    findings: 0,
    high: 0,
    attention: 0,
    status: "not run",
  };
}

function computeSectionStats(
  input: SyncReportInput,
  findingsBySection: Map<FindingSection, RunFinding[]>,
): Map<FindingSection, SectionStats> {
  const out = new Map<FindingSection, SectionStats>();
  const reports = (input.result?.reports ?? {}) as Record<string, unknown>;

  for (const def of SECTIONS) {
    const s = emptyStats();

    if (def.reportKey) {
      const rep = reports[def.reportKey] as
        | { classify?: unknown; apply?: unknown; status?: unknown; error?: unknown }
        | undefined;
      if (rep) {
        s.ran = true;
        const classify = (rep.classify ?? null) as {
          counts?: { insert?: number; update?: number; noop?: number; flagged?: number };
          gate_failures?: unknown[];
        } | null;
        const apply = (rep.apply ?? null) as {
          applied?: { inserts?: number; updates?: number; replaced_dates?: number };
          held?: unknown[];
          errors?: unknown[];
        } | null;

        if (classify?.counts) {
          s.noop = num(classify.counts.noop) ?? 0;
          s.flagged = num(classify.counts.flagged) ?? 0;
        }
        s.gateFailures = Array.isArray(classify?.gate_failures) ? classify!.gate_failures!.length : 0;

        if (apply) {
          s.inserts = num(apply.applied?.inserts) ?? 0;
          s.updates = num(apply.applied?.updates) ?? 0;
          s.replacedDates = num(apply.applied?.replaced_dates) ?? 0;
          s.held = Array.isArray(apply.held) ? apply.held.length : 0;
          s.applyErrors = Array.isArray(apply.errors) ? apply.errors.length : 0;
        } else if (classify) {
          // Classify-only (dry run, or a gate failure that stopped before apply).
          s.inserts = 0;
          s.updates = 0;
          s.held = 0;
        }
        s.status = str(rep.status) ?? (s.gateFailures > 0 ? "gate-failed" : "done");
      }
    } else {
      // `blocking` and `run` are lanes, not reports — they ran iff the run produced a result.
      s.ran = input.result != null;
      s.status = s.ran ? "done" : "not run";
    }

    out.set(def.key, s);
  }

  // Progress beats, bucketed by the section their report_type belongs to.
  for (const ev of input.events) {
    const level = (ev.level ?? "").toLowerCase();
    if (level !== "warn" && level !== "error") continue;
    const key = sectionForEventType(ev.report_type);
    const s = out.get(key);
    if (!s) continue;
    if (level === "error") s.errors += 1;
    else s.warns += 1;
  }

  // Findings.
  for (const def of SECTIONS) {
    const s = out.get(def.key)!;
    const list = findingsBySection.get(def.key) ?? [];
    s.findings = list.length;
    s.high = list.filter((f) => f.severity === "high").length;
    s.attention = list.filter((f) => f.severity === "attention").length;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Sheet writers
// ---------------------------------------------------------------------------

function styleHeaderRow(ws: ExcelJS.Worksheet, rowNumber: number, columnCount: number): void {
  const row = ws.getRow(rowNumber);
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
  row.alignment = { vertical: "middle", horizontal: "left", wrapText: false };
  for (let c = 1; c <= columnCount; c += 1) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  }
  row.height = 18;
  row.commit();
}

/** Freeze the header row and put an autofilter over the whole used range. */
function finishTable(ws: ExcelJS.Worksheet, headerRow: number, lastRow: number, columnCount: number): void {
  ws.views = [{ state: "frozen", ySplit: headerRow }];
  ws.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(lastRow, headerRow), column: columnCount },
  };
}

/**
 * Write one section sheet. An EMPTY section still gets a sheet, and gets one explicit
 * "Nothing flagged" row rather than bare headers — an empty grid reads as a broken report,
 * and "this lane is clean" is a real answer that deserves saying out loud.
 */
function writeSectionSheet(
  wb: ExcelJS.Workbook,
  def: SectionDef,
  findings: RunFinding[],
  stats: SectionStats,
  audit: string[],
): number {
  const ws = wb.addWorksheet(def.sheet);
  ws.columns = FINDING_COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  ws.addRow([def.sheet]);
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
  const subtitle = stats.ran
    ? `${def.blurb} — ${findings.length} flagged, ${stats.warns} warning(s), ${stats.errors} error(s)`
    : `${def.blurb} — did not run in this sync`;
  ws.addRow([subtitle]);
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: "FF5F6368" } };
  audit.push(def.sheet, subtitle);

  const headerRow = 3;
  ws.addRow(FINDING_COLUMNS.map((c) => c.header));
  styleHeaderRow(ws, headerRow, FINDING_COLUMNS.length);

  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.key.localeCompare(b.key),
  );

  let dataRows = 0;
  if (sorted.length === 0) {
    const msg = stats.ran
      ? "Nothing flagged — no warnings, errors or held rows for this section."
      : "This section did not run in this sync (no source file, or it was skipped).";
    const r = ws.addRow({ severity: "—", what: "Nothing flagged", headline: msg });
    r.font = { italic: true, color: { argb: "FF5F6368" }, size: 10 };
    audit.push(msg);
  } else {
    for (const f of sorted) {
      const sides = sidesForFinding(f);
      const details = detailsForFinding(f);
      const d = f.data ?? {};
      const dateVal = dateCell(d.transaction_date ?? d.plan_date ?? d.through_date);
      const batch = str(d.batch_code) ?? str(d.batch) ?? str(d.new_batch) ?? "";
      const values = {
        severity: SEVERITY_TEXT[f.severity],
        what: f.kindLabel,
        source: f.source,
        date: dateVal ?? "",
        where: f.location,
        batch,
        weight: num(d.weight_kg),
        days: daysForFinding(f),
        sideA: sides.a,
        sideB: sides.b,
        headline: f.title,
        why: f.reason,
        details,
      };
      const row = ws.addRow(values);
      row.getCell("severity").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: SEVERITY_FILL[f.severity] },
      };
      if (f.severity === "high") row.getCell("severity").font = { bold: true, size: 10 };
      dataRows += 1;
      audit.push(
        values.what,
        values.source,
        values.where,
        batch,
        sides.a,
        sides.b,
        values.headline,
        values.why,
        details,
      );
    }
  }

  // Column formats + alignment (applied after the rows exist so every cell inherits).
  FINDING_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    col.alignment = {
      horizontal: c.align ?? "left",
      vertical: "top",
      wrapText: c.wrap ?? false,
    };
  });
  // The title/subtitle/header rows must not inherit the body alignment.
  ws.getRow(1).alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).alignment = { horizontal: "left", vertical: "middle" };
  styleHeaderRow(ws, headerRow, FINDING_COLUMNS.length);

  finishTable(ws, headerRow, headerRow + Math.max(dataRows, 1), FINDING_COLUMNS.length);
  return dataRows;
}

const AWAITING_COLUMNS: readonly FindingColumn[] = [
  { header: "Status", key: "status", width: 14, align: "center" },
  { header: "Section", key: "section", width: 14 },
  { header: "What", key: "what", width: 34 },
  { header: "Identity", key: "identity", width: 46, wrap: true },
  { header: "Seen in runs", key: "seen", width: 12, numFmt: "#,##0", align: "right" },
  { header: "First seen", key: "first", width: 20, align: "center" },
  { header: "Last seen", key: "last", width: 20, align: "center" },
  { header: "Known ruling", key: "ruling", width: 13, align: "center" },
  { header: "Why", key: "why", width: 80, wrap: true },
  { header: "Row data", key: "rowData", width: 90, wrap: true },
] as const;

/**
 * The durable cases this run touched — "anything awaiting arbitration", from
 * `sync_held_cases` rather than from the run result, because a case's whole point is that
 * it OUTLIVES the run that raised it (occurrence_count, a prior ruling, a status a human
 * set days ago).
 *
 * `Row data` is the one place a raw delivery row reaches this workbook, so it goes through
 * `formatFindingData` — which strips `cost_basis` along with every other cost-ish key.
 */
function writeAwaitingSheet(wb: ExcelJS.Workbook, cases: ReportCaseRow[], audit: string[]): number {
  const ws = wb.addWorksheet(AWAITING_SHEET);
  ws.columns = AWAITING_COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  ws.addRow([AWAITING_SHEET]);
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
  const open = cases.filter((c) => isAwaitingDecision(c.status)).length;
  const subtitle =
    cases.length === 0
      ? "No case was raised or re-raised by this run."
      : `${cases.length} case(s) touched by this run, ${open} still waiting on a decision. A case persists until someone makes one.`;
  ws.addRow([subtitle]);
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: "FF5F6368" } };
  audit.push(AWAITING_SHEET, subtitle);

  const headerRow = 3;
  ws.addRow(AWAITING_COLUMNS.map((c) => c.header));
  styleHeaderRow(ws, headerRow, AWAITING_COLUMNS.length);

  const STATUS_RANK: Record<string, number> = { open: 0, investigating: 1, investigated: 2 };
  const sorted = [...cases].sort(
    (a, b) =>
      (STATUS_RANK[a.status ?? ""] ?? 9) - (STATUS_RANK[b.status ?? ""] ?? 9) ||
      (a.kind ?? "").localeCompare(b.kind ?? "") ||
      (a.natural_key ?? "").localeCompare(b.natural_key ?? ""),
  );

  let dataRows = 0;
  if (sorted.length === 0) {
    const r = ws.addRow({ status: "—", what: "Nothing awaiting review", why: subtitle });
    r.font = { italic: true, color: { argb: "FF5F6368" }, size: 10 };
  } else {
    for (const c of sorted) {
      const rowData =
        c.row && typeof c.row === "object"
          ? formatFindingData(c.row as Record<string, unknown>)
          : "";
      const why = str(c.reason) ?? str(c.detail) ?? "";
      const values = {
        status: c.status ?? "",
        section: c.report_type ?? "",
        what: c.kind ?? "",
        identity: c.natural_key ?? "",
        seen: num(c.occurrence_count),
        first: manilaText(c.created_at),
        last: manilaText(c.last_seen_at),
        ruling: c.known_ruling_id ? "yes" : "",
        why,
        rowData,
      };
      ws.addRow(values);
      dataRows += 1;
      audit.push(values.section, values.what, values.identity, why, rowData);
    }
  }

  AWAITING_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    col.alignment = { horizontal: c.align ?? "left", vertical: "top", wrapText: c.wrap ?? false };
  });
  ws.getRow(1).alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).alignment = { horizontal: "left", vertical: "middle" };
  styleHeaderRow(ws, headerRow, AWAITING_COLUMNS.length);

  finishTable(ws, headerRow, headerRow + Math.max(dataRows, 1), AWAITING_COLUMNS.length);
  return dataRows;
}

const LOG_COLUMNS: readonly FindingColumn[] = [
  { header: "Level", key: "level", width: 10, align: "center" },
  { header: "When (Manila)", key: "when", width: 21, align: "center" },
  { header: "Section", key: "section", width: 14 },
  { header: "Stage", key: "stage", width: 11 },
  { header: "%", key: "pct", width: 6, numFmt: "#,##0", align: "right" },
  { header: "Message", key: "label", width: 62, wrap: true },
  { header: "Detail", key: "detail", width: 90, wrap: true },
] as const;

const LEVEL_TEXT: Record<string, string> = { error: "ERROR", warn: "WARN", info: "info" };
const LEVEL_FILL: Record<string, string> = { error: "FFF4C7C3", warn: "FFFCE8B2" };

/**
 * Event `report_type` -> the SHEET NAME its section owns, so the log's Section column reads
 * the same as the tab strip. Without this the log shows the worker's internal keys (`_run`,
 * `rc_movement_audit`), which are not words Renzo should have to learn to filter on.
 */
function eventSectionLabel(reportType: string | null): string {
  const key = sectionForEventType(reportType);
  return SECTIONS.find((s) => s.key === key)?.sheet ?? (reportType ?? "");
}

/**
 * Every progress beat, in order, filterable by Level.
 *
 * This sheet exists because a beat is where a warning lives BEFORE anyone thinks to give it
 * a durable channel — and that is not hypothetical. For a week the sync's entire vocabulary
 * for a total price failure was one beat reading "Price file unavailable — proceeding
 * without prices." The file was available; only the tab name was unrecognized. The beat
 * died with the run and nine truckloads went unpriced. Keeping the log means the next such
 * beat is still readable tomorrow, whether or not anyone has modelled it as a finding yet.
 */
function writeLogSheet(wb: ExcelJS.Workbook, events: ReportEventRow[], audit: string[]): number {
  const ws = wb.addWorksheet(LOG_SHEET);
  ws.columns = LOG_COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  const warns = events.filter((e) => (e.level ?? "").toLowerCase() === "warn").length;
  const errors = events.filter((e) => (e.level ?? "").toLowerCase() === "error").length;

  ws.addRow([LOG_SHEET]);
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
  const subtitle = `${events.length} progress beat(s) — ${errors} error, ${warns} warning. Filter the Level column to see only the loud ones.`;
  ws.addRow([subtitle]);
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: "FF5F6368" } };
  audit.push(LOG_SHEET, subtitle);

  const headerRow = 3;
  ws.addRow(LOG_COLUMNS.map((c) => c.header));
  styleHeaderRow(ws, headerRow, LOG_COLUMNS.length);

  const sorted = [...events].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));

  let dataRows = 0;
  if (sorted.length === 0) {
    const r = ws.addRow({ level: "—", label: "No progress events were recorded for this run." });
    r.font = { italic: true, color: { argb: "FF5F6368" }, size: 10 };
  } else {
    for (const ev of sorted) {
      const level = (ev.level ?? "info").toLowerCase();
      const values = {
        level: LEVEL_TEXT[level] ?? level,
        when: manilaText(ev.at),
        section: eventSectionLabel(ev.report_type),
        stage: ev.stage ?? "",
        pct: num(ev.pct),
        label: ev.label ?? "",
        detail: ev.detail ?? "",
      };
      const row = ws.addRow(values);
      const fill = LEVEL_FILL[level];
      if (fill) {
        row.getCell("level").fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        if (level === "error") row.getCell("level").font = { bold: true, size: 10 };
      }
      dataRows += 1;
      audit.push(values.section, values.label, values.detail);
    }
  }

  LOG_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    col.alignment = { horizontal: c.align ?? "left", vertical: "top", wrapText: c.wrap ?? false };
  });
  ws.getRow(1).alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).alignment = { horizontal: "left", vertical: "middle" };
  styleHeaderRow(ws, headerRow, LOG_COLUMNS.length);

  finishTable(ws, headerRow, headerRow + Math.max(dataRows, 1), LOG_COLUMNS.length);
  return dataRows;
}

/**
 * The front sheet. The one Renzo should be able to read alone and know whether he needs to
 * look further — so it answers, in order: did it run cleanly, what needs attention, what
 * did each section actually write, and where does each number come from.
 */
function writeSummarySheet(
  wb: ExcelJS.Workbook,
  input: SyncReportInput,
  findings: RunFinding[],
  statsBySection: Map<FindingSection, SectionStats>,
  totals: { warns: number; errors: number },
  audit: string[],
): number {
  const ws = wb.addWorksheet(SUMMARY_SHEET);
  ws.columns = [
    { width: 22 },
    { width: 26 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
  ];

  const line = (label: string, value: string, bold = false): void => {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { bold: true, size: 10 };
    if (bold) r.getCell(2).font = { bold: true, size: 10 };
    audit.push(label, value);
  };
  const blank = (): void => {
    ws.addRow([]);
  };
  const heading = (text: string): void => {
    const r = ws.addRow([text]);
    r.font = { bold: true, size: 11 };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
    audit.push(text);
  };

  const title = ws.addRow(["Blackwood — Daily Sync Report"]);
  title.font = { bold: true, size: 16 };
  ws.addRow([
    input.dryRun
      ? "Dry run — the sync read everything and wrote nothing."
      : "Live run — everything below was actually applied unless a row says otherwise.",
  ]).font = { italic: true, size: 9, color: { argb: "FF5F6368" } };
  blank();

  heading("The run");
  line("Run id", input.runId);
  line("Started (Manila)", manilaText(input.startedAt));
  line("Finished (Manila)", manilaText(input.finishedAt));
  line("Took", durationText(input.startedAt, input.finishedAt));
  line("Outcome", input.runStatus, true);
  line("Mode", input.dryRun ? "dry run (no writes)" : "live");
  if (str(input.runError)) line("Run error", String(input.runError));
  blank();

  const high = findings.filter((f) => f.severity === "high").length;
  const attention = findings.filter((f) => f.severity === "attention").length;
  const info = findings.filter((f) => f.severity === "info").length;

  heading("Does this need you?");
  const verdict =
    high > 0
      ? `YES — ${high} thing(s) are loud. Start with the rows marked HIGH.`
      : attention > 0
        ? `MAYBE — nothing is broken, but ${attention} thing(s) want a decision.`
        : findings.length > 0
          ? `NO — ${info} item(s) are logged for the record only.`
          : "NO — clean run. Nothing was flagged anywhere.";
  line("Verdict", verdict, true);
  line("Flagged in total", String(findings.length));
  line("HIGH", String(high));
  line("ATTENTION", String(attention));
  line("For the record (info)", String(info));
  line("Warning beats", String(totals.warns));
  line("Error beats", String(totals.errors));
  line(
    "Cases awaiting a decision",
    String(input.cases.filter((c) => isAwaitingDecision(c.status)).length),
  );
  blank();

  // Per-section table.
  heading("By section");
  const sectionHeaderRow = ws.rowCount + 1;
  const sectionHeaders = [
    "Section",
    "What it covers",
    "Inserted",
    "Updated",
    "Dates replaced",
    "Held / refused",
    "Warnings",
    "Errors",
    "Flagged",
    "Status",
  ];
  ws.addRow(sectionHeaders);
  styleHeaderRow(ws, sectionHeaderRow, sectionHeaders.length);
  audit.push(...sectionHeaders);

  const nOrDash = (v: number | null): string | number => (v == null ? "—" : v);
  for (const def of SECTIONS) {
    const s = statsBySection.get(def.key)!;
    const row = ws.addRow([
      def.sheet,
      def.blurb,
      nOrDash(s.inserts),
      nOrDash(s.updates),
      nOrDash(s.replacedDates),
      nOrDash(s.held),
      s.warns,
      s.errors,
      s.findings,
      s.status,
    ]);
    if (s.high > 0) row.font = { bold: true, size: 10 };
    for (let c = 3; c <= 9; c += 1) {
      row.getCell(c).alignment = { horizontal: "right" };
      row.getCell(c).numFmt = "#,##0";
    }
    audit.push(def.sheet, def.blurb, s.status);
  }
  blank();

  // Headline problems.
  heading("Headline problems");
  const loud = findings
    .filter((f) => f.severity !== "info")
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.section.localeCompare(b.section) ||
        a.key.localeCompare(b.key),
    );
  const HEADLINE_CAP = 25;
  const problemHeaderRow = ws.rowCount + 1;
  const problemHeaders = ["Severity", "Sheet", "What", "Where", "Headline"];
  ws.addRow(problemHeaders);
  styleHeaderRow(ws, problemHeaderRow, problemHeaders.length);
  audit.push(...problemHeaders);

  if (loud.length === 0) {
    ws.addRow(["—", "", "Nothing needs your attention", "", "No HIGH or ATTENTION finding in this run."]).font = {
      italic: true,
      color: { argb: "FF5F6368" },
      size: 10,
    };
  } else {
    const sheetFor = new Map(SECTIONS.map((d) => [d.key, d.sheet] as const));
    for (const f of loud.slice(0, HEADLINE_CAP)) {
      const row = ws.addRow([
        SEVERITY_TEXT[f.severity],
        sheetFor.get(f.section) ?? f.section,
        f.kindLabel,
        f.location,
        f.title,
      ]);
      row.getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: SEVERITY_FILL[f.severity] },
      };
      if (f.severity === "high") row.getCell(1).font = { bold: true, size: 10 };
      audit.push(f.kindLabel, f.location, f.title);
    }
    if (loud.length > HEADLINE_CAP) {
      ws.addRow([
        "",
        "",
        `+ ${loud.length - HEADLINE_CAP} more`,
        "",
        "The section sheets carry the full list.",
      ]).font = { italic: true, color: { argb: "FF5F6368" }, size: 10 };
    }
  }
  blank();

  heading("How to read this");
  for (const [k, v] of [
    ["Severity", "HIGH = act now. ATTENTION = a decision is waiting. info = logged for the record. The word is the signal; the colour is only a hint."],
    ["Side A / Side B", "When two sources disagree, both values sit side by side. Each cell says who said what."],
    ["Held / refused", "Rows the sync would not write on its own — they need your judgment, and nothing was lost."],
    ["Days", "How late something is, in days: a delivery still unpriced, a lone witness with no second source, a report that has not arrived."],
    ["Run Log", "Every progress beat. Filter Level to WARN or ERROR to see only the loud ones."],
    ["Awaiting Review", "Cases that outlive this run. They stay until a human decides them, and they re-appear every run until then."],
    ["No peso figures", "This report deliberately carries no cost or price value anywhere. Prices live in RC IN, behind the price permission."],
  ] as const) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true, size: 9 };
    r.getCell(2).font = { size: 9, color: { argb: "FF5F6368" } };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
    audit.push(k, v);
  }
  blank();
  const gen = ws.addRow([
    "Generated by",
    `Blackwood sync worker ${input.generatorVersion} — ${manilaText(new Date().toISOString())} Manila`,
  ]);
  gen.getCell(1).font = { bold: true, size: 9 };
  gen.getCell(2).font = { size: 9, color: { argb: "FF5F6368" } };

  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  ws.views = [{ state: "frozen", ySplit: 2 }];
  // The Summary's own "row count" is the number of headline problems it lists — the only
  // count on this sheet that means anything to a caller reading `sheet_counts`.
  return Math.min(loud.length, HEADLINE_CAP);
}

// ---------------------------------------------------------------------------
// The peso audit
// ---------------------------------------------------------------------------

/** The peso sign, written as an escape so this source file stays plain ASCII. */
const PESO = "₱";

/**
 * Re-read every string this module wrote and decide whether any money got through.
 *
 * This is the enforcement behind `sync_run_reports.contains_prices`, and it is deliberately
 * a POST-HOC check on the emitted text rather than a promise made up front: a promise made
 * in a comment cannot notice the day someone adds a price field to a finding, and this can.
 * It looks for two things — the peso glyph, and a `costish_key=` token of the sort
 * `formatFindingData` is supposed to have stripped.
 *
 * Returns TRUE when the workbook is provably price-free.
 */
export function auditPriceFree(strings: readonly string[]): boolean {
  const keyToken = /([A-Za-z_][A-Za-z0-9_]*)=/g;
  for (const s of strings) {
    if (!s) continue;
    if (s.includes(PESO)) return false;
    keyToken.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = keyToken.exec(s)) !== null) {
      if (isCostKey(m[1])) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Build the workbook. NEVER reads the network or the disk; the caller supplies everything.
 *
 * A run with NOTHING to report still produces a complete, valid workbook — every sheet
 * present, every section saying "nothing flagged". That is deliberate: an empty report is a
 * meaningful answer ("clean"), and a MISSING report is indistinguishable from a generator
 * that quietly broke.
 */
export async function buildSyncReportWorkbook(input: SyncReportInput): Promise<BuiltWorkbook> {
  const findings: RunFinding[] = input.result ? flattenRunFindings(input.result) : [];

  const bySection = new Map<FindingSection, RunFinding[]>();
  for (const def of SECTIONS) bySection.set(def.key, []);
  for (const f of findings) {
    const list = bySection.get(f.section);
    if (list) list.push(f);
    else bySection.get("run")!.push(f); // unknown section is filed, never dropped
  }

  const statsBySection = computeSectionStats(input, bySection);
  const warnCount = input.events.filter((e) => (e.level ?? "").toLowerCase() === "warn").length;
  const errorCount = input.events.filter((e) => (e.level ?? "").toLowerCase() === "error").length;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Blackwood sync worker";
  wb.created = new Date();
  wb.title = `Blackwood sync report ${input.runId}`;

  // Every string that reaches a cell, collected for auditPriceFree.
  const audit: string[] = [input.runId, input.runStatus];

  const sheetCounts: Record<string, number> = {};
  sheetCounts[SUMMARY_SHEET] = writeSummarySheet(
    wb,
    input,
    findings,
    statsBySection,
    { warns: warnCount, errors: errorCount },
    audit,
  );
  for (const def of SECTIONS) {
    sheetCounts[def.sheet] = writeSectionSheet(
      wb,
      def,
      bySection.get(def.key) ?? [],
      statsBySection.get(def.key)!,
      audit,
    );
  }
  sheetCounts[AWAITING_SHEET] = writeAwaitingSheet(wb, input.cases, audit);
  sheetCounts[LOG_SHEET] = writeLogSheet(wb, input.events, audit);

  const priceFree = auditPriceFree(audit);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer as ArrayBuffer),
    sheetCounts,
    findingCount: findings.length,
    warnCount,
    errorCount,
    containsPrices: !priceFree,
  };
}

/** The sheet order, exported for tests and for the app's "what's inside" label. */
export const SYNC_REPORT_SHEETS: readonly string[] = [
  SUMMARY_SHEET,
  ...SECTIONS.map((s) => s.sheet),
  AWAITING_SHEET,
  LOG_SHEET,
];
