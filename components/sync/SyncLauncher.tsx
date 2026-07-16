'use client'

import * as React from 'react'
import { RefreshCw, Zap } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAuth } from '@/components/providers/auth-context'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { SyncPanelBody } from './SyncPanelBody'
import { useSyncRun } from './useSyncRun'

/**
 * Dashboard-mounted "Run Sync" launcher — the replacement for the retired
 * floating button. A compact zinc button that lives in the digest header band
 * and opens the Daily Sync.
 *
 * Two surfaces, ONE state: a centered **Dialog** at `sm`+ (desktop, unchanged)
 * and a bottom **Sheet** below `sm` (phones — first-class "kick a sync + watch
 * it live from a phone" flow). A `min-width: 640px` media query picks exactly
 * ONE surface to mount per viewport — a CSS `hidden sm:block` split can't work
 * here because both Dialog and Sheet PORTAL their content to `document.body`, so
 * mounting both would double the overlay + focus trap. Both surfaces are fed the
 * SAME lifted `useSyncRun()` and the SAME `open`/`setOpen`, so a run opened on
 * one is still live if the viewport flips (rotation/resize) mid-run.
 *
 * `useSyncRun()` is lifted HERE (above the modal boundary), so closing the modal
 * mid-run does NOT kill the stream — the hook state survives, and reopening shows
 * the run still live. Restricted to Owner / Admin / Dev; every server action + the
 * SSE route re-enforce this server-side, so this gate is purely to hide the UI.
 */
export function SyncLauncher() {
  const { role } = useAuth()
  const { state, run, stop } = useSyncRun()
  const [open, setOpen] = React.useState(false)
  // Tailwind's `sm` breakpoint (640px). `false` on the server + first client
  // paint → the modal is closed then anyway, so no flash.
  const isSmUp = useMediaQuery('(min-width: 640px)')

  // Run Sync is Owner/Admin/Dev only — never render the launcher for others.
  if (!PRIVILEGED_ROLES.includes(role)) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Open Daily Sync"
        className={cn(
          // ≥44px touch target on phones; original compact 32px height at sm+.
          'h-11 gap-1.5 px-3 text-xs font-medium sm:h-8 sm:px-3',
          'border-zinc-300 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900',
          'dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-zinc-50'
        )}
      >
        {state.running ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Zap className="h-3.5 w-3.5" />
        )}
        {state.running ? 'Syncing…' : 'Run Sync'}
      </Button>

      {isSmUp ? (
        /* ── Desktop / tablet (sm+): centered Dialog — unchanged behavior ── */
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton
            className="max-h-[85dvh] gap-0 overflow-y-auto p-0 pb-[max(0px,env(safe-area-inset-bottom))] sm:max-w-3xl"
          >
            {/* Sticky glass header (glass pattern for sticky dialog headers) */}
            <DialogHeader className="sticky top-0 z-10 flex-none space-y-0 border-b border-border bg-background/90 px-4 py-3 text-left backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Zap className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-sm font-semibold tracking-tight">
                    Daily Sync
                  </DialogTitle>
                  <DialogDescription className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    Ingest today&apos;s reports
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="px-3 pb-3">
              <SyncPanelBody state={state} run={run} stop={stop} />
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        /* ── Phones (below sm): bottom Sheet — first-class watch-live surface ── */
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton
            className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-2xl p-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            {/* Sticky glass header — mirrors the Dialog's title bar exactly. */}
            <SheetHeader className="sticky top-0 z-10 flex-none space-y-0 border-b border-border bg-background/90 px-4 py-3 text-left backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Zap className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <SheetTitle className="text-sm font-semibold tracking-tight">
                    Daily Sync
                  </SheetTitle>
                  <SheetDescription className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    Ingest today&apos;s reports
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="px-3 pb-3">
              <SyncPanelBody state={state} run={run} stop={stop} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
