/**
 * DEMO 4 of 4 — "ANALYST BRIEF" (SERVER COMPONENT)
 *
 * Fetches the live monthly delivery analytics from the backend data layer
 * (actions.ts → fetchMonthlyDeliveryAnalytics, which reads the SQL views) and
 * hands the normalized payload to the client component for all interactivity.
 *
 * On failure we pass an `error` string down so the client can render the
 * canonical persistent + copyable error UI (HARD error rule).
 */

import { fetchMonthlyDeliveryAnalytics } from './actions';
import AnalystBriefClient from './analyst-brief-client';

export default async function AnalystBriefDemoPage() {
  // Fetch INSIDE try/catch, render OUTSIDE it — constructing JSX inside a
  // try/catch wouldn't actually catch render errors (React renders lazily).
  let data: Awaited<ReturnType<typeof fetchMonthlyDeliveryAnalytics>> | null =
    null;
  let error: string | null = null;
  try {
    data = await fetchMonthlyDeliveryAnalytics();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load delivery analytics.';
  }

  if (error || !data) {
    return (
      <AnalystBriefClient
        years={[]}
        byYear={{}}
        totalsByYear={{}}
        canViewPrices={false}
        error={error ?? 'Failed to load delivery analytics.'}
      />
    );
  }

  return <AnalystBriefClient {...data} />;
}
