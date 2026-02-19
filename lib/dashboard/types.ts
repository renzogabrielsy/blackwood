/* ===================================================
   Dashboard Shared Types
   Extracted here to avoid circular imports between
   DashboardGrid.tsx and profile-store.ts.
   =================================================== */

import type { ChartInstanceSettings } from '@/components/widgets/chart/types'
import type { KPIStripSettings } from '@/components/widgets/kpi-strip/types'

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number }

export interface D6Prefs {
  layout: LayoutItem[]
  visibleModules: string[]
  collapsed: string[]
  widgetSettings: Record<string, ChartInstanceSettings>
  kpiSettings?: KPIStripSettings
  stickyKpi?: boolean
  /** Layout snapshot saved immediately before pinning, used to restore on unpin */
  prePinLayout?: LayoutItem[]
}
