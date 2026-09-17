'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';

import { GroupPrintPage, GroupPrintStage } from '@/components/shared/print/group-print';
import { cn } from '@/lib/utils';
import type {
  OpsCampaignRollup,
  OpsLedgerData,
  OpsLedgerDay,
} from '@/lib/operations/types';
import { count, hours, kg, pctFromFraction, php } from './ops-format';
import {
  PRINT_MUTED_TEXT,
  PRINT_NEUTRAL_FILL,
  PRINT_TONE,
  PRINT_WEEKEND_TEXT,
  type OpsTone,
} from './ops-color';
import { opsKpiPrintTable, type OpsKpiPrintColumn, type OpsKpiPrintRow } from './ops-kpi-strip';
import { quarterPresets, type OpsQuarterOption } from './ops-lens';

// ═════════════════════════════════════════════════════════════════════════════════
// PRINT THE WHOLE PAGE — ONE SECTION PER SHEET (2026-09-17).
//
// Renzo: *"Have a print button on the main page. It should print each section
// separately. For this Q3 2026 view: first the EOQ Roll Up in one page, then the 1st
// month in one page, 2nd month in another, 3rd in another. Legibility is key, so just
// the key data. Output ratios group should be off by default when printing since it is
// redundant. Each month page should also have a little table giving the EOM rollup for
// that month. Maybe its own KPI strip up top also."*
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────────
//   Page 1      the EOQ ROLLUP — one row per campaign plus the GROUP row.
//   Pages 2..N  one per campaign: its own KPI strip (WHICH IS the EOM rollup — it is
//               the same eleven published figures, so it is printed ONCE and not
//               again as a separate little table underneath), then the day ledger.
//
// **A ONE-CAMPAIGN SELECTION PRINTS ONE PAGE, NOT TWO.** With a single campaign there
// is no GROUP row, so page 1's rollup table would be one row — byte-identical to the
// campaign page's own KPI strip. Printing the same eleven numbers on two consecutive
// sheets is exactly the duplication the note above forbids, so the EOQ page is
// rendered only when there is a group to roll up.
//
// ── WHAT IS ON THE LEDGER, AND WHAT IS NOT ──────────────────────────────────────
// KEY DATA ONLY: `DATE · DAY · FED ₱/kg · FED kg · PROD kg · WASTE kg · WASTE % ·
// SHIFTS · DT h`, then one column per GRADE. **OUTPUT RATIOS (YIELD % / LOSS %) are
// always off on paper** — they are the day-level indicative pair, and their caveat is
// a hover `title` that paper cannot carry, which is precisely why Renzo called them
// redundant here. The CAMPAIGN yield and loss are on the KPI strip at the top of the
// same page, where the ratio genuinely holds.
//
// **THE EIGHT WASTE STREAMS ARE DELIBERATELY NOT COLUMNS HERE, AND THE REASON IS NOW
// VERTICAL AS WELL AS HORIZONTAL.** The original measurement stands (at 8pt a stream
// column needs ~56px and eight of them put a four-grade campaign over the sheet's
// width), and round 9 adds the stronger one: the sheet's whole contract is that every
// day row of a campaign lands on ONE page, which is a VERTICAL BUDGET (see
// {@link ledgerMetrics}). Eight more columns do not cost height — but they force the
// body font down a step to keep the width, and the font step is exactly what buys the
// rows. The day's WASTE kg and WASTE % carry the total; the per-stream split is on
// screen under the Losses lens.
//
// ── NO PROSE, NO CAVEATS, NO TOOLTIP CONTENT ────────────────────────────────────
// Everything the screen says in words stays on the screen. A printed sheet carries a
// title, a span, numbers and their units.
//
// ── IT REUSES THE PLATFORM PRINT MECHANISM, UNCHANGED ───────────────────────────
// `GroupPrintStage` / `GroupPrintPage` / `printCard` from `components/shared/print/`,
// and the stage is PORTALLED to `<body>` for the reason `ops-print-sheet.tsx`'s header
// records: `printCard` flattens its ancestors with `transform: none`, Tailwind v4
// centres an overlay with the INDIVIDUAL `translate` property, and Lightning CSS folds
// a `translate` reset back into a `transform` shorthand — so the stage is moved out of
// any transformed ancestor rather than argued with. Here the trigger is an ordinary
// toolbar button rather than a dialog, but the portal costs nothing and keeps the two
// print paths on this screen identical.
//
// ═════════════════════════════════════════════════════════════════════════════════
// ROUND 9 (2026-09-17) — COLOUR, AND ONE PAGE PER CAMPAIGN GUARANTEED
//
// Renzo printed Q3 2026 and sent the PDF back: *"Print output lacks color. Hard to
// determine which data is which. Would be nice to have it follow the current
// operations sheet a bit (in light mode) but have colors that work well on print. Make
// it a point to make sure all rows + KPI strip per month fit in ONE page and not
// overflow to another. Making sure 32-33 rows fit in one A4 landscape page would be
// nice."*
//
// Three things were wrong in that PDF and all three are fixed here.
//
//  1. **THE ROW HEIGHT WAS A CONSTANT WHERE IT HAD TO BE A FUNCTION.** Every row was
//     whatever `text-[8pt]` with an inherited line-height happened to be (~19.5px), so
//     JULY 2026's 33 days ran 5 rows onto a third sheet and AUGUST's 29 ran ONE row
//     onto a fifth. The row height is now derived from the day COUNT against the
//     sheet's measured vertical budget — see {@link ledgerMetrics}.
//  2. **THE TOTALS ROW WAS A `<tfoot>`, AND CHROME REPEATS A `<tfoot>` ON EVERY PAGE.**
//     So `JULY 28 D 45.34 781,234 …` printed at the foot of page 2 AND again at the
//     foot of the overflow page, which reads as a duplicated total rather than as a
//     repeated header. It is the LAST `<tbody>` row now, styled as totals. `<thead>`
//     keeps `display: table-header-group` — a header that repeats is a help, a total
//     that repeats is a lie.
//  3. **IT WAS BLACK ON WHITE.** Now it carries the screen's own semantic palette in
//     explicit light values (`PRINT_TONE` in `ops-color.ts`), with
//     `print-color-adjust: exact` so a browser does not silently drop every fill.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * THE `@page` RULE, INJECTED FOR THE DURATION AND REMOVED AFTERWARDS.
 *
 * `app/globals.css` already sets `@page { size: A4 landscape; margin: 12mm }` — and
 * `@page` **cannot be scoped to a class**, so that rule governs every print in the
 * app, /analytics included. This report wants **8mm** (round 9: four more millimetres
 * of height is roughly two more day rows, and two more of width is roughly one more
 * grade column) plus the row/head break rules a multi-page table needs, and it must
 * not take them from /analytics.
 *
 * So the block is injected at print time and removed when the stage unmounts — which
 * is on `afterprint`, since that is what unmounts the stage. It comes LATER in
 * document order than `globals.css` at equal specificity, so it wins while it exists
 * and leaves nothing behind when it does not. Everything except the `@page` rule is
 * scoped to `[data-ops-print]`, so only this report's own tables are affected.
 *
 * **`print-color-adjust: exact` IS LOAD-BEARING, NOT A POLISH LINE.** Without it a
 * browser drops every background fill unless the person printing happens to tick
 * "Background graphics" in the dialog — i.e. the colour would be there in the markup
 * and absent from the paper, which is indistinguishable from not having built it.
 * `globals.css` already sets it on `[data-print-card] *` and the stage lives inside
 * one; it is re-stated here so this report's colour does not depend on a rule written
 * for a different one.
 *
 * **NO `tfoot` RULE ANY MORE** — there is no `<tfoot>` on this report, on purpose.
 *
 * EXPORTED so the sheet can be mounted STATICALLY and measured in a real print box —
 * a page-fitting promise verified by estimating the page is not verified at all. The
 * only consumer is a throwaway fixture; nothing in the app imports it.
 */
