// ICTC one-click daily sync — v1
//
// Runs Blackwood's three ingestion employees in PARALLEL, full auto-execute
// (no PROPOSE pause, no human approval gate), then an independent read-only
// rc_out audit. Each agent keeps its OWN data-integrity safety gates
// (rc-out >500kg/day drift halt, MALFORMED-never-written, watermark idempotency).
//
// Parallelism is safe: the three writers hit different tables, and all are
// idempotent (natural-key dedup + label-applied-last). The only soft coupling
// is rc-out resolving batch_code->batch_id against batches that deliveries may
// create the same run; rc-out routes any unresolved code to UNMAPPED (surfaced,
// never auto-created) so a concurrent batch-create just defers to the next run.
//
// Invoke: Workflow({ name: 'ictc-sync' })  ·  or just "run the ictc sync"

export const meta = {
  name: 'ictc-sync',
  description: 'One-click daily ICTC sync: auto-execute deliveries + rc_out + production ingestion in PARALLEL (each retains its internal data-integrity safety gates), then an independent read-only rc_out audit. Returns a combined change summary and captures run learnings.',
  phases: [
    { title: 'Sync', detail: 'deliveries + rc_out + production — concurrent auto-execute writes' },
    { title: 'Audit', detail: 'rc-movement-auditor read-only cross-check of rc_out' },
  ],
}

const SYNC_RESULT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    agent: { type: 'string' },
    status: { type: 'string', enum: ['wrote', 'halted', 'noop', 'error'], description: 'wrote=new rows written; noop=nothing new (idempotent); halted=a safety gate stopped some/all writes; error=failed' },
    watermark_before: { type: 'string' },
    watermark_after: { type: 'string' },
    rows_written: { type: 'number' },
    audit_logs_written: { type: 'number' },
    writes_by_table: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          table: { type: 'string' },
          inserted: { type: 'number' },
          updated: { type: 'number' },
          skipped: { type: 'number' },
        },
        required: ['table'],
      },
    },
    batches_created: { type: 'array', items: { type: 'string' }, description: 'batch_codes auto-created this run; flag heuristic ones in notes' },
    gmail_labeled: { type: 'array', items: { type: 'string' }, description: 'Gmail UIDs labeled Blackwood-Processed this run' },
    halt_reason: { type: 'string' },
    flags: {
      type: 'array',
      description: 'Rows HELD for Renzo to resolve. Each must be actionable: what + where + how to open the source.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          what: { type: 'string', description: 'date, weight, operator raw label, best-guess batch + why unsure' },
          source_file: { type: 'string', description: 'absolute path (copied to ~/blackwood/.sync-flags/<date>/ so it survives)' },
          sheet: { type: 'string' },
          rows: { type: 'string', description: 'exact row numbers in the sheet' },
          open_command: { type: 'string', description: "open '<path>' so Renzo can eyeball the source in one click" },
          question: { type: 'string', description: 'the one specific question to ask Renzo' },
        },
        required: ['what', 'open_command', 'question'],
      },
    },
    errors: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'learnings/gotchas/anomalies/timing for hardening this one-click workflow' },
    human_summary: { type: 'string', description: 'concise markdown summary of what changed, for the user' },
  },
  required: ['agent', 'status', 'human_summary', 'notes'],
}

const AUDIT_RESULT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['clean', 'drift', 'error'] },
    dates_checked: { type: 'array', items: { type: 'string' } },
    max_drift_kg: { type: 'number' },
    findings: { type: 'string' },
    notes: { type: 'string' },
    human_summary: { type: 'string' },
  },
  required: ['status', 'findings', 'human_summary'],
}

