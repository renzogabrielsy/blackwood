'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { OpsCampaignRollup, OpsGroupRollup } from '@/lib/operations/types';
import { count, hours, php, pctFromFraction, pctFromPercent, tons } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE EOQ STRIP — Renzo's `EOQ3 2026` tab, as a table.
//
// ONE ROW PER CAMPAIGN, plus the GROUP row when more than one is picked, and the
// nine figures he reads across: RC FED · PRODUCED · YIELD · LOSS · BLOCK RESIKO
// LOSS · FED PRICE · ACTUAL FED PRICE · PC COST · TRUE PC COST.
//
// A TABLE, not the drafts' tile row. Tiles answer "how did this period do"; his EOQ
// tab answers "how did these three months COMPARE", and three tile strips stacked
// is a comparison you have to do in your head. The tiles were right for a draft with
// one group; they are wrong the moment the group has members.
//
// ── THREE THINGS THIS COMPONENT MUST NOT DO, AND DOES NOT ───────────────────────
//
//  1. **It computes nothing.** Every cell is a field of the rollup the group RPC or
//     the campaign KPI view produced. The GROUP row is `data.group` — never a fold
//     of the campaign rows — because ₱/kg and every ratio in it is WEIGHTED in SQL
//     and the mean of three yields belongs to no quarter.
//  2. **It never prints a ₱ it was not given.** `canViewPrices` drops the four ₱
//     columns from the coordinate space (the RC Movement precedent); the server has
//     already nulled the fields, so this is the render guard, not the gate.
//  3. **It never fills in TRUE PC COST.** That figure is strict NULL unless every
//     block a campaign fed is CLOSED and fully priced — and for a group unless EVERY
//     campaign is. Where it is null the cell says WHY, in the coverage caption, and
//     for the group it prints the covered partial beside it, labelled.
//
// ── TWO FIGURES THE GROUP DELIBERATELY DOES NOT HAVE ────────────────────────────
// A block can be fed by more than one campaign (measured: 78 of 523; 5 of Q3 2026's
// 45), so summing per-campaign resiko kg would charge one block's whole-life
// shrinkage once per campaign. The group therefore publishes the fed-kg-weighted
// RATIO and no kg, and the campaign-attributed actual price and no whole-block one.
// Both blanks carry their reason in the caption rather than reading as missing data.
// ═════════════════════════════════════════════════════════════════════════════════

/** One cell: the figure, and the small line under it that says what it is measured against. */
interface Cell {
  value: string;
  note?: string;
  /** Muted + italic — used where the value is legitimately absent, never for data. */
  absent?: boolean;
}

interface KpiColumn {
  key: string;
  label: string;
  unit?: string;
  width: number;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  campaign(r: OpsCampaignRollup): Cell;
  group(g: OpsGroupRollup): Cell;
}

const DASH: Cell = { value: '—', absent: true };

