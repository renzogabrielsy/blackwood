/**
 * apply.ts — TS port of `sync_flecon.py::phase_apply` (read as spec, flecon.md §1, §5).
 *
 * APPLY model = REPLACE-BY-DATE, bounded `>= since`. For each NEW / DATE_CHANGED date:
 *   floor check → bag-type-code→id mapping (whole-date hold on any unmapped code) →
 *   DELETE that date's rows → INSERT the sheet's current movements → ONE manual audit
 *   row per replaced date (operation="REPLACE", requires the widened audit_logs CHECK
 *   from migration 20260703043000, L-032).
 *
 * Held reasons: unmapped_or_missing_columns (standing), below_since_floor,
 *   unmapped_bag_type_code (whole date). Never auto-creates a bag type.
 *
 * BUG-015 (2026-07-27) added four more, all using EXISTING HeldKinds (the kind enum is
 * frontend-locked — app/(app)/sync/types.ts + three exhaustive Record maps):
 *   out_of_year_date                 (malformed)         — a date outside the tab's year
 *   dropped_before_since_unrecorded  (below_since_floor) — a dropped date the DB never had
 *   balance_crosscheck_drift         (flagged)           — the informational drift, surfaced
 *   delete_to_empty_blocked          (gate_failure)      — refuse to wipe a day to empty
 *   stale_workbook                   (gate_failure)      — refuse an older workbook outright
 *
 * Label + watermark: watermark only if `not errors`; label only if `not errors` AND
 *   no held entry with reason unmapped_bag_type_code / unmapped_or_missing_columns —
 *   STRICTER than other pipelines (flecon.md §5). Gmail labeling is an INJECTED
 *   callback so this module never imports gmail (deps wired by the workflow layer).
 *   ONE EXCEPTION (2026-08-26, flecon.md §5b): a STRICTLY-older stale workbook is
 *   labeled processed on the run that refuses it — the refusal to WRITE is unchanged;
 *   an older copy of a cumulative workbook can never become applicable, so re-reading
 *   it can only reproduce the identical refusal, forever.
 *
 * PORTING TRAP #1: the Python reaches into db._session.delete(...) raw. The port first
 * surfaced an explicit `deleteByDate` method on the deps' db; since BUG-015 the pair is
 * ONE transactional RPC (`replaceFleconDate` → `fn_flecon_replace_date`), because the
 * DELETE and the INSERT being two independent HTTP calls is exactly what let a failure
 * between them leave a day deleted with no rows and no audit trail.
 */
import type { FleconClassified, PerDateEntry, BalanceCrosscheckRow } from "./classify.js";
import type { FleconFlaggedRow } from "./extract.js";
import { correctedDate } from "./settlement.js";
import { roundHalfToEven } from "../../lib/norm.js";
import { type HeldRow, fleconKey } from "../held.js";
import { operatorError, errText } from "../../lib/operatorError.js";

