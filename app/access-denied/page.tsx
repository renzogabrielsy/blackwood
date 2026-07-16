import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldX } from 'lucide-react';
import Link from 'next/link';

export const metadata = {
  title: 'Access Revoked - Blackwood',
};

export default function AccessDeniedPage() {
  return (
    <div className="flex items-center justify-center min-h-dvh bg-background">
      <Card className="p-8 max-w-md text-center">
        <ShieldX className="h-12 w-12 mx-auto text-destructive mb-4" />
        <h1 className="text-2xl font-bold mb-2">Access Revoked</h1>
        <p className="text-muted-foreground mb-6">
          Your access to this system has been disabled. Please contact an administrator if you believe this is an error.
        </p>
        <Button asChild variant="outline">
          <Link href="/login">Return to Login</Link>
        </Button>
      </Card>
    </div>
  );
}
