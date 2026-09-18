'use client';

/**
 * THE MEASUREMENT RIG for the RC Movement printed sheet — the client half.
 * `page.tsx` beside it owns the two production locks and the full usage notes.
 *
 * It exists so the one-page promise is VERIFIED IN A REAL PRINT BOX rather than
 * estimated: headless Chrome renders it with `--print-to-pdf`, and the PDF's page count
 * is the assertion. It also RE-MEASURES the mono glyph advance live and publishes it as
 * `data-fixture-advance`, which is the one input `scripts/verify-rc-movement-grid.ts`
 * can only enforce and never derive (Node has no font engine).
 *
 * **KEPT, not thrown away.** It was written as a throwaway, but the fit is arithmetic
 * over a measured font: the day the mono face, the margin or the row ladder moves, this
 * is the only thing in the repo that can say what happened to the paper. The verify
 * script pins the numbers; this is what produces them.
 *
 * Nothing in the app imports it, and it holds no data access of any kind — every row is
 * generated here, in memory, so it can be driven with no credentials.
 *
 * `?days=33&blocks=25&grades=2&prices=1&actual=1` — the shape to render
 * `?control=1` — mount the real toolbar button instead, to drive the click wiring
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import {
    RC_MOVEMENT_PRINT_RULES,
    RcMovementPrintControl,
    RcMovementPrintSheet,
    rcMovementPrintLayout,
} from '@/app/(app)/inventory/rc-movement/rc-movement-print';
import type {
    RcMovementMatrix,
    RcMovementMatrixColumn,
    RcMovementMatrixRow,
} from '@/app/(app)/inventory/rc-movement/actions';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRADES = ['3X50', '6X50', '4X8', '2X6'];
const STATUSES = ['CLOSED', 'IN-USE', 'STORED', 'CLOSED', 'CLOSED'];

/** Deterministic pseudo-random, so two runs measure the same sheet. */
function rng(seed: number) {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
    };
}

function build(days: number, blocks: number, gradeCount: number, prices: boolean, actual: boolean): RcMovementMatrix {
    const r = rng(20260917);
    const columns: RcMovementMatrixColumn[] = Array.from({ length: blocks }, (_, i) => ({
        batchId: `b${i}`,
        // The longest code `rc_out` has ever fed is 16 chars — put one in, so the
        // rotated header band is measured at its real worst case.
        batchCode: i === 0 ? 'MARCH-26-SUNDRY7' : `JULY-26-BLK${i + 1}`,
        blockLoc: `${'ABCD'[i % 4]}-${(i % 12) + 1}${'AB'[i % 2]}`,
        firstFedDate: '2026-06-30',
        campaignFedKg: Math.round(40000 + r() * 110000),
        campaignFeedDays: 3 + Math.floor(r() * 10),
        totalOut: Math.round(60000 + r() * 120000),
        totalIn: Math.round(60000 + r() * 130000),
        status: STATUSES[i % STATUSES.length],
        mc: 10 + r() * 5,
        ash: 3 + r() * 2,
        blockLoss: -(r() * 0.12),
        avgFedPrice: prices ? 40 + r() * 10 : null,
        actualFedPrice: prices && actual ? 44 + r() * 10 : null,
        isClosed: STATUSES[i % STATUSES.length] === 'CLOSED',
        hasUnpricedDelivery: false,
        upliftPhpKg: prices ? r() * 4 : null,
        weightLostKg: Math.round(r() * 9000),
        lossPct: r() * 0.12,
    }));

    const grades = GRADES.slice(0, gradeCount);
    const rows: RcMovementMatrixRow[] = Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.UTC(2026, 5, 30 + i));
        const fedByBatch: Record<string, number> = {};
        let totalFed = 0;
        const active = 1 + Math.floor(r() * 3);
        for (let k = 0; k < active; k++) {
            const c = columns[Math.floor(r() * columns.length)];
            const kg = Math.round(9000 + r() * 30000);
            fedByBatch[c.batchId] = (fedByBatch[c.batchId] ?? 0) + kg;
            totalFed += kg;
        }
        const producedByGrade: Record<string, number> = {};
        let produced = 0;
        for (const g of grades) {
            const kg = Math.round(r() * 22000);
            producedByGrade[g] = kg;
            produced += kg;
        }
        return {
            rowNum: i + 1,
            date: d.toISOString().slice(0, 10),
            dayOfWeek: DOW[d.getUTCDay()],
            productionBatch: 'JULY',
            totalFed,
            fedByBatch,
            avgFedPriceDay: prices && totalFed > 0 ? 40 + r() * 10 : null,
            totalProduced: produced || null,
            producedByGrade,
        };
    });

    const grandTotalFed = rows.reduce((a, x) => a + x.totalFed, 0);
    const campaignTotalProduced = rows.reduce((a, x) => a + (x.totalProduced ?? 0), 0);

    return {
        campaign: 'JULY-2026',
        productionBatch: 'JULY',
        campaignYear: 2026,
        campaignLabel: 'July 2026',
        columns,
        rows,
        campaignOptions: [],
        grandTotalFed,
        campaignAvgFedPrice: prices ? 45.3412 : null,
        producedGrades: grades.map((g) => ({
            grade: g,
            campaignTotal: rows.reduce((a, x) => a + (x.producedByGrade[g] ?? 0), 0),
        })),
        campaignTotalProduced,
        campaignYieldPct: campaignTotalProduced / grandTotalFed,
        campaignLossKg: grandTotalFed - campaignTotalProduced,
        campaignActualFedPrice: prices
            ? {
                  actualFedPhpKg: 48.2579,
                  campaignWeightedActualFedPhpKg: 47.578,
                  deliveredPhpKg: 45.3412,
                  upliftPhpKg: 2.2274,
                  blocksFed: blocks,
                  blocksClosed: blocks - 2,
                  blocksOpen: 2,
                  blocksInPrice: blocks - 3,
                  blocksClosedUnpriced: 1,
                  campaignFedKgIncludedPct: 0.94,
                  isFullyCovered: false,
              }
            : null,
        openBlocks: [],
        canViewPrices: prices,
    };
}

