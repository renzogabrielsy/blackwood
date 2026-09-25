/**
 * normalizeReport.ts — the ASSEMBLY-BOUNDARY normalizer (bug-fix, 2026-07-06).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Each report's `runReport(...)` returns a FLAT apply result:
 *     { report_type, ok, inserts, updates, [replaced_dates], held: HeldRow[],
 *       labeled, watermark_updated, errors }
 * plus its own classify block (counts/gate_failures/watermark).
 *
 * The FRONTEND (app/(app)/sync/types.ts + lib/sync/reducer.ts + SyncEmployeeCard +
 * HeldRows) reads a DIFFERENT, NESTED shape per report — `SyncRunReportResult`:
 *     { classify: ClassifyResult | null, apply: ApplyResult | null }
 * where `ApplyResult.applied` is a NESTED `{inserts, updates, replaced_dates}` object
 * (ALWAYS present on any non-null apply), and `held` is the FULL `HeldRow[]` ROWS —
 * not a count. That nested contract is the frozen SYNC_CLI_CONTRACT.md apply envelope.
 *
 * The old `ReportEnvelope` (reportWorkflow.ts) collapsed `held` to a COUNT, flattened
 * `applied`, and dropped `classify` entirely — so applied counts + the Held-for-review
 * section never populated, and a gate-failed report rendered nothing.
 *
 * This module maps EVERY report's `runReport()` return into `SyncRunReportResult`, so
 * what `runSync` writes to `sync_runs.result.reports[<type>]` is EXACTLY what the
 * frontend reads. It touches ONLY apply-result SHAPING + classify assembly — never the
 * report classify/extract/parity paths (those stay byte-identical).
 *
 * The types here are the WORKER-SIDE MIRROR of the frontend types. They MUST stay in
 * lockstep with app/(app)/sync/types.ts (`SyncRunReportResult`, `ClassifyResult`,
 * `ApplyResult`, `HeldRow`, `ApplyApplied`). The unit harness
 * (test/normalizeReport.test.ts) + scripts/verify-sync-reducer.ts assert both sides
 * describe the same JSON.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Worker-side mirror of the frontend contract (app/(app)/sync/types.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the frontend `HeldRow`. The three legacy fields are always present;
 * the three enrichment fields (kind/row/source_index, 2026-07-06) are optional and
 * passed through verbatim so the app adjudicator gets a decision-grade payload.
 * See src/reports/held.ts for the authoritative construction + the HeldKind enum.
 */
export interface HeldRow {
  reason: string;
  natural_key: string;
  detail: string;
  /** Normalized flag category the app keys its DB lookup off of. */
  kind?: string;
  /** Structured KEY fields for the adjudicator + DB lookup. NEVER a ₱/cost field. */
  row?: Record<string, unknown>;
  /** The former row index — retained for the apply-input mapping. */
  source_index?: string | number;
}

/**
 * ONE date a gate found at odds, with both sides' totals. Mirror of the frontend
 * `GateDriftDate`. Pure kg — never a ₱/cost field.
 */
export interface GateDriftDate {
  date: string;
  proposed_kg?: number | null;
  movement_kg?: number | null;
  diff_kg?: number | null;
  db_sum_kg?: number | null;
  excess_kg?: number | null;
  note?: string;
}

/** Mirror of the frontend `GateFailure`. */
export interface GateFailure {
  gate: string;
  detail: string;
  /**
   * L-049 (2026-09-07) — the dates that drove the gate. This USED TO BE DROPPED here:
   * `toGateFailures` coerced every gate failure down to `{gate, detail}`, so the auditor's
   * per-date `{date, db_sum_kg, movement_kg, excess_kg}` — which it had already built —
   * never reached the panel or the workbook, and the operator read the sentence
   * "2 drift date(s); max_severity=serious". Omitted (not `[]`) when the producer sent
   * none, so a gate failure that never had dates keeps byte-identical shape.
   */
  drift_dates?: GateDriftDate[];
}

/** Mirror of the frontend `ClassifyCounts`. */
export interface ClassifyCounts {
  noop: number;
  insert: number;
  update: number;
  flagged: number;
}

/** Mirror of the frontend `RowPreview`. */
export interface RowPreview {
  action: string;
  natural_key: string;
  summary: string;
}

/**
 * Mirror of the frontend `ClassifyResult`. The reducer/cards read `ok`,
 * `gate_failures`, `counts`, `watermark`; `rows_preview`/`classified_path`/`source`
 * are carried for contract-completeness (the worker has no per-row preview or
 * classified-file path, so they default to empty — the UI never depends on them).
 */
export interface ClassifyResult {
  report_type: string;
  ok: boolean;
  gate_failures: GateFailure[];
  counts: ClassifyCounts;
  rows_preview: RowPreview[];
  classified_path: string;
  source: Record<string, unknown>;
  watermark: string | null;
  /** Extra per-report breakdowns the CLI carried under top-level keys (per_mode /
   *  per_section / severity). Optional — the reducer ignores unknown keys. */
  [key: string]: unknown;
}

/** Mirror of the frontend `ApplyApplied` — the NESTED applied-counts object. */
export interface ApplyApplied {
  inserts: number;
  updates: number;
  /** COUNT of dates whose rows were replaced (flecon REPLACE-BY-DATE). A number. */
  replaced_dates: number;
}

/**
 * One batch the sync auto-created this apply (2026-07-11 policy — see
 * lib/batchAutoCreate.ts). Mirror of the frontend `AutoCreatedBatch`. NEVER a
 * ₱/cost field (avg_cost is always null on an auto-created batch).
 */
export interface AutoCreatedBatchNote {
  batch_code: string;
  location_ref: string;
  mode?: "rc_in" | "rc_out";
  transaction_date: string | null;
  block_loc: string | null;
  source_row: string | number | null;
}

/**
 * One below-watermark feeding the sync WROTE because a second witness corroborated the
 * gap (2026-09-07, L-049). Mirror of the frontend `RcOutBackfill`. Pure kg — `rc_out`
 * has no ₱ column at all.
 */
export interface RcOutBackfillNote {
  transaction_date: string;
  batch_code: string | null;
  block_loc: string | null;
  destination: string;
  weight_kg: number | null;
  movement_kg: number;
  db_kg_before: number;
  gap_kg: number;
  applied_kg: number;
  applied_row_count: number;
  source_row: string | number | null;
}

/**
 * One row filed against the batch already occupying its block, because the derived code
 * differed from it only in the two-digit YEAR (2026-09-07, L-049). Mirror of the frontend
 * `BatchAliasNote`. Pure kg.
 */
export interface BatchAliasNoteEntry {
  kind: string;
  derived_batch_code: string;
  resolved_batch_code: string;
  block_loc: string | null;
  occupying_status: string | null;
  occupying_balance_kg: number | null;
  transaction_date: string | null;
  source_row: string | number | null;
}

