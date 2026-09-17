'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaignRollup,
  type OpsGroupRollup,
  type OpsLedgerData,
  type OpsLedgerDay,
  type OpsShift,
} from '@/lib/operations/types';
import { campaignAccent, TONE, type OpsTone } from './ops-color';
import { OpsFedDaySheet } from './ops-fed-day-sheet';
import { count, hours, kg, pctFromFraction, php } from './ops-format';
import type { OpsLensId } from './ops-lens';

// ═════════════════════════════════════════════════════════════════════════════════
// THE LEDGER — **ONE TABLE, ONE SCROLLBAR** (2026-09-15).
//
// It used to be two scroll-synced panes behind a draggable divider. Renzo, reading
// the shipped page: *"there are two vertical scroll bars. There's no point in having
// two if they are synced… no point in making them two different tables when in
// reality they are just beside each other. Better if they coexist."* He is right, and
// the two-pane shape was paying for a problem it created: a scroll-sync handler, an
// ownership guard against feedback, a pixel divider with a ResizeObserver clamp, a
// phone pane toggle, and a **fixed 320px expansion band** that existed ONLY so the
// two sides would stay row-aligned. One table needs none of it — the rows ARE one
// row — so all five went, and the band now sizes to its content.
//
// The spine is now FROZEN COLUMNS instead of a pane: `#expand · DATE · DAY ·
// FED ₱/KG · TTL FED · TTL PROD · WASTE · WASTE % · YIELD % · LOSS % · SHIFTS ·
// DT HRS`, each `position: sticky` at its own cumulative `left` offset,
// `.frozen-edge` on the last one. The lens columns scroll past them in the same
// `<table>`.
//
// ── DRIFT KG IS GONE; FOUR RATIOS TOOK ITS PLACE (2026-09-15, round 2) ──────────
// `dayDriftKg` is no longer rendered anywhere on this screen. It was a kilogram
// figure whose whole header tooltip existed to say *"this is not what it looks
// like"*, and the same statement is now made by the numbers a reader actually wants
// beside a day: **WASTE** (`totalWasteKg`, the eight streams), **WASTE %**
// (`wastePct`), **YIELD %** (`yieldPct`) and **LOSS %** (`lossPct`) — all four
// published per day by `view_ops_ledger_day`, none of them computed here.
//
// **THE DAY YIELD AND LOSS ARE INDICATIVE AND SAY SO.** The feed tank is continuous
// flow, so a day's fed kilos and its produced kilos are not the same charcoal
// (2026-07-02 divides to 99.55%, and a JULY day produced 22,862 kg on no feed at
// all). That is the identical caveat DRIFT carried, moved onto the two columns it
// actually applies to, and the CAMPAIGN and GROUP footers under them print the real
// campaign figures (`yieldPct` / `processLossPct`) where the ratio genuinely holds.
// WASTE and WASTE % carry no such caveat — a day's swept-up waste and a day's
// production DO describe the same shift.
//
// ── EXPANDING A DAY INSERTS CHILD ROWS, NOT A PANEL (2026-09-15, round 3) ───────
// Renzo: *"An identical row in the format of the parent row but ONLY showing the
// SHIFTS groups. So if there's M, E, N in one day, then it should show 3 child rows
// just summing the totals PER shift accordingly. There's no need for those sections
// above the table with the rc fed breakdown for the day. Child rows should be self
// explanatory. Too wordy anyway. No reason for the fed table in the dropdown to also
// be horizontally scrolled."*
//
// So the whole expansion PANEL is gone — the shift cards, the recorded-waste block,
// the BLOCKS USED table and the `sticky left-0` band that carried them — and with it
// `ops-day-detail.tsx` and the day-grain `blocksUsed` read. A day now opens into ONE
// ORDINARY `<tr>` PER SHIFT, in the SAME columns, with the same frozen-column
// treatment: no inner table, no second set of widths, no second horizontal scroll.
//
// **A SHIFT ROW LEAVES BLANK EVERYTHING A SHIFT DOES NOT OWN.** `rc_out` has no shift
// dimension — feeding is recorded per DATE — so FED PRICE, TTL FED, YIELD % and LOSS %
// are blank on a child row rather than repeated from the parent or split by some
// invented rule. What a shift genuinely owns is published per shift and is printed:
// TTL PROD, WASTE, WASTE %, DT HRS, its grade split and its eight streams. A day with
// no shift at all is NOT EXPANDABLE — there is nothing to open.
//
// ── SIX RULES THIS COMPONENT IS BUILT AROUND ────────────────────────────────────
//
//  1. **NOTHING IS COMPUTED HERE.** No `reduce`, no `+`, no ratio on any render path.
//     Every day figure is a field of `OpsLedgerDay`, every campaign total a field of
//     `OpsCampaignRollup`, every group total a field of `OpsGroupRollup`. The only
//     arithmetic left is column-width and `left`-offset bookkeeping, which is layout.
//     Where a total does not exist in the payload the footer SAYS SO.
//  2. **NULL IS NEVER 0.** A rest day renders blank cells, not a row of zeros.
//  3. **A ROW'S IDENTITY IS `campaignKey:date`, NEVER the date alone.** A CHANGEOVER
//     DATE BELONGS TO TWO CAMPAIGNS — 2026-08-01 is JULY's last day and AUGUST's
//     first; 2026-08-29 is AUGUST's last and SEPTEMBER's first — so keying rows by
//     `date` handed React duplicate keys and it reconciled one of them into the wrong
//     band (a stray 2026-08-29 row rendered above JULY). The expanded-row identity is
//     the same composite string for the same reason.
//  4. **A DAY RATIO IS NEVER PRESENTED AS THE CAMPAIGN'S.** The feed tank is
//     continuous flow, so a day's fed and produced do not describe the same
//     charcoal. YIELD % and LOSS % therefore carry the indicative caveat in their
//     header `title`, and the CAMPAIGN / GROUP footers under them print the
//     campaign's own `yieldPct` / `processLossPct`, where the ratio genuinely holds.
//  5. **A ₱ COLUMN IS ABSENT, NOT BLANK, for a role that may not see prices.** The
//     server already nulled the field; dropping the column from the coordinate space
//     is what the RC Movement matrix does and what the `left`-offset arithmetic here
//     depends on.
//  6. **FROZEN SURFACES ARE OPAQUE.** Every sticky header, footer and spine cell
//     carries a SOLID token — `bg-muted`, `bg-background`, `bg-accent` or a solid
//     palette step from `ops-color.ts`. The translucent column tints are only ever on
//     NON-frozen lens cells. `border-separate` + `borderSpacing: 0` is MANDATORY
//     (under `border-collapse` the browser renders sticky cell backgrounds
//     transparent and the scrolling cells bleed straight through the spine), so the
//     spreadsheet gridlines Renzo asked for are reconstructed per cell with
//     `border-b` / `border-r`.
// ═════════════════════════════════════════════════════════════════════════════════

