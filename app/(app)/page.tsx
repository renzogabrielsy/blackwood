// No 'use client' — this is an async Server Component
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard/DashboardShell'
import { charcoalKpiAdapter } from '@/lib/widgets/adapters/charcoal-kpi'
import { charcoalChartAdapter } from '@/lib/widgets/adapters/charcoal-chart'
import { charcoalWarehouseAdapter } from '@/lib/widgets/adapters/charcoal-warehouse'
import { charcoalSpecialAdapter } from '@/lib/widgets/adapters/charcoal-special'
import { loadDashboardPrefs } from '@/app/(app)/actions'

function formatAdapterError(adapterId: string, reason: unknown): string {
  const timestamp = new Date().toISOString()
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack =
    reason instanceof Error && reason.stack
      ? `\nStack: ${reason.stack.split('\n').slice(0, 4).join('\n')}`
      : ''
  return `[Blackwood] Adapter "${adapterId}" failed at ${timestamp}\nError: ${message}${stack}`
}

export default async function DashboardPage() {
  const supabase = await createClient()

  const [kpiResult, chartResult, warehouseResult, specialChartResult, prefsResult] =
    await Promise.allSettled([
      charcoalKpiAdapter.fetch(supabase),
      charcoalChartAdapter.fetch(supabase),
      charcoalWarehouseAdapter.fetch(supabase),
      charcoalSpecialAdapter.fetch(supabase),
      loadDashboardPrefs(),
    ])

  return (
    <DashboardShell
      kpiData={kpiResult.status === 'fulfilled' ? kpiResult.value : undefined}
      kpiError={
        kpiResult.status === 'rejected'
          ? formatAdapterError('charcoal-kpi', kpiResult.reason)
          : undefined
      }
      chartConfig={chartResult.status === 'fulfilled' ? chartResult.value : undefined}
      chartError={
        chartResult.status === 'rejected'
          ? formatAdapterError('charcoal-chart', chartResult.reason)
          : undefined
      }
      warehouseData={warehouseResult.status === 'fulfilled' ? warehouseResult.value : undefined}
      warehouseError={
        warehouseResult.status === 'rejected'
          ? formatAdapterError('charcoal-warehouse', warehouseResult.reason)
          : undefined
      }
      specialChartData={specialChartResult.status === 'fulfilled' ? specialChartResult.value : undefined}
      specialChartError={
        specialChartResult.status === 'rejected'
          ? formatAdapterError('charcoal-special', specialChartResult.reason)
          : undefined
      }
      serverPrefs={prefsResult.status === 'fulfilled' ? prefsResult.value ?? undefined : undefined}
    />
  )
}
