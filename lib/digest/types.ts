// =====================================================================
// Daily Sync Digest — shared data contract
// =====================================================================
// The Digest page (app/(app)/page.tsx) replaces the old modular widget
// dashboard. It marries TWO views (decision: "both, stacked"):
//   1. Today's operations  — the latest business day's numbers
//   2. Sync health         — what the ingestion "employees" pulled in,
//                            sourced from audit_logs (provenance + diffs)
//
// HARD RULE (CLAUDE.md): every aggregation / running total / weighted
// average is computed in SQL (views), never in TypeScript. The query
// layer (lib/digest/queries.ts) only SHAPES rows into these types.
// =====================================================================

import type { KpiDayStatus, ScheduleRowState } from "./day-status";

// ---------- Meta / freshness ----------

export type Freshness = "fresh" | "recent" | "stale";
// fresh  = synced today
// recent = synced within ~3 days
// stale  = older / no recent sync

export interface StreamFreshness {
  /** machine key, e.g. "deliveries" | "rc_out" | "production" | "electricity" | "trucks" */
  stream: string;
  /** human label, e.g. "RC In (deliveries)" */
  label: string;
  /** latest business date present for this stream (yyyy-MM-dd) */
  throughDate: string | null;
  /** ok = current within tolerance, warn = lagging */
  status: "ok" | "warn";
}

export interface DigestMeta {
  /** latest business day that has ANY operational data (yyyy-MM-dd) */
  operationalDate: string | null;
  /** the business day immediately prior with data, for deltas */
  prevOperationalDate: string | null;
  /** max(audit_logs.performed_at) ISO timestamp, or null */
  lastSyncAt: string | null;
  freshness: Freshness;
  /** per-stream "current through" table */
  streams: StreamFreshness[];
}

// ---------- Hero KPI cards ----------

export interface DigestKpi {
  /** "rc_in" | "rc_out" | "production" | "power" | "net_flow" */
  key: string;
  label: string;
  /** value for the operational date */
  value: number;
  /** "kg" | "kWh" | "₱" | "" */
  unit: string;
  /** value for prevOperationalDate (null if none) */
  prevValue: number | null;
  /** percent change vs prev (null if no prev / divide-by-zero) */
  deltaPct: number | null;
  /** trailing 7-day average of this metric's daily value (null if no data).
   *  Presentational rollup of the windowed daily series — shown in-card. */
  avg7: number | null;
  /** trailing window for an inline sparkline (oldest → newest) */
  spark: SparkPoint[];
  /** optional secondary line, e.g. "5 suppliers · 648 sacks" */
  sub?: string;
}

export interface SparkPoint {
  date: string; // yyyy-MM-dd
  value: number;
}

// ---------- Charts ----------

/** Daily RC In vs RC Out (kg), trailing ~30 days. */
export interface FlowPoint {
  date: string; // yyyy-MM-dd
  in: number; // kg received
  out: number; // kg fed
}

/** Weighted-avg RC IN purchase price (₱/kg) per day, trailing window. */
export interface PricePoint {
  date: string; // yyyy-MM-dd
  phpPerKg: number;
}

/** Production output by grade per day (stacked-bar source), trailing window.
 *  `shift` segments a (date, grade) into separate rows — 'M' | 'E' | 'N'
 *  (morning / evening / night), null when the view doesn't attribute a shift. */
export interface GradePoint {
  date: string; // yyyy-MM-dd
  grade: string;
  kg: number;
  shift?: string;
}

/** Worked hours vs downtime hours per production day, trailing window (the same
 *  GRADE_DAYS window as `grades`, so an hours table can sit beside the
 *  Production-by-grade chart). Aggregated in SQL (view_digest_daily_hours):
 *  workHrs = SUM(shift_hrs), downtimeHrs = SUM(dt_hrs + dt_mins/60). Rest /
 *  no-production days simply have no row. Not price data. */
export interface DailyHoursPoint {
  date: string; // yyyy-MM-dd
  workHrs: number;
  downtimeHrs: number;
}

// ---------- Trucks band ----------

/** A truck that logged a trip (ttl_km > 0) on the operational date. */
export interface TruckTrip {
  plateNo: string;
  ttlKm: number;
  fuelLiters: number | null;
  remarks: string | null;
}

// ---------- Open blocks band ----------

