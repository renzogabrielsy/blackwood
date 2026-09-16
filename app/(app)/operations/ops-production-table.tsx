'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaignRollup,
  type OpsGroupRollup,
  type OpsWaste,
} from '@/lib/operations/types';
import { kg, pctFromFraction, tons } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE PRODUCTION BREAKDOWN — PRODUCED · YIELD · LOSS · WASTE LOSS, as ONE reading.
//
// Renzo, 2026-09-16: *"Hovering over one of them highlights all 4 of those KPIs.
// Since those 4 are interrelated, what pops up should be a table where we can see
// all 4 of that data."*
//
// They ARE one reading, and the database says so: `yieldPct` is produced ÷ fed,
// `processLossPct` is 1 − yield, `wasteLossPct` is waste ÷ PRODUCED. Four cells that
// share two inputs and re-divide them three ways. Reading them one modal at a time
// meant four round trips to answer one question.
//
// ── WHAT IS NOT DONE HERE ───────────────────────────────────────────────────────
// They are **NOT merged into one column** in the strip. Four numbers a reader scans
// down a quarter stay four columns; what changed is that hovering any of them lights
// all four and clicking any of them opens THIS — the whole group at once.
//
// ── TWO TABLES, ONE ROW SET ─────────────────────────────────────────────────────
//  (a) the headline: RC FED · PRODUCED · YIELD · LOSS · PROCESS LOSS · WASTE · WASTE %
//  (b) the eight RECORDED streams that make up the WASTE column of (a), plus the
//      shift coverage behind them.
//
// Both render the SAME rows — one per campaign in the strip, plus the GROUP row when
// the modal was opened from it — so (b) is (a)'s waste column opened up, never a
// second population.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────────
// **NOTHING IS COMPUTED.** Every cell is a published field of `OpsCampaignRollup` /
// `OpsGroupRollup`; the GROUP row is `data.group`, never a fold of the campaign rows
// (every ratio in it is WEIGHTED in SQL, and the mean of three yields belongs to no
// quarter). The only `+` in this file sums COLUMN WIDTHS, which is layout.
//
// NULL IS NEVER 0 — a campaign whose shifts filed no waste row reads blank on all
// eight streams and on WASTE %, which is not the same claim as "it produced none".
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * One row — a campaign, or the group.
 *
 * Deliberately flat and payload-shaped: the two rollup types carry these fields
 * under the same names, so the row builders below are a RENAME of nothing and a
 * copy of everything.
 */
export interface OpsProductionRow {
  key: string;
  label: string;
  /** The GROUP row — heavier type, tinted band, always last. */
  lead?: boolean;
  fedKg: number | null;
  producedKg: number | null;
  /** FALSE → every production figure is NULL rather than 0, and the row says so. */
  productionReported: boolean;
  yieldPct: number | null;
  processLossKg: number | null;
  processLossPct: number | null;
  waste: OpsWaste;
  wasteKg: number | null;
  wasteLossPct: number | null;
  /** Shifts that filed a waste row, of the shifts there were — the coverage. */
  wasteShiftCount: number;
  shiftCount: number | null;
}

export function productionRowFromCampaign(r: OpsCampaignRollup): OpsProductionRow {
  return {
    key: r.campaignKey,
    label: r.label,
    fedKg: r.fedKg,
    producedKg: r.producedKg,
    productionReported: r.productionReported,
    yieldPct: r.yieldPct,
    processLossKg: r.processLossKg,
    processLossPct: r.processLossPct,
    waste: r.waste,
    wasteKg: r.wasteKg,
    wasteLossPct: r.wasteLossPct,
    wasteShiftCount: r.wasteShiftCount,
    shiftCount: r.shiftCount,
  };
}

