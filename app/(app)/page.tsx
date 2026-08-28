// No 'use client' — async Server Component (Daily Sync Digest).
// Replaces the archived modular widget dashboard (see _archived/dashboard-v1).
//
// `/` hosts EXACTLY ONE surface again (2026-08-28). It used to be a `?view=`
// switcher whose second branch was the editable Production Schedule; that whole
// feature was retired as redundant with Renzo's Google Sheet master (a future v2
// will be read-only and gsheet-backed). The toggle, the schedule bands and the
// `?view=` / `?month=` params went with it — see `_archived/prod-schedule-v1/`.
import { Suspense } from "react";
import { getDigestData } from "@/lib/digest/queries";
import { DigestHeader } from "@/components/digest/digest-header";
import { PlantStatusHeader } from "@/components/digest/plant-status-header";
import { KpiHero } from "@/components/digest/kpi-hero";
import { DigestCharts } from "@/components/digest/digest-charts";
import { SyncSummary } from "@/components/digest/sync-summary";
import { SyncNeedsYou } from "@/components/digest/sync-needs-you";
import { ActivityFeed } from "@/components/digest/activity-feed";
import { DigestFooterBand } from "@/components/digest/digest-footer-band";
import { TrucksSummary } from "@/components/digest/trucks-summary";
import { OpenBlocks } from "@/components/digest/open-blocks";
import { BagInventory } from "@/components/digest/bag-inventory";
import { ShipmentsBand, ShipmentsBandFallback } from "@/components/digest/shipments-band";
import { DigestAutoRefresh } from "@/components/digest/digest-auto-refresh";
import { SyncLauncher } from "@/components/sync/SyncLauncher";
// The page-shell container.
import { HOME_SHELL_CLS as SHELL_CLS } from "@/components/digest/shell";

export default async function HomePage() {
  return <DigestBoard />;
}

async function DigestBoard() {
  const data = await getDigestData();

  // Small presentational reads for the plant-status band (no aggregation).
  const fedKg = data.kpis.find((k) => k.key === "rc_out")?.value ?? 0;
  const streamsBehind = data.meta.streams.filter(
    (s) => s.status === "warn"
  ).length;

  return (
    <div className={SHELL_CLS}>
      {/* Auto-refresh the RSC when a sync run finishes (Realtime → router.refresh),
          so the board never shows stale pre-sync numbers — critical on the PWA.
          Renders null; position is cosmetic. */}
      <DigestAutoRefresh />

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

      {/* A2. Operational-day band — the date, kg fed, sync freshness and how many
          streams are behind. It used to also carry the PROD SCHED plan's
          running/rest beacon, planned setup and projected tons; the plan is gone
          (2026-08-28) and none of those are derivable from activity without
          guessing, so they were removed rather than faked. */}
      <section>
        <PlantStatusHeader
          operationalDate={data.meta.operationalDate}
          fedKg={fedKg}
          lastSyncAt={data.meta.lastSyncAt}
          freshness={data.meta.freshness}
          streamsBehind={streamsBehind}
        />
      </section>

      {/* A4. Open blocks — the "current snapshot" band. It used to share a
          two-column row with the rolling 10-day schedule preview; with the
          schedule retired it is alone, so it spans the full width. */}
      {data.openBlocks.length > 0 && (
        <section className="min-w-0">
          <OpenBlocks
            openBlocks={data.openBlocks}
            operationalDate={data.meta.operationalDate}
          />
        </section>
      )}

      {/* B. Hero — today's operations, state-aware per stream (no misleading 0) */}
      <section>
        <KpiHero kpis={data.kpis} dayStatus={data.dayStatus} />
      </section>

      {/* C. Rich charts */}
      <section>
        <DigestCharts
          flow={data.flow}
          price={data.price}
          grades={data.grades}
          productionHours={data.productionHours}
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

      {/* C4. Export shipments readiness (Trello). Its own <Suspense> boundary so
          the Trello fetch STREAMS in independently — the digest above is
          Supabase-only and never waits on Trello (slow/down Trello = late band,
          not a blocked home page). */}
      <section>
        <Suspense fallback={<ShipmentsBandFallback />}>
          <ShipmentsBand />
        </Suspense>
      </section>

      {/* D. Sync band — what the last sync brought in, and what of it is still
             waiting on a human. The "N need you" chip is the panel's OWN count
             (same flatten → same ack ledger), privileged-only and silent at zero;
             its own <Suspense> so the sync-run read never delays the band. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Last sync
          </h2>
          <Suspense fallback={null}>
            <SyncNeedsYou />
          </Suspense>
        </div>
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
