"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE METRIC DICTIONARY, at the point of use.
//
// The analyst audit's gap #1: "a number the reader can interrogate without
// asking anyone." Every KPI row carries this button; hovering gives the whole
// entry as a native `title` (no click, no portal, works on a trackpad in two
// seconds), clicking opens the full card with the four things a definition
// owes — what it counts, what it EXCLUDES, what basis it is on, and how a
// quarter or a year is rolled up.
//
// The copy is `METRIC_DICTIONARY` in `lib/analytics/metrics.ts`, which is
// derived from the view COMMENTs in the Phase-1 migration. It is written once
// there so the matrix, the row expand and the callouts can never describe the
// same number two different ways.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { MetricDictionaryEntry, MetricSpec } from "@/lib/analytics/metrics";

/** The whole entry as one flat string — the hover affordance. */
export function dictionaryEntryTitle(
  label: string,
  sublabel: string,
  d: MetricDictionaryEntry,
): string {
  const lines = [`${label} (${sublabel})`, "", d.definition, "", `Basis: ${d.basis}`];
  if (d.exclusions) lines.push(`Excludes: ${d.exclusions}`);
  lines.push(`Quarter / year: ${d.rollup}`);
  if (d.caveat) lines.push(`Note: ${d.caveat}`);
  lines.push(`Source: ${d.source}`);
  return lines.join("\n");
}

/** The matrix row's flavour of the same thing. */
export function dictionaryTitle(spec: MetricSpec): string {
  return dictionaryEntryTitle(spec.label, spec.sublabel, spec.dictionary);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="mt-0.5 text-[length:var(--bw-fs-12)] leading-relaxed text-foreground">
        {children}
      </p>
    </div>
  );
}

/**
 * THE dictionary card, for any figure on the page — a matrix row, a
 * concentration chip, a premium column. Written once so a metric and a
 * supplier figure can never explain themselves in two different layouts.
 */
export function DictionaryPopover({
  label,
  sublabel,
  entry,
  className,
}: {
  label: string;
  sublabel: string;
  entry: MetricDictionaryEntry;
  className?: string;
}) {
  const d = entry;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={dictionaryEntryTitle(label, sublabel, d)}
          aria-label={`What "${label}" means`}
          // The click must not also toggle the row expand behind it.
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70",
            "transition-colors duration-150 hover:text-foreground",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // BOTTOM, not right: the trigger sits in the frozen left column, and a
        // right-side card 360px wide has nowhere to go on a 375px phone — it
        // flipped to the left and hung off the screen. Below the trigger there
        // is always room, and `collisionPadding` keeps it inside the viewport.
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        onClick={(e) => e.stopPropagation()}
        // Capped and scrollable: the longest entry runs ~520px, which overhangs
        // a phone viewport. The card scrolls; it never gets cut off.
        // `bw-analytics` — Radix portals this to <body>, outside the shell div
        // that carries the page scale. (R3, 2026-09-02.)
        className="bw-analytics max-h-[var(--radix-popover-content-available-height)] w-[min(360px,calc(100vw-2rem))] overflow-y-auto p-0"
      >
        <div className="border-b px-3 py-2">
          <div className="text-[length:var(--bw-fs-13)] font-semibold tracking-tight">{label}</div>
          <div className="text-[length:var(--bw-fs-115)] text-muted-foreground">{sublabel}</div>
        </div>
        <div className="flex flex-col gap-2.5 px-3 py-2.5">
          <Field label="What it is">{d.definition}</Field>
          <Field label="How it is worked out">{d.basis}</Field>
          {d.exclusions && <Field label="What it leaves out">{d.exclusions}</Field>}
          <Field label="Quarter &amp; year columns">{d.rollup}</Field>
          {d.caveat && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
              <div className="text-[length:var(--bw-fs-10)] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Worth knowing
              </div>
              <p className="mt-0.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                {d.caveat}
              </p>
            </div>
          )}
        </div>
        <div className="border-t px-3 py-1.5">
          <span className="font-mono text-[length:var(--bw-fs-10)] text-muted-foreground">
            {d.source}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The matrix row's Info button — the same card, keyed off the registry. */
export function MetricInfo({
  spec,
  className,
}: {
  spec: MetricSpec;
  className?: string;
}) {
  return (
    <DictionaryPopover
      label={spec.label}
      sublabel={spec.sublabel}
      entry={spec.dictionary}
      className={className}
    />
  );
}
