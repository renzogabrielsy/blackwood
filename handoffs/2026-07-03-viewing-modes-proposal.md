# Viewing & Manipulation Modes — Proposal (Phase 5 of the Code Audit)

_2026-07-03. Proposals only — nothing here is built. This is the audit's Phase 5 deliverable: ideas for more efficient ways to VIEW and MANIPULATE already-ingested data. Hard constraint honored throughout: operators' real-world recording (their Excel sheets and emails) does not change at all._

_Honesty note: the original audit's dedicated "viewing-modes" agent never ran (session limit). These proposals are synthesized from the four completed codebase maps + what I learned executing Phases 0–4. Treat as a menu to react to, not findings._

## 1. One spreadsheet engine for the three matrices (the deferred DUP-3)

**What:** RC Movement, Flecon Bags, and Cenapro Production each have their own hand-built frozen-pane matrix (~1,000–1,800 lines each). Build one shared `<FrozenMatrix>` in `components/shared/` and make all three thin configurations of it.

**Why you'd care:** today, a feature added to one grid (say, keyboard navigation or copy-out) doesn't exist in the others. One engine = every grid improvement lands everywhere at once, and new matrix-style modules (a future QC grid, a sundry grid) become days not weeks.

**Cost/risk:** the one big-ticket item (multi-session). Your three most complex screens get re-plumbed — needs its own session with careful visual verification per screen. **Recommended: yes, but as its own dedicated effort.**

## 2. History-aware loading, decided by you (PERF-1 leftover)

**What:** the RC OUT tab still downloads every usage row ever recorded on first open, because its Year filter derives its options from the full dataset. At today's ~2k rows that's fine; at 20k it won't be.

**Proposal:** a tiny SQL view returns just the list of years that exist (cheap), the Year filter reads that, and row data loads per selected year on demand. First paint shows exactly what it shows today — the only change is old years load when clicked instead of up front.

**Cost/risk:** small. The audit deliberately did NOT do this without your sign-off because it changes *when* data arrives. **Needs your yes/no.**

## 3. Uniform drill-down from the home digest

**What:** the digest is a briefing page; some bands deep-link into their source module, some don't. Make it a rule: every number on the digest is clickable and lands you on the module filtered to that exact thing (date, block, batch, bag type).

**Examples:** click a flow-chart day → `/inventory?tab=usage&date=…`; click an open block card → already works (blocking `?block=`); click a bag-type balance → `/inventory/flecon-bags` scrolled/highlighted to that column; click a sync-activity row → the audit-log discussion page (already works via the bell — reuse it).

**Cost/risk:** low, incremental — one band at a time. High daily-use payoff.

## 4. Graduate demo4 out of `/price-demos` (analytics housekeeping)

**What:** the permanent `/summaries` module imports its data layer and main client from `app/(app)/price-demos/demo4/` — a demo folder that also still ships three static mock demos to production. Move demo4's actions + client into `summaries/`, retire demos 1–3 behind a flag or delete them.

**Why:** it's confusing (a real feature living in a folder named "demos"), and the navbar advertises demo pages of fake data to real users.

**Cost/risk:** low — file moves + import updates. `summaries/CONTEXT.md` already flags this as intended cleanup.

## 5. Saved views for the Industrial Spreadsheet tables (bigger idea)

**What:** operators repeat the same filter/sort/column dance daily (e.g. "this month, supplier X, hide lab columns"). Let each user save named view presets per table — stored in the existing `user_table_settings` table (which Phase 2's PURITY-1 refactor conveniently just generalized to be table-id-keyed).

**Why:** the single biggest day-to-day "manipulation efficiency" win available without touching data entry at all.

**Cost/risk:** medium. Builds directly on infrastructure that now exists; purely additive UI.

## Suggested order if you want them
Quick wins first: **#4** (housekeeping) → **#2** (with your sign-off) → **#3** (band by band) → **#5** → **#1** (own dedicated session, the big one).
