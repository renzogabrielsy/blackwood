"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RC OUT drill-down — kg fed out of the blocks.
//
// Same universal set as the RC IN reference (range toggle · big chart · stat
// strip · ONE breakdown dimension · the last few underlying rows · a link out),
// built from the SHARED parts so the two read as one product.
//
// THE RAIL RANKS BY BATCH, NOT BY DESTINATION. Measured over the view's
// 400-day window, feeding is 93.8% MAIN by row and 94.9% by kg — a destination
// rail would draw one bar and say nothing. `destination` is still carried, and
// is printed ONLY when a batch went somewhere other than MAIN, which is the
// case actually worth seeing (a SUNDRY move).
//
// NO ₱ ANYWHERE. `getRcOutDrilldown` never selects the computed
// `rc_out_avg_price` / `rc_out_avg_wtd_value` columns, so this surface has no
// price to gate and is safe for every role including Production.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { fmtKg } from "../format";
import {
  DrilldownChartSkeleton,
  DrilldownModal,
  DrilldownSection,
  DrilldownStat,
} from "./drilldown-modal";
import {
  BreakdownRail,
  TruncatedNotice,
  VolumeSeriesChart,
  asOfNote,
  bucketNoun,
  type RailItem,
} from "./series-parts";
import type { DrilldownModalState } from "./use-drilldown";
import {
  RANGE_LABEL,
  type RcOutDrilldown,
} from "@/lib/digest/drilldown-types";

/**
 * The wired modal — the ONE thing a caller mounts. Spread a
 * `useDrilldown(getRcOutDrilldown)` controller's `modalProps` onto it and pass
 * its `data`.
 */
