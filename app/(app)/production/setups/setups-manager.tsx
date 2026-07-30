'use client';

// =====================================================================
// Setup library — the management table for `production_setups`.
// =====================================================================
// Add · edit · retire · restore · reorder. Excel Standard throughout:
// `table-fixed`, explicit px widths, `min-w` equal to their sum inside
// `overflow-x-auto` ("never crush, always scroll"), `px-2 py-1` cells, `h-8`
// rows, mono right-aligned numerics.
//
// TWO THINGS THIS SCREEN HAS TO MAKE UNSURPRISING, both consequences of
// `production_schedule.setup` being FREE TEXT with no FK:
//
//   1. RETIRE IS NOT DELETE. There is no delete action at all. Retiring removes
//      a setup from the day-grid dropdown; every plan day that already carries
//      the string keeps it, reads normally, and is unaffected. Retired rows stay
//      listed here (dimmed) and can be restored.
//
//   2. EDITING A MIX IS NOT RETROACTIVE. `grades` and `projected_tons` are
//      STORED plan facts, written at plot time. Changing a mix here changes what
//      the NEXT pick projects; it never rewrites a saved day. This is deliberate
//      (a plan is a record of intent at a point in time — see
//      `lib/production/setup-projection.ts`), and the UI says so in three
//      places: the banner, the edit dialog, and the retire confirm.
//
// The per-shift tonnage shown per row is `projectSetup(mix, 1).projectedTons` —
// the ONE projection implementation, never a local `reduce()`.
//
// Motion: container `animate-fade-up` only. Rows never animate (CLAUDE.md).

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Undo2,
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
import { SetupFormDialog } from '@/components/production/setup-form-dialog';
import {
  projectSetup,
  type GradeMix,
} from '@/lib/production/setup-projection';
import {
  createProductionSetup,
  reorderProductionSetups,
  setProductionSetupActive,
  updateProductionSetup,
} from './actions';

export interface SetupLibraryRow {
  id: string;
  code: string;
  label: string | null;
  gradeMix: GradeMix;
  active: boolean;
  sortOrder: number;
  notes: string | null;
  updatedAt: string;
}

// Excel Standard: table-fixed + explicit px. 44+150+150+300+80+180+88+120.
const COL = {
  order: 'w-[44px]',
  code: 'w-[150px]',
  label: 'w-[150px]',
  mix: 'w-[300px]',
  perShift: 'w-[80px]',
  notes: 'w-[180px]',
  status: 'w-[88px]',
  actions: 'w-[120px]',
} as const;
const TABLE_MIN_W = 'min-w-[1112px]';

const HEAD_CLS =
  'frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

const ICON_BTN_CLS =
  'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30';

interface SetupsManagerProps {
  setups: SetupLibraryRow[];
  loadError: string | null;
}

