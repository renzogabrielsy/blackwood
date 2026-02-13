'use client';

import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const providers = [
  { id: 'google' as const, label: 'Sign in with Google' },
] as const;

const ERROR_MESSAGES: Record<string, string> = {
  not_invited: 'You are not on the invite list. Please contact an administrator.',
  auth_callback_error: 'Authentication failed. Please try again.',
};

export function LoginForm() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

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
        {error && ERROR_MESSAGES[error] && (
          <p className="text-sm text-destructive text-center">
            {ERROR_MESSAGES[error]}
          </p>
        )}
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
