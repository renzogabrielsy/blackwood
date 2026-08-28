/**
 * Shared types for the in-app "Run Sync" panel — the CLI contract between the
 * Next.js server actions and the Python sync orchestrators
 * (`.claude/skills/sync-ictc/scripts/sync_*.py`).
 *
 * These mirror the FIXED CLI contract the backend agent is building against.
 * Do NOT drift these shapes without coordinating with the sync-ictc scripts:
 *   classify stdout -> ClassifyResult
 *   apply    stdout -> ApplyResult
 *
 * This file is import-safe from both server actions ('use server') and client
 * components (it is pure types + const data, no server-only imports).
 */

/** The six sync report types, in daily-run order. */
export type SyncReportType =
  | 'gsheet'
  | 'deliveries'
  | 'rc_out'
  | 'production'
  | 'flecon'
  | 'rc_movement'

/** Static catalog describing each employee card in the panel. */
export interface SyncReportMeta {
  type: SyncReportType
  /** Python script basename under `.claude/skills/sync-ictc/scripts/`. */
  script: string
  /** Human label shown on the card. */
  label: string
  /** One-line description of what this employee ingests. */
  blurb: string
  /**
   * Read-only reports never call `--phase apply` (the auditor). The panel must
   * never attempt to apply these.
   */
  readOnly: boolean
}

/**
 * Canonical catalog + run order. gsheet FIRST and alone (source of truth), then
 * the four writers in parallel, then the read-only auditor last.
 */
export const SYNC_REPORTS: readonly SyncReportMeta[] = [
  {
    type: 'gsheet',
    script: 'sync_gsheet.py',
    label: 'Google Sheet',
    blurb: 'Source of truth — RC IN + RC OUT from the shared Sheet.',
    readOnly: false,
  },
  {
    type: 'deliveries',
    script: 'sync_deliveries.py',
    label: 'Deliveries (RC IN)',
    blurb: 'RC DELIVERIES email + Czarina price enrichment.',
    readOnly: false,
  },
  {
    type: 'rc_out',
    script: 'sync_rc_out.py',
    label: 'RC OUT',
    blurb: 'PROPOSED DAILY REPORT — feedings into rc_out.',
    readOnly: false,
  },
  {
    type: 'production',
    script: 'sync_production.py',
    label: 'Production',
    blurb: 'MC + Ivy reports — shifts, runs, downtime, waste.',
    readOnly: false,
  },
  {
    type: 'flecon',
    script: 'sync_flecon.py',
    label: 'FLECON Bags',
    blurb: 'Empty jumbo-bag stock (replace-by-date).',
    readOnly: false,
  },
  {
    type: 'rc_movement',
    script: 'audit_rc_movement.py',
    label: 'RC Movement Audit',
    blurb: 'Read-only feeding-total cross-check.',
    readOnly: true,
  },
] as const

/** Which report types classify+apply in parallel after gsheet. */
export const PARALLEL_WRITERS: readonly SyncReportType[] = [
  'deliveries',
  'rc_out',
  'production',
  'flecon',
]

export function metaFor(type: SyncReportType): SyncReportMeta {
  const meta = SYNC_REPORTS.find((r) => r.type === type)
  if (!meta) throw new Error(`Unknown sync report type: ${type}`)
  return meta
}

// ============================================================
// CLI contract — classify phase
// ============================================================

export interface GateFailure {
  gate: string
  detail: string
}

export interface ClassifyCounts {
  noop: number
  insert: number
  update: number
  flagged: number
}

export interface RowPreview {
  action: string
  natural_key: string
  summary: string
}

export interface ClassifyResult {
  report_type: string
  ok: boolean
  gate_failures: GateFailure[]
  counts: ClassifyCounts
  rows_preview: RowPreview[]
  classified_path: string
  source: Record<string, unknown>
  watermark: string | null
}

// ============================================================
// CLI contract — apply phase
// ============================================================

export interface ApplyApplied {
  inserts: number
  updates: number
  /** COUNT of dates whose rows were replaced (flecon REPLACE-BY-DATE). A number,
   *  matching the worker + SYNC_CLI_CONTRACT — not an array. */
  replaced_dates: number
}

/**
 * The normalized held-flag categories (worker-side src/reports/held.ts is the SoT).
 * The app adjudicator switches its targeted, read-only DB lookup on `kind`.
 */
export type HeldKind =
  | 'sub_watermark_suspected_dup'
  | 'cross_batch_reassignment'
  | 'unmapped_batch_code'
  | 'unmapped_bag_type_code'
  | 'location_occupied'
  /**
   * BUG-027 (2026-08-25) — a new batch wanted a block another ACTIVE batch still holds.
   * The same physical clash as `location_occupied`, but raised with BOTH sides named
   * (which batch wanted it, which batch holds it, its balance, when it was last fed), so
   * the operator can act on the sentence. Every writer raises this one now; the old kind
   * stays in the enum because old runs and old cases still carry it.
   */
  | 'batch_location_conflict'
  | 'malformed'
  | 'low_confidence'
  | 'already_exists'
  | 'gate_failure'
  | 'unmapped_or_missing_columns'
  | 'below_since_floor'
  | 'unresolved_shift'
  | 'unresolved_batch_id'
  | 'flagged'
  | 'other'

/**
 * One held row. The three legacy fields are always present; the enrichment fields
 * (kind/row/source_index, 2026-07-06) are optional and carry a decision-grade
 * payload for "Ask Claude". `natural_key` is a HUMAN label (never a raw index) and
 * doubles as the stable per-row key the recommendation map re-keys by. `row` NEVER
 * contains a ₱/cost field (price gating). Worker mirror: normalizeReport.ts.
 */
