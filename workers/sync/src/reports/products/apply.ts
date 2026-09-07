/**
 * apply.ts — write the classified grades through the three service-role RPCs.
 *
 * WRITE MODEL = REPLACE-BY-GRADE. The sheet is CUMULATIVE (every movement a tab has ever
 * carried is always in it), so the honest model is "make the database say exactly what
 * the tab says", keyed on `row_hash`. `fn_replace_product_grade` does the whole diff in
 * ONE transaction — the flecon lesson: a DELETE and an INSERT as two independent HTTP
 * calls is exactly what leaves a grade wiped with nothing written when the second one
 * fails.
 *
 * IDEMPOTENCE, STATED PRECISELY. A second run over an unchanged tab returns
 * `{inserted: 0, deleted: 0}` and writes NO FACT ROW — that is asserted in the tests.
 * It DOES still refresh `product_grades.last_seen_at`, which is run bookkeeping in the
 * same sense as `ingestion_watermarks.last_run_at`: without it "this tab was not in the
 * workbook today" could not be told from "we have not looked lately", and the
 * `product_sheet_missing` alarm would have nothing to stand on.
 *
 * A GRADE IS ISOLATED. One bad tab must not cost the other four their day's data, so
 * each grade is written inside its own try/catch and a failure becomes an entry in
 * `errors` (which then suppresses the watermark advance) rather than a thrown run.
 *
 * NO PESO ANYWHERE.
 */
import type { ClassifiedGrade, ProductsClassified } from "./classify.js";
import {
  productGradeAdded,
  productGradeAmbiguous,
  productGradeRenamed,
  productSheetMissing,
  type ProductNote,
} from "../productNotes.js";
import { errText } from "../../lib/operatorError.js";

export interface ProductsApplyDeps {
  db: {
    upsertProductGrade(args: {
      sheetName: string;
      thresholds: Record<string, unknown>;
      openingAsOf: string | null;
      fingerprint: string;
    }): Promise<{ ok: boolean; gradeId: string | null; code: string; created: boolean; reason?: string }>;
    renameProductGrade(
      gradeId: string,
      newSheetName: string,
    ): Promise<{ ok: boolean; renamed: boolean; reason?: string; message?: string }>;
    replaceProductGrade(
      gradeId: string,
      openings: Array<Record<string, unknown>>,
      movements: Array<Record<string, unknown>>,
    ): Promise<{ ok: boolean; inserted: number; deleted: number; unchanged: number; reason?: string }>;
    writeIngestionAudit(args: {
      tableName: string;
      recordId: string;
      operation: string;
      comment: string;
      diff?: Record<string, unknown> | null;
      snapshot?: Record<string, unknown> | null;
    }): Promise<{ id: string } | null>;
    upsertIngestionWatermark(
      reportType: string,
      opts?: { lastEmailId?: string | null; lastEmailReceivedAt?: string | null },
    ): Promise<boolean>;
  };
  progress?: (
    stage: "fetch" | "extract" | "classify" | "apply" | "reconcile" | "finalize",
    label: string,
    pct: number,
    detail?: string,
    level?: "info" | "warn" | "error",
  ) => Promise<void> | void;
}

