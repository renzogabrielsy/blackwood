// =====================================================================
// ICTC Owner Analytics — THE CAMPAIGN CHECKLIST, SPLIT IN TWO (R8)
// =====================================================================
// Renzo, 2026-09-03: *"In by production batch table, change how the batches
// drop down filter work from checking every known batch to separating this
// into two drop downs: one for years and one for the batches without the
// year. Currently it lists all 32 batches in one drop down. I'd rather be
// able to see all the batches within a year type of thing."*
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────
// It is a PRESENTATION of the selection, not a second selection. The one
// piece of state is unchanged and stays exactly where it was: a set of
// hidden `campaignLabel` keys, spelled `?bhide=` in the URL, read by the
// campaign matrix, the grade mix and the group print alike. Nothing here
// widens that contract, invents a second param, or lets the two controls
// disagree — a year is simply "every campaign of that year" and a batch
// name is "every campaign carrying that name, in the years on screen".
//
// That is why every function below takes the hidden set and returns a NEW
// hidden set of the same shape. There is no `hiddenYears` state anywhere:
// the year checkboxes are DERIVED on every render, so they cannot drift
// away from the columns they claim to describe.
//
// ── THE TWO RULES THAT MAKE THE PAIR COHERENT ─────────────────────────
//  1. **A control is unticked only when EVERY column it stands for is
//     hidden.** A year with one batch still showing is still a year that
//     is showing. Anything looser would let a fully-visible year read as
//     off; anything stricter would let a fully-hidden year read as on.
//  2. **A toggle is applied as a DIFF, never as an absolute rewrite.**
//     Recomputing every label from the year checkboxes would silently
//     restore the per-batch picks a reader had made the moment they
//     touched the year control — the classic "my filter reset itself" bug.
//     Only the years (or names) whose own state actually CHANGED are
//     rewritten; everything else keeps the selection it already had.
//
// ── AND THE NAME/YEAR SPLIT NEEDS NO STRING PARSING ───────────────────
// `CampaignMatrixRow` already carries `productionBatch` (`AUGUST`) and
// `campaignYear` (`2026`) as separate fields straight from SQL, so the
// label is never split apart to recover them. `campaignLabel` stays the
// identity — the thing `?bhide=` holds and the thing the columns are keyed
// on — and is never reconstructed from the two halves either.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import { campaignSeq } from "./campaign";

/**
 * The shape this module needs from a campaign — the three fields every
 * campaign row already carries. Structural, so `CampaignMatrixRow`,
 * `CampaignCost` and `ProductionBatchRow` all satisfy it without a cast.
 */
export interface CampaignSelectable {
  /** The batch name WITHOUT the year — `AUGUST`. The second dropdown's list. */
  productionBatch: string;
  /** The year — `2026`. The first dropdown's list. */
  campaignYear: number;
  /** `AUGUST 2026` — the identity `?bhide=` holds. Never re-derived here. */
  campaignLabel: string;
}

/**
 * One line of either dropdown, before it is dressed as a `PeriodFilterOption`.
 *
 * Generic in the campaign type so a caller holding the full `CampaignMatrixRow`
 * gets its own rows back — the room reads `cost.fedKg` off them to mark a line
 * that never fed anything, and a widened `CampaignSelectable[]` would have made
 * that a cast.
 */
export interface CampaignGroup<
  K extends string | number,
  C extends CampaignSelectable = CampaignSelectable,
> {
  /** The year, or the batch name. */
  id: K;
  /** Every campaign the line stands for, in the order they arrived. */
  campaigns: C[];
  /** How many of those are currently on screen. */
  shownCount: number;
  /** Rule 1: on unless EVERY column it stands for is hidden. */
  checked: boolean;
}

export type CampaignYearGroup<C extends CampaignSelectable = CampaignSelectable> =
  CampaignGroup<number, C>;
export type CampaignNameGroup<C extends CampaignSelectable = CampaignSelectable> =
  CampaignGroup<string, C>;

/** The dropdown key a year is addressed by. One place, so the two directions agree. */
export function yearKey(year: number): string {
  return String(year);
}

function finish<K extends string | number, C extends CampaignSelectable>(
  id: K,
  campaigns: C[],
  hidden: ReadonlySet<string>,
): CampaignGroup<K, C> {
  let shownCount = 0;
  for (const c of campaigns) if (!hidden.has(c.campaignLabel)) shownCount += 1;
  return { id, campaigns, shownCount, checked: shownCount > 0 };
}