const COLUMNS: KpiColumn[] = [
  {
    key: 'fed',
    label: 'RC FED',
    unit: 't',
    width: 104,
    campaign: (r) => ({ value: tons(r.fedKg), note: `${count(r.feedDays)} feed days` }),
    group: (g) => ({ value: tons(g.fedKg), note: `${count(g.activeDays)} active days` }),
  },
  {
    key: 'produced',
    label: 'PRODUCED',
    unit: 't',
    width: 104,
    campaign: (r) =>
      r.productionReported
        ? { value: tons(r.producedKg), note: `${count(r.reportedDays)} reported days` }
        : { ...DASH, note: 'no production reported' },
    group: (g) => ({
      value: tons(g.producedKg),
      note: `${count(g.reportedCampaignDays)} campaign-days`,
    }),
  },
  {
    key: 'yield',
    label: 'YIELD',
    width: 88,
    campaign: (r) => ({ value: pctFromFraction(r.yieldPct, 2), note: 'produced ÷ fed' }),
    group: (g) => ({
      value: pctFromFraction(g.yieldPct, 2),
      note: `over ${tons(g.fedKgProductionReported)} t fed`,
    }),
  },
  {
    key: 'loss',
    label: 'LOSS',
    unit: 't',
    width: 112,
    campaign: (r) => ({
      value: tons(r.processLossKg),
      note: `${pctFromFraction(r.processLossPct, 2)} in process`,
    }),
    group: (g) => ({
      value: tons(g.processLossKg),
      note: `${pctFromFraction(g.processLossPct, 2)} in process`,
    }),
  },
  {
    key: 'resiko',
    label: 'BLOCK RESIKO LOSS',
    unit: 't',
    width: 132,
    campaign: (r) => ({
      value: tons(r.blockResikoKg),
      note: `${pctFromFraction(r.blockResikoLossPct, 2)} of the yard`,
    }),
    // NO GROUP KG EXISTS — see the class note. The ratio is weighted in SQL.
    group: (g) => ({
      value: pctFromFraction(g.blockResikoLossPct, 2),
      note: 'ratio only (shared blocks)',
    }),
  },
  {
    key: 'fedprice',
    label: 'FED PRICE',
    unit: '₱/kg',
    width: 116,
    price: true,
    campaign: (r) => ({
      value: php(r.fedPhpKg),
      note: `${pctFromPercent(r.fedPriceCoveragePct, 1)} priced`,
    }),
    group: (g) => ({
      value: php(g.fedPhpKg),
      note: `${pctFromPercent(g.fedPriceCoveragePct, 1)} priced`,
    }),
  },
  {
    key: 'actual',
    label: 'ACTUAL FED PRICE',
    unit: '₱/kg',
    width: 136,
    price: true,
    // The CAMPAIGN-ATTRIBUTED form leads, because it is the one weighted by this
    // campaign's own fed kilos and is therefore shape-comparable with FED PRICE
    // above. The whole-block figure rides in the caption rather than being dropped.
    campaign: (r) => ({
      value: php(r.campaignWeightedActualFedPhpKg),
      note:
        r.actualFedPhpKg === null
          ? `${count(r.blocksClosed)} of ${count(r.blocksFed)} blocks closed`
          : `whole-block ${php(r.actualFedPhpKg)}`,
    }),
    group: (g) => ({ value: php(g.actualFedPhpKg), note: 'campaign-attributed' }),
  },
  {
    key: 'pccost',
    label: 'PC COST',
    unit: '₱/kg',
    width: 116,
    price: true,
    campaign: (r) => ({ value: php(r.phpPerProducedKgDelivered), note: 'delivered basis' }),
    group: (g) => ({ value: php(g.phpPerProducedKgDelivered), note: 'delivered basis' }),
  },
  {
    key: 'truepc',
    label: 'TRUE PC COST',
    unit: '₱/kg',
    width: 148,
    price: true,
    campaign: (r) =>
      r.phpPerProducedKgTrue === null
        ? {
            ...DASH,
            note: `${count(r.blocksClosed)} of ${count(r.blocksFed)} closed · ${count(r.blocksInPrice)} priced`,
          }
        : { value: php(r.phpPerProducedKgTrue), note: 'carries the shrinkage' },
    group: (g) =>
      g.phpPerProducedKgTrue === null
        ? {
            ...DASH,
            note:
              g.phpPerProducedKgTrueCovered === null
                ? `${g.campaignsFullyCovered} of ${g.campaignCount} campaigns fully covered`
                : `covered ${php(g.phpPerProducedKgTrueCovered)} · ${g.campaignsFullyCovered} of ${g.campaignCount} campaigns fully covered`,
          }
        : { value: php(g.phpPerProducedKgTrue), note: 'carries the shrinkage' },
  },
];

const W_LABEL = 188;

export interface OpsKpiStripProps {
  rollups: readonly OpsCampaignRollup[];
  group: OpsGroupRollup | null;
  canViewPrices: boolean;
  className?: string;
}