export function productionRowFromGroup(g: OpsGroupRollup): OpsProductionRow {
  return {
    key: 'group',
    label: 'GROUP',
    lead: true,
    fedKg: g.fedKg,
    producedKg: g.producedKg,
    // A group HAS a production figure whenever any member reported; the per-campaign
    // rows above it are where a silent campaign is visible, and they say so there.
    productionReported: g.campaignsProductionReported > 0,
    yieldPct: g.yieldPct,
    processLossKg: g.processLossKg,
    processLossPct: g.processLossPct,
    waste: g.waste,
    wasteKg: g.wasteKg,
    wasteLossPct: g.wasteLossPct,
    wasteShiftCount: g.wasteShiftCount,
    shiftCount: g.shiftCount,
  };
}

// ─── COLUMNS ─────────────────────────────────────────────────────────────────────

interface ProdCol {
  key: string;
  label: string;
  /** The unit, INLINE with the label — one header line, the round-3 rule. */
  unit?: string;
  width: number;
  right?: boolean;
  /** The hue this figure carries in the strip, so the two surfaces agree. */
  accent?: string;
  cell(r: OpsProductionRow): React.ReactNode;
}

const W_LABEL = 156;

const num = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

/** A FRACTION → a bare percent, or a muted em-dash. NULL is never 0. */
const pct = (f: number | null, extra?: string) =>
  f === null ? (
    <span className="font-mono tabular-nums text-muted-foreground">—</span>
  ) : (
    <span className={cn('font-mono tabular-nums', extra)}>{pctFromFraction(f, 2)}</span>
  );

const HEADLINE_COLS: ProdCol[] = [
  {
    key: 'fed',
    label: 'RC fed',
    unit: 't',
    width: 96,
    right: true,
    accent: 'text-sky-700 dark:text-sky-300',
    cell: (r) => num(tons(r.fedKg)),
  },
  {
    key: 'produced',
    label: 'Produced',
    unit: 't',
    width: 100,
    right: true,
    accent: 'text-emerald-700 dark:text-emerald-300',
    cell: (r) => num(r.productionReported ? tons(r.producedKg) : ''),
  },
  {
    key: 'yield',
    label: 'Yield',
    unit: '%',
    width: 88,
    right: true,
    accent: 'text-emerald-700 dark:text-emerald-300',
    cell: (r) => pct(r.yieldPct, 'font-medium text-emerald-700 dark:text-emerald-300'),
  },
  {
    key: 'loss',
    label: 'Loss',
    unit: '%',
    width: 88,
    right: true,
    accent: 'text-amber-700 dark:text-amber-300',
    cell: (r) => pct(r.processLossPct, 'font-medium text-amber-700 dark:text-amber-300'),
  },
  {
    key: 'losskg',
    label: 'Process loss',
    unit: 'kg',
    width: 126,
    right: true,
    accent: 'text-amber-700 dark:text-amber-300',
    cell: (r) => num(kg(r.processLossKg), 'text-muted-foreground'),
  },
  {
    key: 'wastekg',
    label: 'Waste',
    unit: 'kg',
    width: 106,
    right: true,
    accent: 'text-rose-700 dark:text-rose-300',
    cell: (r) => num(kg(r.wasteKg)),
  },
  {
    key: 'wastepct',
    label: 'Waste',
    unit: '%',
    width: 96,
    right: true,
    accent: 'text-rose-700 dark:text-rose-300',
    cell: (r) => pct(r.wasteLossPct, 'font-medium text-rose-700 dark:text-rose-300'),
  },
];

const STREAM_COLS: ProdCol[] = [
  ...WASTE_STREAMS.map<ProdCol>((w) => ({
    key: w.key,
    label: w.label,
    unit: 'kg',
    width: 92,
    right: true,
    // The eight stay on the NEUTRAL token on purpose: colour says what KIND of
    // number this is, never how big it is, and a waste table must not be a wall
    // of red (`ops-color.ts`, rule carried over from the losses lens).
    cell: (r) => num(kg(r.waste[w.key])),
  })),
  {
    key: 'total',
    label: 'Total',
    unit: 'kg',
    width: 100,
    right: true,
    accent: 'text-rose-700 dark:text-rose-300',
    cell: (r) => num(kg(r.wasteKg), 'font-medium text-rose-700 dark:text-rose-300'),
  },
  {
    key: 'coverage',
    label: 'Waste shifts',
    width: 110,
    right: true,
    // TWO PUBLISHED COUNTS PRINTED SIDE BY SIDE — the coverage behind the total,
    // not a ratio computed from them.
    cell: (r) => num(`${r.wasteShiftCount} of ${r.shiftCount ?? 0}`, 'text-muted-foreground'),
  },
];

