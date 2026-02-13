'use client';

import * as React from 'react';
import { createClient } from '@/lib/supabase/client';
import type { User, AuthChangeEvent, Session } from '@supabase/supabase-js';

export type UserRole = 'Owner' | 'Admin' | 'Dev' | 'Employee';

export type Permission =
    | 'view:all'
    | 'view:prices'
    | 'edit:all'
    | 'delete:all';

interface AuthContextType {
    user: User | null;
    role: UserRole;
    dbRole: UserRole;
    displayName: string | null;
    avatarUrl: string | null;
    setRole: (role: UserRole | 'logged-in') => void;
    hasPermission: (permission: Permission) => boolean;
    signOut: () => Promise<void>;
    isLoading: boolean;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = React.useState<User | null>(null);
    const [dbRole, setDbRole] = React.useState<UserRole>('Employee');
    const [displayName, setDisplayName] = React.useState<string | null>(null);
    const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
    const [devOverride, setDevOverride] = React.useState<UserRole | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);

    const role = devOverride ?? dbRole;

    // Initialize: check session + subscribe to auth changes
    React.useEffect(() => {
        const supabase = createClient();

        // Check for dev override in localStorage
        const stored = localStorage.getItem('dev_mock_role');
        if (stored && ['Owner', 'Admin', 'Dev', 'Employee'].includes(stored)) {
            setDevOverride(stored as UserRole);
        }

        // Get initial session
        const initSession = async () => {
            const { data: { user: currentUser } } = await supabase.auth.getUser();
            setUser(currentUser);
            if (currentUser) {
                fetchProfile(currentUser.id);
            } else {
                setIsLoading(false);
            }
        };
        initSession();

        // Subscribe to auth state changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (_event: AuthChangeEvent, session: Session | null) => {
                const currentUser = session?.user ?? null;
                setUser(currentUser);
                if (currentUser) {
                    fetchProfile(currentUser.id);
                } else {
                    setDbRole('Employee');
                    setIsLoading(false);
                }
            }
        );

        return () => subscription.unsubscribe();
    }, []);

    async function fetchProfile(userId: string) {
        const supabase = createClient();
        const { data } = await supabase
            .from('profiles')
            .select('role, display_name, avatar_url')
            .eq('id', userId)
            .single();

        if (data?.role) {
            setDbRole(data.role as UserRole);
        }
        setDisplayName(data?.display_name ?? null);
        setAvatarUrl(data?.avatar_url ?? null);
        setIsLoading(false);
    }

    const setRole = (newRole: UserRole | 'logged-in') => {
        if (newRole === 'logged-in') {
            setDevOverride(null);
            localStorage.removeItem('dev_mock_role');
        } else {
            setDevOverride(newRole);
            localStorage.setItem('dev_mock_role', newRole);
        }
    };

    const signOut = async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        setUser(null);
        setDbRole('Employee');
        setDevOverride(null);
        localStorage.removeItem('dev_mock_role');
    };

    const hasPermission = React.useCallback((permission: Permission): boolean => {
        switch (role) {
            case 'Owner':
            case 'Admin':
            case 'Dev':
                return true;
            case 'Employee':
                if (permission === 'view:prices') return false;
                if (permission === 'delete:all') return false;
                return true;
            default:
                return false;
        }
    }, [role]);

    return (
        <AuthContext.Provider value={{
            user,
            role,
            dbRole,
            displayName,
            avatarUrl,
            setRole,
            hasPermission,
            signOut,
            isLoading,
        }}>
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
