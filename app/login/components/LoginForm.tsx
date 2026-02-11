'use client';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const providers = [
  { id: 'google' as const, label: 'Sign in with Google' },
] as const;

export function LoginForm() {
  const handleOAuthLogin = (provider: 'google') => {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-3">
        {providers.map(({ id, label }) => (
          <Button
            key={id}
            variant="outline"
            className="w-full"
            onClick={() => handleOAuthLogin(id)}
          >
            {label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
