'use client'

// Keeps the Home Daily Sync Digest fresh after a sync finishes — WITHOUT a full
// page reload.
//
// The digest board (`app/(app)/page.tsx` → `DigestBoard`) is an async Server
// Component fed by `getDigestData()`. The RSC only runs on navigation, so once a
// sync run lands new rows the board keeps showing PRE-sync numbers until the user
// manually reloads. On the installed PWA (no service worker — just
// `app/manifest.ts`) that stale state is especially jarring: the app looks "open"
// but the data is hours old.
//
// This component (renders `null`) subscribes ONCE to Supabase Realtime on
// `public.sync_runs` and calls `router.refresh()` the moment a run reaches a
// TERMINAL status. `router.refresh()` re-runs the Server Component (re-invoking
// `getDigestData()`) and patches the DOM in place — client state and scroll are
// preserved, no cache-busting needed (the route is already dynamic).
//
// Why a Set of already-refreshed run ids, not a status compare: Realtime UPDATE
// payloads only carry the changed row's PK in `payload.old`, so we CANNOT read the
// previous status to detect the transition edge. A single run emits several
// UPDATEs (queued → running → terminal), and multiple report finishes can land
// near-simultaneously — the Set makes us refresh AT MOST once per run id, and the
// debounce coalesces the burst into a single refresh.
//
// Why no mount-time catch-up query and no polling: Realtime change events only
// fire for changes AFTER we subscribe, which is exactly what we want — react to
// NEW terminal transitions while the board is open. A run that was already
// terminal before mount must NOT trigger a refresh, or every page load would
// refresh-loop.

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { isTerminalRunStatus, type SyncRunRow, type SyncRunStatus } from '@/app/(app)/sync/types'

/**
 * Debounce window after a terminal signal before calling `router.refresh()`.
 * Coalesces the queued→running→terminal UPDATE burst — and multiple reports
 * finishing at nearly the same time — into ONE refresh.
 */
const REFRESH_DEBOUNCE_MS = 800

export function DigestAutoRefresh() {
  const router = useRouter()

  // Run ids we have already refreshed for — so a run emitting multiple terminal
  // UPDATEs (or an INSERT + UPDATE) refreshes the board at most once.
  const refreshedRef = React.useRef<Set<string>>(new Set())
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    const supabase = createClient()
    let mounted = true

    const handle = (
      payload: RealtimePostgresChangesPayload<Record<string, unknown>>
    ) => {
      if (!mounted) return
      const row = payload.new as unknown as SyncRunRow
      // Guard against a malformed / partial payload (Realtime UPDATE `new` is the
      // full row, but be defensive — never crash on a bad write).
      const status = row?.status as SyncRunStatus | undefined
      if (!status || !isTerminalRunStatus(status)) return
      if (!row.id || refreshedRef.current.has(row.id)) return

      // Mark now (not after the timer) so a second terminal UPDATE for the same
      // run during the debounce window can't schedule a duplicate refresh.
      refreshedRef.current.add(row.id)

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (!mounted) return
        router.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel('digest-auto-refresh')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sync_runs' },
        handle
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sync_runs' },
        handle
      )
      .subscribe()

    return () => {
      mounted = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      void supabase.removeChannel(channel)
    }
  }, [router])

  return null
}
