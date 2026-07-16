/**
 * reconcile.ts — TS port of reconcile_rc_movement.py (read the Python as spec).
 *
 * Behavioral law: workers/sync/specs/rc_out.md §4. Feeds the TWO HARD GATES:
 *   GATE 1  proposed_vs_movement_drift_500kg  — run WITHOUT rc_out_sums (P vs M only).
 *   GATE 2  db_vs_movement_duplication        — run WITH rc_out_sums (activates O>M).
 * A run returning severity >= 2 (serious) HALTS the report: apply writes nothing.
 * Semantics are byte-identical to the Python: same per-date walk, same tolerance
 * (50kg) / serious (500kg) thresholds, same "O below M never trips" rule.
 *
 * NOTE: reconciliation is ORCHESTRATOR-level (apply-phase), NOT part of the classify
 * oracle (fixtures/rc_out manifest note). classifyCase never calls this; runReport does.
 */

export interface ProposedForReconcile {
  rows: Array<{
    transaction_date: string;
    weight_kg?: number | null;
    day_total_kg?: number | null;
    whse_label?: string | null;
    batch_code_primary?: string | null;
  }>;
}

export interface MovementForReconcile {
  date_to_fed_kls: Record<string, number>;
}

export type RcOutSums = Record<string, number>;

export type DriftSeverity = 0 | 1 | 2; // none | warning | serious

export interface ReconcileEntry {
  date: string;
  proposed_sum_kg: number | null;
  rc_movement_kg: number | null;
  rc_out_existing_kg: number | null;
  drift_p_vs_m_kg: number | null;
  drift_p_vs_o_kg: number | null;
  excess_o_vs_m_kg: number | null;
  notes: string[];
}

export interface ReconcileReport {
  summary: {
    total_dates: number;
    proposed_dates: number;
    db_dates_checked: number;
    ok_dates: number;
    drift_dates: number;
    max_severity: "none" | "warning" | "serious";
    tolerance_kg: number;
    serious_drift_kg: number;
  };
  drift_dates: ReconcileEntry[];
  ok_dates: ReconcileEntry[];
  /** The reconciler's own exit code = max_drift_severity. sync_rc_out.py checks `>= 2`. */
  severity: DriftSeverity;
}

const SEVERITY_WORD: Record<DriftSeverity, "none" | "warning" | "serious"> = {
  0: "none",
  1: "warning",
  2: "serious",
};

/**
 * Port of reconcile_rc_movement.py main() body.
 * @param sums  pass `null` for GATE 1 (P-vs-M only); pass the map for GATE 2 (O>M).
 */
