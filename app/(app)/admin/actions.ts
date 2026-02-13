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
    // Use admin client to send invitation
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { role },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/callback`,
    });

    if (error) {
      return { success: false, message: error.message };
    }

    // Create profile for invited user
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: data.user.id,
        email,
        role,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

    if (profileError) {
      console.error('Profile creation error:', profileError);
      // User was invited but profile creation failed - still return success
      // since the invitation email was sent
      revalidatePath('/admin');
      return { success: true, message: 'Invitation sent (profile creation had an issue)' };
    }

    revalidatePath('/admin');
    return { success: true, message: `Invitation sent to ${email}` };
  } catch (error) {
    console.error('Invitation error:', error);
    return { success: false, message: 'Failed to send invitation' };
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
