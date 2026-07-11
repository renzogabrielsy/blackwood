/**
 * local-summary.ts — the deterministic, zero-API run summary.
 *
 * Sync Review is deterministic-only (Renzo 2026-07-11, see `./config.ts`). When
 * `SYNC_AI_REVIEW_ENABLED` is false, `useSyncRun.ts` must NEVER call the
 * `narrateSyncRun` server action (an Anthropic completion) — it calls
 * `localSyncSummary` instead. The clean-run branch mirrors, byte-for-byte, the
 * string `narrateSyncRun` already returns for an all-clean run (so the message
 * a viewer sees is unchanged in the common case); the non-clean branch is a new
 * blunt, counts-based template — no jargon, no AI prose, just what wrote and
 * what needs a look.
 *
 * PURE + CLIENT-SAFE: no imports besides a type-only import of `NarrateInput`
 * (erased at compile time — importing a TYPE from a `'use server'` file never
 * pulls its runtime code into the client bundle). Deterministic, never throws.
 */
import type { NarrateInput } from '@/app/(app)/sync/actions'

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The local, deterministic stand-in for `narrateSyncRun`. Same all-clean string
 * as the server action's short-circuit; a blunt counts-based summary otherwise.
 */
export function localSyncSummary(results: NarrateInput[]): string {
  const allClean = results.every(
    (r) =>
      r.ok &&
      r.gate_failures === 0 &&
      r.inserts === 0 &&
      r.updates === 0 &&
      r.flagged === 0 &&
      r.held === 0,
  )
  if (allClean) {
    return 'Nothing new today. Every report was already up to date. Nothing needs your attention.'
  }

  const totals = results.reduce(
    (acc, r) => ({
      inserts: acc.inserts + r.inserts,
      updates: acc.updates + r.updates,
      held: acc.held + r.held,
      flagged: acc.flagged + r.flagged,
      gateFailures: acc.gateFailures + r.gate_failures,
    }),
    { inserts: 0, updates: 0, held: 0, flagged: 0, gateFailures: 0 },
  )

  const wrote: string[] = []
  if (totals.inserts > 0) wrote.push(plural(totals.inserts, 'new row'))
  if (totals.updates > 0) wrote.push(plural(totals.updates, 'updated row'))
  const writeLine = wrote.length > 0 ? `Wrote ${wrote.join(' and ')}.` : 'Nothing was written.'

  const reviewCount = totals.held + totals.flagged
  const reviewLine =
    reviewCount > 0
      ? `${plural(reviewCount, 'item')} need${reviewCount === 1 ? 's' : ''} your review — see the findings below.`
      : ''

  const gateLine =
    totals.gateFailures > 0
      ? `${plural(totals.gateFailures, 'report')} failed a totals check and saved nothing — check ${
          totals.gateFailures === 1 ? 'that' : 'those'
        } first.`
      : ''

  return [writeLine, gateLine, reviewLine].filter(Boolean).join(' ')
}
