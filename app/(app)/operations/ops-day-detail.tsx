'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { WASTE_STREAMS, type OpsDayBlockUsed, type OpsLedgerDay, type OpsShift } from '@/lib/operations/types';
import { count, hours, kg, pctFromFraction } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE DAY BREAKDOWN — what a day row opens into.
//
// Two halves, and they open in DIFFERENT PANES of the split: the per-SHIFT cards
// under the day spine on the left (they explain the numbers directly above them),
// and BLOCKS USED under the lens on the right (it is the same shape as the lens —
// one row per block). On a phone, where only one pane is on screen, the spine's
// band carries both.
//
// ── FOUR THINGS THE PAYLOAD SAYS THAT THE DRAFT GUESSED WRONG ───────────────────
//
//  1. `shift` is a CODE (`M` / `E`), not `1 | 2`, and THERE IS NO STORED TIME
//     WINDOW and no supervisor column. The draft printed both; they would have to
//     be invented.
//  2. THERE IS NO PER-SHIFT FED KG, so there is no per-shift yield. `rc_out` has no
//     shift dimension — feeding is recorded per DATE — so a shift-level fed figure
//     could only ever be fabricated. The cards show what a shift actually owns:
//     hours, downtime, runs, waste.
//  3. WASTE IS PER SHIFT here, not only per day (the draft said day-level). The
//     shift view carries all eight streams, so each card prints its own and the day
//     total sits beneath them.
//  4. **RESIKO IS NULL ON AN OPEN BLOCK, NOT 0** — charcoal still in the pile is not
//     loss yet. The two figures are published under two names and are rendered in
//     two separately-labelled columns, so one can never be read as the other.
//
// ── THE DOWNTIME BLOCK IS L-051 / L-051b, VISIBLE ──────────────────────────────
// `dtRanges` is MC's own list of stop-and-start times and is what the minutes are
// derived FROM; `dtIncidentRanges` is the subset the plant ran THROUGH, which
// contributes ZERO minutes and is shown anyway so it can never become invisible;
// `shiftHrsSource` says which rule set the shift length. All three are printed
// because the whole point of storing them was that the arithmetic could be checked
// without reopening the workbook.
// ═════════════════════════════════════════════════════════════════════════════════

export interface OpsShiftCardsProps {
  day: OpsLedgerDay;
  className?: string;
}

export function OpsShiftCards({ day, className }: OpsShiftCardsProps) {
  if (day.isRestDay) {
    return (
      <div className={cn('px-1 py-3 text-xs text-muted-foreground', className)}>
        {day.date} · {day.weekday} — rest day. Nothing was fed, nothing was produced and
        nobody was on shift, which is why the row is blank rather than missing.
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {day.shifts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No production shift was filed for {day.date}
          {day.fedKg === null ? '.' : ' — but the plant was fed that day.'}
        </p>
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
        >
          {day.shifts.map((s) => (
            <ShiftCard key={s.shiftId} shift={s} />
          ))}
        </div>
      )}

      {/* The day's own waste totals, beneath the per-shift cards that make them up. */}
      <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Recorded waste — day total {day.totalWasteKg === null ? '' : `· ${kg(day.totalWasteKg)} kg`}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
          {WASTE_STREAMS.map((w) => (
            <span key={w.key} className="text-muted-foreground">
              {w.label} <span className="text-foreground">{kg(day.waste[w.key]) || '—'}</span>
            </span>
          ))}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          These eight do NOT sum to the process loss — most of what the retort loses leaves as
          moisture and volatiles, which nobody weighs. The WASTE % on the spine is this total
          over the day’s PRODUCED kilos, because what gets swept up came OUT of the retort and
          was then rejected. And a day’s fed and produced do not describe the same charcoal: the
          feed tank is continuous flow, so the day’s YIELD % and LOSS % are INDICATIVE ONLY —
          the real figures are the campaign’s, in the strip above.
        </p>
      </div>
    </div>
  );
}

