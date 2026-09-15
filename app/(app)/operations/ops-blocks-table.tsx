'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { OpsCampaignBlock, OpsGroupBlock } from '@/lib/operations/types';
import { kg, pctFromFraction, php } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE BLOCKS USED TABLE — what the FED PRICE and ACTUAL FED PRICE modals ARE.
//
// Renzo, 2026-09-15 (round 3): *"It should take out the how it is defined entirely.
// It should show a table: Batch, Block Loc, Date Opened, Date Closed, State, Fed Wt
// and Block Price… those two KPI pop ups should portray the data in table form so the
// user can distinguish and get a quick look and a breakdown of why the price is the
// way it is and what the actual price is and why."*
//
// So the modal stopped explaining the number in prose and started SHOWING the rows it
// was made of. Two column sets over the same rows:
//
//   fed    BATCH · BLOCK LOC · DATE OPEN · DATE CLOSE · STATE · FED WT · BLOCK PRICE
//   actual …the same, plus ARRV WT · RESIKO · RESIKO LOSS · ACTUAL PRICE · RESIKO PRICE
//
// ── FIVE RULES THIS FILE IS BUILT AROUND ────────────────────────────────────────
//
//  1. **NOTHING IS COMPUTED HERE.** Every cell is a published field of
//     {@link OpsCampaignBlock} / {@link OpsGroupBlock}. The `+` in `MIN_WIDTH` is a
//     column-width sum, which is layout. The footer prints the ROLLUP's own totals,
//     handed in by the caller — never a fold of the rows above it.
//  2. **FED WT IS THE CAMPAIGN'S OWN FED KG, NEVER THE BLOCK'S ALL-TIME TOTAL.**
//     78 of 523 blocks were fed by more than one campaign, so an all-time figure in a
//     campaign's modal credits this campaign with kilos another one ate. That single
//     field is the ONLY difference between the two payload shapes, which is why
//     {@link campaignBlockRows} / {@link groupBlockRows} normalise it and nothing else.
//  3. **RESIKO IS NULL ON AN OPEN BLOCK, AND THE BALANCE IS SHOWN INSTEAD, MUTED.**
//     Charcoal still sitting in the pile is stock, not shrinkage. The two figures are
//     published under two names and can never be read as one number.
//  4. **A ROW OUTSIDE THE PRICE SET IS TINTED AND SAYS WHY** — `still open`, `an
//     unpriced delivery`, `a sun-drying outflow` — because "why is this blank" is the
//     question the table exists to answer.
//  5. **A ₱ COLUMN IS ABSENT, NOT BLANK, for a viewer without price rights.** The
//     adapter already nulled the four fields; dropping the columns from the layout is
//     what the strip and the spine do, so the three agree.
//
// FROZEN SURFACES ARE OPAQUE: the sticky header and the sticky footer sit ON TOP of
// scrolling rows, so both carry a SOLID `bg-muted` — never the dialog's glass
// (CLAUDE.md → "Frozen Panes").
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * One row of the table, normalised across the two payload shapes.
 *
 * The block-life half is identical in both and means exactly the same thing at either
 * grain — those are facts about the pile, not about the campaign reading it.
 */
export interface OpsBlocksRow {
  key: string;
  batchCode: string;
  blockLoc: string | null;
  firstFedDate: string | null;
  closeDate: string | null;
  isClosed: boolean;
  state: string;
  /** FED WT — kg fed WITHIN this campaign (or this group). See rule 2. */
  fedKg: number | null;
  /** ARRV WT — everything that ever arrived into the block. */
  deliveredKg: number | null;
  resikoKg: number | null;
  resikoPct: number | null;
  balanceKg: number | null;
  inPriceSet: boolean;
  hasUnpricedDelivery: boolean;
  hasSundryOutflow: boolean;
  /** ₱ — already null for a viewer without price rights. */
  deliveredPhpKg: number | null;
  actualFedPhpKg: number | null;
  upliftPhpKg: number | null;
}

function common(b: OpsCampaignBlock | OpsGroupBlock, fedKg: number | null): Omit<OpsBlocksRow, 'key'> {
  return {
    batchCode: b.batchCode,
    blockLoc: b.blockLoc,
    firstFedDate: b.firstFedDate,
    closeDate: b.closeDate,
    isClosed: b.isClosed,
    state: b.state,
    fedKg,
    deliveredKg: b.deliveredKg,
    resikoKg: b.resikoKg,
    resikoPct: b.resikoPct,
    balanceKg: b.balanceKg,
    inPriceSet: b.inPriceSet,
    hasUnpricedDelivery: b.hasUnpricedDelivery,
    hasSundryOutflow: b.hasSundryOutflow,
    deliveredPhpKg: b.deliveredPhpKg,
    actualFedPhpKg: b.actualFedPhpKg,
    upliftPhpKg: b.upliftPhpKg,
  };
}

