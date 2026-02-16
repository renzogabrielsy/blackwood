'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

/**
 * Props for RemarksCellAdaptor component
 */
export interface RemarksCellAdaptorProps {
    /** Current remarks value */
    value: string;
    /** Callback when value changes */
    onChange: (value: string) => void;
    /** Callback when popover closes (on Enter or click outside) */
    onClose: () => void;
    /** Callback to revert changes (on Escape) */
    onRevert: () => void;
    /** Font size for the input (from table settings) */
    fontSize: number;
    /** Optional title for the popover (default: "Remarks") */
    title?: string;
    /** Optional description for the popover */
    description?: string;
    /** Optional placeholder text */
    placeholder?: string;
}

/**
 * RemarksCellAdaptor - A popover-based remarks editor for grid cells
 *
 * Features:
 * - Opens immediately on cell edit
 * - Enter to confirm and close
 * - Escape to revert and close
 * - Auto-focus on open
 * - Positioned below the cell
 *
 * Used in RC IN and RC OUT bulk input grids for remarks columns.
 */
export function RemarksCellAdaptor({
    value,
    onChange,
    onClose,
    onRevert,
    fontSize,
    title = 'Remarks',
    description,
    placeholder = 'Enter remarks...',
}: RemarksCellAdaptorProps) {
    const [open, setOpen] = React.useState(true);

    const onOpenChange = (isOpen: boolean) => {
        setOpen(isOpen);
        if (!isOpen) {
            onClose();
        }
    };

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <div className="w-full h-full" />
            </PopoverTrigger>
            <PopoverContent
                className="w-80 p-2"
                align="center"
                side="bottom"
                onEscapeKeyDown={(e) => e.preventDefault()}
            >
                <div className="space-y-2">
                    <h4 className="font-medium leading-none">{title}</h4>
                    {description && (
                        <p className="text-xs text-muted-foreground">{description}</p>
                    )}
                    <Input
                        autoFocus
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        className="h-8"
                        style={{ fontSize: `${fontSize}px` }}
                        placeholder={placeholder}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.stopPropagation();
                                setOpen(false);
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                onRevert();
                            }
                        }}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}
