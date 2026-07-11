# Handoff — 2026-07-11 · Sync = multi-source reconciliation (L-037 killed) + full flag visibility

_Prior: `handoffs/2026-07-07-smart-adjudicator-built.md` (the adjudicator P1–P6 + run triage). This session (spanning ~07-07 → 07-11) turned the adjudicator into a full **multi-source reconciliation** sync, fixed a real production data bug, retired the "Sheet-wins" clobber, added a block-balance cross-check, and — the capstone — fixed the "black box" visibility problem so the panel shows EVERY flag with the detail needed to act. 20 commits, all on `dev`, everything green._

## TL;DR

1. **The June data bug was real and is corrected.** A duplicate/over-statement over-stated rc_out by 32,195 kg on June 10 & 12 (L-037). Root cause (audit-verified): **gsheet-sync's "Sheet-wins" silently overwrote a correct proposed-report feeding** with the Google Sheet's cross-block cumulative. The 4 rows were hand-corrected (both days now reconcile to the movement sheet exactly).
2. **"Sheet-wins" is retired (R4b) — the clobber is now structurally impossible**, proven by test. gsheet no longer writes rc_out; the proposed report is the sole rc_out writer; disagreements surface as cases. Flag-gated + reversible (`SYNC_RCOUT_RECONCILE_CUTOVER`, default ON).
3. **The sync is now a multi-source reconciliation model** (`SYNC_RECONCILIATION_MODEL.md`): no source is authoritative; agreements auto-write, disagreements → human-arbitrated `source_diff` cases with a pick UI. Built R1 (engine) → R2 (shadow) → R3 (pick UI) → R4a (prereqs) → R4b (cutover).
4. **Block-balance cross-check (RB)** — reads the Sheet's Blocking tab (never read before) vs the computed `view_blocking_grid`, two-level (per-block + grand total) → `block_diff` cases. The one net anchored outside the transaction data.
5. **Visibility overhaul (the capstone)** — the panel used to show 1 of ~10 flags (it only read `apply.held`, ignoring the whole reconciliation/block layer). Now it shows ALL findings with source + data + location + reason, plus a **"Copy all for Claude"** button that dumps a diagnosis-ready summary to paste here.
6. **Validity ruleset** (`SYNC_VALIDITY_RULESET.md`) — Renzo's decisions locked (gate hard only on inventory-math corruption; negative balance & lab values = don't-hold).

## What shipped (commits, newest first)

