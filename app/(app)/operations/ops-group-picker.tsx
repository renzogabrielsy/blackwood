'use client';

import * as React from 'react';
import { Check, Layers, Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { OpsCampaignOption } from '@/lib/operations/types';
import { quarterPresets } from './ops-lens';
import { tons } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE GROUP BUILDER — "pick what batches/months are in the group view."
//
// A chip rail showing what IS in the group (so the quarter is visible without
// opening anything) plus a popover holding the full campaign list, a search box and
// the quarter presets. The drafts put every campaign in the rail; the live option
// list is ~32 campaigns, which is a rail nobody reads, so the rail shows the
// SELECTION and the popover owns the pick.
//
// ── THREE DECISIONS ────────────────────────────────────────────────────────────
//
//  • **THE ORDER IS THE CAMPAIGN'S, NEVER THE CLICK ORDER.** Ticking AUGUST then
//    JULY writes `JULY-2026,AUGUST-2026`. A quarter whose months reshuffle when you
//    untick and retick one is not a quarter — and because the order is normalised
//    HERE, two people who built the same group by different routes share the same
//    URL.
//  • **THE PRESETS ARE DERIVED, never hardcoded.** `quarterPresets()` offers a
//    quarter only when all three of its campaigns exist in the option list, so a
//    preset can never point at a campaign the database has never heard of.
//  • **THE LAST CAMPAIGN CANNOT BE UNTICKED.** An empty group has no ledger and no
//    rollup, and an absent `?campaigns=` means "the newest campaign" — so writing an
//    empty selection would silently re-resolve to something the reader did not pick.
//    The chip refuses instead, which is the honest and reversible direction.
// ═════════════════════════════════════════════════════════════════════════════════

export interface OpsGroupPickerProps {
  options: readonly OpsCampaignOption[];
  selected: readonly string[];
  onChange(next: string[]): void;
  disabled?: boolean;
  className?: string;
}

export function OpsGroupPicker({
  options,
  selected,
  onChange,
  disabled,
  className,
}: OpsGroupPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const byKey = React.useMemo(() => {
    const m = new Map<string, OpsCampaignOption>();
    for (const o of options) m.set(o.key, o);
    return m;
  }, [options]);

  /** Chronological, always — see the class note. Unknown keys sort last, in place. */
  const order = React.useCallback(
    (keys: readonly string[]) =>
      [...keys].sort((a, b) => {
        const da = byKey.get(a)?.maxDate ?? '';
        const db = byKey.get(b)?.maxDate ?? '';
        if (da === db) return a.localeCompare(b);
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? -1 : 1;
      }),
    [byKey],
  );

  const toggle = React.useCallback(
    (key: string) => {
      if (selected.includes(key)) {
        if (selected.length === 1) return; // never write an empty group
        onChange(order(selected.filter((k) => k !== key)));
      } else {
        onChange(order([...selected, key]));
      }
    },
    [selected, onChange, order],
  );

  const presets = React.useMemo(() => quarterPresets(options), [options]);
  const filtered = React.useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options;
    return options.filter((o) => o.key.includes(q) || o.label.toUpperCase().includes(q));
  }, [options, query]);

  const selectedOrdered = order(selected);

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5', className)}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Group
      </span>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Layers className="size-3.5" />
            <span>Campaigns</span>
            <span className="font-mono tabular-nums text-muted-foreground">{selected.length}</span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-[360px] bg-popover/95 p-0 backdrop-blur-lg">
          <div className="border-b border-border px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter campaigns…"
                aria-label="Filter campaigns"
                className="h-7 pl-7 text-xs"
              />
            </div>
          </div>

          {presets.length > 0 ? (
            <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
              <span className="mr-1 self-center text-[11px] text-muted-foreground">Quarters</span>
              {presets.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onChange(order(p.keys))}
                  title={p.keys.join(' · ')}
                  className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="max-h-[300px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No campaign matches “{query}”.
              </p>
            ) : (
              filtered.map((o) => {
                const on = selected.includes(o.key);
                const last = on && selected.length === 1;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={last}
                    onClick={() => toggle(o.key)}
                    title={last ? 'A group needs at least one campaign.' : o.key}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150',
                      on ? 'bg-muted/70' : 'hover:bg-muted/40',
                      last && 'cursor-not-allowed',
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
                      <span className="block truncate text-xs font-medium">{o.label}</span>
                      <span className="block truncate font-mono text-[10px] tabular-nums text-muted-foreground">
                        {o.minDate ?? '—'} → {o.maxDate ?? '—'} · {o.feedDays} feed days
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                      {tons(o.totalFedKg)} t
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {selected.length} of {options.length} picked
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
            >
              Done
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* The selection, in the open. `shrink-0` chips inside an `overflow-x-auto`
          track — "never crush, always scroll" applied to a control rail. */}
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5">
        {selectedOrdered.map((key) => {
          const o = byKey.get(key);
          const last = selected.length === 1;
          return (
            <span
              key={key}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-foreground/25 bg-foreground px-2 text-background"
              title={o ? `${o.minDate ?? '—'} → ${o.maxDate ?? '—'}` : 'Not a known campaign'}
            >
              <span className="whitespace-nowrap text-[11px] font-medium">{o?.label ?? key}</span>
              {o ? (
                <span className="whitespace-nowrap font-mono text-[9px] tabular-nums text-background/70">
                  {tons(o.totalFedKg)} t
                </span>
              ) : null}
              <button
                type="button"
                disabled={disabled || last}
                onClick={() => toggle(key)}
                aria-label={`Remove ${o?.label ?? key} from the group`}
                title={last ? 'A group needs at least one campaign.' : `Remove ${o?.label ?? key}`}
                className="rounded transition-opacity duration-150 hover:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-30"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
