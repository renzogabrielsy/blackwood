# 2026-07-20 — Production launch (Vercel + Fly), full mobile/PWA, perf overhaul, block-close cross-check

> Prior handoff: `handoffs/2026-07-15-digest-daystatus-prodsched-sync-fixes-mobile.md`.
> This session took the app from "runs on Renzo's laptop" to **live in production** and
> made it a real installable mobile app, then fixed a wave of on-device + perf + data issues.

## TL;DR

- **Blackwood is now LIVE in production.** Web app on **Vercel → `https://blackwood-ictc.vercel.app`** (production branch = `main`); sync worker on **Fly → `blackwood-sync.fly.dev`** (always-on machine in Tokyo/`nrt`). The laptop is no longer in the sync loop.
- **The whole mobile/PWA effort shipped** — an 11-unit audit (`docs/MOBILE_UI_AUDIT.md`) then a 6-phase additive implementation (installable PWA, Archetype-C card lists, Archetype-E matrix summaries, safe-area/edge-to-edge, landscape). All on branch **`feat/mobile-pwa`**, merged `feat/mobile-pwa → dev → main`.
- **A running bug ledger now exists** at `docs/BUG_LEDGER.md` (BUG-001…011). Most are FIXED; the live ones needing attention are **BUG-007** (safe-area gaps in portalled UI), **BUG-009** (a digest view recomputed 10+×/load), **BUG-010** (hygiene: middleware→proxy, types drift, double `getUser`), and **BUG-011 Phase 2** (the closure reconciliation cross-check — vision, not yet built).
- **Block closure now cross-checks the gsheet** (BUG-011 Phase 1): a "CLOSED" in the Sheet's RC_OUT tab now closes the batch. Proven end-to-end — **C-12A closed correctly** on the 2026-07-20 06:20 sync.
- **NEXT CONCRETE ACTION:** an **on-device verification pass on a real iPhone + iPad mini**. Everything mobile/landscape/safe-area was verified *statically only* (tsc/lint/build) — `env(safe-area-inset-*)` is 0 in desktop browsers and standalone-PWA chrome doesn't exist there, so the tooling literally cannot see this class of bug. That gap produced two real bugs this session (status-bar collision, landscape pillarboxing) that only Renzo's screenshots caught.

## What shipped

### Infrastructure / deploy (the big one)
- **Vercel** — web app deployed; production branch `main`; canonical URL `blackwood-ictc.vercel.app`. Env vars set in Vercel dashboard (NEXT_PUBLIC_SUPABASE_*, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SYNC_WORKER_URL=`https://blackwood-sync.fly.dev`, SYNC_KICK_SECRET=matches the worker).
- **`vercel.json`** (NEW) — `"regions": ["hnd1"]`. Pins serverless functions to Tokyo, the **same AWS region as Supabase** (`ap-northeast-1`). Default was `iad1` (Washington DC) → every DB round-trip crossed the Pacific. This is the single biggest latency fix.
- **Fly worker** — `workers/sync/` deployed to app `blackwood-sync` (region `nrt`, always-on `min_machines_running=1`). Dockerfile bumped **Node 20 → 22** (Supabase realtime-js needs native WebSocket; crash-looped on 20). Runbook at `workers/sync/DEPLOY.md`. Secrets set via `fly secrets` (GMAIL_*, SUPABASE_*, DBOS_DATABASE_URL=session-pooler:5432, SYNC_KICK_SECRET).
- **Auth wiring** — Supabase Auth URL Configuration must include `https://blackwood-ictc.vercel.app` (Site URL + Redirect `/**`). Google login works via the existing cookie-based PKCE flow.

