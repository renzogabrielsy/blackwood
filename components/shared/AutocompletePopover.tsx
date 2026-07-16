'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Command,
    CommandGroup,
    CommandItem,
    CommandList,
} from '@/components/ui/command';

/**
 * Autocomplete item structure with value and optional detail text
 */
export interface AutocompleteItem {
    value: string;
    detail?: string;
}

/**
 * Props for AutocompletePopover component
 */
export interface AutocompletePopoverProps {
    /** Current input value */
    value: string;
    /** Callback when value changes (typing) */
    onChange: (value: string) => void;
    /** Callback when an item is selected (Enter, Tab, or click) */
    onSelect: (value: string) => void;
    /** Array of autocomplete items to filter and display */
    items: AutocompleteItem[];
    /** Additional CSS classes for the input */
    className?: string;
    /** Placeholder text for the input */
    placeholder?: string;
    /** Inline styles for the input */
    style?: React.CSSProperties;
    /** Whether to autofocus the input on mount */
    autoFocus?: boolean;
    /** Callback to revert changes (typically on Escape) */
    onRevert?: () => void;
}

/**
 * AutocompletePopover - A keyboard-navigable autocomplete input with dropdown
 *
 * Features:
 * - Filters items by substring match (case-insensitive)
 * - Keyboard navigation with Arrow keys
 * - Selection with Enter/Tab
 * - Escape to close and revert
 * - Mouse hover highlights items
 * - Shows checkmark for current value
 * - Limits display to 5 items max
 *
 * Used in RC IN and RC OUT bulk input grids for supplier, batch code, etc.
 */
export function AutocompletePopover({
    value,
    onChange,
    onSelect,
    items,
    className,
    placeholder,
    style,
    autoFocus,
    onRevert,
}: AutocompletePopoverProps) {
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [selectedIndex, setSelectedIndex] = React.useState(0);

    // Filter items by value substring match, limit to 5
    const filtered = React.useMemo(
        () => items.filter(item => item.value.toLowerCase().includes(value.toLowerCase())).slice(0, 5),
        [items, value]
    );

    // Reset selected index when filtered list changes
    React.useEffect(() => {
        setSelectedIndex(0);
    }, [filtered]);

    // Auto-open popover when autofocus is set and items are available
    React.useEffect(() => {
        if (autoFocus && filtered.length > 0) {
            setOpen(true);
        }
    }, [autoFocus, filtered.length]);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (open) {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
                    return;
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIndex(prev => Math.max(prev - 1, 0));
                    return;
                case 'Enter':
                    e.preventDefault();
                    if (filtered.length > 0) {
                        onSelect(filtered[selectedIndex].value);
                        setOpen(false);
                        e.stopPropagation();
                    }
                    return;
                case 'Tab':
                    if (filtered.length > 0) {
                        onSelect(filtered[selectedIndex].value);
                        setOpen(false);
                    }
                    return;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    setOpen(false);
                    if (onRevert) onRevert();
                    return;
            }
        }
    }, [open, filtered, selectedIndex, onSelect, onRevert]);

    const handleSelect = React.useCallback((itemValue: string) => {
        onSelect(itemValue);
        setOpen(false);
    }, [onSelect]);

    return (
        <Popover open={open && filtered.length > 0} onOpenChange={setOpen} modal={false}>
            <PopoverTrigger asChild>
                <div className="w-full h-full relative">
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
                        onKeyDown={(e) => {
                            // Handle Escape when popover is closed
                            if (!open && e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                if (onRevert) onRevert();
                                return;
                            }
                            handleKeyDown(e);
                        }}
                        onFocus={() => {
                            if (filtered.length > 0) setOpen(true);
                        }}
                        className={className}
                        placeholder={placeholder}
                        style={style}
                        autoFocus={autoFocus}
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent
                className="w-[200px] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                side="bottom"
                align="start"
                sideOffset={4}
                onContextMenu={(e) => e.preventDefault()}
            >
                <Command shouldFilter={false}>
                    <CommandList>
                        <CommandGroup>
                            {filtered.map((item, idx) => (
                                <CommandItem
                                    key={item.value}
                                    value={item.value}
                                    onSelect={() => handleSelect(item.value)}
                                    className={cn(
                                        "text-xs font-mono cursor-pointer",
                                        idx === selectedIndex && "bg-accent text-accent-foreground"
                                    )}
                                    onMouseEnter={() => setSelectedIndex(idx)}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-3 w-3",
                                            value === item.value ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    {item.value}
                                    {item.detail && (
                                        <span className="ml-auto text-muted-foreground text-[10px]">{item.detail}</span>
                                    )}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
