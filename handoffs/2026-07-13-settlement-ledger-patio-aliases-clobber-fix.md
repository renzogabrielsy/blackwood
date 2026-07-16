# Handoff — 2026-07-13 · Settlement ledger, patio aliases, and the natural-key clobber

_Prior: `handoffs/2026-07-11-sync-reconciliation-and-visibility.md`. This session took the reconciliation sync from "surfaces 61 flags every run" to a healthy steady state, by fixing the **re-ingestion loop** (a date-settlement ledger) and a chain of real data-integrity bugs it exposed. **15 commits (`840d609` → `35ffafd`), all on `dev`**, everything green (worker vitest 463, parity 12/12, tsc + build clean). The single most important operational fact is at the bottom of the TL;DR._

## TL;DR

1. The daily sync kept re-litigating already-balanced past months because the PROPOSED workbook permanently carries every day-tab ever filled. Built a **date-settlement ledger** (`rc_out_date_settlements`): once a day's DB feeding total matches the RC MOVEMENT daily total (two independent witnesses, ±50 kg), that date is SETTLED and every future run skips it entirely. This collapsed a recurring 57-flag May swarm down to ~6–9 genuinely-open findings.
2. That work exposed and we fixed: a **settlement insert bug** (wrote nothing while logging success), a **pipeline-ordering lag** (settled too late to help same-run), a **"FOR FEEDING" extractor bug**, an over-literal **close-remark** trigger, a **FEED-batch constraint** bug, and — the deepest — a **natural-key clobber** silently corrupting a real feeding every run.
3. Also shipped this session: **batch auto-create** (policy reversal), **date-scoped gate quarantine**, the **attribution matcher** (`attribution_diff`), **deterministic-only Sync Review** (killed a ~40-API-call-per-run credit bleed), and **patio block-name aliases**.
4. **Three DB hand-corrections** applied (all movement-confirmed, audited): see "DB hand-corrections" below.
5. **⚠️ NEXT CONCRETE ACTION: restart BOTH the worker (latest `dev`) AND the Next.js app to activate everything.** Everything is committed (through `35ffafd`); the running processes are a build behind. See "The build/restart gotcha" — it cost two runs today. Worker: `cd workers/sync && git pull && npm run build && npm run dev` (fully stop the old process first — its next boot now prints `[blackwood-sync] build <sha> …` so you can confirm the code is live). App: restart `npm run dev` for the footer fix.

## What shipped (commits, newest first — all on `dev`)

- `35ffafd` **chore: worker startup build-SHA banner + gitignore machine-local memory** (`workers/sync/{esbuild.config.mjs,src/index.ts,README.md}`, `.gitignore`) — worker logs `[blackwood-sync] build <sha> · <mode> · started <time>` on boot (guards the stale-build gotcha); `workers/sync/.claude/` no longer swept into `git add .`.
- `8405dde` **docs(handoff): this file + TIMELINE.md**
- `1c7f411` **fix: Daily Sync footer review-count matches the rendered findings** (`lib/sync/local-summary.ts` now takes `findingsCount`; `components/sync/useSyncRun.ts` passes `flattenRunFindings(result).length`). The footer counted per-report classify `flagged`+`held` — including informational gsheet/rc_movement flags with no detail row — so it promised "N items need your review — see the findings below" while the panel rendered 0. **App-side — needs a Next.js restart to activate.**
- `bed6269` **fix: stop proposed from writing patio feedings — kills the natural-key clobber** (`workers/sync/src/reports/rc_out/index.ts` `runReport`)
- `806c346` **feat: patio block-name aliases** (`workers/sync/src/reconcile/blockAliases.ts` — new; applied in `rcOutStage.ts` `bucketProposed`)
- `85ba6ba` **fix: settle balanced dates BEFORE the writers** (moved `persistSettlements` to Stage 1b in `runSync.ts`)
- `f13b1c8` **fix: settlement ledger never persisted** (`insertSettlements` selected a non-existent `id` column — `lib/db.ts`)
- `16e3c84` **feat: date-settlement ledger** (`supabase/migrations/20260712010000_rc_out_date_settlements.sql`, `workers/sync/src/workflows/settlement.ts` — new, `persistSettlements` in `runSync.ts`, `db.readSettledDates`/`insertSettlements`, skip chokepoints in `reports/rc_out/index.ts` + `runSync.ts::reconcileRcOutShadow`)
- `fb4a60d` **feat: Sync Review is deterministic-only — dormant AI layer behind one flag** (`lib/sync/config.ts` `SYNC_AI_REVIEW_ENABLED=false`, `lib/sync/local-summary.ts`, gated all AI triggers in `useSyncRun.ts`/`cases.ts`/`actions.ts`, hid AI UI in `components/sync/cases/`, enriched `FindingDetailCards.tsx`, per-case `serializeCaseForClaude` + "Copy for Claude" button)
- `804c6dd` **fix: create-batch location_ref must satisfy chk_location_ref_format** (`lib/sync/create-batch-plan.ts`, `workers/sync/src/lib/batchAutoCreate.ts` — both copies: block if valid code, else `''`)
- `6b5cfbd` **fix(db): broaden close-remark detection — `fn_is_close_remark()`** (`supabase/migrations/20260711033000_*.sql` + `scripts/backfill_close_remark_batches_2026-07-11.sql`)
- `2f2e37c` **fix: feed-section detection — "FOR FEEDING" WHSE labels** (`workers/sync/src/reports/rc_out/extract.ts` + the Python oracle `extract_proposed_daily.py`, lockstep)
- `5cfd40f` **feat: attribution_diff matcher** (`workers/sync/src/reconcile/rcOut.ts` `matchAttributions` + app fold/fingerprint/detail-card)
- `7263795` **fix: date-scoped gate quarantine** (`reports/rc_out/{index,apply}.ts` — per-date holds replace run-wide HALT; witness-corroboration downgrade)
- `840d609` **feat: auto-create pattern-valid batches** (`workers/sync/src/lib/batchAutoCreate.ts` — reverses never-auto-create for canonical `MONTH-YY-KIND#` codes)

