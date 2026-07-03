# ICTC Sync — Efficiency Audit & "Sync Button" Readiness

> Read-only analysis, 2026-07-03, branch `dev`. No files changed except this one.
> Every claim is cited to a file:line or a live DB query. Where the memories/handoffs
> disagree with what is on disk, the disk wins and the contradiction is noted.

---

## 1. Executive summary (plain language)

**What the daily sync is today.** Every morning, five "employee" mini-Claudes wake up, each
re-read a thick employee handbook plus a shared rulebook, log into Gmail, pull the day's
spreadsheets, run Python to figure out what's new, show you a summary, and — once you say yes —
type the new rows into the database one at a time. A sixth employee (the auditor) double-checks
the feeding numbers.

**Where the money goes.** Think of each employee as a temp who has to re-read the entire
company manual before touching a single row — *every single day*, even when the day is boring
and there's nothing to decide. Just the "reading before working" part costs roughly **60,000
words of context per employee-run** (the handbook + rulebook + their personal notebook), and
the biggest employee (Production) re-reads about **17,600 words of manual and notebook before it
even opens Gmail**. Multiply across five employees and you're paying to re-read the same manual
five times a day. On top of that, four of the five still type rows into the database
**by hand, one at a time**, through the model — when a plain Python script could do it in one shot.

**The three big wastes:**
1. **Copy-paste handbooks.** The same ~1,600-word "you're allowed to act on relayed approval"
   speech, the same Gmail-login checklist, and the same "read the digest first" paragraph are
   pasted into all five employee files. That's ~8,000 words duplicated five ways.
2. **The rulebook keeps growing and everyone opens it wrong.** The full rulebook
   (`LEARNING_LEDGER.md`) is now ~18,900 tokens. The design says "only read the cheap one-line
   digest, open the full rule only when a row matches" — but the **auditor still says read the
   whole rulebook top-to-bottom every run** (`rc-movement-auditor.md:44`), and everyone loads
   their growing personal notebook every run regardless.
3. **The model still does mechanical work.** On a clean day (no conflicts) the model makes
   *zero real decisions* — Python already decided everything — yet it's still the thing that
   reads summaries, decides "NEW rows → insert", and types the writes. Only the gsheet employee
   has a real "Python does the writing" script. The other four never got theirs built.

**The fix direction.** Python already does extract → classify → diff. Push the last mechanical
step (the writing) into Python too, for all five — the blueprint (`LEAN_SYNC_REFACTOR.md`) exists
but only 1 of 5 orchestrators was built. Pull all the duplicated handbook text into **one shared
file** every employee points at. Load the rulebook and the notebook **on demand**, not every run.
Then a clean day can run with almost no model tokens, and the model is called only to narrate the
result and rule on genuinely flagged rows.

**What the button needs.** Good news: the in-app **review-queue** feature is already a working
"extract → classify → show me → I approve → it writes with an audit trail" pipeline
(`app/(app)/review-queue/actions.ts`) and the **Jarvis** feature already has a working Anthropic
API loop wired up (`app/(app)/jarvis/actions.ts`). The button reuses both. The **one real
blocker** is a database permission gap: the app's service-role key is **not allowed to write the
audit-trail table** (verified live — see §5), whereas the employees get away with it today only
because their database tool secretly connects as the almighty `postgres` superuser. That gap must
be closed with a tiny grant or a helper function before an app button can produce the same audit
rows the employees write today.

---

## 2. Token-cost map

### 2A. Per-run context "bill of materials" (what each agent is told to read every run)

Token estimate = `chars / 4`. Sources: agent `.md` files, `RULES_DIGEST.md:3`, each agent's
"Learning Ledger" section, and `memory: project` frontmatter (which auto-loads that employee's
`.claude/agent-memory/<name>/*.md` every run).

