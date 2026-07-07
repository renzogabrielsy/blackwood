/**
 * grouping.ts — the PURE run-grouping / triage / preselect logic for the Sync Review
 * page (v1.1 Run Triage layer, T2).
 *
 * Factored out of CasesClient so the load-bearing transformations — grouping cases by
 * run, pulling the triage summary card out of the table, cluster-chip filtering,
 * ?run= preselection, and bulk-selection eligibility — are framework-free and can be
 * unit-driven without a browser (scripts/verify-case-grouping.ts).
 *
 * NO React, NO server imports. Client-safe + node-safe.
 */

/**
 * The synthetic kind that marks a run's triage summary case. Mirrors
 * `lib/investigator/triage.ts::TRIAGE_KIND` — redeclared HERE (not imported) so this
 * client-bundled module never pulls the server-only triage module (Anthropic SDK +
 * admin client) into the browser bundle. The verify script asserts the two agree.
 */
export const TRIAGE_KIND = 'run_triage'

/** The minimal case shape the grouping logic needs (a subset of WireCase). */
export interface GroupingCase {
  id: string
  report_type: string
  kind: string
  natural_key: string
  status: string
  last_run_id: string | null
  last_seen_at: string
  created_at: string | null
  /** row jsonb — for a triage case this carries { clusters, case_ids }. */
  row: unknown
  verdict: unknown
}

/** A cluster as stored on a triage case's row.clusters. */
export interface TriageClusterView {
  title: string
  root_cause: string
  case_ids: string[]
  suggested_action: 'dismiss' | 'needs-attention'
  reasoning: string
}

/** The triage synthesis pulled off a run_triage case's row + verdict. */
export interface TriageView {
  /** The triage case's own id (select it to open the run chat). */
  caseId: string
  /** The plain-language run summary (from verdict.summary). */
  summary: string
  clusters: TriageClusterView[]
  /** Every sibling case id the triage covers (row.case_ids). */
  caseIds: string[]
}

/** One run section: its id, a display timestamp, the triage card, and the table rows. */
export interface RunSection<T extends GroupingCase = GroupingCase> {
  /** The run id ('__no_run__' bucket for cases with a null last_run_id). */
  runId: string
  /** Newest last_seen_at across the section's cases (drives section ordering + header). */
  latestAt: string
  /** The run's triage synthesis, if a run_triage case exists for it. */
  triage: TriageView | null
  /** The non-triage cases of this run (the table rows). */
  rows: T[]
}

/** True when a case is the synthetic run-triage summary (never a table row). */
export function isTriageCase(c: Pick<GroupingCase, 'kind'>): boolean {
  return c.kind === TRIAGE_KIND
}

/** Bucket key for a case's run (a stable sentinel for null last_run_id). */
export const NO_RUN_BUCKET = '__no_run__'

function runKey(c: GroupingCase): string {
  return c.last_run_id ?? NO_RUN_BUCKET
}

function parseClusters(row: unknown): TriageClusterView[] {
  if (!row || typeof row !== 'object') return []
  const raw = (row as { clusters?: unknown }).clusters
  if (!Array.isArray(raw)) return []
  const out: TriageClusterView[] = []
  for (const rc of raw) {
    if (!rc || typeof rc !== 'object') continue
    const c = rc as Record<string, unknown>
    const ids = Array.isArray(c.case_ids)
      ? c.case_ids.filter((x): x is string => typeof x === 'string')
      : []
    out.push({
      title: typeof c.title === 'string' ? c.title : 'Flags',
      root_cause: typeof c.root_cause === 'string' ? c.root_cause : '',
      case_ids: ids,
      suggested_action: c.suggested_action === 'dismiss' ? 'dismiss' : 'needs-attention',
      reasoning: typeof c.reasoning === 'string' ? c.reasoning : '',
    })
  }
  return out
}