### Mobile / PWA (branch `feat/mobile-pwa`, ALL additive — desktop untouched)
- **Audit** — `docs/MOBILE_UI_AUDIT.md` (11 audit units + the "never crush, always scroll" rule + archetype map); per-feature prompts in `.agents/prompts/mobile-audit-00..10.md`.
- **PWA shell** — `app/manifest.ts`, `app/icon.tsx`, `app/apple-icon.tsx` (generated B-monogram via next/og), `app/layout.tsx` (`viewport-fit=cover` + `appleWebApp` `black-translucent` + themeColor). **`middleware.ts`** — added `/manifest.webmanifest`, `/icon`, `/apple-icon` to PUBLIC_PATHS (were 307→/login, breaking install).
- **Archetype C (dense read tables → card lists)** — the reusable primitive `components/shared/mobile/mobile-card-list.tsx` (+ its CONTEXT.md); applied to RC IN/OUT (`.../rc-in/components/delivery-cards-mobile.tsx`, `.../rc-out/components/rc-out-cards-mobile.tsx`), production daily/electricity + schedule (`components/digest/schedule-row-card.tsx`, generalized from the digest preview), cenapro ledger, summaries (period + supplier), review-queue classified rows.
- **Archetype E (frozen-pane matrices → phone summaries)** — RC Movement, Flecon, Trucks, Cenapro daily block each get a `sm:hidden` KPI-strip + stacked-list summary; full matrix stays `hidden sm:block`.
- **Sync bottom sheet** — `components/sync/SyncLauncher.tsx` renders a bottom `Sheet` below `sm` / the `Dialog` at `sm+`, one shared `useSyncRun` gated by `hooks/use-media-query.ts` (NEW).
- **Navbar** — `components/navbar.tsx` gained a `sm:hidden` hamburger `Sheet` (reuses the module arrays); breadcrumb refactored into an ordered registry keyed on pathname **+ query params** (needed for `/?view=schedule`).
- **Edge-to-edge safe-area architecture** — `app/globals.css` defines UNLAYERED `.safe-t/.safe-b/.safe-l/.safe-r/.safe-x` utilities (unlayered so a caller's `p-0` can't tw-merge them away); applied ONLY in shell/primitives: `navbar.tsx`, `app-shell.tsx`, `components/ui/sheet.tsx`, `components/ui/dialog.tsx`, `components/floating-status-bar.tsx`, `_shared/blocking-detail-panel.tsx`. Six redundant caller-level safe-area bottom paddings removed (the old inline `padding-bottom: env(safe-area-inset-bottom)` shorthand). <!-- NOTE for future docs: never write a bracketed Tailwind arbitrary-value padding token whose inner value is an empty or invalid env(). Tailwind v4 scans .md files for class candidates and emits the broken CSS, which 500s the Turbopack dev server. Describe such classes in prose only. --> Contract documented in `app/layout.tsx`'s viewport comment.
- **Schedule moved into the digest** (BUG-003) — `/` now has `?view=digest|schedule` via `components/digest/home-view-toggle.tsx`; the table extracted to `components/digest/schedule-month-view.tsx`; `/production/schedule` is now a redirect (so the production tab-bar no longer paints under it).

### Perf overhaul (BUG-008)
- `vercel.json` region pin (above) — the headline.
- `lib/digest/queries.ts` — `getDigestData` collapsed 4 sequential DB round-trips → 2 (waves 2/3/4 all depend on `operationalDate` but not each other); schedule week+preview queries deduped 6→4.
- Migration **`20260717031201_add_rc_out_batch_id_index.sql`** — `idx_rc_out_batch_id`; the blocking view's correlated subquery was Seq-Scanning `rc_out` 166× (exec 33.6→6.96ms, buffers 5922→445).
- Pending UI: `useTransition`/`useOptimistic` on the home toggle, summaries switcher, blocking `?block=`, rc-movement campaign picker. 8 new `loading.tsx` (the 4 slow routes + 4 CONTAINMENT skeletons because `app/(app)/loading.tsx` is route-group-level and leaks to siblings).

### Block-close cross-check (BUG-011 Phase 1)
- Migration **`20260720032956_harden_batch_close_close_only.sql`** (applied live via MCP) — hardened `fn_is_close_remark` to EXACT-match (`{CLOSED,DONE,DONE FEEDING,FEEDING DONE}`), made `fn_process_blackwood_usage` **close-only** (a cleared/edited/deleted close remark can no longer reopen a batch), added `fn_close_batch(uuid)`.
- `workers/sync/src/lib/closingRemarks.ts` (NEW, shared helper), `workers/sync/src/lib/gsheetCloseScan.ts` (NEW planner), new Stage 3d `closeBatchesFromGsheet` in `workers/sync/src/workflows/runSync.ts` (runs AFTER writers; status-only write, never `rc_out` — respects R4b sole-writer). Findings surfaced to Sync Review via `lib/sync/cases-fold.ts` + `lib/sync/findings.ts` + `components/sync/HeldRows.tsx` (`batch_closed` / `batch_close_unmatched`).

