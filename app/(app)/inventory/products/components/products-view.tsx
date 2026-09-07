'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { errorToast } from '@/lib/toast';
import type { ProductsData, ProductsFinding } from '@/lib/products/types';
import { cn } from '@/lib/utils';

import { GradeTabs } from './grade-tabs';
import { ProductsHeader, shortDate } from './products-header';
import { ProductsLedgerGrid } from '../products-ledger-grid';

// ═════════════════════════════════════════════════════════════════════════════════
// `/inventory/products` — the client shell.
//
// Owns the page container, the portfolio line, the sync chips, the grade rail and the
// `?grade=` URL contract. Every number it renders arrived from `getProductsData()`; it
// adds none and recomputes none.
//
// ── `?grade=` IS THE SELECTION, AND IT IS OPTIMISTIC ────────────────────────────
// Deep-linkable, refresh-safe, Back returns to the previous grade — the `?block=` pattern
// from `blocking-route-view.tsx`. This route is dynamic, so writing the param costs a
// server round-trip; without the optimistic mirror a tab click would look dead for a
// second and then the whole surface would flip.
//
// The rail AND the header strip repaint on the SAME FRAME as the click, because
// `ProductsData.grades` already carries every active grade's full summary — only the
// LEDGER has to come from the server. So the wait is visible exactly where it is real:
// the tally dims, the numbers above it do not lie in the meantime.
// ═════════════════════════════════════════════════════════════════════════════════

const GRADE_PARAM = 'grade';