export interface HeldRow {
  reason: string
  natural_key: string
  detail: string
  /** Normalized flag category — keys the adjudicator's DB lookup. */
  kind?: HeldKind
  /** Structured KEY fields for the adjudicator + DB lookup. NEVER a ₱/cost field. */
  row?: Record<string, unknown>
  /** The former row index — retained for the apply-input mapping. */
  source_index?: string | number
}

/**
 * One batch the sync auto-created this apply (2026-07-11 policy — reverses the old
 * "never auto-create a batch" hard rule). A pattern-valid unknown batch_code (e.g.
 * `JULY-26-BLK6`) is now created from the same template the human-confirmed
 * "create this batch" Sync Review action uses (`lib/sync/create-batch-plan.ts`),
 * and the triggering row is written through in the SAME run. Worker mirror:
 * normalizeReport.ts::AutoCreatedBatchNote. NEVER a ₱/cost field.
 */
export interface AutoCreatedBatch {
  batch_code: string
  location_ref: string
  /** gsheet only — which tab produced the row. Absent for the PROPOSED rc_out lane. */
  mode?: 'rc_in' | 'rc_out'
  transaction_date: string | null
  block_loc: string | null
  source_row: string | number | null
}

/**
 * One production-batch CHANGEOVER a run detected (2026-08-03). MC's Daily Production
 * Report marks a batch handover in the runs block's column H — `ENDING` on the last
 * runs of the batch that was running, `STARTING` on the first runs of the new one —
 * and the sync files those rows under two DIFFERENT `production_batch` values.
 *
 * The new batch's NAME appears nowhere in the workbook, so the sync DERIVES it (the
 * next name in the strict monthly sequence after the running batch) with nothing to
 * verify it against. This note exists so the operator confirms the name. It is NOT a
 * held row — the rows DID write — and never a `HeldKind` (that enum is frontend-locked).
 * Worker mirror: normalizeReport.ts::ProductionBatchStartNote. NEVER a ₱/cost field.
 */
export interface ProductionBatchStart {
  transaction_date: string
  /** The new batch the `STARTING` rows opened. */
  new_batch: string
  /** The batch it follows (the one that was already running). */
  previous_batch: string
  /**
   * How the new name was derived:
   *   `sequence`                   — the next name after a KNOWN running batch (normal),
   *   `calendar_cold_start`        — no prior batch on record; the sheet's month was used,
   *   `calendar_unknown_running`   — the running batch isn't a month name; ditto.
   */
  derivation: string
  /** The workbook tab the marker was read from. */
  source_sheet: string
}

/**
 * One production row the sync REFUSED to overwrite because a human edited it in the app
 * (the human-edit latch, 2026-08-03 — migration
 * `20260803080000_production_human_edit_guard.sql`).
 *
 * `human_edited_at` on the six production fact tables is set by a trigger on every
 * in-app write; `fn_apply_production_upstream` re-checks it inside its own UPDATE, so
 * the sync cannot revert a hand-corrected number. Nothing is parked in the DB: MC's /
 * Ivy's workbook is cumulative, so the disagreement re-surfaces every run until the
 * operator either fixes the sheet or hands the row back with
 * `fn_release_production_rows`.
 *
 * NOT a held row (there is nothing to retry) and never a `HeldKind` (frontend-locked).
 * Worker mirror: normalizeReport.ts::ProductionHumanEditNote. Production carries no
 * ₱/cost fields.
 */
export interface ProductionHumanEdit {
  /** runs | downtime | waste | electricity | trucks. */
  section: string
  /** The DB table the refusal applies to. */
  table: string
  /** The row id — what the release action needs. */
  record_id: string
  transaction_date: string | null
  production_batch: string | null
  shift: string | null
  meter: string | null
  plate_no: string | null
  /** `yours` = the value stored in the app, `sheet` = what the report says. */
  changed_fields: Array<{ field: string; yours: unknown; sheet: unknown }>
  /** `known_before_write` (already latched when the run planned) | `refused_by_db` (a race). */
  outcome: string
}

/**
 * One DELIVERY the sync REFUSED to overwrite because a human edited it in the app
 * (the deliveries human-edit latch, 2026-08-08 — migration
 * `20260808015712_deliveries_human_edit_latch.sql`).
 *
 * The sibling of `ProductionHumanEdit`, and the same rule: `human_edited_at` on
 * `public.deliveries` is set by the `fn_stamp_human_edit` trigger on every in-app write,
 * and `fn_apply_delivery_upstream` re-checks it inside its own UPDATE, so neither the
 * Google Sheet nor an emailed report can revert a hand-corrected delivery. Nothing is
 * parked in the DB: both sources are CUMULATIVE, so the disagreement re-surfaces every
 * run until the operator either fixes the source or hands the row back with
 * `fn_release_delivery_rows`.
 *
 * The difference from production is WHY it was needed. Production's overwriting writer was
 * DORMANT (its patch shape never matched). This one is LIVE: 40 `audit_logs` UPDATE rows
 * on `deliveries` carry `provenance=gsheet`, four of them on rows Renzo had already edited
 * by hand. The 2026-06-25 comment asking the sync not to do that was prose in a table
 * nothing reads at write time.
 *
 * NOT a held row (there is nothing to retry) and never a `HeldKind` (frontend-locked).
 *
 * ₱ SAFETY — `cost_basis` IS one of the nine fields the latch can refuse, and the
 * run-findings channel is NOT price-gated. So a refused `cost_basis` appears in
 * `changed_fields` by NAME ONLY, with `yours`/`sheet` forced to null and `redacted: true`.
 * The worker does that stripping where the note is built (`deliveryHumanEditNote`), before
 * anything leaves the process — `formatFindingData`'s cost-key strip cannot help here,
 * because the values would be nested inside a `changed_fields` value whose own key is not
 * cost-ish.
 */
