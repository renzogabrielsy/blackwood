// ─── Cenapro badge class maps (display mode only — inputs stay plain) ─────────────
//
// Promoted VERBATIM out of `production/production-ledger-grid.tsx` on 2026-08-04, when
// the QC Ledger's PLANT cell became a dropdown and needed the SAME plant colours. The
// grid is a 1,500-line client component that imports its own server actions; importing
// it from another route to borrow two string maps would have dragged all of that into
// the QC bundle — and into `scripts/verify-qc-draw-cells.ts`, which runs these modules
// under plain Node.
//
// So the definitions live HERE, in a pure module with no React and no imports at all,
// and `production-ledger-grid.tsx` re-exports all three so every existing import site
// (the endless sheet, the mobile cards) keeps working unchanged. There is still exactly
// ONE definition of each colour scheme.
//
// Compact, bold, rounded badges sized to the dense h-8 row. Each uses the project idiom
// (Tailwind color util + /10–/15 fill + a `dark:` text variant) so it reads in BOTH
// themes. These render in the GridCell/SelectCell DISPLAY state — the edit <Input> is
// never wrapped, so typing/paste is unaffected.

export const BADGE_BASE =
    'inline-flex items-center justify-center rounded px-1.5 py-0 h-5 font-mono text-[11px] font-bold leading-none border';

// CCC/FLEC: FLEC (the bagging "in") → emerald; crushers C1–C4 → amber; kilns RK1–RK4 →
// rose. So bagging clearly reads as the IN, and crushers vs kilns are distinguishable.
// Punchier than before: /20–/25 fill + /40 border + a confident -700/-300 bold text so
// each color is distinct and obvious in BOTH modes.
export function cccFlecBadgeClass(raw: string): string {
    const v = raw.trim().toUpperCase();
    if (v === 'FLEC') return 'border-emerald-500/40 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300';
    if (/^C[1-4]$/.test(v)) return 'border-amber-500/40 bg-amber-500/25 text-amber-700 dark:text-amber-300';
    if (/^RK[1-4]$/.test(v)) return 'border-rose-500/40 bg-rose-500/20 text-rose-700 dark:text-rose-300';
    // Unrecognized value — neutral badge so it's still visible (and obviously not a real code).
    return 'border-border bg-muted text-muted-foreground';
}

// PLANT: one distinct, accessible color per plant. W6 → blue, W7 → teal, W6/W7 →
// indigo (the union), DVO → slate. Empty/null plant → no badge (handled by the caller).
// Stronger fill (/20) + border (/40) + bold -700/-300 text so each plant reads punchy
// in both modes.
export function plantBadgeClass(raw: string): string {
    switch (raw.trim().toUpperCase()) {
        case 'W6': return 'border-blue-500/40 bg-blue-500/20 text-blue-700 dark:text-blue-300';
        case 'W7': return 'border-teal-500/40 bg-teal-500/20 text-teal-700 dark:text-teal-300';
        case 'W6/W7': return 'border-indigo-500/40 bg-indigo-500/20 text-indigo-700 dark:text-indigo-300';
        case 'DVO': return 'border-slate-500/40 bg-slate-500/20 text-slate-700 dark:text-slate-300';
        default: return 'border-border bg-muted text-muted-foreground';
    }
}
