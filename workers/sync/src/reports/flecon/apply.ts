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
 * Label + watermark: watermark only if `not errors`; label only if `not errors` AND
 *   no held entry with reason unmapped_bag_type_code / unmapped_or_missing_columns —
 *   STRICTER than other pipelines (flecon.md §5). Gmail labeling is an INJECTED
 *   callback so this module never imports gmail (deps wired by the workflow layer).
 *
 * PORTING TRAP #1: the Python reaches into db._session.delete(...) raw. We surface an
 * explicit `deleteByDate` method on the deps' db instead, preserving the exact
 * semantics (unconditional DELETE WHERE transaction_date = eq.{d}, return=minimal).
 */
import type { FleconClassified, PerDateEntry } from "./classify.js";
import { type HeldRow, fleconKey } from "../held.js";

export interface FleconApplyDeps {
  db: {
    /** Unconditional DELETE FROM flecon_bag_movements WHERE transaction_date = eq.{d}. */
    deleteByDate(table: string, date: string): Promise<void>;
    insert(table: string, rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
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
}

export interface FleconApplyOpts {
  reportType: string;
  emailUid: string | null;
  emailThreadId: string | null;
  noLabel: boolean;
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
}

/** provenance comment builder (sync_flecon.py::_prov, lines 130-133). */
function prov(runTs: string, d: string, cls: string, extra = ""): string {
  const base =
    `provenance=flecon-sync | REPLACE-BY-DATE (${cls}) for ${d} by sync_flecon.py ` +
    `(lean orchestrator) on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
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

  const total = Math.max(1, perDate.length);
  const batch = Math.max(1, Math.ceil(total / 10));
  await deps.progress("apply", `Rewriting bag movements for ${perDate.length} day(s)…`, 12);

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
    try {
      // REPLACE-BY-DATE: DELETE this date then INSERT the sheet's current movements.
      await deps.db.deleteByDate("flecon_bag_movements", d);
      let ins: Array<Record<string, unknown>> = [];
      if (rows.length) {
        ins = await deps.db.insert("flecon_bag_movements", rows);
        inserts += ins.length;
      }
      replacedDates += 1;
      // One manual audit row per replaced date (no audit trigger on flecon).
      const markerId = rows.length && ins.length ? (ins[0].id as string) : null;
      if (markerId) {
        await deps.db.writeIngestionAudit({
          tableName: "flecon_bag_movements",
          recordId: markerId,
          operation: "REPLACE",
          comment: prov(runTs, d, p.class, `${rows.length} movements`),
          snapshot: { transaction_date: d, movement_count: rows.length },
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
      errors.push(`replace date ${d}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

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
  };
}
