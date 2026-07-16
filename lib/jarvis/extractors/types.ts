/**
 * Base types for the AI ingestion agent's report extractors.
 * Phase 2 will implement concrete extractor classes for each daily report type.
 * See AI_INGESTION_AGENT.md §4 for the full design.
 */

export interface ExtractedRow {
  /** The structured data to insert into the target table. */
  payload: Record<string, unknown>
  /** Confidence score 0.0–1.0. Rows below 0.7 surface as warnings in the review UI. */
  confidence: number
  /** Human-readable diagnostics. Each warning reduces confidence by 0.1–0.3. */
  warnings: string[]
}

export interface EmailMeta {
  /** Gmail message ID — used for idempotency checks against pending_review.source_email_id */
  messageId: string
  subject: string
  sender: string
  /** ISO 8601 timestamp when the email was received */
  receivedAt: string
  /** Plain-text body of the email */
  bodyText: string
}

/**
 * Interface that every report extractor must implement.
 * One extractor per report type (daily_production, rc_deliveries, rc_movement, etc.)
 */
export interface ReportExtractor {
  /** Stable identifier for the report type. Stored in pending_review.report_type. */
  readonly reportType: string

  /**
   * Returns true if this extractor should handle the given email.
   * Match on subject pattern + sender address.
   */
  matches(meta: EmailMeta): boolean

  /**
   * Parse the attachment bytes and return proposed rows with confidence scores.
   * Empty array = nothing extracted (e.g. no attachment, wrong format).
   */
  extract(attachmentBytes: Buffer, meta: EmailMeta): Promise<ExtractedRow[]>

  /**
   * The canonical Supabase table these rows will be inserted into on approval.
   * E.g. 'deliveries', 'rc_out', 'production_runs'
   */
  targetTable(): string
}
