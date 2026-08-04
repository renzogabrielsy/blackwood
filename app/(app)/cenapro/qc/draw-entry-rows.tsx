'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// draw-entry-rows.tsx — typing a partner draw INSIDE the ledger (2026-08-04).
//
// This replaced `add-draw-panel.tsx`, a 955-line docked composer. Renzo, on seeing it:
// *"I don't like it in general. When we do add draw, it should create 10 new empty rows
// underneath the latest row. It should act like an excel sheet where we can input
// whatever on the new empty rows."*
//
// The composer was a form that produced rows. This is the rows. A slip is transcribed by
// reading down it, and a grid you type straight into matches that; a form beside the grid
// makes you look in two places and re-read where you were after every line.
//
// ── What is typable, and what is not (revised 2026-08-04, second pass) ──────────
// Renzo: *"when doing in add draw, i want all the cells to be editable. Same behavior as
// production ledger. Currently its blocking me from manipulating certain columns."*
//
//   typed:   date · prod · shift · grade · whse · side · bags · src · mach · wt
//            · BD · ASH · GRIT · MC
//   derived: PLANT — and ONLY plant. `cenapro_add_partner_draw` has no `p_plant`
//            parameter at all: it derives the plant from the source (TNK 1–4→W6,
//            W7→W7, W6→W6, FLEC→none), and for a tank draw the plant IS the sample
//            group's warehouse key, so a typed-wrong one would file the row into a
//            phantom group. The cell renders the live derivation, muted, and hosts the
//            row's remove control — computed, not locked.
//
// WHSE / SIDE / BAGS were disabled until SRC read `FLEC`. That was a pure UI gate with
// nothing behind it — the RPC takes all three directly and `draftBlocker` (plus the
// server, plus the RPC) already refuses them on a non-FLEC row. Worse, they sit BEFORE
// SRC in the column order, so typing down a row left-to-right was impossible: you had to
// tab past three dead cells, type the source, and come back. They are ordinary cells now
// and the refusal is a message, not a lock.
//
// BD/ASH/GRIT/MC used to be one `colSpan` status cell, because a lab reading belongs to a
// sample GROUP which does not exist until the draw is saved. They are typable now and the
// SEQUENCING moved server-side: `addQcDraws` inserts the draw, reads the sample group the
// RPC says it landed in, and applies the reading to THAT group. Two drafts landing in one
// group with different numbers is a genuine conflict — named and refused, never merged.
//
// ── Why inputs, not the grid's coordinate nav ───────────────────────────────────
// The saved rows run `createQcNavResolver`, a per-CELL coordinate space with a genuine
// asymmetry (WT lives on every row; the four metrics live only on a group's LEAD row and
// have no coordinate at all on a `〃` sibling). Draft rows have neither groups nor
// siblings, so folding them into that space would mean a second row-kind threaded through
// every branch of the resolver. Plain inputs with native Tab order give the same
// type-and-tab feel for a tenth of the risk — the same choice
// `production/draft-entry-zone.tsx` made, and the ledger Renzo pointed at.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Check, Loader2, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
    METRICS,
    METRIC_SHORT,
    canonToken,
    parseMetricValue,
    parseQcDate,
    sampleGroupKey,
    type MetricKey,
} from '@/lib/cenapro/ccc-analysis';
import type { AddQcDrawInput } from './actions';
import type { QcDrawOptions } from './data';

/**
 * How many columns a draft row spans — `date · prod · shift · grade · plant · whse ·
 * side · bags · src · mach · wt` plus the four metrics. It MUST equal `COLS.length` in
 * `qc-ledger-client.tsx`; `scripts/verify-qc-draw-cells.ts` asserts that it does, since
 * a drift here silently misaligns the status line under the row it belongs to.
 */
export const COL_COUNT = 11 + METRICS.length;

/** How a draft row is doing. `saved` rows are dropped on the next refresh. */
export type DraftStatus = 'draft' | 'saving' | 'saved' | 'failed';

/** The four lab cells on a draft row, held as the raw text that was typed. */
export type DraftMetrics = Record<MetricKey, string>;

