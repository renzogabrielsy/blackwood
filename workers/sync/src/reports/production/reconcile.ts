/**
 * reconcile.ts — port of reconcile_production.py. INFORMATIONAL ONLY, NEVER a write
 * gate. The RC IN -> RC OUT -> (production + waste) flow does NOT balance per day
 * (the feed tank is continuous-flow, balancing at month-end), so this reconciler
 * always reports `ok:true` and its severity NEVER halts the apply phase.
 *
 * Two "arithmetic" checks exist (runs day-total vs G13; waste internal mismatches)
 * that COULD gate under a `--strict` flag — but sync_production.py never passes
 * --strict, so in this pipeline's actual invocation they are purely informational
 * too. This port models that: `reconcile()` returns the full report; the caller in
 * index.ts consumes only `summary` and never gates on it.
 *
 * Ground truth: .claude/skills/sync-ictc/scripts/reconcile_production.py.
 */
import { roundHalfToEven } from "../../lib/norm.js";
import type { RunRow, McExtract } from "./extractMc.js";
import type { WasteRow, IvyExtract } from "./extractIvy.js";

const DAY_TOTAL_TOLERANCE_KG = 1.0;
const WASTE_STREAMS = ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg"] as const;

export interface WasteMismatch {
  date: string;
  shift: string;
  summed: number;
  reported: number | null;
}

export interface ReconcileReport {
  checks: Record<string, unknown>[];
  day_total_mismatches: Record<string, unknown>[];
  waste_mismatches: WasteMismatch[];
  rc_out_drift: Record<string, unknown>[];
  max_severity: "arithmetic_mismatch" | "info_gap" | "ok";
  hard_arithmetic_failure: boolean;
  strict: boolean;
  note: string;
  summary: {
    runs_day_total_mismatches: number;
    runs_arithmetic_failure: boolean;
    waste_mismatches: number;
    waste_arithmetic_failure: boolean;
    rc_out_drift_dates: number;
  };
}

const NOTE =
  "Daily kg-in vs kg-out drift is EXPECTED, not an error: the feed tank is " +
  "continuous-flow and only balances at month-end when emptied. The " +
  "production-vs-rc_out drift below is INFORMATIONAL and never gates writes. " +
  "Only the runs day-total and waste internal checks are hard arithmetic checks " +
  "(gateable with --strict).";

/** Recompute the waste extractor's internal recon_mismatches (mirrors the extractor). */
export function wasteReconMismatches(waste: WasteRow[]): WasteMismatch[] {
  const out: WasteMismatch[] = [];
  const RECON_TOLERANCE_KG = 1.0;
  for (const w of waste) {
    const reported = w.ttl_waste_kg_reported;
    const summed = w._summed_kg;
    if (reported === null || reported === undefined) {
      out.push({ date: w.transaction_date, shift: w.shift, summed, reported: null });
    } else if (Math.abs(summed - reported) > RECON_TOLERANCE_KG) {
      out.push({ date: w.transaction_date, shift: w.shift, summed, reported });
    }
  }
  return out;
}

/**
 * Informational reconcile. `rcOutSums` (per-date kg) is optional and only affects
 * the informational drift block — never severity/exit.
 */
