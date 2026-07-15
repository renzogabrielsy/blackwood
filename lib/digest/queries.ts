// =====================================================================
// Daily Sync Digest — server-only query layer
// =====================================================================
// Shapes rows from the view_digest_* SQL views (+ audit_logs) into the
// DigestData contract in ./types.ts.
//
// HARD RULE (CLAUDE.md): all aggregation / weighted averages / running
// totals are done in SQL (the view_digest_* views). This module performs
// ONLY light mapping and string parsing (employee/provenance), and a few
// trivial passthrough subtractions that the contract demands at the row
// level (net_flow = in - out, net = rcIn - rcOut) — no aggregation.
// =====================================================================

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { canViewPrices } from "@/lib/auth";
import type {
  DigestData,
  DigestKpi,
  SparkPoint,
  FlowPoint,
  PricePoint,
  GradePoint,
  SyncRun,
  SyncEmployeeStat,
  ActivityItem,
  DiffEntry,
  Flag,
  MonthToDate,
  StreamFreshness,
  Freshness,
  DigestMeta,
  TruckTrip,
  OpenBlock,
  OpenBlockDelivery,
  FleconBagBalance,
  PlantStatus,
  WeekDayPlan,
  SchedulePreviewRow,
} from "./types";
import {
  resolveKpiDayStatus,
  resolveScheduleRowState,
  type KpiDayStatus,
  type ProdSchedDay,
} from "./day-status";

// Trailing-window sizes (kept here, not in SQL, so the contract windows
// can be tuned without a migration).
//
// IMPORTANT (PostgREST 1000-row cap): the view_digest_daily_* views are
// WINDOWED in SQL to a trailing ~120 days (anchored to operational_date),
// so each returns ~120 rows — far under PostgREST's hard 1000-row response
// cap. That windowing is load-bearing: an UNwindowed daily view (full
// history is 2000+ rows) would be silently truncated to the FIRST 1000
// ascending rows, dropping the operational date off the end and flatlining
// every KPI. Any new daily series view MUST stay windowed (or LIMIT) too.
const SPARK_DAYS = 14;
const FLOW_DAYS = 30;
const PRICE_DAYS = 30;
const GRADE_DAYS = 14;
const AVG7_DAYS = 7;
const ACTIVITY_LIMIT = 40;
const STREAM_LAG_TOLERANCE_DAYS = 2;

// ---------- raw row shapes (match the SQL view columns) ----------

interface OperationalDaysRow {
  operational_date: string | null;
  prev_operational_date: string | null;
}
interface StreamFreshnessRow {
  stream: string;
  label: string;
  through_date: string | null;
}
interface DailyFlowRow {
  date: string;
  in_kg: number | string;
  out_kg: number | string;
}
interface DailyPriceRow {
  date: string;
  php_per_kg: number | string;
}
interface DailyKgRow {
  date: string;
  kg: number | string;
}
interface DailyPowerRow {
  date: string;
  kwh: number | string;
}
interface GradeRow {
  date: string;
  grade: string;
  kg: number | string;
  shift: string | null;
}
interface TruckReadingRow {
  plate_no: string;
  start_km: number | string | null;
  end_km: number | string | null;
  ttl_km: number | string | null;
  fuel_liters: number | string | null;
  remarks: string | null;
}
interface BlockingGridRow {
  batch_id: string;
  batch_code: string;
  block_loc: string;
  status: string;
  balance: number | string | null;
  total_in: number | string | null;
  avg_php_kg: number | string | null;
  avg_bd_astm: number | string | null;
  avg_bd_jis: number | string | null;
  avg_ash: number | string | null;
  avg_mc: number | string | null;
  avg_grit: number | string | null;
  avg_vm: number | string | null;
  avg_fc: number | string | null;
}
interface OpenBlockDeliveryRow {
  batch_code: string;
  transaction_date: string;
  supplier: string;
  cost_basis: number | string | null;
  lab_results: Record<string, number> | null;
}
interface FleconBagBalanceRow {
  bag_type_id: string | null;
  code: string | null;
  label: string | null;
  sort_order: number | string | null;
  opening: number | string | null;
  total_in: number | string | null;
  total_out: number | string | null;
  balance: number | string | null;
  last_movement_date: string | null;
}
interface MtdRow {
  label: string;
  month_start: string;
  month_end: string;
  rc_in_kg: number | string;
  rc_out_kg: number | string;
  production_kg: number | string;
}
interface LatestSyncRow {
  date: string;
  insert_count: number;
  update_count: number;
  delete_count: number;
}
interface LatestSyncByEmployeeRow {
  date: string;
  employee: string;
  count: number;
}
interface ProdSchedRow {
  plan_date: string;
  dow: string | null;
  shifts: number | string | null;
  setup: string | null;
  projected_tons: number | string | null;
  /** raw DB source string, e.g. "joseph:REV2" | "gsheet:PROD SCHED".
   *  Only selected for the schedule-preview fetch; undefined elsewhere. */
  source?: string | null;
}
interface ProdActualTonsRow {
  date: string;
  actual_tons: number | string | null;
}
interface AuditLogRow {
  id: string;
  table_name: string;
  operation: string;
  diff: Record<string, { old?: unknown; new?: unknown }> | null;
  comment: string | null;
  performed_at: string;
  employee: string;
  provenance: string | null;
}

