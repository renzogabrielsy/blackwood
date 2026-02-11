import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SignOutButton } from './components/SignOutButton';

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
    <div className="flex min-h-screen flex-col bg-muted/10">
      <header className="flex-none border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Blackwood</h1>
            <p className="text-sm text-muted-foreground">
              Welcome, {displayName}
            </p>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="flex-1 p-6">
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
