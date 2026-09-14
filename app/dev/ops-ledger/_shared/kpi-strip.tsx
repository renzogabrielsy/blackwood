'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { CampaignRollup } from '../_mock/types';
import { count, hours, php, pctFromFraction, phpM, tons } from './format';

// ═════════════════════════════════════════════════════════════════════════════════
// The GROUP KPI STRIP — requirement (3)'s "stats for the group created", once.
//
// Six tiles, because six is what a person reads in a glance and nine is what they scan.
// The rest of the EOQ tab is not dropped — it rides on the meta line underneath, which is
// where a figure you check rather than watch belongs.
//
// TWO RULES IT OBEYS THAT ARE EASY TO GET WRONG:
//
//   • ₱ TILES ARE ABSENT, NOT BLANK, for a viewer who may not see prices. A blanked tile
//     still says "there is a number here you are not allowed to see", and in the live app
//     the field would not even be in the payload. `carriesPrice` is filtered before the
//     array is mapped, so the strip simply has four tiles.
//   • `stagger-children` IS ALLOWED HERE and nowhere near the sheet. CLAUDE.md permits it
//     on dashboard-card groups and forbids it on anything rendering 100+ instances; six
//     tiles is the case it was written for, ~120 day rows is the case it was written
//     against.
// ═════════════════════════════════════════════════════════════════════════════════

interface Tile {
    key: string;
    label: string;
    value: string;
    unit: string;
    /** The small second line — what the figure is measured against. */
    note?: string;
    carriesPrice?: boolean;
    /** Emphasis: the two figures the owner actually steers by. */
    lead?: boolean;
}

function tilesFor(r: CampaignRollup): Tile[] {
    return [
        { key: 'fed', label: 'RC FED', value: tons(r.rcFedKg), unit: 't', note: `${count(r.workingDays)} working days` },
        { key: 'produced', label: 'PRODUCED', value: tons(r.producedKg), unit: 't', note: `${tons(r.lossKg)} t lost in process` },
        { key: 'yield', label: 'YIELD', value: pctFromFraction(r.yieldPct, 2), unit: '', note: 'produced ÷ fed', lead: true },
        { key: 'resiko', label: 'BLOCK RESIKO', value: tons(r.blockResikoKg), unit: 't', note: `${count(r.blocksClosed)} of ${count(r.blocksOpened)} blocks closed` },
        { key: 'fedprice', label: 'FED PRICE', value: php(r.fedPrice), unit: '₱/kg', note: `actual ${php(r.actualFedPrice)}`, carriesPrice: true },
        { key: 'truepc', label: 'TRUE PC COST', value: php(r.truePcCost), unit: '₱/kg', note: `delivered ${php(r.pcCost)}`, carriesPrice: true, lead: true },
    ];
}

export interface KpiStripProps {
    rollup: CampaignRollup;
    canViewPrices: boolean;
    /** The group's name — `Q3 2026`. Rendered above the tiles. */
    title: string;
    /** `3 campaigns · 2026-06-30 → 2026-09-27`. */
    subtitle?: string;
    className?: string;
}

export function KpiStrip({ rollup, canViewPrices, title, subtitle, className }: KpiStripProps) {
    const tiles = tilesFor(rollup).filter((t) => canViewPrices || !t.carriesPrice);

    return (
        <section className={cn('flex flex-col gap-2', className)} aria-label={`${title} summary`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
                {subtitle ? (
                    <span className="text-[11px] text-muted-foreground">{subtitle}</span>
                ) : null}
            </div>

            {/* `minmax(150px, 1fr)` and not `minmax(0, 1fr)` — the tiles WRAP onto a second
                row rather than crushing to slivers, which is "never crush" applied to a
                card grid instead of a table. */}
            <div
                className="stagger-children grid gap-2"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
            >
                {tiles.map((t) => (
                    <div
                        key={t.key}
                        className={cn(
                            'hover-lift rounded-md border bg-card px-3 py-2',
                            t.lead ? 'border-foreground/25' : 'border-border',
                        )}
                    >
                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t.label}
                        </div>
                        <div className="mt-0.5 flex items-baseline gap-1">
                            <span
                                className={cn(
                                    'font-mono tabular-nums leading-none',
                                    t.lead ? 'text-xl font-semibold' : 'text-lg',
                                )}
                            >
                                {t.value || '—'}
                            </span>
                            {t.unit ? (
                                <span className="text-[11px] text-muted-foreground">{t.unit}</span>
                            ) : null}
                        </div>
                        {t.note ? (
                            <div className="mt-1 truncate font-mono text-[10px] tabular-nums text-muted-foreground">
                                {t.note}
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>

            {/* The rest of the EOQ tab. Checked, not watched — so one dense line. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                <span>DOWNTIME {hours(rollup.dtHours)} h</span>
                <span>REST DAYS {count(rollup.restDays)}</span>
                <span>RC INVENTORY {tons(rollup.rcInventoryTons * 1000)} t</span>
                {canViewPrices ? <span>₱{phpM(rollup.rcInventoryPhp)} M</span> : null}
                <span>BOUGHT {tons(rollup.buyingTons * 1000)} t</span>
                {canViewPrices ? <span>₱{phpM(rollup.buyingPhp)} M</span> : null}
            </div>
        </section>
    );
}
