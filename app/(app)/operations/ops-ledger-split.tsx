'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaignRollup,
  type OpsDayBlockUsed,
  type OpsLedgerData,
  type OpsLedgerDay,
} from '@/lib/operations/types';
import { count, hours, kg, php } from './ops-format';
import type { OpsLensId } from './ops-lens';
import { OpsBlocksUsedTable, OpsShiftCards } from './ops-day-detail';

// ═════════════════════════════════════════════════════════════════════════════════
// THE LEDGER — draft C, "SPLIT LENS", on the real adapter.
//
// LEFT PANE: the day spine. One row per CALENDAR DAY, rest days included and blank,
// on the campaign clock. It never scrolls sideways, because the date is the thing
// you are always reading against and a frozen column can still be pushed off screen
// while a PANE cannot.
//
// RIGHT PANE: the chosen lens — grades, the eight waste streams, or one column per
// block fed — scrolling horizontally on its own behind a divider the reader owns.
//
// The two are VERTICALLY SCROLL-SYNCED and render the identical row sequence at
// identical heights, so they read as one row however far apart the two halves are.
//
// ── FOUR RULES THIS COMPONENT IS BUILT AROUND (plan §2.7) ───────────────────────
//
//  1. **NOTHING IS COMPUTED HERE.** There is no `reduce`, no `+` and no ratio in
//     this file's render path. Every day figure is a field of `OpsLedgerDay`, every
//     campaign total a field of `OpsCampaignRollup`, every group total a field of
//     `OpsGroupRollup`. The one arithmetic left is column-width bookkeeping, which
//     is layout, not data. Where a total does NOT exist in the payload the footer
//     SAYS SO rather than inventing it — see `LensColumn.campaignTotal`.
//  2. **NULL IS NEVER 0.** A rest day renders blank cells, not a row of zeros.
//  3. **`dayDriftKg` IS NEVER CALLED LOSS.** The feed tank is continuous flow, so a
//     day's fed and produced do not describe the same charcoal. The column is DRIFT
//     and says why on hover; real loss is a campaign figure in the strip above.
//  4. **A ₱ COLUMN IS ABSENT, NOT BLANK, for a role that may not see prices.** The
//     server already nulled the field; dropping the column from the coordinate space
//     is what the RC Movement matrix does and what the frozen-offset arithmetic
//     below depends on.
//
// ── WHY IT IS NOT THE BLACKWOOD TABLE ──────────────────────────────────────────
// The grid is ONE table with ONE scrollport; two independently scrolling panes over
// a shared row spine is a shape it does not have, and mounting two grids would give
// two carets, two selection rectangles and two status-bar publishers over what the
// reader sees as one row. This is a READ-ONLY ledger with no inline editing, so the
// grid's whole value proposition is unused. It is hand-built and keeps every rule
// the grid would have enforced: explicit pixel widths, `min-width = Σ columns`
// inside `overflow-x-auto`, opaque frozen surfaces, and no row animations.
// ═════════════════════════════════════════════════════════════════════════════════

const ROW_H = 32; // Excel Standard `h-8`.
const HEAD_H = 36;
const BAND_H = 28;
const FOOT_H = 34;
/**
 * The expansion band's height, and it is a CONSTANT on purpose.
 *
 * Both panes open a band for the same day, and the two scrollports only stay
 * row-aligned if the two bands are the same height. Letting each side size to its
 * own content would de-sync every row below the expanded one — the failure mode a
 * split view has and a single sheet does not, so it is designed out rather than
 * watched for. Each side scrolls inside its own band when its content is taller.
 */
const EXPANSION_H = 320;

const W_EXPAND = 32;
const W_DATE = 92;
const W_DAY = 46;
const W_FEDPHP = 96;
const W_FEDKG = 94;
const W_PRODKG = 98;
const W_DRIFT = 92;
const W_SHIFTS = 62;
const W_DTHRS = 80;

const W_GRADE = 92;
const W_WASTE = 86;
const W_BLOCK = 128;

const MIN_LENS_PANE = 240;
const MIN_SPINE_PANE = 240;

function spineWidth(showPrices: boolean): number {
  return (
    W_EXPAND +
    W_DATE +
    W_DAY +
    (showPrices ? W_FEDPHP : 0) +
    W_FEDKG +
    W_PRODKG +
    W_DRIFT +
    W_SHIFTS +
    W_DTHRS
  );
}

