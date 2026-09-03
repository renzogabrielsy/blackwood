'use server';

import { createClient } from '@/lib/supabase/server';
import type { RcInTableSettings } from '@/types/table-settings';
import { DEFAULT_RC_IN_SETTINGS } from '@/types/table-settings';

// ===========================================================================
// Per-user table settings — NEUTRAL (platform-layer) server actions.
// ---------------------------------------------------------------------------
// These read/write the `user_table_settings` table, which is keyed by
// (user_id, module) — a generic per-table settings store. Moved here out of the
// rc-in tenant module so the globally-mounted TableSettingsProvider (platform
// infrastructure) no longer imports from `app/(app)/inventory/rc-in/actions`.
//
// The settings SHAPE is still typed as RcInTableSettings today because RC IN is
// the only table that persists settings. When a second table id is introduced
// the settings type can be generalized; the storage layer is already generic.
// rc-in/actions.ts re-exports these for backward compatibility.
// ===========================================================================

// ===========================================================================
// THE GENERIC PAIR (owner feedback R10, 2026-09-03) — reuse over reinvention.
// ---------------------------------------------------------------------------
// `user_table_settings` is already a per-(user, module) jsonb bag; the two
// functions below are the SHAPE-AGNOSTIC door onto it, so a second module does
// not need a second table, a second action file or a second provider. The pair
// above stays exactly as it is: it is the RC IN shape's door, and merging
// `DEFAULT_RC_IN_SETTINGS` into an analytics record would be nonsense.
//
// TWO DELIBERATE DIFFERENCES FROM `saveTableSettings`:
//
//   1. **It REPLACES, it does not merge.** `saveTableSettings` reads the row
//      and spreads the patch over it, which means a key can be added but never
//      REMOVED — and "reset to defaults" is precisely a removal. Here the
//      caller owns the whole document and sends the whole document, so a
//      defaulted setting disappears from the row instead of lingering.
//   2. **Last write wins, and that is correct here.** The caller debounces at
//      500 ms and holds the authoritative in-memory copy, so a read-modify-
//      write would only widen the window in which two tabs could interleave.
//
// A FAILURE IS RETURNED, NEVER SWALLOWED. The caller decides what to do with
// it; a preference that could not be saved is not worth a toast, but it IS
// worth the caller knowing (see `use-analytics-prefs.ts`).
// ===========================================================================

/**
 * One user's settings for one module, or `null` when there is no row.
 *
 * `null` and `{}` are DIFFERENT answers — "nothing was ever saved" versus
 * "everything is at its default" — and the analytics store reads that
 * difference to decide whether to run its one-time legacy migration.
 */
export async function getUserModuleSettings(
    module: string,
): Promise<Record<string, unknown> | null> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
        .from('user_table_settings')
        .select('settings')
        .eq('user_id', user.id)
        .eq('module', module)
        .maybeSingle();

    if (error || !data) return null;
    const settings = data.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    return settings as Record<string, unknown>;
}

/** Replace one user's settings document for one module. See the note above. */
export async function saveUserModuleSettings(
    module: string,
    settings: Record<string, unknown>,
): Promise<{ success: boolean; message?: string }> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, message: 'Not authenticated' };

    const { error } = await supabase
        .from('user_table_settings')
        .upsert({
            user_id: user.id,
            module,
            settings,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,module' });

    if (error) return { success: false, message: error.message };
    return { success: true };
}

export async function getTableSettings(module = 'rc_in'): Promise<RcInTableSettings> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return DEFAULT_RC_IN_SETTINGS;

    const { data } = await supabase
        .from('user_table_settings')
        .select('settings')
        .eq('user_id', user.id)
        .eq('module', module)
        .single();

    if (!data?.settings) return DEFAULT_RC_IN_SETTINGS;

    // Merge stored settings with defaults (stored values override defaults)
    return { ...DEFAULT_RC_IN_SETTINGS, ...(data.settings as Partial<RcInTableSettings>) };
}

export async function saveTableSettings(module: string, settings: Partial<RcInTableSettings>) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return { success: false, message: 'Not authenticated' };

    // Read existing settings first, merge, then upsert
    const { data: existing } = await supabase
        .from('user_table_settings')
        .select('settings')
        .eq('user_id', user.id)
        .eq('module', module)
        .single();

    const merged = { ...(existing?.settings as Record<string, unknown> ?? {}), ...settings };

    const { error } = await supabase
        .from('user_table_settings')
        .upsert({
            user_id: user.id,
            module,
            settings: merged,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,module' });

    if (error) {
        console.error('Error saving table settings:', error);
        return { success: false, message: error.message };
    }

    return { success: true };
}
