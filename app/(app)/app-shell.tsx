'use client'

import dynamic from 'next/dynamic'
import { FloatingStatusBar } from '@/components/floating-status-bar'
import { JarvisProvider } from '@/components/jarvis/JarvisProvider'
import { JarvisFloatingButton } from '@/components/jarvis/JarvisFloatingButton'

const Navbar = dynamic(
    () => import('@/components/navbar').then((m) => m.Navbar),
    { ssr: false }
)

// The floating button now opens the Daily Sync panel (the "Run Sync" button),
// not the Jarvis chat. The chat components remain in the repo (components/jarvis/)
// but are intentionally UNMOUNTED — JarvisChatPanel was previously mounted here.
// Lazy-load with ssr=false to avoid Radix Dialog hydration mismatches — same
// pattern the Navbar uses.
const SyncPanel = dynamic(
    () => import('@/components/sync/SyncPanel').then((m) => m.SyncPanel),
    { ssr: false }
)

export function AppShell({ children }: { children: React.ReactNode }) {
    return (
        <JarvisProvider>
            <div className="flex flex-col h-screen">
                <Navbar />
                <div className="flex-1 min-h-0 flex flex-col">{children}</div>
                <FloatingStatusBar />
                <JarvisFloatingButton />
                <SyncPanel />
            </div>
        </JarvisProvider>
    )
}
