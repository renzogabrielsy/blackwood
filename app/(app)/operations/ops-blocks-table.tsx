'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type {
  OpsCampaignBlock,
  OpsCampaignRollup,
  OpsGroupBlock,
  OpsGroupRollup,
} from '@/lib/operations/types';
import { TONE, type OpsTone } from './ops-color';
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
// ── SIX RULES THIS FILE IS BUILT AROUND ─────────────────────────────────────────
//
//  1. **NOTHING IS COMPUTED HERE.** Every cell is a published field of
//     {@link OpsCampaignBlock} / {@link OpsGroupBlock}, and every FOOTER cell is a
//     published field of the ROLLUP. The `+` in `blocksTableWidth` is a column-width
//     sum, which is layout.
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
//  6. **THE FOOTER SITS UNDER ITS OWN COLUMNS** (2026-09-16). Renzo: *"Footers I
//     don't really like. It should align with the columns."* It was a wrapped line of
//     `LABEL value` pairs — a reader had to match a name to a column by eye. It is
//     now a real `<tfoot>` row: FED WT totals under FED WT, ARRV WT under ARRV WT,
//     each ₱ under its own rate. Every figure is a rollup field, so the footer still
//     never folds the rows above it; what changed is where it is printed.
//
// FROZEN SURFACES ARE OPAQUE: the sticky header and the sticky footer sit ON TOP of
// scrolling rows, so both carry a SOLID background — a tinted header takes the
// palette's opaque `head` step, and the footer's family tint is a TRANSLUCENT layer
// INSIDE an opaque `bg-muted` cell, never alpha on the cell itself (CLAUDE.md →
// "Frozen Panes").
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

// ─── THE FOOTER ──────────────────────────────────────────────────────────────────

/**
 * THE `<tfoot>` ROW — one published rollup field per column it totals.
 *
 * ⚠ THE GROUP HAS NO WEIGHT TOTALS, AND THE ABSENCE IS THE POINT. A block can be fed
 * by more than one campaign (78 of 523; 5 of Q3 2026's 47), so adding a shared pile's
 * whole-life ARRIVAL weight or RESIKO once per campaign that touched it inflates the
 * total exactly the way a group resiko kg would — which is the refusal
 * `fn_ops_ledger_group_kpis` already makes, and why it was given nothing new in
 * 2026-09-16's migration. The ₱ rates ARE published for a group (every one of them is
 * weighted in SQL), so those cells are filled and the weight cells say why they are not.
 */
export interface OpsBlocksFooter {
  /** `TOTAL` or `GROUP` — printed in the BATCH column, where the eye starts. */
  label: string;
  fedKg: number | null;
  deliveredKg: number | null;
  resikoKg: number | null;
  resikoPct: number | null;
  fedPhpKg: number | null;
  actualFedPhpKg: number | null;
  /** The campaign-attributed twin — a caption under ACTUAL PRICE, never a second cell. */
  campaignWeightedActualFedPhpKg: number | null;
  upliftPhpKg: number | null;
  /** Why the three weight totals are blank. Only a GROUP footer carries it. */
  weightNote?: string;
}

/** A campaign's footer — the five blocks-table totals `view_ops_ledger_campaign_kpis` publishes. */
export function campaignBlocksFooter(r: OpsCampaignRollup): OpsBlocksFooter {
  return {
    label: 'Total',
    fedKg: r.fedKg,
    deliveredKg: r.blocksDeliveredKg,
    resikoKg: r.blocksResikoKg,
    resikoPct: r.blocksClosedResikoLossPct,
    fedPhpKg: r.fedPhpKg,
    actualFedPhpKg: r.actualFedPhpKg,
    campaignWeightedActualFedPhpKg: r.campaignWeightedActualFedPhpKg,
    upliftPhpKg: r.upliftPhpKg,
  };
}

