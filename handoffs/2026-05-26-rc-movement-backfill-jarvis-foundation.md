# Handoff — 2026-05-26 — RC Movement, Backfill, Jarvis Foundation

> **For the next session.** This is the canonical "what just happened and what's next" file. If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md`. To find the latest: `ls handoffs/ | sort -r | head -1` — the YYYY-MM-DD prefix makes alphabetical sort equivalent to chronological.

---

## TL;DR

In one long session, we (1) shipped the **RC Movement** feature end-to-end, (2) backfilled **6 years of Excel data** into Supabase and aligned the database to the user's master Excel as source of truth, (3) made a major architectural pivot from "multi-writer offline sync" to **"single-writer + AI ingestion agent"** for the Flask port plan, and (4) verified Anthropic API access (Opus 4.7 + Sonnet 4.6 with 1M context) — laying the foundation for the next phase: **building the "Jarvis" AI agent** inside the existing Next.js codebase.

**Next concrete action:** spawn the Jarvis multi-agent build. User said "go" at the very end of the session but interrupted before the build kicked off, so the build is **not yet started**. Pick up by confirming the open decision (first report type to scaffold) and then spawning the build.

---

## Context — Who is the user, what are we building, why

**The user is Renzo Sy**, head manager at **ICTC** — a coconut-shell-charcoal grading plant in the Philippines (Bacolod area). The plant buys raw charcoal from rural suppliers, mechanically grades and sieves it into specific mesh sizes (`3×50`, `6×50`, `8×50`, `2×6`), and ships graded product — primarily to **activated-carbon manufacturers in Korea**, with some volume going via a sister plant in **Cebu** and a smaller channel to **Zamboanga**.

**Renzo's political situation matters:** His boss **Joseph Go** (`kitz323@yahoo.com`) micro-manages the plant via a daily Gmail email storm — he runs his own separate set of Excel books and makes block-level decisions himself ("place tomorrow's Tag-at delivery in the Feeding Stockpile"). Renzo is technically head manager but Joseph is the de-facto operating system. Renzo's strategic interest in building Blackwood + Jarvis is to **own the data layer so cleanly that decisions become defensible by numbers**, not Joseph's memory. This isn't just a tool — it's authority infrastructure.

**The platform Blackwood:** a Next.js 16 + Supabase app at `/Users/renzosy/blackwood`. Two paradigms: (1) a composable widget dashboard at `/`, (2) Excel-dense inventory tables at `/inventory` (RC IN / RC OUT / Blocking / Movement). Auth uses Supabase Google OAuth with role gating (Owner / Admin / Dev / Production / Accounting).

**The Jarvis vision (user's term):** a slide-out chat-style AI agent that permeates the entire app — proactive, conversational, tool-using, with memory across sessions. Specifically scoped to **inventory operations only** in v1 (production, accounting, HR are out of scope until those modules exist in the app). Should grow as the app grows.

---

## What shipped this session

### 1. RC Movement feature (Next.js + Supabase — Phases complete)

A new 4th tab in `/inventory` (alongside Deliveries / Usage / Blocking) that mirrors the user's Excel `RC MOVEMENT` sheet column-for-column.

**Backend (commit 8b7e84a, plus migration adjustments):**
- SQL view `view_rc_movement` — applied to live Supabase (migration `20260525000000_create_view_rc_movement.sql`)
- Patch migration `20260525000001_fix_rc_movement_block_loc_empty_string.sql` — `NULLIF(rc.block_loc, '')` so empty-string block_loc falls back to `batches.location_ref`
- Permission migration `20260526010000_grant_view_rc_movement_select.sql` — fixes "permission denied for view view_rc_movement" error that surfaced because the original view-creation migration didn't include a `GRANT SELECT TO anon, authenticated` clause
- Server action at `app/(app)/inventory/rc-movement/actions.ts` exporting `fetchRcMovementData(year, month)` with types `RcMovementRow / RcMovementDay / RcMovementData`. Uses `select('*')` (multi-line select strings break TypeScript inference)
- Production-role cost scrubbing: PHP/KG and PHP TTL fields filtered out entirely (not blanked) when `!canViewPrices`

**Frontend (commit 8b7e84a):**
- New "Movement" tab in `inventory-tab-context.tsx` + `sheet-tabs.tsx` + `inventory-view.tsx`
- Lazy loader `app/(app)/inventory/components/rc-movement-lazy-tab.tsx`
- Table `app/(app)/inventory/rc-movement/rc-movement-table.tsx` (~470 lines):
  - Flat `VirtualItem` array (`{ kind: 'day-header' | 'lane' }`) rendered via raw `<table>` + `@tanstack/react-virtual` — bypasses TanStack Table's row model since grouped virtual rows don't map cleanly to `ColumnDef`
  - Excel-mirrored columns: DATE / DAY / TTL KG / BLOCKS / START BAL / BATCH FED / TTL FED / % LOSS / PHP/KG / PHP TTL / STATUS / BLOCK LOC
  - Day-header rows = single `<td colSpan>` with glass background (`bg-muted/90 backdrop-blur-sm`)
  - % LOSS color logic (corrected post-ship): `status === 'active'` → no color (italic + `*` superscript is enough), `closed` → green normal <2%, amber 2-10%, red >10%, red <0% (over-consumed)
  - STATUS: green dot active / red ✕ line-through closed
  - Built-in month picker footer (lighter than `DeliverySheetFooter`)
- SSR=false wrapper at `app/(app)/inventory/rc-movement/components/rc-movement-table-wrapper.tsx` (Radix tooltip hydration)
- CONTEXT.md files: `rc-movement/CONTEXT.md` and parent `app/(app)/inventory/CONTEXT.md` (created — didn't exist before)

### 2. Historical data backfill (live Supabase aligned with Excel)

The user's master Excel (`/Users/renzosy/Documents/1A WORK FILES/ICTC/MASTER - ICTC INPUT FILE V1.xlsx`) is the source of truth. We aligned Supabase to it.

**Before:**
| Table | Excel | Supabase | Gap |
|---|---|---|---|
| deliveries | 1,577 | 1,328 | 249 missing |
| rc_out | 1,887 | 1,716 | 171 missing |
| batches | — | 518 | — |

**After:**
| Table | Excel | Supabase | Gap |
|---|---|---|---|
| deliveries | 1,577 | 1,581 | **0 missing, 4 historical extras** |
| rc_out | 1,887 | 1,904 | **0 missing, 17 historical extras** |
| batches | — | 655 | — |
| Latest delivery | 2026-05-21 | 2026-05-21 | aligned |
| Latest rc_out | 2026-05-22 | 2026-05-22 | aligned |

**Backfill mechanics (one-shot scripts at `/tmp/blackwood_backfill/`):**
- 253 deliveries inserted (chronological)
- 188 rc_out rows inserted (one at a time in strict chronological order — chunk inserts hit unique-index violations on D-19D, D-20D, PCA-15A, PCA-17B because the trigger temporarily activates a batch before subsequent CLOSED events finalize it)
- 86 new batches upserted (from Excel batch_codes not already in DB)
- 51 stub batches created (with empty `location_ref`, status `CLOSED`) for old rc_out references to batches that pre-date the RC IN data (AUG-22-BLK*, RECOOKED, BLENDING, etc.)
- 9 failed inserts retried successfully after first pass settled
- 6 misaligned batches manually patched to `status='CLOSED'` (see Learning #4 below)

### 3. PCA/PCB warehouse support (commit 81d62f4)

The user's data referenced `PCA-15A`, `PCB-16A`, etc. — prepared-charcoal sundrying sub-zones within the A-row 15-17 area — but the schema rejected them.

- DB CHECK constraints widened: `chk_location_ref_format` on `batches` and `chk_block_loc_format` on `deliveries` now accept `^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$` (migration `20260526000000_widen_block_loc_check_for_pca_pcb.sql`)
- `lib/validation.ts` regex extended; `WAREHOUSE_COLS` lookup added (PCA/PCB restricted to cols 15-17)
- `lib/rc-utils.ts` `calculateWhse()` returns `'PCA'` / `'PCB'` for those prefixes
- Blocking module: `constants.ts` extended with `colStart` field; `WAREHOUSES` adds PCA + PCB (3 cols × 3 rows = 9 slots each = 18 new slots, opt-in chips below the standard 4 warehouses)
- 18 distinct PCA/PCB locations confirmed in user's data (cols 15-17 × rows A-C × {PCA, PCB})

### 4. Flask port plan + AI agent design (committed as part of 8b7e84a)

`FLASK_PORT_PLAN.md` — **heavily revised** after a deeper conversation with the user about the actual operational reality. The architectural pivot:

- **Original plan:** multi-writer offline-capable app with CRDTs/LWW conflict resolution, outbox + tombstones, vector clocks
- **Revised plan:** **single-writer push-only architecture**. Only Renzo writes (from his single local machine). Owners (Joseph etc.) view read-only. No conflicts because there's only one writer.
- Section 8 (Sync) — heavily rewritten. ~80% shorter, ~95% simpler. Just `sync_outbox` and `sync_state` tables, push-only pipeline.
- Section 12 (Open Decisions) — 6 of 10 original decisions resolved (frontend stays React; packaging via pywebview; auth stub via `OWNER_DASHBOARD_PASSWORD`; single-user remote; no conflict UX; 500ms push debounce)
- Section 9b added — brief pointer to AI ingestion agent
- Section 10 (Roadmap) re-phased — AI agent becomes Phase 8; total estimate dropped from 35-45 days to 25-35 days

`AI_INGESTION_AGENT.md` — full design doc for the email-ingestion agent. **451 lines**. Covers per-report-type extractors, the `pending_review` queue, the review UI, Claude API integration, validation rules, cost estimates (~$30/month operational).

### 5. Anthropic API foundation (verified)

- Anthropic SDK installed: `@anthropic-ai/sdk`
- API key in `.env.local` as `ANTHROPIC_API_KEY` (`sk-ant-api03-…`)
- Smoke test at `scripts/test-anthropic.ts` — verified access to:
  - `claude-sonnet-4-6` (default Jarvis brain, 1M context, $3/$15 per M tokens)
  - `claude-opus-4-7` (escalation tier, 1M context, adaptive thinking, $5/$25 per M tokens)
- Both models confirmed: 1M context is **default** on these models (no header/param opt-in)
- Prompt caching syntax accepted; real cache hits will land when Jarvis has its full system prompt (need >4096 tokens on Opus 4.7, >2048 on Sonnet 4.6)
- Total smoke test cost: under $0.01

---

## Critical learnings to internalize

### Learning #1 — The Excel ↔ Supabase mapping is real and authoritative

The user's master Excel files at `/Users/renzosy/Documents/1A WORK FILES/ICTC/` are the **source of truth**. Specifically:
- `MASTER - ICTC INPUT FILE V1.xlsx` — raw daily entry (5,086-row RC IN sheet, 2,240-row RC OUT sheet)
- `MASTER - ICTC SUMMARIES V1.xlsx` — derived rollups

Joseph maintains his own separate Excel files in parallel. **Renzo's files are what we sync to Supabase.** When the user says "verify it matches the master," they mean these Excel files.

The Blackwood schema is essentially a digital port of these sheets. RC IN columns mirror Excel headers exactly. RC OUT same. `view_blocking_grid` mirrors the Blocking sheet. `view_rc_movement` mirrors RC MOVEMENT.

### Learning #2 — Schema drift is severe between local migrations and live Supabase

Per audit findings (now documented in `FLASK_PORT_PLAN.md` §3.4): the live Supabase project has objects that are NOT in `supabase/migrations/`. Specifically `user_dashboard_prefs` (table) and `view_blocking_grid` (view) were created via the Supabase dashboard, not via tracked migrations. Live DB has 44 migrations applied; local has 5 in `supabase/migrations/`.

**Implication for the next session:** before any major Phase 1-type Flask-port schema work, run `supabase db dump --schema-only --linked` to capture the actual live schema and reconcile.

### Learning #3 — `updated_at` is missing on most tables

Per audit findings (`FLASK_PORT_PLAN.md` §3.5): only 3 of 11 tables have `updated_at` (`batches`, `profiles`, `user_table_settings`). The sync engine in the Flask port should NOT rely on existing `updated_at` — it should add a new `last_modified_at` column.

### Learning #4 — The `tr_blackwood_usage` trigger INSERT path has a subtle bug

The trigger that maintains `batches.status` based on `rc_out` events:
- **DELETE/UPDATE paths** look at ALL events for the batch (aggregate logic)
- **INSERT path** only looks at the NEW event (single-event logic)

This is inconsistent. During the historical backfill, when we retried 9 failed rc_out inserts AFTER their CLOSED counterparts had already been inserted (out of chronological order), the trigger's INSERT path saw the non-CLOSED event and downgraded the batch status from CLOSED back to IN-USE/SUNDRYING. We patched 6 batches manually with `UPDATE batches SET status='CLOSED'` to fix this.

**Future work (optional migration):** make the INSERT path aggregate-aware, same as DELETE/UPDATE. The catch: the `FEED` batch (a special long-running bucket) intentionally has a CLOSED event in its middle but keeps being consumed afterward, so aggregate-CLOSED-wins logic would break it. Need a more nuanced "last event by date wins" logic.

### Learning #5 — Always GRANT SELECT on views to anon + authenticated

Discovered when "permission denied for view view_rc_movement" appeared in dev server logs. The view existed and worked when queried via service role, but the user's authenticated session couldn't read it. The existing `view_blocking_grid` has the grants; the new view didn't. **Standard pattern for every new view going forward:**

```sql
GRANT SELECT ON public.view_<name> TO anon, authenticated;
```

### Learning #6 — `user_table_settings` permission error exists (pre-existing)

Dev server logs show `permission denied for table user_table_settings` when saving column-width/density prefs. Not blocking functionality (saves fail silently), but should be fixed. Not addressed this session — flagged as follow-up.

### Learning #7 — The Accounting role's permission helper has a fallthrough

`components/providers/auth-context.tsx:142-165` only explicitly blocks `delete:all` for Accounting, then falls through to `return true` for everything else. The intended scope ("Accounting only sees /inventory/rc-in") is enforced at UI level, NOT in the permission helper. **Implication:** the Flask port API must add explicit `@require_role` decorators on every route, not just permission-helper guards.

### Learning #8 — Joseph's micro-management emails ARE the operational specification

Every day Joseph asks questions via Gmail like "is this the last stockpile for Tag-at?" or "have we finished D-12B feeding?" Each question is a query that should be answerable in Blackwood in 2 clicks. Jarvis being built well means the daily email storm shrinks. **This is why the Movement tab matters and why the AI agent matters — they're the answers to Joseph's questions, computed by the system instead of by his memory.**

### Learning #9 — The 9 daily report types and their senders

| Subject | Sender | Frequency | Destination |
|---|---|---|---|
| Daily Production Report | mccontinedo.ictc@gmail.com | Daily | `production_runs` + `production_downtime` (when modules exist) |
| WASTE PRODUCTION REPORT | edilloivymae306ictc@gmail.com | Daily | `production_waste` (7 streams) |
| RC DELIVERIES | pretchel.jao@yahoo.com / Ivy | Daily when deliveries | `deliveries` (+ `batches` upsert) |
| RC MOVEMENT | edilloivymae306ictc / Pretchel | Daily | `rc_out` |
| FLECON BAGGED | edilloivymae306ictc@gmail.com | Daily | `flecon_bag_movement` (when built) |
| BAGGED POWDER | edilloivymae306ictc / Pretchel | Daily | `flecon_bag_movement` (powder category) |
| Bagged 6x50 (QC) | angelicagustilo26.ictc@gmail.com | Daily | `qc_results` (when built) |
| Prepared Charcoal 3x50 (QC) | angelicagustilo26.ictc@gmail.com | Daily | `qc_results` (when built) |
| Daily Maintenance | ginomichael_go@yahoo.com | Daily | Out of scope v1 (image attachments) |

Gmail label: **`Work/ICTC Daily`** (labelId `Label_11` in Renzo's Gmail).

Out of scope for Jarvis v1: ABSENTEE (HR), banking files from Czarina, maintenance images.

### Learning #10 — Suppliers form a known set with quality patterns

Distinct suppliers in RC IN data: Tag-at, Ornales, Paquibot, Llanto, Lacoto, Sevilla, Layupan, Tanilon, Maranio, Baguio, Ecito, Nazarino, Namoc, Compra, Bagiu/Tipalan, Arbelera/Mercado, Baraquel/Paquibot, etc. (64 distinct supplier strings, with typo variants).

Joseph in his emails notes patterns like "Our ASH is quite high. Try to have Grit Separators or RS 1 checked. If both are ok, then maybe we need to review the RC we are feeding (probably from Ornales at C blocks?)" — this is the kind of supplier-quality-correlation pattern Jarvis should be able to surface from the data.

---

## Current state — what's working, what's broken, what's pending

### ✅ Working
- RC IN module (full CRUD, paste support, audit logs)
- RC OUT module (full CRUD, paste, audit)
- Blocking module (with PCA/PCB opt-in chips)
- RC Movement tab (renders live data after backfill)
- Dashboard with widgets
- Supabase backfill (Excel ↔ Supabase aligned through 2026-05-22)
- Anthropic API access (verified models, smoke test passing)
- Dev server runs on http://localhost:3000

### ⚠️ Known issues (not blocking but worth knowing)
- `user_table_settings` permission denied on save (silent fail — column widths don't persist)
- Trigger INSERT path bug — only affects out-of-order historical replays, not normal flow
- 4 RC IN + 17 RC OUT extras in Supabase that aren't in current Excel (probably old entries deleted from Excel — leave as historical)
- Schema drift between `supabase/migrations/` and live DB (44 vs ~10 local migrations)

### 📦 Uncommitted local artifacts
- `/tmp/blackwood_backfill/` — one-shot Python backfill scripts. **Contains the Supabase service role key inline.** Either sanitize and commit to `scripts/backfill_historical/`, or just leave in /tmp and let them get cleaned up. User was offered both options but didn't pick one before pivoting to the Jarvis discussion.

### 🚧 Not yet started
- **Jarvis multi-agent build** — design complete, foundation ready, user said "go" then interrupted
- Vercel deployment (deferred — iPad accessibility comes later)
- Flask port (deferred indefinitely — current Next.js + AI agent strategy supersedes for now)

---

## Open decisions still pending

These need a user answer before the Jarvis build proceeds:

### 1. First report type to scaffold
User confirmed slide-out chat UI + cross-session memory + `/clear` command + inventory-only scope, but did NOT pick a starting report type. Options:
- **Daily Production Report** (simplest format, highest volume — recommended)
- **RC DELIVERIES** (most critical for inventory accuracy)

Recommended: Daily Production Report — clean tabular format, low ambiguity, gives us a working pipeline end-to-end. Then we expand to the other 8 report types.

### 2. The `/tmp/blackwood_backfill/` scripts
- **(a)** Leave in `/tmp/` — they did their job, gone on next reboot
- **(b)** Sanitize (env-var the service key) + commit to `scripts/backfill_historical/` for future bulk imports

User leaned slightly toward (a) but didn't lock it.

### 3. Trigger INSERT path fix
Optional small migration to make INSERT aggregate-aware like UPDATE/DELETE. User flagged it as "good to know" but didn't ask for the fix.

---

## Architectural decisions locked this session

1. **Frontend approach:** Keep React + Vite (no Jinja/HTMX rewrite). Both for Jarvis chat and for any future Flask port frontend.
2. **Packaging:** Run on Vercel (later) for iPad accessibility. No native app.
3. **Model selection:** Sonnet 4.6 (1M) as default Jarvis brain; Opus 4.7 (1M) as escalation tier; Haiku for routing/classification only if needed later.
4. **Conversation memory:** Cross-session, persisted in Supabase.
5. **Chat UI:** Slide-out panel accessible from every page (not a dedicated route).
6. **Single-writer architecture:** Renzo is sole writer. Owners are read-only. No bidirectional sync ever. No conflict resolution needed.
7. **Auth (when deployed):** Local app = single-user (no auth). Hosted owner dashboard = stub with shared `OWNER_DASHBOARD_PASSWORD` env var, replace with per-user accounts later.
8. **AI ingestion is the high-leverage piece**, not the Flask port. Build it in the current Next.js stack first; revisit Flask only if needed.
9. **Inventory-only scope for Jarvis v1.** Production / accounting / HR are out of scope until those modules exist in the app.
10. **No auto-commit for Jarvis writes in v1.** Every ingestion proposal requires human approval. Auto-commit threshold can be tuned after 30 days of zero corrections per report type.

---

## Next concrete action when picking back up

```
1. Confirm with user: first report type to scaffold (recommend Daily Production Report)
2. Spawn the Jarvis multi-agent build:
   - supabase-backend-engineer (mode: plan)
   - senior-frontend-engineer (mode: plan)
   - One additional agent or self-handled work for the domain/system-prompt scaffold
