'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Inline error banner for a failed data load.
 *
 * CLAUDE.md HARD RULE: every error surface persists until dismissed AND carries a
 * Copy button, so the text can be pasted into a Claude chat without a screenshot.
 * This is the inline (non-toast) form of that rule.
 */
export function LoadError({ message }: { message: string }) {
    const [copied, setCopied] = useState(false);

    return (
        <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-destructive">{message}</p>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive"
                onClick={() => {
                    void navigator.clipboard.writeText(message).then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                    });
                }}
            >
                {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
            </Button>
        </div>
    );
}