export interface DeliveryHumanEdit {
  /** Which source was refused — `deliveries` (the emailed RC DELIVERIES report) or
   *  `gsheet` (the Google Sheet's Sheet-wins update). Becomes the finding's `section`. */
  section: 'deliveries' | 'gsheet'
  /** Always `'deliveries'`. Present so this shape mirrors `ProductionHumanEdit`. */
  table: string
  /** The delivery id — what `fn_release_delivery_rows` needs. */
  record_id: string
  transaction_date: string | null
  supplier: string | null
  batch_code: string | null
  block_loc: string | null
  truck_plate: string | null
  /** `yours` = the value stored in the app, `sheet` = what the source says. Both are
   *  null when `redacted` — see the ₱ note above. */
  changed_fields: Array<{ field: string; yours: unknown; sheet: unknown; redacted?: boolean }>
  /** `refused_by_db` — the DB's own guard declined the write. The only outcome the
   *  deliveries latch reports: unlike production there is no advisory pre-check, because
   *  here the writer is live so the RPC is always called and the refusal always visible. */
  outcome: string
}

/**
 * One thing the DELIVERY PRICE step wants a human to see (2026-08-07).
 *
 * WHY THIS EXISTS: the price step used to have exactly one way of speaking — a bare
 * `catch` that emitted "Price file unavailable — proceeding without prices." On
 * 2026-08-07 that beat was found to have un-priced EVERY August delivery for a week
 * (the worker generated Czarina's tab name as "August 2026"; her tab is "Aug. 2026",
 * the exact-match lookup threw, and the whole-file load is done ONCE before the row
 * loop). Nine truckloads carried cost_basis = 0 and dragged AUGUST-26-BLK1's average
 * cost to ₱11.01 against a real ₱39.99. Silence is what cost those nine truckloads,
 * so every price outcome now has a durable, distinguishable voice here.
 *
 * NEVER CARRIES A ₱/COST VALUE, deliberately — the run-findings channel is not
 * price-gated, so a note identifies the ROW and describes the problem in words while
 * the number stays in RC IN behind `canViewPrices()`. If a future note gains a price
 * field it must be dropped in `normalizeApply`, not passed through.
 */
export interface PriceNote {
  /**
   * `price_tab_unresolved` / `price_tab_ambiguous` / `price_file_unreadable` — the file
   * or one month could not be used at all (the class that silently un-priced August).
   * `price_fuzzy_match` — priced, but the two sources spell the plate/supplier
   * differently. `price_fuzzy_ambiguous` — REFUSED: the fallback key hit more than one
   * row, or the one row it hit disagrees about both plate and supplier.
   * `price_date_drift` — REFUSED: her file has this exact supplier+plate+weight, but
   * months away, so it is a different trip by the same truck (the exact key carries no
   * date because she records the payment date; the bound is the Python's 7 days).
   * `price_out_of_band` — priced, but the number is unlike this supplier's recent range.
   *
   * The two REFUSED kinds leave the row at ₱0 — never word them as "priced".
   *
   * 2026-08-18 (L-044) added three more, all of which leave rows at ₱0:
   * `price_file_missing` — no price workbook in the mailbox window at all.
   * `price_no_row_matched` — the file opened, a month tab resolved, and NOT ONE delivery
   * matched. One unmatched row is ordinary; every row unmatched is not a row problem, it
   * is the signature of the WRONG workbook — a bank cheque-requisition file whose tabs
   * happen to be named `AUGUST 2026` satisfies every other check in this list, and did,
   * for two weeks. `price_overdue_check_failed` — the unpriced-delivery check itself
   * could not be run, so the run cannot say whether any are overdue.
   */
  kind: string
  /** Plain-English specifics, already operator-facing. */
  detail: string
  transaction_date: string | null
  supplier: string | null
  batch_code: string | null
  truck_plate: string | null
  weight_kg: number | null
  sacks: number | null
  source_row: string | null
  /** `exact` | `alias` | `fallback` — which rung of the match ladder produced the price. */
  via: string | null
  matched_sheet: string | null
  matched_row: number | null
  date_tolerance_days: number | null
  /** The month the resolver wanted, e.g. "August 2026". */
  looked_for: string | null
  /** Every worksheet tab the price file actually has — the other half of the message. */
  tabs_found: string[]
  /** Tabs that all normalize to the same month (the ambiguous case). */
  candidates: string[]
  /**
   * The attachment filename the run actually read (L-044). A NAME, never a value — and
   * the single fact that separates "the price file has a problem" from "that was never
   * the price file", which is the distinction nobody could make for two weeks.
   */
  source_filename: string | null
  /** The tabs that resolved and were read, in the order requested. */
  tabs_loaded: string[]
  /** Priceable rows read out of those tabs. 0 with tabs loaded = the tab was empty. */
  rows_loaded: number | null
  /** How many of OUR deliveries the run tried to price. */
  rows_considered: number | null
  /** `czarina` | `ours` — whose side the fallback key collided on. */
  collided_on: string | null
  /** A spelling disagreement with BOTH values, so the operator can confirm at a glance. */
  differences: Array<{ field: string; ours: string; theirs: string }>
  collisions: Array<{ sheet: string | null; row: string; date: string | null }>
}

/**
 * One delivery still carrying the L-008 unpriced placeholder more than a day after it
 * happened (2026-08-07). Renzo: "prices are not supposed to lag, and they liquidate
 * daily" — so an unpriced row is named every run until someone fixes it.
 *
 * Projected straight off `public.view_digest_unpriced_deliveries`, which owns the ONE
 * definition of "unpriced" and "overdue"; nothing re-derives it. No ₱ field: every row
 * here has cost_basis = 0 by construction.
 */
