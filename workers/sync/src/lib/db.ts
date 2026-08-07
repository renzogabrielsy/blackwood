/**
 * db.ts — Supabase service-role DB client for the sync worker.
 *
 * Port of `.claude/skills/sync-ictc/scripts/lib/db.py` (read as spec). The Python
 * used raw PostgREST over `requests`; here we use @supabase/supabase-js's service
 * client, which speaks the same PostgREST API. Contracts mirrored EXACTLY:
 *
 *   readRows(table, {sinceDate, sinceColumn, columns, extraFilters, pageSize})
 *       — paginated full-table read; rows never enter an LLM context.
 *   insert(table, rows)                       — bulk insert, returns rows.
 *   insertIfAbsent(table, rows, naturalKey)   — idempotent insert (L-020): re-SELECT
 *       on the natural key immediately before each insert; skip if present. NOT a DB
 *       constraint — a sync-layer guard (legitimately identical truckloads allowed).
 *   update(table, filters, patch)             — PATCH … WHERE filters.
 *   writeIngestionAudit(...)                   — RPC write_ingestion_audit (L-009):
 *       tables with NO audit trigger (rc_out, production_*, electricity_readings,
 *       truck_readings, flecon_bag_movements) get their audit row via the SECURITY
 *       DEFINER RPC — service role has no direct INSERT grant on audit_logs.
 *   stampIngestionAudit(...)                   — RPC stamp_ingestion_audit (L-001):
 *       deliveries fires its own audit trigger on INSERT; we UPDATE that row for
 *       provenance via the SECURITY DEFINER RPC (no direct UPDATE grant either).
 *   upsertIngestionWatermark(...)              — run bookkeeping (best-effort).
 *   insertProgressEvent(...)                   — sync_run_events row (used by progress.ts).
 *   sync_runs lifecycle: createSyncRun / setSyncRunStatus / finishSyncRun.
 *
 * Error-string style mirrors lib/db.py: "<op> <table> failed <status>: <body slice>".
 *
 * DB trigger facts replicated (LEARNING_LEDGER L-001/L-005/L-006):
 *  - deliveries: BEFORE-INSERT fn_update_blackwood_state maintains current_weight,
 *    AND an AFTER-insert audit trigger writes its own audit_logs row. So after
 *    inserting a delivery, do NOT touch current_weight and do NOT insert a 2nd audit
 *    row — stamp the trigger-written one (stampIngestionAudit).
 *  - rc_out and the other fact tables have NO audit trigger — write via
 *    writeIngestionAudit.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface DbConfig {
  url: string;
  serviceRoleKey: string;
}

/** Read (SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY from env. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in env"
    );
  }
  return { url, serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Row = Record<string, unknown>;

export interface ReadRowsOptions {
  sinceDate?: string | null;
  sinceColumn?: string | null; // default "transaction_date"; pass null to disable
  columns?: string[];
  /** PostgREST-style extra filters, e.g. { order: "transaction_date.desc", limit: "1" }. */
  extraFilters?: Record<string, string>;
  pageSize?: number;
}

export interface InsertIfAbsentResult {
  inserted: Row[];
  skipped: Row[];
  insertedCount: number;
  skippedCount: number;
}

export interface ProgressEventRow {
  run_id: string;
  report_type: string;
  stage: string;
  pct: number;
  label: string;
  detail: string | null;
  level: string;
}

