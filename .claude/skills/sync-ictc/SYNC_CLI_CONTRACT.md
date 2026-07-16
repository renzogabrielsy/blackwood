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
  "held": [                                    // rows deliberately NOT written — ENRICHED (2026-07-06)
    {
      "reason": "flagged",                      // legacy per-report reason (back-compat)
      "natural_key": "2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg", // HUMAN label (never an index)
      "detail": "sub-watermark NEW: … confirm it is truly missing before any write.",
      "kind": "sub_watermark_suspected_dup",    // NORMALIZED flag category (the enum below)
      "row": {                                  // KEY fields for a human + a DB lookup — NEVER a ₱/cost field
        "transaction_date": "2026-06-30", "batch_code": "JUNE-26-FEED5",
        "batch_id": "…", "destination": "MAIN", "weight_kg": 5820,
        "production_batch": null, "block_loc": null
      },
      "source_index": 8                         // the FORMER index (retained for apply-input mapping)
    }
    // `kind` ∈ { sub_watermark_suspected_dup, cross_batch_reassignment, unmapped_batch_code,
    //   unmapped_bag_type_code, location_occupied, malformed, low_confidence, already_exists,
    //   gate_failure, unmapped_or_missing_columns, below_since_floor, unresolved_shift,
    //   unresolved_batch_id, flagged, other }. Worker SoT: workers/sync/src/reports/held.ts
    //   (per-report apply.ts attaches kind/natural_key/row at held-construction — WHICH rows
    //   are held is unchanged). App mirror: app/(app)/sync/types.ts (HeldRow, HeldKind).
    //   location_occupied = a NEW batch whose block_loc already holds an active batch (23505 on
    //   idx_unique_active_batch_per_location) — HELD (human resolves the slot), never a hard error (L-032).
    //   `row` NEVER carries cost_basis / avg_cost / any *_price (price gating — held rows are
    //   write decisions, not cost views).
    //
    //   gate_failure SPECIFICS (2026-07-06): a "kind":"gate_failure" held row carries the
    //   drifted dates on `row.drift_dates` so the app advisor can NAME the exact days + both
    //   numbers (no more "some dates"). Threaded by the worker from the reconciler
    //   (rc_out/rc_movement_audit index.ts). Two flavors, both ₱-free (pure kg totals):
    //     proposed_vs_movement_drift_500kg → [{ "date":"2026-06-10", "proposed_kg":71144,
    //         "movement_kg":57401, "diff_kg":13743 }, { "date":"2026-06-12",
    //         "proposed_kg":82375, "movement_kg":null, "note":"no movement entry" }]
    //     db_vs_movement_duplication (O>M) → [{ "date":"2026-06-30", "db_sum_kg":63820,
    //         "movement_kg":58000, "excess_kg":5820 }]
    //   The app renders the proposed_vs_movement_drift flavor into a plain day-by-day
    //   evidence line with NO DB call (the numbers are already on the row).
    //   O>M SELF-DIAGNOSIS (2026-07-06): the db_vs_movement_duplication flavor does NOT
    //   assume duplication. The app issues ONE read-only rc_out query per flagged date
    //   (filter transaction_date, limit 50, NO ₱/cost column) and diagnoses: exact-duplicate
    //   rows present → DB double-entry ("remove the extra rows"); none → the movement sheet
    //   is MISSING feedings ("the database looks correct — check the movement sheet").
    //   (adjudication.ts::lookupEvidence, kind 'gate_failure').
  ],
  "labeled": false,                            // Gmail thread labeled Blackwood-Processed?
  "watermark_updated": true,                   // ingestion_watermarks row upserted?
  "errors": []
}
```

> **Durable-worker parity (2026-07-06):** the DBOS worker writes this EXACT apply
> envelope into `sync_runs.result.reports[<type>].apply` (alongside a sibling
> `classify` block), so the in-app panel reads the same JSON the CLI produced. The
> `applied` object is ALWAYS present (default zeros) even on a gate-failure/error
> apply, and `held` is always the ROWS (never a count). The read-only auditor +
> dryRun write `apply: null`. Mapping lives in
> `workers/sync/src/workflows/normalizeReport.ts`; the auditor's result is re-keyed
> from `rc_movement_audit` to the panel card `rc_movement`.

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

## Progress events (live panel stream)

While an orchestrator runs, it streams curated **progress events** on `stderr` so the in-app
**Run Sync** panel can show plain-English status (not just "CLASSIFYING…"). This is a **FROZEN
contract** — the frontend parses exactly this shape.

**Format** — one line on **stderr** per event, flushed, sentinel-prefixed:

```
##SYNC_PROGRESS {"stage":"fetch|extract|classify|apply|reconcile|finalize","pct":<0-100 int>,"label":"<plain-English current activity>","detail":"<optional specifics, may be omitted>","level":"info|warn"}
```

- `stage` — one of `fetch | extract | classify | apply | reconcile | finalize`.
- `pct` — integer 0–100, **monotonically nondecreasing** within a single process run.
- `label` — the current activity in plain English (see language rule below). Required.
- `detail` — optional extra specifics. May be omitted.
- `level` — `info` (normal) or `warn` (a retry, a tripped gate, a finish-with-problems).

**stdout stays PURE machine JSON** — the single classify/apply envelope, unchanged. Progress
events are **stderr only**; everything else on stderr remains ordinary technical logging. There is
never a `##SYNC_PROGRESS` line on stdout.

**Digestible-language rule (HARD).** Labels are written the way you'd tell a plant manager what's
happening — never echoed terminal lines, file paths, SQL, or tracebacks. Good:
`"Checking Gmail for new reports…"`, `"Found 1 new report: RC DELIVERIES JUL-02"`,
`"195 already recorded · 5 new · 2 changed"`, `"Writing 2 of 5 — JULY-26-BLK2 @ D-13D"`,
`"Marking the email as processed…"`, `"Done — 3 new rows written"`, `"Nothing new today"`. Numbers
and percentages must be **honest** — derived from real counts / loop indexes, never faked.

**Volume guidance.** Aim for **fewer than 30 events per run** — 4–8 curated calls per phase at the
natural beats, not one per row. For long write loops (e.g. 200 rows), emit on every `ceil(n/10)`
rows (≤10 ticks) rather than per row.

**Emitted by** `oc.progress(stage, label, pct, detail=None, level="info")` in
`scripts/lib/orchestrator_common.py`. Gmail-fetch retries (transient EOF / socket error / abort)
automatically emit a `warn` event like `"Gmail dropped the connection — retrying (attempt 2 of 3)…"`.

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