export interface UnpricedOverdue {
  id: string
  transaction_date: string
  supplier: string | null
  batch_code: string | null
  truck_plate: string | null
  weight_kg: number | null
  sacks: number | null
  /** operational_date − transaction_date, in days. Always ≥ 2 for an overdue row. */
  days_pending: number
}

/**
 * One delivery weighed in with NO PILE ASSIGNED YET (2026-08-13, L-042).
 *
 * MC books overnight weights early with the truck plate, the weight and the moisture, and
 * fills the pile in later in the day. Those rows used to be reported MALFORMED — "row could
 * not be read" — for a normal, self-clearing stage of her day.
 *
 * This channel is deliberately quiet: nothing is written, nothing is HELD (so no durable
 * review case), and the watermark is never blocked. Visibility is the whole job, which is
 * why `days_pending` drives the severity — a row that NEVER gets filled in is a real
 * problem. No ₱ field: the operator file has no price column.
 */
export interface AwaitingBatchAssignment {
  transaction_date: string
  supplier: string | null
  truck_plate: string | null
  weight_kg: number | null
  sacks: number | null
  /** The sheet row, so the operator can go straight to the cell that is empty. */
  source_row: string | null
  /** Whole days between `transaction_date` and the run's Asia/Manila date. 0 = today. */
  days_pending: number
}

/**
 * A report whose SOURCE FILE did not arrive in a run at all (2026-08-18, L-044).
 *
 * The deliveries run used to answer this case with "Nothing new today — no RC DELIVERIES
 * report waiting." at 100% progress, which reads as *checked, all fine*, and which was
 * printed on the very days RC IN was going stale. A run where nothing arrived is otherwise
 * indistinguishable from a quiet day — the absence of a signal is not a signal.
 *
 * NOT a second staleness rule: `missed_working_days` comes straight from
 * `view_digest_stream_status`, which already excludes rest days and reports that are not
 * due yet. It decides only how loudly to say the mail is missing.
 *
 * NOT a duplicate of `StaleStream` either. That one is a DATA fact (the table has no rows
 * for recent working days); this is a FETCH fact (no email was in the mailbox window). The
 * case that needs both: the Google Sheet pass keeps the data current while the email
 * pipeline is quietly dead — `StaleStream` is silent and correct, and this is the only
 * thing that notices. Which is why it still fires at `missed_working_days = 0`, as `info`.
 */
export interface ReportNotReceived {
  /** The `reports` key that went without a file, e.g. "deliveries". */
  report_type: string
  /** Plain-English name of the missing document ("RC DELIVERIES report"). */
  source_label: string
  /** The `view_digest_stream_status` key this report feeds. */
  stream: string
  /** The stream's registry label ("RC In (deliveries)"). */
  stream_label: string
  /** The window floor the run searched from (YYYY-MM-DD). */
  since: string
  /** The latest date the stream has data for. Null if it never has. */
  through_date: string | null
  /** The operational date the view measured lateness against. */
  operational_date: string | null
  /**
   * Planned working days missed, from the view. NULL (never 0) when the number was not
   * measured — 0 means "measured, on time", and a guess must not impersonate a
   * measurement. When null, `lateness_unknown_reason` says why.
   */
  missed_working_days: number | null
  /**
   * Why `missed_working_days` is null; null when it IS a measurement.
   * `unreadable` — the stream-status view could not be read (**the failure that blinded
   * the freshness watch for two weeks**: no `service_role` SELECT grant → 42501 on every
   * call). `unregistered` — the view read fine and has no row for this stream (a registry
   * gap). `not_computable` — the row exists but the stream has never reported, so there is
   * no baseline to count working days from. Different next actions, so different words.
   */
  lateness_unknown_reason: 'unreadable' | 'unregistered' | 'not_computable' | null
  /** True when this stream reports a day behind by design (wording only). */
  reports_next_day: boolean
  /** The run's Asia/Manila calendar date — what "today" means at the plant. */
  as_of: string
}

export interface ApplyResult {
  report_type: string
  ok: boolean
  /** May be ABSENT on a gate-failure / errored apply envelope (nothing applied).
   *  Consumers MUST guard `apply?.applied` before reading counts. */
  applied?: ApplyApplied
  held: HeldRow[]
  labeled: boolean
  watermark_updated: boolean
  errors: string[]
  /** Batches the sync auto-created this apply. The worker always sends this array
   *  (default []); optional here ONLY so older/hand-built fixtures that predate this
   *  field still type-check. Consumers should read it as `apply?.auto_created_batches
   *  ?? []` (see `collectAutoCreatedBatches`). */
  auto_created_batches?: AutoCreatedBatch[]
  /** Production-batch changeovers this apply announced. Same optionality contract as
   *  `auto_created_batches` — read it as `apply?.production_batch_starts ?? []`
   *  (see `collectProductionBatchStarts`). Only the `production` report ever fills it. */
  production_batch_starts?: ProductionBatchStart[]
  /** Production rows the sync refused to overwrite because a human owns them. Same
   *  optionality contract as `auto_created_batches` — read it as
   *  `apply?.production_human_edits ?? []` (see `collectProductionHumanEdits`). */
  production_human_edits?: ProductionHumanEdit[]
  /** Deliveries the sync refused to overwrite because a human owns them. Same
   *  optionality contract as `auto_created_batches` — read it as
   *  `apply?.delivery_human_edits ?? []` (see `collectDeliveryHumanEdits`). Filled by the
   *  `deliveries` and `gsheet` reports. */
  delivery_human_edits?: DeliveryHumanEdit[]
  /** Delivery-price problems this run saw — a tab it could not resolve, a fuzzy match it
   *  accepted, a price outside the supplier's usual range. Same optionality contract as
   *  `auto_created_batches` — read it as `apply?.price_notes ?? []` (see
   *  `collectPriceNotes`). Only the `deliveries` report ever fills it. */
  price_notes?: PriceNote[]
  /** Deliveries still unpriced more than a day after they happened. Same optionality
   *  contract — read it as `apply?.unpriced_overdue ?? []` (see
   *  `collectUnpricedOverdue`). Only the `deliveries` report ever fills it. */
  unpriced_overdue?: UnpricedOverdue[]
  /** Deliveries weighed in with no pile assigned yet (L-042). Same optionality contract —
   *  read it as `apply?.awaiting_batch_assignment ?? []` (see
   *  `collectAwaitingBatchAssignments`). Only the `deliveries` report ever fills it. */
  awaiting_batch_assignment?: AwaitingBatchAssignment[]
  /** Set ONLY when this report's source file never arrived (L-044). Absent on every
   *  ordinary run, so the KEY'S PRESENCE is the fact — never an array with a length to
   *  check. Read it via `collectReportsNotReceived`. */
  report_not_received?: ReportNotReceived
}

