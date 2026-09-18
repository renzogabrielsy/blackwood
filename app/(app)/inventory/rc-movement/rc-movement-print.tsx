'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';

import { GroupPrintPage, GroupPrintStage } from '@/components/shared/print/group-print';
import {
    buildPrintPageRules,
    usePrintPageRules,
} from '@/components/shared/print/print-page-rules';
import {
    a4LandscapeBox,
    fitColumnWidths,
    fitRowHeight,
    maxRepeatingColumns,
    monoCharPx,
    splitEvenly,
    type PrintColumnDemand,
} from '@/components/shared/print/print-fit';
import { cn } from '@/lib/utils';
import type {
    RcMovementMatrix as RcMovementMatrixData,
    RcMovementMatrixColumn,
    RcMovementMatrixRow,
} from './actions';

// ═════════════════════════════════════════════════════════════════════════════════
// PRINT THE RC MOVEMENT MATRIX — IN COLOUR, ONE A4 LANDSCAPE SHEET (2026-09-17).
//
// Renzo: *"a similar colored print functionality for rc movement page. Make sure an
// entire month can fit inside of landscape A4."*
//
// ── WHAT IS ON THE SHEET ────────────────────────────────────────────────────────
// Exactly what the screen is showing, for the campaign currently selected and
// honouring the `Actual ₱` switch:
//
//   * every day row of the campaign (a campaign is up to ~33 calendar days — JULY
//     2026 is a changeover month, 2026-06-30 → 2026-08-01),
//   * the spine: `#` · DATE · DAY · FED ₱/kg · TOTAL FED,
//   * the PRODUCED group: TOTAL PRODUCED + one column per grade the campaign ran,
//   * EVERY block column,
//   * and the block footer, as the LAST rows of the `<tbody>`:
//     `TOTAL · YIELD % · LOSS % · ₱/KG · ACTUAL ₱`.
//
// ── WHY THE FOOTER IS `<tbody>` ROWS AND NOT A `<tfoot>` ────────────────────────
// Chrome REPEATS a `<tfoot>` on every printed page. `/operations`' printed ledger
// shipped that bug and its totals appeared at the foot of two consecutive sheets,
// reading as a duplicated total. `<thead>` keeps `table-header-group` — a header that
// repeats is a help, a total that repeats is a lie.
//
// ── WHY THE BLOCK HEADERS ARE ROTATED ───────────────────────────────────────────
// The MEASURED reason, not a stylistic one. A batch code is up to 16 characters
// (`MARCH-26-SUNDRY7`, the longest `rc_out` has ever fed — see
// `scripts/verify-rc-movement-grid.ts`), while a block CELL holds at most 7 (`150,000`).
// A horizontal header would therefore make every block column 2.3× wider than its own
// data needs, and 25 of those do not fit on any sheet at any legible size. Rotated, the
// header costs HEIGHT — once, as fixed chrome, independent of how many blocks there are
// — and the column width falls back to what the numbers actually need.
//
// ── THE ONE-PAGE PROMISE, AND WHAT HAPPENS WHEN IT CANNOT BE KEPT ───────────────
// Both dimensions are SOLVED, never assumed (`components/shared/print/print-fit.ts`):
//
//   VERTICAL  row height = budget ÷ (day rows + footer rows), clamped, font stepping
//             down with it. The footer rows are IN THE DIVISOR, not in the chrome —
//             they are drawn at the body font, so pinning them at a constant is the
//             circularity that made `/operations` miss by exactly one row.
//   HORIZONTAL every column's width is `measured longest string × the font's advance`,
//             and the FONT is solved for: the largest step at which Σ widths fits the
//             sheet. The strings are measured off THE DATA being printed, so a column
//             can never clip — which is the failure mode this replaces.
//
// **If even the 5pt floor overflows the width, the sheet paginates BY COLUMNS** —
// balanced chunks of block columns, the spine and the PRODUCED group repeated on each,
// and the heading saying `blocks 1–13 of 25`. Never a silent clip, never a crush, and
// never type below the floor: a legible two-sheet matrix beats an unreadable one-sheet
// one. See {@link RCM_PRINT_MAX_BLOCK_COLUMNS} for the measured ceiling.
//
// ── COLOUR ──────────────────────────────────────────────────────────────────────
// The SCREEN's own semantics, restated in explicit LIGHT values (see
// {@link RCM_PRINT_TONE}); `print-color-adjust: exact` on the whole sheet, because
// without it a browser silently drops every fill.
//
// ── PRICE GATING IS A SECURITY BOUNDARY, AND THIS FILE FETCHES NOTHING ──────────
// It renders the payload the page already received. `fetchRcMovementMatrix` nulls
// every ₱ field server-side for a `!canViewPrices()` caller and does not even QUERY
// the three actual-price views, so there is nothing here to leak; the same
// `data.canViewPrices` flag the matrix reads drops the FED ₱/kg column, the ₱/KG
// footer row and the ACTUAL ₱ footer row from the printed layout entirely — exactly as
// the screen drops them. Nothing is summed, weighted or averaged here: every number on
// the sheet is a field of `data`, formatted.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Formatters — MIRRORED VERBATIM from `rc-movement-matrix.tsx` ────────────────
//
// Copied rather than imported, because the matrix imports the print CONTROL below and
// a cycle between two client modules is a real hazard. `scripts/verify-rc-movement-grid.ts`
// pins the four bodies to the matrix's by source text, the `verify-case-grouping.ts`
// idiom — a duplicated definition is legal in this codebase only when something proves
// the copies still agree.

/** Integer kg with thousands separators; blank for zero/empty. */
function fmtKg(n: number | undefined): string {
    if (!n || n === 0) return '';
    return Math.round(n).toLocaleString('en-US');
}

