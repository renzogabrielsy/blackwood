'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Sparkles, Table2 } from 'lucide-react';

import { GRID_PARAM, GRID_V2, gridHref, isGridV2 } from '@/lib/table';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────────
// GridVersionToggle — flip a migrated screen between its two grids. PLATFORM LAYER.
//
// The universal-table migration builds each screen's new grid BESIDE its existing one
// and picks between them on `?grid=v2` (see `lib/table/grid-param.ts`). This is the
// visible control for that param, so comparing the two is a click instead of an edit to
// the address bar.
//
// **It knows nothing about any screen.** No row, no column, no module, no currency, no
// role — it reads one query param and writes it back. That is what lets the same
// component sit in a receipt ledger, a production sheet and a bag-inventory grid without
// a prop that names any of them. `scripts/verify-table-core.ts` scans this directory and
// refuses tenant vocabulary and any import that points at a page.
//
// ── The one behaviour that matters: EVERY OTHER PARAM SURVIVES ──────────────────
// A screen's URL carries its scope, its month, its search, its lens and its per-column
// filters. Flipping the grid must change the GRID and nothing else — a toggle that reset
// the filters would put two different sets of rows on the two sides and make the
// comparison worthless. `withGrid` copies the query exhaustively and only ever touches
// its own param; this component never builds a query string by hand.
//
// ── Why a Suspense boundary lives INSIDE the component ──────────────────────────
// `useSearchParams()` opts its whole client subtree out of static prerendering, and a
// page that has not opted out itself fails the production build with "useSearchParams()
// should be wrapped in a suspense boundary". The screens this gets dropped into tonight
// are not all `force-dynamic`, and a build that breaks on the ninth page is a bad way to
// find that out — so the boundary ships with the control rather than being a rule each
// caller has to remember. The fallback renders the same two segments, inert, so nothing
// moves when it resolves.
//
// TEMPORARY BY DESIGN — it is deleted with the param when the last screen cuts over.
// ─────────────────────────────────────────────────────────────────────────────────

export interface GridVersionToggleProps {
    /**
     * Optional caption in front of the segments (e.g. `"Grid"`). Omitted by default:
     * in a toolbar that already reads as chrome, two words is one word too many.
     */
    label?: string;
    className?: string;
}

const WRAP =
    'inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-background p-0.5';
const SEG =
    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150';
const IDLE = 'text-muted-foreground hover:text-foreground';

/**
 * The segmented control. Two states, and the NEW one is deliberately louder: a
 * screenshot of a bug has to say which grid produced it without anyone having to read
 * the URL, so the accent is the same amber every v2 surface already uses to announce
 * itself. The CURRENT state stays on the neutral `primary` fill the rest of the app's
 * segmented controls use, because "nothing unusual is happening" is the honest reading
 * of the production path.
 */
export function GridVersionToggle({ label, className }: GridVersionToggleProps) {
    return (
        <React.Suspense fallback={<ToggleShell label={label} className={className} />}>
            <GridVersionToggleInner label={label} className={className} />
        </React.Suspense>
    );
}

function GridVersionToggleInner({ label, className }: GridVersionToggleProps) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [pending, startTransition] = React.useTransition();

    const v2 = isGridV2(params.get(GRID_PARAM));

    const go = React.useCallback(
        (next: boolean) => {
            if (next === v2) return;
            // `params` is a `ReadonlyURLSearchParams`, which is iterable — `withGrid`
            // takes the entries and carries every one of them across.
            const href = gridHref(pathname, params.entries(), next);
            startTransition(() => {
                // `scroll: false` — the two grids show the same rows, so the compare is
                // only useful if the sheet does not jump back to the top on every flip.
                router.push(href, { scroll: false });
            });
        },
        [params, pathname, router, v2],
    );

    return (
        // Marks the control as chrome the GRID does not own, so if it is ever mounted
        // inside a Blackwood Table toolbar, Enter/Space here activates the button
        // instead of opening the selected cell for editing.
        <div
            data-grid-chrome=""
            className={cn('flex items-center gap-1.5', className)}
        >
            {label ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </span>
            ) : null}
            <div className={WRAP} role="tablist" aria-label="Table version">
                <button
                    type="button"
                    role="tab"
                    data-testid="grid-version-current"
                    aria-selected={!v2}
                    onClick={() => go(false)}
                    title="Current — the table that is live today"
                    className={cn(SEG, !v2 ? 'bg-primary text-primary-foreground' : IDLE)}
                >
                    <Table2 className="size-3" aria-hidden="true" />
                    Current
                </button>
                <button
                    type="button"
                    role="tab"
                    data-testid="grid-version-new"
                    aria-selected={v2}
                    onClick={() => go(true)}
                    title={`New — the same data on the Blackwood Table (?${GRID_PARAM}=${GRID_V2})`}
                    className={cn(
                        SEG,
                        v2
                            ? 'bg-amber-500 text-amber-950 dark:bg-amber-400 dark:text-amber-950'
                            : IDLE,
                    )}
                >
                    <Sparkles className="size-3" aria-hidden="true" />
                    New
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
 * The Suspense fallback — the control's exact geometry with no state and no handlers, so
 * the toolbar does not reflow when the real one takes over. It renders neither side as
 * selected on purpose: guessing "Current" would be right on nearly every load and
 * momentarily WRONG on a `?grid=v2` one, which is the one load where the answer matters.
 */
function ToggleShell({ label, className }: GridVersionToggleProps) {
    return (
        <div className={cn('flex items-center gap-1.5', className)} aria-hidden="true">
            {label ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </span>
            ) : null}
            <div className={cn(WRAP, 'opacity-60')}>
                <span className={cn(SEG, IDLE)}>
                    <Table2 className="size-3" />
                    Current
                </span>
                <span className={cn(SEG, IDLE)}>
                    <Sparkles className="size-3" />
                    New
                </span>
            </div>
        </div>
    );
}

export interface GridVersionBarProps {
    /** Optional caption in front of the segments. */
    label?: string;
    /** Optional sentence to the right of the control — a note, a count, a caveat. */
    note?: React.ReactNode;
    className?: string;
}

/**
 * A thin strip that carries the toggle above a table this migration may not edit.
 *
 * The reason it exists: the point of the side-by-side method is that the CURRENT table
 * is not touched, which means the toggle usually cannot go in that table's own toolbar.
 * Mounting it from the server `page.tsx` instead is one line — but only if the strip's
 * layout classes come with it. A page that gets them wrong (`shrink-0` missing, in
 * particular) squeezes the sheet below it instead of the strip, which is the exact
 * failure the "never crush, always scroll" rule exists to prevent. So the strip is part
 * of the component, not part of the recipe.
 *
 * Solid `bg-muted/40`, not glass: this is a static flex child, not a sticky surface, and
 * a `backdrop-filter` over an opaque page paints nothing while still costing a
 * compositor layer.
 */
export function GridVersionBar({ label, note, className }: GridVersionBarProps) {
    return (
        <div
            className={cn(
                'flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground',
                className,
            )}
        >
            <GridVersionToggle label={label} />
            {note ? <span className="min-w-0">{note}</span> : null}
        </div>
    );
}
