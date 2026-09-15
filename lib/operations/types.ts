// ═════════════════════════════════════════════════════════════════════════════════
// THE PLANT OPERATIONS LEDGER — the data-agnostic interface (/operations)
//
// This is the PORT half of the hexagon. `lib/operations/queries.ts` is the live
// ADAPTER that fills it from the `view_ops_ledger_*` SQL views; the page and its
// components are the application core and know nothing about Supabase.
//
// It supersedes the draft port at `app/dev/ops-ledger/_mock/types.ts`. Where the
// draft guessed and the database disagrees, the database wins — every divergence
// is called out in a WHY note below and in
// `.agents/plans/ops-ledger-plan.md` §2.
//
// THE SHAPE IS Renzo's `Q3 2026` tab, read literally: ONE ROW PER CALENDAR DAY,
// rest days included and blank, grouped by PRODUCTION BATCH (the campaign clock,
// the same one /inventory/rc-movement runs on). His `EOQ3 2026` tab is
// `OpsCampaignRollup` + `OpsGroupRollup`.
//
// EVERY NUMBER HERE WAS AGGREGATED IN SQL. Nothing in this module or its adapter
// sums, averages or weights anything (CLAUDE.md → "Never calculate weighted
// averages or inventory balances in TypeScript"). The adapter only RESHAPES —
// it groups already-aggregated rows by their key, the way the RC Movement matrix
// pivots already-aggregated cells.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * The eight recorded waste streams, in the sheet's own left-to-right order.
 *
 * ⚠ CORRECTS THE DRAFT. The draft port named these `rs3` and `grits`; the columns
 * that exist are **`rs23_kg`** (the RS2/3 stream is filed as ONE column, not two)
 * and **`grit_kg`**. The field names below are the real ones, so a component can
 * never ask for a key the payload does not have.
 *
 * `key` is the field on {@link OpsWaste}; `label` is the column head. They are
 * declared together so a layout can build a column per stream without a second
 * list to keep in step.
 */
export const WASTE_STREAMS = [
  { key: 'trml1Kg', label: 'TRML 1' },
  { key: 'trml2Kg', label: 'TRML 2' },
  { key: 'rs1aKg', label: 'RS1A' },
  { key: 'rs1bKg', label: 'RS1B' },
  { key: 'rs23Kg', label: 'RS2/3' },
  { key: 'rs5Kg', label: 'RS5' },
  { key: 'bfKg', label: 'BF' },
  { key: 'gritKg', label: 'GRITS' },
] as const;

export type WasteKey = (typeof WASTE_STREAMS)[number]['key'];

/**
 * The eight streams for one shift or one day.
 *
 * NULL IS NEVER 0. A shift that filed no waste row reads `null` on every stream;
 * printing 0 would claim "nothing was swept up" where the truth is "nothing was
 * recorded". And they do NOT sum to the day's drift — most of the loss leaves as
 * moisture and volatiles in the retort, which nobody weighs.
 */
export type OpsWaste = Record<WasteKey, number | null>;

/**
 * Display order for grade columns, mirroring `/inventory/rc-movement`'s
 * `GRADE_ORDER`. Grades PRESENT in the data are ordered by this list and anything
 * outside it is appended alphabetically, so a new grade surfaces rather than
 * silently disappearing.
 *
 * ⚠ CORRECTS THE DRAFT, which froze the grade set to a three-member union. The
 * grade set is DATA — read it from {@link OpsLedgerData.grades}, which the
 * adapter fills from `view_ops_ledger_campaign_grades`. This constant governs
 * ORDER only, never membership.
 */
export const GRADE_DISPLAY_ORDER = ['3X50', '6X50', '8X50', '2X6'] as const;

/** A block's life stage, mirroring the `batch_status` enum without importing it. */
export type BlockState = string;

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PRODUCTION BATCH — the grouping unit of the ledger. "JULY 2026" opens on
 * 2026-06-30; the campaign clock is never the calendar month.
 */
