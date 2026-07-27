---
name: sync-ictc
description: Sync ICTC daily report emails from Gmail into Blackwood's Supabase. Fetches new XLSX attachments from the Work/ICTC Daily label, extracts rows, classifies each against existing DB data (NEW / DUPLICATE_NOOP / VALUE_CHANGED), asks the user to confirm, then writes via Supabase MCP with audit logs and labels processed threads. Use when Renzo says "sync ICTC", "sync emails", "ingest reports", "process daily reports", "/sync-ictc", or any phrasing about pulling daily operator reports into Blackwood.
metadata:
  author: blackwood
  version: "2.0.0"
  scope: project
  requires:
    - Gmail App Password stored at ~/.config/sync-ictc/credentials.env (mode 600)
    - Supabase MCP server connected (provides execute_sql, apply_migration tools)
    - python3 with openpyxl available on PATH (stdlib imaplib handles IMAP)
---

# Sync ICTC — Email-to-Supabase Ingestion

You are running the ICTC daily report ingestion workflow. Your job: fetch new XLSX reports from Gmail, extract rows, classify each against existing Blackwood data, present a summary to Renzo, get his confirmation, and write the deltas to Supabase with a proper audit trail.

**Your trust boundary:** Gmail access stays here in Claude Code, NOT in the Blackwood production app. You are the bridge.

**Your safety posture:** Never auto-commit VALUE_CHANGED rows. Always show summary before writes. Idempotent via Gmail labels — re-running this skill should produce zero duplicate writes.

---

## Daily-run lean defaults (orchestrator — READ THIS)

The production daily sync launches **five specialist agents** (`gsheet-sync`, `deliveries-manager`, `rc-out-manager`, `production-manager`, `bagging-manager`) in parallel Task calls. These defaults are MANDATORY on every routine run — they exist purely to keep each agent token-lean without weakening any safety gate or correctness rule. (The step-by-step protocol below is the single-agent RC-DELIVERIES reference flow; the same four levers apply to all five employees.)

> **`bagging-manager` (FLECON bag inventory — packaging, NOT charcoal).** Ingests Ivy's `FLECON BAGGED` email (`FLECON BAG MOVEMENT` workbook, one tab per year) → `flecon_bag_movements`. Watermark = `MAX(transaction_date)` in `flecon_bag_movements` (NULL ⇒ first-run full-year backfill `--since <year>-01-01`; else tail-scope `--since watermark − 3d`). Idempotency = **REPLACE-BY-DATE** (DELETE the date's rows, re-INSERT the sheet's rows for that date), bounded to the tail window — never touches settled history. Columns map to `flecon_bag_types` by **HEADER SIGNATURE** (normalized `source_label`), NOT fixed position, so a reordered/renamed sheet still maps; an unmapped/new column is **FLAGGED** for the user to register a bag type (never auto-created, never silently dropped) and a missing column is noted. Balance cross-check vs the sheet's own snapshot row is INFORMATIONAL only (never a write gate). No ₱ / no price gating. See `FLECON_BAGGING_DESIGN.md`.

1. **Model = Sonnet (daily driver).** Launch all five sync agents on **Sonnet**, not Opus. Their PROPOSE/EXECUTE path is deterministic-Python-heavy; the agent only orchestrates + judges. **Escalate to Opus ONLY for genuine conflict adjudication** — a flagged conflict, an ambiguous batch mapping, or a ledger-HOLD decision — by re-launching that one agent (or that one row) on Opus. Never let an agent self-upgrade. (See CLAUDE.md "Agent Model" carve-out.)