/** One typed line of a partner's slip. Everything is RAW TEXT — the server parses. */
export interface DraftDraw {
    /** Client-only id. The join key for a per-row verdict; never sent to the DB. */
    id: string;
    /**
     * WHICH day block this row renders in — fixed when the row is created, and never
     * again. Deliberately NOT `recvDate`: the date is typable, so keying the layout off
     * it would make a row jump to another block (or vanish into a block that does not
     * exist) between two keystrokes of retyping it. `null` = the trailing block under
     * the whole month, which is where the toolbar's ten blanks land.
     */
    anchorDate: string | null;
    recvDate: string;
    prodDate: string;
    shift: string;
    grade: string;
    whse: string;
    side: string;
    bags: string;
    src: string;
    mach: string;
    wt: string;
    /** BD · ASH · GRIT · MC, as typed. Applied to the sample group the draw lands in. */
    metrics: DraftMetrics;
    status: DraftStatus;
    /** The server's own message on a refusal — never a re-worded one. */
    message?: string;
    /** Set by a `duplicate_warning`; the re-send carries `allowDuplicate`. */
    needsDuplicateConfirm?: boolean;
    /**
     * The DRAW landed but the reading typed beside it did not — a same-group
     * disagreement, or a version conflict on the group. The row stays on screen so the
     * numbers are not thrown away with it, and it is NEVER sent again: re-sending would
     * file the receipt a second time. `isSendableDraft` is what enforces that.
     */
    drawSaved?: boolean;
}

let draftSeq = 0;

const BLANK_METRICS: DraftMetrics = { bd: '', ash: '', grit: '', mc: '' };

/** A blank row, pre-dated to the day it was added under. */
export function makeBlankDraft(recvDate: string, anchorDate: string | null = null): DraftDraw {
    draftSeq += 1;
    return {
        id: `draft-${draftSeq}`,
        anchorDate,
        recvDate,
        prodDate: '',
        shift: '',
        grade: '',
        whse: '',
        side: '',
        bags: '',
        src: '',
        mach: '',
        wt: '',
        metrics: { ...BLANK_METRICS },
        status: 'draft',
    };
}

/** `n` blank rows in one go — what the "Add draw" button hands you. */
export function makeBlankDrafts(
    count: number,
    recvDate: string,
    anchorDate: string | null = null,
): DraftDraw[] {
    return Array.from({ length: count }, () => makeBlankDraft(recvDate, anchorDate));
}

/** The metric cells with something in them, or `undefined` when the row says nothing. */
export function draftMetrics(d: DraftDraw): Partial<Record<MetricKey, string>> | undefined {
    const out: Partial<Record<MetricKey, string>> = {};
    let any = false;
    for (const metric of METRICS) {
        const raw = d.metrics[metric]?.trim() ?? '';
        if (!raw) continue;
        out[metric] = raw;
        any = true;
    }
    return any ? out : undefined;
}

/**
 * Has anything been typed into this row beyond the date it was born with?
 *
 * This is what stops ten untouched blanks from being ten validation errors on save. It
 * deliberately ignores `recvDate`: every blank arrives already dated, so counting it
 * would make every blank look meaningful.
 */
export function isMeaningfulDraft(d: DraftDraw): boolean {
    return Boolean(
        d.prodDate ||
            d.shift ||
            d.grade ||
            d.whse ||
            d.side ||
            d.bags ||
            d.src ||
            d.mach ||
            d.wt ||
            draftMetrics(d),
    );
}

/**
 * Would this row be SENT by the next Save? The one predicate both the count on the Save
 * button and the payload builder use, so the button can never promise a row the payload
 * drops. Excludes untouched blanks (scaffolding), rows the courtesy check refuses, and —
 * critically — rows whose draw is already filed.
 */
export function isSendableDraft(d: DraftDraw, contextYear: number): boolean {
    return (
        d.status !== 'saved' &&
        d.drawSaved !== true &&
        isMeaningfulDraft(d) &&
        draftBlocker(d, contextYear) === null
    );
}

/** The PLANT the RPC will derive from this row's source (CENAPRO_SCHEMA §8.2). */
export function derivedPlant(src: string): string {
    const s = src.trim().toUpperCase();
    if (s.startsWith('TNK')) return 'W6';
    if (s === 'W7') return 'W7';
    if (s === 'W6') return 'W6';
    return ''; // FLEC (and anything unrecognized) carries no plant.
}

/**
 * Everything the server action needs, straight from what was typed — with the two date
 * cells normalized to `yyyy-MM-dd` on the way out.
 *
 * The normalization is here as well as on the cell's blur because a row can be saved
 * from a focused cell (click Save with the caret still in the date), and the RPC takes a
 * `date`: an un-normalized `6/27` would come back as a Postgres cast error about a cell
 * the UI had already accepted. An unparseable date is refused by `draftBlocker` before
 * this is ever called, so the fallback below is only ever the operator's own text.
 */