/**
 * One production-batch CHANGEOVER a run announced (2026-08-03 — see
 * reports/production/productionBatch.ts). Mirror of the frontend
 * `ProductionBatchStart`. NEVER a ₱/cost field.
 */
export interface ProductionBatchStartNote {
  transaction_date: string;
  new_batch: string;
  previous_batch: string;
  derivation: string;
  source_sheet: string;
}

/**
 * One production row the sync REFUSED to overwrite because a human edited it in the app
 * (the human-edit latch, 2026-08-03 — see reports/production/apply.ts). Mirror of the
 * frontend `ProductionHumanEdit`. Production carries no ₱/cost fields.
 */
export interface ProductionHumanEditNote {
  section: string;
  table: string;
  record_id: string;
  transaction_date: string | null;
  production_batch: string | null;
  shift: string | null;
  meter: string | null;
  plate_no: string | null;
  changed_fields: Array<{ field: string; yours: unknown; sheet: unknown }>;
  outcome: string;
}

/**
 * One downtime day whose typed DURATION cell disagrees with MC's own list of stop times,
 * or which was read from the typed total because no range parsed, or which the report
 * says the plant ran through (L-051 / L-051b). Mirror of the frontend `DowntimeNote` and
 * of `reports/production/apply.ts::DowntimeNote`. Production carries no ₱/cost field.
 */
export interface DowntimeNoteEntry {
  kind: string;
  transaction_date: string;
  production_batch: string | null;
  duration_mins: number | null;
  ranges_mins: number | null;
  minutes_source: string;
  dt_ranges: string | null;
  dt_incident_ranges: string | null;
  shift_hrs: number | null;
  shift_hrs_source: string | null;
  warnings: string[];
}

/**
 * One waste row Ivy's CUMULATIVE workbook states that the database is missing or
 * disagrees with, found BELOW the sync window (L-052, 2026-09-17). Mirror of the frontend
 * `WasteGapNote` and of `reports/production/wasteGap.ts::WasteGapNote`. Production carries
 * no ₱/cost field, so nothing here can be a price.
 */
export interface WasteGapNoteEntry {
  kind: string;
  transaction_date: string;
  production_batch: string;
  shift: string;
  shift_id: string;
  shift_has_runs: boolean;
  source_sheet: string;
  source_row: number;
  sheet_streams: Record<string, number>;
  sheet_total_kg: number;
  sheet_remarks: string | null;
  db_waste_id: string | null;
  db_streams: Record<string, number | null> | null;
  db_total_kg: number | null;
  db_remarks: string | null;
  differing_streams: string[];
  db_human_edited: boolean;
  waste_since: string | null;
  unmatched_dates: string[];
  pre_sync_era_rows: number;
}

/**
 * One DELIVERY the sync REFUSED to overwrite because a human edited it in the app (the
 * deliveries human-edit latch, 2026-08-08 — see reports/deliveryHumanEdit.ts). Mirror of
 * the frontend `DeliveryHumanEdit`.
 *
 * UNLIKE production, `deliveries` DOES carry a ₱ column that the latch can refuse
 * (`cost_basis`), so `changed_fields` may contain a `redacted` entry naming the field with
 * both values withheld. See `toDeliveryHumanEdit`.
 */
export interface DeliveryHumanEditNote {
  section: "deliveries" | "gsheet";
  table: string;
  record_id: string;
  transaction_date: string | null;
  supplier: string | null;
  batch_code: string | null;
  block_loc: string | null;
  truck_plate: string | null;
  changed_fields: Array<{ field: string; yours: unknown; sheet: unknown; redacted?: boolean }>;
  outcome: string;
}

/**
 * Delivery fields whose VALUES may never ride the findings channel. Mirrors
 * `reports/deliveryHumanEdit.ts::REDACTED_FIELDS` — kept as a local copy on purpose: this
 * module is the normalization boundary and must not depend on a report module. A
 * `scripts/verify-*` style drift check is unnecessary because both are one-element sets
 * over a column name that cannot change without a migration.
 */
const REDACTED_DELIVERY_FIELDS: ReadonlySet<string> = new Set(["cost_basis"]);

/**
 * One thing the DELIVERY PRICE step wants a human to see (2026-08-07 — see
 * reports/deliveries/enrich.ts). Mirror of the frontend `PriceNote`.
 *
 * Kinds: `price_tab_unresolved` / `price_tab_ambiguous` / `price_file_unreadable`
 * (the whole file or one month could not be used — the class of failure that silently
 * un-priced every August delivery), `price_fuzzy_match` (priced, but the two sources
 * spell the plate or supplier differently), `price_fuzzy_ambiguous` (refused: the
 * fallback key matched more than one row, or the one row it matched disagrees about
 * both plate and supplier), `price_date_drift` (refused: her file HAS this exact
 * supplier+plate+weight, but months away — the exact key carries no date because she
 * records the payment date, so unbounded it prices a December delivery from an August
 * row; the 7-day bound is the Python spec's own `max_date_drift_days`),
 * `price_out_of_band` (priced, but the number is unlike this
 * supplier's recent range).
 *
 * L-044 added three: `price_file_missing` (no price workbook in the mailbox window at
 * all), `price_no_row_matched` (the file opened, a month tab resolved, and NOT ONE
 * delivery matched — the signature of the WRONG workbook, which is how a bank cheque
 * ledger was used as the price list for two weeks) and `price_overdue_check_failed` (the
 * unpriced-delivery check could not be run, so this run cannot say whether any are
 * overdue — reported instead of returning a reassuring empty list).
 *
 * CARRIES NO ₱/COST FIELD, deliberately — see `toPriceNote`.
 */
export interface PriceNoteEntry {
  kind: string;
  detail: string;
  transaction_date: string | null;
  supplier: string | null;
  batch_code: string | null;
  truck_plate: string | null;
  weight_kg: number | null;
  sacks: number | null;
  source_row: string | null;
  /** exact | alias | fallback — which rung of the match ladder produced the price. */
  via: string | null;
  matched_sheet: string | null;
  matched_row: number | null;
  date_tolerance_days: number | null;
  /** The month the resolver wanted, e.g. "August 2026". */
  looked_for: string | null;
  /** Every worksheet tab the price file actually has — the other half of the message. */
  tabs_found: string[];
  /** Tabs that all normalize to the same month (the ambiguous case). */
  candidates: string[];
  /** The attachment filename the run actually used (L-044). A NAME, never a value. */
  source_filename: string | null;
  /** The tabs that resolved and were read, in the order requested (L-044). */
  tabs_loaded: string[];
  /** Priceable rows read out of those tabs. 0 with tabs loaded = an empty tab (L-044). */
  rows_loaded: number | null;
  /** How many of OUR deliveries the run tried to price (L-044). */
  rows_considered: number | null;
  /** `czarina` | `ours` — whose side the fallback key collided on. */
  collided_on: string | null;
  differences: Array<{ field: string; ours: string; theirs: string }>;
  collisions: Array<{ sheet: string | null; row: string; date: string | null }>;
}

