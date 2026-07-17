// Deep-link alias — REDIRECTS to the schedule's new home, `/?view=schedule`.
//
// The Production Schedule moved into the digest world (BUG-003): it is now a view
// toggle on `/` rather than a production sub-route, because living under
// `app/(app)/production/layout.tsx` wrongly wrapped it in the Daily · Electricity ·
// Trucks tab shell. The month table itself lives in
// `components/digest/schedule-month-view.tsx`.
//
// A redirect (not an aliased re-render) is deliberate: it leaves exactly ONE
// canonical URL for the schedule, so the breadcrumb, the toggle state, and any
// shared link all agree — an alias would keep a second surface rendering inside
// the production shell (the bug) and force the tab bar to be conditionally
// suppressed. `redirect()` throws before the page renders, so the shell never
// paints.
import { redirect } from "next/navigation";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function ProductionScheduleRedirect({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  const params = new URLSearchParams({ view: "schedule" });
  // Carry a valid ?month= cursor through so old deep links land on their month.
  if (month && MONTH_RE.test(month)) params.set("month", month);
  redirect(`/?${params.toString()}`);
}