export const OPS_PAGE_PRINT_RULES = `
@page { size: A4 landscape; margin: 8mm; }
[data-ops-print], [data-ops-print] * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
[data-ops-print] table { break-inside: auto; }
[data-ops-print] thead { display: table-header-group; }
[data-ops-print] tr { break-inside: avoid; break-after: auto; }
`;

const STYLE_ID = 'bw-ops-page-print-rules';

function usePagePrintRules(active: boolean) {
  React.useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = OPS_PAGE_PRINT_RULES;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [active]);
}

// ─── The vertical budget ─────────────────────────────────────────────────────────
//
// THE ONE PROPERTY THIS REPORT PROMISES: *"all rows + KPI strip per month fit in ONE
// page"*. A promise about paper is arithmetic about paper, so the geometry is written
// down rather than guessed at.

/** CSS px per millimetre at the 96dpi the print box is laid out in. */
const PX_PER_MM = 96 / 25.4;
/** A4 landscape: 297mm wide × **210mm tall**. The short side is what runs out. */
const PAGE_H_MM = 210;
/** Matches the `@page` block above. Both must move together or neither may. */
const PAGE_MARGIN_MM = 8;
/** 194mm → **733.2px** of printable height. */
const PAGE_CONTENT_H = (PAGE_H_MM - 2 * PAGE_MARGIN_MM) * PX_PER_MM;

