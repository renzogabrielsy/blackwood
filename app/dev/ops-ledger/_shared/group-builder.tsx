'use client';

import * as React from 'react';
import { Check, Layers, X } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { OPS_LEDGER_DATA, rollupOf } from '../_mock/data';
import { GROUP_PRESETS } from './aggregate';
import { tons } from './format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE GROUP BUILDER — requirement (3)'s first half: "I'd pick what batches/months to
// include in the group view."
//
// A popover of campaign rows you tick, plus named presets, plus a name you can type. It is
// shared because all three drafts need the identical gesture and only differ in where the
// trigger sits — A puts it in the toolbar, B in the group header, C as a chip bar (which
// mounts this popover as the "more" door rather than reimplementing the pick).
//
// THREE DECISIONS WORTH READING:
//
//   • THE ORDER IS THE CAMPAIGN'S, NEVER THE CLICK ORDER. Ticking AUGUST then JULY builds
//     "JULY + AUGUST". A quarter whose months reshuffle when you untick and retick one is
//     not a quarter, and the sorting happens in `groupRollup` so no caller can forget it.
//   • EVERY ROW CARRIES ITS OWN TONNAGE. Picking months by name alone is picking blind;
//     the fed and produced figures are what tell you a month is the one you meant.
//   • AN EMPTY GROUP IS ALLOWED AND SAYS SO. Refusing the last untick would be a modal
//     argument with the operator; an empty selection renders an empty state that names the
//     fix, which is the reversible direction.
// ═════════════════════════════════════════════════════════════════════════════════

export interface GroupBuilderProps {
    selected: readonly string[];
    onChange(next: string[]): void;
    name: string;
    onNameChange(next: string): void;
    /** Rendered as the trigger. Omit for the default button. */
    trigger?: React.ReactNode;
    align?: 'start' | 'center' | 'end';
}

export function GroupBuilder({
    selected,
    onChange,
    name,
    onNameChange,
    trigger,
    align = 'start',
}: GroupBuilderProps) {
    const [open, setOpen] = React.useState(false);

    const toggle = (id: string) => {
        onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    };

    const applyPreset = (presetId: string) => {
        const preset = GROUP_PRESETS.find((p) => p.id === presetId);
        if (!preset) return;
        onChange([...preset.campaignIds]);
        onNameChange(preset.label);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {trigger ?? (
                    <button
                        type="button"
                        className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Layers className="size-3.5" />
                        <span>{name}</span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                            {selected.length}
                        </span>
                    </button>
                )}
            </PopoverTrigger>

            <PopoverContent
                align={align}
                className="w-[360px] bg-popover/95 p-0 backdrop-blur-lg"
            >
                <div className="border-b border-border px-3 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Group name
                    </div>
                    <Input
                        value={name}
                        onChange={(e) => onNameChange(e.target.value)}
                        placeholder="Q3 2026"
                        className="mt-1 h-7 text-xs"
                        aria-label="Group name"
                    />
                </div>

                <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
                    <span className="mr-1 self-center text-[11px] text-muted-foreground">Presets</span>
                    {GROUP_PRESETS.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            onClick={() => applyPreset(p.id)}
                            className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <div className="max-h-[300px] overflow-y-auto py-1">
                    {OPS_LEDGER_DATA.campaigns.map((c) => {
                        const on = selected.includes(c.id);
                        const r = rollupOf(c.id);
                        return (
                            <button
                                key={c.id}
                                type="button"
                                role="checkbox"
                                aria-checked={on}
                                onClick={() => toggle(c.id)}
                                className={cn(
                                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150',
                                    on ? 'bg-muted/70' : 'hover:bg-muted/40',
                                )}
                            >
                                <span
                                    className={cn(
                                        'flex size-4 shrink-0 items-center justify-center rounded border',
                                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                                    )}
                                >
                                    {on ? <Check className="size-3" /> : null}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium">{c.label}</span>
                                    <span className="block truncate font-mono text-[10px] tabular-nums text-muted-foreground">
                                        {c.startDate} → {c.endDate}
                                    </span>
                                </span>
                                <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                                    <span className="block">{tons(r.rcFedKg)} t fed</span>
                                    <span className="block">{tons(r.producedKg)} t prod</span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="flex items-center justify-between border-t border-border px-3 py-2">
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {selected.length} of {OPS_LEDGER_DATA.campaigns.length} picked
                    </span>
                    <button
                        type="button"
                        onClick={() => onChange([])}
                        className="flex h-6 items-center gap-1 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                    >
                        <X className="size-3" />
                        Clear
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
