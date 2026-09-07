/**
 * index.ts — the `products` report port entrypoint (finished-goods flecon inventory).
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts) — the FROZEN Wave-3 contract
 *     (src/reports/types.ts). `products` is TS-NATIVE and has NO PYTHON ORACLE (see
 *     specs/PORTING_DECISIONS.md), so no fixtures exist and the parity runner never
 *     discovers it. The entrypoint is implemented anyway so the contract is honoured the
 *     day someone builds a fixture, rather than being retrofitted under pressure.
 *   runReport(deps, runId, manifest, opts) — the workflow-layer entrypoint, copying the
 *     gsheet idiom exactly (it self-downloads; there is no email and nothing to label).
 *
 * THE PIPELINE: download -> extract -> classify against the DB -> apply through the three
 * RPCs -> notes. The one thing worth reading twice is the L-048 guard below.
 *
 * NO PESO ANYWHERE.
 */
import { readFile } from "node:fs/promises";

import type { ClassifyCase, ClassifyEnvelope, ClassifyOpts, DbWindow } from "../types.js";
import { loadWorkbook } from "../../lib/xlsx.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import { sourceTabsNote, isTotalTabFailure, type SourceTabNote } from "../sourceTabs.js";

import { extractProducts, type ProductsExtract } from "./extract.js";
import {
  classifyProducts,
  type DbProductGrade,
  type ProductsClassified,
  type ProductsDbWindow,
} from "./classify.js";
import { applyProducts, type ProductsApplyResult } from "./apply.js";
import { downloadProductsSheet, productsExportUrl, productsSheetId, type FetchLike } from "./download.js";

export const REPORT_TYPE = "products";

/** The plain-English name of the source, used in every operator-facing note. */
export const PRODUCTS_SOURCE_LABEL = "PRODUCTS INVENTORY sheet";

const CODIFIED_RULES = [
  "grade-identity-is-the-canonical-tab-name",
  "rename-decided-from-content-never-from-name-similarity",
  "ambiguous-rename-refused-and-named",
  "replace-by-grade-keyed-on-row-hash",
  "never-delete-a-grade",
  "date-carried-forward-within-a-day",
  "kg-null-never-zero",
  "L-048-empty-read-of-a-non-empty-file-is-loud",
] as const;

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts).
// ---------------------------------------------------------------------------
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  _opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  void _opts;
  const dw = (dbWindow ?? {}) as { grades?: DbProductGrade[]; hashes_by_grade?: Record<string, string[]> };
  const primary = workbookPaths.primary;
  const extract: ProductsExtract = primary
    ? extractProducts(await loadWorkbook(await readFile(primary)))
    : { grades: [], readable_tabs: [], unreadable_tabs: [], total_rows: 0 };

  const classified = classifyProducts(extract, {
    grades: dw.grades ?? [],
    hashesByGrade: dw.hashes_by_grade ?? {},
  });
  return classified as unknown as ClassifyEnvelope;
};

// ---------------------------------------------------------------------------
// Workflow-layer entrypoint.
// ---------------------------------------------------------------------------
export interface ProductsDeps {
  db: DbClient;
  progress?: ProgressEmitter;
  /** Injected fetch for the Sheet export. Defaults to the platform fetch. */
  fetchImpl?: FetchLike;
}

export interface ProductsRunResult {
  classify: {
    report_type: string;
    ok: boolean;
    gate_failures: never[];
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
    per_grade: ProductsClassified["summary"];
    source_tab_notes: SourceTabNote[];
  };
  apply: ProductsApplyResult | null;
}

/** Read the DB window the classifier needs: every grade, and every movement hash filed
 *  under it. Hashes only — nothing else is needed to answer "have I seen this row". */
export async function readProductsDbWindow(db: DbClient): Promise<ProductsDbWindow> {
  const gradeRows = await db.readRows("product_grades", {
    sinceColumn: null,
    columns: ["id", "code", "sheet_name", "content_fingerprint", "active"],
  });
  const grades: DbProductGrade[] = gradeRows.map((r) => ({
    id: String(r.id),
    code: String(r.code ?? ""),
    sheet_name: String(r.sheet_name ?? ""),
    content_fingerprint: r.content_fingerprint == null ? null : String(r.content_fingerprint),
    active: r.active !== false,
  }));

  const hashRows = await db.readRows("product_movements", {
    sinceColumn: null,
    columns: ["grade_id", "row_hash"],
  });
  const hashesByGrade: Record<string, string[]> = {};
  for (const r of hashRows) {
    const g = String(r.grade_id);
    (hashesByGrade[g] ??= []).push(String(r.row_hash));
  }
  return { grades, hashesByGrade };
}