/**
 * One delivery still unpriced more than a day after it happened (2026-08-07). Mirror of
 * the frontend `UnpricedOverdue`. Projected off `view_digest_unpriced_deliveries`, which
 * owns the overdue definition. No ₱ field: every row here has cost_basis = 0.
 */
export interface UnpricedOverdueNote {
  id: string;
  transaction_date: string;
  supplier: string | null;
  batch_code: string | null;
  truck_plate: string | null;
  weight_kg: number | null;
  sacks: number | null;
  days_pending: number;
  /**
   * Did a price workbook actually reach this run (2026-09-12, L-050)? `false` = "her file
   * was not in the mailbox window"; `true` = it was read and this row still did not match.
   * Before this existed the finding could only say "either it is missing from her file or
   * the sync could not match it" — and on 2026-09-12 the truth was a third thing: the price
   * step only ran inside the RC DELIVERIES email report, and no report had arrived.
   */
  looked_in_file: boolean | null;
  /** The worksheet tabs any price step of this run resolved and read. */
  tabs_read: string[];
}

/**
 * One delivery the operator has not assigned a pile to yet (L-042, 2026-08-13). Mirror of
 * the frontend `AwaitingBatchAssignment`. Never held and never a durable case — a quiet
 * visibility channel whose severity rises with `days_pending`. No PHP field: the operator
 * file has no price column and an unassigned row has no batch to cost against.
 */
export interface AwaitingBatchAssignmentNote {
  transaction_date: string;
  supplier: string | null;
  truck_plate: string | null;
  weight_kg: number | null;
  sacks: number | null;
  source_row: string | null;
  days_pending: number;
}

/**
 * One row of the RC DELIVERIES workbook the EXTRACTOR refused to treat as a delivery
 * (2026-09-25, L-054): `stray_row` or `weight_out_of_range`. Mirror of the frontend
 * `ExtractionNote`, built by `reports/deliveries/extractionNotes.ts`. Never held and never a
 * durable case. No PHP field — MC's workbook has no price column, and `cells` echoes only
 * the date/supplier/label/block/plate/weight/sacks/remarks columns. `weight_kg` stays
 * NULLABLE: "the Weight cell is not a number" must not read as "0 kg".
 */
export interface ExtractionNoteEntry {
  kind: string;
  reason_code: string;
  report_type: string;
  sheet: string;
  source_row: number;
  context_date: string | null;
  date_is_own: boolean;
  cells: Record<string, string>;
  weight_kg: number | null;
  supplier: string | null;
  truck_plate: string | null;
  batch_label: string | null;
  block_loc: string | null;
  summary_row: number | null;
  below_summary_row: boolean;
  cap_kg: number | null;
  detail: string;
}

/**
 * One source workbook this run opened and could not fully read (2026-09-03, L-048).
 * Mirror of the frontend `SourceTabNote`, built by `reports/sourceTabs.ts`. Never held and
 * never a durable case — the moment the tab names parse it stops firing. No PHP field:
 * sheet names, counts and a filename carry nothing to gate.
 */
export interface SourceTabNoteEntry {
  kind: string;
  report_type: string;
  source_label: string;
  filename: string | null;
  tabs_total: number;
  tabs_read: number;
  unreadable_tabs: string[];
  readable_tabs: string[];
  rows_extracted: number;
  source_left_unconsumed: boolean;
}

/**
 * ONE thing the `products` report noticed about the SHAPE of the PRODUCTS INVENTORY
 * sheet (2026-09-07). Mirror of the frontend `ProductNote`, built by
 * `reports/productNotes.ts` — a grade added, renamed, ambiguous, or gone.
 *
 * `rename_overlap_pct` is NULLABLE and must NOT be coerced with `num()`: 0% and "this
 * rename was decided on an identical fingerprint, so there is no percentage" are
 * different facts, and a 0 would read as an inference made on no evidence at all.
 */
export interface ProductNoteEntry {
  kind: string;
  sheet_name: string;
  code: string;
  previous_sheet_name?: string | null;
  previous_code?: string | null;
  rename_evidence?: string | null;
  rename_overlap_pct?: number | null;
  candidates?: string[];
  movement_count?: number;
  inserted?: number;
  deleted?: number;
}

/**
 * The report's source file did not arrive at all (2026-08-18, L-044). Mirror of the
 * frontend `ReportNotReceived`, built by `reports/reportNotReceived.ts`.
 *
 * OPTIONAL and ABSENT on an ordinary run — the presence of the key IS the fact, which is
 * why it is not an array with a length to check. `missed_working_days` is NULL, never 0,
 * when the stream-status view could not be read: 0 means "measured, on time", and a guess
 * must never impersonate a measurement.
 */
export interface ReportNotReceivedNote {
  report_type: string;
  source_label: string;
  stream: string;
  stream_label: string;
  since: string;
  through_date: string | null;
  operational_date: string | null;
  missed_working_days: number | null;
  /** WHY the number is null: `unreadable` | `unregistered` | `not_computable`. */
  lateness_unknown_reason: string | null;
  reports_next_day: boolean;
  as_of: string;
  /** L-048 — TRUE when an earlier run on the same Manila day already ingested this
   *  stream's email, so the empty mailbox is the sync's own doing. Never true on an
   *  unreadable bookkeeping row: an unknown must not quieten an alarm. */
  already_processed: boolean;
  last_processed_at: string | null;
  last_processed_email_id: string | null;
}

/**
 * Mirror of the frontend `ApplyResult`. `applied` is ALWAYS present on any non-null
 * apply (default zeros) so the card never sees a missing `applied` — even on a
 * gate-failure / error path where nothing was written. `held` carries the ROWS.
 * `auto_created_batches` is ALWAYS present (default []) — the run-visibility list of
 * batches the sync auto-created this apply.
 */
