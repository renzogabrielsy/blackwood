'use client'

import * as React from 'react'

import { errorToast } from '@/lib/toast'
import {
  adjudicateHeldRows,
  narrateSyncRun,
  runSyncApply,
  runSyncClassify,
  type NarrateInput,
} from '@/app/(app)/sync/actions'
import {
  PARALLEL_WRITERS,
  SYNC_REPORTS,
  metaFor,
  type ApplyResult,
  type ClassifyResult,
  type HeldRow,
  type HeldRowRecommendation,
  type SyncCardState,
  type SyncProgressEvent,
  type SyncReportType,
  type SyncStreamResult,
} from '@/app/(app)/sync/types'

/** Held-row group shown in the Held section, keyed by report type. */
export interface HeldGroup {
  type: SyncReportType
  rows: HeldRow[]
  /** null until "Ask Claude" is run for this group. */
  recommendations: HeldRowRecommendation[] | null
  adjudicating: boolean
}

export interface SyncRunState {
  running: boolean
  cards: Record<SyncReportType, SyncCardState>
  heldGroups: HeldGroup[]
  summary: string | null
  summarizing: boolean
  /** Set true once a run has completed at least once. */
  ran: boolean
}

/** Cap the per-card technical log so a chatty script can't grow state unbounded. */
const LOG_CAP = 500

function freshCard(type: SyncReportType): SyncCardState {
  return {
    type,
    status: 'idle',
    classify: null,
    apply: null,
    error: null,
    stage: null,
    pct: 0,
    statusLine: null,
    warn: false,
    log: [],
  }
}

function initialCards(): Record<SyncReportType, SyncCardState> {
  const entries = SYNC_REPORTS.map((r) => [r.type, freshCard(r.type)])
  return Object.fromEntries(entries) as Record<SyncReportType, SyncCardState>
}

/**
 * Orchestrates the one-click max-auto flow:
 *   1. gsheet classify -> apply (alone, first — source of truth)
 *   2. the 4 writers classify+apply in parallel
 *   3. rc_movement audit classify only (read-only, last)
 * Clean rows auto-apply (`--only-clean`); held/flagged rows surface in the Held
 * section; gate failures render the card destructive with the gate detail.
 *
 * Each phase now streams live progress from `/api/sync/stream` (SSE). The final
 * `result` event replaces the old server-action return value — downstream
 * held-aggregation + narration logic is unchanged. If the stream errors before
 * any event arrives, we fall back to the server-action path once so a broken
 * stream never breaks a sync.
 */