// ============================================================
// Durable progress contract — Supabase Realtime (Wave 4B)
// ============================================================
//
// The old transport was an SSE stream that spawned Python on Renzo's laptop and
// forwarded `##SYNC_PROGRESS` stderr lines. That is RETIRED. Progress now lives in
// two Supabase tables the DBOS worker writes and the browser watches over Realtime:
//   - `sync_runs`        — one row per "Run Sync" click (lifecycle + terminal result)
//   - `sync_run_events`  — the live progress feed (one row per beat)
// See supabase/migrations/20260704000000_sync_runs_and_events.sql.

/** The coarse pipeline stages a progress event can report. */
export type SyncProgressStage =
  | 'fetch'
  | 'extract'
  | 'classify'
  | 'apply'
  | 'reconcile'
  | 'finalize'

/**
 * One decoded progress event. In the SSE era this was a `##SYNC_PROGRESS` stderr
 * line; now it is projected from a `sync_run_events` row. The digestible-language
 * shape is IDENTICAL, so the card reducer is unchanged.
 */
export interface SyncProgressEvent {
  stage: SyncProgressStage
  /** Integer 0–100. */
  pct: number
  /** Plain-English activity — what to show as the status line. */
  label: string
  /** Optional specifics appended muted after the label. */
  detail?: string
  /**
   * `error` added 2026-08-07 — the worker had no level louder than `warn`, so a beat
   * that had silently un-priced a whole month of deliveries looked identical to a
   * routine retry. `sync_run_events.level` is free text (no CHECK), so this needed no
   * migration; `projectEvent` maps it through and the card's `warn` boolean is set by
   * BOTH non-info levels, so an error can never render quieter than a warn.
   */
  level: 'info' | 'warn' | 'error'
}

/**
 * Lifecycle status of a durable sync run (mirrors the `sync_run_status` enum).
 * `cancelled` is a NEUTRAL terminal state (the Stop button) — a stopped run keeps
 * every already-written row (no rollback) and reads as "Stopped", never error-red.
 */
export type SyncRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'cancelled'

/** The terminal statuses — a run in one of these will emit no further events. */
export const TERMINAL_RUN_STATUSES: readonly SyncRunStatus[] = [
  'succeeded',
  'failed',
  'partial',
  'cancelled',
] as const

export function isTerminalRunStatus(s: SyncRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s)
}

/**
 * A `sync_run_events` row exactly as it arrives over Realtime (or a mount-time
 * catch-up query). All fields are nullable to mirror the table (defensive — a
 * malformed worker write must never crash the reducer). `report_type` keys the
 * card; the sentinel `'_run'` is the top-level workflow's own progress track.
 */
export interface SyncRunEventRow {
  id: number
  run_id: string
  report_type: string | null
  stage: string | null
  pct: number | null
  label: string | null
  detail: string | null
  level: string | null
  at: string | null
}

/** The report-type sentinel the worker uses for the top-level run's own track. */
export const RUN_TRACK_REPORT_TYPE = '_run' as const

/**
 * A `sync_runs` row as it arrives over Realtime / a catch-up query. `result` and
 * `error` are only populated on the terminal transition.
 */
export interface SyncRunRow {
  id: string
  requested_by: string | null
  status: SyncRunStatus
  started_at: string | null
  finished_at: string | null
  result: SyncRunResult | null
  error: string | null
  created_at: string | null
}

/**
 * The terminal `sync_runs.result` contract the worker writes and the modal reads.
 *
 * The worker (M3) fills `reports[<type>]` with the SAME `ClassifyResult` /
 * `ApplyResult` objects the old CLI produced — so the downstream held-aggregation
 * + narration logic (and `SyncPanelBody` / `HeldRows`) are untouched. During
 * M0/M1 the worker instead writes a Mail-Clerk manifest (no `reports` key); the
 * reducer treats a result with no `reports` as "run finished, nothing per-report
 * to show yet" and simply clears the busy state.
 */
export interface SyncRunReportResult {
  classify: ClassifyResult | null
  apply: ApplyResult | null
  /** Terminal card status the worker decided for this report, if any. */
  status?: SyncCardStatus
  /** Full error text (gate detail / crash) for the inline block + Copy. */
  error?: string | null
}

export interface SyncRunResult {
  /** Per-report terminal results, keyed by report type. Absent in M0/M1. */
  reports?: Partial<Record<SyncReportType, SyncRunReportResult>>
  /**
   * R2 SHADOW: multi-source reconciliation output (the worker's additive
   * `result.reconciliation` channel). Present only when the shadow reconcile stage
   * ran and had something to compare. Its `rc_out.diffs` fan out into `source_diff`
   * cases (app/(app)/sync/cases.ts). Sits ALONGSIDE `reports` — observational only.
   */
  reconciliation?: ReconciliationChannel
  /** Optional pre-narrated summary (else the app narrates client-side). */
  summary?: string | null
  /** Anything else the worker attaches (manifest, counts) — inspected loosely. */
  [key: string]: unknown
}

