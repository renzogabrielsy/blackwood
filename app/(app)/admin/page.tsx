import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { UserManagementTable } from './components/UserManagementTable';

export const metadata = {
  title: 'Admin Panel - Blackwood',
};

export default async function AdminPage() {
  const supabase = await createClient();

  // Verify authentication
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Verify admin access
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const isAdmin = ['Owner', 'Admin', 'Dev'].includes(profile?.role ?? '');

  if (!isAdmin) {
    return (
      <Card className="p-6">
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground mt-2">
          You don&apos;t have permission to access the admin panel.
        </p>
      </Card>
    );
  }

  // Fetch all users
  const { data: users } = await supabase
    .from('profiles')
    .select('id, email, display_name, avatar_url, role, status, created_at')
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6">
      <UserManagementTable users={users ?? []} currentUserId={user.id} />
    </div>
  );
}
