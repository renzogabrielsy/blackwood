'use client';

import * as React from 'react';

import type { ProductGrade } from '@/lib/products/types';
import { stageDot } from '../products-ledger-grid';
import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// The header strip — FLEC-FIRST.
//
// Renzo, on Option A: *"I would prefer the header info to be more flecon amount forward
// (the final and shippable flecon bag amounts, with the total vans as an additional info
// and the total tons as some kind of subtext)."*
//
// So the hero is SHIPPABLE FLECS (`view_product_onhand.final_flecs`, = FINAL) in the
// biggest type on the page; VANS READY rides beside it as secondary; and the tonnage —
// which the mockup led with — drops to a muted subtext line. Every figure is the
// database's; this file formats and lays out, and computes nothing.
// ═════════════════════════════════════════════════════════════════════════════════

const FLEC_PER_VAN = 44;

/** Tons: 2 decimals minimum, 3 maximum — so 32.45, 212.04 and 20.125 all read true. */
function tons(value: number | null): string | null {
    if (value === null) return null;
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function int(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Vans are deliberately FRACTIONAL — rounding away half a van throws away the point. */
function vans(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `2026-09-05` → `05 Sep 2026`, by slicing — never `new Date()`, which moves a day. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso: string | null): string | null {
    if (!iso || iso.length < 10) return null;
    const m = Number(iso.slice(5, 7));
    if (!MON[m - 1]) return iso;
    return `${iso.slice(8, 10)} ${MON[m - 1]} ${iso.slice(0, 4)}`;
}

const Cap = ({ children }: { children: React.ReactNode }) => (
    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {children}
    </span>
);

const Unit = ({ children }: { children: React.ReactNode }) => (
    <span className="mr-1.5 text-[10px] font-normal text-muted-foreground/70">{children}</span>
);

export interface ProductsHeaderProps {
    grade: ProductGrade;
    /** `ingestion_watermarks.products.last_run_at` — when the sheet was last read. */
    syncedAt: string | null;
}

export function ProductsHeader({ grade, syncedAt }: ProductsHeaderProps) {
    const t = tons(grade.totalTons);
    const thresholds: string[] = [];
    if (grade.thresholds.ashMax !== null) thresholds.push(`ash ≤ ${grade.thresholds.ashMax}`);
    if (grade.thresholds.me50Under !== null) thresholds.push(`50 me under ${grade.thresholds.me50Under}`);
    if (grade.thresholds.vmMax !== null) thresholds.push(`VM max ${grade.thresholds.vmMax}`);

    const openingOn = shortDate(grade.openingAsOf);
    const lastMove = shortDate(grade.lastMovementDate);
    const syncedOn = syncedAt ? shortDate(syncedAt.slice(0, 10)) : null;

    return (
        <div className="animate-fade-up flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {/* ── The hero + the stage strip. Scrolls sideways rather than crushing. ── */}
            <div className="flex items-stretch overflow-x-auto">
                {/* HERO — shippable flecs, the biggest type on the page. */}
                <div className="flex min-w-[228px] shrink-0 flex-col justify-center gap-0.5 border-r border-border bg-muted/60 px-4 py-3">
                    <Cap>
                        {grade.displayName} · shippable
                    </Cap>
                    <span className="font-mono text-[34px] font-semibold leading-none tracking-tight">
                        <Unit>flec</Unit>
                        {int(grade.finalFlecs)}
                    </span>
                    {/* TONS as subtext, exactly as asked. NULL tonnage renders a reason,
                        never a zero — "we do not know the fill" is a different answer. */}
                    <span className="font-mono text-[11px] text-muted-foreground">
                        {t ? `${t} t on hand` : 'tonnage unknown — no kg/flec recorded yet'}
                        {' · '}
                        {int(grade.totalFlecs)} flec total
                        {grade.kgPerFlec !== null ? ` · ${int(grade.kgPerFlec)} kg / flec` : ''}
                    </span>
                </div>

                {/* VANS — the additional info beside the hero. */}
                <div className="flex min-w-[128px] shrink-0 flex-col justify-center gap-0.5 border-r border-border/60 px-4 py-3">
                    <Cap>Vans ready</Cap>
                    <span className="font-mono text-[22px] font-semibold leading-none">
                        {vans(grade.vansReady)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                        × {FLEC_PER_VAN} flec / van
                    </span>
                </div>

                {/* THE STAGE STRIP — one cell per stage that actually holds something. */}
                {grade.stages.map((cell) => {
                    const st = tons(cell.tons);
                    return (
                        <div
                            key={cell.stage}
                            className="flex min-w-[104px] shrink-0 flex-col justify-center gap-0.5 border-r border-border/40 px-3 py-3"
                        >
                            <span className="flex items-center gap-1.5">
                                <span
                                    aria-hidden="true"
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ background: stageDot(cell.stage) }}
                                />
                                <Cap>{cell.stage}</Cap>
                            </span>
                            <span
                                className={cn(
                                    'font-mono text-[19px] leading-none',
                                    cell.stage === 'FINAL' && 'font-semibold',
                                )}
                            >
                                <Unit>flec</Unit>
                                {int(cell.flecs)}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground">
                                {st ? `${st} t` : '—'}
                            </span>
                        </div>
                    );
                })}

                {/* Thresholds + the two dates. Quiet, right-hand, never a headline. */}
                <div className="flex min-w-[190px] flex-1 shrink-0 flex-col justify-center gap-1 px-4 py-3 text-[11px] text-muted-foreground">
                    {thresholds.length > 0 ? (
                        <span className="font-mono">{thresholds.join(' · ')}</span>
                    ) : (
                        <span className="font-mono opacity-60">no thresholds recorded</span>
                    )}
                    {openingOn ? <span>Opening as of {openingOn}</span> : null}
                    {lastMove ? <span>Last movement {lastMove}</span> : null}
                    {syncedOn ? <span className="opacity-70">Synced {syncedOn}</span> : null}
                </div>
            </div>

            <ProductsSourceNotes grade={grade} />
        </div>
    );
}

/**
 * The two SOURCE defects, said ONCE per grade and only when they apply to this one.
 *
 * Neither is an error in the app and neither is painted red. The tab's own printed
 * running cells disagree with a cumulative sum of the tab's own delta column; which side
 * is right was settled independently — the tab's header-block totals agree with our
 * arithmetic on all twelve non-zero (grade, stage) pairs exactly. And four 2X6 rows carry
 * a `2025-07-29` date that is almost certainly a `2026` year typo, deliberately NOT
 * corrected and affecting no balance.
 */
function ProductsSourceNotes({ grade }: { grade: ProductGrade }) {
    const notes: React.ReactNode[] = [];

    if (grade.sheetRunningDisagreementCount > 0) {
        // A `~` on EVERY row separates nothing, so the tally draws none when the drift is
        // total — and this sentence is then the whole message rather than a caption for a
        // mark that is everywhere. See `products-ledger-grid.tsx` → `showDriftMarker`.
        const everyRow = grade.sheetRunningDisagreementCount >= grade.movementCount;
        notes.push(
            <span key="running">
                The sheet&rsquo;s own running column drifts on{' '}
                <strong className="font-semibold">
                    {everyRow
                        ? `every one of its ${int(grade.movementCount)}`
                        : `${int(grade.sheetRunningDisagreementCount)} of ${int(grade.movementCount)}`}
                </strong>{' '}
                rows
                {everyRow ? (
                    <> &mdash; so no per-row mark is drawn, it would single out nothing</>
                ) : (
                    <>
                        {' '}
                        (marked <span className="font-mono">~</span>)
                    </>
                )}
                . The balances shown here are computed from the sheet&rsquo;s own deltas and match
                its header totals exactly.
            </span>,
        );
    }
    if (grade.dateOutOfOrderCount > 0) {
        notes.push(
            <span key="dates">
                <strong className="font-semibold">{int(grade.dateOutOfOrderCount)}</strong>{' '}
                {grade.dateOutOfOrderCount === 1 ? 'row is' : 'rows are'} dated earlier than the row
                above (a likely year typo). Flagged, never corrected &mdash; no balance is affected.
            </span>,
        );
    }
    if (grade.otherFlecs !== 0) {
        notes.push(
            <span key="other">
                <strong className="font-semibold">{int(grade.otherFlecs)} flec</strong> sit in a stage
                this page has no column for. Counted in the total; worth adding a column.
            </span>,
        );
    }
    if (grade.movementsMissingKg > 0) {
        notes.push(
            <span key="kg">
                <strong className="font-semibold">{int(grade.movementsMissingKg)}</strong>{' '}
                {grade.movementsMissingKg === 1 ? 'movement records' : 'movements record'} no kg &mdash;
                those cells are blank, not zero.
            </span>,
        );
    }
    if (grade.kgPerFlecDistinctCount > 1) {
        notes.push(
            <span key="rate">
                This grade has used{' '}
                <strong className="font-semibold">{grade.kgPerFlecDistinctCount} different</strong>{' '}
                kg/flec rates; the figure above is the latest
                {grade.kgPerFlecAsOf ? ` (${shortDate(grade.kgPerFlecAsOf)})` : ''}.
            </span>,
        );
    }

    if (notes.length === 0) return null;

    return (
        <div className="flex flex-col gap-0.5 border-t border-border/60 bg-muted/25 px-4 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {notes}
        </div>
    );
}
