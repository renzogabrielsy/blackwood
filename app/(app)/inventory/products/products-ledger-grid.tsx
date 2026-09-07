'use client';

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryCell, TableSummaryRow } from '@/components/shared/table';
import { needsGroupSpacer, pinnedOffsets } from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import type { ProductGrade, ProductLedgerRow, ProductStage } from '@/lib/products/types';
import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// The RUNNING TALLY — `view_product_ledger` on the Blackwood Table.
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// Every column is `cellKind: 'readonly'` and none carries a `parse`, so
// `columnAcceptsEdit` is false at every coordinate and no editor can open. No
// `renderEditor`, no draft pool, no server action imported. The sync worker is the sole
// writer of `product_movements`; nothing on this screen can change a byte of it.
//
// ── THE RUNNING BALANCES ARE SQL'S, AND ARE NEVER RECOMPUTED HERE ───────────────
// `view_product_ledger` carries the running balance of every stage as of each row,
// computed with conditional window sums ordered by `transaction_date, source_row`. This
// file reads those columns and formats them. It owns no accumulator over them.
//
// ── THE ONE THING THIS FILE ADDS UP ─────────────────────────────────────────────
// The pinned footer totals the FLEC and KG DELTAS of the rows currently shown — a Σ of
// what is on screen, the same shape `rc-out-grid-v2.tsx`'s rule-off has. It is a
// description of the visible set, not a balance: a balance is `opening + Σ delta`, which
// is `view_product_stage_balance`'s definition and is read from the header strip.
//
// ── SORT + FILTER ARE ON, DELIBERATELY ──────────────────────────────────────────
// `scope="endless"` defaults both OFF because an endless grid's window is usually the
// SERVER's keyset. This sheet has no such window: `page.tsx` hands it the selected
// grade's WHOLE ledger in one payload (331 rows at the widest today, paged by
// `fetchAllRows` if a grade ever outgrows the 1000-row cap), it passes no `startReached`,
// no `firstItemIndex` and no pager at all. So the caveat the default protects against
// cannot arise, and the affordance is switched on explicitly rather than by changing the
// scope — which would silently change how the rows are rendered. The month headings and
// the spacers hide on their own while either axis is active (`applyTableView`): a heading
// naming a run of adjacent rows is a lie the moment a sort destroys the run.
//
// ── HEADER WIDTHS PAY THE 57px CHROME BUDGET ────────────────────────────────────
// Sort + filter on means `HeaderCell` lays out two 16px buttons and their two 4px gaps as
// `opacity-0` flex SIBLINGS of every label — invisible and still occupying layout. Every
// width below is `measured label px + 57` (16 `px-2` + 40 chrome + 1 border) or its
// widest real value + 17, whichever is larger, and `scripts/verify-products-grid.ts`
// pins both halves against label widths measured in Chrome at the real computed fonts.
// See CLAUDE.md → "The header owes chrome, not just its label".
//
// ── TWO SOURCE DEFECTS ARE MARKED QUIETLY, NEVER PAINTED RED ────────────────────
// `agrees_with_sheet` is false on 448 of 808 rows and that is the SHEET, not the app: the
// tab's own printed running cells disagree with a cumulative sum of the tab's own delta
// column, while the tab's header-block totals agree with our arithmetic on all twelve
// non-zero (grade, stage) pairs exactly. So a disagreeing row gets a muted `~` and the
// count is said ONCE per grade in the header strip. Same for `date_out_of_sheet_order`
// (four 2X6 rows dated 2025-07-29, a year typo): a muted date, a title, no colour.
//
// NO PESO ANYWHERE — this module has no cost, price or value column and none is
// derivable, so there is no `canViewPrices` prop, no gate and nothing to null.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Stage identity ──────────────────────────────────────────────────────────────

/**
 * The dot colour per stage, from the shared `--bw-year-*` data-viz series so the two
 * neutral stages stay theme-aware without a new global. RECLASS is muted (a correction,
 * not a process step) and OLD PROD is a slate mixed from the PROD blue and the muted
 * foreground — related to PROD, visibly older.
 */
