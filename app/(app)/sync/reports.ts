'use server'

/**
 * reports.ts — the DOWNLOAD side of the Excel sync report.
 *
 * The worker generates and stores the workbook at the end of every run (see
 * `workers/sync/src/reports/excel/`). Nothing here generates anything; these actions only
 * find the stored artifact and hand back a short-lived signed URL. Renzo's brief was exactly
 * that split: "automatic and stored. Just let me click a button to download when i choose to."
 *
 * ─────────────────────────────── HOW THE FILE IS SERVED ───────────────────────────────
 * The `sync-reports` bucket is PRIVATE and has NO storage policy at all, so nothing can read
 * an object except a signed URL minted by the service role. `getSyncRunReportUrl` mints one
 * with a 60-second life and a `download` filename (so the browser saves it with a human name
 * instead of the run's uuid). The service-role key never leaves the server; the browser only
 * ever sees the one-minute URL.
 *
 * ───────────────────────────────────── THE PESO GATE ─────────────────────────────────────
 * The workbook is price-free by construction — the finding vocabulary it is built from
 * carries no cost value anywhere, on purpose, and the generator strips any cost-ish key on
 * the way into a cell and then AUDITS its own output. It records the measured result in
 * `sync_run_reports.contains_prices`, whose DEFAULT is TRUE (fail-closed).
 *
 * This action enforces that flag: an artifact recording `contains_prices = true` is REFUSED
 * to a caller for whom `canViewPrices()` is false. So the answer to "does a gated viewer get
 * a peso-free regenerated file, or no download at all" is: **no download at all, and today
 * that branch is unreachable** — because the stored file has no peso figure in it, so nobody
 * is gated out of it. There is no second, regenerating code path to keep in sync, and the day
 * someone adds a peso column to the workbook the generator stops asserting price-freedom and
 * this gate engages on its own, with no code change here.
 *
 * `requirePrivileged()` runs first regardless: sync is Owner/Admin/Dev only, and it derives
 * the effective role through the impersonation cookie, so an Owner "viewing as Production" is
 * already refused before the peso question is even asked.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { canViewPrices } from '@/lib/auth'
import { requirePrivileged } from '@/lib/sync/privileged'

/** How long a download link lives. Long enough to click, short enough to be worthless later. */
const SIGNED_URL_TTL_SECONDS = 60

/** One row of `public.view_sync_run_reports`, as the UI needs it. */
export interface SyncRunReportSummary
{
  reportId: string
  runId: string
  runStatus: string
  startedAt: string | null
  finishedAt: string | null
  durationSeconds: number | null
  dryRun: boolean
  filename: string | null
  bytes: number | null
  findingCount: number
  warnCount: number
  errorCount: number
  sheetCounts: Record<string, number>
  containsPrices: boolean
  ok: boolean
  error: string | null
  generatedAt: string
}

interface ReportRow {
  report_id: string
  run_id: string
  run_status: string | null
  started_at: string | null
  finished_at: string | null
  duration_seconds: number | string | null
  dry_run: boolean | null
  storage_bucket: string | null
  storage_path: string | null
  filename: string | null
  bytes: number | null
  finding_count: number | null
  warn_count: number | null
  error_count: number | null
  sheet_counts: unknown
  contains_prices: boolean | null
  ok: boolean | null
  error: string | null
  generated_at: string
  is_latest: boolean | null
}

const SELECT_COLUMNS =
  'report_id,run_id,run_status,started_at,finished_at,duration_seconds,dry_run,' +
  'storage_bucket,storage_path,filename,bytes,finding_count,warn_count,error_count,' +
  'sheet_counts,contains_prices,ok,error,generated_at,is_latest'

function toSummary(r: ReportRow): SyncRunReportSummary {
  const secs = r.duration_seconds == null ? null : Number(r.duration_seconds)
  return {
    reportId: r.report_id,
    runId: r.run_id,
    runStatus: r.run_status ?? 'unknown',
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationSeconds: secs != null && Number.isFinite(secs) ? secs : null,
    dryRun: r.dry_run ?? false,
    filename: r.filename,
    bytes: r.bytes,
    findingCount: r.finding_count ?? 0,
    warnCount: r.warn_count ?? 0,
    errorCount: r.error_count ?? 0,
    sheetCounts:
      r.sheet_counts && typeof r.sheet_counts === 'object'
        ? (r.sheet_counts as Record<string, number>)
        : {},
    // Fail-closed on a NULL: an artifact that does not say it is price-free is treated as
    // price-bearing, matching the column's own DEFAULT.
    containsPrices: r.contains_prices !== false,
    ok: r.ok ?? false,
    error: r.error,
    generatedAt: r.generated_at,
  }
}