export function RcOutDrilldownModal({
  data,
  ...modal
}: DrilldownModalState & { data: RcOutDrilldown | null }) {
  return (
    <DrilldownModal
      {...modal}
      title="RC Out"
      // The as-of joins the description once the payload lands — the skeleton
      // cannot know it, and inventing a placeholder date would be worse than a
      // line that grows by four words.
      description={`${RANGE_LABEL[modal.range]} · kg fed, by ${
        modal.range === "ytd" ? "month" : "day"
      }${asOfNote(data?.asOf)}`}
      skeleton={<DrilldownChartSkeleton stats={4} sideRail tableRows={6} />}
      footerLink={[
        { href: "/inventory/rc-out", label: "Open RC OUT" },
        { href: "/analytics?metric=rc_out", label: "Full analytics" },
      ]}
    >
      {data && <RcOutDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function RcOutDrilldownBody({ data }: { data: RcOutDrilldown }) {
  const { summary, granularity } = data;
  const noun = bucketNoun(granularity);

  const railItems = React.useMemo<RailItem[]>(
    () =>
      data.batches.map((b) => {
        // The block sits beside the code because "which block did this come
        // out of" is the next question after "which batch". A batch fed from
        // several blocks names the heaviest and counts the rest, rather than
        // silently picking one.
        const blockLabel =
          b.blockLoc == null
            ? null
            : b.blockCount > 1
              ? `${b.blockLoc} +${b.blockCount - 1}`
              : b.blockLoc;
        const meta =
          blockLabel || b.otherDestinations.length > 0 ? (
            <>
              {blockLabel}
              {b.otherDestinations.length > 0 && (
                <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  {b.otherDestinations.join(" · ")}
                </span>
              )}
            </>
          ) : undefined;

        const detail = [
          b.batchCode,
          `${b.feedings} feeding${b.feedings === 1 ? "" : "s"}`,
          b.blockLoc
            ? `block ${b.blockLoc}${b.blockCount > 1 ? ` (+${b.blockCount - 1} more)` : ""}`
            : "block not recorded",
          b.otherDestinations.length > 0
            ? `destination ${b.otherDestinations.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

        return {
          key: b.batchCode,
          label: b.batchCode,
          meta,
          value: fmtKg(b.kg),
          unit: "kg",
          sharePct: b.sharePct,
          title: detail,
        };
      }),
    [data.batches]
  );

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && <TruncatedNotice noun="feedings" module="RC OUT" />}

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Total fed"
          value={fmtKg(summary.total)}
          unit="kg"
          sub={`${summary.feedingCount.toLocaleString("en-US")} feeding${
            summary.feedingCount === 1 ? "" : "s"
          }`}
        />
        <DrilldownStat
          label={`Avg per active ${noun}`}
          value={
            summary.avgPerActiveBucket == null
              ? "—"
              : fmtKg(summary.avgPerActiveBucket)
          }
          unit={summary.avgPerActiveBucket == null ? undefined : "kg"}
          sub={`over ${summary.activeBuckets} ${noun}${
            summary.activeBuckets === 1 ? "" : "s"
          } with feeding`}
          title={`Mean of the ${noun}s the plant actually fed on — ${noun}s with no feeding are excluded.`}
        />
        <DrilldownStat
          label={`Peak ${noun}`}
          value={summary.peak ? fmtKg(summary.peak.value) : "—"}
          unit={summary.peak ? "kg" : undefined}
          sub={summary.peak ? summary.peak.bucket : "no feeding in range"}
        />
        <DrilldownStat
          label="Batches"
          value={summary.batchCount.toLocaleString("en-US")}
          sub="fed in this window"
        />
      </div>

      {/* ── Chart + batch rail ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
        <DrilldownSection
          title="Fed"
          subtitle={`by ${noun} · kg`}
          bodyClassName="p-2 pb-1"
        >
          <VolumeSeriesChart
            data={data.series}
            granularity={granularity}
            valueName="Fed"
            fmt={fmtKg}
            unit="kg"
            // chart-1 is the "Fed" hue in the digest's Feed In vs Out card —
            // an expanded chart must not recolour the series it expands.
            color="var(--chart-1)"
            // The mean line must contrast with chart-1 in BOTH themes:
            // chart-4 (yellow in light) all but vanishes over orange bars.
            avgColor="var(--chart-3)"
          />
        </DrilldownSection>

        <DrilldownSection
          title="By batch"
          subtitle={`${data.batches.length} in range`}
          bodyClassName="p-0"
        >
          <BreakdownRail
            items={railItems}
            emptyText="No feeding in this window."
            color="var(--chart-1)"
          />
        </DrilldownSection>
      </div>

      {/* ── Recent underlying rows (Excel Standard density) ── */}
      <DrilldownSection
        title="Recent feedings"
        subtitle={`latest ${data.recent.length}`}
        bodyClassName="p-0"
      >
        {data.recent.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No feeding in this window.
          </p>
        ) : (
          // "Never crush, always scroll": min-width = the 410px of fixed
          // columns + a 160px floor for the flexible Batch column, which is the
          // one column that would otherwise crush.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[570px] table-fixed text-xs">
              <colgroup>
                <col className="w-[110px]" />
                <col />
                <col className="w-[90px]" />
                <col className="w-[100px]" />
                <col className="w-[110px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Date</th>
                  <th className="px-2 py-1 text-left font-medium">Batch</th>
                  <th className="px-2 py-1 text-left font-medium">Block</th>
                  <th className="px-2 py-1 text-left font-medium">Dest</th>
                  <th className="px-2 py-1 text-right font-medium">Weight</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr
                    key={r.id}
                    className="h-8 border-b transition-all duration-150 last:border-0 hover:bg-muted/40"
                  >
                    <td className="truncate px-2 py-1 font-mono tabular-nums">
                      {r.date}
                    </td>
                    <td className="truncate px-2 py-1 font-mono" title={r.batchCode}>
                      {r.batchCode}
                    </td>
                    {/* A blank block_loc is UNRECORDED, not an empty block —
                        491 of 1,266 windowed rows carry one. */}
                    <td
                      className="truncate px-2 py-1 font-mono text-muted-foreground"
                      title={r.blockLoc ?? "Block not recorded"}
                    >
                      {r.blockLoc ?? "—"}
                    </td>
                    <td className="truncate px-2 py-1" title={r.destination}>
                      {r.destination}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {fmtKg(r.weightKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DrilldownSection>
    </div>
  );
}