function parseTriageCaseIds(row: unknown): string[] {
  if (!row || typeof row !== 'object') return []
  const raw = (row as { case_ids?: unknown }).case_ids
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

function summaryOf(verdict: unknown): string {
  if (verdict && typeof verdict === 'object') {
    const s = (verdict as { summary?: unknown }).summary
    if (typeof s === 'string' && s.trim()) return s.trim()
  }
  return 'This run raised flags — review the groups below.'
}

/** Build the TriageView from a run_triage case. */
export function toTriageView(c: GroupingCase): TriageView {
  return {
    caseId: c.id,
    summary: summaryOf(c.verdict),
    clusters: parseClusters(c.row),
    caseIds: parseTriageCaseIds(c.row),
  }
}

/**
 * Group cases into per-run sections, newest run first.
 *
 * - Triage cases (kind === run_triage) are pulled OUT of the table and surfaced only
 *   as the section's triage card — they never appear as a row.
 * - Section order is by the newest `last_seen_at` among the section's cases (a triage
 *   case counts toward that timestamp so a fresh triage keeps its run on top).
 * - Within a section, rows keep the incoming order (the caller pre-sorts newest-first).
 * - The no-run bucket (null last_run_id) always sinks to the bottom.
 */
export function groupCasesByRun<T extends GroupingCase>(cases: T[]): RunSection<T>[] {
  const byRun = new Map<string, { triageCase: T | null; rows: T[]; latestAt: string }>()

  for (const c of cases) {
    const key = runKey(c)
    let bucket = byRun.get(key)
    if (!bucket) {
      bucket = { triageCase: null, rows: [], latestAt: '' }
      byRun.set(key, bucket)
    }
    if (c.last_seen_at > bucket.latestAt) bucket.latestAt = c.last_seen_at
    if (isTriageCase(c)) {
      // Keep the newest triage case if somehow >1 (fingerprint dedup makes this rare).
      if (!bucket.triageCase || c.last_seen_at > bucket.triageCase.last_seen_at) {
        bucket.triageCase = c
      }
    } else {
      bucket.rows.push(c)
    }
  }

  const sections: RunSection<T>[] = []
  for (const [runId, bucket] of byRun) {
    sections.push({
      runId,
      latestAt: bucket.latestAt,
      triage: bucket.triageCase ? toTriageView(bucket.triageCase) : null,
      rows: bucket.rows,
    })
  }

  // Newest run first; the no-run bucket always last.
  sections.sort((a, b) => {
    if (a.runId === NO_RUN_BUCKET) return 1
    if (b.runId === NO_RUN_BUCKET) return -1
    return b.latestAt.localeCompare(a.latestAt)
  })

  return sections
}

/**
 * Filter a section's rows to a specific cluster's case_ids (the cluster-chip toggle).
 * `activeCaseIds` null → no filter (return all rows). PURE.
 */
export function filterRowsByCluster<T extends GroupingCase>(
  rows: T[],
  activeCaseIds: string[] | null,
): T[] {
  if (!activeCaseIds) return rows
  const set = new Set(activeCaseIds)
  return rows.filter((r) => set.has(r.id))
}

/**
 * Resolve the case to preselect for a `?run=<runId>` deep link.
 *
 * Fallback chain (locked):
 *   1. run absent / not found among the sections → null (normal view — caller keeps
 *      its own default, e.g. the first case).
 *   2. run present + has a triage case → the triage case id (land on the run chat).
 *   3. run present, no triage, but has table rows → the run's FIRST row.
 *   4. run present but empty → null.
 */
export function preselectForRun<T extends GroupingCase>(
  sections: RunSection<T>[],
  runId: string | null,
): string | null {
  if (!runId) return null
  const section = sections.find((s) => s.runId === runId)
  if (!section) return null
  if (section.triage) return section.triage.caseId
  if (section.rows.length > 0) return section.rows[0].id
  return null
}

/**
 * A case is eligible for multi-select bulk dismiss when it is a REAL flag the reviewer
 * can set aside: not the triage summary itself, and not already resolved. PURE.
 */
export function isBulkSelectable(c: Pick<GroupingCase, 'kind' | 'status'>): boolean {
  if (isTriageCase(c)) return false
  if (c.status === 'resolved') return false
  return true
}