function ShiftCard({ shift: s }: { shift: OpsShift }) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold">SHIFT {s.shift || '—'}</span>
        <span
          className="font-mono text-[10px] tabular-nums text-muted-foreground"
          title={
            s.shiftHrsSource
              ? `Shift length rule: ${s.shiftHrsSource}`
              : 'No shift-length rule recorded for this row.'
          }
        >
          {hours(s.shiftHrs)} h{s.shiftHrsSource ? ` · ${s.shiftHrsSource}` : ''}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Stat label="Produced" value={s.producedKg === null ? '—' : `${kg(s.producedKg)} kg`} />
        <Stat label="Downtime" value={s.downtimeHours === null ? '—' : `${hours(s.downtimeHours)} h`} />
        <Stat label="Productive" value={s.productiveHrs === null ? '—' : `${hours(s.productiveHrs)} h`} />
        <Stat label="Sacks" value={s.sacks === null ? '—' : count(s.sacks) || '0'} />
      </dl>

      {s.runs.length > 0 ? (
        <div className="mt-2 border-t border-border pt-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Runs ({s.runCount})
          </div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {s.runs.map((r, i) => (
              <li
                key={`${s.shiftId}:${i}`}
                className="flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums"
                title={r.remarks ?? undefined}
              >
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {r.grade ?? '—'}
                  {r.customer ? (
                    <span className="text-muted-foreground"> · {r.customer}</span>
                  ) : null}
                </span>
                <span className="shrink-0">{kg(r.ttl_kg) || '—'} kg</span>
                <span className="w-12 shrink-0 text-right text-muted-foreground">
                  {r.sacks_bags === null ? '—' : `${r.sacks_bags} bg`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {s.downtimeRowPresent ? (
        <div className="mt-2 border-t border-border pt-1.5">
          {s.dtReason ? (
            <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
              {s.dtReason}
            </p>
          ) : null}
          {s.dtRanges ? (
            <p
              className="mt-0.5 font-mono text-[10px] leading-snug text-muted-foreground"
              title="MC’s own list of stop-and-start times — the minutes are derived from this list, not from a typed total (L-051)."
            >
              ranges {s.dtRanges}
            </p>
          ) : null}
          {s.hasIncident && s.dtIncidentRanges ? (
            <p
              className="mt-0.5 font-mono text-[10px] leading-snug text-muted-foreground"
              title="Trouble the plant ran THROUGH — these ranges contribute ZERO downtime minutes and are shown so they never become invisible (L-051b)."
            >
              ran through {s.dtIncidentRanges}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-1.5 font-mono text-[10px] tabular-nums">
        {WASTE_STREAMS.map((w) => (
          <span key={w.key} className="text-muted-foreground">
            {w.label} <span className="text-foreground">{kg(s.waste[w.key]) || '—'}</span>
          </span>
        ))}
      </div>
      {s.wasteRemarks ? (
        <p className="mt-1 truncate text-[10px] text-muted-foreground" title={s.wasteRemarks}>
          {s.wasteRemarks}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

// ─── BLOCKS USED ─────────────────────────────────────────────────────────────────

const STATE_TINT: Record<string, string> = {
  // OPAQUE tokens only — these cells can sit beneath a pinned surface, and any
  // alpha lets the scrolling rows bleed through (CLAUDE.md → "Frozen Panes").
  'IN-USE': 'bg-blue-100 text-blue-950 dark:bg-blue-950 dark:text-blue-50',
  CLOSED: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-50',
  STORED: 'bg-muted text-foreground',
  FEED: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-50',
  SUNDRYING: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
  SUNDRIED: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
};

const BU_WIDTHS = [152, 84, 96, 96, 84, 96, 96, 104, 96, 96];
const BU_MIN = BU_WIDTHS.reduce((a, b) => a + b, 0);

export interface OpsBlocksUsedTableProps {
  day: OpsLedgerDay;
  /** Opens that block's detail drawer — the same gesture as an RC Movement header. */
  onOpenBlock?: (block: OpsDayBlockUsed) => void;
  className?: string;
}

export function OpsBlocksUsedTable({ day, onOpenBlock, className }: OpsBlocksUsedTableProps) {
  if (day.blocksUsed.length === 0) {
    return (
      <div className={cn('px-1 py-3 text-xs text-muted-foreground', className)}>
        {day.isRestDay
          ? 'Rest day — no block was drawn from.'
          : 'No block was drawn from on this day.'}
      </div>
    );
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="table-fixed text-xs" style={{ width: '100%', minWidth: BU_MIN }}>
        <colgroup>
          {BU_WIDTHS.map((w, i) => (
            <col key={i} width={w} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-border bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Th>Batch</Th>
            <Th>Block loc</Th>
            <Th>Date open</Th>
            <Th>Date close</Th>
            <Th>State</Th>
            <Th right sub="kg">Day fed</Th>
            <Th right sub="all-time kg">Fed wt</Th>
            <Th right sub="kg">Arrival wt</Th>
            {/* TWO COLUMNS, never one. The same subtraction means two different
                things depending on whether the block is closed, so it is published
                twice under two names and rendered twice under two headings. */}
            <Th right sub="closed only">Resiko</Th>
            <Th right sub="open only">Balance</Th>
          </tr>
        </thead>
        <tbody>
          {day.blocksUsed.map((b) => (
            <tr
              key={`${day.date}:${b.batchId}`}
              className="h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/40"
            >
              <td className="truncate px-2 py-1 font-mono">
                {onOpenBlock ? (
                  <button
                    type="button"
                    onClick={() => onOpenBlock(b)}
                    title={`Open ${b.batchCode}`}
                    className="max-w-full truncate text-left underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {b.batchCode}
                  </button>
                ) : (
                  b.batchCode
                )}
              </td>
              <td className="truncate px-2 py-1 font-mono">{b.blockLoc ?? '—'}</td>
              <td className="px-2 py-1 font-mono tabular-nums text-muted-foreground">
                {b.firstFedDate ?? '—'}
              </td>
              <td className="px-2 py-1 font-mono tabular-nums text-muted-foreground">
                {b.closeDate ?? '—'}
              </td>
              <td className="px-2 py-1">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    STATE_TINT[b.state] ?? 'bg-muted text-foreground',
                  )}
                >
                  {b.state || '—'}
                </span>
              </td>
              <td className="px-2 py-1 text-right font-mono font-medium tabular-nums">
                {kg(b.dayFedKg)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                {kg(b.totalFedKg)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                {kg(b.deliveredKg)}
                {b.hasUnpricedDelivery ? (
                  <span
                    className="ml-0.5 text-amber-700 dark:text-amber-400"
                    title={`${b.unpricedDeliveryCount ?? 0} delivery(ies) into this block are still unpriced.`}
                  >
                    *
                  </span>
                ) : null}
              </td>
              <td
                className="px-2 py-1 text-right font-mono tabular-nums"
                title={
                  b.isClosed
                    ? `Resiko — ${pctFromFraction(b.resikoPct, 2)} of what arrived.`
                    : 'Blank while the block is open: charcoal still in the pile is not loss yet.'
                }
              >
                {kg(b.resikoKg)}
              </td>
              <td
                className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground"
                title={
                  b.isClosed
                    ? 'Blank once the block is closed — what is left is resiko, not balance.'
                    : 'Charcoal still in the pile.'
                }
              >
                {kg(b.balanceKg)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="h-8 border-t border-border bg-muted/60">
            <td
              className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground"
              colSpan={10}
            >
              {day.blocksUsed.length} block{day.blocksUsed.length === 1 ? '' : 's'} drawn from ·
              the day fed {kg(day.fedKg) || '—'} kg
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Th({
  children,
  right,
  sub,
}: {
  children: React.ReactNode;
  right?: boolean;
  sub?: string;
}) {
  return (
    <th className={cn('h-8 px-2 py-1 align-bottom font-medium', right ? 'text-right' : 'text-left')}>
      <span className="block truncate">{children}</span>
      {sub ? (
        <span className="block truncate text-[9px] font-normal normal-case text-muted-foreground/70">
          {sub}
        </span>
      ) : null}
    </th>
  );
}