## Critical learnings (highest value)

- **The build/restart gotcha (cost 2 runs).** The worker's `start` runs compiled `dist/index.js`; `npm run dev` runs source via `tsx watch`. All worker fixes are TS in `workers/sync/src/` — **they only take effect after a full process restart (and a rebuild if launched from `dist`)**. A stale July-8 `dist` silently masked every fix; the tell was `rc_out_date_settlements` staying empty + zero settlement events in `sync_run_events`. **Always confirm a fix is actually running** (check the ledger row count / run-event log) before diagnosing "why didn't it work." A startup commit-SHA banner is the obvious guard (deferred — see Open decisions).
- **Settlement = two-witness agreement, and it's a one-way ratchet.** A date settles only when DB has rows for it AND movement has a total for it AND they agree within 50 kg — all three required (silence is never agreement; never skip a genuinely-missing day). Once settled, nothing re-checks it (that's the point — stop re-litigating). A later manual correction to a settled date needs `DELETE FROM rc_out_date_settlements WHERE transaction_date='…'` to re-open. Settlement must run BEFORE the writers (Stage 1b), else the write-path skip lags one run.
- **The settlement insert bug was invisible because tests mocked the DB.** `insertSettlements` → `insertIfAbsent` → `selectOne(table, filters, "id")` hardcodes an `id` column; the ledger's PK is `transaction_date`, so PostgREST 400'd, the error was swallowed, and the log printed the *computed* count not the *written* one. Lesson: a "best-effort/non-fatal" write that logs its intended count can lie for weeks. Regression test now mocks the raw supabase builder so the real insert body runs.
- **The natural-key clobber (deepest bug).** `rc_out`'s natural key is `(transaction_date, batch_id, destination)` — **no block**. PROPOSED mis-derives a BLK batch code for sun-drying patio feedings (block_no collision), so a phantom patio row shares the key with a real unrelated feeding and **each run overwrites the other** (audit showed row `0238c58d` flip-flopping 6× between `JAN-26-BLK17 @ A-11B 7045` real and `@ 15A MIDDLE SIDE 7494` patio-dup). This also kept 2026-05-11 from settling (day total oscillated ±449). Fix: proposed no longer writes patio-aliased rows (they're Sheet-owned SUNDRY batches proposed can't attribute; adding block to the key would double-count the dup instead).
- **No source is truth — the movement sheet broke a tie the operator got backwards.** Renzo said "gsheet is correct" for the 05-11 3,692/3,962 pair. Movement (the independent third witness) fed **32,146 kg** that day = DB only with **3,692** — so PROPOSED's 3,692 was right and the SHEET's 3,962 was the transposition. Right about the block *label* (PCA-16A), wrong about the *weight*. Always confirm against movement before committing a value.
- **Patio blocks are a systemic proposed weakness.** PROPOSED names patio spots descriptively ("16A NEAR WALL") and derives BLK codes; the Sheet uses coded PCA/PCB refs and correct SUNDRY batches. The alias table (`blockAliases.ts`, 8 rows, 7 derived from attribution pairs + 1 Renzo-confirmed) now (a) aligns block names for reconciliation matching AND (b) gates proposed's patio rows off the write path. It's the single source of truth — extend it there. Mapping is irregular (NEAR WALL/HALF OF MIDDLE/MIDDLE SIDE→A/B/C, not a clean rule), so it's an explicit table, not a formula.
- **Sync Review AI was a silent ~40-API-call/run bleed.** The auto-investigator (up to 9 calls/case) + unconditional triage + narration all fired automatically on every run with findings. The blunt template text Renzo saw was already deterministic and free; only the "Investigated" verdict card cost money. Now behind one `SYNC_AI_REVIEW_ENABLED=false` flag; AI diagnosis moved to a per-case "Copy for Claude" markdown button paste-into-chat flow.
- **"DONE" = block CLOSED (Renzo-confirmed emphatically), and an empty IN-USE digest band is EXPECTED between campaigns — NOT a regression.** The home page's top "Open Blocks" band = `view_blocking_grid WHERE status='IN-USE'` (`lib/digest/queries.ts:267-273`). This session's "DONE" closes emptied it (all 4 fed-this-month blocks — A-5B/A-7C/C-12B/D-7B — correctly closed); it repopulates when the next feedings (to new blocks) arrive by email. The 52 "IN-USE" batches are stale 2024 junk (negative balances, no `location_ref`) — they never showed on the home page. If a future session sees an empty in-use band, do NOT assume a bug.
- **The blunt-summary review count MUST equal the rendered-findings count.** `localSyncSummary` counted per-report classify `flagged`+`held`, but the panel renders `flattenRunFindings` (apply-held rows + reconciliation categories only). Classify flags with no renderable detail (informational gsheet flag, rc_movement "1 minor difference" drift) inflated the footer → "N items — see the findings below" over an empty list (confirmed on run b142814b). Fixed to key the review line off the actual rendered count.