function int(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function tons(value: number | null): string | null {
    if (value === null) return null;
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function vans(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface ProductsViewProps {
    data: ProductsData;
}

export function ProductsView({ data }: ProductsViewProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();

    const serverCode = data.selected?.gradeCode ?? null;
    // React reverts this to the server's answer once the navigation settles, so the two
    // are only ever apart WHILE a grade change is in flight — which is exactly when the
    // rail and the header should already be showing the grade that was clicked.
    const [selectedCode, setOptimisticCode] = React.useOptimistic(serverCode);

    const shownGrade = React.useMemo(
        () => data.grades.find((g) => g.gradeCode === selectedCode) ?? data.selected,
        [data.grades, data.selected, selectedCode],
    );

    // The LEDGER is the only thing that has to wait for the server.
    const ledgerStale = selectedCode !== serverCode;

    const selectGrade = React.useCallback(
        (code: string) => {
            if (code === selectedCode) return;
            const params = new URLSearchParams(searchParams.toString());
            params.set(GRADE_PARAM, code);
            const qs = params.toString();
            startTransition(() => {
                setOptimisticCode(code);
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [pathname, router, searchParams, selectedCode, setOptimisticCode],
    );

    // Load failures: a persistent toast WITH a Copy button (HARD RULE) plus an inline
    // banner that carries its own Copy, because a toast the operator dismissed leaves no
    // trace of why the sheet is empty.
    const shownError = data.error;
    React.useEffect(() => {
        if (shownError) errorToast(shownError);
    }, [shownError]);

    const portfolio = data.portfolio;
    const syncedOn = data.syncedAt ? shortDate(data.syncedAt.slice(0, 10)) : null;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            {/* ── The whole position, in one line ─────────────────────────────── */}
            {portfolio ? (
                <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-semibold uppercase tracking-[0.06em]">All products</span>
                    <span className="font-mono tabular-nums">
                        {tons(portfolio.totalTons) ?? '—'} t on hand
                    </span>
                    <span className="font-mono tabular-nums">{int(portfolio.totalFlecs)} flec</span>
                    <span className="font-mono tabular-nums">
                        <strong className="font-semibold text-foreground">
                            {int(portfolio.finalFlecs)}
                        </strong>{' '}
                        FINAL
                    </span>
                    <span className="font-mono tabular-nums">{vans(portfolio.vansReady)} vans</span>
                    <span className="font-mono tabular-nums">
                        {int(portfolio.activeGradeCount)} grade
                        {portfolio.activeGradeCount === 1 ? '' : 's'}
                    </span>
                    <span className="font-mono tabular-nums opacity-70">
                        {int(portfolio.movementCount)} movements
                    </span>
                    {portfolio.gradesWithoutRate > 0 ? (
                        <span className="font-mono tabular-nums opacity-70">
                            {int(portfolio.gradesWithoutRate)} without a kg/flec rate
                        </span>
                    ) : null}
                    {syncedOn ? <span className="ml-auto opacity-70">Synced {syncedOn}</span> : null}
                </div>
            ) : null}

            {data.findings.length > 0 ? (
                <SyncChips findings={data.findings} runId={data.runId} />
            ) : null}

            {shownError ? <ErrorBanner message={shownError} /> : null}

            <GradeTabs
                grades={data.grades}
                selectedCode={selectedCode}
                onSelect={selectGrade}
                pending={isPending}
            />

            {shownGrade ? (
                <>
                    <ProductsHeader grade={shownGrade} syncedAt={data.syncedAt} />

                    <div
                        className={cn(
                            'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card',
                            // Compositor-only. The tally stays mounted; nothing reflows.
                            ledgerStale && 'opacity-50 transition-opacity duration-150',
                        )}
                    >
                        <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                            <strong className="text-[12px] font-semibold text-foreground">
                                Running tally
                            </strong>
                            <span className="font-mono tabular-nums">
                                {int(shownGrade.movementCount)} movement
                                {shownGrade.movementCount === 1 ? '' : 's'}
                            </span>
                            {shownGrade.lastMovementDate ? (
                                <span>last {shortDate(shownGrade.lastMovementDate)}</span>
                            ) : null}
                            <span className="opacity-70">
                                the same columns as the sheet · newest first · sort and filter from any header
                            </span>
                        </div>

                        {/* The ledger belongs to the SERVER-selected grade — never the
                            optimistic one, or a grade's rows would render under another
                            grade's name for the length of a round trip. */}
                        {data.selected ? (
                            <ProductsLedgerGrid
                                key={data.selected.gradeCode}
                                grade={data.selected}
                                rows={data.ledger}
                            />
                        ) : null}
                    </div>
                </>
            ) : (
                <div className="animate-fade-up flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No product grades yet — the daily sync will add one per tab of the PRODUCTS
                    INVENTORY sheet.
                </div>
            )}
        </div>
    );
}

/**
 * What the last sync said about the PRODUCTS INVENTORY workbook.
 *
 * READ-ONLY here, and deliberately: every action a chip could offer already exists in
 * `/sync`, and building a second door to it would be a second definition of what a
 * finding means. The chips are the SAME `flattenRunFindings` output the panel renders —
 * filtered to `section: 'products'` on the server — so they cannot disagree with it.
 */
function SyncChips({ findings, runId }: { findings: readonly ProductsFinding[]; runId: string | null }) {
    const href = runId ? `/sync/cases?run=${runId}` : '/sync';
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
            {findings.map((f) => (
                <Link
                    key={f.key}
                    href={href}
                    title={`${f.title} — open Sync Review`}
                    className={cn(
                        'inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-[11px] sm:max-w-[520px]',
                        'transition-colors duration-150',
                        f.severity === 'info'
                            ? 'border-border bg-card text-muted-foreground hover:bg-muted/60'
                            : 'border-amber-500/40 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60',
                    )}
                >
                    <span
                        aria-hidden="true"
                        className={cn(
                            'size-2 shrink-0 rounded-full',
                            f.severity === 'info' ? 'bg-muted-foreground/50' : 'bg-amber-500',
                        )}
                    />
                    <span className="shrink-0 font-semibold uppercase tracking-wide">{f.kindLabel}</span>
                    <span className="min-w-0 truncate opacity-80">{f.title}</span>
                </Link>
            ))}
        </div>
    );
}

/** Inline error with its own Copy button — the HARD RULE's non-toast half. */
function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <span className="flex-1">{message}</span>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                onClick={() => void navigator.clipboard?.writeText(message)}
            >
                <Copy className="size-3" />
                Copy
            </Button>
        </div>
    );
}
