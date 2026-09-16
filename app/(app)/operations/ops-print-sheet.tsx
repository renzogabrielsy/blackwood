'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GroupPrintPage, GroupPrintStage } from '@/components/shared/print/group-print';
import { cn } from '@/lib/utils';
import { OpsBlocksTable, type OpsBlocksFooter, type OpsBlocksRow } from './ops-blocks-table';
import type { KpiResultTile } from './ops-kpi-modal';

// ═════════════════════════════════════════════════════════════════════════════════
// PRINT A PRICE SUMMARY — one sheet per campaign.
//
// Renzo, 2026-09-16: *"When clicking on one campaign, have the option to print a
// summary of the selected campaign. If clicking on the group row, give the option to
// print all 3 SEPARATELY. We should also be able to print from the group summary
// modal which campaign we want instead of batch printing all. **Make sure the printed
// summary is NOT WORDY.**"*
//
// ── IT REUSES THE PLATFORM MECHANISM, IT DOES NOT REPLACE IT ────────────────────
// `printCard` + `GroupPrintStage` / `GroupPrintPage` moved out of `/analytics` into
// `components/shared/print/` in this change precisely so this screen could use them
// unchanged: the stage is a real, laid-out column parked in a zero-sized clipped
// box, `printCard` tags it and flattens the path up to `<body>`, and each
// `GroupPrintPage` carries the page break (the LAST one deliberately does not, so a
// one-campaign print is one sheet and not one sheet plus a blank).
//
// ── NOT WORDY IS A CONSTRAINT ON THE SHEET, NOT A STYLE ─────────────────────────
// The printed page carries the title, the span, the counts line, the rows, the
// aligned footer and the result. **No definition prose, no caveat paragraph, no
// coverage narration** — everything the modal says in words stays on the screen. A
// report a reader has to wade through is a report they stop reading.
//
// ── AND IT IS BLACK ON WHITE ────────────────────────────────────────────────────
// `OpsBlocksTable print` drops every family tint, every sticky surface and every
// scroller and draws in black on white, so the sheet reads the same whichever theme
// the screen was in when the button was pressed. The ₱ columns are gated exactly as
// they are on screen — the spec carries `canViewPrices` and the table drops the
// columns from its layout, so a price-denied reader prints a sheet with no ₱ in it.
// ═════════════════════════════════════════════════════════════════════════════════

/** One printed page — everything it needs, already published and already formatted. */
export interface OpsPrintSheetSpec {
  /** The campaign key, or `group`. React key and menu id. */
  key: string;
  /** `JULY 2026` — what the menu entry says. */
  name: string;
  /** `JULY 2026 · ACTUAL FED PRICE` — the sheet's own heading. */
  title: string;
  /** `2026-06-30 → 2026-08-01`. */
  span: string;
  variant: 'fed' | 'actual';
  rows: readonly OpsBlocksRow[];
  counts: string;
  footer: OpsBlocksFooter;
  results: readonly KpiResultTile[];
  canViewPrices: boolean;
}

/** ONE PAGE. Plain block layout — the print rules flatten everything around it. */
export function OpsPrintSheet({ spec }: { spec: OpsPrintSheetSpec }) {
  return (
    <article className="flex flex-col gap-2 bg-white p-4 text-black">
      <header>
        <h1 className="text-base font-semibold tracking-tight">{spec.title}</h1>
        <p className="font-mono text-[11px] tabular-nums">{spec.span}</p>
      </header>

      <OpsBlocksTable
        print
        variant={spec.variant}
        rows={spec.rows}
        canViewPrices={spec.canViewPrices}
        counts={spec.counts}
        footer={spec.footer}
      />

      {spec.results.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {spec.results.map((t) => (
            <div key={t.label} className="min-w-[140px] border border-black/40 px-2 py-1.5">
              <span className="block text-[10px] font-semibold uppercase tracking-wide">
                {t.label}
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[11px]">{t.value ? t.glyph : ''}</span>
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {t.value || '—'}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export interface OpsPrintControlProps {
  /** One per campaign, in the strip's own order. A single entry prints a button. */
  sheets: readonly OpsPrintSheetSpec[];
  /** `FED PRICE` / `ACTUAL FED PRICE` — the report's own name, printed on the stage. */
  reportLabel: string;
  className?: string;
}

/**
 * THE CONTROL — a button when there is one campaign, a small menu when there are
 * several.
 *
 * The menu is Renzo's own ask: *"we should also be able to print from the group
 * summary modal WHICH campaign we want instead of batch printing all"*. So the
 * group's entries are `Print all N separately` and then one entry per campaign,
 * and the two paths differ ONLY in how many specs reach the stage.
 */
export function OpsPrintControl({ sheets, reportLabel, className }: OpsPrintControlProps) {
  // The specs currently being printed. Non-null MOUNTS the offstage stage, which
  // calls `printCard` on itself once it has laid out and unmounts on `afterprint`.
  const [printing, setPrinting] = React.useState<readonly OpsPrintSheetSpec[] | null>(null);

  if (sheets.length === 0) return null;

  const trigger = (
    <>
      <Printer className="size-3.5" />
      <span>Print</span>
    </>
  );
  const triggerClass = cn(
    'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[11px] font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    className,
  );

  return (
    <>
      {sheets.length === 1 ? (
        <button
          type="button"
          title={`Print the ${sheets[0].name} summary`}
          onClick={() => setPrinting(sheets)}
          className={triggerClass}
        >
          {trigger}
        </button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger className={triggerClass}>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-popover/95 backdrop-blur-lg">
            <DropdownMenuItem onSelect={() => setPrinting(sheets)}>
              Print all {sheets.length} separately
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {sheets.map((s) => (
              <DropdownMenuItem key={s.key} onSelect={() => setPrinting([s])}>
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* ── THE STAGE IS PORTALLED TO <body>, AND THAT IS NOT A DETAIL ─────────
          `printCard` flattens every ancestor from the card up to `<body>` with
          `position: static; transform: none`. A modal is a `DialogContent`, and
          Tailwind v4 centres it with the INDIVIDUAL `translate` property
          (`translate: -50% -50%`) — which `transform: none` does not reset, and
          which could not be reset from the print stylesheet either: Lightning CSS
          FOLDS `translate/rotate/scale` back into a `transform` shorthand, so the
          rule that would have fixed it compiled into `transform: translate3d(0,0,0)
          …` and did nothing. Measured: the sheet landed at `left: -960` on a
          1920px viewport. Portalling the stage out of the dialog removes the
          translated ancestor instead of arguing with it, which is also the
          simpler statement — the sheet is not part of the dialog's layout. */}
      {printing
        ? createPortal(
        <GroupPrintStage
          // NO STAGE HEADER — every page already carries its own title and span,
          // and "not wordy" is the constraint this report was asked for.
          showHeader={false}
          title={reportLabel}
          subtitle={printing.map((s) => s.name).join(' · ')}
          countLabel={`${printing.length} campaign${printing.length === 1 ? '' : 's'}`}
          onDone={() => setPrinting(null)}
        >
          {printing.map((s) => (
            <GroupPrintPage key={s.key}>
              <OpsPrintSheet spec={s} />
            </GroupPrintPage>
          ))}
        </GroupPrintStage>,
            document.body,
          )
        : null}
    </>
  );
}
