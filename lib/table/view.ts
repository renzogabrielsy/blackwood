// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the VIEW transform: sort and filter. PLATFORM LAYER, PURE.
//
// Renzo, after driving the ten migrated grids: *"tables don't have a universal
// filter/sort feature. Would be nice to have this for all columns on the universal
// table."* Only the consumers that had hand-built their own header menus had any, so the
// same capability existed on one screen and was absent on nine — the exact shape of
// finding the platform pass already recorded: a capability reachable only through work
// each consumer has to redo is, from the operator's chair, a capability that is missing.
//
// Everything here is a pure function over plain data, so the whole grammar can be
// asserted without a browser and the component below it holds nothing but the state.
//
// ── THE FIVE RULES, AND WHY EACH ONE IS NOT OPTIONAL ────────────────────────────
//
//   1. **It is VIEW state. It never mutates a row and never touches the URL.** The
//      consumers that already drive filters through search params keep doing exactly
//      that; this is a second, local axis that costs them nothing.
//
//   2. **A sorted view HIDES the chrome rows and the group spacers, and renders the data
//      rows flat.** A group heading, a per-group rule-off and a day total are all claims
//      about a RUN of adjacent rows, and a sort destroys the run — so keeping them would
//      leave a heading standing over rows from six other groups and a subtotal that adds
//      up to nothing on screen. There is no honest way to re-tile them without knowing
//      what they MEAN, which is precisely the tenant knowledge the platform layer may not
//      have. The same rule applies to a FILTER, for the same reason one level milder: a
//      heading over a group whose every row was filtered out is a heading over nothing.
//      Clearing the sort and the filters restores the consumer's own flatten byte for
//      byte, because the transform returns the ORIGINAL ARRAY IDENTITY when neither is on.
//
//   3. **A CHILD row is glued to its parent.** The unit of sorting is a data row plus the
//      child rows that follow it — a receipt and its moisture draws move together, and a
//      child is never sorted against its parent's peers. That is `occupies()`'s insight
//      applied to ordering: a child is not a small parent, so it has no sort key of its
//      own to be judged by.
//
//   4. **A DRAFT never sorts and never filters out.** The blank-row pool is not data: a
//      row the operator is halfway through typing must not jump to the top the moment a
//      sort is applied, and must not vanish because it does not match a filter yet.
//      Drafts are passed through untouched and appended in their original order.
//
//   5. **Blanks sort LAST in both directions.** A column of figures with holes in it is
//      the normal case, and an operator sorting descending is looking for the big
//      numbers, not for the empty cells. Ties keep their source order, so the sort is
//      stable and re-sorting the same column never reshuffles equal rows.
// ─────────────────────────────────────────────────────────────────────────────────

import type { ColumnSpec, GridRow, RowKind } from './types';

// ═══ The state a sorted, filtered view is ═══════════════════════════════════════

export type SortDirection = 'asc' | 'desc';

/** The one column a view is sorted by. `key` is the COLUMN key — what was clicked. */
export interface TableSort {
    key: string;
    dir: SortDirection;
}

/**
 * One column's filter. All three may be present; they AND together, as do the filters of
 * two different columns.
 *
 * `text` is a case-insensitive CONTAINS over the column's own text value — the same
 * string a copy would put on the clipboard, so what the operator searches for is what
 * they can see. `min` / `max` are inclusive bounds over `numericValue`, and are only
 * meaningful on a column that declares one.
 */
export interface ColumnFilter {
    text?: string;
    min?: number;
    max?: number;
}

/** Column key → its filter. A key that is absent, or inactive, filters nothing. */
export type TableFilters = Readonly<Record<string, ColumnFilter | undefined>>;

/** The shared empty map, so a table with no filters never allocates one per render. */
export const NO_FILTERS: TableFilters = Object.freeze({});

/**
 * The header affordance's cycle: **asc → desc → off**, and off is `null` rather than a
 * third direction, because "not sorted" has to restore the consumer's own row order
 * exactly rather than being a third ordering of its own.
 */
export function nextSortDirection(current: SortDirection | null | undefined): SortDirection | null {
    if (current === 'asc') return 'desc';
    if (current === 'desc') return null;
    return 'asc';
}

/**
 * Does this filter actually exclude anything?
 *
 * An empty or whitespace-only `text` is NOT a filter — an operator who opened the popover,
 * typed and then cleared it must get every row back, and a filter object left behind with
 * `text: ''` would otherwise keep the view transformed (and, under rule 2, keep the group
 * headings hidden) with nothing on screen to explain why.
 */
