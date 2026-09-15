// ═════════════════════════════════════════════════════════════════════════════════
// THE COLOUR SYSTEM — one meaning per hue, for the whole `/operations` screen.
//
// Renzo, 2026-09-15: *"the page is too bland — give it a pop of colour."* The answer
// is NOT a rainbow of cells. It is a SEMANTIC palette applied to the three surfaces a
// reader uses to orient: the COLUMN-GROUP header bands, the KPI values in the EOQ
// strip, and a light tint on the scrolling lens columns. Numbers stay `font-mono`,
// right-aligned and on the foreground token — colour says *what kind of number this
// is*, never *how big it is*.
//
//   sky     → FED / INPUT      — raw charcoal going into the plant
//   emerald → PRODUCED / YIELD — finished product coming out
//   amber   → DRIFT / LOSS     — the gap between the two
//   rose    → WASTE            — the eight streams that were swept up and weighed
//   violet  → MONEY (₱)        — every peso column, and only those
//   zinc    → the day spine's own chrome (date, weekday, shift counts)
//
// ── TWO RULES THIS FILE EXISTS TO ENFORCE ──────────────────────────────────────
//
//  1. **`head` IS OPAQUE, `cell` IS NOT.** A tinted header or footer cell is a FROZEN
//     surface — it sits on top of scrolling content — and CLAUDE.md → "Frozen Panes"
//     is unambiguous: any alpha there lets the moving rows bleed through. So every
//     `head` value is a solid palette step in BOTH themes, and the translucent `cell`
//     tint is only ever put on a NON-frozen body cell.
//  2. **Every hue is declared in both themes.** A `dark:` variant on each half, so a
//     tint can never define itself only inside one theme (CLAUDE.md → theme-aware).
// ═════════════════════════════════════════════════════════════════════════════════

export type OpsTone =
  | 'day'
  | 'fed'
  | 'produced'
  | 'yield'
  | 'drift'
  | 'waste'
  | 'money'
  | 'shift'
  | 'block';

export interface OpsToneStyle {
  /** OPAQUE background — the only value safe on a frozen header/footer cell. */
  head: string;
  /** The 2px coloured top border that names a column group. */
  edge: string;
  /** TRANSLUCENT column tint — NON-frozen body cells only. */
  cell: string;
  /** The numeric accent, for a KPI value or a lens cell. */
  text: string;
  /** A solid dot/bar, for a legend or a tab. */
  dot: string;
}

export const TONE: Record<OpsTone, OpsToneStyle> = {
  day: {
    head: 'bg-muted text-muted-foreground',
    edge: 'border-t-zinc-300 dark:border-t-zinc-600',
    cell: '',
    text: 'text-foreground',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
  },
  shift: {
    head: 'bg-muted text-muted-foreground',
    edge: 'border-t-zinc-300 dark:border-t-zinc-600',
    cell: '',
    text: 'text-foreground',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
  },
  fed: {
    head: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
    edge: 'border-t-sky-400 dark:border-t-sky-500',
    cell: 'bg-sky-50/40 dark:bg-sky-950/15',
    text: 'text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500',
  },
  block: {
    head: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
    edge: 'border-t-sky-400 dark:border-t-sky-500',
    cell: 'bg-sky-50/40 dark:bg-sky-950/15',
    text: 'text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500',
  },
  produced: {
    head: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    edge: 'border-t-emerald-400 dark:border-t-emerald-500',
    cell: 'bg-emerald-50/40 dark:bg-emerald-950/15',
    text: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  yield: {
    head: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    edge: 'border-t-emerald-400 dark:border-t-emerald-500',
    cell: 'bg-emerald-50/40 dark:bg-emerald-950/15',
    text: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  drift: {
    head: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    edge: 'border-t-amber-400 dark:border-t-amber-500',
    cell: 'bg-amber-50/40 dark:bg-amber-950/15',
    text: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  waste: {
    head: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
    edge: 'border-t-rose-400 dark:border-t-rose-500',
    cell: 'bg-rose-50/40 dark:bg-rose-950/15',
    text: 'text-rose-700 dark:text-rose-300',
    dot: 'bg-rose-500',
  },
  money: {
    head: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
    edge: 'border-t-violet-400 dark:border-t-violet-500',
    cell: 'bg-violet-50/40 dark:bg-violet-950/15',
    text: 'text-violet-700 dark:text-violet-300',
    dot: 'bg-violet-500',
  },
};

/**
 * The per-campaign accent, cycled by the campaign's position in the group.
 *
 * It identifies a BAND, nothing more — it carries no meaning about the campaign's
 * numbers, which is why it is deliberately drawn from hues the semantic palette
 * above does NOT use for a column group (indigo / teal / fuchsia / orange). A
 * quarter has three campaigns; the list has four so a four-campaign group still
 * reads as four distinct bands.
 */
export const CAMPAIGN_ACCENTS: readonly { bar: string; text: string }[] = [
  { bar: 'bg-indigo-500', text: 'text-indigo-700 dark:text-indigo-300' },
  { bar: 'bg-teal-500', text: 'text-teal-700 dark:text-teal-300' },
  { bar: 'bg-fuchsia-500', text: 'text-fuchsia-700 dark:text-fuchsia-300' },
  { bar: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-300' },
];

export function campaignAccent(index: number) {
  return CAMPAIGN_ACCENTS[index % CAMPAIGN_ACCENTS.length];
}
