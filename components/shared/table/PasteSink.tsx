'use client';

import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────────
// PasteSink — the grid's ear for the clipboard. PLATFORM LAYER.
//
// **READ THIS BEFORE TOUCHING THE PASTE PATH.** Never put `onPaste` on a non-editable
// `<div>` and expect it to fire. The grid this module replaces did exactly that, and
// paste was dead through three rounds of "fixes" that each repaired a genuine fault
// INSIDE the paste handler — none of which helped, because the handler was never running.
//
// Why: `Delete`, `Escape`, the arrows and `Ctrl/Cmd+C` are all **keydown**, and a keydown
// goes to whatever holds focus — a `<div tabIndex={-1}>` included. That is why those
// gestures work. **`paste` is a clipboard event and plays by a different rule:** the
// browser dispatches it at an element that can ACCEPT a paste. A focused non-editable div
// cannot, so the event is dispatched at `document.body` instead (stricter engines disable
// the paste command outright and dispatch nothing). `document.body` is an ANCESTOR of
// React's root container, so an event targeted there never travels through the grid and a
// React `onPaste` on the wrapper cannot fire, ever.
//
// The corroboration is structural: every grid in this codebase where paste demonstrably
// works has a real `<input>` under the caret, so the browser always has a legitimate
// target and the container's `onPaste` catches it on the way up. The one grid whose cells
// are non-editable divs in nav mode is the one where paste was dead.
//
// So: a real, rendered, focusable, EDITABLE element lives inside the grid and holds the
// caret. `display:none`, `visibility:hidden`, `hidden` and `sr-only` all make an element
// **unfocusable**, and an unfocusable sink is no sink. `readOnly` is not an option either
// — a readOnly textarea is not a paste target in Chromium.
// ─────────────────────────────────────────────────────────────────────────────────

/** Marks the sink so `isGridChrome` can exempt it — see the note on that below. */
export const PASTE_SINK_ATTR = 'data-paste-sink';

export interface PasteSinkProps {
    onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
}

export const PasteSink = React.forwardRef<HTMLTextAreaElement, PasteSinkProps>(
    function PasteSink({ onPaste, onKeyDown }, ref) {
        return (
            <textarea
                ref={ref}
                {...{ [PASTE_SINK_ATTR]: '' }}
                aria-hidden
                tabIndex={-1}
                // Hidden by SIZE and OPACITY only — every other way of hiding an element
                // also makes it unfocusable, and then it cannot receive the paste.
                className="pointer-events-none absolute -z-10 size-px select-text opacity-0"
                // WebKit applies an ancestor's `select-none` to editable descendants too,
                // hence `select-text` above.
                onPaste={onPaste}
                onKeyDown={onKeyDown}
                // A keystroke the grid declines to handle must not accumulate in here.
                onChange={(e) => {
                    e.currentTarget.value = '';
                }}
            />
        );
    },
);

/**
 * Is this event aimed at a real form control the grid does NOT own?
 *
 * A keystroke or a paste aimed at the "add rows" counter, a filter box or the cell
 * editor's own input is that control's business, not a grid gesture.
 *
 * **The sink is exempt, and the exemption must come FIRST.** The sink is a `<textarea>`
 * by construction and it is the thing holding focus — so without this branch, the very
 * first line of the grid's keydown handler would bail on every keystroke and silently
 * kill Delete, Escape, Ctrl/Cmd+C, type-to-edit and the arrows.
 */
export function isGridChrome(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return false;
    if (el.hasAttribute?.(PASTE_SINK_ATTR)) return false;
    if (el.closest(`[${PASTE_SINK_ATTR}]`)) return false;
    if (el.closest('[data-grid-chrome]')) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Put keyboard focus where the grid hears BOTH families of gesture.
 *
 * The sink, not the wrapper: a keydown reaches the wrapper either way (it bubbles out of
 * the sink), but a `paste` only ever reaches an element that can accept one.
 *
 * **Always `preventScroll: true`.** `HTMLElement.focus()` is specified to scroll its
 * target into view with block AND inline `"center"`, in every scrolling box up to the
 * document — and `"center"` always computes a target, so it fires even when the element
 * is already fully visible. In a grid that means a purely lateral gesture re-centres the
 * row and drags the whole page with it. A `.focus()` here without the option is a bug.
 */
export function focusGrid(
    sink: HTMLTextAreaElement | null,
    fallback: HTMLElement | null,
): void {
    const target = sink ?? fallback;
    target?.focus({ preventScroll: true });
}
