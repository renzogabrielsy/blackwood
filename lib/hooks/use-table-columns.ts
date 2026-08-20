'use client';

import * as React from 'react';

import {
    columnOffsets,
    minTableWidth,
    pinnedCounts,
    pinnedEndOffsets,
    pinnedOffsets,
    pinnedWidth,
    summarySpans,
} from '@/lib/table';
import type { ColumnSpec, SummarySpans, TableSettings } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// useTableColumns — the column table actually rendered, and every measurement taken
// off it. PLATFORM LAYER.
//
// One hook so that the geometry can never disagree with itself. The bug class this
// closes: the sticky `left` offsets, the horizontal caret-follow, the drag auto-scroll's
// left wall and a sticky footer's bottom-left corner are FOUR consumers of the same
// question ("where does the pinned block end?"), and each used to answer it separately.
// They all read this hook's output now, so a column added, hidden, resized or reordered
// moves all four at once or none of them.
//
// Three transformations, in this order, and the order matters:
//   1. VISIBILITY — a column hidden for this viewer (a ₱ column for a role that may not
//      see prices) is ABSENT, never blanked, so the coordinate space has no unreachable
//      holes and the min-width stays honest.
//   2. ORDER — the operator's saved order, re-grouped by pin so a reorder can never move
//      a column across a pin boundary (see below).
//   3. WIDTH — the operator's saved width overrides the spec's.
// ─────────────────────────────────────────────────────────────────────────────────

export interface ResolvedColumns<Row, Ctx> {
    /** Visible columns, in display order, with saved widths applied. */
    cols: ColumnSpec<Row, Ctx>[];
    /** Cumulative `left` of every column, index-aligned with `cols`. */
    offsets: number[];
    /** How many columns are pinned at each end. */
    pinned: { start: number; end: number };
    /** `left` px for each start-pinned column. */
    pinnedLeft: number[];
    /** `right` px for each end-pinned column, in column order. */
    pinnedRight: number[];
    /** Total width of each pinned block — the walls the caret-follow measures from. */
    pinnedWidths: { start: number; end: number };
    /** The table's `min-width`: Σ widths. Never a fraction — "never crush, always scroll". */
    minWidth: number;
    /** Where each figure in a summary row sits. */
    spans: SummarySpans;
    /** Column key → index in `cols`. */
    indexByKey: Map<string, number>;
}

/**
 * Apply a saved order, then RE-GROUP by pin.
 *
 * The re-group is what makes "reorder within a pin group only" structural rather than a
 * rule someone has to remember: a saved order that moved a pinned column into the middle
 * of the sheet is corrected on read instead of being honoured. It has to be, because a
 * pinned run must stay contiguous at its end for `position: sticky` to paint it — and
 * because the pinned block's WIDTH is subtracted by the caret-follow and the drag
 * auto-scroll, so a stray pin in the middle would silently move two unrelated behaviours.
 *
 * Keys in `order` that no longer exist are ignored; columns missing from it keep their
 * spec order at the end. So a saved layout survives a column being added or removed.
 */
function applyOrder<Row, Ctx>(
    specs: readonly ColumnSpec<Row, Ctx>[],
    order: readonly string[] | undefined,
): ColumnSpec<Row, Ctx>[] {
    let out: ColumnSpec<Row, Ctx>[];

    if (!order || order.length === 0) {
        out = [...specs];
    } else {
        const byKey = new Map(specs.map((s) => [s.key, s]));
        const seen = new Set<string>();
        out = [];
        for (const key of order) {
            const spec = byKey.get(key);
            if (spec && !seen.has(key)) {
                out.push(spec);
                seen.add(key);
            }
        }
        for (const spec of specs) if (!seen.has(spec.key)) out.push(spec);
    }

    // Re-group: start-pinned, then unpinned, then end-pinned — each keeping the relative
    // order the operator chose.
    return [
        ...out.filter((c) => c.pin === 'start'),
        ...out.filter((c) => c.pin !== 'start' && c.pin !== 'end'),
        ...out.filter((c) => c.pin === 'end'),
    ];
}

/**
 * How a table decides its own width.
 *
 * `'content'` is the default and is exactly the behaviour that shipped: the table renders
 * `width: 100%` over a `minWidth` of Σ declared widths, and a consumer clamps its wrapper
 * to keep the browser from stretching it.
 *
 * `'fill'` is the fix for the measured layout bug behind that clamp. Under
 * `table-layout: fixed` a table wider than its `<col>`s scales **all** of them
 * proportionally — a declared 76px column rendered 94.703px at a 1600px container — while
 * the sticky `left` offsets come from the DECLARED widths, so on a wide monitor the frozen
 * block **overlaps itself**. The invariant that restores is: **one number describes both
 * the layout and the sticky arithmetic.** So the slack is distributed here, inside the
 * resolution, and every offset, drag wall, footer corner and min-width is then taken off
 * the widths that are actually rendered.
 */
export interface FillInput {
    /** The scrollport's inner width, in px. 0 ⇒ not measured yet; nothing is distributed. */
    containerWidth: number;
}

