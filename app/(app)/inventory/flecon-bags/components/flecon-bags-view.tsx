'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Pencil } from 'lucide-react';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { Tables } from '@/types/supabase';
import { updateFleconBagNickname, type FleconBagMovementRow } from '../actions';

// ---------------------------------------------------------------------------
// FLECON Bag Movement matrix — the digital mirror of the operator's
// `FLECON BAG MOVEMENT 2026.xlsx`. An Excel-style TABULAR MATRIX:
//
//   DATE | PARTICULAR | one column per bag type (14, in sort_order = sheet C→P)
//   ├─ Forwarded Balance row (top, not sticky) — each type's opening (from view)
//   ├─ Month separator rows (JANUARY … )       — emitted as the month changes
//   ├─ Movement rows (chronological, ASC)       — signed qty in the ONE
//   │                                             intersecting bag-type column;
//   │                                             the other 13 cells render blank
//   └─ Current Balance row (frozen footer)      — each type's live balance (view)
//
// READ-ONLY: there is NO write path. A daily "FLECON BAGGED" Python sync employee
// is the sole writer. NO price data anywhere — `canViewPrices()` is not imported.
//
// Frozen panes per CLAUDE.md: OPAQUE sticky cells only (never glass — glass is for
// surfaces over EMPTY space; frozen cells sit ON TOP of scrolling content), strict
// z-scale via the shared `.frozen-*` utility classes. DATE + PARTICULAR are the two
// frozen-LEFT columns; the header row is frozen-TOP; the Current Balance footer is
// frozen-BOTTOM. All balances are SQL-computed — NEVER summed/recomputed in TS.
// ---------------------------------------------------------------------------

// COALESCE null → 0 for the all-nullable balance view columns. Guards/formats
// only — never recomputes the SQL balance.
const nz = (v: number | null): number => v ?? 0;

/** Plain integer with thousands separators. Blank for 0 (Excel blanks-are-zero). */
const fmtInt = (n: number): string => (n === 0 ? '' : n.toLocaleString('en-US'));

/**
 * Signed qty cell content: positive → "+N" (emerald), negative → "−N" (real minus
 * glyph + abs value, red), zero → muted "0". Empty when there is no movement for
 * this intersecting bag-type cell (`q === undefined`).
 */
function SignedQty({ q }: { q: number | undefined }) {
    if (q === undefined) return null;
    if (q > 0) {
        return (
            <span className="text-emerald-600 dark:text-emerald-400">
                +{q.toLocaleString('en-US')}
            </span>
        );
    }
    if (q < 0) {
        return (
            <span className="text-red-600 dark:text-red-400">
                −{Math.abs(q).toLocaleString('en-US')}
            </span>
        );
    }
    return <span className="text-muted-foreground">0</span>;
}

// Frozen-pane column geometry (Excel Standard — explicit pixel widths).
// DATE + PARTICULAR keep FIXED widths — the sticky `left` offsets depend on them.
const W_DATE = 76;
const W_PARTICULAR = 200;
// Bag columns are NOT fixed-width: under `table-fixed` + `width:100%` they share the
// leftover width equally so the 14 columns stretch to fill a wide monitor. MIN_BAG_W
// is only used to compute the table's `minWidth` — the floor below which a horizontal
// scrollbar appears (frozen DATE/PARTICULAR stay pinned). Mirrors the RC Movement
// fill-and-scroll mechanism, but filling instead of content-sized.
const MIN_BAG_W = 72;
// Cumulative left offsets for the two frozen-LEFT columns.
const LEFT_DATE = 0;
const LEFT_PARTICULAR = W_DATE; // 76

// Month names for separator rows, indexed 0–11 (short forms for the summary strip).
const MONTHS = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;
const MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

interface FleconBagsViewProps {
    balances: Tables<'view_flecon_bag_balance'>[];
    movements: FleconBagMovementRow[];
    error?: string;
}

// A bag-type column: its code (the intersection key), full internal label, the
// user's optional nickname, opening (Forwarded Balance) and live balance (Current
// Balance footer). The HEADER shows `nickname || label`; the full internal `label`
// stays in the cell `title`.
interface BagColumn {
    bagTypeId: string;
    code: string;
    label: string;
    nickname: string | null;
    opening: number;
    balance: number;
}

