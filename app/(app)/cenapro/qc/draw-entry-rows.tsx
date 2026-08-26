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
// ── What is typable (revised 2026-08-04, THIRD pass — everything) ───────────────
// Renzo: *"when doing in add draw, i want all the cells to be editable. Same behavior as
// production ledger. Currently its blocking me from manipulating certain columns."*
//
//   typed: date · prod · shift · grade · PLANT · whse · side · bags · src · mach · wt
//          · BD · ASH · GRIT · MC
//
// PLANT was the last hold-out, on the argument that `cenapro_add_partner_draw` had no
// `p_plant` parameter. Renzo: *"I don't understand how PLANT has to stay this way when
// it's very much typeable in the production ledger?"* He is right — the RPC INSERTs into
// `cenapro.production_event`, the same table and the same column the Production ledger
// writes through an ordinary `SelectCell` dropdown, and this screen transcribes PARTNER
// SLIPS, which can legitimately name a plant the source mapping does not predict. The
// RPC gained `p_plant` on 2026-08-04, so the cell is a dropdown here too — the SAME
// `SelectCell` + `plantBadgeClass` treatment, one colour scheme across both ledgers.
//
// It stays ZERO-EFFORT in the common case: the cell shows the LIVE derivation from SRC
// (ghosted — dashed border, softened, so a derived value never reads as a typed one) and
// nothing is sent for it. Only an explicit pick becomes an override (solid badge), and
// `— follow SRC` puts the cell back to derived, which is exactly the server's
// blank-means-derive rule. Clearing is therefore never "no plant": a phantom sample
// group stays unreachable, which was the real point of the old restriction.
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
import { Check, Info, Loader2, TriangleAlert, X } from 'lucide-react';

import { SelectCell } from '@/components/shared/grid/SelectCell';
import { cn } from '@/lib/utils';
import {
    BAGGING_MACHINE_CODE,
    METRICS,
    METRIC_SHORT,
    canonToken,
    isBaggingMachine,
    parseMetricValue,
    parseQcDate,
    sampleGroupKey,
    type MetricKey,
} from '@/lib/cenapro/ccc-analysis';
// The PLANT badge is the Production ledger's, imported rather than re-styled: the same
// column on the same table must not grow a second colour scheme. It lives in the pure
// `../badges` module (the ledger re-exports it) so borrowing it costs nothing.
import { BADGE_BASE, plantBadgeClass } from '../badges';
import { PLANT_CODES } from '../types';
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
    /**
     * Both date cells start BLANK on every new row (2026-08-04). Renzo: *"when you add
     * draw, leave the new cells in both dates column blank."* Nothing is pre-dated, so
     * a date on a row is always a date someone typed.
     */
    recvDate: string;
    prodDate: string;
    shift: string;
    grade: string;
    /**
     * The PLANT **override**, and only the override — `''` means "follow SRC", exactly
     * as the RPC reads an omitted `p_plant`. The cell displays `effectivePlant()`, so a
     * blank here still renders the derivation; what it never does is send one.
     */
    plant: string;
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
    /**
     * A NON-BLOCKING remark that came back with a SUCCESSFUL write — today the RPC's
     * `plant_notice` (a supplied plant disagreeing with the source) and/or its `notice`
     * (a FLEC draw saved with no LS/RS side). It is informational, needs no answer, and
     * never gates anything; the row simply stays on screen carrying it instead of
     * vanishing with the refresh, so the remark has somewhere to be read.
     */
    notice?: string;
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

/**
 * A genuinely blank row — including BOTH date cells (2026-08-04).
 *
 * `anchorDate` is the ONLY date a blank carries, and it is layout, not data: it decides
 * which day block the row renders in and is never read by the save path. Rows opened
 * from a day header get that day; the toolbar's ten get `null`, the trailing block.
 */