/** Accounting-format number (2 dp, thousands separators); null/zero-fed renders blank. */
function fmtPrice(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Yield fraction → 1-dp percent (×100). Em-dash when null (total_fed = 0). 0 stays "0.0%". */
function fmtYieldPct(fraction: number | null): string {
    if (fraction === null || fraction === undefined) return '—';
    return `${(fraction * 100).toFixed(1)}%`;
}

/** Block loss as a LOSS — 2-decimal percent, em-dash when null (totalIn = 0). */
function fmtLossPct(blockLoss: number | null): string {
    if (blockLoss === null || blockLoss === undefined) return '—';
    return `${(-blockLoss * 100).toFixed(2)}%`;
}

// ═════════════════════════════════════════════════════════════════════════════════
// THE PRINT PALETTE — THE SCREEN'S SIX MEANINGS, IN LIGHT VALUES.
//
// Every tint on `rc-movement-matrix.tsx` carries a `dark:` twin, and a printed sheet
// must come out IDENTICAL whichever theme the dialog was opened from — a reader in
// dark mode must not get a black page. So the print palette is declared ONCE, in
// explicit light values, with no `dark:` variant and no semantic token (`bg-muted` /
// `text-foreground` both flip).
//
// The MEANINGS are lifted from the screen one for one, which is the "follow the
// current sheet" half of the ask:
//
//   violet  → MONEY (₱). The `Actual ₱` switch is violet on screen; so is every ₱.
//   sky     → FED / INPUT — the day's total fed.
//   amber   → PRODUCED. The screen's produced footer band is amber.
//   emerald → a block cell that HAS a feeding (`bg-emerald-500/10` on screen).
//   blue    → an IN-USE block's footer (`statusTint`).
//   red     → a CLOSED / FEED block's footer (`statusTint`), and a LOSS figure.
//   zinc    → the day spine's own chrome.
//
// `cell` tints are hand-mixed at ≈7% of the family's 500 step into white rather than
// taken from the 50 step (~3%, which vanishes on a laser printer). Black numerals on
// every one of them clears 17:1, so the tint says only WHICH column the eye is in.
// ═════════════════════════════════════════════════════════════════════════════════

export type RcmPrintTone = 'day' | 'money' | 'fed' | 'produced' | 'block';

export interface RcmPrintToneStyle {
    /** OPAQUE header fill + its dark family text. */
    head: string;
    /** The 2px coloured top border that names the column group. */
    edge: string;
    /** The body column tint — ≈7%, so black numerals stay high-contrast. */
    cell: string;
    /** The family's dark shade for an emphasised figure. ≥ 7:1 on white, every one. */
    value: string;
}

export const RCM_PRINT_TONE: Record<RcmPrintTone, RcmPrintToneStyle> = {
    day: {
        head: 'bg-zinc-200 text-zinc-900',
        edge: 'border-t-zinc-500',
        cell: '',
        value: 'text-zinc-900',
    },
    money: {
        head: 'bg-violet-100 text-violet-900',
        edge: 'border-t-violet-500',
        cell: 'bg-[#f0ecfd]',
        value: 'text-violet-800',
    },
    fed: {
        head: 'bg-sky-100 text-sky-900',
        edge: 'border-t-sky-500',
        cell: 'bg-[#e9f4fd]',
        value: 'text-sky-800',
    },
    produced: {
        head: 'bg-amber-100 text-amber-900',
        edge: 'border-t-amber-500',
        cell: 'bg-[#fcf3e4]',
        value: 'text-amber-900',
    },
    block: {
        head: 'bg-emerald-100 text-emerald-900',
        edge: 'border-t-emerald-500',
        cell: '',
        value: 'text-emerald-800',
    },
};

/** A block cell that carries a feeding — the paper form of `bg-emerald-500/10`. */
const PRINT_FED_CELL = 'bg-[#e7f6ee]';
/** The footer band and the spine's own totals cell: neutral, opaque, no family hue. */
const PRINT_NEUTRAL_FILL = 'bg-zinc-100';
/** A day on which nothing was fed — present, but visibly not a working row. */
const PRINT_MUTED_TEXT = 'text-zinc-500';
/** A weekend DAY label. amber-800 is 7.09:1 on white — it survives greyscale. */
const PRINT_WEEKEND_TEXT = 'text-amber-800';
/** A block that lost weight / gained weight, on a tint that does not clash. */
const PRINT_LOSS_TEXT = 'text-red-800';
const PRINT_GAIN_TEXT = 'text-emerald-800';

/**
 * The paper form of `rc-movement-matrix.tsx`'s `statusTint()` — the SAME three
 * verdicts, in light-only values. The block footer band is the one place a reader
 * learns, at a glance, which piles are finished.
 *
 *   IN-USE (active)                       → blue
 *   CLOSED / FEED (depleted, non-active)  → red
 *   STORED / SUNDRYING / SUNDRIED / other → neutral
 */
function printStatusTint(status: string): string {
    switch (status) {
        case 'IN-USE':
            return 'bg-blue-100 text-blue-950';
        case 'CLOSED':
        case 'FEED':
            return 'bg-red-100 text-red-950';
        default:
            return 'bg-zinc-100 text-zinc-900';
    }
}

// ─── Geometry ────────────────────────────────────────────────────────────────────

/**
 * The sheet's margin, in millimetres — 7, against `globals.css`'s app-wide 12.
 *
 * This is the densest report in the app (a matrix, so BOTH dimensions are data), and
 * five millimetres back on each side is ~38px of width, i.e. roughly one more block
 * column, and ~38px of height, i.e. roughly two more day rows. It is injected for the
 * duration of the print and removed afterwards, so /analytics keeps its 12mm.
 *
 * **It is stated ONCE and read by both the `@page` rule and the page-box arithmetic.**
 */
export const RCM_PRINT_MARGIN_MM = 7;

/** 283mm × 196mm → **1069.6px × 740.8px** of printable box. */
const PAGE = a4LandscapeBox(RCM_PRINT_MARGIN_MM);

/**
 * The advance width of one monospace glyph, as a fraction of the font size.
 *
 * MEASURED in headless Chrome against the app's own `font-mono` stack, over a 100-glyph
 * run of tabular digits at 100px: **0.6120 em**. It is carried here as **0.62**, ROUNDED
 * UP — a width derived from an under-estimate is a clipped number, and the first PDF of
 * this feature clipped `DAY` and the last character of `MARCH-26-SUNDRY7` for exactly
 * that reason (the constant had been assumed to be 0.60). Rounding up costs ~1.3% of the
 * sheet's width and cannot clip anything.
 *
 * Node has no font engine, so this can only be ENFORCED here, never re-derived — the
 * same discipline `scripts/verify-rc-movement-grid.ts` already applies to the on-screen
 * widths. Re-measure it (and this comment) if the app's mono face ever changes.
 */
export const RCM_MONO_ADVANCE_EM = 0.62;

/**
 * What a column costs BESIDE its text: 1px of padding each side plus the 1px
 * collapsed border it shares with its neighbour.
 */
const PAD_PX = 3;

/**
 * THE FONT LADDER, descending. Deliberately COARSE — two campaigns of similar shape
 * should print at the same size, so a quarter's worth of sheets reads as one document.
 *
 * **5pt is the FLOOR and it is a real floor, not a fallthrough.** At 5pt a tabular
 * digit is 6.7 CSS px, which on a 300dpi printer is ~28 device pixels tall — small,
 * and legible. Below it the sheet stops shrinking and paginates by columns instead.
 */
const FONT_LADDER = [9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5] as const;
const FONT_FLOOR = FONT_LADDER[FONT_LADDER.length - 1];

/** The row-height → body-font ladder. Same steps, keyed by the height that buys them. */
const ROW_FONT_LADDER = [
    { minRowH: 18, fontPt: 9 },
    { minRowH: 17, fontPt: 8.5 },
    { minRowH: 16, fontPt: 8 },
    { minRowH: 15, fontPt: 7.5 },
    { minRowH: 14, fontPt: 7 },
    { minRowH: 13, fontPt: 6.5 },
    { minRowH: 12, fontPt: 6 },
    { minRowH: 11, fontPt: 5.5 },
    { minRowH: 0, fontPt: 5 },
] as const;

/**
 * THE COMFORTABLE CEILING — a short campaign has height to spare and the temptation
 * is to spend all of it. A 12-day matrix divided into the whole budget would give
 * 50px rows, which reads as a form rather than a ledger.
 */
const ROW_MAX = 22;
/** The 5pt floor as a row height: 6.7px of glyph at 1.15 leading + 1px padding ×2 + 1px border. */
const ROW_MIN = 11;
/** `rowH − (1px padding × 2) − 1px collapsed border` — what pins the line box. */
const ROW_CHROME_PX = 3;

/** Title + span, forced onto ONE line. */
const CHROME_TITLE = 16;
/** `gap-1` between the heading and the table. */
const CHROME_GAP = 4;
/**
 * SUB-PIXEL SLACK. Collapsed borders and fractional row heights land the real page a
 * pixel or two above the sum of its parts; six is several times the worst observed
 * drift and costs a third of a row.
 */
const CHROME_SLACK = 6;

/** The block headers' own font — FIXED, so the header height does not move with the body. */
const HEAD_FONT_PT = 6;
/**
 * The header cells' type, as a style object — declared ONCE at module scope so the
 * hoisted {@link Head} and the rotated block headers are drawn in the same face at the
 * same size, which is also the face `headLabelFloorPx` measures against.
 */
const HEAD_FONT: React.CSSProperties = { fontSize: `${HEAD_FONT_PT}pt`, lineHeight: '8px' };
/** Padding around a rotated header label, top and bottom. */
const HEAD_PAD_PX = 10;
/** Floor / ceiling on the rotated header band. */
const HEAD_H_MIN = 44;
const HEAD_H_MAX = 112;

/**
 * THE MEASURED CEILING THIS REPORT PROMISES: **{@link RCM_PRINT_MAX_BLOCK_COLUMNS}
 * block columns on one sheet**, beside the full spine, the PRODUCED total and ONE
 * grade column, at the 5pt floor.
 *
 * Above it the sheet paginates by columns rather than shrinking below the floor. The
 * figure is arithmetic over the SAME solver the sheet itself runs, so it cannot drift
 * from what the sheet does; `scripts/verify-rc-movement-grid.ts` pins it.
 *
 * Each extra GRADE column costs roughly one block column, so a three-grade campaign's
 * ceiling is two lower — {@link rcMovementPrintLayout} computes the real number for
 * the data in hand and the heading says which slice a page is showing.
 *
 * The widest campaign the yard has ever fed is 32 block columns (MARCH 2026), so a
 * campaign CAN exceed this and the column-pagination path is a live path, not a
 * theoretical one.
 */
export const RCM_PRINT_MAX_BLOCK_COLUMNS = maxRepeatingColumns({
    fixed: [
        { key: 'rownum', chars: 3 },
        { key: 'date', chars: 10 },
        { key: 'day', chars: 3 },
        { key: 'fedphp', chars: 6 },
        { key: 'total', chars: 8 },
        { key: 'produced', chars: 8 },
        { key: 'grade', chars: 8 },
    ],
    unit: { key: 'block', chars: 7 },
    availablePx: PAGE.widthPx,
    fontPt: FONT_FLOOR,
    padPx: PAD_PX,
    advanceEm: RCM_MONO_ADVANCE_EM,
});

// ─── The printed column model ────────────────────────────────────────────────────

/**
 * The spine headers' printed labels — ONE definition, read by the SOLVER and by the
 * SHEET. A column sized from one string and printed with another is how a header
 * clips, so the two can only ever be the same string.
 *
 * They are shorter than the screen's (`Fed ₱/kg` → `₱/kg`, `Total fed` → `Fed kg`)
 * because paper has one column-width for them and the screen has a hover tooltip. This
 * is a rendering of the same column, not a renaming of it.
 */
const HEAD_LABEL = {
    rownum: '#',
    date: 'Date',
    day: 'Day',
    fedphp: '₱/kg',
    total: 'Fed kg',
    produced: 'Prod kg',
} as const;

/** The five footer lines, in printed order. `php` / `actual` are price-gated. */
type FooterKind = 'total' | 'yield' | 'loss' | 'php' | 'actual';

const FOOTER_LABEL: Record<FooterKind, string> = {
    total: 'TOTAL',
    yield: 'YIELD %',
    loss: 'LOSS %',
    php: '₱/KG',
    actual: 'ACTUAL ₱',
};

/**
 * Which footer lines this sheet carries.
 *
 * The three peso-free ones are unconditional; `₱/KG` follows the price gate and
 * `ACTUAL ₱` follows the gate AND the screen's `Actual ₱` switch — so what is printed
 * is what was on the screen when the button was pressed, and a price-denied reader's
 * sheet has no ₱ row on it at all.
 */
function footerKinds(showFedPrice: boolean, showActual: boolean): FooterKind[] {
    const out: FooterKind[] = ['total', 'yield', 'loss'];
    if (showFedPrice) out.push('php');
    if (showFedPrice && showActual) out.push('actual');
    return out;
}

/** Every string a spine/produced column will render, so its width can be measured. */
function longest(values: readonly string[]): number {
    let n = 0;
    for (const v of values) if (v.length > n) n = v.length;
    return n;
}

/**
 * A SPINE HEADER'S OWN FLOOR, in px.
 *
 * The body font can be several steps smaller than the HEADER font, so a column sized
 * only by its data can be too narrow for its own label — the first PDF of this feature
 * printed `DAY` with the Y sliced off, over a column sized for `Wed` at 5pt. The
 * measurement is per WORD rather than per label because a spine header is allowed to
 * wrap (`PROD KG` prints on two lines and is happy); a single word cannot, so IT is the
 * floor. The spine headers are rendered in the SAME mono face as the block headers, so
 * this metric is the one that actually applies rather than an approximation of a
 * different font.
 */
function headLabelFloorPx(label: string): number {
    const word = label.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
    return Math.ceil(word.length * monoCharPx(HEAD_FONT_PT, RCM_MONO_ADVANCE_EM)) + PAD_PX;
}

export interface RcMovementPrintPageLayout {
    /** The block columns on THIS page. */
    blocks: RcMovementMatrixColumn[];
    /** 0-based index of the first block on this page, for the `blocks a–b of n` line. */
    firstBlockIndex: number;
}

export interface RcMovementPrintLayout {
    /** Body font, in points. Never below {@link FONT_FLOOR}. */
    fontPt: number;
    /** Every row's exact height, in px. */
    rowH: number;
    /** The line box inside a row. */
    lineH: number;
    /** The rotated header band's height, in px. */
    headH: number;
    /** Per-key column width in px. Block columns share the `block` key's width. */
    widths: Record<string, number>;
    /** Σ of every column's width on one page. */
    tableWidthPx: number;
    /** The footer lines this sheet carries. */
    footers: FooterKind[];
    /** FALSE when the day rows overflow even at {@link ROW_MIN} — the page flows. */
    fitsVertically: boolean;
    /** FALSE when the columns had to be split across sheets. */
    fitsHorizontally: boolean;
    /**
     * The CAPACITY that decided the split — how many block columns a sheet could hold
     * at the tightest font the whole column set allows.
     *
     * It is NOT the number a page ends up carrying: `splitEvenly` balances, so 32
     * columns at a capacity of 26 gives two pages of 16, and the type is then re-solved
     * for 16. Read `pages[i].blocks.length` for what a sheet actually shows.
     */
    blocksPerPage: number;
    /** One entry per printed sheet. Exactly one when everything fits. */
    pages: RcMovementPrintPageLayout[];
}

/**
 * THE SOLVER — one function, so the sheet and every assertion about the sheet read
 * the same arithmetic.
 *
 * Pure, and it takes the payload rather than fetching anything. Exported so
 * `scripts/verify-rc-movement-grid.ts` can pin the fit on synthetic shapes without a
 * browser, and so a fixture can mount the sheet in a real print box and check that the
 * page it measures is the page this predicted.
 */
export function rcMovementPrintLayout(
    data: RcMovementMatrixData,
    showActualPrice: boolean,
): RcMovementPrintLayout {
    const showFedPrice = data.canViewPrices;
    const actual = showFedPrice ? data.campaignActualFedPrice : null;
    const footers = footerKinds(showFedPrice, showActualPrice);
    const grades = data.producedGrades;

    // ── The rotated header band. It is sized by the LONGEST batch code, because that
    //    is what is standing on end; the block_loc rides beside it and is always
    //    shorter. Fixed chrome: it does not move with the block COUNT, which is the
    //    whole reason the header is rotated in the first place.
    const headChars = Math.max(
        4,
        ...data.columns.map((c) => Math.max(c.batchCode.length, (c.blockLoc ?? '—').length)),
    );
    const headH = Math.min(
        HEAD_H_MAX,
        Math.max(
            HEAD_H_MIN,
            Math.ceil(headChars * monoCharPx(HEAD_FONT_PT, RCM_MONO_ADVANCE_EM)) + HEAD_PAD_PX,
        ),
    );

    // ── VERTICAL. The footer lines are rows drawn at the body font, so they are in the
    //    DIVISOR and not in the chrome.
    const rowCount = data.rows.length + footers.length;
    const rowBudget = PAGE.heightPx - (CHROME_TITLE + CHROME_GAP + headH + CHROME_SLACK);
    const rowFit = fitRowHeight({
        budgetPx: rowBudget,
        rowCount,
        minRowH: ROW_MIN,
        maxRowH: ROW_MAX,
        chromePx: ROW_CHROME_PX,
        ladder: ROW_FONT_LADDER,
    });

    // ── HORIZONTAL. Every column's demand is the LONGEST STRING IT WILL ACTUALLY
    //    RENDER — header label included — so a column cannot clip and a width cannot
    //    be sized to a value that happens to be typical.
    const kgStrings = (pick: (r: RcMovementMatrixRow) => number | null | undefined) =>
        data.rows.map((r) => fmtKg(pick(r) ?? undefined));

    const blockStrings: string[] = [];
    for (const r of data.rows) {
        for (const c of data.columns) blockStrings.push(fmtKg(r.fedByBatch[c.batchId]));
    }
    for (const c of data.columns) {
        blockStrings.push(fmtKg(c.campaignFedKg ?? undefined));
        blockStrings.push(fmtLossPct(c.blockLoss));
        if (showFedPrice) blockStrings.push(fmtPrice(c.avgFedPrice));
        if (showFedPrice && showActualPrice) blockStrings.push(fmtPrice(c.actualFedPrice));
    }

    const demands: PrintColumnDemand[] = [
        {
            key: 'rownum',
            chars: Math.max(1, String(data.rows.length).length),
            minPx: headLabelFloorPx(HEAD_LABEL.rownum),
        },
        {
            key: 'date',
            chars: longest(data.rows.map((r) => r.date)),
            minPx: headLabelFloorPx(HEAD_LABEL.date),
        },
        {
            key: 'day',
            chars: longest(data.rows.map((r) => r.dayOfWeek)),
            minPx: headLabelFloorPx(HEAD_LABEL.day),
        },
    ];
    if (showFedPrice) {
        demands.push({
            key: 'fedphp',
            chars: longest([
                ...data.rows.map((r) => fmtPrice(r.avgFedPriceDay)),
                fmtPrice(data.campaignAvgFedPrice),
                fmtPrice(actual?.actualFedPhpKg ?? null),
            ]),
            minPx: headLabelFloorPx(HEAD_LABEL.fedphp),
        });
    }
    demands.push(
        {
            key: 'total',
            chars: longest([...kgStrings((r) => r.totalFed), fmtKg(data.grandTotalFed)]),
            minPx: headLabelFloorPx(HEAD_LABEL.total),
        },
        {
            key: 'produced',
            chars: longest([
                ...kgStrings((r) => r.totalProduced),
                fmtKg(data.campaignTotalProduced ?? undefined),
                fmtYieldPct(data.campaignYieldPct),
            ]),
            minPx: headLabelFloorPx(HEAD_LABEL.produced),
        },
    );
    const gradeChars = longest(
        grades.flatMap((g) => [
            ...data.rows.map((r) => fmtKg(r.producedByGrade[g.grade])),
            fmtKg(g.campaignTotal ?? undefined),
        ]),
    );
    for (const g of grades) {
        demands.push({
            key: `grade:${g.grade}`,
            chars: gradeChars,
            minPx: headLabelFloorPx(g.grade),
        });
    }

    const blockChars = Math.max(3, longest(blockStrings));
    const blockDemand: PrintColumnDemand = { key: 'block', chars: blockChars };
    for (const c of data.columns) {
        demands.push({ key: `block:${c.batchId}`, chars: blockChars });
    }

    const widthFit = fitColumnWidths({
        columns: demands,
        availablePx: PAGE.widthPx,
        ladder: FONT_LADDER,
        padPx: PAD_PX,
        advanceEm: RCM_MONO_ADVANCE_EM,
    });

    // ── THE SPLIT IS DECIDED AT THE CAPACITY FONT, THE TYPE IS SIZED FOR THE PAGE ────
    //
    // `capacityFontPt` answers "how many block columns could a sheet EVER hold" — the
    // tighter of the two solves over the WHOLE column set (a row taller than its font
    // needs is merely airy; a column narrower than its digits is a CLIPPED NUMBER, so
    // width wins wherever the two disagree). That is the right font for deciding the
    // split, and the WRONG font for printing the result.
    const capacityFontPt = Math.min(rowFit.fontPt, widthFit.fontPt);

    const fixed = demands.filter((d) => !d.key.startsWith('block:'));
    const blocksPerPage = maxRepeatingColumns({
        fixed,
        unit: blockDemand,
        availablePx: PAGE.widthPx,
        fontPt: capacityFontPt,
        padPx: PAD_PX,
        advanceEm: RCM_MONO_ADVANCE_EM,
    });

    const chunks = splitEvenly(data.columns, blocksPerPage);
    let seen = 0;
    const pages: RcMovementPrintPageLayout[] = chunks.map((blocks) => {
        const page = { blocks, firstBlockIndex: seen };
        seen += blocks.length;
        return page;
    });

    // ── THEN RE-SOLVE FOR WHAT A PAGE ACTUALLY CARRIES ──────────────────────────────
    //
    // Once the blocks have been SPLIT, a sheet no longer carries every column, so
    // sizing its type for all of them prints far smaller than the paper requires.
    // MEASURED: 33 days × 32 blocks splits 16 + 16, and the whole-set solve pinned both
    // sheets at the 5pt FLOOR — 16 columns of `150,000` in gutters wide enough for 26.
    // Re-solved against the widest page's own demands they print at 7pt, two ladder
    // steps larger, for the same one-page-per-chunk promise.
    //
    // It cannot loop and it cannot overflow: the split was taken at `capacityFontPt`,
    // so a chunk is by construction no wider than a sheet at that font, and a solve over
    // FEWER columns can only ever return a font ≥ that one. `splitEvenly` balances, so
    // every sheet of a report is sized by the same widest page and the set still reads
    // as one document.
    //
    // **When everything fits on one page this is a no-op by construction** — the page
    // demands are then the same count at the same `chars` as `demands`, so the solve is
    // arithmetically identical and the single-sheet path is untouched.
    const widestPageBlocks = Math.max(...pages.map((p) => p.blocks.length));
    const pageDemands: PrintColumnDemand[] = [
        ...fixed,
        ...Array.from({ length: widestPageBlocks }, (_, i) => ({
            key: `block:page:${i}`,
            chars: blockChars,
        })),
    ];
    const pageWidthFit = fitColumnWidths({
        columns: pageDemands,
        availablePx: PAGE.widthPx,
        ladder: FONT_LADDER,
        padPx: PAD_PX,
        advanceEm: RCM_MONO_ADVANCE_EM,
    });
    const fontPt = Math.min(rowFit.fontPt, pageWidthFit.fontPt);

    // Re-solve the widths at the font actually used, so a vertically-constrained sheet
    // does not print 5pt digits in columns sized for 9pt (and vice versa).
    const finalWidths = fitColumnWidths({
        columns: pageDemands,
        availablePx: PAGE.widthPx,
        ladder: [fontPt],
        padPx: PAD_PX,
        advanceEm: RCM_MONO_ADVANCE_EM,
    });

    // The table width for ONE page: the fixed columns plus that page's own blocks. The
    // widest page is what the caller sizes against; a shorter continuation sheet simply
    // stretches (`width: 100%` + `table-fixed` shares the slack out).
    const fixedPx = fixed.reduce((a, d) => a + (finalWidths.widths[d.key] ?? 0), 0);
    const blockPx = finalWidths.widths['block:page:0'] ?? 0;
    const tableWidthPx = fixedPx + blockPx * widestPageBlocks;

    return {
        fontPt,
        rowH: rowFit.rowH,
        lineH: rowFit.lineH,
        headH,
        widths: { ...finalWidths.widths, block: blockPx },
        tableWidthPx,
        footers,
        fitsVertically: rowFit.fits,
        fitsHorizontally: chunks.length === 1,
        blocksPerPage,
        pages,
    };
}

// ─── The print rules ─────────────────────────────────────────────────────────────

/**
 * The `@page` block plus this report's own scoped rules.
 *
 * EXPORTED so the sheet can be mounted STATICALLY in a real print box and measured —
 * a page-fitting promise verified by estimating the page is not verified at all.
 */
export const RC_MOVEMENT_PRINT_RULES = buildPrintPageRules({
    scopeAttr: 'data-rcm-print',
    marginMm: RCM_PRINT_MARGIN_MM,
    extraCss: `
[data-rcm-print] .rcm-vhead {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  white-space: nowrap;
  line-height: 1;
}
`,
});

// ─── The sheet ───────────────────────────────────────────────────────────────────

const HEAD_BASE =
    'border border-zinc-400 border-t-2 px-[1px] font-semibold uppercase overflow-hidden';
const CELL_BASE = 'border border-zinc-300 px-[1px] whitespace-nowrap overflow-hidden';
const NUM = 'font-mono tabular-nums';

/**
 * A spine/produced header cell — horizontal, bottom-aligned in the rotated band.
 *
 * MODULE SCOPE, not a closure inside the sheet: a component declared during render is a
 * NEW component type on every render, so React remounts it and throws its state away
 * (`react-hooks/static-components`). This one is stateless, so nothing broke — but the
 * rule is about the shape, not the symptom, and the fix costs two explicit props.
 */
function Head({
    label,
    tone,
    width,
    headH,
    right,
}: {
    label: string;
    tone: RcmPrintTone;
    width: number;
    headH: number;
    right?: boolean;
}) {
    return (
        <th
            className={cn(
                HEAD_BASE,
                RCM_PRINT_TONE[tone].head,
                RCM_PRINT_TONE[tone].edge,
                right ? 'text-right' : 'text-left',
                'align-bottom',
            )}
            style={{ ...HEAD_FONT, height: headH, width }}
        >
            {/* MONO, like the rotated block headers — so `headLabelFloorPx` measures the
                face the label is actually drawn in. `whitespace-normal` lets a two-word
                label wrap, which is why the floor is measured per WORD. */}
            <span className="block whitespace-normal pb-[2px] font-mono leading-[8px]">
                {label}
            </span>
        </th>
    );
}

interface SheetProps {
    data: RcMovementMatrixData;
    layout: RcMovementPrintLayout;
    page: RcMovementPrintPageLayout;
    pageIndex: number;
    pageCount: number;
    printedAt: string;
}

/** ONE PAGE — the heading line and the matrix. Nothing else; paper carries no prose. */
export function RcMovementPrintSheet({
    data,
    layout,
    page,
    pageIndex,
    pageCount,
    printedAt,
}: SheetProps) {
    const showFedPrice = data.canViewPrices;
    const actual = showFedPrice ? data.campaignActualFedPrice : null;
    const grades = data.producedGrades;
    const blocks = page.blocks;

    const bodyFont: React.CSSProperties = {
        fontSize: `${layout.fontPt}pt`,
        lineHeight: `${layout.lineH}px`,
        height: layout.rowH,
    };
    const firstDate = data.rows[0]?.date ?? '';
    const lastDate = data.rows[data.rows.length - 1]?.date ?? '';
    const slice =
        pageCount > 1
            ? ` · blocks ${page.firstBlockIndex + 1}–${page.firstBlockIndex + blocks.length} of ${data.columns.length}`
            : '';

    /** What a footer line puts in a BLOCK column. */
    const footerBlockValue = (kind: FooterKind, c: RcMovementMatrixColumn): string => {
        switch (kind) {
            case 'total':
                return c.campaignFedKg !== null ? fmtKg(c.campaignFedKg) || '0' : '—';
            case 'yield':
                return '';
            case 'loss':
                return fmtLossPct(c.blockLoss);
            case 'php':
                return fmtPrice(c.avgFedPrice);
            case 'actual':
                return fmtPrice(c.actualFedPrice);
        }
    };

    /** What a footer line puts in the spine's ₱/kg column. */
    const footerFedPhp = (kind: FooterKind): string => {
        if (kind === 'total') return fmtPrice(data.campaignAvgFedPrice);
        if (kind === 'actual') return fmtPrice(actual?.actualFedPhpKg ?? null);
        return '';
    };

    /** What a footer line puts in the PRODUCED column. */
    const footerProduced = (kind: FooterKind): string => {
        if (kind === 'total') return fmtKg(data.campaignTotalProduced ?? undefined) || '—';
        if (kind === 'yield') return fmtYieldPct(data.campaignYieldPct);
        if (kind === 'loss')
            return fmtYieldPct(
                data.campaignYieldPct === null ? null : 1 - data.campaignYieldPct,
            );
        return '';
    };

    return (
        <article data-rcm-print className="flex flex-col gap-1 bg-white text-black">
            {/* THE HEADING — ONE LINE. Tenant-neutral name, the campaign, the span, the
                coverage, and when it was printed. A printed figure that does not say what
                it is and when it was true is a figure somebody misquotes a month later. */}
            <div
                className="flex items-baseline justify-between gap-2"
                style={{ lineHeight: `${CHROME_TITLE - 2}px` }}
            >
                <div className="flex items-baseline gap-2">
                    <h1 className="text-[9pt] font-semibold uppercase tracking-tight text-zinc-900">
                        RC Movement · {data.campaignLabel || '—'}
                    </h1>
                    <p className={cn(NUM, 'text-[6pt] text-zinc-600')}>
                        {firstDate} → {lastDate} · {data.rows.length} days ·{' '}
                        {data.columns.length} blocks
                        {slice}
                    </p>
                </div>
                <p className={cn(NUM, 'text-[6pt] text-zinc-600')}>
                    Printed {printedAt}
                    {pageCount > 1 ? ` · page ${pageIndex + 1}/${pageCount}` : ''}
                </p>
            </div>

            <table
                className="table-fixed border-collapse text-black"
                style={{ width: '100%', borderCollapse: 'collapse' }}
            >
                <colgroup>
                    <col style={{ width: layout.widths.rownum }} />
                    <col style={{ width: layout.widths.date }} />
                    <col style={{ width: layout.widths.day }} />
                    {showFedPrice ? <col style={{ width: layout.widths.fedphp }} /> : null}
                    <col style={{ width: layout.widths.total }} />
                    <col style={{ width: layout.widths.produced }} />
                    {grades.map((g) => (
                        <col key={`col-${g.grade}`} style={{ width: layout.widths[`grade:${g.grade}`] }} />
                    ))}
                    {blocks.map((c) => (
                        <col key={`col-${c.batchId}`} style={{ width: layout.widths.block }} />
                    ))}
                </colgroup>

                {/* `<thead>` keeps `table-header-group` — a header that repeats on an
                    overlong campaign is a help. The footer deliberately does NOT repeat;
                    it is the last `<tbody>` rows, see the file header. */}
                <thead>
                    <tr style={{ height: layout.headH }}>
                        <Head
                            label={HEAD_LABEL.rownum}
                            tone="day"
                            width={layout.widths.rownum}
                            headH={layout.headH}
                            right
                        />
                        <Head
                            label={HEAD_LABEL.date}
                            tone="day"
                            width={layout.widths.date}
                            headH={layout.headH}
                        />
                        <Head
                            label={HEAD_LABEL.day}
                            tone="day"
                            width={layout.widths.day}
                            headH={layout.headH}
                        />
                        {showFedPrice ? (
                            <Head
                                label={HEAD_LABEL.fedphp}
                                tone="money"
                                width={layout.widths.fedphp}
                                headH={layout.headH}
                                right
                            />
                        ) : null}
                        <Head
                            label={HEAD_LABEL.total}
                            tone="fed"
                            width={layout.widths.total}
                            headH={layout.headH}
                            right
                        />
                        <Head
                            label={HEAD_LABEL.produced}
                            tone="produced"
                            width={layout.widths.produced}
                            headH={layout.headH}
                            right
                        />
                        {grades.map((g) => (
                            <Head
                                key={`hd-${g.grade}`}
                                label={g.grade}
                                tone="produced"
                                width={layout.widths[`grade:${g.grade}`]}
                                headH={layout.headH}
                                right
                            />
                        ))}
                        {/* THE ROTATED BLOCK HEADERS. Standing the label on end is what
                            lets a 16-character batch code sit over a column sized for a
                            7-character number. */}
                        {blocks.map((c) => (
                            <th
                                key={`hd-${c.batchId}`}
                                className={cn(
                                    HEAD_BASE,
                                    RCM_PRINT_TONE.block.head,
                                    RCM_PRINT_TONE.block.edge,
                                    'p-0 align-bottom',
                                )}
                                style={{ height: layout.headH, width: layout.widths.block }}
                            >
                                <span
                                    className="flex h-full items-end justify-center gap-[1px] pb-[3px]"
                                    style={{ height: layout.headH }}
                                >
                                    <span className="rcm-vhead font-mono font-semibold" style={HEAD_FONT}>
                                        {c.batchCode}
                                    </span>
                                    <span
                                        className="rcm-vhead font-mono font-normal text-zinc-700"
                                        style={{ fontSize: '5pt', lineHeight: '7px' }}
                                    >
                                        {c.blockLoc ?? '—'}
                                    </span>
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>

                <tbody>
                    {data.rows.map((row) => {
                        const zero = row.totalFed === 0;
                        const weekend = row.dayOfWeek === 'Sat' || row.dayOfWeek === 'Sun';
                        return (
                            <tr key={row.date}>
                                <td
                                    className={cn(CELL_BASE, NUM, 'text-right', PRINT_MUTED_TEXT)}
                                    style={bodyFont}
                                >
                                    {row.rowNum}
                                </td>
                                <td
                                    className={cn(
                                        CELL_BASE,
                                        NUM,
                                        'text-left',
                                        zero ? PRINT_MUTED_TEXT : 'text-zinc-900',
                                    )}
                                    style={bodyFont}
                                >
                                    {row.date}
                                </td>
                                <td
                                    className={cn(
                                        CELL_BASE,
                                        'text-left',
                                        weekend ? PRINT_WEEKEND_TEXT : PRINT_MUTED_TEXT,
                                    )}
                                    style={bodyFont}
                                >
                                    {row.dayOfWeek}
                                </td>
                                {showFedPrice ? (
                                    <td
                                        className={cn(
                                            CELL_BASE,
                                            NUM,
                                            'text-right',
                                            RCM_PRINT_TONE.money.cell,
                                            RCM_PRINT_TONE.money.value,
                                        )}
                                        style={bodyFont}
                                    >
                                        {fmtPrice(row.avgFedPriceDay)}
                                    </td>
                                ) : null}
                                <td
                                    className={cn(
                                        CELL_BASE,
                                        NUM,
                                        'text-right font-semibold',
                                        RCM_PRINT_TONE.fed.cell,
                                        zero ? PRINT_MUTED_TEXT : RCM_PRINT_TONE.fed.value,
                                    )}
                                    style={bodyFont}
                                >
                                    {fmtKg(row.totalFed)}
                                </td>
                                <td
                                    className={cn(
                                        CELL_BASE,
                                        NUM,
                                        'text-right',
                                        RCM_PRINT_TONE.produced.cell,
                                        RCM_PRINT_TONE.produced.value,
                                    )}
                                    style={bodyFont}
                                >
                                    {fmtKg(row.totalProduced ?? undefined)}
                                </td>
                                {grades.map((g) => (
                                    <td
                                        key={`bd-${row.date}-${g.grade}`}
                                        className={cn(
                                            CELL_BASE,
                                            NUM,
                                            'text-right',
                                            RCM_PRINT_TONE.produced.cell,
                                            RCM_PRINT_TONE.produced.value,
                                        )}
                                        style={bodyFont}
                                    >
                                        {fmtKg(row.producedByGrade[g.grade])}
                                    </td>
                                ))}
                                {blocks.map((c) => {
                                    const kg = row.fedByBatch[c.batchId];
                                    const fed = !!kg && kg !== 0;
                                    return (
                                        <td
                                            key={`bd-${row.date}-${c.batchId}`}
                                            className={cn(
                                                CELL_BASE,
                                                NUM,
                                                'text-right',
                                                fed ? cn(PRINT_FED_CELL, 'text-zinc-900') : '',
                                            )}
                                            style={bodyFont}
                                        >
                                            {fmtKg(kg)}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}

                    {/* ── THE FOOTER, AS `<tbody>` ROWS ─────────────────────────────
                        The screen's frozen summary footer, unrolled: one row per line it
                        stacks. The block band keeps `printStatusTint` — which is the one
                        thing on the sheet that says, at a glance, which piles are
                        finished (red) and which are still being fed (blue). */}
                    {layout.footers.map((kind, i) => (
                        <tr key={`ft-${kind}`}>
                            {/* The three spine columns carry ONE label across all of them —
                                a `colSpan`, so the label has room without widening the DATE
                                column for every day row above it. */}
                            <td
                                colSpan={3}
                                className={cn(
                                    CELL_BASE,
                                    PRINT_NEUTRAL_FILL,
                                    'text-left font-semibold uppercase tracking-wide text-zinc-900',
                                    i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                )}
                                style={bodyFont}
                            >
                                {FOOTER_LABEL[kind]}
                            </td>
                            {showFedPrice ? (
                                <td
                                    className={cn(
                                        CELL_BASE,
                                        NUM,
                                        'text-right font-semibold',
                                        RCM_PRINT_TONE.money.cell,
                                        RCM_PRINT_TONE.money.value,
                                        i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                    )}
                                    style={bodyFont}
                                >
                                    {footerFedPhp(kind)}
                                </td>
                            ) : null}
                            <td
                                className={cn(
                                    CELL_BASE,
                                    NUM,
                                    'text-right font-semibold',
                                    RCM_PRINT_TONE.fed.cell,
                                    RCM_PRINT_TONE.fed.value,
                                    i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                )}
                                style={bodyFont}
                            >
                                {kind === 'total' ? fmtKg(data.grandTotalFed) : ''}
                            </td>
                            <td
                                className={cn(
                                    CELL_BASE,
                                    NUM,
                                    'text-right font-semibold',
                                    RCM_PRINT_TONE.produced.cell,
                                    RCM_PRINT_TONE.produced.value,
                                    i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                )}
                                style={bodyFont}
                            >
                                {footerProduced(kind)}
                            </td>
                            {grades.map((g) => (
                                <td
                                    key={`ft-${kind}-${g.grade}`}
                                    className={cn(
                                        CELL_BASE,
                                        NUM,
                                        'text-right font-semibold',
                                        RCM_PRINT_TONE.produced.cell,
                                        RCM_PRINT_TONE.produced.value,
                                        i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                    )}
                                    style={bodyFont}
                                >
                                    {kind === 'total' ? fmtKg(g.campaignTotal ?? undefined) : ''}
                                </td>
                            ))}
                            {blocks.map((c) => {
                                const closed = c.status === 'CLOSED' || c.status === 'FEED';
                                const lossTone =
                                    kind !== 'loss' || c.blockLoss === null
                                        ? ''
                                        : closed
                                          ? '' // inherit the red band's own foreground
                                          : c.blockLoss < 0
                                            ? PRINT_LOSS_TEXT
                                            : PRINT_GAIN_TEXT;
                                return (
                                    <td
                                        key={`ft-${kind}-${c.batchId}`}
                                        className={cn(
                                            CELL_BASE,
                                            NUM,
                                            'text-right',
                                            kind === 'total' && 'font-semibold',
                                            printStatusTint(c.status),
                                            lossTone,
                                            i === 0 && 'border-t-[1.5px] border-t-zinc-700',
                                        )}
                                        style={bodyFont}
                                    >
                                        {footerBlockValue(kind, c)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </article>
    );
}

// ─── The control ─────────────────────────────────────────────────────────────────

export interface RcMovementPrintControlProps {
    data: RcMovementMatrixData;
    /** The `Actual ₱` switch, as the screen has it — what is printed is what is shown. */
    showActualPrice: boolean;
    className?: string;
}

/** `yyyy-MM-dd HH:mm` — the project's date format, plus the clock. */
function stamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function RcMovementPrintControl({
    data,
    showActualPrice,
    className,
}: RcMovementPrintControlProps) {
    // Non-null MOUNTS the offstage stage, which calls `printCard` on itself once it has
    // laid out and unmounts on `afterprint`. The timestamp is captured HERE, on the
    // click, so it is client-only and can never be a hydration mismatch.
    const [printedAt, setPrintedAt] = React.useState<string | null>(null);
    usePrintPageRules(printedAt ? RC_MOVEMENT_PRINT_RULES : null, 'bw-rcm-print-rules');

    const hasData = data.columns.length > 0 && data.rows.length > 0;
    const layout = React.useMemo(
        () => rcMovementPrintLayout(data, showActualPrice),
        [data, showActualPrice],
    );

    if (!hasData) return null;

    const pageCount = layout.pages.length;

    return (
        <>
            <button
                type="button"
                onClick={() => setPrintedAt(stamp(new Date()))}
                title={
                    pageCount === 1
                        ? `Print ${data.campaignLabel || 'this campaign'} — all ${data.rows.length} days and all ${data.columns.length} block columns on one A4 landscape sheet, in colour.`
                        : `Print ${data.campaignLabel || 'this campaign'} — ${data.columns.length} block columns do not fit one sheet at a legible size, so the blocks are split across ${pageCount} sheets with the day spine repeated on each.`
                }
                className={cn(
                    'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    className,
                )}
            >
                <Printer className="size-3.5" />
                <span>Print</span>
            </button>

            {/* ── THE STAGE IS PORTALLED TO <body>, AND THAT IS NOT A DETAIL ─────────
                `printCard` flattens every ancestor from the card up to `<body>` with
                `transform: none`, and Tailwind v4 centres an overlay with the INDIVIDUAL
                `translate` property — which `transform: none` does not reset, and which
                cannot be reset from the print stylesheet either (Lightning CSS folds a
                `translate` reset back into a `transform` shorthand). This screen's
                trigger is an ordinary toolbar button, but the Classic matrix is ALSO
                hosted inside `/operations`' RC FED modal, so the portal is what keeps
                the sheet out of a translated ancestor there. */}
            {printedAt
                ? createPortal(
                      <GroupPrintStage
                          // NO STAGE HEADER — every page carries its own heading line,
                          // and a second one restating the campaign is wordiness.
                          showHeader={false}
                          title={`RC Movement · ${data.campaignLabel}`}
                          subtitle={`${data.rows.length} days · ${data.columns.length} blocks`}
                          countLabel={`${pageCount} page${pageCount === 1 ? '' : 's'}`}
                          onDone={() => setPrintedAt(null)}
                      >
                          {layout.pages.map((page, i) => (
                              <GroupPrintPage key={`rcm-print-${page.firstBlockIndex}`}>
                                  <RcMovementPrintSheet
                                      data={data}
                                      layout={layout}
                                      page={page}
                                      pageIndex={i}
                                      pageCount={pageCount}
                                      printedAt={printedAt}
                                  />
                              </GroupPrintPage>
                          ))}
                      </GroupPrintStage>,
                      document.body,
                  )
                : null}
        </>
    );
}
