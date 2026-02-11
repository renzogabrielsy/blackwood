'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { UserRole } from '@/components/providers/auth-context';

export async function updateUserRole(userId: string, role: UserRole) {
  const supabase = await createClient();

  // Verify caller is Owner or Admin
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, message: 'Not authenticated' };
  }

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!callerProfile || !['Owner', 'Admin', 'Dev'].includes(callerProfile.role)) {
    return { success: false, message: 'Insufficient permissions' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId);

  if (error) {
    return { success: false, message: error.message };
  }

  revalidatePath('/settings');
  return { success: true };
}
