'use client';

import * as React from 'react';

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
    const [fontSize, setFontSize] = React.useState(10);
    const [rowHeight, setRowHeight] = React.useState(32);

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
