'use client';

import * as React from 'react';

type RowDensity = 'compact' | 'comfortable';

interface TableSettings {
    fontSize: number;
    rowDensity: RowDensity;
}

interface TableSettingsContextType extends TableSettings {
    setFontSize: (size: number) => void;
    setRowDensity: (density: RowDensity) => void;
}

const TableSettingsContext = React.createContext<TableSettingsContextType | undefined>(undefined);

export function TableSettingsProvider({ children }: { children: React.ReactNode }) {
    const [fontSize, setFontSize] = React.useState(10);
    const [rowDensity, setRowDensity] = React.useState<RowDensity>('compact');

    return (
        <TableSettingsContext.Provider value={{ fontSize, rowDensity, setFontSize, setRowDensity }}>
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
