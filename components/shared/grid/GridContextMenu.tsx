'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { GridContextMenuState } from '@/lib/hooks/use-grid-context-menu';

// ─────────────────────────────────────────────────────────────────────────────
// GridContextMenu — declarative right-click menu consuming useGridContextMenu's
// state. NO shadcn / Radix (avoids focus-steal inside grids; matches the existing
// hand-rolled menus). Styling lifted VERBATIM from delivery-master-table.tsx +
// production-ledger-grid.tsx menus.
//
// Items are described declaratively via GridMenuItem<T>. `label` may be a function
// so a single item can flip between Delete↔Restore based on the row ref. `hidden`
// items are skipped entirely; `disabled` items render dimmed + non-interactive.
// ─────────────────────────────────────────────────────────────────────────────

export type GridMenuItem<T> =
    | {
          kind: 'item';
          label: string | ((ref: T) => string);
          icon?: React.ComponentType<{ className?: string }>;
          onSelect: (ref: T) => void;
          variant?: 'default' | 'destructive';
          disabled?: (ref: T) => boolean;
          hidden?: (ref: T) => boolean;
          /**
           * Right-aligned indicator icon (e.g. a Check for an active toggle). When
           * it resolves to a component the row switches to `justify-between` so the
           * indicator pins right — matching the column-format toggles in the RC IN
           * master table. Return null/undefined to show nothing.
           */
          trailingIcon?: (ref: T) => React.ComponentType<{ className?: string }> | null | undefined;
          /**
           * Keep the menu OPEN after onSelect (default closes). Used by toggle items
           * (bold/italic/underline) so the operator can flip several without the menu
           * dismissing between clicks.
           */
          keepOpen?: boolean;
      }
    | { kind: 'separator' };

export interface GridContextMenuProps<T> {
    state: GridContextMenuState<T> | null;
    items: GridMenuItem<T>[];
    onClose: () => void;
}

export function GridContextMenu<T>({ state, items, onClose }: GridContextMenuProps<T>) {
    if (!state) return null;
    const { ref } = state;

    return (
        <div
            data-ctx-menu
            className="fixed z-[9999] min-w-[188px] rounded-md border bg-popover/95 py-1 shadow-lg backdrop-blur-lg animate-fade-in"
            style={{ left: state.x, top: state.y }}
        >
            {items.map((item, i) => {
                if (item.kind === 'separator') {
                    return <div key={`sep-${i}`} className="my-1 border-t border-border/50" />;
                }

                if (item.hidden?.(ref)) return null;

                const Icon = item.icon;
                const label = typeof item.label === 'function' ? item.label(ref) : item.label;
                const isDisabled = item.disabled?.(ref) ?? false;
                const isDestructive = item.variant === 'destructive';
                const TrailingIcon = item.trailingIcon?.(ref) ?? null;

                return (
                    <button
                        key={`item-${i}`}
                        type="button"
                        disabled={isDisabled}
                        className={cn(
                            'flex w-full items-center px-2.5 py-1.5 text-xs transition-colors duration-150',
                            TrailingIcon ? 'justify-between' : 'gap-2',
                            isDisabled
                                ? 'cursor-not-allowed opacity-40'
                                : isDestructive
                                  ? 'cursor-pointer text-destructive hover:bg-destructive/10'
                                  : 'cursor-pointer hover:bg-accent',
                        )}
                        onClick={() => {
                            if (isDisabled) return;
                            item.onSelect(ref);
                            if (!item.keepOpen) onClose();
                        }}
                    >
                        <span className="flex items-center gap-2">
                            {Icon && (
                                <Icon
                                    className={cn(
                                        'size-3.5',
                                        isDestructive ? undefined : 'text-muted-foreground',
                                    )}
                                />
                            )}
                            <span>{label}</span>
                        </span>
                        {TrailingIcon && <TrailingIcon className="size-3.5 text-primary" />}
                    </button>
                );
            })}
        </div>
    );
}
