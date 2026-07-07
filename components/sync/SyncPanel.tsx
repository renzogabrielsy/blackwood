'use client'

import * as React from 'react'
import { X, Zap } from 'lucide-react'

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/components/providers/auth-context'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { useJarvis } from '@/components/jarvis/JarvisProvider'
import { SyncPanelBody } from './SyncPanelBody'
import { useSyncRun } from './useSyncRun'

/**
 * DORMANT — the original "Run Sync" slide-out panel. The Daily Sync UI now lives
 * on the dashboard as a MODAL (`SyncLauncher.tsx` → Dialog wrapping the shared
 * `SyncPanelBody`). This Sheet version is no longer mounted in `app-shell.tsx`
 * and depends on the (also-retired) `JarvisProvider`. Kept in the repo as a
 * reference — same policy as the dormant Jarvis chat. Do NOT re-mount without
 * restoring `JarvisProvider`.
 *
 * Restricted to Owner / Admin / Dev — under-privileged roles never render the
 * panel body.
 */
export function SyncPanel() {
  const { open, setOpen } = useJarvis()
  const { role } = useAuth()
  const { state, run, stop } = useSyncRun()

  const privileged = PRIVILEGED_ROLES.includes(role)

  return (
    <Sheet open={open && privileged} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn('p-0 sm:max-w-[440px] w-full', 'flex flex-col gap-0')}
      >
        {/* Header */}
        <div className="flex-none border-b border-border bg-background/90 backdrop-blur-sm">
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
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
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close sync panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </SheetClose>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3">
          <SyncPanelBody state={state} run={run} stop={stop} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
