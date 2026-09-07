/**
 * classify.ts — "is this tab a product we already know?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SMART PART, AND WHY IT IS NOT CLEVER
 * ─────────────────────────────────────────────────────────────────────────────
 * Renzo's requirement: *"automatically add grades in the inventory if there is a new
 * sheet detected (should be smart enough to know that a sheet wasn't detected as new
 * because of a rename or anything)"*.
 *
 * The temptation is to compare names — `8X50` vs `8x50 NEW`, edit distance, prefixes.
 * That is precisely the inference the Cenapro supplier subgroups refuse to make and the
 * batch-code alias table refuses to make: a similarity score is a guess wearing the
 * clothes of a fact, and the cost of being wrong here is MERGING TWO PRODUCTS' ledgers.
 *
 * So a rename is decided from DATA, on a two-rung ladder, and each rung requires the
 * candidate's own tab to be GONE from the workbook — a product cannot have been renamed
 * into a second tab while its first tab is still sitting there:
 *
 *   RUNG 1 — IDENTICAL CONTENT FINGERPRINT. The opening balances plus the first ten
 *            ledger rows, hashed (lib/productFingerprint.ts). That is the part of a tab
 *            that never changes once written, so an exact match is not evidence of
 *            similarity — it is evidence of sameness. Reported `info`: nothing is in
 *            doubt.
 *   RUNG 2 — >= 80% OF THE MOVEMENT ROW HASHES ALREADY EXIST under exactly one absent
 *            grade. This catches the case rung 1 cannot: a tab whose OPENING ROW was
 *            edited at the same time it was renamed. Reported `attention` WITH THE
 *            MEASURED PERCENTAGE, because it is an inference and a person should see the
 *            number that drove it.
 *   OTHERWISE — a NEW grade. Auto-created and ingested (`info`), which is exactly what
 *            Renzo asked for.
 *
 * AND ONE REFUSAL: if TWO OR MORE absent grades match, nothing is renamed. Ambiguity is
 * resolved in the reversible direction — a new grade is created (nothing is destroyed,
 * the old grades stay and are flagged as missing) rather than a ledger being merged into
 * the wrong product, which no later run could undo. The candidates are NAMED in the
 * finding so a human can settle it.
 *
 * A grade whose tab has DISAPPEARED and matched no rename is reported `product_sheet_
 * missing` and is NEVER deleted and never auto-deactivated: a tab can be hidden, moved to
 * another file, or renamed in a way this ladder does not recognise, and none of those is
 * a reason for a machine to retire a product. Deactivation stays a human act.
 */
import {
  buildFingerprintPayload,
  productGradeFingerprint,
  productRowHash,
  type FingerprintPayload,
} from "../../lib/productFingerprint.js";
import type { ProductGradeExtract, ProductsExtract } from "./extract.js";

/** THE rung-2 bar. A tab that shares four fifths of its movements with an absent grade
 *  is that grade; below that the evidence is not strong enough to merge two ledgers. */
export const RENAME_HASH_OVERLAP = 0.8;

/** One `product_grades` row, as the worker reads it. */
export interface DbProductGrade {
  id: string;
  code: string;
  sheet_name: string;
  content_fingerprint: string | null;
  active: boolean;
}

export interface ProductsDbWindow {
  grades: DbProductGrade[];
  /** grade id -> every `row_hash` currently filed under it. */
  hashesByGrade: Record<string, string[]>;
}

export type ProductGradeAction = "new" | "rename" | "unchanged" | "changed";

/** One movement, hashed and ready for the RPC payload. */
export interface HashedMovement {
  row_hash: string;
  transaction_date: string;
  stage: string;
  flec_delta: number;
  kg_delta: number | null;
  remarks: string | null;
  source_row: number;
  sheet_running: Record<string, number>;
}

export interface ClassifiedGrade {
  sheet_name: string;
  code: string;
  action: ProductGradeAction;
  /** Present for every action but `new`. */
  grade_id: string | null;
  /** rename only — what it used to be called. */
  previous_sheet_name?: string;
  previous_code?: string;
  /** rename only — which rung decided it. */
  rename_evidence?: "fingerprint" | "row_overlap";
  /** rename via rung 2 only — the measured overlap, 0..1. */
  rename_overlap?: number;
  /** Set when two or more absent grades matched and NOTHING was renamed. */
  ambiguous_candidates?: string[];
  fingerprint: string;
  fingerprint_payload: FingerprintPayload;
  openings: Array<{ stage: string; flecs: number; as_of: string | null }>;
  movements: HashedMovement[];
  /** Movement hashes not yet in the database. */
  to_insert: number;
  /** Rows in the database this tab no longer carries. */
  to_delete: number;
  thresholds: Record<string, number>;
  opening_as_of: string | null;
  header_counts: Record<string, number | null>;
  warnings: string[];
}

export interface ProductsClassified {
  grades: ClassifiedGrade[];
  /** Grades in the DB whose tab is not in this workbook and which no rename claimed. */
  missing: Array<{ grade_id: string; code: string; sheet_name: string; active: boolean }>;
  readable_tabs: string[];
  unreadable_tabs: string[];
  summary: {
    new_count: number;
    rename_count: number;
    changed_count: number;
    unchanged_count: number;
    missing_count: number;
    ambiguous_count: number;
    movement_rows: number;
    to_insert: number;
    to_delete: number;
  };
}

