// `/production/schedule` — the Production Schedule's OWN route. Renders the real
// editable month grid, not a redirect.
//
// WHY THIS IS NO LONGER A REDIRECT (read with docs/BUG_LEDGER.md → BUG-003):
// BUG-003 was never "this URL is wrong" — it was "this URL wrongly inherits the
// Daily · Electricity · Trucks tab shell from app/(app)/production/layout.tsx".
// The ledger's own fix spec ends with "Keep `/production/schedule` as redirect
// (or deep-link alias)", and its Fallback (S) is exactly the route-group escape
// now in place: the tab shell moved into `app/(app)/production/(tabs)/`, so this
// route sits OUTSIDE it and the shell never reaches it. The bug stays fixed; the
// URL a user would naturally try now works.
//
// The redirect had a real cost: the schedule was reachable only by finding a
// toggle on `/`, so the editor read as "never shipped". Two doors, ONE surface —
// this page and `/?view=schedule` render the SAME `<ScheduleMonthView />` in the
// SAME `HOME_SHELL_CLS` container, with the same server-side data loading. There
// is no second implementation to drift.
//
// The page renders no title/description header — the navbar owns those
// (getBreadcrumb → `/production/schedule`).
import { ScheduleMonthView } from "@/components/digest/schedule-month-view";
import { HOME_SHELL_CLS } from "@/components/digest/shell";

export default async function ProductionSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;

  return (
    <div className={HOME_SHELL_CLS}>
      {/* Month nav stays on THIS route (basePath), and there is no sibling
          param to preserve — `?view=` means nothing here. */}
      <ScheduleMonthView month={month} basePath="/production/schedule" />
    </div>
  );
}
