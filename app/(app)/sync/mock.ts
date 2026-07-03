/**
 * Canned CLI-contract JSON for the SYNC_MOCK path.
 *
 * When `process.env.SYNC_MOCK === '1'`, the server actions return these instead
 * of spawning Python. This makes the entire panel wiring testable end-to-end
 * before the real `sync_*.py` orchestrators exist. It exercises every UI state:
 *   - a clean run (gsheet: all NOOP)
 *   - inserts + updates (deliveries)
 *   - a HARD gate failure (rc_out)
 *   - held rows on apply (production)
 *   - a read-only auditor result (rc_movement)
 *
 * server-only helpers import this; keep it free of client imports.
 */

import type { ApplyResult, ClassifyResult, SyncReportType } from './types'

const CLASSIFIED_DIR = '/tmp/sync-mock'

export const MOCK_CLASSIFY: Record<SyncReportType, ClassifyResult> = {
  gsheet: {
    report_type: 'gsheet',
    ok: true,
    gate_failures: [],
    counts: { noop: 812, insert: 0, update: 0, flagged: 0 },
    rows_preview: [],
    classified_path: `${CLASSIFIED_DIR}/gsheet.classified.json`,
    source: { rows: 812, tab: 'RC IN + RC OUT' },
    watermark: '2026-07-02',
  },
  deliveries: {
    report_type: 'deliveries',
    ok: true,
    gate_failures: [],
    counts: { noop: 40, insert: 3, update: 1, flagged: 0 },
    rows_preview: [
      { action: 'insert', natural_key: '2026-07-03|JULY-26-BLK1|ABC-123|12500', summary: 'New delivery — 12,500 kg' },
      { action: 'insert', natural_key: '2026-07-03|JULY-26-BLK1|XYZ-789|9800', summary: 'New delivery — 9,800 kg' },
      { action: 'insert', natural_key: '2026-07-03|JULY-26-BLK2|DEF-456|11200', summary: 'New delivery — 11,200 kg' },
      { action: 'update', natural_key: '2026-07-02|JULY-26-BLK1|GHI-111|8000', summary: 'cost_basis 0 → 18.50' },
    ],
    classified_path: `${CLASSIFIED_DIR}/deliveries.classified.json`,
    source: { thread: '18f...', uid: 4412 },
    watermark: '2026-07-03',
  },
  rc_out: {
    report_type: 'rc_out',
    ok: false,
    gate_failures: [
      {
        gate: 'PROPOSED-vs-RC-MOVEMENT drift',
        detail:
          '2026-07-03: PROPOSED total 48,200 kg vs RC MOVEMENT 41,900 kg — drift 6,300 kg exceeds the 500 kg HARD limit. Writes halted; likely a doubled block section in the PROPOSED sheet.',
      },
    ],
    counts: { noop: 18, insert: 6, update: 0, flagged: 0 },
    rows_preview: [
      { action: 'insert', natural_key: '2026-07-03|441|FEED', summary: 'Feeding 8,200 kg (blocked by gate)' },
    ],
    classified_path: `${CLASSIFIED_DIR}/rc_out.classified.json`,
    source: { thread: '18e...', uid: 4410 },
    watermark: '2026-07-02',
  },
  production: {
    report_type: 'production',
    ok: true,
    gate_failures: [],
    counts: { noop: 22, insert: 9, update: 0, flagged: 2 },
    rows_preview: [
      { action: 'insert', natural_key: '2026-07-03|SHIFT-A', summary: 'Shift A — 3 runs, 1 downtime' },
      { action: 'insert', natural_key: '2026-07-03|SHIFT-B', summary: 'Shift B — 4 runs' },
      { action: 'flagged', natural_key: '2026-07-03|WASTE|AYAG', summary: 'Waste row references unknown batch AUG-26-BLK9' },
      { action: 'flagged', natural_key: '2026-07-03|ELEC|GEN2', summary: 'Meter reading lower than prior — possible rollover' },
    ],
    classified_path: `${CLASSIFIED_DIR}/production.classified.json`,
    source: { mc_thread: '18d...', ivy_thread: '18c...' },
    watermark: '2026-07-03',
  },
  flecon: {
    report_type: 'flecon',
    ok: true,
    gate_failures: [],
    counts: { noop: 30, insert: 5, update: 0, flagged: 0 },
    rows_preview: [
      { action: 'insert', natural_key: '2026-07-03|Q1', summary: 'Q1 jumbo bags +120' },
      { action: 'insert', natural_key: '2026-07-03|Q2', summary: 'Q2 jumbo bags +80' },
    ],
    classified_path: `${CLASSIFIED_DIR}/flecon.classified.json`,
    source: { thread: '18b...', tab: 'JANUARY 2026' },
    watermark: '2026-07-03',
  },
  rc_movement: {
    report_type: 'rc_movement',
    ok: true,
    gate_failures: [],
    counts: { noop: 0, insert: 0, update: 0, flagged: 1 },
    rows_preview: [
      { action: 'flagged', natural_key: '2026-07-01', summary: 'rc_out sum 39,100 vs movement 39,650 — 550 kg drift' },
    ],
    classified_path: `${CLASSIFIED_DIR}/rc_movement.classified.json`,
    source: { thread: '18a...' },
    watermark: '2026-07-03',
  },
}

export const MOCK_APPLY: Record<SyncReportType, ApplyResult> = {
  gsheet: {
    report_type: 'gsheet',
    ok: true,
    applied: { inserts: 0, updates: 0, replaced_dates: [] },
    held: [],
    labeled: true,
    watermark_updated: true,
    errors: [],
  },
  deliveries: {
    report_type: 'deliveries',
    ok: true,
    applied: { inserts: 3, updates: 1, replaced_dates: [] },
    held: [],
    labeled: true,
    watermark_updated: true,
    errors: [],
  },
  rc_out: {
    // rc_out never reaches apply in the mock (gate fails on classify), but keep
    // a coherent value in case the panel is exercised directly.
    report_type: 'rc_out',
    ok: false,
    applied: { inserts: 0, updates: 0, replaced_dates: [] },
    held: [],
    labeled: false,
    watermark_updated: false,
    errors: ['gate failed on classify — apply skipped'],
  },
  production: {
    report_type: 'production',
    ok: true,
    applied: { inserts: 9, updates: 0, replaced_dates: [] },
    held: [
      {
        reason: 'unmapped_batch',
        natural_key: '2026-07-03|WASTE|AYAG',
        detail: 'Waste row references batch AUG-26-BLK9 which does not exist. Never auto-create a batch.',
      },
      {
        reason: 'meter_rollover',
        natural_key: '2026-07-03|ELEC|GEN2',
        detail: 'GEN2 reading 002,140 < prior 998,000 — likely a 6-digit meter rollover, needs human confirmation.',
      },
    ],
    labeled: false,
    watermark_updated: true,
    errors: [],
  },
  flecon: {
    report_type: 'flecon',
    ok: true,
    applied: { inserts: 5, updates: 0, replaced_dates: ['2026-07-03'] },
    held: [],
    labeled: true,
    watermark_updated: true,
    errors: [],
  },
  rc_movement: {
    report_type: 'rc_movement',
    ok: true,
    applied: { inserts: 0, updates: 0, replaced_dates: [] },
    held: [],
    labeled: false,
    watermark_updated: false,
    errors: [],
  },
}
