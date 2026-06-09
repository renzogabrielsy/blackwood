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

export default async function DigestPage() {
  const data = await getDigestData();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6">
      {/* A. Header strip (sub-band — navbar owns the page title) */}
      <DigestHeader
        operationalDate={data.meta.operationalDate}
        lastSyncAt={data.meta.lastSyncAt}
        freshness={data.meta.freshness}
      />

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