const AUTO = 'You are running in FULL AUTO-EXECUTE mode as one step of a one-click daily ICTC sync workflow. There is NO human approval gate and NO PROPOSE pause this run — you must complete your ENTIRE pipeline including the WRITES and Gmail labeling autonomously, then return. '
  + 'LEARNING LEDGER (do this FIRST): read /Users/renzosy/blackwood/.claude/skills/sync-ictc/LEARNING_LEDGER.md top-to-bottom and apply EVERY Rule in it before you classify — it is the record of past mistakes Renzo has corrected, and it overrides your heuristics. '
  + 'FLAG, DON\'T GUESS: for any row you cannot map with confidence, HOLD it (never write a guess) and add an entry to the `flags` array of your result with: what (date, weight, operator raw label, your best-guess batch + why unsure), where (source_file absolute path, sheet, exact rows), an `open_command` of the form open \'<path>\', and the one question to ask Renzo. Copy the flagged source xlsx to ~/blackwood/.sync-flags/<today>/ so the open command survives /tmp cleanup, and point open_command there. '
  + 'Also read your own agent-memory and apply every stored learning. Auto-execute removes the human-approval gate ONLY — it does NOT disable your data-integrity safety gates (drift halts, MALFORMED-never-written, watermark idempotency all still apply). '
  + 'CONCURRENCY: the other two ICTC importer agents are running at the SAME TIME against the same Gmail mailbox. Gmail permits ~15 simultaneous IMAP connections so this is fine, but if any IMAP fetch times out with [Errno 60], retry it up to 3 times with a few seconds between. Apply your Gmail Blackwood-Processed label LAST, only after your writes have succeeded. '
  + 'APPEND-ON-CORRECTION: if this run reveals a NEW correctable pattern, note it in `notes` as a proposed ledger entry (Symptom / Ground truth / Rule / Provenance) so it can be appended to the ledger. '
  + 'Take NOTES throughout: capture any gotcha, ambiguity, timing/concurrency issue, or idea that would make this one-click workflow more reliable.'

log('ICTC one-click sync starting — PARALLEL auto-execute: deliveries + rc_out + production, then independent audit.')

