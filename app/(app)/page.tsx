import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, role')
    .eq('id', user!.id)
    .single();

  const displayName = profile?.display_name ?? user!.email ?? 'User';

  const modules = [
    { name: 'RC IN', href: '/rc-in', description: 'Raw charcoal receiving & delivery logs' },
    { name: 'Settings', href: '/settings', description: 'User management & role assignments' },
  ];

  return (
    <div className="flex flex-col flex-1 bg-muted/10">
      <div className="flex-none px-6 py-4">
        <p className="text-sm text-muted-foreground">
          Welcome, {displayName}
        </p>
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