export interface OpsCampaign {
  /** The URL-safe key, e.g. `JULY-2026`. Identical to RC Movement's `?campaign=`. */
  key: string;
  /** `JULY 2026` — the analytics spelling, as stored. */
  label: string;
  /** `July 2026` — title-cased for a picker, as RC Movement renders it. */
  displayLabel: string;
  /** `JULY`. */
  productionBatch: string;
  campaignYear: number;
  /** First and last day of the LEDGER — the earlier/later of feeding and production. */
  firstDate: string;
  lastDate: string;
  spanDays: number;
  firstFedDate: string | null;
  lastFedDate: string | null;
  feedDays: number;
}

/** One option in the campaign picker. */
export interface OpsCampaignOption {
  key: string;
  label: string;
  productionBatch: string;
  campaignYear: number;
  feedDays: number;
  totalFedKg: number;
  minDate: string | null;
  maxDate: string | null;
}

/** One grade a campaign produced, and how much of the campaign it was. */
export interface OpsCampaignGrade {
  campaignKey: string;
  grade: string;
  kg: number | null;
  /** A PERCENT (0–100), matching its source view. */
  sharePct: number | null;
  campaignProducedKg: number | null;
  runCount: number | null;
  sacks: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DAY AND ITS LENSES
// ─────────────────────────────────────────────────────────────────────────────

/** One block a campaign drew from on one day — the RC Movement lens cell. */
export interface OpsDayBlockFeed {
  batchId: string;
  batchCode: string;
  blockLoc: string | null;
  fedKg: number | null;
  sundryKg: number | null;
}

/**
 * One line of the day's BLOCKS USED panel: a block the plant drew from that day,
 * carrying that block's whole life.
 */
export interface OpsDayBlockUsed {
  batchId: string;
  batchCode: string;
  blockLoc: string | null;
  /** DATE OPEN — the block's first feed, ever (not this campaign's). */
  firstFedDate: string | null;
  /** DATE CLOSE. `null` while the block is still open. */
  closeDate: string | null;
  isClosed: boolean;
  state: BlockState;
  /** Kg drawn from THIS block on THIS day. */
  dayFedKg: number | null;
  /** All-time kg the plant was fed out of this block (MAIN only). */
  totalFedKg: number | null;
  /** All-time kg that left the block, sun-drying pulls included. */
  totalOutKg: number | null;
  /** ARRIVAL WEIGHT — everything that ever arrived into the block. */
  deliveredKg: number | null;
  /** `delivered − out`. Only *means* "lost" once the block is closed. */
  weightLostKg: number | null;
  lossPct: number | null;
  /**
   * RESIKO — evaporation and shrinkage, a real loss.
   *
   * ⚠ CORRECTS THE DRAFT, which read 0 on an open block. It is **null** here:
   * charcoal still sitting in the pile is not loss yet, and 0 would claim the
   * block lost nothing. Read {@link balanceKg} for the open case.
   */
  resikoKg: number | null;
  resikoPct: number | null;
  /** Charcoal still in the pile. Non-null only while the block is OPEN. */
  balanceKg: number | null;
  hasSundryOutflow: boolean;
  sundryKg: number | null;
  hasUnpricedDelivery: boolean;
  unpricedDeliveryCount: number | null;
  feedCount: number | null;
  deliveryCount: number | null;
}

/** One run inside a shift, exactly as the plant filed it. */
export interface OpsShiftRun {
  grade: string | null;
  customer: string | null;
  ttl_kg: number | null;
  sacks_bags: number | null;
  remarks: string | null;
}

/**
 * One shift's own numbers — the breakdown a day row opens into.
 *
 * ⚠ THREE CORRECTIONS TO THE DRAFT.
 *  1. `shift` is a CODE (`M` / `E`), not `1 | 2`; there is no stored time window.
 *  2. There is **no per-shift fed kg and no supervisor**. `rc_out` has no shift
 *     dimension — feeding is recorded per DATE — so a shift-level fed figure
 *     could only ever be invented, and no column records who ran the shift.
 *  3. A shift's grade split is its RUNS, which carry grade and kg; the adapter
 *     hands them through untouched rather than folding them into a map.
 */
export interface OpsShift {
  shiftId: string;
  shift: string;
  shiftHrs: number | null;
  /** Which rule set the shift length — `default_9h` | `overtime_signal` (L-051b). */
  shiftHrsSource: string | null;
  dtHrs: number | null;
  dtMins: number | null;
  /** `dt_hrs + dt_mins/60`, the fold `view_production_daily` owns. */
  downtimeHours: number | null;
  productiveHrs: number | null;
  dtReason: string | null;
  /** MC's own stop-and-start times (L-051). */
  dtRanges: string | null;
  /** Ranges whose reason says the plant did NOT stop — visible, but 0 hours (L-051b). */
  dtIncidentRanges: string | null;
  hasIncident: boolean;
  downtimeRowPresent: boolean;
  /** NULL, never 0, when the shift filed no run. */
  producedKg: number | null;
  runCount: number;
  sacks: number | null;
  runsWithSacks: number;
  waste: OpsWaste;
  totalWasteKg: number | null;
  wasteRemarks: string | null;
  runs: OpsShiftRun[];
}

/**
 * ONE CALENDAR DAY. Present for every date in the campaign's span, rest days
 * included: a blank Sunday row is information (the plant did not run), and
 * dropping it would make the month read as if it had 26 days.
 *
 * ⚠ CORRECTS THE DRAFT on two points. `restDay` did not mean "every figure is 0"
 * — every figure is **null**. And the draft's `lossKg` is {@link dayDriftKg}: the
 * feed tank is continuous flow, so a day's fed and produced do not describe the
 * same charcoal (JULY 2026 produced 22,862 kg on a day it fed nothing). Real loss
 * is a CAMPAIGN figure; read it from {@link OpsCampaignRollup}.
 */
export interface OpsLedgerDay {
  campaignKey: string;
  campaignLabel: string;
  /** `yyyy-MM-dd`. */
  date: string;
  /** `Mon` … `Sun`. */
  weekday: string;
  isoWeekday: number;
  isWeekend: boolean;
  /** Nothing fed, nothing produced, nobody on shift. */
  isRestDay: boolean;

