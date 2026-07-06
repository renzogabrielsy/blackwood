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
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/components/providers/auth-context'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { SyncPanelBody } from './SyncPanelBody'
import { useSyncRun } from './useSyncRun'

/**
 * Dashboard-mounted "Run Sync" launcher — the replacement for the retired
 * floating button. A compact zinc button that lives in the digest header band
 * and opens the Daily Sync as a MODAL.
 *
 * `useSyncRun()` is lifted HERE (above the Dialog), so closing the modal mid-run
 * does NOT kill the stream — the hook state survives, and reopening shows the run
 * still live. Restricted to Owner / Admin / Dev; every server action + the SSE
 * route re-enforce this server-side, so this gate is purely to hide the UI.
 */
export function SyncLauncher() {
  const { role } = useAuth()
  const { state, run, stop, adjudicate } = useSyncRun()
  const [open, setOpen] = React.useState(false)

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
          'h-8 gap-1.5 text-xs font-medium',
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton
          className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
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
            <SyncPanelBody state={state} run={run} stop={stop} adjudicate={adjudicate} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
