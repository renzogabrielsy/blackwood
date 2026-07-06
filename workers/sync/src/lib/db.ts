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
  is: (col: string, val: null) => AnyBuilder;
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