/** An OPEN block — one actively IN-USE (being fed/consumed) — with its running
 *  balance and weighted-avg lab stats. All aggregation comes from
 *  view_blocking_grid; this is a row-level passthrough. `phpKg` is null when
 *  prices are gated (Production role) — nulled server-side, never hidden only
 *  on the client. `totalInKg` is the total ever delivered to the block, so the
 *  UI can show "volume left" as balanceKg / totalInKg. `batchId` drives the
 *  click-through: the band calls `fetchBlockDataForBatch(batchId)` and opens the
 *  shared Blocking detail slide-over. */
export interface OpenBlock {
  blockLoc: string;
  batchCode: string;
  batchId: string;         // batches.id — opens the Blocking detail slide-over
  status: string;          // 'IN-USE'
  balanceKg: number;
  totalInKg: number;       // total RC-IN ever delivered to this block (bar denominator)
  mc: number;
  ash: number;
  bdAstm: number;
  bdJis: number;
  grit: number;
  vm: number;
  fc: number;
  phpKg: number | null;    // null when prices are gated (Production role)
}

// ---------- FLECON bag inventory band ----------

/** One FLECON bag type's balance snapshot. Sourced from view_flecon_bag_balance;
 *  a row-level passthrough — all aggregation (opening/in/out/balance) lives in
 *  SQL, never summed in TypeScript. Nulls are COALESCEd to 0 in the query layer. */
export interface FleconBagBalance {
  bagTypeId: string;
  code: string;
  label: string;
  sortOrder: number;
  opening: number;
  totalIn: number;
  totalOut: number;
  balance: number;
  lastMovementDate: string | null;
}

// ---------- Sync band ----------

export interface SyncEmployeeStat {
  /** "gsheet-sync" | "deliveries-manager" | "rc-out-manager" | "production-manager" | "other" */
  employee: string;
  count: number;
}

export interface SyncRun {
  /** sync calendar day (yyyy-MM-dd of performed_at) */
  date: string;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  byEmployee: SyncEmployeeStat[];
}

export interface DiffEntry {
  field: string;
  old: unknown;
  new: unknown;
}

export interface ActivityItem {
  id: number;
  /** ISO timestamp (performed_at) */
  at: string;
  table: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  /** the human-readable audit comment */
  note: string;
  /** parsed employee name, "other" if unknown */
  employee: string;
  /** parsed provenance tag, e.g. "gsheet", or null */
  provenance: string | null;
  /** flattened diff entries (empty for plain inserts) */
  diff: DiffEntry[];
}

export interface Flag {
  kind: string; // e.g. "drift" | "conflict" | "stale_stream" | "missing_price"
  severity: "info" | "warn" | "critical";
  message: string;
  date?: string; // yyyy-MM-dd if date-scoped
}

// ---------- Month-to-date roll-up ----------

export interface MonthToDate {
  /** label of the cycle/month, e.g. "June 2026" */
  label: string;
  rcInKg: number;
  rcOutKg: number;
  productionKg: number;
  /** rcInKg - rcOutKg (continuous-flow drift is EXPECTED, informational) */
  netKg: number;
}

// ---------- Production plan (PROD SCHED) ----------

/** Plant status for the operational date, sourced from `production_schedule`.
 *  `running = shifts > 0`. Null when the operational date has no plan row
 *  (outside the ingested PROD SCHED window). Not price data — never gated. */
export interface PlantStatus {
  /** the operational date (yyyy-MM-dd) */
  date: string;
  /** planned shift count: 0 = rest/holiday, 1 = normal, 2 = double */
  shifts: number;
  /** planned line setup, e.g. "3X50 / 4X8"; null on a rest day */
  setup: string | null;
  /** planned TTL tons for the day; null when unknown */
  projectedTons: number | null;
  /** shifts > 0 — the plant was scheduled to run that day */
  running: boolean;
}

/** One day of the operational date's week (Mon→Sun), plan joined with ACTUAL
 *  production tons. `state` is resolved by `resolveScheduleRowState` in
 *  ./day-status. `actualTons` is null when no production run is on record yet. */
export interface WeekDayPlan {
  /** yyyy-MM-dd */
  date: string;
  /** weekday name, e.g. "Tuesday" */
  dow: string;
  shifts: number;
  setup: string | null;
  projectedTons: number | null;
  /** actual output in TONS for the day (SUM(production_runs.ttl_kg)/1000), or
   *  null when no production run is on record. Aggregated in SQL
   *  (view_digest_prod_actual_tons), never summed in TypeScript. */
  actualTons: number | null;
  /** actual hours WORKED for the day (view_digest_daily_hours.work_hrs, joined by
   *  date), or null when that date has no production/hours row. Not a TS sum. */
  actualHrs: number | null;
  /** the operational date */
  isToday: boolean;
  /** reported | awaiting | rest | planned | today (see ./day-status) */
  state: ScheduleRowState;
}

