// =====================================================================
// ICTC Owner Analytics — CAMPAIGN IDENTITY (owner feedback R5)
// =====================================================================
// A production campaign is NAMED for a month — `AUGUST 2026` — and that
// name is the only thing about it that is reliably chronological. Its
// `first_fed_date` is NULL for a campaign that has produced but not yet been
// fed (SEPTEMBER 2026 is exactly that today), so ordering by a date would
// throw the current campaign to one end of the axis rather than putting it in
// its place in the year.
//
// ── WHY THIS MODULE EXISTS ────────────────────────────────────────────
// The twelve month names and the "sort by (year, month index of the NAME)"
// rule lived inside `queries.ts`, which is `server-only`. R5 gives the campaign
// panel its own checklist — Renzo: *"this group sorely lacks what RC Inventory
// has in terms of data filtering"* — and that checklist has to list campaigns
// in the SAME chronological order the columns are in. Copying the month list
// into a client component would have been a second definition of what
// "chronological" means for a campaign, and the first time somebody added a
// name to one list it would have drifted from the other.
//
// So the rule moved here, pure and client-safe, and `queries.ts` imports it.
// ONE definition, two callers.
//
// ── AND THE MONTH SPAN, WHICH IS THE OTHER HALF OF R5 ─────────────────
// Renzo asked for the batch checklist to also drive the production band:
// *"the production matrix + grade table show only the MONTHS overlapping the
// selected batches."* A campaign's months are therefore a first-class question,
// and the answer has to be honest about a campaign that has not been fed yet —
// see `campaignMonthKeys`.
// =====================================================================

import type { CampaignCost } from "./types";

/** The twelve names a campaign can be called, in calendar order. */
export const CAMPAIGN_MONTHS: readonly string[] = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/**
 * 0-based month index of the name a campaign carries, or `-1` when the name is
 * not one of the twelve. Never guesses — an unrecognised name is reported as
 * unrecognised rather than folded into January.
 */
export function campaignMonthIndex(batch: string): number {
  return CAMPAIGN_MONTHS.indexOf(batch.trim().toUpperCase());
}

/**
 * The sort key behind the campaign axis: chronological by the month the NAME
 * spells, newest last. An unrecognised name sorts after the twelve months of
 * its own year rather than silently landing in January.
 */
export function campaignSeq(batch: string): number {
  const i = campaignMonthIndex(batch);
  return i === -1 ? 99 : i;
}

/**
 * Stable identity for one campaign, used as a checklist key.
 *
 * R7 widened the parameter to "anything that carries a campaign label", because
 * the merged campaign table's row is a PAIR of view rows rather than a
 * `CampaignCost`. The key itself is unchanged, which is what keeps every
 * `?bhide=` link shared before the merge resolving.
 */
export function campaignKey(c: { campaignLabel: string }): string {
  return c.campaignLabel;
}

function monthKey(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

/** `2026-08-29` → `2026-08`. The month key everything here speaks in. */
function monthKeyOfDate(date: string): string {
  return date.slice(0, 7);
}

/**
 * THE month span of one campaign, as `YYYY-MM` keys.
 *
 * ── THE TWO SOURCES, AND WHY IT IS A UNION RATHER THAN A CHOICE ────────
 * A campaign runs over the days it actually fed, and those days routinely
 * straddle a month boundary — AUGUST closed and SEPTEMBER opened on
 * 2026-08-29 — so the fed range is the truthful span whenever it exists.
 *
 * But it does not always exist. A campaign that has PRODUCED and not yet been
 * fed carries `first_fed_date = NULL`, and returning an empty span for it
 * would make selecting the current campaign filter the production band down to
 * nothing — the one campaign a reader is most likely to pick. So the month the
 * campaign is NAMED for is always included as well.
 *
 * The union is deliberate rather than a fallback: a fed range that begins in
 * July under the name AUGUST genuinely covers both, and asserting one over the
 * other would be picking which half of the truth to print.
 */
export function campaignMonthKeys(c: CampaignCost): string[] {
  const keys = new Set<string>();

  const named = campaignMonthIndex(c.productionBatch);
  if (named >= 0) keys.add(monthKey(c.campaignYear, named));

  const first = c.firstFedDate ? monthKeyOfDate(c.firstFedDate) : null;
  const last = c.lastFedDate ? monthKeyOfDate(c.lastFedDate) : first;
  if (first && last) {
    // Walk the calendar rather than parsing to Date — a `YYYY-MM` string is
    // already the whole of the arithmetic, and a Date would drag a timezone
    // into a figure that has none.
    let [y, m] = first.split("-").map(Number);
    const [ly, lm] = last.split("-").map(Number);
    // A malformed pair can never loop forever: 600 months is fifty years,
    // which is longer than the record and longer than the company.
    for (let guard = 0; guard < 600 && (y < ly || (y === ly && m <= lm)); guard += 1) {
      keys.add(monthKey(y, m - 1));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  return [...keys].sort();
}

// ── `selectedCampaignMonths` WAS HERE, AND IS GONE (owner feedback R6) ───────
//
// R5 needed it to carry the campaign checklist's selection into the production
// band's CALENDAR columns: a batch is not a month, so the selection had to be
// projected onto months before it could filter anything, and the projection was
// lossy enough to need a caveat sentence on screen ("a month overlapping a
// selected and an unselected batch is shown whole").
//
// R6 moved that band onto the batch clock, so a column IS a batch and the
// checklist filters it by identity — `?bhide=` holds `campaignLabel` keys and
// the campaign panel, the production band and the grade mix all read the same
// set with no mapping step. There is nothing left for this function to do.
//
// Deleted rather than left exported: a projection helper that no caller uses is
// exactly the thing a future round reaches for, and reaching for it would put
// the calendar clock back into the production band by the back door.
// `campaignMonthKeys` stays — the campaign PANEL still uses it to say which
// months a campaign spanned, which is a label, not a filter.
