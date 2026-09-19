// ─────────────────────────────────────────────────────────────────────────────
// THE AGE LENS'S SETTINGS — pure, and deliberately dull.
//
// Everything here is arithmetic over the operator's own CHOICES: where the cut lines
// sit in DAYS, what a band is called, and whether the ratio is measured in kilograms
// or in blocks. **No kilogram, no share and no weighted age is computed here.**
// Those come out of SQL through `fetchBlockingAgeLens` and are rendered verbatim —
// the project rule ("never calculate weighted averages or inventory balances in
// TypeScript") applies with full force, and `scripts/verify-blocking-lens-ui.ts`
// asserts that no lens file sums a kilogram or derives a share.
//
// ── `normalizeEdgeDays` IS THE PURE TWIN OF THE ACTION'S OWN ────────────────
// `actions.ts` carries `'use server'`, so every export there must be an async server
// function and its synchronous normaliser cannot leave the file. This is the copy the
// UI uses, and the two agree on the SHAPE they produce — finite whole numbers of
// days in 1…5000, de-duplicated, ascending, capped at 6 AFTER de-duplication — while
// differing on how they treat rubbish, which is the correct asymmetry:
//
//   • here the input is a STORED PREFERENCE → salvage what is good, drop the junk;
//   • there the input is a LIVE REQUEST → refuse it, and say why.
//
// De-duplicating BEFORE the cap is what keeps the two caps identical:
// `[60,60,120,120,365,365,730]` is seven raw cut lines but four real ones.
//
// ── NO PRICE GATE, AND THAT IS THE POINT ────────────────────────────────────
// Nothing in this lens is money and none of it is derivable into money, so the Age
// lens is offered to EVERY role including Production — the one that actually walks
// the yard. See `types.ts` → "Age lens" and `scripts/verify-blocking-age-lens.ts`,
// which asserts the ABSENCE of a `canViewPrices` call in the action.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLOCKING_AGE_EDGE_MAX_DAYS,
  BLOCKING_AGE_EDGE_MIN_DAYS,
  BLOCKING_AGE_LENS_DEFAULT_EDGES,
  BLOCKING_AGE_LENS_MAX_EDGES,
  type BlockingAgeBand,
} from '../types';
import { rampClass, type LensRampId } from './lens-ramp';
import type { LensUnit } from './lens-shared';

/** The lens's stable id — its `?lens=` value and its settings key. */
export const AGE_LENS_ID = 'age';

/** Age is NOT cost, so it does not paint on the cost ramp. See `lens-ramp.ts`. */
export const AGE_LENS_RAMP: LensRampId = 'age';

/**
 * Cut lines people actually ask for, offered as one-click chips.
 *
 * A month, two months, a quarter, four months, half a year, a year, two years — the
 * shapes an operator says out loud. They are a CONVENIENCE over the same add box,
 * not a second mechanism: each one goes through `addEdgeDay` and is refused by the
 * same rules.
 */
export const AGE_LENS_QUICK_CUTS: readonly number[] = [30, 60, 90, 120, 180, 365, 730];

export interface AgeLensSettings {
  /** Whole-day cut lines, de-duplicated and ascending. */
  edgeDays: number[];
  /** `bandDayKey()` → the name the reader gave that band. */
  bandNames: Record<string, string>;
  unit: LensUnit;
}

export const DEFAULT_AGE_LENS_SETTINGS: AgeLensSettings = {
  edgeDays: [...BLOCKING_AGE_LENS_DEFAULT_EDGES],
  bandNames: {},
  unit: 'kg',
};

// ── Edges ───────────────────────────────────────────────────────────────────

/** Drop anything that is not a whole day inside 1…5000, then de-dupe and sort. */
export function normalizeEdgeDays(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const clean: number[] = [];
  for (const raw of input) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) continue;
    if (raw < BLOCKING_AGE_EDGE_MIN_DAYS || raw > BLOCKING_AGE_EDGE_MAX_DAYS) continue;
    clean.push(raw);
  }
  return Array.from(new Set(clean)).sort((a, b) => a - b);
}