// ---------- helpers (pure, no aggregation) ----------

const n = (v: number | string | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : Number(v);

const round = (v: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Trailing-window slice from a date-sorted ascending series. */
function tail<T>(rows: T[], days: number): T[] {
  return rows.length <= days ? rows : rows.slice(rows.length - days);
}

/** Mean of the last `days` already-aggregated daily values (the metric's
 *  most recent rows from the windowed series). Presentational rollup of
 *  daily rows — NOT a re-aggregation of raw data. Null if no rows. */
function avg7(values: number[]): number | null {
  if (values.length === 0) return null;
  const last = values.length <= AVG7_DAYS ? values : values.slice(values.length - AVG7_DAYS);
  const sum = last.reduce((a, b) => a + b, 0);
  return round(sum / last.length);
}

/** % change, null on no-prev or divide-by-zero. */
function deltaPct(value: number, prev: number | null): number | null {
  if (prev == null || prev === 0) return null;
  return round(((value - prev) / prev) * 100, 1);
}

/** Find the value for a specific date in a {date, value} map, else 0. */
function valueOn(map: Map<string, number>, date: string | null): number {
  if (!date) return 0;
  return map.get(date) ?? 0;
}

/** Days between two yyyy-MM-dd strings (a - b), UTC. */
function daysBetween(a: string, b: string): number {
  const ad = Date.parse(a + "T00:00:00Z");
  const bd = Date.parse(b + "T00:00:00Z");
  return Math.round((ad - bd) / 86_400_000);
}

/** UTC-safe yyyy-MM-dd + n days. */
function addDaysUtc(date: string, n: number): string {
  const ms = Date.parse(date + "T00:00:00Z") + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Weekday name for a yyyy-MM-dd date (UTC) — fallback when a plan row is absent. */
function dowNameFor(date: string): string {
  return DOW_NAMES[new Date(date + "T00:00:00Z").getUTCDay()] ?? "";
}

/** Shape a production_schedule row into the ProdSchedDay contract the pure
 *  day-status resolvers consume. */
function toProdSchedDay(r: ProdSchedRow): ProdSchedDay {
  const shifts = Math.trunc(n(r.shifts)) as 0 | 1 | 2;
  return {
    date: r.plan_date,
    dow: r.dow ?? dowNameFor(r.plan_date),
    shifts,
    setup: r.setup,
    projectedTons: n(r.projected_tons),
  };
}

// =====================================================================
// Main entry point
// =====================================================================

export async function getDigestData(): Promise<DigestData> {
  const supabase = await createClient();

  // Fetch everything in parallel. Views carry the aggregation.
  // canViewPrices() is the canonical price gate (respects the dev
  // impersonation cookie, fails closed); resolved concurrently here so
  // ₱ fields can be nulled SERVER-SIDE before the payload leaves.
  const [
    showPrices,
    opDaysRes,
    streamsRes,
    flowRes,
    priceRes,
    productionRes,
    powerRes,
    gradesRes,
    mtdRes,
    latestSyncRes,
    latestSyncByEmpRes,
    activityRes,
    flagAuditRes,
    zeroCostRes,
    blockingRes,
    fleconBagsRes,
  ] = await Promise.all([
    canViewPrices(),
    supabase.from("view_digest_operational_days").select("*").maybeSingle(),
    supabase.from("view_digest_stream_freshness").select("*"),
    supabase.from("view_digest_daily_flow").select("*").order("date", { ascending: true }),
    supabase.from("view_digest_daily_price").select("*").order("date", { ascending: true }),
    supabase.from("view_digest_daily_production").select("*").order("date", { ascending: true }),
    supabase.from("view_digest_daily_power").select("*").order("date", { ascending: true }),
    supabase.from("view_digest_grades").select("*").order("date", { ascending: true }),
    supabase.from("view_digest_mtd").select("*").maybeSingle(),
    supabase.from("view_digest_latest_sync").select("*").maybeSingle(),
    supabase.from("view_digest_latest_sync_by_employee").select("*"),
    supabase
      .from("view_digest_audit_enriched")
      .select("id, table_name, operation, diff, comment, performed_at, employee, provenance")
      .order("performed_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    // last-7-day audit comments containing flag-words (for the conflict flag)
    supabase
      .from("view_digest_audit_enriched")
      .select("id, comment, performed_at, performed_day")
      .or(
        "comment.ilike.%flag%,comment.ilike.%conflict%,comment.ilike.%held%,comment.ilike.%UNMAPPED%"
      )
      .order("performed_at", { ascending: false })
      .limit(20),
    // count of unpriced deliveries (cost_basis = 0) in the trailing 30 days
    supabase.from("view_digest_unpriced_recent").select("*").maybeSingle(),
    // OPEN blocks = the ones actively IN USE (being fed/consumed) — NOT STORED.
    // view_blocking_grid already does ALL aggregation and excludes CLOSED/empty
    // rows; filter to IN-USE only here. Current-state, not date-keyed, so it's
    // independent of operationalDate.
    supabase
      .from("view_blocking_grid")
      .select(
        "batch_id, batch_code, block_loc, status, balance, total_in, avg_php_kg, avg_bd_astm, avg_bd_jis, avg_ash, avg_mc, avg_grit, avg_vm, avg_fc"
      )
      .eq("status", "IN-USE")
      .order("block_loc", { ascending: true }),
    // FLECON bag balance snapshot — one row per bag type, sort_order ascending.
    // No aggregation here; the view carries it. No price data → no gating.
    supabase
      .from("view_flecon_bag_balance")
      .select("*")
      .order("sort_order", { ascending: true }),
  ]);

  const opDays = (opDaysRes.data as OperationalDaysRow | null) ?? {
    operational_date: null,
    prev_operational_date: null,
  };
  const operationalDate = opDays.operational_date;
  const prevOperationalDate = opDays.prev_operational_date;

  // ---------- raw series ----------
  const flowRows = (flowRes.data as DailyFlowRow[] | null) ?? [];
  const priceRows = (priceRes.data as DailyPriceRow[] | null) ?? [];
  const productionRows = (productionRes.data as DailyKgRow[] | null) ?? [];
  const powerRows = (powerRes.data as DailyPowerRow[] | null) ?? [];
  const gradeRows = (gradesRes.data as GradeRow[] | null) ?? [];

  // Lookup maps for KPI value/prevValue (point-in-time reads, not aggregation).
  const inByDate = new Map<string, number>();
  const outByDate = new Map<string, number>();
  const netByDate = new Map<string, number>();
  for (const r of flowRows) {
    const inKg = n(r.in_kg);
    const outKg = n(r.out_kg);
    inByDate.set(r.date, inKg);
    outByDate.set(r.date, outKg);
    netByDate.set(r.date, inKg - outKg);
  }
  const prodByDate = new Map<string, number>();
  for (const r of productionRows) prodByDate.set(r.date, n(r.kg));
  const powerByDate = new Map<string, number>();
  for (const r of powerRows) powerByDate.set(r.date, n(r.kwh));

  // ---------- sparks (trailing windows from the full series) ----------
  // The four operational sparks (in/out/prod/power) DROP zero-value days
  // BEFORE taking the trailing window — a 0 day plunges the area chart to the
  // floor and "ruins the graph". Filtering pre-tail keeps up to SPARK_DAYS
  // real (non-zero) points so the line connects only days with activity.
  // netSpark is intentionally NOT filtered: a 0 net day is meaningful.
  const inSpark: SparkPoint[] = tail(
    flowRows.filter((r) => n(r.in_kg) !== 0),
    SPARK_DAYS
  ).map((r) => ({
    date: r.date,
    value: round(n(r.in_kg)),
  }));
  const outSpark: SparkPoint[] = tail(
    flowRows.filter((r) => n(r.out_kg) !== 0),
    SPARK_DAYS
  ).map((r) => ({
    date: r.date,
    value: round(n(r.out_kg)),
  }));
  const netSpark: SparkPoint[] = tail(flowRows, SPARK_DAYS).map((r) => ({
    date: r.date,
    value: round(n(r.in_kg) - n(r.out_kg)),
  }));
  const prodSpark: SparkPoint[] = tail(
    productionRows.filter((r) => n(r.kg) !== 0),
    SPARK_DAYS
  ).map((r) => ({
    date: r.date,
    value: round(n(r.kg)),
  }));
  const powerSpark: SparkPoint[] = tail(
    powerRows.filter((r) => n(r.kwh) !== 0),
    SPARK_DAYS
  ).map((r) => ({
    date: r.date,
    value: round(n(r.kwh)),
  }));

  // ---------- KPIs ----------
  const rcInVal = valueOn(inByDate, operationalDate);
  const rcInPrev = prevOperationalDate ? valueOn(inByDate, prevOperationalDate) : null;
  const rcOutVal = valueOn(outByDate, operationalDate);
  const rcOutPrev = prevOperationalDate ? valueOn(outByDate, prevOperationalDate) : null;
  const prodVal = valueOn(prodByDate, operationalDate);
  const prodPrev = prevOperationalDate ? valueOn(prodByDate, prevOperationalDate) : null;
  const powerVal = valueOn(powerByDate, operationalDate);
  const powerPrev = prevOperationalDate ? valueOn(powerByDate, prevOperationalDate) : null;
  const netVal = valueOn(netByDate, operationalDate);
  const netPrev = prevOperationalDate ? valueOn(netByDate, prevOperationalDate) : null;

  // ---------- avg7 (trailing 7 daily values from the windowed series) ----------
  // Ascending daily-value arrays; avg7() takes the last 7. Presentational
  // mean of already-aggregated rows — no aggregation of raw data here.
  const rcInAvg7 = avg7(flowRows.map((r) => n(r.in_kg)));
  const rcOutAvg7 = avg7(flowRows.map((r) => n(r.out_kg)));
  const netAvg7 = avg7(flowRows.map((r) => n(r.in_kg) - n(r.out_kg)));
  const prodAvg7 = avg7(productionRows.map((r) => n(r.kg)));
  const powerAvg7 = avg7(powerRows.map((r) => n(r.kwh)));

  // RC In sub-line: supplier + sack counts for the operational day.
  let rcInSub: string | undefined;
  if (operationalDate) {
    const subRes = await supabase
      .from("view_digest_rcin_daystats")
      .select("*")
      .eq("date", operationalDate)
      .maybeSingle();
    const stats = subRes.data as { suppliers: number; sacks: number } | null;
    if (stats) {
      rcInSub = `${stats.suppliers} supplier${stats.suppliers === 1 ? "" : "s"} · ${stats.sacks} sacks`;
    }
  }

  // ---------- trucks with a trip on the operational date ----------
  // ttl_km is a GENERATED column (= end_km - start_km); > 0 means "had a trip".
  // Keyed on the SAME operationalDate as the KPIs so the band stays in sync.
  let trucks: TruckTrip[] = [];
  if (operationalDate) {
    const truckRes = await supabase
      .from("truck_readings")
      .select("plate_no, start_km, end_km, ttl_km, fuel_liters, remarks")
      .eq("reading_date", operationalDate)
      .gt("ttl_km", 0)
      .order("ttl_km", { ascending: false });
    const truckRows = (truckRes.data as TruckReadingRow[] | null) ?? [];
    trucks = truckRows.map((t) => ({
      plateNo: t.plate_no,
      ttlKm: round(n(t.ttl_km)),
      fuelLiters: t.fuel_liters == null ? null : round(n(t.fuel_liters)),
      remarks: t.remarks,
    }));
  }

  // ---------- open blocks (currently-occupied, STORED/IN-USE) ----------
  // Row-level passthrough of view_blocking_grid (all aggregation is the
  // view's job). phpKg is nulled SERVER-SIDE when prices are gated, so a
  // no-price (Production) user never receives ₱ data in the payload.
  const blockingRows = (blockingRes.data as BlockingGridRow[] | null) ?? [];

  // Per-delivery ledger rows for the open blocks — a DEPENDENT follow-up
  // query (needs the batch_codes resolved in the Promise.all above), run
  // sequentially like `trucks` / `rcInSub`. ONE query for ALL open blocks
  // via .in(batch_code, …) — never one-per-block. RAW passthrough of the
  // deliveries table, mirroring fetchBlockingDetail's lab_results extraction
  // (NO aggregation). Ordered transaction_date DESC so grouping stays
  // newest-first. ₱ (cost_basis) is nulled SERVER-SIDE when gated.
  const byBatch = new Map<string, OpenBlockDelivery[]>();
  const openBlockCodes = Array.from(new Set(blockingRows.map((r) => r.batch_code)));
  if (openBlockCodes.length > 0) {
    const deliveriesRes = await supabase
      .from("deliveries")
      .select("batch_code, transaction_date, supplier, cost_basis, lab_results")
      .in("batch_code", openBlockCodes)
      .order("transaction_date", { ascending: false });
    const deliveryRows = (deliveriesRes.data as OpenBlockDeliveryRow[] | null) ?? [];
    for (const d of deliveryRows) {
      const lab = (d.lab_results as Record<string, number> | null) ?? {};
      const row: OpenBlockDelivery = {
        date: d.transaction_date,
        supplier: d.supplier,
        mc: lab.mc !== undefined ? Number(lab.mc) : null,
        bdAstm: lab.bd_astm !== undefined ? Number(lab.bd_astm) : null,
        ash: lab.ash !== undefined ? Number(lab.ash) : null,
        price:
          showPrices && d.cost_basis !== null && d.cost_basis !== undefined
            ? round(Number(d.cost_basis), 2)
            : null,
      };
      const list = byBatch.get(d.batch_code);
      if (list) list.push(row);
      else byBatch.set(d.batch_code, [row]);
    }
  }

  const openBlocks: OpenBlock[] = blockingRows.map((r) => ({
    blockLoc: r.block_loc,
    batchCode: r.batch_code,
    status: r.status,
    balanceKg: round(n(r.balance)),
    totalInKg: round(n(r.total_in)),
    mc: round(n(r.avg_mc)),
    ash: round(n(r.avg_ash)),
    bdAstm: round(n(r.avg_bd_astm)),
    bdJis: round(n(r.avg_bd_jis)),
    grit: round(n(r.avg_grit)),
    vm: round(n(r.avg_vm)),
    fc: round(n(r.avg_fc)),
    phpKg: showPrices ? round(n(r.avg_php_kg)) : null,
    deliveries: byBatch.get(r.batch_code) ?? [],
  }));

  // FLECON bag balances — row-level passthrough (n() COALESCEs null → 0; the
  // SQL view owns every aggregate). No price data → no gating.
  const fleconBags: FleconBagBalance[] = (
    (fleconBagsRes.data as FleconBagBalanceRow[] | null) ?? []
  ).map((r) => ({
    bagTypeId: r.bag_type_id ?? "",
    code: r.code ?? "",
    label: r.label ?? r.code ?? "",
    sortOrder: n(r.sort_order),
    opening: n(r.opening),
    totalIn: n(r.total_in),
    totalOut: n(r.total_out),
    balance: n(r.balance),
    lastMovementDate: r.last_movement_date,
  }));

  const kpis: DigestKpi[] = [
    {
      key: "rc_in",
      label: "RC In",
      value: round(rcInVal),
      unit: "kg",
      prevValue: rcInPrev == null ? null : round(rcInPrev),
      deltaPct: deltaPct(rcInVal, rcInPrev),
      avg7: rcInAvg7,
      spark: inSpark,
      sub: rcInSub,
    },
    {
      key: "rc_out",
      label: "RC Out",
      value: round(rcOutVal),
      unit: "kg",
      prevValue: rcOutPrev == null ? null : round(rcOutPrev),
      deltaPct: deltaPct(rcOutVal, rcOutPrev),
      avg7: rcOutAvg7,
      spark: outSpark,
    },
    {
      key: "production",
      label: "Production",
      value: round(prodVal),
      unit: "kg",
      prevValue: prodPrev == null ? null : round(prodPrev),
      deltaPct: deltaPct(prodVal, prodPrev),
      avg7: prodAvg7,
      spark: prodSpark,
    },
    {
      key: "power",
      label: "Power",
      value: round(powerVal),
      unit: "kWh",
      prevValue: powerPrev == null ? null : round(powerPrev),
      deltaPct: deltaPct(powerVal, powerPrev),
      avg7: powerAvg7,
      spark: powerSpark,
    },
    {
      key: "net_flow",
      label: "Net Flow",
      value: round(netVal),
      unit: "kg",
      prevValue: netPrev == null ? null : round(netPrev),
      deltaPct: deltaPct(netVal, netPrev),
      avg7: netAvg7,
      spark: netSpark,
    },
  ];

  // ---------- charts ----------
  const flow: FlowPoint[] = tail(flowRows, FLOW_DAYS).map((r) => ({
    date: r.date,
    in: round(n(r.in_kg)),
    out: round(n(r.out_kg)),
  }));

  // ₱/kg is price data: gated by the canonical canViewPrices() resolved above.
  // When the role can't view prices, the series is EMPTY so the payload leaving
  // the server carries no ₱ values (the security boundary — not a UI-only hide).
  const price: PricePoint[] = showPrices
    ? tail(priceRows, PRICE_DAYS).map((r) => ({
        date: r.date,
        phpPerKg: round(n(r.php_per_kg)),
      }))
    : [];

  // grades trailing window: keep only the last GRADE_DAYS distinct dates.
  const gradeDates = Array.from(new Set(gradeRows.map((r) => r.date))).sort();
  const keepGradeDates = new Set(tail(gradeDates, GRADE_DAYS));
  const grades: GradePoint[] = gradeRows
    .filter((r) => keepGradeDates.has(r.date))
    .map((r) => ({
      date: r.date,
      grade: r.grade,
      kg: round(n(r.kg)),
      shift: r.shift ?? undefined,
    }));

  // ---------- latest sync ----------
  const latestSyncRow = latestSyncRes.data as LatestSyncRow | null;
  const byEmpRows = (latestSyncByEmpRes.data as LatestSyncByEmployeeRow[] | null) ?? [];
  let latestSync: SyncRun | null = null;
  if (latestSyncRow) {
    const byEmployee: SyncEmployeeStat[] = byEmpRows.map((r) => ({
      employee: r.employee,
      count: r.count,
    }));
    latestSync = {
      date: latestSyncRow.date,
      insertCount: latestSyncRow.insert_count,
      updateCount: latestSyncRow.update_count,
      deleteCount: latestSyncRow.delete_count,
      byEmployee,
    };
  }

  // ---------- activity ----------
  const auditRows = (activityRes.data as AuditLogRow[] | null) ?? [];
  const activity: ActivityItem[] = auditRows.map((a) => {
    const diff: DiffEntry[] = a.diff
      ? Object.entries(a.diff).map(([field, change]) => ({
          field,
          old: change?.old,
          new: change?.new,
        }))
      : [];
    return {
      id: hashId(a.id),
      at: a.performed_at,
      table: a.table_name,
      operation: a.operation as "INSERT" | "UPDATE" | "DELETE",
      note: a.comment ?? "",
      employee: a.employee,
      provenance: a.provenance,
      diff,
    };
  });

  // ---------- flags ----------
  const flags: Flag[] = [];

  // (a) stale stream: any stream lagging operationalDate by > tolerance.
  const streamRows = (streamsRes.data as StreamFreshnessRow[] | null) ?? [];
  if (operationalDate) {
    for (const s of streamRows) {
      if (!s.through_date) continue;
      const lag = daysBetween(operationalDate, s.through_date);
      if (lag > STREAM_LAG_TOLERANCE_DAYS) {
        flags.push({
          kind: "stale_stream",
          severity: "warn",
          message: `${s.label} is ${lag} days behind (through ${s.through_date}).`,
          date: s.through_date,
        });
      }
    }
  }

  // (b) deliveries awaiting price enrichment (cost_basis = 0) in last 30 days.
  const unpriced = (zeroCostRes.data as { cnt: number } | null) ?? { cnt: 0 };
  if (unpriced.cnt > 0) {
    flags.push({
      kind: "missing_price",
      severity: "info",
      message: `${unpriced.cnt} deliver${unpriced.cnt === 1 ? "y" : "ies"} awaiting price enrichment.`,
    });
  }

  // (c) audit comments in last 7 days flagging a conflict / hold / unmapped row.
  const flagAudit = (flagAuditRes.data as { comment: string | null; performed_day: string }[] | null) ?? [];
  if (operationalDate) {
    for (const f of flagAudit) {
      if (!f.comment) continue;
      if (daysBetween(operationalDate, f.performed_day) > 7) continue;
      flags.push({
        kind: "conflict",
        severity: "warn",
        message: f.comment.length > 160 ? f.comment.slice(0, 157) + "..." : f.comment,
        date: f.performed_day,
      });
    }
  }

  // ---------- month-to-date ----------
  const mtdRow = mtdRes.data as MtdRow | null;
  const monthToDate: MonthToDate = mtdRow
    ? {
        label: mtdRow.label,
        rcInKg: round(n(mtdRow.rc_in_kg)),
        rcOutKg: round(n(mtdRow.rc_out_kg)),
        productionKg: round(n(mtdRow.production_kg)),
        netKg: round(n(mtdRow.rc_in_kg) - n(mtdRow.rc_out_kg)),
      }
    : { label: "", rcInKg: 0, rcOutKg: 0, productionKg: 0, netKg: 0 };

  // ---------- meta ----------
  const streams: StreamFreshness[] = streamRows.map((s) => ({
    stream: s.stream,
    label: s.label,
    throughDate: s.through_date,
    status:
      operationalDate && s.through_date && daysBetween(operationalDate, s.through_date) > STREAM_LAG_TOLERANCE_DAYS
        ? "warn"
        : "ok",
  }));

  // ---------- production plan: plant status, per-KPI day state, week plan ----------
  // Sourced from `production_schedule` (the ingested PROD SCHED plan) joined with
  // ACTUAL production tons from view_digest_prod_actual_tons (SUM in SQL, never a
  // TS reduction). The state RESOLUTION is light branching in the pure
  // ./day-status resolvers (allowed in TS); the tons SUM stays in the view.
  // Not price data → no gating. Dependent on operationalDate, so fetched here
  // (same follow-up pattern as trucks / rcInSub).
  let plantStatus: PlantStatus | null = null;
  const dayStatus: Record<string, KpiDayStatus> = {};
  let weekPlan: WeekDayPlan[] = [];
  let schedulePreview: SchedulePreviewRow[] = [];
  if (operationalDate) {
    // The operational date's week = 7 consecutive days STARTING at the
    // operational date (today is the first, isToday). This matches the draft's
    // WeekStrip and sidesteps the sheet's off-by-one weekday labels (its `dow`
    // text runs one day ahead of the real calendar) — the plan is keyed by DATE,
    // not weekday, so rest/shift detection is unaffected.
    const weekStart = operationalDate;
    const weekDates = Array.from({ length: 7 }, (_, i) => addDaysUtc(weekStart, i));
    const weekEnd = weekDates[6];

    // Schedule-preview window: 14 days STARTING at the operational date (today
    // first). A SUPERSET of the week window above, but fetched separately so it
    // can also pull `source` (the plan-authority tag). Same two sources as
    // weekPlan / the /production/schedule page.
    const previewDates = Array.from({ length: 14 }, (_, i) => addDaysUtc(weekStart, i));
    const previewEnd = previewDates[13];

    const [schedRes, actualRes, previewSchedRes, previewActualRes] = await Promise.all([
      supabase
        .from("production_schedule")
        .select("plan_date, dow, shifts, setup, projected_tons")
        .gte("plan_date", weekStart)
        .lte("plan_date", weekEnd),
      supabase
        .from("view_digest_prod_actual_tons")
        .select("date, actual_tons")
        .gte("date", weekStart)
        .lte("date", weekEnd),
      supabase
        .from("production_schedule")
        .select("plan_date, dow, shifts, setup, projected_tons, source")
        .gte("plan_date", weekStart)
        .lte("plan_date", previewEnd),
      supabase
        .from("view_digest_prod_actual_tons")
        .select("date, actual_tons")
        .gte("date", weekStart)
        .lte("date", previewEnd),
    ]);

    const planRows = (schedRes.data as ProdSchedRow[] | null) ?? [];
    const planByDate = new Map(planRows.map((p) => [p.plan_date, p]));
    const actualByDate = new Map(
      ((actualRes.data as ProdActualTonsRow[] | null) ?? []).map((a) => [a.date, n(a.actual_tons)])
    );

    // Operational-date plan (always within its own Mon→Sun week).
    const opPlanRow = planByDate.get(operationalDate);
    const opPlan: ProdSchedDay | undefined = opPlanRow ? toProdSchedDay(opPlanRow) : undefined;

    if (opPlanRow) {
      plantStatus = {
        date: operationalDate,
        shifts: Math.trunc(n(opPlanRow.shifts)),
        setup: opPlanRow.setup,
        projectedTons: opPlanRow.projected_tons == null ? null : n(opPlanRow.projected_tons),
        running: Math.trunc(n(opPlanRow.shifts)) > 0,
      };
    }

    // Per-KPI day state (the "misleading zero" fix) against the op-date plan.
    for (const kpi of kpis) {
      dayStatus[kpi.key] = resolveKpiDayStatus({
        kpiKey: kpi.key,
        value: kpi.value,
        operationalDate,
        plan: opPlan,
        streams,
      });
    }

    // The operational date's week (Mon→Sun): plan joined with actual tons.
    weekPlan = weekDates.map((date) => {
      const row = planByDate.get(date);
      const plan: ProdSchedDay = row
        ? toProdSchedDay(row)
        : { date, dow: dowNameFor(date), shifts: 0, setup: null, projectedTons: 0 };
      const actualTons = actualByDate.has(date) ? round(actualByDate.get(date)!, 2) : null;
      return {
        date,
        dow: plan.dow,
        shifts: plan.shifts,
        setup: plan.setup,
        projectedTons: row ? (row.projected_tons == null ? null : n(row.projected_tons)) : null,
        actualTons,
        isToday: date === operationalDate,
        state: resolveScheduleRowState(plan, actualTons, operationalDate),
      };
    });

    // Rolling ~2-week schedule preview (op date → +13 days = 14 rows). Same
    // plan-vs-actual join + resolved state as weekPlan, plus the `source` tag.
    const previewPlanByDate = new Map(
      ((previewSchedRes.data as ProdSchedRow[] | null) ?? []).map((p) => [p.plan_date, p])
    );
    const previewActualByDate = new Map(
      ((previewActualRes.data as ProdActualTonsRow[] | null) ?? []).map((a) => [
        a.date,
        n(a.actual_tons),
      ])
    );
    schedulePreview = previewDates.map((date) => {
      const row = previewPlanByDate.get(date);
      const plan: ProdSchedDay = row
        ? toProdSchedDay(row)
        : { date, dow: dowNameFor(date), shifts: 0, setup: null, projectedTons: 0 };
      const actualTons = previewActualByDate.has(date)
        ? round(previewActualByDate.get(date)!, 2)
        : null;
      return {
        date,
        dow: plan.dow,
        shifts: plan.shifts,
        setup: plan.setup,
        projectedTons: row ? (row.projected_tons == null ? null : n(row.projected_tons)) : null,
        actualTons,
        state: resolveScheduleRowState(plan, actualTons, operationalDate),
        source: row?.source ?? null,
      };
    });
  }

  const lastSyncAt = latestSyncRow ? auditRows[0]?.performed_at ?? null : null;
  const meta: DigestMeta = {
    operationalDate,
    prevOperationalDate,
    lastSyncAt: auditRows[0]?.performed_at ?? null,
    freshness: computeFreshness(auditRows[0]?.performed_at ?? lastSyncAt),
    streams,
  };

  return {
    meta,
    kpis,
    flow,
    price,
    grades,
    latestSync,
    activity,
    flags,
    monthToDate,
    trucks,
    openBlocks,
    fleconBags,
    plantStatus,
    dayStatus,
    weekPlan,
    schedulePreview,
  };
}

// ---------- small pure helpers ----------

/** ActivityItem.id is a number in the contract; audit ids are uuids.
 *  Derive a stable positive 32-bit int from the uuid for keying. */
function hashId(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) {
    h = (h * 31 + uuid.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function computeFreshness(lastSyncAt: string | null): Freshness {
  if (!lastSyncAt) return "stale";
  const ageDays = (Date.now() - Date.parse(lastSyncAt)) / 86_400_000;
  if (ageDays <= 1) return "fresh";
  if (ageDays <= 3) return "recent";
  return "stale";
}
