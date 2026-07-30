/**
 * plan.ts — the PURE conditional-refresh planner for `production_schedule`.
 *
 * THE BUG THIS FIXES. Stage 3c used to call `db.upsertProductionSchedule(rows)` — an
 * UNCONDITIONAL upsert of EVERY plan_date on EVERY run, re-applying the same Joseph email
 * over and over. That is fine while the plan is sync-owned and nothing else writes it; the
 * moment the plan becomes editable in-app it is a silent-overwrite machine, which
 * CLAUDE.md's "Sync Integrity" section forbids outright.
 *
 * The load-bearing rule is #1 below: when Joseph's revision is unchanged from what the
 * rows already carry, the sync writes NOTHING AT ALL — not a careful write, no write. The
 * re-application is the clobber mechanism, so removing it removes the whole failure class.
 *
 * THE SIX RULES (per day, in order):
 *   1. Incoming `source_rev` already on the row (or already PARKED on the row) → NO-OP.
 *   2. Production reported for the date (`isReported`) → FROZEN. Never written, whoever
 *      owns it. This is checked here for planning AND re-checked inside the SQL writer.
 *   3. Day is `human` and the upstream value DIFFERS → do NOT write the row; park the
 *      incoming value in `pending_upstream` and raise a run finding naming the date.
 *   4. Day is `human` and the upstream value EQUALS the current value → clear
 *      `pending_upstream` and hand ownership back to the upstream owner. Reality caught up.
 *   5. A day the upstream no longer mentions is simply absent from the plan → untouched.
 *      Absence is NEVER deletion (the flecon BUG-015 class of bug).
 *   6. Every planned write carries the `expected_row_version` it was planned against; the
 *      SQL writer re-checks it IN THE SAME STATEMENT as the write and rejects a stale one.
 *
 * PURE by construction: no IO, no DB, no clock except an injected `observedAt`. The
 * planner's read of current state is ADVISORY — `fn_apply_schedule_upstream` re-validates
 * row_version + owner + the actuals freeze on every write, so a save that lands between
 * the snapshot and the apply wins and our op comes back `version_conflict`.
 */
import { createHash } from "node:crypto";
import type { ProdScheduleRow } from "./parse.js";

/** The plan-bearing fields — the ones a human edits and the ones we compare/hash. */
export const PLAN_FIELDS = [
  "shifts",
  "setup",
  "projected_tons",
  "grades",
  "remarks",
] as const;
export type PlanField = (typeof PLAN_FIELDS)[number];

export type ScheduleOwner = "joseph" | "gsheet" | "human" | "actual";

/** One row of `view_production_schedule_state` (the snapshot the planner reads). */
export interface ScheduleStateRow {
  plan_date: string;
  shifts: number | null;
  setup: string | null;
  projected_tons: number | null;
  grades: Record<string, number> | null;
  remarks: string | null;
  source: string | null;
  owner: ScheduleOwner;
  source_rev: string | null;
  row_version: number;
  pending_source_rev: string | null;
  is_reported: boolean;
}

/**
 * Coerce ONE raw `view_production_schedule_state` row (PostgREST JSON — numerics arrive as
 * strings, jsonb as objects) into the planner's shape. Pure; tolerant of missing keys.
 */
export function toScheduleStateRow(r: Record<string, unknown>): ScheduleStateRow {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const txt = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  };
  return {
    plan_date: String(r.plan_date ?? "").slice(0, 10),
    shifts: num(r.shifts),
    setup: txt(r.setup),
    projected_tons: num(r.projected_tons),
    grades:
      r.grades && typeof r.grades === "object" ? (r.grades as Record<string, number>) : null,
    remarks: txt(r.remarks),
    source: txt(r.source),
    owner: (txt(r.owner) ?? "gsheet") as ScheduleOwner,
    source_rev: txt(r.source_rev),
    row_version: num(r.row_version) ?? 1,
    pending_source_rev: txt(r.pending_source_rev),
    is_reported: r.is_reported === true,
  };
}

export type ScheduleAction = "insert" | "apply" | "reclaim" | "park";

/** One planned operation, in the exact shape `fn_apply_schedule_upstream` consumes. */
export interface ScheduleOp {
  plan_date: string;
  action: ScheduleAction;
  expected_row_version: number | null;
  expected_owner: ScheduleOwner | null;
  source_rev: string;
  new_owner: ScheduleOwner;
  row: ProdScheduleRow;
  pending?: PendingUpstream;
}

/** The withheld upstream value parked on a human-owned day. */
export interface PendingUpstream {
  source_rev: string;
  proposed: Record<PlanField | "source", unknown>;
  changed_fields: PlanField[];
  observed_at: string;
}

/** A day the sync refused to write because a human owns it — surfaced as a run finding. */
export interface ScheduleConflict {
  plan_date: string;
  /** The revision that wanted in. */
  source_rev: string;
  /** Which plan fields disagree. */
  changed_fields: PlanField[];
  current: Record<PlanField, unknown>;
  proposed: Record<PlanField, unknown>;
}