function hashMovements(grade: ProductGradeExtract): HashedMovement[] {
  return grade.movements.map((m) => ({
    row_hash: productRowHash({
      date: m.transaction_date,
      stage: m.stage,
      flecDelta: m.flec_delta,
      kgDelta: m.kg_delta,
      remarks: m.remarks,
      sourceRow: m.source_row,
    }),
    transaction_date: m.transaction_date,
    stage: m.stage,
    flec_delta: m.flec_delta,
    kg_delta: m.kg_delta,
    remarks: m.remarks,
    source_row: m.source_row,
    sheet_running: m.sheet_running,
  }));
}

export function classifyProducts(
  extract: ProductsExtract,
  db: ProductsDbWindow,
): ProductsClassified {
  const byCode = new Map<string, DbProductGrade>();
  for (const g of db.grades) byCode.set(g.code, g);

  // A grade is "absent" when its canonical code is not one of the workbook's tabs. Only
  // an absent grade can be the source of a rename — see the header.
  const workbookCodes = new Set(extract.grades.map((g) => g.code));
  const absent = db.grades.filter((g) => !workbookCodes.has(g.code));
  const claimed = new Set<string>();

  const out: ClassifiedGrade[] = [];

  for (const grade of extract.grades) {
    const movements = hashMovements(grade);
    const payload = buildFingerprintPayload(
      grade.openings,
      grade.movements.map((m) => ({
        d: m.transaction_date,
        s: m.stage,
        f: m.flec_delta,
        kg: m.kg_delta,
      })),
    );
    const fingerprint = productGradeFingerprint(payload);
    const openings = grade.openings.map((o) => ({ ...o, as_of: grade.opening_as_of }));

    const base = {
      sheet_name: grade.sheet_name,
      code: grade.code,
      fingerprint,
      fingerprint_payload: payload,
      openings,
      movements,
      thresholds: grade.thresholds,
      opening_as_of: grade.opening_as_of,
      header_counts: grade.header_counts,
      warnings: grade.warnings,
    };

    const known = byCode.get(grade.code);
    if (known) {
      const have = new Set(db.hashesByGrade[known.id] ?? []);
      const incoming = new Set(movements.map((m) => m.row_hash));
      const toInsert = movements.filter((m) => !have.has(m.row_hash)).length;
      const toDelete = [...have].filter((h) => !incoming.has(h)).length;
      out.push({
        ...base,
        action: toInsert === 0 && toDelete === 0 ? "unchanged" : "changed",
        grade_id: known.id,
        to_insert: toInsert,
        to_delete: toDelete,
      });
      continue;
    }

    // ── unknown code: the rename ladder ──────────────────────────────────────
    const pool = absent.filter((a) => !claimed.has(a.id));

    const byFingerprint = pool.filter(
      (a) => a.content_fingerprint != null && a.content_fingerprint === fingerprint,
    );

    let candidates = byFingerprint;
    let evidence: "fingerprint" | "row_overlap" = "fingerprint";
    let overlap: number | undefined;

    if (candidates.length === 0 && movements.length > 0) {
      const incoming = new Set(movements.map((m) => m.row_hash));
      const scored = pool
        .map((a) => {
          const have = db.hashesByGrade[a.id] ?? [];
          const hit = have.filter((h) => incoming.has(h)).length;
          // Measured against the SMALLER side, so a tab that has grown since the rename
          // is not penalised for its new rows.
          const denom = Math.min(have.length, incoming.size) || 0;
          return { grade: a, ratio: denom > 0 ? hit / denom : 0 };
        })
        .filter((s) => s.ratio >= RENAME_HASH_OVERLAP);
      if (scored.length > 0) {
        candidates = scored.map((s) => s.grade);
        evidence = "row_overlap";
        overlap = Math.max(...scored.map((s) => s.ratio));
      }
    }

    if (candidates.length === 1) {
      const prev = candidates[0];
      claimed.add(prev.id);
      const have = new Set(db.hashesByGrade[prev.id] ?? []);
      const incoming = new Set(movements.map((m) => m.row_hash));
      out.push({
        ...base,
        action: "rename",
        grade_id: prev.id,
        previous_sheet_name: prev.sheet_name,
        previous_code: prev.code,
        rename_evidence: evidence,
        ...(overlap === undefined ? {} : { rename_overlap: Number(overlap.toFixed(4)) }),
        to_insert: movements.filter((m) => !have.has(m.row_hash)).length,
        to_delete: [...have].filter((h) => !incoming.has(h)).length,
      });
      continue;
    }

    out.push({
      ...base,
      action: "new",
      grade_id: null,
      ...(candidates.length > 1
        ? { ambiguous_candidates: candidates.map((c) => c.sheet_name) }
        : {}),
      to_insert: movements.length,
      to_delete: 0,
    });
  }

  const missing = absent
    .filter((a) => !claimed.has(a.id))
    .map((a) => ({ grade_id: a.id, code: a.code, sheet_name: a.sheet_name, active: a.active }));

  const count = (a: ProductGradeAction) => out.filter((g) => g.action === a).length;

  return {
    grades: out,
    missing,
    readable_tabs: extract.readable_tabs,
    unreadable_tabs: extract.unreadable_tabs,
    summary: {
      new_count: count("new"),
      rename_count: count("rename"),
      changed_count: count("changed"),
      unchanged_count: count("unchanged"),
      missing_count: missing.length,
      ambiguous_count: out.filter((g) => g.ambiguous_candidates != null).length,
      movement_rows: out.reduce((n, g) => n + g.movements.length, 0),
      to_insert: out.reduce((n, g) => n + g.to_insert, 0),
      to_delete: out.reduce((n, g) => n + g.to_delete, 0),
    },
  };
}
