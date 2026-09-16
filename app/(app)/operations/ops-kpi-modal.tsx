'use client';

import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UnitValue } from '@/components/shared/unit-value';
import { cn } from '@/lib/utils';
import { TONE, type OpsTone } from './ops-color';
import {
  OPS_MODAL_BODY,
  OPS_MODAL_CONTENT,
  OPS_MODAL_NARROW,
  OPS_MODAL_PADDING,
  opsModalWidth,
} from './ops-modal-size';

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
//
// ── THE DIALOG IS SIZED TO ITS CONTENT AND CLAMPED TO THE VIEWPORT (2026-09-16) ─
// Renzo: *"The modal is causing shrinkage and overflowing of the table UIs. The space
// can be MUCH better utilized considering how much space we have on my 1080p 24-inch
// monitor. It should also occupy the space that is available so it can be viewed on
// any device."* The old `sm:max-w-4xl` (896px) was narrower than the twelve-column
// ACTUAL FED PRICE table, so the table scrolled sideways inside a dialog with ~900px
// of empty monitor on either side. {@link KpiDetail.contentWidth} now carries the
// table's OWN Σ-of-widths — `blocksTableWidth()` / `productionTablesWidth()`, never a
// literal — and `ops-modal-size.ts` turns it into `min(96vw, that + padding)`.
//
// On the other axis the dialog is `max-h-[92vh]` and the layout is a flex COLUMN:
// header, formula, result bar and caveats are pinned, and the TABLE — the only part
// that can be arbitrarily long — is the flexible child that scrolls.
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

/** One tile of the result bar. `glyph` empty renders the number alone. */
export interface KpiResultTile {
  label: string;
  /** The unit, pinned LEFT by `UnitValue` — `%` · `₱/kg` · `t`. */
  glyph: string;
  /** The formatted number, WITHOUT its unit. Empty renders an em-dash. */
  value: string;
  tone: OpsTone;
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
  /**
   * The NATURAL WIDTH of {@link table}, in px — Σ of its own declared column
   * widths, handed over by the component that owns them. The dialog becomes
   * `min(96vw, contentWidth + padding, 1720px)`.
   *
   * **Never a literal.** A column that grows must widen the dialog with it; that
   * is exactly what a hand-kept number failed to do when `BLOCK PRICE ₱/kg`
   * started ellipsising.
   */
  contentWidth?: number;
  /**
   * THE RESULT BAR — ONE TILE PER FIGURE (2026-09-16).
   *
   * Renzo, on the PRODUCTION modal's combined `YIELD · LOSS · WASTE %` line: *"It
   * seems weird keeping them the same colour."* It was — three figures from three
   * different families printed as one string in one hue, which says they are one
   * number. They are three tiles now, each in its own family colour (emerald
   * YIELD · amber LOSS · rose WASTE), each with its label and its unit pinned
   * LEFT and its value large. A modal with ONE result keeps one tile, drawn the
   * same way, so the two shapes are one component and not two.
   *
   * OPTIONAL — a modal whose table already states every figure has no single "the
   * answer", and inventing one would mean picking which of them is the headline.
   */
  results?: KpiResultTile[];
  /**
   * A control that rides in the header, right of the title — today the PRINT
   * button (FED PRICE) or the per-campaign print MENU (the group's).
   *
   * It is a NODE, not a spec, for the same reason {@link table} is: this module
   * stays a shell, and `ops-print-sheet.tsx` can keep importing
   * {@link KpiResultTile} from here without a cycle back into it.
   */
  actions?: React.ReactNode;
  /** Coverage, caveats, and the reason a NULL is a NULL. */
  notes?: string[];
}

export interface OpsKpiModalProps {
  detail: KpiDetail | null;
  onClose(): void;
}

export function OpsKpiModal({ detail, onClose }: OpsKpiModalProps) {
  const tone = detail ? TONE[detail.tone] : TONE.day;
  // Sized to what it holds: the table's own Σ-of-widths plus the dialog's padding,
  // or the narrow default for an inputs LIST (a two-column list gains nothing from
  // a metre of width — "size to content, not to a fixed max" cuts both ways).
  const width = opsModalWidth(
    detail?.contentWidth ? detail.contentWidth + OPS_MODAL_PADDING : OPS_MODAL_NARROW,
  );

  return (
    <Dialog open={detail !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className={OPS_MODAL_CONTENT} style={width}>
        {detail ? (
          <>
            <div className="flex shrink-0 items-start gap-3 pr-8">
              <DialogHeader className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 text-sm">
                  <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
                  {detail.title}
                </DialogTitle>
                <DialogDescription className="font-mono text-[11px] tabular-nums">
                  {detail.subtitle}
                </DialogDescription>
              </DialogHeader>
              {/* `data-print-hide` so the control can never print itself — it is
                  inside the dialog, which becomes a print ANCESTOR of the stage. */}
              {detail.actions ? (
                <div data-print-hide className="flex shrink-0 items-center gap-2">
                  {detail.actions}
                </div>
              ) : null}
            </div>

            {/* ── The definition, in ONE line. PINNED. ───────────────────────── */}
            <p className={cn('shrink-0 font-mono text-[11px] tabular-nums', tone.text)}>
              {detail.symbols}
            </p>

            {/* ── What it is made of: a TABLE when there is one, else the list.
                   THE ONLY PART THAT SCROLLS. ───────────────────────────────── */}
            <div className={OPS_MODAL_BODY}>
              {detail.table ? (
                detail.table
              ) : (
                <section className="min-h-0 flex-auto overflow-auto">
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
                        <tr
                          key={`${inp.label}:${i}`}
                          className="border-b border-border/60 last:border-b-0"
                        >
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
            </div>

            {/* ── The result. PINNED. ONE TILE PER FIGURE. ──────────────────── */}
            {detail.results && detail.results.length > 0 ? (
              <section className="flex shrink-0 flex-wrap gap-2">
                {detail.results.map((t) => (
                  <div
                    key={t.label}
                    className={cn(
                      // OPAQUE `head` steps — the palette's solid values, so a tile
                      // reads the same on any ground and in either theme.
                      'min-w-[128px] flex-1 rounded-md px-2.5 py-2',
                      TONE[t.tone].head,
                    )}
                  >
                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wide">
                      {t.label}
                    </span>
                    {/* UNIT LEFT, DIGITS RIGHT — the platform component, so the
                        tiles cannot drift from the EOQ strip's own cells. An
                        ABSENT figure drops the glyph with the number. */}
                    <UnitValue
                      glyph={t.value ? t.glyph : ''}
                      className="leading-tight"
                      glyphClassName="text-[length:var(--bw-fs-11)] opacity-80"
                      valueClassName="font-mono text-base font-semibold tabular-nums"
                    >
                      {t.value || '—'}
                    </UnitValue>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.notes && detail.notes.length > 0 ? (
              // Pinned, but capped: a long caveat must never push the table's
              // scroller down to nothing on a short viewport.
              <ul className="flex max-h-[22vh] shrink-0 flex-col gap-1 overflow-auto">
                {detail.notes.map((n, i) => (
                  <li key={i} className="text-[11px] leading-snug text-muted-foreground">
                    {n}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