// ─── The lens ────────────────────────────────────────────────────────────────────

interface LensColumn {
  key: string;
  label: string;
  sub?: string;
  width: number;
  /** Rendered as the batch code in a header button — the RC Movement gesture. */
  block?: { batchId: string; batchCode: string; blockLoc: string | null };
  value(day: OpsLedgerDay): React.ReactNode;
  /**
   * The campaign's own total for this column, **when the payload publishes one**.
   *
   * `null` is not "zero" and not "not implemented": it means the data layer does
   * not carry that total, and re-deriving it by summing the day cells is exactly
   * the bug plan §2.7 rule 1 forbids. Grades DO have a campaign total
   * (`view_ops_ledger_campaign_grades`); the waste streams and the per-block
   * columns do not, so those footers stay empty and the row says why once.
   */
  campaignTotal(campaignKey: string): React.ReactNode | null;
}

const PLACEHOLDER_COL: LensColumn = {
  key: '__none__',
  label: '—',
  width: 220,
  value: () => null,
  campaignTotal: () => null,
};

function buildLensColumns(data: OpsLedgerData, lens: OpsLensId): LensColumn[] {
  if (lens === 'grades') {
    // THE GRADE SET IS DATA. `data.grades` is the union the campaigns in view
    // actually produced, already in display order — never a hardcoded list.
    return data.grades.map((g) => ({
      key: `grade:${g}`,
      label: g,
      sub: 'kg',
      width: W_GRADE,
      value: (d) => mono(kg(d.producedByGrade[g] ?? null)),
      campaignTotal: (campaignKey) => {
        const row = data.gradesByCampaign[campaignKey]?.find((x) => x.grade === g);
        return row ? mono(kg(row.kg), 'font-semibold') : null;
      },
    }));
  }

  if (lens === 'losses') {
    return WASTE_STREAMS.map((w) => ({
      key: `waste:${w.key}`,
      label: w.label,
      sub: 'kg',
      width: W_WASTE,
      value: (d) => mono(kg(d.waste[w.key]), 'text-muted-foreground'),
      campaignTotal: () => null,
    }));
  }

  // BLOCKS FED — the RC Movement lens. The column list is the blocks the selected
  // campaigns actually drew from, in the order they were first drawn from, which is
  // a RESHAPE of the payload's own ordering, not a computation.
  const seen = new Map<string, { batchCode: string; blockLoc: string | null }>();
  for (const day of data.days) {
    for (const b of day.blocksFed) {
      if (!seen.has(b.batchId)) seen.set(b.batchId, { batchCode: b.batchCode, blockLoc: b.blockLoc });
    }
  }
  return [...seen.entries()].map(([batchId, meta]) => ({
    key: `blk:${batchId}`,
    label: meta.batchCode,
    sub: meta.blockLoc ?? '—',
    width: W_BLOCK,
    block: { batchId, batchCode: meta.batchCode, blockLoc: meta.blockLoc },
    value: (d) => {
      const cell = d.blocksFed.find((x) => x.batchId === batchId);
      return cell ? mono(kg(cell.fedKg)) : null;
    },
    campaignTotal: () => null,
  }));
}

const mono = (text: string, extra?: string) =>
  text ? <span className={cn('font-mono tabular-nums', extra)}>{text}</span> : null;

// ─── The row model, shared by both panes ─────────────────────────────────────────

type LedgerRow =
  | { kind: 'band'; campaignKey: string }
  | { kind: 'day'; day: OpsLedgerDay }
  | { kind: 'campaignFoot'; campaignKey: string };

function buildRows(days: readonly OpsLedgerDay[], withFooters: boolean): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let prev: string | null = null;
  for (const day of days) {
    if (day.campaignKey !== prev) {
      if (withFooters && prev !== null) rows.push({ kind: 'campaignFoot', campaignKey: prev });
      rows.push({ kind: 'band', campaignKey: day.campaignKey });
      prev = day.campaignKey;
    }
    rows.push({ kind: 'day', day });
  }
  if (withFooters && prev !== null) rows.push({ kind: 'campaignFoot', campaignKey: prev });
  return rows;
}

// ─── The component ───────────────────────────────────────────────────────────────

export interface OpsLedgerSplitProps {
  data: OpsLedgerData;
  lens: OpsLensId;
  /** Opens a block's detail drawer — a block column header, or a BLOCKS USED row. */
  onOpenBlock(batchId: string, batchCode: string, blockLoc: string | null): void;
  className?: string;
}

