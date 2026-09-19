'use client';

// ─────────────────────────────────────────────────────────────────────────────
// "CUSTOMIZE BANDS" — the disclosure both lenses put their cut lines behind.
//
// The scaffolding is identical for every lens on this frame and the DIMENSION is
// not: the price lens cuts in pesos from the rounded market price, the age lens in
// DAYS. So this component owns the shape — the disclosure, the chip row with its
// removers, the add box, the cap sentence, the per-band rename inputs and the two
// resets — and every word and every number is passed in by the lens.
//
// Three properties it is here to keep from drifting apart:
//
//   • THE CAP IS A SENTENCE, NOT A DEAD BUTTON. A disabled Add with no explanation
//     is the version of this control that gets filed as a bug.
//   • AT LEAST ONE CUT LINE MUST SURVIVE, and the refusal for removing the last one
//     is the lens's own words (with none there is a single band holding the whole
//     yard, which is the same picture as no lens at all).
//   • A BAND NAME IS KEYED ON THE BAND'S OWN INTERVAL, never its index — so a name
//     follows its own slice of the yard instead of jumping to somebody else's the
//     moment a cut line is added below it. This component never invents a key; it
//     renders the ones the lens hands it.
//
// It computes nothing. The chip text, the intro, the cap note and every label are
// strings the lens built.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Plus, RotateCcw, Sliders, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

/** One cut line, as the chip row shows it. */
export interface LensCutLineChip {
  /** The value handed back to `onRemove` / used as the React key. */
  value: number;
  /** How it reads — `+5`, `-1`, `60 d`. */
  text: string;
  /** The remover's accessible name, written by the lens in its own dimension. */
  removeLabel: string;
}

/** A cut line offered as a one-click add, because it is one people ask for. */
export interface LensQuickCut {
  value: number;
  text: string;
  /** The button's accessible name. */
  title: string;
}

/** One rename input, keyed on the band's own interval. */
export interface LensBandNameField {
  /** The interval key the lens stores the name under. Also the React key. */
  key: string;
  /** The stored name, or '' — rendered as `defaultValue`, so typing is never fought. */
  value: string;
  /** The generated label, shown as the placeholder so the default is visible. */
  placeholder: string;
  ariaLabel: string;
}

export interface LensCustomizeProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** `2/6 cut lines` on the trigger. */
  edgeCount: number;
  maxEdges: number;

  /** The explanatory paragraph, in the lens's own dimension. */
  intro: React.ReactNode;

  chips: readonly LensCutLineChip[];
  onRemoveChip: (value: number) => void;

  /** Optional one-click cut lines (the age lens offers 30 · 60 · 90 · …). */
  quickCuts?: readonly LensQuickCut[];
  onQuickCut?: (value: number) => void;
  /** Heading for the quick-add row. */
  quickCutsLabel?: string;

  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  addPlaceholder: string;
  addAriaLabel: string;

  /** True when the cap is reached — turns `capNote` on beside the Add button. */
  atCap: boolean;
  capNote: string;

  /** The last refusal, shown under the add row. Null = nothing to say. */
  error: string | null;

  /** Per-band rename inputs. Omit while there is no payload to name bands from. */
  names?: readonly LensBandNameField[];
  onRename?: (key: string, name: string) => void;

  /** Cut lines + names back to the lens's shipped default. */
  onResetBands: () => void;
  /** Every setting back to default. Shown only when something is off-default. */
  onResetAll?: () => void;
}

export function LensCustomize({
  open,
  onOpenChange,
  edgeCount,
  maxEdges,
  intro,
  chips,
  onRemoveChip,
  quickCuts,
  onQuickCut,
  quickCutsLabel = 'Common cuts',
  draft,
  onDraftChange,
  onAdd,
  addPlaceholder,
  addAriaLabel,
  atCap,
  capNote,
  error,
  names,
  onRename,
  onResetBands,
  onResetAll,
}: LensCustomizeProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
        >
          <Sliders className="h-3 w-3" />
          Customize bands
          <span className="ml-auto font-mono text-[10px]">
            {edgeCount}/{maxEdges} cut lines
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
          <p className="text-[10px] leading-snug text-muted-foreground">{intro}</p>

          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span
                key={chip.value}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]"
              >
                {chip.text}
                <button
                  type="button"
                  onClick={() => onRemoveChip(chip.value)}
                  aria-label={chip.removeLabel}
                  className="rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>

          {/* One-click cut lines. Only the ones NOT already on the scale are offered,
              which the lens decides — an "add 60" chip beside an existing 60 would
              be a button whose only outcome is a refusal. */}
          {quickCuts && quickCuts.length > 0 && onQuickCut && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {quickCutsLabel}
              </span>
              <div className="flex flex-wrap gap-1">
                {quickCuts.map((q) => (
                  <button
                    key={q.value}
                    type="button"
                    onClick={() => onQuickCut(q.value)}
                    title={q.title}
                    aria-label={q.title}
                    className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors duration-150 hover:border-solid hover:text-foreground cursor-pointer"
                  >
                    <Plus className="h-2.5 w-2.5" />
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Input
              inputMode="numeric"
              value={draft}
              placeholder={addPlaceholder}
              aria-label={addAriaLabel}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAdd();
                }
              }}
              className="h-7 w-20 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={onAdd}
            >
              <Plus className="h-3 w-3" />
              Add
            </Button>
            {/* The cap is stated, not enforced by a dead button with no reason. */}
            {atCap && (
              <span className="text-[10px] leading-tight text-muted-foreground">{capNote}</span>
            )}
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          {/* Renaming. Keyed on the band's OWN interval, so a name follows its own
              slice instead of jumping when a cut line is added below it. */}
          {names && names.length > 0 && onRename && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Names
              </span>
              {names.map((field) => (
                <Input
                  key={field.key}
                  defaultValue={field.value}
                  placeholder={field.placeholder}
                  aria-label={field.ariaLabel}
                  maxLength={40}
                  onBlur={(e) => onRename(field.key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onRename(field.key, (e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="h-7 text-[11px]"
                />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={onResetBands}
            >
              <RotateCcw className="h-3 w-3" />
              Reset to default
            </Button>
            {onResetAll && (
              <button
                type="button"
                onClick={onResetAll}
                className="text-[10px] font-semibold text-muted-foreground underline decoration-dotted transition-colors duration-150 hover:text-foreground cursor-pointer"
              >
                Reset everything
              </button>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