export interface ApplyResult {
  report_type: string;
  ok: boolean;
  applied: ApplyApplied;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  auto_created_batches: AutoCreatedBatchNote[];
  /** Below-watermark feedings this apply WROTE on a second witness's corroboration
   *  (L-049). ALWAYS present (default []). */
  rc_out_backfills: RcOutBackfillNote[];
  /** Rows filed against the pile already in their block because the derived code differed
   *  only by the year (L-049). ALWAYS present (default []). */
  batch_alias_notes: BatchAliasNoteEntry[];
  /** Production-batch changeovers this apply announced. ALWAYS present (default []). */
  production_batch_starts: ProductionBatchStartNote[];
  /** Production rows the sync refused to overwrite. ALWAYS present (default []). */
  production_human_edits: ProductionHumanEditNote[];
  /** Deliveries the DB refused to let the sync overwrite (the human-edit latch,
   *  2026-08-08). ALWAYS present (default []). Carries no PHP value: a refused
   *  `cost_basis` arrives already redacted by the worker and is re-stripped here, so a
   *  hand-built or replayed envelope cannot smuggle a price through. */
  delivery_human_edits: DeliveryHumanEditNote[];
  /** Delivery-price problems this run saw. ALWAYS present (default []). */
  price_notes: PriceNoteEntry[];
  /** Deliveries still unpriced >1 day on. ALWAYS present (default []). */
  unpriced_overdue: UnpricedOverdueNote[];
  /** Deliveries with no pile assigned yet (L-042). ALWAYS present (default []). */
  awaiting_batch_assignment: AwaitingBatchAssignmentNote[];
  /** Rows of the RC DELIVERIES workbook the extractor refused to call deliveries —
   *  stray rows and impossible weights (L-054). ALWAYS present (default []). Only the
   *  `deliveries` report fills it. */
  extraction_notes: ExtractionNoteEntry[];
  /** Source workbooks this run opened and could not fully read (L-048). ALWAYS present
   *  (default []), so an ordinary run's shape does not depend on nothing going wrong. */
  source_tab_notes: SourceTabNoteEntry[];
  /** What the `products` report noticed about the PRODUCTS INVENTORY sheet's shape
   *  (2026-09-07). ALWAYS present (default []). */
  product_notes: ProductNoteEntry[];
  /**
   * Downtime days whose typed DURATION cell disagrees with MC's own list of stop times
   * (L-051, 2026-09-14). ALWAYS present (default []).
   *
   * ⚠️ THIS KEY WAS MISSING FROM THIS BOUNDARY UNTIL 2026-09-17 (L-052). `apply.ts` built
   * the notes, `cases-fold.ts` read `apply.downtime_notes` and `findings.ts` had three
   * builders ready for them — but `toApplyResult` below constructs a FIXED-KEY object, so
   * the array was dropped here and never reached `sync_runs.result`. Measured: zero of the
   * stored runs carry the key, i.e. L-051's three findings had never once fired. This is
   * L-044's shape exactly — an alarm that was built, wired at both ends, and silently
   * disconnected in the middle — and it is why the L-052 channel below was added in the
   * same change rather than beside a still-broken sibling.
   */
  downtime_notes: DowntimeNoteEntry[];
  /** Waste rows Ivy's CUMULATIVE workbook states that the database is missing or
   *  disagrees with, found BELOW the sync window (L-052). ALWAYS present (default []). */
  waste_notes: WasteGapNoteEntry[];
  /** Set ONLY when this report's source file never arrived (L-044). Absent otherwise. */
  report_not_received?: ReportNotReceivedNote;
}

/** Terminal card status the worker may pre-decide (mirror of frontend SyncCardStatus). */
export type SyncCardStatus =
  | "idle"
  | "classifying"
  | "applying"
  | "done"
  | "gate-failed"
  | "error"
  | "stopped";

/**
 * Mirror of the frontend `SyncRunReportResult` — the per-report unit written to
 * `sync_runs.result.reports[<type>]`. This is THE canonical shape.
 *   - Read-only auditor (rc_movement_audit) + dryRun apply → `apply: null`.
 *   - A report that never ran (no source email) still returns a `classify` with zero
 *     counts and `apply` reflecting the empty write (or null in dryRun).
 */
export interface SyncRunReportResult {
  classify: ClassifyResult | null;
  apply: ApplyResult | null;
  status?: SyncCardStatus;
  error?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loose input shapes — what each report's runReport() actually returns. We read
// these defensively (every field guarded) so a shape drift degrades to zeros, never
// a crash at the assembly boundary.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A report classify block as returned by the writer ports (deliveries/rc_out/…).
 * Loose + read defensively — every field guarded in `normalizeClassify`. No index
 * signature so the concrete port classify types assign structurally.
 */
interface RawClassify {
  report_type?: string;
  ok?: boolean;
  gate_failures?: ReadonlyArray<{ gate?: unknown; detail?: unknown; drift_dates?: unknown }>;
  counts?: { noop?: number; insert?: number; update?: number; flagged?: number };
  watermark?: string | null;
}

/**
 * A flat apply result as returned by the writer ports' apply.ts. Loose superset of
 * every port's apply return (deliveries/rc_out/production/flecon/gsheet) — the shared
 * fields plus flecon's `replaced_dates`. No index signature (see RawClassify).
 */
interface RawApply {
  report_type?: string;
  ok?: boolean;
  inserts?: number;
  updates?: number;
  /** flecon only — dates replaced (REPLACE-BY-DATE). */
  replaced_dates?: number;
  held?: unknown;
  labeled?: boolean;
  watermark_updated?: boolean;
  errors?: unknown;
  /** gsheet (top-level) / rc_out — batches auto-created this apply. */
  auto_created_batches?: unknown;
  /** rc_out only — below-watermark feedings written on corroboration (L-049). */
  rc_out_backfills?: unknown;
  /** rc_out only — rows filed against the block's existing occupant (L-049). */
  batch_alias_notes?: unknown;
  /** production only — batch changeovers announced this apply. */
  production_batch_starts?: unknown;
  /** production only — rows the sync refused to overwrite (human-edit latch). */
  production_human_edits?: unknown;
  /** production only — downtime days whose two halves disagree (L-051). */
  downtime_notes?: unknown;
  /** production only — waste rows below the window the DB is missing / disagrees with. */
  waste_notes?: unknown;
  delivery_human_edits?: unknown;
  /** deliveries only — price-step problems (tab miss, fuzzy match, out-of-band). */
  price_notes?: unknown;
  /** deliveries only — deliveries still unpriced more than a day after the fact. */
  unpriced_overdue?: unknown;
  /** deliveries only — rows weighed in with no pile assigned yet (L-042). */
  awaiting_batch_assignment?: unknown;
  /** deliveries only — rows the extractor refused to call deliveries (L-054). */
  extraction_notes?: unknown;
  /** rc_out only (today) — workbooks opened whose tab names could not all be read (L-048). */
  source_tab_notes?: unknown;
  /** products only — grades added, renamed, ambiguous or gone (2026-09-07). */
  product_notes?: unknown;
  /** Set only when this report's source file never arrived at all (L-044). */
  report_not_received?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion helpers — every field guarded (a bad worker write must never crash the
// assembly; it degrades to a safe default).
// ─────────────────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : [];
}

/** Coerce a raw held entry (typed reason unions, optional detail) → contract HeldRow.
 *  Passes the enrichment fields (kind/row/source_index) through when present. */
function toHeldRow(h: unknown): HeldRow {
  const o = (h ?? {}) as Record<string, unknown>;
  const out: HeldRow = {
    reason: str(o.reason),
    natural_key: str(o.natural_key),
    detail: str(o.detail),
  };
  if (typeof o.kind === "string") out.kind = o.kind;
  if (o.row && typeof o.row === "object" && !Array.isArray(o.row)) {
    out.row = o.row as Record<string, unknown>;
  }
  if (typeof o.source_index === "string" || typeof o.source_index === "number") {
    out.source_index = o.source_index;
  }
  return out;
}

/** Coerce a raw held array (any of the ports' HeldEntry/HeldRow shapes) → HeldRow[]. */
export function toHeldRows(v: unknown): HeldRow[] {
  return Array.isArray(v) ? v.map(toHeldRow) : [];
}

/** Coerce a raw auto-created-batch entry → contract AutoCreatedBatchNote. Every
 *  field guarded — a bad/missing entry degrades to safe defaults, never a crash. */
function toAutoCreatedBatch(v: unknown): AutoCreatedBatchNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const mode = o.mode === "rc_in" || o.mode === "rc_out" ? o.mode : undefined;
  const sourceRow =
    typeof o.source_row === "string" || typeof o.source_row === "number" ? o.source_row : null;
  return {
    batch_code: str(o.batch_code),
    location_ref: str(o.location_ref),
    ...(mode ? { mode } : {}),
    transaction_date: typeof o.transaction_date === "string" ? o.transaction_date : null,
    block_loc: typeof o.block_loc === "string" ? o.block_loc : null,
    source_row: sourceRow,
  };
}

/** Coerce a raw auto-created-batches array → AutoCreatedBatchNote[]. */
function toAutoCreatedBatches(v: unknown): AutoCreatedBatchNote[] {
  return Array.isArray(v) ? v.map(toAutoCreatedBatch) : [];
}

/** `number | null` — a non-finite / absent value becomes null, NEVER 0 (a kg figure of
 *  zero and "not recorded" are different answers; the NULL≠0 rule). */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce one raw corroborated-backfill entry → RcOutBackfillNote. Every field guarded. */
function toRcOutBackfill(v: unknown): RcOutBackfillNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const sourceRow =
    typeof o.source_row === "string" || typeof o.source_row === "number" ? o.source_row : null;
  return {
    transaction_date: str(o.transaction_date),
    batch_code: typeof o.batch_code === "string" ? o.batch_code : null,
    block_loc: typeof o.block_loc === "string" ? o.block_loc : null,
    destination: str(o.destination) || "MAIN",
    weight_kg: numOrNull(o.weight_kg),
    movement_kg: num(o.movement_kg),
    db_kg_before: num(o.db_kg_before),
    gap_kg: num(o.gap_kg),
    applied_kg: num(o.applied_kg),
    applied_row_count: num(o.applied_row_count),
    source_row: sourceRow,
  };
}

