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
import type { ComparisonMode, Granularity } from "@/lib/analytics/matrix";
import { METRIC_BY_KEY, type MetricKey } from "@/lib/analytics/metrics";
import { CAMPAIGN_METRIC_BY_KEY } from "@/lib/analytics/campaign-matrix";
import { AnalyticsView } from "./analytics-view";
import { AnalyticsError } from "./analytics-error";
import { parseHidden } from "@/lib/analytics/period-selection";

/**
 * Same page-shell container the Home Digest uses, so the two rooms line up —
 * plus the two things owner feedback R3 added to it.
 *
 * **`bw-analytics`** carries the page's type + geometry scale (`globals.css`).
 * Every size on this page reads a variable, and this class is where the
 * big-screen values are switched on above 1920 px.
 *
 * **The container itself is relaxed at the same breakpoint.** `max-w-7xl` is
 * 1280 px, so on a 2560 px monitor the whole room was rendering inside HALF the
 * screen with empty gutters either side — which is most of what "does not
 * really scale well" was describing. 1760 px is chosen against the widest thing
 * on the page rather than picked for looks: the KPI matrix at its big scale and
 * a full nine-column year is 276 + 9x138 + 152 = 1670 px, so at 1760 the matrix
 * finally fits without scrolling sideways, and the page still leaves real
 * margin on a 2560 px screen rather than running edge to edge.
 */
const SHELL_CLS =
  "bw-analytics mx-auto flex w-full max-w-7xl min-[1920px]:max-w-[1760px] flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5";

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

/**
 * What the second chip under every value shows.
 *
 * R10 — `null` means THE ADDRESS SAID NOTHING. `cmp`, `wd` and `dict` have
 * always been spelled only in their non-default state, so an absent param was
 * already silence rather than a stated "no"; what changes is that the shell can
 * now tell the two apart, and let the reader's saved setting answer the silence.
 * A param that IS present still wins outright — a shared link must show its
 * recipient the same figures whatever their own habit is. An unrecognised value
 * is a statement too, and resolves to the default rather than to the preference.
 */
function resolveComparison(raw: Param): ComparisonMode | null {
  const v = first(raw);
  if (v == null) return null;
  return v === "actual" ? "actual" : "yoy";
}

/** `?wd=1` on, anything else stated off, absent = silent. See above. */
function resolvePerWorkingDay(raw: Param): boolean | null {
  const v = first(raw);
  if (v == null) return null;
  return v === "1";
}

/**
 * OWNER FEEDBACK R3 — the master `Definitions` switch.
 *
 * Spelled the way `wd` and `cmp` already are: the param exists ONLY in the
 * non-default state, so the default view keeps a clean address and the param's
 * presence always means something. It is the R2 hidden-set decision in its
 * smallest form — "on" cannot be encoded, so it cannot be forgotten.
 *
 * It IS in the URL rather than in session state because it describes the whole
 * page rather than one card's exploration of one row: it applies to every
 * expand at once, so a shared link carrying it means the same thing to whoever
 * opens it — which is exactly the test the expand's own Years filter fails.
 */
function resolveDictionary(raw: Param): boolean | null {
  const v = first(raw);
  if (v == null) return null;
  return v !== "off";
}

/**
 * R7 — the keys R7 retired, and the live row each one's question moved to.
 *
 * `rc_in_total` and `rc_out` were the yard's two undifferentiated totals, and
 * R7 replaced them with rows that say what they MEAN (Purchase volume · Usage).
 * **Both series are still drawn** — as the two companion lines inside the Net
 * flow row's expand — so a link that named either of them opens exactly where
 * its data now lives. That is a redirect to the same numbers, not a
 * substitution of a different figure for them.
 *
 * The two aging keys have no such home: `stock_age` and `over_120d` were
 * removed at Renzo's request and nothing on the page carries them any more, so
 * they resolve to nothing rather than to an arbitrary neighbour. A link that
 * opens no row still renders the whole page correctly.
 *
 * This map exists rather than an edit to the four Home Digest drill-down hrefs
 * because links shared out of this page over the last two days name these keys
 * too, and only one of the two fixes catches those.
 */
const RETIRED_METRIC_ALIASES: Readonly<Record<string, MetricKey>> = {
  rc_in_total: "net_flow",
  rc_out: "net_flow",
};

/**
 * R6 — BOTH registries are consulted, because the page has two clocks.
 *
 * The RC Inventory rows are read against calendar months and the campaign rows
 * against production batches, so they live in two registries rather than one —
 * but a `?metric=` deep link names a ROW, not a clock. Checking both is what
 * keeps every existing link resolving, including the four the Home Digest
 * drill-downs carry. A key belongs to exactly one of the two, so there is
 * nothing to disambiguate.
 */
function resolveMetric(raw: Param): MetricKey | null {
  const v = first(raw);
  if (!v) return null;
  const aliased = RETIRED_METRIC_ALIASES[v] ?? v;
  const known =
    METRIC_BY_KEY.has(aliased as MetricKey) ||
    CAMPAIGN_METRIC_BY_KEY.has(aliased);
  return known ? (aliased as MetricKey) : null;
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
        <div className="rounded-lg border bg-card px-4 py-12 text-center text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] text-muted-foreground">
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
        initialPerWorkingDay={resolvePerWorkingDay(params.wd)}
        initialComparison={resolveComparison(params.cmp)}
        initialMetric={resolveMetric(params.metric)}
        // OWNER FEEDBACK R2 — the switched-off period columns, resolved
        // server-side like every other control so a shared or refreshed
        // filtered view renders correctly on the FIRST paint. Absent means
        // every column, which is the default and the clean address.
        initialHidden={parseHidden(first(params.hide))}
        // OWNER FEEDBACK R5 — the switched-off production campaigns, spelled
        // exactly like `hide` and resolved by the same codec. It is in the URL
        // for the same reason `hide` is: it decides what is on screen — the
        // campaign panel's columns AND the months the production band covers —
        // so a link carrying it shows the recipient the same figures.
        initialHiddenCampaigns={parseHidden(first(params.bhide))}
        initialShowDictionary={resolveDictionary(params.dict)}
      />
    </div>
  );
}