export const STAGE_DOT: Readonly<Record<string, string>> = {
    PROD: 'var(--bw-year-1)',
    AYAG: 'var(--bw-year-4)',
    MAGNET: 'var(--bw-year-7)',
    FINAL: 'var(--bw-year-3)',
    BLENDED: 'var(--bw-year-5)',
    SUNDRY: 'var(--bw-year-2)',
    RECLASS: 'var(--muted-foreground)',
    'OLD PROD': 'color-mix(in oklab, var(--bw-year-1) 30%, var(--muted-foreground))',
};

export function stageDot(stage: string): string {
    return STAGE_DOT[stage] ?? 'var(--muted-foreground)';
}

// ─── Formatting ──────────────────────────────────────────────────────────────────

const int = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** A signed delta. NULL renders BLANK — never 0: "not recorded" is not "nothing moved". */
function signed(value: number | null, className?: string): React.ReactNode {
    if (value === null) return <span className="text-muted-foreground/40">&mdash;</span>;
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    return (
        <span
            className={cn(
                'font-mono tabular-nums',
                value > 0 && 'text-emerald-600 dark:text-emerald-400',
                value < 0 && 'text-red-600 dark:text-red-400',
                value === 0 && 'text-muted-foreground',
                className,
            )}
        >
            {sign}
            {int(Math.abs(value))}
        </span>
    );
}

function signedText(value: number | null): string {
    if (value === null) return '';
    return String(value);
}

const MONTHS = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

