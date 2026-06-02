// Bulk-Add paste + canonicalization layer for the Cenapro Production grid.
//
// This is the "paste-friendly" brain behind the Bulk Add modal. The modal's grid
// cells are plain text (so Excel/Sheets paste flows in unmangled — strict dropdowns
// fight paste), and this module turns whatever the operator typed/pasted into the
// canonical lookup `code` the DB FKs require. It mirrors RC IN's `paste-utils.ts`
// (COLUMN_MAP + cleanCellValue) but adds the categorical canonicalization the cenapro
// production columns need, including the disposition⇄equipment co-derivation.
//
// Keeping this here (not in the component) keeps `bulk-add-modal.tsx` lean and makes
// the mapping logic unit-reviewable in isolation.

import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    WHSE_SIDES,
    parseCccFlec,
} from '../types';
import type { ProductionEventDirtyRow } from './actions';

// ─── Grid row shape (all strings — grid cells are text) ──────────────────────────
// The 12 editable production-event fields, in the column order the Bulk Add grid
// renders left→right. `disposition_kind` + `partner_equipment_code` are COLLAPSED into
// a single `ccc_flec` cell (Excel parity — one "CCC / FLEC" column), derived to the two
// DB fields on save via `parseCccFlec`. `id`/`unique_tag`/`batch_year` are absent — the
// modal only ever INSERTs, and the DB trigger computes the latter two.
export interface BulkRow {
    recv_date: string;
    prod_date: string;
    batch: string;
    shift_code: string;
    grade_code: string;
    plant_code: string;
    warehouse_code: string;
    source_location_code: string;
    weight_kg: string;
    /** Single CCC/FLEC cell — "FLEC" | "C1".."C4" | "RK1".."RK4". */
    ccc_flec: string;
    flec_count: string;
    whse_side: string;
}

export type BulkField = keyof BulkRow;

// ─── Column geometry ─────────────────────────────────────────────────────────────
// Visual column index → data key. col 0 = row#/trash (null, skipped on paste). The
// order matches Renzo's Excel: recv · prod · batch · shift · grade · plant ·
// warehouse · source · weight · CCC/FLEC · flec · side — so a pasted Excel block lines
// up positionally (12 data columns, was 13 before the disposition+equipment merge).
export const BULK_COLUMN_MAP: (BulkField | null)[] = [
    null,                       // 0: row# / remove button
    'recv_date',                // 1
    'prod_date',                // 2
    'batch',                    // 3
    'shift_code',               // 4
    'grade_code',               // 5
    'plant_code',               // 6
    'warehouse_code',           // 7
    'source_location_code',     // 8
    'weight_kg',                // 9
    'ccc_flec',                 // 10  (merged disposition + equipment)
    'flec_count',               // 11
    'whse_side',                // 12
];
export const BULK_COL_COUNT = BULK_COLUMN_MAP.length;

export const BULK_NUMERIC_FIELDS = new Set<BulkField>(['weight_kg', 'flec_count']);
const DATE_FIELDS = new Set<BulkField>(['recv_date', 'prod_date']);

// ─── Empty-row factory ───────────────────────────────────────────────────────────
// Mirrors RC IN's createEmptyRow — recv_date defaults to today so a fresh sheet
// already has a sensible date in every row (operators overwrite as needed).
export function createEmptyRow(): BulkRow {
    return {
        recv_date: new Date().toISOString().split('T')[0],
        prod_date: '',
        batch: '',
        shift_code: '',
        grade_code: '',
        plant_code: '',
        warehouse_code: '',
        source_location_code: '',
        weight_kg: '',
        ccc_flec: '',
        flec_count: '',
        whse_side: '',
    };
}

// A row is "blank" (dropped on save) when every field is empty OR only carries the
// default date with nothing else — i.e. nothing the operator actually entered.
export function isBlankRow(r: BulkRow): boolean {
    return (
        !r.batch.trim() &&
        !r.shift_code.trim() &&
        !r.grade_code.trim() &&
        !r.plant_code.trim() &&
        !r.warehouse_code.trim() &&
        !r.source_location_code.trim() &&
        !r.weight_kg.trim() &&
        !r.ccc_flec.trim() &&
        !r.flec_count.trim() &&
        !r.whse_side.trim() &&
        !r.prod_date.trim()
    );
}