export function OpsKpiStrip({ rollups, group, canViewPrices, className }: OpsKpiStripProps) {
  const cols = React.useMemo(
    () => COLUMNS.filter((c) => canViewPrices || !c.price),
    [canViewPrices],
  );
  const showGroup = group !== null && rollups.length > 1;
  const minWidth = W_LABEL + cols.reduce((sum, c) => sum + c.width, 0);

  if (rollups.length === 0) return null;

  return (
    <section className={cn('flex flex-col gap-1', className)} aria-label="Campaign rollup">
      {/* NEVER CRUSH, ALWAYS SCROLL — an explicit min-width equal to the sum of the
          column widths, inside an `overflow-x-auto` wrapper. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="table-fixed text-xs" style={{ width: '100%', minWidth }}>
          <colgroup>
            <col width={W_LABEL} />
            {cols.map((c) => (
              <col key={c.key} width={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-muted">
              <th className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Campaign
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className="px-2 py-1 text-right align-bottom text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  <span className="block truncate">{c.label}</span>
                  {c.unit ? (
                    <span className="block truncate text-[9px] font-normal normal-case text-muted-foreground/70">
                      {c.unit}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rollups.map((r) => (
              <Row
                key={r.campaignKey}
                title={r.label}
                subtitle={`${r.firstDate} → ${r.lastDate} · ${count(r.ledgerDays)} days · ${count(r.restDays)} rest`}
                cells={cols.map((c) => c.campaign(r))}
                cols={cols}
              />
            ))}
            {showGroup ? (
              <Row
                lead
                title="GROUP"
                subtitle={`${group.campaignCount} campaigns · ${group.firstDate} → ${group.lastDate} · ${group.blocksFedDistinct} distinct blocks (naive ${count(group.blocksFedCampaignSum)})`}
                cells={cols.map((c) => c.group(group))}
                cols={cols}
              />
            ) : null}
          </tbody>
        </table>
      </div>

      {/* The rest of the EOQ tab — figures that are CHECKED rather than watched, so
          one dense line rather than four more columns. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {showGroup ? (
          <>
            <span>SHIFTS {count(group.shiftCount)}</span>
            <span>RUNS {count(group.runCount)}</span>
            <span>DOWNTIME {hours(group.downtimeHours)} h</span>
            <span>SACKS {count(group.sacks)}</span>
            <span>REST DAYS {count(group.restDays)}</span>
            <span>
              BLOCKS {group.blocksClosedDistinct} closed / {group.blocksOpenDistinct} open
            </span>
            <span>SUNDRY {tons(group.sundryKg)} t</span>
          </>
        ) : (
          rollups.map((r) => (
            <React.Fragment key={r.campaignKey}>
              <span>SHIFTS {count(r.shiftCount)}</span>
              <span>RUNS {count(r.runCount)}</span>
              <span>DOWNTIME {hours(r.downtimeHours)} h</span>
              <span>SACKS {count(r.sacks)}</span>
              <span>REST DAYS {count(r.restDays)}</span>
              <span>
                BLOCKS {count(r.blocksClosed)} closed / {count(r.blocksOpen)} open
              </span>
              <span>SUNDRY {tons(r.sundryKg)} t</span>
            </React.Fragment>
          ))
        )}
      </div>
    </section>
  );
}

function Row({
  title,
  subtitle,
  cells,
  cols,
  lead,
}: {
  title: string;
  subtitle: string;
  cells: Cell[];
  cols: KpiColumn[];
  lead?: boolean;
}) {
  return (
    <tr
      className={cn(
        'border-b border-border/60 transition-all duration-150 last:border-b-0 hover:bg-muted/40',
        lead && 'bg-muted/40',
      )}
    >
      <td className="px-2 py-1.5 align-top">
        <span className={cn('block truncate text-xs', lead ? 'font-semibold' : 'font-medium')}>
          {title}
        </span>
        <span className="block truncate font-mono text-[10px] tabular-nums text-muted-foreground">
          {subtitle}
        </span>
      </td>
      {cells.map((cell, i) => (
        <td key={cols[i].key} className="px-2 py-1.5 text-right align-top">
          <span
            className={cn(
              'block truncate font-mono text-sm tabular-nums',
              cell.absent ? 'text-muted-foreground' : 'font-medium',
              lead && !cell.absent && 'font-semibold',
            )}
          >
            {cell.value || '—'}
          </span>
          {cell.note ? (
            <span className="block truncate text-[10px] text-muted-foreground" title={cell.note}>
              {cell.note}
            </span>
          ) : null}
        </td>
      ))}
    </tr>
  );
}
