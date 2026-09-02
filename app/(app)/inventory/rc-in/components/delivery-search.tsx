'use client';

/**
 * The RC IN search box — the v2 grid's copy of the live table's toolbar control.
 *
 * ── Why this is a NEW file and not an extraction ──────────────────────────────
 * `delivery-master-table.tsx` is production and this module's CONTEXT says it is not
 * edited by one character, so a "pure lift" was the only extraction on offer — and it is
 * not available here. The live control carries a `{filteredData.length} found` badge that
 * counts CLIENT-side filtered rows (a concept the v2 grid does not have), and it has
 * neither a clear (×) affordance nor an Escape handler, both of which this pass adds. Any
 * one of those makes the lift impure. So the live table stays untouched and this is its
 * SIBLING: the behaviour that matters — the placeholder, the icon, the 300 ms debounce and
 * above all the `?search=` URL contract — is reproduced verbatim, and the two differences
 * are additive controls that write the same param the same way.
 *
 * ── THE URL IS THE ONLY CHANNEL ───────────────────────────────────────────────
 * There is no client-side filter here and there must never be one. `?search=` is read by
 * `app/(app)/inventory/page.tsx`, which swaps the year-bounded query for an `ilike` across
 * **supplier · batch_code · truck_plate · block_loc** over every year. A second, local
 * predicate over the rows that came back would be a second definition of "matches", and
 * the day the two disagree the sheet hides a row the server deliberately found.
 *
 * ── ALL YEARS is the SERVER'S doing, not this control's ───────────────────────
 * The live table does not touch `?year=` when a search starts, and neither does this. The
 * page drops the date bound while `search` is present and resolves the period to
 * `all` / `all`; the `?year=` already in the URL is carried across untouched by
 * `createQueryString` and comes back into force the moment the search is cleared. That is
 * exactly the live behaviour, and it is why the restore needs no code: nothing was thrown
 * away to need restoring.
 *
 * ── No `/`, no Cmd/Ctrl+K ─────────────────────────────────────────────────────
 * The live table binds neither, so neither is bound here. The Blackwood Table's keyboard
 * space is the sheet's — a printable character types over the active cell — and a global
 * `/` would steal it. Escape is bound on the INPUT only (never on the document), so it can
 * reach nothing else.
 */

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The live table's debounce, to the millisecond (`delivery-master-table.tsx`). */
export const DELIVERY_SEARCH_DEBOUNCE_MS = 300;

/** The live table's placeholder, verbatim. */
export const DELIVERY_SEARCH_PLACEHOLDER = 'Search supplier, batch, truck...';

export interface DeliverySearchProps {
    /** The `?search=` the SERVER acted on — the source of truth, not the typed text. */
    search?: string;
    className?: string;
}

export function DeliverySearch(props: DeliverySearchProps) {
    return (
        // `useSearchParams` needs a boundary of its own, the same way `PeriodPicker`
        // carries one — the fallback is the control at rest so the strip never reflows.
        <React.Suspense fallback={<SearchShell className={props.className} />}>
            <DeliverySearchInner {...props} />
        </React.Suspense>
    );
}

function SearchShell({ className }: { className?: string }) {
    return (
        <div className={cn('relative', className)}>
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
                disabled
                placeholder={DELIVERY_SEARCH_PLACEHOLDER}
                className="h-7 w-[200px] max-w-full pl-7 pr-7 text-xs sm:w-[220px]"
            />
        </div>
    );
}

function DeliverySearchInner({ search, className }: DeliverySearchProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [pending, startTransition] = React.useTransition();

    const applied = search ?? '';
    const [term, setTerm] = React.useState(applied);
    const inputRef = React.useRef<HTMLInputElement>(null);

    /**
     * `createQueryString`, verbatim from the live table: copy EVERY param the URL is
     * carrying and touch only `search`. That exhaustive copy is what keeps `?tab=`,
     * `?grid=`, `?year=`, `?month=` and the classic table's own filter params alive across
     * a search — the same rule `withPeriod` and `withGrid` obey on their own keys.
     */
    const createQueryString = React.useCallback(
        (name: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value) params.set(name, value);
            else params.delete(name);
            return params.toString();
        },
        [searchParams],
    );

    /**
     * The last value handed to `router.push`, so the debounce and the × cannot push the
     * same query twice while a navigation is still in flight (two history entries for one
     * gesture, and Back would then land on a state the operator never saw). Cleared when
     * the server's answer arrives, which is what makes a later re-search of the same term
     * legal again.
     */
    const pushedRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        pushedRef.current = null;
    }, [applied]);

    const commit = React.useCallback(
        (value: string) => {
            if (value === applied || pushedRef.current === value) return;
            pushedRef.current = value;
            startTransition(() => {
                // `scroll: false` for the same reason the period picker uses it — the rows
                // are replaced in place and a sheet that jumps to the top mid-keystroke is
                // a sheet you cannot read while typing.
                router.push(pathname + '?' + createQueryString('search', value), { scroll: false });
            });
        },
        [applied, createQueryString, pathname, router],
    );

    // The live table's effect, same shape and same 300 ms.
    React.useEffect(() => {
        const timer = setTimeout(() => commit(term), DELIVERY_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [term, commit]);

    // The URL is the source of truth: a Back/Forward, a cleared search from elsewhere or a
    // deep link has to be reflected in the box. Only when the two genuinely differ, so a
    // keystroke mid-flight is never overwritten by the value it is replacing.
    React.useEffect(() => {
        setTerm((current) => (current === applied ? current : applied));
    }, [applied]);

    const clear = React.useCallback(() => {
        setTerm('');
        commit('');
        inputRef.current?.focus({ preventScroll: true });
    }, [commit]);

    return (
        // `data-grid-chrome` marks this as a control the GRID does not own. The strip is a
        // sibling of the table rather than a descendant, so no keystroke here reaches the
        // sheet today — the marker is what keeps that true if the strip is ever moved
        // inside a toolbar slot.
        <div data-grid-chrome="" className={cn('relative', className)}>
            <Search
                className={cn(
                    'absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground transition-opacity duration-150',
                    pending && 'opacity-50',
                )}
                aria-hidden="true"
            />
            <Input
                ref={inputRef}
                type="text"
                role="searchbox"
                aria-label="Search deliveries"
                data-testid="rc-in-search"
                placeholder={DELIVERY_SEARCH_PLACEHOLDER}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    // Bound to the input, never the document — Escape inside the sheet
                    // still reverts a cell edit, which is the grid's own meaning for it.
                    e.stopPropagation();
                    if (term) {
                        e.preventDefault();
                        clear();
                    } else {
                        inputRef.current?.blur();
                    }
                }}
                className="h-7 w-[200px] max-w-full pl-7 pr-7 text-xs sm:w-[220px]"
            />
            {term ? (
                <button
                    type="button"
                    onClick={clear}
                    aria-label="Clear search"
                    data-testid="rc-in-search-clear"
                    className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3" aria-hidden="true" />
                </button>
            ) : null}
        </div>
    );
}
