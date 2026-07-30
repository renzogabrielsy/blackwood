/**
 * setup-projection.ts — the ONE implementation of the production-plan projection.
 *
 * Given a SETUP (a per-shift grade mix, from `public.production_setups.grade_mix`) and a
 * SHIFT COUNT, produce the day's `grades` and `projected_tons`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE RULES (verified against every row of `production_schedule`, 2026-07-30)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. A setup IS a per-shift grade mix.   "3X50 / 6X50" = 20 t of 3X50 + 6 t of 6X50.
 *   2. It scales LINEARLY with `shifts`.   SOLID 3X50 = 25 t at 1 shift, 50 t at 2.
 *   3. `projected_tons` = the SUM of the grade values.  20+6=26, 21+5=26, 10+15=25.
 *
 * Rule 3 is not merely checked here — it is enforced BY CONSTRUCTION: `projectedTons` is
 * computed as the sum of the already-rounded grade values, so the two outputs can never
 * disagree with each other no matter what the inputs are.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS IN TYPESCRIPT AND NOT IN SQL
 * ─────────────────────────────────────────────────────────────────────────────
 * CLAUDE.md: "Never calculate weighted averages or inventory balances in TypeScript —
 * trust the DB." That rule is about DERIVED STATE OVER MANY ROWS — balances, running
 * totals, weighted averages — where the DB holds the authoritative facts and a parallel TS
 * implementation would silently drift from the SQL one. This is none of those things, and
 * the distinction is worth stating precisely rather than waving at:
 *
 *   • It is a FORM DEFAULT, not a derivation of stored truth. It reads ONE reference row
 *     (a 5-row lookup table already in memory) and ONE number the operator is typing, and
 *     proposes values BEFORE any write. Nothing is being computed *about* the data.
 *
 *   • The result is STORED, and must stay stored. `projected_tons` and `grades` are plain
 *     columns the sync has written from Renzo's PROD SCHED tab since long before this
 *     feature. If they were derived in a view instead, editing the setup library tomorrow
 *     would retroactively rewrite what was planned last February. A plan is a record of
 *     intent at a point in time; it must not move under you.
 *
 *   • PER-DAY OVERRIDES ARE NORMAL, and a derivation cannot express them. History: SOLID
 *     3X50 ran 25 t on 127 days and 30 t on 2; 3X50 / 4X8 ran 26 t on 16 days and 24 t on
 *     2. Those are facts about days, not about setups. The projection fills the fields;
 *     the operator then edits them freely, and the edit is what lands in the DB.
 *
 * And on the "exactly ONE implementation" constraint: the editor needs a live preview as
 * the operator types the shift count, so a client-side implementation is MANDATORY — a
 * round-trip per keystroke is not a design option. The only real question was whether a
 * SECOND, SQL implementation should also exist, and the answer is no: it would be the very
 * duplication the constraint forbids, and nothing would call it. `fn_save_schedule_day`
 * stores the patch it is handed (that is exactly what makes overrides possible), and no
 * view derives `projected_tons`. So SQL gains nothing and risks drift. This module is the
 * whole implementation, and `scripts/verify-setup-projection.ts` pins it against the live
 * seeded library and the historical rows it must reproduce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROUNDING
 * ─────────────────────────────────────────────────────────────────────────────
 * Each scaled grade is rounded to a WHOLE TON (half away from zero), and the total is the
 * sum of those rounded values. Whole tons because every tonnage in the source data — every
 * `projected_tons`, every value inside every `grades` object — is a whole number; the plan
 * is plotted in tons, not kilos. Rounding the PARTS and summing (rather than rounding the
 * total separately) is what keeps rule 3 exact: round-then-sum can never produce a total
 * that disagrees with its own components.
 *
 * On today's data the rounding is a NO-OP on every row — the mixes are whole numbers and
 * `shifts` is an integer, so nothing is ever fractional. It exists only so a future
 * fractional mix (say a 12.5 t half-line) degrades predictably instead of writing
 * 25.000000000000004 into the plan.
 *
 * This module is PURE: no imports, no I/O, no `server-only`. Safe in a client component,
 * a server component, a server action, or a script.
 */

/** Tonnage by grade, e.g. `{ "3X50": 20, "6X50": 6 }`. */
export type GradeMix = Record<string, number>

/** One row of `public.production_setups`, camel-cased for the UI. */
export type ProductionSetup = {
  code: string
  label: string | null
  /** PER-SHIFT tonnage by grade. Multiply by `shifts` to get the day's grades. */
  gradeMix: GradeMix
  active: boolean
  sortOrder: number
  notes: string | null
}