export function RcmPrintFixture() {
    const sp = useSearchParams();
    const days = Number(sp.get('days') ?? 33);
    const blocks = Number(sp.get('blocks') ?? 25);
    const grades = Number(sp.get('grades') ?? 2);
    const prices = sp.get('prices') !== '0';
    const actual = sp.get('actual') === '1';
    // `?control=1` mounts the REAL toolbar button instead of the static stage, so the
    // wiring (click → stage mounts → `printCard` → `window.print()`) can be driven and
    // observed. The static mode is what the PDF measurements use.
    const control = sp.get('control') === '1';
    const [advance, setAdvance] = React.useState<string>('');

    const data = React.useMemo(
        () => build(days, blocks, grades, prices, actual),
        [days, blocks, grades, prices, actual],
    );
    const layout = React.useMemo(
        () => rcMovementPrintLayout(data, actual),
        [data, actual],
    );

    React.useEffect(() => {
        // In CONTROL mode the button owns this class — adding it here would hide the
        // button itself and the click could never happen.
        if (!control) document.body.classList.add('bw-printing');
        // MEASURE the mono advance for real — the print solver takes it as a constant
        // and Node has no font engine, so this is the only place it can be checked.
        const probe = document.createElement('span');
        probe.className = 'font-mono tabular-nums';
        probe.style.cssText = 'position:fixed;visibility:hidden;font-size:100px;white-space:pre';
        probe.textContent = '0'.repeat(100);
        document.body.appendChild(probe);
        setAdvance((probe.getBoundingClientRect().width / 100 / 100).toFixed(4));
        probe.remove();
        return () => document.body.classList.remove('bw-printing');
    }, [control]);

    if (control) {
        return (
            <div className="p-6" data-fixture-control>
                <RcMovementPrintControl data={data} showActualPrice={actual} />
            </div>
        );
    }

    return (
        <>
            <style dangerouslySetInnerHTML={{ __html: RC_MOVEMENT_PRINT_RULES }} />
            <div
                data-print-card
                className="bw-print-sheet flex flex-col"
                style={{ width: 1069 }}
                data-fixture-font={layout.fontPt}
                data-fixture-rowh={layout.rowH}
                data-fixture-headh={layout.headH}
                data-fixture-pages={layout.pages.length}
                data-fixture-advance={advance}
            >
                {layout.pages.map((page, i) => (
                    <div data-print-page key={page.firstBlockIndex}>
                        <RcMovementPrintSheet
                            data={data}
                            layout={layout}
                            page={page}
                            pageIndex={i}
                            pageCount={layout.pages.length}
                            printedAt="2026-09-17 12:00"
                        />
                    </div>
                ))}
            </div>
        </>
    );
}
