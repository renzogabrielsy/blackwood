'use client';

// =====================================================================
// Production Schedule — upstream-conflict arbitration dialog.
// =====================================================================
// A day the human owns whose upstream (Joseph) value the sync WITHHELD. The
// proposal is parked in `production_schedule.pending_upstream` and surfaced by
// `view_production_schedule_conflicts`, which carries BOTH sides plus the exact
// `changed_fields` — so this dialog renders a precise field-by-field diff, never
// two opaque JSON blobs.
//
// Two outcomes, both explicit arbitrations (the ONLY callers that pass
// `clear_pending: true` to fn_save_schedule_day):
//   • Take Joseph's — write his proposed values + clear the pending. The day
//     stays human-owned; the sync's own rule-4 "reclaim" hands ownership back on
//     the next run precisely because the values now match upstream.
//   • Keep mine     — clear the pending, values untouched, day stays human-owned.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import {
  keepMineClearPending,
  takeUpstreamProposal,
} from '@/app/(app)/production/schedule/actions';
import type { ScheduleConflict, ScheduleConflictSide } from './schedule-types';

const FIELD_LABEL: Record<string, string> = {
  shifts: 'Shifts',
  setup: 'Setup',
  projected_tons: 'Projected tons',
  grades: 'Grades',
  remarks: 'Remarks',
  source: 'Source',
};

/** Fields "take Joseph's" can write. `grades` JOINED this set once the setup
 *  library gave the app a writer for it (see `SchedulePatch` in
 *  `schedule/actions.ts`) — a grades difference is now carried across like any
 *  other, so the dialog no longer has to apologise for dropping it. `source` is
 *  provenance, not a plan value, and stays read-only. */
const WRITABLE = new Set([
  'shifts',
  'setup',
  'projected_tons',
  'grades',
  'remarks',
]);

/** Render one side's value for a field as compact display text. */
function fmtField(side: ScheduleConflictSide | null, field: string): string {
  if (!side) return '—';
  switch (field) {
    case 'shifts':
      return side.shifts == null ? '—' : String(side.shifts);
    case 'projected_tons':
      return side.projected_tons == null ? '—' : String(side.projected_tons);
    case 'setup':
      return side.setup?.trim() || '—';
    case 'remarks':
      return side.remarks?.trim() || '—';
    case 'source':
      return side.source?.trim() || '—';
    case 'grades': {
      const g = side.grades;
      if (!g) return '—';
      const entries = Object.entries(g);
      if (entries.length === 0) return '—';
      return entries.map(([k, v]) => `${k} ${v}t`).join(' · ');
    }
    default:
      return '—';
  }
}

interface ScheduleConflictDialogProps {
  planDate: string;
  rowVersion: number;
  conflict: ScheduleConflict;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScheduleConflictDialog({
  planDate,
  rowVersion,
  conflict,
  open,
  onOpenChange,
}: ScheduleConflictDialogProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<'mine' | 'joseph' | null>(null);

  // Only the fields the sync actually flagged. Fall back to the full writable
  // set if changed_fields is somehow empty, so the operator is never shown an
  // arbitration with nothing in it.
  const fields = React.useMemo(() => {
    const changed = conflict.changedFields.filter((f) => f in FIELD_LABEL);
    return changed.length > 0 ? changed : [...WRITABLE];
  }, [conflict.changedFields]);

  /** Nothing on this conflict can be written by "take Joseph's" (only `source`
   *  differs). Rare, but the dialog must not promise a write it cannot make. */
  const readOnlyOnly = fields.length > 0 && fields.every((f) => !WRITABLE.has(f));

  async function run(kind: 'mine' | 'joseph') {
    setBusy(kind);
    try {
      const res =
        kind === 'joseph'
          ? await takeUpstreamProposal({
              planDate,
              expectedRowVersion: rowVersion,
              proposed: {
                shifts: conflict.proposed?.shifts ?? 0,
                setup: conflict.proposed?.setup ?? null,
                projected_tons: conflict.proposed?.projected_tons ?? null,
                grades: conflict.proposed?.grades ?? null,
                remarks: conflict.proposed?.remarks ?? null,
              },
            })
          : await keepMineClearPending({
              planDate,
              expectedRowVersion: rowVersion,
            });

      if (!res.ok) {
        errorToast(`Could not resolve ${planDate}`, {
          description: res.error ?? `Outcome: ${res.outcome}`,
        });
        return;
      }
      toast.success(
        kind === 'joseph'
          ? `${planDate} now matches Joseph's plan`
          : `${planDate} kept your values`,
        {
          description:
            kind === 'joseph'
              ? 'The sync will resume following this day on the next run.'
              : "Joseph's proposal was discarded. The day stays yours.",
          duration: 4000,
        }
      );
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      errorToast(`Could not resolve ${planDate}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Upstream change withheld · {planDate}
          </DialogTitle>
          <DialogDescription className="text-xs">
            You own this day, so the sync did not apply Joseph&apos;s newer plan
            — it parked it here instead. Pick a side; nothing else on the
            calendar is touched.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[520px] table-fixed border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-[140px] bg-muted px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Field
                </th>
                <th className="bg-muted px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                  Yours (current)
                </th>
                <th className="w-[28px] bg-muted px-1 py-1.5" />
                <th className="bg-muted px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                  Joseph proposes
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const mine = fmtField(conflict.current, f);
                const theirs = fmtField(conflict.proposed, f);
                const numeric = f === 'shifts' || f === 'projected_tons';
                return (
                  <tr key={f} className="h-8 border-t">
                    <td className="px-2 py-1 font-medium text-muted-foreground">
                      {FIELD_LABEL[f] ?? f}
                      {!WRITABLE.has(f) && (
                        <span className="ml-1 text-[10px] text-muted-foreground/70">
                          (read-only)
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(
                        'max-w-0 truncate px-2 py-1',
                        numeric && 'font-mono tabular-nums'
                      )}
                      title={mine}
                    >
                      {mine}
                    </td>
                    <td className="px-1 py-1 text-muted-foreground/50">
                      <ArrowRight className="h-3 w-3" />
                    </td>
                    <td
                      className={cn(
                        'max-w-0 truncate px-2 py-1 font-medium',
                        numeric && 'font-mono tabular-nums'
                      )}
                      title={theirs}
                    >
                      {theirs}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {readOnlyOnly ? (
            <>
              Only read-only fields differ, so &ldquo;Take Joseph&apos;s&rdquo;
              has nothing to write — it will clear the parked proposal and let
              the next sync re-apply it in full.
            </>
          ) : (
            <>
              <span className="font-medium">Take Joseph&apos;s</span> overwrites
              the fields above and hands the day back to the sync on its next
              run. <span className="font-medium">Keep mine</span> discards his
              proposal and leaves the day yours.
            </>
          )}
          {conflict.observedAt && (
            <>
              {' '}
              Observed {conflict.observedAt.slice(0, 16).replace('T', ' ')}.
            </>
          )}
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('mine')}
          >
            {busy === 'mine' && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            Keep mine
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('joseph')}
          >
            {busy === 'joseph' && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            Take Joseph&apos;s
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