export function draftToInput(d: DraftDraw, contextYear: number, allowDuplicate = false): AddQcDrawInput {
    const recv = parseQcDate(d.recvDate, contextYear);
    const prodRaw = d.prodDate.trim();
    const prod = prodRaw ? parseQcDate(prodRaw, contextYear) : null;
    return {
        recvDate: 'iso' in recv ? recv.iso : d.recvDate.trim(),
        sourceLocationCode: d.src,
        partnerEquipmentCode: d.mach,
        gradeCode: d.grade,
        shiftCode: d.shift,
        weightRaw: d.wt,
        prodDate: prod ? ('iso' in prod ? prod.iso : prodRaw) : null,
        warehouseCode: d.whse || null,
        flecCountRaw: d.bags || null,
        whseSide: d.side || null,
        allowDuplicate,
    };
}

/**
 * The ONE client-side check, and it is a courtesy, not the authority: it names the field
 * that is obviously missing or unreadable so the operator is not made to round-trip for
 * it. Everything that gets through is judged by `addPartnerDraw` and by the RPC
 * underneath it, and their message is what gets rendered.
 *
 * `contextYear` is what a bare `6/27` means — the focused month's year.
 */
export function draftBlocker(d: DraftDraw, contextYear: number): string | null {
    if (!d.recvDate.trim()) return 'needs a date';
    const recv = parseQcDate(d.recvDate, contextYear);
    if ('error' in recv) return recv.error;
    if (d.prodDate.trim()) {
        const prod = parseQcDate(d.prodDate, contextYear);
        if ('error' in prod) return prod.error;
        if (prod.iso > recv.iso) return 'the production date cannot be after the receipt date';
    }
    if (!d.src.trim()) return 'needs a source';
    if (!d.mach.trim()) return 'needs a machine';
    if (!d.grade.trim()) return 'needs a grade';
    if (!d.shift.trim()) return 'needs a shift';
    if (!d.wt.trim()) return 'needs a weight';
    if (d.src.trim().toUpperCase() === 'FLEC') {
        if (!d.whse.trim()) return 'a FLEC draw needs a warehouse';
        if (!d.bags.trim()) return 'a FLEC draw needs a bag count';
    } else if (d.whse.trim() || d.bags.trim() || d.side.trim()) {
        return `a ${d.src.trim().toUpperCase()} draw carries no warehouse, bags or side`;
    }
    for (const metric of METRICS) {
        const { error } = parseMetricValue(metric, d.metrics[metric] ?? '');
        if (error) return error;
    }
    return null;
}

// ── Two drafts, one sample group, two different readings ─────────────────────────
//
// A lab reading covers a whole sample GROUP — every draw from the same source and
// warehouse on the same day. So two typed rows can perfectly legitimately land in one
// group, and if both carry a reading they had better agree. If they do not, there is no
// correct answer available to a machine: last-write-wins would silently pick one, and
// the operator would never learn that the other number was thrown away.
//
// The key below MIRRORS the RPC's derivation (`whse_key = coalesce(warehouse_code,
// plant_code)`, plant from the source) using the same `derivedPlant` the PLANT cell
// already previews with. It is used ONLY to refuse — never to write, and never sent to
// the server, which re-derives the truth from each insert's own returned `sample_group`.
// A mirror that drifts can therefore cost a spurious refusal or a missed one, never a
// wrong value: `addQcDraws` runs the same check over the RPC's own answer.

/** The sample group this row would land in, or `null` while it is too blank to say. */
export function draftGroupKey(d: DraftDraw, contextYear: number): string | null {
    const recv = parseQcDate(d.recvDate, contextYear);
    if ('error' in recv) return null;
    const src = canonToken(d.src);
    if (!src) return null;
    return sampleGroupKey({
        sample_date: recv.iso,
        source_location_code: src,
        // `coalesce(nullif(canon(warehouse), ''), plant)` — a whitespace-only warehouse
        // cell canonicalizes to '' and must fall through to the plant, exactly as the
        // RPC's own `nullif` does.
        whse_key: canonToken(d.whse) || canonToken(derivedPlant(d.src)),
    });
}

