# SYNC_CLI_CONTRACT.md — the "Run Sync" button ⇄ orchestrator contract

> Canonical, machine-facing contract for the in-app **Run Sync** button. The app side
> (server actions in `app/**`) shells out to these Python orchestrators on Renzo's Mac
> (Gmail creds + Python live there) and parses **exactly** the JSON described here. Do not
> deviate from these keys without updating both sides.

Every orchestrator lives in `.claude/skills/sync-ictc/scripts/` and speaks the same two-phase
CLI. `stdout` is a **single machine-JSON object** per invocation; **all** human-readable
logging goes to `stderr`.

## Orchestrators

| report_type | script | tables written | notes |
|---|---|---|---|
| `deliveries` | `sync_deliveries.py` | `deliveries` (+ defensive `batches` upsert) | Czarina price enrichment; L-001 trigger-audit UPDATE |
| `rc_out` | `sync_rc_out.py` | `rc_out` | two HARD reconcile gates; manual audit via RPC |
| `production` | `sync_production.py` | `production_shifts`+`_runs`/`_downtime`/`_waste`, `electricity_readings`, `truck_readings` | parent-shift-first FK order; reconcile INFORMATIONAL |
| `flecon` | `sync_flecon.py` | `flecon_bag_movements` | REPLACE-BY-DATE bounded `>= since` |
| `gsheet` | `sync_gsheet.py` | `deliveries` + `rc_out` (from the Google Sheet) | combined rc_in+rc_out in ONE run; Sheet-wins; NEVER labels (Sheet, not email) |
| `rc_movement_audit` | `audit_rc_movement.py` | **none — read-only** | classify-only; no apply phase |

### `gsheet` — dual-CLI orchestrator (contract + legacy)

