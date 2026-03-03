'use client'

import dynamic from 'next/dynamic'
import { FloatingStatusBar } from '@/components/floating-status-bar'

const Navbar = dynamic(
    () => import('@/components/navbar').then((m) => m.Navbar),
    { ssr: false }
)

export function AppShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col h-screen">
            <Navbar />
            <div className="flex-1 min-h-0 flex flex-col">{children}</div>
            <FloatingStatusBar />
        </div>
    )
}