export type SyncRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class DbClient {
  readonly sb: SupabaseClient;

  constructor(cfg: DbConfig) {
    this.sb = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Match the Python service client: no session, direct PostgREST calls.
    });
  }

  static fromEnv(env?: NodeJS.ProcessEnv): DbClient {
    return new DbClient(dbConfigFromEnv(env));
  }

  // -- reads ---------------------------------------------------------------
  /**
   * Fetch rows from `table`, optionally filtered to sinceColumn >= sinceDate.
   * Pages through PostgREST ranges so large tables are fully retrieved. Mirrors
   * lib/db.py::read_rows (default sinceColumn = "transaction_date").
   */
  async readRows(table: string, opts: ReadRowsOptions = {}): Promise<Row[]> {
    const {
      sinceDate = null,
      sinceColumn = "transaction_date",
      columns,
      extraFilters,
      pageSize = 1000,
    } = opts;

    const select = columns && columns.length ? columns.join(",") : "*";
    const rows: Row[] = [];
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = this.sb.from(table).select(select);
      if (sinceDate && sinceColumn) {
        q = q.gte(sinceColumn, sinceDate);
      }
      // Apply PostgREST-style extra filters (order/limit/eq) verbatim.
      q = applyExtraFilters(q, extraFilters);
      q = q.range(offset, offset + pageSize - 1);

      const { data, error } = await q;
      if (error) {
        throw new Error(
          `read_rows ${table} failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
        );
      }
      const batch = (data ?? []) as unknown as Row[];
      rows.push(...batch);
      // If an explicit limit was requested, PostgREST already capped it — stop.
      if (extraFilters && "limit" in extraFilters) break;
      if (batch.length < pageSize) break;
      offset += pageSize;
    }
    return rows;
  }

  /** SELECT … LIMIT 1 with equality/op filters. Mirrors lib/db.py::select_one. */
  async selectOne(
    table: string,
    filters: Record<string, string>,
    columns = "*"
  ): Promise<Row | null> {
    let q = this.sb.from(table).select(columns);
    q = applyPostgrestFilters(q, filters);
    const { data, error } = await q.limit(1);
    if (error) {
      throw new Error(
        `select_one ${table} failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return (data && data[0]) ? (data[0] as unknown as Row) : null;
  }

  // -- writes --------------------------------------------------------------
  /** Insert one or many rows. Returns inserted rows (with ids). lib/db.py::insert. */
  async insert(table: string, rows: Row[]): Promise<Row[]> {
    if (!rows.length) return [];
    const { data, error } = await this.sb.from(table).insert(rows).select();
    if (error) {
      throw new Error(
        `insert ${table} failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return (data ?? []) as Row[];
  }

  /**
   * Idempotent insert (L-020 / BUG-2 fix). For each candidate row, re-SELECT the DB
   * on `naturalKey` IMMEDIATELY before inserting it; if a match exists, SKIP it.
   * This is a SYNC-LAYER guard, NOT a DB unique constraint — legitimately identical
   * truckloads (same date/batch/truck/weight/sacks) are allowed by the DB. A null
   * key column falls back to `is.null` matching (same as the Python). Returns
   * {inserted, skipped, insertedCount, skippedCount}.
   */
  async insertIfAbsent(
    table: string,
    rows: Row[],
    naturalKey: string[]
  ): Promise<InsertIfAbsentResult> {
    const inserted: Row[] = [];
    const skipped: Row[] = [];
    const toInsert: Row[] = [];

    for (const row of rows) {
      const filters: Record<string, string> = {};
      for (const col of naturalKey) {
        const val = row[col];
        if (val === null || val === undefined) {
          filters[col] = "is.null";
        } else {
          filters[col] = `eq.${val}`;
        }
      }
      // NOTE: hardcodes selecting "id" — this helper assumes `table` has an `id` column.
      // For an id-less table (e.g. rc_out_date_settlements, PK = transaction_date) this
      // throws "column <table>.id does not exist" via PostgREST. Use a dedicated
      // upsert-on-conflict path (see upsertBatchIfAbsent / insertSettlements) instead.
      const existing = await this.selectOne(table, filters, "id");
      if (existing !== null) skipped.push(row);
      else toInsert.push(row);
    }

    let insertedRows: Row[] = [];
    if (toInsert.length) insertedRows = await this.insert(table, toInsert);
    inserted.push(...insertedRows);

    return {
      inserted,
      skipped,
      insertedCount: inserted.length,
      skippedCount: skipped.length,
    };
  }

  /**
   * UPDATE table SET patch WHERE filters. `filters` values are PostgREST ops, e.g.
   * { id: "eq.<uuid>" }. Mirrors lib/db.py::update.
   */
  async update(
    table: string,
    filters: Record<string, string>,
    patch: Row
  ): Promise<Row[]> {
    let q = this.sb.from(table).update(patch);
    q = applyPostgrestFilters(q, filters);
    const { data, error } = await q.select();
    if (error) {
      throw new Error(
        `update ${table} failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return (data ?? []) as Row[];
  }

  /**
   * Unconditional DELETE FROM `table` WHERE transaction_date = eq.{date}, return
   * minimal. The flecon REPLACE-BY-DATE apply needs this (its Python reached into
   * db._session.delete(...) raw — flecon apply.ts PORTING TRAP #1). Additive to the
   * base client; no report logic depends on its return value.
   */
  async deleteByDate(table: string, date: string): Promise<void> {
    const { error } = await this.sb.from(table).delete().eq("transaction_date", date);
    if (error) {
      throw new Error(
        `delete_by_date ${table} failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
  }

  /**
   * ATOMIC flecon REPLACE-BY-DATE (BUG-015 defect C3, 2026-07-27). Calls the
   * `fn_flecon_replace_date` RPC, which DELETEs one date's `flecon_bag_movements` rows
   * and INSERTs the supplied replacements inside ONE transaction.
   *
   * The old shape was `deleteByDate()` then `insert()` — two independent HTTP calls, so
   * a failure (or a stop) between them left the date DELETED with nothing inserted and,
   * because the audit row was only written when the insert returned rows, NO audit trail
   * of the wipe. This RPC makes the pair all-or-nothing and returns a marker id from
   * EITHER side so the caller can always write its audit row.
   */
  async replaceFleconDate(
    date: string,
    rows: Row[]
  ): Promise<{
    deleted: number;
    deletedFirstId: string | null;
    inserted: number;
    firstId: string | null;
  }> {
    const { data, error } = await this.sb.rpc("fn_flecon_replace_date", {
      p_date: date,
      p_rows: rows,
    });
    if (error) {
      throw new Error(
        `fn_flecon_replace_date RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    const o = (data ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return {
      deleted: n(o.deleted),
      deletedFirstId: s(o.deleted_first_id),
      inserted: n(o.inserted),
      firstId: s(o.first_id),
    };
  }

  /**
   * Idempotent, RACE-SAFE batch creation (2026-07-11 auto-create policy). Upserts one
   * `batches` row keyed on the UNIQUE `batch_code` column with ON CONFLICT DO NOTHING
   * (`ignoreDuplicates: true`), then re-SELECTs — so two PARALLEL writer lanes (e.g.
   * deliveries + rc_out both feeding a brand-new batch in the same run) can't crash or
   * duplicate each other: the loser's upsert silently does nothing and its re-select
   * finds the winner's row. Returns `created:true` only for the caller that actually
   * inserted the row (so exactly one lane writes the batch-creation audit log).
   * Mirrors lib/sync/batchAutoCreate.ts's DerivedBatchFields shape (batch_code,
   * location_ref, status, current_weight, avg_cost) but accepts any row shape.
   */
  async upsertBatchIfAbsent(row: Row): Promise<{ id: string; batch_code: string; created: boolean }> {
    const batchCode = row.batch_code;
    if (!batchCode) throw new Error("upsert_batch_if_absent: row.batch_code is required");
    const { data, error } = await this.sb
      .from("batches")
      .upsert(row, { onConflict: "batch_code", ignoreDuplicates: true })
      .select("id,batch_code");
    if (error) {
      throw new Error(
        `upsert_batch_if_absent batches failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    if (data && data.length) {
      const row0 = data[0] as { id: string; batch_code: string };
      return { id: String(row0.id), batch_code: String(row0.batch_code), created: true };
    }
    // ignoreDuplicates means a conflict returns nothing from .select() — re-select the
    // row a sibling lane already created (or that existed from a prior run).
    const existing = await this.selectOne(
      "batches",
      { batch_code: `eq.${batchCode}` },
      "id,batch_code"
    );
    if (!existing) {
      throw new Error(
        `upsert_batch_if_absent batches: no row found after ignoreDuplicates conflict for '${batchCode}'`
      );
    }
    return { id: String(existing.id), batch_code: String(existing.batch_code), created: false };
  }

  /**
   * Flip a batch to CLOSED via the SECURITY DEFINER `fn_close_batch(uuid)` RPC (the ONE
   * place the close write lives — service-role-only EXECUTE). Idempotent + monotonic: the
   * function only updates a batch that is NOT already CLOSED and NEVER re-opens one. Used by
   * the gsheet close-scan (workflows/runSync.ts) to close a batch whose "CLOSED" remark lives
   * in the Google Sheet RC OUT tab, which the R4b cutover otherwise drops. Returns true when a
   * row was actually flipped (was non-CLOSED), false when it was already CLOSED / not found.
   */
  async closeBatch(batchId: string): Promise<boolean> {
    const { data, error } = await this.sb.rpc("fn_close_batch", { p_batch_id: batchId });
    if (error) {
      throw new Error(
        `fn_close_batch RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return Boolean(data);
  }

  // -- rc_out date-settlement ledger (2026-07-12) ---------------------------
  /**
   * All settled `transaction_date`s (ISO "YYYY-MM-DD" strings) as a Set, for O(1)
   * membership checks while filtering extracted rows. Reads the whole ledger — it is
   * small (one row per already-balanced historical date) and read every run.
   */
  async readSettledDates(): Promise<Set<string>> {
    const rows = await this.readRows("rc_out_date_settlements", {
      columns: ["transaction_date"],
      sinceColumn: null,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const d = r.transaction_date;
      if (d) out.add(String(d).slice(0, 10));
    }
    return out;
  }

  /**
   * Idempotent insert of newly-qualifying settlement rows. `rc_out_date_settlements` has
   * NO `id` column (its PK is `transaction_date`), so this CANNOT go through
   * `insertIfAbsent` (that helper hardcodes `.select("id")`, which PostgREST 400s on an
   * id-less table — this was a real bug: the ledger silently inserted zero rows every
   * run while the caller logged a false "Settled N date(s)"). Instead this upserts
   * directly on the `transaction_date` PK with `ignoreDuplicates: true`, mirroring
   * `upsertBatchIfAbsent`'s pattern: a re-run naming a date already settled is a silent
   * skip, never a duplicate/crash. `.select()` after an `ignoreDuplicates` upsert returns
   * ONLY the rows PostgREST actually inserted, so `data.length` is the true insertedCount.
   * Best-effort/non-fatal, mirroring upsertIngestionWatermark: a failure here must never
   * fail the sync run — settlement is a re-ingestion optimization, not a correctness
   * requirement — but the happy path must actually write.
   */
  async insertSettlements(
    rows: Array<{
      transaction_date: string;
      db_sum_kg: number;
      movement_kg: number;
      settled_by_run_id?: string | null;
    }>,
  ): Promise<{ insertedCount: number; skippedCount: number }> {
    if (!rows.length) return { insertedCount: 0, skippedCount: 0 };
    try {
      const { data, error } = await this.sb
        .from("rc_out_date_settlements")
        .upsert(rows, { onConflict: "transaction_date", ignoreDuplicates: true })
        .select("transaction_date");
      if (error) {
        throw new Error(
          `insert_settlements rc_out_date_settlements failed ${error.code ?? ""}: ${sliceMsg(
            error.message,
          )}`,
        );
      }
      const insertedCount = (data ?? []).length;
      const skippedCount = rows.length - insertedCount;
      return { insertedCount, skippedCount };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[warn] rc_out_date_settlements insert failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { insertedCount: 0, skippedCount: rows.length };
    }
  }

  // -- flecon date-settlement ledger (2026-07-29) ---------------------------
  /**
   * All settled flecon `transaction_date`s as a Set, for O(1) membership checks while
   * filtering extracted rows / DB movements. Sibling of `readSettledDates` (rc_out); the
   * ledger is tiny (one row per arbitrated date) and read once per flecon run.
   */
  async readFleconSettledDates(): Promise<Set<string>> {
    const rows = await this.readRows("flecon_bag_date_settlements", {
      columns: ["transaction_date"],
      sinceColumn: null,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const d = r.transaction_date;
      if (d) out.add(String(d).slice(0, 10));
    }
    return out;
  }

  /**
   * Idempotent insert of newly-qualifying flecon settlements. Same shape and same trap as
   * `insertSettlements`: `flecon_bag_date_settlements` has NO `id` column (PK =
   * transaction_date), so this CANNOT go through `insertIfAbsent` (that helper hardcodes
   * `.select("id")`, which PostgREST 400s on an id-less table). Upserts directly on the
   * PK with `ignoreDuplicates: true`, so a re-run naming an already-settled date is a
   * silent skip. `.select()` after an `ignoreDuplicates` upsert returns ONLY the rows
   * PostgREST actually inserted, so `insertedDates` is the true set. Best-effort /
   * non-fatal — a failure here must never fail the run (settlement is protection, and its
   * absence degrades to the pre-existing behavior, never to a wrong write).
   */
  async insertFleconSettlements(
    rows: Array<{
      transaction_date: string;
      db_movement_count: number;
      db_net_qty: number;
      reason?: string;
      note?: string | null;
      settled_by_run_id?: string | null;
    }>,
  ): Promise<{ insertedCount: number; insertedDates: string[]; skippedCount: number }> {
    if (!rows.length) return { insertedCount: 0, insertedDates: [], skippedCount: 0 };
    try {
      const { data, error } = await this.sb
        .from("flecon_bag_date_settlements")
        .upsert(rows, { onConflict: "transaction_date", ignoreDuplicates: true })
        .select("transaction_date");
      if (error) {
        throw new Error(
          `insert_settlements flecon_bag_date_settlements failed ${error.code ?? ""}: ${sliceMsg(
            error.message,
          )}`,
        );
      }
      const insertedDates = (data ?? []).map((r) =>
        String((r as unknown as Row).transaction_date ?? "").slice(0, 10),
      );
      return {
        insertedCount: insertedDates.length,
        insertedDates,
        skippedCount: rows.length - insertedDates.length,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[warn] flecon_bag_date_settlements insert failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { insertedCount: 0, insertedDates: [], skippedCount: rows.length };
    }
  }

  // -- production plan (production_schedule) --------------------------------
  //
  // REMOVED 2026-07-30: `upsertProductionSchedule(rows)`, a blind replace-by-plan_date
  // upsert of the WHOLE calendar on every run. It was the clobber mechanism the schedule
  // "master plotter" Phase A exists to kill — nothing may write this table unconditionally
  // any more. The pair below is the replacement: snapshot state, plan purely, apply
  // atomically. Do NOT reintroduce a blanket upsert here.
  /**
   * Snapshot `view_production_schedule_state` for the given plan_dates — the ADVISORY
   * read the conditional-refresh planner works from (ownership, the stored/parked
   * source_rev, row_version, the actuals-freeze flag, and the current plan values).
   *
   * Chunked at 400 dates per request: a plan is ~year-sized (273 rows today) but a single
   * `in.(…)` list of a whole year is a long URL, and PostgREST caps a response at 1000
   * rows regardless. Returns whatever it can read; a hard error throws (the caller,
   * refreshProductionSchedule, is fully guarded and downgrades any throw to non-fatal).
   */
  async readScheduleState(planDates: string[]): Promise<Row[]> {
    if (!planDates.length) return [];
    const CHUNK = 400;
    const out: Row[] = [];
    for (let i = 0; i < planDates.length; i += CHUNK) {
      const slice = planDates.slice(i, i + CHUNK);
      const { data, error } = await this.sb
        .from("view_production_schedule_state")
        .select(
          "plan_date, shifts, setup, projected_tons, grades, remarks, source, owner, " +
            "source_rev, row_version, pending_source_rev, is_reported",
        )
        .in("plan_date", slice);
      if (error) {
        throw new Error(
          `read view_production_schedule_state failed ${error.code ?? ""}: ${sliceMsg(
            error.message,
          )}`,
        );
      }
      out.push(...((data ?? []) as unknown as Row[]));
    }
    return out;
  }

  /**
   * CONDITIONAL production-schedule write via the atomic RPC `fn_apply_schedule_upstream`.
   *
   * Replaces the old unconditional `upsertProductionSchedule`. The worker plans purely
   * (reports/prodSchedule/plan.ts) and hands the planned ops here; the RPC re-checks
   * row_version + owner + the production_shifts actuals freeze IN THE SAME STATEMENT as
   * each write, so a human save that landed between the snapshot and this call wins and
   * comes back as `version_conflict` rather than being clobbered.
   *
   * Chunked at 200 ops (each op carries a full row payload). Returns the flat outcome
   * list. Throws on a hard PostgREST error — the caller is guarded.
   */
  async applyScheduleUpstream(
    ops: Row[],
  ): Promise<Array<{ plan_date: string; action: string; outcome: string }>> {
    if (!ops.length) return [];
    const CHUNK = 200;
    const out: Array<{ plan_date: string; action: string; outcome: string }> = [];
    for (let i = 0; i < ops.length; i += CHUNK) {
      const slice = ops.slice(i, i + CHUNK);
      const { data, error } = await this.sb.rpc("fn_apply_schedule_upstream", {
        p_ops: slice,
      });
      if (error) {
        throw new Error(
          `fn_apply_schedule_upstream RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`,
        );
      }
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        out.push({
          plan_date: String(r.plan_date ?? "").slice(0, 10),
          action: String(r.action ?? ""),
          outcome: String(r.outcome ?? ""),
        });
      }
    }
    return out;
  }

  // -- production facts (the human-edit latch, 2026-08-03) ------------------
  /**
   * CONDITIONAL update of the production fact tables via the atomic RPC
   * `fn_apply_production_upstream`.
   *
   * This is the ONLY way the sync may UPDATE `production_runs` / `production_downtime` /
   * `production_waste` / `electricity_readings` / `truck_readings`. A plain
   * `db.update(table, {id}, patch)` on those tables would silently revert a number an
   * operator corrected in the app; the RPC re-checks `human_edited_at IS NULL` IN THE SAME
   * STATEMENT as each write, so a save that landed between classify and apply wins and the
   * op comes back labelled `human_edited` instead of clobbering it.
   *
   * `production_shifts` is deliberately NOT accepted — the sync only ever inserts shifts.
   *
   * Chunked at 200 ops. Throws on a hard PostgREST error (the caller records it in
   * `errors[]`, which already blocks the watermark + Gmail label).
   */
  async applyProductionUpstream(
    ops: Row[],
  ): Promise<Array<{ table: string; id: string; outcome: string }>> {
    if (!ops.length) return [];
    const CHUNK = 200;
    const out: Array<{ table: string; id: string; outcome: string }> = [];
    for (let i = 0; i < ops.length; i += CHUNK) {
      const slice = ops.slice(i, i + CHUNK);
      const { data, error } = await this.sb.rpc("fn_apply_production_upstream", {
        p_ops: slice,
      });
      if (error) {
        throw new Error(
          `fn_apply_production_upstream RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`,
        );
      }
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        out.push({
          table: String(r.table ?? ""),
          id: String(r.id ?? ""),
          outcome: String(r.outcome ?? ""),
        });
      }
    }
    return out;
  }

  // -- audit helpers (L-009 SECURITY DEFINER RPCs) -------------------------
  /**
   * For tables with NO audit trigger: write the audit_logs row via the SECURITY
   * DEFINER RPC write_ingestion_audit (owner postgres, service_role-only EXECUTE).
   * The service role has no direct INSERT grant on audit_logs. Mirrors
   * lib/db.py::insert_manual_audit. Returns the new audit id (or null).
   */
  async writeIngestionAudit(args: {
    tableName: string;
    recordId: string;
    operation: string;
    comment: string;
    diff?: Row | null;
    snapshot?: Row | null;
  }): Promise<{ id: string } | null> {
    const { data, error } = await this.sb.rpc("write_ingestion_audit", {
      p_table_name: args.tableName,
      p_record_id: args.recordId,
      p_operation: args.operation,
      p_comment: args.comment,
      p_diff: args.diff ?? null,
      p_snapshot: args.snapshot ?? null,
    });
    if (error) {
      throw new Error(
        `write_ingestion_audit RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return data ? { id: data as string } : null;
  }

  /**
   * Remember a source-spelling pair in `public.delivery_source_aliases` via the
   * service-role-only RPC `fn_record_delivery_source_alias` (2026-08-07).
   *
   * Czarina's price file writes some plates and supplier names differently from the
   * operator's RC DELIVERIES sheet ("T138003" vs "138003", "ALA 3958" vs "ALA9958").
   * Persisting a pair the sync has already corroborated turns a fuzzy match into a
   * clean exact match on every future run, so the same typo never needs a human twice.
   *
   * The RPC is idempotent: a repeat sighting bumps `times_seen` and re-activates a
   * retired pair, but never rewrites the original `evidence`. It REFUSES a blank
   * evidence string and refuses `ours = theirs` — an alias is earned, never guessed.
   */
  async recordSourceAlias(args: {
    kind: "truck_plate" | "supplier";
    ours: string;
    theirs: string;
    evidence: string;
    ours_raw?: string | null;
    theirs_raw?: string | null;
    seen_on?: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.sb.rpc("fn_record_delivery_source_alias", {
      p_kind: args.kind,
      p_ours: args.ours,
      p_theirs: args.theirs,
      p_evidence: args.evidence,
      p_ours_raw: args.ours_raw ?? null,
      p_theirs_raw: args.theirs_raw ?? null,
      p_seen_on: args.seen_on ?? null,
    });
    if (error) {
      throw new Error(
        `fn_record_delivery_source_alias RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return data ? String(data) : null;
  }

  /**
   * For tables whose INSERT fires an audit trigger (deliveries): UPDATE the
   * trigger-written audit row's comment for provenance (L-001 — never INSERT a 2nd)
   * via the SECURITY DEFINER RPC stamp_ingestion_audit. Mirrors
   * lib/db.py::update_trigger_audit_provenance. Returns true if a row was updated.
   */
  async stampIngestionAudit(args: {
    tableName: string;
    recordId: string;
    comment: string;
    snapshot?: Row | null;
  }): Promise<boolean> {
    const { data, error } = await this.sb.rpc("stamp_ingestion_audit", {
      p_table_name: args.tableName,
      p_record_id: args.recordId,
      p_operation: "INSERT",
      p_comment: args.comment,
      p_snapshot: args.snapshot ?? null,
    });
    if (error) {
      throw new Error(
        `stamp_ingestion_audit RPC failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    const count = typeof data === "number" ? data : Number(data ?? 0);
    return Boolean(count);
  }

  /**
   * Upsert one row per report_type into ingestion_watermarks (run bookkeeping).
   * Best-effort — mirrors orchestrator_common.upsert_ingestion_watermark; a failure
   * here returns false and must never fail the apply.
   */
  async upsertIngestionWatermark(
    reportType: string,
    opts: { lastEmailId?: string | null; lastEmailReceivedAt?: string | null } = {}
  ): Promise<boolean> {
    const row: Row = {
      report_type: reportType,
      last_run_at: new Date().toISOString(),
    };
    if (opts.lastEmailId !== undefined) row.last_email_id = opts.lastEmailId;
    if (opts.lastEmailReceivedAt !== undefined)
      row.last_email_received_at = opts.lastEmailReceivedAt;
    const { error } = await this.sb
      .from("ingestion_watermarks")
      .upsert(row, { onConflict: "report_type" });
    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[warn] ingestion_watermarks upsert failed (non-fatal): ${error.message}`
      );
      return false;
    }
    return true;
  }

  /**
   * The REAL data watermark = MAX(dateColumn). Mirrors
   * orchestrator_common.data_watermark. Returns "YYYY-MM-DD" or null.
   */
  async dataWatermark(
    table: string,
    dateColumn = "transaction_date"
  ): Promise<string | null> {
    const rows = await this.readRows(table, {
      columns: [dateColumn],
      sinceColumn: null,
      extraFilters: { order: `${dateColumn}.desc`, limit: "1" },
    });
    if (!rows.length) return null;
    const val = rows[0][dateColumn];
    return val ? String(val).slice(0, 10) : null;
  }

  /**
   * The MC PRODUCTION watermark = MAX(production_shifts.transaction_date) among shifts
   * that have at least one production_runs child. Returns "YYYY-MM-DD" or null — the
   * SAME contract as dataWatermark.
   *
   * WHY this exists instead of dataWatermark("production_shifts"): production_shifts is
   * written by BOTH source reports. MC's "Daily Production Report" drips ONE day per
   * email and writes production_runs/downtime/electricity/trucks. Ivy's "WASTE" report
   * is a CUMULATIVE monthly workbook — its parent-shift upsert creates a production_shifts
   * row for EVERY waste day of the month. Because waste is cumulative it runs ahead of
   * MC, so a plain MAX(production_shifts.transaction_date) tracks the latest WASTE day,
   * not MC's frontier. Feeding that inflated max back as the EXCLUSIVE `since` made
   * extractMc silently drop every MC day-sheet dated <= it — MC's runs/downtime/
   * electricity/trucks stalled the moment waste passed MC's frontier, with no error.
   * production_runs is written ONLY by MC, so its frontier is MC's true watermark.
   *
   * Deliberately the RUNS frontier (a per-day presence test), NOT a MIN across all MC
   * streams: a chronically-sparse stream (e.g. trucks with no trips for days) must never
   * peg the watermark backward and force a full re-walk every run. Electricity/trucks
   * that are legitimately behind ride along on whatever day-sheets fall in the extraction
   * window — they are not a reason to lower the durable watermark further.
   *
   * Mirrors the view_digest_stream_freshness production branch
   * (supabase/migrations/20260714000000_digest_stream_freshness_production_output.sql):
   *   max(ps.transaction_date) WHERE EXISTS (SELECT 1 FROM production_runs pr
   *                                          WHERE pr.shift_id = ps.id)
   * Issued over PostgREST as an inner embed (parent-side order/limit picks the max):
   *   production_shifts?select=transaction_date,production_runs!inner(id)
   *     &order=transaction_date.desc&limit=1
   */
  async productionRunsFrontier(): Promise<string | null> {
    const { data, error } = await this.sb
      .from("production_shifts")
      .select("transaction_date,production_runs!inner(id)")
      .order("transaction_date", { ascending: false })
      .limit(1);
    if (error) {
      throw new Error(
        `production_runs_frontier failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    const rows = (data ?? []) as Array<{ transaction_date?: unknown }>;
    if (!rows.length) return null;
    const val = rows[0].transaction_date;
    return val ? String(val).slice(0, 10) : null;
  }

  // -- sync_runs / sync_run_events (new for the worker) --------------------
  async insertProgressEvent(ev: ProgressEventRow): Promise<void> {
    const { error } = await this.sb.from("sync_run_events").insert(ev);
    if (error) {
      throw new Error(
        `insert sync_run_events failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
  }

  async createSyncRun(args: {
    requestedBy?: string | null;
  } = {}): Promise<{ id: string }> {
    const { data, error } = await this.sb
      .from("sync_runs")
      .insert({ requested_by: args.requestedBy ?? null, status: "queued" })
      .select("id")
      .single();
    if (error) {
      throw new Error(
        `create sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return { id: (data as { id: string }).id };
  }

  /**
   * The run's created_at ISO timestamp. R4a reconciliation reads this to derive the run's
   * calendar date (YYYY-MM-DD) deterministically — a fixed stored value, never Date.now()
   * inside a DBOS step. Returns null if the run has no created_at.
   */
  async getSyncRunCreatedAt(runId: string): Promise<string | null> {
    const { data, error } = await this.sb
      .from("sync_runs")
      .select("created_at")
      .eq("id", runId)
      .single();
    if (error) {
      throw new Error(
        `read sync_runs created_at failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return (data as { created_at: string | null }).created_at ?? null;
  }

  async setSyncRunStatus(
    runId: string,
    status: SyncRunStatus,
    extra: Row = {}
  ): Promise<void> {
    const patch: Row = { status, ...extra };
    if (status === "running" && !("started_at" in patch)) {
      patch.started_at = new Date().toISOString();
    }
    const { error } = await this.sb.from("sync_runs").update(patch).eq("id", runId);
    if (error) {
      throw new Error(
        `update sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
  }

  async finishSyncRun(
    runId: string,
    status: Extract<SyncRunStatus, "succeeded" | "failed" | "partial" | "cancelled">,
    result: Row | null,
    errorText?: string | null
  ): Promise<void> {
    const { error } = await this.sb
      .from("sync_runs")
      .update({
        status,
        result: result ?? null,
        error: errorText ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (error) {
      throw new Error(
        `finish sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
  }

  // -- self-healing helpers (M5.1 — recovery + watchdog) -------------------
  /**
   * Terminally mark a run 'cancelled' (the Stop button) — but ONLY if it is still
   * non-terminal, so we never clobber a run that already succeeded/failed in a race.
   * finished_at is stamped; result/error are left as-is (a stop keeps prior rows and
   * whatever partial result was written). Returns true if a row was actually updated.
   */
  async cancelSyncRunIfActive(runId: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from("sync_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", runId)
      .in("status", ["queued", "running"])
      .select("id");
    if (error) {
      throw new Error(
        `cancel sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Terminally mark a run 'failed' with an error string — ONLY if still non-terminal.
   * Used by the stale-run watchdog to auto-expire orphaned runs. Returns true if a row
   * was updated (so the watchdog never double-reports an already-settled run).
   */
  async failSyncRunIfActive(runId: string, errorText: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from("sync_runs")
      .update({ status: "failed", error: errorText, finished_at: new Date().toISOString() })
      .eq("id", runId)
      .in("status", ["queued", "running"])
      .select("id");
    if (error) {
      throw new Error(
        `fail sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * List runs still in a NON-terminal state (queued|running) created within the last
   * `withinHours`. Startup recovery uses status='queued'; the watchdog reads both.
   * Returns minimal fields: id, status, created_at.
   */
  async listActiveRuns(
    opts: { statuses?: SyncRunStatus[]; withinHours?: number } = {}
  ): Promise<Array<{ id: string; status: string; created_at: string | null }>> {
    const statuses = opts.statuses ?? ["queued", "running"];
    let q = this.sb
      .from("sync_runs")
      .select("id,status,created_at")
      .in("status", statuses);
    if (opts.withinHours && opts.withinHours > 0) {
      const floor = new Date(Date.now() - opts.withinHours * 3600 * 1000).toISOString();
      q = q.gte("created_at", floor);
    }
    const { data, error } = await q.order("created_at", { ascending: true });
    if (error) {
      throw new Error(
        `list active sync_runs failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    return (data ?? []) as Array<{ id: string; status: string; created_at: string | null }>;
  }

  /**
   * The timestamp of the NEWEST progress event for a run, or null if it has none.
   * The watchdog uses this to detect a stalled run (no event in > STALE_RUN_MINUTES).
   */
  async latestEventAt(runId: string): Promise<string | null> {
    const { data, error } = await this.sb
      .from("sync_run_events")
      .select("at")
      .eq("run_id", runId)
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(
        `latest sync_run_events failed ${error.code ?? ""}: ${sliceMsg(error.message)}`
      );
    }
    const val = (data as { at?: string } | null)?.at;
    return val ?? null;
  }
}

// ---------------------------------------------------------------------------
// PostgREST filter helpers (mirror the {col: "op.val"} contract from lib/db.py)
// ---------------------------------------------------------------------------
// The supabase-js filter builders are chainable and return `this`, so we thread
// the builder through each filter. We type it loosely (`AnyBuilder`) because the
// select/update builders have distinct generic types but share the filter surface.
type AnyBuilder = {
  order: (col: string, opts: { ascending: boolean }) => AnyBuilder;
  limit: (n: number) => AnyBuilder;
  eq: (col: string, val: unknown) => AnyBuilder;
  /** PostgREST `is.` accepts null / true / false (see applyOneFilter). */
  is: (col: string, val: null | boolean) => AnyBuilder;
  gte: (col: string, val: unknown) => AnyBuilder;
  lte: (col: string, val: unknown) => AnyBuilder;
};

/** Apply order/limit-style extra filters used by readRows. Returns the same-typed builder. */
function applyExtraFilters<T>(q: T, extra?: Record<string, string>): T {
  if (!extra) return q;
  let b = q as unknown as AnyBuilder;
  for (const [key, raw] of Object.entries(extra)) {
    if (key === "order") {
      const [col, dir] = raw.split(".");
      b = b.order(col, { ascending: dir !== "desc" });
    } else if (key === "limit") {
      b = b.limit(parseInt(raw, 10));
    } else {
      b = applyOneFilter(b, key, raw);
    }
  }
  return b as unknown as T;
}

/** Apply {col: "op.value"} PostgREST filters (eq / is.null / gte / lte). */
function applyPostgrestFilters<T>(q: T, filters: Record<string, string>): T {
  let b = q as unknown as AnyBuilder;
  for (const [col, spec] of Object.entries(filters)) {
    b = applyOneFilter(b, col, spec);
  }
  return b as unknown as T;
}

function applyOneFilter(b: AnyBuilder, col: string, spec: string): AnyBuilder {
  const dot = spec.indexOf(".");
  const op = dot >= 0 ? spec.slice(0, dot) : "eq";
  const val = dot >= 0 ? spec.slice(dot + 1) : spec;
  switch (op) {
    case "is":
      // PostgREST `is.` takes null / true / false / unknown. This used to hardcode
      // `is(col, null)` and DISCARD the value, so `is.true` silently became
      // `IS NULL` — a filter that quietly returns the wrong rows. Every existing
      // caller passed `is.null`, so honouring the value changes nothing for them
      // and makes `is.true`/`is.false` mean what they say (2026-08-07).
      if (val === "true") return b.is(col, true);
      if (val === "false") return b.is(col, false);
      return b.is(col, null);
    case "gte":
      return b.gte(col, val);
    case "lte":
      return b.lte(col, val);
    case "eq":
    default:
      return b.eq(col, val);
  }
}

function sliceMsg(msg: string | undefined, n = 1000): string {
  return (msg ?? "").slice(0, n);
}