phase('Sync')
const [deliveries, rcout, production] = await parallel([
  () => agent(
    AUTO + '\n\nYOU ARE: deliveries-manager (RC IN -> deliveries table).\n' +
    'Pipeline: fetch new RC DELIVERIES emails (exclude Blackwood-Processed) -> extract -> enrich prices from Czarina RAW CHARCOAL PURCHASES -> classify by natural key -> WRITE all NEW rows and apply your standard VALUE_CHANGED decision rules autonomously (feeding-status/typo remarks -> db_wins per your memory), auto-create batches for corroborated new batch_codes -> write audit logs by UPDATING the trigger-created row (per memory project_db_triggers_on_deliveries.md: NEVER INSERT a duplicate audit row, and keep batch-insert and delivery-insert as SEPARATE statements) -> label ingested RC threads Blackwood-Processed (NOT the Czarina thread).\n' +
    'CONTEXT: deliveries was already synced through 2026-05-27 earlier today (UID 118488 labeled). You will likely find little or nothing new — that is SUCCESS (idempotency proven); if nothing is new set status=noop. List every batch you create and flag any heuristically-translated batch_code loudly in notes.\n' +
    'Return the structured result (per-table counts, watermark before/after, batches created, UIDs labeled, notes, human_summary).',
    { agentType: 'deliveries-manager', model: 'opus', label: 'deliveries:auto-exec', phase: 'Sync', schema: SYNC_RESULT }
  ),
  () => agent(
    AUTO + '\n\nYOU ARE: rc-out-manager (PROPOSED DAILY REPORT -> rc_out table).\n' +
    'Pipeline: fetch the PROPOSED DAILY REPORT email AND the RAW CHARCOAL MOVEMENT email -> extract both -> reconcile PROPOSED daily block-section totals vs RC MOVEMENT raw_charcoal_fed per date -> resolve batch_code to batch_id -> classify against rc_out by natural key -> WRITE all NEW rows that pass the gate plus audit logs -> label the PROPOSED DAILY thread Blackwood-Processed. NEVER label the RAW CHARCOAL MOVEMENT thread (cumulative reference data needed every run).\n' +
    'HARD SAFETY GATE (keep it active): for any date later than the watermark where PROPOSED vs RC MOVEMENT drift exceeds 500 kg, DO NOT write that date — halt those specific writes, set status=halted, and put the per-date drift in halt_reason. Pre-watermark drift is expected historical state (memory feedback_reconciliation_scope.md) and must NOT gate. The classify_rc_out.py db_rows input must use the [{"data":[...]}] array wrapper (memory).\n' +
    'CONCURRENCY NOTE: deliveries-manager is running at the same time and may be creating new batches. If you cannot resolve a batch_code to a batch_id, route it to UNMAPPED and surface it in notes — do NOT auto-create a batch; a follow-up run will resolve it once deliveries has committed.\n' +
    'CONTEXT: rc_out was NOT synced earlier today, so you most likely have a real catch-up to write. Discover your watermark from the DB. If the backlog is unexpectedly large (spans more than ~2 weeks or multiple months), still proceed per the gate but CALL IT OUT prominently in human_summary so the user can scrutinize the volume.\n' +
    'Return the structured result (dates written, per-date reconciliation drift, watermark before/after, any halted dates, UID labeled, notes, human_summary).',
    { agentType: 'rc-out-manager', model: 'opus', label: 'rc-out:auto-exec', phase: 'Sync', schema: SYNC_RESULT }
  ),
  () => agent(
    AUTO + '\n\nYOU ARE: production-manager (MC Daily Production Report + Ivy WASTE PRODUCTION REPORT -> 6 tables).\n' +
    'Pipeline: fetch MC then Ivy emails SEQUENTIALLY WITHIN YOUR OWN RUN (never two concurrent logins from your own process — this intra-agent rule still holds even though you run concurrently with the other importers) -> discover your watermark from production_shifts -> extract both with --since {watermark} -> classify all 5 record types -> upsert production_shifts FIRST, then insert runs/downtime/waste against the resolved shift_id map, then electricity_readings + truck_readings, then audit logs -> label MC and Ivy threads Blackwood-Processed. MALFORMED/null-shift rows are NEVER written. Reconcile is INFORMATIONAL only — it must never gate.\n' +
    'CONTEXT: production was already synced through 2026-05-28 earlier today (UIDs 118639/118635 labeled). You will likely find little or nothing new — that is SUCCESS (idempotency); if nothing is new set status=noop.\n' +
    'Return the structured result (per-table counts, shifts upserted, watermark before/after, UIDs labeled, notes, human_summary).',
    { agentType: 'production-manager', model: 'opus', label: 'production:auto-exec', phase: 'Sync', schema: SYNC_RESULT }
  ),
])

phase('Audit')
const rcoutCtx = rcout ? ('rc-out status=' + rcout.status + ', watermark ' + (rcout.watermark_before || '?') + ' -> ' + (rcout.watermark_after || '?') + '. ' + (rcout.human_summary || '').slice(0, 600)) : 'rc-out did not return a result.'
const audit = await agent(
  'You are the rc-movement-auditor — READ-ONLY independent verification, the final step of a one-click ICTC sync. NEVER write to the DB. NEVER label Gmail.\n' +
  'The rc-out-manager just ran in this workflow. Context: ' + rcoutCtx + '\n' +
  'Fetch the latest RAW CHARCOAL MOVEMENT email and cross-check the daily RAW CHARCOAL FED (KLS.) total against (1) SUM(rc_out.weight_kg) per date and (2) view_rc_movement aggregations, for the dates rc-out just wrote (or the last 7 days if rc-out was noop). Report any drift, missing dates, or anomalies. Retry IMAP on [Errno 60].\n' +
  'Return structured findings (status clean/drift/error, dates_checked, max_drift_kg, findings, human_summary, notes).',
  { agentType: 'rc-movement-auditor', model: 'opus', label: 'audit:rc-out', phase: 'Audit', schema: AUDIT_RESULT }
)

log('ICTC one-click sync complete.')
return { deliveries, rcout, production, audit }
