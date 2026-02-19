'use client'

import dynamic from 'next/dynamic'

const DashboardGrid = dynamic(
  () => import('@/components/dashboard/DashboardGrid').then(m => m.DashboardGrid),
  { ssr: false }
)

export default function DashboardPage() {
  return <DashboardGrid />
}