| File loaded every run | chars | ~tokens | Loaded by |
|---|---:|---:|---|
| `gsheet-sync.md` | 25,701 | 6,425 | gsheet-sync |
| `deliveries-manager.md` | 26,373 | 6,593 | deliveries-manager |
| `rc-out-manager.md` | 25,015 | 6,253 | rc-out-manager |
| `production-manager.md` | 40,321 | 10,080 | production-manager |
| `bagging-manager.md` | 29,795 | 7,448 | bagging-manager |
| `rc-movement-auditor.md` | 10,784 | 2,696 | auditor (when used) |
| `RULES_DIGEST.md` | 14,088 | 3,522 | **all 5 employees** every run |
| `LEARNING_LEDGER.md` (full) | 75,592 | 18,898 | on-demand (but auditor loads it fully — see below) |
| agent-memory / deliveries-manager | 4,646 | 1,161 | deliveries-manager |
| agent-memory / rc-out-manager | 17,661 | 4,415 | rc-out-manager |
| agent-memory / production-manager | 30,082 | 7,520 | production-manager |
| agent-memory / rc-movement-auditor | 5,163 | 1,290 | auditor |
| agent-memory / gsheet-sync, bagging-manager | 0 | 0 | (empty dirs) |

**Per-employee "read before any work" cost (agent def + digest + own memory), clean run:**

| Employee | agent def | + digest | + memory | **≈ fixed tokens/run** |
|---|---:|---:|---:|---:|
| gsheet-sync | 6,425 | 3,522 | 0 | **9,947** |
| deliveries-manager | 6,593 | 3,522 | 1,161 | **11,276** |
| rc-out-manager | 6,253 | 3,522 | 4,415 | **14,190** |
| production-manager | 10,080 | 3,522 | 7,520 | **21,122** |
| bagging-manager | 7,448 | 3,522 | 0 | **10,970** |
| **5-employee daily total (fixed reading only)** | | | | **≈ 67,505** |
| + rc-movement-auditor (def + memory + **full ledger**, per its own instructions) | 2,696 | — | 1,290 + 18,898 | **+22,884** |
| **Full run incl. auditor** | | | | **≈ 90,389** |

This is **just the fixed context** — before Gmail JSON, extract/classify summaries, the compact
decisions files, or any reasoning. It is paid on every run whether or not there is anything to do.

**Worst offenders:**
- **`production-manager` — 21,122 fixed tokens/run.** Largest agent def (40 KB) + largest memory
  dir (30 KB: `project_run_log.md` alone is 5,211 tok, `project_first_execute.md` 2,220 tok). Much
  of `project_run_log.md` is historical run logs the model does not need to re-read to do today's run.
- **`LEARNING_LEDGER.md` — 18,898 tokens and growing** (75 KB, ~28 `L-###` entries). The digest
  design (`RULES_DIGEST.md:3`, `SKILL.md:34`) exists precisely to avoid loading this every run — but
  **`rc-movement-auditor.md:44` still says "read `LEARNING_LEDGER.md` top-to-bottom … every audit."**
  That single line re-imports the whole ledger on every auditor run. **Contradiction with disk:**
  the lean design says digest-first; the auditor file never got the digest-first rewrite the other
  five received.
- **`rc-out-manager` memory (4,415 tok)** and **`production-manager` memory (7,520 tok)** are loaded
  in full every run via `memory: project`, even though most entries are settled history.

### 2B. Instruction redundancy across the 5–6 agent files

Measured near-duplicate blocks (each block is byte-for-byte or near-identical across files):