  fedKg: number | null;
  /** Kg pulled out to sun-dry that day. NOT feed — it never reached the plant. */
  sundryKg: number | null;
  /** ₱ — the day's weighted-average delivered price. NULLED SERVER-SIDE for Production. */
  fedPhpKg: number | null;
  producedKg: number | null;
  /** `fed − produced`. DAY-LEVEL DRIFT, not loss. See the class note. */
  dayDriftKg: number | null;

  blocksFedCount: number;
  shiftCount: number;
  shiftHrsTotal: number | null;
  downtimeHours: number | null;
  /** Shifts whose downtime ranges include one the plant ran THROUGH (L-051b). */
  downtimeIncidentCount: number;
  downtimeShiftCount: number;
  downtimeShiftsWithDuration: number;
  downtimeShiftsReasonOnly: number;
  runCount: number;
  sacks: number | null;
  runsWithSacks: number;
  waste: OpsWaste;
  totalWasteKg: number | null;
  /** The digest's rule: a production day is a day with a `production_runs` child. */
  productionReported: boolean;

  /** grade → kg produced that day. Absent = the grade did not run. */
  producedByGrade: Record<string, number | null>;
  /** The RC Movement lens: one entry per block fed that day. */
  blocksFed: OpsDayBlockFeed[];
  /** The BLOCKS USED expand. */
  blocksUsed: OpsDayBlockUsed[];
  /** The per-SHIFT expand. */
  shifts: OpsShift[];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EOQ ROWS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of the `EOQ` tab — a campaign's rollup.
 *
 * ⚠ FOUR DRAFT FIELDS ARE ABSENT, DELIBERATELY. `rcInventoryTons` /
 * `rcInventoryPhp` / `buyingTons` / `buyingPhp` are NOT campaign-clock figures:
 * stock is a LEVEL owned by `view_analytics_inventory_eom` and buying is a FLOW
 * owned by `view_analytics_rcin_monthly`, and both are keyed on the CALENDAR
 * month. Fabricating a campaign-clock version of either would create a second
 * definition of the RC inventory price — the exact mistake migration
 * `20260903013948` was written to undo. If the band needs them, join the calendar
 * views and label them as calendar-month figures.
 */
export interface OpsCampaignRollup {
  campaignKey: string;
  label: string;
  productionBatch: string;
  campaignYear: number;
  firstDate: string;
  lastDate: string;
  spanDays: number;
  firstFedDate: string | null;
  lastFedDate: string | null;
  feedDays: number;

