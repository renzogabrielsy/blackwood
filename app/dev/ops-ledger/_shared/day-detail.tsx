'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { GRADES, WASTE_STREAMS, type LedgerDay } from '../_mock/types';
import { hours, kg, pctFromFraction, php } from './format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE DAY BREAKDOWN — Renzo's "later" item, prototyped now because where it opens is a
// LAYOUT decision and the three drafts are here to make that decision arguable.
//
// Renzo: *"I'd like to be able to drop down on single-row dates to see a breakdown of
// production, like the stats of the second shift and so on."*
//
// The CONTENT is identical in all three drafts, so it lives here once. What differs is the
// CONTAINER, and that is the thing to compare:
//
//   A — child ROWS inside the sheet, so the breakdown lands in the grid's own coordinate
//       space and can be copied out with the day above it;
//   B — a SIDE PANEL, so the ledger never moves under the reader's eye;
//   C — an inline PANEL beneath the row, so the day and its shifts share one viewport.
//
// Two shifts is what the plant runs, so these are cards rather than a table: a table of two
// rows is a table for no reason, and cards let each shift carry its downtime sentence at
// full width instead of truncating it into a cell.
// ═════════════════════════════════════════════════════════════════════════════════

export interface ShiftCardsProps {
    day: LedgerDay;
    canViewPrices: boolean;
    className?: string;
}

export function ShiftCards({ day, canViewPrices, className }: ShiftCardsProps) {
    if (day.restDay) {
        return (
            <div className={cn('px-3 py-4 text-xs text-muted-foreground', className)}>
                {day.date} · {day.day} — rest day. The plant did not run, and that is why the
                row is blank rather than missing.
            </div>
        );
    }

    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                {day.shiftDetail.map((s) => {
                    const shiftYield = s.fedKg > 0 ? s.producedKg / s.fedKg : null;
                    return (
                        <div key={s.shift} className="rounded-md border border-border bg-card p-2.5">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-semibold">SHIFT {s.shift}</span>
                                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                    {s.window}
                                </span>
                            </div>
                            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                                {s.supervisor}
                            </div>

                            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                                <Stat label="Fed" value={`${kg(s.fedKg)} kg`} />
                                <Stat label="Produced" value={`${kg(s.producedKg)} kg`} />
                                <Stat label="Yield" value={pctFromFraction(shiftYield, 2)} />
                                <Stat label="Downtime" value={`${hours(s.dtHours)} h`} />
                            </dl>

                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-1.5 font-mono text-[10px] tabular-nums">
                                {GRADES.map((g) => (
                                    <span key={g} className="text-muted-foreground">
                                        {g}{' '}
                                        <span className="text-foreground">{kg(s.producedByGrade[g]) || '—'}</span>
                                    </span>
                                ))}
                            </div>

                            {s.dtReason ? (
                                <p className="mt-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                                    {s.dtReason}
                                </p>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {/* The eight recorded streams, as one dense line. They are day-level in the
                source, not per shift — so presenting them per shift would be an invention. */}
            <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Recorded waste — day total
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
                    {WASTE_STREAMS.map((w) => (
                        <span key={w.key} className="text-muted-foreground">
                            {w.label} <span className="text-foreground">{kg(day.waste[w.key]) || '—'}</span>
                        </span>
                    ))}
                </div>
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                    These eight do NOT sum to the day’s {kg(day.lossKg)} kg of loss — most of the
                    loss leaves as moisture and volatiles, which nobody weighs.
                </p>
            </div>

            {canViewPrices && day.fedPhpKg !== null ? (
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    FED ₱/KG {php(day.fedPhpKg)} · DAY VALUE ₱{php(day.fedKg * day.fedPhpKg)}
                </div>
            ) : null}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
        </div>
    );
}

// ─── BLOCKS USED ─────────────────────────────────────────────────────────────────

const STATE_TINT: Record<string, string> = {
    // OPAQUE tokens. These cells can sit under a pinned column in draft C, and any alpha
    // lets the scrolling rows bleed through (CLAUDE.md → "Frozen Panes").
    'IN-USE': 'bg-blue-100 text-blue-950 dark:bg-blue-950 dark:text-blue-50',
    CLOSED: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-50',
    STORED: 'bg-muted text-foreground',
};

export interface BlocksUsedTableProps {
    day: LedgerDay;
    className?: string;
}

/**
 * The day's BLOCKS USED panel — the eight columns of Renzo's sheet, as a real table.
 *
 * This is the part of the ledger that CANNOT be columns on the day row: several blocks per
 * day means several rows per day, and the whole reason "Blocks fed" (one column per block)
 * exists as an alternative lens is that it flattens exactly this into the day row at the
 * cost of a very wide sheet.
 */
export function BlocksUsedTable({ day, className }: BlocksUsedTableProps) {
    if (day.blocks.length === 0) return null;

    return (
        // MIN-WIDTH = Σ of the column minimums, inside an `overflow-x-auto` wrapper.
        <div className={cn('overflow-x-auto', className)}>
            <table className="table-fixed text-xs" style={{ width: '100%', minWidth: 716 }}>
                <colgroup>
                    <col width={148} />
                    <col width={72} />
                    <col width={96} />
                    <col width={96} />
                    <col width={72} />
                    <col width={80} />
                    <col width={88} />
                    <col width={80} />
                </colgroup>
                <thead>
                    <tr className="border-b border-border bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <Th>Batch</Th>
                        <Th>Block loc</Th>
                        <Th>Date open</Th>
                        <Th>Date close</Th>
                        <Th>State</Th>
                        <Th right>Fed wt kg</Th>
                        <Th right>Arrv wt kg</Th>
                        <Th right>Resiko kg</Th>
                    </tr>
                </thead>
                <tbody>
                    {day.blocks.map((b) => (
                        <tr
                            key={`${day.date}:${b.batchCode}`}
                            className="h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/40"
                        >
                            <td className="truncate px-2 py-1 font-mono">{b.batchCode}</td>
                            <td className="truncate px-2 py-1 font-mono">{b.blockLoc}</td>
                            <td className="px-2 py-1 font-mono tabular-nums text-muted-foreground">{b.dateOpen}</td>
                            <td className="px-2 py-1 font-mono tabular-nums text-muted-foreground">
                                {b.dateClose ?? '—'}
                            </td>
                            <td className="px-2 py-1">
                                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', STATE_TINT[b.state])}>
                                    {b.state}
                                </span>
                            </td>
                            <td className="px-2 py-1 text-right font-mono tabular-nums">{kg(b.fedKg)}</td>
                            <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                                {kg(b.arrivedKg)}
                            </td>
                            <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                                {kg(b.resikoKg) || '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="h-8 border-t border-border bg-muted/60 font-medium">
                        <td className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" colSpan={5}>
                            {day.blocks.length} block{day.blocks.length === 1 ? '' : 's'} drawn from
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">
                            {kg(day.blocks.reduce((s, b) => s + b.fedKg, 0))}
                        </td>
                        <td />
                        <td />
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
    return (
        <th className={cn('h-7 px-2 py-1 font-medium', right ? 'text-right' : 'text-left')}>
            {children}
        </th>
    );
}
