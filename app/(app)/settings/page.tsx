import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { SignOutButton } from './components/SignOutButton';
import { Badge } from '@/components/ui/badge';

function getInitials(name: string | null, email: string | null): string {
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) {
    return email[0].toUpperCase();
  }
  return '?';
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user!.id)
    .single();

  const displayName = profile?.display_name || 'User';
  const email = profile?.email || user?.email || '';
  const role = profile?.role || 'Production';
  const avatarUrl = profile?.avatar_url;
  const initials = getInitials(displayName, email);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-muted/10">
      <main className="flex-1 px-4 md:px-6 py-4 md:py-6 overflow-auto">
        <div className="max-w-2xl mx-auto w-full space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">Manage your account preferences</p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Your personal information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-4">
                <Avatar className="h-20 w-20">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback className="text-lg bg-muted text-muted-foreground">{initials}</AvatarFallback>
                </Avatar>
                <div className="space-y-1">
                  <h3 className="font-medium text-lg">{displayName}</h3>
                  <p className="text-sm text-muted-foreground">{email}</p>
                </div>
              </div>

              <div className="grid gap-1">
                <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Current Role
                </label>
                <div className="flex items-center mt-1.5">
                  <Badge variant="outline" className="text-sm px-3 py-1 font-normal">
                    {role}
                  </Badge>
                </div>
                <p className="text-[13px] text-muted-foreground mt-1.5">
                  Contact an administrator to change your role permissions.
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <SignOutButton />
          </div>
        </div>
      </main>
    </div>
  );
}
