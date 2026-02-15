'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type StatusBarContextType = {
  connectionStatus: string;
  setConnectionStatus: (status: string) => void;
  cellSelectionCount: number;
  setCellSelectionCount: (count: number) => void;
};

const StatusBarContext = createContext<StatusBarContextType | null>(null);

export function StatusBarProvider({ children }: { children: ReactNode }) {
  const [connectionStatus, setConnectionStatus] = useState('CONNECTING');
  const [cellSelectionCount, setCellSelectionCount] = useState(0);

  const setConn = useCallback((s: string) => setConnectionStatus(s), []);
  const setCell = useCallback((n: number) => setCellSelectionCount(n), []);

  return (
    <StatusBarContext.Provider value={{
      connectionStatus, setConnectionStatus: setConn,
      cellSelectionCount, setCellSelectionCount: setCell
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