// THE FIXED CHROME, **MEASURED** in a real laid-out sheet pinned to the print box's own
// 1062px (2026-09-17, `app/dev/table-playground/opsprint/`, since deleted) — not
// estimated. Every one of these was squeezed this round, because a pixel taken off the
// chrome is a pixel handed to the rows.
/** Title + span, forced onto ONE line (they were two). Measured 17.00. */
const CHROME_TITLE = 17;
/** KPI strip: header + ONE campaign row, both single-line (WASTE LOSS was two). 33.50. */
const CHROME_KPI = 34;
/** The ledger header — ONE line, which is why the labels are shortened for print. 15.50. */
const CHROME_LEDGER_HEAD = 16;
/** `gap-1` × 2 between the three blocks of the page. */
const CHROME_GAPS = 8;

/**
 * SUB-PIXEL SLACK, measured rather than guessed.
 *
 * Collapsed borders and fractional row heights land the real page 1–2px above the sum
 * of its parts (a 33-day sheet computed 720 and measured 722). Six pixels is three
 * times the worst observed drift and costs nothing — at 19px rows it is a third of a
 * row.
 */
const CHROME_SLACK = 6;

const CHROME = CHROME_TITLE + CHROME_KPI + CHROME_LEDGER_HEAD + CHROME_GAPS + CHROME_SLACK;

/**
 * What is left for rows: **652px**.
 *
 * **THE TOTALS ROW IS NOT IN THE CHROME, IT IS IN THE DIVISOR.** It is a `<tbody>` row
 * drawn at the body font, so its height is `rowH` — the very thing being solved for —
 * and pinning it at a constant is what produced the first miss of this round: AUGUST's
 * 29 days computed to 22px rows and the page measured **736px against a 733px box**,
 * i.e. it would still have spilled by one row, which is exactly the bug being fixed.
 * Counting it as an `N + 1`-th row removes the circularity instead of approximating it.
 */
const ROW_BUDGET = PAGE_CONTENT_H - CHROME;

/**
 * THE COMFORTABLE CEILING — *"rows must not balloon"*.
 *
 * A short campaign has height to spare, and the temptation is to spend all of it. A
 * 19-day ledger divided into 641px would give 33px rows, which reads as a form rather
 * than a ledger. 22px is the Excel Standard's `h-8` (32px) scaled to paper's smaller
 * type, and it leaves the bottom of a short page honestly empty.
 */
const ROW_MAX = 22;

/**
 * THE 7pt FLOOR, AS A ROW HEIGHT.
 *
 * 7pt = 9.33px; at the 1.15 line-height this report uses that is 10.7px, plus 1px of
 * padding each side and the collapsed 1px border = **14px**. Below this the report
 * stops shrinking and lets the campaign flow onto a second sheet — a legible two-page
 * ledger beats an unreadable one-page one, and the ask was legibility first.
 */
const ROW_MIN = 14;

/**
 * THE DAY-COUNT CEILING THIS REPORT PROMISES: **45 day rows on one sheet**.
 *
 * `floor(652 / 14) − 1`, the −1 being the totals row. Above it the 7pt floor stops
 * shrinking and the page is allowed to FLOW rather than become illegible — a readable
 * two-page ledger beats an unreadable one-page one, and the ask was legibility first.
 *
 * **MEASURED, the render is two days MORE forgiving than the arithmetic: 47 days still
 * lands on one sheet and 48 takes a second** (headless Chrome, A4 landscape at 8mm,
 * `--print-to-pdf`, day counts 44…48). The gap is collapsed borders — adjacent rows
 * share one — so the constant under-promises by design; a page-fitting guarantee
 * derived from an over-estimate is the only kind worth publishing.
 *
 * **AND THE FLOW IS CLEAN, which is the other half of the promise.** `<thead>` repeats
 * on the second sheet and the totals row appears exactly ONCE, at the end — verified on
 * a 48-day page. That is what the `<tfoot>` → `<tbody>` move above buys.
 *
 * The plant's longest campaign to date is JULY 2026 at **33 ledger days** (a changeover
 * month, 2026-06-30 → 2026-08-01), so the promise carries twelve days of headroom over
 * anything the yard has ever produced.
 */