export function OpsLedgerSplit({ data, lens, onOpenBlock, className }: OpsLedgerSplitProps) {
  const showPrices = data.canViewPrices;
  const multi = data.rollups.length > 1;

  const rollupByKey = React.useMemo(() => {
    const m = new Map<string, OpsCampaignRollup>();
    for (const r of data.rollups) m.set(r.campaignKey, r);
    return m;
  }, [data.rollups]);

  const builtCols = React.useMemo(() => buildLensColumns(data, lens), [data, lens]);
  const lensCols = builtCols.length > 0 ? builtCols : [PLACEHOLDER_COL];
  const lensHasColumns = builtCols.length > 0;
  const lensMinWidth = lensCols.reduce((s, c) => s + c.width, 0);

  const rows = React.useMemo(() => buildRows(data.days, multi), [data.days, multi]);

  const [expanded, setExpanded] = React.useState<string | null>(null);
  const toggle = React.useCallback((date: string) => {
    setExpanded((prev) => (prev === date ? null : date));
  }, []);

  // ── The panes scroll VERTICALLY AS ONE ──────────────────────────────────────
  // Two scrollports over one row spine is the whole idea, and it works only if a
  // wheel in either pane moves both. The guard stops the two `onScroll` handlers
  // writing to each other forever: whichever pane the gesture started in owns the
  // frame.
  const spineRef = React.useRef<HTMLDivElement>(null);
  const lensRef = React.useRef<HTMLDivElement>(null);
  const syncing = React.useRef<'spine' | 'lens' | null>(null);

  const syncFrom = React.useCallback((source: 'spine' | 'lens') => {
    if (syncing.current && syncing.current !== source) return;
    const from = source === 'spine' ? spineRef.current : lensRef.current;
    const to = source === 'spine' ? lensRef.current : spineRef.current;
    if (!from || !to || from.scrollTop === to.scrollTop) return;
    syncing.current = source;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => {
      syncing.current = null;
    });
  }, []);

  // ── The divider ─────────────────────────────────────────────────────────────
  // Stored in PIXELS, not as a fraction of the frame — a deliberate change from the
  // draft. The spine's natural width is a known constant, so a pixel default makes
  // the pane fit it EXACTLY on the first paint and the spine genuinely never scrolls
  // sideways, which is the entire claim of this layout. A fraction only approximates
  // it, and approximates it differently on every screen.
  const naturalSpine = spineWidth(showPrices);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [spineW, setSpineW] = React.useState(naturalSpine + 10);
  const [dragging, setDragging] = React.useState(false);

  // Clamp against the real frame once it exists (and on every resize), so neither
  // pane can be squeezed below a readable minimum — "never crush, always scroll"
  // expressed as a drag constraint rather than as a scrollbar.
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = frame.getBoundingClientRect().width;
      if (w <= 0) return;
      setSpineW((prev) => Math.min(Math.max(prev, MIN_SPINE_PANE), Math.max(MIN_SPINE_PANE, w - MIN_LENS_PANE)));
    });
    ro.observe(frame);
    return () => ro.disconnect();
  }, []);

  const onDividerDown = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
  }, []);

  React.useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const raw = ev.clientX - rect.left;
      const max = Math.max(MIN_SPINE_PANE, rect.width - MIN_LENS_PANE);
      setSpineW(Math.min(Math.max(raw, MIN_SPINE_PANE), max));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  // ── Phone: the split keeps its idea and drops the simultaneity ───────────────
  // Two side-by-side scrollports need ~240px each, so on a 375px phone the divider
  // would leave a spine showing a date and a lens showing one column — a layout that
  // renders and answers nothing. A segmented control swaps which pane is on screen,
  // and both keep one shared scroll position. `narrow` starts false on server AND
  // client and is set in an effect, so the first client render matches the server's.
  const [narrow, setNarrow] = React.useState(false);
  const [phonePane, setPhonePane] = React.useState<'spine' | 'lens'>('spine');

  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const openBlockFromUsed = React.useCallback(
    (b: OpsDayBlockUsed) => onOpenBlock(b.batchId, b.batchCode, b.blockLoc),
    [onOpenBlock],
  );

  if (data.days.length === 0) {
    return (
      <div className={cn('animate-fade-up m-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground', className)}>
        No ledger days for this group. Pick at least one campaign above.
      </div>
    );
  }

  const groupFoot = data.group;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {narrow ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div
            role="tablist"
            aria-label="Pane"
            className="inline-flex items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5"
          >
            {(['spine', 'lens'] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                role="tab"
                aria-selected={phonePane === pane}
                onClick={() => setPhonePane(pane)}
                className={cn(
                  'h-7 rounded px-2.5 text-xs font-medium transition-colors duration-150',
                  phonePane === pane ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {pane === 'spine' ? 'Day spine' : 'Lens'}
              </button>
            ))}
          </div>
          <span className="text-[10px] leading-snug text-muted-foreground">
            Two panes need ~240px each — on a phone they take turns and share one scroll.
          </span>
        </div>
      ) : null}

      <div
        ref={frameRef}
        className={cn('flex min-h-0 flex-1', dragging && 'cursor-col-resize select-none')}
      >
        {/* ── LEFT: the day spine. Never scrolls sideways. ────────────────────── */}
        <div
          className={cn(
            'flex min-w-0 flex-col border-r border-border',
            !narrow && 'frozen-edge',
            narrow && phonePane !== 'spine' && 'hidden',
            narrow && 'w-full border-r-0',
          )}
          style={narrow ? undefined : { width: spineW, flex: '0 0 auto' }}
        >
          <div ref={spineRef} onScroll={() => syncFrom('spine')} className="min-h-0 flex-1 overflow-auto">
            <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth: naturalSpine }}>
              <colgroup>
                <col width={W_EXPAND} />
                <col width={W_DATE} />
                <col width={W_DAY} />
                {showPrices ? <col width={W_FEDPHP} /> : null}
                <col width={W_FEDKG} />
                <col width={W_PRODKG} />
                <col width={W_DRIFT} />
                <col width={W_SHIFTS} />
                <col width={W_DTHRS} />
                {/* THE SPACER. `table-fixed` + `width:100%` distributes any leftover
                    pane width proportionally across the declared columns, which pulls
                    a three-column lens apart into unreadable islands. An auto column
                    at the end absorbs it instead, so every data column keeps EXACTLY
                    the width it declared. It is the one case the "never rely on a
                    w-auto column to absorb leftover space" rule does not bite: it
                    carries no content, so crushing it to zero costs nothing — and the
                    table's `minWidth` is still Σ of the fixed widths, so the pane
                    scrolls rather than crushing when it is too narrow. */}
                <col />
              </colgroup>
              <thead>
                <tr style={{ height: HEAD_H }}>
                  {/* Frozen header cells are OPAQUE `bg-muted` — this row sits on top
                      of scrolling content, and any alpha bleeds through. */}
                  <th className="frozen-row bg-muted" />
                  <Th>Date</Th>
                  <Th>Day</Th>
                  {showPrices ? (
                    <Th right sub="₱/kg" title="The day's weighted-average delivered price.">
                      Fed price
                    </Th>
                  ) : null}
                  <Th right sub="kg">Ttl fed</Th>
                  <Th right sub="kg">Ttl prod</Th>
                  <Th
                    right
                    sub="kg"
                    title="Fed − produced, at DAY grain. This is DRIFT, not loss: the feed tank is continuous flow, so a day's fed and produced do not describe the same charcoal. Real loss is a campaign figure — see the strip above."
                  >
                    Drift
                  </Th>
                  <Th right>Shifts</Th>
                  <Th right sub="h">DT hrs</Th>
                  <th className="frozen-row bg-muted" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  if (r.kind === 'band') {
                    const c = rollupByKey.get(r.campaignKey);
                    return (
                      <tr key={`band:${r.campaignKey}`} style={{ height: BAND_H }}>
                        <td colSpan={showPrices ? 10 : 9} className="border-y border-border bg-muted px-2 py-1">
                          <span className="text-[11px] font-semibold">{c?.label ?? r.campaignKey}</span>
                        </td>
                      </tr>
                    );
                  }
                  if (r.kind === 'campaignFoot') {
                    const c = rollupByKey.get(r.campaignKey);
                    if (!c) return null;
                    return (
                      <tr key={`foot:${r.campaignKey}`} style={{ height: BAND_H }} className="border-y border-border bg-muted/70">
                        <FootTd />
                        <FootTd className="text-[10px] font-semibold uppercase tracking-wide">
                          {c.productionBatch}
                        </FootTd>
                        <FootTd className="text-[10px] text-muted-foreground">{count(c.activeDays)} d</FootTd>
                        {showPrices ? <FootTd right>{php(c.fedPhpKg)}</FootTd> : null}
                        <FootTd right>{kg(c.fedKg)}</FootTd>
                        <FootTd right>{kg(c.producedKg)}</FootTd>
                        <FootTd
                          right
                          title="At CAMPAIGN grain fed − produced IS loss — the retort's process loss. Only the DAY figure is drift."
                        >
                          {kg(c.processLossKg)}
                        </FootTd>
                        <FootTd right>{count(c.shiftCount)}</FootTd>
                        <FootTd right>{hours(c.downtimeHours)}</FootTd>
                        <FootTd />
                      </tr>
                    );
                  }
                  const d = r.day;
                  const open = expanded === d.date;
                  return (
                    <React.Fragment key={d.date}>
                      <tr
                        style={{ height: ROW_H }}
                        className={cn(
                          'border-b border-border/60 transition-all duration-150 hover:bg-muted/40',
                          open && 'bg-muted/60',
                          d.isRestDay && 'text-muted-foreground/70',
                        )}
                      >
                        <td className="px-1 py-1 text-center">
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={`${open ? 'Collapse' : 'Expand'} ${d.date}`}
                            onClick={() => toggle(d.date)}
                            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                          </button>
                        </td>
                        <td className="px-2 py-1 font-mono tabular-nums">{d.date}</td>
                        <td
                          className={cn(
                            'px-2 py-1 text-muted-foreground',
                            d.isWeekend && 'text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {d.weekday}
                        </td>
                        {showPrices ? (
                          <td className="px-2 py-1">
                            {d.fedPhpKg === null ? null : (
                              // ACCOUNTING FORMAT — ₱ pinned left, number pinned right.
                              <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
                                <span className="text-muted-foreground">&#8369;</span>
                                <span>{php(d.fedPhpKg)}</span>
                              </span>
                            )}
                          </td>
                        ) : null}
                        <td className="px-2 py-1 text-right font-mono font-medium tabular-nums">{kg(d.fedKg)}</td>
                        <td className="px-2 py-1 text-right font-mono font-medium tabular-nums">{kg(d.producedKg)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {kg(d.dayDriftKg)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{count(d.shiftCount)}</td>
                        <td
                          className={cn(
                            'px-2 py-1 text-right font-mono tabular-nums',
                            d.downtimeHours !== null && d.downtimeHours > 0
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-muted-foreground',
                          )}
                          title={
                            d.downtimeIncidentCount > 0
                              ? `${d.downtimeIncidentCount} shift(s) list a stoppage the plant ran THROUGH — those ranges contribute zero minutes (L-051b).`
                              : undefined
                          }
                        >
                          {hours(d.downtimeHours)}
                        </td>
                        <td />
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={showPrices ? 10 : 9} className="border-b border-border bg-muted/30 p-0">
                            <ExpansionBand>
                              <OpsShiftCards day={d} />
                              {/* On a phone only one pane is on screen, so the spine's
                                  band carries BOTH halves of the breakdown. */}
                              {narrow ? (
                                <div className="mt-3">
                                  <OpsBlocksUsedTable day={d} onOpenBlock={openBlockFromUsed} />
                                </div>
                              ) : null}
                            </ExpansionBand>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ height: FOOT_H }}>
                  <FootTd sticky />
                  <FootTd sticky className="text-[10px] font-semibold uppercase tracking-wide">
                    {multi ? 'GROUP' : (data.rollups[0]?.productionBatch ?? 'TOTAL')}
                  </FootTd>
                  <FootTd sticky className="text-[10px] text-muted-foreground">
                    {count(groupFoot?.activeDays ?? data.rollups[0]?.activeDays ?? null)} d
                  </FootTd>
                  {showPrices ? (
                    <FootTd sticky right>{php(multi ? (groupFoot?.fedPhpKg ?? null) : (data.rollups[0]?.fedPhpKg ?? null))}</FootTd>
                  ) : null}
                  <FootTd sticky right>{kg(multi ? (groupFoot?.fedKg ?? null) : (data.rollups[0]?.fedKg ?? null))}</FootTd>
                  <FootTd sticky right>{kg(multi ? (groupFoot?.producedKg ?? null) : (data.rollups[0]?.producedKg ?? null))}</FootTd>
                  <FootTd
                    sticky
                    right
                    title="At GROUP grain fed − produced IS loss — the retort's process loss, weighted in SQL. Only the DAY figure is drift."
                  >
                    {kg(multi ? (groupFoot?.processLossKg ?? null) : (data.rollups[0]?.processLossKg ?? null))}
                  </FootTd>
                  <FootTd sticky right>{count(multi ? (groupFoot?.shiftCount ?? null) : (data.rollups[0]?.shiftCount ?? null))}</FootTd>
                  <FootTd sticky right>{hours(multi ? (groupFoot?.downtimeHours ?? null) : (data.rollups[0]?.downtimeHours ?? null))}</FootTd>
                  <FootTd sticky />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* ── THE DIVIDER ─────────────────────────────────────────────────────── */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panes"
          aria-valuenow={Math.round(spineW)}
          tabIndex={0}
          hidden={narrow}
          onPointerDown={onDividerDown}
          onKeyDown={(e) => {
            // Keyboard-operable, because a divider that only answers a drag is a
            // control half the operators cannot reach.
            if (e.key === 'ArrowLeft') setSpineW((w) => Math.max(MIN_SPINE_PANE, w - 24));
            if (e.key === 'ArrowRight') setSpineW((w) => w + 24);
          }}
          className={cn(
            'relative flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-border/40',
            'transition-colors duration-150 hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            dragging && 'bg-border',
          )}
        >
          <GripVertical className="pointer-events-none size-3 text-muted-foreground/50" />
        </div>

        {/* ── RIGHT: the lens. Scrolls horizontally on its own. ────────────────── */}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            narrow && phonePane !== 'lens' && 'hidden',
            narrow && 'w-full',
          )}
        >
          <div ref={lensRef} onScroll={() => syncFrom('lens')} className="min-h-0 flex-1 overflow-auto">
            {/* NEVER CRUSH, ALWAYS SCROLL — explicit min-width equal to the sum of
                the column widths, inside this pane's own `overflow-auto`. */}
            <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth: lensMinWidth }}>
              <colgroup>
                {lensCols.map((c) => (
                  <col key={c.key} width={c.width} />
                ))}
                {/* The lens's spacer — see the spine's note above. */}
                <col />
              </colgroup>
              <thead>
                <tr style={{ height: HEAD_H }}>
                  {lensCols.map((c) => (
                    <th
                      key={c.key}
                      title={c.block ? `Open ${c.block.batchCode}${c.block.blockLoc ? ` · ${c.block.blockLoc}` : ''}` : `${c.label}${c.sub ? ` · ${c.sub}` : ''}`}
                      className="frozen-row bg-muted px-2 py-1 text-right align-bottom"
                    >
                      {c.block ? (
                        // NO SORT / FILTER CHROME on a block column — the header IS
                        // the affordance, and it opens that block, exactly as an RC
                        // Movement column header does.
                        <button
                          type="button"
                          onClick={() => onOpenBlock(c.block!.batchId, c.block!.batchCode, c.block!.blockLoc)}
                          className="block w-full text-right underline-offset-2 transition-colors duration-150 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <span className="block truncate font-mono text-[11px] font-semibold text-foreground">
                            {c.label}
                          </span>
                          <span className="block truncate text-[9px] font-normal text-muted-foreground/70">
                            {c.sub}
                          </span>
                        </button>
                      ) : (
                        <>
                          <span className="block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {c.label}
                          </span>
                          {c.sub ? (
                            <span className="block truncate text-[9px] font-normal text-muted-foreground/70">
                              {c.sub}
                            </span>
                          ) : null}
                        </>
                      )}
                    </th>
                  ))}
                  <th className="frozen-row bg-muted" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  if (r.kind === 'band') {
                    const c = rollupByKey.get(r.campaignKey);
                    return (
                      <tr key={`band:${r.campaignKey}`} style={{ height: BAND_H }}>
                        <td colSpan={lensCols.length + 1} className="border-y border-border bg-muted px-2 py-1">
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {c ? `${c.firstDate} → ${c.lastDate} · ${count(c.ledgerDays)} days` : r.campaignKey}
                          </span>
                        </td>
                      </tr>
                    );
                  }
                  if (r.kind === 'campaignFoot') {
                    const totals = lensCols.map((c) => c.campaignTotal(r.campaignKey));
                    const any = totals.some((t) => t !== null);
                    return (
                      <tr key={`foot:${r.campaignKey}`} style={{ height: BAND_H }} className="border-y border-border bg-muted/70">
                        {any ? (
                          <>
                            {lensCols.map((c, i) => (
                              <td key={c.key} className="px-2 py-1 text-right font-mono text-[11px] tabular-nums">
                                {totals[i]}
                              </td>
                            ))}
                            <td />
                          </>
                        ) : (
                          <td colSpan={lensCols.length + 1} className="px-2 py-1 text-[10px] text-muted-foreground">
                            {lensHasColumns ? NO_TOTAL_NOTE : 'No columns in this lens.'}
                          </td>
                        )}
                      </tr>
                    );
                  }
                  const d = r.day;
                  const open = expanded === d.date;
                  return (
                    <React.Fragment key={d.date}>
                      <tr
                        style={{ height: ROW_H }}
                        className={cn(
                          'border-b border-border/60 transition-all duration-150 hover:bg-muted/40',
                          open && 'bg-muted/60',
                          d.isRestDay && 'text-muted-foreground/70',
                        )}
                      >
                        {lensCols.map((c) => {
                          const v = c.value(d);
                          return (
                            <td
                              key={c.key}
                              className={cn('px-2 py-1 text-right', c.block && v !== null && 'bg-emerald-500/10')}
                            >
                              {v}
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={lensCols.length + 1} className="border-b border-border bg-muted/30 p-0">
                            <ExpansionBand>
                              <OpsBlocksUsedTable day={d} onOpenBlock={openBlockFromUsed} />
                            </ExpansionBand>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ height: FOOT_H }}>
                  <td
                    colSpan={lensCols.length + 1}
                    className="frozen-row-bottom frozen-edge-top bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                  >
                    {lensHasColumns ? NO_TOTAL_NOTE : 'No columns in this lens.'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * WHY A LENS FOOTER CAN BE EMPTY, said once rather than left blank.
 *
 * The waste streams and the per-block columns have no campaign-level or group-level
 * total in the data layer. Summing the visible cells to fill the gap is precisely
 * the re-derivation plan §2.7 rule 1 forbids — it would be a second definition of a
 * figure, computed in a component, that nothing checks. So the row says what it does
 * not have and points at the figures that ARE published.
 */
const NO_TOTAL_NOTE =
  'No campaign or group total is published for this lens — the totals that ARE published are in the strip above.';

function ExpansionBand({ children }: { children: React.ReactNode }) {
  return (
    // STICKY LEFT: under the blocks lens the right pane's table can be thousands of
    // pixels wide, so a full-width band would spread the panel across several screens
    // of horizontal scroll. Pinned to the pane's left edge it stays put while the
    // matrix behind it scrolls.
    <div className="animate-fade-in sticky left-0 overflow-auto p-3" style={{ height: EXPANSION_H, width: 'min(900px, 100%)' }}>
      {children}
    </div>
  );
}

function Th({
  children,
  right,
  sub,
  title,
}: {
  children?: React.ReactNode;
  right?: boolean;
  sub?: string;
  title?: string;
}) {
  return (
    <th
      title={title}
      className={cn('frozen-row bg-muted px-2 py-1 align-bottom', right ? 'text-right' : 'text-left')}
    >
      <span className="block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {children}
      </span>
      {sub ? (
        <span className="block truncate text-[9px] font-normal normal-case text-muted-foreground/70">
          {sub}
        </span>
      ) : null}
    </th>
  );
}

/**
 * A footer cell.
 *
 * `sticky` pins it to the bottom of the pane's scrollport — and the classes go on
 * the CELLS, never on the `<tr>`: Tailwind's preflight sets `border-collapse:
 * collapse`, under which `position: sticky` on a row is the browser-dependent form
 * and on a cell is the reliable one. The background must be a SOLID token for the
 * same reason the header's is: a pinned surface sits on top of scrolling content,
 * and any alpha lets the rows bleed through (CLAUDE.md → "Frozen Panes").
 */
function FootTd({
  children,
  right,
  className,
  title,
  sticky,
}: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
  title?: string;
  sticky?: boolean;
}) {
  return (
    <td
      title={title}
      className={cn(
        'px-2 py-1 font-mono text-[11px] font-semibold tabular-nums',
        sticky && 'frozen-row-bottom frozen-edge-top bg-muted',
        right ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}
