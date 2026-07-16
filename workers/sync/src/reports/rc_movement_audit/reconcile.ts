/**
 * reconcile.ts — local TS port of reconcile_rc_movement.py (read the Python as spec).
 *
 * SCOPE FENCE: rc_out/reconcile.ts ports the same reconciler for its own two hard gates,
 * but this port owns ONLY src/reports/rc_movement_audit/** and may NOT import from rc_out/.
 * This is an independent, byte-faithful local copy.
 *
 * Behavioral law: workers/sync/specs/rc_movement_audit.md §3. For each date in
 * PROPOSED ∪ rc_out_sums (a movement-only date is INVISIBLE to this walk):
 *   P = round(sum of proposed weight for that date, 2)  (None if the date has no PROPOSED)
 *   M = movement.date_to_fed_kls[d]                       (None if the movement lacks it)
 *   O = rc_out_sums[d]                                    (None if the DB lacks it)
 * Drift checks (all thresholds strict `>`, tolerance 50 / serious 500):
 *   p_vs_m_drift  = round(P - M, 2)   (only if P and M present)
 *   p_vs_o_drift  = round(P - O, 2)   (only if P and O present)
 *   o_vs_m_excess = round(O - M, 2)   (only if O and M present) — the L-019 DUPLICATION
 *                   gate; ONLY a POSITIVE excess (O materially ABOVE M) trips anything;
 *                   O below M is silent (continuous-flow tank lag is normal).
 * The reconciler's exit code = the numeric severity (0/1/2); this port returns it as
 * `severity` so the auditor can propagate the integer (rc_movement_audit.md §8 trap #3).
 *
 * The note strings are compared VERBATIM by the parity harness, including the em-dash
 * (U+2014) in the two duplication notes — reproduced exactly.
 */

/** Synthetic PROPOSED input — audit_rc_movement.py:104 builds `{transaction_date, weight_kg}`. */
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

/** One `blocks` element — proposed_blocks_by_date entry (reconcile_rc_movement.py:99-103). */
export interface ReconcileBlock {
  whse: string | null;
  batch_code: string | null;
  weight_kg: number;
}

/** One per-date reconcile entry — reconcile_rc_movement.py:168-178. */
export interface ReconcileEntry {
  date: string;
  proposed_sum_kg: number | null;
  rc_movement_kg: number | null;
  rc_out_existing_kg: number | null;
  drift_p_vs_m_kg: number | null;
  drift_p_vs_o_kg: number | null;
  excess_o_vs_m_kg: number | null;
  blocks: ReconcileBlock[];
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
  /** The reconciler's own exit code = max_drift_severity (0/1/2). */
  severity: DriftSeverity;
}

const SEVERITY_WORD: Record<DriftSeverity, "none" | "warning" | "serious"> = {
  0: "none",
  1: "warning",
  2: "serious",
};

/**
 * Port of reconcile_rc_movement.py main() body. For the auditor, `sums` is passed as the
 * SAME map that seeds `proposed` (audit_rc_movement.py:104-106 double-feed trick), so
 * P == O for every date and p_vs_m == o_vs_m by construction.
 */
export function reconcile(
  proposed: ProposedForReconcile,
  movement: MovementForReconcile,
  sums: RcOutSums | null,
  toleranceKg = 50.0,
  seriousDriftKg = 500.0,
): ReconcileReport {
  const rcOutSums: RcOutSums = sums ?? {};

  // Sum PROPOSED rows by transaction_date; capture the per-date block echo
  // (reconcile_rc_movement.py:93-103).
  const proposedByDate = new Map<string, number>();
  const proposedBlocksByDate = new Map<string, ReconcileBlock[]>();
  for (const r of proposed.rows) {
    const d = r.transaction_date;
    const w = pyFloatOrZero(pyOr(r.weight_kg, r.day_total_kg));
    proposedByDate.set(d, (proposedByDate.get(d) ?? 0) + w);
    const blocks = proposedBlocksByDate.get(d) ?? [];
    blocks.push({
      whse: r.whse_label ?? null,
      batch_code: r.batch_code_primary ?? null,
      weight_kg: w,
    });
    proposedBlocksByDate.set(d, blocks);
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

    // DB-vs-RC-MOVEMENT duplication gate — every date the DB has rows for, PROPOSED or
    // not. Only an O materially ABOVE M is a problem; O below M is silent by design
    // (reconcile_rc_movement.py:152-166). Note the em-dash (U+2014) is verbatim.
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
      blocks: proposedBlocksByDate.get(d) ?? [],
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function has(obj: Record<string, number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python `a or b` truthiness for the weight fallback (reconcile_rc_movement.py:97). */
function pyOr(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined || a === 0 || a === "" || a === false) return b;
  return a;
}

/** Python `float(r.get("weight_kg") or r.get("day_total_kg") or 0)` — falsy → 0; else float(). */
function pyFloatOrZero(v: unknown): number {
  if (v === null || v === undefined || v === "" || v === false || v === 0) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const f = Number(v.trim());
    return Number.isFinite(f) ? f : 0;
  }
  return 0;
}

/** Python round(x, 2). These sums are plain kg, never at a true .5-boundary; half-up is safe. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Python f"{x:+.0f}" — signed, zero-decimal, round-half-to-even at 0dp. */
function signedInt(n: number): string {
  const r = roundHalfEven0(n);
  const sign = r >= 0 ? "+" : "-";
  return `${sign}${Math.abs(r)}`;
}

/** Python f"{x:.0f}" — unsigned zero-decimal, round-half-to-even at 0dp. */
function fixed0(n: number): string {
  return String(roundHalfEven0(n));
}

/** round-half-to-even at 0 decimals, matching Python format-spec rounding. */
function roundHalfEven0(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1; // exactly .5 → nearest even
}
