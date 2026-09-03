"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE CAMPAIGN ROOM — ONE table per production batch (owner feedback R7).
//
// ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
// Two components that sat one above the other: `batch-cost-panel.tsx` (the
// money read, nine rows) and `production-room.tsx` (the plant read, eight
// rows). Renzo, 2026-09-02: *"It doesn't make sense for it to be separated and
// have redundant metrics… better to reference all of that in one table."*
//
// He is describing a duplication R6 created and then made obvious. R6 moved the
// production band onto the BATCH clock so its Yield would equal the panel's;
// the moment it did, the two tables had the same axis, the same columns in the
// same order, the same `?bhide=` checklist driving them — and **Produced** and
// **Yield** printed twice on one screen. The merge deletes the duplicate rather
// than inventing a join: the two views share a spine
// (`campaign_options UNION campaign_yield`) and the adapter already sorts both
// by `campaignSeq`. No SQL was written for this round.
//
// ── WHAT IT KEEPS, DELIBERATELY ──────────────────────────────────────────────
//   • the `?bhide=` selection, which drives the table and the grade mix — two
//     consumers, one set. **R8 split the CONTROL over it in two** (a Year
//     dropdown and a batch-NAME dropdown) without touching the set: thirty-two
//     lines in one list is a wall, and the two questions a reader actually asks
//     are "just 2026" and "every January". See the derivation below;
//   • the `Blocks closed / priced` coverage line, as a footer ROW rather than a
//     rail, because it is the sentence a blank true price owes its reader and a
//     reader must not have to open anything to see it;
//   • the row dividers, the drag/keyboard reorder and the group Print, which
//     the shared matrix component already provides to every band;
//   • the ₱ gate. Five of the eleven rows are `price: true` and the adapter
//     already nulls every one of those fields server-side, so a restricted role
//     gets `null` in the cell and the matrix renders the row locked. There is
//     nothing to hide client-side because nothing arrived.
//
// ── WHAT IT GAINS ────────────────────────────────────────────────────────────
// The six money-and-yard rows are matrix rows now, so each has what only the
// production rows had before: a period-over-period delta, the comparison chip,
// an in-place expand with its own chart, checklist, average switch and Print,
// and a dictionary entry rather than a `title` attribute.
//
// ── AND THE ONE THING IT IS STILL FREE OF ────────────────────────────────────
// The grade mix underneath carries no ₱ and none is derivable, so it is live
// for every role including Production, exactly as it was.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Factory } from "lucide-react";
import type { ComparisonMode, Matrix, MatrixRow } from "@/lib/analytics/matrix";
import { SECTION_ACCENT } from "@/lib/analytics/metrics";
import type { MetricKey, MetricSection } from "@/lib/analytics/metrics";
import {
  CAMPAIGN_GRANULARITY,
  coverageSentence,
  type CampaignMatrixRow,
} from "@/lib/analytics/campaign-matrix";
import { campaignKey, campaignMonthKeys } from "@/lib/analytics/campaign";
import {
  applyNameSelection,
  applyYearSelection,
  groupCampaignNames,
  groupCampaignYears,
  hiddenNameKeys,
  hiddenYearKeys,
  shownYearSet,
  yearKey,
} from "@/lib/analytics/campaign-selection";
import { buildGradeSet, PRODUCTION_DICTIONARY } from "@/lib/analytics/production";
import type {
  ProductionBatchRow,
  ProductionGradeData,
} from "@/lib/analytics/types";
import { AnalyticsMatrix } from "./analytics-matrix";
import { BatchSideRail, MetricExpand } from "./metric-expand";
import { DictionaryPopover } from "./metric-info";
import { ProductionGrades } from "./production-grades";
import { GroupPrintPage, GroupPrintStage } from "./group-print";
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { UnitValue } from "./unit-value";
import { cn } from "@/lib/utils";

/** This section renders exactly one band of the campaign matrix. */
const CAMPAIGN_BAND: readonly MetricSection[] = ["campaigns"];

