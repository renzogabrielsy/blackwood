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
    const cols = widths
        ? ordered.map((c) => {
              const w = widths[c.key];
              return w && w > 0 && c.resizable !== false ? { ...c, width: w } : c;
          })
        : ordered;

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
): ResolvedColumns<Row, Ctx> {
    const hidden = settings?.hidden;
    const order = settings?.order;
    const widths = settings?.widths;
    return React.useMemo(
        () => resolveColumns(specs, ctx, { hidden, order, widths }),
        [specs, ctx, hidden, order, widths],
    );
}