export async function runReport(
  deps: ProductsDeps,
  runId: string,
  _manifest: Record<string, unknown> = {},
  opts: { dryRun?: boolean } = {},
): Promise<ProductsRunResult> {
  void runId;
  void _manifest;
  const { db } = deps;
  const emit = deps.progress;

  await emit?.("fetch", "Downloading the PRODUCTS INVENTORY sheet…", 8);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const buf = await downloadProductsSheet(fetchImpl, productsExportUrl());

  await emit?.("extract", "Reading each product's tab…", 25);
  const wb = await loadWorkbook(buf);
  const extract = extractProducts(wb);

  // ── L-048: an EMPTY READ of a NON-EMPTY FILE is an alarm, not a quiet day ──────
  // A tab whose ledger could not be located is reported through the EXISTING
  // `source_tabs_unreadable` channel rather than a parallel one — one workbook opened,
  // one vocabulary. When NOT ONE tab parsed, the run also leaves the watermark where it
  // is (there is nothing to be idempotent about, and the next run must re-read the file).
  const tabNote = sourceTabsNote({
    reportType: REPORT_TYPE,
    sourceLabel: PRODUCTS_SOURCE_LABEL,
    filename: `${productsSheetId()}.xlsx`,
    parsed: extract.readable_tabs,
    unparsed: extract.unreadable_tabs,
    rowsExtracted: extract.total_rows,
  });
  const totalFailure = tabNote != null && isTotalTabFailure(tabNote);
  const tabNotes = tabNote ? [tabNote] : [];

  await emit?.(
    "extract",
    `${extract.grades.length} product${extract.grades.length === 1 ? "" : "s"} · ` +
      `${extract.total_rows} movement${extract.total_rows === 1 ? "" : "s"}`,
    35,
    undefined,
    totalFailure ? "error" : extract.unreadable_tabs.length ? "warn" : "info",
  );

  await emit?.("classify", "Matching each tab against the products we know…", 55);
  const dbWindow = totalFailure
    ? { grades: [], hashesByGrade: {} }
    : await readProductsDbWindow(db);
  const classified = classifyProducts(extract, dbWindow);
  const s = classified.summary;

  await emit?.(
    "classify",
    `${s.unchanged_count} unchanged · ${s.changed_count} changed · ` +
      `${s.new_count} new · ${s.rename_count} renamed · ${s.missing_count} missing`,
    75,
  );

  const counts = {
    noop: s.unchanged_count,
    insert: s.new_count,
    update: s.changed_count + s.rename_count,
    flagged: s.missing_count + s.ambiguous_count + extract.unreadable_tabs.length,
  };

  const classify: ProductsRunResult["classify"] = {
    report_type: REPORT_TYPE,
    ok: !totalFailure,
    gate_failures: [],
    counts,
    watermark: null,
    codified_rules_applied: CODIFIED_RULES,
    per_grade: s,
    source_tab_notes: tabNotes,
  };

  if (opts.dryRun || totalFailure) {
    return { classify, apply: null };
  }

  await emit?.("apply", "Writing the product ledgers…", 88);
  const apply = await applyProducts(classified, {
    db: db as unknown as Parameters<typeof applyProducts>[1]["db"],
    progress: deps.progress,
  });
  // The tab notes belong on the APPLY block: that is where `collectSourceTabNotes` reads
  // them from for every other report, and a second location would be a second channel.
  const applyWithNotes = { ...apply, source_tab_notes: tabNotes } as ProductsApplyResult & {
    source_tab_notes: SourceTabNote[];
  };

  await emit?.(
    "finalize",
    `${apply.applied.inserts} movement(s) added · ${apply.deleted} removed · ` +
      `${apply.grades_created} new product(s) · ${apply.grades_renamed} renamed`,
    100,
    undefined,
    apply.errors.length ? "error" : "info",
  );

  return { classify, apply: applyWithNotes };
}

export { productsExportUrl, productsSheetId };