export interface DraftReadingConflict {
    groupKey: string;
    /** `2026-06-27 · TNK 1 · W6` — what the operator sees in the row. */
    label: string;
    /** Which metric they disagree about, and the two values. */
    metric: MetricKey;
    values: string[];
    /** Every draft id in the conflicting group — all of them get the rail. */
    rowIds: string[];
}

/**
 * Every group where two typed rows disagree about one metric. A group where one row
 * gives BD and another gives MC is NOT a conflict — that is a union, and it is how a
 * slip that splits the analysis across lines is meant to read. Only the same metric with
 * two different numbers is unanswerable.
 */
export function findDraftReadingConflicts(
    drafts: DraftDraw[],
    contextYear: number,
): DraftReadingConflict[] {
    const buckets = new Map<string, { label: string; rows: DraftDraw[] }>();
    for (const d of drafts) {
        // A row already filed is not part of the next save, so it cannot conflict with
        // one — its refusal is already written on it.
        if (d.status === 'saved' || d.drawSaved || !draftMetrics(d)) continue;
        const key = draftGroupKey(d, contextYear);
        if (!key) continue;
        const bucket = buckets.get(key) ?? {
            label: key.split('|').filter(Boolean).join(' · '),
            rows: [],
        };
        bucket.rows.push(d);
        buckets.set(key, bucket);
    }

    const conflicts: DraftReadingConflict[] = [];
    for (const [groupKey, { label, rows }] of buckets) {
        if (rows.length < 2) continue;
        for (const metric of METRICS) {
            const seen = new Map<number, string>();
            for (const row of rows) {
                const { value } = parseMetricValue(metric, row.metrics[metric] ?? '');
                if (value == null) continue;
                if (!seen.has(value)) seen.set(value, row.metrics[metric].trim());
            }
            if (seen.size > 1) {
                conflicts.push({
                    groupKey,
                    label,
                    metric,
                    values: [...seen.values()],
                    rowIds: rows.map((r) => r.id),
                });
                break; // One sentence per group is enough to act on.
            }
        }
    }
    return conflicts;
}

// ── Cell chrome ──────────────────────────────────────────────────────────────────

const CELL = 'border-r border-border/40 p-0 align-middle';
const INPUT =
    'h-7 w-full rounded-none border-transparent bg-transparent px-1 text-[11px] shadow-none ' +
    'outline-none transition-colors focus:bg-primary/5 focus:ring-1 focus:ring-inset focus:ring-primary ' +
    'disabled:cursor-not-allowed disabled:opacity-60';

interface DraftCellProps {
    value: string;
    onChange: (next: string) => void;
    /** Only ever true while this row is IN FLIGHT — never a permanent lock. */
    disabled?: boolean;
    /** A `<datalist>` of suggestions — type freely OR pick, exactly like Excel. */
    options?: readonly string[];
    listId?: string;
    upper?: boolean;
    numeric?: boolean;
    /** Tabular text that is not a number — a date. Excel Standard: `font-mono`. */
    mono?: boolean;
    placeholder?: string;
    title?: string;
    /** Cell-level tint (the metric block reads as its own family, as on saved rows). */
    className?: string;
    /** Fired on blur and on Enter — where a typed date becomes `yyyy-MM-dd`. */
    onCommit?: () => void;
}

