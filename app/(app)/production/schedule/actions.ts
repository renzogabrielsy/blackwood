'use server';

// =====================================================================
// Production Schedule — in-app write path (Phase B).
// =====================================================================
// The schedule's ownership model lives in the DB (migration
// `20260730060000_production_schedule_ownership.sql`). These actions are the
// ONLY way the app writes `production_schedule`:
//
//   • saveScheduleDay      → fn_save_schedule_day(patch)                    (edit)
//   • takeUpstreamProposal → fn_save_schedule_day(proposed, clear_pending)  (resolve)
//   • keepMineClearPending → fn_save_schedule_day({}, clear_pending)        (resolve)
//   • releaseScheduleDay   → fn_release_schedule_day(plan_date, version)    (revert)
//
// Every mutation goes through an RPC with the `row_version` the client read; the
// RPC re-checks version + the actuals freeze INSIDE its own UPDATE, so a save
// racing the sync is rejected, never merged.
//
// `p_clear_pending` defaults to FALSE on purpose: an unrelated edit must never
// silently discard Joseph's parked proposal. Only the two explicit resolve
// actions pass `true`.
//
// The schema gap this file used to document is CLOSED:
// `fn_release_schedule_day` (migration
// `20260730070000_fn_release_schedule_day.sql`) is now the sanctioned way to
// hand a human-owned day back to the sync, and it enforces all three guards —
// row_version, owner='human', and the `production_shifts` actuals freeze —
// inside the single UPDATE's own WHERE. There is no read-then-write left in this
// module.
//
// This module writes NO ₱ data — the schedule carries tons only — so it never
// touches `canViewPrices()`.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/types/supabase';

// ---------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------

/** The four fields the in-app editor may patch. `grades` (JSONB) stays
 *  read-only in Phase B — there is no JSON editor yet. */
export interface SchedulePatch {
  shifts?: number | null;
  setup?: string | null;
  projected_tons?: number | null;
  remarks?: string | null;
}

/** Owners the sync is allowed to write. `human` is what the app sets; `actual`
 *  is derived, never stored. */
export type ScheduleUpstreamOwner = 'joseph' | 'gsheet';

/** The RPC's own outcome vocabulary, surfaced verbatim so the UI can say the
 *  RIGHT thing (a version conflict is "reload", a freeze is "already reported").
 *
 *  ONE translation happens at the boundary: `fn_release_schedule_day` reports a
 *  successful revert as `reclaimed` — the word Phase A already uses for "hand
 *  ownership back to the upstream owner" — and this module surfaces it to the UI
 *  as `released`, the app-facing name for the same event. No other outcome is
 *  renamed. */
export type SaveOutcome =
  | 'saved'
  | 'frozen'
  | 'missing'
  | 'version_conflict'
  | 'released';

export interface ScheduleWriteResult {
  ok: boolean;
  outcome: SaveOutcome;
  /** The row_version AFTER the write (or the DB's current one on a conflict). */
  rowVersion: number | null;
  /** Human-readable failure text — already phrased for an error toast. */
  error?: string;
}

const PATH = '/';

/** Turn an RPC outcome into the sentence the operator should read. */
function messageFor(outcome: SaveOutcome, planDate: string): string | undefined {
  switch (outcome) {
    case 'version_conflict':
      return `${planDate} changed since you loaded it (the sync or another operator wrote it first). Reload the page and redo your edit — nothing was saved.`;
    case 'frozen':
      return `${planDate} already has reported production, so the plan is frozen. Nothing was saved.`;
    case 'missing':
      return `${planDate} has no schedule row. The sync creates the calendar; a day it never planned cannot be edited in-app.`;
    default:
      return undefined;
  }
}

/** Narrow the RPC's `jsonb` return into our result shape. */
function readRpcResult(
  raw: Json | null,
  planDate: string
): ScheduleWriteResult {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, Json | undefined>)
      : null;
  const outcome = (obj?.outcome as SaveOutcome | undefined) ?? 'missing';
  const rowVersion =
    typeof obj?.row_version === 'number' ? obj.row_version : null;
  const ok = obj?.ok === true;
  return { ok, outcome, rowVersion, error: ok ? undefined : messageFor(outcome, planDate) };
}

/** Strip `undefined` keys so an ABSENT key means "keep stored value" and an
 *  EXPLICIT null means "clear it" — exactly the RPC's `p_patch ? 'key'` contract. */
function toPatchJson(patch: SchedulePatch): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (patch.shifts !== undefined) out.shifts = patch.shifts;
  if (patch.setup !== undefined) out.setup = patch.setup;
  if (patch.projected_tons !== undefined)
    out.projected_tons = patch.projected_tons;
  if (patch.remarks !== undefined) out.remarks = patch.remarks;
  return out;
}