export function reconcile(
  proposed: ProposedForReconcile,
  movement: MovementForReconcile,
  sums: RcOutSums | null,
  toleranceKg = 50.0,
  seriousDriftKg = 500.0,
): ReconcileReport {
  const rcOutSums: RcOutSums = sums ?? {};

  // Sum PROPOSED rows by transaction_date (reconcile_rc_movement.py:93-103).
  const proposedByDate = new Map<string, number>();
  for (const r of proposed.rows) {
    const d = r.transaction_date;
    const w = pyFloatOrZero(pyOr(r.weight_kg, r.day_total_kg));
    proposedByDate.set(d, (proposedByDate.get(d) ?? 0) + w);
  }

  const movementDateToFed = movement.date_to_fed_kls ?? {};

  const driftRows: ReconcileEntry[] = [];
  const okRows: ReconcileEntry[] = [];
  let maxSeverity: DriftSeverity = 0;
  const bump = (s: DriftSeverity) => {
    if (s > maxSeverity) maxSeverity = s;
  };

  // Walk every date in PROPOSED ∪ rc_out_sums, sorted (reconcile_rc_movement.py:116).
  const allDates = Array.from(
    new Set<string>([...proposedByDate.keys(), ...Object.keys(rcOutSums)]),
  ).sort();

  for (const d of allDates) {
    const P = proposedByDate.has(d) ? round2(proposedByDate.get(d) as number) : null;
    const M = has(movementDateToFed, d) ? movementDateToFed[d] : null;
    const O = has(rcOutSums, d) ? rcOutSums[d] : null;

    let pVsM: number | null = null;
    let pVsO: number | null = null;
    let oVsM: number | null = null;
    const notes: string[] = [];

    if (P !== null) {
      if (M === null) {
        notes.push("No RC MOVEMENT entry for this date");
      } else {
        pVsM = round2(P - M);
        if (Math.abs(pVsM) > seriousDriftKg) {
          notes.push(`SERIOUS drift PROPOSED vs RC MOVEMENT: ${signedInt(pVsM)} kg`);
          bump(2);
        } else if (Math.abs(pVsM) > toleranceKg) {
          notes.push(`Tolerable drift PROPOSED vs RC MOVEMENT: ${signedInt(pVsM)} kg`);
          bump(1);
        }
      }

      if (O !== null) {
        pVsO = round2(P - O);
        if (Math.abs(pVsO) > seriousDriftKg) {
          notes.push(`SERIOUS drift PROPOSED vs existing rc_out: ${signedInt(pVsO)} kg`);
          bump(2);
        } else if (Math.abs(pVsO) > toleranceKg) {
          notes.push(`Tolerable drift PROPOSED vs existing rc_out: ${signedInt(pVsO)} kg`);
          bump(1);
        }
      }
    }

    // DB-vs-RC-MOVEMENT duplication gate — every date the DB has rows for. Only an
    // O materially ABOVE M is a problem (reconcile_rc_movement.py:152-166).
    if (O !== null && M !== null) {
      oVsM = round2(O - M);
      if (oVsM > seriousDriftKg) {
        notes.push(
          `SERIOUS DB-side DUPLICATION: rc_out DB SUM exceeds RC MOVEMENT by ` +
            `${signedInt(oVsM)} kg (O=${fixed0(O)} > M=${fixed0(M)}). Likely duplicated ` +
            `feedings already in the DB — do NOT write; investigate this date.`,
        );
        bump(2);
      } else if (oVsM > toleranceKg) {
        notes.push(
          `DB rc_out SUM above RC MOVEMENT by ${signedInt(oVsM)} kg ` +
            `(possible partial duplication) — review.`,
        );
        bump(1);
      }
    }

    const entry: ReconcileEntry = {
      date: d,
      proposed_sum_kg: P,
      rc_movement_kg: M,
      rc_out_existing_kg: O,
      drift_p_vs_m_kg: pVsM,
      drift_p_vs_o_kg: pVsO,
      excess_o_vs_m_kg: oVsM,
      notes,
    };
    if (notes.length) driftRows.push(entry);
    else okRows.push(entry);
  }

  return {
    summary: {
      total_dates: allDates.length,
      proposed_dates: proposedByDate.size,
      db_dates_checked: Object.keys(rcOutSums).length,
      ok_dates: okRows.length,
      drift_dates: driftRows.length,
      max_severity: SEVERITY_WORD[maxSeverity],
      tolerance_kg: toleranceKg,
      serious_drift_kg: seriousDriftKg,
    },
    drift_dates: driftRows,
    ok_dates: okRows,
    severity: maxSeverity,
  };
}

/**
 * Compute rc_out daily sums from a snapshot of rc_out rows over the since window
 * (sync_rc_out.py:75-84 `_rc_out_sums`). Grouped by date[:10], summed, rounded 2dp.
 */
export function rcOutSumsFromRows(rows: Array<Record<string, unknown>>): RcOutSums {
  const sums: Record<string, number> = {};
  for (const r of rows) {
    const d = String(r.transaction_date ?? "").slice(0, 10);
    const wRaw = r.weight_kg;
    const w = pyFloatOrZero(wRaw);
    if (typeof wRaw !== "number" && typeof wRaw !== "string" && wRaw !== null && wRaw !== undefined) {
      // Python skips a value that float() can't parse; our pyFloatOrZero returns 0 —
      // but non-numeric weight never occurs in rc_out. Guard defensively: skip.
      continue;
    }
    sums[d] = (sums[d] ?? 0) + w;
  }
  const out: RcOutSums = {};
  for (const [k, v] of Object.entries(sums)) out[k] = round2(v);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function has(obj: Record<string, number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function pyOr(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined || a === 0 || a === "" || a === false) return b;
  return a;
}

/** Python `float(r.get("weight_kg") or 0)` — falsy → 0; else float(); NaN/None → 0. */
function pyFloatOrZero(v: unknown): number {
  if (v === null || v === undefined || v === "" || v === false || v === 0) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const f = Number(v.trim());
    return Number.isFinite(f) ? f : 0;
  }
  return 0;
}

/** Python round(x, 2). These sums are not at a true .5-boundary; half-up is safe. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Python f"{x:+.0f}" — signed, zero-decimal, round-half-to-even at 0dp. */
function signedInt(n: number): string {
  const r = roundHalfEven0(n);
  const sign = r >= 0 ? "+" : "-";
  return `${sign}${Math.abs(r)}`;
}

/** Python f"{x:.0f}" — unsigned zero-decimal. */
function fixed0(n: number): string {
  return String(roundHalfEven0(n));
}

/** round-half-to-even at 0 decimals, matching Python format spec rounding. */
function roundHalfEven0(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 → nearest even
  return floor % 2 === 0 ? floor : floor + 1;
}
