'use client'

import * as React from 'react'

import { errorToast } from '@/lib/toast'
import {
  acknowledgeFinding,
  fetchCurrentAcks,
  releaseDeliveryRows,
  type FindingAckAction,
} from '@/app/(app)/sync/acks'
import type { AckLike, AckTarget } from '@/lib/sync/decision-cards'

/**
 * useFindingAcks — the client half of the acknowledgement ledger.
 *
 * Owns three things and nothing else: the standing acks (loaded once), an OPTIMISTIC
 * overlay so a click hides its card instantly, and the release call behind
 * *[Take the source]*.
 *
 * WHY OPTIMISTIC, AND WHY IT UN-HIDES ON FAILURE. The whole point of these buttons is
 * that one click ends the nagging; waiting a round-trip to see the card go makes the
 * panel feel broken. But an optimistic hide that SURVIVES a failed write would be a lie
 * about durable state — the finding would come back on the next run with no explanation.
 * So the overlay entry is removed again on any failure and the error goes to
 * `errorToast()` (persistent + Copy, the project's hard rule), which is the one place a
 * refusal can be read at leisure.
 *
 * The ack ledger is APPEND-ONLY, so "undo" is not modelled here: clicking again after a
 * failure simply appends again, and a changed mind is a new row the view resolves.
 */

/** What the hook hands back per fingerprint — the shape `buildDecisionCards` consumes. */
export type AckMap = ReadonlyMap<string, AckLike>

export interface FindingAcksState {
  /** Standing acks merged with the optimistic overlay. Empty until the load resolves. */
  acks: AckMap
  /** True until the first load settles — the UI shows nothing as "acknowledged" yet. */
  loading: boolean
  /**
   * Why the standing acks could not be read. REPORTED, never folded into "no acks" —
   * an empty map and a failed read look identical to a filter, and the 2026-08-18 lesson
   * (L-044) is that a silent read failure is indistinguishable from good news.
   */
  error: string | null
  /** Fingerprints with a write in flight — for per-card button spinners. */
  pending: ReadonlySet<string>
}

export interface FindingAcksApi extends FindingAcksState {
  /** Record one answer against every fingerprint a card speaks for. */
  acknowledge: (targets: readonly AckTarget[], action: FindingAckAction) => Promise<boolean>
  /**
   * Hand deliveries back to the sync, then acknowledge the card. Returns false (and
   * acknowledges nothing) if the release itself failed — an ack for a release that did
   * not happen would hide a decision nobody actually made.
   */
  takeSource: (
    deliveryIds: readonly string[],
    targets: readonly AckTarget[],
  ) => Promise<{ ok: boolean; released: number; skipped: number }>
}

export function useFindingAcks(enabled: boolean): FindingAcksApi {
  const [stored, setStored] = React.useState<AckMap>(() => new Map())
  const [optimistic, setOptimistic] = React.useState<AckMap>(() => new Map())
  const [loading, setLoading] = React.useState(enabled)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set())

  // Load the standing answers once. Not on every findings change: the ledger only moves
  // when THIS screen writes to it, and every such write updates the overlay directly.
  React.useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void fetchCurrentAcks().then(
      (r) => {
        if (!alive) return
        if (r.ok) {
          setStored(r.acks)
          setError(null)
        } else {
          setError(r.error)
        }
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [enabled])

  const acks = React.useMemo<AckMap>(() => {
    if (optimistic.size === 0) return stored
    const merged = new Map(stored)
    for (const [k, v] of optimistic) merged.set(k, v)
    return merged
  }, [stored, optimistic])

  const markPending = React.useCallback((fingerprints: readonly string[], on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      for (const fp of fingerprints) {
        if (on) next.add(fp)
        else next.delete(fp)
      }
      return next
    })
  }, [])

  const applyOptimistic = React.useCallback(
    (targets: readonly AckTarget[], action: string) => {
      const at = new Date().toISOString()
      setOptimistic((prev) => {
        const next = new Map(prev)
        for (const t of targets) {
          next.set(t.fingerprint, { action, contentHash: t.contentHash, acked_at: at })
        }
        return next
      })
    },
    [],
  )

  const revertOptimistic = React.useCallback((targets: readonly AckTarget[]) => {
    setOptimistic((prev) => {
      const next = new Map(prev)
      for (const t of targets) next.delete(t.fingerprint)
      return next
    })
  }, [])

  const acknowledge = React.useCallback(
    async (targets: readonly AckTarget[], action: FindingAckAction): Promise<boolean> => {
      if (targets.length === 0) return true
      const fps = targets.map((t) => t.fingerprint)
      markPending(fps, true)
      applyOptimistic(targets, action)
      try {
        // One ledger row per fingerprint. A card that answers two questions files two
        // answers; the common card files exactly one.
        const results = await Promise.all(
          targets.map((t) =>
            acknowledgeFinding({
              fingerprint: t.fingerprint,
              kind: t.kind,
              contentHash: t.contentHash,
              action,
            }),
          ),
        )
        const failed = results.find((r) => !r.ok)
        if (failed) {
          revertOptimistic(targets)
          errorToast('Could not record your answer', { description: failed.error })
          return false
        }
        return true
      } catch (e) {
        revertOptimistic(targets)
        errorToast('Could not record your answer', {
          description: e instanceof Error ? e.message : String(e),
        })
        return false
      } finally {
        markPending(fps, false)
      }
    },
    [applyOptimistic, markPending, revertOptimistic],
  )

  const takeSource = React.useCallback(
    async (deliveryIds: readonly string[], targets: readonly AckTarget[]) => {
      const fps = targets.map((t) => t.fingerprint)
      markPending(fps, true)
      applyOptimistic(targets, 'acknowledge')
      try {
        const res = await releaseDeliveryRows([...deliveryIds])
        if (!res.ok) {
          revertOptimistic(targets)
          errorToast('Could not hand this delivery back to the sync', { description: res.error })
          return { ok: false, released: 0, skipped: 0 }
        }
        // The release landed. Record the acknowledgement so the card stays quiet until
        // the situation itself changes; a failure HERE is not worth un-doing the release,
        // so it is reported and the card simply re-appears next run.
        const results = await Promise.all(
          targets.map((t) =>
            acknowledgeFinding({
              fingerprint: t.fingerprint,
              kind: t.kind,
              contentHash: t.contentHash,
              action: 'acknowledge',
              note: 'Handed back to the sync (take the source).',
            }),
          ),
        )
        const failed = results.find((r) => !r.ok)
        if (failed) {
          revertOptimistic(targets)
          errorToast('Handed back, but your answer was not recorded', {
            description: `${failed.error} The delivery WAS released — the next run will apply the source value.`,
          })
        }
        return { ok: true, released: res.released.length, skipped: res.skipped.length }
      } catch (e) {
        revertOptimistic(targets)
        errorToast('Could not hand this delivery back to the sync', {
          description: e instanceof Error ? e.message : String(e),
        })
        return { ok: false, released: 0, skipped: 0 }
      } finally {
        markPending(fps, false)
      }
    },
    [applyOptimistic, markPending, revertOptimistic],
  )

  return { acks, loading, error, pending, acknowledge, takeSource }
}
