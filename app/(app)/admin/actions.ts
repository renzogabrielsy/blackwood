'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { UserRole } from '@/components/providers/auth-context';

type ActionResult = { success: boolean; message?: string };

/**
 * Invite user via Supabase Auth
 * Uses service role to call auth.admin.inviteUserByEmail()
 */
export async function inviteUser(
  email: string,
  role: UserRole
): Promise<ActionResult> {
  const supabase = await createClient();

  // Verify caller is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: 'Not authenticated' };

  // Verify caller is admin
  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!['Owner', 'Admin', 'Dev'].includes(callerProfile?.role)) {
    return { success: false, message: 'Insufficient permissions' };
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { success: false, message: 'Invalid email format' };
  }

  // Check if user already exists
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    return { success: false, message: 'User already exists' };
  }

  try {
    // Use admin client for all operations on user_invites to bypass RLS
    const adminClient = createAdminClient();

    // Check if user is already invited
    const { data: existingInvite } = await adminClient
      .from('user_invites')
      .select('email')
      .eq('email', email)
      .single();

    if (existingInvite) {
      return { success: false, message: 'User already invited' };
    }

    // Add to whitelist
    const { error } = await adminClient
      .from('user_invites')
      .insert({
        email,
        role,
        invited_by: user.id,
      });

    if (error) {
      console.error(`Invite Error: ${error.message} (Code: ${error.code})`);
      return { success: false, message: `DB Error: ${error.message}` };
    }

    revalidatePath('/admin');
    return { success: true, message: `Added ${email} to whitelist` };
  } catch (err: any) {
    console.error(`Invitation Exception: ${err.message}`);
    return { success: false, message: `Exception: ${err.message}` };
  }
}

/**
 * Revoke user access (soft delete)
 */
export async function revokeUserAccess(userId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: 'Not authenticated' };

  // Verify caller is admin
  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!['Owner', 'Admin', 'Dev'].includes(caller?.role)) {
    return { success: false, message: 'Insufficient permissions' };
  }

  // Prevent self-revocation
  if (userId === user.id) {
    return { success: false, message: 'Cannot revoke your own access' };
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) return { success: false, message: error.message };

    revalidatePath('/admin');
    return { success: true, message: 'User access revoked' };
  } catch (error) {
    console.error('Revoke access error:', error);
    return { success: false, message: 'Failed to revoke access' };
  }
}

/**
 * Reactivate disabled user
 */
export async function reactivateUser(userId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: 'Not authenticated' };

  // Verify caller is admin
  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!['Owner', 'Admin', 'Dev'].includes(caller?.role)) {
    return { success: false, message: 'Insufficient permissions' };
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) return { success: false, message: error.message };

    revalidatePath('/admin');
    return { success: true, message: 'User reactivated' };
  } catch (error) {
    console.error('Reactivate user error:', error);
    return { success: false, message: 'Failed to reactivate user' };
  }
}

/**
 * Update user role
 */
export async function updateUserRole(userId: string, role: UserRole): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: 'Not authenticated' };

  // Verify caller is admin
  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!['Owner', 'Admin', 'Dev'].includes(caller?.role)) {
    return { success: false, message: 'Insufficient permissions' };
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) return { success: false, message: error.message };

    revalidatePath('/admin');
    return { success: true, message: `User role updated to ${role}` };
  } catch (error) {
    console.error('Update role error:', error);
    return { success: false, message: 'Failed to update user role' };
  }
}
