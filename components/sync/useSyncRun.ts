'use client'

import * as React from 'react'

import { errorToast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import {
  adjudicateHeldRows,
  cancelSyncRun,
  enqueueSyncRun,
  narrateSyncRun,
  type NarrateInput,
} from '@/app/(app)/sync/actions'
import { autoInvestigateRun } from '@/app/(app)/sync/cases'
import {
  SYNC_REPORTS,
  isTerminalRunStatus,
  metaFor,
  type ApplyResult,
  type ClassifyResult,
  type HeldRow,
  type HeldRowRecommendation,
  type SyncCardState,
  type SyncProgressStage,
  type SyncReportType,
  type SyncRunEventRow,
  type SyncRunReportResult,
  type SyncRunResult,
  type SyncRunRow,
  type SyncRunStatus,
} from '@/app/(app)/sync/types'
import {
  applyEventToCard,
  deriveCardStatus,
  eventReportType,
  freshCard,
  gateErrorFrom,
  isRunTrack,
  projectEvent,
} from '@/lib/sync/reducer'
import { flattenRunFindings } from '@/lib/sync/findings'

/** Held-row group shown in the Held section, keyed by report type. */
export interface HeldGroup {
  type: SyncReportType
  rows: HeldRow[]
  /** null until "Ask Claude" is run for this group. */
  recommendations: HeldRowRecommendation[] | null
  adjudicating: boolean
}

/** A lightweight top-level ("_run") progress line, shown above the cards. */
export interface OverallProgress {
  stage: SyncProgressStage | null
  pct: number
  label: string | null
  warn: boolean
}

export interface SyncRunState {
  running: boolean
  cards: Record<SyncReportType, SyncCardState>
  heldGroups: HeldGroup[]
  /**
   * The raw terminal `sync_runs.result` payload of the watched run (null before a run
   * finishes / on a manifest-only or cancelled run). The panel flattens this with
   * `flattenRunFindings` to show EVERYTHING flagged — held rows PLUS every reconciliation
   * channel (source diffs, overdue single-source facts, unresolved batches, block diffs) —
   * not just `apply.held` (the old keyhole that showed 1 of 10).
   */
  result: SyncRunResult | null
  summary: string | null
  summarizing: boolean
  /** Set true once a run has completed (or been attached to) at least once. */
  ran: boolean
  /** The durable run currently being watched (null before the first run / attach). */
  runId: string | null
  /** Latest known lifecycle status of the watched run. */
  runStatus: SyncRunStatus | null
  /** True when we attached to a run that was ALREADY in flight (multi-viewer / reopen). */
  attached: boolean
  /** ISO timestamp the watched run started (for the "already running since HH:MM" note). */
  startedAt: string | null
  /** Non-fatal info line (e.g. "worker asleep — queued"). */
  notice: string | null
  /** The top-level workflow's own progress track (from `_run` events). */
  overall: OverallProgress
  /** True while a Stop request is in flight (disables the Stop button, prevents double-clicks). */
  cancelling: boolean
}

/** Realtime-degrade poll cadence while a run is non-terminal (mirror the bell). */
const POLL_MS = 3_000

/**
 * Attach-to-in-flight staleness guard (belt-and-suspenders with the worker's
 * watchdog): on mount we only ATTACH to a run that is genuinely live. A run older
 * than this with no recent event is treated as dead and NOT attached, so a stale row
 * can never re-strand the UI in a spinning state.
 */
const ATTACH_MAX_AGE_MS = 20 * 60 * 1000 // 20 min since created
const ATTACH_MAX_EVENT_GAP_MS = 15 * 60 * 1000 // 15 min since the newest event

function initialCards(): Record<SyncReportType, SyncCardState> {
  const entries = SYNC_REPORTS.map((r) => [r.type, freshCard(r.type)])
  return Object.fromEntries(entries) as Record<SyncReportType, SyncCardState>
}

function initialOverall(): OverallProgress {
  return { stage: null, pct: 0, label: null, warn: false }
}

/**
 * Orchestrates the durable, laptop-proof "Run Sync" flow (Wave 4B):
 *   1. `run()` writes a `sync_runs` row (queued) via `enqueueSyncRun` and kicks
 *      the worker; the worker does extract → classify → apply durably (DBOS).
 *   2. `sync_run_events` INSERTs (Supabase Realtime) patch each card's live
 *      progress — `report_type` keys the card; `_run` drives the overall line.
 *   3. The `sync_runs` UPDATE to a terminal status carries `result.reports`
 *      (per-report ClassifyResult/ApplyResult) → commit terminal card states →
 *      aggregate held rows → narrate. `SyncPanelBody` / `HeldRows` are unchanged.
 *
 * On mount it QUERIES the latest run + its events, so a reopened modal / second
 * viewer / post-refresh session ATTACHES to an in-flight run (the headline
 * feature — closing the laptop lid can't kill the run). A Realtime hiccup
 * degrades to a ~3s poll of the two tables (mirrors the notification bell).
 */
export function useSyncRun() {
  const [state, setState] = React.useState<SyncRunState>(() => ({
    running: false,
    cards: initialCards(),
    heldGroups: [],
    result: null,
    summary: null,
    summarizing: false,
    ran: false,
    runId: null,
    runStatus: null,
    attached: false,
    startedAt: null,
    notice: null,
    overall: initialOverall(),
    cancelling: false,
  }))

  // Mirror the latest committed state so finalizeRun can fold report results
  // SYNCHRONOUSLY (see the note there) instead of inside a deferred setState updater.
  // Updated in an effect (never during render); finalizeRun runs async after commit,
  // so the ref is current by the time it reads it.
  const stateRef = React.useRef(state)
  React.useEffect(() => {
    stateRef.current = state
  })

  // The run we are actively watching. Kept in a ref so the subscription effect
  // and the poll can read it without re-subscribing on every state change.
  const runIdRef = React.useRef<string | null>(null)
  // Track the highest event id we have applied per run, so a catch-up query after
  // a reconnect / poll never double-applies an event.
  const lastEventIdRef = React.useRef<number>(0)
  // Guard so the terminal transition (held aggregation + narration) runs once.
  const finalizedRef = React.useRef<string | null>(null)

  /** Apply one progress-event row to the matching card (or the overall line). */
  const applyEvent = React.useCallback(
    (row: SyncRunEventRow) => {
      const ev = projectEvent(row)
      if (!ev) return

      if (isRunTrack(row)) {
        setState((prev) => ({
          ...prev,
          overall: {
            stage: ev.stage,
            pct: Math.max(prev.overall.pct, ev.pct),
            label: ev.detail ? `${ev.label} · ${ev.detail}` : ev.label,
            warn: ev.level === 'warn',
          },
        }))
        return
      }

      const type = eventReportType(row)
      if (!type) return

      setState((prev) => ({
        ...prev,
        cards: { ...prev.cards, [type]: applyEventToCard(prev.cards[type], ev) },
      }))
    },
    []
  )

  /**
   * Apply an ordered batch of event rows (catch-up query / poll), skipping any we
   * have already applied. Bumps the high-water mark.
   */
  const applyEventBatch = React.useCallback(
    (rows: SyncRunEventRow[]) => {
      let maxId = lastEventIdRef.current
      for (const row of rows) {
        if (typeof row.id === 'number' && row.id <= lastEventIdRef.current) continue
        applyEvent(row)
        if (typeof row.id === 'number' && row.id > maxId) maxId = row.id
      }
      lastEventIdRef.current = maxId
    },
    [applyEvent]
  )

  /**
   * Commit the terminal `sync_runs` result: fold each report's ClassifyResult /
   * ApplyResult into its card, aggregate held rows, then narrate. Idempotent per
   * runId via `finalizedRef` (Realtime UPDATE + a poll can both observe terminal).
   */
  const finalizeRun = React.useCallback(
    async (runId: string, status: SyncRunStatus, result: SyncRunResult | null, errorText: string | null) => {
      if (finalizedRef.current === runId) return
      finalizedRef.current = runId

      const reports = result?.reports ?? null
      const cancelled = status === 'cancelled'

      // Fold per-report results into cards + build the settled list for aggregation.
      // Fold SYNCHRONOUSLY from the latest committed state (stateRef). `settled` MUST be
      // a real, populated array where heldGroups + the narration input read it below —
      // it was previously .push()ed INSIDE a setState updater, which React defers, so it
      // read EMPTY (→ blank held section + a false "Nothing new today" summary despite
      // real writes/held rows).
      const settled: SyncCardState[] = []
      const prevCards = stateRef.current.cards
      const foldedCards = { ...prevCards }
      for (const meta of SYNC_REPORTS) {
          const rep: SyncRunReportResult | undefined = reports?.[meta.type]
          const prevCard = prevCards[meta.type]
          let next: SyncCardState

          if (rep) {
            // A report finished (or was stopped) with a per-report envelope: fold it.
            // On a cancelled run, a report that never reached a terminal state settles
            // to 'stopped' (neutral) rather than 'done' — but a report that DID finish
            // keeps its real terminal status (its rows are legitimately written).
            const derived = deriveCardStatus(meta.type, rep)
            const cardStatus: SyncCardState['status'] =
              cancelled && (prevCard.status === 'classifying' || prevCard.status === 'applying')
                ? 'stopped'
                : derived
            next = {
              ...prevCard,
              status: cardStatus,
              classify: rep.classify ?? prevCard.classify,
              apply: rep.apply ?? prevCard.apply,
              error: rep.error ?? gateErrorFrom(rep) ?? null,
            }
          } else if (
            prevCard.status === 'classifying' ||
            prevCard.status === 'applying'
          ) {
            // No per-report result (M0/M1 manifest, a report the worker didn't run,
            // or a stop before this report produced an envelope): don't leave the card
            // spinning — settle it by the run's own status. Cancelled → 'stopped'
            // (neutral, rows kept), failed → 'error', otherwise → 'done'.
            next = {
              ...prevCard,
              status: cancelled ? 'stopped' : status === 'failed' ? 'error' : 'done',
              error: status === 'failed' ? errorText ?? 'The sync run failed.' : prevCard.error,
            }
          } else {
            next = prevCard
          }
          foldedCards[meta.type] = next
          settled.push(next)
      }
      setState((prev) => ({ ...prev, cards: foldedCards }))

      // Aggregate held rows into groups.
      const heldGroups: HeldGroup[] = settled
        .filter((c) => c.apply && c.apply.held.length > 0)
        .map((c) => ({
          type: c.type,
          rows: c.apply!.held,
          recommendations: null,
          adjudicating: false,
        }))

      // The HONEST count: every flagged thing across held rows AND all reconciliation
      // channels (source diffs, overdue single-source facts, unresolved batches, block
      // diffs). This is what the panel renders and what decides whether to fan out cases —
      // NOT `heldGroups` alone (a run can flag block/reconciliation issues with zero held
      // rows; the old `heldGroups.length > 0` trigger missed them entirely).
      const findings = result ? flattenRunFindings(result) : []

      // P3 auto-trigger: the moment a run finishes WITH anything flagged, kick off the
      // background investigator for every fresh case (fire-and-forget). It fans the
      // run out into cases and runs the loop; verdicts surface over Realtime (P4).
      // Never awaited — the modal must not block — and any failure is swallowed
      // (the review page still lets Renzo investigate on demand). Skip a clean run.
      if (!cancelled && findings.length > 0) {
        void autoInvestigateRun(runId).catch(() => {})
      }

      // A cancelled run gets a calm, local summary — never an API narration and
      // never an error toast. "Stopped" is a deliberate action, not a failure.
      const cancelledSummary = cancelled
        ? 'Sync stopped. Anything already written was kept — nothing was rolled back.'
        : null

      setState((prev) => ({
        ...prev,
        heldGroups,
        result,
        running: false,
        runStatus: status,
        cancelling: false,
        summarizing: !result?.summary && !cancelledSummary,
        summary: result?.summary ?? cancelledSummary ?? null,
      }))

      // Surface a run-level failure (HARD RULE — copyable, persistent). Cancelled is
      // NOT a failure — no toast.
      if (status === 'failed' && errorText) {
        errorToast('Sync run failed', { description: errorText })
      }

      // Cancelled → local summary already set; skip narration entirely.
      if (cancelled) return

      // If the worker pre-narrated, we're done. Otherwise narrate client-side.
      if (result?.summary) return

      const narrateInput: NarrateInput[] = settled.map((c) => ({
        report_type: c.type,
        ok: c.status !== 'error' && c.status !== 'gate-failed',
        gate_failures: c.classify?.gate_failures.length ?? (c.status === 'gate-failed' ? 1 : 0),
        inserts: c.apply?.applied?.inserts ?? 0,
        updates: c.apply?.applied?.updates ?? 0,
        flagged: c.classify?.counts.flagged ?? 0,
        held: c.apply?.held?.length ?? 0,
      }))

      try {
        const summary = await narrateSyncRun(narrateInput)
        setState((prev) => ({ ...prev, summary, summarizing: false }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast('Sync summary failed', { description: message })
        setState((prev) => ({ ...prev, summarizing: false }))
      }
    },
    []
  )

  /** Apply a `sync_runs` row (Realtime UPDATE / catch-up query / poll). */
  const applyRunRow = React.useCallback(
    (row: SyncRunRow) => {
      if (row.id !== runIdRef.current) return
      setState((prev) => ({
        ...prev,
        runStatus: row.status,
        startedAt: row.started_at ?? prev.startedAt,
        running: !isTerminalRunStatus(row.status),
      }))
      if (isTerminalRunStatus(row.status)) {
        void finalizeRun(row.id, row.status, row.result, row.error)
      }
    },
    [finalizeRun]
  )

  // --- Attach to a run: subscribe to its two tables + a catch-up query. -----
  React.useEffect(() => {
    const runId = state.runId
    if (!runId) return
    runIdRef.current = runId

    const supabase = createClient()
    let mounted = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null

    /** Catch-up: pull the run row + any events we haven't applied yet. */
    const catchUp = async () => {
      const [{ data: runRow }, { data: eventRows }] = await Promise.all([
        supabase.from('sync_runs').select('*').eq('id', runId).maybeSingle(),
        supabase
          .from('sync_run_events')
          .select('*')
          .eq('run_id', runId)
          .order('id', { ascending: true }),
      ])
      if (!mounted) return
      if (Array.isArray(eventRows)) applyEventBatch(eventRows as unknown as SyncRunEventRow[])
      if (runRow) applyRunRow(runRow as unknown as SyncRunRow)
    }

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
    const startPolling = () => {
      if (pollTimer) return
      pollTimer = setInterval(() => {
        // Stop once the run is terminal.
        if (finalizedRef.current === runId) {
          stopPolling()
          return
        }
        void catchUp()
      }, POLL_MS)
    }

    channel = supabase
      .channel(`sync-run-${runId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sync_run_events', filter: `run_id=eq.${runId}` },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (!mounted) return
          applyEventBatch([payload.new as unknown as SyncRunEventRow])
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sync_runs', filter: `id=eq.${runId}` },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (!mounted) return
          applyRunRow(payload.new as unknown as SyncRunRow)
        }
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          stopPolling()
          // Realtime may have missed events between the row insert and subscribe.
          void catchUp()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Degrade to polling (mirror the notification bell fallback).
          startPolling()
        }
      })

    // Always do one immediate catch-up (attach-to-in-flight + fill the gap before
    // the channel is live).
    void catchUp()

    return () => {
      mounted = false
      stopPolling()
      if (channel) void supabase.removeChannel(channel)
    }
  }, [state.runId, applyEventBatch, applyRunRow])

  // --- On mount: attach to the latest run if one is already in flight. ------
  React.useEffect(() => {
    let mounted = true
    const supabase = createClient()
    void (async () => {
      const { data } = await supabase
        .from('sync_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!mounted || !data) return
      const row = data as unknown as SyncRunRow
      if (isTerminalRunStatus(row.status)) return // nothing live to attach to

      // Attach-to-in-flight STALENESS GUARD (belt-and-suspenders with the worker's
      // watchdog): only attach to a GENUINELY-live run. A run that is too old, or has
      // gone quiet (no recent event), is presumed dead/orphaned — attaching would
      // re-strand the UI in a spinner. The watchdog will terminalize it worker-side.
      const now = Date.now()
      const createdMs = row.created_at ? new Date(row.created_at).getTime() : now
      if (now - createdMs > ATTACH_MAX_AGE_MS) {
        const { data: ev } = await supabase
          .from('sync_run_events')
          .select('at')
          .eq('run_id', row.id)
          .order('at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!mounted) return
        const lastEventMs = (ev as { at?: string } | null)?.at
          ? new Date((ev as { at: string }).at).getTime()
          : null
        const stale =
          lastEventMs === null || now - lastEventMs > ATTACH_MAX_EVENT_GAP_MS
        if (stale) return // presumed orphaned — do not attach
      }

      // Attach: reset the per-run guards and point the subscription at it.
      lastEventIdRef.current = 0
      finalizedRef.current = null
      setState((prev) => ({
        ...prev,
        runId: row.id,
        runStatus: row.status,
        running: true,
        ran: true,
        attached: true,
        startedAt: row.started_at ?? row.created_at,
        cards: initialCards(),
        heldGroups: [],
        result: null,
        summary: null,
        overall: initialOverall(),
      }))
    })()
    return () => {
      mounted = false
    }
  }, [])

  // --- run(): enqueue a new durable run + kick the worker. ------------------
  const run = React.useCallback(
    async (opts?: { dryRun?: boolean }) => {
      const dryRun = opts?.dryRun ?? false
      // Reset per-run guards + state for a fresh run.
      lastEventIdRef.current = 0
      finalizedRef.current = null
      setState((prev) => ({
        ...prev,
        running: true,
        ran: true,
        attached: false,
        summary: null,
        summarizing: false,
        heldGroups: [],
        result: null,
        notice: null,
        runStatus: 'queued',
        startedAt: null,
        overall: initialOverall(),
        cards: initialCards(),
        cancelling: false,
      }))

      try {
        const { runId, kicked, message } = await enqueueSyncRun(dryRun)
        setState((prev) => ({
          ...prev,
          runId,
          notice: kicked ? null : message ?? null,
        }))
        // The subscription effect (keyed on state.runId) takes over from here.
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err)
        errorToast('Could not start the sync', { description: messageText })
        setState((prev) => ({ ...prev, running: false, runStatus: null }))
      }
    },
    []
  )

  // --- stop(): Stop the in-flight run (graceful cancel). -------------------
  const stop = React.useCallback(async () => {
    const runId = runIdRef.current
    if (!runId) return
    // Guard against double-clicks; the Realtime UPDATE to 'cancelled' settles the rest.
    setState((prev) => (prev.cancelling ? prev : { ...prev, cancelling: true }))
    try {
      await cancelSyncRun(runId)
      // The service-role UPDATE to 'cancelled' arrives over Realtime and drives the
      // terminal fold-in (cards → "Stopped", running=false). Nothing else to do here.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errorToast('Could not stop the sync', { description: message })
      setState((prev) => ({ ...prev, cancelling: false }))
    }
  }, [])

  const adjudicate = React.useCallback(
    async (type: SyncReportType) => {
      setState((prev) => ({
        ...prev,
        heldGroups: prev.heldGroups.map((g) =>
          g.type === type ? { ...g, adjudicating: true } : g
        ),
      }))

      const group = state.heldGroups.find((g) => g.type === type)
      if (!group) return

      try {
        const recommendations = await adjudicateHeldRows(type, group.rows)
        setState((prev) => ({
          ...prev,
          heldGroups: prev.heldGroups.map((g) =>
            g.type === type ? { ...g, recommendations, adjudicating: false } : g
          ),
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast(`Adjudication failed — ${metaFor(type).label}`, { description: message })
        setState((prev) => ({
          ...prev,
          heldGroups: prev.heldGroups.map((g) =>
            g.type === type ? { ...g, adjudicating: false } : g
          ),
        }))
      }
    },
    [state.heldGroups]
  )

  return { state, run, stop, adjudicate }
}

// Re-exported so callers importing from this module keep working.
export type { ApplyResult, ClassifyResult }
