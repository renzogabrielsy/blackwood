'use server'

/**
 * acks.ts — the ONE-CLICK half of Sync Review (2026-08-19).
 *
 * Three server actions, one theme: give the operator a BUTTON where today there is a
 * sentence ending in "please confirm". They split cleanly by what they touch:
 *
 *   acknowledgeFinding  — writes ONE row to the append-only `sync_finding_acks` ledger.
 *                         Touches no operational data at all. This is what silences the
 *                         five findings per run that have no durable case and therefore
 *                         nothing to mark resolved.
 *   releaseDeliveryRows — clears the human-edit latch on deliveries so the NEXT sync run
 *                         may apply the source value. Writes no delivery data itself.
 *   fetchCurrentAcks    — reads the standing answer per fingerprint so the screen can
 *                         filter.
 *
 * WHY A SIBLING FILE AND NOT `resolve.ts`. `resolve.ts` owns RESOLUTION OF A DURABLE
 * CASE: it re-reads a proposal from the DB, re-checks eligibility, dispatches an
 * operational write through the apply-writer registry and records a `sync_case_rulings`
 * row. Nothing here does any of that — an acknowledgement is a statement about the
 * SCREEN, and a release is a one-line RPC call. Mixing them would put "no operational
 * write, ever" and "the operational write path" in one file.
 *
 * ROLE GATE. `requirePrivileged()` — the same Owner/Admin/Dev boundary every other sync
 * server action uses, respecting the dev-impersonation cookie. Note this is STRICTER
 * than `releaseProductionRows`, which has no gate of its own because it is reached from
 * the production module; these are reached from Sync Review, which is privileged-only,
 * and the gate is what keeps that true on the server rather than only in the UI.
 * Unlike `resolve.ts` the refusal is RETURNED rather than thrown, because every one of
 * these is wired to a button whose failure has to reach an error toast intact.
 *
 * PRICE GATING. Nothing here returns a ₱ value. A fingerprint and a content hash are hex
 * digests whose INPUT is cost-stripped (`findingIdentity`), and neither the ack ledger
 * nor `view_deliveries_human_edited` carries a cost column. So no `canViewPrices()` call
 * is needed — and if a future column changes that, it must be nulled here before the
 * payload leaves the server, never hidden client-side.
 */

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'
import { requirePrivileged } from '@/lib/sync/privileged'
import type { Json } from '@/types/supabase'

// ============================================================================
// Shared shapes
// ============================================================================

/** The three answers a person can give. Mirrors the table's CHECK constraint. */
export type FindingAckAction = 'acknowledge' | 'keep_mine' | 'same_truck'

const ACK_ACTIONS: readonly FindingAckAction[] = ['acknowledge', 'keep_mine', 'same_truck']

/** Toast-ready result for a write. `error` is already phrased for `errorToast()`. */
export interface AckResult {
  ok: boolean
  error?: string
}

export interface AcknowledgeFindingInput {
  /** From `lib/sync/findings.ts::findingIdentity` — never hand-built by a caller. */
  fingerprint: string
  /** The `RunFinding.kind`, carried for readability. Not part of the identity. */
  kind: string
  /** From the same `findingIdentity` call as `fingerprint` — the two travel together. */
  contentHash: string
  action: FindingAckAction
  /** Optional. Deliberately never required — see the table's `note` comment. */
  note?: string
}

/** The standing answer for one fingerprint. */
export interface CurrentAck {
  action: FindingAckAction
  /**
   * What the finding said when it was acknowledged. Compare against the finding's
   * CURRENT `contentHash`: equal → still acknowledged (hide it); different → the
   * situation changed and it is unacknowledged again (show it).
   */
  contentHash: string
  acked_at: string
}

export type FetchAcksResult =
  | { ok: true; acks: Map<string, CurrentAck> }
  | { ok: false; error: string }

/**
 * Run the privileged gate and turn its throw into a returned, toast-ready refusal.
 * Returns the user id on success, or the message on refusal.
 */