async function callSaveDay(
  planDate: string,
  expectedRowVersion: number,
  patch: Record<string, Json>,
  clearPending: boolean
): Promise<ScheduleWriteResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_save_schedule_day', {
    p_plan_date: planDate,
    p_expected_row_version: expectedRowVersion,
    p_patch: patch as Json,
    p_clear_pending: clearPending,
  });

  if (error) {
    return {
      ok: false,
      outcome: 'missing',
      rowVersion: null,
      error: `Could not save ${planDate}: ${error.message}`,
    };
  }

  const result = readRpcResult(data as Json, planDate);
  if (result.ok) revalidatePath(PATH);
  return result;
}

// ---------------------------------------------------------------------
// 1. Edit a day  (the grid's Save)
// ---------------------------------------------------------------------
// Flips the WHOLE DAY to owner='human' — that is the approved lock granularity,
// enforced by the RPC, not by this action. `clear_pending` is FALSE: an edit is
// not an arbitration.

export async function saveScheduleDay(input: {
  planDate: string;
  expectedRowVersion: number;
  patch: SchedulePatch;
}): Promise<ScheduleWriteResult> {
  const patch = toPatchJson(input.patch);
  if (Object.keys(patch).length === 0) {
    return { ok: true, outcome: 'saved', rowVersion: input.expectedRowVersion };
  }
  return callSaveDay(input.planDate, input.expectedRowVersion, patch, false);
}

// ---------------------------------------------------------------------
// 2. Conflict resolution — "take Joseph's"
// ---------------------------------------------------------------------
// Writes the parked proposal's values AND clears the pending. The day stays
// human-owned; the sync's own rule-4 "reclaim" hands ownership back on the next
// run precisely because the values now equal upstream.

export async function takeUpstreamProposal(input: {
  planDate: string;
  expectedRowVersion: number;
  proposed: SchedulePatch;
}): Promise<ScheduleWriteResult> {
  // Every editable field is written explicitly (including nulls) so "take
  // Joseph's" means "match Joseph", not "merge with mine".
  const patch: Record<string, Json> = {
    shifts: input.proposed.shifts ?? 0,
    setup: input.proposed.setup ?? null,
    projected_tons: input.proposed.projected_tons ?? null,
    remarks: input.proposed.remarks ?? null,
  };
  return callSaveDay(input.planDate, input.expectedRowVersion, patch, true);
}

// ---------------------------------------------------------------------
// 3. Conflict resolution — "keep mine"
// ---------------------------------------------------------------------
// Discards the parked proposal, leaving the day human-owned with the operator's
// values untouched. An empty patch still bumps row_version + re-stamps
// human_edited_at, which is correct: the human just made a decision about this
// day.

export async function keepMineClearPending(input: {
  planDate: string;
  expectedRowVersion: number;
}): Promise<ScheduleWriteResult> {
  return callSaveDay(input.planDate, input.expectedRowVersion, {}, true);
}

// ---------------------------------------------------------------------
// 4. Revert to upstream — hand the day back to the sync
// ---------------------------------------------------------------------
// Without this, ownership only ratchets one way and the calendar slowly freezes.
// Releasing a day:
//   • sets owner back to the upstream owner implied by `source`
//     (`joseph:…` → joseph, otherwise gsheet),
//   • clears `source_rev` so the next run sees a rev mismatch and RE-APPLIES the
//     upstream value (a stale rev would make the run a no-op and the day would
//     keep the human value while claiming to follow Joseph),
//   • clears any parked `pending_upstream` (it is about to be applied for real),
//   • bumps `row_version`.
// All three guards — `row_version`, `owner = 'human'`, and the
// `production_shifts` actuals freeze — live inside the RPC's single UPDATE. A
// day that is not human-owned fails the same way a stale version does
// (`version_conflict`), exactly as `fn_apply_schedule_upstream` classifies it:
// either way the day moved out from under the operator.

export async function releaseScheduleDay(input: {
  planDate: string;
  expectedRowVersion: number;
}): Promise<ScheduleWriteResult> {
  const { planDate, expectedRowVersion } = input;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_release_schedule_day', {
    p_plan_date: planDate,
    p_expected_row_version: expectedRowVersion,
  });

  if (error) {
    return {
      ok: false,
      outcome: 'missing',
      rowVersion: null,
      error: `Could not hand ${planDate} back to the sync: ${error.message}`,
    };
  }

  const result = readRpcResult(data as Json, planDate);

  // `reclaimed` is the DB's word for a successful hand-back; `released` is the
  // app's. Same event — see the SaveOutcome note above.
  if (result.ok) {
    revalidatePath(PATH);
    return { ok: true, outcome: 'released', rowVersion: result.rowVersion };
  }
  return result;
}
