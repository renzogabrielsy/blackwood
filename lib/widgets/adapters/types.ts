/* ===================================================
   Widget Adapter — Base Interface (Hexagonal Architecture)
   =================================================== */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A widget adapter transforms a raw data source into the typed port interface
 * that a specific widget declares. Adapters are pure async functions — no React,
 * no rendering logic. They are the only place where tenant/domain knowledge meets
 * the platform layer.
 *
 * TPort = the data-agnostic interface the widget accepts (e.g. KPIData[], ChartConfig)
 */
export interface WidgetAdapter<TPort> {
  /** Stable identifier for this adapter (e.g. 'charcoal-kpi') */
  id: string
  /** Fetch and transform data into the widget's port interface */
  fetch: (client: SupabaseClient) => Promise<TPort>
}
