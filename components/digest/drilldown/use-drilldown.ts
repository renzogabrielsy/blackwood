"use client";

// ─────────────────────────────────────────────────────────────────────────────
// useDrilldown — the state machine every digest drill-down shares.
//
// It is the OPTIMISTIC-DRAWER contract (components/digest/CONTEXT.md → "Optimistic
// drawers"), ported from a slide-over to a modal:
//
//   • the modal OPENS ON THE CLICK FRAME. `open()` flips `isOpen` and starts the
//     fetch in the same tick — it never awaits anything.
//   • `data` is CLEARED before every request, so the modal can never flash the
//     previous range's chart under a new title.
//   • RACE SAFETY IS A REQUEST TOKEN, not a range compare: re-selecting the SAME
//     range after a failure must also invalidate the first attempt, and `close()`
//     bumps the token too, so a reply landing after the modal shuts can never
//     repopulate it.
//   • FAILURE KEEPS THE MODAL OPEN with a persistent, copyable banner + Retry
//     (the project HARD RULE on error surfaces — an inline banner satisfies it
//     in place of a toast because the modal is where the user is looking).
//
// Adopting it on a new tile is ~5 lines — see the header of ./drilldown-modal.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import type { DrilldownRange } from "@/lib/digest/drilldown-types";

export interface DrilldownModalState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range: DrilldownRange;
  onRangeChange: (range: DrilldownRange) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export interface DrilldownController<T> {
  isOpen: boolean;
  range: DrilldownRange;
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Open the modal AND start the fetch, on the click frame. */
  open: () => void;
  close: () => void;
  /** Everything `<DrilldownModal>` needs — spread it. */
  modalProps: DrilldownModalState;
}

export function useDrilldown<T>(
  fetcher: (range: DrilldownRange) => Promise<T>,
  initialRange: DrilldownRange = "30d"
): DrilldownController<T> {
  const [isOpen, setIsOpen] = React.useState(false);
  const [range, setRange] = React.useState<DrilldownRange>(initialRange);
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // One monotonic token per request. A reply is applied ONLY while its token is
  // still current. See the header for why this is a token and not a value compare.
  const requestRef = React.useRef(0);

  const load = React.useCallback(
    (next: DrilldownRange) => {
      const token = ++requestRef.current;
      setData(null);
      setError(null);
      setLoading(true);

      fetcher(next)
        .then((result) => {
          if (requestRef.current !== token) return; // stale — a newer request won
          setData(result);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (requestRef.current !== token) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    },
    [fetcher]
  );

  const open = React.useCallback(() => {
    setIsOpen(true);
    load(range);
  }, [load, range]);

  const close = React.useCallback(() => {
    requestRef.current++;
    setIsOpen(false);
    setLoading(false);
    setError(null);
  }, []);

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) open();
      else close();
    },
    [open, close]
  );

  const onRangeChange = React.useCallback(
    (next: DrilldownRange) => {
      setRange(next);
      load(next);
    },
    [load]
  );

  const onRetry = React.useCallback(() => load(range), [load, range]);

  return {
    isOpen,
    range,
    data,
    loading,
    error,
    open,
    close,
    modalProps: {
      open: isOpen,
      onOpenChange,
      range,
      onRangeChange,
      loading,
      error,
      onRetry,
    },
  };
}
