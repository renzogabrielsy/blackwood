// ═════════════════════════════════════════════════════════════════════════════════
// THE LENS REGISTRY — which column block scrolls beside the frozen day spine.
//
// THE UNIFICATION THESIS, as data. `/operations` and `/inventory/rc-movement` are
// not two screens; they are one row spine with two different column groups hung off
// it. So **BLOCKS FED is an entry in this list, not a route** — picking it turns the
// scrolling half of the ledger into the RC Movement matrix over the identical days,
// and nothing else on the page moves.
//
// Renzo's `Q3 2026` tab has three column blocks to the right of the day spine
// (GRADES · LOSSES · BLOCKS FED), and the drafts' `costs` / `production` groups are
// columns of the SPINE here, not of the lens — they are the things you always want
// beside the date, which is the whole reason the spine is frozen.
//
// **PRODUCTION (2026-09-15) is a FOURTH lens and the DEFAULT: grades and the eight
// waste streams side by side, under two group headers.** Renzo reads those two
// blocks together — what came out, and what was swept up on the way — and making him
// flip a tab to compare them is making him hold one half in his head. It is not a
// new column set: it is the grades lens and the losses lens rendered adjacently,
// from the identical fields, so nothing can disagree between the three tabs.
//
// The lens is a single choice, in `?lens=`. `?lens=grades` and `?lens=losses` keep
// working exactly as before — the default simply moved, and the default is spelled
// as ABSENCE, so a plain `/operations` address stays clean.
// ═════════════════════════════════════════════════════════════════════════════════

import type { OpsTone } from './ops-color';

export type OpsLensId = 'production' | 'grades' | 'losses' | 'blocks';

export interface OpsLensSpec {
  id: OpsLensId;
  /** The segmented-control label. */
  label: string;
  /** One line, on hover, saying what the lens puts beside the day spine. */
  hint: string;
  /** The semantic hue the lens's columns are drawn in — see `ops-color.ts`. */
  tone: OpsTone;
}

export const OPS_LENSES: readonly OpsLensSpec[] = [
  {
    id: 'production',
    label: 'Production',
    tone: 'produced',
    hint: 'GRADES and the eight WASTE STREAMS side by side — what came out of the retort, and what was swept up on the way. The two blocks carry their own group headers; the figures are the same fields the Grades and Losses lenses show on their own.',
  },
  {
    id: 'grades',
    label: 'Grades',
    tone: 'produced',
    hint: 'One column per finished grade, kg produced that day. The grade set is DATA — it comes from the campaigns in view, never from a hardcoded list.',
  },
  {
    id: 'losses',
    label: 'Losses',
    tone: 'waste',
    hint: 'The eight recorded waste streams. They do NOT sum to the process loss — most of what the retort loses leaves as moisture and volatiles, which nobody weighs. The spine’s WASTE % is this total over the day’s PRODUCED kilos.',
  },
  {
    id: 'blocks',
    label: 'Blocks fed',
    tone: 'block',
    hint: 'ONE COLUMN PER BLOCK the campaign drew from, kg fed in the cells. This lens IS the RC Movement matrix — click a block header to open it.',
  },
];

const LENS_IDS = new Set<string>(OPS_LENSES.map((l) => l.id));

/** The lens a bare `/operations` opens on, and the one spelled as ABSENCE in `?lens=`. */
export const DEFAULT_LENS: OpsLensId = 'production';

/** `?lens=` → a lens. Anything unrecognised (or absent) resolves to {@link DEFAULT_LENS}. */
export function parseLens(raw: string | string[] | undefined): OpsLensId {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && LENS_IDS.has(v) ? (v as OpsLensId) : DEFAULT_LENS;
}

export function lensSpec(id: OpsLensId): OpsLensSpec {
  return OPS_LENSES.find((l) => l.id === id) ?? OPS_LENSES[0];
}

// ─── Quarter presets, DERIVED from the SPAN'S OWN QUARTER ────────────────────────

