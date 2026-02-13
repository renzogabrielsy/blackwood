'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/providers/auth-context';

export function SignOutButton() {
    const { signOut } = useAuth();
    const router = useRouter();

    const handleSignOut = async () => {
        await signOut();
        router.push('/login');
    };

    return (
        <Button variant="destructive" className="w-full sm:w-auto" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
        </Button>
    );
}
