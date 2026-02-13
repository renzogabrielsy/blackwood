import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        // Retry fetching profile to handle trigger race conditions
        // Use adminClient to bypass RLS policies just in case
        const adminClient = createAdminClient();
        let profile = null;
        for (let i = 0; i < 3; i++) {
          const { data } = await adminClient
            .from('profiles')
            .select('status')
            .eq('id', user.id)
            .single();

          profile = data;

          if (profile?.status === 'active') {
            break;
          }

          // Wait 1s before retrying
          if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (profile?.status !== 'active') {
          const userId = user.id;
          await supabase.auth.signOut();
          // Delete the auto-created auth user (cascades to profile) to prevent junk accumulation
          const adminClient = createAdminClient();
          await adminClient.auth.admin.deleteUser(userId);
          return NextResponse.redirect(`${origin}/login?error=not_invited`);
        }

        // Update profile with Google metadata (avatar, display name)
        const meta = user.user_metadata;
        if (meta) {
          await supabase.from('profiles').update({
            display_name: meta.full_name || meta.name,
            avatar_url: meta.avatar_url,
          }).eq('id', user.id);
        }
      }

      return NextResponse.redirect(origin);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
