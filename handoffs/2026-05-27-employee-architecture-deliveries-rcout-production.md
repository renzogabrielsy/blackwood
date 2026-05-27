# Handoff — 2026-05-27 — Employee Architecture: Deliveries, RC Out, Production

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md`. To find the latest: `ls handoffs/ | sort -r | head -1`.

---

## TL;DR

Day after the Jarvis scaffold (2026-05-26), the project pivoted from "build a chat agent in the app" to **"build a workforce of specialized Claude Code subagents that ingest emails into Supabase using deterministic Python tools."** The user's mental model: each report-type gets its own dedicated employee.

**Three employees now exist:**
1. **Deliveries Manager** (RC IN → `deliveries` table) — fully built, end-to-end tested with real data, ingested 2 NEW rows + re-synced 3 deleted rows in test
2. **RC Out Manager** (PROPOSED DAILY REPORT → `rc_out` table) — fully built, not yet end-to-end tested
3. **RC Movement Auditor** (RAW CHARCOAL MOVEMENT, read-only cross-check) — fully built, not yet tested
4. **Production Manager** (MC's Daily Production Report → 5 new tables) — **fully designed, no code yet**

**Other major shifts today:**
- Pivoted Gmail auth strategy: rejected Google Cloud OAuth + Composio in favor of **IMAP + Gmail App Password** (zero third-party, no GCP project, 2-min setup)
- Established **error toast HARD RULE**: every error toast persists until manually dismissed AND has a Copy button (10 call sites migrated to `errorToast()` wrapper)
- Established **employee architecture pattern**: Claude Code subagent + Python tools as deterministic muscle; subagent provides judgment, Python provides repeatability

**Next concrete action:** User needs to decide between (a) Phase 1 of Production Manager (migrations + first extractor), (b) end-to-end test of RC Out Manager with real data, or (c) build next employee (Bagging / QC / Sundry Manager).

---

## Context — who, what, why

**The user is Renzo Sy**, head manager at **ICTC** (coconut-shell-charcoal grading plant, Bacolod, Philippines). Working with the existing Next.js + Supabase app `blackwood` at `/Users/renzosy/blackwood`.

**Today's evolution of the Jarvis vision:** Jarvis-the-chat-agent (built yesterday) is still in place but the user's focus shifted to the more leveraged half of the design — automated email ingestion. Rather than a single in-app agent, the new architecture is a **"workforce" of Claude Code subagents** (one per email type) using Python tools as deterministic muscle. The user explicitly used the metaphor "employees, dedicated to extraction of each section."

**Trust boundary:** Gmail access lives in the Claude Code session (Renzo's laptop, IMAP App Password in `~/.config/sync-ictc/credentials.env` mode 600). Blackwood production never holds Gmail credentials. Each employee subagent uses fetch_gmail.py + Supabase MCP + extract/classify Python scripts to do its work.

**Today's session was very long** — multiple architecture pivots, extensive design work, one full end-to-end production test. Major architectural conversations + actual ingestion + design scaffolding for two more employees.

---

## What shipped this session

### 1. Deliveries Manager — first employee, end-to-end tested

**Agent:** `.claude/agents/deliveries-manager.md` (298 lines)

**Python tools** at `.claude/skills/sync-ictc/scripts/`:
- `fetch_gmail.py` (573 lines) — IMAP fetcher with App Password auth, X-GM-RAW search, X-GM-LABELS for idempotency, supports fetch / mark-processed / list-folders modes
- `extract_rc_deliveries.py` (532 lines) — multi-row header parsing, forward-fill sparse dates, B-label → batch_code heuristic with PILED-IN-MONTH remark fallback, FEEDING AREA → FEED batch translation
- `enrich_prices.py` (286 lines) — matches Czarina's "RAW CHARCOAL PURCHASES" prices to extracted RC IN rows by (supplier, truck, weight) — date is NOT used because Czarina's "Date of Del.paid" is typically +1 day from delivery
- `classify_deliveries.py` (264 lines) — NEW / DUPLICATE_NOOP / VALUE_CHANGED classification with diff details

**Real production test run:**
- Today's RC DELIVERIES email (UID 118420 from Ivy, 2026-05-26 04:10 UTC)
- Today's Czarina prices email (UID 118466, May 27 sheet)
- Result: 2 NEW rows inserted (5/23 Ornales MAY-26-BLK9 D-17A 18,725kg ₱41.50 + 5/25 Tag-at MAY-26-FEED6 19,330kg ₱40.00)
- 6 VALUE_CHANGED rows routed to `db_wins` (DONE FEEDING remarks belong to RC OUT, ASAH was typo, DB had correct ASH)
- 48 DUPLICATE_NOOP silently filtered
- New batch MAY-26-FEED6 auto-created
- 7 Gmail threads labeled `Blackwood-Processed`
- 2 `audit_logs` entries written with thread-ID provenance
- DB latest delivery advanced from 2026-05-21 → 2026-05-25 ✓

**Re-test after user deleted 3 rows:** Agent correctly identified all 3 deleted rows as NEW (5/21 Ornales BLK7, 5/23 Ornales BLK9, 5/25 Tag-at FEED6) with prices matched. Required unlabeling the 7 threads first (label-as-processed is idempotency mechanism — agent skips already-processed threads). Test ran via `general-purpose` agent as a proxy because new agent files aren't loaded mid-session.

### 2. RC Out Manager + RC Movement Auditor — second + third employees

**Source-of-truth split** (per Renzo): PROPOSED DAILY REPORT is the canonical source for `rc_out` writes; RAW CHARCOAL MOVEMENT is read-only audit cross-check.

**Agents:**
- `.claude/agents/rc-out-manager.md` (350 lines) — PROPOSE + EXECUTE modes
- `.claude/agents/rc-movement-auditor.md` (223 lines) — read-only watchdog

**Python tools added to `scripts/`:**
- `extract_proposed_daily.py` (426 lines) — per-block per-day rows; derives batch_code from BLOCK DATE + BLOCK NO (e.g., 2026-02-01 + #2 → FEB-26-BLK2); handles FEEDING AREA → FEED batch
- `extract_rc_movement.py` (234 lines) — daily fed totals from monthly sheet; **section-break detection** required (sheet has TWO data sections: main fed totals at top, then "SUPPLIERS" section starting around R101 that should NOT be extracted)
- `classify_rc_out.py` (258 lines) — natural key is `(transaction_date, batch_id, destination='MAIN')`; batch_id lookup via primary + fallback batch_code candidates; rows with no batch_id match go to UNMAPPED bucket (never auto-create batches in rc_out)
- `reconcile_rc_movement.py` (170 lines) — exit codes 0/1/2 (none/warning/serious drift)

**Reconciliation verified end-to-end on 5/26 data:**
- PROPOSED 5/26 sum of 5 block sections: 45,167 kg
- RC MOVEMENT 5/26 RAW CHARCOAL FED: 45,167 kg
- **Drift: 0 kg** ✓

**Design doc:** `.claude/skills/sync-ictc/RC_OUT_DESIGN.md` (195 lines)

### 3. Error Toast HARD RULE — wrapper + 14 call site migration

`lib/toast.ts` (44 lines) — exports `errorToast(message, { description? })` enforcing:
- `duration: Infinity` (persistent until X clicked)
- `closeButton: true`
- Copy action that writes full error to clipboard

Migrated all 14 `toast.error()` call sites across 8 files (admin × 3, settings × 1, rc-in × 2, rc-out × 2). Also added Copy button to Jarvis inline chat error (`components/jarvis/JarvisChatPanel.tsx`).

Documented in:
- `CLAUDE.md` Error Toasts (HARD RULE) section (new)
- `~/.claude/projects/-Users-renzosy-blackwood/memory/MEMORY.md` (User Preferences section)
- `~/.claude/projects/-Users-renzosy-blackwood/memory/feedback_error_toasts.md` (full reasoning)

**Why:** the user pastes errors into Claude chats; auto-dismissing toasts force screenshots that waste tokens on OCR.

### 4. Jarvis chat polish (from yesterday's scaffold)

- `query_deliveries` SELECT extended to include `lab_results` + `remarks` (was missing — that's why the user originally said "no ASH for Ornales")
- Tool description rewritten to explicitly tell Sonnet to weight by `weight_kg` for aggregations
- `react-markdown` + `remark-gfm` installed; `JarvisMessage.tsx` renders markdown for assistant turns (tables, code blocks, lists, etc.)
- System prompt rule #8 rewritten: ALWAYS include price (₱/kg + ₱ total) in any data table — was previously opt-in

### 5. Production Manager — design only, no code

**Design doc:** `.claude/skills/sync-ictc/PRODUCTION_DESIGN.md` (589 lines)

**Five new Supabase tables proposed** (will require migration when build kicks off):
- `production_runs` — output by `(date, grade, shift)`; grade IN (3X50 / 6X50 / 8X50 / 2X6); shift IN (M / E / N); CEBU is implicit destination (no `destination` column on this table)
- `production_downtime` — per `(date, shift)` with `dt_reason` field
- `production_waste` — per `(date, shift)` with 8 stream columns (RS1A, RS1B, BF, RS2_3, RS5, TRML1, TRML2, GRIT) — schema mirrors MASTER's WASTE SUMMARY exactly because Ivy's WASTE PRODUCTION REPORT email is what Renzo pastes into MASTER
- `electricity_readings` — daily per-meter (MAIN, BUNKHOUSE, PUMP confirmed)
- `truck_readings` — daily per-truck (AAV 6111, KCA 378 confirmed; more in MASTER)

**Plus a view** — `view_production_daily` joining all three production-direct tables for analytics.

**Phase 0 done in this session:**
- Inspected MC's Daily Production Report email (`Daily Production Report 2026 2Q.xlsx`, one sheet per production day, 42 sheets so far for Q2)
- MC's email contains ~20 sub-sections — only 5 are in scope for Production Manager v1; the rest go to future Bagging Manager / QC Manager / Sundry Manager / etc.
- Verified: electricity + trucks are DAILY (not monthly) in MC's email — so schema stores daily, derive monthly views
- Verified: one consolidated XLSX per email (not multiple attachments)
- Identified subject exactly: `"Daily Production Report"` from `mccontinedo.ictc@gmail.com`

**Locked decisions** (Section 12 of design doc):
- ONE Production Manager (not split into Production Output Manager + Waste Manager)
- Shifts: M / E / N (Renzo prepping for 3rd shift; currently only M/N active)
- Full backfill from MASTER (~250 PROD rows + monthly electricity/trucks)
- Grade enum locked: 3X50 / 6X50 / 8X50 / 2X6
- DT_REASON included (from MC's emails)
- Daily kg-in/kg-out drift is INFORMATIONAL only (never blocks writes — feed tank empties end of month; daily drift is expected from work-in-process inventory)
- NO `destination` column on production_runs (CEBU is implicit; KOREA/LOCAL/ZAMBOANGA waste sales are silently dropped from this scope)
- NO `rc_tank_level` table (deferred — user said not needed)
- NO `production_waste_sales` table (KOREA POWDER etc. excluded entirely from Production Manager scope)

**Out of scope (future agents):**
- Bagging Manager — FB sheet, magnet/ayag waste, re-classify/blending/re-bagging
- QC Manager — per-grade sheets (3X50 KC, 8X50, 6X50, 2X6 in MASTER), AYAG/MAGNET/FINAL stages
- Sundry Analysis Manager — SUNDRY ANALYSIS sheet
- Possibly a Waste Sales Manager later for KOREA/LOCAL/ZAMBOANGA buyer tracking

### 6. Architectural pivots that happened in this session

**Pivot A: Skill → Subagent + Python tools**
- Original sync-ictc was a SKILL (one big markdown doc invoking Python scripts)
- User proposed "employees per extractor" for parallelization
- I initially over-engineered the cost argument (assumed API tokens). User clarified: Claude Code subagents are on the existing Max plan, no marginal per-extractor cost
- Final architecture: each employee = a `.claude/agents/<name>.md` subagent definition + a set of Python tools as deterministic muscle. Subagent provides judgment + orchestration, Python provides repeatable extraction/classification

**Pivot B: Gmail auth — Google Cloud OAuth → Composio → klodr MCP → IMAP + App Password**
- Tried 4 different approaches in one conversation
- Final landing: **IMAP + App Password** wins because:
  - Zero Google Cloud project setup
  - Zero third-party trust (no Composio, no klodr)
  - 2-min user setup (generate App Password at myaccount.google.com/apppasswords)
  - Mature protocol, won't break
  - Python stdlib (`imaplib`) so no npm dependency
- User generated App Password and tested — works
- Credentials: `~/.config/sync-ictc/credentials.env` (mode 600, contains GMAIL_USER + GMAIL_APP_PASSWORD)

**Pivot C: Reconciliation expectations**
- Initial design assumed RC IN → RC OUT → Production should balance daily (cross-check ingestion accuracy)
- User corrected: feed tank is continuous-flow; daily drift is EXPECTED and is just work-in-process inventory
- Real balance check happens at end-of-month when tank is emptied
- Production Manager v1 does NOT gate writes on this — surfaces drift as informational

**Pivot D: Waste design**
- Original: speculative `production_waste_sales` table for KOREA POWDER style buyer-classification
- User: "drop korea and local powders entirely. Focus on product production"
- Final: only stream-classified waste (matches MASTER + matches Ivy's WASTE PRODUCTION REPORT email). Waste-sales context is out of Production Manager scope

---

## Critical learnings to internalize

### Learning #1 — Employee architecture pattern (the new mental model)

Every email type gets a dedicated Claude Code subagent. Each one:
- Lives at `.claude/agents/<name>.md`
- Has a description that auto-routes from natural-language prompts ("sync deliveries", "sync rc out")
- Operates in PROPOSE mode (default) or EXECUTE mode (after approval)
- Uses Python scripts as deterministic tools — never extracts XLSX cells via Bash/awk
- Has scoped tool access (Bash, Read, Write, mcp__supabase__execute_sql, sometimes Edit)
- Reports back via a structured response — main session presents to user, gets approval, re-invokes in EXECUTE mode

Pattern for new employees:
1. Inspect source email + corresponding MASTER sheet
2. Write design doc (e.g., `*_DESIGN.md`)
3. Get user confirmation on schema decisions
4. Build Python tools (extract / classify / reconcile)
5. Write agent definition
6. Test via `general-purpose` proxy in same session
7. User restarts Claude Code to load agent for future native invocation

### Learning #2 — Inconsistent month-prefix in DB batch_codes

Verified empirically with a `SELECT SPLIT_PART(batch_code, '-', 1), COUNT(*)` query. Conventions for 2026:
- JAN, FEB → 3-letter
- MARCH, APRIL → full name
- MAY → 3-letter (naturally)
- JUNE, JULY → full
- AUG → 3-letter
- SEPT → 4-letter
- OCT, NOV, DEC → 3-letter

The extract_proposed_daily.py uses a primary + fallback prefix list; classifier tries both before flagging UNMAPPED. Same approach should be used by any future agent that needs to resolve batch_codes from operator-format inputs.

### Learning #3 — Czarina's payment date != delivery date

Her RAW CHARCOAL PURCHASES file has "Date of Del.paid" which is typically delivery_date + 1 day. Matching on date alone breaks. Solution in `enrich_prices.py`: natural key for price lookup is `(supplier_normalized, truck_normalized, weight_kg)`. Date is only used as a tiebreaker when multiple candidates match.

### Learning #4 — Truck plate inconsistency between operator and Czarina

Operator writes "AAV 611" (3 digits with space), Czarina writes "AAV6111" (4 digits no space). Same truck or different? Typo in one file? My norm_truck() strips whitespace, so "AAV 611" → "AAV611" but Czarina's "AAV6111" stays "AAV6111". They DON'T match. 5 unmatched rows surfaced — all DUPLICATE_NOOP so non-blocking, but a fuzzy-match fallback would help in future.

### Learning #5 — RC MOVEMENT has TWO data sections

The sheet has the main daily fed table (R7-R37) plus a SECOND section starting at R101 labeled "SUPPLIERS" — duplicate dates with zero or null fed values. The extractor must STOP at section breaks (rows with non-date text in col A: "SUPPLIERS", "REMARKS:", etc.).

### Learning #6 — Claude Code session env has ANTHROPIC_API_KEY=""

The shell `process.env.ANTHROPIC_API_KEY` is set to empty string. Next.js doesn't override existing process.env when loading .env.local. So dev server gets undefined for Anthropic key.

Workaround: start dev server with `env -u ANTHROPIC_API_KEY npm run dev` to clear the var, letting .env.local fill it. Document for future sessions.

### Learning #7 — Claude Code MCP attachment limitation

The default Gmail MCP (`claude.ai Gmail` connector) has 12 tools — none download attachment bytes. It returns attachment metadata (filename, id, mimeType) but no `get_attachment` to fetch bytes. We worked around with IMAP via fetch_gmail.py instead of the MCP for attachment-heavy operations.

### Learning #8 — Idempotency via Gmail labels

The pattern: agent applies `Blackwood-Processed` label to threads it successfully ingested. Next run's search query excludes that label (`-label:"Blackwood-Processed"`). This is rock-solid idempotency.

For testing: to re-run on already-processed data, must UNLABEL via IMAP first (Gmail MCP requires extra permissions for unlabel; IMAP via fetch_gmail.py works fine).

### Learning #9 — Daily kg-in/kg-out drift is EXPECTED, not an error

The feed tank is continuous-flow. Daily RC IN deliveries arrive on no fixed schedule. Daily RC OUT consumption happens at production line speed. The two don't balance per day — they balance at month-end when tank is emptied.

Therefore: the Production Manager does NOT gate writes on "input total = output total + waste total" — that test is informational only. Useful for monitoring trends; not a data quality signal on a per-day basis.

The agent that CAN have a hard gate: RC Out Manager's PROPOSED-vs-RC MOVEMENT reconciliation, because those two files SHOULD match daily — both record the same day's events from different operators. Drift > 500 kg there → halt writes until manual reconciliation.

### Learning #10 — Operator's "PILED IN APRIL # 9" remarks are extractor hints

The operator's RC DELIVERIES file uses short batch labels like "B9" instead of full batch codes. Heuristic resolution:
1. If remarks contain "PILED IN <MONTH> # <N>" → batch_code = `{MONTH}-26-BLK{N}` (use the explicit month)
2. Otherwise → use delivery_date's month for the prefix

The pattern was caught from one row's remarks. Future operators might use different conventions; the heuristic logs warnings for non-standard cases.

### Learning #11 — Single-writer architecture preserved

Renzo is the sole writer. All employee agents respect this:
- Gmail credentials on his laptop only (IMAP App Password)
- Blackwood prod never sees Gmail
- Audit logs use `performed_by = NULL` for skill writes (the comment carries provenance)
- No third-party in the data path (no Composio, no klodr, no Google Cloud OAuth client)

### Learning #12 — Subagent definitions are loaded only at Claude Code startup

When you write a new `.claude/agents/<name>.md` file, the current session can't invoke it as `subagent_type: <name>` until Claude Code restarts. Workaround for testing in the same session: use `general-purpose` as a proxy with the agent's full protocol embedded in the prompt.

Future agents should always be tested via `general-purpose` first, then the user restarts to register the named version.

---

## Current state — what's working, what's broken, what's pending

### ✅ Working and tested with real data
- Deliveries Manager full pipeline (fetch → extract → enrich → classify → present → write → label)
- Czarina price enrichment (51/56 matched in latest run; 5 unmatched on truck-plate inconsistency)
- IMAP fetch via App Password
- Error toast wrapper (in all 14 migrated call sites)
- Markdown rendering in Jarvis chat panel
- Reconciliation: PROPOSED sum vs RC MOVEMENT daily fed (verified 0 drift on 5/26)

### 🟡 Built but not yet tested end-to-end
- RC Out Manager (PROPOSED → rc_out writes)
- RC Movement Auditor (read-only audit)

### ⚠️ Known issues
- Subagent definitions only load on Claude Code restart (workaround: use general-purpose proxy)
- Truck-plate fuzzy matching needed for AAV 611 / AAV6111 case (currently 5 historical rows unmatched in price enrichment — all DUPLICATE_NOOP so non-blocking)
- Gmail MCP unlabel_thread requires additional permissions (use IMAP-based STORE -X-GM-LABELS instead)

### 🚧 Designed but no code
- Production Manager — full design doc complete, locked decisions, no migration yet, no Python scripts, no agent file

### 📋 Designed for future (no doc yet)
- Bagging Manager (FB sheet, magnet/ayag, re-classify/blending/re-bagging)
- QC Manager (per-grade sheets, AYAG/MAGNET/FINAL stages)
- Sundry Analysis Manager
- Possibly Waste Sales Manager (KOREA / LOCAL / ZAMBOANGA buyer tracking)

---

## Open decisions still pending

These need a user answer before specific work proceeds:

### 1. Production Manager Phase 1 go-ahead
Phase 0 (design + email inspection) is fully done. Phase 1 is migrations + view + Python extractors + agent file. Estimated 12 hours across 2 sessions. User needs to say "go" to kick off.

### 2. RC Out Manager end-to-end test
The agent is built but hasn't run a real production sync. Would catch any issues before serious use. Quick: probably 15 minutes including DB verification.

### 3. Other employee priorities
Order of next employees to hire — Bagging Manager? QC Manager? Sundry Manager? Depends on which daily reports cause the most pain in Renzo's manual workflow.

### 4. Truck plate fuzzy matching
Real concern: AAV 611 vs AAV6111 mismatch. Could add Levenshtein-distance fallback to enrich_prices.py. Low priority — only 5 historical rows affected, all already DUPLICATE_NOOP.

---

## Architectural decisions locked this session

1. **Employee architecture**: One Claude Code subagent per email type; Python tools for deterministic muscle; subagent for orchestration + judgment.
2. **Gmail auth**: IMAP + App Password (not OAuth, not Composio, not klodr MCP). Credentials at `~/.config/sync-ictc/credentials.env` mode 600.
3. **Idempotency mechanism**: Gmail label `Blackwood-Processed` applied to threads after successful ingestion. Search queries exclude that label.
4. **Reconciliation gating**:
   - HARD gate (halt writes) when two same-day-events sources drift > 500 kg (e.g., PROPOSED vs RC MOVEMENT)
   - SOFT informational only when continuous-flow drift expected (e.g., RC IN vs Production OUT — feed tank in transit)
5. **Error toast HARD RULE**: every error toast persists until manually dismissed AND has a Copy button. Wrapper at `lib/toast.ts`. Never call `toast.error()` directly.
6. **Batch_code resolution**: try primary month-prefix, fallback to alternate prefix (DB convention is inconsistent — JAN vs JANUARY). UNMAPPED never auto-creates batches.
7. **Price enrichment**: match by `(supplier, truck, weight)` not date. Czarina's payment date != delivery date.
8. **CEBU is implicit** for production. Other "destinations" (KOREA, ZAMBOANGA, LOCAL) are waste-buyer customers, out of Production Manager scope.
9. **Shifts: M / E / N** (preparing for 3rd shift; currently M/N active).
10. **Production v1 scope**: 5 tables (runs / downtime / waste / electricity / trucks); 14+ other MC email sections deferred to future agents.

---

## Next concrete action when picking back up

User's choice between:

**Option A: Build Production Manager Phase 1**
- Apply migrations for 5 tables + view_production_daily
- Build extract_master_prod.py (read all 3 PROD sub-tables from MASTER for backfill)
- Build extract_master_electricity.py and extract_master_trucks.py
- Bulk backfill all historical data from MASTER
- Time estimate: ~6 hours for the Master backfill stack; full Production Manager including emails another 6-8 hours

**Option B: End-to-end test RC Out Manager**
- Restart Claude Code first (to load rc-out-manager subagent natively) OR use general-purpose proxy
- Run "sync rc out" prompt
- Verify the 5 expected NEW rc_out rows for 5/26 land correctly
- Time estimate: ~30 min

**Option C: Build next employee (Bagging / QC / Sundry / etc.)**
- Repeat the design + build pattern for whichever pain-point Renzo wants relieved next
- Each follows: inspect → design → build Python → build agent → test
- Time estimate per employee: 6-10 hours depending on email complexity

**Option D: Polish + handoff**
- Restart Claude Code, register all 3 agents natively
- Test deliveries-manager + rc-out-manager directly (not via proxy)
- Document the "employee onboarding" pattern in the project README

User likely wants Option A (Production Manager build) since that's where today's most thorough design work landed.

---

## Project file references

**Active and current:**
- `/Users/renzosy/blackwood/CLAUDE.md` — operating norms (NEW: Error Toasts HARD RULE section)
- `/Users/renzosy/blackwood/TIMELINE.md` — recent completions
- `/Users/renzosy/blackwood/AI_INGESTION_AGENT.md` — original Jarvis ingestion design (still relevant as the canonical design doc)
- `/Users/renzosy/blackwood/FLASK_PORT_PLAN.md` — Flask port plan (deferred indefinitely; current Next.js + subagent strategy supersedes)

**Today's design docs (read before working on respective domain):**
- `/Users/renzosy/blackwood/.claude/skills/sync-ictc/RC_OUT_DESIGN.md` — reconciliation logic for rc-out-manager
- `/Users/renzosy/blackwood/.claude/skills/sync-ictc/PRODUCTION_DESIGN.md` — full design for Production Manager (589 lines, all locked decisions)

**Today's agent definitions:**
- `/Users/renzosy/blackwood/.claude/agents/deliveries-manager.md`
- `/Users/renzosy/blackwood/.claude/agents/rc-out-manager.md`
- `/Users/renzosy/blackwood/.claude/agents/rc-movement-auditor.md`

**Today's Python tools** (all at `.claude/skills/sync-ictc/scripts/`):
- `fetch_gmail.py`, `extract_rc_deliveries.py`, `enrich_prices.py`, `classify_deliveries.py`
- `extract_proposed_daily.py`, `extract_rc_movement.py`, `classify_rc_out.py`, `reconcile_rc_movement.py`

**App-side changes:**
- `lib/toast.ts` (NEW — errorToast wrapper)
- `lib/jarvis/tool-handlers.ts` (UPDATED — lab_results + remarks in query_deliveries; tool description rewritten)
- `lib/jarvis/system-prompt.ts` (UPDATED — rule #8 always-include-price)
- `components/jarvis/JarvisMessage.tsx` (UPDATED — markdown rendering for assistant turns)
- `components/jarvis/JarvisChatPanel.tsx` (UPDATED — Copy button on inline error)
- 8 files migrated to `errorToast()` wrapper (admin, settings, rc-in, rc-out)
- `package.json` — added `react-markdown` + `remark-gfm`

**Per-module CONTEXT.md files (read before exploring a module):**
- All from yesterday's handoff still apply
- No new module-level CONTEXT.md added today (sync-ictc is in .claude/, not app/)

**Git state at handoff:**
- Branch: `dev`
- Many uncommitted changes from today's work (Python scripts, agent files, design docs, app-side updates)
- Working tree NOT clean — needs commit before next major change

**Should be committed:**
- All new files under `.claude/skills/sync-ictc/` and `.claude/agents/`
- `lib/toast.ts`
- All 8 modified files using `errorToast()`
- `lib/jarvis/` updates
- `components/jarvis/` updates
- `CLAUDE.md` updates
- `TIMELINE.md` updates (will be made by this handoff process)
- `handoffs/2026-05-27-employee-architecture-deliveries-rcout-production.md` (this file)
- `MEMORY.md` updates (will be made by this handoff process)

Run `git status` to confirm exact state at the start of next session.

---

## How to update this pattern

When ending future sessions:
1. Create a new file in `handoffs/` with format `YYYY-MM-DD-<short-slug>.md`
2. Use this file as a template
3. Don't delete old handoffs — they form the project's session history
4. To find the latest: `ls handoffs/ | sort -r | head -1`

When starting future sessions:
- The user can say "view latest handoff file" / "where did we leave off" / "what's the current state"
- The agent should run `ls handoffs/ | sort -r | head -1` and read that file before doing anything else
- This pattern is also documented in `CLAUDE.md` under the **Handoff Files** section

---

*End of handoff — 2026-05-27 — Employee Architecture: Deliveries, RC Out, Production*