export function isColumnFilterActive(filter: ColumnFilter | undefined): boolean {
    if (!filter) return false;
    if (filter.text !== undefined && filter.text.trim() !== '') return true;
    return filter.min !== undefined || filter.max !== undefined;
}

/** How many columns are actually filtering. Zero ⇒ the view is untransformed. */
export function activeFilterCount(filters: TableFilters): number {
    let n = 0;
    for (const key of Object.keys(filters)) {
        if (isColumnFilterActive(filters[key])) n++;
    }
    return n;
}

// ═══ Which columns OFFER the two affordances ════════════════════════════════════

/**
 * May the operator sort by this column?
 *
 * The same shape as `columnSelectable`, and the same default: yes unless the column is a
 * pure ornament. A `derived` column carries a row ordinal or an actions cluster — sorting
 * by a row's own position in the list is a no-op dressed up as a gesture.
 */
export function columnSortable<Row, Ctx>(spec: ColumnSpec<Row, Ctx>): boolean {
    if (spec.sortable !== undefined) return spec.sortable;
    return spec.cellKind !== 'derived';
}

/** May the operator filter on this column? Same default, same reasoning. */
export function columnFilterable<Row, Ctx>(spec: ColumnSpec<Row, Ctx>): boolean {
    if (spec.filterable !== undefined) return spec.filterable;
    return spec.cellKind !== 'derived';
}

// ═══ The transform ══════════════════════════════════════════════════════════════

export interface TableViewInput<Row, Ctx> {
    /** Already FLAT — records, children, drafts and chrome rows, in the consumer's order. */
    items: readonly GridRow<Row>[];
    kinds: ReadonlyMap<string, RowKind<Row>>;
    /** The RESOLVED columns, so a column hidden for this viewer cannot be sorted by. */
    cols: readonly ColumnSpec<Row, Ctx>[];
    sort: TableSort | null;
    filters: TableFilters;
    /** Row kinds that are CHILDREN — glued beneath the parent above them (rule 3). */
    childKinds?: readonly string[];
    /** The blank-row pool's kind — never sorted, never filtered out (rule 4). */
    draftKind?: string;
    /**
     * The value the STORE holds for a cell — the same function the grid hands
     * `useTableEdits`. Consulted only where a column declares no `clipboardValue`, so a
     * column that says what a copy carries is judged by exactly that string.
     */
    storedText(rowId: string, field: string): string;
}

export interface TableView<Row> {
    /**
     * The rows to render. **Referentially IDENTICAL to `items`** when neither a sort nor a
     * filter is on, which is what makes the whole feature free for a grid that never uses
     * it: the row axis, the class cache and every memo downstream compare equal.
     */
    items: readonly GridRow<Row>[];
    sorted: boolean;
    filtered: boolean;
    /** Data rows (parents, drafts excluded) that passed every filter. */
    matched: number;
    /** Data rows (parents, drafts excluded) before any filter. */
    total: number;
}

/** What one cell contributes to a sort or a filter. Computed ONCE per row, never in a comparator. */
interface CellValue {
    num: number | null;
    text: string;
}

const NO_VALUE: CellValue = Object.freeze({ num: null, text: '' });

function rowIdOf<Row>(item: GridRow<Row>): string | null {
    return 'id' in item ? item.id : null;
}

function dataOf<Row>(item: GridRow<Row>): Row | null {
    return 'data' in item ? (item.data as Row) : null;
}

function cellValue<Row, Ctx>(
    spec: ColumnSpec<Row, Ctx>,
    kind: RowKind<Row>,
    item: GridRow<Row>,
    storedText: (rowId: string, field: string) => string,
): CellValue {
    const data = dataOf(item);
    // A row that has no cell in this lane contributes NOTHING — it is not a blank value,
    // it is the absence of one, and rule 5 sorts it last for the same reason.
    const slot = kind.occupies(spec.key, data);
    if (!slot) return NO_VALUE;

    const num = data !== null && spec.numericValue ? spec.numericValue(data) : null;
    const text =
        data !== null && spec.clipboardValue
            ? spec.clipboardValue(data)
            : storedText(rowIdOf(item) ?? '', slot.field);
    return { num, text };
}

function matchesFilter(value: CellValue, filter: ColumnFilter): boolean {
    if (filter.text !== undefined) {
        const needle = filter.text.trim().toLowerCase();
        if (needle !== '' && !value.text.toLowerCase().includes(needle)) return false;
    }
    // A bounds filter on a row with no number EXCLUDES it. "Between 10 and 20" is a claim
    // about a figure, and a row that has none does not satisfy it — reading a missing
    // number as 0 would quietly sweep every unpriced row into a `min: 0` filter.
    if (filter.min !== undefined && (value.num === null || value.num < filter.min)) return false;
    if (filter.max !== undefined && (value.num === null || value.num > filter.max)) return false;
    return true;
}

