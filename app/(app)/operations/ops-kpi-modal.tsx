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
// was arrived at. So each cell is a button and this dialog answers three questions in
// a fixed order: **what is this** (title + the one-line formula), **what went in**,
// and **what came out**.
//
// ── THE PROSE BLOCK IS GONE (2026-09-15, round 3) ──────────────────────────────
// Every modal used to open with a HOW IT IS DEFINED paragraph. Renzo, reading them:
// *"It should take out the how it is defined entirely."* The formula line survives —
// it is the definition, in the space of one line — and everything the paragraph was
// carrying that is actually load-bearing (why a figure is NULL, what the coverage is)
// is a `note` under the result, where it belongs.
//
// ── AND TWO MODALS SHOW A TABLE INSTEAD OF A LIST ──────────────────────────────
// FED PRICE and ACTUAL FED PRICE (and the two RESIKO columns, which read the same
// rows) render {@link KpiDetail.table} — the campaign's BLOCKS USED table — in place
// of the inputs list, because *"the user can distinguish and get a quick look and a
// breakdown of why the price is the way it is and what the actual price is and why."*
// A twelve-column table needs the room, so those details set {@link KpiDetail.wide}.
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
  /** The definition, as symbols — `Produced ÷ RC Fed`. ONE line, never a paragraph. */
  symbols: string;
  /** The inputs list. Ignored when {@link table} is set. */
  inputs: KpiInput[];
  /**
   * A TABLE of the rows the figure was made of, rendered INSTEAD of {@link inputs}.
   * Built by the caller (`OpsBlocksTable`), so this module stays a shell.
   */
  table?: React.ReactNode;
  /** Widen the dialog to `sm:max-w-4xl` — a twelve-column table needs it. */
  wide?: boolean;
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
      <DialogContent className={detail?.wide ? 'sm:max-w-4xl' : 'sm:max-w-xl'}>
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
              {/* ── The definition, in ONE line ────────────────────────────── */}
              <p className={cn('font-mono text-[11px] tabular-nums', tone.text)}>{detail.symbols}</p>

              {/* ── What it is made of: a TABLE when there is one, else the list ── */}
              {detail.table ? (
                detail.table
              ) : (
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
              )}

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
