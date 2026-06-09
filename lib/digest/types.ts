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

// ---------- Trucks band ----------

/** A truck that logged a trip (ttl_km > 0) on the operational date. */
export interface TruckTrip {
  plateNo: string;
  ttlKm: number;
  fuelLiters: number | null;
  remarks: string | null;
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
  operation: "INSERT" | "UPDATE" | "DELETE";
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

// ---------- Top-level payload ----------

export interface DigestData {
  meta: DigestMeta;
  kpis: DigestKpi[];
  flow: FlowPoint[];
  price: PricePoint[];
  grades: GradePoint[];
  latestSync: SyncRun | null;
  activity: ActivityItem[];
  flags: Flag[];
  monthToDate: MonthToDate;
  /** Trucks with a trip (ttl_km > 0) on the operational date, busiest first. */
  trucks: TruckTrip[];
}