/**
 * ⚠ REWRITTEN 2026-09-16: A QUARTER IS DECIDED BY DATE, NEVER BY THE BATCH NAME.
 *
 * This used to map the twelve month WORDS to quarters and require all three
 * months of a quarter to be present. Both halves were wrong.
 *
 *  1. **A production_batch is a NAME A PERSON TYPED** — the L-039 / L-042 /
 *     L-048 lesson one level up. `TEST BATCH` is a legal batch name with no
 *     month in it, and a name-driven preset cannot place it anywhere at all.
 *     And the campaign clock is never the calendar month: JULY 2026 runs
 *     2026-06-30 → 2026-08-01, SEPTEMBER 2026 opens 2026-08-29.
 *  2. **An incomplete quarter is still a quarter** (Renzo, 2026-09-16). The
 *     old "all three or nothing" rule meant the CURRENT quarter never appeared
 *     until its third campaign opened — the one quarter an owner most wants.
 *
 * `quarterKey` / `quarterLabel` come from `view_ops_ledger_campaign_span`, which
 * places a campaign in the quarter containing the MIDPOINT of its span. **This
 * function does no date arithmetic** — it groups on a value the database already
 * decided, so the picker and the database can never disagree about which quarter
 * a campaign is in. Measured on all 32 campaigns today: every midpoint quarter
 * agrees with the quarter its month-name implies, so nothing visible changed on
 * current data.
 */
export interface OpsGroupPreset {
  id: string;
  /** `Q3 2026`. */
  label: string;
  /** The quarter's campaign keys, CHRONOLOGICAL by `firstDate`. */
  keys: string[];
  /** How many campaigns the quarter holds — a preset of 1 is legitimate. */
  campaignCount: number;
  /** The quarter's own span: the earliest `firstDate` and the latest `lastDate`. */
  firstDate: string;
  lastDate: string;
}

/** The shape `quarterPresets` reads — the four fields, and nothing else. */
export interface OpsQuarterOption {
  key: string;
  quarterKey: string;
  quarterLabel: string;
  firstDate: string;
  lastDate: string;
}

export function quarterPresets(options: readonly OpsQuarterOption[]): OpsGroupPreset[] {
  const byQuarter = new Map<string, { label: string; rows: OpsQuarterOption[] }>();
  for (const o of options) {
    if (!o.quarterKey) continue;
    const bucket = byQuarter.get(o.quarterKey) ?? { label: o.quarterLabel || o.quarterKey, rows: [] };
    bucket.rows.push(o);
    byQuarter.set(o.quarterKey, bucket);
  }

  // `quarterKey` is `YYYY-Qn`, so a plain string sort IS chronological order — and
  // `firstDate` / `lastDate` are `yyyy-MM-dd`, so the same is true of them. NO DATE
  // ARITHMETIC: every comparison here is a string comparison over values the
  // database decided.
  return [...byQuarter.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((qk) => {
      const b = byQuarter.get(qk)!;
      const rows = [...b.rows].sort((x, y) =>
        x.firstDate === y.firstDate ? x.key.localeCompare(y.key) : x.firstDate < y.firstDate ? -1 : 1,
      );
      return {
        id: qk,
        label: b.label,
        keys: rows.map((r) => r.key),
        campaignCount: rows.length,
        firstDate: rows[0]?.firstDate ?? '',
        lastDate: rows.reduce((acc, r) => (r.lastDate > acc ? r.lastDate : acc), ''),
      };
    });
}

/**
 * THE DEFAULT GROUP — every campaign of the LATEST quarter.
 *
 * Renzo, 2026-09-16: *"It is not showing the current Q3 2026 group because it
 * isn't complete yet. It should show it and default to it since it is the
 * latest."* The old default was the single newest campaign, which on the day a
 * quarter's third campaign opened made the screen read as one month.
 *
 * "Latest" is the quarter holding the newest `firstDate` — the first preset, since
 * `quarterPresets` is already newest-first and `quarterKey` sorts chronologically.
 * Returns `[]` when the options carry no quarter at all, so the caller keeps its
 * own fallback rather than this one inventing a group.
 */
export function latestQuarterKeys(options: readonly OpsQuarterOption[]): string[] {
  return quarterPresets(options)[0]?.keys ?? [];
}
