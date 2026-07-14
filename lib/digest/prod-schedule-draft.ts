// =====================================================================
// PROD SCHED — DRAFT plan constant (NOT a live data source yet)
// =====================================================================
// ⚠️ DRAFT / STAND-IN. The charcoal plant's daily production PLAN lives in
// the sheet's "PROD SCHED" tab. That tab is NOT ingested into the DB yet —
// there is no extractor and no `view_digest_*` view for it. This module is a
// typed, hand-transcribed snapshot of the July 2026 plan so the Dashboard
// Draft (`app/(app)/dashboard-draft/`) can demonstrate day-status states and
// the Production Schedule band against REAL plan figures.
//
// When a real PROD SCHED extractor + view land, this file should be deleted
// and the plan read from `getDigestData()` like every other slice (same
// port/adapter discipline as the rest of the digest — see CLAUDE.md).
//
// Values are TONS. Sundays are planned rest days (0 shifts, 0 t).
// Pure module — no server imports, safe on both client and server.
// =====================================================================

/** Planned shift count for a day. 0 = planned rest (Sunday / holiday). */
export type PlannedShifts = 0 | 1 | 2;

/** One day of the PROD SCHED plan. `projectedTons` is the planned output. */
export interface ProdSchedDay {
  /** yyyy-MM-dd */
  date: string;
  /** short weekday, e.g. "Mon" */
  dow: string;
  shifts: PlannedShifts;
  /** line setup label, e.g. "3X50 / 4X8"; null on a rest day */
  setup: string | null;
  /** planned output in TONS */
  projectedTons: number;
  /** free-text planning note from the sheet, when present */
  remarks?: string;
}

/** A grade produced under a setup, with its planned tons/day contribution. */
export interface SetupGrade {
  grade: string;
  tonsPerDay: number;
}

/** An open order commitment (from the sheet's ORDERS tab). */
export interface OrderCommitment {
  /** customer code, e.g. "KC" | "MH" | "FG" */
  customer: string;
  /** volume summary, e.g. "5 vans · 103.8 t" */
  volume: string;
  /** setup the order runs under */
  setup: string;
  /** estimated dispatch window, e.g. "AUG" | "MID AUG" */
  etd: string;
  /** planning note */
  note: string;
}

// ---------------------------------------------------------------------
// July 2026 plan (transcribed from the PROD SCHED tab)
// ---------------------------------------------------------------------