/**
 * The YEAR dropdown's lines, in the campaigns' own arrival order.
 *
 * The payload is already sorted chronologically — `campaignSeq` within a year,
 * years ascending — so first-appearance order IS calendar order and nothing
 * here re-derives one. A second sort would be a second definition of
 * chronological, which is exactly the drift `lib/analytics/campaign.ts` exists
 * to prevent.
 */
export function groupCampaignYears<C extends CampaignSelectable>(
  campaigns: readonly C[],
  hidden: ReadonlySet<string>,
): CampaignYearGroup<C>[] {
  const byYear = new Map<number, C[]>();
  for (const c of campaigns) {
    const list = byYear.get(c.campaignYear);
    if (list) list.push(c);
    else byYear.set(c.campaignYear, [c]);
  }
  return [...byYear.entries()].map(([year, list]) => finish(year, list, hidden));
}

/**
 * The BATCH-NAME dropdown's lines — **only the names that exist inside the
 * years currently on screen**, which is the whole point of the split: pick
 * 2026 and the list is 2026's batches, not all thirty-two.
 *
 * Sorted by the month the name spells (`campaignSeq`, the one definition), so
 * it reads JANUARY → DECEMBER regardless of which month the record happens to
 * open on, with any name that is not one of the twelve sorted after them
 * alphabetically rather than folded into January.
 */
export function groupCampaignNames<C extends CampaignSelectable>(
  campaigns: readonly C[],
  hidden: ReadonlySet<string>,
  shownYears: ReadonlySet<number>,
): CampaignNameGroup<C>[] {
  const byName = new Map<string, C[]>();
  for (const c of campaigns) {
    if (!shownYears.has(c.campaignYear)) continue;
    const list = byName.get(c.productionBatch);
    if (list) list.push(c);
    else byName.set(c.productionBatch, [c]);
  }
  return [...byName.entries()]
    .map(([name, list]) => finish(name, list, hidden))
    .sort((a, b) => {
      const d = campaignSeq(a.id) - campaignSeq(b.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
}

/** The years with nothing on screen — what the year dropdown reads as unticked. */
export function hiddenYearKeys(years: readonly CampaignYearGroup[]): Set<string> {
  const out = new Set<string>();
  for (const y of years) if (!y.checked) out.add(yearKey(y.id));
  return out;
}

/** The batch names with nothing on screen — what the batch dropdown reads as unticked. */
export function hiddenNameKeys(names: readonly CampaignNameGroup[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) if (!n.checked) out.add(n.id);
  return out;
}

/** The years with at least one column on screen — the batch list's population. */
export function shownYearSet(years: readonly CampaignYearGroup[]): Set<number> {
  const out = new Set<number>();
  for (const y of years) if (y.checked) out.add(y.id);
  return out;
}

/**
 * Rule 2, written once and reused by both controls: rewrite the labels of the
 * groups whose own ticked/unticked state CHANGED, and leave every other group's
 * selection exactly as the reader left it.
 *
 * `nextHidden` is whatever the checklist handed back — one toggle, or the
 * wholesale set `All` / `None` produce — so this is the only code path either
 * gesture needs.
 */
function applyGroupToggle<K extends string | number>(
  groups: readonly CampaignGroup<K, CampaignSelectable>[],
  key: (id: K) => string,
  hidden: ReadonlySet<string>,
  nextHiddenGroups: ReadonlySet<string>,
): Set<string> {
  const next = new Set(hidden);
  for (const g of groups) {
    const nowHidden = nextHiddenGroups.has(key(g.id));
    if (nowHidden === !g.checked) continue; // this group did not move
    for (const c of g.campaigns) {
      if (nowHidden) next.add(c.campaignLabel);
      else next.delete(c.campaignLabel);
    }
  }
  return next;
}

/**
 * The year dropdown's write path. Unticking a year hides every one of its
 * columns; ticking it back returns the year WHOLE — every batch in it, which is
 * the only reading of "show me 2025 again" that does not need a footnote.
 */
export function applyYearSelection(
  years: readonly CampaignYearGroup[],
  hidden: ReadonlySet<string>,
  nextHiddenYears: ReadonlySet<string>,
): Set<string> {
  return applyGroupToggle(years, yearKey, hidden, nextHiddenYears);
}

/**
 * The batch dropdown's write path. A name that exists in two selected years
 * toggles BOTH columns — Renzo's own requirement — and touches nothing in a
 * year that is currently switched off, because `groupCampaignNames` never put
 * those campaigns in the group to begin with.
 */
export function applyNameSelection(
  names: readonly CampaignNameGroup[],
  hidden: ReadonlySet<string>,
  nextHiddenNames: ReadonlySet<string>,
): Set<string> {
  return applyGroupToggle(names, (n) => n, hidden, nextHiddenNames);
}