function toRcOutBackfills(v: unknown): RcOutBackfillNote[] {
  return Array.isArray(v) ? v.map(toRcOutBackfill) : [];
}

/** Coerce one raw year-alias entry → BatchAliasNoteEntry. Every field guarded. */
function toBatchAliasNote(v: unknown): BatchAliasNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const sourceRow =
    typeof o.source_row === "string" || typeof o.source_row === "number" ? o.source_row : null;
  return {
    kind: str(o.kind) || "year_alias_of_block_occupant",
    derived_batch_code: str(o.derived_batch_code),
    resolved_batch_code: str(o.resolved_batch_code),
    block_loc: typeof o.block_loc === "string" ? o.block_loc : null,
    occupying_status: typeof o.occupying_status === "string" ? o.occupying_status : null,
    occupying_balance_kg: numOrNull(o.occupying_balance_kg),
    transaction_date: typeof o.transaction_date === "string" ? o.transaction_date : null,
    source_row: sourceRow,
  };
}

function toBatchAliasNotes(v: unknown): BatchAliasNoteEntry[] {
  return Array.isArray(v) ? v.map(toBatchAliasNote) : [];
}

/** Coerce a raw batch-changeover entry → contract ProductionBatchStartNote. Every
 *  field guarded — a bad/missing entry degrades to safe defaults, never a crash. */
function toProductionBatchStart(v: unknown): ProductionBatchStartNote {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    transaction_date: str(o.transaction_date),
    new_batch: str(o.new_batch),
    previous_batch: str(o.previous_batch),
    derivation: str(o.derivation),
    source_sheet: str(o.source_sheet),
  };
}

/** Coerce a raw batch-changeover array → ProductionBatchStartNote[]. */
function toProductionBatchStarts(v: unknown): ProductionBatchStartNote[] {
  return Array.isArray(v) ? v.map(toProductionBatchStart) : [];
}

/** Coerce one raw refused-overwrite entry → contract ProductionHumanEditNote. */
function toProductionHumanEdit(v: unknown): ProductionHumanEditNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  const fields = Array.isArray(o.changed_fields) ? o.changed_fields : [];
  return {
    section: str(o.section),
    table: str(o.table),
    record_id: str(o.record_id),
    transaction_date: nullable(o.transaction_date),
    production_batch: nullable(o.production_batch),
    shift: nullable(o.shift),
    meter: nullable(o.meter),
    plate_no: nullable(o.plate_no),
    changed_fields: fields.map((f) => {
      const e = (f ?? {}) as Record<string, unknown>;
      return { field: str(e.field), yours: e.yours ?? null, sheet: e.sheet ?? null };
    }),
    outcome: str(o.outcome),
  };
}

/** Coerce a raw refused-overwrite array → ProductionHumanEditNote[]. */
function toProductionHumanEdits(v: unknown): ProductionHumanEditNote[] {
  return Array.isArray(v) ? v.map(toProductionHumanEdit) : [];
}

/**
 * Coerce one raw refused-delivery entry → contract DeliveryHumanEditNote (2026-08-08).
 *
 * The `redacted` re-strip is deliberate BELT AND BRACES. The worker already withholds a
 * refused `cost_basis` at the point the note is built, but this function is also the door
 * every REPLAYED and hand-built envelope comes through, and the findings channel it feeds
 * is not price-gated. Re-applying the strip here means the ONLY way a price could reach
 * the channel is if both defences were removed in the same edit.
 */
function toDeliveryHumanEdit(v: unknown): DeliveryHumanEditNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  const fields = Array.isArray(o.changed_fields) ? o.changed_fields : [];
  const section = str(o.section) === "gsheet" ? "gsheet" : "deliveries";
  return {
    section,
    table: str(o.table) || "deliveries",
    record_id: str(o.record_id),
    transaction_date: nullable(o.transaction_date),
    supplier: nullable(o.supplier),
    batch_code: nullable(o.batch_code),
    block_loc: nullable(o.block_loc),
    truck_plate: nullable(o.truck_plate),
    changed_fields: fields.map((f) => {
      const e = (f ?? {}) as Record<string, unknown>;
      const field = str(e.field);
      if (REDACTED_DELIVERY_FIELDS.has(field) || e.redacted === true) {
        return { field, yours: null, sheet: null, redacted: true };
      }
      return { field, yours: e.yours ?? null, sheet: e.sheet ?? null };
    }),
    outcome: str(o.outcome),
  };
}

/** Coerce a raw refused-delivery array → DeliveryHumanEditNote[]. */
function toDeliveryHumanEdits(v: unknown): DeliveryHumanEditNote[] {
  return Array.isArray(v) ? v.map(toDeliveryHumanEdit) : [];
}

