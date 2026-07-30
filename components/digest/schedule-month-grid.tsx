'use client';

// =====================================================================
// Production Schedule — the editable MONTH grid (Phase B).
// =====================================================================
// The dense Excel-Standard month table, inline-editable. Built on the shared
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
//   • A day carrying a parked upstream proposal shows an amber conflict button
//     that opens the field-by-field arbitration dialog.
//
// ─────────────────────────────────────────────────────────────────────────────
// REPORTEDNESS FREEZES THE SYNC, NOT THE HUMAN  (migration 20260730090000)
// ─────────────────────────────────────────────────────────────────────────────
// This grid used to render a reported day as plain, padlocked <td>s with nothing
// to click. That was one line (`isScheduleDayEditable`) and it locked 166 of the
// calendar's 273 days out of reach. Both human RPCs dropped their actuals
// freeze; only the SYNC's `fn_apply_schedule_upstream` still has one.
//
// So EVERY day is editable here, and reportedness is shown WITHOUT gating:
//   • an emerald check on the date cell (not a padlock — a padlock would lie),
//   • the emerald `Actual` owner chip, unchanged,
//   • a sky "corrected" badge driven by `human_edit_after_report`, the signal
//     `effective_owner` hides once a day is reported,
//   • a ONE-TIME confirm before the first edit of a reported day in a session,
//     because that edit changes plan-vs-actual history.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SETUP PROJECTION  (the "changing setup doesn't compute the grades" fix)
// ─────────────────────────────────────────────────────────────────────────────
// SETUP is a dropdown over `production_setups`, not free text. The recompute
// rule, stated exactly once, here:
//
//   A. PICKING A SETUP FROM THE LIBRARY ALWAYS RECOMPUTES `grades` +
//      `projected_tons` for the day's current shift count — overwriting whatever
//      was there. Choosing a template is an explicit request for that template.
//
//   B. CHANGING `shifts` RECOMPUTES **ONLY IF THE DAY IS STILL ON-TEMPLATE** —
//      i.e. `isOnTemplate(projection-at-the-OLD-shift-count, stored grades,
//      stored tons)`. A day the operator overrode (SOLID 3X50 at 30 t instead of
//      25) keeps its numbers; bumping the shift count must not silently discard
//      a deliberate override. On-template days rescale, which is the whole point
//      of a per-shift mix.
//
//   C. TWO PICKS DO NOT RECOMPUTE, because neither names a template:
//      "— No setup" (clears the label only — a day with 2 shifts and no setup
//      name is a labelling gap, not a rest day, and zeroing its tonnage would be
//      destructive), and re-picking a LEGACY setup string that is not in the
//      library (there is no mix to project from — the cell says so).
//
// `projected_tons` stays freely editable after the projection fills it; an
// off-template day is BADGED, never blocked (per-day overrides are normal — see
// lib/production/setup-projection.ts). The math itself is never reimplemented
// here: `projectSetupByCode` / `isOnTemplate` are imported.
//
// Motion rules (CLAUDE.md): the CONTAINER animates (`animate-fade-up`), rows
// never do. No stagger, no per-row entrance. Row hover is
// `transition-all duration-150`.
//
// No ₱ anywhere in the schedule → this file never touches price gating.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  CircleCheck,
  Library,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
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
import {
  fmtGradeTons,
  gradeTonsTitle,
  parseGradeTons,
  type GradeTon,
} from '@/components/digest/format';
import {
  HUMAN_EDIT_AFTER_REPORT_HINT,
  OWNER_CHIP,
  OWNER_HINT,
  OWNER_LABEL,
  REPORTED_HINT,
} from '@/components/digest/schedule-owner';
import {
  SCHEDULE_COLUMN_MAP,
  scheduleFieldToString,
  type ScheduleEditableField,
  type ScheduleGridRow,
} from '@/components/digest/schedule-types';
import { ScheduleConflictDialog } from '@/components/digest/schedule-conflict-dialog';
import { ScheduleSetupCell } from '@/components/digest/schedule-setup-cell';
import { SetupFormDialog } from '@/components/production/setup-form-dialog';
import {
  isOnTemplate,
  projectSetupByCode,
  type GradeMix,
  type ProductionSetup,
} from '@/lib/production/setup-projection';
import { createProductionSetup } from '@/app/(app)/production/setups/actions';
import {
  releaseScheduleDay,
  saveScheduleDay,
  type SchedulePatch,
} from '@/app/(app)/production/schedule/actions';