const ROW_H = 32; // Excel Standard `h-8`.
const GROUP_H = 22; // The column-group band — header row 1.
const HEAD_H = 26; // The column labels — ONE line (label + inline unit), sticky at `top: GROUP_H`.
const BAND_H = 30;
const FOOT_H = 34;

const W_EXPAND = 32;
const W_DATE = 92;
const W_DAY = 46;
const W_FEDPHP = 102; // `FED PRICE ₱/kg` on ONE line — measured, it clipped at 96.
const W_FEDKG = 94;
const W_PRODKG = 98;
const W_WASTEKG = 88;
const W_WASTEPCT = 76;
const W_YIELDPCT = 76;
const W_LOSSPCT = 76;
const W_SHIFTS = 62;
const W_DTHRS = 80;

const W_GRADE = 92;
const W_WASTE = 86;
const W_BLOCK = 150; // label + the block loc INLINE — one header line, so it needs the width.

/**
 * Below this the frozen spine would leave no room for the lens.
 *
 * ⚠ IT IS DERIVED FROM THE SPINE, NOT DECLARED (2026-09-17). The spine's width now
 * has FOUR values, not two — the ₱ column goes for a price-denied reader and the two
 * OUTPUT RATIOS columns go when `?ratios=off` — so a hardcoded breakpoint would be
 * right for one of them and wrong for three. The rule is the one it always was:
 * **un-freeze while the spine would occupy more than ~90% of the frame**, i.e.
 * `round(spineWidth / 0.9) − 1`, which reproduces the 1023px that was hardcoded here
 * for the 922px priced spine EXACTLY and moves with the other three:
 *
 * | spine | ₱ | ratios | breakpoint |
 * |---|---|---|---|
 * | 922 | ✓ | ✓ | 1023 |
 * | 820 | — | ✓ | 910 |
 * | 770 | ✓ | — | 855 |
 * | 668 | — | — | 741 |
 */
const narrowQuery = (spineWidth: number) =>
  `(max-width: ${Math.round(spineWidth / 0.9) - 1}px)`;

/**
 * THE ONE CAVEAT, on the two columns it applies to.
 *
 * Renzo's rule, carried from the data layer: a DAY yield is indicative only. It is
 * the same statement the retired DRIFT column made in kilograms, said as a ratio —
 * and the footers underneath print the campaign figure, where it genuinely holds.
 */
const DAY_RATIO_TITLE =
  'Day-level, indicative — the feed tank is continuous flow; the campaign figure is the real one.';

const mono = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

/**
 * IS THERE ANYTHING TO OPEN BEHIND THIS DAY'S FED CELL?
 *
 * A day that fed nothing has no blend (the view publishes one row per day with
 * `fed_kg > 0`) and no block rows, so it gets no button rather than a disclosure
 * that opens into an empty panel — the same rule the expand chevron already
 * follows for a day with no shift.
 */
const fedOpenable = (d: OpsLedgerDay) => d.fedBlend !== null || d.blocksFed.length > 0;

/**
 * EVERYTHING L-051 / L-051b STORED, on the one cell it explains.
 *
 * `dtRanges` is MC's own list of stop-and-start times and is what the minutes are
 * derived FROM; `dtIncidentRanges` is the subset the plant ran THROUGH, which
 * contributes ZERO minutes and is named anyway so it can never become invisible;
 * `shiftHrsSource` says which rule set the shift length. String assembly only.
 */