export const PROD_SCHED_JULY_2026: ProdSchedDay[] = [
  { date: "2026-07-01", dow: "Wed", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "12HR shift + LOADING" },
  { date: "2026-07-02", dow: "Thu", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "12HR shift + LOADING" },
  { date: "2026-07-03", dow: "Fri", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "12HR + LOADING (4X8 2ND VAN JULY DONE)" },
  { date: "2026-07-04", dow: "Sat", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "12HR + LOADING + BLENDING" },
  { date: "2026-07-05", dow: "Sun", shifts: 0, setup: null, projectedTons: 0 },
  { date: "2026-07-06", dow: "Mon", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "12HR + LOADING - BLENDING" },
  { date: "2026-07-07", dow: "Tue", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26 },
  { date: "2026-07-08", dow: "Wed", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26 },
  { date: "2026-07-09", dow: "Thu", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "4X8 1ST VAN AUG DONE" },
  { date: "2026-07-10", dow: "Fri", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26 },
  { date: "2026-07-11", dow: "Sat", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26 },
  { date: "2026-07-12", dow: "Sun", shifts: 0, setup: null, projectedTons: 0 },
  { date: "2026-07-13", dow: "Mon", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26 },
  { date: "2026-07-14", dow: "Tue", shifts: 1, setup: "3X50 / 4X8", projectedTons: 26, remarks: "4X8 2ND VAN AUG DONE" },
  { date: "2026-07-15", dow: "Wed", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "3X50 KC 5 VAN AUG START" },
  { date: "2026-07-16", dow: "Thu", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-17", dow: "Fri", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-18", dow: "Sat", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-19", dow: "Sun", shifts: 0, setup: null, projectedTons: 0 },
  { date: "2026-07-20", dow: "Mon", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-21", dow: "Tue", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "3X50 KC 5 VAN AUG END ~150t" },
  { date: "2026-07-22", dow: "Wed", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "3X50 KC 5 VAN SEPT START" },
  { date: "2026-07-23", dow: "Thu", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-24", dow: "Fri", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-25", dow: "Sat", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-26", dow: "Sun", shifts: 0, setup: null, projectedTons: 0 },
  { date: "2026-07-27", dow: "Mon", shifts: 1, setup: "SOLID 3X50", projectedTons: 25 },
  { date: "2026-07-28", dow: "Tue", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "3X50 KC 5 VAN SEPT END ~150t" },
  { date: "2026-07-29", dow: "Wed", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "1 shift + LOADING" },
  { date: "2026-07-30", dow: "Thu", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "1 shift + LOADING" },
  { date: "2026-07-31", dow: "Fri", shifts: 1, setup: "SOLID 3X50", projectedTons: 25, remarks: "1 shift + LOADING PAHUBAS" },
];

/** The full DRAFT plan. Only July 2026 is transcribed today. */
export const PROD_SCHED_PLAN: ProdSchedDay[] = [...PROD_SCHED_JULY_2026];

/** Setup → grade breakdown (tons/day per grade). From the PROD SCHED legend. */
export const SETUP_REFERENCE: Record<string, SetupGrade[]> = {
  "SOLID 3X50": [{ grade: "3X50", tonsPerDay: 25 }],
  "3X50 / 6X50": [
    { grade: "3X50", tonsPerDay: 20 },
    { grade: "6X50", tonsPerDay: 6 },
  ],
  "3X50 / 8X50": [
    { grade: "3X50", tonsPerDay: 20 },
    { grade: "8X50", tonsPerDay: 6 },
  ],
  "3X50 / 4X8": [
    { grade: "3X50", tonsPerDay: 21 },
    { grade: "4X8", tonsPerDay: 5 },
  ],
  "3X50 / 2X6": [
    { grade: "3X50", tonsPerDay: 10 },
    { grade: "2X6", tonsPerDay: 15 },
  ],
};

/** Open order commitments (from the ORDERS tab). */
export const ORDER_COMMITMENTS: OrderCommitment[] = [
  { customer: "KC", volume: "5 vans · 103.8 t", setup: "3X50", etd: "AUG", note: "blend test first" },
  { customer: "KC", volume: "5 vans · 103.8 t", setup: "3X50", etd: "SEPT", note: "blend test first" },
  { customer: "MH", volume: "2 vans · 50.6 t", setup: "4X8", etd: "MID AUG", note: "12 hr + blend" },
  { customer: "MH", volume: "2 vans · 48.4 t", setup: "4X8", etd: "LATE AUG", note: "started 14 Jul" },
  { customer: "FG", volume: "4 vans · 96.8 t", setup: "6X50", etd: "NOV", note: "not plotted yet" },
];

// ---------------------------------------------------------------------
// Pure lookup helpers
// ---------------------------------------------------------------------

const PLAN_BY_DATE: Map<string, ProdSchedDay> = new Map(
  PROD_SCHED_PLAN.map((d) => [d.date, d])
);

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** UTC-safe yyyy-MM-dd + n days. */
function addDaysUtc(date: string, n: number): string {
  const ms = Date.parse(date + "T00:00:00Z") + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Short weekday label for a yyyy-MM-dd date (UTC). */
function dowFor(date: string): string {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return DOW_LABELS[day] ?? "";
}

/** Plan for one date, or `undefined` when the date is outside the draft. */
export function getPlanForDate(date: string): ProdSchedDay | undefined {
  return PLAN_BY_DATE.get(date);
}

/**
 * 7 consecutive days starting at `fromDate`. Dates outside the transcribed
 * plan are synthesized as a minimal placeholder (Sunday ⇒ rest, else a
 * 1-shift working day with no projection) so the week strip never has holes.
 */
export function getWeekPlan(fromDate: string): ProdSchedDay[] {
  const out: ProdSchedDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysUtc(fromDate, i);
    const known = PLAN_BY_DATE.get(date);
    if (known) {
      out.push(known);
      continue;
    }
    const dow = dowFor(date);
    const isSunday = dow === "Sun";
    out.push({
      date,
      dow,
      shifts: isSunday ? 0 : 1,
      setup: isSunday ? null : null,
      projectedTons: 0,
    });
  }
  return out;
}

/** All plan days for a calendar month (`month` = 1–12), date-ascending. */
export function getMonthPlan(year: number, month: number): ProdSchedDay[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  return PROD_SCHED_PLAN.filter((d) => d.date.startsWith(prefix)).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}