export const OPS_PRINT_MAX_ROWS_PER_PAGE = Math.floor(ROW_BUDGET / ROW_MIN) - 1;

interface LedgerMetrics {
  /** The exact height every day row will occupy, in px. */
  rowH: number;
  /** The body font for this page — 9 / 8.5 / 8 / 7.5 / 7 pt, never lower. */
  fontPt: number;
  /**
   * The line box inside the row. `rowH − (1px padding × 2) − 1px collapsed border`,
   * stated explicitly so the row height is DETERMINISTIC: a `<tr>` height is a floor
   * in the table model, so the only way to pin a row is to pin its content.
   */
  lineH: number;
  /** FALSE when even the 7pt floor overflows — the page is allowed to flow. */
  fitsOnePage: boolean;
}

/**
 * ROW HEIGHT AS A FUNCTION OF THE DAY COUNT.
 *
 * The budget is fixed and the row count is data, so the row height is the quotient
 * over `dayCount + 1` (the totals row is a row), clamped at both ends, and the font
 * steps DOWN with it. The ladder is deliberately coarse — five steps, not a continuous
 * scale — so two campaigns of similar length print at the same size and a quarter
 * reads as one document.
 *
 * Measured on the fixture at the real page width: 33 days → 19px at 9pt (720px page),
 * 29 → 21px at 9pt (704px), 19 → 22px at 9pt (514px). All three inside 733px.
 */
function ledgerMetrics(dayCount: number): LedgerMetrics {
  const rows = dayCount + 1;
  const raw = Math.floor(ROW_BUDGET / rows);
  const rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, raw));
  const fontPt = rowH >= 18 ? 9 : rowH >= 17 ? 8.5 : rowH >= 16 ? 8 : rowH >= 15 ? 7.5 : 7;
  return { rowH, fontPt, lineH: rowH - 3, fitsOnePage: rowH * rows <= ROW_BUDGET };
}

// ─── Geometry ────────────────────────────────────────────────────────────────────
//
// The widths below are PROPORTIONS, not minimums, and there is deliberately NO trailing
// spacer column — the opposite of the on-screen ledger, for a stated reason: **paper does
// not scroll**, so "never crush, always scroll" has no scroll half to offer here and the
// only question left is how the page width is shared. `width: 100%` + `table-fixed` makes
// these numbers a RATIO, so the nine spine columns and the grades fill the sheet instead
// of leaving ~40% of an A4 landscape page blank beside them.
//
// Measured at the 8mm margin: **1062px** of printable width against a declared 768px for
// five grades, i.e. every column is laid out ~1.38× its number here. The printed labels
// are shortened (see {@link PrintLedgerCol.label}) so that not one of them wraps at that
// scale — a wrapped header is a two-line header, and a two-line header costs 17px of the
// row budget above.

const P_DATE = 72;
const P_DAY = 34;
const P_FEDPHP = 62;
const P_FEDKG = 66;
const P_PRODKG = 66;
const P_WASTEKG = 56;
const P_WASTEPCT = 50;
const P_SHIFTS = 38;
const P_DTHRS = 44;
const P_GRADE = 56;

/** The printed ledger's columns — key data only, OUTPUT RATIOS never among them. */
interface PrintLedgerCol {
  key: string;
  /**
   * THE PRINTED LABEL — SHORTER THAN THE SCREEN'S, ON PURPOSE.
   *
   * `FED PRICE ₱/kg` and `DT HRS h` both wrapped in the PDF Renzo returned, which is
   * how the ledger header became two lines tall. Paper has one line for it, so the
   * label is written for one line: `FED ₱/kg`, `DT h`. The SCREEN keeps the long
   * forms — this is a rendering of the same column, not a renaming of it.
   */
  label: string;
  width: number;
  tone: OpsTone;
  right?: boolean;
  day(d: OpsLedgerDay): string;
  foot(r: OpsCampaignRollup): string;
}

