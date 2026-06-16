/**
 * SUMMARIES — Delivery price & volume analysis (SERVER COMPONENT)
 *
 * Permanent home for the "analyst brief" work that began life as
 * price-demos/demo4. This page owns DATA FETCHING only: it reuses the existing
 * `fetchMonthlyDeliveryAnalytics` action from demo4 (imported, NOT duplicated —
 * demo4 keeps working) for the period view, and the co-located
 * `fetchSupplierAnalytics` action for the supplier view, then hands both
 * normalized payloads to the client shell. The shell renders a top-level view
 * toggle:
 *   • "By Period"   → AnalystBriefClient (period analytics).
 *   • "By Supplier" → SupplierBriefClient (supplier analytics).
 *
 * Each fetch is wrapped in its own try/catch; on failure we pass an `error`
 * string down so the relevant view renders the canonical persistent + copyable
 * error UI.
 */

import { fetchMonthlyDeliveryAnalytics } from '../price-demos/demo4/actions';
import { fetchSupplierAnalytics } from './actions';
import { SummariesClient } from './summaries-client';

export default async function SummariesPage() {
  // Fetch INSIDE try/catch, render OUTSIDE it — constructing JSX inside a
  // try/catch wouldn't catch render errors (React renders lazily).
  let periodData: Awaited<
    ReturnType<typeof fetchMonthlyDeliveryAnalytics>
  > | null = null;
  let periodError: string | null = null;
  try {
    periodData = await fetchMonthlyDeliveryAnalytics();
  } catch (err) {
    periodError =
      err instanceof Error ? err.message : 'Failed to load delivery analytics.';
  }

  let supplierData: Awaited<ReturnType<typeof fetchSupplierAnalytics>> | null =
    null;
  let supplierError: string | null = null;
  try {
    supplierData = await fetchSupplierAnalytics();
  } catch (err) {
    supplierError =
      err instanceof Error ? err.message : 'Failed to load supplier analytics.';
  }

  const period =
    periodError || !periodData
      ? {
          years: [],
          byYear: {},
          totalsByYear: {},
          canViewPrices: false,
          error: periodError ?? 'Failed to load delivery analytics.',
        }
      : periodData;

  const supplier =
    supplierError || !supplierData
      ? {
          years: [],
          byYear: {},
          canViewPrices: false,
          error: supplierError ?? 'Failed to load supplier analytics.',
        }
      : supplierData;

  return <SummariesClient period={period} supplier={supplier} />;
}
