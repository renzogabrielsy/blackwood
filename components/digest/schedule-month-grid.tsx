'use client';

// =====================================================================
// Production Schedule — the editable MONTH grid (Phase B).
// =====================================================================
// The dense Excel-Standard month table, now inline-editable. Built on the shared
// Blackwood Table primitives (components/shared/grid + lib/hooks) — the SAME
// click/type/F2/Esc/Tab/Enter model every other grid in the app uses. No second
// editing engine.
//
// Ownership is the load-bearing concept (migration 20260730060000):
//   • Editing ANY cell flips the WHOLE DAY to owner='human' — the approved lock
//     granularity, enforced by fn_save_schedule_day, not by this component. The
//     consequence is shown BEFORE the commit: the row's owner chip previews the
//     flip (`Joseph → You`), the row gets a sky rail, and the sticky save bar
//     names every day whose ownership is about to move.
//   • A day whose effective owner is 'actual' (production already reported) is
//     rendered VISIBLY FROZEN with a reason — its cells are plain <td>s, never
//     GridCells, so there is nothing to click and no save to refuse.
//   • A day carrying a parked upstream proposal shows an amber conflict button
//     that opens the field-by-field arbitration dialog.
//
// Motion rules (CLAUDE.md): the CONTAINER animates (`animate-fade-up`), rows
// never do. No stagger, no per-row entrance. Row hover is
// `transition-all duration-150`.
//
// No ₱ anywhere in the schedule → this file never touches price gating.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Lock, RotateCcw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
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
import { GridCell } from '@/components/shared/grid/GridCell';
import { EditInput } from '@/components/shared/grid/EditInput';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import {
  createCoordinateNavResolver,
  useGridKeyboardNav,
  type CoordinateId,
  type NavResolver,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { STATE_CHIP, STATE_LABEL } from '@/components/digest/status-tokens';
import { fmtGradeTons, gradeTonsTitle } from '@/components/digest/format';
import {
  OWNER_CHIP,
  OWNER_HINT,
  OWNER_LABEL,
  isScheduleDayEditable,
} from '@/components/digest/schedule-owner';
import {
  SCHEDULE_COLUMN_MAP,
  scheduleFieldToString,
  type ScheduleEditableField,
  type ScheduleGridRow,
} from '@/components/digest/schedule-types';
import { ScheduleConflictDialog } from '@/components/digest/schedule-conflict-dialog';
import {
  releaseScheduleDay,
  saveScheduleDay,
  type SchedulePatch,
} from '@/app/(app)/production/schedule/actions';

// ---------------------------------------------------------------------
// Column widths — Excel Standard: table-fixed + explicit px, and a min-width
// equal to their SUM so the wrapper scrolls instead of crushing a column
// ("never crush, always scroll").
// ---------------------------------------------------------------------
const COL = {
  // Wide enough for `yyyy-MM-dd` PLUS the frozen padlock without wrapping.
  date: 'w-[116px]',
  day: 'w-[52px]',
  setup: 'w-[128px]',
  grades: 'w-[156px]',
  shifts: 'w-[58px]',
  projected: 'w-[84px]',
  actual: 'w-[78px]',
  actualHrs: 'w-[76px]',
  variance: 'w-[76px]',
  status: 'w-[108px]',
  owner: 'w-[128px]',
  remarks: 'w-[216px]',
  actions: 'w-[64px]',
} as const;

/** 116+52+128+156+58+84+78+76+76+108+128+216+64 */
const TABLE_MIN_W = 'min-w-[1340px]';

const HEAD_CLS =
  'frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

// ---------------------------------------------------------------------
// Formatting (display only — no aggregation)
// ---------------------------------------------------------------------

function fmtTons(v: number | null): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtVariance(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

/** Trim + collapse so "  " and "" compare equal when deciding dirtiness. */
function norm(v: string): string {
  return v.trim();
}

/** Turn an edited cell string into the JSON value fn_save_schedule_day wants.
 *  An empty string CLEARS a text field (explicit null) and zeroes `shifts`
 *  (the RPC's own COALESCE(...,0) contract). */
function toPatchValue(
  field: ScheduleEditableField,
  raw: string
): number | string | null {
  const v = norm(raw);
  switch (field) {
    case 'shifts': {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    }
    case 'projected_tons': {
      if (v === '') return null;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'setup':
    case 'remarks':
      return v === '' ? null : v;
  }
}

type DraftMap = Record<string, Partial<Record<ScheduleEditableField, string>>>;

interface ScheduleMonthGridProps {
  rows: ScheduleGridRow[];
  /** Presentational month footer totals, computed by the server component. */
  totals: {
    projected: number;
    actual: number;
    actualHrs: number;
    variance: number;
  };
}

export function ScheduleMonthGrid({ rows, totals }: ScheduleMonthGridProps) {
  const router = useRouter();
  const gridRef = React.useRef<HTMLDivElement>(null);

  const [drafts, setDrafts] = React.useState<DraftMap>({});
  const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [releasing, setReleasing] = React.useState(false);
  const [revertTarget, setRevertTarget] =
    React.useState<ScheduleGridRow | null>(null);
  const [conflictTarget, setConflictTarget] =
    React.useState<ScheduleGridRow | null>(null);

  // A fresh server payload (post-save router.refresh, or a month change) makes
  // every draft stale — the row_versions it was keyed to no longer exist.
  const rowsKey = React.useMemo(
    () => rows.map((r) => `${r.date}:${r.rowVersion}`).join(','),
    [rows]
  );
  React.useEffect(() => {
    setDrafts({});
  }, [rowsKey]);

  // ---------------- draft plumbing ----------------

  const valueOf = React.useCallback(
    (rowIdx: number, field: ScheduleEditableField): string => {
      const row = rows[rowIdx];
      if (!row) return '';
      const d = drafts[row.date]?.[field];
      return d !== undefined ? d : scheduleFieldToString(row, field);
    },
    [rows, drafts]
  );

  const setValueAt = React.useCallback(
    (rowIdx: number, field: ScheduleEditableField, value: string) => {
      const row = rows[rowIdx];
      if (!row || !isScheduleDayEditable(row.effectiveOwner)) return;
      setDrafts((prev) => ({
        ...prev,
        [row.date]: { ...prev[row.date], [field]: value },
      }));
    },
    [rows]
  );

  /** Which editable fields on a day actually differ from what the DB holds. */
  const changedFieldsFor = React.useCallback(
    (row: ScheduleGridRow): ScheduleEditableField[] => {
      const d = drafts[row.date];
      if (!d) return [];
      return (Object.keys(d) as ScheduleEditableField[]).filter(
        (f) => norm(d[f] ?? '') !== norm(scheduleFieldToString(row, f))
      );
    },
    [drafts]
  );

  const dirtyRows = React.useMemo(
    () => rows.filter((r) => changedFieldsFor(r).length > 0),
    [rows, changedFieldsFor]
  );
  /** Dirty days whose ownership is ABOUT to move to the human. */
  const flippingRows = React.useMemo(
    () => dirtyRows.filter((r) => r.owner !== 'human'),
    [dirtyRows]
  );

  // ---------------- shared grid primitives ----------------

  const editSession = useGridEditSession<CoordinateId>({
    getValue: (id) => {
      const field = SCHEDULE_COLUMN_MAP[id.col];
      return field ? valueOf(id.row, field) : '';
    },
    setValue: (id, v) => {
      const field = SCHEDULE_COLUMN_MAP[id.col];
      if (field) setValueAt(id.row, field, v);
    },
  });

  const startEditing = React.useCallback(
    (rowIdx: number, colIdx: number, initialChar?: string) => {
      const row = rows[rowIdx];
      if (!row || !isScheduleDayEditable(row.effectiveOwner)) return;
      if (SCHEDULE_COLUMN_MAP[colIdx] == null) return;
      setActiveCell({ row: rowIdx, col: colIdx });
      editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
    },
    [rows, editSession]
  );

  const revertCellEdit = React.useCallback(() => {
    editSession.revertChanges();
    gridRef.current?.focus();
  }, [editSession]);

  // Coordinate resolver = the canonical moveSelection math. Wrapped so
  // `isEditable` ALSO respects the per-row actuals freeze: keyboard nav must
  // never drop an editor onto a reported day.
  const resolver = React.useMemo<NavResolver<CoordinateId>>(() => {
    const base = createCoordinateNavResolver({
      rowCount: rows.length,
      columnMap: SCHEDULE_COLUMN_MAP,
    });
    return {
      ...base,
      isEditable: (id) =>
        base.isEditable(id) &&
        !!rows[id.row] &&
        isScheduleDayEditable(rows[id.row].effectiveOwner),
    };
  }, [rows]);

  const { handleKeyDown } = useGridKeyboardNav<CoordinateId>({
    activeCell,
    setActiveCell,
    isEditing: editSession.isEditing,
    resolver,
    edit: {
      start: (id, char) => startEditing(id.row, id.col, char),
      revert: revertCellEdit,
      commit: () => {
        editSession.commit();
        gridRef.current?.focus();
      },
    },
    // Plain Enter always drops straight down (matches RC IN / RC OUT).
    enableEnterAnchor: false,
  });

  const setIsEditing = React.useCallback(
    (editing: boolean) => {
      if (!editing) editSession.commit();
    },
    [editSession]
  );

  // ---------------- mutations ----------------

  async function handleSave() {
    if (dirtyRows.length === 0 || saving) return;
    setSaving(true);
    const failures: string[] = [];
    let savedCount = 0;

    try {
      for (const row of dirtyRows) {
        const fields = changedFieldsFor(row);
        const patch: SchedulePatch = {};
        for (const f of fields) {
          const v = toPatchValue(f, valueOf(rows.indexOf(row), f));
          if (f === 'shifts') patch.shifts = v as number;
          else if (f === 'projected_tons')
            patch.projected_tons = v as number | null;
          else if (f === 'setup') patch.setup = v as string | null;
          else patch.remarks = v as string | null;
        }

        const res = await saveScheduleDay({
          planDate: row.date,
          expectedRowVersion: row.rowVersion,
          patch,
        });
        if (res.ok) {
          savedCount++;
        } else {
          // Every failure outcome (version_conflict / frozen / missing) means the
          // draft cannot be replayed as-is, so it is discarded below. Carry the
          // typed values into the (persistent, copyable) error toast so the
          // operator can paste them back instead of retyping from memory.
          const attempted = Object.entries(patch)
            .map(([k, v]) => `${k}=${v === null ? '(cleared)' : v}`)
            .join(', ');
          failures.push(
            `${res.error ?? `${row.date}: ${res.outcome}`}\nYou had entered: ${attempted}`
          );
        }
      }
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }

    if (failures.length > 0) {
      errorToast(
        savedCount > 0
          ? `Saved ${savedCount} day${savedCount === 1 ? '' : 's'}, ${failures.length} failed`
          : `Could not save ${failures.length} day${failures.length === 1 ? '' : 's'}`,
        { description: failures.join('\n\n') }
      );
    } else {
      toast.success(
        `Saved ${savedCount} day${savedCount === 1 ? '' : 's'}`,
        {
          description:
            flippingRows.length > 0
              ? `${flippingRows.length} day${flippingRows.length === 1 ? '' : 's'} now owned by you — the sync will no longer update ${flippingRows.length === 1 ? 'it' : 'them'}.`
              : undefined,
          duration: 4000,
        }
      );
    }
    setDrafts({});
    router.refresh();
  }

  async function handleRelease(row: ScheduleGridRow) {
    setReleasing(true);
    try {
      const res = await releaseScheduleDay({
        planDate: row.date,
        expectedRowVersion: row.rowVersion,
      });
      if (!res.ok) {
        errorToast(`Could not hand ${row.date} back to the sync`, {
          description: res.error ?? `Outcome: ${res.outcome}`,
        });
        return;
      }
      toast.success(`${row.date} handed back to the sync`, {
        description:
          'The next run will overwrite it with the upstream plan. Your edit is gone.',
        duration: 4000,
      });
      setRevertTarget(null);
      router.refresh();
    } catch (e) {
      errorToast(`Could not hand ${row.date} back to the sync`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setReleasing(false);
    }
  }

  // ---------------- cell renderers ----------------

  /** One editable cell: a GridCell wrapping the canonical inline EditInput. */
  const editableCell = (
    rowIdx: number,
    colIdx: number,
    field: ScheduleEditableField,
    opts: {
      align?: 'left' | 'right';
      mono?: boolean;
      placeholder?: string;
      display?: React.ReactNode;
      title?: string;
    } = {}
  ) => {
    const align = opts.align ?? 'left';
    const value = valueOf(rowIdx, field);
    return (
      <GridCell
        row={rowIdx}
        col={colIdx}
        value={value}
        activeCell={activeCell}
        isEditing={editSession.isEditing}
        setActiveCell={setActiveCell}
        setIsEditing={setIsEditing}
        onStartEditing={startEditing}
        onRevert={revertCellEdit}
        gridRef={gridRef}
        tabIndex={-1}
        className={cn(
          'px-2 text-xs',
          align === 'right' ? 'justify-end' : 'justify-start',
          opts.mono && 'font-mono tabular-nums'
        )}
        displayValue={
          <span className="w-full truncate" title={opts.title ?? value}>
            {opts.display ?? (value || (
              <span className="text-muted-foreground/50">—</span>
            ))}
          </span>
        }
      >
        <EditInput
          autoFocus
          value={value}
          onChange={(v) => setValueAt(rowIdx, field, v)}
          onCommit={() => setIsEditing(false)}
          onEscape={revertCellEdit}
          align={align}
          placeholder={opts.placeholder}
          inputMode={opts.mono ? 'decimal' : undefined}
          valueClass={cn('text-xs', !opts.mono && 'font-sans')}
        />
      </GridCell>
    );
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {/* Pre-emptive legibility: the lock rule is stated BEFORE anyone types. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Editing any cell takes the <span className="font-medium">whole day</span>{' '}
        — ownership flips to <span className="font-medium">You</span> and the
        daily sync stops updating that date until you hand it back. Reported days
        are frozen. Grades are read-only for now.
      </p>

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="min-w-0 animate-fade-up overflow-x-auto rounded-xl border bg-card/95 outline-none backdrop-blur supports-backdrop-filter:bg-card/70 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <table
          className={cn(
            'w-full table-fixed border-collapse text-xs',
            TABLE_MIN_W
          )}
        >
          <thead>
            <tr>
              <th className={cn(HEAD_CLS, COL.date, 'text-left')}>Date</th>
              <th className={cn(HEAD_CLS, COL.day, 'text-left')}>Day</th>
              <th className={cn(HEAD_CLS, COL.setup, 'text-left')}>Setup</th>
              <th className={cn(HEAD_CLS, COL.grades, 'text-left')}>
                Grades (t)
              </th>
              <th className={cn(HEAD_CLS, COL.shifts, 'text-right')}>Shifts</th>
              <th className={cn(HEAD_CLS, COL.projected, 'text-right')}>
                Proj t
              </th>
              <th className={cn(HEAD_CLS, COL.actual, 'text-right')}>Act t</th>
              <th className={cn(HEAD_CLS, COL.actualHrs, 'text-right')}>
                Act hrs
              </th>
              <th className={cn(HEAD_CLS, COL.variance, 'text-right')}>Var</th>
              <th className={cn(HEAD_CLS, COL.status, 'text-left')}>Status</th>
              <th className={cn(HEAD_CLS, COL.owner, 'text-left')}>Owner</th>
              <th className={cn(HEAD_CLS, COL.remarks, 'text-left')}>Remarks</th>
              <th className={cn(HEAD_CLS, COL.actions, 'text-center')}>
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const frozen = !isScheduleDayEditable(r.effectiveOwner);
              const dirtyFields = changedFieldsFor(r);
              const isDirty = dirtyFields.length > 0;
              // The ownership flip is previewed, not announced after the fact.
              const willFlip = isDirty && r.owner !== 'human';
              const chipState =
                r.isToday && r.state !== 'reported' ? 'today' : r.state;
              const shownOwner = willFlip ? 'human' : r.effectiveOwner;

              return (
                <tr
                  key={r.date}
                  className={cn(
                    'h-8 border-t transition-all duration-150 hover:bg-muted/40',
                    r.isRest && 'bg-muted/20 text-muted-foreground',
                    r.isToday && 'bg-amber-500/[0.07]',
                    frozen && 'bg-emerald-500/[0.04]',
                    isDirty && 'bg-sky-500/[0.07]'
                  )}
                >
                  {/* 0 · DATE — carries the dirty rail + the frozen padlock. */}
                  <td
                    className={cn(
                      'whitespace-nowrap border-l-2 px-2 py-1 font-mono tabular-nums',
                      isDirty ? 'border-l-sky-500' : 'border-l-transparent',
                      r.isToday && 'font-semibold text-foreground'
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {r.date}
                      {frozen && (
                        <Lock
                          className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-label="Frozen — production reported"
                        />
                      )}
                    </span>
                  </td>

                  {/* 1 · DAY */}
                  <td className="px-2 py-1">{r.dow.slice(0, 3)}</td>

                  {/* 2 · SETUP (editable) */}
                  <td className={cn('h-8 p-0', frozen && 'px-2 py-1')}>
                    {frozen ? (
                      <span
                        className="block truncate text-muted-foreground"
                        title={r.setup ?? undefined}
                      >
                        {r.setup ?? '— off —'}
                      </span>
                    ) : (
                      editableCell(i, 2, 'setup', {
                        placeholder: r.isRest ? '— off —' : 'Setup',
                        display: valueOf(i, 'setup') || (
                          <span className="italic text-muted-foreground/70">
                            — off —
                          </span>
                        ),
                        title: valueOf(i, 'setup'),
                      })
                    )}
                  </td>

                  {/* 3 · GRADES — read-only JSONB in Phase B. */}
                  <td className="px-2 py-1">
                    {r.gradeTons.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div
                        className="flex items-center gap-1 overflow-hidden"
                        title={gradeTonsTitle(r.gradeTons)}
                      >
                        {r.gradeTons.map((g) => (
                          <span
                            key={g.grade}
                            className="inline-flex shrink-0 items-baseline gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none"
                          >
                            <span className="uppercase tracking-tight">
                              {g.grade}
                            </span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {fmtGradeTons(g.tons)}t
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* 4 · SHIFTS (editable) */}
                  <td className={cn('h-8 p-0', frozen && 'px-2 py-1')}>
                    {frozen ? (
                      <span className="block text-right font-mono tabular-nums text-muted-foreground">
                        {r.shifts}
                      </span>
                    ) : (
                      editableCell(i, 4, 'shifts', {
                        align: 'right',
                        mono: true,
                      })
                    )}
                  </td>

                  {/* 5 · PROJECTED TONS (editable) */}
                  <td className={cn('h-8 p-0', frozen && 'px-2 py-1')}>
                    {frozen ? (
                      <span className="block text-right font-mono tabular-nums text-muted-foreground">
                        {fmtTons(r.projectedTons)}
                      </span>
                    ) : (
                      editableCell(i, 5, 'projected_tons', {
                        align: 'right',
                        mono: true,
                        display: (
                          <span className="w-full text-right text-violet-600 dark:text-violet-300">
                            {valueOf(i, 'projected_tons') || '—'}
                          </span>
                        ),
                      })
                    )}
                  </td>

                  {/* 6 · ACTUAL TONS */}
                  <td className="px-2 py-1 text-right font-mono tabular-nums">
                    {fmtTons(r.actualTons)}
                  </td>

                  {/* 7 · ACTUAL HOURS */}
                  <td
                    className={cn(
                      'px-2 py-1 text-right font-mono tabular-nums',
                      r.actualHrs == null && 'text-muted-foreground'
                    )}
                  >
                    {fmtTons(r.actualHrs)}
                  </td>

                  {/* 8 · VARIANCE */}
                  <td
                    className={cn(
                      'px-2 py-1 text-right font-mono tabular-nums',
                      r.variance == null
                        ? 'text-muted-foreground'
                        : r.variance > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : r.variance < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-muted-foreground'
                    )}
                  >
                    {r.variance == null ? '—' : fmtVariance(r.variance)}
                  </td>

                  {/* 9 · STATUS */}
                  <td className="px-2 py-1">
                    <span
                      className={cn(
                        'inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                        STATE_CHIP[chipState]
                      )}
                    >
                      {chipState === 'today' ? 'Today' : STATE_LABEL[chipState]}
                    </span>
                  </td>

                  {/* 10 · OWNER — previews the flip while the row is dirty. */}
                  <td className="px-2 py-1">
                    <span className="flex items-center gap-1">
                      {willFlip && (
                        <span
                          className="inline-block shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground line-through"
                          title={OWNER_HINT[r.effectiveOwner]}
                        >
                          {OWNER_LABEL[r.effectiveOwner]}
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                          OWNER_CHIP[shownOwner],
                          willFlip && 'ring-1 ring-sky-500/40'
                        )}
                        title={
                          willFlip
                            ? `Unsaved: saving takes ${r.date} from ${OWNER_LABEL[r.effectiveOwner]}. ${OWNER_HINT.human}`
                            : OWNER_HINT[shownOwner]
                        }
                      >
                        {shownOwner === 'actual' && (
                          <Lock className="h-2.5 w-2.5" />
                        )}
                        {OWNER_LABEL[shownOwner]}
                        {willFlip && '?'}
                      </span>
                      {r.conflict && (
                        <button
                          type="button"
                          onClick={() => setConflictTarget(r)}
                          title={`The sync withheld an upstream change for ${r.date} (${r.conflict.changedFields.join(', ') || 'plan'}). Click to arbitrate.`}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300"
                        >
                          <TriangleAlert className="h-2.5 w-2.5" />
                          {r.conflict.changedFields.length || 1}
                        </button>
                      )}
                    </span>
                  </td>

                  {/* 11 · REMARKS (editable) */}
                  <td className={cn('h-8 p-0', frozen && 'px-2 py-1')}>
                    {frozen ? (
                      <span
                        className="block truncate text-muted-foreground"
                        title={r.remarks ?? undefined}
                      >
                        {r.remarks ?? ''}
                      </span>
                    ) : (
                      editableCell(i, 11, 'remarks', {
                        placeholder: 'Remarks',
                        display: (
                          <span className="w-full truncate text-muted-foreground">
                            {valueOf(i, 'remarks')}
                          </span>
                        ),
                        title: valueOf(i, 'remarks'),
                      })
                    )}
                  </td>

                  {/* 12 · ACTIONS — hand a human-owned day back to the sync. */}
                  <td className="px-1 py-1 text-center">
                    {r.owner === 'human' && !r.isReported ? (
                      <button
                        type="button"
                        onClick={() => setRevertTarget(r)}
                        title={`Hand ${r.date} back to the sync — discards your value in favour of the upstream plan.`}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span className="sr-only">
                          Hand {r.date} back to the sync
                        </span>
                      </button>
                    ) : frozen ? (
                      <span
                        className="text-[10px] text-muted-foreground/60"
                        title={OWNER_HINT.actual}
                      >
                        frozen
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="frozen-row-bottom frozen-edge-top h-8 bg-muted font-semibold">
              <td
                className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground"
                colSpan={5}
              >
                Month total · {rows.length} days
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-300">
                {fmtTons(totals.projected)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums">
                {fmtTons(totals.actual)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums">
                {fmtTons(totals.actualHrs)}
              </td>
              <td
                className={cn(
                  'px-2 py-1 text-right font-mono tabular-nums',
                  totals.variance > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : totals.variance < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-muted-foreground'
                )}
              >
                {fmtVariance(totals.variance)}
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Sticky save bar — the LAST chance to read the ownership consequence
          before committing. Floating-bar glass pattern (CLAUDE.md). */}
      {dirtyRows.length > 0 && (
        <div className="sticky bottom-3 z-30 animate-fade-up">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-background/95 px-3 py-2 shadow-lg backdrop-blur supports-backdrop-filter:bg-background/60">
            <div className="min-w-0 text-[11px] leading-relaxed">
              <span className="font-semibold">
                {dirtyRows.length} day{dirtyRows.length === 1 ? '' : 's'} edited
              </span>
              {flippingRows.length > 0 ? (
                <>
                  {' — saving takes '}
                  <span className="font-mono">
                    {flippingRows
                      .slice(0, 4)
                      .map((r) => r.date)
                      .join(', ')}
                    {flippingRows.length > 4 &&
                      ` +${flippingRows.length - 4} more`}
                  </span>
                  {' from '}
                  {Array.from(
                    new Set(flippingRows.map((r) => OWNER_LABEL[r.owner]))
                  ).join(' / ')}
                  {'. The sync will stop updating '}
                  {flippingRows.length === 1 ? 'that day' : 'those days'} until
                  you hand {flippingRows.length === 1 ? 'it' : 'them'} back.
                </>
              ) : (
                <span className="text-muted-foreground">
                  {' '}
                  — already yours; ownership does not change.
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setDrafts({})}
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {flippingRows.length > 0
                  ? `Take ownership & save ${dirtyRows.length}`
                  : `Save ${dirtyRows.length}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Revert-to-upstream confirm (destructive-ish: discards the human value). */}
      <AlertDialog
        open={revertTarget !== null}
        onOpenChange={(v) => !v && !releasing && setRevertTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              Hand {revertTarget?.date} back to the sync?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              Ownership returns to the upstream plan
              {revertTarget?.conflict
                ? ' and the parked proposal is released'
                : ''}
              . The next sync run will overwrite this day with whatever Joseph or
              the PROD SCHED sheet says — your edit is discarded. Reported days
              stay frozen either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={releasing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={releasing}
              onClick={(e) => {
                e.preventDefault();
                if (revertTarget) void handleRelease(revertTarget);
              }}
            >
              {releasing && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Hand it back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conflict arbitration */}
      {conflictTarget?.conflict && (
        <ScheduleConflictDialog
          planDate={conflictTarget.date}
          rowVersion={conflictTarget.rowVersion}
          conflict={conflictTarget.conflict}
          open
          onOpenChange={(v) => !v && setConflictTarget(null)}
        />
      )}
    </div>
  );
}