/**
 * Coerce one raw price note → contract PriceNoteEntry (2026-08-07).
 *
 * NEVER carries a ₱/cost value — the run-findings channel is not price-gated. The note
 * identifies the ROW and describes the problem in words; the number stays in RC IN
 * behind `canViewPrices()`. If a future note gains a price field, it must be dropped
 * here rather than passed through.
 */
function toPriceNote(v: unknown): PriceNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  const nnum = (x: unknown): number | null => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const diffs = Array.isArray(o.differences) ? o.differences : [];
  const colls = Array.isArray(o.collisions) ? o.collisions : [];
  return {
    kind: str(o.kind),
    detail: str(o.detail),
    transaction_date: nullable(o.transaction_date),
    supplier: nullable(o.supplier),
    batch_code: nullable(o.batch_code),
    truck_plate: nullable(o.truck_plate),
    weight_kg: nnum(o.weight_kg),
    sacks: nnum(o.sacks),
    source_row: nullable(o.source_row),
    via: nullable(o.via),
    matched_sheet: nullable(o.matched_sheet),
    matched_row: nnum(o.matched_row),
    date_tolerance_days: nnum(o.date_tolerance_days),
    looked_for: nullable(o.looked_for),
    tabs_found: strArray(o.tabs_found),
    candidates: strArray(o.candidates),
    // L-044 — WHICH workbook was read, and what came out of it. `source_filename` is a
    // NAME, never a value: it is the one fact that distinguishes "the price file has a
    // problem" from "that was never the price file", and it carries no PHP.
    source_filename: nullable(o.source_filename),
    tabs_loaded: strArray(o.tabs_loaded),
    rows_loaded: nnum(o.rows_loaded),
    rows_considered: nnum(o.rows_considered),
    collided_on: nullable(o.collided_on),
    differences: diffs.map((d) => {
      const e = (d ?? {}) as Record<string, unknown>;
      return { field: str(e.field), ours: str(e.ours), theirs: str(e.theirs) };
    }),
    collisions: colls.map((c) => {
      const e = (c ?? {}) as Record<string, unknown>;
      return { sheet: nullable(e.sheet), row: str(e.row), date: nullable(e.date) };
    }),
  };
}

/** Coerce a raw price-notes array → PriceNoteEntry[]. */
function toPriceNotes(v: unknown): PriceNoteEntry[] {
  return Array.isArray(v) ? v.map(toPriceNote) : [];
}

/** Coerce one raw overdue-unpriced entry → UnpricedOverdueNote. No ₱ by construction. */
function toUnpricedOverdue(v: unknown): UnpricedOverdueNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  const nnum = (x: unknown): number | null => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: str(o.id),
    transaction_date: str(o.transaction_date),
    supplier: nullable(o.supplier),
    batch_code: nullable(o.batch_code),
    truck_plate: nullable(o.truck_plate),
    weight_kg: nnum(o.weight_kg),
    sacks: nnum(o.sacks),
    days_pending: num(o.days_pending),
    // NULL, never false (L-050): "we don't know whether the sync looked" and "the sync
    // looked and found nothing" are different answers, and only one of them is a reason to
    // go and chase Czarina. A payload written before this field existed reads null.
    looked_in_file: typeof o.looked_in_file === "boolean" ? o.looked_in_file : null,
    tabs_read: strArray(o.tabs_read),
  };
}

/** Coerce a raw overdue-unpriced array → UnpricedOverdueNote[]. */
function toUnpricedOverdues(v: unknown): UnpricedOverdueNote[] {
  return Array.isArray(v) ? v.map(toUnpricedOverdue) : [];
}

/** Coerce one raw awaiting-assignment entry → AwaitingBatchAssignmentNote (L-042). */
function toAwaitingBatchAssignment(v: unknown): AwaitingBatchAssignmentNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  const nnum = (x: unknown): number | null => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    transaction_date: str(o.transaction_date),
    supplier: nullable(o.supplier),
    truck_plate: nullable(o.truck_plate),
    weight_kg: nnum(o.weight_kg),
    sacks: nnum(o.sacks),
    source_row: nullable(o.source_row),
    days_pending: num(o.days_pending),
  };
}

/** Coerce a raw awaiting-assignment array → AwaitingBatchAssignmentNote[]. */
function toAwaitingBatchAssignments(v: unknown): AwaitingBatchAssignmentNote[] {
  return Array.isArray(v) ? v.map(toAwaitingBatchAssignment) : [];
}

/**
 * Coerce one raw extraction note → ExtractionNoteEntry (L-054). No PHP by construction; the
 * `cells` map is re-filtered to string values under non-cost-ish keys anyway, so a
 * hand-built or replayed envelope cannot smuggle a price through it.
 */
function toExtractionNote(v: unknown): ExtractionNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : null;
  const nnum = (x: unknown): number | null => {
    if (x === null || x === undefined || x === "") return null;
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const cells: Record<string, string> = {};
  if (o.cells && typeof o.cells === "object" && !Array.isArray(o.cells)) {
    for (const [k, val] of Object.entries(o.cells as Record<string, unknown>)) {
      if (/cost|price|php|₱|amount|value/i.test(k)) continue;
      if (typeof val === "string" || typeof val === "number") cells[k] = String(val);
    }
  }
  return {
    kind: str(o.kind) || "stray_row",
    reason_code: str(o.reason_code),
    report_type: str(o.report_type) || "deliveries",
    sheet: str(o.sheet),
    source_row: num(o.source_row),
    context_date: nullable(o.context_date),
    date_is_own: o.date_is_own === true,
    cells,
    weight_kg: nnum(o.weight_kg),
    supplier: nullable(o.supplier),
    truck_plate: nullable(o.truck_plate),
    batch_label: nullable(o.batch_label),
    block_loc: nullable(o.block_loc),
    summary_row: nnum(o.summary_row),
    below_summary_row: o.below_summary_row === true,
    cap_kg: nnum(o.cap_kg),
    detail: str(o.detail),
  };
}

/** Coerce a raw extraction-notes array → ExtractionNoteEntry[]. */
function toExtractionNotes(v: unknown): ExtractionNoteEntry[] {
  return Array.isArray(v) ? v.map(toExtractionNote) : [];
}

/** Coerce one raw source-tab note → SourceTabNoteEntry (L-048). No PHP by construction. */
function toSourceTabNote(v: unknown): SourceTabNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : null;
  return {
    kind: str(o.kind) || "source_tabs_unreadable",
    report_type: str(o.report_type),
    source_label: str(o.source_label),
    filename: nullable(o.filename),
    tabs_total: num(o.tabs_total),
    tabs_read: num(o.tabs_read),
    unreadable_tabs: strArray(o.unreadable_tabs),
    readable_tabs: strArray(o.readable_tabs),
    rows_extracted: num(o.rows_extracted),
    source_left_unconsumed: o.source_left_unconsumed === true,
  };
}