/** The campaign's own blocks — `campaignFedKg` is FED WT. */
export function campaignBlockRows(blocks: readonly OpsCampaignBlock[]): OpsBlocksRow[] {
  return blocks.map((b) => ({ key: `${b.campaignKey}:${b.batchId}`, ...common(b, b.campaignFedKg) }));
}

/** The group's DISTINCT blocks — `groupFedKg` is FED WT. */
export function groupBlockRows(blocks: readonly OpsGroupBlock[]): OpsBlocksRow[] {
  return blocks.map((b) => ({ key: `group:${b.batchId}`, ...common(b, b.groupFedKg) }));
}

// ─── COLUMNS ─────────────────────────────────────────────────────────────────────

interface BlocksCol {
  key: string;
  label: string;
  /** The unit, rendered INLINE with the label — one header line, never two. */
  unit?: string;
  width: number;
  right?: boolean;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  /** `actual` only. */
  wide?: boolean;
  cell(r: OpsBlocksRow): React.ReactNode;
}

const STATE_TINT: Record<string, string> = {
  'IN-USE': 'bg-blue-100 text-blue-950 dark:bg-blue-950 dark:text-blue-50',
  CLOSED: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-50',
  STORED: 'bg-muted text-foreground',
  FEED: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-50',
  SUNDRYING: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
  SUNDRIED: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
};

const num = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

/**
 * WHY a block is outside the price set, in the block's own terms.
 *
 * String assembly over three published booleans — it states the reasons, it does not
 * decide them: `inPriceSet` is the view's own predicate and is never re-derived here.
 */
function whyExcluded(r: OpsBlocksRow): string | undefined {
  if (r.inPriceSet) return undefined;
  const reasons: string[] = [];
  if (!r.isClosed) reasons.push('still open');
  if (r.hasUnpricedDelivery) reasons.push('an unpriced delivery');
  if (r.hasSundryOutflow) reasons.push('a sun-drying outflow');
  return reasons.length > 0
    ? `Outside the price set — ${reasons.join(' · ')}. Its ACTUAL and RESIKO prices are blank rather than guessed at.`
    : 'Outside the price set, so its ACTUAL and RESIKO prices are blank rather than guessed at.';
}

const COLS: BlocksCol[] = [
  {
    key: 'batch',
    label: 'Batch',
    width: 124,
    cell: (r) => <span className="block truncate font-mono">{r.batchCode}</span>,
  },
  {
    key: 'loc',
    label: 'Block loc',
    width: 78,
    cell: (r) => <span className="block truncate font-mono">{r.blockLoc ?? '—'}</span>,
  },
  {
    key: 'open',
    label: 'Date open',
    width: 88,
    cell: (r) => num(r.firstFedDate ?? '', 'text-muted-foreground'),
  },
  {
    key: 'close',
    label: 'Date close',
    width: 88,
    cell: (r) => num(r.closeDate ?? '', 'text-muted-foreground'),
  },
  {
    key: 'state',
    label: 'State',
    width: 78,
    cell: (r) => (
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-medium',
          STATE_TINT[r.state] ?? 'bg-muted text-foreground',
        )}
      >
        {r.state || '—'}
      </span>
    ),
  },
  {
    key: 'fed',
    label: 'Fed wt',
    unit: 'kg',
    width: 88,
    right: true,
    cell: (r) => num(kg(r.fedKg), 'font-medium'),
  },
  // ── the ACTUAL-price half ──────────────────────────────────────────────────────
  {
    key: 'arrv',
    label: 'Arrv wt',
    unit: 'kg',
    width: 88,
    right: true,
    wide: true,
    cell: (r) => num(kg(r.deliveredKg), 'text-muted-foreground'),
  },
  {
    key: 'resiko',
    label: 'Resiko',
    unit: 'kg',
    width: 86,
    right: true,
    wide: true,
    // TWO FIGURES, NEVER ONE. Closed → resiko. Open → the balance, MUTED, because
    // charcoal still in the pile is stock and calling it shrinkage invents loss.
    cell: (r) =>
      r.isClosed ? (
        num(kg(r.resikoKg))
      ) : (
        <span className="font-mono tabular-nums text-muted-foreground/70" title="still in the pile">
          {kg(r.balanceKg)}
        </span>
      ),
  },
  {
    key: 'resikopct',
    label: 'Resiko loss',
    unit: '%',
    width: 84,
    right: true,
    wide: true,
    // `resikoPct` is the published CLOSED-ONLY twin of `lossPct`; gating it on
    // `isClosed` as well means this cell and the RESIKO kg cell beside it can never
    // disagree about whether the block has finished losing weight.
    cell: (r) => (r.isClosed ? num(pctFromFraction(r.resikoPct, 2), 'text-muted-foreground') : null),
  },
  // ── the ₱ half ─────────────────────────────────────────────────────────────────
  {
    key: 'blockprice',
    label: 'Block price',
    unit: '₱/kg',
    width: 84,
    right: true,
    price: true,
    cell: (r) => num(php(r.deliveredPhpKg)),
  },
  {
    key: 'actualprice',
    label: 'Actual price',
    unit: '₱/kg',
    width: 84,
    right: true,
    price: true,
    wide: true,
    cell: (r) => num(php(r.actualFedPhpKg), 'font-medium'),
  },
  {
    key: 'resikoprice',
    label: 'Resiko price',
    unit: '₱/kg',
    width: 84,
    right: true,
    price: true,
    wide: true,
    cell: (r) => num(php(r.upliftPhpKg), 'text-muted-foreground'),
  },
];

