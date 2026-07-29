/**
 * settlement.ts — the FLECON DATE-SETTLEMENT LEDGER pure core (2026-07-29).
 *
 * Sibling of `workflows/settlement.ts` (rc_out's ledger) and of the migration
 * `20260729060000_flecon_bag_date_settlements.sql`. Once a `transaction_date` is
 * SETTLED, every future flecon run skips it entirely — no extract-compare, no classify,
 * no REPLACE-BY-DATE, and critically NO DELETE.
 *
 * WHY flecon needs one at all
 * ---------------------------
 * Ivy's "JANUARY 2026" tab has an operator year-typo in cell A75: it reads `2025-01-31`
 * (rows 76-79 inherit it by date carry-forward). Those five movements fall outside the
 * extractor's window and are correctly refused on every run — so they were HAND-BACKFILLED
 * into `2026-01-31` on 2026-07-27 (audit log a6293bf8-26b2-4207-98a4-6134f0f08fb7). Renzo
 * decided NOT to correct the source cell. Today that backfill survives only because the
 * sync's `since` window never reaches January; a watermark reset would re-run from
 * 2026-01-01, the extractor would refuse the mis-dated rows again, and REPLACE-BY-DATE
 * would DELETE the backfill. The ledger makes the arbitration a DB fact instead of an
 * accident of window arithmetic.
 *
 * HOW A DATE SETTLES AUTOMATICALLY (deliberately narrow)
 * ------------------------------------------------------
 * flecon is SINGLE-SOURCE — there is no independent second witness per date the way
 * rc_out has the RC MOVEMENT sheet — so we do NOT invent corroboration. `NOOP` days are
 * never auto-settled: the sheet is editable history and settling a NOOP would freeze out
 * a legitimate future edit. The ONE case the worker settles by itself is the
 * machine-verifiable "the arbitration provably already happened":
 *
 *   an out-of-year sheet row group (dated outside the tab's own year) whose movements
 *   ALREADY EXIST in the DB, movement for movement, under the tab-year date.
 *
 * That is exactly the shape of the 2026-01-31 backfill and nothing else. Any other
 * settlement is a human act, recorded by seeding the ledger directly (see the migration).
 *
 * PURE + deterministic: no DB, no I/O — mirrors the `workflows/settlement.ts` split so
 * the criterion is unit-testable without a fake DbClient. Persisted by
 * `reports/flecon/index.ts::runReport` via `DbClient.insertFleconSettlements`; consumed
 * by the same `runReport` (the skip filter) and, defensively, by `apply.ts`.
 */
import { movementSig } from "./classify.js";
import type { FleconFlaggedRow } from "./extract.js";

/** Recorded on every row this module produces (`flecon_bag_date_settlements.reason`). */
export const FLECON_SETTLEMENT_REASON = "human_arbitrated_backfill";

/** The DB-side movement shape the criterion compares against (code, not id). */
export interface FleconSettlementDbRow {
  transaction_date: string;
  particular?: unknown;
  bag_type_code?: unknown;
  qty_delta?: unknown;
}

export interface FleconQualifyingSettlement {
  /** The CORRECTED (tab-year) date being settled — the date the DB actually holds. */
  transaction_date: string;
  db_movement_count: number;
  db_net_qty: number;
  reason: string;
  note: string;
}

/**
 * Map a mis-dated sheet date onto the tab's own year, keeping month + day.
 * Returns null when the year already matches, the input is not an ISO date, the tab year
 * is unknown, or the resulting date does not exist (e.g. 02-29 into a non-leap year).
 */
export function correctedDate(misdated: string, sheetYear: number | null): string | null {
  if (sheetYear === null || !Number.isInteger(sheetYear)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(misdated));
  if (!m) return null;
  if (Number(m[1]) === sheetYear) return null; // not actually out of year
  const yyyy = String(sheetYear).padStart(4, "0");
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  // Round-trip through UTC so an impossible calendar date (Feb 29 → non-leap) is rejected
  // rather than silently rolling over to March 1.
  const dt = new Date(Date.UTC(sheetYear, mm - 1, dd));
  if (dt.getUTCFullYear() !== sheetYear || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) {
    return null;
  }
  return `${yyyy}-${m[2]}-${m[3]}`;
}

/** Multiset of `movementSig` keys — the SAME identity the day-set classifier uses. */
function multiset(rows: Array<Record<string, unknown>>): Map<string, number> {
  const c = new Map<string, number>();
  for (const r of rows) {
    const k = movementSig(r);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return c;
}

function multisetsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the newly-qualifying flecon settlements.
 *
 * For every DATE the extractor flagged as OUT OF YEAR:
 *   1. corrected = same month/day under the tab's own year (`sheetYear`).
 *   2. skip if the corrected date is already settled.
 *   3. the DB must hold movements for the corrected date, and their multiset of
 *      (particular, bag_type_code, qty_delta) must EXACTLY equal the mis-dated sheet
 *      rows' multiset. Anything less — an empty DB day, an extra DB row, a changed qty —
 *      does NOT settle. Silence is never agreement.
 *
 * Only `out_of_year` rows are considered. A plain sub-`since` drop is ordinary settled
 * history and is not evidence of an arbitration.
 */
export function computeFleconSettlements(
  flagged: FleconFlaggedRow[],
  sheetYear: number | null,
  dbMovements: FleconSettlementDbRow[],
  alreadySettled: ReadonlySet<string>,
): FleconQualifyingSettlement[] {
  if (!flagged.length) return [];

  const byMisdate = new Map<string, FleconFlaggedRow[]>();
  for (const r of flagged) {
    if (!r.out_of_year) continue;
    const arr = byMisdate.get(r.transaction_date) ?? [];
    arr.push(r);
    byMisdate.set(r.transaction_date, arr);
  }
  if (!byMisdate.size) return [];

  const dbByDate = new Map<string, FleconSettlementDbRow[]>();
  for (const m of dbMovements) {
    const d = String(m.transaction_date ?? "").slice(0, 10);
    if (!d) continue;
    const arr = dbByDate.get(d) ?? [];
    arr.push(m);
    dbByDate.set(d, arr);
  }

  const out: FleconQualifyingSettlement[] = [];
  for (const misdate of [...byMisdate.keys()].sort()) {
    const sheetRows = byMisdate.get(misdate)!;
    const corrected = correctedDate(misdate, sheetYear);
    if (corrected === null) continue;
    if (alreadySettled.has(corrected)) continue;

    const dbDay = dbByDate.get(corrected) ?? [];
    if (dbDay.length === 0) continue; // nothing was backfilled — nothing to protect

    const sheetMs = multiset(sheetRows as unknown as Array<Record<string, unknown>>);
    const dbMs = multiset(dbDay as unknown as Array<Record<string, unknown>>);
    if (!multisetsEqual(sheetMs, dbMs)) continue; // not the same movements — never settle

    const rowRange = [...new Set(sheetRows.map((r) => r.source_row))].sort((a, b) => a - b);
    out.push({
      transaction_date: corrected,
      db_movement_count: dbDay.length,
      db_net_qty: dbDay.reduce((s, r) => s + toNumber(r.qty_delta), 0),
      reason: FLECON_SETTLEMENT_REASON,
      note:
        `Sheet row(s) ${rowRange.join(", ")} of the bag workbook carry the date ${misdate}, which is ` +
        `outside the tab's year (${sheetYear}). Those exact movements are already recorded in the ` +
        `app under ${corrected}, so the correction has already been made by hand. ${corrected} is ` +
        `settled: the sync will never re-extract, re-classify or replace it.`,
    });
  }
  return out;
}
