# Handoff — 2026-05-31 — Google-Sheet Source-of-Truth Pivot + Self-Learning Ledger + Blocking Bug Caught & Fixed

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Lineage:** continues `2026-05-29-production-manager-agent-built.md`, whose next action ("real unified production + deliveries EXECUTE run") is **DONE** — and this session went much further: built the one-click sync, then pivoted the whole data architecture to the Google Sheet, and caught + fixed a real inventory bug.

---

## TL;DR

Three big things happened, in order:
1. **First real EXECUTE writes** — production (5/25–5/28 catch-up) + deliveries went live; then a one-click parallel **`ictc-sync` workflow** was built, and a **self-learning ledger** (`LEARNING_LEDGER.md`, now L-001…L-006) that turns every Renzo correction into permanent agent memory + an actionable-flag protocol.
2. **The Google-Sheet pivot (the architectural shift).** Renzo's link-shared Google Sheet is now the **SOURCE OF TRUTH for RC IN + RC OUT (2025-01-01 onward)**, ingested by a new **`gsheet-sync`** employee. The email agents are being repointed from *writers* to *read-only auditors* (email-vs-DB). gsheet-sync EXECUTE ran: DB is now Sheet-aligned for 2025+ (~42 writes, all `provenance=gsheet`).
3. **A blocking cross-check caught a real ~54 t phantom-inventory bug** and we fixed it: `batches.current_weight` was being double-counted by the **deliveries-manager** (an imperative `current_weight += delta` racing the trigger — L-001 family). Fixed via two migrations (the view now computes balance from transactions = self-correcting) + a playbook guard.