/**
 * Hand the container's slack to the columns that can take it.
 *
 * Three exclusions, and each one is a way the naive version is wrong:
 *
 *   • **A PINNED column never grows.** Its width is a wall the caret-follow and the drag
 *     auto-scroll both measure from, and widening the frozen block to fill a monitor
 *     hides more of the sheet underneath it, not less.
 *   • **A column the operator RESIZED never grows.** A width they dragged is an
 *     instruction, and a distribution that overrode it would make the drag look broken.
 *   • **`resizable: false` never grows.** A column that declares its width is not
 *     negotiable has said so already; a fill mode is not a licence to renegotiate.
 *
 * Proportional to the declared widths (a 200px note lane should absorb more than a 60px
 * date), and the remainder lands on the LAST candidate so **Σ is exact** — an off-by-one
 * here is a permanent 1px horizontal scrollbar.
 */
function distributeFill<Row, Ctx>(
    cols: ColumnSpec<Row, Ctx>[],
    containerWidth: number,
    widths: Record<string, number> | undefined,
): ColumnSpec<Row, Ctx>[] {
    const target = Math.floor(containerWidth);
    if (!Number.isFinite(target) || target <= 0) return cols;

    const declared = cols.reduce((sum, c) => sum + c.width, 0);
    const slack = target - declared;
    if (slack <= 0) return cols;

    const candidates: number[] = [];
    for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.pin) continue;
        if (c.resizable === false) continue;
        if (widths && (widths[c.key] ?? 0) > 0) continue;
        candidates.push(i);
    }
    if (candidates.length === 0) return cols;

    const base = candidates.reduce((sum, i) => sum + cols[i].width, 0);
    const add = new Map<number, number>();
    let given = 0;
    for (let n = 0; n < candidates.length - 1; n++) {
        const i = candidates[n];
        const share = base > 0 ? Math.round((slack * cols[i].width) / base) : Math.round(slack / candidates.length);
        add.set(i, share);
        given += share;
    }
    add.set(candidates[candidates.length - 1], slack - given);

    return cols.map((c, i) => {
        const extra = add.get(i);
        return extra !== undefined && extra > 0 ? { ...c, width: c.width + extra } : c;
    });
}

/**
 * The whole resolution, as a PURE function — visibility, then order, then widths, then
 * every measurement taken off the result.
 *
 * The hook below is `useMemo(resolveColumns)` and nothing else, deliberately: a test of
 * this function is a test of the hook, without a renderer. Writing the body twice (once
 * inside the memo, once for tests) would be a second definition of the column table,
 * which is the exact failure this module exists to prevent.
 */
export function resolveColumns<Row, Ctx>(
    specs: readonly ColumnSpec<Row, Ctx>[],
    ctx: Ctx,
    settings?: TableSettings,
    fill?: FillInput,
): ResolvedColumns<Row, Ctx> {
    const hiddenSet = new Set(settings?.hidden ?? []);
    const visible = specs.filter((s) => {
        if (s.visible && !s.visible(ctx)) return false;
        // A column that cannot be hidden stays even if a stale saved layout says so.
        if (s.hideable === false) return true;
        return !hiddenSet.has(s.key);
    });

    const ordered = applyOrder(visible, settings?.order);

    // Saved widths LAST, so a resize never changes which columns exist or where the pin
    // groups start.
    const widths = settings?.widths;
    const sized = widths
        ? ordered.map((c) => {
              const w = widths[c.key];
              return w && w > 0 && c.resizable !== false ? { ...c, width: w } : c;
          })
        : ordered;

    // FILL comes LAST, over the widths the operator's own layout produced — so a resize
    // wins over the distribution for that column, and the distribution re-spreads whatever
    // slack the resize left. Everything below is measured off the RESULT, which is the
    // whole point: the sticky offsets and the rendered widths are one number.
    const cols = fill ? distributeFill(sized, fill.containerWidth, widths) : sized;

    return {
        cols,
        offsets: columnOffsets(cols),
        pinned: pinnedCounts(cols),
        pinnedLeft: pinnedOffsets(cols),
        pinnedRight: pinnedEndOffsets(cols),
        pinnedWidths: { start: pinnedWidth(cols, 'start'), end: pinnedWidth(cols, 'end') },
        minWidth: minTableWidth(cols),
        spans: summarySpans(cols),
        indexByKey: new Map(cols.map((c, i) => [c.key, i])),
    };
}

export function useTableColumns<Row, Ctx>(
    specs: readonly ColumnSpec<Row, Ctx>[],
    ctx: Ctx,
    settings?: TableSettings,
    /**
     * `sizing: 'fill'`'s measured container width, or undefined for `'content'`.
     *
     * A PRIMITIVE rather than the `FillInput` object, so the memo below compares by `===`:
     * a fresh `{ containerWidth }` per render would re-resolve the whole column table —
     * and with it every sticky offset — on every keystroke.
     */
    fillWidth?: number,
): ResolvedColumns<Row, Ctx> {
    const hidden = settings?.hidden;
    const order = settings?.order;
    const widths = settings?.widths;
    return React.useMemo(
        () =>
            resolveColumns(
                specs,
                ctx,
                { hidden, order, widths },
                fillWidth !== undefined && fillWidth > 0 ? { containerWidth: fillWidth } : undefined,
            ),
        [specs, ctx, hidden, order, widths, fillWidth],
    );
}
