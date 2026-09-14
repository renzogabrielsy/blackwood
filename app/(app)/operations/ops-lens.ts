// ═════════════════════════════════════════════════════════════════════════════════
// THE LENS REGISTRY — what the RIGHT pane of the split shows.
//
// THE UNIFICATION THESIS, as data. `/operations` and `/inventory/rc-movement` are
// not two screens; they are one row spine with two different column groups hung off
// it. So **BLOCKS FED is an entry in this list, not a route** — picking it turns the
// right pane into the RC Movement matrix over the identical days, and nothing else
// on the page moves.
//
// Three lenses rather than the drafts' six toggleable groups: Renzo's `Q3 2026` tab
// has exactly three column blocks to the right of the day spine (GRADES · LOSSES ·
// BLOCKS FED), and the drafts' `costs` / `production` groups are columns of the
// SPINE here, not of the lens — they are the things you always want beside the date,
// which is the whole reason the spine is a frozen pane.
//
// The lens is a single choice, in `?lens=`, because two lenses at once is a wide
// sheet with no frozen date — the shape draft C exists to refuse.
// ═════════════════════════════════════════════════════════════════════════════════

export type OpsLensId = 'grades' | 'losses' | 'blocks';

export interface OpsLensSpec {
  id: OpsLensId;
  /** The segmented-control label. */
  label: string;
  /** One line, on hover, saying what the lens puts in the right pane. */
  hint: string;
}

export const OPS_LENSES: readonly OpsLensSpec[] = [
  {
    id: 'grades',
    label: 'Grades',
    hint: 'One column per finished grade, kg produced that day. The grade set is DATA — it comes from the campaigns in view, never from a hardcoded list.',
  },
  {
    id: 'losses',
    label: 'Losses',
    hint: 'The eight recorded waste streams. They do NOT sum to the day’s drift — most of it leaves as moisture and volatiles, which nobody weighs.',
  },
  {
    id: 'blocks',
    label: 'Blocks fed',
    hint: 'ONE COLUMN PER BLOCK the campaign drew from, kg fed in the cells. This lens IS the RC Movement matrix — click a block header to open it.',
  },
];

const LENS_IDS = new Set<string>(OPS_LENSES.map((l) => l.id));

/** `?lens=` → a lens. Anything unrecognised (or absent) resolves to Grades. */
export function parseLens(raw: string | string[] | undefined): OpsLensId {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && LENS_IDS.has(v) ? (v as OpsLensId) : 'grades';
}

export function lensSpec(id: OpsLensId): OpsLensSpec {
  return OPS_LENSES.find((l) => l.id === id) ?? OPS_LENSES[0];
}

// ─── Quarter presets, DERIVED from the campaign list ─────────────────────────────

/**
 * The twelve production-batch names, in order, so a quarter can be derived.
 *
 * A campaign's `productionBatch` is the month word MC's report opens the batch with
 * (`JULY`), and the campaign clock is never the calendar month — JULY 2026 opens on
 * 2026-06-30. That does not make the NAME ambiguous, and the quarter presets are
 * built from the names of campaigns that actually exist, never from a hardcoded
 * `['JULY-2026', …]`: a quarter is offered only when all three of its campaigns are
 * in the option list, so a preset can never point at a campaign the database has
 * never heard of.
 */
const BATCH_MONTHS = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;

export interface OpsGroupPreset {
  id: string;
  /** `Q3 2026`. */
  label: string;
  keys: string[];
}

export function quarterPresets(
  options: readonly { key: string; productionBatch: string; campaignYear: number }[],
): OpsGroupPreset[] {
  const byYear = new Map<number, Map<string, string>>();
  for (const o of options) {
    const batch = o.productionBatch.toUpperCase();
    if (!BATCH_MONTHS.includes(batch as (typeof BATCH_MONTHS)[number])) continue;
    const bucket = byYear.get(o.campaignYear) ?? new Map<string, string>();
    bucket.set(batch, o.key);
    byYear.set(o.campaignYear, bucket);
  }

  const out: OpsGroupPreset[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    const bucket = byYear.get(year)!;
    for (let q = 4; q >= 1; q--) {
      const months = BATCH_MONTHS.slice((q - 1) * 3, q * 3);
      const keys = months.map((m) => bucket.get(m)).filter((k): k is string => Boolean(k));
      // All three, or it is not that quarter — a two-month "Q3" is a different
      // period wearing a quarter's name, which is worse than no preset at all.
      if (keys.length !== 3) continue;
      out.push({ id: `Q${q}-${year}`, label: `Q${q} ${year}`, keys });
    }
  }
  return out;
}