/** One row of the rolling schedule-preview table on the Home Digest: the
 *  operational date through the next 9 days (10 rows), plan (from
 *  `production_schedule`) joined with ACTUAL production tons. Distinct from
 *  `WeekDayPlan` (used by the week-strip cards) — this feeds a dense Excel-
 *  Standard table complementing the full page at `/production/schedule`.
 *  Not price data → never gated. */
export interface SchedulePreviewRow {
  /** yyyy-MM-dd */
  date: string;
  /** weekday name, e.g. "Tuesday" */
  dow: string;
  shifts: number;
  setup: string | null;
  projectedTons: number | null;
  /** actual output in TONS for the day (SUM(production_runs.ttl_kg)/1000), or
   *  null when no production run is on record. Aggregated in SQL
   *  (view_digest_prod_actual_tons), never summed in TypeScript. */
  actualTons: number | null;
  /** actual hours WORKED for the day (view_digest_daily_hours.work_hrs, joined by
   *  date), or null when that date has no production/hours row. Not a TS sum. */
  actualHrs: number | null;
  /** reported | awaiting | rest | planned | today (see ./day-status) */
  state: ScheduleRowState;
  /** raw DB `source` string, e.g. "joseph:REV2" | "gsheet:PROD SCHED". A
   *  `joseph:`-prefixed source is the authoritative plan. Null when absent. */
  source: string | null;
  /** per-grade projected tonnage for the day, straight from the
   *  production_schedule `grades` JSONB ({ "3X50": 21, "4X8": 5 }). null/empty
   *  on a rest day. `projectedTons` remains the day TOTAL. */
  grades: Record<string, number> | null;
}

// ---------- Top-level payload ----------

export interface DigestData {
  meta: DigestMeta;
  kpis: DigestKpi[];
  flow: FlowPoint[];
  price: PricePoint[];
  grades: GradePoint[];
  /** Worked vs downtime hours per production day — the last GRADE_DAYS rows of
   *  view_digest_daily_hours, ascending by date (same window as `grades`).
   *  Aggregated in SQL; the adapter only windows + shapes. Not price data. */
  productionHours: DailyHoursPoint[];
  latestSync: SyncRun | null;
  activity: ActivityItem[];
  flags: Flag[];
  monthToDate: MonthToDate;
  /** Trucks with a trip (ttl_km > 0) on the operational date, busiest first. */
  trucks: TruckTrip[];
  /** Currently in-use blocks (status = IN-USE) with balance + lab stats,
   *  block_loc ascending. phpKg is null when prices are gated (Production). */
  openBlocks: OpenBlock[];
  /** FLECON bag balance snapshot — one entry per bag type, sort_order ascending.
   *  No price data. Row-level passthrough from view_flecon_bag_balance. */
  fleconBags: FleconBagBalance[];
  /** Plant status for the operational date, from `production_schedule`
   *  (running / planned setup / projected tons). Null when the operational date
   *  has no plan row. Not price data. */
  plantStatus: PlantStatus | null;
  /** Per-KPI operational-day state, keyed by kpi key
   *  ("rc_in" | "rc_out" | "production" | "power" | "net_flow"). Resolves the
   *  "misleading zero": a plan-driven state (reported / awaiting / rest / stale /
   *  idle) so a bare 0 carries meaning. Computed by `resolveKpiDayStatus`
   *  (./day-status) against the operational date's plan + stream freshness. */
  dayStatus: Record<string, KpiDayStatus>;
  /** The 7 days of the operational date's week (Mon→Sun): plan (from
   *  `production_schedule`) joined with ACTUAL production tons (from
   *  view_digest_prod_actual_tons) + a resolved per-day state. Empty when there
   *  is no operational date. */
  weekPlan: WeekDayPlan[];
  /** Rolling schedule preview: the operational date through the next 9 days
   *  (10 rows). Plan (from `production_schedule`, incl. per-grade tonnage) joined
   *  with actual tons (view_digest_prod_actual_tons) + a resolved per-row state.
   *  Feeds the compact schedule-preview table band. Empty when there is no
   *  operational date. */
  schedulePreview: SchedulePreviewRow[];
  /** How many production-schedule days carry an unarbitrated upstream proposal
   *  the sync withheld because a human owns the day
   *  (COUNT over `view_production_schedule_conflicts`). Surfaced as a quiet
   *  indicator on the schedule band so a stale conflict cannot sit unread on the
   *  schedule route. 0 = render nothing. Not price data. */
  schedulePendingConflicts: number;
}