### Other data fixes
- **BUG-005** — Jul/July duplicate campaign: the PROPOSED extractor emitted 3-letter month abbreviations. Fixed with shared `workers/sync/src/lib/months.ts` normalizer (both extractors + the Python oracle `extract_proposed_daily.py` in lockstep); DB repaired (`JUL`→`JULY`, `APR`→`APRIL`, 29 rows).
- **BUG-006** — 178 legacy-2024 `rc_out` rows with blank/NULL `production_batch` backfilled from `transaction_date`'s month (guarded so modern data proven byte-identical before/after).

## Critical learnings (highest-value — a fresh context can't reconstruct these)

1. **VERIFY AGAINST THE LIVE SYSTEM, NOT GREP/ASSUMPTION.** I got the block-close diagnosis wrong TWICE: (a) claimed no code closes a batch — false, the DB trigger `fn_process_blackwood_usage` on `rc_out` does it via `fn_is_close_remark` (460 batches closed that way); I'd only checked `fn_update_blackwood_state` (which is on `deliveries`) and grepped app/worker code, missing the DB trigger. (b) Then looked in the PROPOSED report for the missing close signal when it was in the **gsheet RC_OUT tab**. Renzo's screenshot settled it. Lesson: query `pg_trigger`/`pg_get_functiondef` and read the actual source docs before concluding.
2. **iOS chrome is invisible to the dev tooling.** `env(safe-area-inset-*)` = 0 in any desktop browser (responsive mode resizes the viewport but does NOT synthesize a notch), and standalone-PWA behavior doesn't exist in Blink. So the status-bar collision and the landscape pillarboxing were BOTH shipped with full confidence and only caught by on-device screenshots. Responsive mode catches layout-fit bugs (squashed columns, crushed cells) — auth is the only thing blocking me from using it (see "dev-login" open decision).
3. **`viewport-fit=cover` is required to fill the screen in landscape, but it's all-or-nothing.** Without it iOS auto-insets (safe, but PILLARBOXES landscape → black side bars). With it you MUST pad every top/bottom/side surface. The right fix is central (shared `.safe-*` utilities in the primitives), NOT per-surface — the first attempt was per-surface whack-a-mole and missed half the app.
4. **`black-translucent` status bar is cached at PWA install time.** Changing `statusBarStyle` requires deleting + re-adding the home-screen icon to take effect; a reload isn't enough.
5. **Vercel functions default to `iad1` (US East).** With Supabase in Tokyo, that's ~180ms × ~6 sequential round-trips per navigation ≈ the 2-3s "dead click." One-line `vercel.json` region pin fixed it.
6. **Parallel subagents on ONE working tree collide.** In Phase 4b, agents editing disjoint files still clobbered each other (stale editor buffers auto-saving, a stray `git stash`). Mitigation: run sequentially for anything touching shared/adjacent files, and do a hard integrity check (grep every marker + full build) before committing a parallel wave.
7. **R4b cutover consequence:** `SYNC_RCOUT_RECONCILE_CUTOVER` (default ON) makes the PROPOSED report the sole `rc_out` writer; the gsheet only reconciles. Side effect: gsheet close remarks were being DROPPED. The close-scan writes `batches.status` ONLY (not `rc_out`) so it respects the cutover.
8. **Supabase migration history is MCP-stamped, not CLI-stamped** — `supabase db push` misreads it. Use MCP `apply_migration` (write the local migration file too, for VCS/reproducibility).
9. **Close semantics are now monotonic** — a batch can't be reopened by clearing/editing/deleting an `rc_out` close remark; a genuine reopen is a manual `batches.status` change. INSERT is intentionally exempt (a new feeding on a closed batch legitimately resumes it).

## Current state

**Working (verified against prod / live DB):**
- App live on Vercel, worker healthy on Fly (`/health` 200, machine `started`, check passing).
- Block close cross-check proven: **C-12A (AUG-25-BLK2) CLOSED** by the 06:20 sync (`batch_closes` logged it); 460 existing CLOSED batches untouched by the trigger hardening.
- Perf: region pinned, index live, all builds green.
- **A-7B (FEB-26-BLK1) is CORRECTLY still IN-USE** — it is NOT marked closed in the gsheet (Renzo confirmed; the "closed FEB-26" block was FEB-26-BLK4 = A-7C, a neighbour). Not a bug.

