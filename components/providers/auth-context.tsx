'use client';

import * as React from 'react';

// Define available roles
export type UserRole = 'Owner' | 'Admin' | 'Dev' | 'Employee';

// Define permissions structure (can be expanded)
export type Permission =
    | 'view:all'
    | 'view:prices'
    | 'edit:all'
    | 'delete:all';

interface AuthContextType {
    role: UserRole;
    setRole: (role: UserRole) => void;
    hasPermission: (permission: Permission) => boolean;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    // Default to 'Owner' for dev convenience, can be changed via UI
    const [role, setRoleState] = React.useState<UserRole>('Owner');

    // Persist role selection for dev testing
    React.useEffect(() => {
        const stored = localStorage.getItem('dev_mock_role');
        if (stored && ['Owner', 'Admin', 'Dev', 'Employee'].includes(stored)) {
            setRoleState(stored as UserRole);
        }
    }, []);

    const setRole = (newRole: UserRole) => {
        setRoleState(newRole);
        localStorage.setItem('dev_mock_role', newRole);
    };

    const hasPermission = React.useCallback((permission: Permission): boolean => {
        switch (role) {
            case 'Owner':
            case 'Admin':
            case 'Dev':
                // Full access
                return true;
            case 'Employee':
                // Restricted access
                if (permission === 'view:prices') return false;
                if (permission === 'delete:all') return false;
                // Can view non-price, can add/edit (implied by lack of specific restriction here,
                // but we can add 'edit:prices' if needed)
                return true;
            default:
                return false;
        }
    }, [role]);

    return (
        <AuthContext.Provider value={{ role, setRole, hasPermission }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = React.useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