/** What a setup + a shift count projects onto a plan day. */
export type SetupProjection = {
  /**
   * The day's grade tonnages, or `null` for a non-working day. `null` (not `{}`) matches
   * how `production_schedule` stores a rest day: `shifts = 0`, `grades = NULL`,
   * `projected_tons = 0`.
   */
  grades: GradeMix | null
  /** Always equal to the sum of `grades`' values. `0` when `grades` is `null`. */
  projectedTons: number
}

/** A non-working day: the exact shape the 56 rest-day rows already hold. */
const REST_DAY: SetupProjection = { grades: null, projectedTons: 0 }

/** Whole tons, half away from zero. `Math.round` alone is half-toward-+∞. */
function roundTons(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Coerce a raw `grade_mix` / `grades` JSON value into a `GradeMix`.
 *
 * Tolerant on purpose: PostgREST hands numerics back as strings often enough that a strict
 * parse would drop real values. Anything that is not a finite, POSITIVE number under a
 * non-blank key is dropped — a zero or negative tonnage is not a grade the plan produces,
 * and letting one through would corrupt the total.
 */
export function parseGradeMix(raw: unknown): GradeMix {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: GradeMix = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const grade = key.trim()
    if (!grade) continue
    const tons =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN
    if (!Number.isFinite(tons) || tons <= 0) continue
    out[grade] = tons
  }
  return out
}

/**
 * THE PROJECTION. `(per-shift mix, shifts) → (grades, projected_tons)`.
 *
 * `shifts` of 0 (or negative, or non-finite) is a rest day and yields `REST_DAY`. An empty
 * mix does too — there is nothing to produce.
 *
 * @param gradeMix per-shift tonnage by grade (a `production_setups.grade_mix`)
 * @param shifts   the day's shift count
 */
export function projectSetup(gradeMix: GradeMix, shifts: number): SetupProjection {
  if (!Number.isFinite(shifts) || shifts <= 0) return REST_DAY

  const grades: GradeMix = {}
  let projectedTons = 0

  for (const [grade, perShift] of Object.entries(gradeMix)) {
    if (!Number.isFinite(perShift) || perShift <= 0) continue
    const tons = roundTons(perShift * shifts)
    if (tons <= 0) continue
    grades[grade] = tons
    // Rule 3, by construction: the total IS the sum of the parts that were kept.
    projectedTons += tons
  }

  if (projectedTons === 0) return REST_DAY
  return { grades, projectedTons }
}

/**
 * Convenience for the editor: project by setup code against a loaded library.
 *
 * An unknown or blank code yields `REST_DAY` rather than throwing — the operator may be
 * mid-typing, or the plan row may carry a legacy setup string that is not in the library
 * (`production_schedule.setup` is deliberately free text with no FK to `production_setups`,
 * so this is an expected state, not an error).
 */
export function projectSetupByCode(
  setups: readonly ProductionSetup[],
  code: string | null | undefined,
  shifts: number
): SetupProjection {
  if (!code) return REST_DAY
  const setup = setups.find((s) => s.code === code)
  if (!setup) return REST_DAY
  return projectSetup(setup.gradeMix, shifts)
}

/**
 * Map a raw `production_setups` row (snake_case, straight from PostgREST) to
 * `ProductionSetup`. Keeps the coercion in one place so the editor never hand-rolls it.
 */
export function toProductionSetup(row: {
  code: string
  label?: string | null
  grade_mix: unknown
  active?: boolean | null
  sort_order?: number | null
  notes?: string | null
}): ProductionSetup {
  return {
    code: row.code,
    label: row.label ?? null,
    gradeMix: parseGradeMix(row.grade_mix),
    active: row.active ?? true,
    sortOrder: row.sort_order ?? 100,
    notes: row.notes ?? null,
  }
}

/**
 * True when a plan day's stored values match what its setup would project — i.e. the day
 * is "on template". A `false` means the operator overrode something, which is a normal and
 * expected state (see the module header); the editor can use this purely to badge it.
 */
export function isOnTemplate(
  projection: SetupProjection,
  storedGrades: unknown,
  storedProjectedTons: number | null | undefined
): boolean {
  const stored = parseGradeMix(storedGrades)
  const want = projection.grades ?? {}
  const storedKeys = Object.keys(stored).sort()
  const wantKeys = Object.keys(want).sort()
  if (storedKeys.length !== wantKeys.length) return false
  if (storedKeys.some((k, i) => k !== wantKeys[i])) return false
  if (storedKeys.some((k) => Math.abs(stored[k] - want[k]) > 1e-6)) return false
  return Math.abs((storedProjectedTons ?? 0) - projection.projectedTons) <= 1e-6
}