export function makeBlankDraft(anchorDate: string | null = null): DraftDraw {
    draftSeq += 1;
    return {
        id: `draft-${draftSeq}`,
        anchorDate,
        recvDate: '',
        prodDate: '',
        shift: '',
        grade: '',
        plant: '',
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
export function makeBlankDrafts(count: number, anchorDate: string | null = null): DraftDraw[] {
    return Array.from({ length: count }, () => makeBlankDraft(anchorDate));
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
 * Has anything been typed into this row at all?
 *
 * This is what stops ten untouched blanks from being ten validation errors on save.
 *
 * It used to skip `recvDate` deliberately, on the premise that *"every blank arrives
 * already dated, so counting it would make every blank look meaningful"*. **That premise
 * died on 2026-08-04**, when blanks stopped being pre-dated: a date on a row is now
 * always a date someone typed, and skipping it would mean a row with ONLY a date typed
 * into it looked untouched — silently dropped by Save, with no line saying why. So every
 * cell counts now, `recvDate` and the PLANT override included.
 */
export function isMeaningfulDraft(d: DraftDraw): boolean {
    return Boolean(
        d.recvDate.trim() ||
            d.prodDate.trim() ||
            d.shift ||
            d.grade ||
            d.plant ||
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
 * The plant this row would OVERRIDE the derivation with, or `''` for "follow SRC".
 *
 * The one predicate that decides whether `p_plant` is sent, so the cell's styling, the
 * group-key mirror and the payload can never disagree about whether a row is overridden.
 */
export function plantOverride(d: DraftDraw): string {
    return canonToken(d.plant);
}

/** What will actually be STORED as this row's plant — the override, else the derivation. */
export function effectivePlant(d: DraftDraw): string {
    return plantOverride(d) || derivedPlant(d.src);
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
    const input: AddQcDrawInput = {
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
    // ── The plant is sent ONLY when it was actually overridden ────────────────────
    // A derived value must never be echoed back as a supplied one: every row would then
    // return `plant_source: 'supplied'`, and a verdict key that is always the same
    // answers nothing. Blank stays blank all the way down — the server reads an omitted
    // `p_plant` as "follow the source", which is the same rule this cell renders.
    const override = plantOverride(d);
    if (override) input.plant = override;
    return input;
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

    // ── The DIRECTION of the row, and the two rules that follow from it ───────────
    //
    // Since 2026-08-26 the MACH cell decides what KIND of row this is: a crusher or a
    // kiln makes it a DRAW (bags out, when the source is FLEC), and `FLEC` makes it a
    // BAGGING entry (bags in). `isBaggingMachine` is the ONE predicate — shared with
    // `actions.ts` and with the RPC — so a spelling this screen accepts and a spelling
    // the server accepts cannot drift apart.
    const src = d.src.trim().toUpperCase();
    const bagging = isBaggingMachine(d.mach);

    // Out of FLEC and into FLEC at once is a self-loop. Named here only to save the
    // round trip; the RPC refuses it too and ITS sentence is the authority, so this one
    // is deliberately shorter rather than a second, differently-worded explanation.
    if (bagging && src === 'FLEC') {
        return 'a bagging entry cannot also come out of FLEC — name the tank or plant it was bagged from';
    }

    // Bag fields follow the DIRECTION, not the source: a FLEC-sourced draw takes bags
    // OUT and a FLEC-machine entry puts them IN, and `cenapro.flec_ledger` counts either
    // only when the warehouse and the count are both there. Same `needsBagFields`
    // predicate `addPartnerDraw` uses, one layer up.
    //
    // SIDE is deliberately NOT required in either direction — 183 of the 372 historic
    // bagging rows carry none, so demanding one would refuse a shape the ledger has
    // always had. The server returns a non-blocking `notice` instead, and that notice is
    // rendered on the row's status line.
    const needsBags = bagging || src === 'FLEC';
    if (needsBags) {
        if (!d.whse.trim()) {
            return bagging
                ? 'a bagging entry needs the warehouse the bags went into'
                : 'a FLEC draw needs a warehouse';
        }
        if (!d.bags.trim()) {
            return bagging ? 'a bagging entry needs a bag count' : 'a FLEC draw needs a bag count';
        }
    } else if (d.whse.trim() || d.bags.trim() || d.side.trim()) {
        return `a ${src} draw carries no warehouse, bags or side`;
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
// plant_code)`) using the same `effectivePlant` the PLANT cell displays — so an
// OVERRIDDEN plant moves the mirrored group exactly as it moves the stored one, and two
// rows that the server would file apart are not claimed to be one here. It is used ONLY
// to refuse — never to write, and never sent to
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
        // RPC's own `nullif` does. The plant here is the EFFECTIVE one: a typed override
        // is what gets stored, so it is what the group is keyed by.
        whse_key: canonToken(d.whse) || canonToken(effectivePlant(d)),
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

/**
 * The dropdown's "put it back to derived" item.
 *
 * It is an OPTION rather than `SelectCell`'s built-in `nullable` because that item reads
 * "— None", and none is precisely what this cell must never mean: a cleared plant on a
 * tank draw files the row under an empty sample-group key. Blank here means "follow
 * SRC", the server's own rule, and the item says so. The sentinel can never collide with
 * a real code (`W6` · `W7` · `W6/W7` · `DVO`) and is mapped back to `''` on the way in.
 */
const FOLLOW_SRC = 'FOLLOW SRC';
const PLANT_OPTIONS: readonly string[] = [FOLLOW_SRC, ...PLANT_CODES];

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
 * so ten waiting blanks are still ten rows — and since blanks arrive UNDATED, "needs a
 * date" is not the first thing ten of them shout.
 *
 * That same line is where a NOTICE lands: a remark the server returned with a successful
 * write (a typed plant disagreeing with the source, a FLEC draw with no side). It reads
 * green beside `saved`, never red, and asks for nothing — it is not a refusal and gets
 * no confirm round trip.
 */
export function DraftRow({ draft, options, contextYear, conflict, onChange, onRemove }: DraftRowProps) {
    const set = (patch: Partial<DraftDraw>) => onChange(draft.id, patch);
    const setMetric = (metric: MetricKey, value: string) =>
        onChange(draft.id, { metrics: { ...draft.metrics, [metric]: value } });
    const busy = draft.status === 'saving';
    // Crushers · kilns · and the ONE bagging token (2026-08-26). `FLEC` goes LAST, not
    // first: it is the rarer entry and every operator's muscle memory reaches for C1–C4
    // and RK1–RK4, so prepending it would shift the whole list under them.
    //
    // Exactly one bagging spelling is OFFERED even though the RPC ACCEPTS five —
    // `BAGGING_MACHINE_CODE` vs `BAGGING_MACHINE_CODES`. A picker listing all five would
    // ask the operator to choose between synonyms; the accept list exists for text that
    // is already typed (a paste out of the production ledger), not for a menu.
    const machines = React.useMemo(
        () => [...options.crushers, ...options.kilns, BAGGING_MACHINE_CODE],
        [options.crushers, options.kilns],
    );
    // The plant that would be STORED, and whether the operator put it there. A derived
    // value is rendered ghosted so the row never claims a transcription it does not have.
    const plantTyped = plantOverride(draft) !== '';
    const plant = effectivePlant(draft);
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
    /** A remark that came back WITH a successful write — never a reason to act. */
    const noticeText = draft.notice?.trim() ? draft.notice.trim() : null;
    const bodyText = statusText
        ? noticeText
            ? `${statusText} ${noticeText}`
            : statusText
        : noticeText;
    const showStatus = busy || draft.status === 'saved' || Boolean(bodyText);

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

                {/* PLANT — a real dropdown since 2026-08-04, the SAME `SelectCell` +
                    `plantBadgeClass` the Production ledger renders on this very column.
                    Left alone it shows the live derivation from SRC, ghosted (dashed,
                    softened) so derived never reads as typed, and sends nothing; an
                    explicit pick becomes an override and gets the solid badge;
                    `— follow SRC` puts it back. It also hosts this row's remove control
                    — still the only cell with room for one. */}
                <td
                    className={cn(CELL, plantTyped ? 'bg-primary/[0.06]' : 'bg-muted/40')}
                    title={
                        plantTyped
                            ? `Plant typed from the slip — this row is stored as ${plant}${
                                  derivedPlant(draft.src)
                                      ? `, not the ${derivedPlant(draft.src)} its source would give`
                                      : ''
                              }. Pick “follow SRC” to go back to the derived value.`
                            : 'Following SRC — TNK→W6, W7→W7, W6→W6, FLEC→none. Pick a plant to override it when the partner’s slip says otherwise.'
                    }
                >
                    {/* `items-stretch` so the dropdown trigger's `h-full` fills the
                        row — the whole cell is the click target, as it is in the
                        production ledger. The remove control stays centred. */}
                    <span className="flex h-7 items-stretch gap-0.5">
                        <span className="min-w-0 flex-1">
                            <SelectCell
                                value={plant}
                                options={PLANT_OPTIONS}
                                onChange={(next) =>
                                    set({ plant: next === FOLLOW_SRC ? '' : next })
                                }
                                renderLabel={(opt) =>
                                    opt === FOLLOW_SRC ? '— follow SRC' : opt
                                }
                                renderTrigger={(value) => (
                                    <span
                                        className={cn(
                                            BADGE_BASE,
                                            plantBadgeClass(value),
                                            // Derived: same colour family, visibly
                                            // provisional. Typed: the ledger's own badge.
                                            !plantTyped && 'border-dashed opacity-60',
                                        )}
                                    >
                                        {value}
                                    </span>
                                )}
                                disabled={busy}
                                // Doubles as the trigger's accessible name, which is why
                                // it is a word rather than a dash: a blank cell here (no
                                // SRC yet, or a FLEC draw, which derives no plant) would
                                // otherwise announce itself as "—".
                                placeholder="plant"
                            />
                        </span>
                        <button
                            type="button"
                            onClick={() => onRemove(draft.id)}
                            disabled={busy}
                            title="Remove this row"
                            aria-label="Remove this draft row"
                            className="h-5 shrink-0 self-center rounded p-0.5 text-muted-foreground/40 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
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
                    title="The warehouse the bags moved through — required when SRC is FLEC (bags out) or MACH is FLEC (bags in), refused on any other row. Flec-count warehouses only; never WHSE 3."
                />
                <DraftCell
                    value={draft.side}
                    onChange={(v) => set({ side: v })}
                    disabled={busy}
                    options={options.sides}
                    listId={`qc-sides-${draft.id}`}
                    upper
                    title="Warehouse side (LS / RS) — optional in both directions, but the flec ledger EXCLUDES a sideless row entirely rather than counting it sideless"
                />
                <DraftCell
                    value={draft.bags}
                    onChange={(v) => set({ bags: v })}
                    disabled={busy}
                    numeric
                    title="Whole flec bags — required when SRC is FLEC (bags out) or MACH is FLEC (bags in), refused on any other row"
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
                            <span className="inline-flex items-start gap-1">
                                <Check className="mt-px h-3 w-3 shrink-0" />
                                <span>{noticeText ? `saved — ${noticeText}` : 'saved'}</span>
                            </span>
                        ) : (
                            <span className="inline-flex items-start gap-1">
                                {statusText ? (
                                    <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                                ) : (
                                    <Info className="mt-px h-3 w-3 shrink-0" />
                                )}
                                <span>{bodyText}</span>
                            </span>
                        )}
                    </td>
                </tr>
            ) : null}
        </>
    );
}
