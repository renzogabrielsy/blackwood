// No 'use client' — async Server Component.
//
// /analytics — the ICTC owner's month-on-month room. The Home Digest answers
// "what happened today"; this answers "what has been happening", one KPI per
// row and one period per column.
//
// It owns DATA FETCHING and the ₱ GATE, and nothing else. `getAnalyticsData()`
// (the adapter, `lib/analytics/queries.ts`) reads the three `view_analytics_*`
// views plus the LIVE blocking grid, resolves `canViewPrices()` server-side and
// nulls the four ₱ fields BEFORE the payload leaves the server — the network
// response is the leak, so nothing is hidden client-side.
//
// The navbar owns the page title and description (`getBreadcrumb()`), so this
// page renders no heading of its own.
//
// `searchParams` resolves the OPENING view — a shared link renders correctly on
// the first paint rather than after a client effect. From then on the shell
// keeps the address bar in step with `history.replaceState`, because every
// control here re-slices a payload the browser already holds and none of them
// changes what the server reads (see `analytics-view.tsx`).

import { getAnalyticsData } from "@/lib/analytics/queries";
import type { AnalyticsData } from "@/lib/analytics/types";
import type { Granularity } from "@/lib/analytics/matrix";
import { METRIC_BY_KEY, type MetricKey } from "@/lib/analytics/metrics";
import { AnalyticsView } from "./analytics-view";
import { AnalyticsError } from "./analytics-error";

/** Same page-shell container the Home Digest uses, so the two rooms line up. */
const SHELL_CLS =
  "mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5";

type Param = string | string[] | undefined;

function first(v: Param): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function resolveGranularity(raw: Param): Granularity {
  const v = first(raw)?.toUpperCase();
  return v === "Y" || v === "Q" || v === "M" ? v : "M";
}

function resolveYear(raw: Param, years: readonly number[], fallback: number): number {
  const v = Number(first(raw));
  return Number.isInteger(v) && years.includes(v) ? v : fallback;
}

function resolveMetric(raw: Param): MetricKey | null {
  const v = first(raw);
  return v && METRIC_BY_KEY.has(v as MetricKey) ? (v as MetricKey) : null;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>;
}) {
  const params = await searchParams;

  // Fetch INSIDE try/catch, render OUTSIDE it — JSX built inside a try/catch
  // would not have its render errors caught (React renders lazily).
  let data: AnalyticsData | null = null;
  let error: string | null = null;
  try {
    data = await getAnalyticsData();
  } catch (err) {
    error =
      err instanceof Error ? err.message : "Failed to load analytics data.";
  }

  if (!data || error) {
    return (
      <div className={SHELL_CLS}>
        <AnalyticsError message={error ?? "Failed to load analytics data."} />
      </div>
    );
  }

  if (data.months.length === 0) {
    return (
      <div className={SHELL_CLS}>
        <div className="rounded-lg border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No delivery or feeding records yet — there is nothing to chart.
        </div>
      </div>
    );
  }

  return (
    <div className={SHELL_CLS}>
      <AnalyticsView
        data={data}
        initialYear={resolveYear(params.year, data.years, data.defaultYear)}
        initialGranularity={resolveGranularity(params.g)}
        initialPerWorkingDay={first(params.wd) === "1"}
        initialMetric={resolveMetric(params.metric)}
      />
    </div>
  );
}