async function gate(): Promise<{ userId: string } | { error: string }> {
  try {
    return { userId: await requirePrivileged() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Not authorized.' }
  }
}

// ============================================================================
// 1. acknowledgeFinding — append one row to the ledger. NO operational write.
// ============================================================================

/**
 * Record that a human has SEEN this finding, in this state.
 *
 * This changes no operational data and it changes nothing about what the sync reports:
 * the finding is still raised by the next run, still lands in `sync_runs.result` and
 * still lands in the Excel workbook. It changes only what the SCREEN chooses to show —
 * which is exactly why an old acknowledgement can never suppress a new problem.
 *
 * APPEND-ONLY. Acknowledging the same fingerprint again (a changed situation, a changed
 * mind, a different person) INSERTS a new row; the latest one wins, resolved once in
 * `view_sync_finding_acks_current`. Nothing is ever updated or deleted, and the database
 * refuses both even if this action tried.
 *
 * `acked_by` is set from the session, never from the client, and the DB's INSERT policy
 * re-checks it against `auth.uid()` — so the name on an acknowledgement is a claim the
 * database verified, not a field a caller filled in.
 */
export async function acknowledgeFinding(input: AcknowledgeFindingInput): Promise<AckResult> {
  const g = await gate()
  if ('error' in g) return { ok: false, error: g.error }

  const fingerprint = (input?.fingerprint ?? '').trim()
  const kind = (input?.kind ?? '').trim()
  const contentHash = (input?.contentHash ?? '').trim()
  const note = (input?.note ?? '').trim()

  if (!fingerprint) return { ok: false, error: 'That finding has no identity to acknowledge.' }
  if (!kind) return { ok: false, error: 'That finding has no kind — cannot acknowledge it.' }
  if (!contentHash) {
    return {
      ok: false,
      error:
        'That finding has no content hash, so "acknowledged until it changes" could not work — nothing was recorded.',
    }
  }
  if (!ACK_ACTIONS.includes(input?.action)) {
    return { ok: false, error: `"${input?.action}" is not something you can answer here.` }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('sync_finding_acks').insert({
    fingerprint,
    kind,
    content_hash: contentHash,
    action: input.action,
    note: note || null,
    acked_by: g.userId,
  })

  if (error) {
    return { ok: false, error: `Could not record your answer: ${error.message}` }
  }

  revalidatePath('/sync/cases')
  revalidatePath('/')
  return { ok: true }
}

// ============================================================================
// 2. releaseDeliveryRows — the IN-APP DOOR for the deliveries human-edit latch.
// ============================================================================

/** Mirrors `ReleaseResult` in `app/(app)/production/actions.ts` — same shape, one table. */
export interface ReleaseDeliveryResult {
  ok: boolean
  /** Ids that were released — they follow the source again from the next run. */
  released: string[]
  /** Ids that were already following the source (or no longer exist). Not an error. */
  skipped: string[]
  /** Human-readable failure text, already phrased for an error toast. */
  error?: string
}

/**
 * Hand human-edited deliveries back to the sync — the *[Take the source]* button.
 *
 * THIS BUTTON WRITES NO DELIVERY DATA. It clears ONLY the ownership stamp
 * (`human_edited_at` / `human_edited_by`); every value on the row is left exactly as it
 * is. Nothing changes until the NEXT sync run actually has something different to write,
 * and when it does it writes through the existing latch-aware path
 * (`fn_apply_delivery_upstream`), with its normal audit trail. So "take the source" is a
 * statement of INTENT recorded against the row, not an edit applied on the spot — which
 * is what makes it safe to offer as one click.
 *
 * `fn_release_delivery_rows` is the only sanctioned way to clear the stamp: an ordinary
 * authenticated UPDATE sending `human_edited_at: null` is immediately re-stamped by
 * `fn_stamp_human_edit`. The RPC holds the transaction-local GUC that suppresses that
 * trigger, and its guard (`human_edited_at IS NOT NULL`) lives inside its own UPDATE's
 * WHERE — so releasing a row nobody claimed writes nothing and comes back as `skipped`
 * rather than pretending it worked.
 *
 * This closes the gap CLAUDE.md names: the function has existed since 2026-08-08 with no
 * server action calling it, so until now a release was a service-role call by hand.
 */
export async function releaseDeliveryRows(ids: string[]): Promise<ReleaseDeliveryResult> {
  const g = await gate()
  if ('error' in g) return { ok: false, released: [], skipped: [], error: g.error }

  if (!ids?.length) {
    return { ok: true, released: [], skipped: [] }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('fn_release_delivery_rows', { p_ids: ids })

  if (error) {
    return {
      ok: false,
      released: [],
      skipped: [],
      error: `Could not hand ${ids.length} deliver${ids.length === 1 ? 'y' : 'ies'} back to the sync: ${error.message}`,
    }
  }

  const obj =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, Json | undefined>)
      : null
  const asIds = (v: Json | undefined): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  const result: ReleaseDeliveryResult = {
    ok: obj?.ok === true,
    released: asIds(obj?.released),
    skipped: asIds(obj?.skipped),
  }
  if (!result.ok && !result.error) {
    result.error = 'The database did not confirm the release — nothing was changed.'
  }
  if (result.ok) {
    revalidatePath('/sync/cases')
    revalidatePath('/inventory/rc-in')
  }
  return result
}

// ============================================================================
// 3. fetchCurrentAcks — the standing answer per fingerprint.
// ============================================================================

/**
 * Every fingerprint's CURRENT acknowledgement, keyed for a client-side filter.
 *
 * A finding is still-acknowledged when its fingerprint is present here AND the stored
 * `contentHash` equals the finding's current one. A different hash means the situation
 * moved since somebody looked, so it surfaces again — that comparison is the caller's,
 * deliberately, because only the caller holds the run being rendered.
 *
 * Reads `view_sync_finding_acks_current`, which owns the "latest row wins" rule. Never
 * re-derive that with an `order by acked_at desc limit 1` in a caller.
 *
 * A read failure is REPORTED, never folded to an empty map. An empty map and a broken
 * read look identical to a filter (everything shows), which is the benign direction —
 * but "we could not check" must still be sayable, because a bare catch reporting
 * "nothing to report" is exactly the failure L-044 cost two weeks.
 */
export async function fetchCurrentAcks(): Promise<FetchAcksResult> {
  const g = await gate()
  if ('error' in g) return { ok: false, error: g.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('view_sync_finding_acks_current')
    .select('fingerprint, action, content_hash, acked_at')

  if (error) {
    return { ok: false, error: `Could not load which findings you have already seen: ${error.message}` }
  }

  const acks = new Map<string, CurrentAck>()
  for (const row of data ?? []) {
    const fingerprint = row.fingerprint
    const action = row.action
    const contentHash = row.content_hash
    const ackedAt = row.acked_at
    if (!fingerprint || !contentHash || !ackedAt) continue
    if (!ACK_ACTIONS.includes(action as FindingAckAction)) continue
    acks.set(fingerprint, {
      action: action as FindingAckAction,
      contentHash,
      acked_at: ackedAt,
    })
  }
  return { ok: true, acks }
}