  /** RC FED. */
  fedKg: number | null;
  /** PRODUCED. NULL, never 0, when the campaign reported no production. */
  producedKg: number | null;
  productionReported: boolean;
  /** A FRACTION (0.8292), not a percent. */
  yieldPct: number | null;
  /** LOSS — the retort's, `fed − produced`. */
  processLossKg: number | null;
  /** A FRACTION. */
  processLossPct: number | null;

  /** BLOCK RESIKO LOSS — the yard's shrinkage, kg and FRACTION. */
  blockResikoKg: number | null;
  blockResikoLossPct: number | null;

  /**
   * WASTE LOSS — the eight RECORDED streams, totalled for the campaign.
   *
   * THEY DO NOT SUM TO {@link processLossKg}. Most of what the retort loses
   * leaves as moisture and volatiles that nobody weighs; this is what was swept
   * up and put on a scale. NULL IS NEVER 0 — a campaign none of whose shifts
   * filed a waste row reads `null` on every stream and on {@link wasteKg}.
   */
  waste: OpsWaste;
  /** Σ of the eight streams. NULL, never 0, when no shift filed a waste row. */
  wasteKg: number | null;
  /** Shifts that filed a waste row — the coverage behind {@link wasteKg}. */
  wasteShiftCount: number;
  /**
   * `wasteKg ÷ fedKg`, a **FRACTION** (0.121155 = 12.1155%), the same convention
   * as {@link yieldPct} / {@link processLossPct}. ×100 at render. NULL when
   * either side is missing or the fed denominator is 0.
   */
  wasteLossPct: number | null;

  /** ₱ FED PRICE (delivered). */
  fedPhpKg: number | null;
  fedValuePhp: number | null;
  /** ₱ ACTUAL FED PRICE — whole-block value ÷ whole-block fed kg. */
  actualFedPhpKg: number | null;
  /** ₱ the campaign-attributed twin, shape-comparable with `fedPhpKg`. */
  campaignWeightedActualFedPhpKg: number | null;
  /** ₱ actual − delivered. Legitimately 0 or negative on ~27% of closed blocks. */
  upliftPhpKg: number | null;
  /** ₱ PC COST — delivered ₱ per kilo of finished product. */
  phpPerProducedKgDelivered: number | null;
  /** ₱ TRUE PC COST — the same, carrying the shrinkage. NULL unless fully covered. */
  phpPerProducedKgTrue: number | null;

  /** 0–100. */
  fedPriceCoveragePct: number | null;
  blocksFed: number | null;
  blocksClosed: number | null;
  blocksOpen: number | null;
  blocksInPrice: number | null;
  blocksClosedUnpriced: number | null;
  blocksWithSundry: number | null;
  campaignFedKgIncluded: number | null;
  /** A FRACTION. */
  campaignFedKgIncludedPct: number | null;
  isFullyCovered: boolean;
  sundryKg: number | null;
  outKg: number | null;

  reportedDays: number | null;
  shiftCount: number | null;
  runCount: number | null;
  downtimeHours: number | null;
  downtimeShiftCount: number | null;
  downtimeShiftsWithDuration: number | null;
  downtimeShiftsReasonOnly: number | null;
  sacks: number | null;
  runsWithSacks: number | null;
  /** 0–100. */
  sacksCoveragePct: number | null;
  kwh: number | null;
  kwhDays: number | null;
  kwhSuspectReadingCount: number | null;
  kwhPerProducedKg: number | null;
  kwhPerProducedKgExclSuspect: number | null;

  /** Days in the ledger, and the working/rest split. */
  ledgerDays: number | null;
  activeDays: number | null;
  restDays: number | null;
}

/**
 * THE GROUP ROW — a chosen set of campaigns read as one period (Q3 2026).
 *
 * Kilograms and hours SUM; every ₱/kg and every ratio is WEIGHTED in SQL.
 * TWO FIGURES ARE DELIBERATELY ABSENT because a block can be fed by more than one
 * campaign (measured: 78 of 523 blocks): there is no group resiko KG (only the
 * weighted ratio) and no whole-block actual price (only the campaign-attributed
 * form). Block counts come de-duplicated.
 */
export interface OpsGroupRollup {
  campaignCount: number;
  campaignKeys: string[];
  /** Keys that resolved to no campaign — surfaced, never silently dropped. */
  campaignsMissing: string[];
  firstDate: string | null;
  lastDate: string | null;
  ledgerDays: number;
  activeDays: number;
  restDays: number;