export interface SchedulePlan {
  ops: ScheduleOp[];
  conflicts: ScheduleConflict[];
  /** Per-decision counts, for the progress beat. Keys are stable. */
  counts: {
    unchanged: number;
    frozen: number;
    inserted: number;
    applied: number;
    reclaimed: number;
    parked: number;
  };
}

// ---------------------------------------------------------------------------
// source_rev
// ---------------------------------------------------------------------------

/**
 * Canonical JSON of ONE day's plan-bearing payload. Key order is fixed and `grades` keys
 * are sorted, so the hash is stable across parse runs and JS object-insertion order.
 * Numbers go through Number() so `26` and `26.0` hash the same.
 */
export function canonicalDayPayload(row: ProdScheduleRow): string {
  const grades = row.grades
    ? Object.keys(row.grades)
        .sort()
        .map((k) => [k, Number(row.grades![k])] as const)
    : null;
  return JSON.stringify([
    row.plan_date,
    row.year,
    row.month,
    row.dow ?? null,
    row.shifts ?? 0,
    row.setup ?? null,
    row.projected_tons == null ? null : Number(row.projected_tons),
    grades,
    row.remarks ?? null,
    row.source,
  ]);
}

/**
 * `source_rev` — the identity of the upstream revision a row was derived from.
 *
 *     `${row.source}|${messageTag}|${dayHash12}`
 *
 *  - `row.source`  the provenance tag already stored on the row ('joseph:REV5' |
 *                  'gsheet:PROD SCHED'), so the revision label is visible at a glance.
 *  - `messageTag`  the identity of the email the overlay came from: `gm<threadId>.<uid>`
 *                  (Gmail's own message identity). `lib/gmail.ts`'s `FetchedEmail` exposes
 *                  no RFC-822 Message-ID and adding one means touching the live IMAP fetch
 *                  we cannot test, so threadId+uid is the stand-in — it is stable across
 *                  re-fetches of the same message, which is exactly the property rule 1
 *                  needs. `-` on Renzo-only days (no email involved).
 *  - `dayHash12`   first 12 hex of sha256 over `canonicalDayPayload` — a CONTENT address
 *                  for that one day. Per-day (not per-workbook) so a one-day change
 *                  rewrites one row, not the whole calendar.
 *
 * Equality with the stored `source_rev` means "the sync has already applied exactly this
 * for this day" → write nothing (rule 1).
 */
export function computeSourceRev(row: ProdScheduleRow, messageTag: string | null): string {
  const hash = createHash("sha256").update(canonicalDayPayload(row)).digest("hex").slice(0, 12);
  return `${row.source}|${messageTag ?? "-"}|${hash}`;
}

/** `gm<threadId>.<uid>` for a Joseph email, or null when there is no email. */
export function messageTagFor(
  email: { uid: number; threadId: string | null } | null | undefined,
): string | null {
  if (!email) return null;
  return `gm${email.threadId ?? "-"}.${email.uid}`;
}

/**
 * Stamp `source_rev` onto every merged row. Days Joseph covered (source starts `joseph:`)
 * carry the message tag; Renzo-only days carry `-` so a Joseph email arriving/leaving does
 * not churn the untouched part of the calendar.
 */
export function stampSourceRevs(
  rows: ProdScheduleRow[],
  messageTag: string | null,
): Array<ProdScheduleRow & { source_rev: string }> {
  return rows.map((r) => ({
    ...r,
    source_rev: computeSourceRev(r, r.source.startsWith("joseph:") ? messageTag : null),
  }));
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

/** Owner a sync-written row should carry, derived from its provenance tag. */
export function ownerForSource(source: string): ScheduleOwner {
  return source.startsWith("joseph:") ? "joseph" : "gsheet";
}

function sameNumber(a: unknown, b: unknown): boolean {
  const na = a == null || a === "" ? null : Number(a);
  const nb = b == null || b === "" ? null : Number(b);
  if (na === null || nb === null) return na === nb;
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  // Tonnage is a numeric(…) round-trip through PostgREST; compare at 1e-6.
  return Math.abs(na - nb) < 1e-6;
}

function sameText(a: unknown, b: unknown): boolean {
  const sa = a == null || a === "" ? null : String(a);
  const sb = b == null || b === "" ? null : String(b);
  return sa === sb;
}

function sameGrades(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): Array<[string, number]> | null => {
    if (v == null || typeof v !== "object") return null;
    const e = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, Number(x)] as [string, number])
      .filter(([, x]) => Number.isFinite(x))
      .sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    return e.length ? e : null;
  };
  const na = norm(a);
  const nb = norm(b);
  if (na === null || nb === null) return na === nb;
  if (na.length !== nb.length) return false;
  return na.every(([k, v], i) => nb[i][0] === k && Math.abs(nb[i][1] - v) < 1e-6);
}

