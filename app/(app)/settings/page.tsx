import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RoleAssignmentTable } from './components/RoleAssignmentTable';
import Link from 'next/link';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: currentProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user!.id)
    .single();

  const isAdmin = currentProfile?.role === 'Owner' || currentProfile?.role === 'Admin' || currentProfile?.role === 'Dev';

  if (!isAdmin) {
    return (
      <div className="flex flex-1 items-center justify-center bg-muted/10">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Access Denied</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You do not have permission to access this page. Only Owner and Admin roles can manage users.
            </p>
            <Link href="/" className="text-sm underline">
              Back to Dashboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, display_name, avatar_url, role, created_at')
    .order('created_at', { ascending: true });

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/10">
      <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">User Roles</CardTitle>
          </CardHeader>
          <CardContent>
            <RoleAssignmentTable profiles={profiles ?? []} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
