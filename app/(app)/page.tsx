// No 'use client' — async Server Component (Daily Sync Digest).
// Replaces the archived modular widget dashboard (see _archived/dashboard-v1).
import Link from "next/link";
import { getDigestData } from "@/lib/digest/queries";
import { DigestHeader } from "@/components/digest/digest-header";
import { PlantStatusHeader } from "@/components/digest/plant-status-header";
import { KpiHero } from "@/components/digest/kpi-hero";
import { DigestCharts } from "@/components/digest/digest-charts";
import { WeekStrip } from "@/components/digest/week-strip";
import { SchedulePreview } from "@/components/digest/schedule-preview";
import { SyncSummary } from "@/components/digest/sync-summary";
import { ActivityFeed } from "@/components/digest/activity-feed";
import { DigestFooterBand } from "@/components/digest/digest-footer-band";
import { TrucksSummary } from "@/components/digest/trucks-summary";
import { OpenBlocks } from "@/components/digest/open-blocks";
import { BagInventory } from "@/components/digest/bag-inventory";
import { SyncLauncher } from "@/components/sync/SyncLauncher";

export default async function DigestPage() {
  const data = await getDigestData();

  // Small presentational reads for the plant-status band (no aggregation).
  const fedKg = data.kpis.find((k) => k.key === "rc_out")?.value ?? 0;
  const streamsBehind = data.meta.streams.filter(
    (s) => s.status === "warn"
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6">
      {/* A. Header strip (sub-band — navbar owns the page title). The Daily Sync
          launcher (privileged-only modal trigger) lives in this top band,
          right-aligned, replacing the retired floating button. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <DigestHeader
            operationalDate={data.meta.operationalDate}
            lastSyncAt={data.meta.lastSyncAt}
            freshness={data.meta.freshness}
          />
        </div>
        <SyncLauncher />
      </div>

      {/* A2. Plant status — the operational date's running/rest state, planned
          setup, projected tons + fed kg (from the PROD SCHED plan). */}
      <section>
        <PlantStatusHeader
          operationalDate={data.meta.operationalDate}
          plantStatus={data.plantStatus}
          fedKg={fedKg}
          lastSyncAt={data.meta.lastSyncAt}
          freshness={data.meta.freshness}
          streamsBehind={streamsBehind}
        />
      </section>

      {/* A3. This week — plan vs actual, surfaced right below the plant status
          band (skips if there is no operational date). Links to the full
          Production Schedule table. */}
      {data.weekPlan.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              This week · plan vs actual
            </h2>
            <div className="flex items-baseline gap-3">
              <span className="text-[11px] text-muted-foreground">
                from the PROD SCHED plan
              </span>
              <Link
                href="/production/schedule"
                className="text-[11px] font-medium text-primary hover:underline"
              >
                View full schedule →
              </Link>
            </div>
          </div>
          <WeekStrip week={data.weekPlan} />
        </section>
      )}

      {/* A4. Production schedule table — a dense rolling ~2-week window, grouped
          with the schedule content at the top of the digest (complements the
          WeekStrip cards + the full page at /production/schedule). */}
      {data.schedulePreview.length > 0 && (
        <section>
          <SchedulePreview rows={data.schedulePreview} />
        </section>
      )}

      {/* Open blocks — current in-use inventory, surfaced at the top (at-a-glance) */}
      <section>
        <OpenBlocks
          openBlocks={data.openBlocks}
          operationalDate={data.meta.operationalDate}
        />
      </section>

      {/* B. Hero — today's operations, state-aware per stream (no misleading 0) */}
      <section>
        <KpiHero kpis={data.kpis} dayStatus={data.dayStatus} />
      </section>

      {/* C. Rich charts (flow chart is rest-day aware via the week plan) */}
      <section>
        <DigestCharts
          flow={data.flow}
          price={data.price}
          grades={data.grades}
          weekPlan={data.weekPlan}
        />
      </section>

      {/* C2. Trucks with a trip on the operational date (skips if none moved) */}
      <section>
        <TrucksSummary trucks={data.trucks} />
      </section>

      {/* C3. FLECON bag inventory snapshot */}
      <section>
        <BagInventory fleconBags={data.fleconBags} />
      </section>

      {/* D. Sync band — what the last sync brought in */}
      <section className="flex flex-col gap-3">
        <SyncSummary latestSync={data.latestSync} />
        <ActivityFeed activity={data.activity} />
      </section>

      {/* E. Flags + freshness + month-to-date */}
      <section>
        <DigestFooterBand
          flags={data.flags}
          streams={data.meta.streams}
          monthToDate={data.monthToDate}
        />
      </section>
    </div>
  );
}