/** Which plan-bearing fields differ between the stored row and the incoming one. */
export function changedPlanFields(
  current: ScheduleStateRow,
  incoming: ProdScheduleRow,
): PlanField[] {
  const out: PlanField[] = [];
  if (!sameNumber(current.shifts ?? 0, incoming.shifts ?? 0)) out.push("shifts");
  if (!sameText(current.setup, incoming.setup)) out.push("setup");
  if (!sameNumber(current.projected_tons, incoming.projected_tons)) out.push("projected_tons");
  if (!sameGrades(current.grades, incoming.grades)) out.push("grades");
  if (!sameText(current.remarks, incoming.remarks)) out.push("remarks");
  return out;
}

function planSnapshot(r: {
  shifts: number | null;
  setup: string | null;
  projected_tons: number | null;
  grades: Record<string, number> | null;
  remarks: string | null;
}): Record<PlanField, unknown> {
  return {
    shifts: r.shifts ?? 0,
    setup: r.setup ?? null,
    projected_tons: r.projected_tons ?? null,
    grades: r.grades ?? null,
    remarks: r.remarks ?? null,
  };
}

// ---------------------------------------------------------------------------
// the planner
// ---------------------------------------------------------------------------

/**
 * Decide, per day, what (if anything) the sync may write. See the six rules at the top.
 *
 * `incoming` — the merged plan rows, already `source_rev`-stamped (stampSourceRevs).
 * `current`  — the `view_production_schedule_state` snapshot (any subset; a day absent
 *              from it has no row yet).
 * `observedAt` — ISO timestamp stamped into a parked value; injected so tests are stable.
 */
export function planScheduleUpstream(
  incoming: Array<ProdScheduleRow & { source_rev: string }>,
  current: ScheduleStateRow[],
  observedAt: string,
): SchedulePlan {
  const byDate = new Map<string, ScheduleStateRow>();
  for (const c of current) byDate.set(c.plan_date, c);

  const ops: ScheduleOp[] = [];
  const conflicts: ScheduleConflict[] = [];
  const counts = { unchanged: 0, frozen: 0, inserted: 0, applied: 0, reclaimed: 0, parked: 0 };

  for (const row of incoming) {
    const cur = byDate.get(row.plan_date);
    const newOwner = ownerForSource(row.source);

    // -- no row yet: create it. A REPORTED day is still frozen (rule 2 is absolute) —
    //    the plan for a day that already happened is archaeology, not a plan.
    if (!cur) {
      ops.push({
        plan_date: row.plan_date,
        action: "insert",
        expected_row_version: null,
        expected_owner: null,
        source_rev: row.source_rev,
        new_owner: newOwner,
        row,
      });
      counts.inserted++;
      continue;
    }

    // -- RULE 1 (load-bearing): this exact revision is already on the row, or is already
    //    parked on it. Write NOTHING. This is what makes the steady state a zero-write run.
    if (cur.source_rev === row.source_rev || cur.pending_source_rev === row.source_rev) {
      counts.unchanged++;
      continue;
    }

    // -- RULE 2: production reported → frozen for everyone. Re-checked in SQL too.
    if (cur.is_reported) {
      counts.frozen++;
      continue;
    }

    // -- RULES 3 & 4: a human owns this day.
    if (cur.owner === "human") {
      const changed = changedPlanFields(cur, row);
      if (changed.length === 0) {
        // RULE 4 — reality caught up. Hand ownership back, clear any parked value.
        ops.push({
          plan_date: row.plan_date,
          action: "reclaim",
          expected_row_version: cur.row_version,
          expected_owner: "human",
          source_rev: row.source_rev,
          new_owner: newOwner,
          row,
        });
        counts.reclaimed++;
        continue;
      }
      // RULE 3 — withhold. Park the proposal, write no plan field, raise a finding.
      const proposed = { ...planSnapshot(row), source: row.source };
      ops.push({
        plan_date: row.plan_date,
        action: "park",
        expected_row_version: cur.row_version,
        expected_owner: "human",
        source_rev: row.source_rev,
        new_owner: "human",
        row,
        pending: {
          source_rev: row.source_rev,
          proposed,
          changed_fields: changed,
          observed_at: observedAt,
        },
      });
      conflicts.push({
        plan_date: row.plan_date,
        source_rev: row.source_rev,
        changed_fields: changed,
        current: planSnapshot(cur),
        proposed: planSnapshot(row),
      });
      counts.parked++;
      continue;
    }

    // -- sync-owned day, upstream genuinely changed → apply.
    ops.push({
      plan_date: row.plan_date,
      action: "apply",
      expected_row_version: cur.row_version,
      expected_owner: cur.owner,
      source_rev: row.source_rev,
      new_owner: newOwner,
      row,
    });
    counts.applied++;
  }

  // RULE 5 is structural: `current` days with no `incoming` counterpart are never visited,
  // so they produce no op. There is no delete path anywhere in this module.
  return { ops, conflicts, counts };
}