/** A group's footer — rates only; see the class note on why the weights are blank. */
export function groupBlocksFooter(g: OpsGroupRollup): OpsBlocksFooter {
  return {
    label: 'Group',
    fedKg: g.fedKg,
    deliveredKg: null,
    resikoKg: null,
    resikoPct: g.blockResikoLossPct,
    fedPhpKg: g.fedPhpKg,
    actualFedPhpKg: g.actualFedPhpKg,
    campaignWeightedActualFedPhpKg: null,
    upliftPhpKg: g.upliftPhpKg,
    weightNote:
      'No group ARRIVAL or RESIKO weight is published: a block can be fed by more than one campaign, so adding a shared pile’s whole-life weight once per campaign would double-count it. The RATIO is weighted in SQL instead.',
  };
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
  /**
   * THE FAMILY TINT (2026-09-16). Renzo: *"add the same kind of pop in the colour as
   * the rest of the table — don't overly colour it, old people are reading this as a
   * report, legibility is king."* So the tint lands on the HEADER (opaque `head`) and
   * on the FOOTER (translucent `cell`, inside an opaque cell) — never on a data row,
   * and the numbers stay on the neutral token.
   */
  tint?: OpsTone;
  cell(r: OpsBlocksRow, print?: boolean): React.ReactNode;
  /** The `<tfoot>` cell. Absent = blank, because that column has no total. */
  foot?(f: OpsBlocksFooter): React.ReactNode;
}

const STATE_TINT: Record<string, string> = {
  'IN-USE': 'bg-blue-100 text-blue-950 dark:bg-blue-950 dark:text-blue-50',
  CLOSED: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-50',
  STORED: 'bg-muted text-foreground',
  FEED: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-50',
  SUNDRYING: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
  SUNDRIED: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
};

/** The three columns a GROUP footer leaves blank, and must explain. */
const WEIGHT_COLS = new Set(['arrv', 'resiko']);

const num = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

/** A footer figure — always `font-mono` on the NEUTRAL token, never a hue. */
const total = (text: string) =>
  text ? (
    <span className="font-mono text-[11px] font-semibold tabular-nums">{text}</span>
  ) : (
    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">—</span>
  );

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

