'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';

import { cn } from '@/lib/utils';

import { OPS_LEDGER_DATA, blocksFedBy, campaignOf, rollupOf } from '../_mock/data';
import { GRADES, WASTE_STREAMS, type LedgerDay } from '../_mock/types';
import { groupRollup } from '../_shared/aggregate';
import { COLUMN_GROUPS, type ColumnGroupId } from '../_shared/column-groups';
import { BlocksUsedTable, ShiftCards } from '../_shared/day-detail';
import { count, hours, kg, pctFromFraction, php, tons } from '../_shared/format';
import { GroupBuilder } from '../_shared/group-builder';
import { KpiStrip } from '../_shared/kpi-strip';
import { LensSwitcher } from '../_shared/lens-controls';

// ═════════════════════════════════════════════════════════════════════════════════
// DRAFT C — "SPLIT LENS".
//
// THE AXIS: what if the day spine and the lens are two PANES instead of one sheet?
//
// A and B both answer "one sheet, more columns". C answers differently: the five things you
// always want — date, day, fed, produced, yield — live in their OWN pane on the left and
// never scroll sideways, and the right pane is whichever lens you picked, scrolling
// horizontally on its own behind a divider you can drag.
//
// ── WHY THIS IS A DIFFERENT STRUCTURE, NOT A RESTYLE ────────────────────────────
//
//   • A FROZEN COLUMN CAN STILL BE PUSHED OFF SCREEN; A PANE CANNOT. With 40 block columns
//     on a 1512px screen the sticky lanes eat ~520px of a sheet that is 6,400px wide, and on
//     a laptop the operator is permanently reading five pinned columns and two data ones.
//     Here the split is a real boundary the reader OWNS — drag it to 30% and read the matrix,
//     drag it to 60% and read the ledger — and the date is never a scroll position.
//
//   • THE LENS IS A SWAP, NOT A NAVIGATION. Ledger ↔ RC Movement changes what is in the RIGHT
//     PANE and nothing else: same rows, same order, same vertical scroll offset (the two panes
//     are scroll-synced), same expanded day. That is the unification thesis made physical —
//     the two "screens" are two contents of one frame.
//
//   • THE BREAKDOWN OPENS INLINE, ACROSS BOTH PANES. B's side panel would be a third region
//     in a layout that already has two; here an expanded day pushes a full-width band in under
//     its own row, so the shift cards sit directly beneath the numbers they explain.
//
// ── WHY NOT THE BLACKWOOD TABLE HERE ────────────────────────────────────────────
// Deliberate, and the one place these drafts diverge on primitives. The grid is ONE table
// with ONE scrollport; two independently-scrolling panes over a shared row spine is a shape
// it does not have, and faking it by mounting two grids would give two carets, two selection
// rectangles and two status-bar publishers over what the reader sees as one row. A draft
// exploring whether the shape is worth having should not first pretend it already exists —
// so this is hand-built, read-only, and it keeps every rule the grid would have enforced:
// explicit widths, min-width = Σ columns, `overflow-x-auto`, opaque frozen surfaces.
// ═════════════════════════════════════════════════════════════════════════════════

const ROW_H = 32;

// Plain `<th>` here — no sort/filter chrome — so a column pays only ~17px over its label.
const W_EXPAND = 34;
const W_DATE = 96;
const W_DAY = 52;
const W_SPINE_KG = 88;
const W_SPINE_YIELD = 68;
const SPINE_WIDTH = W_EXPAND + W_DATE + W_DAY + W_SPINE_KG * 2 + W_SPINE_YIELD;

const W_LENS = 96;
const W_BLOCKCOL = 132;

const MIN_PANE = 260;

interface LensColumn {
    key: string;
    label: string;
    sub?: string;
    width: number;
    /** The column group this belongs to, so a rule is drawn at each boundary. */
    group: ColumnGroupId;
    value(day: LedgerDay): React.ReactNode;
    /** Group footer figure. */
    total(days: readonly LedgerDay[]): React.ReactNode;
    /** Hidden entirely for a viewer who may not see prices. */
    price?: boolean;
}

const mono = (text: string, extra?: string) => (
    <span className={cn('font-mono tabular-nums', extra)}>{text}</span>
);

