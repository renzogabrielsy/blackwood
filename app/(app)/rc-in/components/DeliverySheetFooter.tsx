'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const MONTHS = [
    'All Months', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function buildYearOptions(): number[] {
    const currentYear = new Date().getFullYear();
    const years: number[] = [];
    for (let y = currentYear + 1; y >= 2010; y--) {
        years.push(y);
    }
    return years;
}

export function DeliverySheetFooter({
    month,
    year,
    onMonthChange,
    onYearChange,
    disabled = false,
    monthsDisabled = false,
    statusText
}: {
    month: string;
    year: string;
    onMonthChange: (m: string) => void;
    onYearChange: (y: string) => void;
    disabled?: boolean;
    monthsDisabled?: boolean;
    statusText: React.ReactNode;
}) {
    const yearOptions = React.useMemo(() => buildYearOptions(), []);

    // Refs for year sliding indicator
    const yearContainerRef = React.useRef<HTMLDivElement>(null);
    const allYearsBtnRef = React.useRef<HTMLButtonElement>(null);
    const yearDropdownRef = React.useRef<HTMLButtonElement>(null);
    const [yearIndicator, setYearIndicator] = React.useState({ left: 0, width: 0 });

    // Refs for month sliding indicator
    const monthContainerRef = React.useRef<HTMLDivElement>(null);
    const monthRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
    const [monthIndicator, setMonthIndicator] = React.useState({ left: 0, width: 0 });

    // Track dropdown open state for immediate slide
    const [dropdownOpen, setDropdownOpen] = React.useState(false);
    // Guard against slide-back flash when selecting from dropdown
    const justSelectedRef = React.useRef(false);
    // Optimistic year for immediate indicator response (before URL/server updates)
    const [pendingYear, setPendingYear] = React.useState<string | null>(null);

    // Clear pending once the real year prop catches up
    React.useEffect(() => {
        if (pendingYear !== null && year === pendingYear) {
            setPendingYear(null);
        }
    }, [year, pendingYear]);

    // The "visual" year used only for the indicator
    const visualYear = pendingYear ?? year;

    const handleMonthClick = (index: number) => {
        if (disabled) return;
        if (index === 0) {
            onMonthChange('all');
        } else {
            onMonthChange(String(index - 1));
        }
    };

    const activeMonthIndex = month === 'all' ? 0 : parseInt(month, 10) + 1;

    // Measure year indicator position
    React.useEffect(() => {
        const container = yearContainerRef.current;
        const shouldSlideToDropdown = dropdownOpen || visualYear !== 'all' || justSelectedRef.current;
        justSelectedRef.current = false;
        const target = shouldSlideToDropdown ? yearDropdownRef.current : allYearsBtnRef.current;
        if (!container || !target) return;

        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        setYearIndicator({
            left: targetRect.left - containerRect.left,
            width: targetRect.width,
        });
    }, [visualYear, dropdownOpen]);

    // Measure month indicator position
    React.useEffect(() => {
        const container = monthContainerRef.current;
        const target = monthRefs.current[activeMonthIndex];
        if (!container || !target) return;

        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        setMonthIndicator({
            left: targetRect.left - containerRect.left,
            width: targetRect.width,
        });
    }, [activeMonthIndex]);

    return (
        <div className={cn(
            "flex-none flex items-center justify-between px-4 py-2 border-t bg-card/80 backdrop-blur-sm z-10 transition-all duration-200",
            disabled && "opacity-50 pointer-events-none grayscale"
        )}>
            {/* Left: Status */}
            <div className="text-sm font-medium text-muted-foreground shrink-0">
                {statusText}
            </div>

            {/* Right: Year selector + Month tabs */}
            <div className="flex items-center gap-3">
                {/* Year Controls */}
                <div
                    ref={yearContainerRef}
                    className="relative flex items-center bg-muted/40 rounded-lg border border-border/50 p-1 h-9"
                >
                    {/* Sliding indicator */}
                    <div
                        className="absolute rounded-md bg-zinc-800 dark:bg-zinc-200 shadow-sm transition-all duration-300 ease-in-out"
                        style={{
                            left: `${yearIndicator.left}px`,
                            width: `${yearIndicator.width}px`,
                            top: '4px',
                            bottom: '4px',
                        }}
                    />
                    <Button
                        ref={allYearsBtnRef}
                        variant="ghost"
                        size="sm"
                        onClick={() => { setPendingYear('all'); onYearChange('all'); }}
                        disabled={disabled}
                        className={cn(
                            "relative z-10 h-7 text-xs font-medium px-3 cursor-pointer hover:bg-transparent",
                            visualYear === 'all'
                                ? "text-background hover:text-background"
                                : "text-muted-foreground hover:text-muted-foreground"
                        )}
                    >
                        All Years
                    </Button>
                    <div className="w-px h-4 bg-border/50 mx-0.5" />
                    <Select
                        key={year === 'all' ? 'no-selection' : 'selection'}
                        value={year === 'all' ? undefined : year}
                        onValueChange={(v) => { justSelectedRef.current = true; setPendingYear(v); onYearChange(v); }}
                        onOpenChange={setDropdownOpen}
                        disabled={disabled}
                        open={dropdownOpen}
                    >
                        <SelectTrigger
                            ref={yearDropdownRef}
                            className={cn(
                                "relative z-10 h-7 min-w-[70px] text-xs font-medium border-0 focus:ring-0 shadow-none px-2 rounded-md bg-transparent",
                                visualYear !== 'all'
                                    ? "text-background"
                                    : "text-muted-foreground"
                            )}
                        >
                            <SelectValue placeholder="Year" />
                        </SelectTrigger>
                        <SelectContent position="popper" className="max-h-60">
                            {yearOptions.map((y) => (
                                <SelectItem key={y} value={String(y)} className="text-xs">
                                    {y}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Month Controls */}
                <div
                    ref={monthContainerRef}
                    className={cn(
                        "relative flex items-center gap-0.5 bg-muted/40 rounded-lg border border-border/50 p-1 h-9",
                        monthsDisabled && "opacity-50 pointer-events-none grayscale"
                    )}
                >
                    {/* Sliding indicator */}
                    <div
                        className="absolute rounded-md bg-zinc-800 dark:bg-zinc-200 shadow-sm transition-all duration-300 ease-in-out"
                        style={{
                            left: `${monthIndicator.left}px`,
                            width: `${monthIndicator.width}px`,
                            top: '4px',
                            bottom: '4px',
                        }}
                    />
                    {MONTHS.map((label, i) => (
                        <Button
                            key={label}
                            ref={(el) => { monthRefs.current[i] = el; }}
                            variant="ghost"
                            size="sm"
                            disabled={disabled || monthsDisabled}
                            onClick={() => handleMonthClick(i)}
                            className={cn(
                                'relative z-10 h-7 px-3 text-xs font-medium cursor-pointer transition-colors duration-200 hover:bg-transparent',
                                i === activeMonthIndex
                                    ? "text-background hover:text-background"
                                    : "text-muted-foreground hover:text-muted-foreground"
                            )}
                        >
                            {label}
                        </Button>
                    ))}
                </div>
            </div>
        </div>
    );
}
