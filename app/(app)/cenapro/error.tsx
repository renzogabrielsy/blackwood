'use client';

import { Button } from '@/components/ui/button';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

export default function CenaproError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const message = error.message || 'Failed to load Cenapro data. Please try again.';
    const copyText = error.digest ? `${message}\n\nDigest: ${error.digest}` : message;

    return (
        <div className="flex flex-col items-center justify-center h-full bg-muted/10 gap-4 p-6">
            <div className="text-center space-y-2 max-w-lg">
                <h2 className="text-xl font-semibold">Something went wrong</h2>
                <p className="text-sm text-muted-foreground break-words">{message}</p>
                <p className="text-xs text-muted-foreground/70">
                    Try again in a moment. If it keeps happening, copy the details below and send them over.
                </p>
            </div>
            <div className="flex items-center gap-2">
                <Button onClick={reset} variant="outline" size="sm">
                    Try again
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        void navigator.clipboard.writeText(copyText).then(() => {
                            toast.success('Error copied to clipboard', { duration: 2000 });
                        });
                    }}
                >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy
                </Button>
            </div>
        </div>
    );
}
