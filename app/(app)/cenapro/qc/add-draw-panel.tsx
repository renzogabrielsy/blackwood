'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// Add partner draws — the QC Ledger's entry composer.
//
// Renzo: "Partner sends their totals on a piece of paper and we log those in." That
// sentence is the whole design brief, and it rules out the obvious shape. A modal you
// open, fill, submit and reopen costs four interactions per line of a slip that has
// six; the transcription itself costs one. So this is a DOCKED panel, not an overlay:
//
//   • it opens once per slip and STAYS open across saves — every field except the
//     per-draw ones (weight, bags, note) carries to the next line, because a slip
//     repeats its date and source and varies the machine and the number;
//   • Enter in any field adds the line and returns focus to the weight box, so a run
//     of draws is `12400 ⏎`, retab the machine, `9880 ⏎`;
//   • it does not dim the ledger. Each added row appears in the grid beside it with
//     its analysis cells ready and the day / month totals restated — the operator
//     watches the day build as they read the slip out.
//
// PARTNER DRAWS ONLY. Flec bagging arrives on a different sheet and belongs to the
// Production ledger, so no bagging affordance exists here — and DVO is not offered
// either (`cenapro_add_partner_draw` answers `unsupported_source`).
//
// Nothing is derived here that the RPC derives. `disposition_kind`, `plant_code` and
// above all `batch` (JULY starts 2026-06-27 — it is not the calendar month) come back
// on the verdict and are REPORTED, never guessed at, so the panel can say where a row
// landed without ever being able to say it wrong.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import Link from 'next/link';
import { Check, Copy, Loader2, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { parseWeightKg, type BatchResolution, type ExistingDraw } from '@/lib/cenapro/ccc-analysis';
import { formatKg, formatMonthHeading, monthBounds } from '@/lib/cenapro/ccc-analysis-view';

import { addPartnerDraw, type AddQcDrawInput, type AddQcDrawOutcome } from './actions';
import type { QcDrawOptions } from './data';

/** Where a committed draw landed — handed up so the ledger can point at the new row. */
export interface DrawLanding {
    drawId: string;
    /** `date|SRC|WHSE`, exactly as the RPC reported it. Never re-derived. */
    groupKey: string;
    date: string;
    /** The group's source, so the ledger can clear a filter that would hide the row. */
    source: string;
}

export interface AddDrawPanelProps {
    options: QcDrawOptions;
    /** The month on screen, `YYYY-MM`. The composer is scoped to it. */
    month: string;
    /** The day the composer was opened on, `YYYY-MM-DD`. */
    initialDate: string;
    /** True while the parent is re-rendering the ledger after a commit. */
    refreshing: boolean;
    onClose: () => void;
    onInserted: (landing: DrawLanding) => void;
    /** Whether a draw id is among the rows currently on screen. */
    hasDraw: (id: string) => boolean;
    /** Scroll to and mark an existing row. */
    onLocateDraw: (id: string) => void;
}

/** One committed line of the slip, kept on screen as a running receipt. */
interface AddedDraw {
    id: string;
    date: string;
    source: string;
    machine: string;
    grade: string;
    shift: string;
    kg: number;
    batch: string;
    batchYear?: number;
    resolution?: BatchResolution;
    whseKey: string;
    notice: string | null;
}

/** What the panel is showing under the form, when it is showing anything. */
type Verdict =
    | { kind: 'confirm'; existing: ExistingDraw[]; message: string; input: AddQcDrawInput }
    | { kind: 'problem'; outcome: AddQcDrawOutcome; message: string; existingId?: string };

const FLEC = 'FLEC';

/** How the RPC arrived at the batch, in words an operator can act on. */
const RESOLUTION_NOTE: Record<BatchResolution, string> = {
    running: 'the batch running that day',
    explicit: 'the batch you named',
    calendar: 'the calendar month — no batch history at or before that date',
};

const FIELD_LABEL = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';
const FIELD_INPUT =
    'h-7 w-full rounded-md border border-input bg-transparent px-2 text-[11px] outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const TRIGGER = 'h-7 w-full gap-1 border-input bg-transparent px-2 text-[11px] hover:bg-muted/40';

export function AddDrawPanel({
    options,
    month,
    initialDate,
    refreshing,
    onClose,
    onInserted,
    hasDraw,
    onLocateDraw,
}: AddDrawPanelProps) {
    const { from, toExclusive } = monthBounds(month);
    // The composer is scoped to the month on screen, and the date box is clamped to it
    // rather than trusted to be: a draw saved into another month is a correct write the
    // operator cannot see, which reads exactly like a failure.
    const lastDay = React.useMemo(() => {
        const end = new Date(`${toExclusive}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() - 1);
        return end.toISOString().slice(0, 10);
    }, [toExclusive]);

    const [recvDate, setRecvDate] = React.useState(initialDate);
    const [source, setSource] = React.useState(options.sources[0] ?? '');
    const [machine, setMachine] = React.useState('');
    const [grade, setGrade] = React.useState(options.grades[0] ?? '');
    const [shift, setShift] = React.useState(options.shifts[0] ?? '');
    const [weight, setWeight] = React.useState('');
    const [warehouse, setWarehouse] = React.useState('');
    const [flecCount, setFlecCount] = React.useState('');
    const [side, setSide] = React.useState('');
    const [prodDate, setProdDate] = React.useState('');
    const [notes, setNotes] = React.useState('');

    const [showMore, setShowMore] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [verdict, setVerdict] = React.useState<Verdict | null>(null);
    const [added, setAdded] = React.useState<AddedDraw[]>([]);

    const weightRef = React.useRef<HTMLInputElement>(null);

    // Reopening on another day retargets the composer without disturbing the run.
    React.useEffect(() => {
        setRecvDate(initialDate);
    }, [initialDate]);

    const isFlec = source === FLEC;

    /**
     * Any edit invalidates a pending verdict — a duplicate confirmation applies to the
     * exact values it was raised for, and "Add anyway" re-sends the STORED input rather
     * than whatever is in the boxes now.
     */
    const clearVerdict = React.useCallback(() => setVerdict(null), []);

    const changeSource = React.useCallback((next: string) => {
        clearVerdict();
        setSource(next);
        if (next !== FLEC) {
            // Non-FLEC sources consume no bags at all, and the RPC refuses the fields by
            // name rather than dropping them — so they are cleared, not merely hidden.
            setWarehouse('');
            setFlecCount('');
            setSide('');
        }
    }, [clearVerdict]);

    // ── What can be blocked before it costs a round trip ──────────────────────────
    const weightCheck = parseWeightKg(weight);
    const flecCountValid = /^\d[\d,\s]*$/.test(flecCount.trim());
    const blocker = !recvDate
        ? 'Pick the receipt date from the slip.'
        : recvDate < from || recvDate > lastDay
          ? `That date is outside ${formatMonthHeading(month)} — switch month first, or pick a day in it.`
          : !source
            ? 'Choose where the material was drawn from.'
            : !machine
              ? 'Choose the crusher or kiln it went into.'
              : !grade
                ? 'Choose the grade.'
                : !shift
                  ? 'Choose the shift.'
                  : weightCheck.error
                    ? weightCheck.error
                    : isFlec && !warehouse
                      ? 'A FLEC draw takes bags out of a warehouse — choose which one.'
                      : isFlec && !flecCountValid
                        ? 'Enter how many flecs came out, as a whole number.'
                        : prodDate && prodDate > recvDate
                          ? 'The production date cannot be after the receipt date.'
                          : null;

    const buildInput = React.useCallback(
        (): AddQcDrawInput => ({
            recvDate,
            sourceLocationCode: source,
            partnerEquipmentCode: machine,
            gradeCode: grade,
            shiftCode: shift,
            weightRaw: weight,
            prodDate: prodDate || null,
            warehouseCode: isFlec ? warehouse : null,
            flecCountRaw: isFlec ? flecCount : null,
            whseSide: isFlec ? side : null,
            notes: notes || null,
        }),
        [recvDate, source, machine, grade, shift, weight, prodDate, isFlec, warehouse, flecCount, side, notes],
    );

    /**
     * Send one line. `input` is passed explicitly so the duplicate confirmation can
     * re-send byte-for-byte what was refused, plus `p_allow_duplicate`.
     */
    const submit = React.useCallback(
        async (input: AddQcDrawInput) => {
            setBusy(true);
            setVerdict(null);
            try {
                const result = await addPartnerDraw(input);

                if (result.ok && result.outcome === 'inserted' && result.id) {
                    const group = result.sample_group;
                    setAdded((prev) => [
                        {
                            id: result.id as string,
                            date: input.recvDate,
                            source: input.sourceLocationCode,
                            machine: input.partnerEquipmentCode,
                            grade: input.gradeCode,
                            shift: input.shiftCode,
                            kg: parseWeightKg(input.weightRaw).kg ?? 0,
                            batch: result.batch ?? '',
                            batchYear: result.batch_year,
                            resolution: result.batch_resolution,
                            whseKey: group?.whse_key ?? '',
                            notice: result.notice ?? null,
                        },
                        ...prev,
                    ]);

                    if (group) {
                        onInserted({
                            drawId: result.id,
                            groupKey: `${group.sample_date}|${group.source_location_code}|${group.whse_key}`,
                            date: group.sample_date,
                            source: group.source_location_code,
                        });
                    }

                    // Only the per-draw values reset. The slip's date, source, machine,
                    // grade, shift and warehouse are what the next line most likely
                    // repeats, so they stay put and the caret goes back to the weight.
                    setWeight('');
                    setFlecCount('');
                    setNotes('');
                    window.setTimeout(() => weightRef.current?.focus(), 0);
                    return;
                }

                if (result.outcome === 'duplicate_warning') {
                    setVerdict({
                        kind: 'confirm',
                        existing: result.existing ?? [],
                        message:
                            result.message ??
                            'A draw with the same date, source, machine, grade and shift is already on file.',
                        input,
                    });
                    return;
                }

                if (result.outcome === 'rpc_error') {
                    errorToast('The draw could not be added', { description: result.message ?? undefined });
                }

                setVerdict({
                    kind: 'problem',
                    outcome: result.outcome,
                    message: result.message ?? 'The draw could not be added.',
                    existingId: result.outcome === 'already_exists' ? result.id : undefined,
                });
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                errorToast('The draw could not be added', { description: message });
                setVerdict({ kind: 'problem', outcome: 'rpc_error', message });
            } finally {
                setBusy(false);
            }
        },
        [onInserted],
    );

    const onSubmit = React.useCallback(
        (event: React.FormEvent) => {
            event.preventDefault();
            if (busy || blocker) return;
            void submit(buildInput());
        },
        [busy, blocker, submit, buildInput],
    );

    const previewKg = weightCheck.kg;

    return (
        <aside
            aria-label="Add partner draws"
            className="ml-3 flex w-[318px] shrink-0 animate-fade-up flex-col overflow-hidden rounded-lg border border-border bg-card xl:w-[340px]"
        >
            {/* ── Header ───────────────────────────────────────────────────────────── */}
            <header className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-xs font-semibold">Add partner draws</h2>
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                        One line per line of the slip. Stays open — <Kbd>Enter</Kbd> adds and keeps
                        going.
                    </p>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-mr-1 h-6 w-6 shrink-0 p-0"
                    aria-label="Close the add-draw panel"
                    onClick={onClose}
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            </header>

            {/* One scrollport for the form, its verdict and the receipt below it — a
                short window must never clip the Add button out of reach. */}
            <div className="min-h-0 flex-1 overflow-auto">
            {/* ── The form ─────────────────────────────────────────────────────────── */}
            <form onSubmit={onSubmit} className="space-y-2 border-b border-border px-3 py-2.5">
                <div>
                    <label className={FIELD_LABEL} htmlFor="qc-add-date">
                        Receipt date
                    </label>
                    <input
                        id="qc-add-date"
                        type="date"
                        value={recvDate}
                        min={from}
                        max={lastDay}
                        onChange={(event) => {
                            clearVerdict();
                            setRecvDate(event.target.value);
                        }}
                        className={cn(FIELD_INPUT, 'font-mono tabular-nums')}
                    />
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <Picker
                        label="Source"
                        value={source}
                        onChange={changeSource}
                        options={options.sources}
                        placeholder="Where from"
                    />
                    <MachinePicker
                        crushers={options.crushers}
                        kilns={options.kilns}
                        value={machine}
                        onChange={(next) => {
                            clearVerdict();
                            setMachine(next);
                        }}
                    />
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <Picker
                        label="Grade"
                        value={grade}
                        onChange={(next) => {
                            clearVerdict();
                            setGrade(next);
                        }}
                        options={options.grades}
                        placeholder="Grade"
                    />
                    <Picker
                        label="Shift"
                        value={shift}
                        onChange={(next) => {
                            clearVerdict();
                            setShift(next);
                        }}
                        options={options.shifts}
                        placeholder="Shift"
                    />
                </div>

                <div>
                    <label className={FIELD_LABEL} htmlFor="qc-add-weight">
                        Weight{' '}
                        <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
                            kg
                        </span>
                    </label>
                    <div className="relative">
                        <input
                            id="qc-add-weight"
                            ref={weightRef}
                            value={weight}
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="12,400"
                            onChange={(event) => {
                                clearVerdict();
                                setWeight(event.target.value);
                            }}
                            className={cn(
                                FIELD_INPUT,
                                'pr-14 text-right font-mono text-xs tabular-nums',
                                weight !== '' && weightCheck.error && 'border-destructive/60',
                            )}
                        />
                        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground/60">
                            {previewKg == null ? 'kg' : `${formatKg(previewKg)}`}
                        </span>
                    </div>
                </div>

                {/* FLEC-only. A draw out of the bagged stock is bags leaving a specific
                    warehouse, so these are part of what happened; every other source
                    consumes no bags and the RPC refuses the fields by name. */}
                {isFlec ? (
                    <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                            Out of bagged stock
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                            <Picker
                                label="Warehouse"
                                value={warehouse}
                                onChange={(next) => {
                                    clearVerdict();
                                    setWarehouse(next);
                                }}
                                options={options.warehouses}
                                placeholder="Which"
                            />
                            <div>
                                <label className={FIELD_LABEL} htmlFor="qc-add-flec">
                                    Flecs out
                                </label>
                                <input
                                    id="qc-add-flec"
                                    value={flecCount}
                                    inputMode="numeric"
                                    autoComplete="off"
                                    placeholder="38"
                                    onChange={(event) => {
                                        clearVerdict();
                                        setFlecCount(event.target.value);
                                    }}
                                    className={cn(
                                        FIELD_INPUT,
                                        'text-right font-mono tabular-nums',
                                        flecCount !== '' && !flecCountValid && 'border-destructive/60',
                                    )}
                                />
                            </div>
                        </div>
                        <Picker
                            label="Side"
                            value={side}
                            onChange={(next) => {
                                clearVerdict();
                                setSide(next);
                            }}
                            options={options.sides}
                            placeholder="LS / RS"
                            emptyLabel="Not stated"
                        />
                        {/* The RPC returns this same warning AFTER the write; saying it
                            first costs nothing and is the difference between a balance
                            that moves and one that quietly does not. */}
                        {!side ? (
                            <p className="text-[10px] leading-tight text-amber-600 dark:text-amber-400">
                                Without LS or RS the flec ledger will not count this draw, so the
                                warehouse balance will not move until a side is set.
                            </p>
                        ) : null}
                    </div>
                ) : null}

                <button
                    type="button"
                    onClick={() => setShowMore((open) => !open)}
                    className="text-[10px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
                >
                    {showMore ? 'Hide' : 'Production date · note'}
                </button>

                {showMore ? (
                    <div className="space-y-2">
                        <div>
                            <label className={FIELD_LABEL} htmlFor="qc-add-prod">
                                Production date
                            </label>
                            <input
                                id="qc-add-prod"
                                type="date"
                                value={prodDate}
                                max={recvDate || undefined}
                                onChange={(event) => {
                                    clearVerdict();
                                    setProdDate(event.target.value);
                                }}
                                className={cn(FIELD_INPUT, 'font-mono tabular-nums')}
                            />
                        </div>
                        <div>
                            <label className={FIELD_LABEL} htmlFor="qc-add-notes">
                                Note
                            </label>
                            <input
                                id="qc-add-notes"
                                value={notes}
                                autoComplete="off"
                                placeholder="Anything the slip says"
                                onChange={(event) => {
                                    clearVerdict();
                                    setNotes(event.target.value);
                                }}
                                className={FIELD_INPUT}
                            />
                        </div>
                    </div>
                ) : null}

                <div className="flex items-center gap-2 pt-0.5">
                    <Button
                        type="submit"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        disabled={busy || blocker !== null}
                    >
                        {busy ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                            <Plus className="mr-1 h-3 w-3" />
                        )}
                        Add draw
                    </Button>
                    {refreshing && !busy ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">updating…</span>
                    ) : null}
                </div>

                <p
                    className={cn(
                        'text-[10px] leading-tight',
                        blocker ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70',
                    )}
                >
                    {blocker ?? 'Batch is resolved from the receipt date — the verdict says which.'}
                </p>
            </form>

            {/* ── Verdict ──────────────────────────────────────────────────────────── */}
            {verdict?.kind === 'confirm' ? (
                <DuplicateConfirm
                    verdict={verdict}
                    busy={busy}
                    onCancel={clearVerdict}
                    onConfirm={() => void submit({ ...verdict.input, allowDuplicate: true })}
                />
            ) : null}

            {verdict?.kind === 'problem' ? (
                <ProblemBlock
                    verdict={verdict}
                    canLocate={verdict.existingId ? hasDraw(verdict.existingId) : false}
                    onLocate={() => {
                        if (verdict.existingId) onLocateDraw(verdict.existingId);
                        clearVerdict();
                    }}
                    onDismiss={clearVerdict}
                />
            ) : null}

            {/* ── The running receipt ──────────────────────────────────────────────── */}
            <div className="px-3 py-2">
                {added.length === 0 ? (
                    <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                        Draws you add appear here and in the ledger beside this panel, with their
                        analysis cells ready and the day total restated.
                    </p>
                ) : (
                    <>
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Added this sitting · {added.length}
                        </p>
                        <ul className="space-y-1.5">
                            {added.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5"
                                >
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="truncate font-mono text-[11px] font-semibold">
                                            {entry.date.slice(5)} · {entry.source} · {entry.machine}
                                        </span>
                                        <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums">
                                            {formatKg(entry.kg)}
                                        </span>
                                    </div>
                                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                                        {entry.grade} · {entry.shift} · {entry.whseKey || 'unplaced'}
                                    </p>
                                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
                                        <Check className="mr-0.5 inline h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />
                                        filed in{' '}
                                        <span className="font-mono font-semibold text-foreground">
                                            {entry.batch}
                                            {entry.batchYear ? ` ${entry.batchYear}` : ''}
                                        </span>
                                        {entry.resolution ? ` — ${RESOLUTION_NOTE[entry.resolution]}` : ''}
                                    </p>
                                    {entry.notice ? (
                                        <p className="mt-1 text-[10px] leading-tight text-amber-600 dark:text-amber-400">
                                            {entry.notice}
                                        </p>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
            </div>
        </aside>
    );
}

// ─── Verdict blocks ──────────────────────────────────────────────────────────────

/**
 * A SOFT refusal. Fourteen `(date, source, machine, grade, shift)` keys in live data
 * already carry two draws, so two trips in a day are real work — only the operator
 * knows whether the slip lists two of them or they keyed one twice. The existing rows
 * are shown so they can tell, and confirming re-sends the same values with
 * `p_allow_duplicate`.
 */
function DuplicateConfirm({
    verdict,
    busy,
    onCancel,
    onConfirm,
}: {
    verdict: Extract<Verdict, { kind: 'confirm' }>;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div
            role="alert"
            className="shrink-0 animate-fade-up border-b border-amber-500/40 bg-amber-500/10 px-3 py-2"
        >
            <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                Already a draw like this on file
            </p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                {verdict.message}
            </p>
            {verdict.existing.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                    {verdict.existing.map((row) => (
                        <li key={row.id} className="font-mono text-[10px] text-amber-700/90 dark:text-amber-300/90">
                            {formatKg(row.weight_kg)} kg · {row.batch}
                            {row.warehouse_code ? ` · ${row.warehouse_code}` : ''}
                            {row.whse_side ? ` ${row.whse_side}` : ''}
                            {row.prod_date ? ` · prod ${row.prod_date.slice(5)}` : ''}
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="mt-2 flex items-center gap-1.5">
                <Button
                    type="button"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={onConfirm}
                >
                    {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    Add anyway
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={onCancel}
                >
                    Cancel
                </Button>
                <CopyButton text={copyTextFor(verdict.message, verdict.existing)} tone="amber" />
            </div>
        </div>
    );
}

/**
 * A heading per outcome. It names WHAT went wrong; the RPC's own message says which
 * value, and is rendered under it untouched.
 */
const PROBLEM_HEADING: Record<AddQcDrawOutcome, string> = {
    inserted: 'Added',
    duplicate_warning: 'Already a draw like this on file',
    already_exists: 'This exact row is already stored',
    wrong_surface: 'That belongs in the Production ledger',
    unsupported_source: 'DVO is not entered here yet',
    invalid_key: 'Something in this draw is not recognised',
    invalid: 'That value cannot be saved',
    rpc_error: 'The draw could not be added',
};

/**
 * Everything the operator cannot simply confirm through. The RPC's own `message` is
 * rendered VERBATIM — it is written for them, names the offending value, and is more
 * specific than anything this component could restate. Only the affordance differs:
 * `already_exists` can point at the row that is already there, `wrong_surface` points
 * at the Production ledger, and a typo offers neither because neither would help.
 */
function ProblemBlock({
    verdict,
    canLocate,
    onLocate,
    onDismiss,
}: {
    verdict: Extract<Verdict, { kind: 'problem' }>;
    canLocate: boolean;
    onLocate: () => void;
    onDismiss: () => void;
}) {
    return (
        <div
            role="alert"
            className="shrink-0 animate-fade-up border-b border-destructive/40 bg-destructive/10 px-3 py-2"
        >
            <p className="text-[11px] font-semibold text-destructive">
                {PROBLEM_HEADING[verdict.outcome]}
            </p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-destructive/90">{verdict.message}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {verdict.outcome === 'already_exists' && canLocate ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={onLocate}
                    >
                        Open the existing row
                    </Button>
                ) : null}
                {verdict.outcome === 'already_exists' && !canLocate ? (
                    <span className="text-[10px] text-destructive/80">
                        That row is not in the month on screen.
                    </span>
                ) : null}
                {verdict.outcome === 'wrong_surface' ? (
                    <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[11px]">
                        <Link href="/cenapro/production">Go to the Production ledger</Link>
                    </Button>
                ) : null}
                <CopyButton text={verdict.message} tone="destructive" />
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                    onClick={onDismiss}
                >
                    Dismiss
                </Button>
            </div>
        </div>
    );
}

function copyTextFor(message: string, existing: ExistingDraw[]): string {
    if (existing.length === 0) return message;
    const lines = existing.map(
        (row) =>
            `${formatKg(row.weight_kg)} kg · ${row.batch}${row.warehouse_code ? ` · ${row.warehouse_code}` : ''}${row.whse_side ? ` ${row.whse_side}` : ''}${row.prod_date ? ` · prod ${row.prod_date}` : ''}`,
    );
    return `${message}\n${lines.join('\n')}`;
}

/** The inline half of the error HARD RULE — every inline problem can be pasted out. */
function CopyButton({ text, tone }: { text: string; tone: 'amber' | 'destructive' }) {
    const [copied, setCopied] = React.useState(false);
    return (
        <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
                'h-6 px-2 text-[11px]',
                tone === 'amber'
                    ? 'text-amber-700 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300'
                    : 'text-destructive hover:text-destructive',
            )}
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                });
            }}
        >
            {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
        </Button>
    );
}

// ─── Pickers ─────────────────────────────────────────────────────────────────────

/** Radix Select forbids an empty item value, so "not stated" carries a sentinel. */
const NO_SIDE = '__none__';

function Picker({
    label,
    value,
    onChange,
    options,
    placeholder,
    emptyLabel,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    options: readonly string[];
    placeholder: string;
    /** When given, the list gains a "clear" row — used by the optional LS/RS side. */
    emptyLabel?: string;
}) {
    const id = React.useId();
    // Radix forbids an empty `SelectItem` value, so a clearable picker carries the
    // sentinel BOTH ways: the trigger reads "Not stated" instead of falling back to a
    // placeholder that looks like nothing was ever chosen.
    const selectValue = emptyLabel && value === '' ? NO_SIDE : value;
    return (
        <div className="min-w-0">
            <label className={FIELD_LABEL} htmlFor={id}>
                {label}
            </label>
            <Select
                value={selectValue}
                onValueChange={(next) => onChange(next === NO_SIDE ? '' : next)}
            >
                <SelectTrigger id={id} size="sm" className={cn(TRIGGER, 'font-mono')}>
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent className="font-mono">
                    {emptyLabel ? (
                        <SelectItem value={NO_SIDE} className="text-[11px] text-muted-foreground">
                            {emptyLabel}
                        </SelectItem>
                    ) : null}
                    {options.map((option) => (
                        <SelectItem key={option} value={option} className="text-[11px]">
                            {option}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

/**
 * The machine is the one field that decides what KIND of draw this is — a crusher makes
 * it a `partner_crusher`, a kiln a `partner_kiln` — so the two families are labelled
 * groups rather than one flat list. There is deliberately no bagging entry: that is a
 * different document and a different screen.
 */
function MachinePicker({
    crushers,
    kilns,
    value,
    onChange,
}: {
    crushers: readonly string[];
    kilns: readonly string[];
    value: string;
    onChange: (next: string) => void;
}) {
    const id = React.useId();
    return (
        <div className="min-w-0">
            <label className={FIELD_LABEL} htmlFor={id}>
                Machine
            </label>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger id={id} size="sm" className={cn(TRIGGER, 'font-mono')}>
                    <SelectValue placeholder="C1 / RK1" />
                </SelectTrigger>
                <SelectContent className="font-mono">
                    {crushers.length > 0 ? (
                        <SelectGroup>
                            <SelectLabel className="text-[10px] uppercase tracking-wide">
                                Crushers
                            </SelectLabel>
                            {crushers.map((code) => (
                                <SelectItem key={code} value={code} className="text-[11px]">
                                    {code}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ) : null}
                    {kilns.length > 0 ? (
                        <SelectGroup>
                            <SelectLabel className="text-[10px] uppercase tracking-wide">
                                Rotary kilns
                            </SelectLabel>
                            {kilns.map((code) => (
                                <SelectItem key={code} value={code} className="text-[11px]">
                                    {code}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ) : null}
                </SelectContent>
            </Select>
        </div>
    );
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="rounded border border-border bg-muted px-1 font-mono text-[9px] text-muted-foreground">
            {children}
        </kbd>
    );
}
