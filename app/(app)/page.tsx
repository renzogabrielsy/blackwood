// No 'use client' — async Server Component (Daily Sync Digest).
// Replaces the archived modular widget dashboard (see _archived/dashboard-v1).
import { getDigestData } from "@/lib/digest/queries";
import { DigestHeader } from "@/components/digest/digest-header";
import { KpiHero } from "@/components/digest/kpi-hero";
import { DigestCharts } from "@/components/digest/digest-charts";
import { SyncSummary } from "@/components/digest/sync-summary";
import { ActivityFeed } from "@/components/digest/activity-feed";
import { DigestFooterBand } from "@/components/digest/digest-footer-band";
import { TrucksSummary } from "@/components/digest/trucks-summary";
import { OpenBlocks } from "@/components/digest/open-blocks";
import { BagInventory } from "@/components/digest/bag-inventory";
import { SyncLauncher } from "@/components/sync/SyncLauncher";

export default async function DigestPage() {
  const data = await getDigestData();

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

      {/* Open blocks — current in-use inventory, surfaced at the very top (at-a-glance) */}
      <section>
        <OpenBlocks
          openBlocks={data.openBlocks}
          operationalDate={data.meta.operationalDate}
        />
      </section>

      {/* B. Hero — today's operations */}
      <section>
        <KpiHero kpis={data.kpis} />
      </section>

      {/* C. Rich charts */}
      <section>
        <DigestCharts flow={data.flow} price={data.price} grades={data.grades} />
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