| Duplicated block | ~chars each | × copies | ~total dup chars | ~dup tokens |
|---|---:|---:|---:|---:|
| "Authorization & Approval Model" (coordinator-relayed approval) | 1,637 | 5 | 8,185 | ~2,046 |
| "Learning Ledger — read the DIGEST FIRST" paragraph + "Flag, don't guess" + "Append-on-correction" | ~1,500 | 5 | ~7,500 | ~1,875 |
| Pre-flight checks (creds file / chmod 600 / Supabase probe / pwd / scripts-present) | ~900 | 5 | ~4,500 | ~1,125 |
| "Routine runs use Sonnet … Escalate to Opus ONLY …" | ~600 | 5 | ~3,000 | ~750 |
| Gmail label / idempotency + "mark-processed" mechanics | ~700 | 4 | ~2,800 | ~700 |
| "Operating principles" (determinism-via-Python, audit-trail-sacred, stay-in-lane, idempotent) | ~1,200 | 5 | ~6,000 | ~1,500 |
| EXECUTE-mode audit_logs INSERT shape + "only label if ALL writes succeeded" | ~800 | 4 | ~3,200 | ~800 |

**Rough total near-duplicate boilerplate ≈ 35,000 chars ≈ 8,800 tokens** that could live in **one**
shared reference (e.g. `SYNC_EMPLOYEE_COMMON.md`) each agent links to, instead of being pasted five
times. Verified sample: the Authorization block is 1,637 chars in gsheet-sync / rc-out / production /
bagging and 1,667 in deliveries — i.e. identical modulo one line.

---

## 3. Judgment inventory (what the model actually decides on a CLEAN run)

A "clean run" = watermark advances, some NEW rows, some NOOP, **zero** flagged/unmapped/malformed,
reconciliation within tolerance. For each decision: can code make it?

| # | Decision the model makes today | Verdict | Evidence / note |
|---|---|---|---|
| 1 | "Which emails to fetch" (build Gmail query from watermark) | **MOVE-TO-CODE** | Pure function of `MAX(transaction_date)`; already scripted logic in every agent Step 1. An orchestrator can compute + fetch. |
| 2 | "Pick the LATEST attachment" | **MOVE-TO-CODE** | Deterministic (max date/UID). `deliveries-manager.md:120`, `production-manager.md:131`. |
| 3 | Extract rows from XLSX | **ALREADY-CODE** | `extract_*.py`. Model never parses cells. |
| 4 | Price enrichment (deliveries) | **ALREADY-CODE** | `enrich_prices.py`. |
| 5 | Classify NEW / NOOP / VALUE_CHANGED | **ALREADY-CODE** | `classify_*.py` + `diff-engine`. |
| 6 | "VALUE_CHANGED within rounding / null↔0 → NOOP" | **ALREADY-CODE** | Material-change gate is in `classify_gsheet.py` (SKILL.md:35 "demoted to NOOP by the classifier's material-change gate"). The model does **not** apply this rule — Python does. |
| 7 | "NOOP rows → skip / never load into context" | **ALREADY-CODE / MOVE-TO-CODE** | Compact builder omits NOOP (`sync_gsheet.py:187`). For the 4 unbuilt employees the *agent* still does the `jq` slicing — should be the orchestrator. |
| 8 | Watermark + tail-scope (`--since = watermark − 3d`) | **MOVE-TO-CODE** | Currently the agent computes it and passes `--since`. An orchestrator computes it internally. `SKILL.md:32`. |
| 9 | Reconciliation drift math + gate (rc_out >500 kg HARD; DB-vs-movement duplication) | **ALREADY-CODE (keep the gate)** | `reconcile_rc_movement.py` returns exit codes 0/1/2; `rc-out-manager.md:160,211`. The **math** is code; the model only narrates. Keep the gate (see §6). |
| 10 | "Insert NEW rows" (build + run the INSERTs + audit rows) | **MOVE-TO-CODE** | Only gsheet has this (`sync_gsheet.py:phase_apply`). The other 4 still issue MCP `execute_sql` per row (`deliveries-manager.md:281-320`, `rc-out-manager.md:307-327`, `production-manager.md:390-435`, `bagging-manager.md:230-256`). |
| 11 | Idempotency guard (natural-key re-check before insert) | **ALREADY-CODE** | `DBClient.insert_if_absent` (`lib/db.py:166`). |
| 12 | Gmail label-as-processed after success | **MOVE-TO-CODE** | `fetch_gmail.py --mark-processed`; the agent just decides "all writes ok → label". A script can gate on the apply result. |
| 13 | Write the run summary paragraph for Renzo | **KEEP-MODEL (optional)** | The one genuinely language-shaped output. Cheap. Can be skipped on a clean run. |
| 14 | Adjudicate a FLAGGED row (reassignment / overflow / double-count / unmapped batch) | **KEEP-MODEL** | Genuine judgment; ledger-rule-driven. `gsheet-sync.md:157`, L-002/L-004/L-010/L-011/L-012. |
| 15 | Adjudicate an UNMAPPED batch_code | **KEEP-MODEL** | Never auto-create a batch. `rc-out-manager.md:398`. |
| 16 | Decide MALFORMED handling | **KEEP-MODEL (light)** | Usually "skip + tell Renzo to fix the sheet." Could be auto-skip-and-report. |
| 17 | Ledger append-on-correction | **KEEP-MODEL** | Only when Renzo corrects something — not a clean-run cost. |

