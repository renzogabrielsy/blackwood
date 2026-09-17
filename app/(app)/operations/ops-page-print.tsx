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
import { opsKpiPrintTable, type OpsKpiPrintRow } from './ops-kpi-strip';
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
// KEY DATA ONLY: `DATE · DAY · FED ₱/KG · TTL FED · TTL PROD · WASTE kg · WASTE % ·
// SHIFTS · DT HRS`, then one column per GRADE. **OUTPUT RATIOS (YIELD % / LOSS %) are
// always off on paper** — they are the day-level indicative pair, and their caveat is
// a hover `title` that paper cannot carry, which is precisely why Renzo called them
// redundant here. The CAMPAIGN yield and loss are on the KPI strip at the top of the
// same page, where the ratio genuinely holds.
//
// **THE EIGHT WASTE STREAMS ARE DELIBERATELY NOT COLUMNS HERE — MEASURED.** At 8pt
// (the legibility floor this report was given) a waste-stream column needs ~56px and a
// grade column ~58px. A4 landscape at a 10mm margin is ~1047px of printable width; the
// nine spine columns are ~484px, so three grades leave ~389px and eight streams need
// ~448px — over, and a campaign running four grades is 117px over. Squeezing them in
// would trade the stated floor for a column nobody asked for; the day's WASTE kg and
// WASTE % carry the total, and the per-stream split is on screen under the Losses lens.
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
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * THE `@page` RULE, INJECTED FOR THE DURATION AND REMOVED AFTERWARDS.
 *
 * `app/globals.css` already sets `@page { size: A4 landscape; margin: 12mm }` — and
 * `@page` **cannot be scoped to a class**, so that rule governs every print in the
 * app, /analytics included. This report wants 10mm (two more millimetres of width is
 * roughly one more grade column) plus the row/head break rules a multi-page table
 * needs, and it must not take them from /analytics.
 *
 * So the block is injected at print time and removed when the stage unmounts — which
 * is on `afterprint`, since that is what unmounts the stage. It comes LATER in
 * document order than `globals.css` at equal specificity, so it wins while it exists
 * and leaves nothing behind when it does not. Everything except the `@page` rule is
 * scoped to `[data-ops-print]`, so only this report's own tables are affected.
 */
const PAGE_RULE = `
@page { size: A4 landscape; margin: 10mm; }
[data-ops-print] table { break-inside: auto; }
[data-ops-print] thead { display: table-header-group; }
[data-ops-print] tfoot { display: table-footer-group; }
[data-ops-print] tr { break-inside: avoid; break-after: auto; }
`;

const STYLE_ID = 'bw-ops-page-print-rules';

function usePagePrintRules(active: boolean) {
  React.useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = PAGE_RULE;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [active]);
}

// ─── Geometry ────────────────────────────────────────────────────────────────────
//
// The widths below are PROPORTIONS, not minimums, and there is deliberately NO trailing
// spacer column — the opposite of the on-screen ledger, for a stated reason: **paper does
// not scroll**, so "never crush, always scroll" has no scroll half to offer here and the
// only question left is how the page width is shared. `width: 100%` + `table-fixed` makes
// these numbers a RATIO, so the nine spine columns and the grades fill the sheet instead
// of leaving ~40% of an A4 landscape page blank beside them. Measured: the declared sum is
// 600px for two grades against ~1047px of printable width at a 10mm margin, and it stays
// under it up to eight grades — the plant has run four.

const P_DATE = 72;
const P_DAY = 34;
const P_FEDPHP = 62;
const P_FEDKG = 66;
const P_PRODKG = 66;
const P_WASTEKG = 56;
const P_WASTEPCT = 50;
const P_SHIFTS = 34;
const P_DTHRS = 44;
const P_GRADE = 58;

/** The printed ledger's columns — key data only, OUTPUT RATIOS never among them. */
interface PrintLedgerCol {
  key: string;
  label: string;
  unit?: string;
  width: number;
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
      day: (d) => d.date,
      foot: (r) => r.productionBatch,
    },
    {
      key: 'day',
      label: 'Day',
      width: P_DAY,
      day: (d) => d.weekday,
      foot: (r) => `${count(r.activeDays)} d`,
    },
  ];
  if (data.canViewPrices) {
    cols.push({
      key: 'fedphp',
      label: 'Fed price',
      unit: '₱/kg',
      width: P_FEDPHP,
      right: true,
      day: (d) => php(d.fedPhpKg),
      foot: (r) => php(r.fedPhpKg),
    });
  }
  cols.push(
    {
      key: 'fedkg',
      label: 'Ttl fed',
      unit: 'kg',
      width: P_FEDKG,
      right: true,
      day: (d) => kg(d.fedKg),
      foot: (r) => kg(r.fedKg),
    },
    {
      key: 'prodkg',
      label: 'Ttl prod',
      unit: 'kg',
      width: P_PRODKG,
      right: true,
      day: (d) => kg(d.producedKg),
      foot: (r) => kg(r.producedKg),
    },
    {
      key: 'wastekg',
      label: 'Waste',
      unit: 'kg',
      width: P_WASTEKG,
      right: true,
      day: (d) => kg(d.totalWasteKg),
      foot: (r) => kg(r.wasteKg),
    },
    {
      key: 'wastepct',
      label: 'Waste',
      unit: '%',
      width: P_WASTEPCT,
      right: true,
      day: (d) => pctFromFraction(d.wastePct, 2),
      foot: (r) => pctFromFraction(r.wasteLossPct, 2),
    },
    {
      key: 'shifts',
      label: 'Shifts',
      width: P_SHIFTS,
      right: true,
      day: (d) => count(d.shiftCount),
      foot: (r) => count(r.shiftCount),
    },
    {
      key: 'dthrs',
      label: 'DT hrs',
      unit: 'h',
      width: P_DTHRS,
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
      label: g,
      unit: 'kg',
      width: P_GRADE,
      right: true,
      day: (d) => kg(d.producedByGrade[g] ?? null),
      foot: () => kg(gradesFor(campaignKey, g)),
    });
  }
  return cols;
}

