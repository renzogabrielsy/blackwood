'use client';

import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { TONE, type OpsTone } from './ops-color';

// ═════════════════════════════════════════════════════════════════════════════════
// "SHOW ME THE MATH" — every EOQ cell opens this.
//
// Renzo, 2026-09-15: every figure in the rollup should be clickable and say how it
// was arrived at. So each cell is a button and this dialog answers four questions in
// a fixed order: **what is this**, **how is it defined** (in words and in symbols),
// **what went in** (each input with its own payload value), and **what came out**.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────────
// **NOTHING IS COMPUTED HERE.** `a ÷ b = c` is a SENTENCE: `a`, `b` AND `c` are each
// a separate published field, printed side by side so the reader can check the
// database's arithmetic — not a component performing it. There is no `/`, no `*` and
// no `-` on any value path in this file or in the builders that fill it. If a figure
// has no field it is not shown; if the database publishes NULL, the modal says WHY
// rather than filling the gap (CLAUDE.md → "Never calculate weighted averages … in
// TypeScript", plan §2.7 rule 1).
//
// The dialog carries the project's canonical glass: `DialogContent` already ships
// `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`.
// ═════════════════════════════════════════════════════════════════════════════════

export interface KpiInput {
  label: string;
  /** The payload value, already rendered. Blank string = the payload carries null. */
  value: string;
  /** Where the figure comes from, or what it is measured over. */
  note?: string;
}

export interface KpiDetail {
  /** `JULY 2026 · YIELD`. */
  title: string;
  /** The date span, or the group's membership. */
  subtitle: string;
  tone: OpsTone;
  /** The definition, in plain language. */
  words: string;
  /** The same definition as symbols — `Produced ÷ RC Fed`. */
  symbols: string;
  inputs: KpiInput[];
  result: { label: string; value: string };
  /** Coverage, caveats, and the reason a NULL is a NULL. */
  notes?: string[];
}

export interface OpsKpiModalProps {
  detail: KpiDetail | null;
  onClose(): void;
}

export function OpsKpiModal({ detail, onClose }: OpsKpiModalProps) {
  const tone = detail ? TONE[detail.tone] : TONE.day;

  return (
    <Dialog open={detail !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        {detail ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
                {detail.title}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px] tabular-nums">
                {detail.subtitle}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              {/* ── The definition ─────────────────────────────────────────── */}
              <section className={cn('rounded-md border border-border border-t-2 p-2.5', tone.edge)}>
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  How it is defined
                </h3>
                <p className="mt-1 text-xs leading-relaxed">{detail.words}</p>
                <p className={cn('mt-1.5 font-mono text-[11px] tabular-nums', tone.text)}>
                  {detail.symbols}
                </p>
              </section>

              {/* ── The inputs ─────────────────────────────────────────────── */}
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  The numbers that went in
                </h3>
                <table className="mt-1 w-full table-fixed text-xs">
                  <colgroup>
                    <col />
                    <col style={{ width: 132 }} />
                  </colgroup>
                  <tbody>
                    {detail.inputs.map((inp, i) => (
                      <tr key={`${inp.label}:${i}`} className="border-b border-border/60 last:border-b-0">
                        <td className="px-1 py-1 align-top">
                          <span className="block">{inp.label}</span>
                          {inp.note ? (
                            <span className="block text-[10px] leading-snug text-muted-foreground">
                              {inp.note}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-1 py-1 text-right align-top font-mono tabular-nums">
                          {inp.value || <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* ── The result ─────────────────────────────────────────────── */}
              <section
                className={cn(
                  'flex items-baseline justify-between gap-3 rounded-md px-2.5 py-2',
                  tone.head,
                )}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide">
                  {detail.result.label}
                </span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {detail.result.value || '—'}
                </span>
              </section>

              {detail.notes && detail.notes.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {detail.notes.map((n, i) => (
                    <li key={i} className="text-[11px] leading-snug text-muted-foreground">
                      {n}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
