'use server';

// =====================================================================
// Production Setup library — the in-app write path for `production_setups`.
// =====================================================================
// `production_setups` is REFERENCE DATA the operator maintains: one row per named
// per-shift grade mix (`SOLID 3X50` = `{"3X50": 25}`). It has no ownership model,
// no optimistic-concurrency token and no RPC — RLS gives `authenticated` plain
// PostgREST CRUD (migration `20260730080000_production_setups.sql`). These actions
// exist so the CLIENT never touches Supabase, matching every other module.
//
// THE ONE INVARIANT WORTH STATING LOUDLY:
// `production_schedule.setup` is FREE TEXT with **no FK** to this table. That is
// deliberate and it drives two behaviours here:
//   • RETIRE, NEVER DELETE. `active = false` hides a setup from the day-grid
//     dropdown; the string stays valid on every historical plan row, and the
//     management screen keeps showing it. (There is no delete action in this
//     file at all — retiring is the only removal.)
//   • EDITING A MIX IS NOT RETROACTIVE. `grades` / `projected_tons` are STORED
//     plan facts, written at plot time by the projection. Changing a mix here
//     changes what FUTURE picks project; it never rewrites a saved day. The UI
//     says this out loud — see `setups-manager.tsx`.
//
// The projection math itself lives in exactly ONE place —
// `lib/production/setup-projection.ts` — and is never duplicated here.
//
// No ₱ anywhere (tons only) → this module never touches `canViewPrices()`.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { GradeMix } from '@/lib/production/setup-projection';
import type { Json } from '@/types/supabase';

// ---------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------

export interface SetupWriteResult {
  ok: boolean;
  /** The code that was written — the grid applies it to the day on success. */
  code?: string;
  /** Human-readable failure text, already phrased for an error toast. */
  error?: string;
}

export interface SetupFormValues {
  code: string;
  label: string | null;
  gradeMix: GradeMix;
  notes: string | null;
}

// Every surface that shows setups.
const PATHS = ['/production/setups', '/production/schedule', '/'];

function revalidateAll() {
  for (const p of PATHS) revalidatePath(p);
}

/**
 * Turn a PostgREST error into something an operator can act on.
 *
 * The one that actually happens is the UNIQUE violation on `code` — Postgres
 * reports it as `duplicate key value violates unique constraint
 * "production_setups_code_key"`, which is noise. The two CHECK constraints are
 * mirrored by client-side validation, so they should be unreachable; they are
 * translated anyway rather than leaked raw.
 */
function readableDbError(
  err: { code?: string; message: string },
  code: string
): string {
  if (err.code === '23505') {
    return `A setup named "${code}" already exists. Setup codes are unique because the code is the literal string stored on every plan day — pick a different name, or edit the existing one from the setup library.`;
  }
  if (err.message.includes('production_setups_grade_mix_object_check')) {
    return `"${code}" needs at least one grade with a tonnage.`;
  }
  if (err.message.includes('production_setups_code_not_blank_check')) {
    return 'A setup needs a code.';
  }
  return err.message;
}

/** Server-side mirror of the dialog's validation — never trust the client. */
function validate(values: SetupFormValues): string | null {
  if (!values.code.trim()) return 'A setup needs a code.';
  const entries = Object.entries(values.gradeMix);
  if (entries.length === 0)
    return 'A setup needs at least one grade with a tonnage.';
  for (const [grade, tons] of entries) {
    if (!grade.trim()) return 'Every grade needs a name.';
    if (!Number.isFinite(tons) || tons <= 0)
      return `"${grade}" needs a tonnage greater than zero.`;
  }
  return null;
}

// ---------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------
// Called from BOTH the management screen and the day grid's inline
// "+ New setup…" — the grid then applies the returned `code` to the day in the
// same motion, which is why `code` comes back on success.

export async function createProductionSetup(
  values: SetupFormValues
): Promise<SetupWriteResult> {
  const invalid = validate(values);
  if (invalid) return { ok: false, error: invalid };

  const code = values.code.trim();
  const supabase = await createClient();

  // New setups land at the END of the library. `sort_order` is a plain integer
  // the operator reorders later; there is no gap-keeping scheme to preserve.
  const { data: last } = await supabase
    .from('production_setups')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from('production_setups').insert({
    code,
    label: values.label?.trim() || null,
    grade_mix: values.gradeMix as Json,
    notes: values.notes?.trim() || null,
    sort_order: (last?.sort_order ?? 0) + 10,
  });

  if (error) return { ok: false, error: readableDbError(error, code) };
  revalidateAll();
  return { ok: true, code };
}

// ---------------------------------------------------------------------
// 2. Update
// ---------------------------------------------------------------------
// Renaming a code does NOT rewrite `production_schedule.setup` on saved days —
// there is no FK and no cascade. The management screen warns before renaming.

export async function updateProductionSetup(input: {
  id: string;
  values: SetupFormValues;
}): Promise<SetupWriteResult> {
  const invalid = validate(input.values);
  if (invalid) return { ok: false, error: invalid };

  const code = input.values.code.trim();
  const supabase = await createClient();
  const { error } = await supabase
    .from('production_setups')
    .update({
      code,
      label: input.values.label?.trim() || null,
      grade_mix: input.values.gradeMix as Json,
      notes: input.values.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.id);

  if (error) return { ok: false, error: readableDbError(error, code) };
  revalidateAll();
  return { ok: true, code };
}

// ---------------------------------------------------------------------
// 3. Retire / restore  (there is no delete — see the header)
// ---------------------------------------------------------------------

export async function setProductionSetupActive(input: {
  id: string;
  active: boolean;
}): Promise<SetupWriteResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('production_setups')
    .update({ active: input.active, updated_at: new Date().toISOString() })
    .eq('id', input.id);

  if (error) {
    return {
      ok: false,
      error: `Could not ${input.active ? 'restore' : 'retire'} the setup: ${error.message}`,
    };
  }
  revalidateAll();
  return { ok: true };
}

// ---------------------------------------------------------------------
// 4. Reorder
// ---------------------------------------------------------------------
// The client sends the WHOLE list in its new order; this rewrites `sort_order`
// as 10, 20, 30… That is O(n) writes on a table with a handful of rows, and it
// is immune to the drift a swap-with-neighbour scheme accumulates when two rows
// share a sort_order (which the seeded data can, since sort_order is not
// unique).

export async function reorderProductionSetups(input: {
  orderedIds: string[];
}): Promise<SetupWriteResult> {
  const supabase = await createClient();
  const stamp = new Date().toISOString();

  for (const [index, id] of input.orderedIds.entries()) {
    const { error } = await supabase
      .from('production_setups')
      .update({ sort_order: (index + 1) * 10, updated_at: stamp })
      .eq('id', id);
    if (error) {
      return { ok: false, error: `Could not reorder the library: ${error.message}` };
    }
  }

  revalidateAll();
  return { ok: true };
}
