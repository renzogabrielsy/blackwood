'use client';

import * as React from 'react';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { UnitValue } from '@/components/shared/unit-value';
import { cn } from '@/lib/utils';
import type { OpsDayBlockFeed, OpsFedBlend, OpsLedgerDay } from '@/lib/operations/types';
import { TONE } from './ops-color';
import { kg, lab } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE FED CELL'S SIDEBAR — what was fed that day, and what it projects to.
//
// Renzo, 2026-09-16: *"Per cell in the Fed column, it should be clickable like the
// KPI and once clicked show a table of the blocks that were fed on that day, like a
// sidebar. And it should show me the stats of what was fed — a table / mini KPI
// strip that shows me the projected MC, BD, Ash etc. of the final product. **Not to
// be taken as truth but a good figure to see.**"*
//
// ── THE ONE THING THIS SURFACE MUST NEVER STOP SAYING ───────────────────────────
// **IT IS A PROJECTION, NOT A LAB RESULT.** These are the delivery-weighted lab
// averages of the RAW CHARCOAL that went in, carried forward because the finished
// product is heavily determined by what was fed. No lab measured what the head of
// this panel describes. The caveat line is not decoration — it is the whole reason
// Renzo is willing to look at the number.
//
// ── FOUR RULES ──────────────────────────────────────────────────────────────────
//
//  1. **NOTHING IS COMPUTED.** Every weighted mean was computed IN SQL, weighted by
//     FED KG, by `view_ops_ledger_day_fed_blend` — which SELECTs from the very view
//     the block rows below come from, so the head and the list can never describe
//     different populations. The only `+` in this file sums COLUMN WIDTHS.
//  2. **COVERAGE IS PRINTED, NOT ASSUMED.** Each stat is weighted over only the
//     blocks that carry it, and the fed kilos that did carry it ride beside it as
//     `<stat>Kg`. When that is short of the day's `fedKg` the caption says so —
//     *"from 41,200 of 47,000 kg"* — two published fields printed side by side.
//  3. **NULL IS NEVER 0.** 53 of the 525 blocks a campaign has ever fed carry no
//     lab reading at all; a printed `0.00` would read as "0 % moisture". A block
//     with no panel reads BLANK on all seven, and the blend reads blank on a stat
//     no fed block carries.
//  4. **NO ₱ ANYWHERE.** Not one column on either source view carries money and
//     none is derivable, so this panel is safe for every role including Production
//     and is not gated.
//
// It is a SHEET and therefore OPAQUE: it slides over the scrolling ledger, and
// CLAUDE.md → "Frozen Panes" is unambiguous that a surface sitting on top of moving
// content takes no alpha. The primitive's canonical glass is overridden here for
// exactly that reason — `bg-background`, `backdrop-blur-none`, and the
// `supports-[backdrop-filter]` twin as well, because a variant-prefixed class is
// its own utility group and a plain `bg-background` would not replace it.
// ═════════════════════════════════════════════════════════════════════════════════

/** ⚠ `gritKg` HERE IS COVERAGE — nothing to do with the GRITS waste stream. */
interface BlendStat {
  key: string;
  label: string;
  /** The unit, pinned LEFT by `UnitValue`. */
  glyph: string;
  dp: number;
  value(b: OpsFedBlend): number | null;
  /** The fed kilos that carried a reading for this stat. */
  coverage(b: OpsFedBlend): number | null;
  cell(r: OpsDayBlockFeed): number | null;
}

const STATS: readonly BlendStat[] = [
  { key: 'mc', label: 'MC', glyph: '%', dp: 2, value: (b) => b.wMc, coverage: (b) => b.mcKg, cell: (r) => r.mc },
  { key: 'ash', label: 'Ash', glyph: '%', dp: 2, value: (b) => b.wAsh, coverage: (b) => b.ashKg, cell: (r) => r.ash },
  {
    key: 'bdastm',
    label: 'BD ASTM',
    glyph: 'g/cc',
    dp: 3,
    value: (b) => b.wBdAstm,
    coverage: (b) => b.bdAstmKg,
    cell: (r) => r.bdAstm,
  },
  {
    key: 'bdjis',
    label: 'BD JIS',
    glyph: 'g/cc',
    dp: 3,
    value: (b) => b.wBdJis,
    coverage: (b) => b.bdJisKg,
    cell: (r) => r.bdJis,
  },
  { key: 'grit', label: 'Grit', glyph: '%', dp: 2, value: (b) => b.wGrit, coverage: (b) => b.gritKg, cell: (r) => r.grit },
  { key: 'vm', label: 'VM', glyph: '%', dp: 2, value: (b) => b.wVm, coverage: (b) => b.vmKg, cell: (r) => r.vm },
  { key: 'fc', label: 'FC', glyph: '%', dp: 2, value: (b) => b.wFc, coverage: (b) => b.fcKg, cell: (r) => r.fc },
];