const width = (cols: ProdCol[]) => W_LABEL + cols.reduce((s, c) => s + c.width, 0);

/**
 * THE NATURAL WIDTH of the wider of the two tables — what the dialog is sized from
 * (`ops-modal-size.ts`). Column-width bookkeeping, i.e. layout.
 */
export function productionTablesWidth(): number {
  return Math.max(width(HEADLINE_COLS), width(STREAM_COLS));
}

// ─── THE TABLE ───────────────────────────────────────────────────────────────────

function ProdTable({
  caption,
  cols,
  rows,
}: {
  caption: string;
  cols: ProdCol[];
  rows: readonly OpsProductionRow[];
}) {
  const minWidth = width(cols);
  return (
    <section className="flex min-h-0 shrink-0 flex-col gap-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {caption}
      </h3>
      {/* NEVER CRUSH, ALWAYS SCROLL — an explicit min-width equal to Σ of the
          declared widths, inside an `overflow-x-auto` wrapper. On a phone this is
          the only thing that scrolls sideways; the dialog itself never does. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table
          className="table-fixed text-xs"
          style={{
            width: '100%',
            minWidth,
            // MANDATORY with sticky cells — under `border-collapse` the browser
            // paints sticky backgrounds transparent and the rows bleed through.
            borderCollapse: 'separate',
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_LABEL }} />
            {cols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                style={{ top: 0 }}
                className="frozen-row border-b border-r border-border bg-muted px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Campaign
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  style={{ top: 0 }}
                  className={cn(
                    // OPAQUE — a sticky header sits on top of scrolling rows.
                    'frozen-row border-b border-r border-border bg-muted px-2 py-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                    c.right ? 'text-right' : 'text-left',
                  )}
                >
                  <span className="block truncate">
                    {c.label}
                    {c.unit ? (
                      <span className="ml-1 font-normal normal-case opacity-70">{c.unit}</span>
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={cn(
                  'h-8 transition-all duration-150 hover:bg-accent/50',
                  r.lead && 'bg-muted/40',
                )}
              >
                <td className="border-b border-r border-border/60 px-2 py-1">
                  <span
                    className={cn(
                      'block truncate text-[11px]',
                      r.lead ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {r.label}
                  </span>
                </td>
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'border-b border-r border-border/60 px-2 py-1',
                      c.right ? 'text-right' : 'text-left',
                      r.lead && 'font-semibold',
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export interface OpsProductionTablesProps {
  rows: readonly OpsProductionRow[];
  className?: string;
}

export function OpsProductionTables({ rows, className }: OpsProductionTablesProps) {
  if (rows.length === 0) {
    return (
      <p className={cn('px-1 py-3 text-xs text-muted-foreground', className)}>
        No campaign is in view, so there is nothing to break down.
      </p>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-auto flex-col gap-3 overflow-auto', className)}>
      <ProdTable caption="The four figures, side by side" cols={HEADLINE_COLS} rows={rows} />
      <ProdTable
        caption="What the WASTE column is made of — the eight recorded streams"
        cols={STREAM_COLS}
        rows={rows}
      />
      {/* The caveat that belongs to table (b) and nowhere else. */}
      <p className="shrink-0 text-[11px] leading-snug text-muted-foreground">
        THESE EIGHT DO NOT SUM TO THE PROCESS LOSS. Most of what the retort loses leaves as
        moisture and volatiles that nobody weighs; this is what was swept up off the screens
        and trommels and put on a scale — a recovery figure, never a second process-loss
        number.
      </p>
    </div>
  );
}
