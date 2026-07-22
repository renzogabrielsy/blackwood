// ─── Cenapro production ledger — URL axis helpers (pure, no React) ───────────────
// The production screen is governed by THREE orthogonal URL axes. This module owns the
// two *enum* axes as pure parse/format helpers so BOTH the server page (page.tsx) and
// the client toolbar controls (ledger-controls.tsx) share one source of truth without a
// client/server boundary hazard — there is NO 'use client' directive here, so the
// server component can call `parseViewMode` / `parseScope` / `plantViewOf` directly.
//
//   1. VIEW  (`?view=ledger|daily-w6|daily-w7`) — WHAT you look at: the flat ledger, or
//      the W6 / W7 daily pivot. (The third axis, EDIT lock/unlock, lands in Phase 3 and
//      has no URL param yet.)
//   2. SCOPE (`?scope=endless|focus`) — HOW MUCH history is in view: the whole
//      cursor-guided history (endless), or one clamped (batch_year, batch) period (focus).
//
// Both axes are independent: every VIEW × SCOPE combination is valid and reachable.

// ─── View axis ──────────────────────────────────────────────────────────────────
export const VIEW_MODES = ['ledger', 'daily-w6', 'daily-w7'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
    ledger: 'Ledger',
    'daily-w6': 'Daily W6',
    'daily-w7': 'Daily W7',
};

export function parseViewMode(raw: string | null | undefined): ViewMode {
    // Backward-compat: the legacy single Daily Block (`?view=daily`) maps to W6.
    if (raw === 'daily') return 'daily-w6';
    return raw && (VIEW_MODES as readonly string[]).includes(raw) ? (raw as ViewMode) : 'ledger';
}

/** Map a daily view mode → the plant variant the Daily Block renders (null for ledger). */
export function plantViewOf(mode: ViewMode): 'W6' | 'W7' | null {
    if (mode === 'daily-w6') return 'W6';
    if (mode === 'daily-w7') return 'W7';
    return null;
}

// ─── Scope axis ─────────────────────────────────────────────────────────────────
export const SCOPES = ['endless', 'focus'] as const;
export type Scope = (typeof SCOPES)[number];

// `endless` is the default and OMITS the param (clean URLs); anything invalid/absent
// resolves to endless. Only `focus` is written as `?scope=focus`.
export function parseScope(raw: string | null | undefined): Scope {
    return raw === 'focus' ? 'focus' : 'endless';
}