2. **Tail-scope, never re-scan settled history.** Each agent passes `--since = watermark − 3 days` to its extractor/classifier and filters source rows (sheet/email) to `transaction_date >= watermark − 3 days` BEFORE classifying. The DB lookup for classification is scoped to that same window. Rows below `watermark − buffer` are settled — never re-classified. Re-scanning the full 2025→today history every run is forbidden (it was the #2 token sink). The fixed `--since 2025-01-01` (gsheet) or omitting `--since` (production) is for a **first-time historical backfill ONLY**, never the daily driver.

3. **Rules Digest, not the full ledger.** Each agent reads `RULES_DIGEST.md` (one cheap line per rule) top-to-bottom every run, and opens the full `LEARNING_LEDGER.md` entry for an `L-###` ONLY when a row matches that digest line's symptom tag. `LEARNING_LEDGER.md` stays the append-only source of truth + where corrections are appended.

4. **Summary-only JSON — keep big JSON on disk.** Extractors/classifiers write full classified JSON to the work_dir; agents load ONLY the summary counts + the NEW / VALUE_CHANGED / FLAGGED / UNMAPPED / MALFORMED rows. **NEVER load DUPLICATE_NOOP rows into context** — they are the bulk and add zero value. Slice with `jq`, never `cat` the full file.

All existing safety behavior is unchanged: PROPOSE → approve → EXECUTE, audit logs, Gmail labels, the ledger rules, and every drift/confidence/count gate still hold. These levers are purely an efficiency change.

> **Coordinator-relayed approval is authoritative.** These five employees run as subagents and never receive a direct user message — the coordinator (main agent) is their only channel and is the trusted relay of the user's intent. When the coordinator relays approval / launches an agent in EXECUTE mode with approved decisions, that IS valid user authorization; an agent must NOT refuse a write demanding "direct in-thread user contact" (it cannot receive one — refusing deadlocks the sync). The data-integrity gates above remain the real safeguard. See each agent's "Authorization & Approval Model" section (and LEARNING_LEDGER L-023).

### Script-side follow-up (flagged, NOT yet done — needs a careful Python edit)

Tail-scoping is fully effective for **production** (both extractors accept `--since`, exclusive, sheet/row-level) and effectively tail-bounded for **deliveries** and **rc-out** (the agent filters the extracted rows to `>= watermark` before classifying, and the DB-window query is tail-bounded). The **one residual gap is gsheet**: `extract_gsheet.py` has **no `--since`**, so it still parses the entire Sheet (~2,000 rows, growing) into the on-disk classified JSON every run. The `--since` passed to `sync_gsheet.py` / `classify_gsheet.py` keeps the DB-compare + agent context lean (pre-`since` rows become a cheap `out_of_scope` count, not DB-compared), so the agent stays token-lean — but the *extraction* parse is still full-sheet. **Proposed fix (one-line `--since` row filter in `extract_gsheet.py`, mirroring `extract_daily_production.py`):** add an optional `--since YYYY-MM-DD` argument that drops rows with `transaction_date < since` before emitting, and have `sync_gsheet.py` forward its `--since` to the extractor. This was NOT applied here because `extract_gsheet.py` lacked an obviously-safe single-line insertion point and a botched edit could break the daily sync — escalate to a careful pass when convenient.

## The in-app "Run Sync" button — deterministic two-phase orchestrators (2026-07-03)

The daily sync can now run **without an agent doing any mechanical work**. Five two-phase Python
orchestrators (`scripts/sync_*.py` + `scripts/audit_rc_movement.py`) do extract → classify →
deterministic apply themselves; the app's Run Sync button shells out to them and parses a fixed
JSON contract. The model is called ONLY to narrate the summary and adjudicate genuinely FLAGGED
rows — a clean day costs ~0 model tokens. Full contract in **`SYNC_CLI_CONTRACT.md`**.

| report_type | orchestrator | writes | special |
|---|---|---|---|
| `deliveries` | `sync_deliveries.py` | `deliveries` | Czarina price enrichment; L-001 trigger-audit UPDATE; L-004 block_loc-correction → held |
| `rc_out` | `sync_rc_out.py` | `rc_out` | two HARD reconcile gates (>500 kg drift; DB duplication O>M) baked into Python |
| `production` | `sync_production.py` | 6 tables | parent-shift-first FK order; reconcile INFORMATIONAL (never gates) |
| `flecon` | `sync_flecon.py` | `flecon_bag_movements` | REPLACE-BY-DATE bounded `>= since`; unmapped column → held |
| `gsheet` | `sync_gsheet.py` | `deliveries` + `rc_out` | dual-CLI: contract path (`--json`, no `--mode`) runs rc_in+rc_out combined; legacy `--mode`/`--decisions` CLI unchanged; NEVER labels (Sheet, not email) |
| `rc_movement_audit` | `audit_rc_movement.py` | none | classify-only, read-only, no apply phase |

Each speaks: `python3 sync_<type>.py --phase classify --json` (read-only; emits the classify
envelope with `counts`, `rows_preview`, `codified_rules_applied`, `gate_failures`, `watermark`)
and `python3 sync_<type>.py --phase apply --input <classified_path> --only-clean --json`
(deterministic writer; emits `applied`/`held`/`labeled`/`watermark_updated`/`errors`).

**`--only-clean` (button default):** applies ONLY rows passing every codified mechanical rule;
FLAGGED / UNMAPPED / MALFORMED / uncertain rows go to `held` — never auto-written, never blocking
the clean rows. A tripped HARD gate (rc_out) writes nothing and sets `ok:false`. Gmail label
applies ONLY on zero errors AND zero unapplied non-held rows (`--no-label` skips labeling for tests).

**Live progress:** each orchestrator streams curated, plain-English `##SYNC_PROGRESS {…}` events on
**stderr** (stage/pct/label/level) for the Run Sync panel — stdout stays pure machine JSON. Gmail
fetches also auto-retry transient EOF/socket faults (3 attempts, backoff + startup jitter) so
parallel modules don't get dropped by a Gmail connection burst. See SYNC_CLI_CONTRACT.md →
"Progress events".

**Shared plumbing:** `scripts/lib/orchestrator_common.py` (watermark, Gmail fetch + label gate,
contract envelopes, `ingestion_watermarks` upsert, `progress()`). **Audit provenance (L-009):** non-`deliveries`
audit rows are written via the SECURITY DEFINER RPC `write_ingestion_audit` (migration
`20260703032537`, `service_role`-only) — `lib/db.py::insert_manual_audit` routes through it, closing
the grant gap without a broad `audit_logs` INSERT grant. **Watermarks:** data watermark stays
`MAX(transaction_date)`; the `ingestion_watermarks` table (previously dead) now records run
provenance per report_type on each successful apply.

These orchestrators are ADDITIVE — they wrap the existing `extract_*`/`classify_*`/`reconcile_*`
scripts (no diff rule is re-implemented) and reuse `lib/db.py`. `sync_gsheet.py` remains the
reference implementation for RC IN/RC OUT from the Google Sheet.

## Pre-flight checks (do these first, abort on failure)

> **Auth note (2026-07-27):** the production **sync worker** (`workers/sync`) migrated to
> **OAuth2/XOAUTH2** — Google refused App-Password IMAP logins that day and blocked every
> sync, reversing the old "App Password ONLY, never OAuth" rule. This skill's Python
> fallback path still logs in with an App Password; if Gmail refuses it here too, use the
> worker instead (`npm run gmail:check` in `workers/sync` proves the OAuth path) rather
> than regenerating another App Password. The worker's env is `GMAIL_USER` +
> `GMAIL_OAUTH_CLIENT_ID` + `GMAIL_OAUTH_CLIENT_SECRET` + `GMAIL_OAUTH_REFRESH_TOKEN`.

1. **Gmail App Password file exists.** Check `~/.config/sync-ictc/credentials.env`. If missing, tell Renzo: *"Gmail credentials aren't set up. Create the file with: `mkdir -p ~/.config/sync-ictc && chmod 700 ~/.config/sync-ictc && printf 'GMAIL_USER=you@gmail.com\\nGMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx\\n' > ~/.config/sync-ictc/credentials.env && chmod 600 ~/.config/sync-ictc/credentials.env`. Generate the App Password at https://myaccount.google.com/apppasswords."* and stop.

2. **Credentials file has safe permissions.** `stat -f '%Lp' ~/.config/sync-ictc/credentials.env` should return `600`. If it's looser, tell Renzo to run `chmod 600 ~/.config/sync-ictc/credentials.env` and stop. (The fetch_gmail.py script also enforces this — it refuses to run on world/group readable files.)

3. **Supabase MCP is loaded.** Look for `mcp__supabase__execute_sql`. If absent, tell Renzo to connect it and stop.

4. **Verify the deliveries table is reachable.** Run a tiny probe query: `SELECT 1 AS ok` via Supabase MCP. If it errors, surface the error to Renzo (with copy-friendly formatting) and stop.

5. **Confirm working directory is the Blackwood project.** Run `pwd` — it should end in `/blackwood`. If not, stop.

## Step 1 — Establish the date watermark

Query Supabase for the latest transaction_date in `deliveries`:

```sql
SELECT MAX(transaction_date) AS latest FROM deliveries;
```

Set `since_date = latest - 3 days` (the 3-day buffer catches corrections sent days after the original report). Format as `YYYY/MM/DD` for Gmail's search syntax.

Tell Renzo: *"Latest delivery in DB: 2026-05-22. Scanning Gmail since 2026-05-19 (3-day buffer for corrections)..."*

## Step 2 — Fetch matching emails + download attachments (one IMAP call)

Run `fetch_gmail.py` to search Gmail AND download attachments in a single step. The script connects via IMAP, uses Gmail's X-GM-RAW extension for Gmail-syntax search, and saves matching XLSX attachments to a temp dir.

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_DIR=/tmp/ictc-sync/$TS

python3 .claude/skills/sync-ictc/scripts/fetch_gmail.py \
  --query 'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since_date} -label:"Blackwood-Processed"' \
  --output-dir "$OUTPUT_DIR" \
  --attachment-pattern '*.xlsx,*.xls' \
  --limit 50
```

The script outputs JSON to stdout with this shape:

```json
{
  "ok": true,
  "folder": "[Gmail]/All Mail",
  "query": "...",
  "email_count": 4,
  "output_dir": "/tmp/ictc-sync/20260526T...",
  "emails": [
    {
      "uid": "12345",
      "thread_id": "1813091820832029634",
      "subject": "RC DELIVERIES",
      "sender": "Edillo Ivy Mae <edilloivymae306ictc@gmail.com>",
      "date": "Sun, 26 May 2026 04:10:39 +0000",
      "size_bytes": 1024000,
      "attachments": [
        {
          "filename": "RC DELIVERIES 2026.xlsx",
          "path": "/tmp/ictc-sync/20260526T.../12345_RC_DELIVERIES_2026.xlsx",
          "size_bytes": 524000,
          "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "is_inline": false
        }
      ]
    }
  ]
}
```

**Important behaviors:**
- The `-label:"Blackwood-Processed"` clause is your **idempotency mechanism** — threads you've ingested before won't reappear because Step 10 labels them.
- The script enforces `chmod 600` on the credentials file; if your file has loose perms it'll refuse to run with a clear error.
- Each attachment is saved with UID prefix to prevent filename collisions across emails.
- Attachments themselves are written with mode 600.
- If `email_count` is 0, tell Renzo *"Nothing to sync. DB is current through {latest}."* and exit cleanly.

**Capture for later:** The `thread_id` and `uid` per email — you'll need them in Step 10 to apply the Blackwood-Processed label.

## Step 4 — Extract rows from each XLSX

Run the Python extractor for each saved file:

```bash
python3 .claude/skills/sync-ictc/scripts/extract_rc_deliveries.py --file /tmp/ictc-sync/{ts}/{filename}.xlsx
```

The script outputs JSON to stdout:

```json
{
  "filename": "RC DELIVERIES 2026.xlsx",
  "rows": [
    {
      "transaction_date": "2026-05-23",
      "supplier": "Ornales",
      "batch_code": "MAY-26-BLK1",
      "block_loc": "A-1A",
      "truck_plate": "ABC-123",
      "sacks": 200,
      "weight_kg": 12450,
      "cost_basis": 43.50,
      "remarks": null,
      "lab_results": {
        "mc": 8.2, "ash": 4.1, "fc": 78.5, "vm": 9.2,
        "grit": 0.05, "bd_astm": 0.480, "bd_jis": 0.495
      },
      "true_weight_kg": null,
      "deduction_note": null,
      "warnings": [],
      "confidence": 1.0
    }
  ],
  "summary": {
    "total_rows": 12,
    "extraction_warnings": [],
    "overall_confidence": 0.94
  }
}
```

If the script exits non-zero, capture stderr and surface to Renzo as an error (with copy-friendly formatting). Skip that file and continue with others.

**Deductions + recovery rows (see `DEDUCTIONS_DESIGN.md`).** Every `rows[]` element carries two additive fields: `true_weight_kg` (physical/GROSS weight before ASH+wet deductions, parsed from a `net kilos of <GROSS> … = <NET>` remark — **NULL on ordinary rows, never 0**) and `deduction_note` (a short hover label, e.g. `−1.60% MC; −2.88% ASH`). `weight_kg` stays the deducted NET; the natural key / dedup is unchanged, and these fields are write-only (the classifier never diffs on them). A wet **recovery sub-row** (own weight + sacks + MC, no truck/batch/block/date of its own) is emitted as its OWN delivery row inheriting the mother's truck/block/supplier/batch/date/price (tagged `"_recovery": true`) — it is no longer dropped as MALFORMED.

## Step 5 — Classify each row via natural-key lookup

For each extracted row, query Supabase to check if it already exists. Natural key for RC DELIVERIES: `(transaction_date, batch_code, block_loc, weight_kg)`.

```sql
SELECT id, supplier, truck_plate, sacks, cost_basis, remarks, lab_results
FROM deliveries
WHERE transaction_date = $1
  AND batch_code = $2
  AND block_loc = $3
  AND weight_kg = $4
LIMIT 1;
```

(Use parameterized inputs via Supabase MCP — never string-concat values into SQL.)

Three outcomes per row:

| Lookup result | Comparison | Classification |
|---|---|---|
| 0 rows | — | **NEW** |
| 1 row, all non-key fields match | (see equality rules below) | **DUPLICATE_NOOP** — silently skip, don't count toward writes |
| 1 row, ≥1 field differs | — | **VALUE_CHANGED** — flag with diff |

**Equality rules** when comparing fields:
- **Strings** (supplier, truck_plate, remarks): case-insensitive, trim whitespace. Treat null and empty string as equal.
- **Numbers** (sacks, cost_basis): compare with abs tolerance 0.001.
- **Dates**: normalize to YYYY-MM-DD.
- **lab_results (JSONB)**: deep equality. For each key in the union of both objects, compare values; nulls/missing equal each other.

## Step 6 — Present the summary

Before any writes, show Renzo a clear summary:

```
Scanned 4 Gmail threads (since 2026-05-19).
Extracted 47 rows across 4 XLSX files.

Classification:
  • NEW                 12 rows  ← will insert
  • VALUE_CHANGED        3 rows  ← need your decision (see below)
  • DUPLICATE_NOOP      32 rows  (silently skipped)

Extraction warnings:
  • RC DELIVERIES 2026-05-23.xlsx, row 7: supplier "Ornalesa" — fuzzy match to "Ornales" (similarity 0.91)

NEW deliveries (12) — ready to insert:
  Date        Batch          Block  Supplier   Weight  ₱/kg
  2026-05-23  MAY-26-BLK1    A-1A   Ornales    12,450  43.50
  2026-05-23  MAY-26-BLK2    A-2A   Tag-at      8,200  44.20
  ... (full list)

VALUE_CHANGED (3) — pick a decision per row:
  Row 1: 2026-05-21 / APRIL-25-BLK3 / A-1A / 11,705 kg
    Field "supplier":  email says "Ornaless" (typo?)  vs  DB has "Ornales"
    Field "remarks":   email says "wet load"          vs  DB has null
    Decision options: [email_wins / db_wins / both]

  Row 2: ...
  Row 3: ...
```

Then ask: *"Proceed with the 12 NEW inserts? For the 3 VALUE_CHANGED rows, give me a decision per row (e.g., '1=email_wins, 2=db_wins, 3=email_wins')."*

Wait for Renzo's reply. Do NOT proceed without explicit confirmation.

## Step 7 — Safety gates (apply BEFORE any writes)

Refuse to proceed if any of these trip — explain why and stop:

| Gate | Threshold | Reasoning |
|---|---|---|
| NEW count too high | > 50 rows in a single sync | Likely a misclassification or schema mismatch. Inspect manually via `/review-queue`. |
| Confidence too low | any row with confidence < 0.7 | Extraction was uncertain. Route those rows to `/review-queue` (see Step 9 fallback) and ingest only confidence ≥ 0.7. |
| User said anything other than yes | — | Stop. No writes. |

## Step 8 — Write the deltas

On confirmation, execute writes via Supabase MCP. For each operation, write an audit_log entry **in the same transaction-like sequence**:

### Inserts (NEW rows) — IDEMPOTENT (BUG-2 guard, HARD RULE)

Insert each NEW row **guarded on the delivery natural key** `(transaction_date, batch_code, truck_plate, weight_kg, sacks)` so a re-run or an accidental double-execute cannot land the same delivery twice (this is the fix for the 21-seconds-apart duplicate insert). Do NOT add a DB UNIQUE constraint — legitimately identical truckloads can occur; the guard lives in the write, not the schema:

```sql
INSERT INTO deliveries (
  transaction_date, supplier, batch_code, block_loc, truck_plate,
  sacks, weight_kg, cost_basis, remarks, lab_results, true_weight_kg, deduction_note
)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12
WHERE NOT EXISTS (
  SELECT 1 FROM deliveries
  WHERE transaction_date = $1 AND batch_code = $3
    AND truck_plate IS NOT DISTINCT FROM $5
    AND weight_kg = $7
    AND sacks IS NOT DISTINCT FROM $6
)
RETURNING id;
```

A statement returning 0 rows means the row already existed (a prevented duplicate) — count it as skipped, not an error. When writing via the Python helper, use `DBClient.insert_if_absent("deliveries", rows, natural_key=(...))` instead, which performs the same re-check before each insert. `true_weight_kg` + `deduction_note` are additive display fields (`DEDUCTIONS_DESIGN.md`): pass the extractor's values straight through (both NULL on ordinary rows — never 0), and keep them OUT of the natural-key guard (the key stays `(transaction_date, batch_code, truck_plate, weight_kg, sacks)`, and `weight_kg` stays the deducted NET).

For each row that actually inserted, immediately:

```sql
INSERT INTO audit_logs (
  table_name, record_id, operation, snapshot, performed_by, comment
) VALUES (
  'deliveries', $1, 'INSERT', $2::jsonb, NULL,
  'Ingested by sync-ictc skill from Gmail thread ' || $3
);
```

(performed_by is NULL because the skill isn't authenticated as a Blackwood user. The audit comment carries the provenance.)

### Updates (VALUE_CHANGED rows where decision = 'email_wins')

```sql
UPDATE deliveries
SET supplier = $1, truck_plate = $2, ..., lab_results = $N
WHERE id = $M
RETURNING id, *;
```

Audit log:

```sql
INSERT INTO audit_logs (
  table_name, record_id, operation, diff, snapshot, performed_by, comment
) VALUES (
  'deliveries', $id, 'UPDATE', $diff::jsonb, $new_snapshot::jsonb, NULL,
  'Ingested by sync-ictc skill from Gmail thread ' || $thread_id || ' (overwrote DB values)'
);
```

The `diff` field gets the same diff array you computed in Step 5: `[{field, emailValue, dbValue}, ...]`.

### Splits (VALUE_CHANGED with decision = 'both')

INSERT as a brand new row, same as Step 8's INSERT path. Audit log comment: *"Ingested as new row alongside existing match (split shipment treated as separate)"*.

### Skips (VALUE_CHANGED with decision = 'db_wins')

No write. No audit log entry needed (DB unchanged).

## Step 9 — Fallback: route low-confidence to /review-queue

For any row with confidence < 0.7 (filtered out in Step 7), build a `pending_review` entry instead of writing directly:

```sql
INSERT INTO pending_review (
  source_email_id, source_filename, report_type,
  received_at, rows_json, overall_confidence, diagnostic_json, status
) VALUES (
  $thread_id, $filename, 'rc_deliveries',
  $received_at, $rows_json::jsonb, $confidence, $diagnostic::jsonb, 'pending'
);
```

Tell Renzo: *"3 rows had low extraction confidence. Queued at /review-queue for manual review."*

## Step 10 — Label processed threads (idempotency)

For every email UID you successfully processed (whether by direct write or by queueing to /review-queue), apply the Gmail label `Blackwood-Processed` via `fetch_gmail.py --mark-processed`:

```bash
python3 .claude/skills/sync-ictc/scripts/fetch_gmail.py \
  --mark-processed \
  --uids '<uid1>,<uid2>,<uid3>' \
  --folder '[Gmail]/All Mail'
```

The script uses Gmail's X-GM-LABELS IMAP extension to apply the label. Gmail auto-creates the label on first use, so no separate "create label" step is needed.

This prevents the next run from re-processing the same threads (the X-GM-RAW query in Step 2 excludes `-label:"Blackwood-Processed"`).

**Important:** Only mark UIDs whose ingestion fully succeeded. If a row failed to write and you stopped mid-batch, those UIDs should NOT be labeled so the next run re-fetches them.

## Step 11 — Final report to Renzo

Output a clean summary:

```
✓ Sync complete.

Inserted:        12 deliveries
Updated:          2 deliveries
Split-inserted:   0 deliveries
Skipped (DB wins): 1 delivery
Queued for review: 0 deliveries
Already in DB:    32 deliveries (silently skipped)

Labeled "Blackwood-Processed" on 4 Gmail threads.

DB latest delivery is now: 2026-05-23 (was 2026-05-22).
```

If anything failed mid-pipeline, surface it with full context. Use clear language; Renzo pastes errors back into chat for debugging.

## Error handling rules

- **Per-file XLSX extraction failure**: log error with file path + stderr, skip that file, continue with others. Mention the failure in the final report.
- **Per-row classification failure** (e.g., natural-key columns missing from extracted row): skip that row, add to a "skipped due to malformed row" section in the summary.
- **Supabase write failure mid-batch**: stop immediately. Tell Renzo which writes succeeded and which didn't. Do NOT label threads as processed — the next run should re-fetch them. Manual cleanup may be required (e.g., delete partial inserts from `deliveries`).
- **Gmail rate limit / 429**: back off 30 seconds, retry once. If second attempt fails, stop and tell Renzo.
- **User declines confirmation**: stop. No writes. Threads remain unlabeled so a future run picks them up.

## What this skill does NOT do (v1 boundaries)

- Other report types (Daily Production, Waste, RC Movement, etc.) — RC DELIVERIES only. See `README.md` for how to extend.
- Auto-commit any VALUE_CHANGED rows. Always requires per-row decision.
- Send/delete/modify any emails (Gmail access is read + label only).
- Handle non-XLSX attachments (PDFs, images, etc.).
- Push notifications to Renzo's phone (he's invoking this synchronously).
- Run on a schedule. Renzo invokes manually. For schedule, see `/loop` or `/schedule` skills.

## Invocation examples

- *"sync ICTC"* → triggers this skill
- *"sync today's emails"* → triggers this skill
- *"process daily reports"* → triggers this skill
- *"/sync-ictc"* → triggers this skill
- *"ingest the RC DELIVERIES from Gmail"* → triggers this skill

When invoked, start at "Pre-flight checks" and work through every step in order. Do not skip steps even if they seem obvious for a given run.
