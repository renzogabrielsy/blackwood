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
// ── What is typable, and what is not ────────────────────────────────────────────
//   typed:   date · prod · shift · grade · whse · side · bags · src · mach · wt
//   derived: PLANT  — `cenapro_add_partner_draw` derives it from the source
//                     (TNK 1–4→W6, W7→W7, W6→W6, FLEC→null). Typing it would let the
//                     caller contradict the RPC, and for a tank draw the plant IS the
//                     sample group's warehouse key, so a wrong one files the row into a
//                     phantom group. Shown as a live preview instead.
//   later:   BD/ASH/GRIT/MC — a lab reading belongs to a sample GROUP, which does not
//                     exist until the draw is saved. The cells go live on the saved row.
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
import { Check, Loader2, Trash2, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AddQcDrawInput } from './actions';
import type { QcDrawOptions } from './data';

/** How a draft row is doing. `saved` rows are dropped on the next refresh. */
export type DraftStatus = 'draft' | 'saving' | 'saved' | 'failed';

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
    status: DraftStatus;
    /** The server's own message on a refusal — never a re-worded one. */
    message?: string;
    /** Set by a `duplicate_warning`; the re-send carries `allowDuplicate`. */
    needsDuplicateConfirm?: boolean;
}

let draftSeq = 0;

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

/**
 * Has anything been typed into this row beyond the date it was born with?
 *
 * This is what stops ten untouched blanks from being ten validation errors on save. It
 * deliberately ignores `recvDate`: every blank arrives already dated, so counting it
 * would make every blank look meaningful.
 */