/**
 * The comparator, over values already extracted.
 *
 * `numeric: true` on the collator is deliberate: it is what makes `R-2` sort before
 * `R-10` in a text column of codes, which is the ordering an operator means every time.
 */
function compareValues(
    a: CellValue,
    b: CellValue,
    orderA: number,
    orderB: number,
    numericMode: boolean,
    dir: SortDirection,
): number {
    const aEmpty = numericMode ? a.num === null : a.text.trim() === '';
    const bEmpty = numericMode ? b.num === null : b.text.trim() === '';
    // Blanks LAST in both directions — see rule 5. Not `dir`-dependent, on purpose.
    if (aEmpty && bEmpty) return orderA - orderB;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    const d = numericMode
        ? (a.num as number) - (b.num as number)
        : a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' });
    if (d !== 0) return dir === 'asc' ? d : -d;
    // STABLE: ties keep the consumer's own order, in both directions.
    return orderA - orderB;
}

/**
 * Sort and/or filter a flat item array, obeying the five rules in the header.
 *
 * **Returns the input array itself when there is nothing to do**, which is both the
 * performance property and the correctness one: a grid that never sorts is byte-identical
 * with the same grid before this file existed.
 */
export function applyTableView<Row, Ctx>(input: TableViewInput<Row, Ctx>): TableView<Row> {
    const { items, kinds, cols, sort, filters, childKinds, draftKind, storedText } = input;

    const byKey = new Map(cols.map((c) => [c.key, c]));
    // A sort on a column that is no longer there (hidden for this viewer, removed from the
    // spec list) is simply not a sort. Nothing is thrown and nothing is reordered.
    const sortSpec = sort ? byKey.get(sort.key) : undefined;

    const active: { spec: ColumnSpec<Row, Ctx>; filter: ColumnFilter }[] = [];
    for (const spec of cols) {
        const filter = filters[spec.key];
        if (filter && isColumnFilterActive(filter)) active.push({ spec, filter });
    }

    const sorting = sortSpec !== undefined && sort !== null;
    const filtering = active.length > 0;

    // ── Partition into UNITS: a data row plus the children glued beneath it ──────
    const childSet = new Set(childKinds ?? []);
    const units: { head: GridRow<Row>; kind: RowKind<Row>; rows: GridRow<Row>[] }[] = [];
    const drafts: GridRow<Row>[] = [];
    let current: (typeof units)[number] | null = null;

    for (const item of items) {
        const kind = kinds.get(item.kind);
        // Chrome — a spacer, a heading, a rule-off. It also BREAKS the run, so a child
        // that follows one can never be glued to a parent on the far side of it.
        if (!kind || !kind.addressable) {
            current = null;
            continue;
        }
        if (draftKind !== undefined && item.kind === draftKind) {
            drafts.push(item);
            current = null;
            continue;
        }
        if (childSet.has(item.kind) && current !== null) {
            current.rows.push(item);
            continue;
        }
        current = { head: item, kind, rows: [item] };
        units.push(current);
    }

    const total = units.length;

    if (!sorting && !filtering) {
        return { items, sorted: false, filtered: false, matched: total, total };
    }

    // ── One value per unit per consulted column, extracted ONCE ─────────────────
    const consulted = new Map<string, ColumnSpec<Row, Ctx>>();
    if (sortSpec) consulted.set(sortSpec.key, sortSpec);
    for (const a of active) consulted.set(a.spec.key, a.spec);

    const values = units.map((unit) => {
        const out: Record<string, CellValue> = {};
        for (const [key, spec] of consulted) {
            out[key] = cellValue(spec, unit.kind, unit.head, storedText);
        }
        return out;
    });

    let kept: number[] = units.map((_, i) => i);
    if (filtering) {
        kept = kept.filter((i) => active.every(({ spec, filter }) => matchesFilter(values[i][spec.key], filter)));
    }

    if (sorting && sortSpec && sort) {
        const numericMode = sortSpec.numericValue !== undefined;
        const key = sortSpec.key;
        kept = [...kept].sort((a, b) =>
            compareValues(values[a][key], values[b][key], a, b, numericMode, sort.dir),
        );
    }

    const out: GridRow<Row>[] = [];
    for (const i of kept) out.push(...units[i].rows);
    // Rule 4 — the blank-row pool stays where the consumer put it, at the end.
    out.push(...drafts);

    return { items: out, sorted: sorting, filtered: filtering, matched: kept.length, total };
}
