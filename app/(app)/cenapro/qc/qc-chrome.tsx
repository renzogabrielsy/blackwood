// Shared chrome for the two QC routes: status chips, KPI tiles, panels and the
// narrow-viewport notice. Presentational only — no state, no directive, so a server
// page and a client component can both render them.

import { cn } from '@/lib/utils';

// ─── Chips ───────────────────────────────────────────────────────────────────────

export type ChipTone = 'ok' | 'pending' | 'info' | 'muted';

const CHIP_TONE: Record<ChipTone, string> = {
    ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    muted: 'bg-muted text-muted-foreground',
};

export function Chip({
    tone = 'muted',
    children,
    className,
}: {
    tone?: ChipTone;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide',
                CHIP_TONE[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}

// ─── KPI tile ────────────────────────────────────────────────────────────────────

export function Tile({
    label,
    value,
    sub,
    subTone = 'muted',
    children,
}: {
    label: string;
    value: string;
    sub?: string;
    subTone?: 'muted' | 'amber';
    children?: React.ReactNode;
}) {
    return (
        <div className="min-w-0 rounded-lg border border-border bg-muted/40 px-3 pb-2 pt-2.5">
            <p className="truncate text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {label}
            </p>
            <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums leading-tight">{value}</p>
            {children}
            {sub ? (
                <p
                    className={cn(
                        'mt-0.5 truncate text-[10px]',
                        subTone === 'amber'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground/70',
                    )}
                >
                    {sub}
                </p>
            ) : null}
        </div>
    );
}

// ─── Panel ───────────────────────────────────────────────────────────────────────

export function Panel({
    title,
    subtitle,
    actions,
    children,
    className,
}: {
    title: string;
    subtitle?: string;
    /** Right-aligned controls in the panel header (a segmented toggle, a legend…). */
    actions?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={cn('min-w-0 rounded-lg border border-border bg-card p-3', className)}>
            <header className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="truncate text-xs font-semibold">{title}</h3>
                <div className="flex shrink-0 items-center gap-2">
                    {subtitle ? (
                        <span className="text-[10px] text-muted-foreground/70">{subtitle}</span>
                    ) : null}
                    {actions}
                </div>
            </header>
            {children}
        </section>
    );
}

// ─── Narrow-viewport notice (the LEDGER only) ────────────────────────────────────

/**
 * The entry grid is a twelve-column spreadsheet with a keyboard model; reflowing it
 * onto a phone would produce something nobody could type into accurately, so below
 * `sm` it says so instead. The BREAKDOWN has no such notice — it is read-only and
 * degrades honestly (its tables scroll inside their own scrollports).
 */
export function NarrowScreenNotice() {
    return (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center sm:hidden">
            <p className="text-sm font-medium">Open on a wider screen</p>
            <p className="mt-1 text-xs text-muted-foreground">
                The QC entry grid needs at least a tablet-width viewport. The{' '}
                <span className="font-medium">QC Breakdown</span> page reads fine on a phone.
            </p>
        </div>
    );
}
