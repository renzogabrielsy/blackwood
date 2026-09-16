'use client';

import * as React from 'react';
import { Check, Layers, Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { OpsCampaignOption, OpsCampaignRollup } from '@/lib/operations/types';
import { quarterPresets } from './ops-lens';
import { tons } from './ops-format';

// ═════════════════════════════════════════════════════════════════════════════════
// THE GROUP BUILDER — "pick what batches/months are in the group view."
//
// A chip rail showing what IS in the group (so the quarter is visible without
// opening anything) plus a popover holding the campaign list GROUPED UNDER ITS
// QUARTER HEADINGS, a search box and the quarter presets. The drafts put every
// campaign in the rail; the live option list is ~32 campaigns, which is a rail
// nobody reads, so the rail shows the SELECTION and the popover owns the pick.
//
// ── FOUR DECISIONS ─────────────────────────────────────────────────────────────
//
//  • **THE ORDER IS THE CAMPAIGN'S, NEVER THE CLICK ORDER.** Ticking AUGUST then
//    JULY writes `JULY-2026,AUGUST-2026`. A quarter whose months reshuffle when you
//    untick and retick one is not a quarter — and because the order is normalised
//    HERE, two people who built the same group by different routes share the same
//    URL. It sorts on `firstDate`, the LEDGER's own opening day, which every
//    campaign has; `maxDate` is the last FEED and is NULL on a campaign that has
//    produced but not yet been fed (SEPTEMBER 2026 on the day it opened).
//  • **THE PRESETS ARE DERIVED FROM A DATE, never from a batch NAME** (2026-09-16).
//    `quarterPresets()` groups the options on the `quarterKey` the database
//    computed from the MIDPOINT of each campaign's span, so a preset can never
//    point at a campaign the database has never heard of AND can never disagree
//    with it about which quarter a campaign belongs to. An INCOMPLETE quarter is
//    still a quarter — the current one appears the day its first campaign opens,
//    and `page.tsx` DEFAULTS to it through the same function.
//  • **A ROW STATES ITS SPAN, NOT ITS TONNAGE** (2026-09-16). The option list is
//    `view_ops_ledger_campaign_span`, a calendar spine that carries no tonnage at
//    all — `OpsCampaignOption.totalFedKg` reads 0 for every row — so printing it
//    would have been printing a zero. `firstDate → lastDate` is what the list is
//    for; the SELECTED chips get a real fed total from `rollups[].fedKg`, which is
//    the payload that was actually resolved.
//  • **THE LAST CAMPAIGN CANNOT BE UNTICKED.** An empty group has no ledger and no
//    rollup, and an absent `?campaigns=` means "the latest quarter" — so writing an
//    empty selection would silently re-resolve to something the reader did not pick.
//    The chip refuses instead, which is the honest and reversible direction.
// ═════════════════════════════════════════════════════════════════════════════════

export interface OpsGroupPickerProps {
  options: readonly OpsCampaignOption[];
  selected: readonly string[];
  /**
   * The rollups the payload actually resolved — read ONLY for `fedKg`, the tonnage
   * on a selected chip. A key with no rollup simply shows no tonnage.
   */
  rollups?: readonly OpsCampaignRollup[];
  onChange(next: string[]): void;
  disabled?: boolean;
  className?: string;
}

export function OpsGroupPicker({
  options,
  selected,
  rollups,
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

  /** campaignKey → the fed kilos the payload published for it. A LOOKUP, never a sum. */
  const fedByKey = React.useMemo(() => {
    const m = new Map<string, number | null>();
    for (const r of rollups ?? []) m.set(r.campaignKey, r.fedKg);
    return m;
  }, [rollups]);

  /** Chronological, always — see the class note. Unknown keys sort last, in place. */
  const order = React.useCallback(
    (keys: readonly string[]) =>
      [...keys].sort((a, b) => {
        const da = byKey.get(a)?.firstDate ?? '';
        const db = byKey.get(b)?.firstDate ?? '';
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

  /**
   * THE LIST, GROUPED UNDER ITS QUARTER HEADINGS.
   *
   * The sections and their order ARE the presets — same function, same field, same
   * newest-first order — so a heading can never name a quarter the preset above it
   * does not build. The filter narrows the rows inside a section and drops a section
   * that ends up empty; it never re-orders anything.
   */
  const sections = React.useMemo(() => {
    const q = query.trim().toUpperCase();
    const match = (o: OpsCampaignOption) =>
      !q || o.key.includes(q) || o.label.toUpperCase().includes(q);
    return presets
      .map((p) => ({
        id: p.id,
        label: p.label,
        span: `${p.firstDate || '—'} → ${p.lastDate || '—'}`,
        rows: p.keys.map((k) => byKey.get(k)).filter((o): o is OpsCampaignOption => !!o && match(o)),
      }))
      .filter((s) => s.rows.length > 0);
  }, [presets, byKey, query]);

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

        <PopoverContent align="start" className="w-[380px] bg-popover/95 p-0 backdrop-blur-lg">
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
                  title={`${p.firstDate} → ${p.lastDate} · ${p.keys.join(' · ')}`}
                  className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                >
                  {p.label}
                  <span className="ml-1 font-mono tabular-nums text-muted-foreground">
                    {p.campaignCount}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="max-h-[320px] overflow-y-auto py-1">
            {sections.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No campaign matches “{query}”.
              </p>
            ) : (
              sections.map((s) => (
                <section key={s.id}>
                  {/* OPAQUE — a sticky heading sits on top of the scrolling rows
                      beneath it (CLAUDE.md → "Frozen Panes"). */}
                  <h4 className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-border bg-muted px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>{s.label}</span>
                    <span className="font-mono text-[9px] font-normal normal-case tabular-nums">
                      {s.span}
                    </span>
                  </h4>
                  {s.rows.map((o) => {
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
                            on
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input',
                          )}
                        >
                          {on ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {o.label}
                        </span>
                        {/* THE SPAN, not a tonnage — the option list is a calendar
                            spine and carries none. */}
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {o.firstDate || '—'} → {o.lastDate || '—'}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))
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
          const fedKg = fedByKey.get(key);
          const fed = fedKg === null || fedKg === undefined ? '' : tons(fedKg);
          return (
            <span
              key={key}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-foreground/25 bg-foreground px-2 text-background"
              title={o ? `${o.firstDate} → ${o.lastDate}` : 'Not a known campaign'}
            >
              <span className="whitespace-nowrap text-[11px] font-medium">{o?.label ?? key}</span>
              {fed ? (
                <span className="whitespace-nowrap font-mono text-[9px] tabular-nums text-background/70">
                  {fed} t
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