export interface FleconApplyDeps {
  db: {
    /**
     * ATOMIC replace-by-date (BUG-015 defect C, 2026-07-27). DELETE + INSERT for one
     * date inside ONE transaction via the `fn_flecon_replace_date` RPC. The previous
     * shape was `deleteByDate(...)` then `insert(...)` — two independent HTTP calls, so
     * a failure between them left the date DELETED with nothing inserted and no audit
     * row. Returns the counts + a marker id from EITHER side so the audit row can
     * always be written (including a delete-only outcome).
     */
    replaceFleconDate(
      date: string,
      rows: Array<Record<string, unknown>>,
    ): Promise<{
      deleted: number;
      deletedFirstId: string | null;
      inserted: number;
      firstId: string | null;
    }>;
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
  progress: (
    stage: "fetch" | "extract" | "classify" | "apply" | "reconcile" | "finalize",
    label: string,
    pct: number,
    detail?: string,
    level?: "info" | "warn",
  ) => Promise<void>;
  /** Injected Gmail labeler — apply.ts NEVER imports gmail. */
  labelProcessed: (uid: string) => Promise<boolean>;
  /**
   * POST-WRITE balance re-read (2026-07-29 fix). `classified.balance_crosscheck` was
   * computed from balances read BEFORE this run's own writes, and compared against the
   * sheet's ALREADY-UPDATED balance row — so every run that imported new movements
   * reported phantom drift (proven on run da9f2714: FG_ALL_BLACK "app 6 vs sheet 156",
   * KOREA_WHITE_SUNDRY "app 306 vs sheet 282", ZAMBOANGA_BAG "app 0 vs sheet 160", all
   * three matching the sheet exactly once the day's movements landed).
   *
   * Injected rather than imported so apply.ts still never reaches a DB singleton, and
   * OPTIONAL so an offline caller keeps the old (pre-write) rows. Returns
   * `view_flecon_bag_balance` rows.
   */
  readBalances?: () => Promise<Array<{ code?: unknown; balance?: unknown }>>;
}

/**
 * Set when the fetched workbook is an OLDER revision than what the DB already holds
 * (BUG-015 defect C1). A stale workbook's missing days classify DATE_CHANGED with an
 * empty movement list, which used to DELETE a real day down to nothing. When present,
 * the apply refuses outright: no writes, no watermark.
 *
 * The Gmail LABEL is the one thing that changed on 2026-08-26: a STRICTLY-older workbook
 * (a real `workbookMaxDate` below `dbWatermark`) is labeled processed on the run that
 * refuses it, because it can never become applicable and was otherwise re-refused forever.
 * A NULL `workbookMaxDate` is still left unlabeled — see the apply body.
 */
export interface FleconStaleWorkbook {
  /**
   * MAX(transaction_date) the workbook itself carries, over the WHOLE SHEET (null = it
   * carried no usable dated row at all). Built by `index.ts::wholeSheetMaxDate` — NOT
   * `extract.summary.date_max`, which is window-scoped and reads null whenever every row
   * in the file is older than this run's `since` floor.
   */
  workbookMaxDate: string | null;
  /** MAX(flecon_bag_movements.transaction_date) already in the DB. */
  dbWatermark: string;
}

export interface FleconApplyOpts {
  reportType: string;
  emailUid: string | null;
  emailThreadId: string | null;
  noLabel: boolean;
  /**
   * Extractor telemetry (BUG-015 defect A) — rows dropped by the `since` floor and/or
   * dated outside the tab's own year. NEVER auto-corrected; surfaced as held rows.
   */
  flaggedRows?: FleconFlaggedRow[];
  /**
   * Every `transaction_date` the DB already holds (ALL history, not just >= since).
   * Lets the apply tell a benign settled-history drop (the date is already recorded)
   * from a dropped date the DB has NEVER seen. Omit → the benign class is not raised.
   */
  dbDates?: string[];
  /** Non-null → refuse the whole apply (see FleconStaleWorkbook). */
  staleWorkbook?: FleconStaleWorkbook | null;
  /**
   * The DATE-SETTLEMENT LEDGER (`flecon_bag_date_settlements`, 2026-07-29). A settled
   * date is skipped ENTIRELY — never replaced, never deleted. `runReport` already filters
   * settled dates out of both the extract and the DB compare-set before classify, so
   * nothing settled should ever reach here; this is the defence-in-depth backstop that
   * makes "a settled date is never deleted" true of `applyFlecon` on its own.
   */
  settledDates?: ReadonlySet<string>;
  /** The tab's own year — lets a settled date suppress its MIS-DATED sheet rows too. */
  sheetYear?: number | null;
}

/** Retained as an alias so anything importing HeldEntry still resolves; the
 *  canonical shape is now the shared HeldRow (with kind/row/source_index). */
export type HeldEntry = HeldRow;

export interface FleconApplyResult {
  ok: boolean;
  inserts: number;
  replaced_dates: number;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  /** How many per-date entries were skipped because the date is SETTLED (see opts). */
  settled_dates_skipped: number;
}

/** provenance comment builder (sync_flecon.py::_prov, lines 130-133). */
function prov(runTs: string, d: string, cls: string, extra = ""): string {
  const base =
    `provenance=flecon-sync | REPLACE-BY-DATE (${cls}) for ${d} by sync_flecon.py ` +
    `(lean orchestrator) on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
}

/** Thousands-free compact signed qty for a held detail line ("+128" / "−1"). */
function signed(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** "rows 75-79" for a contiguous run, "rows 75, 78" otherwise. */
function rowRange(rows: number[]): string {
  const uniq = [...new Set(rows)].sort((a, b) => a - b);
  if (uniq.length === 0) return "";
  const contiguous = uniq[uniq.length - 1] - uniq[0] === uniq.length - 1;
  if (uniq.length === 1) return `row ${uniq[0]}`;
  return contiguous ? `rows ${uniq[0]}–${uniq[uniq.length - 1]}` : `rows ${uniq.join(", ")}`;
}

/** "ECOPACK_BEIGE +100, ZAMBOANGA_BAG +127" — net qty per bag type, code-sorted. */
function netByCode(rows: FleconFlaggedRow[]): string {
  const net = new Map<string, number>();
  for (const r of rows) net.set(r.bag_type_code, (net.get(r.bag_type_code) ?? 0) + r.qty_delta);
  return [...net.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([code, n]) => `${code} ${signed(n)}`)
    .join(", ");
}

/**
 * BUG-015 defect A — turn the extractor's silently-swallowed drops into held rows.
 *
 * TWO distinct classes, deliberately kept apart:
 *   1. `out_of_year_date` — the row's date year is NOT the tab's year (e.g. `2025-01-31`
 *      typed inside the `JANUARY 2026` tab). This is categorically an operator TYPO, not
 *      settled history: the row will never be ingested under ANY watermark. Held as
 *      `malformed` (attention-level) so it reaches a person. NEVER auto-corrected.
 *   2. `dropped_before_since_unrecorded` — an in-year row below the `since` floor whose
 *      DATE the database has never recorded at all. Ordinary settled history (a dropped
 *      date the DB already holds) is NOT raised — that is the benign, every-run case.
 *
 * One held row per DATE (not per sheet row) so a five-row typo is one case, not five.
 *
 * SETTLED DATES ARE SUPPRESSED (2026-07-29). The `out_of_year_date` detail used to assert
 * "These rows were NOT imported and never will be while the date reads 2025-01-31" — which
 * became FALSE the moment those rows were hand-backfilled to 2026-01-31. Once the
 * corrected (tab-year) date is in `flecon_bag_date_settlements`, the arbitration is on
 * record and the rows are protected, so the finding stops firing entirely. A genuinely NEW
 * out-of-year date — one nobody has arbitrated — still fires exactly as loudly as before.
 */
export function buildFlaggedRowHolds(
  flagged: FleconFlaggedRow[],
  dbDates?: string[],
  settled?: { dates?: ReadonlySet<string>; sheetYear?: number | null },
): HeldRow[] {
  if (!flagged.length) return [];
  const known = dbDates ? new Set(dbDates.map((d) => String(d).slice(0, 10))) : null;
  const settledDates = settled?.dates;
  const sheetYear = settled?.sheetYear ?? null;
  const out: HeldRow[] = [];

  /** A row is silenced when its own date, or its tab-year correction, is settled. */
  const isSettled = (row: FleconFlaggedRow): boolean => {
    if (!settledDates || settledDates.size === 0) return false;
    if (settledDates.has(row.transaction_date)) return true;
    const corrected = correctedDate(row.transaction_date, sheetYear);
    return corrected !== null && settledDates.has(corrected);
  };

  const byDate = new Map<string, FleconFlaggedRow[]>();
  for (const r of flagged) {
    if (isSettled(r)) continue;
    const arr = byDate.get(r.transaction_date) ?? [];
    arr.push(r);
    byDate.set(r.transaction_date, arr);
  }

  for (const d of [...byDate.keys()].sort()) {
    const rows = byDate.get(d)!;
    const outOfYear = rows.filter((r) => r.out_of_year);
    const plainDropped = rows.filter((r) => !r.out_of_year && r.dropped);

    if (outOfYear.length) {
      const where = rowRange(outOfYear.map((r) => r.source_row));
      out.push({
        reason: "out_of_year_date",
        natural_key: fleconKey(d, `${where} — date is outside this sheet's year`),
        detail:
          `${where} of the bag sheet carry the date ${d}, which is not in this tab's year. ` +
          `That is almost certainly a typo in the date cell. These rows were NOT imported and ` +
          `never will be while the date reads ${d}: ${netByCode(outOfYear)}. ` +
          `Fix the date in the source sheet — the sync will not guess it.`,
        kind: "malformed",
        row: {
          transaction_date: d,
          source_rows: [...new Set(outOfYear.map((r) => r.source_row))].sort((a, b) => a - b),
          bag_type_codes: [...new Set(outOfYear.map((r) => r.bag_type_code))].sort(),
          movements: outOfYear.map((r) => ({
            source_row: r.source_row,
            particular: r.particular,
            bag_type_code: r.bag_type_code,
            qty_delta: r.qty_delta,
          })),
        },
      });
    }

    if (plainDropped.length && known && !known.has(d)) {
      const where = rowRange(plainDropped.map((r) => r.source_row));
      out.push({
        reason: "dropped_before_since_unrecorded",
        natural_key: fleconKey(d, `${where} — older than the sync window and never saved`),
        detail:
          `${where} of the bag sheet are dated ${d}, which is older than this run's window, so ` +
          `they were skipped — but the database has no bag movements for ${d} at all, so these ` +
          `rows have never been saved: ${netByCode(plainDropped)}.`,
        kind: "below_since_floor",
        row: {
          transaction_date: d,
          source_rows: [...new Set(plainDropped.map((r) => r.source_row))].sort((a, b) => a - b),
          bag_type_codes: [...new Set(plainDropped.map((r) => r.bag_type_code))].sort(),
        },
      });
    }
  }
  return out;
}