function ledgerColumns(
  data: OpsLedgerData,
  gradesFor: (campaignKey: string, grade: string) => number | null,
  campaignKey: string,
): PrintLedgerCol[] {
  const cols: PrintLedgerCol[] = [
    {
      key: 'date',
      label: 'Date',
      width: P_DATE,
      tone: 'day',
      day: (d) => d.date,
      foot: (r) => r.productionBatch,
    },
    {
      key: 'day',
      label: 'Day',
      width: P_DAY,
      tone: 'day',
      day: (d) => d.weekday,
      foot: (r) => `${count(r.activeDays)} d`,
    },
  ];
  if (data.canViewPrices) {
    cols.push({
      key: 'fedphp',
      label: 'Fed ₱/kg',
      width: P_FEDPHP,
      tone: 'money',
      right: true,
      day: (d) => php(d.fedPhpKg),
      foot: (r) => php(r.fedPhpKg),
    });
  }
  cols.push(
    {
      key: 'fedkg',
      label: 'Fed kg',
      width: P_FEDKG,
      tone: 'fed',
      right: true,
      day: (d) => kg(d.fedKg),
      foot: (r) => kg(r.fedKg),
    },
    {
      key: 'prodkg',
      label: 'Prod kg',
      width: P_PRODKG,
      tone: 'produced',
      right: true,
      day: (d) => kg(d.producedKg),
      foot: (r) => kg(r.producedKg),
    },
    {
      key: 'wastekg',
      label: 'Waste kg',
      width: P_WASTEKG,
      tone: 'waste',
      right: true,
      day: (d) => kg(d.totalWasteKg),
      foot: (r) => kg(r.wasteKg),
    },
    {
      key: 'wastepct',
      label: 'Waste %',
      width: P_WASTEPCT,
      tone: 'waste',
      right: true,
      day: (d) => pctFromFraction(d.wastePct, 2),
      foot: (r) => pctFromFraction(r.wasteLossPct, 2),
    },
    {
      key: 'shifts',
      label: 'Shifts',
      width: P_SHIFTS,
      tone: 'shift',
      right: true,
      day: (d) => count(d.shiftCount),
      foot: (r) => count(r.shiftCount),
    },
    {
      key: 'dthrs',
      label: 'DT h',
      width: P_DTHRS,
      tone: 'shift',
      right: true,
      day: (d) => hours(d.downtimeHours),
      foot: (r) => hours(r.downtimeHours),
    },
  );
  // THE GRADE SET IS DATA — the union the campaigns in view actually produced, in the
  // payload's own display order. Never a hardcoded list, on paper or on screen.
  for (const g of data.grades) {
    cols.push({
      key: `grade:${g}`,
      label: `${g} kg`,
      width: P_GRADE,
      tone: 'produced',
      right: true,
      day: (d) => kg(d.producedByGrade[g] ?? null),
      foot: () => kg(gradesFor(campaignKey, g)),
    });
  }
  return cols;
}

// ─── The pages ───────────────────────────────────────────────────────────────────

/**
 * The header font is FIXED at 7.5pt whatever the body does.
 *
 * A header that shrank with the rows would cost legibility exactly where a reader
 * orients, and it buys nothing: the header is ONE line either way, so its height is
 * already the constant {@link CHROME_LEDGER_HEAD}.
 */
const HEAD_FONT: React.CSSProperties = { fontSize: '7.5pt', lineHeight: '12px' };

/** The KPI strip carries ELEVEN long names across the same sheet — half a point tighter. */
const KPI_HEAD_FONT: React.CSSProperties = { fontSize: '7pt', lineHeight: '12px' };

const HEAD_BASE =
  'border border-zinc-400 border-t-2 px-1 py-[1px] font-semibold uppercase whitespace-nowrap overflow-hidden';
const CELL_BASE = 'border border-zinc-300 px-1 py-[1px] whitespace-nowrap overflow-hidden';
const NUM = 'font-mono tabular-nums';

/**
 * A KPI cell. ONE LINE, ALWAYS (2026-09-17).
 *
 * It used to render each `extra` on its own line, which made WASTE LOSS two lines tall
 * and therefore made the whole strip two lines tall — ~17px of the day-row budget spent
 * on one cell. `kg 106,507 · % 17.15` says the same two figures side by side.
 *
 * With a single figure the cell keeps the Excel Standard's accounting shape (unit
 * pinned LEFT, digits pinned RIGHT). With two it becomes a right-aligned run, because
 * pinning two units to one left edge is not a shape.
 */
