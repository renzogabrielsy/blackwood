'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Crosshair, Infinity as InfinityIcon, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Scope } from './ledger-url';

// ─────────────────────────────────────────────────────────────────────────────────
// The SCOPE toggle for the v2 grid — endless ⇄ focus, over `?scope=`. TENANT code.
//
// `?scope=endless|focus` is this screen's own axis (`ledger-url.ts`), not a platform
// one: "the whole history as one cursor-guided sheet" vs "one month, day-grouped with
// totals" is a fact about a receipt ledger, so the control lives here rather than in
// `components/shared/table/`.
//
// ── Why a second component instead of the ledger's own toggle ───────────────────
// `deliveries-ledger.tsx` is the production path and this migration does not edit it by
// one character, so its `ScopeToggle` (module-private, and wired to that component's
// unsaved-work guard) is not reachable from the page. This is the same control's
// BEHAVIOUR — same two segments, same wording, and the same param rule — mounted from
// `page.tsx` into the grid bar's `trailing` slot, above whichever grid rendered. It is
// rendered ONLY on the v2 branch: the Classic table keeps its own, and two toggles over
// one param is two things that can disagree.
//
// ── The param rule, copied verbatim from the ledger's `setScope` ────────────────
//   endless → DELETE the param (the default, and the clean URL)
//   focus   → `?scope=focus`
// Nothing else is touched. The period (`?year=`/`?month=`), the lens, the search and
// every `f_<column>` filter are carried across, because the two scopes are two views of
// the SAME cut of the ledger — and because `?year=`/`?month=` surviving a flip to endless
// is precisely what lets a flip BACK to focus land on the month you left.
//
// ── Why a Suspense boundary lives inside the component ─────────────────────────
// `useSearchParams()` opts its whole client subtree out of static prerendering. This page
// is `force-dynamic`, so it would build either way — but the boundary ships with the
// control rather than being a rule the page has to remember, exactly as `PeriodPicker`
// and `GridVersionToggle` do. The fallback renders the same two segments, inert, so
// nothing moves when it resolves.
//
// ── What it deliberately does NOT do ───────────────────────────────────────────
// It does not guard unsaved work. The ledger's own toggle does, because it lives INSIDE
// the component that holds the edits; a control mounted in the page above the grid cannot
// see them. That is already true of `GridVersionBar` and `PeriodPicker` on every migrated
// screen, so this control behaves like its two neighbours in the same strip rather than
// like the one it replaces. Save before you change the view.
// ─────────────────────────────────────────────────────────────────────────────────

/** The URL param this control owns. The parser's half is `parseScope` in `ledger-url.ts`. */
const SCOPE_PARAM = 'scope';

export interface DeliveriesScopeToggleProps {
    /**
     * The RESOLVED scope the page is showing. Passed down rather than re-read from the
     * URL: a page that parses the param and a control that parses the param are two
     * answers to one question, and the day they disagree the toggle lights `Focus` while
     * the sheet pages endlessly.
     */
    scope: Scope;
    className?: string;
}

const WRAP =
    'inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-background p-0.5';
const SEG =
    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150';
const ACTIVE = 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900';
const IDLE = 'text-muted-foreground hover:text-foreground';

const ENDLESS_TITLE = 'Endless — the whole history as one continuous, cursor-guided sheet';
const FOCUS_TITLE = 'Focus — one month, day-grouped, with day totals and a month footer';

export function DeliveriesScopeToggle(props: DeliveriesScopeToggleProps) {
    return (
        <React.Suspense fallback={<ScopeShell {...props} />}>
            <ScopeToggleInner {...props} />
        </React.Suspense>
    );
}

function ScopeToggleInner({ scope, className }: DeliveriesScopeToggleProps) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [pending, startTransition] = React.useTransition();

    const go = React.useCallback(
        (next: Scope) => {
            if (next === scope) return;
            // Exhaustive, order-preserving copy — the same clause `withGrid` and
            // `withPeriod` are built around. `append`, so a legitimately repeated param
            // survives as a repeat.
            const out = new URLSearchParams();
            for (const [key, value] of params.entries()) {
                if (key === SCOPE_PARAM) continue;
                out.append(key, value);
            }
            // `endless` is the default and OMITS the param, so the default state of this
            // screen stays its clean URL.
            if (next === 'focus') out.append(SCOPE_PARAM, next);
            const qs = out.toString();
            startTransition(() => {
                // `scroll: false` — changing the scope replaces the rows in place, and a
                // sheet that jumps to the top on every flip is one you cannot compare a
                // month against the run of history in.
                router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [params, pathname, router, scope],
    );

    return (
        // Marks the control as chrome the GRID does not own, so if it is ever mounted
        // inside a Blackwood Table toolbar, Enter/Space here activates the button instead
        // of opening the selected cell for editing.
        <div data-grid-chrome="" className={cn('flex items-center gap-1.5', className)}>
            <div className={WRAP} role="tablist" aria-label="Receipt history scope">
                <button
                    type="button"
                    role="tab"
                    data-testid="delivery-scope-endless"
                    aria-selected={scope === 'endless'}
                    onClick={() => go('endless')}
                    title={ENDLESS_TITLE}
                    className={cn(SEG, scope === 'endless' ? ACTIVE : IDLE)}
                >
                    <InfinityIcon className="size-3" aria-hidden="true" />
                    Endless
                </button>
                <button
                    type="button"
                    role="tab"
                    data-testid="delivery-scope-focus"
                    aria-selected={scope === 'focus'}
                    onClick={() => go('focus')}
                    title={FOCUS_TITLE}
                    className={cn(SEG, scope === 'focus' ? ACTIVE : IDLE)}
                >
                    <Crosshair className="size-3" aria-hidden="true" />
                    Focus
                </button>
            </div>
            {pending ? (
                <Loader2
                    className="size-3 shrink-0 animate-spin text-muted-foreground"
                    aria-hidden="true"
                />
            ) : null}
        </div>
    );
}

/**
 * The Suspense fallback — the control's exact geometry with no handlers, so the strip does
 * not reflow when the real one takes over. It renders the SELECTION, which it can: the
 * scope arrives as a prop rather than being read from the URL, so there is nothing to
 * guess and nothing to get momentarily wrong.
 */
function ScopeShell({ scope, className }: DeliveriesScopeToggleProps) {
    return (
        <div className={cn('flex items-center gap-1.5', className)} aria-hidden="true">
            <div className={cn(WRAP, 'opacity-60')}>
                <span className={cn(SEG, scope === 'endless' ? ACTIVE : IDLE)}>
                    <InfinityIcon className="size-3" />
                    Endless
                </span>
                <span className={cn(SEG, scope === 'focus' ? ACTIVE : IDLE)}>
                    <Crosshair className="size-3" />
                    Focus
                </span>
            </div>
        </div>
    );
}
