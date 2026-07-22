'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2, Infinity as InfinityIcon, Crosshair } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    VIEW_MODES,
    VIEW_MODE_LABELS,
    type ViewMode,
    type Scope,
} from './ledger-url';

// ─── Cenapro production ledger — toolbar axis controls ───────────────────────────
// Two small segmented controls, shared by BOTH the endless-sheet toolbar and the
// editable-grid toolbar so the axis framework reads identically in every view × scope.
// Each writes ONE URL param while PRESERVING the others (view/scope/year/batch), so
// toggling a scope keeps your view + period, and switching a view keeps your scope +
// period. `useTransition` surfaces the navigation's pending state.

const SEG_WRAP = 'inline-flex h-6 items-center rounded-md border border-border/60 bg-background p-0.5';
const SEG_ACTIVE = 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900';
const SEG_IDLE = 'text-muted-foreground hover:text-foreground';

// ─── View-mode switcher (ledger | daily-w6 | daily-w7) ───────────────────────────
// Drives `?view=`. `ledger` omits the param (default → clean URL). Available in BOTH
// scopes — the switcher is never scope-exclusive.
export function ViewModeSwitcher({ mode }: { mode: ViewMode }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();

    const select = React.useCallback(
        (next: ViewMode) => {
            if (next === mode) return;
            const sp = new URLSearchParams(searchParams.toString());
            if (next === 'ledger') sp.delete('view'); // default → keep the URL clean
            else sp.set('view', next);
            const qs = sp.toString();
            startTransition(() => {
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [mode, searchParams, router, pathname],
    );

    return (
        <div className={SEG_WRAP} role="tablist" aria-label="Production view mode">
            {VIEW_MODES.map((m) => (
                <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => select(m)}
                    className={cn(
                        'h-5 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                        mode === m ? SEG_ACTIVE : SEG_IDLE,
                    )}
                >
                    {VIEW_MODE_LABELS[m]}
                </button>
            ))}
            {isPending && <Loader2 className="ml-1 mr-0.5 h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
    );
}

// ─── Scope toggle (Endless | Focus) ──────────────────────────────────────────────
// Drives `?scope=`. `endless` omits the param (default → clean URL); `focus` writes
// `?scope=focus`. Clears the legacy `?focus` param on any change (back-compat cleanup).
// Preserves `view`/`year`/`batch` so a scope switch keeps the current view + period.
export function ScopeToggle({ scope }: { scope: Scope }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();

    const select = React.useCallback(
        (next: Scope) => {
            if (next === scope) return;
            const sp = new URLSearchParams(searchParams.toString());
            sp.delete('focus'); // retire the legacy param whenever the toggle is used
            if (next === 'endless') sp.delete('scope'); // default → clean URL
            else sp.set('scope', next);
            const qs = sp.toString();
            startTransition(() => {
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [scope, searchParams, router, pathname],
    );

    return (
        <div className={SEG_WRAP} role="tablist" aria-label="Production history scope">
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'endless'}
                onClick={() => select('endless')}
                title="Endless — the full history as one continuous, cursor-guided sheet"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'endless' ? SEG_ACTIVE : SEG_IDLE,
                )}
            >
                <InfinityIcon className="h-3 w-3" />
                Endless
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'focus'}
                onClick={() => select('focus')}
                title="Focus — clamp to the selected period only"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'focus' ? SEG_ACTIVE : SEG_IDLE,
                )}
            >
                <Crosshair className="h-3 w-3" />
                Focus
            </button>
            {isPending && <Loader2 className="ml-1 mr-0.5 h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
    );
}
