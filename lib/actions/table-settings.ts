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