// ── WIDTHS — Excel Standard, explicit px, Σ is the table's `minWidth` ───────────
const W_BATCH = 148;
const W_LOC = 72;
const W_FED = 88;
const W_STAT = 64;
const TABLE_MIN = W_BATCH + W_LOC + W_FED + STATS.length * W_STAT;

const mono = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

export interface OpsFedDaySheetProps {
  /** The day whose FED cell was clicked. `null` closes the panel. */
  day: OpsLedgerDay | null;
  onClose(): void;
  /** Opens the block's own detail drawer — the same contract the lens headers use. */
  onOpenBlock(batchId: string, batchCode: string, blockLoc: string | null): void;
}

export function OpsFedDaySheet({ day, onClose, onOpenBlock }: OpsFedDaySheetProps) {
  const blend = day?.fedBlend ?? null;
  const rows = day?.blocksFed ?? [];

  return (
    <Sheet open={day !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className={cn(
          // OPAQUE — see the header note. Both halves of the primitive's glass are
          // replaced, and the blur with them.
          'w-full bg-background backdrop-blur-none supports-[backdrop-filter]:bg-background',
          'gap-0 p-0 sm:max-w-[min(96vw,800px)]',
        )}
      >
        {day ? (
          <>
            <SheetHeader className="shrink-0 border-b border-border px-4 py-3 pr-10">
              <SheetTitle className="flex items-center gap-2 text-sm">
                <span className={cn('size-2 shrink-0 rounded-full', TONE.fed.dot)} />
                <span className="font-mono tabular-nums">{day.date}</span>
                <span className="text-muted-foreground">·</span>
                <span>{day.campaignLabel}</span>
                <span className="text-muted-foreground">·</span>
                <span>FED</span>
              </SheetTitle>
              <SheetDescription className="font-mono text-[11px] tabular-nums">
                {kg(day.fedKg)} kg fed · {day.blocksFedCount} block
                {day.blocksFedCount === 1 ? '' : 's'} · {day.weekday}
              </SheetDescription>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
              {/* ── THE PROJECTED PROFILE ─────────────────────────────────────── */}
              <section className="shrink-0">
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Projected profile of what was fed
                </h3>
                {blend ? (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {STATS.map((s) => {
                      const v = s.value(blend);
                      const cov = s.coverage(blend);
                      // A COMPARISON, not arithmetic: both sides are published
                      // fields and the caption prints them unchanged.
                      const partial = v !== null && cov !== null && blend.fedKg !== null && cov < blend.fedKg;
                      return (
                        <div
                          key={s.key}
                          className="rounded-md border border-border bg-muted/40 px-2 py-1.5"
                          title={
                            partial
                              ? `${s.label} is weighted over the ${kg(cov)} kg of the day's ${kg(blend.fedKg)} kg whose blocks carry a reading.`
                              : undefined
                          }
                        >
                          <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {s.label}
                          </span>
                          <UnitValue
                            glyph={v === null ? '' : s.glyph}
                            className="leading-tight"
                            valueClassName={cn(
                              'font-mono text-sm font-medium tabular-nums',
                              v === null ? 'text-muted-foreground' : TONE.fed.text,
                            )}
                          >
                            {lab(v, s.dp) || '—'}
                          </UnitValue>
                          {partial ? (
                            <span className="mt-0.5 block truncate font-mono text-[9px] tabular-nums text-muted-foreground">
                              from {kg(cov)} of {kg(blend.fedKg)} kg
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No blend is published for this day — nothing reached the plant, so there is
                    nothing to project from.
                  </p>
                )}
                {/* THE CAVEAT. Renzo's own words, and the reason the figure is
                    allowed on the screen at all. */}
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                  Projected from what was fed — not a lab result. These are the delivery-weighted
                  lab averages of the raw charcoal, weighted by the kilos fed; no lab measured the
                  finished product.
                </p>
              </section>

              {/* ── THE BLOCKS ────────────────────────────────────────────────── */}
              <section className="flex min-h-0 flex-auto flex-col gap-1">
                <h3 className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Blocks fed
                </h3>
                {rows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No block is listed for this day.
                  </p>
                ) : (
                  // NEVER CRUSH, ALWAYS SCROLL — Σ of every declared width.
                  <div className="min-h-0 flex-auto overflow-auto rounded-md border border-border">
                    <table
                      className="table-fixed text-xs"
                      style={{
                        width: '100%',
                        minWidth: TABLE_MIN,
                        // MANDATORY with sticky cells — under `border-collapse` the
                        // browser paints sticky backgrounds transparent.
                        borderCollapse: 'separate',
                        borderSpacing: 0,
                      }}
                    >
                      <colgroup>
                        <col style={{ width: W_BATCH }} />
                        <col style={{ width: W_LOC }} />
                        <col style={{ width: W_FED }} />
                        {STATS.map((s) => (
                          <col key={s.key} style={{ width: W_STAT }} />
                        ))}
                      </colgroup>
                      <thead>
                        <tr>
                          <th
                            style={{ top: 0 }}
                            className="frozen-row border-b border-r border-border bg-muted px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                          >
                            Batch
                          </th>
                          <th
                            style={{ top: 0 }}
                            className="frozen-row border-b border-r border-border bg-muted px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                          >
                            Block loc
                          </th>
                          <th
                            style={{ top: 0 }}
                            className={cn(
                              'frozen-row border-b border-r border-border px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide',
                              TONE.fed.head,
                            )}
                          >
                            <span className="block truncate">
                              Fed
                              <span className="ml-1 font-normal normal-case opacity-70">kg</span>
                            </span>
                          </th>
                          {STATS.map((s) => (
                            <th
                              key={s.key}
                              style={{ top: 0 }}
                              className="frozen-row border-b border-r border-border bg-muted px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                              <span className="block truncate">{s.label}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.batchId} className="h-8 transition-all duration-150 hover:bg-accent/50">
                            <td className="border-b border-r border-border/60 px-1 py-0.5">
                              <button
                                type="button"
                                onClick={() => onOpenBlock(r.batchId, r.batchCode, r.blockLoc)}
                                title={`Open ${r.batchCode}`}
                                className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                              >
                                {r.batchCode}
                              </button>
                            </td>
                            <td className="border-b border-r border-border/60 px-2 py-1">
                              <span className="block truncate font-mono">{r.blockLoc ?? '—'}</span>
                            </td>
                            <td className="border-b border-r border-border/60 px-2 py-1 text-right">
                              {mono(kg(r.fedKg), cn('font-medium', TONE.fed.text))}
                            </td>
                            {STATS.map((s) => (
                              <td
                                key={s.key}
                                className="border-b border-r border-border/60 px-2 py-1 text-right"
                              >
                                {mono(lab(s.cell(r), s.dp), 'text-muted-foreground')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td
                            style={{ bottom: 0 }}
                            className="frozen-row-bottom frozen-edge-top border-r border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                          >
                            Blend
                          </td>
                          <td
                            style={{ bottom: 0 }}
                            className="frozen-row-bottom border-r border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                          >
                            {day.blocksFedCount}
                          </td>
                          <td
                            style={{ bottom: 0 }}
                            className="frozen-row-bottom border-r border-border bg-muted px-2 py-1 text-right"
                          >
                            {mono(kg(day.fedKg), 'text-[11px] font-semibold')}
                          </td>
                          {STATS.map((s) => (
                            <td
                              key={s.key}
                              style={{ bottom: 0 }}
                              className="frozen-row-bottom border-r border-border bg-muted px-2 py-1 text-right"
                            >
                              {blend
                                ? mono(lab(s.value(blend), s.dp), 'text-[11px] font-semibold')
                                : null}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