/** Coerce a raw source-tab-notes array → SourceTabNoteEntry[]. */
function toSourceTabNotes(v: unknown): SourceTabNoteEntry[] {
  return Array.isArray(v) ? v.map(toSourceTabNote) : [];
}

/**
 * Coerce one raw downtime note → DowntimeNoteEntry (L-051). Every numeric stays NULLABLE:
 * a blank DURATION cell states nothing, and 0 would claim it stated zero.
 */
function toDowntimeNote(v: unknown): DowntimeNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullableStr = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : null;
  const nnum = (x: unknown): number | null => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    kind: str(o.kind) || "downtime_duration_mismatch",
    transaction_date: str(o.transaction_date),
    production_batch: nullableStr(o.production_batch),
    duration_mins: nnum(o.duration_mins),
    ranges_mins: nnum(o.ranges_mins),
    minutes_source: str(o.minutes_source),
    dt_ranges: nullableStr(o.dt_ranges),
    dt_incident_ranges: nullableStr(o.dt_incident_ranges),
    shift_hrs: nnum(o.shift_hrs),
    shift_hrs_source: nullableStr(o.shift_hrs_source),
    warnings: strArray(o.warnings),
  };
}

function toDowntimeNotes(v: unknown): DowntimeNoteEntry[] {
  return Array.isArray(v) ? v.map(toDowntimeNote) : [];
}

/** Coerce one raw waste-gap note → WasteGapNoteEntry (L-052). Production carries no ₱
 *  column at all, so nothing here can be a price. */
function toWasteGapNote(v: unknown): WasteGapNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullableStr = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : null;
  const nnum = (x: unknown): number | null => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const numMap = (x: unknown): Record<string, number> => {
    const src = (x ?? {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(src)) {
      const n = typeof val === "number" ? val : Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  };
  const nullableNumMap = (x: unknown): Record<string, number | null> | null => {
    if (x == null || typeof x !== "object") return null;
    const out: Record<string, number | null> = {};
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      const n = typeof val === "number" ? val : Number(val);
      out[k] = Number.isFinite(n) ? n : null;
    }
    return out;
  };
  return {
    kind: str(o.kind) || "waste_row_missing",
    transaction_date: str(o.transaction_date),
    production_batch: str(o.production_batch),
    shift: str(o.shift),
    shift_id: str(o.shift_id),
    shift_has_runs: o.shift_has_runs === true,
    source_sheet: str(o.source_sheet),
    source_row: num(o.source_row),
    sheet_streams: numMap(o.sheet_streams),
    sheet_total_kg: num(o.sheet_total_kg),
    sheet_remarks: nullableStr(o.sheet_remarks),
    db_waste_id: nullableStr(o.db_waste_id),
    db_streams: nullableNumMap(o.db_streams),
    db_total_kg: nnum(o.db_total_kg),
    db_remarks: nullableStr(o.db_remarks),
    differing_streams: strArray(o.differing_streams),
    db_human_edited: o.db_human_edited === true,
    waste_since: nullableStr(o.waste_since),
    unmatched_dates: strArray(o.unmatched_dates),
    pre_sync_era_rows: num(o.pre_sync_era_rows),
  };
}

function toWasteGapNotes(v: unknown): WasteGapNoteEntry[] {
  return Array.isArray(v) ? v.map(toWasteGapNote) : [];
}

/** Coerce one raw products note. Every field is guarded; `rename_overlap_pct` is kept
 *  NULLABLE on purpose (see ProductNoteEntry) rather than being flattened to 0. */
function toProductNote(v: unknown): ProductNoteEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const nullableStr = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : null;
  const pct = o.rename_overlap_pct;
  const out: ProductNoteEntry = {
    kind: str(o.kind),
    sheet_name: str(o.sheet_name),
    code: str(o.code),
    previous_sheet_name: nullableStr(o.previous_sheet_name),
    previous_code: nullableStr(o.previous_code),
    rename_evidence: nullableStr(o.rename_evidence),
    rename_overlap_pct:
      typeof pct === "number" && Number.isFinite(pct) ? pct : null,
    movement_count: num(o.movement_count),
    inserted: num(o.inserted),
    deleted: num(o.deleted),
  };
  if (Array.isArray(o.candidates)) out.candidates = strArray(o.candidates);
  return out;
}

function toProductNotes(v: unknown): ProductNoteEntry[] {
  return Array.isArray(v) ? v.map(toProductNote) : [];
}

/**
 * Coerce a raw "the report never arrived" note → ReportNotReceivedNote, or null (L-044).
 *
 * `missed_working_days` is the one field that must NOT be coerced with `num()`: that helper
 * returns 0 for anything unreadable, and 0 means "measured, and on time". An unreadable
 * lateness figure has to stay NULL so the finding says "no report arrived" without also
 * claiming, on no evidence, that nothing is late.
 */
function toReportNotReceived(v: unknown): ReportNotReceivedNote | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const nullable = (x: unknown): string | null =>
    typeof x === "string" && x.trim() ? x : typeof x === "number" ? String(x) : null;
  // NOTE `Number(null) === 0` — the exact coercion this field must not suffer. An
  // absent/unreadable lateness figure has to stay NULL: 0 means "measured, on time".
  const rawMissed = o.missed_working_days;
  const missed =
    rawMissed == null
      ? NaN
      : typeof rawMissed === "number"
        ? rawMissed
        : Number(rawMissed);
  return {
    report_type: str(o.report_type),
    source_label: str(o.source_label),
    stream: str(o.stream),
    stream_label: str(o.stream_label),
    since: str(o.since),
    through_date: nullable(o.through_date),
    operational_date: nullable(o.operational_date),
    missed_working_days: Number.isFinite(missed) ? missed : null,
    lateness_unknown_reason: nullable(o.lateness_unknown_reason),
    reports_next_day: o.reports_next_day === true,
    as_of: str(o.as_of),
    // Boolean-strict, not truthy: only an explicit `true` may downgrade the finding, so a
    // missing/garbled field leaves it at full volume (L-048).
    already_processed: o.already_processed === true,
    last_processed_at: nullable(o.last_processed_at),
    last_processed_email_id: nullable(o.last_processed_email_id),
  };
}

/** Coerce one raw drift date → GateDriftDate. Only the keys that were actually present
 *  are carried, so a P-vs-M entry does not sprout empty O-vs-M fields (and vice versa). */
function toGateDriftDate(v: unknown): GateDriftDate {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: GateDriftDate = { date: str(o.date) };
  if ("proposed_kg" in o) out.proposed_kg = numOrNull(o.proposed_kg);
  if ("movement_kg" in o) out.movement_kg = numOrNull(o.movement_kg);
  if ("diff_kg" in o) out.diff_kg = numOrNull(o.diff_kg);
  if ("db_sum_kg" in o) out.db_sum_kg = numOrNull(o.db_sum_kg);
  if ("excess_kg" in o) out.excess_kg = numOrNull(o.excess_kg);
  if (typeof o.note === "string") out.note = o.note;
  return out;
}