// ============================================================
// Multi-source reconciliation (R1/R2) — app-side MIRROR of the worker types
// (workers/sync/src/reconcile/types.ts + rcOutStage.ts). Kept local so the app
// never imports from the worker package (separate module graph). MUST stay in
// lockstep with the worker's SourceDiff / SourceOpinion / RcOutNaturalKey shapes.
// ============================================================

/** The rc_out reconciliation witnesses. */
export type RcOutSource = 'proposed' | 'gsheet' | 'movement'

/** Natural key at the reconciliation granularity (fine records set batch+block). */
export interface RcOutNaturalKey {
  transaction_date: string
  batch: string | null
  block_loc: string | null
  destination: string | null
}

/**
 * One raw per-LEG row that summed to a source's opinion at a natural key — R3's
 * pick-source write-plan input (app/(app)/sync/diff-plan.ts). Mirror of the worker's
 * reconcile/types.ts::SourceLegRow. NEVER carries a ₱/cost field (rc_out has none).
 */
export interface SourceLegRow {
  transaction_date: string
  batch_code: string | null
  batch_id?: string
  block_loc: string | null
  destination: string
  weight_kg: number
  production_batch?: string | null
  remarks?: string | null
}

/** One competing value inside a diff, with provenance + self-consistency + backers. */
export interface SourceOpinion {
  source: RcOutSource
  value: number | string | null
  provenance: string
  selfConsistent: boolean
  corroboratedBy: RcOutSource[]
  /** The raw legs that summed to `value` — R3's per-leg write-plan input. Empty for movement. */
  rows: SourceLegRow[]
}

/** Advisory winner hint — NEVER a decision (the human still picks in Sync Review). */
export interface Recommendation {
  source: RcOutSource
  why: string
}

/** A field where present sources disagree — one `source_diff` case per diff. */
export interface SourceDiff {
  naturalKey: RcOutNaturalKey
  field: string
  table: 'rc_out'
  sources: SourceOpinion[]
  recommended?: Recommendation
}

/**
 * R4a — a batch that could not resolve to exactly ONE batch_id (Deliverable 1). Mirror of the
 * worker's reconcile/types.ts::UnresolvedBatch. Surfaces as an `unresolved_batch` case. NEVER a ₱.
 */
export interface UnresolvedBatch {
  transaction_date: string
  batch_code: string
  /** Distinct batch_ids the code + fallbacks resolved to: 0 (no match) or 2+ (ambiguous). */
  candidates: string[]
  block_loc: string | null
  destination: string
  weight_kg: number
  sources: RcOutSource[]
}

/**
 * R4a — a single-witness fact whose second source is OVERDUE (Deliverable 3). Mirror of the
 * worker's reconcile/types.ts::SingleSourceOverdue. Surfaces as a `single_source_overdue` case.
 * A `pending` fact (recent, self-clears) never becomes one of these — it is a count only.
 */
export interface SingleSourceOverdue {
  naturalKey: RcOutNaturalKey
  field: string
  table: 'rc_out'
  source: RcOutSource
  value: number | string | null
  provenance: string
  ageDays: number
  lagDays: number
}

/**
 * One side of an `AttributionDiff` pairing. Mirror of the worker's
 * reconcile/types.ts::AttributionSide. `batch` is the resolved batch_id; `batch_code` is
 * the source's raw code string when available (best-effort). NEVER a ₱.
 */
export interface AttributionSide {
  source: RcOutSource
  batch: string | null
  batch_code?: string | null
  block_loc: string | null
  weight_kg: number
  provenance: string
}

/**
 * Second-pass attribution matcher — two single-witness rc_out facts that are almost
 * certainly the SAME physical feeding reported under two different batch/block
 * attributions (e.g. the proposed report derives its batch from block_date+block_no
 * while the Sheet carries an operator-typed code). Mirror of the worker's
 * reconcile/types.ts::AttributionDiff. Surfaces as an `attribution_diff` case —
 * NEVER auto-resolved; dismiss-only in v1 (no pick-and-rewrite yet).
 */
export interface AttributionDiff {
  transaction_date: string
  destination: string
  weight_kg: number
  proposed: AttributionSide
  gsheet: AttributionSide
}

/**
 * The reconciliation output for one table (extensible per table in later phases). The R4a
 * fields are OPTIONAL here (defensive: a pre-R4a run's channel omits them) but the worker
 * always populates them.
 */
export interface TableReconciliation {
  diffs: SourceDiff[]
  agreements: number
  /** R4a — count of single-witness facts within the lag window (self-clear next run). No case. */
  pending?: number
  /** R4a — single-witness facts older than the lag window → `single_source_overdue` cases. */
  heldOverdue?: SingleSourceOverdue[]
  /** R4a — batches that could not resolve to one batch_id → `unresolved_batch` cases. */
  unresolvedBatches?: UnresolvedBatch[]
  /** Second-pass attribution pairings → `attribution_diff` cases. Optional (defensive: a
   *  pre-this-feature run's channel omits it). */
  attributionDiffs?: AttributionDiff[]
}

// ============================================================
// RB — block-balance cross-check (app-side MIRROR of the worker's
// reconcile/blockBalance.ts). An ORTHOGONAL, read-only net: the Sheet Blocking tab vs
// the computed view_blocking_grid. Kept local (the app never imports the worker package).
// MUST stay in lockstep with the worker's BlockDiff / BlockTotals / BlockReconciliation.
// ============================================================

/** The four block_diff shapes. */
export type BlockDiffKind = 'balance' | 'batch_mismatch' | 'multi_batch' | 'grand_total'

