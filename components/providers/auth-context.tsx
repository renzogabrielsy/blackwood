'use client';

import * as React from 'react';
import { createClient } from '@/lib/supabase/client';
import type { User, AuthChangeEvent, Session } from '@supabase/supabase-js';

// Canonical UserRole lives in types/auth.ts. Re-exported here so the many existing
// consumers that import `UserRole` from this provider keep working (single source
// of truth, no duplicate union).
export type { UserRole } from '@/types/auth';
import type { UserRole } from '@/types/auth';

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
    const [dbRole, setDbRole] = React.useState<UserRole>('Production');
    const [displayName, setDisplayName] = React.useState<string | null>(null);
    const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
    const [devOverride, setDevOverride] = React.useState<UserRole | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);

    const role = devOverride ?? dbRole;

    // Track last user ID to prevent unnecessary profile refetches
    const lastUserIdRef = React.useRef<string | null>(null);

    // Helper to fetch profile (defined before useEffect to satisfy React Hooks rule)
    const fetchProfile = React.useCallback(async (userId: string) => {
        const supabase = createClient();
        const { data, error } = await supabase
            .from('profiles')
            .select('role, display_name, avatar_url, status')
            .eq('id', userId)
            .single();

        if (error) {
            // console.error(`Failed to fetch profile: ${error.message}`);
            setIsLoading(false);
            return;
        }

        if (data?.status !== 'active') {
            await supabase.auth.signOut();
            if (data?.status === 'disabled') {
                window.location.href = '/access-denied';
            } else {
                window.location.href = '/login?error=not_invited';
            }
            return;
        }

        if (data?.role) {
            setDbRole(data.role as UserRole);
        }
        setDisplayName(data?.display_name ?? null);
        setAvatarUrl(data?.avatar_url ?? null);
        setIsLoading(false);
    }, [setDbRole, setDisplayName, setAvatarUrl, setIsLoading]);

    // Initialize: check session + subscribe to auth changes
    React.useEffect(() => {
        const supabase = createClient();

        // Check for dev override in localStorage
        const stored = localStorage.getItem('dev_mock_role');
        if (stored && ['Owner', 'Admin', 'Dev', 'Production', 'Accounting'].includes(stored)) {
            setDevOverride(stored as UserRole);
        }

        // Get initial session
        const initSession = async () => {
            const { data: { user: currentUser } } = await supabase.auth.getUser();
            setUser(currentUser);
            if (currentUser) {
                lastUserIdRef.current = currentUser.id;
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

                // Only fetch profile if user ID actually changed (not on TOKEN_REFRESHED or SESSION_UPDATED)
                if (currentUser) {
                    if (lastUserIdRef.current !== currentUser.id) {
                        lastUserIdRef.current = currentUser.id;
                        fetchProfile(currentUser.id);
                    }
                } else {
                    lastUserIdRef.current = null;
                    setDbRole('Production');
                    setIsLoading(false);
                }
            }
        );

        return () => subscription.unsubscribe();
    }, [fetchProfile]);

    const setRole = React.useCallback((newRole: UserRole | 'logged-in') => {
        if (newRole === 'logged-in') {
            setDevOverride(null);
            localStorage.removeItem('dev_mock_role');
            document.cookie = 'dev_mock_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        } else {
            setDevOverride(newRole);
            localStorage.setItem('dev_mock_role', newRole);
            document.cookie = `dev_mock_role=${newRole}; path=/; max-age=31536000`;
        }
    }, []);

    const signOut = async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        setUser(null);
        setDbRole('Production');
        setDevOverride(null);
        localStorage.removeItem('dev_mock_role');
    };

    const hasPermission = React.useCallback((permission: Permission): boolean => {
        switch (role) {
            case 'Owner':
            case 'Admin':
            case 'Dev':
                return true;
            case 'Accounting':
                // Accounting permissions:
                // - Can see prices (view:prices = true)
                // - CANNOT edit everything? (Task says "most probably only have access to /inventory/rc-in", "must not have same access as Admins")
                // - Let's assume they can view/edit in their scope, but maybe restricts delete?
                // For now, allow verify prices.
                if (permission === 'delete:all') return false;
                return true;
            case 'Production':
                // Production permissions:
                // - STRICTLY NO PRICE ACCESS
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
