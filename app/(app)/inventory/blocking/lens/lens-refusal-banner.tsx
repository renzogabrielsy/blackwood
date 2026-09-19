'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE INLINE REFUSAL — persistent, copyable, and shared by every lens.
//
// The project's HARD RULE is that an error never auto-dismisses and always offers
// Copy. CLAUDE.md allows a BANNER in place of a toast for an error that belongs to
// one panel, which is exactly this: a refusal about a lens's own settings would be
// homeless as a toast the moment the panel closed.
//
// Shared rather than copied per lens, because "the error rule, as a banner" must
// have one implementation — a second copy is how one lens quietly loses its Copy
// button.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Copy, RotateCcw } from 'lucide-react';

export function RefusalBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const copy = React.useCallback(() => {
    void navigator.clipboard.writeText(message);
  }, [message]);
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-snug text-foreground">
      <p>{message}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
        >
          <Copy className="h-2.5 w-2.5" />
          Copy
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
