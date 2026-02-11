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

    const setFontSize = (size: number) => {
        setFontSizeState(size);
        saveSettings(role, { fontSize: size, rowHeight });
    };

    const setRowHeight = (height: number) => {
        setRowHeightState(height);
        saveSettings(role, { fontSize, rowHeight: height });
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