// A rendered matrix body row is either a movement or a month separator. Each
// movement carries the single (date, particular, code, qty) it records — the
// sheet places at most one type per row, so one DB row = one matrix row.
type MatrixRow =
    | { kind: 'month'; key: string; month: string }
    | {
          kind: 'movement';
          key: string;
          date: string;
          particular: string;
          code: string;
          qty: number;
      };

// ---------------------------------------------------------------------------
// Frozen cell helpers — centralize the sticky offset + z-index + edge wiring so
// header / body / footer stay consistent (mirrors rc-movement-matrix.tsx). Adapted
// to TWO frozen-left columns (DATE, PARTICULAR). Callers pass `.frozen-edge` in
// `className` on the LAST frozen-left column (PARTICULAR); the helper then skips
// its own `border-r` so the two dividers don't fight.
// ---------------------------------------------------------------------------

function FrozenHeaderCell({
    left,
    width,
    className,
    children,
}: {
    left: number;
    width: number;
    className?: string;
    children: React.ReactNode;
}) {
    // Top-left CORNER: sticky on BOTH axes (.frozen-corner, z30). OPAQUE bg-muted so
    // scrolling cells can't bleed through in either direction.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <th
            className={cn(
                'frozen-corner border-b border-border bg-muted px-2 py-1 text-left align-bottom font-medium',
                !hasEdge && 'border-r border-border/50',
                className,
            )}
            style={{ left, width }}
        >
            {children}
        </th>
    );
}

function FrozenBodyCell({
    left,
    width,
    className,
    title,
    children,
}: {
    left: number;
    width: number;
    className?: string;
    title?: string;
    children?: React.ReactNode;
}) {
    // Frozen LEFT-column body cell (.frozen-col, z10). OPAQUE bg-background so scrolling
    // cells can't bleed through; group-hover repaints the hover tint OPAQUELY (bg-muted,
    // solid) onto the pinned columns so they match the scrolling part of the row.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <td
            className={cn(
                'frozen-col border-b border-border/50 bg-background px-2 py-1',
                !hasEdge && 'border-r border-border/50',
                className,
            )}
            style={{ left, width }}
            title={title}
        >
            {children}
        </td>
    );
}

function FrozenFooterCell({
    left,
    width,
    className,
    children,
}: {
    left: number;
    width: number;
    className?: string;
    children?: React.ReactNode;
}) {
    // Bottom-left CORNER: sticky on BOTH axes (.frozen-corner-bottom, z30). OPAQUE
    // bg-muted; frozen-edge-top kills the seam against the scrolling body above.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <td
            className={cn(
                'frozen-corner-bottom frozen-edge-top bg-muted px-2 py-1 align-middle',
                !hasEdge && 'border-r border-border/50',
                className,
            )}
            style={{ left, width }}
        >
            {children}
        </td>
    );
}

// ---------------------------------------------------------------------------
// Click-to-edit bag-type header cell. Sticky-TOP only (.frozen-row, z20), OPAQUE
// bg-muted (never glass — it sits on top of scrolling content). Display label is
// `nickname || label`; the FULL internal label stays in the native `title`. Click
// (or the hover pencil) swaps in a compact input seeded with the current nickname:
// Enter/blur SAVES via updateFleconBagNickname, Escape cancels. On success the page
// is refreshed so the header reflects the new value; on error errorToast() fires
// (persist + Copy, HARD RULE) and edit mode stays open so the user can retry.
// ---------------------------------------------------------------------------
function BagTypeHeaderCell({ column }: { column: BagColumn }) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(column.nickname ?? '');
    const [saving, setSaving] = useState(false);

    const display = column.nickname?.trim() || column.label;

    function beginEdit() {
        setValue(column.nickname ?? '');
        setEditing(true);
    }

    async function commit() {
        // Guard against the blur that fires when Enter/Escape has already closed
        // the input, and skip the round-trip when nothing changed.
        if (!editing || saving) return;
        const next = value.trim();
        const current = (column.nickname ?? '').trim();
        if (next === current) {
            setEditing(false);
            return;
        }
        setSaving(true);
        const res = await updateFleconBagNickname(column.bagTypeId, next);
        setSaving(false);
        if (res.ok) {
            setEditing(false);
            router.refresh();
        } else {
            errorToast(res.error);
            // keep the input open so the user can retry without retyping
        }
    }

    function cancel() {
        setValue(column.nickname ?? '');
        setEditing(false);
    }

    return (
        <th
            title={column.label}
            className="frozen-row border-b border-r border-border/50 bg-muted px-1 py-1 align-bottom text-center font-medium leading-tight"
        >
            {editing ? (
                <input
                    autoFocus
                    value={value}
                    disabled={saving}
                    onChange={(e) => setValue(e.target.value)}
                    onBlur={() => void commit()}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void commit();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancel();
                        }
                    }}
                    placeholder={column.label}
                    aria-label={`Nickname for ${column.label}`}
                    className="w-full rounded-sm border border-border bg-background px-1 py-0.5 text-center text-[9px] leading-tight outline-none focus:ring-1 focus:ring-ring"
                />
            ) : (
                <button
                    type="button"
                    onClick={beginEdit}
                    aria-label={`Edit nickname for ${column.label}`}
                    className="group/edit flex w-full cursor-text items-start justify-center gap-0.5 text-center"
                >
                    <span className="line-clamp-2 block text-[9px]">{display}</span>
                    <Pencil className="mt-px size-2.5 shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-60" />
                </button>
            )}
        </th>
    );
}

