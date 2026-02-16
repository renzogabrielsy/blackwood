'use client';

import * as React from 'react';
import { useAuth } from './auth-context';

interface TableSettings {
    fontSize: number;
    rowHeight: number;
}

interface TableSettingsContextType extends TableSettings {
    setFontSize: (size: number) => void;
    setRowHeight: (height: number) => void;
}

const TableSettingsContext = React.createContext<TableSettingsContextType | undefined>(undefined);

export function TableSettingsProvider({ children }: { children: React.ReactNode }) {
    const { role } = useAuth();
    const [fontSize, setFontSizeState] = React.useState(10);
    const [rowHeight, setRowHeightState] = React.useState(32);

    // Debounce timer refs for localStorage writes
    const fontSizeTimerRef = React.useRef<NodeJS.Timeout | null>(null);
    const rowHeightTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    // Load settings when role changes
    React.useEffect(() => {
        const stored = localStorage.getItem(`table_settings_${role}`);
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                if (parsed.fontSize) setFontSizeState(parsed.fontSize);
                if (parsed.rowHeight) setRowHeightState(parsed.rowHeight);
            } catch (e) {
                console.error("Failed to parse table settings", e);
            }
        } else {
            // Defaults per role could go here, or just generic defaults
            setFontSizeState(10);
            setRowHeightState(32);
        }
    }, [role]);

    // Cleanup timers on unmount
    React.useEffect(() => {
        return () => {
            if (fontSizeTimerRef.current) clearTimeout(fontSizeTimerRef.current);
            if (rowHeightTimerRef.current) clearTimeout(rowHeightTimerRef.current);
        };
    }, []);

    const setFontSize = (size: number) => {
        // Immediate state update for responsive UI
        setFontSizeState(size);

        // Debounce localStorage write (150ms) to reduce thrashing during slider drag
        if (fontSizeTimerRef.current) clearTimeout(fontSizeTimerRef.current);
        fontSizeTimerRef.current = setTimeout(() => {
            saveSettings(role, { fontSize: size, rowHeight });
            fontSizeTimerRef.current = null;
        }, 150);
    };

    const setRowHeight = (height: number) => {
        // Immediate state update for responsive UI
        setRowHeightState(height);

        // Debounce localStorage write (150ms) to reduce thrashing during slider drag
        if (rowHeightTimerRef.current) clearTimeout(rowHeightTimerRef.current);
        rowHeightTimerRef.current = setTimeout(() => {
            saveSettings(role, { fontSize, rowHeight: height });
            rowHeightTimerRef.current = null;
        }, 150);
    };

    const saveSettings = (currentRole: string, settings: TableSettings) => {
        localStorage.setItem(`table_settings_${currentRole}`, JSON.stringify(settings));
    };

    return (
        <TableSettingsContext.Provider value={{ fontSize, rowHeight, setFontSize, setRowHeight }}>
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