**Conclusion:** On a clean run, items 1–12 are all mechanical (code can own them); only #13 (an
optional paragraph) needs the model. **A clean run's ideal model cost is ~0 tokens + one optional
summary.** Today it pays the full fixed-context bill in §2A (~10k–21k tokens/employee) to do work a
script already does.

---

## 4. Write path — what a deterministic `execute_writes` must replicate

What the EXECUTE phase does today, per target, and where that logic already lives vs. only-in-prose:

| Target table | Audit mechanism (VERIFIED live) | current_weight | Idempotency | Built in Python? |
|---|---|---|---|---|
| `deliveries` | **Audit TRIGGER** `deliveries_audit_trigger → log_delivery_changes()` (AFTER INS/UPD/DEL). So the audit row is auto-written; you **UPDATE** it for provenance, never INSERT a 2nd (L-001). | Maintained by BEFORE trigger `fn_update_blackwood_state` — **never `+= delta`** (L-006/AF-001). | `insert_if_absent` natural key `(date,batch_code,truck_plate,weight_kg,sacks)` | **gsheet only** (`sync_gsheet.py:333-355`). deliveries-manager EXECUTE is prose-only (MCP row-by-row). |
| `rc_out` | **NO audit trigger** (only `tr_blackwood_usage` state trigger). Audit row must be **INSERTed manually**. | `fn_process_blackwood_usage` BEFORE trigger. | natural key `(date,batch_id,destination)` | **gsheet only** (`sync_gsheet.py:369-377`). rc-out-manager EXECUTE is prose-only. |
| `production_shifts`+4 children | **NO audit trigger** — manual INSERT; parent shift upserted first, children FK to `shift_id`. | n/a | natural keys per table | **Not built** — `sync_production.py` does not exist. Prose-only across 6 tables. |
| `electricity_readings`, `truck_readings` | **NO audit trigger** — manual INSERT; never write generated cols (`diff_kwh`, `consumption_kwh`, `ttl_km`). | n/a | natural key | Not built. |
| `flecon_bag_movements` | **NO audit trigger** — manual INSERT; REPLACE-BY-DATE (DELETE date + re-INSERT), bounded `>= since`. | n/a | whole-day replace | Not built — `sync_flecon.py` does not exist. |

