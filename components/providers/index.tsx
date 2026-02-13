'use client';

import { AuthProvider } from './auth-context';
import { TableSettingsProvider } from './table-settings';
import { ThemeProvider } from './theme-provider';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
        >
            <AuthProvider>
                <TableSettingsProvider>
                    {children}
                </TableSettingsProvider>
            </AuthProvider>
        </ThemeProvider>
    );
}