- `d7dafa6` copy-all-flags button (diagnosis-ready run summary for Claude)
- `9dbf51d` **surface ALL run findings in the panel** + full case detail + create-batch resolution (the visibility fix)
- `8b1e01f` auto-clear intra-run batch-creation-race holds + name batch code in unmapped alerts
- `b755fcc` **block-balance cross-check (RB)** — Sheet Blocking tab vs computed grid
- `d5b2eca` **retire gsheet Sheet-wins for rc_out — reversible cutover (R4b, kills L-037 clobber)**
- `229d9eb` R4a reconciliation prereqs — batch_id alignment, FEED keying, pending/held cases
- `1d0ca7d` / `e9ff033` validity ruleset + reconciliation-model refinements
- `c2c5bf9` **pick-a-source resolution for source_diff cases (R3)**
- `a01774c` escape raw control-byte key delimiters (text-diffable)
- `d8bbc21` **rc_out reconciliation engine + shadow-wired source_diff cases (R1+R2)**
- `ca37d5b` multi-source reconciliation model + L-037 root-cause correction + rc_out source-consistency guard
- `f891bc6` render sheet dates timezone-proof + L-035/L-036 ledger + **agent-def hardening**
- `4ccd9ae` **run triage layer** — root-cause clustering, run chat, group dismiss
- `7f0dddb` stop rc_out false-flagging settled month-boundary feedings (**L-034**)
- `449ceba` heal dangling submit_verdict tool_use so case chat stops 400ing
- `3fcd746` navbar "Sync Review" link
- `014fff4` **smart held-row adjudicator with investigator loop + case review** (P1–P6, from the prior session's plan)

## The system now, one paragraph

A daily sync fetches every source (Google Sheet RC IN/OUT/Blocking, proposed report, movement sheet, delivery emails, Czarina pricing, production/flecon emails). Each is extracted exactly + self-consistency-checked. **Reconciliation** (RC IN/OUT/Blocking — the reports with a Sheet tab) compares sources: agreements auto-write, disagreements/overdue/unresolved/block-mismatches become **cases** in Sync Review (`/sync/cases`) — each auto-investigated by a read-only Claude agent that cites a verdict, clustered by root cause (run triage), and resolvable by the human (pick a source / dismiss / edit / create-batch), confirm-gated with full audit + a known-issues ledger. Production/flecon are single-source → auto-write if they pass `SYNC_VALIDITY_RULESET.md`. Every run ends CLEAN or DIFFS-PENDING — never a silent overwrite.

## CRITICAL — do this to activate it all

**Restart the app AND the worker** — most of this session's changes are live only after a restart:
- **Worker** (`cd workers/sync && npm run dev`, or the Fly deploy) — activates the **R4b cutover** (gsheet stops writing rc_out → the clobber dies) and all the reconciliation/block-balance stages. Cutover is default-ON; set `SYNC_RCOUT_RECONCILE_CUTOVER=off` only to revert.
- **Next app** (`env -u ANTHROPIC_API_KEY npm run dev`) — activates the new panel visibility + Sync Review detail + the copy-all button + create-batch resolution.
- **After restart the "don't run gsheet-sync" hold is LIFTED** — the clobber is structurally impossible.

## Open questions / things needing Renzo's eye

1. **The block-balance findings need validation (first real run).** The 07-09 run's block-balance check flagged the **total inventory off by 18,598 kg** (Sheet 10,311,693 vs computed 10,330,291), with A-7C off 21,333 kg, D-19B off 3,000 (== the unrecorded FEED1 feeding), C-12A in app not on Sheet. RB is brand-new — these are its first real output and could be genuine discrepancies OR teething in the new extractor. **Use the "Copy all for Claude" button and paste here to diagnose.**
2. **FEED batches recur as `unmapped_batch_code`.** `JULY-26-FEED1` (and monthly successors) reference a batch nothing creates → flagged every run. The **"Create this batch"** button (new) resolves it in one confirm. Renzo could alternatively opt into auto-creating feed batches (currently NOT done — never-auto-create is a hard rule).
3. **The ⚠️ validity rules are resolved**, but the "too strict / too loose" review stays organic — flag any rule that wrongly holds/waves-through on a real run.
4. **Deferred: the Fly deploy** (`workers/sync/RUNBOOK.md`, ~15 min) — gets the worker off the laptop. Independent of everything above.

## Critical learnings (highest value)

- **No source is truth — the L-037 lesson.** "Sheet-wins" silently crowned one fallible witness and overwrote correct data. The whole reconciliation model exists to make disagreements *visible and human-arbitrated* instead of auto-resolved. Canonical in `CLAUDE.md` → "Sync Integrity".
- **The window trap (R4b's load-bearing design):** the Sheet carries ALL history but the proposed report carries ~1 day, so single-witness = the norm. Auto-applying single-witness Sheet values = Sheet-wins reborn. Reconciliation only acts on the proposed-extract's date span; older Sheet-only data is *settled and untouched*; a lone recent witness *pends* (self-clears next run).
- **Two nets catch what one misses:** reconciliation (receipts match each other) + block-balance (the till balances) caught L-037 from different angles (D-19B Δ == the exact unrecorded feed). Both worth having.
- **Visibility IS the product.** Renzo: "if I can't see what's flagged with detail, I'm trusting a black box." The panel silently showed 1 of ~10 — the single most important fix of the session was making all findings visible with source/data/location/why.
- **Agent-def hardening (subagent discipline):** git-branch-guardian was rewritten (Haiku→Sonnet, operator persona, `tools:` stripped of Agent so it can't spawn/stall) after it repeatedly narrated-instead-of-working; the two engineers got an executor rule. **Always disk-verify a subagent's completion report** (`git status`, re-run gates) — memory `[[subagent-verify-disk]]`.
- **Raw control bytes in `.ts` (delimiter trap) make git see binary** — bit us twice; escape as `\uXXXX`, grep `[\x00-\x08\x0E-\x1F]` before commit.
- **New L-rules:** L-034 (month-boundary compare-window + label variance), L-035 (investigator date-shift bug + two-tab month split), L-036 (compare-window is rc_out-only), L-037 (gsheet Sheet-wins overwrote a correct value — the whole model's motivation).

## Current state

- **All green:** worker vitest 374, parity 12/12, 12 root verify scripts, root tsc + build clean. 20 commits pushed to `dev`. Nothing uncommitted except the standing machine-local `agent-memory-local` file.
- **June data corrected + reconciles**; the stale JULY-26-BLK4 race case dismissed with an audit note.
- **New DB objects this session:** migrations for `sync_case_rulings` action values (`pick_source`, `create_batch`), the case tables were from the prior session. Reconciliation writes NOTHING new to inventory tables (shadow/read-only except the R4b write-path *subtraction*).

## Next concrete action

1. **Restart worker + app** (above) to activate everything.
2. **Run a sync, hit "Copy all for Claude," paste here** — diagnose the block-balance 18,598 kg question + triage the ~9–15 flags.
3. Resolve FEED1 via "Create this batch."
4. Optional next builds (all specced in `SYNC_RECONCILIATION_MODEL.md` phasing): **RC-IN** reconciliation (deliveries), **RS** single-source rulesets (production/flecon auto-write gate), **R-EXPLAIN** (Haiku/Sonnet explainer for ambiguous diffs), **R5** trust phase (auto-apply proven-identical rulings). Then the **Fly deploy**.

## Key files

- **Docs:** `SYNC_RECONCILIATION_MODEL.md` (the model + phasing + R4b window policy), `SYNC_VALIDITY_RULESET.md` (per-report rules + Renzo's decisions), `CLAUDE.md` → "Sync Integrity", `.claude/skills/sync-ictc/LEARNING_LEDGER.md` (L-034…L-037).
- **Reconciliation engine:** `workers/sync/src/reconcile/` (rcOut, rcOutStage, blockBalance, blocking extractor, types, CONTEXT.md), `workers/sync/src/workflows/{runSync,creationRaceHolds}.ts`, `workers/sync/src/reports/gsheet/{apply,blocking}.ts` (cutover + Blocking tab), `workers/sync/src/lib/env.ts` (the cutover flag).
- **App:** `lib/sync/{findings,create-batch-plan,fingerprint,cases-fold}.ts`, `app/(app)/sync/{cases,resolve,case-chat,diff-plan}.ts`, `components/sync/` (HeldRows = the findings panel) + `components/sync/cases/` (CaseDetail, FindingDetailCards, CreateBatchCard, SourceDiffCard).
- **Verify:** `scripts/verify-{findings,create-batch,source-diff-fold,block-diff-fold,resolve-diff,…}.ts`; worker `npm test` + `npm run parity`.