export function useSyncRun() {
  const [state, setState] = React.useState<SyncRunState>(() => ({
    running: false,
    cards: initialCards(),
    heldGroups: [],
    summary: null,
    summarizing: false,
    ran: false,
  }))

  const patchCard = React.useCallback(
    (type: SyncReportType, patch: Partial<SyncCardState>) => {
      setState((prev) => ({
        ...prev,
        cards: { ...prev.cards, [type]: { ...prev.cards[type], ...patch } },
      }))
    },
    []
  )

  /** Apply one live progress event to a card. */
  const onProgress = React.useCallback(
    (type: SyncReportType, ev: SyncProgressEvent) => {
      const statusLine = ev.detail ? `${ev.label} · ${ev.detail}` : ev.label
      patchCard(type, {
        stage: ev.stage,
        pct: ev.pct,
        statusLine,
        warn: ev.level === 'warn',
      })
    },
    [patchCard]
  )

  /** Append a raw technical-log line to a card (capped). */
  const onLog = React.useCallback(
    (type: SyncReportType, line: string) => {
      setState((prev) => {
        const card = prev.cards[type]
        const nextLog =
          card.log.length >= LOG_CAP
            ? [...card.log.slice(card.log.length - LOG_CAP + 1), line]
            : [...card.log, line]
        return { ...prev, cards: { ...prev.cards, [type]: { ...card, log: nextLog } } }
      })
    },
    []
  )

  /**
   * Run one phase over SSE, resolving with the terminal result. Rejects (so the
   * caller can fall back to the server action) ONLY if the stream errors before
   * ANY event arrives; once events flow, a stream error resolves with whatever
   * result we have (or a synthesized error result).
   */
  const streamPhase = React.useCallback(
    (
      type: SyncReportType,
      phase: 'classify' | 'apply',
      opts?: { input?: string; onlyClean?: boolean; noLabel?: boolean }
    ): Promise<SyncStreamResult> => {
      return new Promise<SyncStreamResult>((resolve, reject) => {
        const params = new URLSearchParams({ report: type, phase })
        if (opts?.input) params.set('input', opts.input)
        if (opts?.onlyClean) params.set('onlyClean', '1')
        if (opts?.noLabel) params.set('noLabel', '1')

        const es = new EventSource(`/api/sync/stream?${params.toString()}`)
        let sawAnyEvent = false
        let settled = false

        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          es.close()
          fn()
        }

        es.addEventListener('progress', (e) => {
          sawAnyEvent = true
          try {
            onProgress(type, JSON.parse((e as MessageEvent).data) as SyncProgressEvent)
          } catch {
            /* ignore a malformed frame */
          }
        })

        es.addEventListener('log', (e) => {
          sawAnyEvent = true
          try {
            onLog(type, JSON.parse((e as MessageEvent).data) as string)
          } catch {
            /* ignore */
          }
        })

        es.addEventListener('result', (e) => {
          sawAnyEvent = true
          try {
            const result = JSON.parse((e as MessageEvent).data) as SyncStreamResult
            finish(() => resolve(result))
          } catch {
            finish(() => reject(new Error('Malformed result event from sync stream')))
          }
        })

        es.onerror = () => {
          // EventSource fires onerror both on a mid-stream drop AND when the server
          // closes the connection right after the result (which we already handled
          // via `settled`). Only treat it as a failure if nothing ever arrived.
          if (settled) return
          if (!sawAnyEvent) {
            finish(() => reject(new Error('sync stream failed before any event')))
          } else {
            // Stream dropped mid-flight but we had events — surface an error result
            // rather than rejecting (fallback would re-run the whole phase).
            finish(() =>
              resolve({
                exitCode: -1,
                json: null,
                stderrTail: 'The progress stream disconnected before completing.',
              })
            )
          }
        }
      })
    },
    [onLog, onProgress]
  )

  /**
   * Run one phase, preferring the SSE stream and falling back to the server
   * action exactly once if the stream fails before any event. Returns the phase's
   * contract object (ClassifyResult | ApplyResult) plus whether a gate/error
   * exit occurred.
   */
  const runClassifyPhase = React.useCallback(
    async (type: SyncReportType): Promise<ClassifyResult> => {
      try {
        const res = await streamPhase(type, 'classify')
        if (res.json) return res.json as ClassifyResult
        // Stream completed but produced no parseable JSON — treat as failure.
        throw new Error(
          res.stderrTail?.trim()
            ? `Sync classify failed for ${type}.\n\n${res.stderrTail}`
            : `Sync classify returned no result for ${type}.`
        )
      } catch (err) {
        if (err instanceof Error && err.message === 'sync stream failed before any event') {
          // Fallback: the classic server-action path (one attempt).
          return runSyncClassify(type)
        }
        throw err
      }
    },
    [streamPhase]
  )

  const runApplyPhase = React.useCallback(
    async (type: SyncReportType, classifiedPath: string): Promise<ApplyResult> => {
      try {
        const res = await streamPhase(type, 'apply', { input: classifiedPath, onlyClean: true })
        if (res.json) return res.json as ApplyResult
        throw new Error(
          res.stderrTail?.trim()
            ? `Sync apply failed for ${type}.\n\n${res.stderrTail}`
            : `Sync apply returned no result for ${type}.`
        )
      } catch (err) {
        if (err instanceof Error && err.message === 'sync stream failed before any event') {
          return runSyncApply(type, classifiedPath)
        }
        throw err
      }
    },
    [streamPhase]
  )

  /**
   * Run one report end-to-end. Returns the final card state so the caller can
   * aggregate held rows + narration input after all reports settle.
   */
  const runOne = React.useCallback(
    async (type: SyncReportType): Promise<SyncCardState> => {
      const meta = metaFor(type)
      patchCard(type, {
        status: 'classifying',
        error: null,
        classify: null,
        apply: null,
        stage: null,
        pct: 0,
        statusLine: null,
        warn: false,
        log: [],
      })

      // Commit a terminal card state via the functional updater (so the live
      // `log` accumulated during streaming is preserved) and return the merged
      // card for downstream aggregation.
      const commit = (patch: Partial<SyncCardState>): Promise<SyncCardState> =>
        new Promise((resolve) => {
          setState((prev) => {
            const card: SyncCardState = { ...prev.cards[type], ...patch }
            resolve(card)
            return { ...prev, cards: { ...prev.cards, [type]: card } }
          })
        })

      try {
        const classify = await runClassifyPhase(type)

        // Hard-gate failure -> destructive card, no apply.
        if (!classify.ok || classify.gate_failures.length > 0) {
          return commit({
            status: 'gate-failed',
            classify,
            apply: null,
            error:
              classify.gate_failures.length > 0
                ? classify.gate_failures.map((g) => `[${g.gate}] ${g.detail}`).join('\n\n')
                : 'Classify reported not-ok with no gate detail.',
          })
        }

        // Read-only auditor: never apply.
        if (meta.readOnly) {
          return commit({ status: 'done', classify, apply: null, error: null })
        }

        // Nothing to write -> done without an apply call.
        const hasWrites = classify.counts.insert > 0 || classify.counts.update > 0
        if (!hasWrites) {
          return commit({ status: 'done', classify, apply: null, error: null })
        }

        patchCard(type, { status: 'applying', classify, pct: 0, statusLine: null, stage: null })
        const apply = await runApplyPhase(type, classify.classified_path)
        return commit({ status: 'done', classify, apply, error: null })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast(`Sync failed — ${meta.label}`, { description: message })
        return commit({ status: 'error', classify: null, apply: null, error: message })
      }
    },
    [patchCard, runApplyPhase, runClassifyPhase]
  )

  const run = React.useCallback(async () => {
    setState((prev) => ({
      ...prev,
      running: true,
      ran: true,
      summary: null,
      heldGroups: [],
      cards: initialCards(),
    }))

    const settled: SyncCardState[] = []

    // 1. gsheet first, alone.
    settled.push(await runOne('gsheet'))

    // 2. the 4 writers in parallel.
    const parallel = await Promise.all(PARALLEL_WRITERS.map((t) => runOne(t)))
    settled.push(...parallel)

    // 3. auditor last.
    settled.push(await runOne('rc_movement'))

    // Aggregate held rows into groups.
    const heldGroups: HeldGroup[] = settled
      .filter((c) => c.apply && c.apply.held.length > 0)
      .map((c) => ({
        type: c.type,
        rows: c.apply!.held,
        recommendations: null,
        adjudicating: false,
      }))

    setState((prev) => ({ ...prev, heldGroups, running: false, summarizing: true }))

    // Narrate (skipped locally when clean — zero tokens).
    const narrateInput: NarrateInput[] = settled.map((c) => ({
      report_type: c.type,
      ok: c.status !== 'error' && c.status !== 'gate-failed',
      gate_failures: c.classify?.gate_failures.length ?? (c.status === 'gate-failed' ? 1 : 0),
      inserts: c.apply?.applied.inserts ?? 0,
      updates: c.apply?.applied.updates ?? 0,
      flagged: c.classify?.counts.flagged ?? 0,
      held: c.apply?.held.length ?? 0,
    }))

    try {
      const summary = await narrateSyncRun(narrateInput)
      setState((prev) => ({ ...prev, summary, summarizing: false }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errorToast('Sync summary failed', { description: message })
      setState((prev) => ({ ...prev, summarizing: false }))
    }
  }, [runOne])

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

  return { state, run, adjudicate }
}