export interface ProductsApplyResult {
  report_type: "products";
  ok: boolean;
  applied: { inserts: number; updates: number; replaced_dates: number };
  /** Rows removed because the tab no longer carries them. */
  deleted: number;
  grades_written: number;
  grades_created: number;
  grades_renamed: number;
  held: never[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  product_notes: ProductNote[];
  per_grade: Array<{
    code: string;
    sheet_name: string;
    action: string;
    inserted: number;
    deleted: number;
    unchanged: number;
  }>;
}

/** Strip a classified grade down to the RPC's movement payload. */
function movementPayload(g: ClassifiedGrade): Array<Record<string, unknown>> {
  return g.movements.map((m) => ({
    row_hash: m.row_hash,
    transaction_date: m.transaction_date,
    stage: m.stage,
    flec_delta: m.flec_delta,
    kg_delta: m.kg_delta,
    remarks: m.remarks,
    source_row: m.source_row,
    sheet_running: m.sheet_running,
  }));
}

export async function applyProducts(
  classified: ProductsClassified,
  deps: ProductsApplyDeps,
): Promise<ProductsApplyResult> {
  const { db } = deps;
  const errors: string[] = [];
  const notes: ProductNote[] = [];
  const perGrade: ProductsApplyResult["per_grade"] = [];
  let inserted = 0;
  let deleted = 0;
  let created = 0;
  let renamed = 0;
  let written = 0;

  for (const g of classified.grades) {
    try {
      // 1. A rename FIRST, so the header upsert cannot create a second grade under the
      //    new code while the old row is still sitting there under the old one.
      let gradeId = g.grade_id;
      if (g.action === "rename" && gradeId) {
        const r = await db.renameProductGrade(gradeId, g.sheet_name);
        if (!r.ok) {
          errors.push(
            `${g.sheet_name}: rename refused (${r.reason ?? "unknown"})${r.message ? ` — ${r.message}` : ""}`,
          );
          continue;
        }
        if (r.renamed) renamed += 1;
        await db.writeIngestionAudit({
          tableName: "product_grades",
          recordId: gradeId,
          operation: "UPDATE",
          comment:
            `provenance=products sync | Product grade renamed from "${g.previous_sheet_name}" ` +
            `to "${g.sheet_name}" on ${g.rename_evidence === "fingerprint" ? "an identical content fingerprint" : `a ${(((g.rename_overlap ?? 0) * 100)).toFixed(1)}% match of its existing movements`}.`,
          diff: {
            sheet_name: { old: g.previous_sheet_name, new: g.sheet_name },
            code: { old: g.previous_code, new: g.code },
          },
        });
      }

      // 2. The header (creates the row for a genuinely new grade).
      const up = await db.upsertProductGrade({
        sheetName: g.sheet_name,
        thresholds: g.thresholds,
        openingAsOf: g.opening_as_of,
        fingerprint: g.fingerprint,
      });
      if (!up.ok || !up.gradeId) {
        errors.push(`${g.sheet_name}: could not record the grade (${up.reason ?? "unknown"}).`);
        continue;
      }
      gradeId = up.gradeId;
      if (up.created) created += 1;

      // 3. The ledger — replace-by-grade, one transaction.
      const rep = await db.replaceProductGrade(
        gradeId,
        g.openings.map((o) => ({ stage: o.stage, flecs: o.flecs, as_of: o.as_of })),
        movementPayload(g),
      );
      if (!rep.ok) {
        errors.push(`${g.sheet_name}: could not write its movements (${rep.reason ?? "unknown"}).`);
        continue;
      }

      inserted += rep.inserted;
      deleted += rep.deleted;
      written += 1;
      perGrade.push({
        code: g.code,
        sheet_name: g.sheet_name,
        action: g.action,
        inserted: rep.inserted,
        deleted: rep.deleted,
        unchanged: rep.unchanged,
      });

      // An audit row ONLY when something actually moved — an unchanged tab must leave
      // no trace at all, or the trail becomes a log of the sync running rather than a
      // log of the data changing.
      if (rep.inserted > 0 || rep.deleted > 0) {
        await db.writeIngestionAudit({
          tableName: "product_movements",
          recordId: gradeId,
          operation: "REPLACE",
          comment:
            `provenance=products sync | ${g.sheet_name}: ${rep.inserted} movement(s) added, ` +
            `${rep.deleted} removed, ${rep.unchanged} unchanged.`,
          diff: { inserted: rep.inserted, deleted: rep.deleted, unchanged: rep.unchanged },
        });
      }

      if (g.action === "new") {
        notes.push(
          productGradeAdded({
            sheetName: g.sheet_name,
            code: g.code,
            movementCount: g.movements.length,
            inserted: rep.inserted,
          }),
        );
      } else if (g.action === "rename") {
        notes.push(
          productGradeRenamed({
            sheetName: g.sheet_name,
            code: g.code,
            previousSheetName: g.previous_sheet_name ?? "",
            previousCode: g.previous_code ?? "",
            evidence: g.rename_evidence ?? "fingerprint",
            overlap: g.rename_overlap,
            movementCount: g.movements.length,
            inserted: rep.inserted,
            deleted: rep.deleted,
          }),
        );
      }
      if (g.ambiguous_candidates && g.ambiguous_candidates.length > 0) {
        notes.push(
          productGradeAmbiguous({
            sheetName: g.sheet_name,
            code: g.code,
            candidates: g.ambiguous_candidates,
            movementCount: g.movements.length,
          }),
        );
      }
    } catch (err) {
      errors.push(`${g.sheet_name}: ${errText(err)}`);
    }
  }

  // A grade whose tab is gone. NEVER deleted, NEVER auto-deactivated — see classify.ts.
  for (const m of classified.missing) {
    notes.push(productSheetMissing({ sheetName: m.sheet_name, code: m.code }));
  }

  // The watermark is run bookkeeping and is advanced only on a clean pass, the same rule
  // every other apply follows.
  let watermarkUpdated = false;
  if (errors.length === 0) {
    watermarkUpdated = await db.upsertIngestionWatermark("products");
  }

  return {
    report_type: "products",
    ok: errors.length === 0,
    applied: { inserts: inserted, updates: 0, replaced_dates: written },
    deleted,
    grades_written: written,
    grades_created: created,
    grades_renamed: renamed,
    held: [],
    labeled: false, // a Google Sheet has no Gmail thread to label.
    watermark_updated: watermarkUpdated,
    errors,
    product_notes: notes,
    per_grade: perGrade,
  };
}
