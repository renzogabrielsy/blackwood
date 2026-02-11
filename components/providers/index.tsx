'use client';

import { AuthProvider } from './auth-context';
import { TableSettingsProvider } from './table-settings';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <TableSettingsProvider>
                {children}
            </TableSettingsProvider>
        </AuthProvider>
    );
}