export function SetupsManager({ setups, loadError }: SetupsManagerProps) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<SetupLibraryRow | null>(null);
  const [retiring, setRetiring] = React.useState<SetupLibraryRow | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const active = setups.filter((s) => s.active);
  const retired = setups.filter((s) => !s.active);

  /** Move a setup one slot within the ACTIVE block and rewrite the whole order.
   *  Retired rows keep their relative position at the end. */
  async function move(row: SetupLibraryRow, dir: -1 | 1) {
    const idx = active.findIndex((s) => s.id === row.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= active.length) return;
    const next = [...active];
    [next[idx], next[target]] = [next[target], next[idx]];

    setBusyId(row.id);
    try {
      const res = await reorderProductionSetups({
        orderedIds: [...next, ...retired].map((s) => s.id),
      });
      if (!res.ok) {
        errorToast('Could not reorder the setup library', {
          description: res.error,
        });
        return;
      }
      router.refresh();
    } catch (e) {
      errorToast('Could not reorder the setup library', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(row: SetupLibraryRow, nextActive: boolean) {
    setBusyId(row.id);
    try {
      const res = await setProductionSetupActive({
        id: row.id,
        active: nextActive,
      });
      if (!res.ok) {
        errorToast(
          `Could not ${nextActive ? 'restore' : 'retire'} "${row.code}"`,
          { description: res.error }
        );
        return;
      }
      setRetiring(null);
      toast.success(
        nextActive ? `"${row.code}" restored` : `"${row.code}" retired`,
        {
          description: nextActive
            ? 'It is pickable again on the schedule.'
            : 'It no longer appears in the schedule dropdown. Plan days that already use it are untouched.',
          duration: 4000,
        }
      );
      router.refresh();
    } catch (e) {
      errorToast('Could not update the setup', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyId(null);
    }
  }

  function renderRow(row: SetupLibraryRow, indexInActive: number | null) {
    const perShift = projectSetup(row.gradeMix, 1).projectedTons;
    const entries = Object.entries(row.gradeMix).sort((a, b) => b[1] - a[1]);
    const busy = busyId === row.id;

    return (
      <tr
        key={row.id}
        className={cn(
          'h-8 border-t transition-all duration-150 hover:bg-muted/40',
          !row.active && 'bg-muted/20 text-muted-foreground'
        )}
      >
        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
          {indexInActive == null ? '—' : indexInActive + 1}
        </td>

        <td className="px-2 py-1">
          <span
            className={cn(
              'block truncate font-mono text-xs font-semibold',
              !row.active && 'line-through decoration-muted-foreground/50'
            )}
            title={row.code}
          >
            {row.code}
          </span>
        </td>

        <td className="max-w-0 truncate px-2 py-1" title={row.label ?? ''}>
          {row.label || <span className="text-muted-foreground/50">—</span>}
        </td>

        <td className="px-2 py-1">
          <div className="flex items-center gap-1 overflow-hidden">
            {entries.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              entries.map(([grade, tons]) => (
                <span
                  key={grade}
                  className="inline-flex shrink-0 items-baseline gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none"
                >
                  <span className="uppercase tracking-tight">{grade}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {tons}t
                  </span>
                </span>
              ))
            )}
          </div>
        </td>

        <td
          className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-300"
          title="Projected tons for a one-shift day. The plan multiplies this by the day's shift count."
        >
          {perShift}
        </td>

        <td
          className="max-w-0 truncate px-2 py-1 text-muted-foreground"
          title={row.notes ?? ''}
        >
          {row.notes || <span className="text-muted-foreground/50">—</span>}
        </td>

        <td className="px-2 py-1">
          <span
            className={cn(
              'inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
              row.active
                ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {row.active ? 'Active' : 'Retired'}
          </span>
        </td>

        <td className="px-1 py-1">
          <div className="flex items-center justify-end gap-0.5">
            {busy && (
              <Loader2 className="mr-0.5 h-3 w-3 animate-spin text-muted-foreground" />
            )}
            {row.active && (
              <>
                <button
                  type="button"
                  className={ICON_BTN_CLS}
                  disabled={busy || indexInActive === 0}
                  onClick={() => void move(row, -1)}
                  title={`Move "${row.code}" up in the dropdown`}
                >
                  <ArrowUp className="h-3 w-3" />
                  <span className="sr-only">Move {row.code} up</span>
                </button>
                <button
                  type="button"
                  className={ICON_BTN_CLS}
                  disabled={
                    busy ||
                    indexInActive == null ||
                    indexInActive === active.length - 1
                  }
                  onClick={() => void move(row, 1)}
                  title={`Move "${row.code}" down in the dropdown`}
                >
                  <ArrowDown className="h-3 w-3" />
                  <span className="sr-only">Move {row.code} down</span>
                </button>
              </>
            )}
            <button
              type="button"
              className={ICON_BTN_CLS}
              disabled={busy}
              onClick={() => setEditing(row)}
              title={`Edit "${row.code}"`}
            >
              <Pencil className="h-3 w-3" />
              <span className="sr-only">Edit {row.code}</span>
            </button>
            {row.active ? (
              <button
                type="button"
                className={ICON_BTN_CLS}
                disabled={busy}
                onClick={() => setRetiring(row)}
                title={`Retire "${row.code}" — hides it from the schedule dropdown, keeps every plan day that uses it`}
              >
                <Undo2 className="h-3 w-3" />
                <span className="sr-only">Retire {row.code}</span>
              </button>
            ) : (
              <button
                type="button"
                className={ICON_BTN_CLS}
                disabled={busy}
                onClick={() => void toggleActive(row, true)}
                title={`Restore "${row.code}" to the schedule dropdown`}
              >
                <RotateCcw className="h-3 w-3" />
                <span className="sr-only">Restore {row.code}</span>
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
          A setup is a <span className="font-medium">per-shift grade mix</span>.
          The schedule multiplies it by a day&apos;s shift count to fill Grades
          and Proj t.{' '}
          <span className="font-medium text-foreground">
            Editing a mix is not retroactive
          </span>{' '}
          — days already plotted keep the tonnage stored on them, because a plan
          is a record of intent, not a live formula. Retiring hides a setup from
          the schedule dropdown; it never deletes it, and every plan day that
          already names it is untouched.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/production/schedule"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <CalendarRange className="h-3.5 w-3.5" />
            Month plan
          </Link>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            New setup
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-destructive">
            Could not load the setup library: {loadError}
          </p>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(
                `Could not load the setup library: ${loadError}`
              )
            }
            className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/15"
          >
            Copy
          </button>
        </div>
      )}

      <div className="min-w-0 animate-fade-up overflow-x-auto rounded-xl border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70">
        <table
          className={cn(
            'w-full table-fixed border-collapse text-xs',
            TABLE_MIN_W
          )}
        >
          <thead>
            <tr>
              <th className={cn(HEAD_CLS, COL.order, 'text-right')}>#</th>
              <th className={cn(HEAD_CLS, COL.code, 'text-left')}>Code</th>
              <th className={cn(HEAD_CLS, COL.label, 'text-left')}>Label</th>
              <th className={cn(HEAD_CLS, COL.mix, 'text-left')}>
                Grade mix (t / shift)
              </th>
              <th className={cn(HEAD_CLS, COL.perShift, 'text-right')}>
                t / shift
              </th>
              <th className={cn(HEAD_CLS, COL.notes, 'text-left')}>Notes</th>
              <th className={cn(HEAD_CLS, COL.status, 'text-left')}>Status</th>
              <th className={cn(HEAD_CLS, COL.actions, 'text-right')}>
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {setups.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-2 py-8 text-center text-sm text-muted-foreground"
                >
                  No setups yet. Add one to make the schedule&apos;s Setup column
                  project grades and tons.
                </td>
              </tr>
            ) : (
              <>
                {active.map((s, i) => renderRow(s, i))}
                {retired.length > 0 && (
                  <tr className="h-7 border-t bg-muted/40">
                    <td
                      colSpan={8}
                      className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      Retired · hidden from the schedule dropdown, still valid on
                      every plan day that names them
                    </td>
                  </tr>
                )}
                {retired.map((s) => renderRow(s, null))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Create */}
      <SetupFormDialog
        open={creating}
        onOpenChange={setCreating}
        showMeta
        onSubmit={async (values) => {
          const res = await createProductionSetup(values);
          if (res.ok) {
            toast.success(`Setup "${values.code}" created`, { duration: 3000 });
            router.refresh();
          }
          return res;
        }}
      />

      {/* Edit */}
      {editing && (
        <SetupFormDialog
          open
          onOpenChange={(v) => !v && setEditing(null)}
          showMeta
          initial={{
            code: editing.code,
            label: editing.label,
            gradeMix: editing.gradeMix,
            notes: editing.notes,
          }}
          onSubmit={async (values) => {
            const res = await updateProductionSetup({
              id: editing.id,
              values,
            });
            if (res.ok) {
              setEditing(null);
              toast.success(`Setup "${values.code}" saved`, {
                description:
                  values.code !== editing.code
                    ? `Plan days that already say "${editing.code}" keep that label — the schedule stores the string, not a link.`
                    : 'Days already plotted keep their stored tonnage.',
                duration: 5000,
              });
              router.refresh();
            }
            return res;
          }}
        />
      )}

      {/* Retire */}
      <AlertDialog
        open={retiring !== null}
        onOpenChange={(v) => !v && setRetiring(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              Retire &ldquo;{retiring?.code}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              It disappears from the schedule&apos;s Setup dropdown so nobody
              plots it again. Nothing is deleted: every plan day that already
              names it keeps the label and its stored tonnage, and the setup
              stays listed here so you can restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId !== null}
              onClick={(e) => {
                e.preventDefault();
                if (retiring) void toggleActive(retiring, false);
              }}
            >
              {busyId !== null && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
