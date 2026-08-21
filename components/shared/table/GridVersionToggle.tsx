'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Sparkles, Table2 } from 'lucide-react';

import { GRID_PARAM, GRID_V1, GRID_V2, gridHref, resolveGrid } from '@/lib/table';
import type { GridVersion } from '@/lib/table';
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
// ── A flipped page (2026-08-21) ─────────────────────────────────────────────────
// A screen whose default is now the NEW grid (`defaultVersion="v2"`) still gets the same
// two segments — what changes is which side is the paramless URL, so the control keeps
// writing the shortest URL that means what it says. The labels are props rather than a
// branch on the version, because "Current" is a claim about a particular page's state,
// not a fact about the module, and a flipped page has to be able to say something honest
// ("Classic") without this component learning what any screen is.
//
// The SEGMENT ORDER never changes, deliberately: an operator comparing two screens in two
// browser tabs should not find the buttons swapped between them. The amber accent stays
// on the v2 side on every page, so a screenshot still says which grid produced it without
// anyone reading the URL.
//
// TEMPORARY BY DESIGN — it is deleted with the param when the last screen cuts over.
// ─────────────────────────────────────────────────────────────────────────────────

export interface GridVersionToggleProps {
    /**
     * Optional caption in front of the segments (e.g. `"Grid"`). Omitted by default:
     * in a toolbar that already reads as chrome, two words is one word too many.
     */
    label?: string;
    /**
     * Which grid this page shows when the URL says nothing. Defaults to `'v1'` — today's
     * behaviour on every screen that does not pass it, byte for byte.
     */
    defaultVersion?: GridVersion;
    /** Label on the OLD grid's segment. `'Current'` unless the page has flipped. */
    currentLabel?: string;
    /** Label on the NEW grid's segment. `'New'` unless the page has flipped. */
    newLabel?: string;
    className?: string;
}

const WRAP =
    'inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-background p-0.5';
const SEG =
    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150';
const IDLE = 'text-muted-foreground hover:text-foreground';

/**
 * The wording a screen that has NOT flipped uses. Kept as constants so the control and
 * its Suspense shell cannot drift apart, and so "the default labels" is one edit.
 */
const DEFAULT_CURRENT_LABEL = 'Current';
const DEFAULT_NEW_LABEL = 'New';

/**
 * The segmented control. Two states, and the NEW one is deliberately louder: a
 * screenshot of a bug has to say which grid produced it without anyone having to read
 * the URL, so the accent is the same amber every v2 surface already uses to announce
 * itself. The CURRENT state stays on the neutral `primary` fill the rest of the app's
 * segmented controls use, because "nothing unusual is happening" is the honest reading
 * of the production path.
 */
export function GridVersionToggle(props: GridVersionToggleProps) {
    return (
        <React.Suspense fallback={<ToggleShell {...props} />}>
            <GridVersionToggleInner {...props} />
        </React.Suspense>
    );
}

function GridVersionToggleInner({
    label,
    defaultVersion = GRID_V1,
    currentLabel = DEFAULT_CURRENT_LABEL,
    newLabel = DEFAULT_NEW_LABEL,
    className,
}: GridVersionToggleProps) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [pending, startTransition] = React.useTransition();

    const v2 = resolveGrid(params.get(GRID_PARAM), defaultVersion) === GRID_V2;

    const go = React.useCallback(
        (next: boolean) => {
            if (next === v2) return;
            // `params` is a `ReadonlyURLSearchParams`, which is iterable — `withGrid`
            // takes the entries and carries every one of them across. The default is
            // passed so the paramless URL always means this page's default.
            const href = gridHref(pathname, params.entries(), next, defaultVersion);
            startTransition(() => {
                // `scroll: false` — the two grids show the same rows, so the compare is
                // only useful if the sheet does not jump back to the top on every flip.
                router.push(href, { scroll: false });
            });
        },
        [defaultVersion, params, pathname, router, v2],
    );

    const flipped = defaultVersion === GRID_V2;

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
                    title={
                        flipped
                            ? `${currentLabel} — the previous table, still fully working (?${GRID_PARAM}=${GRID_V1})`
                            : `${currentLabel} — the table that is live today`
                    }
                    className={cn(SEG, !v2 ? 'bg-primary text-primary-foreground' : IDLE)}
                >
                    <Table2 className="size-3" aria-hidden="true" />
                    {currentLabel}
                </button>
                <button
                    type="button"
                    role="tab"
                    data-testid="grid-version-new"
                    aria-selected={v2}
                    onClick={() => go(true)}
                    title={
                        flipped
                            ? `${newLabel} — the Blackwood Table, this page's default`
                            : `${newLabel} — the same data on the Blackwood Table (?${GRID_PARAM}=${GRID_V2})`
                    }
                    className={cn(
                        SEG,
                        v2
                            ? 'bg-amber-500 text-amber-950 dark:bg-amber-400 dark:text-amber-950'
                            : IDLE,
                    )}
                >
                    <Sparkles className="size-3" aria-hidden="true" />
                    {newLabel}
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
function ToggleShell({
    label,
    currentLabel = DEFAULT_CURRENT_LABEL,
    newLabel = DEFAULT_NEW_LABEL,
    className,
}: GridVersionToggleProps) {
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
                    {currentLabel}
                </span>
                <span className={cn(SEG, IDLE)}>
                    <Sparkles className="size-3" />
                    {newLabel}
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
    /**
     * Chrome pinned to the FAR RIGHT of the same strip — a period picker, a scope toggle,
     * a count. It exists so a page does not have to stack a second bar under this one to
     * put one more control on screen: two strips of chrome above a dense sheet is two
     * rows of the sheet the operator no longer sees, and the strip already owns its own
     * layout for exactly this reason (see the note on the component below).
     *
     * Rendered inside an `ml-auto` group, so it is right-aligned when the note is short
     * and wraps beneath rather than crushing it when the note is long.
     */
    trailing?: React.ReactNode;
    /** Which grid this page shows when the URL says nothing. Defaults to `'v1'`. */
    defaultVersion?: GridVersion;
    /** Label on the OLD grid's segment. `'Current'` unless the page has flipped. */
    currentLabel?: string;
    /** Label on the NEW grid's segment. `'New'` unless the page has flipped. */
    newLabel?: string;
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
export function GridVersionBar({
    label,
    note,
    trailing,
    defaultVersion,
    currentLabel,
    newLabel,
    className,
}: GridVersionBarProps) {
    return (
        <div
            className={cn(
                'flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground',
                className,
            )}
        >
            <GridVersionToggle
                label={label}
                defaultVersion={defaultVersion}
                currentLabel={currentLabel}
                newLabel={newLabel}
            />
            {note ? <span className="min-w-0">{note}</span> : null}
            {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
        </div>
    );
}