  fedKg: number | null;
  producedKg: number | null;
  /** The denominator `yieldPct` actually used: fed kg of the campaigns that reported. */
  fedKgProductionReported: number | null;
  campaignsProductionReported: number;
  /** A FRACTION. */
  yieldPct: number | null;
  processLossKg: number | null;
  processLossPct: number | null;
  /** A FRACTION, weighted by covered fed kg. There is no group resiko KG — see the class note. */
  blockResikoLossPct: number | null;

  /**
   * WASTE LOSS for the whole group — a plain SUM of the member campaigns' own
   * waste columns. Unlike a block, a SHIFT belongs to exactly one campaign, so
   * waste partitions cleanly and the kilograms simply add; that is why a group
   * waste KG exists where a group resiko KG deliberately does not.
   */
  waste: OpsWaste;
  wasteKg: number | null;
  wasteShiftCount: number;
  /**
   * A **FRACTION** of fed kg, weighted by {@link fedKgWasteReported} — the fed
   * kilos of the campaigns that actually filed waste, NOT the group's whole fed
   * total. Production reporting begins 2025-11-27, so 22 of the 32 campaigns fed
   * the plant and filed no shift at all; including their kilos would understate
   * any group straddling that boundary, the same trap {@link yieldPct} avoids
   * with {@link fedKgProductionReported}.
   */
  wasteLossPct: number | null;
  /** How many of {@link campaignCount} filed any waste — print "3 of 3". */
  campaignsWasteReported: number;
  /** The denominator `wasteLossPct` actually used. */
  fedKgWasteReported: number | null;

  /** ₱ */
  fedPhpKg: number | null;
  fedValuePhp: number | null;
  /** ₱ campaign-attributed ACTUAL FED PRICE. */
  actualFedPhpKg: number | null;
  upliftPhpKg: number | null;
  phpPerProducedKgDelivered: number | null;
  /** ₱ strict NULL unless EVERY campaign is fully covered and reported production. */
  phpPerProducedKgTrue: number | null;
  /** ₱ the always-computed partial beside it. */
  phpPerProducedKgTrueCovered: number | null;

  campaignsFullyCovered: number;
  isFullyCovered: boolean;
  /** A FRACTION: covered fed kg ÷ fed kg. */
  coveredFedKgShare: number | null;
  campaignFedKgIncluded: number | null;
  /** 0–100. */
  fedPriceCoveragePct: number | null;

  /** De-duplicated across campaigns. */
  blocksFedDistinct: number;
  blocksClosedDistinct: number;
  blocksOpenDistinct: number;
  /** The naive Σ of per-campaign counts — larger when a block was fed twice. */
  blocksFedCampaignSum: number | null;

  /** Campaign-days (a changeover date counts in both campaigns). */
  reportedCampaignDays: number | null;
  /** Distinct calendar dates. */
  reportedCalendarDays: number;
  shiftCount: number | null;
  runCount: number | null;
  downtimeHours: number | null;
  sacks: number | null;
  sundryKg: number | null;
}

/** What the adapter hands the page. One object, like `DigestData`. */
export interface OpsLedgerData {
  /** The resolved campaigns, in date order. */
  campaigns: OpsCampaign[];
  /** Requested keys that matched no campaign. */
  campaignsMissing: string[];
  /** Every day of every campaign, in (campaign, date) order. */
  days: OpsLedgerDay[];
  /** The EOQ rows, one per campaign, in date order. */
  rollups: OpsCampaignRollup[];
  /** The group KPI strip. `null` when no campaign resolved. */
  group: OpsGroupRollup | null;
  /** Every grade any campaign in the group produced, in display order. */
  grades: string[];
  /** campaignKey → that campaign's grades, in display order. */
  gradesByCampaign: Record<string, OpsCampaignGrade[]>;
  /**
   * The canonical server-side price gate (`lib/auth.canViewPrices`). FALSE for
   * Production, including an impersonating Owner/Admin/Dev. When false every ₱
   * field above is ALREADY null — the server stripped it before the payload left.
   */
  canViewPrices: boolean;
}