/**
 * BUG-015 defect B — the balance cross-check has been computed on every run since the
 * port and thrown away. Any non-zero drift between the DB's own balance view and the
 * sheet's own running-balance row now becomes ONE held row naming every drifting bag
 * type and both numbers.
 *
 * Deliberately a FINDING, never a write gate — flecon is single-source and specs/
 * flecon.md §4 fixes the cross-check as INFORMATIONAL. Nothing here blocks a write.
 */
export function buildBalanceDriftHold(
  classified: FleconClassified,
  rowsOverride?: BalanceCrosscheckRow[],
): HeldRow | null {
  const cc = classified.balance_crosscheck;
  if (!cc || !cc.available) return null;
  const source = rowsOverride ?? cc.rows ?? [];
  const drifting = source.filter((r) => typeof r.drift === "number" && r.drift !== 0);
  if (!drifting.length) return null;

  const codes = drifting.map((r) => r.code).sort();
  const lines = drifting
    .slice()
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map(
      (r) =>
        `${r.code}: app says ${r.db_view_balance}, the sheet says ${r.sheet_snapshot_balance} ` +
        `(off by ${signed(r.drift as number)})`,
    );

  return {
    reason: "balance_crosscheck_drift",
    natural_key: `FLECON bag balance drift — ${drifting.length} bag type(s): ${codes.join(", ")}`,
    detail:
      `The app's bag balances disagree with the balance row on the operator's own sheet for ` +
      `${drifting.length} bag type(s). ${lines.join("; ")}. Nothing was blocked because of this ` +
      `— it is a cross-check, not a gate — but a persistent gap usually means rows are ` +
      `missing from, or duplicated in, the app.`,
    kind: "flagged",
    row: {
      drifting_count: drifting.length,
      bag_type_codes: codes,
      rows: drifting.map((r) => ({
        code: r.code,
        db_view_balance: r.db_view_balance,
        sheet_snapshot_balance: r.sheet_snapshot_balance,
        drift: r.drift,
      })),
    },
  };
}