**Next concrete action:** finish the pivot — (1) **flip `deliveries-manager` + `rc-out-manager` to audit mode**, (2) **wire pricing** (Czarina `cost_basis`), (3) **lean Python-first refactor of gsheet-sync** (Renzo's efficiency ask). **Restart Claude Code** to register `gsheet-sync` as a named agent (until then it runs via a general-purpose proxy).

Everything is committed + pushed to `dev` (6 commits). Working tree clean.

---

## What shipped (with paths)

### 1. Self-learning sync foundation
- **`.claude/workflows/ictc-sync.js`** — one-click workflow: deliveries + rc-out + production in PARALLEL auto-execute + a read-only `rc-movement-auditor` pass. ⚠️ **Renzo dislikes the Workflow tool (too many tokens)** — daily runs should be **parallel `Task` launches on Sonnet 4.6**, NOT the Workflow tool. The file documents the flow; the workflow proved 3 concurrent agents on one Gmail mailbox = zero `[Errno 60]`.
- **`.claude/skills/sync-ictc/LEARNING_LEDGER.md`** — ever-growing, append-only. Entries: L-001 (audit_logs trigger-written → UPDATE not INSERT), L-002 (PCA/PCB "pathway" feeds = overflow SUNDRY batches), L-003 (bare-number 514/601 sections = continuation pallets, not feeds), L-004 (Sheet "NEW" row w/ matching date+batch+weight but different block_loc = block_loc correction), L-005 + **L-006** (`current_weight += delta` double-count root cause + hard rule). Every agent reads it before classifying.
- **`.claude/skills/sync-ictc/AUDIT_FINDINGS.md`** — the audit's findings log. **AF-001 = RESOLVED** (the blocking phantom-inventory bug).
- **`.claude/skills/sync-ictc/SYNC_LEARNINGS.md`** — run log + hardening backlog.
- All 4 email agent defs + the new gsheet-sync def read the ledger first + emit actionable flags (`what / source_file / sheet / rows / open '<path>' / question`; flagged source files copied to `~/blackwood/.sync-flags/<date>/`, gitignored).

### 2. gsheet-sync employee (the Sheet pivot)
- **`.claude/agents/gsheet-sync.md`** — PROPOSE+EXECUTE. Source = Renzo's link-shared Google Sheet (ID `1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM`) via `curl …/export?format=xlsx`. Ingests **RC IN + RC OUT tabs only** → `deliveries`/`rc_out`. Policy: **scope 2025-01-01+**, **forward-only**, **Sheet-wins on material VALUE_CHANGED** (rounding/null↔0 demoted to NOOP), **conflict-flag** (NEW colliding with a *different* batch at same date/slot/weight → FLAG, never auto-write/delete), `provenance=gsheet` in audit_logs. Blocking tab = **cross-check only, NEVER ingested**. `cost_basis` out of scope. Runs FIRST in the daily sequence.
- **`.claude/skills/sync-ictc/scripts/extract_gsheet.py`** + **`classify_gsheet.py`** (`--mode rc_in|rc_out --since 2025-01-01`). Emit primary+fallback batch_codes; material-gate; conflict guardrail.
- **`.claude/skills/sync-ictc/GSHEET_DESIGN.md`** — design doc + column maps + dry-run results.
- **Memory:** `~/.claude/projects/-Users-renzosy-blackwood/memory/gsheet_data_source.md` (the Sheet link, 8-tab map, full architecture, locked decisions) + one-line index in `MEMORY.md`.

### 3. Blocking bug fix (migrations)
- **`supabase/migrations/20260531041520_fix_blocking_view_balance_from_transactions.sql`** — `view_blocking_grid.balance` now computes `SUM(deliveries) − SUM(rc_out)` (correlated subquery for the rc_out total, OUTSIDE the GROUP BY to avoid LEFT JOIN fan-out) instead of reading `batches.current_weight`. **Self-correcting** — the grid is right even if `current_weight` drifts again.
- **`supabase/migrations/20260531041615_resync_current_weight_for_drifted_active_batches.sql`** — re-synced the 3 drifted active batches (allow-list).
- **`.claude/agents/deliveries-manager.md`** — Step 4 guard: never `UPDATE batches SET current_weight += delta` (trigger owns it; use idempotent absolute form if ever needed).
- `app/(app)/inventory/blocking/CONTEXT.md` updated.

### 4. Real DB writes this session (data, not code)
- **Production:** first EXECUTE — 5/25–5/28 = 8 `production_shifts` + 8 runs + 4 downtime + 8 waste + 4 electricity + 1 truck + 33 audit_logs. Watermark → 2026-05-28.
- **Deliveries (email):** the morning unified run + the gsheet sync. DB `deliveries` = 1,584.
- **gsheet-sync EXECUTE (2025+):** RC IN 14 updates (supplier spelling, 5 lab panels, 5 remarks) + 12 block_loc corrections (sundry → A-4C/PCA-16A/PCB-16B) + 7 truck_plate → `MAR 2499`; RC OUT 1 insert (`NOV-25-BLK16`) + 6 updates + 1 FEED5 insert (5/26 6,497) + 1 FEED5 reassign (5/27 13,330, FEED6→FEED5). All `provenance=gsheet`. `rc_out` = 1,926.
- **current_weight resync:** MAY-26-FEED6/BLK9/BLK7 corrected to in−out.

---

## Critical learnings (highest-value section)

1. **The Google Sheet is the new source of truth for RC IN/OUT (2025+).** Link-shared → no auth, just `curl …/export?format=csv|xlsx`. Maintained by Renzo's OWN hires (vs the legacy email maintained by one person for Joseph) → **genuinely independent** → real cross-check. 8 tabs: Blocking · RC IN (=deliveries, no price) · RC OUT · SUNDRY · 3X50 QC · Production · ORDERS · PROD SCHED. **Pre-2025 Sheet data is incomplete** → scope 2025+, leave legacy DB untouched. ORDERS + PROD SCHED have no Blackwood module yet (future).
2. **Sheet ≈ DB (shared master-file lineage).** The 2025+ dry-run was ~98% NOOP (RC IN 785/12/21; RC OUT 1,615/1/6/2-flagged). So gsheet-sync is mostly *confirmation*, cheap. The **email diverges more** → the email-vs-DB audit is where real breaks surface. Since gsheet-sync runs first, "email vs DB" == "email vs Sheet" transitively.
3. **The blocking bug (AF-001 / L-006):** `batches.current_weight` was over-stated by ~54 t across 3 active MAY-26 batches. Root cause = the **deliveries-manager EXECUTE run on 2026-05-27 03:04:39** issued an imperative `UPDATE batches SET current_weight = current_weight + <weight>` *on top of* the correct trigger (`fn_update_blackwood_state` already does the `+=`). Proof: 5/26 inserts via the same trigger were NOT doubled. The triggers are innocent. **Rule: balance is ALWAYS `SUM(in) − SUM(out)`; never `+= delta` on current_weight.** The view now computes from transactions so this can't mislead the app again.
4. **EFFICIENCY (Renzo's explicit ask — drives the next refactor):** the deterministic work (download/parse/classify/diff/write-unambiguous) should be **pure Python**; the LLM agent should only touch the **flagged handful**. The agents have been burning tokens "autonomously scanning files" + narrating no-op rows. The blocking cross-check was done the lean way and should be the template: `curl` + REST + a ~40-line Python diff (`/tmp/blocking_xcheck.py`), near-zero tokens, returns only mismatches. **Refactor gsheet-sync into a single `sync_gsheet.py` runner that writes the unambiguous rows directly to Supabase and emits only flags.** Constraints found: the Supabase **REST view endpoint 403s** (`view_blocking_grid` not exposed) but the **`batches` table REST works** with the service key; **no `psycopg2`/`psycopg` driver installed**; `.env.local` has `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (usable for REST writes/reads).
5. **Renzo preferences locked this session:** NO Workflow tool (tokens) → use parallel `Task` launches; **Sonnet 4.6** for recurring sync/audit runs (Python does the deterministic work); goal = **less encoding, more exception-analysis**.
6. **`deliveries.cost_basis` is NOT NULL** — so a genuinely-new Sheet RC IN row (no price) can't be inserted as-is; it needs a placeholder until the email/Czarina pricing step fills it. (Didn't bite this run — all 12 "new" were dupes-with-different-block_loc, L-004.)
7. **gsheet-sync conflict guardrail works:** the `MAY-26-FEED5` collisions were correctly held → Renzo resolved "follow the sheet" → insert the 5/26 6,497, reassign the 5/27 13,330 (no double-count, no delete).

---

## Current state

### ✅ Working / validated
- gsheet-sync built, dry-run + EXECUTE done. DB aligned to the Sheet for 2025+.
- **Blocking cross-check: 167/167 slots, same batch in every slot, 0 occupancy mismatches.** The 2 balance mismatches were the `current_weight` bug — now fixed; view self-correcting; all 167 rows satisfy `balance == in − out`.
- Build green (`tsc --noEmit` 0 errors). Migrations applied to the linked remote DB.

### ⚠️ Built but not yet done
- **Email agents still in WRITE mode** — the deliveries-manager + rc-out-manager → audit-mode flip is NOT done yet (this is the headline next step).
- **Pricing wiring** (Czarina `cost_basis` + NOT-NULL placeholder) — not built.
- **Lean Python-first refactor of gsheet-sync** — not built (Renzo's efficiency ask).
- **gsheet-sync is NOT a registered named agent** — needs a Claude Code restart; runs via general-purpose proxy until then.

### ⚠️ Deferred (flagged, not done)
- **2 legacy CLOSED batches with current_weight drift** — `MAY-26-FEED5` (+13,330, from the 5/30 reassignment) and `JAN-26-SUNDRY7` (−2,533, also has stale `location_ref='A-4C'` despite CLOSED). Off-grid, harmless to the app. Awaiting Renzo's call (AF-001).
- `supabase/.temp/cli-latest` is tracked → recurring diff noise; `git rm --cached supabase/.temp/` + gitignore it.
- From SYNC_LEARNINGS backlog: `extract_proposed_daily.py` over-segmentation (the 514/601 phantom continuation rows) + reconciler `--unmapped-aware`; rc-out reconciliation should be write-based not map-based.

---

## Open decisions
- The 2 legacy CLOSED batches: fix or leave?
- Pricing: exact placeholder strategy for genuinely-new Sheet RC IN rows (cost_basis is NOT NULL).
- Lean refactor: confirm direct Python→Supabase writes (service-role key) are acceptable for the daily run.

---

## Next concrete action
**Recommended order:** (1) **lean Python-first refactor of gsheet-sync** — a single `sync_gsheet.py` that curls the Sheet, classifies vs DB, writes the unambiguous 2025+ rows directly to Supabase (service-role REST/`requests`; no psycopg available), and emits ONLY flags — making the daily run one cheap command (template: `/tmp/blocking_xcheck.py`). Then (2) **flip `deliveries-manager` + `rc-out-manager` to audit mode** (read-only email-vs-DB break reports → AUDIT_FINDINGS + ledger). Then (3) **pricing**. **Restart Claude Code** first so `gsheet-sync` registers as a named agent.

---

## Git state
- Branch `dev`, working tree **clean**, in sync with `origin/dev` at `f23f6c1`. This session's 6 commits (pushed): `5887f9e` (workflow + ledger), `cf09b73` (EXECUTE learnings/memory), `94625e6` (gsheet-sync employee), `5e3709c` (blocking view fix + resync migrations), `2161dd0` (ledger L-004/5/6 + AUDIT_FINDINGS), `f23f6c1` (deliveries-manager current_weight guard).

---

*End of handoff — 2026-05-31 — Google-Sheet source-of-truth pivot, self-learning ledger to L-006, blocking phantom-inventory bug caught by the new cross-check and fixed.*