function buildLensColumns(
    groups: readonly ColumnGroupId[],
    blocks: readonly { batchCode: string; blockLoc: string; totalKg: number }[],
): LensColumn[] {
    const on = (id: ColumnGroupId) => groups.includes(id);
    const out: LensColumn[] = [];

    if (on('costs')) {
        out.push({
            key: 'fedprice',
            label: 'FED ₱/KG',
            width: 104,
            group: 'costs',
            price: true,
            value: (d) =>
                d.fedPhpKg === null ? null : (
                    <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
                        <span className="text-muted-foreground">&#8369;</span>
                        <span>{php(d.fedPhpKg)}</span>
                    </span>
                ),
            total: (days) => {
                const fed = days.reduce((s, d) => s + d.fedKg, 0);
                const val = days.reduce((s, d) => s + d.fedKg * (d.fedPhpKg ?? 0), 0);
                return mono(fed > 0 ? php(val / fed) : '');
            },
        });
    }

    if (on('production')) {
        out.push(
            {
                key: 'losskg', label: 'TTL LOSS KG', width: 108, group: 'production',
                value: (d) => mono(kg(d.lossKg), 'text-muted-foreground'),
                total: (days) => mono(kg(days.reduce((s, d) => s + d.lossKg, 0))),
            },
            {
                key: 'shifts', label: 'TTL SHIFTS', width: W_LENS, group: 'production',
                value: (d) => (d.shifts ? mono(String(d.shifts)) : null),
                total: (days) => mono(String(days.reduce((s, d) => s + d.shifts, 0))),
            },
            {
                key: 'dthrs', label: 'TTL DT HRS', width: 104, group: 'production',
                value: (d) =>
                    d.restDay ? null : mono(hours(d.dtHours), d.dtHours > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'),
                total: (days) => mono(hours(days.reduce((s, d) => s + d.dtHours, 0))),
            },
        );
    }

    if (on('grades')) {
        for (const g of GRADES) {
            out.push({
                key: `grade:${g}`, label: g, sub: 'kg', width: 84, group: 'grades',
                value: (d) => mono(kg(d.producedByGrade[g])),
                total: (days) => mono(kg(days.reduce((s, d) => s + d.producedByGrade[g], 0))),
            });
        }
    }

    if (on('losses')) {
        for (const w of WASTE_STREAMS) {
            out.push({
                key: `waste:${w.key}`, label: w.label, sub: 'kg', width: 84, group: 'losses',
                value: (d) => mono(kg(d.waste[w.key]), 'text-muted-foreground'),
                total: (days) => mono(kg(days.reduce((s, d) => s + d.waste[w.key], 0))),
            });
        }
    }

    if (on('blocksUsed')) {
        out.push({
            key: 'blocks', label: 'BLOCKS', sub: 'drawn from', width: 100, group: 'blocksUsed',
            value: (d) => mono(count(d.blocks.length), 'text-muted-foreground'),
            total: (days) => mono(count(new Set(days.flatMap((d) => d.blocks.map((b) => b.batchCode))).size)),
        });
    }

    if (on('blocksFed')) {
        for (const b of blocks) {
            out.push({
                key: `blk:${b.batchCode}`,
                label: b.batchCode,
                sub: b.blockLoc,
                width: W_BLOCKCOL,
                group: 'blocksFed',
                value: (d) => {
                    const v = d.blocks.find((x) => x.batchCode === b.batchCode)?.fedKg ?? 0;
                    return v > 0 ? mono(kg(v)) : null;
                },
                total: () => mono(kg(b.totalKg)),
            });
        }
    }

    return out;
}

// ─── The page ────────────────────────────────────────────────────────────────────

const DEFAULT_GROUPS: ColumnGroupId[] = ['costs', 'production', 'grades', 'losses', 'blocksUsed'];

export function LedgerDraftC() {
    const data = OPS_LEDGER_DATA;
    const [groupIds, setGroupIds] = React.useState<string[]>(['JULY-2026', 'AUGUST-2026']);
    const [groupName, setGroupName] = React.useState('JULY + AUGUST');
    const [groups, setGroups] = React.useState<ColumnGroupId[]>(DEFAULT_GROUPS);
    const [expanded, setExpanded] = React.useState<string | null>(null);
    /** The divider position, as a fraction of the frame. Dragged, never animated. */
    const [split, setSplit] = React.useState(0.34);
    /**
     * BELOW 768px THE SPLIT COLLAPSES TO ONE PANE AT A TIME.
     *
     * Two side-by-side scrollports need roughly 260px each to be readable, so on a 375px
     * phone the divider would leave a 127px spine showing only a date and a lens showing one
     * column — a layout that technically renders and answers nothing. The honest degradation
     * is to keep the SPLIT as an idea and drop the SIMULTANEITY: a segmented control swaps
     * which pane is on screen, and both keep their own scroll.
     *
     * It starts `false` on both server and client and is set in an effect, so the first
     * client render matches the server's and there is no hydration mismatch.
     */
    const [narrow, setNarrow] = React.useState(false);
    const [phonePane, setPhonePane] = React.useState<'spine' | 'lens'>('spine');

    React.useEffect(() => {
        const mq = window.matchMedia('(max-width: 767px)');
        const apply = () => setNarrow(mq.matches);
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    }, []);

    const group = React.useMemo(() => groupRollup(groupIds, groupName), [groupIds, groupName]);
    const days = group.days;
    const blocks = React.useMemo(
        () => (groups.includes('blocksFed') ? blocksFedBy(days) : []),
        [groups, days],
    );
    const lensCols = React.useMemo(
        () => buildLensColumns(groups, blocks).filter((c) => data.canViewPrices || !c.price),
        [groups, blocks, data.canViewPrices],
    );

    // ── The two panes scroll VERTICALLY AS ONE ───────────────────────────────────
    //
    // Two scrollports over one row spine is the whole idea, and it only works if a wheel in
    // either pane moves both. The guard is what stops the two `onScroll` handlers writing to
    // each other forever: whichever pane the gesture STARTED in owns the frame.
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

    // ── The divider ──────────────────────────────────────────────────────────────
    const frameRef = React.useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = React.useState(false);

    const onDividerDown = React.useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setDragging(true);
    }, []);

    React.useEffect(() => {
        if (!dragging) return;
        const move = (e: PointerEvent) => {
            const frame = frameRef.current;
            if (!frame) return;
            const rect = frame.getBoundingClientRect();
            // Clamped so neither pane can be squeezed below a readable minimum — the
            // divider is "never crush, always scroll" expressed as a drag constraint.
            const raw = (e.clientX - rect.left) / rect.width;
            const min = MIN_PANE / rect.width;
            setSplit(Math.min(Math.max(raw, min), 1 - min));
        };
        const up = () => setDragging(false);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
    }, [dragging]);

    const toggle = React.useCallback((date: string) => {
        setExpanded((prev) => (prev === date ? null : date));
    }, []);

    const lensMinWidth = lensCols.reduce((s, c) => s + c.width, 0);
    /** Where each column group starts, so the 2px section rule is drawn once per boundary. */
    const ruleAt = new Set<string>();
    let prevGroup: ColumnGroupId | null = null;
    for (const c of lensCols) {
        if (c.group !== prevGroup) ruleAt.add(c.key);
        prevGroup = c.group;
    }

    /** One heading row per campaign, plus the expansion band, share this row list. */
    const rows: ({ kind: 'month'; campaignId: string } | { kind: 'day'; day: LedgerDay })[] = [];
    let prevCampaign: string | undefined;
    for (const day of days) {
        if (day.campaignId !== prevCampaign) {
            rows.push({ kind: 'month', campaignId: day.campaignId });
            prevCampaign = day.campaignId;
        }
        rows.push({ kind: 'day', day });
    }

    const expandedDay = expanded ? days.find((d) => d.date === expanded) ?? null : null;

    return (
        <main
            className={cn(
                'flex flex-col bg-background text-foreground',
                // Wide: the frame owns the viewport and the panes scroll inside it. Narrow:
                // the PAGE scrolls, because a phone cannot spare the vertical room the header
                // and the KPI strip take before a single row is visible.
                narrow ? 'min-h-dvh' : 'h-dvh overflow-hidden',
            )}
        >
            <div className="flex shrink-0 flex-col gap-3 border-b border-border px-3 py-3 sm:px-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                        href="/dev/ops-ledger"
                        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" />
                        Drafts
                    </Link>
                    <h1 className="text-sm font-semibold tracking-tight">C · Split lens</h1>
                    <p className="max-w-[70ch] text-[11px] leading-snug text-muted-foreground">
                        Explores: what if the day spine and the lens are two <em>panes</em> instead of
                        one sheet — the date pinned in its own frame, and Ledger ↔ RC Movement a swap
                        of what is on the right.
                    </p>
                </div>

                {/* CAMPAIGN CHIPS, not a popover — the group is built in the open here, so the
                    reader can see what is in and out of the quarter without opening anything.
                    The builder is still one click away for the name and the presets. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Group
                    </span>
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                        {data.campaigns.map((c) => {
                            const on = groupIds.includes(c.id);
                            const r = rollupOf(c.id);
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() =>
                                        setGroupIds((prev) =>
                                            prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                                        )
                                    }
                                    title={`${c.label} · ${c.startDate} → ${c.endDate} · ${kg(r.rcFedKg)} kg fed`}
                                    className={cn(
                                        'flex h-8 shrink-0 flex-col items-start justify-center rounded-md border px-2.5',
                                        'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        on
                                            ? 'border-foreground/30 bg-foreground text-background'
                                            : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                >
                                    <span className="whitespace-nowrap text-[11px] font-medium leading-none">
                                        {c.label}
                                    </span>
                                    <span
                                        className={cn(
                                            'whitespace-nowrap font-mono text-[9px] leading-none tabular-nums',
                                            on ? 'text-background/70' : 'text-muted-foreground/70',
                                        )}
                                    >
                                        {tons(r.rcFedKg)} t
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <GroupBuilder
                        selected={groupIds}
                        onChange={setGroupIds}
                        name={groupName}
                        onNameChange={setGroupName}
                    />
                    <div className="ml-auto">
                        <LensSwitcher groups={groups} onChange={setGroups} showHint={false} />
                    </div>
                </div>

                <KpiStrip
                    rollup={group.total}
                    canViewPrices={data.canViewPrices}
                    title={groupName || 'Untitled group'}
                    subtitle={`${group.members.length} campaign${group.members.length === 1 ? '' : 's'} · right pane: ${lensCols.length} column${lensCols.length === 1 ? '' : 's'} across ${
                        [...new Set(lensCols.map((c) => c.group))]
                            .map((g) => COLUMN_GROUPS.find((x) => x.id === g)?.label ?? g)
                            .join(' · ') || 'nothing'
                    }`}
                />
            </div>

            {/* THE SPLIT'S PHONE FORM: the same two panes, one at a time. */}
            {narrow && days.length > 0 ? (
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
                                    phonePane === pane
                                        ? 'bg-background shadow-sm'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {pane === 'spine' ? 'Day spine' : 'Lens'}
                            </button>
                        ))}
                    </div>
                    <span className="text-[10px] leading-snug text-muted-foreground">
                        Two panes need ~260px each. On a phone the split keeps its idea and drops
                        the simultaneity — both panes still share one scroll position.
                    </span>
                </div>
            ) : null}

            {days.length === 0 ? (
                <div className="animate-fade-up m-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No campaigns in this group. Tick at least one chip above.
                </div>
            ) : (
                <div
                    ref={frameRef}
                    className={cn('flex min-h-0 flex-1', dragging && 'cursor-col-resize select-none')}
                >
                    {/* ── LEFT: the day spine. Never scrolls sideways. ─────────────────── */}
                    <div
                        className={cn(
                            'flex min-w-0 flex-col border-r border-border',
                            narrow && phonePane !== 'spine' && 'hidden',
                            narrow && 'h-[70vh] w-full border-r-0',
                        )}
                        style={narrow ? undefined : { width: `${split * 100}%` }}
                    >
                        <div
                            ref={spineRef}
                            onScroll={() => syncFrom('spine')}
                            className="min-h-0 flex-1 overflow-auto"
                        >
                            <table
                                className="relative table-fixed text-xs"
                                style={{ width: '100%', minWidth: SPINE_WIDTH }}
                            >
                                <colgroup>
                                    <col width={W_EXPAND} />
                                    <col width={W_DATE} />
                                    <col width={W_DAY} />
                                    <col width={W_SPINE_KG} />
                                    <col width={W_SPINE_KG} />
                                    <col width={W_SPINE_YIELD} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        {/* Frozen header cells are OPAQUE `bg-muted` — this row sits
                                            on top of scrolling content, and any alpha bleeds. */}
                                        <th className="frozen-row h-9 bg-muted" />
                                        <Th>Date</Th>
                                        <Th>Day</Th>
                                        <Th right>Fed kg</Th>
                                        <Th right>Prod kg</Th>
                                        <Th right>Yield</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((r) =>
                                        r.kind === 'month' ? (
                                            <tr key={`m:${r.campaignId}`} style={{ height: 30 }}>
                                                <td
                                                    colSpan={6}
                                                    className="border-y border-border bg-muted px-2 py-1 text-[11px] font-semibold"
                                                >
                                                    {campaignOf(r.campaignId).label}
                                                </td>
                                            </tr>
                                        ) : (
                                            <React.Fragment key={r.day.date}>
                                                <tr
                                                    style={{ height: ROW_H }}
                                                    className={cn(
                                                        'border-b border-border/60 transition-all duration-150 hover:bg-muted/40',
                                                        expanded === r.day.date && 'bg-muted/60',
                                                        r.day.restDay && 'text-muted-foreground/70',
                                                    )}
                                                >
                                                    <td className="px-1 py-1 text-center">
                                                        {r.day.restDay ? null : (
                                                            <button
                                                                type="button"
                                                                aria-expanded={expanded === r.day.date}
                                                                aria-label={`${expanded === r.day.date ? 'Collapse' : 'Expand'} ${r.day.date}`}
                                                                onClick={() => toggle(r.day.date)}
                                                                className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                                            >
                                                                {expanded === r.day.date ? (
                                                                    <ChevronDown className="size-3.5" />
                                                                ) : (
                                                                    <ChevronRight className="size-3.5" />
                                                                )}
                                                            </button>
                                                        )}
                                                    </td>
                                                    <td className="px-2 py-1 font-mono tabular-nums">{r.day.date}</td>
                                                    <td
                                                        className={cn(
                                                            'px-2 py-1 text-muted-foreground',
                                                            r.day.day === 'Sun' && 'text-amber-600 dark:text-amber-400',
                                                        )}
                                                    >
                                                        {r.day.day}
                                                    </td>
                                                    <td className="px-2 py-1 text-right font-mono font-medium tabular-nums">
                                                        {kg(r.day.fedKg)}
                                                    </td>
                                                    <td className="px-2 py-1 text-right font-mono font-medium tabular-nums">
                                                        {kg(r.day.producedKg)}
                                                    </td>
                                                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                                                        {r.day.fedKg > 0
                                                            ? pctFromFraction(r.day.producedKg / r.day.fedKg, 1)
                                                            : ''}
                                                    </td>
                                                </tr>
                                                {/* THE EXPANSION BAND. It is rendered in BOTH panes at the
                                                    same height, so the two scrollports stay row-aligned —
                                                    that alignment is the whole contract of a split view,
                                                    and one pane growing alone would break it silently. */}
                                                {expanded === r.day.date ? (
                                                    <tr>
                                                        <td colSpan={6} className="border-b border-border bg-muted/30 p-0">
                                                            <ExpansionBand>
                                                                <ShiftCards day={r.day} canViewPrices={data.canViewPrices} />
                                                            </ExpansionBand>
                                                        </td>
                                                    </tr>
                                                ) : null}
                                            </React.Fragment>
                                        ),
                                    )}
                                </tbody>
                                <tfoot>
                                    <tr style={{ height: 34 }} className="frozen-row-bottom frozen-edge-top bg-muted">
                                        <Td />
                                        <Td className="text-[10px] font-semibold uppercase tracking-wide">
                                            {groupName || 'GROUP'}
                                        </Td>
                                        <Td className="text-[10px] text-muted-foreground">
                                            {group.total.workingDays} wd
                                        </Td>
                                        <Td right className="font-semibold">{kg(group.total.rcFedKg)}</Td>
                                        <Td right className="font-semibold">{kg(group.total.producedKg)}</Td>
                                        <Td right>{pctFromFraction(group.total.yieldPct, 1)}</Td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>

                    {/* ── THE DIVIDER ──────────────────────────────────────────────────── */}
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize the panes"
                        tabIndex={0}
                        hidden={narrow}
                        onPointerDown={onDividerDown}
                        onKeyDown={(e) => {
                            // Keyboard-operable, because a divider that only responds to a drag
                            // is a control half the operators cannot reach.
                            if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0.18, s - 0.02));
                            if (e.key === 'ArrowRight') setSplit((s) => Math.min(0.82, s + 0.02));
                        }}
                        className={cn(
                            'group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-border/40',
                            'transition-colors duration-150 hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            dragging && 'bg-border',
                        )}
                    >
                        <GripVertical className="pointer-events-none size-3 text-muted-foreground/50" />
                    </div>

                    {/* ── RIGHT: the lens. Scrolls horizontally on its own. ─────────────── */}
                    <div
                        className={cn(
                            'flex min-w-0 flex-1 flex-col',
                            narrow && phonePane !== 'lens' && 'hidden',
                            narrow && 'h-[70vh] w-full',
                        )}
                    >
                        <div
                            ref={lensRef}
                            onScroll={() => syncFrom('lens')}
                            className="min-h-0 flex-1 overflow-auto"
                        >
                            {lensCols.length === 0 ? (
                                <div className="p-6 text-xs text-muted-foreground">
                                    Every column group is switched off — the right pane has nothing to
                                    show. Pick a lens above.
                                </div>
                            ) : (
                                <table
                                    className="relative table-fixed text-xs"
                                    style={{ width: '100%', minWidth: lensMinWidth }}
                                >
                                    <colgroup>
                                        {lensCols.map((c) => (
                                            <col key={c.key} width={c.width} />
                                        ))}
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            {lensCols.map((c) => (
                                                <th
                                                    key={c.key}
                                                    title={`${c.label}${c.sub ? ` · ${c.sub}` : ''}`}
                                                    className={cn(
                                                        'frozen-row h-9 bg-muted px-2 py-1 text-right align-bottom',
                                                        ruleAt.has(c.key) && 'border-l-2 border-l-border',
                                                    )}
                                                >
                                                    <span
                                                        className={cn(
                                                            'block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
                                                            c.group === 'blocksFed' &&
                                                                'font-mono text-[11px] font-semibold normal-case tracking-normal text-foreground',
                                                        )}
                                                    >
                                                        {c.label}
                                                    </span>
                                                    {c.sub ? (
                                                        <span className="block truncate text-[9px] font-normal text-muted-foreground/70">
                                                            {c.sub}
                                                        </span>
                                                    ) : null}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r) =>
                                            r.kind === 'month' ? (
                                                <tr key={`m:${r.campaignId}`} style={{ height: 30 }}>
                                                    <td
                                                        colSpan={lensCols.length}
                                                        className="border-y border-border bg-muted px-2 py-1"
                                                    >
                                                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                                            {campaignOf(r.campaignId).startDate} →{' '}
                                                            {campaignOf(r.campaignId).endDate}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ) : (
                                                <React.Fragment key={r.day.date}>
                                                    <tr
                                                        style={{ height: ROW_H }}
                                                        className={cn(
                                                            'border-b border-border/60 transition-all duration-150 hover:bg-muted/40',
                                                            expanded === r.day.date && 'bg-muted/60',
                                                            r.day.restDay && 'text-muted-foreground/70',
                                                        )}
                                                    >
                                                        {lensCols.map((c) => (
                                                            <td
                                                                key={c.key}
                                                                className={cn(
                                                                    'px-2 py-1 text-right',
                                                                    ruleAt.has(c.key) && 'border-l-2 border-l-border',
                                                                    c.group === 'blocksFed' &&
                                                                        r.day.blocks.some(
                                                                            (b) => `blk:${b.batchCode}` === c.key,
                                                                        ) &&
                                                                        'bg-emerald-500/10',
                                                                )}
                                                            >
                                                                {c.value(r.day)}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                    {expanded === r.day.date ? (
                                                        <tr>
                                                            <td
                                                                colSpan={lensCols.length}
                                                                className="border-b border-border bg-muted/30 p-0"
                                                            >
                                                                <ExpansionBand>
                                                                    <BlocksUsedTable day={r.day} />
                                                                </ExpansionBand>
                                                            </td>
                                                        </tr>
                                                    ) : null}
                                                </React.Fragment>
                                            ),
                                        )}
                                    </tbody>
                                    <tfoot>
                                        <tr style={{ height: 34 }} className="frozen-row-bottom frozen-edge-top bg-muted">
                                            {lensCols.map((c) => (
                                                <td
                                                    key={c.key}
                                                    className={cn(
                                                        'px-2 py-1 text-right font-mono text-[11px] tabular-nums',
                                                        ruleAt.has(c.key) && 'border-l-2 border-l-border',
                                                    )}
                                                >
                                                    {c.total(days)}
                                                </td>
                                            ))}
                                        </tr>
                                    </tfoot>
                                </table>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* The canonical floating-bar glass, and `sticky bottom-0` only where the PAGE
                scrolls — a bar inside a viewport-height flex column is already at the bottom. */}
            <div
                className={cn(
                    'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground',
                    'bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60',
                    narrow && 'sticky bottom-0 z-10',
                )}
            >
                <span>
                    {narrow
                        ? `Showing the ${phonePane === 'spine' ? 'day spine' : 'lens'} pane`
                        : `Split ${Math.round(split * 100)} / ${Math.round((1 - split) * 100)} — drag the divider, or focus it and use ←/→`}
                </span>
                <span className="font-mono tabular-nums">
                    {days.length} day rows · right pane {lensMinWidth}px wide
                </span>
                {expandedDay ? (
                    <span className="font-mono tabular-nums">
                        open: {expandedDay.date} ({expandedDay.shiftDetail.length} shifts,{' '}
                        {expandedDay.blocks.length} blocks)
                    </span>
                ) : null}
            </div>
        </main>
    );
}

/**
 * The expansion band's height, and it is a CONSTANT on purpose.
 *
 * Both panes render the band for the same day, and the two scrollports only stay row-aligned
 * if the two bands are the same height. Letting each side size to its own content would
 * de-sync every row below the expanded one — the failure mode a split view has and a single
 * sheet does not, so it is designed out rather than watched for. Each side scrolls inside
 * its own band when its content is taller.
 */
const EXPANSION_H = 300;

/**
 * The band an expanded day opens into, in EITHER pane.
 *
 * Two things it does that a bare `<div>` in the `<td>` would not:
 *
 *   • **STICKY LEFT.** Under the RC Movement lens the right pane's table is ~4,100px wide,
 *     so a full-width band spreads eight blocks-used columns across four screens and the
 *     reader has to scroll sideways to read a panel that was supposed to explain the row
 *     they are looking at. Pinned to the pane's left edge, the panel stays put while the
 *     matrix behind it scrolls.
 *   • **A FIXED HEIGHT, shared by both panes.** They are two scrollports over one row spine,
 *     so a band that sized to its own content would leave every row below the expanded one
 *     misaligned between the panes — the failure mode a split view has and a single sheet
 *     does not. Each side scrolls inside its own band instead.
 */
function ExpansionBand({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="animate-fade-in sticky left-0 overflow-auto p-3"
            style={{ height: EXPANSION_H, width: 'min(880px, 100%)' }}
        >
            {children}
        </div>
    );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
    return (
        <th
            className={cn(
                'frozen-row h-9 bg-muted px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
                right ? 'text-right' : 'text-left',
            )}
        >
            {children}
        </th>
    );
}

function Td({
    children,
    right,
    className,
}: {
    children?: React.ReactNode;
    right?: boolean;
    className?: string;
}) {
    return (
        <td
            className={cn(
                'bg-muted px-2 py-1 font-mono text-[11px] tabular-nums',
                right ? 'text-right' : 'text-left',
                className,
            )}
        >
            {children}
        </td>
    );
}