function monthHeading(key: string): string {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1] ?? key} ${y}`;
}

// ─── Column widths ───────────────────────────────────────────────────────────────
//
// Each is `max(measured header label + 57, widest real value + 17)`. The measured label
// widths and this arithmetic are pinned in `scripts/verify-products-grid.ts`; do not
// narrow one back to "what looks about right" — that is exactly how RC Movement and the
// Cenapro QC sheet each regressed once.

const W_DATE = 108; // header 29.52 + 57 = 86.52 · cell `2026-09-05` + the ⚠ = 88.52 + 17
const W_STAGE = 118; // header 29.60 + 57 = 86.60 · cell dot+gap+`OLD PROD`+gap+`~` = 81.21 + 17
const W_FLEC = 92; //  header 28.70 + 57 = 85.70 · cell `−1,234` 36.12 + 17
const W_KG = 90; //    header 15.92 + 57 = 72.92 · cell `−100,320` 53.03 + 17
const W_REMARKS = 300; // header 55.37 + 57 = 112.37 · truncate + tooltip (Excel Standard)
/**
 * Every running lane shares ONE width, and the widest of the eight headers is what sizes
 * it: `OLD PROD` at 59.75. They opt OUT of sort + filter, so they pay the BARE 17px of
 * chrome rather than 57 — see the column spec for why that opt-out is about meaning and
 * not about pixels.
 */
const W_RUN = 92; //   header `OLD PROD` 59.75 + 17 = 76.75 · cell `1,234` 29.78 + 17

const ROW_H = 28;
const MONTH_HEADER_H = 24;
const SPACER_H = 8;

// ─── Row families ────────────────────────────────────────────────────────────────

export type ProductLedgerItem = GridRow<ProductLedgerRow>;

const RUN_PREFIX = 'run:';
const runKey = (stage: ProductStage): string => `${RUN_PREFIX}${stage}`;

const KINDS: ReadonlyMap<string, RowKind<ProductLedgerRow>> = new Map([
    ['movement', {
        kind: 'movement',
        height: ROW_H,
        addressable: true,
        // Every column exists on a movement row and every one of them is read-only.
        occupies: (colKey: string) => ({ field: colKey, editable: false }),
    }],
    ['group-header', { kind: 'group-header', height: MONTH_HEADER_H, addressable: false, occupies: () => null }],
    ['spacer', { kind: 'spacer', height: SPACER_H, addressable: false, occupies: () => null }],
]);

const ROW_RULES: Record<string, string> = {
    movement: 'border-b border-b-border/30',
    spacer: 'border-b border-b-border',
};

// ─── Columns ─────────────────────────────────────────────────────────────────────

/**
 * The lanes are built PER GRADE, because the running lanes are the stages that grade has
 * ever used — OLD PROD exists on Kuraray and nowhere else, and a column of blanks on the
 * other four would be a coordinate space with a phantom in it.
 */
function buildColumns(
    stages: readonly ProductStage[],
    showDriftMarker: boolean,
): ColumnSpec<ProductLedgerRow, null>[] {
    const cols: ColumnSpec<ProductLedgerRow, null>[] = [
        {
            key: 'date',
            label: 'DATE',
            title: 'Transaction date (yyyy-MM-dd), as the sheet states it',
            width: W_DATE,
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (row) => row.transactionDate,
            format: (row) => (
                <span
                    className={cn(
                        'font-mono font-bold tabular-nums',
                        // A row dated EARLIER than the row above it in the sheet — a
                        // likely operator year typo, flagged and never corrected. Muted,
                        // not red: no balance is affected.
                        row.dateOutOfSheetOrder && 'font-normal text-muted-foreground',
                    )}
                    title={
                        row.dateOutOfSheetOrder
                            ? `${row.transactionDate} — dated earlier than the row above it in the sheet (a likely year typo). Flagged, never corrected; no balance is affected.`
                            : undefined
                    }
                >
                    {row.transactionDate}
                    {row.dateOutOfSheetOrder ? <span className="ml-1 opacity-70">&#9888;</span> : null}
                </span>
            ),
        },
        {
            key: 'stage',
            label: 'TYPE',
            title: 'Which stage of the product this movement is filed under',
            width: W_STAGE,
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (row) => row.stage,
            format: (row) => (
                <span className="flex items-center gap-1.5 truncate">
                    <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: stageDot(row.stage) }}
                    />
                    <span className="truncate font-mono text-[11px] font-semibold">{row.stage}</span>
                    {showDriftMarker && row.agreesWithSheet === false ? (
                        <span
                            className="shrink-0 font-mono text-[11px] text-muted-foreground/70"
                            title="The sheet's own printed running cell disagrees with the sheet's own arithmetic on this row. The balance shown here is the computed one — see the note above the tally."
                        >
                            ~
                        </span>
                    ) : null}
                </span>
            ),
        },
        {
            key: 'flec',
            label: 'FLEC',
            title: 'Flecons moved by this row (signed)',
            width: W_FLEC,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            numericValue: (row) => row.flecDelta,
            clipboardValue: (row) => signedText(row.flecDelta),
            format: (row) => signed(row.flecDelta),
        },
        {
            key: 'kg',
            label: 'KG',
            title: 'Kilograms moved by this row (signed). Blank = not recorded, never zero.',
            width: W_KG,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            numericValue: (row) => row.kgDelta,
            clipboardValue: (row) => signedText(row.kgDelta),
            format: (row) => signed(row.kgDelta),
        },
        {
            key: 'remarks',
            label: 'REMARKS',
            title: 'What the sheet wrote beside this movement',
            width: W_REMARKS,
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (row) => row.remarks ?? '',
            format: (row) =>
                row.remarks ? (
                    // Excel Standard: truncate, full text on hover.
                    <span className="block max-w-full truncate text-muted-foreground" title={row.remarks}>
                        {row.remarks}
                    </span>
                ) : null,
        },
    ];

    for (const stage of stages) {
        cols.push({
            key: runKey(stage),
            label: stage,
            title: `${stage} balance as of this row — computed in SQL by view_product_ledger, never here`,
            width: W_RUN,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            // The running lanes carry no header controls: sorting a running balance
            // reorders the very sequence that makes it a running balance, and the eight
            // stage names are the widest labels on the sheet. Opting them out buys back
            // the 40px of chrome AND removes an affordance that could only mislead.
            sortable: false,
            filterable: false,
            numericValue: (row) => row.running[stage] ?? null,
            clipboardValue: (row) => {
                const v = row.running[stage];
                return v === null || v === undefined ? '' : String(v);
            },
            format: (row) => {
                const v = row.running[stage];
                if (v === null || v === undefined) return null;
                return (
                    <span
                        className={cn(
                            'font-mono tabular-nums',
                            stage === 'FINAL' && 'font-semibold',
                            v === 0 && 'text-muted-foreground/50',
                        )}
                    >
                        {int(v)}
                    </span>
                );
            },
        });
    }

    return cols;
}

/** What a cell HOLDS as text — the jump keys' `filled` probe and the clipboard's source. */
function fieldText(row: ProductLedgerRow, field: string): string {
    if (field.startsWith(RUN_PREFIX)) {
        const v = row.running[field.slice(RUN_PREFIX.length) as ProductStage];
        return v === null || v === undefined ? '' : String(v);
    }
    switch (field) {
        case 'date': return row.transactionDate;
        case 'stage': return row.stage;
        case 'flec': return signedText(row.flecDelta);
        case 'kg': return signedText(row.kgDelta);
        case 'remarks': return row.remarks ?? '';
        default: return '';
    }
}

// ─── The flatten ─────────────────────────────────────────────────────────────────

interface MonthBlock {
    label: string;
    count: number;
    flec: number;
    kg: number;
}

interface Flattened {
    items: ProductLedgerItem[];
    months: Map<string, MonthBlock>;
    total: { count: number; flec: number; kg: number };
}

/**
 * The shape of the sheet: the rows in the order the SERVER sent them (newest first), a
 * month heading at each boundary and a blank rule above it.
 *
 * The chrome keys carry a RUN ORDINAL, not just the month — `computeItemKey` is the
 * virtualiser's React key, and a month can appear twice if rows ever arrive out of
 * order, which the 2X6 year typo is a live example of.
 */
function flatten(rows: readonly ProductLedgerRow[]): Flattened {
    const items: ProductLedgerItem[] = [];
    const months = new Map<string, MonthBlock>();
    const total = { count: 0, flec: 0, kg: 0 };

    let prev: string | undefined;
    let run = 0;
    let chromeKey = '';
    for (const row of rows) {
        const key = row.transactionDate.slice(0, 7);
        if (needsGroupSpacer(prev, key)) items.push({ kind: 'spacer', key: `sp:${run}` });
        if (prev !== key) {
            run += 1;
            chromeKey = `mh:${run}:${key}`;
            items.push({ kind: 'group-header', key: chromeKey });
            months.set(chromeKey, {
                label: key ? monthHeading(key) : 'NO DATE',
                count: 0,
                flec: 0,
                kg: 0,
            });
        }
        prev = key;

        const block = months.get(chromeKey)!;
        block.count += 1;
        block.flec += row.flecDelta ?? 0;
        block.kg += row.kgDelta ?? 0;
        total.count += 1;
        total.flec += row.flecDelta ?? 0;
        total.kg += row.kgDelta ?? 0;

        items.push({ kind: 'movement', id: row.id, data: row });
    }

    return { items, months, total };
}

// ─── The component ───────────────────────────────────────────────────────────────

export interface ProductsLedgerGridProps {
    grade: ProductGrade;
    rows: readonly ProductLedgerRow[];
}

export function ProductsLedgerGrid({ grade, rows }: ProductsLedgerGridProps) {
    // A MARKER THAT IS ON EVERY ROW DISTINGUISHES NOTHING.
    //
    // The `~` earns its place by separating the rows the sheet's own running column got
    // wrong from the rows it got right. On 6X50 that is 14 of 331 and the mark is exactly
    // the right instrument; on 2X6 it is 216 of 216, where it is pure noise on every line
    // of the sheet and the COUNT in the header note is the whole message. Same reasoning
    // as a month heading naming the only month present, and the header note says which of
    // the two the reader is looking at.
    const showDriftMarker = grade.sheetRunningDisagreementCount < grade.movementCount;

    const columns = React.useMemo(
        () => buildColumns(grade.ledgerStages, showDriftMarker),
        [grade.ledgerStages, showDriftMarker],
    );

    const { items, months, total } = React.useMemo(() => flatten(rows), [rows]);

    const byId = React.useMemo(() => {
        const m = new Map<string, ProductLedgerRow>();
        for (const row of rows) m.set(row.id, row);
        return m;
    }, [rows]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            return row ? fieldText(row, field) : '';
        },
        [byId],
    );

    // The module's single writer. Nothing here ever calls `applyEdits`, so it holds an
    // empty map for the life of the component — but `BlackwoodTable` requires the port,
    // and handing it a real (idle) instance is honest where a stub would not be.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // Column widths the operator drags. LOCAL state, deliberately: persisting them would
    // mean a write, and this grid has no write path of any kind.
    const [tableSettings, setTableSettings] = React.useState<TableSettings>({});

    const renderChromeRow = React.useCallback(
        (item: ProductLedgerItem, api: TableChromeRowApi<ProductLedgerRow, null>) => {
            if (!('key' in item)) return null;

            if (item.kind === 'spacer') {
                const left = pinnedOffsets(api.cols);
                return (
                    <>
                        {api.cols.map((c, ci) => {
                            const frozen = ci < left.length;
                            return (
                                <td
                                    key={c.key}
                                    aria-hidden="true"
                                    className={cn(
                                        'border-b border-b-border border-r border-r-border/40 p-0 align-middle',
                                        frozen && 'frozen-col bg-background',
                                        frozen && ci === left.length - 1 && 'frozen-edge',
                                    )}
                                    style={{ height: SPACER_H, ...(frozen ? { left: left[ci] } : {}) }}
                                />
                            );
                        })}
                    </>
                );
            }

            const block = months.get(item.key);
            if (!block) return null;
            return (
                <td colSpan={api.colCount} className="h-6 border-b border-border/40 bg-muted/25 px-2 py-1">
                    <span className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {block.label}
                        <span className="font-normal normal-case text-muted-foreground/60">
                            {block.count} movement{block.count === 1 ? '' : 's'}
                        </span>
                        <span className="font-normal tabular-nums text-muted-foreground/60">
                            {block.flec >= 0 ? '+' : '−'}
                            {int(Math.abs(block.flec))} flec
                        </span>
                        <span className="font-normal tabular-nums text-muted-foreground/60">
                            {block.kg >= 0 ? '+' : '−'}
                            {int(Math.abs(block.kg))} kg
                        </span>
                    </span>
                </td>
            );
        },
        [months],
    );

    // ── The pinned Σ rule-off ────────────────────────────────────────────────────
    //
    // Σ of the LOADED rows' deltas, per column, and it SAYS SO — because sort and filter
    // live inside `BlackwoodTable` (`applyTableView`) and no seam hands a consumer the
    // rows that survived them, so a footer that claimed to total "what is shown" would
    // be wrong the instant a filter is on. The platform's own view strip renders
    // immediately beneath this row and reports "N of M rows" whenever one is, so the
    // difference is never hidden — it is stated by the surface that actually knows it.
    //
    // It is deliberately NOT a balance either: a balance is `opening + Σ delta` and lives
    // in `view_product_stage_balance`, which the header strip reads. Printing a "balance"
    // here that ignored the opening would be a second, wrong definition of the number
    // this page exists to show.
    const totalsCell = React.useCallback(
        (spec: ColumnSpec<ProductLedgerRow, null>): TableSummaryCell | null => {
            if (spec.key === 'date') {
                return {
                    content: (
                        <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                            &Sigma; {int(total.count)}
                        </span>
                    ),
                };
            }
            if (spec.key === 'stage') {
                return {
                    content: (
                        <span className="text-[10px] text-muted-foreground">
                            movement{total.count === 1 ? '' : 's'} loaded
                        </span>
                    ),
                };
            }
            if (spec.key === 'flec') {
                return { content: <span className="block text-right">{signed(total.flec, 'font-bold')}</span> };
            }
            if (spec.key === 'kg') {
                return { content: <span className="block text-right">{signed(total.kg, 'font-bold')}</span> };
            }
            if (spec.key === 'remarks') {
                return {
                    content: (
                        <span className="text-[10px] leading-tight text-muted-foreground">
                            Totals cover every loaded row &mdash; a filter changes what is listed, not what is
                            totalled. Running balances are the database&rsquo;s, never recomputed here.
                        </span>
                    ),
                };
            }
            return null;
        },
        [total],
    );

    const summaryRows = React.useMemo<TableSummaryRow<ProductLedgerRow, null>[]>(
        () => [{ key: 'totals', sticky: true, cell: totalsCell }],
        [totalsCell],
    );

    const rowClassFor = React.useCallback(
        () => 'group transition-all duration-150 hover:bg-muted/50',
        [],
    );

    return (
        <BlackwoodTable<ProductLedgerRow, null>
            items={items}
            kinds={KINDS}
            specs={columns}
            ctx={null}
            settings={tableSettings}
            onSettingsChange={setTableSettings}
            edits={edits}
            storedText={storedText}
            scope="endless"
            enableSort
            enableFilter
            rowRules={ROW_RULES}
            rowClassFor={rowClassFor}
            renderChromeRow={renderChromeRow}
            summaryRows={summaryRows}
            emptyMessage={`No movements recorded for ${grade.displayName} yet.`}
            className="min-h-0 flex-1"
        />
    );
}