// ─── The pages ───────────────────────────────────────────────────────────────────

const HEAD = 'border border-black/50 bg-black/[0.06] px-1 py-0.5 text-[8pt] font-semibold uppercase';
const CELL = 'border border-black/25 px-1 py-[1px] text-[8pt]';
const NUM = 'font-mono tabular-nums';

/** A KPI cell: the unit pinned left, the figure pinned right (the Excel Standard). */
function PrintFigure({
  glyph,
  value,
  strong,
}: {
  glyph: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <span className="flex items-baseline justify-between gap-1">
      <span className="text-[7pt] uppercase">{value ? glyph : ''}</span>
      <span className={cn(NUM, strong && 'font-semibold')}>{value || '—'}</span>
    </span>
  );
}

/**
 * THE KPI STRIP, PRINTED — the EOQ rollup on page 1 and, with one row, each
 * campaign's own EOM rollup at the top of its page. ONE component, so the two can
 * never disagree about what the rollup is.
 */
function PrintKpiTable({
  columns,
  rows,
}: {
  columns: { key: string; label: string }[];
  rows: OpsKpiPrintRow[];
}) {
  return (
    <table className="w-full table-fixed border-collapse text-black" style={{ width: '100%' }}>
      <colgroup>
        <col style={{ width: 120 }} />
        {columns.map((c) => (
          <col key={c.key} style={{ width: 82 }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th className={cn(HEAD, 'text-left')}>Campaign</th>
          {columns.map((c) => (
            <th key={c.key} className={cn(HEAD, 'text-right')}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className={cn(CELL, 'font-semibold uppercase')}>
              {r.label}
              {r.subtitle ? (
                <span className="ml-1 text-[7pt] font-normal normal-case">{r.subtitle}</span>
              ) : null}
            </td>
            {r.cells.map((cell, i) => (
              <td key={columns[i]?.key ?? i} className={cn(CELL, 'text-right')}>
                <PrintFigure glyph={cell.glyph} value={cell.value} strong />
                {cell.extra.map((e, j) => (
                  <PrintFigure key={j} glyph={e.glyph} value={e.value} />
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** PAGE 1 — the EOQ rollup, and nothing else. */
function RollupPage({ title, span, data }: { title: string; span: string; data: OpsLedgerData }) {
  const table = opsKpiPrintTable(data.rollups, data.group, data.canViewPrices);
  return (
    <article data-ops-print className="flex flex-col gap-2 bg-white p-2 text-black">
      <header>
        <h1 className="text-[12pt] font-semibold tracking-tight">{title} · EOQ ROLLUP</h1>
        <p className={cn(NUM, 'text-[8pt]')}>{span}</p>
      </header>
      <PrintKpiTable columns={table.columns} rows={table.rows} />
    </article>
  );
}

/** PAGES 2..N — one campaign: its EOM rollup strip, then its day ledger. */
function CampaignPage({
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

  return (
    <article data-ops-print className="flex flex-col gap-2 bg-white p-2 text-black">
      <header>
        <h1 className="text-[12pt] font-semibold uppercase tracking-tight">{rollup.label}</h1>
        <p className={cn(NUM, 'text-[8pt]')}>
          {rollup.firstDate} → {rollup.lastDate} · {count(rollup.ledgerDays)} days ·{' '}
          {count(rollup.restDays)} rest
        </p>
      </header>

      <PrintKpiTable columns={kpi.columns} rows={kpi.rows} />

      <table className="w-full table-fixed border-collapse text-black" style={{ width: '100%' }}>
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={cn(HEAD, c.right ? 'text-right' : 'text-left')}>
                {c.label}
                {c.unit ? <span className="ml-1 font-normal normal-case">{c.unit}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            // A REST DAY IS A ROW, and it is BLANK — dropping it would make a month
            // read as if it had 26 days. The date and the weekday still print.
            <tr key={`${rollup.campaignKey}:${d.date}`}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cn(CELL, c.right ? cn(NUM, 'text-right') : 'text-left')}
                >
                  {c.day(d)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {cols.map((c) => (
              <td
                key={c.key}
                className={cn(
                  HEAD,
                  c.right ? cn(NUM, 'text-right') : 'text-left',
                  'font-semibold',
                )}
              >
                {c.foot(rollup)}
              </td>
            ))}
          </tr>
        </tfoot>
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
        }. Key columns only; the output-ratio columns are left off.`}
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
                  <RollupPage title={groupLabel} span={groupSpan} data={data} />
                </GroupPrintPage>
              ) : null}
              {data.rollups.map((r) => (
                <GroupPrintPage key={r.campaignKey}>
                  <CampaignPage
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