// ─── Paste cleaning (per cell, on the way IN) ────────────────────────────────────
// Light touch only — dates normalize, numerics strip currency/commas. Categoricals
// are left as raw typed text here (canonicalization happens at save time so the cell
// keeps showing exactly what the operator pasted, e.g. "Bag" or "WHSE 7"). This is the
// same split RC IN uses: clean-on-paste for dates/numbers, validate-on-save for codes.
export function cleanBulkPasteValue(raw: string, field: BulkField): string {
    const val = trimCellValue(raw);
    if (DATE_FIELDS.has(field)) return parseExcelDate(val);
    if (BULK_NUMERIC_FIELDS.has(field)) return val.replace(/[₱,"'%\s]/g, '');
    return val;
}

// ─── Categorical canonicalization (raw operator text → seeded lookup `code`) ──────
// Each helper returns the canonical code, or null when the input can't be mapped.
// They're forgiving about case/whitespace and a few friendly aliases, because the
// whole point is letting the operator paste "M", "3x50", "whse 7", "bag", "c1"
// straight from a sheet. A null result surfaces as a clear, copyable errorToast naming
// the row — never a cryptic Postgres FK/CHECK error.

/** Normalize for comparison: trim, collapse inner whitespace, uppercase. */
function norm(raw: string): string {
    return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Match against a fixed option list, comparing on the normalized form. */
function matchCode<T extends string>(raw: string, options: readonly T[]): T | null {
    const n = norm(raw);
    if (!n) return null;
    for (const opt of options) {
        if (norm(opt) === n) return opt;
    }
    return null;
}

export function canonicalizeShift(raw: string): string | null {
    return matchCode(raw, SHIFT_CODES);
}

export function canonicalizeGrade(raw: string): string | null {
    // Tolerate "3x50" / "3 X 50" → "3X50"; "2x6" → "2X6"; "4x8" → "4X8"; "3.5" stays.
    const compact = norm(raw).replace(/\s+/g, '');
    for (const g of GRADE_CODES) {
        if (norm(g).replace(/\s+/g, '') === compact) return g;
    }
    return null;
}

export function canonicalizePlant(raw: string): string | null {
    return matchCode(raw, PLANT_CODES);
}

export function canonicalizeWarehouse(raw: string): string | null {
    // Tolerate "W7" / "WHSE7" / "WHSE 7" → "WHSE 7"; bare digit "7" → "WHSE 7".
    const n = norm(raw);
    const direct = matchCode(raw, WAREHOUSE_CODES);
    if (direct) return direct;
    const digitMatch = n.match(/^(?:W|WHSE)?\s*(\d+)$/);
    if (digitMatch) {
        const candidate = `WHSE ${digitMatch[1]}`;
        return matchCode(candidate, WAREHOUSE_CODES);
    }
    return null;
}

export function canonicalizeSource(raw: string): string | null {
    // Tolerate "TNK1" / "TANK 1" → "TNK 1".
    const direct = matchCode(raw, SOURCE_LOCATION_CODES);
    if (direct) return direct;
    const n = norm(raw);
    const tankMatch = n.match(/^(?:TNK|TANK)\s*(\d+)$/);
    if (tankMatch) {
        const candidate = `TNK ${tankMatch[1]}`;
        return matchCode(candidate, SOURCE_LOCATION_CODES);
    }
    return null;
}

export function canonicalizeSide(raw: string): string | null {
    // Tolerate "LEFT"/"L" → "LS"; "RIGHT"/"R" → "RS".
    const direct = matchCode(raw, WHSE_SIDES);
    if (direct) return direct;
    const n = norm(raw);
    if (n === 'L' || n === 'LEFT') return 'LS';
    if (n === 'R' || n === 'RIGHT') return 'RS';
    return null;
}

// ─── Row → canonical dirty-row (the save mapping) ────────────────────────────────
// Validates + canonicalizes a single grid row into the `ProductionEventDirtyRow` the
// existing `saveProductionEvents` action consumes (INSERT — no `id`). Returns either
// the mapped row or a list of human-readable problems for that row. The caller
// aggregates problems across rows into one persistent errorToast (HARD RULE) rather
// than letting an FK/CHECK violation reach Postgres.
export interface RowMapResult {
    row?: ProductionEventDirtyRow;
    errors: string[];
}

export function mapBulkRowToDirty(r: BulkRow): RowMapResult {
    const errors: string[] = [];

    // — Categoricals (only validate non-empty cells; empties become null downstream) —
    let shift = '';
    if (r.shift_code.trim()) {
        const c = canonicalizeShift(r.shift_code);
        if (c) shift = c;
        else errors.push(`shift "${r.shift_code.trim()}" is not one of ${SHIFT_CODES.join('/')}`);
    }

    let grade = '';
    if (r.grade_code.trim()) {
        const c = canonicalizeGrade(r.grade_code);
        if (c) grade = c;
        else errors.push(`grade "${r.grade_code.trim()}" is not one of ${GRADE_CODES.join('/')}`);
    }

    let plant = '';
    if (r.plant_code.trim()) {
        const c = canonicalizePlant(r.plant_code);
        if (c) plant = c;
        else errors.push(`plant "${r.plant_code.trim()}" is not one of ${PLANT_CODES.join('/')}`);
    }

    let warehouse = '';
    if (r.warehouse_code.trim()) {
        const c = canonicalizeWarehouse(r.warehouse_code);
        if (c) warehouse = c;
        else errors.push(`warehouse "${r.warehouse_code.trim()}" is not one of ${WAREHOUSE_CODES.join('/')}`);
    }

    let source = '';
    if (r.source_location_code.trim()) {
        const c = canonicalizeSource(r.source_location_code);
        if (c) source = c;
        else errors.push(`source "${r.source_location_code.trim()}" is not a valid location`);
    }

    let side = '';
    if (r.whse_side.trim()) {
        const c = canonicalizeSide(r.whse_side);
        if (c) side = c;
        else errors.push(`side "${r.whse_side.trim()}" is not LS/RS`);
    }

    // — CCC/FLEC (single column → disposition + equipment, Excel parity) —
    // The merged cell resolves to BOTH DB fields via the shared `parseCccFlec` helper:
    // "FLEC" → flec_bagging / no equipment; "C1".."C4" → partner_crusher + that machine;
    // "RK1".."RK4" → partner_kiln + that machine. A single typed cell can't produce an
    // inconsistent (disposition, equipment) pair, so the old cross-field CHECK dance is
    // gone — `parseCccFlec` returns null only for genuinely unrecognized input.
    let disposition = '';
    let equipment = '';
    if (r.ccc_flec.trim()) {
        const res = parseCccFlec(r.ccc_flec);
        if (res) {
            disposition = res.disposition_kind;
            equipment = res.partner_equipment_code ?? '';
        } else {
            errors.push(`CCC/FLEC "${r.ccc_flec.trim()}" is not FLEC / C1–C4 / RK1–RK4`);
        }
    }

    // — Weight (required, > 0) —
    const weightStr = r.weight_kg.trim();
    if (!weightStr) {
        errors.push('weight is required');
    } else {
        const w = Number(weightStr);
        if (!Number.isFinite(w) || w <= 0) errors.push(`weight "${weightStr}" must be a number > 0`);
    }

    // — Flec (optional int) —
    const flecStr = r.flec_count.trim();
    if (flecStr) {
        const f = Number(flecStr);
        if (!Number.isFinite(f)) errors.push(`flec "${flecStr}" must be a number`);
    }

    if (errors.length > 0) return { errors };

    // Build the dirty-row (strings; the server coerces/strips empties→null). No `id`
    // so the action INSERTs; `prod_date` passes through (server coerces empty→null).
    return {
        errors: [],
        row: {
            recv_date: r.recv_date.trim(),
            prod_date: r.prod_date.trim(),
            batch: r.batch.trim(),
            shift_code: shift,
            grade_code: grade,
            plant_code: plant,
            warehouse_code: warehouse,
            source_location_code: source,
            weight_kg: weightStr,
            disposition_kind: disposition,
            partner_equipment_code: equipment,
            flec_count: flecStr,
            whse_side: side,
        },
    };
}

// A 1-based row label for error messages ("row 3" / 'row 3 "MAY-26-BLK1"').
export function rowLabel(r: BulkRow, index: number): string {
    const base = `row ${index + 1}`;
    return r.batch.trim() ? `${base} "${r.batch.trim()}"` : base;
}