**The audit-log provenance shape** every writer must produce (columns verified live):
`audit_logs(table_name, record_id, operation, diff jsonb, snapshot jsonb, performed_by, comment, performed_at, resolve_* )`.
Convention today: `performed_by = NULL`, provenance carried in `comment`
(e.g. `"Ingested by RC Out Manager from PROPOSED DAILY REPORT Gmail thread <id> (UID <uid>)"`,
`"provenance=gsheet | …"`). Live sample confirms rc_out/production/electricity/truck audit rows all
exist with these agent comments — so the manual-insert path **works today** (see §5 for *why* it works
and why the app can't copy it as-is).

**Watermark + Gmail labels + provenance tags** are the four things `execute_writes` must replicate:
1. **audit_logs row** (trigger-UPDATE for deliveries; manual-INSERT for everything else).
2. **provenance tag** in the comment (and `provenance=<source>` prefix).
3. **Gmail label** `Blackwood-Processed` via `fetch_gmail.py --mark-processed`, **only if all writes
   succeeded** — partial success must NOT label (SKILL.md:347).
4. **Watermark** — note this is **implicit** (`MAX(transaction_date)`), *not* the
   `ingestion_watermarks` table (see §5 contradiction).

Reusable building blocks that already exist: `lib/db.py` (`insert`, `insert_if_absent`, `update`,
`update_trigger_audit_provenance`, `insert_manual_audit`) and `sync_gsheet.py::phase_apply` as the
reference apply implementation.

---

## 5. Button gap list (in-app "Run Sync")

### 5A. DB reality checks (verified live, read-only)

**(1) `ingestion_watermarks` is DEAD schema.**
- Table exists; columns `(report_type, last_email_id, last_email_received_at, last_run_at)`.
- **`SELECT * … ` returns 0 rows.** Nothing reads or writes it.
- No script references it; every agent uses `SELECT MAX(transaction_date)` as the real watermark.
- **Contradiction with lore:** the name implies a live watermark store; on disk/in-DB it is unused.
  The button should either adopt it (write `last_run_at` / `last_email_id` per report on each run) or
  ignore it and keep using `MAX(transaction_date)`. Recommend: **populate it** — it's the natural place
  for the button to record run provenance and it already has the right columns.

**(2) L-009 audit_logs grant gap is REAL. This is the button's one hard blocker.**
- `information_schema.role_table_grants` for `audit_logs`: **`authenticated` = SELECT, UPDATE;
  `postgres` = ALL. `service_role` and `anon` have NO grants at all — nobody but `postgres` can
  INSERT.**
- `service_role` is a member of `authenticator` (with `anon`/`authenticated`), **not of `postgres`** —
  so it does **not** inherit the INSERT privilege.
- **Why the employees get away with it today:** the Supabase **MCP connects as `postgres`**
  (`SELECT current_user` → `postgres`). Every "manual audit INSERT" the agents do runs as the
  superuser. `lib/db.py`, by contrast, uses the **service-role key over PostgREST** — which is why
  L-009 recorded a live `403 permission denied for table audit_logs (42501)` and told agents to finish
  audit writes via MCP. So `sync_gsheet.py`'s `insert_manual_audit` for rc_out **would 403 if run purely
  via the service-role key** — it only worked in practice because the operator finished audit writes
  through MCP-as-postgres.
- **What works without a grant:** `deliveries` INSERTs — because `log_delivery_changes()` is
  **SECURITY DEFINER owned by `postgres`**, the trigger writes the audit row as the owner regardless of
  the caller. Likewise `set_audit_comment()` is SECURITY DEFINER. That's exactly why review-queue's
  app-side delivery writes already produce audit rows correctly.
- **Verdict:** An app-side service-role writer can produce `deliveries` audit rows today (trigger does
  it). It **cannot** produce `rc_out` / production / flecon audit rows today — those need a manual
  INSERT the service role isn't granted. **Fix (pick one):**
  - **(preferred) a `SECURITY DEFINER` RPC** `write_ingestion_audit(table_name, record_id, operation, diff, snapshot, comment)` owned by `postgres`, `GRANT EXECUTE … TO service_role`. Mirrors the existing `set_audit_comment` pattern; no broad table grant, keeps the audit table locked down. The app and `lib/db.py` both call it.
  - or **`GRANT INSERT ON audit_logs TO service_role`** (simpler, but widens write access to the audit table for anything holding the service key).

### 5B. Existing in-app code to REUSE (don't rebuild)

- **`app/(app)/review-queue/actions.ts`** — the closest precedent: `uploadForReview` (extract →
  classify → persist `pending_review`), `listPending` / `getReviewDetail` (the PROPOSE summary UI),
  `approveReview` (per-row `email_wins`/`db_wins`/`both` → admin-client writes + `set_audit_comment`
  RPC + `revalidatePath`), `rejectReview`. The button's PROPOSE/summary/approve/write loop is *this*,
  generalized from one report type to five. `pending_review` is the natural staging table for a
  proposed run.
- **`lib/supabase/admin.ts`** — `createAdminClient()` (service-role, server-only). The writer client.
- **`app/(app)/jarvis/actions.ts`** — a working Anthropic **tool-use loop** (`chat()`): builds
  messages, calls `anthropic.messages.create` with `system` (ephemeral cache) + `tools`, runs up to
  `MAX_ITERATIONS = 5`, executes tools, persists turns. Reuse this loop for the **narrate + adjudicate**
  step: feed it the compact decisions JSON, let it write the summary and (with a tool) set decisions on
  flagged rows.
- **`lib/anthropic/client.ts`** — `anthropic` client + `JARVIS_MODEL = 'claude-sonnet-4-6'`,
  `JARVIS_MAX_TOKENS = 4096`. The API is already integrated; the button adds a second system prompt,
  not a new integration.
- **`lib/jarvis/tool-handlers.ts`** — the price-gating pattern (`canViewPrices()` before returning
  any ₱ field) the sync-narration model must also honor if it ever surfaces cost data.

### 5C. New scripts / server-actions still MISSING for the button

| Missing piece | What it is | Notes |
|---|---|---|
| `sync_deliveries.py` | two-phase orchestrator (classify + deterministic apply) | Blueprinted in `LEAN_SYNC_REFACTOR.md §2`; **never built.** deliveries-manager still MCP-row-by-row. |
| `sync_rc_out.py` | ditto + the HARD >500 kg + DB-duplication reconcile gates baked into Python | `LEAN_SYNC_REFACTOR.md §3`; **never built.** |
| `sync_production.py` | ditto across 6 tables, parent-shift-first FK ordering | `LEAN_SYNC_REFACTOR.md §4`; **never built.** |
| `sync_flecon.py` | ditto, REPLACE-BY-DATE apply | not blueprinted; bagging-manager EXECUTE is prose-only. |
| `audit_rc_movement.py` | classify-only (read-only) auditor orchestrator | `LEAN_SYNC_REFACTOR.md §5`; **never built.** |
| `extract_gsheet.py --since` | one-line row filter so extraction is tail-scoped too | flagged residual gap, `SKILL.md:42-44`. |
| **`write_ingestion_audit` RPC** (or grant) | the L-009 fix in §5A | **prerequisite** for any app-side non-deliveries writer. |
| **Server action `runSyncPropose(reportType)`** | `child_process` → the `sync_*.py --phase classify` on Renzo's Mac → return the compact decisions JSON to the UI | new; wraps the orchestrators. Runs locally (Gmail creds + Python live on the Mac). |
| **Server action `runSyncApply(reportType, decisions)`** | `child_process` → `sync_*.py --phase apply` (or the review-queue-style admin writer) → label Gmail → return result | new; the deterministic writer. |
| **Narration/adjudication call** | reuse the Jarvis loop with a sync-specific system prompt + a `set_decision` tool | new prompt, existing loop. |

### 5D. Which Anthropic model tier the remaining judgment actually needs

- **Clean run (no flags): no model call needed at all** — or **Haiku** for a one-paragraph summary.
  Nothing to reason about; Python decided everything (§3).
- **Flagged/unmapped/malformed adjudication: Sonnet** (already `JARVIS_MODEL='claude-sonnet-4-6'`).
  This is exactly the Sonnet daily-driver posture in `CLAUDE.md` and `SKILL.md:30`.
- **Genuine conflict escalation** (ambiguous batch reassignment, a ledger-HOLD, a >500 kg drift that
  needs interpreting): **Opus**, on demand, for that one decision only — matching the existing
  "escalate to Opus ONLY for genuine conflict adjudication" carve-out. Never default the button to Opus.

---

## 6. Do NOT change (safety gates worth their tokens)

- **rc_out PROPOSED-vs-RC-MOVEMENT >500 kg HARD drift gate** (`rc-out-manager.md:160-166`,
  `reconcile_rc_movement.py`) — those two files record the *same day's* events and must match; it
  caught real doubling. Keep it HARD, keep it in Python.
- **rc_out DB-vs-RC-MOVEMENT duplication gate (Step 9.5, `O > M` → halt)** — the check that catches
  DB-side doubling on settled dates (`rc-out-manager.md:200-213`). Keep.
- **Sub-watermark write guard (`--watermark`) + full-span dedup window** — settled-date would-be-NEW
  rows must route to `flagged`, never INSERT (`rc-out-manager.md:175-216`, L-019/L-020). Keep.
- **Human approval on FLAGGED / UNMAPPED / reassignment / DELETE** — never auto-write a flagged
  reassignment or auto-create a batch; never silently delete (`gsheet-sync.md:28,273`, L-011/L-012).
  Keep human-in-the-loop for these even under a button.
- **Production reconciliation is INFORMATIONAL — must NOT gate** (`production-manager.md:300,516`) —
  the RC-IN→production daily drift is expected (feed tank empties month-end). Don't "upgrade" it to a
  gate.
- **flecon balance cross-check INFORMATIONAL** and **REPLACE-BY-DATE floor `>= since`** (never touch
  settled history) (`bagging-manager.md:226,309`). Keep.
- **Idempotent inserts (natural-key re-check) + "label only if ALL writes succeeded"** (L-020,
  `lib/db.py:166`, SKILL.md:347). Keep.
- **Price gating** (`canViewPrices()` before any ₱ reaches the model) if the narration step ever
  surfaces cost data (`lib/jarvis/tool-handlers.ts:90`). Keep.

---

## 7. Ranked refactor list

Savings % are relative to the **fixed per-run context bill in §2A** (the recurring waste), effort
XS→L, risk L/M/H.

| # | Refactor | Est. token saving | Effort | Risk | Verdict / notes |
|---|---|---:|---|---|---|
| 1 | **Fix `rc-movement-auditor.md:44` to digest-first** (stop loading the full 18,898-tok ledger every audit) | ~15,000 tok/audit run | XS | L | Clear bug vs. the digest design. One-line-scope edit. Do first. |
| 2 | **Extract shared boilerplate → `SYNC_EMPLOYEE_COMMON.md`** (Authorization, Learning-Ledger protocol, Pre-flight, Sonnet/Opus policy, Operating principles) and have each agent link to it | ~8,800 tok of dup removed across the 5 files; each run reads the common file once | S | L | Biggest structural win. Keep each agent's *domain-specific* rules inline. |
| 3 | **Load agent-memory on demand, not every run** (esp. `production-manager` 7,520 tok, `rc-out-manager` 4,415 tok). Split settled run-logs out of the auto-loaded set; keep only an index | ~10,000 tok/run across employees | S | L | `project_run_log.md` history doesn't need re-reading to do today's run. |
| 4 | **Build the 4 missing apply orchestrators** (`sync_deliveries/rc_out/production/flecon.py`) mirroring `sync_gsheet.py::phase_apply` | On a clean run, collapses per-row MCP writes + the model's write-orchestration to ~0 model tokens; also the biggest *latency* win | **L** | M | The core of Goal A **and** Goal B (the button calls these). Build read-only classify first, dry-run, then apply — exactly how gsheet-sync was proven. |
| 5 | **Auto-execute clean NOOP/INSERT runs without model review** (when flagged=unmapped=malformed=0 and gates pass, apply directly + emit summary; only call the model when there's a flag) | ~all model tokens on a clean day | M | M | Safe *only* behind the gates in §6. Keep human approval the instant any flag/gate trips. Pairs with #4. |
| 6 | **Watermark-scoped extraction (`extract_gsheet.py --since`)** | small (extraction JSON on disk, not context) but removes the last full-sheet parse | XS | M | The one residual gap (`SKILL.md:42`). Careful one-line edit; a botched edit breaks the daily sync. |
| 7 | **`write_ingestion_audit` RPC (or `GRANT INSERT … TO service_role`)** | enables app-side writers to produce audit rows | XS (RPC) | M | **Prerequisite for the button** (§5A). Prefer the SECURITY DEFINER RPC over a broad grant. |
| 8 | **`runSyncPropose` / `runSyncApply` server actions + narration via the Jarvis loop** | n/a (feature) | M | M | Reuses review-queue (write path) + jarvis loop (narrate/adjudicate). The button itself. |
| 9 | **Trim/rotate `LEARNING_LEDGER.md`** (archive superseded entries — e.g. L-007's colliding-waste HOLD is superseded by L-028; L-025 supersedes the blank-shift sub-case of L-007/L-014) into `LEARNING_LEDGER_ARCHIVE.md`; keep the digest as the index | shrinks any full-ledger open + the digest | S | M | Do carefully — the ledger is the append-only source of truth; archive, don't delete. |
| 10 | **`rc-movement-auditor` + reconcile steps as pure Python** | ~2,700 (auditor def) + ledger, per audit | M | L | Verdict: **YES — the reconcile math is already pure Python** (`reconcile_rc_movement.py`, exit codes). The auditor's only real judgment is interpreting cross-sheet date-duplicate anomalies (its agent-memory tracks the pattern). Make it `audit_rc_movement.py --phase classify` (read-only), model narrates only the discrepancy list. Zero write risk. |

**Recommended order:** #1 → #2 → #3 → #7 (unblocks the button) → #4 (classify-then-apply, dry-run each) →
#5 → #8 → #6 → #10 → #9.

---

## Appendix — contradictions found (disk/DB wins over lore)

1. **`ingestion_watermarks` is empty and unused** despite its name implying a live watermark store.
   Real watermark = `MAX(transaction_date)`. (live query, §5A-1)
2. **`rc-movement-auditor.md:44` still says "read the full LEARNING_LEDGER top-to-bottom every audit"**
   — contradicts the digest-first design adopted by the other five agents (`SKILL.md:34`,
   `RULES_DIGEST.md:3`). The auditor never got the digest-first rewrite.
3. **Only 1 of 5 apply orchestrators exists.** `LEAN_SYNC_REFACTOR.md` presents the two-phase
   orchestrator as the pattern "reused across all five," and MEMORY/handoffs imply the lean path is the
   norm — but on disk only `sync_gsheet.py` was built. deliveries/rc_out/production/flecon EXECUTE is
   still prose instructing MCP row-by-row writes.
4. **L-009 audit grant gap is real and load-bearing.** The employees only avoid the 403 because the
   **MCP connects as `postgres`** (verified). The service-role path (`lib/db.py`) genuinely 403s on a
   manual `audit_logs` INSERT — so the "lean apply writes audit rows" claim in
   `LEAN_SYNC_REFACTOR.md`/`sync_gsheet.py` is only true for `deliveries` (trigger, SECURITY DEFINER);
   for rc_out/production/flecon it needs the §5A fix.
5. **`deliveries` is the ONLY sync target with an audit trigger** (`deliveries_audit_trigger →
   log_delivery_changes()`, verified). rc_out, production_*, electricity, trucks, flecon have none —
   their audit rows are all manual inserts (currently succeeding only via MCP-as-postgres).