/** Why a cut line could not be added or removed — a sentence, never a throw. */
export type AgeEdgeChangeResult =
  | { ok: true; edgeDays: number[] }
  | { ok: false; message: string };

export function addEdgeDay(current: readonly number[], days: number): AgeEdgeChangeResult {
  if (!Number.isFinite(days) || !Number.isInteger(days)) {
    return { ok: false, message: 'A cut line has to be a whole number of days.' };
  }
  if (days < BLOCKING_AGE_EDGE_MIN_DAYS) {
    // Day 0 is where the first band already starts, so a cut there draws nothing.
    return {
      ok: false,
      message: `A cut line is at least ${BLOCKING_AGE_EDGE_MIN_DAYS} day — the first band already starts at day 0.`,
    };
  }
  if (days > BLOCKING_AGE_EDGE_MAX_DAYS) {
    return {
      ok: false,
      message: `Keep a cut line within ${BLOCKING_AGE_EDGE_MAX_DAYS.toLocaleString()} days — further out than that and no block in the yard can be on the other side of it.`,
    };
  }
  if (current.includes(days)) {
    return { ok: false, message: 'That cut line is already on the scale.' };
  }
  if (current.length >= BLOCKING_AGE_LENS_MAX_EDGES) {
    return {
      ok: false,
      message: `A lens takes at most ${BLOCKING_AGE_LENS_MAX_EDGES} cut lines (${BLOCKING_AGE_LENS_MAX_EDGES + 1} bands). Remove one first.`,
    };
  }
  return { ok: true, edgeDays: normalizeEdgeDays([...current, days]) };
}

export function removeEdgeDay(current: readonly number[], days: number): AgeEdgeChangeResult {
  const next = current.filter((e) => e !== days);
  if (next.length === current.length) {
    return { ok: false, message: 'That cut line is not on the scale.' };
  }
  // At least one edge must survive: with none there is one band holding the whole
  // yard, which is the same picture as no lens at all.
  if (next.length === 0) {
    return {
      ok: false,
      message:
        'A lens needs at least one cut line — with none, every block is in the same band and nothing is highlighted.',
    };
  }
  return { ok: true, edgeDays: normalizeEdgeDays(next) };
}

/** Parse the typed cut line. A positive whole number of days, or a reason why not. */
export function parseEdgeDayInput(
  text: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Type a number of days.' };
  if (!/^\d{1,4}$/.test(trimmed)) {
    return {
      ok: false,
      message: `A cut line is a whole number of days between ${BLOCKING_AGE_EDGE_MIN_DAYS} and ${BLOCKING_AGE_EDGE_MAX_DAYS.toLocaleString()}.`,
    };
  }
  return { ok: true, value: Number(trimmed) };
}

// ── Band identity, labels and colours ───────────────────────────────────────

/**
 * A band's identity for naming purposes: its own INTERVAL in days, not its index.
 *
 * Keying on the index would silently re-point every name the moment a cut line was
 * added below — the operator's "Feed these first" label would jump to a different
 * slice of the yard. `*` stands for the OPEN upper end. The lower bound is never
 * open (age has a floor at 0, where money did not), so it is always a number.
 */
export function bandDayKey(lowerDays: number, upperDays: number | null): string {
  return `${lowerDays}:${upperDays ?? '*'}`;
}

/**
 * `365 → '1 year'`, `730 → '2 years'`, `1095 → '3 years'`, anything else `null`.
 *
 * Only EXACT multiples read as years. "Over 400 days" is not "over 1 year" and
 * rounding it to one would quietly move the cut line the reader chose.
 */
export function yearWord(days: number): string | null {
  if (days <= 0 || days % 365 !== 0) return null;
  const years = days / 365;
  if (years > 3) return null;
  return `${years} year${years === 1 ? '' : 's'}`;
}

function dayWord(days: number): string {
  return `${days.toLocaleString()} day${days === 1 ? '' : 's'}`;
}

/**
 * What a band is called.
 *
 * A name the reader typed always wins. Otherwise the interval describes itself, and
 * a bound that is an exact number of YEARS says so — `Over 1 year` reads at a glance
 * where `Over 365 days` has to be divided in the head. Everything else stays in
 * days, because that is the unit the cut line was set in.
 */
