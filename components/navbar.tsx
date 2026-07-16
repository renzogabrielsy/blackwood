'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ArrowLeft, Factory, LogOut, Menu, Moon, Settings, Shield, Sun } from 'lucide-react';
import { NotificationBell } from '@/components/notification-bell';
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
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
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

/**
 * Ordered breadcrumb registry. Each entry's `test` decides whether it applies to the
 * current pathname; the FIRST match wins, so MORE-SPECIFIC routes must come BEFORE their
 * parent catch-alls (e.g. `/inventory/blocking` precedes the `/inventory` catch-all, and
 * `/cenapro/production` precedes `/cenapro`). Replaces the old long if-chain.
 */
interface BreadcrumbEntry extends Breadcrumb {
    test: (pathname: string) => boolean;
}

const exact = (path: string) => (pathname: string) => pathname === path;
const prefix = (path: string) => (pathname: string) => pathname.startsWith(path);

const BREADCRUMB_REGISTRY: BreadcrumbEntry[] = [
    { test: prefix('/edit/'), backLabel: 'Back to Inventory', backHref: '/inventory', pageTitle: 'Edit Discussion' },
    // Inventory sub-routes — MUST precede the `/inventory` catch-all below.
    { test: prefix('/inventory/blocking'), backLabel: 'Back to Inventory', backHref: '/inventory', pageTitle: 'Blocking', pageDescription: 'Warehouse grid — block occupancy & balances' },
    { test: prefix('/inventory/rc-movement'), backLabel: 'Back to Inventory', backHref: '/inventory', pageTitle: 'Movement', pageDescription: 'Daily feed matrix — campaign-scoped day × block' },
    { test: prefix('/inventory/flecon-bags'), backLabel: 'Back to Inventory', backHref: '/inventory', pageTitle: 'Bag Inventory', pageDescription: 'FLECON bag stock — balances & movement ledger' },
    { test: prefix('/inventory'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Inventory', pageDescription: 'Raw charcoal deliveries, usage & tracking' },
    // Production sub-routes — MUST precede the `/production` catch-all below.
    { test: prefix('/production/schedule'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Production Schedule', pageDescription: 'Month plan vs actual — projected tons & Joseph\'s authoritative schedule' },
    { test: prefix('/production'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Production', pageDescription: 'Daily runs, downtime, waste, electricity & trucks' },
    { test: prefix('/summaries'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Summaries', pageDescription: 'Delivery price & volume analysis — by period or supplier' },
    // Price & Volume Analysis design concepts (planning-stage demos).
    // Specific demo routes MUST precede the `/price-demos` index catch-all.
    { test: prefix('/price-demos/demo1'), backLabel: 'Back to Demos', backHref: '/price-demos', pageTitle: 'Terminal', pageDescription: 'Dual-axis volume × price command view (concept 1 of 4)' },
    { test: prefix('/price-demos/demo2'), backLabel: 'Back to Demos', backHref: '/price-demos', pageTitle: 'Ledger', pageDescription: 'Sortable supplier league table with sparklines (concept 2 of 4)' },
    { test: prefix('/price-demos/demo3'), backLabel: 'Back to Demos', backHref: '/price-demos', pageTitle: 'Heatmap', pageDescription: 'Month × supplier ₱/kg & volume matrix (concept 3 of 4)' },
    { test: prefix('/price-demos/demo4'), backLabel: 'Back to Demos', backHref: '/price-demos', pageTitle: 'Analyst Brief', pageDescription: 'Executive monthly review dashboard (concept 4 of 4)' },
    { test: prefix('/price-demos'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Price & Volume Demos', pageDescription: 'Four design concepts for delivery price & volume analysis' },
    // Cenapro sub-routes — MUST precede the `/cenapro` catch-all below.
    { test: prefix('/cenapro/production'), backLabel: 'Back to Cenapro', backHref: '/cenapro', pageTitle: 'Cenapro · Production', pageDescription: 'CI production events — bagging & partner draws' },
    { test: prefix('/cenapro/inventory'), backLabel: 'Back to Cenapro', backHref: '/cenapro', pageTitle: 'Cenapro · Flec Inventory', pageDescription: 'Per-warehouse flec balances & movement ledger' },
    { test: prefix('/cenapro'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Cenapro', pageDescription: 'CI / Cebu production & flec inventory — second tenant' },
    { test: exact('/notifications'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Notifications' },
    { test: exact('/settings'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Settings', pageDescription: 'Your profile and sign-out' },
    { test: exact('/admin'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Admin Panel', pageDescription: 'Manage users and invitations' },
    { test: exact('/review-queue'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Review Queue', pageDescription: 'Pre-extracted rows from daily reports awaiting approval' },
    { test: prefix('/sync/cases'), backLabel: 'Back to Dashboard', backHref: '/', pageTitle: 'Sync Review', pageDescription: 'Held-row cases & investigations' },
];

function getBreadcrumb(pathname: string): Breadcrumb | null {
    const entry = BREADCRUMB_REGISTRY.find((e) => e.test(pathname));
    if (!entry) return null;
    const { backLabel, backHref, pageTitle, pageDescription } = entry;
    return { backLabel, backHref, pageTitle, pageDescription };
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

type Module = { name: string; href: string; disabled?: boolean };

// ICTC / Davao Inventory sub-group — the four inventory surfaces, shown INDENTED under an
// "Inventory" mini-label in the dropdown. Deliveries/Usage deep-link into the logs page's
// tab; Blocking/Movement are standalone routes. Plain labels (no "RC " prefix).
const ICTC_INVENTORY: Module[] = [
    { name: 'Blocking', href: '/inventory/blocking' },
    { name: 'Deliveries', href: '/inventory?tab=deliveries' },
    { name: 'Usage', href: '/inventory?tab=usage' },
    { name: 'Movement', href: '/inventory/rc-movement' },
    { name: 'Bag Inventory', href: '/inventory/flecon-bags' },
];

// ICTC / Davao top-level modules shown as siblings BELOW the Inventory sub-group.
const ICTC_MODULES: Module[] = [
    { name: 'Production', href: '/production' },
    { name: 'Summaries', href: '/summaries' },
    { name: 'Accounting', href: '/accounting', disabled: true },
];

// Cenapro / Cebu tenant modules — kept in a separate section from ICTC.
const CENAPRO_MODULES: Module[] = [
    { name: 'Production', href: '/cenapro/production' },
    { name: 'Flec Inventory', href: '/cenapro/inventory' },
];

// A single mobile-nav row. Disabled modules render as inert text; live ones are
// SheetClose-wrapped links so navigation dismisses the sheet. Hoisted to module level
// (never defined during render) so it keeps a stable identity.
function MobileNavItem({ mod, indent }: { mod: Module; indent?: boolean }) {
    const base = 'flex min-h-11 items-center rounded-md px-2 text-sm transition-colors';
    const pad = indent ? 'pl-5' : '';
    if (mod.disabled) {
        return (
            <div className={`${base} ${pad} cursor-not-allowed text-muted-foreground/50`}>
                {mod.name}
            </div>
        );
    }
    return (
        <SheetClose asChild>
            <Link
                href={mod.href}
                className={`${base} ${pad} text-foreground hover:bg-accent hover:text-accent-foreground`}
            >
                {mod.name}
            </Link>
        </SheetClose>
    );
}

/**
 * Mobile navigation Sheet — rendered ONLY below `sm` (the trigger is `sm:hidden`), it replaces
 * the desktop breadcrumb block that gets `hidden sm:flex`. It REUSES the same module-level
 * constants the desktop Modules dropdown renders (`ICTC_INVENTORY` / `ICTC_MODULES` /
 * `CENAPRO_MODULES` + the `PRIVILEGED_ROLES` conditional) — no duplicated link list, single
 * source of truth. Each nav item is wrapped in `SheetClose asChild`, so tapping a link closes
 * the sheet AND navigates in one gesture. The current page title (from the same
 * `getBreadcrumb()` resolution the breadcrumb uses) is surfaced in the sheet header since the
 * breadcrumb text is hidden on mobile.
 *
 * The BAR stays dark-themed and untouched; only this Sheet panel is a normal `bg-background`
 * surface (readable nav, per the sheet convention).
 */
function MobileNav({ role, currentTitle }: { role: UserRole; currentTitle: string }) {
    return (
        <Sheet>
            <SheetTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 sm:hidden"
                    aria-label="Open navigation menu"
                >
                    <Menu className="h-5 w-5" />
                </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
                <SheetHeader className="border-b">
                    <SheetTitle>{currentTitle}</SheetTitle>
                    <SheetDescription className="sr-only">Site navigation</SheetDescription>
                </SheetHeader>
                <nav className="flex-1 overflow-y-auto px-2 py-3">
                    <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        ICTC · Davao
                    </p>
                    {/* Inventory sub-group — mini-label + indented children, mirroring the dropdown. */}
                    <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground/80">Inventory</p>
                    {ICTC_INVENTORY.map((mod) => (
                        <MobileNavItem key={`m-ictc-inv-${mod.name}`} mod={mod} indent />
                    ))}
                    {ICTC_MODULES.map((mod) => (
                        <MobileNavItem key={`m-ictc-${mod.name}`} mod={mod} />
                    ))}
                    <div className="my-2 border-t" />
                    <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Cenapro · Cebu
                    </p>
                    {CENAPRO_MODULES.map((mod) => (
                        <MobileNavItem key={`m-cenapro-${mod.name}`} mod={mod} />
                    ))}
                    {PRIVILEGED_ROLES.includes(role) && (
                        <>
                            <div className="my-2 border-t" />
                            <MobileNavItem mod={{ name: 'Sync Review', href: '/sync/cases' }} />
                            <MobileNavItem mod={{ name: 'Review Queue', href: '/review-queue' }} />
                            <MobileNavItem mod={{ name: 'Admin Panel', href: '/admin' }} />
                        </>
                    )}
                </nav>
            </SheetContent>
        </Sheet>
    );
}

export function Navbar() {
    const { user, role, dbRole, displayName, avatarUrl, setRole, signOut } = useAuth();
    const pathname = usePathname();
    const router = useRouter();
    const { setTheme, resolvedTheme } = useTheme();
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => setMounted(true), []);

    const breadcrumb = getBreadcrumb(pathname);
    const initials = getInitials(displayName, user?.email ?? null);
    const canSwitchRoles = PRIVILEGED_ROLES.includes(dbRole);
    const isDark = resolvedTheme === 'dark';

    const handleSignOut = async () => {
        await signOut();
        router.push('/login');
    };

    const toggleTheme = () => {
        setTheme(isDark ? 'light' : 'dark');
    };

    return (
        <nav className="flex-none h-12 border-b border-zinc-700 bg-zinc-800 dark:bg-zinc-700 px-4 sm:px-8 flex items-center shadow-[0_2px_8px_rgba(0,0,0,0.3)] z-10">
            {/* Left — hamburger (mobile, below sm) + breadcrumb (desktop, sm+) */}
            <div className="flex-1 flex items-center gap-2 min-w-0">
                {/* Mobile-only navigation trigger — replaces the breadcrumb at <sm. */}
                <MobileNav role={role} currentTitle={breadcrumb?.pageTitle ?? 'Dashboard'} />
                {/* Desktop breadcrumb — unchanged at sm+, hidden on mobile. */}
                {breadcrumb && (
                    <div className="hidden sm:flex items-center gap-2 min-w-0">
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
                    </div>
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
                    {/* Modules */}
                    <DropdownMenu>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600">
                                        <Factory className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>Modules</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                            <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                ICTC · Davao
                            </DropdownMenuLabel>
                            {/* Inventory sub-group — a mini-label with indented children, so
                                the four inventory surfaces read as a scannable cluster. */}
                            <DropdownMenuLabel className="pl-2 text-[11px] font-medium text-muted-foreground/80">
                                Inventory
                            </DropdownMenuLabel>
                            {ICTC_INVENTORY.map((mod) => (
                                <DropdownMenuItem key={`ictc-inv-${mod.name}`} asChild className="pl-5">
                                    <Link href={mod.href}>{mod.name}</Link>
                                </DropdownMenuItem>
                            ))}
                            {/* Sibling modules below the Inventory sub-group. */}
                            {ICTC_MODULES.map((mod) =>
                                mod.disabled ? (
                                    <DropdownMenuItem key={`ictc-${mod.name}`} disabled>
                                        {mod.name}
                                    </DropdownMenuItem>
                                ) : (
                                    <DropdownMenuItem key={`ictc-${mod.name}`} asChild>
                                        <Link href={mod.href}>{mod.name}</Link>
                                    </DropdownMenuItem>
                                )
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Cenapro · Cebu
                            </DropdownMenuLabel>
                            {CENAPRO_MODULES.map((mod) => (
                                <DropdownMenuItem key={`cenapro-${mod.name}`} asChild>
                                    <Link href={mod.href}>{mod.name}</Link>
                                </DropdownMenuItem>
                            ))}
                            {PRIVILEGED_ROLES.includes(role) && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem asChild>
                                        <Link href="/sync/cases">Sync Review</Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                        <Link href="/review-queue">Review Queue</Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                        <Link href="/admin">Admin Panel</Link>
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Role Switcher — Owner/Admin/Dev only */}
                    {canSwitchRoles && (
                        <DropdownMenu>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600">
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
                                {(['Owner', 'Admin', 'Dev', 'Production', 'Accounting'] as UserRole[]).map((r) => (
                                    <DropdownMenuItem key={r} onClick={() => setRole(r)} className={role === r ? "bg-accent" : ""}>
                                        {r} {role === r && "(Active)"}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}

                    {/* Dark Mode Toggle */}
                    {mounted && (
                        <button
                            type="button"
                            onClick={toggleTheme}
                            className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-zinc-600 transition-colors mx-0.5"
                            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                        >
                            <Sun className="absolute left-1.5 h-3 w-3 text-amber-300" />
                            <Moon className="absolute right-1.5 h-3 w-3 text-blue-300" />
                            <span className={`pointer-events-none flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 shadow-sm transition-transform duration-200 ${isDark ? 'translate-x-[22px]' : 'translate-x-0.5'}`}>
                                {isDark
                                    ? <Moon className="h-3 w-3 text-zinc-700" />
                                    : <Sun className="h-3 w-3 text-amber-500" />
                                }
                            </span>
                        </button>
                    )}

                    {/* Notifications */}
                    <NotificationBell />
                </TooltipProvider>

                {/* Profile */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 rounded-full p-0 hover:bg-zinc-600">
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
