import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getUserRole } from '@/lib/auth';
import { PRIVILEGED_ROLES } from '@/types/auth';

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return null; // or redirect
  }

  const role = await getUserRole(user.id);

  // We still need profile for display name
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .single();

  const displayName = profile?.display_name ?? user.email ?? 'User';

  const isAdmin = PRIVILEGED_ROLES.includes(role);

  const modules = [
    { name: 'RC IN', href: '/inventory/rc-in', description: 'Raw charcoal receiving & delivery logs' },
    { name: 'RC OUT', href: '/inventory/rc-out', description: 'Raw charcoal usage & depletion logs' },
    { name: 'Settings', href: '/settings', description: 'User management & role assignments' },
    ...(isAdmin ? [{
      name: 'Admin Panel',
      href: '/admin',
      description: 'Manage users, invitations, and access control'
    }] : []),
  ];

  return (
    <div className="flex flex-col flex-1 bg-muted/10">
      <div className="flex-none px-6 py-4">
        <p className="text-sm text-muted-foreground">
          Welcome, {displayName}
        </p>
        {role !== 'Owner' && role !== 'Admin' && role !== 'Dev' && (
          <p className="text-xs text-muted-foreground mt-1">Role: {role}</p>
        )}
      </div>

      <main className="flex-1 px-6 pb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl">
          {modules.map((mod) => (
            <Link key={mod.href} href={mod.href}>
              <Card className="h-full transition-colors hover:bg-accent/50 cursor-pointer">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{mod.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{mod.description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