export function ageBandLabel(
  band: Pick<BlockingAgeBand, 'lowerDays' | 'upperDays'>,
  names: Record<string, string> = {},
): string {
  const { lowerDays, upperDays } = band;
  const custom = names[bandDayKey(lowerDays, upperDays)];
  if (custom && custom.trim() !== '') return custom.trim();

  // Open above — the oldest band.
  if (upperDays === null) {
    if (lowerDays <= 0) return 'Every dated block';
    return `Over ${yearWord(lowerDays) ?? dayWord(lowerDays)}`;
  }
  // The freshest band always starts at day 0, so it reads as a ceiling.
  if (lowerDays <= 0) {
    return `Up to ${yearWord(upperDays) ?? dayWord(upperDays)}`;
  }
  // Two-sided. It reads as years only when BOTH bounds are exact years — a mixed
  // `120 days to 1 year` makes the reader convert one end to compare it with the
  // other, so a span with one day-ish bound stays entirely in days.
  const lowerYears = yearWord(lowerDays);
  const upperYears = yearWord(upperDays);
  if (lowerYears && upperYears) return `${lowerYears} to ${upperYears}`;
  return `${lowerDays.toLocaleString()} to ${dayWord(upperDays)}`;
}

/** Which `.lens-age-N` stop a band lands on — by POSITION across the ramp. */
export function ageBandRampClass(index: number, bandCount: number): string {
  return rampClass(AGE_LENS_RAMP, index, bandCount);
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Validate a stored settings document, FIELD BY FIELD, falling back per field.
 *
 * It comes back from `user_table_settings`, a free-form jsonb bag with no CHECK
 * constraint, possibly written by an older build or by hand. Never "one bad key,
 * everything to defaults" — that throws away good settings for one typo. An edge
 * list that normalises to empty (all junk, or over the cap) falls back to the
 * shipped default rather than leaving the lens with no bands at all.
 */
export function parseAgeLensSettings(raw: unknown): AgeLensSettings {
  const out: AgeLensSettings = {
    ...DEFAULT_AGE_LENS_SETTINGS,
    edgeDays: [...DEFAULT_AGE_LENS_SETTINGS.edgeDays],
    bandNames: {},
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;

  const edges = normalizeEdgeDays(rec.edgeDays);
  if (edges.length > 0 && edges.length <= BLOCKING_AGE_LENS_MAX_EDGES) out.edgeDays = edges;

  if (rec.bandNames && typeof rec.bandNames === 'object' && !Array.isArray(rec.bandNames)) {
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.bandNames as Record<string, unknown>)) {
      // A name is rendered as TEXT, never as markup — and capped, because an
      // unbounded string in a band row would push the panel's layout apart.
      if (typeof v !== 'string') continue;
      const name = v.trim().slice(0, 40);
      if (name === '') continue;
      // `<lower>:<upper|*>`, both non-negative — the shape `bandDayKey` produces.
      if (!/^\d+:(\d+|\*)$/.test(k)) continue;
      names[k] = name;
    }
    out.bandNames = names;
  }

  if (rec.unit === 'kg' || rec.unit === 'blocks') out.unit = rec.unit;

  return out;
}

/**
 * The document to store — DEFAULTS OMITTED.
 *
 * `saveUserModuleSettings` REPLACES the row, so leaving a defaulted field out is
 * what makes "Reset to default" an actual removal rather than a value that lingers
 * and has to be recognised as default forever after.
 */
export function serializeAgeLensSettings(s: AgeLensSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!sameDays(s.edgeDays, DEFAULT_AGE_LENS_SETTINGS.edgeDays)) body.edgeDays = [...s.edgeDays];
  if (Object.keys(s.bandNames).length > 0) body.bandNames = { ...s.bandNames };
  if (s.unit !== DEFAULT_AGE_LENS_SETTINGS.unit) body.unit = s.unit;
  return body;
}

export function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Is anything off the shipped defaults? Drives the Reset affordance. */
export function isDefaultAgeLensSettings(s: AgeLensSettings): boolean {
  return Object.keys(serializeAgeLensSettings(s)).length === 0;
}
