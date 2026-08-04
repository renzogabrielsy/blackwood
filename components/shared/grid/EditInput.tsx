'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

// The CANONICAL inline-edit input class. An editing input must visually MATCH the static
// cell EXACTLY — same font-size (text-[11px]), padding (px-1.5), transparent bg, no border,
// no focus ring/outline, full height, box-border, no margin/min-height, spinner killed —
// so clicking a cell to edit changes ONLY the caret, never the row height.
// Promoted VERBATIM from production-daily-block.tsx (was a local `EDIT_INPUT` const).
export const EDIT_INPUT =
    'm-0 box-border h-full w-full appearance-none border-0 bg-transparent px-1.5 py-0 text-[11px] leading-none outline-none focus:ring-0 focus-visible:ring-0 [min-height:0]';

// ─── EditInput — the canonical inline cell editor (no row-height expansion) ──────────
// A bare <input> that matches the static cell metrics EXACTLY (EDIT_INPUT). Optional
// `list` wires a native <datalist> for Excel-style typeahead. PLACEHOLDER behaves like a
// true Excel cell: it shows when empty + unfocused, VANISHES the instant the cell is
// focused (we blank the placeholder attr on focus), and reappears on blur-if-empty.
//
// Promoted VERBATIM from production-daily-block.tsx. Standalone + presentational: it
// owns ONLY the bare input, the Escape-suppresses-blur-commit ref, and focus/placeholder
// behavior. No daily-block-specific imports.
export interface EditInputProps {
    value: string;
    onChange: (v: string) => void;
    onCommit: () => void;
    onEscape?: () => void;
    placeholder?: string;
    list?: string;
    align?: 'left' | 'right' | 'center';
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    valueClass?: string;
    autoFocus?: boolean;
    /** Stable `rowKey|colKey` id for keyboard nav (the grid reads these from the DOM). */
    navId?: string;
    /** Called on focus so click + keyboard share one active-cell model. */
    onActivate?: (navId: string | null) => void;
}

export function EditInput({
    value,
    onChange,
    onCommit,
    onEscape,
    placeholder,
    list,
    align = 'left',
    inputMode,
    valueClass,
    autoFocus,
    navId: navIdProp,
    onActivate,
}: EditInputProps) {
    const [focused, setFocused] = React.useState(false);
    // Escape must NOT also fire the blur-commit (it would re-commit the reverted value —
    // e.g. an existing weight cell would route to the delete-confirm). This ref suppresses
    // the next onBlur-commit after an Escape.
    const escapedRef = React.useRef(false);

    // ── autoFocus WITHOUT the page jump (2026-08-04) ──────────────────────────────────
    // React's own `autoFocus` prop focuses through a bare `domElement.focus()` in
    // react-dom's `commitMount` — no options — and `HTMLElement.focus()` is specified to
    // run "scroll an element into view" with block AND inline **"center"**, in EVERY
    // scrolling box up to the document (an `overflow-hidden` ancestor is still
    // programmatically scrollable, so it counts). `"center"` always computes a target, so
    // it fires even when the cell is already fully visible: merely STARTING an edit
    // re-centred the row and dragged the page with it.
    //
    // So we take the focus over and refuse only the scroll. A ref callback lands in the
    // same commit (layout) phase `commitMount` would have, and — like react-dom — it does
    // NOT call `select()` or `setSelectionRange()`, so the caret still lands wherever the
    // browser puts it for a freshly focused input. Caret + selection behaviour is
    // byte-identical; only the scroll is gone. `autoFocus` must stay OFF the <input> or
    // React would re-add its own unguarded focus on top.
    const focusOnMount = React.useCallback((el: HTMLInputElement | null) => {
        el?.focus({ preventScroll: true });
    }, []);

    const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
    return (
        <input
            ref={autoFocus ? focusOnMount : undefined}
            value={value}
            list={list}
            inputMode={inputMode}
            data-navid={navIdProp}
            // Placeholder vanishes on focus (Excel-like), restores on empty blur.
            placeholder={focused ? '' : placeholder}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => { setFocused(true); onActivate?.(navIdProp ?? null); }}
            onBlur={() => { setFocused(false); if (escapedRef.current) { escapedRef.current = false; return; } onCommit(); }}
            // Tab / Enter / arrows are owned by the grid-level keydown (it commits via this
            // input's blur, then focuses the next cell). EditInput keeps ONLY Escape (cancel
            // + stay put). Esc suppresses the blur-commit via escapedRef.
            onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); escapedRef.current = true; onEscape?.(); (e.target as HTMLInputElement).blur(); }
            }}
            className={cn(EDIT_INPUT, 'font-mono tabular-nums placeholder:text-muted-foreground/40', textAlign, valueClass)}
        />
    );
}
