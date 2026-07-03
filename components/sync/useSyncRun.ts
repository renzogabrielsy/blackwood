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
  type HeldRow,
  type HeldRowRecommendation,
  type SyncCardState,
  type SyncReportType,
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

function initialCards(): Record<SyncReportType, SyncCardState> {
  const entries = SYNC_REPORTS.map((r) => [
    r.type,
    { type: r.type, status: 'idle', classify: null, apply: null, error: null } as SyncCardState,
  ])
  return Object.fromEntries(entries) as Record<SyncReportType, SyncCardState>
}

/**
 * Orchestrates the one-click max-auto flow:
 *   1. gsheet classify -> apply (alone, first — source of truth)
 *   2. the 4 writers classify+apply in parallel
 *   3. rc_movement audit classify only (read-only, last)
 * Clean rows auto-apply (`--only-clean`); held/flagged rows surface in the Held
 * section; gate failures render the card destructive with the gate detail.
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

  /**
   * Run one report end-to-end. Returns the final card state so the caller can
   * aggregate held rows + narration input after all reports settle.
   */
  const runOne = React.useCallback(
    async (type: SyncReportType): Promise<SyncCardState> => {
      const meta = metaFor(type)
      patchCard(type, { status: 'classifying', error: null, classify: null, apply: null })

      try {
        const classify = await runSyncClassify(type)

        // Hard-gate failure -> destructive card, no apply.
        if (!classify.ok || classify.gate_failures.length > 0) {
          const card: SyncCardState = {
            type,
            status: 'gate-failed',
            classify,
            apply: null,
            error:
              classify.gate_failures.length > 0
                ? classify.gate_failures.map((g) => `[${g.gate}] ${g.detail}`).join('\n\n')
                : 'Classify reported not-ok with no gate detail.',
          }
          setState((prev) => ({ ...prev, cards: { ...prev.cards, [type]: card } }))
          return card
        }

        // Read-only auditor: never apply.
        if (meta.readOnly) {
          const card: SyncCardState = { type, status: 'done', classify, apply: null, error: null }
          setState((prev) => ({ ...prev, cards: { ...prev.cards, [type]: card } }))
          return card
        }

        // Nothing to write -> done without an apply call.
        const hasWrites = classify.counts.insert > 0 || classify.counts.update > 0
        if (!hasWrites) {
          const card: SyncCardState = { type, status: 'done', classify, apply: null, error: null }
          setState((prev) => ({ ...prev, cards: { ...prev.cards, [type]: card } }))
          return card
        }

        patchCard(type, { status: 'applying', classify })
        const apply = await runSyncApply(type, classify.classified_path)
        const card: SyncCardState = { type, status: 'done', classify, apply, error: null }
        setState((prev) => ({ ...prev, cards: { ...prev.cards, [type]: card } }))
        return card
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast(`Sync failed — ${meta.label}`, { description: message })
        const card: SyncCardState = {
          type,
          status: 'error',
          classify: null,
          apply: null,
          error: message,
        }
        setState((prev) => ({ ...prev, cards: { ...prev.cards, [type]: card } }))
        return card
      }
    },
    [patchCard]
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

  const adjudicate = React.useCallback(async (type: SyncReportType) => {
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
  }, [state.heldGroups])

  return { state, run, adjudicate }
}
