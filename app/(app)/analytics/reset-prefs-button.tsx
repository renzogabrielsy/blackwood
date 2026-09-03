"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RESET — put every analytics preference back (owner feedback R10, 2026-09-03)
//
// A store that remembers needs a door out of it, and this is the whole door:
// one action clearing one record. It is deliberately NOT a set of per-control
// resets — the Style popover already has "reset this year" and "reset every
// year", the row handle already has its own "reset order", and a page-wide
// reset that only cleared SOME of the page's memory would be the worse kind of
// control, the sort that does not do what its label says.
//
// ── WHY IT IS CONFIRMED ──────────────────────────────────────────────────────
// The thing it destroys is invisible from the button: a reader's colours, the
// years they switched off, the order they dragged eight rows into. None of that
// is recoverable and none of it is on screen at the moment of clicking, so it is
// the exact shape of action that gets an `AlertDialog` — the confirmation names
// what goes, not just that something will.
//
// ── WHY IT IS NOT RENDERED WHEN THERE IS NOTHING TO RESET ────────────────────
// R3's standing rule on this page: a control that cannot do anything is a
// control that lies about what the page can do. `customised` is the store's own
// `isDefaultPrefs` inverted, so a fresh reader never sees it and a reader who
// has just reset watches it leave.
//
// ── WHAT IT DOES **NOT** TOUCH ───────────────────────────────────────────────
// The URL. `?year=`, `?g=`, `?hide=`, `?bhide=` and `?metric=` describe what is
// on screen and belong to the address, not to the reader's habits — resetting a
// preference must not silently re-slice the figures someone is reading. The
// three toggles that ARE stored (`wd`, `cmp`, `dict`) come back to their
// defaults through the same adoption path they arrived by.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { RotateCcw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function ResetPrefsButton({
  customised,
  onReset,
}: {
  /** Anything at all is off the defaults. Nothing renders when it is false. */
  customised: boolean;
  onReset(): void;
}) {
  if (!customised) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          data-testid="analytics-reset-prefs"
          title="Put every remembered analytics setting back to its default — year colours and strokes, which years the expand charts draw, the overlay and average toggles, the compare mode, per-working-day, Definitions and the row order you dragged. It changes no figure and touches nothing in the address bar."
          className="inline-flex h-[var(--an-h-8)] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 text-[length:var(--bw-fs-12)] font-medium leading-[var(--bw-lh-xs)] text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Reset view
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset your saved analytics settings?</AlertDialogTitle>
          <AlertDialogDescription>
            This clears the year colours and strokes, the years the expand charts
            open with, the price-overlay and trailing-average toggles, the compare
            mode, per-working-day, the Definitions switch and every row order you
            have dragged — on this browser and on your account. It changes no
            figure and nothing in the address bar. There is no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep my settings</AlertDialogCancel>
          <AlertDialogAction
            data-testid="analytics-reset-prefs-confirm"
            onClick={onReset}
          >
            Reset to defaults
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
