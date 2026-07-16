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
 * The "N items need your review" line is keyed off `findingsCount` — the count
 * of findings the Sync panel ACTUALLY renders (`flattenRunFindings(result).length`
 * in `useSyncRun.ts`), NOT the raw per-report classify-level `held + flagged`
 * totals. Those totals can be non-zero with zero renderable findings (e.g. a
 * classify-level `flagged` that never produced a held row or a reconciliation
 * finding — see the b142814b run: gsheet + rc_movement_audit each flagged=1,
 * apply held=0, block/diff findings=0 → 0 rendered findings). Basing the count
 * on raw totals made the footer promise reviews the findings list never showed.
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
 *
 * `findingsCount` is the number of findings the panel will actually render
 * (`flattenRunFindings(result).length`) — the review line only appears, and is
 * only ever sized, off that number.
 */
export function localSyncSummary(results: NarrateInput[], findingsCount: number): string {
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

  const reviewLine =
    findingsCount > 0
      ? `${plural(findingsCount, 'item')} need${findingsCount === 1 ? 's' : ''} your review — see the findings below.`
      : ''

  const gateLine =
    totals.gateFailures > 0
      ? `${plural(totals.gateFailures, 'report')} failed a totals check and saved nothing — check ${
          totals.gateFailures === 1 ? 'that' : 'those'
        } first.`
      : ''

  return [writeLine, gateLine, reviewLine].filter(Boolean).join(' ')
}