/** Coerce a raw gate_failures array → contract GateFailure[].
 *
 *  L-049: `drift_dates` is CARRIED now. It used to be dropped here, which is the whole
 *  reason a serious movement drift reached the operator as a bare count. Spread, not
 *  assigned — a producer that sends none keeps the exact `{gate, detail}` shape it had. */
function toGateFailures(v: unknown): GateFailure[] {
  if (!Array.isArray(v)) return [];
  return v.map((g) => {
    const o = (g ?? {}) as Record<string, unknown>;
    const drift = Array.isArray(o.drift_dates) ? o.drift_dates.map(toGateDriftDate) : null;
    return {
      gate: str(o.gate),
      detail: str(o.detail),
      ...(drift && drift.length ? { drift_dates: drift } : {}),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The normalizers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a writer report's classify block → contract `ClassifyResult`. Carries the
 * fields the reducer reads (ok/gate_failures/counts/watermark) plus any extra top-level
 * breakdown keys (per_mode/per_section) untouched, and fills the required-but-unused
 * contract fields (rows_preview/classified_path/source) with safe empties.
 */
export function normalizeClassify(
  reportType: string,
  raw: RawClassify | null | undefined,
  extra?: Record<string, unknown>,
): ClassifyResult {
  const c = raw ?? {};
  const counts = c.counts ?? {};
  return {
    report_type: str(c.report_type) || reportType,
    ok: c.ok !== false, // default true
    gate_failures: toGateFailures(c.gate_failures),
    counts: {
      noop: num(counts.noop),
      insert: num(counts.insert),
      update: num(counts.update),
      flagged: num(counts.flagged),
    },
    rows_preview: [],
    classified_path: "",
    source: {},
    watermark: typeof c.watermark === "string" ? c.watermark : null,
    ...(extra ?? {}),
  };
}

/**
 * Normalize a writer report's FLAT apply result → contract `ApplyResult`. `applied` is
 * ALWAYS present (nested, default zeros); `held` is the full ROWS. `null` in →
 * read-only/dryRun/no-apply. Coerces the flecon `replaced_dates` when present.
 */
export function normalizeApply(
  reportType: string,
  raw: RawApply | null | undefined,
): ApplyResult | null {
  if (raw == null) return null;
  const notReceived = toReportNotReceived(raw.report_not_received);
  return {
    report_type: str(raw.report_type) || reportType,
    ok: raw.ok !== false, // default true
    applied: {
      inserts: num(raw.inserts),
      updates: num(raw.updates),
      replaced_dates: num(raw.replaced_dates),
    },
    held: toHeldRows(raw.held),
    labeled: Boolean(raw.labeled),
    watermark_updated: Boolean(raw.watermark_updated),
    errors: strArray(raw.errors),
    auto_created_batches: toAutoCreatedBatches(raw.auto_created_batches),
    rc_out_backfills: toRcOutBackfills(raw.rc_out_backfills),
    batch_alias_notes: toBatchAliasNotes(raw.batch_alias_notes),
    production_batch_starts: toProductionBatchStarts(raw.production_batch_starts),
    production_human_edits: toProductionHumanEdits(raw.production_human_edits),
    delivery_human_edits: toDeliveryHumanEdits(raw.delivery_human_edits),
    price_notes: toPriceNotes(raw.price_notes),
    unpriced_overdue: toUnpricedOverdues(raw.unpriced_overdue),
    awaiting_batch_assignment: toAwaitingBatchAssignments(raw.awaiting_batch_assignment),
    extraction_notes: toExtractionNotes(raw.extraction_notes),
    source_tab_notes: toSourceTabNotes(raw.source_tab_notes),
    product_notes: toProductNotes(raw.product_notes),
    downtime_notes: toDowntimeNotes(raw.downtime_notes),
    waste_notes: toWasteGapNotes(raw.waste_notes),
    // L-044 — spread, not assigned: the KEY'S PRESENCE is the fact ("no report arrived"),
    // so an ordinary run must keep the byte-identical shape it had before this existed.
    ...(notReceived ? { report_not_received: notReceived } : {}),
  };
}

/**
 * Build the canonical per-report `SyncRunReportResult` from a report's classify + flat
 * apply. `apply === null` (or `undefined`) → read-only auditor / dryRun. The `extra`
 * bag is merged into the classify block (per_mode/per_section/severity carriers).
 */
export function toReportResult(params: {
  reportType: string;
  classify: RawClassify | null | undefined;
  apply?: RawApply | null;
  classifyExtra?: Record<string, unknown>;
  status?: SyncCardStatus;
  error?: string | null;
}): SyncRunReportResult {
  const classify = normalizeClassify(params.reportType, params.classify, params.classifyExtra);
  const apply = params.apply === undefined ? null : normalizeApply(params.reportType, params.apply);
  const result: SyncRunReportResult = { classify, apply };
  if (params.status) result.status = params.status;
  if (params.error != null) result.error = params.error;
  return result;
}

/**
 * The FAILURE-ISOLATION result: a report that THREW. Contract-shaped so the card
 * renders an error (not a crash) — classify present with ok:false so the reducer's
 * `deriveCardStatus` settles to 'error'/'gate-failed', `applied` zeros present.
 */
export function failedReportResult(
  reportType: string,
  message: string,
  /**
   * Optional held rows to surface alongside the failure. `apply.errors` is NOT part of
   * the panel's honest findings list (`lib/sync/findings.ts::flattenRunFindings` reads
   * held rows + the reconciliation channels), so a failure that an operator must ACT on
   * — e.g. "Gmail connection limit hit, wait and retry" — passes one `gate_failure` row
   * here to become a visible finding. Uses the EXISTING HeldKind vocabulary; that enum
   * is frontend-locked, so new categories are expressed via `reason`/`detail`.
   */
  held: HeldRow[] = [],
): SyncRunReportResult {
  return {
    classify: {
      report_type: reportType,
      ok: false,
      gate_failures: [],
      counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
      rows_preview: [],
      classified_path: "",
      source: {},
      watermark: null,
    },
    apply: {
      report_type: reportType,
      ok: false,
      applied: { inserts: 0, updates: 0, replaced_dates: 0 },
      held,
      labeled: false,
      watermark_updated: false,
      errors: [message],
      auto_created_batches: [],
      rc_out_backfills: [],
      batch_alias_notes: [],
      production_batch_starts: [],
      production_human_edits: [],
      delivery_human_edits: [],
      price_notes: [],
      unpriced_overdue: [],
      awaiting_batch_assignment: [],
      extraction_notes: [],
      source_tab_notes: [],
      product_notes: [],
      downtime_notes: [],
      waste_notes: [],
    },
    status: "error",
    error: message,
  };
}