/**
 * Rebuild the cross-check rows against a FRESH (post-write) balance read.
 *
 * The sheet side (`sheet_snapshot_balance`) is the operator's own balance row and is
 * already up to date with everything the workbook contains; the app side must therefore be
 * read AFTER this run's writes or the comparison is apples-to-oranges. This swaps in the
 * fresh `view_flecon_bag_balance` numbers and recomputes `drift = app − sheet` on exactly
 * the same code set the classifier produced. A code missing from the fresh read yields a
 * null balance and a null drift (un-comparable, never reported as drift) — the same
 * convention classify.ts uses.
 *
 * PURE + exported so the timing fix is unit-testable without a DB.
 */
export function recomputeCrosscheckRows(
  rows: BalanceCrosscheckRow[],
  freshBalances: Array<{ code?: unknown; balance?: unknown }>,
): BalanceCrosscheckRow[] {
  const fresh = new Map<string, number | null>();
  for (const b of freshBalances) {
    const code = String(b.code ?? "").trim().toUpperCase();
    if (!code) continue;
    const raw = b.balance;
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    fresh.set(code, Number.isFinite(n) ? Math.trunc(roundHalfToEven(n, 0)) : null);
  }
  return rows.map((r) => {
    const code = String(r.code ?? "").trim().toUpperCase();
    const dbBal = fresh.has(code) ? fresh.get(code)! : null;
    const sheetBal = r.sheet_snapshot_balance;
    const drift =
      typeof dbBal === "number" && Number.isInteger(dbBal) &&
      typeof sheetBal === "number" && Number.isInteger(sheetBal)
        ? dbBal - sheetBal
        : null;
    return { code: r.code, db_view_balance: dbBal, sheet_snapshot_balance: sheetBal, drift };
  });
}

