'use client'

import * as React from 'react'
import { Download, FileSpreadsheet, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { errorToast } from '@/lib/toast'
import { getSyncRunReportUrl } from '@/app/(app)/sync/reports'

interface SyncReportButtonProps {
  /** The `sync_runs.id` whose report to download. */
  runId: string | null
  /** `panel` = the full-width button in the Run Sync modal; `inline` = a small row action. */
  variant?: 'panel' | 'inline'
  /** Extra classes for the wrapping button. */
  className?: string
}

/**
 * Download this run's Excel report.
 *
 * The workbook is generated and stored automatically at the end of every sync; this button
 * only fetches a link to it. The link is a SIGNED URL minted server-side and valid for one
 * minute — the bucket is private with no read policy, so there is no public URL to leak and
 * the service-role key never reaches the browser.
 *
 * Failure is always LOUD and always copyable: `errorToast()` (never sonner's `toast.error`)
 * so the message persists until dismissed and carries a Copy button. The server messages are
 * written to be shown verbatim — "no report was generated for this run", "your role cannot
 * view prices" — so there is nothing to translate here.
 */
export function SyncReportButton({ runId, variant = 'panel', className }: SyncReportButtonProps) {
  const [busy, setBusy] = React.useState(false)

  const download = React.useCallback(async () => {
    if (!runId || busy) return
    setBusy(true)
    try {
      const { url, filename } = await getSyncRunReportUrl(runId)
      // The signed URL carries `?download=<filename>`, so the server sets
      // Content-Disposition: attachment. An anchor click therefore saves the file without
      // navigating away — no popup, no new tab, nothing for a blocker to swallow.
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      errorToast('Could not download the sync report', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }, [runId, busy])

  if (!runId) return null

  if (variant === 'inline') {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          void download()
        }}
        title="Download this run's Excel report"
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5',
          'text-[10px] font-medium text-muted-foreground transition-all duration-150',
          'hover:bg-muted hover:text-foreground disabled:opacity-50',
          className
        )}
      >
        {busy ? (
          <RefreshCw className="h-3 w-3 animate-spin" />
        ) : (
          <FileSpreadsheet className="h-3 w-3" />
        )}
        Excel
      </button>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => void download()}
      title="Download this run's Excel report — every warning, disagreement and held row, one sheet per section."
      className={cn('w-full', className)}
    >
      {busy ? (
        <>
          <RefreshCw className="h-4 w-4 animate-spin" />
          Preparing the file…
        </>
      ) : (
        <>
          <Download className="h-4 w-4" />
          Download Excel report
        </>
      )}
    </Button>
  )
}
