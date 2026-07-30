'use client';

// =====================================================================
// Production Setup — the create / edit dialog for one per-shift grade mix.
// =====================================================================
// ONE dialog, TWO callers, so the two can never disagree about what a setup is:
//   • the schedule day-grid's inline "+ New setup…"  (compact: code + mix)
//   • the setup library screen `/production/setups`  (adds label + notes)
//
// It is a controlled, dumb form: it validates, shows the live per-shift total as
// the operator types, and hands `SetupFormValues` to whatever `onSubmit` the
// caller passed. It does NOT know about Supabase, server actions, or what
// happens next — the grid applies the new code to the day, the library screen
// just refreshes.
//
// The per-shift total shown here is deliberately the SAME arithmetic the plan
// uses: `projectSetup(mix, 1).projectedTons` from
// `lib/production/setup-projection.ts` — the one implementation. A second
// `reduce()` here would be exactly the drift that module exists to prevent.
//
// Motion: `DialogContent` already carries the house glass + spring entrance.
// Nothing extra is animated.

import * as React from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  projectSetup,
  type GradeMix,
} from '@/lib/production/setup-projection';
import type { SetupFormValues } from '@/app/(app)/production/setups/actions';

/** One editable mix line. Kept as STRINGS so a half-typed "1." is not destroyed
 *  mid-keystroke; coerced once on submit. */
interface MixRow {
  /** Stable key — grade names change as the operator types, so they cannot key. */
  key: number;
  grade: string;
  tons: string;
}

let nextKey = 1;
const newRow = (grade = '', tons = ''): MixRow => ({
  key: nextKey++,
  grade,
  tons,
});

/** `{ "3X50": 20, "6X50": 6 }` → two rows, heaviest first (reads like the label). */
function rowsFromMix(mix: GradeMix): MixRow[] {
  const rows = Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .map(([grade, tons]) => newRow(grade, String(tons)));
  return rows.length > 0 ? rows : [newRow()];
}

/** Rows → a `GradeMix`, dropping blanks. Last write wins on a duplicate grade. */
function mixFromRows(rows: MixRow[]): GradeMix {
  const mix: GradeMix = {};
  for (const r of rows) {
    const grade = r.grade.trim();
    const tons = Number.parseFloat(r.tons);
    if (!grade || !Number.isFinite(tons) || tons <= 0) continue;
    mix[grade] = tons;
  }
  return mix;
}

export interface SetupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent = create. Present = edit (prefills, and changes the copy). */
  initial?: {
    code: string;
    label: string | null;
    gradeMix: GradeMix;
    notes: string | null;
  };
  /** Show the optional Label + Notes fields. The grid's inline form does not. */
  showMeta?: boolean;
  /** Extra sentence under the title (e.g. "…and apply it to 2026-07-14"). */
  contextNote?: string;
  /** Returns an error string to show INLINE, or nothing on success. */
  onSubmit: (values: SetupFormValues) => Promise<{ ok: boolean; error?: string }>;
}

export function SetupFormDialog({
  open,
  onOpenChange,
  initial,
  showMeta = false,
  contextNote,
  onSubmit,
}: SetupFormDialogProps) {
  const isEdit = initial != null;

  const [code, setCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [rows, setRows] = React.useState<MixRow[]>([newRow()]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset on every OPEN so a cancelled edit never leaks into the next one.
  React.useEffect(() => {
    if (!open) return;
    setCode(initial?.code ?? '');
    setLabel(initial?.label ?? '');
    setNotes(initial?.notes ?? '');
    setRows(initial ? rowsFromMix(initial.gradeMix) : [newRow()]);
    setError(null);
    setBusy(false);
    // `initial` is a fresh object each render; keying on its fields keeps this
    // from re-running (and wiping typing) on an unrelated parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.code]);

  const mix = React.useMemo(() => mixFromRows(rows), [rows]);
  /** The SAME arithmetic the plan uses — one shift, so this is the mix's total. */
  const perShiftTons = projectSetup(mix, 1).projectedTons;
  const gradeCount = Object.keys(mix).length;

  const trimmedCode = code.trim();
  const canSubmit = trimmedCode !== '' && gradeCount > 0 && !busy;

  function patchRow(key: number, patch: Partial<MixRow>) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSubmit({
        code: trimmedCode,
        label: showMeta ? label.trim() || null : (initial?.label ?? null),
        gradeMix: mix,
        notes: showMeta ? notes.trim() || null : (initial?.notes ?? null),
      });
      if (!res.ok) {
        // INLINE, not a toast: the operator is mid-form and needs to fix the
        // field in front of them. Carries its own Copy button (HARD RULE).
        setError(res.error ?? 'Could not save the setup.');
        return;
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {isEdit ? `Edit setup · ${initial.code}` : 'New setup'}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            A setup is a <span className="font-medium">per-shift</span> grade
            mix. The plan multiplies it by the day&apos;s shift count.
            {contextNote ? ` ${contextNote}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-code" className="text-xs">
              Code
            </Label>
            <Input
              id="setup-code"
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value)}
              placeholder="3X50 / 6X50"
              className="h-8 font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              This exact string is what gets stored on every plan day.
            </p>
          </div>

          {showMeta && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-label" className="text-xs">
                Label{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="setup-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Friendly name"
                className="h-8 text-xs"
              />
            </div>
          )}

          {/* Grade mix — dense, Excel-ish, one line per grade. */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Grade mix · tons per shift</Label>
            <div className="flex flex-col gap-1">
              {rows.map((r) => (
                <div key={r.key} className="flex items-center gap-1.5">
                  <Input
                    value={r.grade}
                    onChange={(e) => patchRow(r.key, { grade: e.target.value })}
                    placeholder="Grade"
                    aria-label="Grade"
                    className="h-8 flex-1 font-mono text-xs uppercase"
                  />
                  <Input
                    value={r.tons}
                    onChange={(e) => patchRow(r.key, { tons: e.target.value })}
                    placeholder="0"
                    aria-label="Tons per shift"
                    inputMode="decimal"
                    className="h-8 w-[84px] text-right font-mono text-xs tabular-nums"
                  />
                  <button
                    type="button"
                    aria-label="Remove this grade"
                    disabled={rows.length === 1}
                    onClick={() =>
                      setRows((prev) => prev.filter((x) => x.key !== r.key))
                    }
                    className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setRows((prev) => [...prev, newRow()])}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add grade
              </Button>
              {/* The sanity-check figure, live as they type. */}
              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  gradeCount === 0
                    ? 'text-muted-foreground/60'
                    : 'font-semibold text-violet-600 dark:text-violet-300'
                )}
                title="Projected tons for a ONE-shift day. A two-shift day doubles it."
              >
                {perShiftTons} t / shift
              </span>
            </div>
          </div>

          {showMeta && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-notes" className="text-xs">
                Notes{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="setup-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="When this configuration is used"
                className="h-8 text-xs"
              />
            </div>
          )}

          {isEdit && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Days already saved keep the tonnage stored on them — a plan is a
              record of intent, not a live formula. This edit only changes what
              future picks project.
            </p>
          )}

          {/* Inline error — persists until fixed, with its own Copy (HARD RULE). */}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5">
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-destructive">
                {error}
              </p>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(error)}
                className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/15"
              >
                Copy
              </button>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {isEdit ? 'Save setup' : 'Create setup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