export interface OpsBlocksTableProps {
  /** `fed` = the seven-column FED PRICE set; `actual` = the twelve-column one. */
  variant: 'fed' | 'actual';
  rows: readonly OpsBlocksRow[];
  canViewPrices: boolean;
  /** `20 blocks · 17 closed · 3 open · 16 in the price set` — PUBLISHED counts only. */
  counts: string;
  /** The rollup's own totals: `[label, value]` pairs, printed under the rows. */
  totals: readonly { label: string; value: string }[];
  className?: string;
}

export function OpsBlocksTable({
  variant,
  rows,
  canViewPrices,
  counts,
  totals,
  className,
}: OpsBlocksTableProps) {
  const cols = React.useMemo(
    () => COLS.filter((c) => (variant === 'actual' || !c.wide) && (canViewPrices || !c.price)),
    [variant, canViewPrices],
  );
  // NEVER CRUSH, ALWAYS SCROLL — Σ of every declared width, inside `overflow-x-auto`.
  const minWidth = cols.reduce((s, c) => s + c.width, 0);

  if (rows.length === 0) {
    return (
      <p className={cn('px-1 py-3 text-xs text-muted-foreground', className)}>
        No block is listed for this row — nothing was fed, so there is nothing to break down.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <p className="font-mono text-[10px] tabular-nums text-muted-foreground">{counts}</p>

      <div className="max-h-[min(50vh,380px)] overflow-auto rounded-md border border-border">
        <table
          className="table-fixed text-xs"
          style={{
            width: '100%',
            minWidth,
            // MANDATORY with sticky cells — under `border-collapse` the browser paints
            // sticky backgrounds transparent and the rows bleed through.
            borderCollapse: 'separate',
            borderSpacing: 0,
          }}
        >
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  style={{ top: 0 }}
                  className={cn(
                    // OPAQUE — this header sits on top of scrolling rows.
                    'frozen-row border-b border-r border-border bg-muted px-2 py-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                    c.right ? 'text-right' : 'text-left',
                  )}
                >
                  {/* THE UNIT IS ON THE SAME LINE AS THE LABEL (Renzo, round 3) —
                      one header row, not two. */}
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
            {rows.map((r) => {
              const why = whyExcluded(r);
              return (
                <tr
                  key={r.key}
                  title={why}
                  className={cn(
                    'h-8 transition-all duration-150 hover:bg-accent/50',
                    why ? 'bg-muted/40 text-muted-foreground' : undefined,
                  )}
                >
                  {cols.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'border-b border-r border-border/60 px-2 py-1',
                        c.right ? 'text-right' : 'text-left',
                      )}
                    >
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td
                colSpan={cols.length}
                style={{ bottom: 0 }}
                className="frozen-row-bottom frozen-edge-top bg-muted px-2 py-1.5"
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[10px]">
                  {totals.map((t) => (
                    <span key={t.label} className="uppercase tracking-wide text-muted-foreground">
                      {t.label}{' '}
                      <span className="font-mono text-[11px] font-semibold normal-case tabular-nums text-foreground">
                        {t.value || '—'}
                      </span>
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
