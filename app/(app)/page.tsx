// No 'use client' — async Server Component (Daily Sync Digest).
// Replaces the archived modular widget dashboard (see _archived/dashboard-v1).
//
// `/` hosts TWO surfaces, switched by `?view=digest|schedule` (default `digest`,
// which OMITS the param). The branch happens HERE, server-side, so only the
// selected surface's queries run — the toggle (HomeViewToggle) merely writes the
// URL. The schedule surface used to be the `/production/schedule` route, which
// wrongly inherited the production tab shell (BUG-003); that route now redirects
// here.
import Link from "next/link";
import { cn } from "@/lib/utils";
import { getDigestData } from "@/lib/digest/queries";
import { HomeViewToggle, type HomeView } from "@/components/digest/home-view-toggle";
import { ScheduleMonthView } from "@/components/digest/schedule-month-view";
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
import { DigestAutoRefresh } from "@/components/digest/digest-auto-refresh";
import { SyncLauncher } from "@/components/sync/SyncLauncher";

/** Shared page shell — same container for both views so the toggle never shifts. */
const SHELL_CLS =
  "mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const { view: viewParam, month } = await searchParams;
  // Default view is the digest — any unknown/absent value falls back to it.
  const view: HomeView = viewParam === "schedule" ? "schedule" : "digest";

  if (view === "schedule") {
    return (
      <div className={SHELL_CLS}>
        <HomeViewToggle view="schedule" />
        {/* Month nav keeps `view=schedule` alive alongside `?month=`. */}
        <ScheduleMonthView
          month={month}
          basePath="/"
          extraParams={{ view: "schedule" }}
        />
      </div>
    );
  }

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

      {/* A0. View switcher — digest board ↔ production schedule (URL-driven). */}
      <HomeViewToggle view="digest" />

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
                href="/?view=schedule"
                className="text-[11px] font-medium text-primary hover:underline"
              >
                View full schedule →
              </Link>
            </div>
          </div>
          <WeekStrip week={data.weekPlan} />
        </section>
      )}

      {/* A4. Snapshot row — the compact rolling 10-day schedule table paired
          BESIDE the Open Blocks card grid on wide screens (lg: 2 columns), so
          two dense "current snapshot" bands share one row instead of stacking
          full-width — reclaiming vertical space at the top of the digest. Each
          renders only when it has content; a lone survivor spans the full width
          (no lg:grid-cols-2). Both stack in a single column on mobile. */}
      {(data.schedulePreview.length > 0 || data.openBlocks.length > 0) && (
        <section
          className={cn(
            "grid items-start gap-4 sm:gap-6",
            data.schedulePreview.length > 0 &&
              data.openBlocks.length > 0 &&
              "lg:grid-cols-2"
          )}
        >
          {data.schedulePreview.length > 0 && (
            <SchedulePreview rows={data.schedulePreview} />
          )}
          {data.openBlocks.length > 0 && (
            <OpenBlocks
              openBlocks={data.openBlocks}
              operationalDate={data.meta.operationalDate}
            />
          )}
        </section>
      )}

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
          productionHours={data.productionHours}
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
