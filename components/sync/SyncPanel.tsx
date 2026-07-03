'use client'

import * as React from 'react'
import { Play, RefreshCw, X, Zap } from 'lucide-react'

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
import { SYNC_REPORTS } from '@/app/(app)/sync/types'
import { useJarvis } from '@/components/jarvis/JarvisProvider'
import { SyncEmployeeCard } from './SyncEmployeeCard'
import { HeldRows } from './HeldRows'
import { useSyncRun } from './useSyncRun'

/**
 * The "Run Sync" slide-out panel. Reuses the Jarvis panel shell + glass patterns
 * (the FAB toggles this via the shared JarvisProvider `open` state). Restricted
 * to Owner / Admin / Dev — under-privileged roles never render the panel body.
 */
export function SyncPanel() {
  const { open, setOpen } = useJarvis()
  const { role } = useAuth()
  const { state, run, adjudicate } = useSyncRun()

  const privileged = PRIVILEGED_ROLES.includes(role)

  const idle = !state.running && !state.ran

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

        {/* Run button */}
        <div className="flex-none border-b border-border px-3 py-2.5">
          <Button
            type="button"
            className="w-full"
            disabled={state.running}
            onClick={() => void run()}
          >
            {state.running ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Running sync…
              </>
            ) : state.ran ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Run again
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run Sync
              </>
            )}
          </Button>
          {idle && (
            <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-muted-foreground">
              Classifies every report in parallel, auto-applies the clean rows, and holds anything
              that needs your judgment.
            </p>
          )}
        </div>

        {/* Employee cards */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 space-y-2">
          {SYNC_REPORTS.map((meta) => (
            <SyncEmployeeCard key={meta.type} card={state.cards[meta.type]} />
          ))}

          {/* Held rows */}
          <HeldRows groups={state.heldGroups} onAdjudicate={adjudicate} />
        </div>

        {/* Summary footer */}
        <div className="flex-none border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 py-2.5">
          {state.summarizing ? (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Summarizing the run…
            </p>
          ) : state.summary ? (
            <p className="animate-fade-up text-[11px] leading-snug text-foreground/90">
              {state.summary}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">
              Run summary appears here once the sync completes.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
