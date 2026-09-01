"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE PERIOD CHECKLIST — ONE control, two surfaces (owner feedback R2).
//
// Renzo, 2026-09-02: *"I would also like the option to click which years to
// display, which months, quarters etc. We must always default this filter
// checklist to checking all. We should have the option to select/deselect all
// as well."*
//
// Two places need it and they must not diverge:
//   • the MATRIX, filtering its period columns (the 12 months / 4 quarters /
//     every year on record);
//   • a row EXPAND, filtering which years its full-history chart draws — the
//     complaint that started this, because several metrics carry long honest
//     blanks back to 2020 (rc_out starts 2024, production starts Nov 2025).
//
// So it is written once, here, and both mount it.
//
// ── THE ONE STRUCTURAL DECISION: IT STORES WHAT IS *HIDDEN* ──────────────────
// The state is the set of switched-OFF keys, never the set of selected ones.
// That is what makes "always default to checking all" a property of the shape
// rather than a default someone has to remember to write: an absent or empty
// set cannot mean "nothing is selected", it can only mean "everything is". It
// also gives the URL param its natural spelling — `?hide=` is simply absent
// when nothing is hidden, so the default view has a clean address. The set's
// URL codec lives in `lib/analytics/period-selection.ts` rather than here,
// because the Server Component has to read it and a plain function exported
// from a `"use client"` module is a client reference, not a function.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It never touches a number. Hiding a period removes a COLUMN or a chart point;
// the arithmetic behind what remains is re-folded by `buildMatrix`'s own rollup
// machinery over the periods that survive (`matrix.ts` → `foldSelection`), and
// a comparison — a month-on-month move, a year-ago chip — still reads the real
// neighbouring period whether or not it is on screen. Filtering may hide a
// period; it may never restate one.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Check, ListFilter } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One line of the checklist. `key` is the period key — stable and unique. */
export interface PeriodFilterOption {
  key: string;
  /** What the box says — `Mar`, `Q1`, `2026`. */
  label: string;
  /** The muted right-hand column — a coverage count, a full period name. */
  meta?: string;
  /** Nothing was ever recorded here. Rendered quieter; still toggleable. */
  empty?: boolean;
  title?: string;
}

export interface PeriodFilterProps {
  /** The control's own name — `Columns`, `Years`. */
  label: string;
  /** Singular noun for the counts — `column`, `year`. */
  noun: string;
  options: readonly PeriodFilterOption[];
  /** The switched-OFF keys. Absent from this set = on. Empty = everything on. */
  hidden: ReadonlySet<string>;
  onChange(next: Set<string>): void;
  /** Hover copy on the trigger — what filtering this actually does. */
  title?: string;
  align?: "start" | "end";
  className?: string;
}

export function PeriodFilter({
  label,
  noun,
  options,
  hidden,
  onChange,
  title,
  align = "start",
  className,
}: PeriodFilterProps) {
  const total = options.length;
  const shown = options.filter((o) => !hidden.has(o.key)).length;
  const filtered = shown < total;

  const setAll = React.useCallback(() => {
    // Only the keys THIS control owns are cleared. The hidden set is shared
    // across granularities and years (a period key is self-describing —
    // `2026-03`, `2026-Q1`, `2025` — so a key from another view is simply
    // inert here), and "All" must not silently un-hide a quarter the reader
    // switched off while looking at quarters.
    const next = new Set(hidden);
    for (const o of options) next.delete(o.key);
    onChange(next);
  }, [hidden, onChange, options]);

  const setNone = React.useCallback(() => {
    const next = new Set(hidden);
    for (const o of options) next.add(o.key);
    onChange(next);
  }, [hidden, onChange, options]);

  const toggle = React.useCallback(
    (key: string) => {
      const next = new Set(hidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onChange(next);
    },
    [hidden, onChange],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={
            title ??
            `Choose which ${noun}s to show. Everything is on by default; hiding one removes it from view and never changes what the others say.`
          }
          aria-label={`${label} filter — ${shown} of ${total} ${noun}s shown`}
          className={cn(
            "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium",
            "transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            filtered
              ? "border-border bg-background text-foreground shadow-sm"
              : "border-border/60 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            className,
          )}
        >
          <ListFilter className="size-3.5" aria-hidden />
          {label}
          {/* The count appears ONLY while something is off. An always-present
              "12/12" is chrome that trains the eye to ignore the one state
              that matters. */}
          {filtered && (
            <span className="rounded border border-border/70 px-1 font-mono text-[10px] leading-4 tabular-nums">
              {shown}/{total}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(248px,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
          <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={setAll}
              title={`Show every ${noun}.`}
              className="cursor-pointer rounded border border-border/70 px-1.5 py-0.5 text-[10.5px] leading-4 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              All
            </button>
            <button
              type="button"
              onClick={setNone}
              title={`Hide every ${noun}. Nothing is deleted — turn one back on and it returns unchanged.`}
              className="cursor-pointer rounded border border-border/70 px-1.5 py-0.5 text-[10.5px] leading-4 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              None
            </button>
          </span>
        </div>

        <div className="max-h-[248px] overflow-y-auto py-1">
          {options.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              Nothing to filter.
            </p>
          ) : (
            options.map((o) => {
              const checked = !hidden.has(o.key);
              return (
                <button
                  key={o.key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  title={o.title}
                  onClick={() => toggle(o.key)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left text-xs",
                    "transition-colors duration-150 hover:bg-muted/60",
                    "focus:outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background",
                    )}
                  >
                    {checked && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono tabular-nums",
                      checked ? "text-foreground" : "text-muted-foreground",
                      o.empty && "italic",
                    )}
                  >
                    {o.label}
                  </span>
                  {o.meta && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {o.meta}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
