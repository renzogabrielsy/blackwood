'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
    TableVirtuoso,
    type ItemProps,
    type TableComponents,
    type TableProps,
    type TableVirtuosoHandle,
} from 'react-virtuoso';
import {
    AlertTriangle,
    Copy,
    Crosshair,
    Droplets,
    Infinity as InfinityIcon,
    Inbox,
    Loader2,
    Plus,
    Save,
    Search,
    Trash2,
    Undo2,
    X,
} from 'lucide-react';
import { format, isValid, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditInput, GridContextMenu, type GridMenuItem } from '@/components/shared/grid';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { useGridPaste } from '@/lib/hooks/use-grid-paste';
import {
    useGridKeyboardNav,
    type CoordinateId,
    type NavResolver,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { errorToast } from '@/lib/toast';
import { normalizeTypedDate, trimCellValue } from '@/lib/paste-utils';
import { cn } from '@/lib/utils';
import { parsePriceInput, parseWeightInput } from '@/lib/cenapro/rc-formula';

import { deleteDelivery, saveDeliveries, type DeliveryAnchor } from './actions';
import {
    buildColumns,
    formatDestinationCell,
    formatInt,
    formatKg,
    formatLab,
    formatPeso,
    formatRate,
    formatSupplierCell,
    frozenOffsets,
    labDecimals,
    minTableWidth,
    num,
    parseDestinationCell,
    parseSupplierCell,
    priceEditText,
    readImportFlags,
    rowIssues,
    sampleFieldFor,
    weightEditText,
    ROW_H,
    SAMPLE_ROW_H,
    type DeliveryCol,
    type DeliveryDimensions,
    type DeliveryField,
    type DeliveryPatch,
    type DeliveryRecord,
    type RcDeliverySampleRow,
    type SamplePayload,
    type SaveDeliveryInput,
} from './types';
import {
    ISSUE_HINTS,
    ISSUE_LABELS,
    ISSUE_LENSES,
    periodKey,
    periodLabel,
    parsePeriodKey,
    type DeliveryPeriod,
    type IssueLens,
    type Scope,
} from './ledger-url';
import { useDeliveriesWindow, type InitialDeliveryPage } from './use-deliveries-window';

// ═════════════════════════════════════════════════════════════════════════════════
// RC Deliveries ledger — the operators' "RC 2026" sheet as a live grid.
//
// ── Why this file owns BOTH scopes ───────────────────────────────────────────────
// Endless (virtualized, cursor-paged) and Focus (one month, day-grouped, footed) draw
// the SAME seventeen columns with the SAME cell behaviour and the SAME keyboard model.
// Only the container differs — a `TableVirtuoso` versus a plain `<table>`. Splitting
// them into two components would mean threading forty props through a shared renderer
// and would guarantee the two drift; keeping them as two containers over one set of
// closures is what keeps "Tab does the same thing here as it does there" true by
// construction.
//
// ── The keyboard coordinate space, and why it needs its own resolver ─────────────
// A receipt's moisture draws render as indented CHILD rows directly beneath it, and a
// draw is not a small receipt — it has no date, no truck, no weight, no warehouse, no
// price. It has a label and up to seven lab readings. So the two row families disagree
// about which columns they occupy:
//
//     delivery row   DATE · TRK# · SUPPLIER · SKS · WT · BD…FC · WAREHOUSE · REMARKS · PHP/KG
//     sample row              (label in the SUPPLIER lane) ·  BD…FC
//
// `createCoordinateNavResolver`'s `columnMap` is per-COLUMN, which cannot express that.
// So this grid carries its own resolver — the same answer, and for the same reason, as
// the QC ledger's. Every branch below asks one question: "is there an ADDRESSABLE cell
// that way?", and returns null (stay put) when there is not, so the selection can never
// come to rest on a cell that does not exist.
//
// ── Two columns hold arithmetic, not numbers ─────────────────────────────────────
// WT and PHP/KG show the FORMULA on focus (`=27045*88%`) and the computed value on
// blur. The engine is `lib/cenapro/rc-formula.ts`; the round-trip is `weightEditText` /
// `priceEditText` in `./types.ts`. An imported row with no stored formula gets its
// formula REBUILT from the stored parts, so it is indistinguishable from one typed this
// morning. A parse failure persists a toast and leaves the cell dirty — it never writes
// a silent zero.
//
// ── TTL PRICE is not a column this file computes ─────────────────────────────────
// It is a STORED GENERATED column (`net × ₱/kg`, exact decimal). It renders, it never
// edits, and while a row's WT or PHP/KG is dirty it renders the STALE stored figure in
// a muted "pending" state rather than a browser-computed guess. Reproducing the DB's
// arithmetic in floating-point JavaScript is precisely how a payment ledger goes wrong.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Row model ───────────────────────────────────────────────────────────────────

/** A row the keyboard can address. Non-addressable chrome is absent by construction. */
type NavRow =
    | { kind: 'delivery'; deliveryId: string }
    | { kind: 'sample'; deliveryId: string; sampleIndex: number };

type LedgerItem =
    | { kind: 'month'; key: string; label: string }
    | { kind: 'day'; key: string; label: string; count: number }
    | { kind: 'delivery'; key: string; navRow: number; rec: DeliveryRecord; num: number; monthLabel: string | null }
    | { kind: 'sample'; key: string; navRow: number; deliveryId: string; sampleIndex: number }
    | { kind: 'day-total'; key: string; netKg: number; php: number | null; dupNetKg: number; dupPhp: number };

/** Per-receipt unsaved field edits, held as the raw text the operator typed. */
type FieldEdits = Partial<Record<DeliveryField, string>>;

/** One sub-sample while it is being edited. `id` is null for a draw added in the app. */
interface SampleDraft {
    key: string;
    label: string;
    bd: string;
    moisture_pct: string;
    grit: string;
    ash: string;
    dust: string;
    vm: string;
    fc: string;
}

// ─── Summary-row treatments ──────────────────────────────────────────────────────
//
// A day total is a SUM LINE, not another entry: the accountant's rule-off — heavy top
// border, an OPAQUE `bg-muted` band matched to the frozen surfaces so every summary row
// reads as one family, semibold tabular figures, and a literal `Σ DAY TOTAL` label.
const DAY_TOTAL_CELL =
    'border-b border-border/60 border-t-2 border-t-foreground/45 bg-muted py-1 align-middle text-foreground';
/** Deliberately a much FAINTER band — a filled grey band here means "this is a sum". */
const DAY_HEADER_CELL = 'h-6 border-b border-border/40 bg-muted/25 px-2 py-1';
/** Sticky-bottom month footer. OPAQUE `bg-muted` + `.frozen-edge-top` — never glass. */
const MONTH_FOOTER_CELL = 'frozen-row-bottom frozen-edge-top bg-muted px-2 py-1 align-middle';

const dash = <span className="text-muted-foreground/40">—</span>;

const CELL_BASE = 'h-full w-full flex items-center px-2 outline-none cursor-default select-none';

// ─── Data-quality rails ──────────────────────────────────────────────────────────
//
// 22 receipts are suspected duplicates — the 2026-04-06 block is pasted twice, roughly
// ₱7M double-counted. They must be unmistakable, because they inflate every total on
// the page. The rose rail is drawn on the FIRST frozen cell (an inset left border, so
// it survives horizontal scrolling) and repeated as a badge on the supplier cell.
function railClass(kind: 'duplicate' | 'unmapped' | 'flagged' | 'none'): string {
    if (kind === 'duplicate') return 'shadow-[inset_3px_0_0_0_var(--color-rose-500)]';
    if (kind === 'unmapped') return 'shadow-[inset_3px_0_0_0_var(--color-amber-500)]';
    if (kind === 'flagged') return 'shadow-[inset_3px_0_0_0_var(--color-sky-500)]';
    return '';
}

const BADGE =
    'inline-flex items-center rounded-sm px-1 py-0 text-[9px] font-bold uppercase leading-[14px] tracking-wide';

// ─── Props ───────────────────────────────────────────────────────────────────────

export interface DeliveriesLedgerProps {
    scope: Scope;
    /** Endless only — the server-prefetched first window. */
    initialPage: InitialDeliveryPage | null;
    /** Focus only — the whole month, already ordered. */
    monthRecords: DeliveryRecord[] | null;
    anchor: DeliveryAnchor;
    period: DeliveryPeriod | null;
    monthKeys: string[];
    issue: IssueLens | null;
    query: string;
    dimensions: DeliveryDimensions;
    /** Derived SERVER-SIDE from `canViewPrices()`; the ₱ fields are already nulled. */
    canViewPrices: boolean;
    loadError: string | null;
}

export function DeliveriesLedger(props: DeliveriesLedgerProps) {
    const {
        scope,
        initialPage,
        monthRecords,
        anchor,
        period,
        monthKeys,
        issue,
        query,
        dimensions,
        canViewPrices,
        loadError,
    } = props;

    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();

    const gridRef = React.useRef<HTMLDivElement>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);

    // ── Columns + geometry ───────────────────────────────────────────────────────
    // The ₱ columns are ABSENT (not blanked) for a gated viewer, so the coordinate
    // space has no unreachable holes and the table's min-width stays honest.
    const cols = React.useMemo(() => buildColumns(canViewPrices), [canViewPrices]);
    const frozenLeft = React.useMemo(() => frozenOffsets(cols), [cols]);
    const frozenCount = frozenLeft.length;
    const minWidth = React.useMemo(() => minTableWidth(cols), [cols]);
    const lastCol = cols.length - 1;

    const supplierCodes = React.useMemo(
        () => dimensions.suppliers.map((s) => s.code ?? '').filter(Boolean),
        [dimensions.suppliers],
    );
    const destinationCodes = React.useMemo(
        () => dimensions.destinations.map((d) => d.code ?? '').filter(Boolean),
        [dimensions.destinations],
    );

    // ── The record window ────────────────────────────────────────────────────────
    const win = useDeliveriesWindow(
        initialPage ?? { records: [], hasOlder: false, hasNewer: false },
        { issue, query },
    );
    // Wrapped so the flatten/index memos below have a stable dependency — a bare
    // conditional would hand them a fresh array identity on every render.
    const records = React.useMemo(
        () => (scope === 'endless' ? win.records : (monthRecords ?? [])),
        [scope, win.records, monthRecords],
    );

    const recordsById = React.useMemo(() => {
        const m = new Map<string, DeliveryRecord>();
        for (const r of records) m.set(r.row.id ?? '', r);
        return m;
    }, [records]);

    // ── Unsaved work ─────────────────────────────────────────────────────────────
    const [edits, setEdits] = React.useState<Record<string, FieldEdits>>({});
    const [sampleDrafts, setSampleDrafts] = React.useState<Record<string, SampleDraft[]>>({});
    const [invalidCells, setInvalidCells] = React.useState<Set<string>>(new Set());
    const [saving, setSaving] = React.useState(false);
    const [deleteTarget, setDeleteTarget] = React.useState<DeliveryRecord | null>(null);

    const dirtyIds = React.useMemo(() => {
        const s = new Set<string>();
        for (const [id, e] of Object.entries(edits)) if (Object.keys(e).length > 0) s.add(id);
        for (const id of Object.keys(sampleDrafts)) s.add(id);
        return s;
    }, [edits, sampleDrafts]);
    const dirtyCount = dirtyIds.size;

    /** The live sample list for a receipt — the unsaved draft if there is one. */
    const samplesOf = React.useCallback(
        (id: string): SampleDraft[] => sampleDrafts[id] ?? toDrafts(recordsById.get(id)?.samples ?? []),
        [sampleDrafts, recordsById],
    );

    // ═══ Flatten to the render list + the nav row axis ═══════════════════════════
    //
    // `items` is what the container renders; `navRows` is the keyboard's row axis. Day
    // headers, `Σ DAY TOTAL` rows, month markers and the frozen footer are ABSENT from
    // `navRows` by construction, which is exactly why Tab and the arrows can never land
    // on one.
    const { items, navRows, monthTotals } = React.useMemo(
        () => flatten(records, samplesOf, scope),
        [records, samplesOf, scope],
    );

    // ═══ The nav resolver ════════════════════════════════════════════════════════
    const addressable = React.useCallback(
        (row: number, col: number): boolean => {
            if (row < 0 || row >= navRows.length) return false;
            if (col < 0 || col > lastCol) return false;
            const field = cols[col].field;
            if (field === null) return false;
            const nav = navRows[row];
            if (nav.kind === 'delivery') return true;
            return sampleFieldFor(field) !== null;
        },
        [navRows, cols, lastCol],
    );

    const resolver = React.useMemo<NavResolver<CoordinateId>>(
        () => createDeliveryNavResolver({ rowCount: navRows.length, lastCol, addressable }),
        [navRows.length, lastCol, addressable],
    );

    const [rawActiveCell, setActiveCellState] = React.useState<CoordinateId | null>(null);

    // Clamped at READ time rather than reconciled in an effect: a page load, a lens
    // change or a deleted receipt can shrink the row axis under the selection, and an
    // effect would let one render paint with a selection pointing past the end.
    const activeCell = rawActiveCell && rawActiveCell.row < navRows.length ? rawActiveCell : null;

    // ═══ Cell text — the ONE place display/edit/dirty are reconciled ═════════════

    /** What the cell shows when it takes FOCUS (the formula, for the two formula cells). */
    const getCellText = React.useCallback(
        (id: CoordinateId): string => {
            const nav = navRows[id.row];
            if (!nav) return '';
            const field = cols[id.col].field;
            if (field === null) return '';

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(field);
                if (!sf) return '';
                const draft = samplesOf(nav.deliveryId)[nav.sampleIndex];
                return draft ? draft[sf] : '';
            }

            const pending = edits[nav.deliveryId]?.[field];
            if (pending !== undefined) return pending;

            const rec = recordsById.get(nav.deliveryId);
            if (!rec) return '';
            return canonicalEditText(rec, field);
        },
        [navRows, cols, edits, recordsById, samplesOf],
    );

    const setCellText = React.useCallback(
        (id: CoordinateId, value: string) => {
            const nav = navRows[id.row];
            if (!nav) return;
            const field = cols[id.col].field;
            if (field === null) return;

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(field);
                if (!sf) return;
                const deliveryId = nav.deliveryId;
                const index = nav.sampleIndex;
                setSampleDrafts((prev) => {
                    const list = prev[deliveryId] ?? toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                    const next = list.map((d, i) => (i === index ? { ...d, [sf]: value } : d));
                    return { ...prev, [deliveryId]: next };
                });
                return;
            }

            setEdits((prev) => ({
                ...prev,
                [nav.deliveryId]: { ...(prev[nav.deliveryId] ?? {}), [field]: value },
            }));
        },
        [navRows, cols, recordsById],
    );

    // ═══ Commit-time validation ══════════════════════════════════════════════════
    //
    // The four cells that hold something other than a plain number are checked the
    // moment the operator leaves them, so a mistake is caught while the context is still
    // on screen. The SAVE re-runs the exact same checks (it has to — it builds the
    // patch), so this is an early warning, never the only gate.
    const markInvalid = React.useCallback((id: CoordinateId, bad: boolean) => {
        setInvalidCells((prev) => {
            const key = `${id.row}:${id.col}`;
            if (bad === prev.has(key)) return prev;
            const next = new Set(prev);
            if (bad) next.add(key);
            else next.delete(key);
            return next;
        });
    }, []);

    const validateOnCommit = React.useCallback(
        (id: CoordinateId) => {
            const nav = navRows[id.row];
            if (!nav || nav.kind !== 'delivery') return;
            const field = cols[id.col].field;
            if (field === null) return;
            const text = getCellText(id).trim();
            const rec = recordsById.get(nav.deliveryId);
            const label = rec ? rowLabel(rec) : 'this receipt';

            if (field === 'wt') {
                if (!text) return markInvalid(id, false);
                const parsed = parseWeightInput(text);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`WT on ${label} could not be read: ${parsed.error}`, {
                        description: `You typed: ${text}\n\nThe cell keeps your text — nothing was written. Excel arithmetic works here: =27045*88% stores the 27,045 kg scale reading and the 12% deduction.`,
                    });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'price') {
                if (!text) return markInvalid(id, false);
                const parsed = parsePriceInput(text);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`PHP/KG on ${label} could not be read: ${parsed.error}`, {
                        description: `You typed: ${text}\n\nThe cell keeps your text — nothing was written. Excel arithmetic works here: =39.5+2.7 stores the 39.50 base and the 2.70 add-on.`,
                    });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'supplier') {
                if (!text) return markInvalid(id, false);
                const parsed = parseSupplierCell(text, supplierCodes);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`Supplier on ${label} is not recognised.`, { description: parsed.error });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'destination') {
                if (!text) return markInvalid(id, false);
                const parsed = parseDestinationCell(text, destinationCodes);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`Warehouse on ${label} is not recognised.`, { description: parsed.error });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'delivery_date') return markInvalid(id, false);
        },
        [navRows, cols, getCellText, recordsById, supplierCodes, destinationCodes, markInvalid],
    );

    // ═══ Edit session + keyboard ═════════════════════════════════════════════════
    const activeRef = React.useRef<CoordinateId | null>(null);
    activeRef.current = activeCell;

    const edit = useGridEditSession<CoordinateId>({
        getValue: getCellText,
        setValue: setCellText,
        onAfterCommit: () => {
            const id = activeRef.current;
            if (id) validateOnCommit(id);
        },
    });

    const firstItemIndexRef = React.useRef(win.firstItemIndex);
    firstItemIndexRef.current = win.firstItemIndex;

    const scrollTo = React.useCallback(
        (row: number) => {
            if (scope !== 'endless') return;
            const nav = navRows[row];
            if (!nav) return;
            const index = items.findIndex(
                (it) =>
                    (it.kind === 'delivery' || it.kind === 'sample') && it.navRow === row,
            );
            // `firstItemIndex` shifts virtuoso's public index space on every prepend, so
            // the array position has to be rebased before it can be scrolled to.
            if (index >= 0) {
                virtuosoRef.current?.scrollIntoView({ index: firstItemIndexRef.current + index, behavior: 'auto' });
            }
        },
        [scope, navRows, items],
    );

    const setActiveCell = React.useCallback((id: CoordinateId | null) => {
        setActiveCellState(id);
    }, []);

    const { handleKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing: edit.isEditing,
        resolver,
        edit: {
            start: (id, char) => {
                // The date cell is a native picker, not a text editor — nav lands on it,
                // typing does not mount an input over it.
                if (cols[id.col].field === 'delivery_date') return;
                edit.startEditing(id, char);
            },
            revert: edit.revertChanges,
            commit: edit.commit,
        },
        onAfterMove: (id) => {
            scrollTo(id.row);
            gridRef.current?.focus();
        },
        // Tab-then-Enter returns to the run's lane — the Excel habit, and this sheet is
        // entered row-by-row across the lab columns, which is exactly the run it helps.
        enableEnterAnchor: true,
    });

    // ═══ Paste ═══════════════════════════════════════════════════════════════════
    //
    // The shared TSV paste, bridged to this grid's edit MAP. The hook thinks in rows; a
    // thin `setRows` adapter turns the array it produces back into per-receipt edits,
    // dropping any cell the paste landed on that is not addressable on that row — so a
    // block pasted across a receipt and its sub-samples writes only where a cell exists,
    // by the same rule the keyboard uses.
    const pasteRowsRef = React.useRef<PasteRow[]>([]);
    pasteRowsRef.current = React.useMemo(
        () => navRows.map((_, r) => readPasteRow(r, cols, getCellText)),
        [navRows, cols, getCellText],
    );

    const applyPaste = React.useCallback<React.Dispatch<React.SetStateAction<PasteRow[]>>>(
        (update) => {
            const before = pasteRowsRef.current;
            const after = typeof update === 'function' ? update(before) : update;
            let written = 0;
            for (let r = 0; r < Math.min(after.length, navRows.length); r++) {
                const row = after[r];
                for (let c = 0; c <= lastCol; c++) {
                    const field = cols[c].field;
                    if (field === null) continue;
                    const key = pasteKey(c);
                    const next = row[key];
                    if (next === undefined || next === before[r]?.[key]) continue;
                    if (!addressable(r, c)) continue;
                    setCellText({ row: r, col: c }, next);
                    written++;
                }
            }
            if (written === 0) toast.info('Nothing pasted — that block lands outside the editable cells.');
        },
        [navRows.length, cols, lastCol, addressable, setCellText],
    );

    const pasteColumnMap = React.useMemo(
        () => cols.map((c, i) => (c.field === null ? null : (pasteKey(i) as keyof PasteRow))),
        [cols],
    );
    /** Which synthetic paste keys are the DATE lane — the one column that needs
     *  Excel-style shorthand transcription (`6/2` → `yyyy-MM-dd`). */
    const dateKeys = React.useMemo(
        () => new Set(cols.map((c, i) => (c.field === 'delivery_date' ? pasteKey(i) : '')).filter(Boolean)),
        [cols],
    );

    const { handleGridPaste } = useGridPaste<PasteRow>({
        columnMap: pasteColumnMap,
        setRows: applyPaste,
        createEmptyRow: () => ({}),
        cleanCellValue: (raw, key) => {
            const trimmed = trimCellValue(raw);
            return dateKeys.has(String(key))
                ? normalizeTypedDate(trimmed, new Date().getFullYear())
                : trimmed;
        },
    });

    // ═══ Context menu ════════════════════════════════════════════════════════════
    const menu = useGridContextMenu<MenuRef>({ width: 232, height: 220 });

    const addSample = React.useCallback(
        (deliveryId: string, afterIndex?: number) => {
            setSampleDrafts((prev) => {
                const list = prev[deliveryId] ?? toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                const blank: SampleDraft = {
                    key: `new-${Math.random().toString(36).slice(2, 10)}`,
                    label: `#${list.length + 1}`,
                    bd: '', moisture_pct: '', grit: '', ash: '', dust: '', vm: '', fc: '',
                };
                const at = afterIndex === undefined ? list.length : afterIndex + 1;
                return { ...prev, [deliveryId]: [...list.slice(0, at), blank, ...list.slice(at)] };
            });
        },
        [recordsById],
    );

    const removeSample = React.useCallback(
        (deliveryId: string, index: number) => {
            setSampleDrafts((prev) => {
                const list = prev[deliveryId] ?? toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                return { ...prev, [deliveryId]: list.filter((_, i) => i !== index) };
            });
        },
        [recordsById],
    );

    /**
     * Fill the receipt's official MOIST from its draws' average. Offered, never
     * automatic: the receipt's own reading is the number the lab signed off, and a
     * six-draw mean is a different measurement with a different meaning.
     */
    const fillMoistureFromSamples = React.useCallback(
        (deliveryId: string) => {
            const rec = recordsById.get(deliveryId);
            const avg = num(rec?.row.sample_avg_moisture_pct);
            if (avg === null) {
                errorToast('That receipt has no moisture draws to average.');
                return;
            }
            setEdits((prev) => ({
                ...prev,
                [deliveryId]: { ...(prev[deliveryId] ?? {}), moisture_pct: avg.toFixed(2) },
            }));
            toast.success(`MOIST set to the ${rec?.row.sample_count ?? 0}-draw average (${avg.toFixed(2)}%)`);
        },
        [recordsById],
    );

    const revertRow = React.useCallback((deliveryId: string) => {
        setEdits((prev) => {
            const next = { ...prev };
            delete next[deliveryId];
            return next;
        });
        setSampleDrafts((prev) => {
            const next = { ...prev };
            delete next[deliveryId];
            return next;
        });
        setInvalidCells(new Set());
    }, []);

    const copyRow = React.useCallback(
        (deliveryId: string) => {
            const rec = recordsById.get(deliveryId);
            if (!rec) return;
            const tsv = cols
                .filter((c) => c.field !== null)
                .map((c) => displayText(rec, c.field!, canViewPrices))
                .join('\t');
            void navigator.clipboard.writeText(tsv).then(() => toast.success('Row copied as TSV'));
        },
        [recordsById, cols, canViewPrices],
    );

    const menuItems = React.useMemo<GridMenuItem<MenuRef>[]>(
        () => [
            {
                kind: 'item',
                label: 'Add moisture draw',
                icon: Plus,
                onSelect: (ref) => addSample(ref.deliveryId, ref.sampleIndex),
            },
            {
                kind: 'item',
                label: 'Remove this draw',
                icon: Trash2,
                variant: 'destructive',
                hidden: (ref) => ref.sampleIndex === undefined,
                onSelect: (ref) => {
                    if (ref.sampleIndex !== undefined) removeSample(ref.deliveryId, ref.sampleIndex);
                },
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: (ref) => `Fill MOIST from ${ref.sampleCount} draw${ref.sampleCount === 1 ? '' : 's'}`,
                icon: Droplets,
                disabled: (ref) => ref.sampleCount === 0,
                onSelect: (ref) => fillMoistureFromSamples(ref.deliveryId),
            },
            { kind: 'item', label: 'Copy row as TSV', icon: Copy, onSelect: (ref) => copyRow(ref.deliveryId) },
            {
                kind: 'item',
                label: 'Discard changes on this row',
                icon: Undo2,
                disabled: (ref) => !dirtyIds.has(ref.deliveryId),
                onSelect: (ref) => revertRow(ref.deliveryId),
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: 'Delete receipt…',
                icon: Trash2,
                variant: 'destructive',
                onSelect: (ref) => {
                    const rec = recordsById.get(ref.deliveryId);
                    if (rec) setDeleteTarget(rec);
                },
            },
        ],
        [addSample, removeSample, fillMoistureFromSamples, copyRow, revertRow, dirtyIds, recordsById],
    );

    // ═══ Save ════════════════════════════════════════════════════════════════════
    //
    // Every dirty receipt is validated FIRST, and a single bad cell blocks the WHOLE
    // batch. Half-committing a sheet an operator is midway through is worse than
    // refusing it: they would have to work out which rows landed. The toast names every
    // offending receipt so the fix list is on screen, not in the console.
    const handleSave = React.useCallback(async () => {
        if (dirtyCount === 0 || saving) return;

        const inputs: SaveDeliveryInput[] = [];
        const problems: string[] = [];

        for (const id of dirtyIds) {
            const rec = recordsById.get(id);
            if (!rec) continue;
            const label = rowLabel(rec);
            const version = rec.row.row_version;
            if (version === null || version === undefined) {
                problems.push(`${label}: the row is missing its version token — reload before editing.`);
                continue;
            }

            const built = buildPatch(edits[id] ?? {}, supplierCodes, destinationCodes, canViewPrices);
            if (built.errors.length > 0) {
                for (const e of built.errors) problems.push(`${label}: ${e}`);
                continue;
            }

            const drafts = sampleDrafts[id];
            const samples = drafts ? toSamplePayload(drafts) : undefined;

            if (Object.keys(built.patch).length === 0 && !samples) continue;
            inputs.push({ id, expectedRowVersion: version, patch: built.patch, samples, label });
        }

        if (problems.length > 0) {
            errorToast(
                `${problems.length} change${problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: problems.join('\n') },
            );
            return;
        }
        if (inputs.length === 0) {
            toast.info('Nothing to save.');
            return;
        }

        setSaving(true);
        try {
            const result = await saveDeliveries(inputs);
            const failed = result.results.filter((r) => !r.ok);
            const saved = result.results.filter((r) => r.ok).map((r) => r.id);

            if (saved.length > 0) {
                setEdits((prev) => {
                    const next = { ...prev };
                    for (const id of saved) delete next[id];
                    return next;
                });
                setSampleDrafts((prev) => {
                    const next = { ...prev };
                    for (const id of saved) delete next[id];
                    return next;
                });
                setInvalidCells(new Set());
            }

            if (failed.length > 0) {
                errorToast(
                    `${failed.length} receipt${failed.length === 1 ? '' : 's'} did not save.`,
                    {
                        description: failed
                            .map((f) => `${f.label} — ${f.outcome}: ${f.message ?? 'no detail returned'}`)
                            .join('\n'),
                    },
                );
            }
            if (result.savedCount > 0) {
                toast.success(`Saved ${result.savedCount} receipt${result.savedCount === 1 ? '' : 's'}`);
                if (scope === 'endless') await win.refreshWindow();
                else startTransition(() => router.refresh());
            }
        } finally {
            setSaving(false);
        }
    }, [
        dirtyCount, dirtyIds, saving, recordsById, edits, sampleDrafts,
        supplierCodes, destinationCodes, canViewPrices, scope, win, router,
    ]);

    const handleDelete = React.useCallback(async () => {
        const target = deleteTarget;
        if (!target) return;
        setDeleteTarget(null);
        const id = target.row.id ?? '';
        const version = target.row.row_version;
        if (!id || version === null || version === undefined) {
            errorToast('That receipt is missing its id or version token — reload the ledger.');
            return;
        }
        const result = await deleteDelivery(id, version);
        if (!result.ok) {
            errorToast(`Could not delete ${rowLabel(target)} (${result.outcome}).`, {
                description: result.message ?? 'No detail returned by the database.',
            });
            return;
        }
        toast.success(
            `Deleted ${rowLabel(target)}${result.samplesDeleted > 0 ? ` and ${result.samplesDeleted} draw${result.samplesDeleted === 1 ? '' : 's'}` : ''}`,
        );
        revertRow(id);
        if (scope === 'endless') win.dropRecord(id);
        else startTransition(() => router.refresh());
    }, [deleteTarget, scope, win, router, revertRow]);

    // ═══ URL axis writers ════════════════════════════════════════════════════════
    const writeParams = React.useCallback(
        (mutate: (sp: URLSearchParams) => void) => {
            const sp = new URLSearchParams(searchParams.toString());
            mutate(sp);
            const qs = sp.toString();
            startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
        },
        [searchParams, router, pathname],
    );

    const setScope = (next: Scope) =>
        writeParams((sp) => {
            if (next === 'endless') sp.delete('scope');
            else sp.set('scope', next);
        });

    const setIssue = (next: IssueLens | null) =>
        writeParams((sp) => {
            if (next === null) sp.delete('issue');
            else sp.set('issue', next);
        });

    const setPeriodParam = (key: string) =>
        writeParams((sp) => {
            const p = parsePeriodKey(key);
            if (!p) return;
            sp.set('year', String(p.year));
            sp.set('month', String(p.month));
        });

    // ── Search box: local state, committed on Enter/blur (a URL write per keystroke
    //    would be a server round-trip per keystroke). ────────────────────────────────
    // Seeded once: a committed search changes the URL, which changes the axes key, which
    // REMOUNTS this component — so there is nothing to sync back afterwards.
    const [searchText, setSearchText] = React.useState(query);
    const commitSearch = () =>
        writeParams((sp) => {
            const v = searchText.trim();
            if (v) sp.set('q', v);
            else sp.delete('q');
        });

    // ═══ Cell rendering ══════════════════════════════════════════════════════════

    const renderEditor = (id: CoordinateId, align: 'left' | 'right') => (
        <EditInput
            autoFocus
            value={getCellText(id)}
            onChange={(v) => setCellText(id, v)}
            onCommit={edit.commit}
            onEscape={edit.revertChanges}
            align={align}
            valueClass="text-xs"
        />
    );

    /** One `<td>`. `navRow` is -1 for chrome rows, which are never addressable. */
    const renderCell = (
        col: DeliveryCol,
        colIndex: number,
        navRow: number,
        body: React.ReactNode,
        opts: { rail?: string; tint?: string; title?: string; muted?: boolean } = {},
    ) => {
        const isFrozen = colIndex < frozenCount;
        const isActive = activeCell?.row === navRow && activeCell?.col === colIndex;
        const isEditingThis = isActive && edit.isEditing;
        const canEdit = navRow >= 0 && addressable(navRow, colIndex);
        const invalid = invalidCells.has(`${navRow}:${colIndex}`);

        return (
            <td
                key={col.key}
                className={cn(
                    'border-r border-border/30 p-0 align-middle',
                    // Frozen cells repaint OPAQUELY — a solid theme token, never glass —
                    // because they sit ON TOP of scrolling content. Any alpha and the
                    // moving cells bleed through them.
                    isFrozen && 'frozen-col bg-background group-hover:bg-muted',
                    isFrozen && colIndex === frozenCount - 1 && 'frozen-edge',
                    opts.tint,
                    opts.rail,
                )}
                style={isFrozen ? { left: frozenLeft[colIndex] } : undefined}
                title={opts.title}
                onContextMenu={
                    navRow >= 0
                        ? (e) => {
                              const nav = navRows[navRow];
                              if (!nav) return;
                              e.preventDefault();
                              const rec = recordsById.get(nav.deliveryId);
                              menu.open(
                                  {
                                      deliveryId: nav.deliveryId,
                                      sampleIndex: nav.kind === 'sample' ? nav.sampleIndex : undefined,
                                      sampleCount: rec?.row.sample_count ?? 0,
                                  },
                                  e.clientX,
                                  e.clientY,
                              );
                          }
                        : undefined
                }
            >
                {isEditingThis ? (
                    <div className="relative h-full w-full">{renderEditor({ row: navRow, col: colIndex }, col.numeric ? 'right' : 'left')}</div>
                ) : (
                    <div
                        tabIndex={-1}
                        className={cn(
                            CELL_BASE,
                            col.numeric && 'justify-end font-mono tabular-nums',
                            opts.muted && 'text-muted-foreground/60',
                            invalid && 'bg-destructive/15 text-destructive',
                            // The active ring sits at z-20 so it clears `.frozen-col`
                            // (z-10) — otherwise a frozen cell paints over its own ring.
                            isActive && 'z-20 ring-2 ring-primary ring-inset',
                            canEdit ? 'cursor-cell' : 'cursor-default',
                        )}
                        onMouseDown={(e) => {
                            if (navRow < 0 || !addressable(navRow, colIndex)) return;
                            e.preventDefault();
                            setActiveCell({ row: navRow, col: colIndex });
                            gridRef.current?.focus();
                        }}
                        onDoubleClick={(e) => {
                            if (navRow < 0 || !addressable(navRow, colIndex)) return;
                            e.stopPropagation();
                            if (col.field === 'delivery_date') return;
                            edit.startEditing({ row: navRow, col: colIndex });
                        }}
                    >
                        {body}
                    </div>
                )}
            </td>
        );
    };

    // ── A delivery row's cells ───────────────────────────────────────────────────
    const deliveryCells = (item: Extract<LedgerItem, { kind: 'delivery' }>) => {
        const { rec, navRow, num: rowNum, monthLabel } = item;
        const row = rec.row;
        const id = row.id ?? '';
        const rowEdits = edits[id] ?? {};
        const issues = rowIssues(row);
        const isDup = issues.includes('duplicate');
        const rail = railClass(
            isDup ? 'duplicate' : issues.includes('unmapped') ? 'unmapped' : issues.includes('flagged') ? 'flagged' : 'none',
        );
        const flags = readImportFlags(row.import_flags);
        const dirtyTint = (f: DeliveryField) => (rowEdits[f] !== undefined ? 'bg-amber-500/[0.12]' : undefined);
        const pendingMoney = rowEdits.wt !== undefined || rowEdits.price !== undefined;

        return cols.map((col, ci) => {
            const field = col.field;

            switch (col.key) {
                case 'num':
                    return renderCell(
                        col, ci, navRow,
                        <span className="w-full text-center font-mono text-[10px] font-bold text-muted-foreground">{rowNum}</span>,
                        { rail, title: monthLabel ?? undefined },
                    );

                case 'date': {
                    const value = rowEdits.delivery_date ?? row.delivery_date ?? '';
                    const undated = !row.delivery_date && !!row.delivery_date_raw;
                    return renderCell(
                        col, ci, navRow,
                        <div className="flex w-full items-center gap-1">
                            {monthLabel && (
                                <span className="shrink-0 rounded-sm bg-primary/15 px-1 font-mono text-[9px] font-bold uppercase text-primary">
                                    {monthLabel}
                                </span>
                            )}
                            <input
                                type="date"
                                value={value}
                                onChange={(e) => setCellText({ row: navRow, col: ci }, e.target.value)}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="w-full cursor-pointer border-0 bg-transparent p-0 font-mono text-xs font-bold outline-none [color-scheme:light] dark:[color-scheme:dark]"
                                aria-label="Delivery date"
                            />
                            {undated && <AlertTriangle className="size-3 shrink-0 text-amber-500" />}
                        </div>,
                        {
                            tint: dirtyTint('delivery_date'),
                            title: undated ? `The workbook wrote: ${row.delivery_date_raw}` : undefined,
                        },
                    );
                }

                case 'truck':
                    return renderCell(
                        col, ci, navRow,
                        <span className="truncate font-mono text-xs font-bold">{rowEdits.truck_no ?? row.truck_no ?? ''}</span>,
                        { tint: dirtyTint('truck_no') },
                    );

                case 'supplier': {
                    const text = rowEdits.supplier ?? formatSupplierCell(row);
                    return renderCell(
                        col, ci, navRow,
                        <span className="flex w-full min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {isDup && (
                                <span className={cn(BADGE, 'shrink-0 bg-rose-500/15 text-rose-600 dark:text-rose-400')}>DUP</span>
                            )}
                            {row.supplier_unresolved && (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>MAP?</span>
                            )}
                            {flags.length > 0 && <FlagPopover flags={flags} />}
                        </span>,
                        { tint: dirtyTint('supplier'), title: text },
                    );
                }

                case 'sacks':
                    return renderCell(
                        col, ci, navRow,
                        <span className="text-xs font-bold">{rowEdits.sacks ?? formatInt(row.sacks) ?? ''}</span>,
                        { tint: dirtyTint('sacks') },
                    );

                case 'wt': {
                    const pending = rowEdits.wt;
                    let body: React.ReactNode;
                    if (pending === undefined) {
                        body = <span className="text-xs font-bold">{formatKg(row.net_weight_kg) || dash}</span>;
                    } else {
                        const parsed = parseWeightInput(pending);
                        body =
                            'error' in parsed ? (
                                <span className="truncate text-xs font-bold">{pending}</span>
                            ) : (
                                <span className="text-xs font-bold">{formatKg(parsed.netKg) || dash}</span>
                            );
                    }
                    return renderCell(col, ci, navRow, body, {
                        tint: dirtyTint('wt'),
                        title: weightTitle(row, pending),
                    });
                }

                case 'bd':
                case 'moist':
                case 'grit':
                case 'ash':
                case 'dust':
                case 'vm':
                case 'fc': {
                    const f = field as DeliveryField;
                    const dp = labDecimals(f);
                    const pending = rowEdits[f];
                    const stored = row[f as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'];
                    return renderCell(
                        col, ci, navRow,
                        <span className="text-xs font-bold">{pending ?? formatLab(stored, dp) ?? ''}</span>,
                        { tint: dirtyTint(f) },
                    );
                }

                case 'whse': {
                    const text = rowEdits.destination ?? formatDestinationCell(row);
                    return renderCell(
                        col, ci, navRow,
                        <span className="flex w-full min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {row.destination_unresolved && (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>MAP?</span>
                            )}
                        </span>,
                        { tint: dirtyTint('destination'), title: text },
                    );
                }

                case 'remarks': {
                    const text = rowEdits.remarks ?? row.remarks ?? '';
                    return renderCell(
                        col, ci, navRow,
                        <span className="max-w-[200px] truncate text-xs">{text}</span>,
                        { tint: dirtyTint('remarks'), title: text || undefined },
                    );
                }

                case 'php_kg': {
                    const pending = rowEdits.price;
                    let value: number | null;
                    if (pending === undefined) value = num(row.price_php_kg);
                    else {
                        const parsed = parsePriceInput(pending);
                        value = 'error' in parsed ? null : parsed.effectivePhpKg;
                    }
                    return renderCell(
                        col, ci, navRow,
                        // Accounting format: ₱ pinned left, the figure pinned right.
                        <span className="flex w-full items-center justify-between gap-1 text-xs font-bold">
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{value === null ? (pending ?? '') : formatRate(value)}</span>
                        </span>,
                        { tint: dirtyTint('price'), title: priceTitle(row, pending) },
                    );
                }

                case 'ttl':
                    return renderCell(
                        col, ci, navRow,
                        <span
                            className={cn(
                                'flex w-full items-center justify-between gap-1 text-xs font-bold',
                                pendingMoney && 'italic opacity-45',
                            )}
                        >
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{formatPeso(row.total_price_php) || '0.00'}</span>
                        </span>,
                        {
                            muted: !pendingMoney && row.sheet_total_matches === false,
                            title: pendingMoney
                                ? 'Stale — this is the stored total. TTL PRICE is a database-generated column and is recomputed on save, never in the browser.'
                                : row.sheet_total_matches === false
                                  ? `The workbook printed ₱${formatPeso(row.sheet_total_php)} for this row.`
                                  : undefined,
                        },
                    );

                default:
                    return renderCell(col, ci, navRow, null);
            }
        });
    };

    // ── A sample sub-row's cells ─────────────────────────────────────────────────
    const sampleCells = (item: Extract<LedgerItem, { kind: 'sample' }>) => {
        const drafts = samplesOf(item.deliveryId);
        const draft = drafts[item.sampleIndex];
        const isDirty = sampleDrafts[item.deliveryId] !== undefined;
        const tint = isDirty ? 'bg-amber-500/[0.08]' : undefined;

        return cols.map((col, ci) => {
            const sf = sampleFieldFor(col.field);
            const isFirstFrozen = ci === 0;

            if (sf === null) {
                return renderCell(
                    col, ci, item.navRow,
                    isFirstFrozen ? <span className="w-full text-center text-[10px] text-muted-foreground/40">└</span> : null,
                    { tint },
                );
            }
            if (sf === 'label') {
                return renderCell(
                    col, ci, item.navRow,
                    <span className="flex w-full min-w-0 items-center gap-1 pl-3">
                        <span className="shrink-0 text-[10px] text-muted-foreground/40">└</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {draft?.label || <span className="text-muted-foreground/40">unlabelled draw</span>}
                        </span>
                    </span>,
                    { tint, title: draft?.label },
                );
            }
            return renderCell(
                col, ci, item.navRow,
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {draft?.[sf] ?? ''}
                </span>,
                { tint },
            );
        });
    };

    // ── Chrome rows (day header, Σ DAY TOTAL, month marker) ──────────────────────
    const spanAll = cols.length;

    const chromeRow = (item: LedgerItem): React.ReactNode => {
        if (item.kind === 'month') {
            return (
                <td colSpan={spanAll} className={cn(DAY_HEADER_CELL, 'bg-primary/[0.06]')}>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-primary/80">{item.label}</span>
                </td>
            );
        }
        if (item.kind === 'day') {
            return (
                <td colSpan={spanAll} className={DAY_HEADER_CELL}>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {item.label}
                        <span className="ml-2 font-normal normal-case text-muted-foreground/60">
                            {item.count} receipt{item.count === 1 ? '' : 's'}
                        </span>
                    </span>
                </td>
            );
        }
        // Σ DAY TOTAL
        const t = item as Extract<LedgerItem, { kind: 'day-total' }>;
        return (
            <>
                <td colSpan={5} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide">Σ Day total</span>
                </td>
                <td className={cn(DAY_TOTAL_CELL, 'px-2 text-right font-mono text-[11px] font-bold tabular-nums')}>
                    {formatKg(t.netKg)}
                </td>
                <td colSpan={canViewPrices ? spanAll - 7 : spanAll - 6} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                    {t.dupNetKg > 0 && (
                        <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                            includes {formatKg(t.dupNetKg)} kg
                            {canViewPrices ? ` / ₱${formatPeso(t.dupPhp)}` : ''} from suspected duplicates
                        </span>
                    )}
                </td>
                {canViewPrices && (
                    <td className={cn(DAY_TOTAL_CELL, 'px-2')}>
                        <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px] font-bold tabular-nums">
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{formatPeso(t.php ?? 0)}</span>
                        </span>
                    </td>
                )}
            </>
        );
    };

    // ── Header ───────────────────────────────────────────────────────────────────
    const headerRow = (
        <tr className="border-b">
            {cols.map((col, ci) => (
                <th
                    key={col.key}
                    title={col.title}
                    className={cn(
                        'h-8 border-r border-border/40 bg-muted px-2 align-middle text-[10px] font-bold uppercase tracking-wide text-muted-foreground',
                        col.numeric ? 'text-right' : 'text-left',
                        ci < frozenCount ? 'frozen-corner' : '',
                        ci === frozenCount - 1 && 'frozen-edge',
                    )}
                    style={ci < frozenCount ? { left: frozenLeft[ci] } : undefined}
                >
                    {col.label}
                </th>
            ))}
        </tr>
    );

    const colGroup = (
        <colgroup>
            {cols.map((c) => (
                <col key={c.key} style={{ width: `${c.width}px` }} />
            ))}
        </colgroup>
    );

    // ── Row wrapper (shared by both containers) ──────────────────────────────────
    const rowClassFor = (item: LedgerItem): string => {
        if (item.kind === 'delivery') {
            const dirty = dirtyIds.has(item.rec.row.id ?? '');
            const dup = item.rec.row.is_suspected_duplicate;
            return cn(
                'group border-b border-border/30 transition-colors duration-150 hover:bg-muted',
                dup && 'bg-rose-500/[0.05]',
                dirty && 'bg-amber-500/[0.07]',
            );
        }
        if (item.kind === 'sample') return 'group border-b border-border/20 bg-muted/20 transition-colors duration-150 hover:bg-muted/40';
        return '';
    };

    const rowHeightFor = (item: LedgerItem): number | undefined => {
        if (item.kind === 'delivery') return ROW_H;
        if (item.kind === 'sample') return SAMPLE_ROW_H;
        return undefined;
    };

    const renderItemCells = (item: LedgerItem): React.ReactNode => {
        if (item.kind === 'delivery') return <>{deliveryCells(item)}</>;
        if (item.kind === 'sample') return <>{sampleCells(item)}</>;
        return chromeRow(item);
    };

    // ── Virtuoso plumbing (endless only) ─────────────────────────────────────────
    const ctx = React.useMemo<LedgerCtx>(
        () => ({ minWidth, rowClassFor, rowHeightFor, colGroup }),
        // `rowClassFor`/`rowHeightFor` close over dirty state, so the context must be
        // re-made when that changes — virtuoso re-renders visible rows off it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [minWidth, dirtyIds, cols],
    );

    const initialTop = React.useRef<number | undefined>(undefined);
    if (initialTop.current === undefined && scope === 'endless') {
        initialTop.current = anchor.kind === 'latest' ? Math.max(0, items.length - 1) : 0;
    }

    // ── Empty / error ────────────────────────────────────────────────────────────
    const isEmpty = items.length === 0;

    // ═══ Render ══════════════════════════════════════════════════════════════════
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Toolbar — the ONE surface in this screen that animates. */}
            <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/60">
                <ScopeToggle scope={scope} onChange={setScope} pending={isPending} />

                {scope === 'focus' && period && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]">
                                {periodLabel(period)}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto bg-popover/95 backdrop-blur-lg">
                            {monthKeys
                                .slice()
                                .reverse()
                                .map((k) => {
                                    const p = parsePeriodKey(k);
                                    return (
                                        <DropdownMenuItem
                                            key={k}
                                            onSelect={() => setPeriodParam(k)}
                                            className={cn(
                                                'font-mono text-[11px]',
                                                period && periodKey(period) === k && 'font-bold text-primary',
                                            )}
                                        >
                                            {p ? periodLabel(p) : k}
                                        </DropdownMenuItem>
                                    );
                                })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}

                <div className="flex items-center gap-1">
                    {ISSUE_LENSES.map((lens) => (
                        <button
                            key={lens}
                            type="button"
                            title={ISSUE_HINTS[lens]}
                            onClick={() => setIssue(issue === lens ? null : lens)}
                            className={cn(
                                'h-6 rounded-md border px-2 text-[11px] font-medium transition-colors duration-150',
                                issue === lens
                                    ? 'border-transparent bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900'
                                    : 'border-border/60 text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {ISSUE_LABELS[lens]}
                        </button>
                    ))}
                </div>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
                    <Input
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onBlur={commitSearch}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commitSearch();
                        }}
                        placeholder="Supplier, truck, permit, remarks…"
                        className="h-6 w-56 pl-7 text-[11px]"
                    />
                    {searchText && (
                        <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                                setSearchText('');
                                writeParams((sp) => sp.delete('q'));
                            }}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                        >
                            <X className="size-3" />
                        </button>
                    )}
                </div>

                <div className="ml-auto flex items-center gap-2">
                    {isPending && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                    {!canViewPrices && (
                        <span className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            ₱ hidden for your role
                        </span>
                    )}
                    {dirtyCount > 0 && (
                        <span className="animate-fade-in rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-700 dark:text-amber-400">
                            {dirtyCount} unsaved
                        </span>
                    )}
                    <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" disabled={dirtyCount === 0 || saving} onClick={handleSave}>
                        {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                        Save
                    </Button>
                </div>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex-1">{loadError}</span>
                    <button
                        type="button"
                        className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium"
                        onClick={() => {
                            void navigator.clipboard.writeText(loadError).then(() => toast.success('Error copied'));
                        }}
                    >
                        Copy
                    </button>
                </div>
            )}

            {isEmpty ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
                    <Inbox className="size-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">
                        {win.notice ?? 'No receipts match the current view.'}
                    </p>
                </div>
            ) : (
                <div
                    ref={gridRef}
                    tabIndex={-1}
                    className="relative min-h-0 flex-1 select-none outline-none"
                    onKeyDown={handleKeyDown}
                    onPaste={(e) => handleGridPaste(e, activeCell)}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) setActiveCell(null);
                    }}
                >
                    {scope === 'endless' ? (
                        <>
                            {win.loadingOlder && <EdgeSpinner where="top" label="Loading earlier receipts…" />}
                            <TableVirtuoso
                                ref={virtuosoRef}
                                data={items}
                                context={ctx}
                                computeItemKey={(_i, item) => item.key}
                                firstItemIndex={win.firstItemIndex}
                                initialTopMostItemIndex={initialTop.current}
                                startReached={() => void win.fetchOlder()}
                                endReached={() => void win.fetchNewer()}
                                increaseViewportBy={{ top: 400, bottom: 400 }}
                                components={TABLE_COMPONENTS}
                                fixedHeaderContent={() => headerRow}
                                itemContent={(_i, item) => renderItemCells(item)}
                                style={{ height: '100%' }}
                            />
                            {win.loadingNewer && <EdgeSpinner where="bottom" label="Loading later receipts…" />}
                        </>
                    ) : (
                        <div className="h-full overflow-auto">
                            <table
                                className="relative table-fixed text-xs"
                                style={{ width: '100%', minWidth, borderCollapse: 'separate', borderSpacing: 0 }}
                            >
                                {colGroup}
                                <thead className="frozen-row bg-muted" style={{ zIndex: 20 }}>
                                    {headerRow}
                                </thead>
                                <tbody>
                                    {items.map((item) => (
                                        <tr key={item.key} className={rowClassFor(item)} style={{ height: rowHeightFor(item) }}>
                                            {renderItemCells(item)}
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr style={{ height: 34 }}>
                                        {/* Bottom-LEFT corner: sticky-left AND sticky-bottom, so it
                                            out-ranks both the frozen column (z-10) and the footer row
                                            (z-20) at z-30. It spans exactly the frozen block — no
                                            further, or it would overhang into scrolling territory. */}
                                        <td
                                            colSpan={frozenCount}
                                            className={cn(MONTH_FOOTER_CELL, 'frozen-corner-bottom frozen-edge')}
                                            style={{ left: frozenLeft[0] }}
                                        >
                                            <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                                                Σ {period ? periodLabel(period) : 'Month'} · {monthTotals.count} receipts
                                            </span>
                                        </td>
                                        <td className={MONTH_FOOTER_CELL} />
                                        <td className={cn(MONTH_FOOTER_CELL, 'text-right font-mono text-[11px] font-bold tabular-nums')}>
                                            {formatKg(monthTotals.netKg)}
                                        </td>
                                        <td colSpan={canViewPrices ? cols.length - frozenCount - 3 : cols.length - frozenCount - 2} className={MONTH_FOOTER_CELL}>
                                            {monthTotals.dupCount > 0 && (
                                                <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                                                    {monthTotals.dupCount} suspected duplicate{monthTotals.dupCount === 1 ? '' : 's'} included —
                                                    {' '}{formatKg(monthTotals.dupNetKg)} kg
                                                    {canViewPrices ? ` / ₱${formatPeso(monthTotals.dupPhp)}` : ''}
                                                </span>
                                            )}
                                        </td>
                                        {canViewPrices && (
                                            <td className={MONTH_FOOTER_CELL}>
                                                <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px] font-bold tabular-nums">
                                                    <span className="text-muted-foreground/70">₱</span>
                                                    <span>{formatPeso(monthTotals.php)}</span>
                                                </span>
                                            </td>
                                        )}
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    )}
                </div>
            )}

            <GridContextMenu state={menu.state} items={menuItems} onClose={menu.close} />

            <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this receipt?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleteTarget ? rowLabel(deleteTarget) : ''} and its
                            {' '}{deleteTarget?.samples.length ?? 0} moisture draw
                            {(deleteTarget?.samples.length ?? 0) === 1 ? '' : 's'} will be removed. This cannot be undone,
                            and the row&apos;s import provenance goes with it.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => void handleDelete()}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            Delete receipt
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

// ═══ Sub-components ═════════════════════════════════════════════════════════════

function ScopeToggle({
    scope,
    onChange,
    pending,
}: {
    scope: Scope;
    onChange: (s: Scope) => void;
    pending: boolean;
}) {
    const wrap = 'inline-flex h-6 items-center rounded-md border border-border/60 bg-background p-0.5';
    const active = 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900';
    const idle = 'text-muted-foreground hover:text-foreground';
    return (
        <div className={wrap} role="tablist" aria-label="Receipt history scope">
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'endless'}
                onClick={() => onChange('endless')}
                title="Endless — the whole history as one continuous, cursor-guided sheet"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'endless' ? active : idle,
                )}
            >
                <InfinityIcon className="size-3" />
                Endless
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'focus'}
                onClick={() => onChange('focus')}
                title="Focus — one month, day-grouped, with day totals and a month footer"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'focus' ? active : idle,
                )}
            >
                <Crosshair className="size-3" />
                Focus
            </button>
            {pending && <Loader2 className="ml-1 mr-0.5 size-3 animate-spin text-muted-foreground" />}
        </div>
    );
}

function FlagPopover({ flags }: { flags: ReturnType<typeof readImportFlags> }) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={`${flags.length} import flag${flags.length === 1 ? '' : 's'}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="shrink-0 text-sky-500 hover:text-sky-600"
                >
                    <AlertTriangle className="size-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 bg-popover/95 p-2 backdrop-blur-lg">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    Import flags — kept, not fixed
                </p>
                <ul className="space-y-1.5">
                    {flags.map((f, i) => (
                        <li key={i} className="text-[11px] leading-snug">
                            <span className="font-mono font-bold text-foreground">{f.kind}</span>
                            <span className="block text-muted-foreground">{f.detail}</span>
                            {f.raw && (
                                <span className="block font-mono text-[10px] text-muted-foreground/70">
                                    workbook wrote: {f.raw}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
}

function EdgeSpinner({ where, label }: { where: 'top' | 'bottom'; label: string }) {
    return (
        <div
            className={cn(
                'pointer-events-none absolute inset-x-0 z-40 flex items-center justify-center gap-1.5 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm',
                where === 'top' ? 'top-0 border-b border-border/40' : 'bottom-0 border-t border-border/40',
            )}
        >
            <Loader2 className="size-3 animate-spin" />
            {label}
        </div>
    );
}

// ═══ Virtuoso table components (module level → stable identity) ═════════════════
//
// Virtuoso forwards the `context` prop to every component, and an object prop named
// `context` on a <div>/<thead> is an invalid DOM attribute — so it is stripped here
// rather than spread through.

interface LedgerCtx {
    minWidth: number;
    rowClassFor: (item: LedgerItem) => string;
    rowHeightFor: (item: LedgerItem) => number | undefined;
    colGroup: React.ReactNode;
}

const LedgerScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & { context?: unknown }>(
    function LedgerScroller({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <div ref={ref} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
    },
);

const LedgerTable = ({ style, children, context }: TableProps & { context?: LedgerCtx }) => (
    <table
        className="relative table-fixed text-xs"
        style={{ ...style, width: '100%', minWidth: context?.minWidth, borderCollapse: 'separate', borderSpacing: 0 }}
    >
        {context?.colGroup}
        {children}
    </table>
);

const LedgerTableHead = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'> & { context?: unknown }>(
    function LedgerTableHead({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
    },
);

const LedgerTableRow = ({ item, context, children, style, ...props }: ItemProps<LedgerItem> & { context?: LedgerCtx }) => (
    <tr {...props} style={{ ...style, height: context?.rowHeightFor(item) }} className={context?.rowClassFor(item)}>
        {children}
    </tr>
);

const TABLE_COMPONENTS: TableComponents<LedgerItem, LedgerCtx> = {
    Scroller: LedgerScroller,
    Table: LedgerTable,
    TableHead: LedgerTableHead,
    TableRow: LedgerTableRow,
};

// ═══ The nav resolver ═══════════════════════════════════════════════════════════

interface DeliveryNavGeometry {
    rowCount: number;
    lastCol: number;
    addressable: (row: number, col: number) => boolean;
}

/**
 * Per-CELL addressability, because a sample sub-row occupies only the label lane and
 * the seven lab lanes. Every branch answers "is there an addressable cell that way?"
 * and returns null (stay put) when there is not.
 *
 * The behavioural consequence is exactly the asymmetry the data already has: ArrowDown
 * in the WT lane walks receipt-to-receipt, stepping OVER the draws in between, while
 * ArrowDown in the MOIST lane walks through every draw — which is what a QC operator
 * reading down a moisture column actually wants.
 */
function createDeliveryNavResolver(geo: DeliveryNavGeometry): NavResolver<CoordinateId> {
    const { rowCount, lastCol, addressable } = geo;

    const rowStep = (row: number, col: number, dir: 1 | -1): number | null => {
        for (let r = row + dir; r >= 0 && r < rowCount; r += dir) {
            if (addressable(r, col)) return r;
        }
        return null;
    };

    /** Reading order: across the row, then on to the next. Skips inert cells. */
    const tabStep = (from: CoordinateId, dir: 1 | -1): CoordinateId | null => {
        let { row, col } = from;
        const limit = rowCount * (lastCol + 1) + (lastCol + 1);
        for (let guard = 0; guard < limit; guard++) {
            col += dir;
            if (col > lastCol) {
                row += 1;
                col = 0;
            } else if (col < 0) {
                row -= 1;
                col = lastCol;
            }
            if (row < 0 || row >= rowCount) return null;
            if (addressable(row, col)) return { row, col };
        }
        return null;
    };

    const vertical = (from: CoordinateId, dir: 1 | -1): CoordinateId | null => {
        const row = rowStep(from.row, from.col, dir);
        return row === null ? null : { row, col: from.col };
    };

    return {
        resolve(from, move) {
            if (move.kind === 'tab') return tabStep(from, move.shift ? -1 : 1);
            if (move.kind === 'enter') return vertical(from, move.shift ? -1 : 1);
            if (move.dir === 'up') return vertical(from, -1);
            if (move.dir === 'down') return vertical(from, 1);
            // left / right stay on the row and clamp at its edges.
            const dir = move.dir === 'right' ? 1 : -1;
            for (let col = from.col + dir; col >= 0 && col <= lastCol; col += dir) {
                if (addressable(from.row, col)) return { row: from.row, col };
            }
            return null;
        },
        laneOf: (id) => id.col,
        resolveInRow(from, lane, dir) {
            // The Enter-anchor lane may not exist on the next row (a WT lane over a run
            // of sample rows) — `rowStep` walks past them to the next row that has it.
            const col = typeof lane === 'number' ? lane : from.col;
            const row = rowStep(from.row, col, dir);
            return row === null ? null : { row, col };
        },
        isEditable: (id) => addressable(id.row, id.col),
    };
}

// ═══ Flattening ═════════════════════════════════════════════════════════════════

interface MonthTotals {
    count: number;
    netKg: number;
    php: number;
    dupCount: number;
    dupNetKg: number;
    dupPhp: number;
}

/**
 * Build the render list, the keyboard's row axis and the footer figures in ONE pass.
 *
 * The two summary figures are SUMS OF STORED COLUMNS (`net_weight_kg`,
 * `total_price_php` — both DB-generated, exact decimal), not arithmetic re-derived from
 * gross × deduction × rate. A rule-off line adds up the numbers already on screen; it
 * does not recompute them. The duplicate sub-total rides alongside because 22 receipts
 * in this dataset are pasted twice, and a total that silently includes them is worse
 * than no total at all.
 */
function flatten(
    records: DeliveryRecord[],
    samplesOf: (id: string) => SampleDraft[],
    scope: Scope,
): { items: LedgerItem[]; navRows: NavRow[]; monthTotals: MonthTotals } {
    const items: LedgerItem[] = [];
    const navRows: NavRow[] = [];
    const totals: MonthTotals = { count: 0, netKg: 0, php: 0, dupCount: 0, dupNetKg: 0, dupPhp: 0 };

    // Counted once up front — a `filter` inside the row loop would make this quadratic.
    const dayCounts = new Map<string, number>();
    for (const r of records) {
        const d = r.row.delivery_date ?? '';
        dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }

    let currentDay = '';
    let currentMonth = '';
    let dayNet = 0;
    let dayPhp = 0;
    let dayDupNet = 0;
    let dayDupPhp = 0;
    let dayCount = 0;
    let rowNum = 0;

    const closeDay = () => {
        if (scope !== 'focus' || dayCount === 0) return;
        items.push({
            kind: 'day-total',
            key: `total:${currentDay}`,
            netKg: dayNet,
            php: dayPhp,
            dupNetKg: dayDupNet,
            dupPhp: dayDupPhp,
        });
        dayNet = 0;
        dayPhp = 0;
        dayDupNet = 0;
        dayDupPhp = 0;
        dayCount = 0;
    };

    for (const rec of records) {
        const row = rec.row;
        const id = row.id ?? '';
        const date = row.delivery_date ?? '';
        const month = date.slice(0, 7);
        let monthLabel: string | null = null;

        if (scope === 'focus') {
            if (date !== currentDay) {
                closeDay();
                currentDay = date;
                items.push({
                    kind: 'day',
                    key: `day:${date || 'undated'}`,
                    label: date ? formatDayHeading(date) : 'Undated — the workbook’s date could not be read',
                    count: dayCounts.get(date) ?? 0,
                });
            }
        } else if (month && month !== currentMonth) {
            currentMonth = month;
            monthLabel = monthBadge(date);
        }

        rowNum++;
        const navRow = navRows.length;
        navRows.push({ kind: 'delivery', deliveryId: id });
        items.push({ kind: 'delivery', key: `d:${id}`, navRow, rec, num: rowNum, monthLabel });

        const net = num(row.net_weight_kg) ?? 0;
        const php = num(row.total_price_php) ?? 0;
        totals.count++;
        totals.netKg += net;
        totals.php += php;
        dayCount++;
        dayNet += net;
        dayPhp += php;
        if (row.is_suspected_duplicate) {
            totals.dupCount++;
            totals.dupNetKg += net;
            totals.dupPhp += php;
            dayDupNet += net;
            dayDupPhp += php;
        }

        const drafts = samplesOf(id);
        drafts.forEach((d, i) => {
            const sNav = navRows.length;
            navRows.push({ kind: 'sample', deliveryId: id, sampleIndex: i });
            items.push({ kind: 'sample', key: `s:${id}:${d.key}`, navRow: sNav, deliveryId: id, sampleIndex: i });
        });
    }
    closeDay();

    return { items, navRows, monthTotals: totals };
}

function formatDayHeading(iso: string): string {
    const d = parseISO(iso);
    return isValid(d) ? format(d, 'EEEE · yyyy-MM-dd').toUpperCase() : iso;
}

function monthBadge(iso: string): string | null {
    const d = parseISO(iso);
    return isValid(d) ? format(d, 'MMM yyyy').toUpperCase() : null;
}

// ═══ Pure helpers ═══════════════════════════════════════════════════════════════

interface MenuRef {
    deliveryId: string;
    sampleIndex: number | undefined;
    sampleCount: number;
}

/** How a receipt is named in an error message — enough to find it in the sheet. */
function rowLabel(rec: DeliveryRecord): string {
    const r = rec.row;
    const date = r.delivery_date ?? r.delivery_date_raw ?? 'undated';
    const who = formatSupplierCell(r) || 'unknown supplier';
    const truck = r.truck_no ? ` · ${r.truck_no}` : '';
    return `${date} · ${who}${truck}`;
}

function toDrafts(samples: RcDeliverySampleRow[]): SampleDraft[] {
    return samples.map((s) => ({
        key: s.id ?? `p${s.position ?? 0}`,
        label: s.label ?? '',
        bd: s.bd === null || s.bd === undefined ? '' : String(s.bd),
        moisture_pct: s.moisture_pct === null || s.moisture_pct === undefined ? '' : String(s.moisture_pct),
        grit: s.grit === null || s.grit === undefined ? '' : String(s.grit),
        ash: s.ash === null || s.ash === undefined ? '' : String(s.ash),
        dust: s.dust === null || s.dust === undefined ? '' : String(s.dust),
        vm: s.vm === null || s.vm === undefined ? '' : String(s.vm),
        fc: s.fc === null || s.fc === undefined ? '' : String(s.fc),
    }));
}

function toSamplePayload(drafts: SampleDraft[]): SamplePayload[] {
    return drafts.map((d, i) => ({
        position: i + 1,
        label: d.label.trim() || null,
        bd: num(d.bd),
        moisture_pct: num(d.moisture_pct),
        grit: num(d.grit),
        ash: num(d.ash),
        dust: num(d.dust),
        vm: num(d.vm),
        fc: num(d.fc),
    }));
}

/** What a cell shows on FOCUS, when it has no unsaved text of its own. */
function canonicalEditText(rec: DeliveryRecord, field: DeliveryField): string {
    const r = rec.row;
    switch (field) {
        case 'delivery_date': return r.delivery_date ?? '';
        case 'truck_no': return r.truck_no ?? '';
        case 'supplier': return formatSupplierCell(r);
        case 'sacks': return formatInt(r.sacks);
        // The two formula cells: the stored formula, else one REBUILT from the stored
        // parts, else the plain number. This is what makes an imported row read exactly
        // like one typed this morning.
        case 'wt': return weightEditText(r);
        case 'price': return priceEditText(r);
        case 'destination': return formatDestinationCell(r);
        case 'remarks': return r.remarks ?? '';
        default: {
            const v = r[field as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'];
            return v === null || v === undefined ? '' : String(v);
        }
    }
}

/** What a cell shows in DISPLAY mode — used by the TSV copy. */
function displayText(rec: DeliveryRecord, field: DeliveryField, showPrices: boolean): string {
    const r = rec.row;
    switch (field) {
        case 'delivery_date': return r.delivery_date ?? r.delivery_date_raw ?? '';
        case 'truck_no': return r.truck_no ?? '';
        case 'supplier': return formatSupplierCell(r);
        case 'sacks': return formatInt(r.sacks);
        case 'wt': return formatKg(r.net_weight_kg);
        case 'destination': return formatDestinationCell(r);
        case 'remarks': return r.remarks ?? '';
        case 'price': return showPrices ? formatRate(r.price_php_kg) : '';
        default: return formatLab(r[field as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'], labDecimals(field));
    }
}

function weightTitle(row: DeliveryRecord['row'], pending: string | undefined): string {
    const source = pending ?? weightEditText(row);
    const parsed = parseWeightInput(source);
    if ('error' in parsed) return `${source} — ${parsed.error}`;
    if (parsed.deductionPct === null) return `${formatKg(parsed.netKg)} kg`;
    return `${formatKg(parsed.grossKg)} kg on the scale, less ${parsed.deductionPct}% ⇒ ${formatKg(parsed.netKg)} kg paid for`;
}

function priceTitle(row: DeliveryRecord['row'], pending: string | undefined): string {
    const source = pending ?? priceEditText(row);
    if (!source) return '';
    const parsed = parsePriceInput(source);
    if ('error' in parsed) return `${source} — ${parsed.error}`;
    if (parsed.adjustmentPhpKg === null) return `₱${formatRate(parsed.effectivePhpKg)}/kg`;
    return `₱${formatRate(parsed.basePhpKg)} base + ₱${formatRate(parsed.adjustmentPhpKg)} adjustment ⇒ ₱${formatRate(parsed.effectivePhpKg)}/kg`;
}

// ── Patch building ──────────────────────────────────────────────────────────────

/**
 * Turn a receipt's raw edit text into the allowlisted patch the RPC accepts.
 *
 * The two dimension cells and the two formula cells are the whole reason this is a
 * function and not an object spread: each one is ONE cell that becomes THREE columns,
 * and a value that does not resolve comes back as an `error` rather than being written
 * as an unresolved row. The import was allowed to leave a supplier NULL because it was
 * transcribing a workbook nobody can go back and ask about; a human typing today can be
 * asked, so this refuses instead.
 */
function buildPatch(
    fieldEdits: FieldEdits,
    supplierCodes: readonly string[],
    destinationCodes: readonly string[],
    canViewPrices: boolean,
): { patch: DeliveryPatch; errors: string[] } {
    const patch: DeliveryPatch = {};
    const errors: string[] = [];

    for (const [key, raw] of Object.entries(fieldEdits) as [DeliveryField, string][]) {
        const text = (raw ?? '').trim();

        switch (key) {
            case 'delivery_date':
                if (!text) errors.push('a receipt entered in the app needs a date.');
                else patch.delivery_date = text;
                break;

            case 'truck_no':
                patch.truck_no = text || null;
                break;

            case 'supplier': {
                if (!text) {
                    errors.push('the supplier cannot be cleared — a receipt with no payee cannot be liquidated.');
                    break;
                }
                const parsed = parseSupplierCell(text, supplierCodes);
                if ('error' in parsed) {
                    errors.push(parsed.error);
                    break;
                }
                patch.supplier_code = parsed.supplier_code;
                patch.supplier_origin = parsed.supplier_origin;
                patch.permit_no = parsed.permit_no;
                // The raw column is the operator's own words — rewrite it to what they
                // just typed so the row's audit trail matches the screen.
                patch.supplier_raw = text;
                break;
            }

            case 'destination': {
                if (!text) {
                    patch.destination_code = null;
                    patch.destination_side = null;
                    patch.destination_raw = null;
                    break;
                }
                const parsed = parseDestinationCell(text, destinationCodes);
                if ('error' in parsed) {
                    errors.push(parsed.error);
                    break;
                }
                patch.destination_code = parsed.destination_code;
                patch.destination_side = parsed.destination_side;
                patch.destination_raw = text;
                break;
            }

            case 'sacks': {
                if (!text) {
                    patch.sacks = null;
                    break;
                }
                const n = num(text);
                if (n === null || n < 0) errors.push(`"${text}" is not a sack count.`);
                else patch.sacks = Math.round(n);
                break;
            }

            case 'wt': {
                if (!text) {
                    patch.gross_weight_kg = null;
                    patch.deduction_pct = null;
                    patch.weight_formula = null;
                    break;
                }
                const parsed = parseWeightInput(text);
                if ('error' in parsed) {
                    errors.push(`WT "${text}" — ${parsed.error}`);
                    break;
                }
                // The DB derives `net_weight_kg` (and `total_price_php`) from these three.
                // Nothing here computes the net; a generated column cannot be written to.
                patch.gross_weight_kg = parsed.grossKg;
                patch.deduction_pct = parsed.deductionPct;
                patch.weight_formula = parsed.formula;
                break;
            }

            case 'price': {
                if (!canViewPrices) {
                    errors.push('your role cannot edit price data.');
                    break;
                }
                if (!text) {
                    patch.base_price_php_kg = null;
                    patch.price_adjustment_php_kg = null;
                    patch.price_formula = null;
                    break;
                }
                const parsed = parsePriceInput(text);
                if ('error' in parsed) {
                    errors.push(`PHP/KG "${text}" — ${parsed.error}`);
                    break;
                }
                patch.base_price_php_kg = parsed.basePhpKg;
                patch.price_adjustment_php_kg = parsed.adjustmentPhpKg;
                patch.price_formula = parsed.formula;
                break;
            }

            case 'remarks':
                patch.remarks = text || null;
                break;

            default: {
                // A lab column.
                if (!text) {
                    patch[key as 'bd'] = null;
                    break;
                }
                const n = num(text);
                if (n === null) errors.push(`${key.toUpperCase()} "${text}" is not a number.`);
                else patch[key as 'bd'] = n;
                break;
            }
        }
    }

    return { patch, errors };
}

// ── Paste bridge ────────────────────────────────────────────────────────────────
//
// `useGridPaste` thinks in rows of `{ field: value }`. This grid's edit state is a map
// keyed by receipt id, so the paste target is a synthetic row keyed by COLUMN INDEX —
// which also keeps two columns that edit the same nominal field distinct.

type PasteRow = Record<string, string>;

function pasteKey(colIndex: number): string {
    return `c${colIndex}`;
}

function readPasteRow(
    row: number,
    cols: DeliveryCol[],
    getCellText: (id: CoordinateId) => string,
): PasteRow {
    const out: PasteRow = {};
    for (let c = 0; c < cols.length; c++) {
        if (cols[c].field === null) continue;
        out[pasteKey(c)] = getCellText({ row, col: c });
    }
    return out;
}