/**
 * The last N generated reports, newest first — one cheap query against
 * `view_sync_run_reports` (which already joins the run's status, timing and dry-run flag, so
 * there is no join to write here).
 *
 * Read with the SERVICE role deliberately: `requirePrivileged()` above is the authorization,
 * and using the admin client keeps the result identical no matter how the caller's session
 * cookie behaves inside a server action.
 */
export async function listSyncRunReports(limit = 20): Promise<SyncRunReportSummary[]> {
  await requirePrivileged()
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('view_sync_run_reports')
    .select(SELECT_COLUMNS)
    .eq('is_latest', true)
    .order('generated_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 100)))

  if (error) {
    throw new Error(`Could not list sync reports.\n\n${error.message}`)
  }
  return ((data ?? []) as unknown as ReportRow[]).map(toSummary)
}

/**
 * Which of these runs have a downloadable report? Used by the Sync Review run headers so a
 * download button only appears where there is something to download — the 97 runs that
 * predate this feature have no artifact, and offering them a button that can only fail would
 * be worse than offering nothing.
 */
export async function getRunsWithReports(runIds: string[]): Promise<string[]> {
  await requirePrivileged()
  const ids = [...new Set(runIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return []

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('sync_run_reports')
    .select('run_id')
    .in('run_id', ids)
    .eq('ok', true)
    .not('storage_path', 'is', null)

  if (error) {
    throw new Error(`Could not check which runs have a report.\n\n${error.message}`)
  }
  return [...new Set(((data ?? []) as { run_id: string }[]).map((r) => r.run_id))]
}

export interface SyncReportDownload {
  url: string
  filename: string
  bytes: number | null
  /** Seconds the URL stays valid — the UI can say so rather than guessing. */
  expiresInSeconds: number
}

/**
 * Mint a short-lived signed URL for one run's report.
 *
 * Refuses, with a plain message the UI can show verbatim, when: the caller is not
 * Owner/Admin/Dev; no report exists for that run; generation had failed; or the artifact says
 * it carries peso data and the caller may not see prices.
 */
export async function getSyncRunReportUrl(runId: string): Promise<SyncReportDownload> {
  await requirePrivileged()

  if (!runId || typeof runId !== 'string') {
    throw new Error('No run was specified, so there is no report to download.')
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('sync_run_reports')
    .select('storage_bucket,storage_path,filename,bytes,contains_prices,ok,error,generated_at')
    .eq('run_id', runId)
    .order('generated_at', { ascending: false })
    .limit(10)

  if (error) {
    throw new Error(`Could not look up this run's report.\n\n${error.message}`)
  }

  interface ArtifactRow {
    storage_bucket: string | null
    storage_path: string | null
    filename: string | null
    bytes: number | null
    contains_prices: boolean | null
    ok: boolean | null
    error: string | null
  }
  const rows = (data ?? []) as unknown as ArtifactRow[]

  if (rows.length === 0) {
    throw new Error(
      'No Excel report was generated for this run. Reports are produced automatically at the ' +
        'end of every sync — runs from before that was switched on do not have one.'
    )
  }

  // Prefer the newest SUCCESSFUL artifact, not simply the newest row. A regeneration that
  // failed must not take away a file that is still sitting in Storage and still perfectly
  // valid — the retry failing is not the same as there being nothing to download.
  const row = rows.find((r) => r.ok !== false && r.storage_path)
  if (!row?.storage_path) {
    const latest = rows[0]
    throw new Error(
      'The Excel report for this run could not be generated, so there is no file to download.' +
        (latest?.error ? `\n\nThe failure was: ${latest.error}` : '')
    )
  }

  // THE PESO GATE. Fail-closed: a NULL flag counts as "carries prices".
  if (row.contains_prices !== false) {
    const allowed = await canViewPrices()
    if (!allowed) {
      throw new Error(
        'This report contains price data, and your role cannot view prices, so it cannot be ' +
          'downloaded. Ask an Owner or Admin for it.'
      )
    }
  }

  const bucket = row.storage_bucket ?? 'sync-reports'
  const filename = row.filename ?? `blackwood-sync-${runId.slice(0, 8)}.xlsx`
  const { data: signed, error: signError } = await admin.storage
    .from(bucket)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS, { download: filename })

  if (signError || !signed?.signedUrl) {
    throw new Error(
      `Could not create a download link for this report.\n\n${
        signError?.message ?? 'no URL returned'
      }`
    )
  }

  return {
    url: signed.signedUrl,
    filename,
    bytes: row.bytes,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  }
}
