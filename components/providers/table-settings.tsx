'use client';

import * as React from 'react';
import type { DensityMode, LabMetric, RcInTableSettings, LabHighlightSpec, ColumnFormat } from '@/types/table-settings';
import { DEFAULT_RC_IN_SETTINGS } from '@/types/table-settings';
import { saveTableSettings } from '@/lib/actions/table-settings';

/** Map density mode to a row height in px for backward compatibility */
function densityToRowHeight(mode: DensityMode): number {
  switch (mode) {
    case 'normal':   return 32;
    case 'expanded': return 40;
  }
}

interface TableSettingsContextType {
  settings: RcInTableSettings;
  /** Shortcut to settings.fontSize — backward compat for existing consumers */
  fontSize: number;
  /** Computed row height from densityMode — backward compat for existing consumers */
  rowHeight: number;
  setDensity: (mode: DensityMode) => void;
  setFontSize: (size: number) => void;
  /** @deprecated Use setDensity instead. Kept for backward compat. */
  setRowHeight: (height: number) => void;
  toggleColumn: (colId: string) => void;
  showAllColumns: () => void;
  setLabHighlights: (highlights: Record<LabMetric, LabHighlightSpec>) => void;
  setLabHighlightField: (metric: LabMetric, field: keyof LabHighlightSpec, value: LabHighlightSpec[keyof LabHighlightSpec]) => void;
  setColumnWidth: (colId: string, width: number) => void;
  setColumnFormat: (colId: string, format: Partial<ColumnFormat>) => void;
  resetSettings: () => void;
  isSaving: boolean;
}

const TableSettingsContext = React.createContext<TableSettingsContextType | undefined>(undefined);

interface TableSettingsProviderProps {
  children: React.ReactNode;
  initialSettings?: RcInTableSettings;
  /**
   * Which table these settings belong to — the (user_id, module) key in
   * `user_table_settings` and the base of the localStorage cache key. Defaults to
   * 'rc_in' so existing consumers (mounted without this prop) are unchanged. This
   * is what de-tenants the provider: the platform infra no longer hardcodes RC IN.
   */
  tableId?: string;
}

export function TableSettingsProvider({ children, initialSettings, tableId = 'rc_in' }: TableSettingsProviderProps) {
  // localStorage cache key derived from tableId, e.g. "rc_in_table_settings".
  const storageKey = `${tableId}_table_settings`;

  const [settings, setSettings] = React.useState<RcInTableSettings>(() => {
    // Try localStorage first for instant restore, fall back to server-provided settings
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(storageKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          // Backward compat: old settings may have labRanges instead of labHighlights
          if (parsed.labRanges && !parsed.labHighlights) {
            delete parsed.labRanges;
            delete parsed.disabledHighlights;
          }
          // Ensure columnFormats exists
          if (!parsed.columnFormats) {
            parsed.columnFormats = {};
          }
          return { ...DEFAULT_RC_IN_SETTINGS, ...parsed };
        } catch { /* ignore corrupt cache */ }
      }
    }
    return initialSettings ?? DEFAULT_RC_IN_SETTINGS;
  });

  const [isSaving, setIsSaving] = React.useState(false);
  const saveTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  const settingsRef = React.useRef(settings);

  // Persist to localStorage immediately, debounce DB save
  const persistSettings = React.useCallback((newSettings: RcInTableSettings) => {
    settingsRef.current = newSettings; // sync update — makes subsequent calls in same tick see latest
    setSettings(newSettings);

    // Immediate localStorage write
    localStorage.setItem(storageKey, JSON.stringify(newSettings));

    // Debounced DB persist (500ms)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setIsSaving(true);
      try {
        await saveTableSettings(tableId, newSettings);
      } catch (e) {
        console.error('Failed to save table settings:', e);
      } finally {
        setIsSaving(false);
      }
    }, 500);
  }, [storageKey, tableId]);

  // Cleanup timer on unmount
  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const setDensity = React.useCallback((mode: DensityMode) => {
    persistSettings({ ...settingsRef.current, densityMode: mode });
  }, [persistSettings]);

  const setFontSize = React.useCallback((size: number) => {
    persistSettings({ ...settingsRef.current, fontSize: Math.max(9, Math.min(14, size)) });
  }, [persistSettings]);

  // Backward compat: setRowHeight is a no-op now (density controls row height)
  // Kept so existing consumers that destructure it don't throw
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const setRowHeight = React.useCallback((_height: number) => {
    // No-op — row height is now derived from densityMode
  }, []);

  const toggleColumn = React.useCallback((colId: string) => {
    const hidden = new Set(settingsRef.current.hiddenColumns);
    if (hidden.has(colId)) {
      hidden.delete(colId);
    } else {
      hidden.add(colId);
    }
    persistSettings({ ...settingsRef.current, hiddenColumns: Array.from(hidden) });
  }, [persistSettings]);

  const showAllColumns = React.useCallback(() => {
    persistSettings({ ...settingsRef.current, hiddenColumns: [] });
  }, [persistSettings]);

  const setLabHighlights = React.useCallback((highlights: Record<LabMetric, LabHighlightSpec>) => {
    persistSettings({ ...settingsRef.current, labHighlights: highlights });
  }, [persistSettings]);

  const setLabHighlightField = React.useCallback((metric: LabMetric, field: keyof LabHighlightSpec, value: LabHighlightSpec[keyof LabHighlightSpec]) => {
    const next = { ...settingsRef.current.labHighlights };
    next[metric] = { ...next[metric], [field]: value };
    persistSettings({ ...settingsRef.current, labHighlights: next });
  }, [persistSettings]);

  const setColumnWidth = React.useCallback((colId: string, width: number) => {
    persistSettings({
      ...settingsRef.current,
      columnWidths: { ...settingsRef.current.columnWidths, [colId]: width },
    });
  }, [persistSettings]);

  const setColumnFormat = React.useCallback((colId: string, format: Partial<ColumnFormat>) => {
    const current = settingsRef.current.columnFormats[colId] || {};
    const merged = { ...current, ...format };
    // If all values are falsy, remove the entry
    const hasAny = merged.bold || merged.italic || merged.underline;
    const next = { ...settingsRef.current.columnFormats };
    if (hasAny) {
      next[colId] = merged;
    } else {
      delete next[colId];
    }
    persistSettings({ ...settingsRef.current, columnFormats: next });
  }, [persistSettings]);

  const resetSettings = React.useCallback(() => {
    persistSettings({ ...DEFAULT_RC_IN_SETTINGS });
  }, [persistSettings]);

  const rowHeight = densityToRowHeight(settings.densityMode);

  const value = React.useMemo(() => ({
    settings,
    fontSize: settings.fontSize,
    rowHeight,
    setDensity,
    setFontSize,
    setRowHeight,
    toggleColumn,
    showAllColumns,
    setLabHighlights,
    setLabHighlightField,
    setColumnWidth,
    setColumnFormat,
    resetSettings,
    isSaving,
  }), [settings, rowHeight, setDensity, setFontSize, setRowHeight, toggleColumn, showAllColumns, setLabHighlights, setLabHighlightField, setColumnWidth, setColumnFormat, resetSettings, isSaving]);

  return (
    <TableSettingsContext.Provider value={value}>
      {children}
    </TableSettingsContext.Provider>
  );
}

export function useTableSettings() {
  const context = React.useContext(TableSettingsContext);
  if (!context) {
    throw new Error('useTableSettings must be used within a TableSettingsProvider');
  }
  return context;
}
