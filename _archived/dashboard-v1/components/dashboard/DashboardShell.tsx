'use client'

import dynamic from 'next/dynamic'
import type { DashboardGridProps } from './DashboardGrid'

/* ===================================================
   DashboardShell — SSR-safe wrapper for DashboardGrid
   ReactGridLayout and all Radix-based widget components
   require a browser environment — ssr: false prevents
   hydration mismatches.
   =================================================== */

const DashboardGrid = dynamic(
  () => import('./DashboardGrid').then(m => m.DashboardGrid),
  { ssr: false },
)

export function DashboardShell(props: DashboardGridProps) {
  return <DashboardGrid {...props} />
}