3. Follow the 7-day phasing in AI_INGESTION_AGENT.md §11
```

The build should follow the file structure laid out in the AI agent design doc + the Anthropic SDK best practices documented in the `claude-api` skill. Specifically:
- Slide-out chat lives at the layout level so it permeates every page
- Server-side Claude API calls (key never reaches browser)
- Stream responses (better UX, and avoids HTTP timeouts on long replies)
- Server actions exist at `app/(app)/jarvis/actions.ts`
- Tool handlers in `lib/jarvis/tool-handlers.ts`
- New tables: `pending_review`, `jarvis_conversations`, `jarvis_messages`, `jarvis_learnings`

---

## Project file references

**Active and current:**
- `/Users/renzosy/blackwood/CLAUDE.md` — operating norms for Claude (project conventions)
- `/Users/renzosy/blackwood/TIMELINE.md` — recent completions, sprint focus
- `/Users/renzosy/blackwood/FLASK_PORT_PLAN.md` — full Flask port architectural plan (pivoted to single-writer; ~30% shorter than original)
- `/Users/renzosy/blackwood/AI_INGESTION_AGENT.md` — Jarvis agent design doc (451 lines, full per-report-type extractor patterns)
- `/Users/renzosy/blackwood/scripts/test-anthropic.ts` — re-runnable smoke test ("is my Anthropic setup still working?")

**Auto-updated each session:**
- `/Users/renzosy/blackwood/handoffs/` — this directory. Latest file = most recent context.

**Per-module CONTEXT.md files (read before exploring a module):**
- `app/(app)/CONTEXT.md` — Dashboard
- `app/(app)/inventory/CONTEXT.md` — Inventory tab container (NEW this session)
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT
- `app/(app)/inventory/blocking/CONTEXT.md` — Blocking (updated for PCA/PCB)
- `app/(app)/inventory/rc-movement/CONTEXT.md` — RC Movement (NEW this session)
- `app/(app)/admin/CONTEXT.md` — Admin
- `components/widgets/CONTEXT.md` — Widget system
- `components/NAVBAR.md` — Navbar
- `components/providers/AUTH.md` — Auth provider
- `components/NOTIFICATIONS.md` — Notification bell

**Git state at handoff:**
- Branch: `dev`
- Unpushed commits: 4 ahead of `origin/dev`
- Working tree: clean (all changes committed)
- Most recent commits this session:
  - `8b7e84a` — RC Movement feature shipped + Flask plan pivot + AI agent design
  - `81d62f4` — PCA/PCB warehouse zones (schema + UI)
  - One more for the `% LOSS` color logic fix (smaller commit)

**Not yet committed but should be tracked:**
- The Anthropic API smoke test (`scripts/test-anthropic.ts`) is uncommitted.
- New migration `20260526010000_grant_view_rc_movement_select.sql` may also be uncommitted depending on what happened.
- This handoff file.

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

*End of handoff — 2026-05-26 — RC Movement, Backfill, Jarvis Foundation*