function DraftCell({
    value,
    onChange,
    disabled,
    options,
    listId,
    upper,
    numeric,
    mono,
    placeholder,
    title,
    className,
    onCommit,
}: DraftCellProps) {
    return (
        <td className={cn(CELL, className)} title={title}>
            <input
                type="text"
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                list={options && listId ? listId : undefined}
                onChange={(e) => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
                onBlur={onCommit}
                onKeyDown={
                    onCommit
                        ? (e) => {
                              if (e.key === 'Enter') onCommit();
                          }
                        : undefined
                }
                className={cn(
                    INPUT,
                    numeric && 'text-right font-mono tabular-nums',
                    mono && 'font-mono tabular-nums',
                    upper && 'uppercase',
                )}
            />
            {options && listId ? (
                <datalist id={listId}>
                    {options.map((o) => (
                        <option key={o} value={o} />
                    ))}
                </datalist>
            ) : null}
        </td>
    );
}

export interface DraftRowProps {
    draft: DraftDraw;
    options: QcDrawOptions;
    /** What a bare `6/27` means in this ledger — the focused month's year. */
    contextYear: number;
    /** Set when this row is one side of a same-group reading disagreement. */
    conflict?: string;
    onChange: (id: string, patch: Partial<DraftDraw>) => void;
    onRemove: (id: string) => void;
}

/**
 * One draft row. Column order MUST track `COLS` in `qc-ledger-client.tsx`:
 *   date · prod · shift · grade · plant · whse · side · bags · src · mach · wt
 *   · bd · ash · grit · mc
 *
 * Renders as a fragment of ONE data `<tr>` plus — only when the row has something to say
 * — a full-width status `<tr>` under it. The status used to live in the `colSpan` cell
 * the four metrics now occupy; it needed a home that costs no column and hides no
 * refusal, and a line that appears under the row it is about is the one place an
 * operator is already looking. An untouched blank says nothing and gets no second row,
 * so ten waiting blanks are still ten rows.
 */
export function DraftRow({ draft, options, contextYear, conflict, onChange, onRemove }: DraftRowProps) {
    const set = (patch: Partial<DraftDraw>) => onChange(draft.id, patch);
    const setMetric = (metric: MetricKey, value: string) =>
        onChange(draft.id, { metrics: { ...draft.metrics, [metric]: value } });
    const busy = draft.status === 'saving';
    const machines = React.useMemo(
        () => [...options.crushers, ...options.kilns],
        [options.crushers, options.kilns],
    );
    const plant = derivedPlant(draft.src);
    const meaningful = isMeaningfulDraft(draft);
    const blocker = meaningful ? draftBlocker(draft, contextYear) : null;
    const failed = draft.status === 'failed';

    /** Normalize a typed date cell in place. An unreadable one is LEFT AS TYPED. */
    const commitDate = (field: 'recvDate' | 'prodDate') => {
        const raw = draft[field].trim();
        if (!raw) {
            if (draft[field] !== '') set({ [field]: '' } as Partial<DraftDraw>);
            return;
        }
        const parsed = parseQcDate(raw, contextYear);
        // A date we cannot read stays exactly as the operator typed it — `draftBlocker`
        // names it, and Save refuses the row. Never a silently corrected wrong date.
        if ('iso' in parsed && parsed.iso !== draft[field]) {
            set({ [field]: parsed.iso } as Partial<DraftDraw>);
        }
    };

    const statusText =
        draft.status === 'failed'
            ? (draft.message ?? 'could not save')
            : conflict
              ? conflict
              : blocker;
    const showStatus = busy || draft.status === 'saved' || Boolean(statusText);

    return (
        <>
            <tr
                className={cn(
                    'h-7',
                    failed || conflict
                        ? 'bg-rose-500/5'
                        : draft.status === 'saved'
                          ? 'bg-emerald-500/5'
                          : 'bg-primary/[0.03]',
                )}
                data-draft-id={draft.id}
                // ── The draft row's keyboard is ITS OWN ───────────────────────────
                // Draft rows live inside the grid's scrollport, and that div carries
                // `useGridKeyboardNav`'s `handleKeyDown`. That handler bails only when
                // NOTHING is selected — so with a saved cell selected (the normal state
                // the moment anyone clicks a WT or a metric), every keystroke typed into
                // a draft input also bubbled into the saved-cell state machine: Tab was
                // preventDefault-ed and rerouted into the coordinate space (which is
                // precisely the "I can't type across the row" complaint), and a printable
                // character opened an editor on the SAVED cell and typed into it.
                //
                // Draft rows deliberately use plain inputs with native Tab order, so the
                // fix belongs here rather than in the shared hook or the saved-row model:
                // their keys never leave the row.
                onKeyDown={(e) => e.stopPropagation()}
            >
                <DraftCell
                    value={draft.recvDate}
                    onChange={(v) => set({ recvDate: v })}
                    onCommit={() => commitDate('recvDate')}
                    disabled={busy}
                    placeholder="6/27"
                    mono
                    title="Receipt date at CCC — type 6/27, 6/27/26, 2026-06-27 or 27 Jun 26"
                />
                <DraftCell
                    value={draft.prodDate}
                    onChange={(v) => set({ prodDate: v })}
                    onCommit={() => commitDate('prodDate')}
                    disabled={busy}
                    placeholder="—"
                    mono
                    title="Production date (optional) — cannot be after the receipt date"
                />
                <DraftCell
                    value={draft.shift}
                    onChange={(v) => set({ shift: v })}
                    disabled={busy}
                    options={options.shifts}
                    listId={`qc-shifts-${draft.id}`}
                    upper
                />
                <DraftCell
                    value={draft.grade}
                    onChange={(v) => set({ grade: v })}
                    disabled={busy}
                    options={options.grades}
                    listId={`qc-grades-${draft.id}`}
                    upper
                />

                {/* PLANT — the one cell that is not typed, because the RPC has no
                    parameter for it: it derives the plant from the source, and for a
                    tank draw that plant IS the sample group's warehouse key. Rendered as
                    a live computation (muted, on the summary-row grey) rather than a
                    greyed-out input, and it hosts this row's remove control — the only
                    cell in the row with room for one. */}
                <td
                    className={cn(CELL, 'bg-muted/40 px-1')}
                    title="Computed from SRC by the database — TNK→W6, W7→W7, W6→W6, FLEC→none. There is no plant to type."
                >
                    <span className="flex items-center justify-between gap-0.5">
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {plant || '—'}
                        </span>
                        <button
                            type="button"
                            onClick={() => onRemove(draft.id)}
                            disabled={busy}
                            title="Remove this row"
                            aria-label="Remove this draft row"
                            className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </span>
                </td>

                <DraftCell
                    value={draft.whse}
                    onChange={(v) => set({ whse: v })}
                    disabled={busy}
                    options={options.warehouses}
                    listId={`qc-whse-${draft.id}`}
                    upper
                    title="Warehouse the bags came out of — required on a FLEC draw, refused on any other source"
                />
                <DraftCell
                    value={draft.side}
                    onChange={(v) => set({ side: v })}
                    disabled={busy}
                    options={options.sides}
                    listId={`qc-sides-${draft.id}`}
                    upper
                    title="Warehouse side (LS / RS) — FLEC draws only, and optional there, but the flec ledger only counts sided rows"
                />
                <DraftCell
                    value={draft.bags}
                    onChange={(v) => set({ bags: v })}
                    disabled={busy}
                    numeric
                    title="Whole flec bags — required on a FLEC draw, refused on any other source"
                />
                <DraftCell
                    value={draft.src}
                    onChange={(v) => set({ src: v })}
                    disabled={busy}
                    options={options.sources}
                    listId={`qc-src-${draft.id}`}
                    upper
                />
                <DraftCell
                    value={draft.mach}
                    onChange={(v) => set({ mach: v })}
                    disabled={busy}
                    options={machines}
                    listId={`qc-mach-${draft.id}`}
                    upper
                    title="C1–C4 (crusher) or RK1–RK4 (kiln) — this alone decides the disposition"
                />
                <DraftCell
                    value={draft.wt}
                    onChange={(v) => set({ wt: v })}
                    disabled={busy}
                    numeric
                    title="Weight in kilograms"
                />

                {/* The four analysis cells. A reading covers the whole sample GROUP this
                    draw lands in, so it is applied AFTER the draw saves, against the
                    group identity the RPC itself reports — see `addQcDraws`. Leave them
                    blank on every row but the one you read the analysis off. */}
                {METRICS.map((metric) => (
                    <DraftCell
                        key={metric}
                        value={draft.metrics[metric] ?? ''}
                        onChange={(v) => setMetric(metric, v)}
                        disabled={busy}
                        numeric
                        placeholder={METRIC_SHORT[metric]}
                        className="bg-sky-500/5"
                        title={`${METRIC_SHORT[metric]} — saved onto the sample group this draw joins, once the draw itself is in`}
                    />
                ))}
            </tr>

            {showStatus ? (
                <tr
                    className={cn(
                        failed || conflict ? 'bg-rose-500/5' : draft.status === 'saved' ? 'bg-emerald-500/5' : 'bg-primary/[0.03]',
                    )}
                >
                    <td
                        colSpan={COL_COUNT}
                        className={cn(
                            'border-x border-b border-border/40 px-2 pb-1 text-[10px] leading-tight',
                            failed || conflict
                                ? 'text-rose-600 dark:text-rose-400'
                                : draft.status === 'saved'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-amber-600 dark:text-amber-400',
                        )}
                    >
                        {busy ? (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" /> saving…
                            </span>
                        ) : draft.status === 'saved' ? (
                            <span className="inline-flex items-center gap-1">
                                <Check className="h-3 w-3" /> saved
                            </span>
                        ) : (
                            <span className="inline-flex items-start gap-1">
                                <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                                <span>{statusText}</span>
                            </span>
                        )}
                    </td>
                </tr>
            ) : null}
        </>
    );
}