// ── WIDTHS ARE SIZED TO THE LONGEST HEADER, UNIT INCLUDED (2026-09-16) ──────────
// Renzo saw `BLOCK PRICE ₱…` and `RESIKO LO…` on a 1080p monitor. TWO separate
// faults produced that, and both are fixed here: the DIALOG was clamped narrower
// than the table (see `ops-modal-size.ts`), and these columns were sized for their
// label ALONE while round 3 had moved the unit onto the same line. A header is
// `text-[10px] font-semibold uppercase tracking-wide` plus a 4px gap and the unit,
// inside `px-2` — so the budget is `measured label + gap + unit + 16`, and the
// numbers below are the measured ones, not estimates.
const COLS: BlocksCol[] = [
  {
    key: 'batch',
    label: 'Batch',
    // The content, not the header, sets this one: `SEPTEMBER-26-BLK12` is 18 mono
    // characters at 12px. A batch code is the row's identity and must never elide.
    width: 152,
    cell: (r) => <span className="block truncate font-mono">{r.batchCode}</span>,
    foot: (f) => (
      <span className="block truncate text-[10px] font-semibold uppercase tracking-wide">
        {f.label}
      </span>
    ),
  },
  {
    key: 'loc',
    label: 'Block loc',
    width: 86,
    cell: (r) => <span className="block truncate font-mono">{r.blockLoc ?? '—'}</span>,
  },
  {
    key: 'open',
    label: 'Date open',
    width: 92,
    cell: (r) => num(r.firstFedDate ?? '', 'text-muted-foreground'),
  },
  {
    key: 'close',
    label: 'Date close',
    width: 94,
    cell: (r) => num(r.closeDate ?? '', 'text-muted-foreground'),
  },
  {
    key: 'state',
    label: 'State',
    width: 94,
    // ON PAPER THE CHIP IS PLAIN TEXT — a report is read in black on white, and a
    // coloured pill is the one tint the print variant could not drop by class alone.
    cell: (r, print) =>
      print ? (
        <span className="text-[10px] font-medium uppercase">{r.state || '—'}</span>
      ) : (
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
    width: 98,
    right: true,
    tint: 'fed',
    cell: (r) => num(kg(r.fedKg), 'font-medium'),
    foot: (f) => total(kg(f.fedKg)),
  },
  // ── the ACTUAL-price half ──────────────────────────────────────────────────────
  {
    key: 'arrv',
    label: 'Arrv wt',
    unit: 'kg',
    width: 100,
    right: true,
    wide: true,
    tint: 'fed',
    cell: (r) => num(kg(r.deliveredKg), 'text-muted-foreground'),
    foot: (f) => total(kg(f.deliveredKg)),
  },
  {
    key: 'resiko',
    label: 'Resiko',
    unit: 'kg',
    width: 98,
    right: true,
    wide: true,
    tint: 'drift',
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
    foot: (f) => total(kg(f.resikoKg)),
  },
  {
    key: 'resikopct',
    label: 'Resiko loss',
    unit: '%',
    width: 106,
    right: true,
    wide: true,
    tint: 'drift',
    // `resikoPct` is the published CLOSED-ONLY twin of `lossPct`; gating it on
    // `isClosed` as well means this cell and the RESIKO kg cell beside it can never
    // disagree about whether the block has finished losing weight.
    cell: (r) => (r.isClosed ? num(pctFromFraction(r.resikoPct, 2), 'text-muted-foreground') : null),
    foot: (f) => total(f.resikoPct === null ? '' : pctFromFraction(f.resikoPct, 2)),
  },
  // ── the ₱ half ─────────────────────────────────────────────────────────────────
  {
    key: 'blockprice',
    label: 'Block price',
    unit: '₱/kg',
    width: 122,
    right: true,
    price: true,
    tint: 'money',
    cell: (r) => num(php(r.deliveredPhpKg)),
    foot: (f) => total(php(f.fedPhpKg)),
  },
  {
    key: 'actualprice',
    label: 'Actual price',
    unit: '₱/kg',
    width: 128,
    right: true,
    price: true,
    wide: true,
    tint: 'money',
    cell: (r) => num(php(r.actualFedPhpKg), 'font-medium'),
    // THE CAMPAIGN-ATTRIBUTED TWIN RIDES AS A CAPTION, not as a second column: it is
    // the same statistic attributed to this campaign's own fed kilos, and the two are
    // read together or not at all.
    foot: (f) => (
      <>
        {total(php(f.actualFedPhpKg))}
        {f.campaignWeightedActualFedPhpKg === null ? null : (
          <span className="block truncate font-mono text-[9px] tabular-nums text-muted-foreground">
            attributed {php(f.campaignWeightedActualFedPhpKg)}
          </span>
        )}
      </>
    ),
  },
  {
    key: 'resikoprice',
    label: 'Resiko price',
    unit: '₱/kg',
    width: 128,
    right: true,
    price: true,
    wide: true,
    tint: 'money',
    cell: (r) => num(php(r.upliftPhpKg), 'text-muted-foreground'),
    foot: (f) => total(php(f.upliftPhpKg)),
  },
];

/** The columns a variant actually renders for this viewer. */
function visibleCols(variant: 'fed' | 'actual', canViewPrices: boolean): BlocksCol[] {
  return COLS.filter((c) => (variant === 'actual' || !c.wide) && (canViewPrices || !c.price));
}

/**
 * THE TABLE'S NATURAL WIDTH — Σ of the declared widths of the columns this viewer
 * gets. Column-width bookkeeping, i.e. layout, which is the one arithmetic this
 * screen allows.
 *
 * It is exported so the DIALOG can be sized from it (`ops-modal-size.ts`) rather
 * than from a literal that has to be remembered when a column changes. That is the
 * whole fix for `BLOCK PRICE ₱…`: the width the dialog asks for and the width the
 * table needs are now the same expression.
 */
export function blocksTableWidth(variant: 'fed' | 'actual', canViewPrices: boolean): number {
  return visibleCols(variant, canViewPrices).reduce((s, c) => s + c.width, 0);
}

export interface OpsBlocksTableProps {
  /** `fed` = the seven-column FED PRICE set; `actual` = the twelve-column one. */
  variant: 'fed' | 'actual';
  rows: readonly OpsBlocksRow[];
  canViewPrices: boolean;
  /** `20 blocks · 17 closed · 3 open · 16 in the price set` — PUBLISHED counts only. */
  counts: string;
  /** The `<tfoot>` row — one rollup field per column it totals. */
  footer: OpsBlocksFooter;
  /**
   * PAPER. Drops every tint, every sticky surface and every scroller, and draws in
   * black on white so the sheet reads the same whichever theme the screen is in.
   * The print stylesheet already flattens the scrollers; what it cannot do is decide
   * that a REPORT should not be colour-coded.
   */
  print?: boolean;
  className?: string;
}

export function OpsBlocksTable({
  variant,
  rows,
  canViewPrices,
  counts,
  footer,
  print,
  className,
}: OpsBlocksTableProps) {
  const cols = React.useMemo(() => visibleCols(variant, canViewPrices), [variant, canViewPrices]);
  // NEVER CRUSH, ALWAYS SCROLL — Σ of every declared width, inside `overflow-auto`.
  const minWidth = blocksTableWidth(variant, canViewPrices);

  if (rows.length === 0) {
    return (
      <p
        className={cn(
          'px-1 py-3 text-xs',
          print ? 'text-black' : 'text-muted-foreground',
          className,
        )}
      >
        No block is listed for this row — nothing was fed, so there is nothing to break down.
      </p>
    );
  }

  const headBase = print
    ? 'border-b border-r border-black/40 bg-white px-2 py-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-black'
    : 'frozen-row border-b border-r border-border bg-muted px-2 py-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';

  return (
    <div className={cn('flex min-h-0 flex-auto flex-col gap-1.5', className)}>
      <p
        className={cn(
          'shrink-0 font-mono text-[10px] tabular-nums',
          print ? 'text-black' : 'text-muted-foreground',
        )}
      >
        {counts}
      </p>

      {/* THE ONLY SCROLLER IN THE DIALOG. It used to be capped at
          `min(50vh,380px)`, which meant a 20-block campaign scrolled inside a
          modal that was itself scrolling inside a viewport with room to spare.
          Now it takes whatever height the dialog's 92vh clamp leaves it — see
          `OPS_MODAL_BODY` for why `flex-auto` and not `flex-1`. */}
      <div
        className={cn(
          print ? 'border border-black/40' : 'min-h-0 flex-auto overflow-auto rounded-md border border-border',
        )}
      >
        <table
          className={cn('table-fixed text-xs', print && 'text-black')}
          style={{
            width: '100%',
            minWidth: print ? undefined : minWidth,
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
                  style={print ? undefined : { top: 0 }}
                  className={cn(
                    // OPAQUE — this header sits on top of scrolling rows. A tinted
                    // one takes the palette's opaque `head` step, never an alpha.
                    headBase,
                    !print && c.tint && TONE[c.tint].head,
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
                  title={print ? undefined : why}
                  className={cn(
                    'h-8',
                    print
                      ? undefined
                      : cn(
                          'transition-all duration-150 hover:bg-accent/50',
                          why ? 'bg-muted/40 text-muted-foreground' : undefined,
                        ),
                  )}
                >
                  {cols.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-2 py-1',
                        print ? 'border-b border-r border-black/20' : 'border-b border-r border-border/60',
                        c.right ? 'text-right' : 'text-left',
                      )}
                    >
                      {c.cell(r, print)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {/* ── THE FOOTER, UNDER ITS OWN COLUMNS (rule 6) ───────────────────── */}
          <tfoot>
            <tr>
              {cols.map((c) => (
                <td
                  key={c.key}
                  title={WEIGHT_COLS.has(c.key) ? footer.weightNote : undefined}
                  style={print ? undefined : { bottom: 0 }}
                  className={cn(
                    'p-0',
                    print
                      ? 'border-t border-r border-black/40 bg-white'
                      : // The OPAQUE base. The tint goes on the inner layer, and
                        // `.frozen-edge-top` composes the seam across the whole row.
                        'frozen-row-bottom frozen-edge-top border-r border-border bg-muted',
                    c.right ? 'text-right' : 'text-left',
                  )}
                >
                  <div
                    className={cn(
                      'px-2 py-1.5',
                      // LOW ALPHA, over the opaque cell above — "don't overly
                      // colour it, legibility is king".
                      !print && c.tint && TONE[c.tint].cell,
                    )}
                  >
                    {c.foot ? c.foot(footer) : <span className="block h-[17px]" />}
                  </div>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* The one sentence the GROUP footer owes, because three of its cells are
          deliberately blank. On screen it is also the `title` of those two cells. */}
      {footer.weightNote ? (
        <p
          className={cn(
            'shrink-0 text-[10px] leading-snug',
            print ? 'text-black' : 'text-muted-foreground',
          )}
        >
          {footer.weightNote}
        </p>
      ) : null}
    </div>
  );
}