export function FleconBagsView({ balances, movements, error }: FleconBagsViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Error toast — persist-until-dismissed + Copy enforced by errorToast() (HARD RULE;
    // never call sonner's toast.error directly).
    useEffect(() => {
        if (error) errorToast(error);
    }, [error]);

    // Bag-type columns in sheet order (the view is already sorted by sort_order).
    // Gives BOTH the 14 ordered columns AND their opening/balance for the
    // Forwarded Balance / Current Balance rows.
    const columns = useMemo<BagColumn[]>(
        () =>
            balances.map((b) => ({
                bagTypeId: b.bag_type_id ?? '',
                code: b.code ?? '',
                label: b.label ?? b.code ?? '',
                nickname: b.nickname,
                opening: nz(b.opening),
                balance: nz(b.balance),
            })),
        [balances],
    );

    // Build the chronological row list, injecting a month separator whenever the
    // month changes. `movements` arrives ASC (server-ordered) so a single pass is
    // correct — the client never re-sorts. ONE table row per movement record.
    const rows = useMemo<MatrixRow[]>(() => {
        const out: MatrixRow[] = [];
        let lastMonthKey = '';
        for (const m of movements) {
            // transaction_date is `yyyy-MM-dd`; slice the month WITHOUT Date() to
            // avoid TZ drift (exact for the fixed ISO shape — no date-fns).
            const monthKey = m.transaction_date.slice(0, 7); // yyyy-MM
            if (monthKey !== lastMonthKey) {
                const moIdx = Number(m.transaction_date.slice(5, 7)) - 1;
                out.push({
                    kind: 'month',
                    key: `month-${monthKey}`,
                    month: MONTHS[moIdx] ?? monthKey,
                });
                lastMonthKey = monthKey;
            }
            out.push({
                kind: 'movement',
                key: m.id,
                date: m.transaction_date,
                particular: m.particular,
                code: m.bag_code,
                qty: m.qty_delta,
            });
        }
        return out;
    }, [movements]);

    // Month range for the summary strip, derived from the first/last movement
    // (movements are ASC). e.g. "Jan–Jul 2026".
    const rangeLabel = useMemo(() => {
        if (movements.length === 0) return '';
        const first = movements[0].transaction_date;
        const last = movements[movements.length - 1].transaction_date;
        const firstMo = MONTHS_SHORT[Number(first.slice(5, 7)) - 1] ?? '';
        const lastMo = MONTHS_SHORT[Number(last.slice(5, 7)) - 1] ?? '';
        const firstYr = first.slice(0, 4);
        const lastYr = last.slice(0, 4);
        if (firstYr === lastYr) {
            return firstMo === lastMo ? `${firstMo} ${firstYr}` : `${firstMo}–${lastMo} ${firstYr}`;
        }
        return `${firstMo} ${firstYr}–${lastMo} ${lastYr}`;
    }, [movements]);

    // Auto-scroll to the BOTTOM on mount — operators check the latest movements.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [rows.length]);

    const hasData = movements.length > 0;
    const nBag = columns.length;

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {/* Inline error banner (in addition to the toast) — persists on screen
                with its own Copy button, per the Error Toasts HARD RULE. */}
            {error ? (
                <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                    <span className="min-w-0 break-words">{error}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 gap-1 px-2 text-xs"
                        onClick={() => navigator.clipboard.writeText(error)}
                    >
                        <Copy className="size-3" />
                        Copy
                    </Button>
                </div>
            ) : null}

            {/* Slim summary strip — the matrix IS the page (no balance cards). */}
            <div className="flex shrink-0 items-baseline gap-2">
                <h2 className="text-sm font-semibold tracking-tight">FLECON Bag Movement</h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                    · {nBag} bag types · {movements.length} movements
                    {rangeLabel ? ` · ${rangeLabel}` : ''}
                </span>
            </div>

            {hasData ? (
                /* Scroll container — BOTH axes scroll; sticky handles the freezing.
                   border-separate + border-spacing:0 is MANDATORY (not border-collapse):
                   under the collapsed border model, sticky cell backgrounds render
                   transparent and scrolling content bleeds through the frozen columns.
                   Cell gridlines are reconstructed per-cell (border-b / border-r). */
                <div
                    ref={scrollRef}
                    className="min-h-0 flex-1 overflow-auto rounded-md border border-border max-h-[calc(100dvh-180px)]"
                >
                    <table
                        className="relative table-fixed text-xs"
                        style={{
                            // Fill the container on a wide monitor; the frozen DATE/PARTICULAR
                            // widths are fixed, and `table-fixed` distributes the leftover width
                            // equally across the 14 unsized bag <col>s. minWidth guarantees a
                            // horizontal scrollbar once the container is narrower than the
                            // columns' minimum (fill-and-scroll, like RC Movement).
                            width: '100%',
                            minWidth: W_DATE + W_PARTICULAR + columns.length * MIN_BAG_W,
                            borderCollapse: 'separate',
                            borderSpacing: 0,
                        }}
                    >
                        <colgroup>
                            <col style={{ width: W_DATE }} />
                            <col style={{ width: W_PARTICULAR }} />
                            {/* Bag <col>s: NO explicit width — table-fixed shares leftover space
                                equally so they stretch to fill on a wide screen. */}
                            {columns.map((c) => (
                                <col key={`col-${c.bagTypeId || c.code}`} />
                            ))}
                        </colgroup>

                        {/* ---- Frozen header row ---- */}
                        <thead>
                            <tr className="h-11">
                                {/* Two frozen-left header cells = CORNERS (.frozen-corner, z30).
                                    PARTICULAR is the LAST frozen-left col → .frozen-edge. */}
                                <FrozenHeaderCell left={LEFT_DATE} width={W_DATE}>
                                    DATE
                                </FrozenHeaderCell>
                                <FrozenHeaderCell
                                    left={LEFT_PARTICULAR}
                                    width={W_PARTICULAR}
                                    className="frozen-edge"
                                >
                                    PARTICULAR
                                </FrozenHeaderCell>
                                {/* Bag-type headers — sticky-TOP only (.frozen-row, z20),
                                    OPAQUE bg-muted. Click-to-edit nickname: shows
                                    `nickname || label`, wraps to two lines at 9px, full
                                    internal label in the native title. */}
                                {columns.map((c) => (
                                    <BagTypeHeaderCell
                                        key={`hd-${c.bagTypeId || c.code}`}
                                        column={c}
                                    />
                                ))}
                            </tr>
                        </thead>

                        <tbody>
                            {/* ---- Forwarded Balance row (top, NOT sticky) ---- */}
                            <tr className="h-8">
                                <FrozenBodyCell left={LEFT_DATE} width={W_DATE} />
                                <FrozenBodyCell
                                    left={LEFT_PARTICULAR}
                                    width={W_PARTICULAR}
                                    className="frozen-edge font-medium text-muted-foreground"
                                >
                                    Forwarded Balance
                                </FrozenBodyCell>
                                {columns.map((c) => (
                                    <td
                                        key={`fwd-${c.bagTypeId || c.code}`}
                                        className="border-b border-r border-border/50 bg-background px-1 py-1 text-right font-mono tabular-nums text-muted-foreground"
                                    >
                                        {fmtInt(c.opening)}
                                    </td>
                                ))}
                            </tr>

                            {/* ---- Body rows (movements + month separators) ---- */}
                            {rows.map((r) => {
                                if (r.kind === 'month') {
                                    // Month separator. DATE + PARTICULAR are frozen → repaint
                                    // the band OPAQUELY (solid bg-muted, NOT /opacity) so the
                                    // scrolling cells don't bleed through; the 14 bag columns
                                    // share one colSpan band.
                                    return (
                                        <tr key={r.key} className="h-7">
                                            <td
                                                className="frozen-col border-y border-r border-border bg-muted px-2 py-1"
                                                style={{ left: LEFT_DATE, width: W_DATE }}
                                            />
                                            <td
                                                className="frozen-col frozen-edge border-y border-border bg-muted px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                                                style={{ left: LEFT_PARTICULAR, width: W_PARTICULAR }}
                                            >
                                                {r.month}
                                            </td>
                                            <td
                                                colSpan={nBag}
                                                className="border-y border-border/50 bg-muted px-1 py-1"
                                            />
                                        </tr>
                                    );
                                }
                                // Movement row — signed qty in the ONE intersecting bag column.
                                return (
                                    <tr
                                        key={r.key}
                                        className="group h-8 transition-all duration-150"
                                    >
                                        <FrozenBodyCell
                                            left={LEFT_DATE}
                                            width={W_DATE}
                                            title={r.date}
                                            className="font-mono tabular-nums group-hover:bg-muted"
                                        >
                                            {/* MM-dd (slice — no date-fns); full yyyy-MM-dd in title. */}
                                            {r.date.slice(5)}
                                        </FrozenBodyCell>
                                        <FrozenBodyCell
                                            left={LEFT_PARTICULAR}
                                            width={W_PARTICULAR}
                                            title={r.particular}
                                            className="frozen-edge max-w-[200px] truncate group-hover:bg-muted"
                                        >
                                            {r.particular}
                                        </FrozenBodyCell>
                                        {columns.map((c) => {
                                            const q = c.code === r.code ? r.qty : undefined;
                                            return (
                                                <td
                                                    key={`bd-${r.key}-${c.bagTypeId || c.code}`}
                                                    className="border-b border-r border-border/50 px-1 py-1 text-right font-mono tabular-nums group-hover:bg-muted/50"
                                                >
                                                    <SignedQty q={q} />
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>

                        {/* ---- Frozen footer — Current Balance (SQL-computed) ----
                            Mirror of the frozen header, pinned to the container bottom. The
                            two cells under the frozen-left columns are BOTH sticky-left and
                            sticky-bottom (.frozen-corner-bottom, z30); the per-type cells are
                            sticky-bottom only (.frozen-row-bottom, z20). frozen-edge-top kills
                            the top seam; PARTICULAR's corner also carries .frozen-edge for the
                            vertical seam. All OPAQUE bg-muted — never glass. */}
                        <tfoot>
                            <tr className="h-9">
                                <FrozenFooterCell left={LEFT_DATE} width={W_DATE} />
                                <FrozenFooterCell
                                    left={LEFT_PARTICULAR}
                                    width={W_PARTICULAR}
                                    className="frozen-edge text-[11px] font-semibold uppercase tracking-wide"
                                >
                                    Current Balance
                                </FrozenFooterCell>
                                {columns.map((c) => (
                                    <td
                                        key={`ft-${c.bagTypeId || c.code}`}
                                        title={`${c.label}: ${c.balance.toLocaleString('en-US')}`}
                                        className={cn(
                                            'frozen-row-bottom frozen-edge-top border-r border-border/50 bg-muted px-1 py-1 text-right font-mono font-bold tabular-nums',
                                            c.balance < 0 && 'text-red-600 dark:text-red-400',
                                        )}
                                    >
                                        {c.balance.toLocaleString('en-US')}
                                    </td>
                                ))}
                            </tr>
                        </tfoot>
                    </table>
                </div>
            ) : (
                /* Empty-ledger state — the matrix needs movements. Centered muted panel. */
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-border animate-fade-up">
                    <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
                        No bag movements recorded yet — the daily FLECON BAGGED sync will
                        populate this matrix.
                    </p>
                </div>
            )}
        </div>
    );
}