export function isMeaningfulDraft(d: DraftDraw): boolean {
    return Boolean(
        d.prodDate || d.shift || d.grade || d.whse || d.side || d.bags || d.src || d.mach || d.wt,
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

/** Everything the server action needs, straight from what was typed. */
export function draftToInput(d: DraftDraw, allowDuplicate = false): AddQcDrawInput {
    return {
        recvDate: d.recvDate.trim(),
        sourceLocationCode: d.src,
        partnerEquipmentCode: d.mach,
        gradeCode: d.grade,
        shiftCode: d.shift,
        weightRaw: d.wt,
        prodDate: d.prodDate.trim() || null,
        warehouseCode: d.whse || null,
        flecCountRaw: d.bags || null,
        whseSide: d.side || null,
        allowDuplicate,
    };
}

/**
 * The ONE client-side check, and it is a courtesy, not the authority: it names the field
 * that is obviously missing so the operator is not made to round-trip for it. Everything
 * that gets through is judged by `addPartnerDraw` and by the RPC underneath it, and their
 * message is what gets rendered.
 */
export function draftBlocker(d: DraftDraw): string | null {
    if (!d.recvDate.trim()) return 'needs a date';
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
    return null;
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
    disabled?: boolean;
    /** A `<datalist>` of suggestions — type freely OR pick, exactly like Excel. */
    options?: readonly string[];
    listId?: string;
    upper?: boolean;
    numeric?: boolean;
    type?: 'text' | 'date';
    placeholder?: string;
    title?: string;
}

function DraftCell({
    value,
    onChange,
    disabled,
    options,
    listId,
    upper,
    numeric,
    type = 'text',
    placeholder,
    title,
}: DraftCellProps) {
    return (
        <td className={CELL} title={title}>
            <input
                type={type}
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                list={options && listId ? listId : undefined}
                onChange={(e) => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
                className={cn(INPUT, numeric && 'text-right font-mono tabular-nums', upper && 'uppercase')}
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

/** An inert cell on a draft row — derived, or not yet applicable. */
function DeadCell({ children, title }: { children?: React.ReactNode; title?: string }) {
    return (
        <td
            className={cn(CELL, 'px-1 text-center text-[11px] text-muted-foreground/50')}
            title={title}
        >
            {children ?? '—'}
        </td>
    );
}

export interface DraftRowProps {
    draft: DraftDraw;
    options: QcDrawOptions;
    metricCount: number;
    onChange: (id: string, patch: Partial<DraftDraw>) => void;
    onRemove: (id: string) => void;
}

/**
 * One draft `<tr>`. Column order MUST track `COLS` in `qc-ledger-client.tsx`:
 *   date · prod · shift · grade · plant · whse · side · bags · src · mach · wt · 4 metrics
 */
export function DraftRow({ draft, options, metricCount, onChange, onRemove }: DraftRowProps) {
    const set = (patch: Partial<DraftDraw>) => onChange(draft.id, patch);
    const busy = draft.status === 'saving';
    const machines = React.useMemo(
        () => [...options.crushers, ...options.kilns],
        [options.crushers, options.kilns],
    );
    const plant = derivedPlant(draft.src);
    const isFlec = draft.src.trim().toUpperCase() === 'FLEC';
    const blocker = isMeaningfulDraft(draft) ? draftBlocker(draft) : null;

    return (
        <tr
            className={cn(
                'h-7',
                draft.status === 'failed'
                    ? 'bg-rose-500/5'
                    : draft.status === 'saved'
                      ? 'bg-emerald-500/5'
                      : 'bg-primary/[0.03]',
            )}
            data-draft-id={draft.id}
        >
            <DraftCell
                type="date"
                value={draft.recvDate}
                onChange={(v) => set({ recvDate: v })}
                disabled={busy}
                title="Receipt date at CCC"
            />
            <DraftCell
                type="date"
                value={draft.prodDate}
                onChange={(v) => set({ prodDate: v })}
                disabled={busy}
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
            {/* PLANT is derived by the RPC, never typed — shown live so the row is honest. */}
            <DeadCell title="Derived from the source by the database — not typed">
                {plant || '—'}
            </DeadCell>
            <DraftCell
                value={draft.whse}
                onChange={(v) => set({ whse: v })}
                disabled={busy || !isFlec}
                options={options.warehouses}
                listId={`qc-whse-${draft.id}`}
                upper
                title={isFlec ? 'Required on a FLEC draw' : 'FLEC draws only'}
            />
            <DraftCell
                value={draft.side}
                onChange={(v) => set({ side: v })}
                disabled={busy || !isFlec}
                options={options.sides}
                listId={`qc-sides-${draft.id}`}
                upper
                title={
                    isFlec
                        ? 'Optional — but the flec ledger only counts sided rows, so an unsided draw will not move the LS/RS balance'
                        : 'FLEC draws only'
                }
            />
            <DraftCell
                value={draft.bags}
                onChange={(v) => set({ bags: v })}
                disabled={busy || !isFlec}
                numeric
                title={isFlec ? 'Required on a FLEC draw — whole bags' : 'FLEC draws only'}
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

            {/* The four analysis cells belong to a sample GROUP that does not exist until
                this row is saved. They go live on the saved row. The first one carries the
                row's status so a refusal is read where the eye already is. */}
            <td
                colSpan={metricCount}
                className={cn(CELL, 'px-2 text-[11px]')}
                title={
                    draft.message ??
                    'Lab readings are entered on the saved row — a reading covers the whole sample group'
                }
            >
                <span className="flex items-center justify-between gap-2">
                    <span
                        className={cn(
                            'truncate',
                            draft.status === 'failed'
                                ? 'text-rose-600 dark:text-rose-400'
                                : draft.status === 'saved'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : blocker
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-muted-foreground/60',
                        )}
                    >
                        {draft.status === 'saving' ? (
                            <span className="inline-flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" /> saving…
                            </span>
                        ) : draft.status === 'saved' ? (
                            <span className="inline-flex items-center gap-1">
                                <Check className="h-3 w-3" /> saved
                            </span>
                        ) : draft.status === 'failed' ? (
                            <span className="inline-flex items-center gap-1">
                                <TriangleAlert className="h-3 w-3 shrink-0" />
                                {draft.message ?? 'could not save'}
                            </span>
                        ) : blocker ? (
                            blocker
                        ) : (
                            'lab readings go on the saved row'
                        )}
                    </span>
                    <button
                        type="button"
                        onClick={() => onRemove(draft.id)}
                        disabled={busy}
                        title="Remove this row"
                        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                        <Trash2 className="h-3 w-3" />
                    </button>
                </span>
            </td>
        </tr>
    );
}
