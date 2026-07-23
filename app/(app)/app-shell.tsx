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
        <div className="flex flex-col h-dvh">
            <Navbar />
            {/* Horizontal safe-area insets for ALL page content (viewport-fit=cover):
                in landscape the notch eats one side of the display, so the content
                region is gutter-padded clear of it. The gutter is 0 on desktop and in
                portrait. The div paints no background of its own, so page/body
                backgrounds still reach the physical screen edge — backgrounds
                edge-to-edge, content inset. Root stays h-dvh. */}
            {/* Horizontal containment backstop (platform-wide): `min-w-0` lets this
                flex child shrink below its content's intrinsic width, and
                `overflow-x-clip` guarantees NO page can ever scroll the DOCUMENT
                sideways (the iPad-Mini-portrait navbar "black bar" bug). `clip` is
                used over `hidden` on purpose — it does NOT create a scroll container
                and does NOT force `overflow-y: auto`, so vertical page scroll and
                any descendant `position: sticky` keep working. Every legitimately
                wide table already scrolls inside its OWN `overflow-x-auto` wrapper
                ("never crush, always scroll"), so it is unaffected by this clamp. */}
            <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-x-clip safe-x">{children}</div>
            <FloatingStatusBar />
        </div>
    )
}
