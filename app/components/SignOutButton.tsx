'use client';

import { useAuth } from '@/components/providers/auth-context';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';

export function SignOutButton() {
  const { signOut } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  return (
    <Button variant="outline" size="sm" onClick={handleSignOut}>
      Sign Out
    </Button>
  );
}