/** One block-level (or grand-total) disagreement between the Sheet and the app. NEVER a ₱. */
export interface BlockDiff {
  kind: BlockDiffKind
  /** The block; null ONLY for the single grand_total diff. */
  block_loc: string | null
  sheet_kg: number | null
  computed_kg: number | null
  delta: number | null
  sheet_batch?: string | null
  computed_batch?: string | null
  active_batch_count?: number
  /**
   * ── grand_total ONLY — the residual decomposition (2026-08-12) ──────────────
   * `accounted_block_kg` = Σ of the SIGNED kg gaps the per-block `balance` diffs of the same
   * run already account for; `residual_kg` = `delta − accounted_block_kg`, the part NO flagged
   * block explains — **that, not the delta, is the alarming number**; `fully_accounted` =
   * `|residual_kg|` within the grand-total tolerance.
   *
   * All four are OPTIONAL because a run stored before 2026-08-12 has none of them. A consumer
   * must treat "absent" as "unknown", never as "accounted for" — see `fromBlockDiff`, which
   * keeps such a diff at `high`.
   */
  accounted_block_kg?: number
  accounted_block_count?: number
  residual_kg?: number
  fully_accounted?: boolean
  /** Plain-language explanation (rendered as the case detail). */
  detail: string
}

export interface BlockTotals {
  sheetSumKg: number
  computedSumKg: number
  sheetStatedTotalKg: number | null
  delta: number
  sheetBlocks: number
  computedBlocks: number
  comparedBlocks: number
  negativeComputedBlocks: string[]
}

/** The RB reconciliation channel for the Blocking cross-check. */
export interface BlockReconciliation {
  blockDiffs: BlockDiff[]
  totals: BlockTotals
}

/**
 * One gsheet close-scan outcome (app-side MIRROR of the worker's
 * `lib/gsheetCloseScan.ts::BatchClose`). `matched:true` = a batch was flipped IN-USE→CLOSED
 * from a Google Sheet RC OUT close remark (info); `matched:false` = the Sheet asserted CLOSED
 * but no live batch matched the code (attention). NEVER a ₱/cost field.
 */
export interface BatchClose {
  batch_code: string | null
  location_ref: string | null
  transaction_date: string | null
  block_loc: string | null
  source_row: number | null
  matched: boolean
}

/** The plan-bearing fields of one production-schedule day.
 *  HISTORICAL — see `ScheduleConflict` below (no live producer since 2026-08-28). */
export type SchedulePlanField =
  | 'shifts'
  | 'setup'
  | 'projected_tons'
  | 'grades'
  | 'remarks'

/**
 * One production-PLAN day the sync REFUSED to write because a human owns it (app-side
 * MIRROR of the worker's `reports/prodSchedule/plan.ts::ScheduleConflict`). Joseph's
 * proposed value was parked in `production_schedule.pending_upstream` instead of being
 * applied; the operator arbitrates it. Never a ₱/cost field — this is a plan, not pricing.
 *
 * HISTORICAL (2026-08-28): the production PLAN was retired — `production_schedule`,
 * its UI and the sync's Stage 3c are gone, so NO LIVE RUN PRODUCES THIS ANY MORE.
 * It is kept, parseable and renderable, because historic `sync_runs.result` payloads
 * in the database still carry it and the Sync panel pages through past runs; a kind
 * the panel cannot parse renders as a blank card. Do not add a producer, and do not
 * add a write affordance — the arbitration dialog (the only caller of
 * `takeUpstreamProposal` / `keepMineClearPending`) was archived with the feature.
 * See `_archived/prod-schedule-v1/`.
 */
export interface ScheduleConflict {
  plan_date: string
  /** The upstream revision that wanted in ("joseph:REV6|gm<thread>.<uid>|<hash>"). */
  source_rev: string
  changed_fields: SchedulePlanField[]
  current: Record<string, unknown>
  proposed: Record<string, unknown>
}

/**
 * One report stream that has missed at least one PLANNED working day (app-side MIRROR of
 * the worker's `lib/streamStaleness.ts::StaleStream`). Read straight off
 * `view_digest_stream_status`; rest days and not-yet-due next-day reports are already
 * excluded there, so any row here is genuinely late. Never a ₱/cost field.
 */
export interface StaleStream {
  /** `deliveries` | `rc_out` | `production` | `electricity` | `trucks`. */
  stream: string
  label: string
  /** Latest date the stream has actually reported; null if it never has. */
  through_date: string | null
  operational_date: string | null
  /** Planned working days between the two, exclusive. Always >= 1. */
  missed_working_days: number
  reports_next_day: boolean
}

/**
 * The Excel sync report the worker generates at the end of every run (app-side MIRROR of
 * the worker's `reports/excel/generate.ts::ReportArtifact`), 2026-08-07.
 *
 * Present on EVERY terminal run, successful or not — the pointer is useful provenance and
 * lets the panel link to the download without a second query. It is a FINDING only when
 * `ok === false`: a reporting tool that can break the thing it reports on is worse than no
 * tool, so a generation failure never fails the run, it just says so out loud.
 *
 * Never a ₱/cost field. `contains_prices` is a claim ABOUT the workbook (see the
 * `sync_run_reports.contains_prices` column comment), not a price.
 */
/**
 * The freshness watch could not RUN (2026-08-18, L-044) — app-side MIRROR of the worker's
 * `reconcile/rcOutStage.ts::StaleStreamCheck`.
 *
 * PRESENT ONLY ON FAILURE, so its mere presence is the fact and a healthy run's shape is
 * unchanged. It exists because `stale_streams: []` cannot distinguish "nothing is late"
 * from "I could not look" — and for two weeks it silently meant the second: the worker's
 * service role had no SELECT grant on `view_digest_stream_status`, every read returned
 * 42501, and a bare `catch { return [] }` reported that as "Every report stream is up to
 * date." `stale_streams` is absent from every run in `sync_runs`; the watch built on
 * 2026-08-04 had never fired once. Never a ₱/cost field.
 */
