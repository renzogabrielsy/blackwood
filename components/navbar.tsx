'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, Bell, LogOut, Moon, Settings, Shield, Sun } from 'lucide-react';
import { useAuth, type UserRole } from '@/components/providers/auth-context';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';

interface Breadcrumb {
    backLabel: string;
    backHref: string;
    pageTitle: string;
    pageDescription?: string;
}

function getBreadcrumb(pathname: string): Breadcrumb | null {
    if (pathname.startsWith('/rc-in/edit/')) {
        return { backLabel: 'Back to Master Log', backHref: '/rc-in', pageTitle: 'Edit Remarks' };
    }
    if (pathname === '/rc-in') {
        return { backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Master Log', pageDescription: 'Recent delivery history' };
    }
    if (pathname === '/settings') {
        return { backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Settings', pageDescription: 'Manage user roles and permissions' };
    }
    return null;
}

function getInitials(name: string | null, email: string | null): string {
    if (name) {
        return name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
    }
    if (email) {
        return email[0].toUpperCase();
    }
    return '?';
}

const PRIVILEGED_ROLES: UserRole[] = ['Owner', 'Admin', 'Dev'];

export function Navbar() {
    const { user, role, dbRole, displayName, avatarUrl, setRole, signOut } = useAuth();
    const pathname = usePathname();
    const router = useRouter();

    const breadcrumb = getBreadcrumb(pathname);
    const initials = getInitials(displayName, user?.email ?? null);
    const canSwitchRoles = PRIVILEGED_ROLES.includes(dbRole);

    const handleSignOut = async () => {
        await signOut();
        router.push('/login');
    };

    return (
        <nav className="flex-none h-12 border-b border-zinc-700 bg-zinc-900 px-8 flex items-center shadow-[0_2px_8px_rgba(0,0,0,0.3)] z-10">
            {/* Left — breadcrumb */}
            <div className="flex-1 flex items-center gap-2 min-w-0">
                {breadcrumb && (
                    <>
                        <Link
                            href={breadcrumb.backHref}
                            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors shrink-0"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            {breadcrumb.backLabel}
                        </Link>
                        <span className="text-zinc-600 text-base">/</span>
                        <span className="text-sm font-medium text-zinc-200 shrink-0">
                            {breadcrumb.pageTitle}
                        </span>
                        {breadcrumb.pageDescription && (
                            <span className="text-xs text-zinc-500 truncate self-end pb-[2px] pl-[5px]">
                                {breadcrumb.pageDescription}
                            </span>
                        )}
                    </>
                )}
            </div>

            {/* Center — Blackwood */}
            <Link
                href="/"
                className="text-xl font-bold tracking-tight text-zinc-100 hover:text-white transition-colors shrink-0 px-4"
            >
                Blackwood
            </Link>

            {/* Right — controls */}
            <div className="flex-1 flex items-center justify-end gap-1.5">
                <TooltipProvider delayDuration={300}>
                    {/* Role Switcher — Owner/Admin/Dev only */}
                    {canSwitchRoles && (
                        <DropdownMenu>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800">
                                            <Shield className="h-4 w-4" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>Dev Role Override</TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent align="end">
                                {user && (
                                    <>
                                        <DropdownMenuItem onClick={() => setRole('logged-in')}>
                                            Logged In ({user.email}) — {dbRole}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                    </>
                                )}
                                <DropdownMenuLabel>Dev Override</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {(['Owner', 'Admin', 'Dev', 'Employee'] as UserRole[]).map((r) => (
                                    <DropdownMenuItem key={r} onClick={() => setRole(r)} className={role === r ? "bg-accent" : ""}>
                                        {r} {role === r && "(Active)"}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}

                    {/* Dark Mode Toggle — scaffold */}
                    <button
                        type="button"
                        className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-zinc-700 transition-colors mx-0.5"
                    >
                        <Sun className="absolute left-1.5 h-3 w-3 text-zinc-400" />
                        <Moon className="absolute right-1.5 h-3 w-3 text-zinc-400" />
                        <span className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 shadow-sm translate-x-0.5 transition-transform">
                            <Sun className="h-3 w-3 text-zinc-700" />
                        </span>
                    </button>

                    {/* Notifications — scaffold */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800">
                                <Bell className="h-4 w-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Notifications</TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                {/* Profile */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 rounded-full p-0 hover:bg-zinc-800">
                            <Avatar className="h-7 w-7">
                                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName ?? ''} />}
                                <AvatarFallback className="text-[11px] bg-zinc-700 text-zinc-200">{initials}</AvatarFallback>
                            </Avatar>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <div className="px-2 py-1.5">
                            <p className="text-sm font-medium">{displayName ?? 'User'}</p>
                            <p className="text-xs text-muted-foreground">{user?.email}</p>
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link href="/settings" className="cursor-pointer">
                                <Settings className="mr-2 h-4 w-4" />
                                Settings
                            </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
                            <LogOut className="mr-2 h-4 w-4" />
                            Sign Out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </nav>
    );
}