## DB hand-corrections applied this session (all audited via `write_ingestion_audit`)

1. **JULY-26-FEED1 created + 2 feedings re-attributed** off JULY-26-BLK1 → restored BLK1 to STORED @ 66,350 (D-19B); root-caused the "FOR FEEDING" extractor bug (`2f2e37c`).
2. **AUG-25-BLK2 closed** (C-12B, 265 kg remnant) — plant marked "DONE FEEDING" on a not-yet-received tab; the `fn_is_close_remark` migration (`6b5cfbd`) broadens future detection.
3. **05-11 two corrections** (movement-confirmed 32,146): `JAN-26-SUNDRY6` 3,962→3,692 (transposition), `JAN-26-BLK17` restored to 7,045 @ A-11B (undo the clobber). The patio write-skip (`bed6269`) prevents recurrence.

## Current state

- **All green:** worker vitest 463, parity 12/12, root+worker tsc clean, `npm run build` clean. 12 commits pushed to `dev`. Only untracked item is `workers/sync/.claude/` (machine-local agent memory — NOT gitignored; see Open decisions).
- **Live DB:** `rc_out_date_settlements` migration applied; table had 92 rows at last check (settlement working after the `f13b1c8`+`85ba6ba` fixes). `fn_is_close_remark` migration applied.
- **Pending activation:** the running worker is a build behind — restart required (see TL;DR #5).
- **Last observed clean run (23d8bd09, pre-clobber-fix):** 10 findings = 6 block-close-lag + the 05-11 items (now hand-corrected). Expected after restart: ~6 (just the block flags).

## Open decisions / deferred

- **C-11A** (block flag): **investigated — it's Sheet-lag, NOT a double-count.** JULY-26-BLK6 has 3 genuine truckloads (07-09 MAV 9202 22,875 + 07-10 CBN 2192 10,065 + 07-10 CBQ 5957 16,580 = 49,520); the Sheet's blocking tab shows only the first (22,875). App is correct; the Sheet trails 2 recent deliveries. Self-resolves when the Sheet updates. (The earlier "double-count" hypothesis was wrong — no duplicate exists.)
- **A-7C / CBQ-5957** (Case 2, parked): app counts a Feb-4 21,333 kg delivery (truck CBQ 5957, ASH-deduction remark) the Sheet's blocking tab doesn't. Needs Renzo to check the Sheet's RC IN tab, early Feb — is it re-attributed or dropped?
- **Block-close-lag (A-5B/A-7C/C-12B/D-7B):** the plant closed these ("DONE" 07-11), app followed correctly, Sheet's blocking tab hasn't caught up. Self-resolves when the Sheet updates — informational.
- **Cleanup pass — DONE (`35ffafd`):** (a) worker **startup commit-SHA banner** (prints the build SHA so a stale build is obvious); (b) **gitignored `workers/sync/.claude/`**; (c) this handoff.
- **Forward gap:** under R4b, PROPOSED is the sole rc_out writer but now skips patio rows, and gsheet doesn't write rc_out — so a genuinely-NEW patio feeding (if sun-drying season returns) has no writer. Currently fine (patio is historical April/May, all dups). Flag if new patio feedings appear.

## Next concrete action

**Restart BOTH the worker (latest `dev`) AND the Next.js app, then run one sync.** Confirm: `rc_out_date_settlements` holds, the run logs "Auto-matched N patio feedings" + "Skipped N patio feedings," the footer's review count matches the rendered findings list (the app-side fix above), and the flag count sits at ~6 (all block-close-lag — verified benign, incl. C-11A). The **only genuine open reconciliation item is A-7C / Case 2** (the CBQ-5957 Feb delivery the Sheet never counted — Renzo to check the Sheet's RC IN tab, early Feb). The cleanup pass (SHA banner + gitignore) is **DONE** (`35ffafd`).

## Git state

- Branch `dev`, tree **fully clean** (`workers/sync/.claude/` now gitignored — nothing untracked). All work committed + pushed.
- Session commits: `840d609` → `35ffafd` (15 commits). Prior handoff tip was `b77846d`.