function PrintKpiFigure({
  cell,
  tone,
}: {
  cell: OpsKpiPrintRow['cells'][number];
  tone: OpsTone;
}) {
  const valueClass = cn(
    NUM,
    'font-semibold',
    cell.absent ? PRINT_MUTED_TEXT : PRINT_TONE[tone].value,
  );
  if (cell.extra.length === 0) {
    return (
      <span className="flex items-baseline justify-between gap-1">
        <span className="text-[6.5pt] uppercase text-zinc-600">{cell.value ? cell.glyph : ''}</span>
        <span className={valueClass}>{cell.value || '—'}</span>
      </span>
    );
  }
  return (
    <span className="flex items-baseline justify-end gap-1">
      <span className="text-[6.5pt] uppercase text-zinc-600">{cell.value ? cell.glyph : ''}</span>
      <span className={valueClass}>{cell.value || '—'}</span>
      {cell.extra.map((e, j) => (
        <React.Fragment key={j}>
          <span className="text-[6.5pt] text-zinc-400">·</span>
          <span className="text-[6.5pt] uppercase text-zinc-600">{e.value ? e.glyph : ''}</span>
          <span className={cn(NUM, cell.absent ? PRINT_MUTED_TEXT : PRINT_TONE[tone].value)}>
            {e.value || '—'}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * THE KPI STRIP'S WIDTHS — per column, because its LABELS are what size it.
 *
 * A flat 78px clipped `ACTUAL FED PRICE` to `ACTUAL FED PR` in the first real PDF of
 * this round. The ledger below solves the same problem by SHORTENING its labels, which
 * is not available here: these eleven names are the EOQ rollup's own column names and
 * abbreviating them on paper would make the printed strip and the screen strip
 * disagree about what a column is called. So the width moves instead.
 *
 * They are RATIOS (`width: 100%` + `table-fixed`), so only their proportions matter —
 * the declared sum is 1102 against 1062px of printable width, i.e. every column lays
 * out at ~0.96× the number below. Measured need at 7pt uppercase semibold:
 * `ACTUAL FED PRICE` 89px (gets 104), `WASTE LOSS`'s two-figure cell 119px (gets 127).
 */
const KPI_W_LABEL = 116;
const KPI_W_DEFAULT = 84;
const KPI_W: Record<string, number> = {
  fed: 72,
  produced: 84,
  yield: 64,
  loss: 64,
  waste: 132,
  fedprice: 86,
  actual: 108,
  resikocost: 96,
  resikoloss: 96,
  pccost: 84,
  truepc: 100,
};

const kpiWidth = (key: string) => KPI_W[key] ?? KPI_W_DEFAULT;

/**
 * THE KPI STRIP, PRINTED — the EOQ rollup on page 1 and, with one row, each
 * campaign's own EOM rollup at the top of its page. ONE component, so the two can
 * never disagree about what the rollup is.
 *
 * The column tones come from `opsKpiPrintTable()` — i.e. from the strip's own
 * `COLUMNS` — so a family hue is stated once for both surfaces.
 */
function PrintKpiTable({
  columns,
  rows,
}: {
  columns: OpsKpiPrintColumn[];
  rows: OpsKpiPrintRow[];
}) {
  return (
    <table className="w-full table-fixed border-collapse text-black" style={{ width: '100%' }}>
      <colgroup>
        <col style={{ width: KPI_W_LABEL }} />
        {columns.map((c) => (
          <col key={c.key} style={{ width: kpiWidth(c.key) }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th
            className={cn(HEAD_BASE, PRINT_TONE.day.head, PRINT_TONE.day.edge, 'text-left')}
            style={KPI_HEAD_FONT}
          >
            Campaign
          </th>
          {columns.map((c) => (
            <th
              key={c.key}
              className={cn(
                HEAD_BASE,
                PRINT_TONE[c.tone].head,
                PRINT_TONE[c.tone].edge,
                'text-right',
              )}
              style={KPI_HEAD_FONT}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td
              className={cn(CELL_BASE, 'font-semibold uppercase text-zinc-900')}
              style={{ fontSize: '8pt', lineHeight: '13px' }}
            >
              {r.label}
              {r.subtitle ? (
                <span className="ml-1 text-[6.5pt] font-normal normal-case text-zinc-600">
                  {r.subtitle}
                </span>
              ) : null}
            </td>
            {r.cells.map((cell, i) => {
              const col = columns[i];
              return (
                <td
                  key={col?.key ?? i}
                  className={cn(CELL_BASE, 'text-right', col ? PRINT_TONE[col.tone].cell : '')}
                  style={{ fontSize: '8pt', lineHeight: '13px' }}
                >
                  <PrintKpiFigure cell={cell} tone={col?.tone ?? 'day'} />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Title and span on ONE line — they were two, and two cost a day row. */
function PrintHeading({ title, span }: { title: string; span: string }) {
  return (
    <div className="flex items-baseline gap-2" style={{ lineHeight: '15px' }}>
      <h1 className="text-[10pt] font-semibold uppercase tracking-tight text-zinc-900">{title}</h1>
      <p className={cn(NUM, 'text-[7pt] text-zinc-600')}>{span}</p>
    </div>
  );
}

/** PAGE 1 — the EOQ rollup, and nothing else. */
export function OpsPrintRollupPage({
  title,
  span,
  data,
}: {
  title: string;
  span: string;
  data: OpsLedgerData;
}) {
  const table = opsKpiPrintTable(data.rollups, data.group, data.canViewPrices);
  return (
    <article data-ops-print className="flex flex-col gap-1 bg-white text-black">
      <PrintHeading title={`${title} · EOQ Rollup`} span={span} />
      <PrintKpiTable columns={table.columns} rows={table.rows} />
    </article>
  );
}

/** PAGES 2..N — one campaign: its EOM rollup strip, then its day ledger. */
export function OpsPrintCampaignPage({
  data,
  rollup,
  days,
}: {
  data: OpsLedgerData;
  rollup: OpsCampaignRollup;
  days: OpsLedgerDay[];
}) {
  const gradesFor = (campaignKey: string, grade: string) =>
    data.gradesByCampaign[campaignKey]?.find((x) => x.grade === grade)?.kg ?? null;
  const cols = ledgerColumns(data, gradesFor, rollup.campaignKey);
  // ONE ROW, the same eleven columns as page 1 — this IS the month's EOM rollup, and
  // it is printed here instead of a second little table saying the same thing twice.
  const kpi = opsKpiPrintTable([rollup], null, data.canViewPrices);
  // THE WHOLE POINT OF THE ROUND: the row height is derived from how many days this
  // campaign has, against the sheet's own budget.
  const m = ledgerMetrics(days.length);
  const bodyFont: React.CSSProperties = {
    fontSize: `${m.fontPt}pt`,
    lineHeight: `${m.lineH}px`,
  };

  return (
    <article data-ops-print className="flex flex-col gap-1 bg-white text-black">
      <PrintHeading
        title={rollup.label}
        span={`${rollup.firstDate} → ${rollup.lastDate} · ${count(rollup.ledgerDays)} days · ${count(
          rollup.restDays,
        )} rest`}
      />

      <PrintKpiTable columns={kpi.columns} rows={kpi.rows} />

      <table className="w-full table-fixed border-collapse text-black" style={{ width: '100%' }}>
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        {/* `<thead>` KEEPS `table-header-group` — a header that repeats on an overlong
            campaign is a help. The totals row deliberately does NOT repeat; see below. */}
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={cn(
                  HEAD_BASE,
                  PRINT_TONE[c.tone].head,
                  PRINT_TONE[c.tone].edge,
                  c.right ? 'text-right' : 'text-left',
                )}
                style={HEAD_FONT}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            // A REST DAY IS A ROW, and it is BLANK — dropping it would make a month
            // read as if it had 26 days. The date and the weekday still print, on a
            // neutral fill that says "nothing happened here" without a word.
            <tr key={`${rollup.campaignKey}:${d.date}`}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    CELL_BASE,
                    // The rest-day fill REPLACES the column tint rather than layering
                    // over it: both are opaque, and two opaque fills in one cell is a
                    // stacking question with no right answer on paper.
                    d.isRestDay ? PRINT_NEUTRAL_FILL : PRINT_TONE[c.tone].cell,
                    c.right ? cn(NUM, 'text-right') : 'text-left',
                    d.isRestDay
                      ? PRINT_MUTED_TEXT
                      : c.key === 'day' && d.isWeekend
                        ? PRINT_WEEKEND_TEXT
                        : 'text-zinc-900',
                  )}
                  style={bodyFont}
                >
                  {c.day(d)}
                </td>
              ))}
            </tr>
          ))}
          {/* THE TOTALS ROW IS A `<tbody>` ROW, NOT A `<tfoot>` — that is the fix, not
              a refactor. Chrome REPEATS a `<tfoot>` on every printed page, so in the
              PDF Renzo returned `JULY 28 D 45.34 781,234 …` appeared at the foot of
              page 2 and again at the foot of page 3 and read as a duplicated total. */}
          <tr>
            {cols.map((c) => (
              <td
                key={c.key}
                className={cn(
                  CELL_BASE,
                  PRINT_NEUTRAL_FILL,
                  'border-t-[1.5px] border-t-zinc-700 font-semibold text-zinc-900',
                  c.right ? cn(NUM, 'text-right') : 'text-left',
                )}
                style={bodyFont}
              >
                {c.foot(rollup)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </article>
  );
}

// ─── The control ─────────────────────────────────────────────────────────────────

export interface OpsPagePrintControlProps {
  data: OpsLedgerData;
  /**
   * The campaign options, read for ONE thing: the quarter LABEL of the group being
   * printed, so page 1 is headed `Q3 2026 · EOQ ROLLUP` rather than a list of three
   * campaign names. It comes from `quarterPresets()` — the same function the picker
   * and the page's default both read — so the sheet can never name a quarter the
   * picker does not build. With no matching preset the campaign list is the label.
   */
  options?: readonly OpsQuarterOption[];
  className?: string;
}

export function OpsPagePrintControl({ data, options, className }: OpsPagePrintControlProps) {
  const [printing, setPrinting] = React.useState(false);
  usePagePrintRules(printing);

  const keys = data.campaigns.map((c) => c.key);
  const preset = options
    ? quarterPresets(options).find(
        (p) => p.keys.length === keys.length && p.keys.every((k) => keys.includes(k)),
      )
    : undefined;
  const groupLabel = preset?.label ?? data.rollups.map((r) => r.label).join(' · ');
  const groupSpan =
    data.group && data.group.firstDate && data.group.lastDate
      ? `${data.group.firstDate} → ${data.group.lastDate} · ${count(data.group.ledgerDays)} days · ${count(data.group.restDays)} rest`
      : '';

  // A RESHAPE, not a computation — the payload's own days, grouped by campaign, in
  // the campaigns' own chronological order. A CHANGEOVER DATE BELONGS TO TWO
  // CAMPAIGNS (2026-08-01 is JULY's last day and AUGUST's first), so it appears once
  // on each campaign's page, exactly as it appears once in each band on screen.
  const daysByCampaign = new Map<string, OpsLedgerDay[]>();
  for (const d of data.days) {
    const list = daysByCampaign.get(d.campaignKey);
    if (list) list.push(d);
    else daysByCampaign.set(d.campaignKey, [d]);
  }

  // Page 1 only when there IS a group to roll up — see the header note.
  const withRollupPage = data.group !== null && data.rollups.length > 1;
  const pageCount = data.rollups.length + (withRollupPage ? 1 : 0);

  if (data.rollups.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setPrinting(true)}
        title={`Print this page — ${
          withRollupPage ? 'the EOQ rollup, then one sheet per campaign' : 'one sheet'
        }. Key columns only; the output-ratio columns are left off. Each campaign fits one A4 landscape sheet up to ${OPS_PRINT_MAX_ROWS_PER_PAGE} day rows.`}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <Printer className="size-3.5" />
        <span>Print</span>
      </button>

      {printing
        ? createPortal(
            <GroupPrintStage
              // NO STAGE HEADER — every page carries its own title and span, and a
              // second heading restating them is the wordiness this report avoids.
              showHeader={false}
              title={groupLabel}
              subtitle={groupSpan}
              countLabel={`${pageCount} page${pageCount === 1 ? '' : 's'}`}
              onDone={() => setPrinting(false)}
            >
              {withRollupPage ? (
                <GroupPrintPage key="__rollup__">
                  <OpsPrintRollupPage title={groupLabel} span={groupSpan} data={data} />
                </GroupPrintPage>
              ) : null}
              {data.rollups.map((r) => (
                <GroupPrintPage key={r.campaignKey}>
                  <OpsPrintCampaignPage
                    data={data}
                    rollup={r}
                    days={daysByCampaign.get(r.campaignKey) ?? []}
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
