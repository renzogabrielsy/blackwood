/**
 * DailyProductionExtractor — skeleton for Phase 2.
 *
 * Handles: "Daily Production Report" from mccontinedo.ictc@gmail.com
 * Target table: production_runs (table does not exist yet in v1 — Phase 3+ scope)
 *
 * TODO Phase 2: implement XLSX parsing
 *   - Open attachment with openpyxl (Python) or a Node XLSX lib
 *   - Locate header row (scan for 'DATE', 'GRADE', 'SHIFT', 'TTL KG' columns)
 *   - Extract one row per shift per grade
 *   - Cross-validate row date vs email subject/body stated date
 *   - Score confidence: 1.0 - 0.2 * warning_count (min 0.0)
 *   - Return ExtractedRow[] for the pending_review queue
 *
 * See AI_INGESTION_AGENT.md §4 for the full extraction pattern and example Python code.
 */

import type { EmailMeta, ExtractedRow, ReportExtractor } from './types'

export class DailyProductionExtractor implements ReportExtractor {
  readonly reportType = 'daily_production'

  matches(meta: EmailMeta): boolean {
    return (
      meta.subject.trim().toLowerCase() === 'daily production report' &&
      meta.sender.toLowerCase() === 'mccontinedo.ictc@gmail.com'
    )
  }

  // TODO Phase 2: implement XLSX parsing
  async extract(
    _attachmentBytes: Buffer,
    _meta: EmailMeta
  ): Promise<ExtractedRow[]> {
    return []
  }

  targetTable(): string {
    // Table 'production_runs' is a Phase 3+ addition to the schema.
    return 'production_runs'
  }
}