// ---------------------------------------------------------------------
// Column widths — Excel Standard: table-fixed + explicit px, and a min-width
// equal to their SUM so the wrapper scrolls instead of crushing a column
// ("never crush, always scroll"). SETUP gained 22px for the dropdown chevron so
// `3X50 / 8X50` still reads without truncating; the sum below moved with it.
// ---------------------------------------------------------------------
const COL = {
  // Wide enough for `yyyy-MM-dd` PLUS the reported marker without wrapping.
  date: 'w-[116px]',
  day: 'w-[52px]',
  setup: 'w-[150px]',
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

/** 116+52+150+156+58+84+78+76+76+108+128+216+64 */
const TABLE_MIN_W = 'min-w-[1362px]';

const HEAD_CLS =
  'frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

/**
 * EDITABILITY AFFORDANCE (the "you can type here" cue).
 *
 * Nothing on a Blackwood grid announces that a cell is editable — you have to
 * already know the click/type · F2 · Enter model. On a table that is mostly
 * READ-ONLY columns (actual tons, hours, variance, status, owner) with the
 * editable ones scattered among them, that is unreadable, so they get a cue.
 *
 * Reused, not invented: `cursor-cell` is the house pointer for a selectable grid
 * cell (`summaries/supplier-brief-client.tsx`, `price-demos/demo4`), and the soft
 * tint + inset hairline mirrors `shared/grid/DatePickerCell`'s
 * `hover:border-blue-500/60 hover:bg-blue-500/5` treatment. `transition-colors
 * duration-150` is the micro-interaction budget (CLAUDE.md).
 *
 * A per-cell pencil icon was deliberately rejected: 31 days × 4 columns = 124
 * icons of permanent noise in a dense grid. Hover is the right weight.
 *
 * The hover half is suppressed on the ACTIVE cell so its hairline can never
 * shrink that cell's `ring-2 ring-primary` selection ring (a hover pseudo-class
 * would out-specify it).
 */
const EDITABLE_CELL_HOVER_CLS =
  'transition-colors duration-150 hover:bg-sky-500/10 hover:ring-1 hover:ring-inset hover:ring-sky-500/40';

/**
 * Has the operator already accepted, in THIS browsing session, that editing a
 * reported day rewrites plan-vs-actual history?
 *
 * Module-level on purpose. Month navigation is a `<Link>`, so the grid remounts
 * on every prev/next — a component-state flag would re-ask constantly, and a
 * confirm you see ten times a day is a click reflex, not a safeguard. It resets
 * on a full page load, which is the right granularity for "a session".
 */
let reportedEditAcknowledged = false;

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

/** Do two grade mixes hold the same tonnages? (Key order is irrelevant.) */
function sameMix(a: GradeMix | null, b: GradeMix | null): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  return xk.every((k) => k in y && Math.abs(x[k] - y[k]) <= 1e-6);
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
/** Per-day recomputed grade mix. Present ⇒ the projection ran for that day. */
type GradeDraftMap = Record<string, GradeMix | null>;

interface ScheduleMonthGridProps {
  rows: ScheduleGridRow[];
  /** The ACTIVE setup library, in `sort_order`. Retired setups are absent by
   *  design — they stay valid on saved days but must not be pickable. */
  setups: readonly ProductionSetup[];
  /** Presentational month footer totals, computed by the server component. */
  totals: {
    projected: number;
    actual: number;
    actualHrs: number;
    variance: number;
  };
}

export function ScheduleMonthGrid({
  rows,
  setups,
  totals,
}: ScheduleMonthGridProps) {
  const router = useRouter();
  const gridRef = React.useRef<HTMLDivElement>(null);

  const [drafts, setDrafts] = React.useState<DraftMap>({});
  const [gradeDrafts, setGradeDrafts] = React.useState<GradeDraftMap>({});
  const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [releasing, setReleasing] = React.useState(false);
  const [revertTarget, setRevertTarget] =
    React.useState<ScheduleGridRow | null>(null);
  const [conflictTarget, setConflictTarget] =
    React.useState<ScheduleGridRow | null>(null);
  /** Which row's setup dropdown is open (keyboard F2/Enter opens it too). */
  const [openSetupRow, setOpenSetupRow] = React.useState<number | null>(null);
  /** Which row the inline "+ New setup…" dialog will apply to on success. */
  const [newSetupForRow, setNewSetupForRow] = React.useState<number | null>(
    null
  );
  const [ackReported, setAckReported] = React.useState(
    reportedEditAcknowledged
  );
  /** The edit the operator asked for, held until they confirm the history note. */
  const [pendingReportedEdit, setPendingReportedEdit] = React.useState<
    { date: string; run: () => void } | null
  >(null);

  // A fresh server payload (post-save router.refresh, or a month change) makes
  // every draft stale — the row_versions it was keyed to no longer exist.
  const rowsKey = React.useMemo(
    () => rows.map((r) => `${r.date}:${r.rowVersion}`).join(','),
    [rows]
  );
  React.useEffect(() => {
    setDrafts({});
    setGradeDrafts({});
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

  /** The day's grade mix as it currently stands (draft first, then stored). */
  const gradesOf = React.useCallback(
    (row: ScheduleGridRow): GradeMix | null =>
      row.date in gradeDrafts ? gradeDrafts[row.date] : row.grades,
    [gradeDrafts]
  );

  /** Everything the projection reasons about, draft-aware. */
  const effectiveOf = React.useCallback(
    (rowIdx: number) => {
      const row = rows[rowIdx];
      const setup = norm(valueOf(rowIdx, 'setup'));
      const shifts = Number.parseInt(valueOf(rowIdx, 'shifts'), 10);
      const tonsRaw = norm(valueOf(rowIdx, 'projected_tons'));
      const tons = tonsRaw === '' ? null : Number.parseFloat(tonsRaw);
      return {
        setup,
        shifts: Number.isFinite(shifts) ? shifts : 0,
        tons: tons != null && Number.isFinite(tons) ? tons : null,
        grades: gradesOf(row),
        inLibrary: setups.some((s) => s.code === setup),
      };
    },
    [rows, valueOf, gradesOf, setups]
  );

  const setValueAt = React.useCallback(
    (rowIdx: number, field: ScheduleEditableField, value: string) => {
      const row = rows[rowIdx];
      if (!row) return;
      setDrafts((prev) => ({
        ...prev,
        [row.date]: { ...prev[row.date], [field]: value },
      }));
    },
    [rows]
  );

  /** Write a projection's outputs into the day's drafts (rule A and rule B). */
  const applyProjection = React.useCallback(
    (
      row: ScheduleGridRow,
      projection: { grades: GradeMix | null; projectedTons: number },
      extra?: Partial<Record<ScheduleEditableField, string>>
    ) => {
      setDrafts((prev) => ({
        ...prev,
        [row.date]: {
          ...prev[row.date],
          ...extra,
          projected_tons: String(projection.projectedTons),
        },
      }));
      setGradeDrafts((prev) => ({ ...prev, [row.date]: projection.grades }));
    },
    []
  );

  // ---- RULE A: picking a library setup always recomputes ----
  const pickSetup = React.useCallback(
    (rowIdx: number, code: string) => {
      const row = rows[rowIdx];
      if (!row) return;
      const known = setups.some((s) => s.code === code);
      if (!known) {
        // RULE C: a legacy string has no mix to project from — set the label
        // only. The dropdown labels it "not in library" so this is not a
        // surprise.
        setValueAt(rowIdx, 'setup', code);
        return;
      }
      const shifts = effectiveOf(rowIdx).shifts;
      applyProjection(row, projectSetupByCode(setups, code, shifts), {
        setup: code,
      });
    },
    [rows, setups, effectiveOf, applyProjection, setValueAt]
  );

  // ---- RULE C: "— No setup" clears the LABEL, never the tonnage ----
  const clearSetup = React.useCallback(
    (rowIdx: number) => setValueAt(rowIdx, 'setup', ''),
    [setValueAt]
  );

  // ---- RULE B: a shift change rescales an ON-TEMPLATE day only ----
  const setShifts = React.useCallback(
    (rowIdx: number, raw: string) => {
      const row = rows[rowIdx];
      if (!row) return;
      const before = effectiveOf(rowIdx);
      setValueAt(rowIdx, 'shifts', raw);

      if (!before.inLibrary) return; // nothing to project from
      const wasOnTemplate = isOnTemplate(
        projectSetupByCode(setups, before.setup, before.shifts),
        before.grades,
        before.tons
      );
      if (!wasOnTemplate) return; // a deliberate override survives a shift change

      const next = Number.parseInt(norm(raw), 10);
      applyProjection(
        row,
        projectSetupByCode(setups, before.setup, Number.isFinite(next) ? next : 0)
      );
    },
    [rows, setups, effectiveOf, setValueAt, applyProjection]
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

  const gradesChangedFor = React.useCallback(
    (row: ScheduleGridRow): boolean =>
      row.date in gradeDrafts && !sameMix(gradeDrafts[row.date], row.grades),
    [gradeDrafts]
  );

  const isRowDirty = React.useCallback(
    (row: ScheduleGridRow) =>
      changedFieldsFor(row).length > 0 || gradesChangedFor(row),
    [changedFieldsFor, gradesChangedFor]
  );

  const dirtyRows = React.useMemo(
    () => rows.filter(isRowDirty),
    [rows, isRowDirty]
  );
  /** Dirty days whose ownership is ABOUT to move to the human. */
  const flippingRows = React.useMemo(
    () => dirtyRows.filter((r) => r.owner !== 'human'),
    [dirtyRows]
  );
  /** Dirty days that already have reported production — the history warning. */
  const dirtyReportedRows = React.useMemo(
    () => dirtyRows.filter((r) => r.isReported),
    [dirtyRows]
  );

  // ---------------- the reported-day confirm ----------------

  /** Run `action`, but on a REPORTED day ask once per session first. */
  const guardReported = React.useCallback(
    (row: ScheduleGridRow, action: () => void) => {
      if (!row.isReported || ackReported) {
        action();
        return;
      }
      setPendingReportedEdit({ date: row.date, run: action });
    },
    [ackReported]
  );

  function confirmReportedEdit() {
    const pending = pendingReportedEdit;
    reportedEditAcknowledged = true;
    setAckReported(true);
    setPendingReportedEdit(null);
    // Let the AlertDialog finish unmounting before handing focus to an editor
    // or a dropdown — Radix restores focus to the trigger on close.
    if (pending) setTimeout(pending.run, 0);
  }

  // ---------------- shared grid primitives ----------------

  const editSession = useGridEditSession<CoordinateId>({
    getValue: (id) => {
      const field = SCHEDULE_COLUMN_MAP[id.col];
      return field ? valueOf(id.row, field) : '';
    },
    setValue: (id, v) => {
      const field = SCHEDULE_COLUMN_MAP[id.col];
      if (!field) return;
      if (field === 'shifts') setShifts(id.row, v);
      else setValueAt(id.row, field, v);
    },
  });

  const openSetupMenu = React.useCallback(
    (rowIdx: number) => {
      const row = rows[rowIdx];
      if (!row) return;
      setActiveCell({ row: rowIdx, col: 2 });
      guardReported(row, () => setOpenSetupRow(rowIdx));
    },
    [rows, guardReported]
  );

  const startEditing = React.useCallback(
    (rowIdx: number, colIdx: number, initialChar?: string) => {
      const row = rows[rowIdx];
      if (!row) return;
      // The setup column has no inline editor — F2 / Enter / double-click open
      // its dropdown instead, so the keyboard model is unbroken.
      if (colIdx === 2) {
        openSetupMenu(rowIdx);
        return;
      }
      if (SCHEDULE_COLUMN_MAP[colIdx] == null) return;
      setActiveCell({ row: rowIdx, col: colIdx });
      guardReported(row, () =>
        editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar)
      );
    },
    [rows, editSession, guardReported, openSetupMenu]
  );

  const revertCellEdit = React.useCallback(() => {
    editSession.revertChanges();
    gridRef.current?.focus();
  }, [editSession]);

  // Coordinate resolver = the canonical moveSelection math. `isEditable` is
  // overridden for the SETUP column so a printable keystroke can never mount a
  // phantom inline editor over a dropdown cell — F2/Enter route to the menu via
  // `startEditing` instead. (Same posture as the Cenapro ledger's dropdown
  // columns, which stay in the column map so nav reaches them.)
  const resolver = React.useMemo<NavResolver<CoordinateId>>(() => {
    const base = createCoordinateNavResolver({
      rowCount: rows.length,
      columnMap: SCHEDULE_COLUMN_MAP,
    });
    return {
      ...base,
      isEditable: (id) => id.col !== 2 && base.isEditable(id),
    };
  }, [rows.length]);

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

  // F2 / Enter on a SELECTED setup cell must still do something. The nav hook
  // only calls `edit.start` when `resolver.isEditable` is true, which col 2 is
  // not, so the grid handles those two keys itself before the hook sees them.
  const handleGridKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (
        !editSession.isEditing &&
        activeCell?.col === 2 &&
        (e.key === 'F2' || e.key === ' ')
      ) {
        e.preventDefault();
        openSetupMenu(activeCell.row);
        return;
      }
      handleKeyDown(e);
    },
    [editSession.isEditing, activeCell, openSetupMenu, handleKeyDown]
  );

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
        // `grades` is never typed — it rides along only when the projection
        // actually produced something different from what is stored.
        if (gradesChangedFor(row)) patch.grades = gradeDrafts[row.date];

        const res = await saveScheduleDay({
          planDate: row.date,
          expectedRowVersion: row.rowVersion,
          patch,
        });
        if (res.ok) {
          savedCount++;
        } else {
          // Every failure outcome (version_conflict / missing) means the draft
          // cannot be replayed as-is, so it is discarded below. Carry the typed
          // values into the (persistent, copyable) error toast so the operator
          // can paste them back instead of retyping from memory.
          const attempted = Object.entries(patch)
            .map(([k, v]) => {
              if (v === null) return `${k}=(cleared)`;
              if (typeof v === 'object')
                return `${k}=${Object.entries(v)
                  .map(([g, t]) => `${g} ${t}t`)
                  .join(' + ')}`;
              return `${k}=${v}`;
            })
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
      toast.success(`Saved ${savedCount} day${savedCount === 1 ? '' : 's'}`, {
        description:
          flippingRows.length > 0
            ? `${flippingRows.length} day${flippingRows.length === 1 ? '' : 's'} now owned by you — the sync will no longer update ${flippingRows.length === 1 ? 'it' : 'them'}.`
            : undefined,
        duration: 4000,
      });
    }
    setDrafts({});
    setGradeDrafts({});
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
        description: row.isReported
          ? 'Ownership returns to the upstream plan. The values stay as they are — the sync never writes a reported day.'
          : 'The next run will overwrite it with the upstream plan. Your edit is gone.',
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
    const isActiveCell =
      activeCell?.row === rowIdx && activeCell?.col === colIdx;
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
          opts.mono && 'font-mono tabular-nums',
          // "You can type here." See EDITABLE_CELL_HOVER_CLS above.
          'cursor-cell',
          !isActiveCell && EDITABLE_CELL_HOVER_CLS
        )}
        displayValue={
          <span className="w-full truncate" title={opts.title ?? value}>
            {opts.display ??
              (value || <span className="text-muted-foreground/50">—</span>)}
          </span>
        }
      >
        <EditInput
          autoFocus
          value={value}
          onChange={(v) =>
            field === 'shifts'
              ? setShifts(rowIdx, v)
              : setValueAt(rowIdx, field, v)
          }
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

  const newSetupRow = newSetupForRow == null ? null : rows[newSetupForRow];

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {/* Stated BEFORE anyone types: (1) this grid IS editable and how; (2) how
          the setup dropdown drives the projection; (3) the ownership
          consequence. One dense muted block, not a callout box. */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">
            Setup, Shifts, Proj t and Remarks are editable
          </span>{' '}
          — click a cell and start typing, or press{' '}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            F2
          </kbd>{' '}
          (
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            F2
          </kbd>{' '}
          /{' '}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            Space
          </kbd>{' '}
          opens the Setup picker);{' '}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            Esc
          </kbd>{' '}
          cancels.{' '}
          <span className="font-medium text-foreground">Setup is a picker</span>{' '}
          — choosing one fills Grades and Proj t from its per-shift mix, and
          changing Shifts rescales them while the day still matches that mix
          (once you override a figure it is kept, marked{' '}
          <span className="font-mono text-amber-700 dark:text-amber-300">*</span>
          ). Editing any cell takes the{' '}
          <span className="font-medium">whole day</span> — ownership flips to{' '}
          <span className="font-medium">You</span> and the daily sync stops
          updating that date until you hand it back. Reported days (
          <CircleCheck className="inline h-3 w-3 -translate-y-px text-emerald-600 dark:text-emerald-400" />
          ) stay editable so you can correct a past plan.
        </p>
        <Link
          href="/production/setups"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <Library className="h-3.5 w-3.5" />
          Setup library
        </Link>
      </div>

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
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
              const dirtyFields = changedFieldsFor(r);
              const isDirty = dirtyFields.length > 0 || gradesChangedFor(r);
              // The ownership flip is previewed, not announced after the fact.
              const willFlip = isDirty && r.owner !== 'human';
              const chipState =
                r.isToday && r.state !== 'reported' ? 'today' : r.state;
              const shownOwner = willFlip ? 'human' : r.effectiveOwner;

              const eff = effectiveOf(i);
              const displayGrades: GradeTon[] =
                r.date in gradeDrafts
                  ? parseGradeTons(gradeDrafts[r.date])
                  : r.gradeTons;
              // A library day whose stored figures no longer match its own mix.
              // Normal and expected — badged, never blocked.
              const offTemplate =
                eff.inLibrary &&
                !isOnTemplate(
                  projectSetupByCode(setups, eff.setup, eff.shifts),
                  eff.grades,
                  eff.tons
                );

              return (
                <tr
                  key={r.date}
                  className={cn(
                    'h-8 border-t transition-all duration-150 hover:bg-muted/40',
                    r.isRest && 'bg-muted/20 text-muted-foreground',
                    r.isToday && 'bg-amber-500/[0.07]',
                    r.isReported && 'bg-emerald-500/[0.04]',
                    isDirty && 'bg-sky-500/[0.07]'
                  )}
                >
                  {/* 0 · DATE — carries the dirty rail + the reported marker. */}
                  <td
                    className={cn(
                      'whitespace-nowrap border-l-2 px-2 py-1 font-mono tabular-nums',
                      isDirty ? 'border-l-sky-500' : 'border-l-transparent',
                      r.isToday && 'font-semibold text-foreground'
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {r.date}
                      {r.isReported && (
                        // NOT a padlock. Reportedness stopped being a lock when
                        // the human RPCs dropped their actuals freeze; drawing
                        // one here would be the same lie the old code told.
                        <CircleCheck
                          className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-label="Production reported"
                        >
                          <title>{REPORTED_HINT}</title>
                        </CircleCheck>
                      )}
                    </span>
                  </td>

                  {/* 1 · DAY */}
                  <td className="px-2 py-1">{r.dow.slice(0, 3)}</td>

                  {/* 2 · SETUP — a dropdown over the ACTIVE setup library. */}
                  <td
                    className={cn(
                      'h-8 p-0',
                      activeCell?.row === i &&
                        activeCell?.col === 2 &&
                        'relative z-10 ring-2 ring-inset ring-primary'
                    )}
                    // CAPTURE phase: the trigger button stops propagation on
                    // mousedown (so opening the menu can never start a drag),
                    // so a bubbling handler here would never fire.
                    onMouseDownCapture={() => setActiveCell({ row: i, col: 2 })}
                  >
                    <ScheduleSetupCell
                      value={valueOf(i, 'setup')}
                      setups={setups}
                      open={openSetupRow === i}
                      onOpenChange={(v) => setOpenSetupRow(v ? i : null)}
                      onPickSetup={(code) =>
                        guardReported(r, () => pickSetup(i, code))
                      }
                      onClear={() => guardReported(r, () => clearSetup(i))}
                      onCreateNew={() =>
                        guardReported(r, () => setNewSetupForRow(i))
                      }
                    />
                  </td>

                  {/* 3 · GRADES — read-only, but LIVE: it re-renders from the
                      projection the moment a setup or shift count changes. */}
                  <td className="px-2 py-1">
                    {displayGrades.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div
                        className="flex items-center gap-1 overflow-hidden"
                        title={gradeTonsTitle(displayGrades)}
                      >
                        {displayGrades.map((g) => (
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

                  {/* 4 · SHIFTS (editable — rescales an on-template day) */}
                  <td className="h-8 p-0">
                    {editableCell(i, 4, 'shifts', {
                      align: 'right',
                      mono: true,
                    })}
                  </td>

                  {/* 5 · PROJECTED TONS — derived by the projection, STORED,
                      and still freely editable. */}
                  <td className="h-8 p-0">
                    {editableCell(i, 5, 'projected_tons', {
                      align: 'right',
                      mono: true,
                      title: offTemplate
                        ? `Overridden — "${eff.setup}" at ${eff.shifts} shift${eff.shifts === 1 ? '' : 's'} would project ${projectSetupByCode(setups, eff.setup, eff.shifts).projectedTons} t. The stored figure is kept.`
                        : valueOf(i, 'projected_tons'),
                      display: (
                        <span className="flex w-full items-baseline justify-end gap-0.5 text-violet-600 dark:text-violet-300">
                          {valueOf(i, 'projected_tons') || '—'}
                          {offTemplate && (
                            <span className="text-amber-700 dark:text-amber-300">
                              *
                            </span>
                          )}
                        </span>
                      ),
                    })}
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
                        {OWNER_LABEL[shownOwner]}
                        {willFlip && '?'}
                      </span>
                      {/* `effective_owner` collapses to 'actual' the moment a
                          day is reported, so a human correction would otherwise
                          be invisible. This badge is that signal. */}
                      {r.humanEditAfterReport && !willFlip && (
                        <span
                          className="inline-flex shrink-0 items-center rounded bg-sky-500/12 px-1 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300"
                          title={HUMAN_EDIT_AFTER_REPORT_HINT}
                        >
                          corrected
                        </span>
                      )}
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
                  <td className="h-8 p-0">
                    {editableCell(i, 11, 'remarks', {
                      placeholder: 'Remarks',
                      display: (
                        <span className="w-full truncate text-muted-foreground">
                          {valueOf(i, 'remarks')}
                        </span>
                      ),
                      title: valueOf(i, 'remarks'),
                    })}
                  </td>

                  {/* 12 · ACTIONS — hand a human-owned day back to the sync.
                      Reported days included: release is inert on them (it only
                      drops the ownership claim; the sync still cannot write
                      them), and withholding it would re-create the one-way
                      ratchet that migration 20260730090000 removed. */}
                  <td className="px-1 py-1 text-center">
                    {r.owner === 'human' ? (
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
              {dirtyReportedRows.length > 0 && (
                <span className="text-emerald-700 dark:text-emerald-400">
                  {' '}
                  {dirtyReportedRows.length} of them already{' '}
                  {dirtyReportedRows.length === 1 ? 'has' : 'have'} reported
                  production — you are correcting plan-vs-actual history.
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setDrafts({});
                  setGradeDrafts({});
                }}
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {flippingRows.length > 0
                  ? `Take ownership & save ${dirtyRows.length}`
                  : `Save ${dirtyRows.length}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Editing a REPORTED day — asked ONCE per session, then never again. */}
      <AlertDialog
        open={pendingReportedEdit !== null}
        onOpenChange={(v) => !v && setPendingReportedEdit(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              Edit the plan for {pendingReportedEdit?.date}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              Production has already been reported for this date, so changing
              the plan changes plan-vs-actual history — the variance on this row,
              and every month figure built from it, will move. Correcting a
              mis-plotted past day is exactly what this is for; just know that is
              what you are doing. The day will be marked{' '}
              <span className="font-medium">corrected</span>, and the daily sync
              will still never write it.
              <span className="mt-1.5 block text-muted-foreground">
                Asked once per session.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmReportedEdit();
              }}
            >
              Edit anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              .{' '}
              {revertTarget?.isReported
                ? 'This day already has reported production, so the sync will never write it — the values stay exactly as they are and only the ownership label moves.'
                : 'The next sync run will overwrite this day with whatever Joseph or the PROD SCHED sheet says — your edit is discarded.'}
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

      {/* Inline "+ New setup…" — creates the library row, then applies it to the
          day that opened it, in the same motion. */}
      {newSetupRow && (
        <SetupFormDialog
          open
          onOpenChange={(v) => !v && setNewSetupForRow(null)}
          contextNote={`Saving adds it to the library and applies it to ${newSetupRow.date}.`}
          onSubmit={async (values) => {
            const res = await createProductionSetup(values);
            if (!res.ok || !res.code) return res;
            const shifts = effectiveOf(rows.indexOf(newSetupRow)).shifts;
            // The library prop is a SERVER value and will not include the new
            // setup until `router.refresh()` lands, so project from the mix the
            // operator just typed rather than looking it up.
            applyProjection(
              newSetupRow,
              projectSetupByCode(
                [
                  {
                    code: res.code,
                    label: values.label,
                    gradeMix: values.gradeMix,
                    active: true,
                    sortOrder: 0,
                    notes: values.notes,
                  },
                ],
                res.code,
                shifts
              ),
              { setup: res.code }
            );
            setNewSetupForRow(null);
            router.refresh();
            toast.success(`Setup "${res.code}" created`, {
              description: `Applied to ${newSetupRow.date} — review the projection, then save.`,
              duration: 4000,
            });
            return { ok: true };
          }}
        />
      )}

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