export function reconcile(
  mc: McExtract,
  ivy: IvyExtract | null,
  rcOutSums: Record<string, number> | null,
): ReconcileReport {
  const runsByDate = new Map<string, number>();
  for (const r of mc.runs as RunRow[]) {
    const d = r.transaction_date;
    if (!d) continue;
    runsByDate.set(d, (runsByDate.get(d) ?? 0) + (r.ttl_kg || 0));
  }
  const dayTotals = mc.dayTotals ?? {};

  // CHECK 1 — runs day-total
  const dayTotalMismatches: Record<string, unknown>[] = [];
  const allDates = [...new Set([...runsByDate.keys(), ...Object.keys(dayTotals)])].sort();
  for (const d of allDates) {
    const runsSum = roundHalfToEven(runsByDate.get(d) ?? 0, 2);
    const sheetTotal = dayTotals[d];
    if (sheetTotal === null || sheetTotal === undefined) {
      dayTotalMismatches.push({
        date: d, runs_sum_kg: runsSum, sheet_day_total_kg: null, drift_kg: null,
        reason: "no summary.day_totals entry for this date",
      });
      continue;
    }
    const drift = roundHalfToEven(runsSum - sheetTotal, 2);
    if (Math.abs(drift) > DAY_TOTAL_TOLERANCE_KG) {
      dayTotalMismatches.push({
        date: d, runs_sum_kg: runsSum, sheet_day_total_kg: roundHalfToEven(sheetTotal, 2), drift_kg: drift,
        reason: `runs sum differs from sheet G13 total by ${drift >= 0 ? "+" : ""}${drift.toFixed(2)} kg`,
      });
    }
  }
  const runsArithFailed = dayTotalMismatches.some((m) => m.drift_kg !== null);

  // CHECK 2 — waste internal
  const wastePresent = ivy !== null;
  const wasteMismatches = wastePresent ? wasteReconMismatches(ivy!.waste) : [];
  const wasteArithFailed = wasteMismatches.some((m) => m.reported !== null);

  // CHECK 3 — production vs rc_out drift (INFORMATIONAL)
  const wasteByDate = new Map<string, number>();
  if (wastePresent) {
    for (const w of ivy!.waste) {
      const d = w.transaction_date;
      if (!d) continue;
      let s = 0;
      for (const k of WASTE_STREAMS) s += (w[k] as number) || 0;
      wasteByDate.set(d, (wasteByDate.get(d) ?? 0) + s);
    }
  }
  const rcOutDrift: Record<string, unknown>[] = [];
  if (rcOutSums && Object.keys(rcOutSums).length > 0) {
    const driftDates = [
      ...new Set([...runsByDate.keys(), ...wasteByDate.keys(), ...Object.keys(rcOutSums)]),
    ].sort();
    for (const d of driftDates) {
      const prodKg = roundHalfToEven(runsByDate.get(d) ?? 0, 2);
      const wasteKg = roundHalfToEven(wasteByDate.get(d) ?? 0, 2);
      const outRaw = rcOutSums[d];
      if (outRaw === null || outRaw === undefined) continue;
      const outKg = roundHalfToEven(outRaw, 2);
      const drift = roundHalfToEven(prodKg + wasteKg - outKg, 2);
      rcOutDrift.push({
        date: d, total_production_kg: prodKg, total_waste_kg: wasteKg, rc_out_total_kg: outKg,
        drift_kg: drift, label: "INFORMATIONAL — feed-tank-in-transit, never a failure",
      });
    }
  }

  const checks: Record<string, unknown>[] = [
    {
      check: "runs_day_total", kind: "arithmetic", gateable: true,
      dates_compared: allDates.length, mismatch_count: dayTotalMismatches.length,
      hard_arithmetic_failure: runsArithFailed, tolerance_kg: DAY_TOTAL_TOLERANCE_KG,
    },
    {
      check: "waste_internal", kind: "arithmetic", gateable: true,
      present: wastePresent, mismatch_count: wasteMismatches.length,
      hard_arithmetic_failure: wasteArithFailed, source: "waste extractor summary.recon_mismatches",
    },
    {
      check: "production_vs_rc_out", kind: "informational", gateable: false,
      present: !!(rcOutSums && Object.keys(rcOutSums).length > 0), dates_compared: rcOutDrift.length,
      note: "expected nonzero; monitors feed-tank fill, never gates",
    },
  ];

  const hardArithmeticFailure = runsArithFailed || wasteArithFailed;
  const maxSeverity: ReconcileReport["max_severity"] = hardArithmeticFailure
    ? "arithmetic_mismatch"
    : dayTotalMismatches.length > 0 || wasteMismatches.length > 0
      ? "info_gap"
      : "ok";

  return {
    checks,
    day_total_mismatches: dayTotalMismatches,
    waste_mismatches: wasteMismatches,
    rc_out_drift: rcOutDrift,
    max_severity: maxSeverity,
    hard_arithmetic_failure: hardArithmeticFailure,
    strict: false,
    note: NOTE,
    summary: {
      runs_day_total_mismatches: dayTotalMismatches.length,
      runs_arithmetic_failure: runsArithFailed,
      waste_mismatches: wasteMismatches.length,
      waste_arithmetic_failure: wasteArithFailed,
      rc_out_drift_dates: rcOutDrift.length,
    },
  };
}
