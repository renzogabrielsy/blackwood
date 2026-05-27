/**
 * Classifier — maps an email's subject/sender to a ReportExtractor.
 *
 * Phase A: single extractor (RcDeliveriesExtractor).
 * Phase B: register additional extractors here (DailyProductionExtractor, etc.)
 *
 * Usage:
 *   const extractor = classifyEmail({ subject, sender })
 *   if (extractor) { ... }
 */

import type { ReportExtractor } from './extractors/types'
import { RcDeliveriesExtractor } from './extractors/rc-deliveries'

export interface EmailLike {
  subject: string
  sender?: string
  body_text?: string
}

// ── Extractor Registry ─────────────────────────────────────────────────────
// Each entry is instantiated once at module load time.
// Phase B: add new extractors here in priority order (first match wins).
const REGISTRY: ReportExtractor[] = [
  new RcDeliveriesExtractor(),
  // Phase B entries (uncomment when implemented):
  // new DailyProductionExtractor(),
  // new WasteProductionExtractor(),
  // new RcMovementExtractor(),
  // new FleconBaggedExtractor(),
  // new BaggedPowderExtractor(),
  // new QcBagged6x50Extractor(),
  // new QcPreparedCharcoal3x50Extractor(),
  // new DailyMaintenanceExtractor(),
]

/**
 * Returns the first extractor whose matches() returns true for the given email,
 * or null if no extractor recognises it.
 */
export function classifyEmail(email: EmailLike): ReportExtractor | null {
  const meta = {
    messageId: '',
    subject: email.subject,
    sender: email.sender ?? '',
    receivedAt: new Date().toISOString(),
    bodyText: email.body_text ?? '',
  }

  for (const extractor of REGISTRY) {
    if (extractor.matches(meta)) return extractor
  }

  return null
}

/**
 * Returns the extractor for a specific report_type string, or null.
 * Used by uploadForReview when the caller already knows the report_type.
 */
export function extractorForType(reportType: string): ReportExtractor | null {
  return REGISTRY.find(e => e.reportType === reportType) ?? null
}