export async function applyFlecon(
  deps: FleconApplyDeps,
  classified: FleconClassified,
  opts: FleconApplyOpts,
): Promise<FleconApplyResult> {
  // RUN_TS captured once per apply (mirrors orchestrator_common.RUN_TS import-time stamp).
  const runTs = new Date().toISOString();

  const since = classified.since;
  const codeToId = classified.code_to_id ?? {};
  const perDate: PerDateEntry[] = classified.per_date ?? [];
  const held: HeldRow[] = [];
  const errors: string[] = [];
  let replacedDates = 0;
  let inserts = 0;
  let settledSkipped = 0;
  const settledDates = opts.settledDates;

  // ── Defect C1: a STALE workbook is refused outright, before anything is written. ──
  if (opts.staleWorkbook) {
    const s = opts.staleWorkbook;

    // ── UNJAM (2026-08-26): a DETERMINISTICALLY stale attachment is marked processed. ──
    // The refusal to WRITE is untouched — only the LABEL decision changes. flecon's normal
    // rule is "label only on a clean apply", which is right for every failure that a later
    // run could resolve. This one cannot: an attachment is a fixed file, an older copy of a
    // CUMULATIVE workbook can never become newer, so re-reading it tomorrow can only
    // produce the identical refusal. Left unlabeled it is re-fetched forever — Ivy's
    // 2026-08-24 00:58 email (uid 126413, last sheet row 2026-08-21 vs a 2026-08-25
    // watermark) failed this gate on EVERY run from 08-25 onward and turned every one of
    // them `partial`.
    //
    // STRICTLY older only. A workbook with NO dated rows at all (`workbookMaxDate === null`)
    // is a different, rarer failure — a broken or unreadable attachment, not a provably
    // superseded one — so it keeps re-firing until a human looks at it.
    //
    // This run still reports `ok: false` and still emits the `stale_workbook` gate failure,
    // so the run settles `partial` and the operator sees it ONCE. That is the point: seen
    // once, then silent, instead of unseen-because-always-there.
    const deterministicallyStale =
      s.workbookMaxDate !== null && s.workbookMaxDate < s.dbWatermark;
    let staleLabeled = false;
    if (deterministicallyStale && !opts.noLabel && opts.emailUid) {
      await deps.progress(
        "apply",
        "Marking this older copy as processed so it stops coming back…",
        95,
      );
      try {
        staleLabeled = await deps.labelProcessed(opts.emailUid);
      } catch {
        staleLabeled = false; // a labeling failure must never turn a clean refusal into a crash
      }
    }

    const detail =
      `The bag report we just read only goes up to ${s.workbookMaxDate ?? "(no dated rows)"}, ` +
      `but the database already has bag movements through ${s.dbWatermark}. That means this ` +
      `attachment is an OLDER copy of the workbook than the one we already loaded. Applying it ` +
      `would blank out the days it is missing, so NOTHING was written. Ask for the current ` +
      `FLECON BAGGED file, or re-send today's report.` +
      (staleLabeled
        ? ` This older copy was marked as processed so it stops re-firing on every run — ` +
          `nothing was written and the watermark did not move.`
        : ``);
    held.push({
      reason: "stale_workbook",
      natural_key: `FLECON workbook is older than the database (${s.workbookMaxDate ?? "no dates"} < ${s.dbWatermark})`,
      detail,
      kind: "gate_failure",
      row: {
        workbook_max_date: s.workbookMaxDate,
        db_watermark: s.dbWatermark,
        days_in_workbook: perDate.length,
        email_labeled_processed: staleLabeled,
      },
    });
    await deps.progress(
      "finalize",
      staleLabeled
        ? "Stopped — the bag report is an older copy than what we already have. Nothing written; " +
          "that email won't be read again."
        : "Stopped — the bag report is an older copy than what we already have. Nothing written.",
      100,
      undefined,
      "warn",
    );
    return {
      ok: false,
      inserts: 0,
      replaced_dates: 0,
      held,
      labeled: staleLabeled,
      watermark_updated: false,
      errors: [],
      settled_dates_skipped: 0,
    };
  }

  const total = Math.max(1, perDate.length);
  const batch = Math.max(1, Math.ceil(total / 10));
  await deps.progress("apply", `Rewriting bag movements for ${perDate.length} day(s)…`, 12);

  // ── Defect A: rows the EXTRACTOR dropped / mis-dated become LOUD held rows. ──
  // (Settled dates are suppressed — the arbitration is on record; see buildFlaggedRowHolds.)
  held.push(
    ...buildFlaggedRowHolds(opts.flaggedRows ?? [], opts.dbDates, {
      dates: settledDates,
      sheetYear: opts.sheetYear ?? null,
    }),
  );

  // NOTE: the balance cross-check finding is built AFTER the write loop (2026-07-29) —
  // comparing pre-write app balances against the sheet's already-updated balance row
  // reported phantom drift on every run that imported anything. See below.

  // Column flags → held (never auto-create a bag type).
  const colFlags = classified.column_flags ?? { flagged: false };
  if (colFlags.flagged) {
    held.push({
      reason: "unmapped_or_missing_columns",
      natural_key: "Unmapped / missing bag-type columns",
      detail:
        `unmapped=${JSON.stringify(colFlags.unmapped_columns)} missing=${JSON.stringify(colFlags.missing_columns)} ` +
        `— register/acknowledge before these bag types can be written.`,
      kind: "unmapped_or_missing_columns",
      row: {
        unmapped_columns: colFlags.unmapped_columns ?? [],
        missing_columns: colFlags.missing_columns ?? [],
      },
    });
  }

  let seen = 0;
  for (const p of perDate) {
    const d = p.transaction_date;
    seen += 1;
    // ── DATE-SETTLEMENT LEDGER (2026-07-29): a settled date is skipped ENTIRELY. ──
    // No replace, no DELETE, no held row — the arbitration already happened and is
    // recorded in flecon_bag_date_settlements. runReport filters these out before
    // classify; this is the backstop that makes the guarantee true of apply alone.
    if (settledDates?.has(d)) {
      settledSkipped += 1;
      continue;
    }
    if (since && d < since) {
      // Bounded floor — never touch settled history.
      held.push({
        reason: "below_since_floor",
        natural_key: fleconKey(d),
        detail: `${d} < since ${since}; settled history not replaced.`,
        kind: "below_since_floor",
        row: { transaction_date: d, since },
      });
      continue;
    }
    const movements = p.movements ?? [];
    const rows: Array<Record<string, unknown>> = [];
    const unmappedHere: string[] = [];
    for (const m of movements) {
      const code = String(m.bag_type_code ?? "").trim().toUpperCase();
      // code_to_id.get(code) OR code_to_id.get(raw) — mirror the Python fallback.
      const bid = codeToId[code] ?? codeToId[m.bag_type_code as string];
      if (!bid) {
        unmappedHere.push(code);
        continue;
      }
      rows.push({
        transaction_date: d,
        particular: m.particular,
        bag_type_id: bid,
        qty_delta: m.qty_delta,
        source_row: m.source_row,
        remarks: (m as unknown as Record<string, unknown>).remarks ?? null, // always null in practice (§5 trap #2)
      });
    }
    if (unmappedHere.length) {
      const uniq = [...new Set(unmappedHere)].sort();
      held.push({
        reason: "unmapped_bag_type_code",
        natural_key: fleconKey(d, uniq.join(", ")),
        detail: `date ${d} has unmapped codes ${JSON.stringify(uniq)} — date NOT replaced.`,
        kind: "unmapped_bag_type_code",
        row: { transaction_date: d, bag_type_codes: uniq },
      });
      continue;
    }
    // ── Defect C2: a date that resolves to ZERO rows is a HOLD, never a delete. ──
    // A stale/short workbook reports an absent section as "this day has no movements",
    // which REPLACE-BY-DATE would honour by deleting the day down to empty. We never
    // delete a day on the strength of an absent section — the human arbitrates.
    if (rows.length === 0) {
      held.push({
        reason: "delete_to_empty_blocked",
        natural_key: fleconKey(d, "no movements in this report"),
        detail:
          `The report shows NO bag movements at all for ${d}, but the database has ` +
          `${p.db_movement_count} row(s) saved for that day. Wiping a day clean on the strength of ` +
          `a missing section is almost always a short/older copy of the workbook, so nothing was ` +
          `changed for ${d}. If the day genuinely had no bag movement, clear it by hand.`,
        kind: "gate_failure",
        row: {
          transaction_date: d,
          db_movement_count: p.db_movement_count,
          sheet_movement_count: p.sheet_movement_count,
          classified_as: p.class,
        },
      });
      continue;
    }
    try {
      // REPLACE-BY-DATE, now ATOMIC: DELETE + INSERT in ONE transaction (defect C3).
      const res = await deps.db.replaceFleconDate(d, rows);
      inserts += res.inserted;
      replacedDates += 1;
      // ALWAYS write the manual audit row (no audit trigger on flecon) — the marker
      // falls back to a DELETED row's id so even a delete-heavy replace is traceable.
      const markerId = res.firstId ?? res.deletedFirstId;
      if (markerId) {
        await deps.db.writeIngestionAudit({
          tableName: "flecon_bag_movements",
          recordId: markerId,
          operation: "REPLACE",
          comment: prov(
            runTs,
            d,
            p.class,
            `${res.deleted} row(s) removed, ${res.inserted} movement(s) written.`,
          ),
          snapshot: {
            transaction_date: d,
            movement_count: rows.length,
            deleted_count: res.deleted,
            inserted_count: res.inserted,
          },
        });
      }
      if (seen % batch === 0 || seen === total) {
        await deps.progress(
          "apply",
          `Rewriting day ${seen} of ${total} — ${d}`,
          12 + Math.trunc((75 * seen) / total),
        );
      }
    } catch (exc) {
      errors.push(
        operatorError(
          `Couldn't rewrite the bag movements for ${d} — the database refused it. That day ` +
            `was left exactly as it was (nothing was deleted and nothing was added); the ` +
            `email stays unprocessed so the next run tries again.`,
          errText(exc),
        ),
      );
    }
  }

  // ── Defect B + the 2026-07-29 TIMING fix: the informational balance cross-check.
  // It is produced HERE, after the write loop, and against a FRESH balance read — the
  // sheet's balance row already includes everything the workbook carries, so comparing it
  // to pre-write app balances manufactured drift on every importing run. The tolerance is
  // untouched (any non-zero drift is still reported); only the read moved.
  let ccRows: BalanceCrosscheckRow[] | undefined;
  if (deps.readBalances && classified.balance_crosscheck?.available) {
    try {
      const fresh = await deps.readBalances();
      ccRows = recomputeCrosscheckRows(classified.balance_crosscheck.rows ?? [], fresh);
    } catch {
      ccRows = undefined; // re-read failed → fall back to the classify-time rows
    }
  }
  const driftHold = buildBalanceDriftHold(classified, ccRows);
  if (driftHold) held.push(driftHold);

  let watermarkUpdated = false;
  let labeled = false;
  if (!errors.length) {
    await deps.progress("apply", "Updating the audit trail…", 90);
    watermarkUpdated = await deps.db.upsertIngestionWatermark(opts.reportType, {
      lastEmailId: opts.emailThreadId,
    });
    // Label only if zero errors AND no held date/columns that weren't intentional.
    const heldDates = held.filter(
      (h) => h.reason === "unmapped_bag_type_code" || h.reason === "unmapped_or_missing_columns",
    );
    if (!heldDates.length && !opts.noLabel) {
      const uid = opts.emailUid;
      if (uid) {
        await deps.progress("apply", "Marking the email as processed…", 95);
        labeled = await deps.labelProcessed(uid);
      }
    }
  }

  if (errors.length) {
    await deps.progress("finalize", `Finished with ${errors.length} problem(s) — see details.`, 100, undefined, "warn");
  } else if (replacedDates) {
    await deps.progress("finalize", `Done — ${replacedDates} day(s) rewritten, ${inserts} movement(s) written.`, 100);
  } else {
    await deps.progress("finalize", "Done — nothing new to write.", 100);
  }

  return {
    ok: errors.length === 0,
    inserts,
    replaced_dates: replacedDates,
    held,
    labeled,
    watermark_updated: watermarkUpdated,
    errors,
    settled_dates_skipped: settledSkipped,
  };
}