function downtimeTitle(s: OpsShift): string | undefined {
  const parts: string[] = [];
  if (s.shiftHrs !== null) {
    parts.push(`Shift ${hours(s.shiftHrs)} h${s.shiftHrsSource ? ` (${s.shiftHrsSource})` : ''}`);
  }
  if (s.dtReason) parts.push(s.dtReason);
  if (s.dtRanges) parts.push(`ranges ${s.dtRanges}`);
  if (s.hasIncident && s.dtIncidentRanges) {
    parts.push(`ran through ${s.dtIncidentRanges} — zero downtime minutes`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// ─── THE SPINE ───────────────────────────────────────────────────────────────────

interface SpineCol {
  key: string;
  label: string;
  sub?: string;
  title?: string;
  width: number;
  right?: boolean;
  tone: OpsTone;
  /** The column-group band above it. Consecutive equal labels merge into one cell. */
  group: string;
  /** Dropped from the coordinate space entirely when the viewer may not see prices. */
  price?: boolean;
  /**
   * PART OF THE `OUTPUT RATIOS` GROUP — dropped from the coordinate space entirely
   * when `?ratios=off` (2026-09-17).
   *
   * ABSENT, never blank: the frozen `left` offsets, the table's `minWidth` and the
   * un-freeze breakpoint are all computed from the columns that survive, which is
   * the same contract {@link price} has kept since the spine was frozen.
   */
  ratio?: boolean;
  /** The chevron column — rendered by the row, not by `day()`. */
  expand?: boolean;
  /**
   * THE FED CELL — a BUTTON on a day that fed, opening the day's sidebar
   * (2026-09-16). Renzo: *"Per cell in the Fed column, it should be clickable like
   * the KPI and once clicked show a table of the blocks that were fed on that
   * day, like a sidebar."* The row renders the button around `day()`, so the cell
   * keeps exactly the figure and the colour it already had; a rest day (and any
   * day that fed nothing) gets no button rather than a dead affordance.
   */
  fedCell?: boolean;
  day(d: OpsLedgerDay): React.ReactNode;
  /**
   * THE CHILD ROW. Absent means the column is BLANK on a shift row, and that is a
   * statement: a shift does not own that figure. Never a fallback to the day's.
   */
  shift?(s: OpsShift): React.ReactNode;
  campaign(c: OpsCampaignRollup): React.ReactNode;
  /** The sticky bottom row: the GROUP when several campaigns are picked, else the one. */
  total(g: OpsGroupRollup | null, single: OpsCampaignRollup | null): React.ReactNode;
}

const SPINE: SpineCol[] = [
  {
    key: 'expand',
    label: '',
    width: W_EXPAND,
    tone: 'day',
    group: '',
    expand: true,
    day: () => null,
    campaign: () => null,
    total: () => null,
  },
  {
    key: 'date',
    label: 'Date',
    width: W_DATE,
    tone: 'day',
    group: 'DAY',
    day: (d) => <span className="font-mono tabular-nums">{d.date}</span>,
    // The child row announces itself HERE, where the eye already is, rather than in
    // the SHIFTS column — which stays blank, because a count of one is not news.
    shift: (s) => (
      <span className="block truncate pl-2 font-mono text-[11px] text-muted-foreground">
        ↳ Shift {s.shift || '—'}
      </span>
    ),
    campaign: (c) => (
      <span className="text-[10px] font-semibold uppercase tracking-wide">{c.productionBatch}</span>
    ),
    total: (g, s) => (
      <span className="text-[10px] font-semibold uppercase tracking-wide">
        {g ? 'GROUP' : (s?.productionBatch ?? 'TOTAL')}
      </span>
    ),
  },
  {
    key: 'weekday',
    label: 'Day',
    width: W_DAY,
    tone: 'day',
    group: 'DAY',
    day: (d) => (
      <span className={cn(d.isWeekend ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
        {d.weekday}
      </span>
    ),
    campaign: (c) => <span className="text-[10px] text-muted-foreground">{count(c.activeDays)} d</span>,
    total: (g, s) => (
      <span className="text-[10px] text-muted-foreground">
        {count(g ? g.activeDays : (s?.activeDays ?? null))} d
      </span>
    ),
  },
  {
    key: 'fedphp',
    label: 'Fed price',
    sub: '₱/kg',
    title: "The day's weighted-average DELIVERED price for the charcoal fed.",
    width: W_FEDPHP,
    tone: 'money',
    group: 'PRICE',
    price: true,
    day: (d) =>
      d.fedPhpKg === null ? null : (
        // ACCOUNTING FORMAT — ₱ pinned left, number pinned right (Excel Standard).
        <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
          <span className="text-muted-foreground">&#8369;</span>
          <span className={TONE.money.text}>{php(d.fedPhpKg)}</span>
        </span>
      ),
    campaign: (c) => mono(php(c.fedPhpKg)),
    total: (g, s) => mono(php(g ? g.fedPhpKg : (s?.fedPhpKg ?? null))),
  },
  {
    key: 'fedkg',
    label: 'Ttl fed',
    sub: 'kg',
    title: 'Click a day to open the blocks it drew from and the projected profile of what was fed.',
    right: true,
    width: W_FEDKG,
    tone: 'fed',
    group: 'FED',
    fedCell: true,
    day: (d) => mono(kg(d.fedKg), cn('font-medium', TONE.fed.text)),
    campaign: (c) => mono(kg(c.fedKg)),
    total: (g, s) => mono(kg(g ? g.fedKg : (s?.fedKg ?? null))),
  },
  {
    key: 'prodkg',
    label: 'Ttl prod',
    sub: 'kg',
    right: true,
    width: W_PRODKG,
    tone: 'produced',
    group: 'PRODUCED',
    day: (d) => mono(kg(d.producedKg), cn('font-medium', TONE.produced.text)),
    shift: (s) => mono(kg(s.producedKg), TONE.produced.text),
    campaign: (c) => mono(kg(c.producedKg)),
    total: (g, s) => mono(kg(g ? g.producedKg : (s?.producedKg ?? null))),
  },
  {
    key: 'wastekg',
    label: 'Waste',
    sub: 'kg',
    right: true,
    title:
      'The eight recorded waste streams, totalled for the day. They do NOT sum to the process loss — most of what the retort loses leaves as moisture and volatiles, which nobody weighs. The footers print the campaign and group totals.',
    width: W_WASTEKG,
    tone: 'waste',
    group: 'WASTE',
    day: (d) => mono(kg(d.totalWasteKg), cn('font-medium', TONE.waste.text)),
    shift: (s) => mono(kg(s.totalWasteKg), TONE.waste.text),
    campaign: (c) => mono(kg(c.wasteKg)),
    total: (g, s) => mono(kg(g ? g.wasteKg : (s?.wasteKg ?? null))),
  },
  {
    key: 'wastepct',
    label: 'Waste %',
    right: true,
    title:
      'Recorded waste over the charcoal PRODUCED that day — what the plant swept up came OUT of the retort and was then rejected, so it is a property of the output, not of what went in. Same denominator as the campaign figure in the rollup above, so the two grains are one definition.',
    width: W_WASTEPCT,
    tone: 'waste',
    group: 'WASTE',
    day: (d) => mono(pctFromFraction(d.wastePct, 2), 'text-muted-foreground'),
    // THE SAME DENOMINATOR at all three grains — shift, day, campaign — so a child
    // row, its parent and the EOQ cell are one definition, computed in SQL each time.
    shift: (s) => mono(pctFromFraction(s.wastePct, 2), 'text-muted-foreground'),
    campaign: (c) => mono(pctFromFraction(c.wasteLossPct, 2)),
    total: (g, s) => mono(pctFromFraction(g ? g.wasteLossPct : (s?.wasteLossPct ?? null), 2)),
  },
  {
    key: 'yieldpct',
    label: 'Yield %',
    right: true,
    title: DAY_RATIO_TITLE,
    width: W_YIELDPCT,
    tone: 'drift',
    group: 'OUTPUT RATIOS',
    ratio: true,
    day: (d) => mono(pctFromFraction(d.yieldPct, 2), 'text-muted-foreground'),
    campaign: (c) => mono(pctFromFraction(c.yieldPct, 2)),
    total: (g, s) => mono(pctFromFraction(g ? g.yieldPct : (s?.yieldPct ?? null), 2)),
  },
  {
    key: 'losspct',
    label: 'Loss %',
    right: true,
    title: DAY_RATIO_TITLE,
    width: W_LOSSPCT,
    tone: 'drift',
    group: 'OUTPUT RATIOS',
    ratio: true,
    day: (d) => mono(pctFromFraction(d.lossPct, 2), 'text-muted-foreground'),
    campaign: (c) => mono(pctFromFraction(c.processLossPct, 2)),
    total: (g, s) => mono(pctFromFraction(g ? g.processLossPct : (s?.processLossPct ?? null), 2)),
  },
  {
    key: 'shifts',
    label: 'Shifts',
    right: true,
    width: W_SHIFTS,
    tone: 'shift',
    group: 'SHIFT',
    day: (d) => mono(count(d.shiftCount)),
    campaign: (c) => mono(count(c.shiftCount)),
    total: (g, s) => mono(count(g ? g.shiftCount : (s?.shiftCount ?? null))),
  },
  {
    key: 'dthrs',
    label: 'DT hrs',
    sub: 'h',
    right: true,
    width: W_DTHRS,
    tone: 'shift',
    group: 'SHIFT',
    day: (d) =>
      mono(
        hours(d.downtimeHours),
        d.downtimeHours !== null && d.downtimeHours > 0
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground',
      ),
    // L-051 / L-051b ride in the `title`: MC's own list of stop-and-start times, the
    // ranges the plant ran THROUGH (zero minutes, never invisible) and which rule set
    // the shift length. The panel that used to print them is gone; the facts are not.
    shift: (s) => (
      <span
        className={cn(
          'font-mono tabular-nums',
          s.downtimeHours !== null && s.downtimeHours > 0
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground',
        )}
        title={downtimeTitle(s)}
      >
        {hours(s.downtimeHours)}
      </span>
    ),
    campaign: (c) => mono(hours(c.downtimeHours)),
    total: (g, s) => mono(hours(g ? g.downtimeHours : (s?.downtimeHours ?? null))),
  },
];

interface ColRun {
  group: string;
  span: number;
  left: number;
  /** The run's first column's tone — the band is one colour by construction. */
  tone: OpsTone;
}

/**
 * Consecutive columns sharing a `group` label, merged into one header cell.
 *
 * Pure layout bookkeeping — it counts columns and adds up pixel widths, which is the
 * one kind of arithmetic this module is allowed (plan §2.7 rule 1 is about DATA).
 */
function runs<T extends { group: string; width: number; tone: OpsTone }>(cols: readonly T[]): ColRun[] {
  const out: ColRun[] = [];
  let left = 0;
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && last.group === c.group) last.span += 1;
    else out.push({ group: c.group, span: 1, left, tone: c.tone });
    left += c.width;
  }
  return out;
}

// ─── THE LENS ────────────────────────────────────────────────────────────────────

interface LensColumn {
  key: string;
  label: string;
  sub?: string;
  width: number;
  tone: OpsTone;
  group: string;
  /** Rendered as a batch-code button in the header — the RC Movement gesture. */
  block?: { batchId: string; batchCode: string; blockLoc: string | null };
  value(day: OpsLedgerDay): React.ReactNode;
  /** The child row. Absent = blank on a shift row — see the header note. */
  shiftValue?(shift: OpsShift): React.ReactNode;
  /**
   * Whether the PAYLOAD publishes a per-campaign total for this column.
   *
   * It is a separate flag from the value because `null` is a legitimate total (a
   * campaign whose shifts filed no waste row), and collapsing "not published" into
   * "published as null" is how a footer starts lying. Re-deriving a missing total by
   * summing the visible cells is the re-derivation plan §2.7 rule 1 forbids.
   */
  hasCampaignTotal: boolean;
  hasGroupTotal: boolean;
  campaignTotal(campaignKey: string): React.ReactNode;
  groupTotal(): React.ReactNode;
}

function gradeColumns(data: OpsLedgerData): LensColumn[] {
  // THE GRADE SET IS DATA — the union the campaigns in view actually produced,
  // already in display order. Never a hardcoded list.
  const soleKey = data.rollups.length === 1 ? data.rollups[0].campaignKey : null;
  const totalFor = (campaignKey: string, grade: string) =>
    data.gradesByCampaign[campaignKey]?.find((x) => x.grade === grade) ?? null;

  return data.grades.map((g) => ({
    key: `grade:${g}`,
    label: g,
    sub: 'kg',
    width: W_GRADE,
    tone: 'produced' as const,
    group: 'GRADES',
    value: (d) => mono(kg(d.producedByGrade[g] ?? null), TONE.produced.text),
    // The SHIFT's own grade split, summed in SQL over its runs. A MISSING key means
    // that grade did not run in that shift — never 0.
    shiftValue: (s) => mono(kg(s.gradeKg[g] ?? null), 'text-muted-foreground'),
    hasCampaignTotal: true,
    // No GROUP grade total is published — `gradesByCampaign` is per campaign. With
    // exactly one campaign in view the two grains are the same published row, so the
    // footer prints it; with several it stays blank and says why on hover.
    hasGroupTotal: soleKey !== null,
    campaignTotal: (ck) => mono(kg(totalFor(ck, g)?.kg ?? null), 'font-semibold'),
    groupTotal: () => (soleKey ? mono(kg(totalFor(soleKey, g)?.kg ?? null), 'font-semibold') : null),
  }));
}

function wasteColumns(data: OpsLedgerData): LensColumn[] {
  // 2026-09-15: the campaign and group rollups NOW CARRY the eight streams
  // (`rollups[].waste` / `group.waste`), so these footers print real published
  // totals where they used to print "no total is published for this lens".
  const byKey = new Map(data.rollups.map((r) => [r.campaignKey, r]));
  return WASTE_STREAMS.map((w) => ({
    key: `waste:${w.key}`,
    label: w.label,
    sub: 'kg',
    width: W_WASTE,
    tone: 'waste' as const,
    group: 'WASTE STREAMS',
    // The STREAM's hue lives in its header band and its column tint; the eight
    // value columns stay on the neutral token so a losses lens is not a wall of
    // red. Colour says WHAT KIND of number this is, never how big it is.
    value: (d) => mono(kg(d.waste[w.key]), 'text-muted-foreground'),
    shiftValue: (s) => mono(kg(s.waste[w.key]), 'text-muted-foreground'),
    hasCampaignTotal: true,
    hasGroupTotal: data.group !== null,
    campaignTotal: (ck) => mono(kg(byKey.get(ck)?.waste[w.key] ?? null), 'font-semibold'),
    groupTotal: () => mono(kg(data.group?.waste[w.key] ?? null), 'font-semibold'),
  }));
}

function blockColumns(data: OpsLedgerData): LensColumn[] {
  // The column list is the blocks the selected campaigns actually drew from, in the
  // order they were first drawn from — a RESHAPE of the payload's own ordering.
  const seen = new Map<string, { batchCode: string; blockLoc: string | null }>();
  for (const day of data.days) {
    for (const b of day.blocksFed) {
      if (!seen.has(b.batchId)) {
        seen.set(b.batchId, { batchCode: b.batchCode, blockLoc: b.blockLoc });
      }
    }
  }

  // ── THIS LENS NOW HAS FOOTERS (2026-09-15, round 3) ──────────────────────────
  // `OpsCampaign.blocks[].campaignFedKg` is the kilograms THIS campaign drew from
  // that block, and `OpsGroupRollup.blocks[].groupFedKg` the group's — both published
  // per (campaign|group × block) in SQL, both proven to sum to the rollup's own
  // `fedKg`. So the footer prints a real total where it used to print *"no total is
  // published for this lens"*. It is a LOOKUP, not a fold of the cells above it.
  const blocksByCampaign = new Map(data.campaigns.map((c) => [c.key, c.blocks]));
  const soleKey = data.rollups.length === 1 ? data.rollups[0].campaignKey : null;
  const campaignFed = (campaignKey: string, batchId: string) =>
    blocksByCampaign.get(campaignKey)?.find((b) => b.batchId === batchId)?.campaignFedKg ?? null;
  const groupFed = (batchId: string) =>
    data.group?.blocks.find((b) => b.batchId === batchId)?.groupFedKg ?? null;

  return [...seen.entries()].map(([batchId, meta]) => ({
    key: `blk:${batchId}`,
    label: meta.batchCode,
    sub: meta.blockLoc ?? '—',
    width: W_BLOCK,
    tone: 'block' as const,
    group: 'BLOCKS FED',
    block: { batchId, batchCode: meta.batchCode, blockLoc: meta.blockLoc },
    value: (d) => {
      const cell = d.blocksFed.find((x) => x.batchId === batchId);
      return cell ? mono(kg(cell.fedKg), TONE.fed.text) : null;
    },
    // Feeding has no shift dimension — `rc_out` is recorded per DATE — so a block
    // column is BLANK on a child row rather than split by an invented rule.
    hasCampaignTotal: true,
    hasGroupTotal: soleKey !== null || data.group !== null,
    campaignTotal: (ck) => mono(kg(campaignFed(ck, batchId)), 'font-semibold'),
    groupTotal: () =>
      mono(kg(soleKey ? campaignFed(soleKey, batchId) : groupFed(batchId)), 'font-semibold'),
  }));
}

function buildLensColumns(data: OpsLedgerData, lens: OpsLensId): LensColumn[] {
  if (lens === 'grades') return gradeColumns(data);
  if (lens === 'losses') return wasteColumns(data);
  if (lens === 'blocks') return blockColumns(data);
  // PRODUCTION — grades then the waste streams, under two group headers. The same
  // column builders, so the three tabs can never disagree about a figure.
  return [...gradeColumns(data), ...wasteColumns(data)];
}

const PLACEHOLDER_COL: LensColumn = {
  key: '__none__',
  label: '—',
  width: 220,
  tone: 'day',
  group: '',
  value: () => null,
  hasCampaignTotal: false,
  hasGroupTotal: false,
  campaignTotal: () => null,
  groupTotal: () => null,
};

/**
 * WHY A LENS FOOTER CAN BE EMPTY, said once rather than left blank.
 *
 * Since 2026-09-15 (round 3) every lens DOES publish totals — grades from
 * `gradesByCampaign`, the eight streams from `rollups[].waste` / `group.waste`, and
 * the blocks lens from `campaign.blocks[].campaignFedKg` / `group.blocks[].groupFedKg`
 * — so this note survives only for the placeholder column of an EMPTY lens. It is kept
 * rather than deleted because the rule it states still binds: summing the visible
 * cells to fill a gap is exactly the re-derivation plan §2.7 rule 1 forbids.
 */
const NO_TOTAL_NOTE =
  'No campaign or group total is published for this lens — the totals that ARE published are in the rollup above.';

const NO_GROUP_GRADE_NOTE =
  'No GROUP total is published for these columns — grade totals are per CAMPAIGN, so read them in each campaign’s own footer row.';

// ─── THE ROW MODEL ───────────────────────────────────────────────────────────────

type LedgerRow =
  | { kind: 'band'; campaignKey: string; index: number }
  | { kind: 'day'; day: OpsLedgerDay; rowKey: string }
  | { kind: 'campaignFoot'; campaignKey: string };

/**
 * Days grouped by campaign, in the campaigns' own chronological order, each band
 * immediately before its first day.
 *
 * It groups explicitly rather than trusting the payload's row order, because the
 * band/day relationship is the thing a changeover date makes easy to get wrong: a
 * date that belongs to two campaigns appears ONCE PER CAMPAIGN, inside that
 * campaign's band, exactly as RC Movement renders it. Grouping is a reshape, not a
 * computation.
 */
function buildRows(data: OpsLedgerData, withFooters: boolean): LedgerRow[] {
  const byCampaign = new Map<string, OpsLedgerDay[]>();
  for (const d of data.days) {
    const list = byCampaign.get(d.campaignKey);
    if (list) list.push(d);
    else byCampaign.set(d.campaignKey, [d]);
  }

  const ordered = data.campaigns.map((c) => c.key).filter((k) => byCampaign.has(k));
  const known = new Set(ordered);
  // A day whose campaign never resolved is still shown, after the resolved ones —
  // dropping it would silently shrink the ledger.
  const orphans = [...byCampaign.keys()].filter((k) => !known.has(k));

  const rows: LedgerRow[] = [];
  let index = 0;
  for (const key of [...ordered, ...orphans]) {
    rows.push({ kind: 'band', campaignKey: key, index });
    for (const day of byCampaign.get(key)!) {
      rows.push({ kind: 'day', day, rowKey: `${key}:${day.date}` });
    }
    if (withFooters) rows.push({ kind: 'campaignFoot', campaignKey: key });
    index += 1;
  }
  return rows;
}

// ─── THE COMPONENT ───────────────────────────────────────────────────────────────

export interface OpsLedgerTableProps {
  data: OpsLedgerData;
  lens: OpsLensId;
  /**
   * `?ratios=` — FALSE drops YIELD % and LOSS % from the spine's coordinate space
   * (2026-09-17). WASTE and WASTE % stay: they carry no indicative caveat.
   */
  showRatios: boolean;
  /** Opens a block's detail drawer — a block column header, or a BLOCKS USED row. */
  onOpenBlock(batchId: string, batchCode: string, blockLoc: string | null): void;
  className?: string;
}

export function OpsLedgerTable({
  data,
  lens,
  showRatios,
  onOpenBlock,
  className,
}: OpsLedgerTableProps) {
  const showPrices = data.canViewPrices;
  const multi = data.rollups.length > 1;

  const rollupByKey = React.useMemo(() => {
    const m = new Map<string, OpsCampaignRollup>();
    for (const r of data.rollups) m.set(r.campaignKey, r);
    return m;
  }, [data.rollups]);

  const spineCols = React.useMemo(
    () => SPINE.filter((c) => (showPrices || !c.price) && (showRatios || !c.ratio)),
    [showPrices, showRatios],
  );
  const spineLefts = React.useMemo(() => {
    const out: number[] = [];
    let left = 0;
    for (const c of spineCols) {
      out.push(left);
      left += c.width;
    }
    return out;
  }, [spineCols]);
  const spineWidth = spineLefts.length
    ? spineLefts[spineLefts.length - 1] + spineCols[spineCols.length - 1].width
    : 0;
  const lastSpine = spineCols.length - 1;

  const builtCols = React.useMemo(() => buildLensColumns(data, lens), [data, lens]);
  const lensCols = React.useMemo(
    () => (builtCols.length > 0 ? builtCols : [PLACEHOLDER_COL]),
    [builtCols],
  );
  const lensHasColumns = builtCols.length > 0;
  const lensWidth = lensCols.reduce((s, c) => s + c.width, 0);
  const minWidth = spineWidth + lensWidth;
  /** +1 for the trailing auto-width spacer column. */
  const totalCols = spineCols.length + lensCols.length + 1;

  const spineGroups = React.useMemo(() => runs(spineCols), [spineCols]);
  const lensGroups = React.useMemo(() => runs(lensCols), [lensCols]);

  const rows = React.useMemo(() => buildRows(data, multi), [data, multi]);

  // THE FED-CELL SIDEBAR (2026-09-16). Local state, not the URL — it is a
  // disclosure inside ONE reading of one payload, the same category as the expanded
  // day and the block drawer; putting it in the address would re-run the server on
  // every click to change nothing the server computes.
  const [fedDay, setFedDay] = React.useState<OpsLedgerDay | null>(null);

  // The expanded day is keyed `campaignKey:date` — see rule 3 in the header.
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const toggle = React.useCallback((rowKey: string) => {
    setExpanded((prev) => (prev === rowKey ? null : rowKey));
  }, []);

  // ── Phone: UN-FREEZE the spine rather than hide it ──────────────────────────
  // ~900px of frozen columns on a 375px screen would leave no room at all for the
  // lens, so below the derived breakpoint (see `narrowQuery`) the spine simply
  // scrolls with everything else — one table, one horizontal scroll, nothing hidden
  // and no second layout to maintain. The HEADER stays pinned at every width.
  // `narrow` starts false on server AND client and is set in an effect, so the first
  // client render matches the server's.
  const [narrow, setNarrow] = React.useState(false);
  // The query is DERIVED from the spine that actually rendered, so turning the ₱
  // column or the OUTPUT RATIOS pair off lowers the breakpoint with it.
  const narrowMq = narrowQuery(spineWidth);
  React.useEffect(() => {
    const mq = window.matchMedia(narrowMq);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [narrowMq]);
  const frozen = !narrow;

  if (data.days.length === 0) {
    return (
      <div
        className={cn(
          'animate-fade-up m-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground',
          className,
        )}
      >
        No ledger days for this group. Pick at least one campaign above.
      </div>
    );
  }

  const groupFoot = multi ? data.group : null;
  const singleFoot = multi ? null : (data.rollups[0] ?? null);
  const anyGroupLensTotal = lensCols.some((c) => c.hasGroupTotal);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/* ONE scroll container, ONE vertical scrollbar. NEVER CRUSH, ALWAYS SCROLL —
          `minWidth` is Σ of every declared column width. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="relative table-fixed text-xs"
          style={{
            width: '100%',
            minWidth,
            // MANDATORY, not a preference — see rule 6 in the header comment.
            borderCollapse: 'separate',
            borderSpacing: 0,
          }}
        >
          <colgroup>
            {spineCols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            {lensCols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            {/* THE SPACER. `table-fixed` + `width:100%` distributes leftover width
                proportionally across the declared columns, which pulls a three-column
                lens apart into unreadable islands. An auto column at the end absorbs
                it instead. The one case the "never let a `w-auto` column absorb the
                slack" rule does not bite: it carries no content, and `minWidth` still
                forces the scrollbar when the frame is too narrow. */}
            <col />
          </colgroup>

          <thead>
            {/* ── Header row 1: the COLUMN-GROUP bands, in the semantic palette ──── */}
            <tr style={{ height: GROUP_H }}>
              {spineGroups.map((g) => (
                <th
                  key={`sg:${g.group}:${g.left}`}
                  colSpan={g.span}
                  style={frozen ? { top: 0, left: g.left } : { top: 0 }}
                  className={cn(
                    'border-t-2 border-r border-b border-border px-2 text-left text-[9px] font-semibold uppercase tracking-wider',
                    frozen ? 'frozen-corner' : 'frozen-row',
                    TONE[g.tone].head,
                    TONE[g.tone].edge,
                  )}
                >
                  {g.group}
                </th>
              ))}
              {lensGroups.map((g) => (
                <th
                  key={`lg:${g.group}:${g.left}`}
                  colSpan={g.span}
                  style={{ top: 0 }}
                  className={cn(
                    'frozen-row border-t-2 border-r border-b border-border px-2 text-left text-[9px] font-semibold uppercase tracking-wider',
                    TONE[g.tone].head,
                    TONE[g.tone].edge,
                  )}
                >
                  {g.group}
                </th>
              ))}
              <th style={{ top: 0 }} className="frozen-row border-b border-border bg-muted" />
            </tr>

            {/* ── Header row 2: the column labels, pinned under the band ─────────── */}
            <tr style={{ height: HEAD_H }}>
              {spineCols.map((c, i) => (
                <th
                  key={c.key}
                  title={c.title}
                  style={frozen ? { top: GROUP_H, left: spineLefts[i] } : { top: GROUP_H }}
                  className={cn(
                    'border-b border-border px-2 py-1 align-middle',
                    frozen ? 'frozen-corner' : 'frozen-row',
                    TONE[c.tone].head,
                    c.right ? 'text-right' : 'text-left',
                    frozen && i === lastSpine ? 'frozen-edge' : 'border-r border-border',
                  )}
                >
                  {/* ONE LINE — the unit sits on the label's own baseline (Renzo,
                      2026-09-15 round 3: *"can't those sub headers in the columns
                      (where the units are) be stored on the same line as the column
                      title… for all views in general in this page"*). The header row
                      went 40px → 26px, which is two more ledger rows on screen. */}
                  {c.label ? (
                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wide">
                      {c.label}
                      {c.sub ? (
                        <span className="ml-1 font-normal normal-case opacity-70">{c.sub}</span>
                      ) : null}
                    </span>
                  ) : null}
                </th>
              ))}
              {lensCols.map((c) => (
                <th
                  key={c.key}
                  title={
                    c.block
                      ? `Open ${c.block.batchCode}${c.block.blockLoc ? ` · ${c.block.blockLoc}` : ''}`
                      : `${c.label}${c.sub ? ` · ${c.sub}` : ''}`
                  }
                  style={{ top: GROUP_H }}
                  className={cn(
                    'frozen-row border-b border-r border-border px-2 py-1 text-right align-middle',
                    TONE[c.tone].head,
                  )}
                >
                  {c.block ? (
                    // NO SORT / FILTER CHROME on a block column — the header IS the
                    // affordance, and it opens that block, exactly as an RC Movement
                    // column header does. The block loc rides INLINE with the code, on
                    // the one header line every column now gets.
                    <button
                      type="button"
                      onClick={() => onOpenBlock(c.block!.batchId, c.block!.batchCode, c.block!.blockLoc)}
                      className="block w-full text-right underline-offset-2 transition-colors duration-150 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <span className="block truncate font-mono text-[11px] font-semibold">
                        {c.label}
                        <span className="ml-1 font-normal opacity-70">{c.sub}</span>
                      </span>
                    </button>
                  ) : (
                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wide">
                      {c.label}
                      {c.sub ? (
                        <span className="ml-1 font-normal normal-case opacity-70">{c.sub}</span>
                      ) : null}
                    </span>
                  )}
                </th>
              ))}
              <th style={{ top: GROUP_H }} className="frozen-row border-b border-border bg-muted" />
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => {
              // ── The campaign BAND ────────────────────────────────────────────
              if (r.kind === 'band') {
                const c = rollupByKey.get(r.campaignKey);
                const accent = campaignAccent(r.index);
                return (
                  <tr key={`band:${r.campaignKey}`} style={{ height: BAND_H }}>
                    <td
                      colSpan={totalCols}
                      className="border-y border-border bg-muted p-0"
                    >
                      {/* Pinned to the scrollport's left edge: under the blocks lens
                          the table can be thousands of pixels wide, and a caption
                          that scrolls off is a caption you cannot read. */}
                      <div className="sticky left-0 flex w-max items-center gap-2 px-2 py-1">
                        <span className={cn('h-3.5 w-1 shrink-0 rounded-full', accent.bar)} />
                        <span className={cn('text-[11px] font-semibold', accent.text)}>
                          {c?.label ?? r.campaignKey}
                        </span>
                        {c ? (
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {c.firstDate} → {c.lastDate} · {count(c.ledgerDays)} days ·{' '}
                            {count(c.restDays)} rest
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              }

              // ── The per-campaign FOOTER ──────────────────────────────────────
              if (r.kind === 'campaignFoot') {
                const c = rollupByKey.get(r.campaignKey);
                if (!c) return null;
                const anyCampaignLensTotal = lensCols.some((x) => x.hasCampaignTotal);
                return (
                  <tr key={`foot:${r.campaignKey}`} style={{ height: BAND_H }}>
                    {spineCols.map((col, i) => (
                      <td
                        key={col.key}
                        title={RATIO_FOOTER_TITLE[col.key]}
                        style={frozen ? { left: spineLefts[i] } : undefined}
                        className={cn(
                          'border-b border-border bg-muted px-2 py-1 font-mono text-[11px] font-semibold tabular-nums',
                          frozen && 'frozen-col',
                          col.right ? 'text-right' : 'text-left',
                          frozen && i === lastSpine ? 'frozen-edge' : 'border-r border-border',
                        )}
                      >
                        {col.campaign(c)}
                      </td>
                    ))}
                    {anyCampaignLensTotal ? (
                      <>
                        {lensCols.map((col) => (
                          <td
                            key={col.key}
                            title={col.hasCampaignTotal ? undefined : NO_TOTAL_NOTE}
                            className="border-b border-r border-border bg-muted px-2 py-1 text-right font-mono text-[11px] font-semibold tabular-nums"
                          >
                            {col.hasCampaignTotal ? col.campaignTotal(r.campaignKey) : null}
                          </td>
                        ))}
                        <td className="border-b border-border bg-muted" />
                      </>
                    ) : (
                      <td
                        colSpan={lensCols.length + 1}
                        className="border-b border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                      >
                        {lensHasColumns ? NO_TOTAL_NOTE : 'No columns in this lens.'}
                      </td>
                    )}
                  </tr>
                );
              }

              // ── A DAY ────────────────────────────────────────────────────────
              const d = r.day;
              // A DAY WITH NO SHIFT IS NOT EXPANDABLE. The expansion IS the shifts;
              // a rest day (or a day the plant was fed but filed no shift) would open
              // into nothing, so it gets no chevron rather than an empty disclosure.
              const expandable = d.shifts.length > 0;
              const open = expandable && expanded === r.rowKey;
              const frozenBg = open ? 'bg-accent' : d.isRestDay ? 'bg-muted' : 'bg-background';
              return (
                <React.Fragment key={r.rowKey}>
                  <tr
                    className={cn(
                      'group transition-all duration-150',
                      d.isRestDay && 'text-muted-foreground/70',
                    )}
                    style={{ height: ROW_H }}
                  >
                    {spineCols.map((col, i) => (
                      <td
                        key={col.key}
                        style={frozen ? { left: spineLefts[i] } : undefined}
                        className={cn(
                          'border-b border-border/60 px-2 py-1',
                          // OPAQUE, and the hover repaint is opaque too — a
                          // translucent hover would REPLACE the base and reopen the
                          // bleed-through (CLAUDE.md → "Frozen Panes").
                          frozenBg,
                          'group-hover:bg-accent',
                          frozen && 'frozen-col',
                          col.right ? 'text-right' : 'text-left',
                          col.expand && 'text-center',
                          frozen && i === lastSpine ? 'frozen-edge' : 'border-r border-border/60',
                        )}
                      >
                        {col.expand ? (
                          expandable ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? 'Collapse' : 'Expand'} ${d.date} (${d.campaignLabel}) — ${d.shifts.length} shift${d.shifts.length === 1 ? '' : 's'}`}
                              onClick={() => toggle(r.rowKey)}
                              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {open ? (
                                <ChevronDown className="size-3.5" />
                              ) : (
                                <ChevronRight className="size-3.5" />
                              )}
                            </button>
                          ) : null
                        ) : col.fedCell && fedOpenable(d) ? (
                          // THE FED CELL IS A BUTTON — the same affordance idiom as
                          // an EOQ strip cell: full-width hit area, real button
                          // semantics, a visible focus ring, and the figure itself
                          // unchanged inside it.
                          <button
                            type="button"
                            aria-haspopup="dialog"
                            title={`${d.date} · ${d.campaignLabel} — open the blocks fed and the projected profile`}
                            onClick={() => setFedDay(d)}
                            className="-mx-1 block w-[calc(100%+0.5rem)] rounded px-1 text-right transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            {col.day(d)}
                          </button>
                        ) : (
                          col.day(d)
                        )}
                      </td>
                    ))}
                    {lensCols.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'border-b border-r border-border/60 px-2 py-1 text-right',
                          // NOT frozen, so a translucent column tint is safe here.
                          TONE[col.tone].cell,
                          open && 'bg-accent/60',
                          d.isRestDay && 'bg-muted/40',
                          'group-hover:bg-accent/50',
                        )}
                      >
                        {col.value(d)}
                      </td>
                    ))}
                    <td
                      className={cn(
                        'border-b border-border/60',
                        open && 'bg-accent/60',
                        'group-hover:bg-accent/50',
                      )}
                    />
                  </tr>

                  {open
                    ? d.shifts.map((sh) => (
                        // ONE ORDINARY ROW PER SHIFT, in the SAME columns as its
                        // parent — no inner table, no second set of widths, and no
                        // second horizontal scroll. Keyed `campaignKey:date:shift`
                        // for the same reason the parent is keyed `campaignKey:date`:
                        // a changeover date belongs to two campaigns.
                        <tr
                          key={`${r.rowKey}:${sh.shiftId}`}
                          className="group/shift transition-all duration-150"
                          style={{ height: ROW_H }}
                        >
                          {spineCols.map((col, i) => (
                            <td
                              key={col.key}
                              style={frozen ? { left: spineLefts[i] } : undefined}
                              className={cn(
                                // OPAQUE, like every frozen cell — the child row's
                                // "indent" is a solid `bg-muted`, never an alpha.
                                'border-b border-border/60 bg-muted px-2 py-1',
                                'group-hover/shift:bg-accent',
                                frozen && 'frozen-col',
                                col.right ? 'text-right' : 'text-left',
                                col.expand && 'text-center',
                                frozen && i === lastSpine
                                  ? 'frozen-edge'
                                  : 'border-r border-border/60',
                              )}
                            >
                              {col.expand ? null : col.shift ? col.shift(sh) : null}
                            </td>
                          ))}
                          {lensCols.map((col) => (
                            <td
                              key={col.key}
                              className={cn(
                                'border-b border-r border-border/60 bg-muted/50 px-2 py-1 text-right',
                                'group-hover/shift:bg-accent/50',
                              )}
                            >
                              {col.shiftValue ? col.shiftValue(sh) : null}
                            </td>
                          ))}
                          <td className="border-b border-border/60 bg-muted/50 group-hover/shift:bg-accent/50" />
                        </tr>
                      ))
                    : null}
                </React.Fragment>
              );
            })}
          </tbody>

          <tfoot>
            <tr style={{ height: FOOT_H }}>
              {spineCols.map((col, i) => (
                <td
                  key={col.key}
                  title={RATIO_FOOTER_TITLE[col.key]}
                  style={frozen ? { left: spineLefts[i] } : undefined}
                  className={cn(
                    'bg-muted px-2 py-1 font-mono text-[11px] font-semibold tabular-nums',
                    frozen ? 'frozen-corner-bottom' : 'frozen-row-bottom',
                    col.right ? 'text-right' : 'text-left',
                    // ONE box-shadow property, so the two seams are composed rather
                    // than stacked — `.frozen-edge-corner` exists for exactly this.
                    frozen && i === lastSpine
                      ? 'frozen-edge-corner'
                      : 'frozen-edge-top border-r border-border',
                  )}
                >
                  {col.total(groupFoot, singleFoot)}
                </td>
              ))}
              {anyGroupLensTotal ? (
                <>
                  {lensCols.map((col) => (
                    <td
                      key={col.key}
                      title={col.hasGroupTotal ? undefined : NO_GROUP_GRADE_NOTE}
                      className="frozen-row-bottom frozen-edge-top border-r border-border bg-muted px-2 py-1 text-right font-mono text-[11px] font-semibold tabular-nums"
                    >
                      {col.hasGroupTotal ? col.groupTotal() : null}
                    </td>
                  ))}
                  <td className="frozen-row-bottom frozen-edge-top bg-muted" />
                </>
              ) : (
                <td
                  colSpan={lensCols.length + 1}
                  className="frozen-row-bottom frozen-edge-top bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                >
                  {!lensHasColumns
                    ? 'No columns in this lens.'
                    : // A lens whose columns DO have per-campaign totals but no group
                      // one says which grain is missing, rather than claiming neither
                      // exists — "no total" and "no total at THIS grain" are different.
                      lensCols.some((c) => c.hasCampaignTotal)
                      ? NO_GROUP_GRADE_NOTE
                      : NO_TOTAL_NOTE}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* THE FED-CELL SIDEBAR. Outside the scroll container, because it is a
          viewport-anchored overlay and not part of the ledger's coordinate space. */}
      <OpsFedDaySheet day={fedDay} onClose={() => setFedDay(null)} onOpenBlock={onOpenBlock} />
    </div>
  );
}

/**
 * What a FOOTER cell under a ratio column is, said where the day cells say the
 * opposite. Keyed by column so it can never end up on the wrong one.
 */
const RATIO_FOOTER_TITLE: Record<string, string | undefined> = {
  yieldpct:
    'The CAMPAIGN / GROUP yield, weighted in SQL — the real figure the indicative day cells above approximate.',
  losspct:
    'The CAMPAIGN / GROUP process loss. At these grains fed − produced genuinely IS loss; only the day cells above are indicative.',
  wastepct:
    'The CAMPAIGN / GROUP waste over produced kg — the same definition as the day cells, at a grain where the coverage is published beside it in the rollup.',
  wastekg: 'The campaign / group total of the eight recorded streams, published — never a sum of the cells above.',
};