**Built but NOT device-verified (the real gap):** the entire safe-area/edge-to-edge landscape rework, the condensed blocking landscape header (`[@media(max-height:500px)]`), the digest KPI/chart Dialogs, the perf pending-UI/skeletons. All static-verified only.

**Known open (in `docs/BUG_LEDGER.md`):**
- **BUG-007** — safe-area not yet applied to portalled UI: Radix `DropdownMenu`/`Popover`/`Tooltip` content + Sonner `<Toaster>` can tuck under the home indicator/notch; `black-translucent` = white status-bar text, low-contrast over a light-mode full-height sheet.
- **BUG-009** — `view_digest_operational_days` is embedded in 9/15 digest views (one evaluates it twice) → recomputed 10+× per `/` load. Structural (materialize or restructure); the real remaining server lever.
- **BUG-010** — hygiene: `middleware.ts`→`proxy.ts` (Next 16 deprecation, harmless), `types/supabase.ts` drift (`view_digest_daily_hours` never regenerated), double/triple `getUser()` per request.

## Open decisions (need Renzo)

- **BUG-011 Phase 2 — the full closure cross-check.** Vision captured in `docs/BUG_LEDGER.md` BUG-011 + memory `closure_reconciliation_vision.md`: make closed/active a RECONCILED field (gsheet ⇄ PROPOSED) — corroborate on agreement, raise a **Sync Review diff case** on genuine conflict (e.g. gsheet says CLOSED but PROPOSED shows feeding after that date). Phase 1's shared helpers + `fn_close_batch` are the primitives it builds on. Design against `SYNC_RECONCILIATION_MODEL.md`.
- **Dev-login route for agent self-verification.** Proposed: `app/api/dev-login/route.ts` triple-gated (`NODE_ENV!=='production'` + `VERCEL_ENV` unset + `DEV_LOGIN_ENABLED=1`), reads a dev password from server env (never through the agent), signs in a dedicated `dev@` account with the **Production role** (can't see ₱). Would unlock responsive-mode self-verification of the layout bug class. NOT built — awaiting Renzo's OK + the dev account.
- **Xcode/iOS Simulator** — the ONLY way for the agent to see real iOS chrome (safe-areas, standalone). ~7-10GB install on Renzo's machine. Recommendation was: probably not worth it; responsive-mode + dev-login covers most, keep the screenshot loop for iOS-chrome specifics. (This is NOT about a native Swift app — a native rewrite was discussed and recommended AGAINST: the Supabase/SQL/worker layer ports, but ~25 dense screens are months of rewrite.)

## Next concrete action

**Do an on-device verification pass on a real iPhone + iPad mini (portrait + landscape).** Priority spots: (1) landscape Blocking — does it fill the screen now + is the condensed header right on both a 20-col and a 3-col PCA/PCB warehouse; (2) the digest⇄schedule toggle; (3) tapping a KPI card / expanding a chart (now centered Dialogs); (4) any portalled dropdown/toast near the bottom edge (BUG-007 candidates). Reload / delete+re-add the home-screen icon after any `statusBarStyle`-affecting deploy. Screenshot anything off — the loop of {Renzo screenshots → agent fixes → redeploy} is the working verification method for iOS chrome.

Then, if desired: BUG-011 Phase 2, or the BUG-010 hygiene sweep.

## Git state

- **Branch `feat/mobile-pwa`** @ `6d7c6bf` (== `origin/dev`) — the working branch for everything this session. Tree clean.
- **`main`** @ `699b9ba` (merge of `6d7c6bf`) — **this is production; Vercel deploys it.**
- All work merged `feat/mobile-pwa → dev → main`. `feat/mobile-pwa` is fully merged and could be kept or deleted.
- Recent SHAs: `6d7c6bf` close cross-check · `30ab4ad` perf · `761bf42` edge-to-edge safe-area + landscape header · `651451a` schedule→digest + ledger 001-005 · `3fd0d94` never-crush + month canonicalization · `bd9b40b`/`0e4ae9c`/`699b9ba` are the corresponding `main` merge commits.
- Two live DB migrations applied via MCP: `20260717031201_add_rc_out_batch_id_index`, `20260720032956_harden_batch_close_close_only` (local files written for VCS).