function t1(kg: number): string {
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function pct1(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * One chip. No colour, no threshold — a magnitude and a name, with the unit on
 * the LEFT so a chip and the table under it announce a unit in the same place.
 */
function Chip({
  label,
  value,
  unit,
  note,
  title,
}: {
  label: string;
  value: string;
  unit: string;
  note?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 px-2.5 py-1.5" title={title}>
      <div className="truncate text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <UnitValue
        glyph={unit}
        className="font-mono text-[length:var(--bw-fs-15)] tabular-nums"
        valueClassName="font-semibold"
        after={
          note ? (
            <span className="shrink-0 text-[length:var(--bw-fs-11)] text-muted-foreground">
              {note}
            </span>
          ) : undefined
        }
      >
        {value}
      </UnitValue>
    </div>
  );
}

export interface CampaignRoomProps {
  /** The merged fold — campaigns as columns, eleven rows (sixteen until R8). */
  matrix: Matrix<CampaignMatrixRow>;
  /** EVERY campaign, in chronological order — the checklist lists them all. */
  campaigns: readonly CampaignMatrixRow[];
  /**
   * Campaigns whose two source views disagree about `fed_kg`. Measured 0 of 32;
   * carried so the room can SAY it rather than the merge assuming it.
   */
  fedKgMismatches: readonly string[];
  /** The plant half on its own, for the grade fold. */
  batches: readonly ProductionBatchRow[];
  grades: ProductionGradeData;
  /**
   * R8 — `canViewPrices` NO LONGER ARRIVES HERE. Its only reader was the
   * footnote under the table, which said "₱ rows are withheld for your role"
   * to a reader who could already see four rows rendered locked with their own
   * restricted panel. The gate itself is untouched and is exactly where it
   * always was: the ADAPTER nulls every ₱ field before the payload leaves the
   * server, and `AnalyticsMatrix` locks a `price: true` row from the fold's own
   * `foldOptions.canViewPrices`. Nothing about the security boundary moved —
   * one duplicate sentence about it did.
   */
  /** The expanded metric, shared with the matrix at the top of the page. */
  selected: MetricKey | null;
  onSelect(key: MetricKey | null): void;
  /** What the second chip under every value shows — the page's own control. */
  comparison: ComparisonMode;
  /** What a printed metric card says the reader was looking at. */
  printScope: string;
  asOfDate: string | null;
  /** R3 — the page's master `Definitions` switch, passed straight through. */
  showDictionary: boolean;
  /** The switched-OFF campaign keys, straight from `?bhide=`. */
  hidden: ReadonlySet<string>;
  onHiddenChange(next: Set<string>): void;
}

export function CampaignRoom({
  matrix,
  campaigns,
  fedKgMismatches,
  batches,
  grades,
  selected,
  onSelect,
  comparison,
  printScope,
  asOfDate,
  showDictionary,
  hidden,
  onHiddenChange,
}: CampaignRoomProps) {
  const gradeSet = React.useMemo(
    () => buildGradeSet(grades.rows, batches, hidden),
    [grades.rows, batches, hidden],
  );

  /**
   * ── R8 — TWO DROPDOWNS OVER ONE SELECTION ──────────────────────────────
   *
   * Renzo, 2026-09-03: *"I'd rather be able to see all the batches within a
   * year type of thing."* Thirty-two lines in one list is a wall, and the
   * thing a reader actually wants to say is either "just 2026" or "every
   * January". So the control is split — a YEAR list and a BATCH-NAME list —
   * while the SELECTION is not: `?bhide=` still holds `campaignLabel` keys,
   * still drives the table, the grade mix and the group print from one set,
   * and `period-selection.ts` is untouched. Both lists are DERIVED from that
   * set on every render, which is why they cannot drift from the columns.
   *
   * Neither list splits a label apart to find a year: `productionBatch` and
   * `campaignYear` arrive as separate columns and are read as they are.
   *
   * The name list is scoped to the years currently on screen — that IS the
   * feature. Untick 2024 and the batches it alone contained leave the second
   * list rather than sitting there toggling a column nobody can see.
   */
  const yearGroups = React.useMemo(
    () => groupCampaignYears(campaigns, hidden),
    [campaigns, hidden],
  );
  const shownYears = React.useMemo(() => shownYearSet(yearGroups), [yearGroups]);
  const nameGroups = React.useMemo(
    () => groupCampaignNames(campaigns, hidden, shownYears),
    [campaigns, hidden, shownYears],
  );
  const hiddenYears = React.useMemo(() => hiddenYearKeys(yearGroups), [yearGroups]);
  const hiddenNames = React.useMemo(() => hiddenNameKeys(nameGroups), [nameGroups]);

  const onYearChange = React.useCallback(
    (next: Set<string>) =>
      onHiddenChange(applyYearSelection(yearGroups, hidden, next)),
    [yearGroups, hidden, onHiddenChange],
  );
  const onNameChange = React.useCallback(
    (next: Set<string>) =>
      onHiddenChange(applyNameSelection(nameGroups, hidden, next)),
    [nameGroups, hidden, onHiddenChange],
  );

  const yearOptions = React.useMemo<PeriodFilterOption[]>(
    () =>
      yearGroups.map((y) => {
        const total = y.campaigns.length;
        const partial = y.shownCount > 0 && y.shownCount < total;
        return {
          key: yearKey(y.id),
          label: String(y.id),
          meta: partial ? `${y.shownCount}/${total}` : `${total}`,
          // Nothing in the whole year ever fed the plant — rendered quieter,
          // still toggleable, exactly as a never-fed campaign was before.
          empty: y.campaigns.every((c) => c.cost?.fedKg == null),
          title:
            `${y.id} — ${total} production batch${total === 1 ? "" : "es"}: ` +
            `${y.campaigns.map((c) => c.productionBatch).join(", ")}. ` +
            "Unticking it removes every one of those columns from the table and " +
            "from the grade mix below, and drops its batches from the Batches " +
            "list beside it; ticking it back returns the year whole.",
        };
      }),
    [yearGroups],
  );

  /**
   * The BATCH list. One line per NAME, sorted by the month that name spells
   * (`campaignSeq` — the one definition), so it reads JANUARY → DECEMBER and
   * alphabetical (APRIL, AUGUST, DECEMBER) stays unrepresentable here.
   */
  const batchOptions = React.useMemo<PeriodFilterOption[]>(
    () =>
      nameGroups.map((n) => {
        const total = n.campaigns.length;
        const partial = n.shownCount > 0 && n.shownCount < total;
        const only = total === 1 ? n.campaigns[0] : null;
        const months = only?.cost ? campaignMonthKeys(only.cost) : [];
        return {
          key: n.id,
          label: n.id,
          meta: partial
            ? `${n.shownCount}/${total}`
            : only
              ? String(only.campaignYear)
              : `×${total}`,
          empty: n.campaigns.every((c) => c.cost?.fedKg == null),
          title: only
            ? `${only.campaignLabel} — ${
                only.cost?.firstFedDate && only.cost?.lastFedDate
                  ? `fed ${only.cost.firstFedDate} → ${only.cost.lastFedDate}`
                  : "no feeding recorded yet"
              }. Covers ${months.length} calendar month${months.length === 1 ? "" : "s"}` +
              `${months.length ? ` (${months.join(", ")})` : ""} — unticking it ` +
              "removes this column from the table and from the grade mix below."
            : `${n.id} ran in ${n.campaigns
                .map((c) => c.campaignYear)
                .join(", ")}. Ticking or unticking it toggles all ${total} of ` +
              "those columns at once; years switched off above are not touched.",
        };
      }),
    [nameGroups],
  );

  const shown = React.useMemo(
    () =>
      hidden.size === 0
        ? campaigns
        : campaigns.filter((r) => !hidden.has(campaignKey(r))),
    [campaigns, hidden],
  );

  /** R5 — the band's group report, mounted only while it is being printed. */
  const [printKeys, setPrintKeys] = React.useState<readonly MetricKey[] | null>(
    null,
  );
  const startPrint = React.useCallback(
    (_section: MetricSection, keys: readonly MetricKey[]) => setPrintKeys(keys),
    [],
  );
  const endPrint = React.useCallback(() => setPrintKeys(null), []);
  const printRows = React.useMemo(() => {
    if (!printKeys) return [];
    const byKey = new Map(matrix.rows.map((r) => [r.metric.key, r] as const));
    return printKeys
      .map((k) => byKey.get(k))
      .filter((r): r is MatrixRow<CampaignMatrixRow> => r != null);
  }, [printKeys, matrix.rows]);

  const expandedRow = React.useMemo(
    () => matrix.rows.find((r) => r.metric.key === selected) ?? null,
    [matrix.rows, selected],
  );

  /**
   * The newest campaign inside the displayed window — what the expand's side
   * rail describes. Same anchor rule the page's own expand uses.
   */
  const anchor: CampaignMatrixRow | null = React.useMemo(() => {
    const cols = matrix.periods.flatMap((p) => p.months);
    return cols[cols.length - 1] ?? campaigns[campaigns.length - 1] ?? null;
  }, [matrix.periods, campaigns]);

  /**
   * The headline figures, over the campaigns actually on screen — so the chips
   * describe the same window the table under them does. A chip quietly reading
   * every batch beside a filtered grid would be the page disagreeing with
   * itself.
   *
   * `kwhUnmappedPreCampaign` is carried on every row (it is the same plant-wide
   * figure everywhere) so it is READ rather than summed — adding it up across
   * campaigns would multiply one hole by the number of columns.
   */
  const summary = React.useMemo(() => {
    let fedKg = 0;
    let producedKg = 0;
    let reportedDays = 0;
    let kwh = 0;
    let suspectReadings = 0;
    let reasonOnly = 0;
    let downtimeRecords = 0;
    let reportedBatches = 0;
    for (const r of shown) {
      fedKg += r.cost?.fedKg ?? 0;
      producedKg += r.batch?.producedKg ?? 0;
      reportedDays += r.batch?.reportedDays ?? 0;
      kwh += r.batch?.kwh ?? 0;
      suspectReadings += r.batch?.kwhSuspectReadingCount ?? 0;
      reasonOnly += r.batch?.downtimeShiftsReasonOnly ?? 0;
      downtimeRecords += r.batch?.downtimeShiftCount ?? 0;
      if (r.batch?.productionReported) reportedBatches += 1;
    }
    return {
      shownCount: shown.length,
      fedKg,
      producedKg,
      reportedDays,
      kwh,
      suspectReadings,
      reasonOnly,
      downtimeRecords,
      reportedBatches,
      unmappedKwh: batches[0]?.kwhUnmappedPreCampaign ?? null,
    };
  }, [shown, batches]);

  const filtered = hidden.size > 0;

  /**
   * The coverage line, as a footer ROW of the table itself.
   *
   * It is built here rather than declared as a metric because it is not one: it
   * has no rollup, no history and no expand, and giving it a fake spec so it
   * could be a row would have put a coverage note into the callout gate and
   * into the group print. It is built from `matrix.periods`, so it can never
   * carry a different number of cells than the columns above it.
   */
  const footer = (
    <tr className="h-[var(--an-h-7)] border-t bg-muted/20">
      <th
        scope="row"
        title="A campaign's true cost is only final once every block it fed has been closed and priced. This line says how far along that is."
        className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-11)] font-medium uppercase tracking-wide text-muted-foreground"
        style={{ left: 0 }}
      >
        Blocks closed / priced
      </th>
      {matrix.periods.map((p) => {
        const c = p.months[0]?.cost ?? null;
        return (
          <td
            key={p.key}
            className="border-l px-2 py-1 text-right"
            title={coverageSentence(c)}
          >
            <span
              className={cn(
                "font-mono text-[length:var(--bw-fs-11)] tabular-nums",
                c?.isFullyCovered ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {c?.blocksFed == null
                ? "—"
                : `${c.blocksClosed ?? 0}/${c.blocksFed} · ${c.blocksInPrice ?? 0}`}
            </span>
          </td>
        );
      })}
      <td
        className="border-l bg-muted/40 px-2 py-1 text-right"
        title="Across the campaigns shown: blocks closed and blocks fully priced, out of every block they fed."
      >
        <span className="font-mono text-[length:var(--bw-fs-11)] tabular-nums text-muted-foreground">
          {(() => {
            let fed = 0;
            let closed = 0;
            let priced = 0;
            for (const p of matrix.periods) {
              const c = p.months[0]?.cost;
              if (!c || c.blocksFed == null) continue;
              fed += c.blocksFed;
              closed += c.blocksClosed ?? 0;
              priced += c.blocksInPrice ?? 0;
            }
            return fed === 0 ? "—" : `${closed}/${fed} · ${priced}`;
          })()}
        </span>
      </td>
    </tr>
  );

  return (
    <section id="section-campaigns" className="flex scroll-mt-24 flex-col gap-3">
      <header
        className="bw-accent-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pl-2.5"
        style={{ "--bw-accent": SECTION_ACCENT.campaigns } as React.CSSProperties}
      >
        <div className="min-w-0">
          <h2
            className="text-[length:var(--bw-fs-13)] font-semibold uppercase tracking-wide"
            style={{ color: SECTION_ACCENT.campaigns }}
          >
            By production batch
          </h2>
          {/* ── R8 — THE TWO EXPLANATORY PARAGRAPHS ARE GONE ─────────────
              Renzo read the shipped page and asked for both to come out: the
              "a campaign is the unit the plant actually runs" paragraph and
              the "a column is a production batch, not a month" one, the
              second of which also carried the "Filtered to N of M batches"
              sentence. The COUNT survives — it is the small
              `1 of 3 years · 10 of 34 batches` line beside the dropdowns
              below, which is where a reader looks for it — and every
              definition those paragraphs spelled out is still one click away
              in the dictionary strip under the chips (the batch clock, the
              reported-days denominator, the grade mix). Prose that repeats a
              definition the page already carries is the thing that was cut,
              never the definition.

              ONE sentence stayed, because it is not an explanation: the merge
              between the two source views CHECKS that they agree about how
              much a campaign fed, and says so when they do not (measured 0 of
              32 today). A finding is not prose. */}
          {fedKgMismatches.length > 0 && (
            <p className="mt-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground">
                The two source views disagree about how much{" "}
                {fedKgMismatches.join(", ")} fed
              </strong>{" "}
              — the cost view&rsquo;s figure is the one shown, and this sentence
              exists because the merge checks rather than assumes.
            </p>
          )}
        </div>
        {/* ── The group's own controls ───────────────────────────────────
            R8 — TWO dropdowns, ONE selection. Year narrows the batch list
            beside it; both write the same `?bhide=` set of campaign labels. */}
        {/* `min-w-0` and NOT `shrink-0`: with two triggers plus the count
            sentence, a non-shrinking control block is wider than a 375 px
            screen and pushes the DOCUMENT into horizontal overflow — the one
            thing every table on this page is built to avoid. Shrinkable, its
            own `flex-wrap` puts the sentence on its own line instead. */}
        <span
          className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5"
          data-print-hide
        >
          <span className="text-[length:var(--bw-fs-115)] text-muted-foreground">
            {filtered
              ? `${
                  shownYears.size < yearGroups.length
                    ? `${shownYears.size} of ${yearGroups.length} years · `
                    : ""
                }${summary.shownCount} of ${campaigns.length} batches`
              : `${yearGroups.length} years · ${campaigns.length} campaigns · scroll left for older`}
          </span>
          <PeriodFilter
            label="Year"
            noun="year"
            nounPlural="years"
            align="end"
            options={yearOptions}
            hidden={hiddenYears}
            onChange={onYearChange}
            title="Choose which campaign years this table shows. Everything is on by default. A year is a shorthand for every batch inside it — unticking one removes all of its columns and drops its batches from the Batches list beside this one; ticking it back returns the year whole."
          />
          <PeriodFilter
            label="Batches"
            noun="batch"
            nounPlural="batches"
            align="end"
            options={batchOptions}
            hidden={hiddenNames}
            onChange={onNameChange}
            title="Choose which production batches this table shows, by NAME — the list is January to December in the batches' own chronological order, never alphabetically, and it holds only the names that exist inside the years selected beside it. A name that ran in more than one selected year toggles every one of those columns at once. It also narrows the grade mix below."
          />
        </span>
      </header>

      {/* ── The selection at a glance ─────────────────────────────────── */}
      {/* R8 — THREE chips, not four. The Power chip went with the Power row:
          a selection chip is a headline for a row on the table beneath it, and
          a headline for a figure that is no longer published is a figure with
          nowhere to go and check. `sm:grid-cols-3` so three chips fill the
          strip rather than leaving a gap where the fourth was. */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-2 sm:grid-cols-3">
        <Chip
          label="Fed"
          value={t1(summary.fedKg)}
          unit="T"
          title={`Everything the ${summary.shownCount} batch${summary.shownCount === 1 ? "" : "es"} shown fed to the plant, as the Charcoal fed row publishes it. Destination MAIN only — a pull taken out of a block for sun-drying is not plant feed.`}
        />
        <Chip
          label="Made"
          value={t1(summary.producedKg)}
          unit="T"
          title={`Everything the plant produced across the batches shown, as the Produced row publishes it. The grade table below re-cuts this same figure by product; it is never re-added.`}
        />
        <Chip
          label="Top grade"
          value={pct1(gradeSet.topGradeSharePct)}
          unit="%"
          note={gradeSet.topGrade ?? undefined}
          title={`${gradeSet.topGrade ?? "—"} was ${pct1(gradeSet.topGradeSharePct)}% of everything made across the batches shown, out of ${gradeSet.gradeCount} grade${gradeSet.gradeCount === 1 ? "" : "s"}. A magnitude, not a verdict — nothing on this page turns amber because a share is high.`}
        />
      </div>

      <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--bw-fs-115)] text-muted-foreground">
        <Factory className="size-3 shrink-0" aria-hidden />
        <span className="inline-flex items-center gap-1">
          The batch clock
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.batch_clock.label}
            sublabel={PRODUCTION_DICTIONARY.batch_clock.sublabel}
            entry={PRODUCTION_DICTIONARY.batch_clock.dictionary}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          · Reported days, not working days
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.reported_days.label}
            sublabel={PRODUCTION_DICTIONARY.reported_days.sublabel}
            entry={PRODUCTION_DICTIONARY.reported_days.dictionary}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          · Grade mix
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.grade_mix.label}
            sublabel={PRODUCTION_DICTIONARY.grade_mix.sublabel}
            entry={PRODUCTION_DICTIONARY.grade_mix.dictionary}
          />
        </span>
        <span title={`Days production actually reported across the batches shown — the plant's own denominator, deliberately NOT the yard's working days. A changeover day belongs to two batches and both really did run it, so these counts add to slightly more than the calendar.`}>
          · {summary.reportedDays.toLocaleString("en-US")} reported days over{" "}
          {summary.reportedBatches} reporting batch
          {summary.reportedBatches === 1 ? "" : "es"}
        </span>
        {/* R8 — the DOWNTIME and PRE-CAMPAIGN kWh notes were here, and they
            went with the rows they annotated. Both were caveats ABOUT a
            published figure ("those hours are missing from the Downtime row",
            "that electricity belongs to no batch on this clock"), and a
            caveat about a figure the table no longer prints points at
            nothing. The measurements themselves are untouched in SQL and
            still arrive on every `ProductionBatchRow`; the calendar
            production views carry the same facts by month. */}
      </div>

      {/* ── The eleven rows, in the page's own table language ──────────
          Rendered by the SAME component as the matrix at the top, through the
          SAME fold machinery — so a purchase record, a campaign's cost and a
          production record are judged by identical rules, on their own
          clocks. */}
      <AnalyticsMatrix
        matrix={matrix}
        selected={selected}
        onSelect={onSelect}
        perWorkingDay={false}
        comparison={comparison}
        sections={CAMPAIGN_BAND}
        onPrintSection={startPrint}
        printingSection={printKeys ? "campaigns" : null}
        footer={footer}
        expand={
          expandedRow ? (
            <MetricExpand
              // Keyed by metric — a fresh, all-batches-checked filter per card.
              key={expandedRow.metric.key}
              row={expandedRow}
              granularity={CAMPAIGN_GRANULARITY}
              allPeriods={matrix.allPeriods}
              foldOptions={matrix.foldOptions}
              rules={matrix.rules}
              totalLabel={matrix.totalLabel}
              totalFullLabel={matrix.totalFullLabel}
              sideRail={
                <BatchSideRail spec={expandedRow.metric} campaign={anchor} />
              }
              perWorkingDay={false}
              scopeLabel={printScope}
              asOfDate={asOfDate}
              showDictionary={showDictionary}
              onClose={() => onSelect(null)}
            />
          ) : undefined
        }
      />

      {/* ── R8 — THE FOOTNOTE UNDER THE TABLE IS GONE ─────────────────────
          It explained the `~` and the `—`, and it re-stated the two ₱ per
          produced kg rows as "the same question asked twice". Renzo asked for
          it out. The one load-bearing half — what the two marks MEAN — moved
          into `MARK_LEGEND` in `lib/analytics/campaign-matrix.ts`, appended to
          the dictionary caveat of the three rows that can actually print a
          `~`, so the master `Definitions` switch still explains it and a
          reader meets it beside the figure instead of below the table. The
          other half was a restatement of two row labels that already say it.

          NOTHING replaces it for a price-restricted reader either: the four ₱
          rows already render locked with their own restricted panel, which is
          a stronger statement than a sentence at the bottom of the page. */}

      {/* ── The grade mix ──────────────────────────────────────────────
          Same columns as the table above it, driven by the same checklist. */}
      <ProductionGrades
        data={gradeSet}
        truncated={grades.truncated}
        showDictionary={showDictionary}
        scopeLabel={printScope}
        asOfDate={asOfDate}
      />

      {/* R5 — the band's group report, while it is printing. */}
      {printKeys && printRows.length > 0 && (
        <GroupPrintStage
          title="By production batch"
          subtitle={`${
            filtered
              ? `${summary.shownCount} of ${campaigns.length} production batches`
              : `all ${campaigns.length} production batches`
          }${asOfDate ? ` · records through ${asOfDate}` : ""}`}
          countLabel={`${printRows.length} metric${printRows.length === 1 ? "" : "s"}`}
          onDone={endPrint}
        >
          {printRows.map((r) => (
            <GroupPrintPage key={r.metric.key}>
              <MetricExpand
                row={r}
                granularity={CAMPAIGN_GRANULARITY}
                allPeriods={matrix.allPeriods}
                foldOptions={matrix.foldOptions}
                rules={matrix.rules}
                totalLabel={matrix.totalLabel}
                totalFullLabel={matrix.totalFullLabel}
                sideRail={<BatchSideRail spec={r.metric} campaign={anchor} />}
                perWorkingDay={false}
                scopeLabel={printScope}
                asOfDate={asOfDate}
                showDictionary={showDictionary}
                onClose={endPrint}
              />
            </GroupPrintPage>
          ))}
        </GroupPrintStage>
      )}
    </section>
  );
}
