'use client'

import dynamic from 'next/dynamic'
import { FloatingStatusBar } from '@/components/floating-status-bar'

const Navbar = dynamic(
    () => import('@/components/navbar').then((m) => m.Navbar),
    { ssr: false }
)

// RETIRED: the floating "Run Sync" FAB + its slide-out SyncPanel used to mount
// here, wrapped in <JarvisProvider>. The Daily Sync UI now lives on the dashboard
// as a MODAL — see components/sync/SyncLauncher.tsx, mounted in app/(app)/page.tsx.
//   - JarvisFloatingButton  -> unmounted (dormant; file kept, same policy as chat)
//   - SyncPanel (Sheet)     -> unmounted (dormant; content moved to SyncPanelBody)
//   - JarvisProvider        -> removed: its ONLY live consumers were the FAB +
//                              SyncPanel. The Jarvis chat (JarvisChatPanel) was
//                              already unmounted, so nothing else needs the
//                              provider or its Cmd+K toggle.
export function AppShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col h-screen">
            <Navbar />
            <div className="flex-1 min-h-0 flex flex-col">{children}</div>
            <FloatingStatusBar />
        </div>
    )
}