`sync_gsheet.py` predates this contract and keeps its **legacy** employee CLI working byte-for-byte
(`--phase classify --mode rc_in|rc_out --since`, compact non-contract stdout; `--phase apply
--decisions <file>`). It ALSO speaks the contract CLI, selected by `--json` **without** `--mode`:
- `--phase classify --json` → runs BOTH rc_in and rc_out in one invocation and emits ONE `gsheet`
  classify envelope. `counts` are summed across both modes; `rows_preview` mixes both with a
  `<mode>:` marker in each `natural_key`; `classified_path` is one combined file
  (`decisions_gsheet.json`, holding both modes' compacts under a `modes` key); `source` is the Sheet
  (`email_uid: null`); `watermark` is the 2025-scope `since` used; an `extra.per_mode` breakdown is included.
- `--phase apply --input <combined> --only-clean --json` → applies BOTH modes' clean rows via the
  existing per-mode write logic. FLAGGED (e.g. NEW-collides-different-batch reassignments — the
  MAY-26-FEED5 class) and skipped rows go to `held`, never applied. Sheet-wins material
  VALUE_CHANGED is applied (locked policy); rounding/null↔0 is already demoted to NOOP by the
  classifier. **`labeled` is ALWAYS `false`** (a Sheet has no Gmail thread to label); the
  `ingestion_watermarks` row is still upserted (`report_type='gsheet'`, `last_email_id=null`).

## Phase: classify

```
python3 sync_<type>.py --phase classify --json
```

Read-only. Fetches the source (Gmail xlsx / — ), classifies against the live DB (rows never
enter an agent context), writes a compact decisions file to disk, and prints **one** object:

```json
{
  "report_type": "<type>",
  "ok": true,                       // false ⇒ a HARD gate tripped; apply will write nothing
  "gate_failures": [                // empty unless a HARD gate tripped
    { "gate": "proposed_vs_movement_drift_500kg", "detail": "…" }
  ],
  "counts": { "noop": 0, "insert": 0, "update": 0, "flagged": 0 },
  "rows_preview": [                 // up to 20 human-readable rows for the summary UI
    { "action": "INSERT", "natural_key": "2026-07-02|JULY-26-BLK1|B-3A", "summary": "5820kg AVSECO" }
  ],
  "classified_path": "/abs/path/decisions_<type>.json",   // the approved-input for apply
  "source": { "email_subject": "…", "email_uid": "121640" },
  "watermark": "2026-07-01",        // the DATA watermark = MAX(transaction_date)
  "codified_rules_applied": ["rounding-null-zero-noop", "L-020", "…"]
}
```

Notes:
- `counts.flagged` includes MALFORMED / UNMAPPED / flagged rows — everything that will NOT be
  auto-written and instead lands in `held` at apply time.
- For `rc_movement_audit` the counts describe DISCREPANCIES, not writes:
  `noop`=agreeing dates, `insert`/`update`=0, `flagged`=drift dates; `rows_preview` = drift dates.
- When there is no source email in the window, the orchestrator returns `ok:true` with a `note`
  and an empty `classified_path` — a legitimate "nothing to do" run.

## Phase: apply

```
python3 sync_<type>.py --phase apply --input <classified_path> --only-clean --json
```

Deterministic writer. `--input` is the `classified_path` from classify (optionally with per-row
`skip`/`decision` edits the reviewer set). Prints **one** object:

```json
{
  "report_type": "<type>",
  "ok": true,                                  // false ⇒ at least one write error (see errors)
  "applied": { "inserts": 0, "updates": 0, "replaced_dates": 0 },
  "held": [                                    // rows deliberately NOT written
    { "reason": "unmapped_batch_code", "natural_key": 42, "detail": "…" }
  ],
  "labeled": false,                            // Gmail thread labeled Blackwood-Processed?
  "watermark_updated": true,                   // ingestion_watermarks row upserted?
  "errors": []
}
```

### `--only-clean` (the button's default)
Apply ONLY rows that pass **every codified mechanical rule**. Any FLAGGED / UNMAPPED / MALFORMED /
uncertain row goes to `held` — it never blocks the clean rows and is **NEVER** auto-written.
Held rows require a human decision (a later, explicit apply run with the row promoted).

### HARD gates (rc_out)
If a HARD gate tripped in classify (`gate_failures` non-empty), the apply phase sets `ok:false`,
writes **nothing**, and echoes the gate in `held`/`errors`. The two gates:
1. `proposed_vs_movement_drift_500kg` — PROPOSED vs RC MOVEMENT daily drift > 500 kg.
2. `db_vs_movement_duplication` — DB `rc_out` SUM exceeds RC MOVEMENT (`O > M`) on a settled date.

### Gmail labeling discipline (SKILL.md:347)
The Gmail `Blackwood-Processed` label is applied **only** when the apply had **zero errors AND zero
unapplied non-held rows**. A partial success must never label the thread. Pass `--no-label` to skip
labeling entirely (used by no-op verification runs so a test never touches Gmail state).

### Watermarks
- **Data watermark** (scoping) = `MAX(transaction_date)` — unchanged behavior; computed per run.
- **Run watermark** (bookkeeping) = the `ingestion_watermarks` table (`report_type` PK): on every
  successful apply the orchestrator upserts `(report_type, last_email_id, last_run_at)`. Best-effort
  — a failure here never fails the apply.

## Audit provenance (L-009)

- `deliveries` INSERTs fire a SECURITY DEFINER audit trigger (`log_delivery_changes`); the writer
  UPDATEs that row for provenance (L-001) — never a 2nd INSERT.
- `rc_out`, `production_*`, `electricity_readings`, `truck_readings`, `flecon_bag_movements` have
  **no** audit trigger. Their audit rows are written through the SECURITY DEFINER RPC
  `write_ingestion_audit(p_table_name, p_record_id, p_operation, p_diff, p_snapshot, p_comment)`
  (owner `postgres`, `service_role`-only EXECUTE). This closes the L-009 grant gap without granting
  broad INSERT on `audit_logs`. `lib/db.py::insert_manual_audit` calls this RPC; callers are unchanged.

## Codified vs judgment

Every MECHANICAL rule is enforced in code (in the wrapped `extract_*`/`classify_*` scripts or the
orchestrator) and echoed per run in `codified_rules_applied`. Anything not mechanically codifiable
(genuine adjudication: unmapped batch, ambiguous reassignment, L-002/L-007 batch inference, waste
collision sum-vs-split) stays FLAGGED → `held`, never auto-written. See each orchestrator's module
docstring for its exact codified-rule list.
