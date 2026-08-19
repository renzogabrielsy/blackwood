'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { CellAggregates } from '@/lib/hooks/use-cell-aggregation';

type StatusBarContextType = {
  connectionStatus: string;
  setConnectionStatus: (status: string) => void;
  cellSelectionCount: number;
  setCellSelectionCount: (count: number) => void;
  cellAggregates: CellAggregates | null;
  setCellAggregates: (agg: CellAggregates | null) => void;
};

const StatusBarContext = createContext<StatusBarContextType | null>(null);

export function StatusBarProvider({ children }: { children: ReactNode }) {
  const [connectionStatus, setConnectionStatus] = useState('CONNECTING');
  const [cellSelectionCount, setCellSelectionCount] = useState(0);
  const [cellAggregates, setCellAggregatesState] = useState<CellAggregates | null>(null);

  const setConn = useCallback((s: string) => setConnectionStatus(s), []);
  const setCell = useCallback((n: number) => setCellSelectionCount(n), []);
  const setAgg = useCallback((a: CellAggregates | null) => setCellAggregatesState(a), []);

  return (
    <StatusBarContext.Provider value={{
      connectionStatus, setConnectionStatus: setConn,
      cellSelectionCount, setCellSelectionCount: setCell,
      cellAggregates, setCellAggregates: setAgg
    }}>
      {children}
    </StatusBarContext.Provider>
  );
}

export function useStatusBar() {
  const ctx = useContext(StatusBarContext);
  if (!ctx) throw new Error('useStatusBar must be used within StatusBarProvider');
  return ctx;
}

/**
 * The same context, but NULL instead of a throw when there is no provider.
 *
 * `BlackwoodTable` publishes its selection's SUM/AVG/COUNT here itself, so that every
 * grid in the app gets the bottom-right pill with no wiring at all. The platform grid is
 * mountable outside the app shell — the dev playground and any future standalone surface
 * are exactly that — and a shared primitive that CRASHES the page when an optional
 * ambient provider is missing is not a shared primitive. So the dependency is optional by
 * construction: present, the pill fills in; absent, the table simply says nothing.
 *
 * Use `useStatusBar` anywhere the provider is genuinely required — a missing one there is
 * a wiring bug and should be loud.
 */
export function useOptionalStatusBar() {
  return useContext(StatusBarContext);
}
