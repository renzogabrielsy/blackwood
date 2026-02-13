'use client';

import { Button } from '@/components/ui/button';

export default function RCInError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <div className="flex flex-col items-center justify-center h-screen bg-muted/10 gap-4">
            <div className="text-center space-y-2">
                <h2 className="text-xl font-semibold">Something went wrong</h2>
                <p className="text-sm text-muted-foreground max-w-md">
                    {error.message || 'Failed to load deliveries. Please try again.'}
                </p>
            </div>
            <Button onClick={reset} variant="outline">
                Try again
            </Button>
        </div>
    );
}