export interface StaleStreamCheck {
  /** Only ever `false` — a successful check is represented by this member being absent. */
  ok: boolean
  /** Why the read failed, in the DB's own words. */
  error: string | null
}

/**
 * A Gmail search that ran longer than the worker's per-search budget (app-side MIRROR of
 * the worker's `workflows/mailClerk.ts::SlowGmailSearch`), 2026-08-19, BUG-026.
 *
 * WHY A RUN RECORDS HOW SLOW ITS OWN MAILBOX WAS. On 2026-08-19 the RC DELIVERIES search
 * took 58 s where it had taken 4–7 s on every earlier run that day, on the identical
 * build. Nothing was broken — Gmail was slow. But a slow run and a hung run look identical
 * from the panel, so the run was read as hung, Stopped, and started again, which put two
 * IMAP sessions on one account and made the replacement run slower still. Recording the
 * slowness is what lets "was the 19th just a slow day?" be answered next week from the
 * Excel report instead of guessed.
 *
 * Never a ₱/cost field — a query name, a Gmail query string and two durations.
 */
export interface SlowGmailSearch {
  /** The mail-clerk query key, e.g. `deliveries`, `deliveries_czarina`. */
  key: string
  /** Plain-English report label, e.g. "RC DELIVERIES". */
  label: string
  /** The Gmail query as issued ({since} already substituted). */
  query: string
  elapsed_ms: number
  /** The budget it exceeded, so a later reader knows what "slow" meant that day. */
  budget_ms: number
}

export interface ReportArtifact {
  ok: boolean
  /** Storage bucket + object path, absent exactly when ok is false. */
  bucket?: string | null
  path?: string | null
  filename?: string | null
  bytes?: number | null
  /** Sheet name -> data row count, so the panel can say what is inside. */
  sheet_counts?: Record<string, number>
  finding_count?: number
  warn_count?: number
  error_count?: number
  /** TRUE = the workbook carries ₱ data and the download is price-gated. */
  contains_prices?: boolean
  /** Why generation failed, in plain words. Only set when ok is false. */
  error?: string | null
}

/**
 * The top-level `result.reconciliation` channel. All members are OPTIONAL: a run may carry
 * the rc_out same-fact reconciliation, the RB blocking cross-check, the gsheet batch
 * close-scan, the production-plan conflicts, the freshness watch, any combination, or (on a
 * shadow-stage failure) none. The collect* folds guard each with optional chaining.
 */
export interface ReconciliationChannel {
  rc_out?: TableReconciliation
  blocking?: BlockReconciliation
  /** Batches closed this run from Google Sheet RC OUT close remarks (+ unmatched warnings). */
  batch_closes?: BatchClose[]
  /** Production-plan days the sync withheld because a human owns them (Stage 3c).
   *  HISTORICAL: no live producer since 2026-08-28 (the plan was retired). Still read
   *  so past runs render — see `ScheduleConflict`. */
  schedule_conflicts?: ScheduleConflict[]
  /**
   * Streams that have gone quiet (Stage 3e). The ONE finding that is about what did NOT
   * arrive rather than what this run wrote — a run where nothing came in otherwise looks
   * identical to a quiet day, which is how RC OUT went 5 days stale in July 2026.
   */
  stale_streams?: StaleStream[]
  /** Set ONLY when the freshness watch could not run — see `StaleStreamCheck`. */
  stale_stream_check?: StaleStreamCheck
  /**
   * Gmail searches that blew the worker's per-search budget (2026-08-19). Like
   * `stale_streams` this describes the RUN, not the data — how the mailbox behaved rather
   * than what it contained — and it is present only when something was actually slow.
   */
  gmail_slow_searches?: SlowGmailSearch[]
  /**
   * The Excel report generated for this run (2026-08-07). A pointer, always written; a
   * FINDING only when `ok` is false.
   */
  report_artifact?: ReportArtifact
}

// ============================================================
// Adjudication (Anthropic) — held-row recommendations
// ============================================================

export type AdjudicationVerdict = 'apply' | 'skip' | 'needs-human'

export interface HeldRowRecommendation {
  natural_key: string
  verdict: AdjudicationVerdict
  reason: string
  /** A short summary of the read-only DB finding that grounds the verdict (e.g.
   *  "identical 2026-06-30 MAIN 5,820kg row already in DB (id abc)"). Optional —
   *  absent for kinds with no lookup (malformed / low_confidence). */
  evidence?: string
}

// ============================================================
// Panel-facing aggregate result per report
// ============================================================

/** Lifecycle state of a single employee card during a run. */
export type SyncCardStatus =
  | 'idle'
  | 'classifying'
  | 'applying'
  | 'done'
  | 'gate-failed'
  | 'error'
  /** The run was Stopped mid-flight — a NEUTRAL terminal (not error-red). Rows
   *  already written are kept; the card just settles calmly to "Stopped". */
  | 'stopped'

/** What a single card holds after (or during) a run. */
export interface SyncCardState {
  type: SyncReportType
  status: SyncCardStatus
  classify: ClassifyResult | null
  apply: ApplyResult | null
  /** Full error text (incl. stderr) for the inline error block + Copy. */
  error: string | null

  // --- live progress (populated from the SSE stream) ---
  /** Latest reported stage, or null before the first progress event. */
  stage: SyncProgressStage | null
  /** 0–100 progress; drives the scaleX bar. */
  pct: number
  /** Plain-English status line (label + optional detail). Null → fall back to the busy verb. */
  statusLine: string | null
  /** True when the latest progress event was level:'warn' — tints the status line amber. */
  warn: boolean
  /** Technical stderr lines for the collapsible log (capped). */
  log: string[]
}
