# Mobile UI Audit — Feature Map & Battle Plan

> **Created 2026-07-16.** This is the persistent working document for the mobile/PWA
> readiness effort. Each audit session appends one "Audit Result" section at the
> bottom. Do NOT re-derive the map — it is the source of truth. Prompts for each
> audit live in `.agents/prompts/mobile-audit-*.md`.

## The goal (locked with Renzo, 2026-07-16)

> **Make Blackwood an installable PWA where anyone can MONITOR everything and
> RUN/WATCH a sync from an iPhone or iPad mini. No data editing on mobile —
> entry, inline edits, and case arbitration stay desktop.**

> **NON-GOAL (hard rule): desktop functionality is NEVER removed, degraded, or
> redesigned by this effort.** Mobile work is strictly ADDITIVE — smaller-screen
> presentations rendered alongside the existing desktop UI, switched by viewport
> (the `hidden sm:block` / `sm:hidden` pattern, e.g. `ScheduleTable` vs
> `SchedulePreviewMobile`). "Hide on mobile" always means "below the breakpoint
> only," never "delete from the toolbar." A 🖥 DESKTOP-ONLY verdict means phones
> get no special version — it never means the desktop feature changes.

Consequences:
- Bulk-input grids + inline table editing are **declared desktop-only**. No touch
  redesign, ever. Their audit verdict is pre-decided: the READ layer must work,
  the EDIT layer must simply not break the read experience (and ideally hide).
- Every data table needs a *readable* mobile view, not an editable one.
- "Run Sync" (the modal + live progress) is the ONE interactive flow that must be
  first-class on a phone.
- Deployment target is the existing Vercel app (`https://blackwood-ictc.vercel.app`)
  — responsive web + PWA shell (manifest, icons, service worker), NOT a native app.

## Device matrix (test at these exact viewports)

| Device | Viewport (CSS px) | Notes |
|---|---|---|
| iPhone | **375 × 812** portrait | The hard target. Tailwind: below `sm` (640). |
| iPad mini portrait | **744 × 1133** (test via 768 × 1024 preset if needed) | Hits `sm`/`md`; most desktop tables *almost* fit. |
| iPad mini landscape | **1133 × 744** | Usually fine; verify frozen panes + modals. |

Dark mode must be checked at each size (one pass, `colorScheme: 'dark'`).

## Verdict vocabulary (use exactly these)

- ✅ **WORKS AS-IS** — readable + usable at the viewport, no changes needed.
- 🔧 **ADAPT: `<pattern name>`** — needs a named mobile pattern (see catalog below).
- 🖥 **DESKTOP-ONLY** — deliberately out of mobile scope; page should degrade
  gracefully (no horizontal page scroll, no broken chrome) but gets no mobile UX.

## In-repo mobile precedents (proven patterns — reuse before inventing)

| Pattern | Reference implementation | Use for |
|---|---|---|
| **Stacked list + "view full table" bottom sheet** | `components/digest/schedule-preview-mobile.tsx` (phone) vs `schedule-table.tsx` (sm+) | Any dense table whose phone user needs a summary, with the full table one tap away |
| **Bands stack single-column on mobile** | `app/(app)/page.tsx` digest layout (`lg:grid-cols-2` → stacks below lg) | Multi-column dashboard layouts |
| **Full-width slide-over on phones** | `_shared/blocking-detail-panel.tsx` (`w-full sm:w-[520px]`) | Detail panels |
| **Table scrolls inside its own box** | `ScheduleTable` wrapper (`overflow-auto` + `minWidth`) | Keeping wide tables from breaking the page |
| **Frozen-pane horizontal scroll** | `rc-movement-matrix.tsx`, `flecon-bags-view.tsx` | Matrices: pinned identity columns + scroll the rest (may be *acceptable* on iPad, painful on iPhone) |
| **Tap-to-expand widgets** | Home digest mobile work (2026-07-15, commit `650a970`) | Compact-by-default bands |

## Archetype table (the token saver — decide once, apply everywhere)

| # | Archetype | Features covered | Expected mobile answer |
|---|---|---|---|
| A | Briefing bands | Home digest | ✅ mostly proven; verify + polish |
| B | Modal + live progress | Sync launcher/run watcher | 🔧 full-screen sheet on phones? |
| C | Dense master table (read layer) | RC IN, RC OUT, production daily/electricity/trucks, schedule | 🔧 one pattern decided at RC IN, reused |
| D | Bulk/inline EDIT grids | RC IN/RC OUT bulk input, production grids, Cenapro ledger edits | 🖥 desktop-only by decree |
| E | Frozen-pane matrix (read) | RC Movement, Flecon bags, Cenapro daily block | 🔧 pinned-column scroll on iPad; phone = summary or landscape-only |
| F | Spatial heatmap grid | Blocking (220 slots) | 🔧 strong phone case (warehouse walks) |
| G | Case/feed flows (view) | Sync cases, review queue, notifications, activity feed | 🔧/✅ naturally phone-shaped |
| H | Analytics (charts + tables) | Summaries | 🔧 charts resize; tables → archetype C pattern |
| I | Forms/admin chrome | Admin, settings, login, edit-audit | 🖥 or ✅ — light sweep only |
| — | Chat | Jarvis | **DORMANT (unmounted since 2026-07-04) — skip entirely** |

## Feature map (routes → what it shows → audit prompt)

Priority order = the order Renzo confirmed (business priority). Status column is
updated as audits complete.

| P | Feature | Route(s) | Data shown | Interactions kept on mobile | Archetype | Prompt file | Status |
|---|---|---|---|---|---|---|---|
| 0 | **PWA shell** | app-wide | — | install, launch | — | `mobile-audit-00-pwa-shell.md` | ☑ 2026-07-16 |
| 1 | **Sync control** | `/` (SyncLauncher modal), `sync_runs`/`sync_run_events` realtime | run progress, per-report results, findings list | **Run Sync click**, watch live, read findings | B | `mobile-audit-01-sync-control.md` | ☑ 2026-07-16 |
| 2 | **Home digest** | `/` | KPIs, charts, open blocks, schedule preview, bag inventory, sync summary, activity, flags/MTD | read; tap-to-expand | A | `mobile-audit-02-home-digest.md` | ☑ 2026-07-16 |
| 3 | **Blocking grid** | `/inventory/blocking` (`?block=`) | 220-slot heatmap ×4 warehouses (+PCA/PCB), detail slide-over (deliveries/usage history), blend proposal modal | read, tap cell → panel, filters; blend = desktop | F | `mobile-audit-03-blocking.md` | ☑ 2026-07-16 |
| 4 | **Master tables (read)** | `/inventory` (`?tab=deliveries\|usage`) | RC IN delivery log (~20 cols, virtual scroll), RC OUT usage + closed-blocks summary | read, search, filters, month/year nav; NO edit/bulk | C | `mobile-audit-04-master-tables.md` | ☑ 2026-07-16 |
| 5 | **Production (read)** | `/production` (3 tabs), `/production/schedule` | daily ledger, electricity, trucks, month plan-vs-actual | read, period picker, month nav; NO inline edit | C/D | `mobile-audit-05-production.md` | ☑ 2026-07-16 |
| 6 | **Feeds (view-only)** | `/sync/cases`, `/review-queue`, `/notifications` | diff cases grouped by run, pending uploads, notification list | read, filter chips; NO resolve/approve on phone | G | `mobile-audit-06-feeds.md` | ☑ 2026-07-16 |
| 7 | **Matrices (read)** | `/inventory/rc-movement` (`?campaign=`), `/inventory/flecon-bags` | campaign feed matrix (frozen panes), bag movement matrix | read, campaign picker, column-tap → panel | E | `mobile-audit-07-matrices.md` | ☑ 2026-07-16 |
| 8 | **Cenapro (read)** | `/cenapro`, `/cenapro/production` (`?view=`), `/cenapro/inventory` | production ledger, daily W6/W7 block, flec balances + ledger | read, period/view pickers; NO edit | C/E | `mobile-audit-08-cenapro.md` | ☑ 2026-07-16 |
| 9 | **Summaries** | `/summaries` (`?view=period\|supplier`) | multi-year price/volume overlay charts, KPI strips, monthly/supplier tables, supplier slide-out | read, year/granularity toggles | H | `mobile-audit-09-summaries.md` | ☑ 2026-07-16 |
| 10 | **Platform chrome** | navbar, `/login`, `/settings`, `/admin`, `/edit/[auditLogId]`, `/access-denied` | nav, breadcrumbs, auth, user mgmt, audit detail | login MUST work on phone; admin likely 🖥 | I | `mobile-audit-10-chrome.md` | ☑ 2026-07-16 |
| — | Jarvis chat | (unmounted) | — | — | — | — | SKIP (dormant) |
| — | Price demos | `/price-demos/*` | demo pages | — | — | — | SKIP (demos; demo4 logic lives on in Summaries) |

## Cross-cutting facts every auditor must know

1. **Price gating:** ₱ data is nulled server-side for the Production role
   (`canViewPrices()`). Mobile views must never accidentally re-expose it, and
   must not render awkward empty ₱ columns (see RC Movement's `showFedPrice`
   column-drop precedent).
2. **Error toasts HARD RULE:** persist-until-dismissed + Copy button
   (`errorToast()` from `lib/toast.ts`). On a phone the toast must not cover the
   whole screen unusably — check it.
3. **Frozen panes are ALWAYS opaque** (CLAUDE.md) — when checking matrices at
   small sizes watch for bleed-through/seams, don't "fix" with glass.
4. **No page-level horizontal scroll, ever.** Wide content scrolls inside its own
   `overflow-auto` box.
5. **Never animate table rows**; don't propose entrance animations on big tables.
6. **The navbar** (`components/navbar.tsx`) owns page titles; check its own
   mobile behavior once (prompt 10), not in every audit.
7. **Read-layer vs edit-layer:** many "tables" are secretly editors (archetype D).
   The audit only cares that the page is *readable* on mobile and edit affordances
   don't break it (e.g. context menus, F2, hover-only UI must degrade silently).

## Audit result template (append one per feature, keep it THIS short)

```markdown
---
## Audit N — <Feature> (YYYY-MM-DD, auditor: <agent>)

**Verdicts:** iPhone 375: <✅/🔧 pattern/🖥> · iPad mini 744: <…> · landscape: <…>
**What it shows:** <1-2 sentences>
**What breaks (evidence):** <bullet list, each with viewport + screenshot ref>
**Recommended pattern:** <named pattern from the catalog, or new one defined in 2-3 sentences>
**Keep on desktop only:** <list of interactions deliberately excluded>
**Effort:** S / M / L — <1 sentence why>
**Implementation notes for the future builder:** <3-6 bullets max, file-specific>
```

## Audit results

> Sections below are in **completion order**, not strict numeric order (00, 01, 02, 07, 03, 04, 06, 10, 05, 08, 09). For a numeric index use the **feature map** table above or the **Series wrap-up** table at the bottom.

---
## Audit 00 — PWA Shell Readiness (2026-07-16, auditor: Opus 4.8)

**Verdict:** 🔧 **NOT installable today** — zero PWA scaffolding exists, but the foundations are unusually favorable and the build is small. No blocking architectural problems; two real unknowns (one device test, one design asset) gate a clean finish.

**Current state (evidence, all from source):**
- **No manifest, no `public/` dir, no icons** except `app/favicon.ico`. `next.config.ts` is empty. So the app cannot be "installed" with a proper name/icon/standalone display on any platform yet.
- **No `viewport` export anywhere** (`grep` across `app/`), so Next.js emits its default `width=device-width, initial-scale=1` — **no `viewport-fit=cover`, no `themeColor`, no `appleWebApp` metadata.** Root `metadata` (`app/layout.tsx`) is just title + description.
- **Safe-area code already exists but is currently INERT:** three digest bottom sheets use `pb-[max(1rem,env(safe-area-inset-bottom))]` (`digest-charts.tsx:120`, `kpi-hero.tsx:414`, `schedule-preview-mobile.tsx:138`). `env(safe-area-inset-*)` only resolves to a nonzero value when `viewport-fit=cover` is set — which it isn't — so today these all collapse to `1rem`. Adding `viewport-fit=cover` "activates" the padding that's already written.
- **App shell uses `h-screen` not `h-dvh`** (`app/(app)/app-shell.tsx`: `<div className="flex flex-col h-screen">`, Navbar top + `FloatingStatusBar` bottom). `h-screen` = `100vh`, which on iOS Safari includes the area behind the dynamic browser toolbar → bottom chrome (the FloatingStatusBar) can sit under the toolbar/home indicator. `h-dvh` is the mobile-correct unit.
- **Auth is in the BEST-CASE configuration for iOS standalone** (this is the good news): browser client is `@supabase/ssr` `createBrowserClient` (`lib/supabase/client.ts`) → **cookie-based PKCE sessions, NOT `localStorage`**; login is a **full-page top-level redirect** (`LoginForm.tsx` `signInWithOAuth`, no popup); the callback (`app/auth/callback/route.ts`) exchanges the code **server-side** and sets HTTP-only cookies via a top-level redirect back to the in-scope origin. Cookies + full-page redirect + server callback are exactly the three properties that survive iOS standalone best (localStorage + popups are what classically break).
- **Session longevity is already handled:** `middleware.ts` runs `getUser()` on every non-static request and forwards refreshed cookies, so a PWA cold-launched after days refreshes its session on the first navigation (as long as the refresh token is still valid).

**The one genuine risk (must be device-tested, cannot be resolved from code):** iOS standalone PWAs have a **cookie/storage container isolated from Safari** ([netguru](https://www.netguru.com/blog/how-to-share-session-cookie-or-state-between-pwa-in-standalone-mode-and-safari-on-ios), [Apple forums](https://developer.apple.com/forums/thread/649699)). If, during the Google hop, iOS kicks the flow out to Safari (instead of keeping the top-level navigation inside the standalone webview), the returning session cookie lands in Safari's container and the installed app stays logged out. Our cookie+PKCE+full-page-redirect setup gives this the best odds of "just working" on iOS 17/18, and Supabase's own guidance is that the session is saved to cookies after the server code exchange ([Supabase Google auth docs](https://supabase.com/docs/guides/auth/social-login/auth-google)) — but the outcome is iOS-version-dependent and **only a real-device test settles it.** Mitigation if it fails: ensure a clean re-login path (a failed callback already redirects to `/login`), and treat native Google/Apple Sign-In + deep linking as a heavy last-resort (likely out of scope for a responsive-web PWA).

**Recommended service-worker approach:** **Defer the SW for the first cut.** The audience is iPhone + iPad (all iOS/iPadOS Safari), and **iOS does NOT require a service worker for "Add to Home Screen" installability** — only Chrome/Android does. So manifest + icons + metas alone make it installable for these users. If Chrome/Android install is later wanted, add a ~25-line hand-rolled SW (install-qualifying + static-shell cache + offline fallback page) rather than `next-pwa`/Serwist — the app is Supabase-driven and useless offline, so rich offline caching buys nothing and the project favors minimal deps.

**Ordered implementation checklist (each ≤1 line):**
1. Add a `viewport` export in `app/layout.tsx`: `width=device-width, initialScale=1, viewportFit: 'cover'` + `themeColor` (light `#27272a` zinc-800 / dark per navbar). — **S**
2. Add `appleWebApp` to root `metadata` (`capable: true`, `statusBarStyle: 'black-translucent'`, `title: 'Blackwood'`). — **S**
3. Create `app/manifest.ts` (Next metadata route): name/short_name "Blackwood", `display: 'standalone'`, `start_url: '/'`, `scope: '/'`, theme/background matching zinc + dark. — **S**
4. Produce the icon set from a real Blackwood logo → `app/icon.png` (512, maskable-safe padding), `app/apple-icon.png` (180), manifest 192/512 refs. **Blocked on a source logo asset.** — **M (design asset)**
5. Swap `h-screen` → `h-dvh` in `app/(app)/app-shell.tsx`; grep + fix any other `h-screen`/`100vh` in mobile-visible chrome. — **S**
6. With `viewport-fit=cover` live, verify real safe-area insets on the navbar (top) + `FloatingStatusBar` (bottom) + the 3 existing bottom sheets; add `pt/pb env(safe-area-inset-*)` where the shell chrome needs it. — **S/M**
7. **Device-test the standalone OAuth flow on a real iPhone** (install → cold launch → Google login → confirm session lands). This is the go/no-go gate. — **M (testing; cannot be done in-repo)**
8. Confirm cold-PWA-launch session refresh end-to-end (mostly already covered by `middleware.ts`; just verify after a multi-day background). — **S**
9. (Deferred) Only if Chrome/Android install is wanted: add the minimal hand-rolled SW + offline fallback page. — **M**

**Effort:** **S–M for the code** (items 1–3, 5, 8 are all Small; the whole code side is ~half a day), **gated by two non-code unknowns**: a real-device OAuth test (item 7) and a design-supplied icon asset (item 4). No architectural blockers.

**P0 status:** ☑ audited.

---
## Audit 01 — Sync Control (2026-07-16, auditor: Opus 4.8)

> **Method note:** live browser preview is gated behind Google OAuth on the shared pane, so this is a **code-based structural audit** (read of `SyncLauncher`, `SyncPanelBody`, `SyncEmployeeCard`, `HeldRows`, `ui/dialog`, the digest header row, and the `schedule-preview-mobile` precedent). Every verdict is flagged with confidence + a live-verify list.

**Verdicts:** iPhone 375: 🔧 **ADAPT: full-screen/bottom sheet on phones, Dialog at sm+** · iPad mini 744: ✅ WORKS AS-IS · landscape 1133: ✅ WORKS AS-IS

**What it shows:** A privileged-only zinc "Run Sync" button in the digest header row opens a centered Dialog that runs the six ingestion pipelines and watches them live over Realtime — per-employee progress cards, a Stop control mid-run, and a terminal findings list with "Copy for Claude" buttons.

**What breaks / risks (evidence, all from source):**
- **`max-h-[85vh]` uses `vh`, not `dvh`** (`SyncLauncher.tsx:63`). On iOS Safari `vh` = large viewport (behind the dynamic toolbar), so the modal's bottom — the summary footer and the last findings — can sit under the browser chrome / home indicator at 375. Same class of bug Audit 00 flagged for `h-screen`. **CONFIDENCE: high (code); exact cutoff needs on-device confirm.**
- **No `env(safe-area-inset-bottom)` padding anywhere in the sync UI.** The digest bottom sheets already do `pb-[max(1rem,env(safe-area-inset-bottom))]` — the sync modal does not. Bottom content hugs the unsafe edge on notched iPhones. **CONFIDENCE: high.**
- **It's a centered Dialog, not a phone-shaped surface.** At 375 the width is fine (`w-full max-w-[calc(100%-2rem)]` → 343px, single-column stacked cards, chips `flex-wrap`, internal `overflow-y-auto`, sticky glass header pins correctly). But a floating centered modal with a 32px launcher and a 16px top-right X is *usable, not first-class* for a 90s watch-live flow. **CONFIDENCE: high (layout deterministic).**
- **Hover-only affordances are all supplementary** — `title=` tooltips on Stop / Dry run / Copy never show on touch, but each control has a visible icon+label, so no critical path is hover-gated. **CONFIDENCE: high — no blocker.**
- **Clipboard** ("Copy all for Claude", per-finding Copy) fires `navigator.clipboard.writeText` synchronously in the tap handler over https — correct iOS pattern, but iOS clipboard is finicky. **CONFIDENCE: medium — device-test.**
- **Realtime jank low-risk:** all six cards render from mount (fixed `SYNC_REPORTS` set, mutate in place), progress bars animate via `transform: scaleX` (compositor-safe), `HeldRows` appears once at terminal (top-anchored, `animate-fade-up`). No mid-run row insertion to hijack scroll. **CONFIDENCE: medium — confirm scroll-anchoring as the modal grows live.**
- iPad 744/1133: `sm:max-w-3xl` → comfortable centered dialog, ≈ desktop. No breakage.

**Recommended pattern:** **Full-screen / bottom sheet on phones, Dialog at sm+** (archetype-B answer). Reuse the digest precedent: `Sheet side="bottom"` + `max-h-[Ndvh]` + `rounded-t-2xl` + `pb-[max(1rem,env(safe-area-inset-bottom))]` (exactly `schedule-preview-mobile.tsx:136-138`). Key enabler: **`SyncPanelBody` is already chrome-agnostic**, `useSyncRun` is already **lifted above the modal** in `SyncLauncher`, and a **dormant `SyncPanel.tsx` Sheet wrapper already exists** — so this is a viewport switch (`sm:hidden` Sheet / `hidden sm:block` Dialog, both fed the same lifted hook), not a rebuild.

**Keep on desktop only:** nothing — Run Sync is the one interactive flow that must be first-class on a phone. (Case *arbitration* at `/sync/cases` is Audit 06's call.)

**Effort:** **S** — body + hook already chrome-agnostic and a Sheet variant exists; work is a breakpoint-switched wrapper + the `vh→dvh` + safe-area fixes.

**Implementation notes for the future builder:**
- `SyncLauncher.tsx`: render `<Sheet side="bottom">` below `sm` and the existing `<Dialog>` at `sm+`; feed BOTH the same lifted `useSyncRun()` (already lifted — don't move it back down).
- Phone Sheet: `max-h-[90dvh] rounded-t-2xl gap-0 overflow-y-auto p-0 pb-[max(1rem,env(safe-area-inset-bottom))]`; keep the sticky glass header.
- Regardless of the sheet decision, change `max-h-[85vh]`→`max-h-[85dvh]` (`SyncLauncher.tsx:63`) + add safe-area bottom padding.
- Bump the launcher button to ≥44px touch target on phones (`h-8`=32px today); confirm the top-right X is comfortably tappable.
- Don't touch `SyncEmployeeCard`/`HeldRows` internals — they already reflow.

**Live-verify before build:** on a real iPhone confirm — (1) modal bottom not clipped by Safari toolbar/home indicator at `85vh`; (2) Copy buttons write to iOS clipboard on tap; (3) no scroll jump when findings render at terminal during a live run; (4) touch-scroll momentum inside the modal; (5) Stop reachable without covering content.

---
## Audit 02 — Home Digest (2026-07-16, auditor: Sonnet)

> **Method note:** code-based (auth-gated pane); verifies the 2026-07-15 mobile work (commit `650a970`) against the checklist rather than re-designing.

**Verdicts:** iPhone 375: 🔧 minor residue (3 items) · iPad mini 744: ✅ · landscape: ✅

**What it shows:** the `/` Daily Sync Digest — 9 stacked bands, already made mobile-responsive (tap-to-expand sheets, stacked schedule list, single-column stacking).

**What breaks (evidence, from source):**
- **Chart-expand tap target under-sized.** `digest-charts.tsx:96-103` — the phone-only `Maximize2` expand button (the only way to see Flow/Price/Grade charts full-size) is `size-6` (24px), under the ~40px guideline. `schedule-preview-mobile.tsx:126-134`'s "View full table" is `h-9` with no horizontal padding. Both are the primary phone affordance for their band → a mis-tap blocks the intended flow.
- **Truck remarks tooltip is hover-only, load-bearing.** `trucks-summary.tsx:64-77` wraps the plate in a Radix `Tooltip` (`cursor-help`) whenever `remarks` is set — the ONLY place remarks show, no truncate-and-tap fallback. **The single genuine residue** — Radix Tooltip *sometimes* opens on tap but nothing in code guarantees it. **Needs on-device confirm.**
- **`ProductionHoursChart` lacks the expand pattern its sibling `GradeChart` has.** It renders its own chrome (not `ChartCard`), so no `sm:hidden` Maximize2 / bottom sheet — stays fixed `h-[220px]` on phones while the chart stacked next to it gets tap-to-expand. Flagged intentional in the CONTEXT but reads as inconsistency at 375.
- Everything else clean by inspection: `WeekStrip` snap-scrolls; `KpiHero` MobileKpiCard is a proper `min-h-[76px]` tap card with sheet detail (net-flow drift text rendered plainly, not hover-gated); Open/Trucks/Bags/Footer tables use `table-fixed` fixed-px + `w-auto` summing under 319px content (no page h-scroll); bottom sheets use `pb-[max(1rem,env(safe-area-inset-bottom))]` (inert until `viewport-fit=cover` per Audit 00).

**Recommended pattern:** no new pattern — apply the existing catalog more completely: bump the two undersized buttons to `h-9 px-3`/`size-9`; give truck remarks the `activity-feed.tsx` truncate+tap-to-expand (or `Tooltip`→`Popover`); either wrap `ProductionHoursChart` in `ChartCard` (gets expand free) or accept the asymmetry with a comment.

**Keep on desktop only:** nothing new — all read-only.

**Effort:** **S** — three single-file non-structural fixes.

**Implementation notes for the future builder:**
- `digest-charts.tsx:96-103` — grow the `Maximize2` trigger to `size-8/9` with `-m-1` compensation.
- `schedule-preview-mobile.tsx:126-134` — add `px-3`, bump to `h-10`.
- `trucks-summary.tsx:64-77` — `Popover` (tap-native) or truncate+`(more)` mirroring `activity-feed.tsx:100-114`.
- `production-hours-chart.tsx` — if unifying, wrap the `h-[220px]` body like `ChartCard` (`digest-charts.tsx:62-132`).

**Live-verify before build:** (a) does the Radix Tooltip on truck remarks respond to tap; (b) Recharts tooltip touch-scrubbing on the 4 panels vs page scroll; (c) schedule table at exactly 744px reads clean not cramped.

---
## Audit 07 — Frozen-Pane Matrices (2026-07-16, auditor: Opus 4.8)

> **Method note:** code-based (auth-gated pane). Verdicts derive from the explicit `W_*`/`LEFT_*` frozen-column pixel constants in source — the decisive finding is arithmetic, not a screenshot.

**Verdicts — RC Movement (`rc-movement-matrix.tsx`):** iPhone 375: **🖥 full matrix / 🔧 phone-summary** · iPad mini 744: **🔧 pinned-column scroll** · landscape 1133: **✅ (mild scroll)**
**Verdicts — Flecon bags (`flecon-bags-view.tsx`):** iPhone 375: **🔧 pinned-scroll (tedious) / 🔧 phone-summary** · iPad mini 744: **🔧 pinned-column scroll** · landscape 1133: **✅ (mild scroll)**

**What they show:** two cross-tab matrices whose entire value is 2-D shape. RC Movement = days × opened blocks (kg-fed), campaign-scoped, 5 frozen left cols + frozen header/footer. Flecon = movements × 14 bag types (signed qty), 2 frozen left cols + frozen Current-Balance footer.

**What breaks (evidence — the frozen-width math is the load-bearing finding):**
- **RC Movement frozen region = 384px** (`# 48 + Date 100 + Day 52 + Fed₱/kg 96 + Total 88`) — **wider than the entire 375px iPhone.** Sticky columns cover 0–384 at every scroll offset; the first data column starts at x=384, off-screen → a phone user sees **only identity columns, never one data cell.** Production role drops the ₱ col (`showFedPrice=false`, `:150,155`) → 288px frozen, ~87px left = one peeking column. Either way the days×blocks point is unreachable on a phone.
- **RC Movement toolbar overflow risk at 375** (`:201` `flex gap-3` no wrap; `Select` fixed `w-[180px]` `:215`) — label + 180px select + counts ≈ 374px, crowds/overflows.
- **Flecon frozen region = 276px** (`Date 76 + Particular 200`) → at 375px ~99px left = **~1 of 14 bag columns**; `minWidth=1284px` forces h-scroll. Reading all 14 balances = h-scrolling one-at-a-time through a 99px window. Balance footer IS frozen-bottom (stays pinned) → tedious, NOT broken. The 200px Particular column alone eats over half the phone.
- **iPad portrait 744:** RC Movement 360px leftover → ~3–4 data cols; Flecon 468px → ~6 of 14. Legit pinned-scroll (🔧). **Landscape 1133:** RC Movement ~8 cols at once; Flecon ≈ all 14 — the honest "full matrix on a tablet" answer. ✅.
- Both scroll **inside their own `overflow-auto` box** (no page h-scroll — passes rule #4); frozen cells correctly OPAQUE (no glass, no coded bleed).
- **Flecon uses `max-h-[calc(100vh-180px)]`** (`:424`) — `vh` not `dvh`; same iOS-toolbar clip class as Audit 00's `h-screen` finding. Swap to `dvh`.

**Recommended pattern (per matrix — additive `sm:hidden`, desktop matrix stays `hidden sm:block`):**
- **RC Movement phone-summary:** campaign **KPI strip** (fed `grandTotalFed`, produced `campaignTotalProduced`, yield `campaignYieldPct`, loss) + a **per-day stacked list** (date · day · total fed · total produced, ₱/kg price-gated). Full matrix behind a "View full matrix" affordance (landscape/iPad). Block rows tappable → `BlockingDetailPanel` (already `w-full` on phones).
- **Flecon phone-summary:** **Current-Balance card list of all 14 bag types** (label + balance, red when negative — the number operators check) + a **recent-movements feed** (latest first). Removes the one-column-at-a-time scroll entirely.

**Load-bearing numbers that must survive the summary:** RC Movement — campaign fed/produced/yield%/loss% + per-block fed total/loss%/status. Flecon — the 14 Current-Balance values (full stop).

**Keep on desktop only:** the full frozen days×blocks / days×bag-types matrices (archetype E); Flecon nickname click-to-edit; RC Movement inline campaign geometry. No desktop behavior altered.

**Effort:** **M each** — no backend change (every number already ships in `RcMovementMatrix` footer/toolbar + `view_flecon_bag_balance`); work is two read-only `sm:hidden` summary components + the viewport switch, mirroring `ScheduleTable`/`SchedulePreviewMobile`.

**Implementation notes for the future builder:**
- RC Movement: gate summary vs matrix at `rc-movement-route-view.tsx` (or wrap the `<table>` in `hidden sm:block` + render `RcMovementSummaryMobile` in `sm:hidden`); reuse `campaignLabel`/`grandTotalFed`/`campaignTotalProduced`/`campaignYieldPct`/`campaignAvgFedPrice`/`columns[].{totalOut,blockLoss,status}` — never recompute (CLAUDE.md).
- Honor `data.canViewPrices` exactly as `showFedPrice` does — never render ₱ for Production.
- Flecon: card list from existing `columns` (`opening`/`balance` already `nz()`-COALESCEd); feed from `movements` (server-sorted ASC — reverse for latest-first).
- Wrap RC Movement toolbar in `flex-wrap` / `flex-col sm:flex-row`.
- Swap Flecon `max-h-[calc(100vh-180px)]` → `dvh`-based (aligns with P0 `h-dvh` fix).
- Keep both matrices' desktop code byte-for-byte — strictly additive.

**Live-verify before build:** touch momentum h-scroll of frozen panes on iOS (page-scroll fights? sticky-cell seam while flinging?); Flecon auto-scroll-to-bottom on mount at 375 (lands on latest? footer above home indicator?); RC Movement column-header tap → `BlockingDetailPanel` on touch; iPad portrait vs landscape column counts; dark-mode frozen-tint legibility.

---
## Audit 03 — Blocking Grid (2026-07-16, auditor: Opus 4.8)

> **Method note:** code-based (auth-gated pane). Cell-size/tap/scroll conclusions derive from the CSS math in `blocking-grid.tsx` + `constants.ts` — must be confirmed on-device.

**Verdicts:** iPhone 375: 🔧 **ADAPT: per-warehouse frozen-row-label horizontal scroll** · iPad mini 744: ✅ **WORKS AS-IS** (the true primary walk device) · landscape iPhone: ✅ viable fallback · Blend Proposal: 🖥 **DESKTOP-ONLY** (degrades cleanly)

**What it shows:** a 220-slot spatial heatmap (4 stacked warehouse sections, each 20-col CSS grid × 2–4 rows, +opt-in PCA/PCB); tap occupied cell → full-height right slide-over with balance, 7-cell lab strip, delivery + usage history.

**What breaks (evidence, from `blocking-grid.tsx:952-959`):**
- **The crux — 20 columns crush to ~13px at 375px.** `gridTemplateColumns: '20px repeat(20, minmax(0,1fr))'` — fractional tracks (floor 0) ALWAYS shrink to fit, so the grid never exceeds its box and the `overflow-x-auto` wrapper (`:952`) is **inert (never scrolls).** Width math at 375: ~265px ÷ 20 = **~13px/cell.** The 10px `whitespace-nowrap` loc/batch text overflows → cells garbled. This is a *crushed-cells* failure, NOT horizontal scroll.
- **Tap target ≈13px — far below 44px.** Hitting one of 20 cells in a 2px-gap row with a thumb → adjacent mis-taps near-certain. **Confirm hit area on-device.**
- **Sticky header balloons.** Header is `flex flex-wrap` (`:470`) with 8 warehouse chips + 8 status/lab pills + 5-item stats + toggles + inline `w-px` dividers → at 375px wraps to many rows consuming a big fraction of the 812px height; dividers orphan mid-wrap.
- **No page-level h-scroll** (everything `1fr`/`flex-wrap`) — failure is illegibility, not overflow.
- **iPad mini 744 → ~32px cells** (legible, deliberate taps workable) — **the realistic warehouse-walk device essentially works today.** Landscape iPhone ~35px cells (legible, but 375px tall → heavy vertical scroll).

**Detail panel (already mobile-considered):** `w-full sm:w-[520px]`, `h-dvh`, backdrop/Escape close, internal scroll — full-width phone takeover works. Two caveats: the delivery/usage `<table>`s have no inner `overflow-x` box (panel root `overflow-hidden`) so a wide row **clips** (rightmost clipped col is the hover-only edit pencil → likely harmless, confirm ASH isn't cut); the `Σ` true-weight popover is a tiny 12px tap target.

**Blend Proposal (🖥 desktop-only):** `max-w-4xl` Dialog with `min-w-[640px]` table in `overflow-x-auto` self-constrains + scrolls internally — doesn't break page/read. Multi-tapping ~13px cells to build a blend is impractical; leave the toggle present but unblessed.

**Recommended pattern:** **(a) per-warehouse horizontal scroll with a frozen row-label column** (reuses the frozen-pane precedent, `rc-movement-matrix.tsx`). Below `sm` only, swap `minmax(0,1fr)` for a fixed ≥44px cell width so the already-present `overflow-x-auto` box actually scrolls, and make the 20px row-label `sticky left-0` + **opaque** (frozen-pane "never glass" rule). Justification: the grid IS the spatial map, so summarize/collapse destroys the feature; candidate (b) one-warehouse-at-a-time doesn't even help (20 cols share the same width whether 1 or 4 sections show — they already stack). (a) is the smallest change preserving the full map + thumb-accurate taps.

**Keep on desktop only:** Blend Proposal build/modal/PDF/print; inline delivery/notes edit; the dense sticky-header filter cluster in its current form.

**Effort:** **M** — viewport-gated column-template + sticky/opaque row-label (desktop `1fr` untouched) + a mobile treatment for the wrapping header. Additive; no data/desktop change.

**Implementation notes for the future builder:**
- `blocking-grid.tsx:956` — gate the template: keep `20px repeat(N,minmax(0,1fr))` at `sm`+; below `sm` use `20px repeat(N,44px)` (or `minmax(44px,1fr)`) so the `p-2 overflow-x-auto` wrapper (`:952`) finally scrolls. Single load-bearing change.
- Row-label `<div>` (`:1034`, `width:20px`) + corner (`:961`) → `sticky left-0 z-10` solid `bg-card` (opaque) + a `.frozen-edge` right border.
- Sticky header (`:470`): below `sm`, wrap filter/stat clusters in an `overflow-x-auto` strip (or a Filters bottom-sheet); drop the inline dividers that orphan on wrap.
- Detail panel done — only wrap the two history `<table>`s in `overflow-x-auto` so a price-role 9-col row scrolls instead of clips.

**Live-verify before build:** (1) the ~13px crushed-cell rendering + text overflow at 375; (2) real cell tap hit-area / mis-tap rate; (3) that a fixed-44px template makes the section (not page) scroll with the row label frozen; (4) iPad 744 ~32px cells genuinely tap-usable on a walk (may need no phone pattern at all).

---
## Audit 04 — Master Tables, read layer (2026-07-16, auditor: Opus 4.8)

> **Method note:** code-based (auth-gated pane). LOAD-BEARING — sets the canonical Archetype C table pattern reused by Audits 05/06/08/09.

**Verdicts:** iPhone 375: 🔧 **ADAPT: card list + detail sheet** · iPad mini 744: 🔧 **full table in its own scroll box (add frozen identity col)** · landscape 1133: ✅ **WORKS AS-IS**

**What it shows:** `/inventory` logs shell, two tabs — Deliveries (RC IN ~18 cols incl. 7-metric lab + ₱) and Usage (RC OUT ~11 cols + "Closed Blocks" summary toggle); dense, virtual-scrolled, `table-fixed` grids with column-header filter popovers.

**What breaks (evidence, from source):**
- **Table width vs viewport:** RC IN `tableMinWidth` ≈ **1170px** (with prices) / ~1020px gated (`delivery-master-table.tsx:110`, sum `:1304`). At 375px = ~3× overflow, ~5-6 cols visible, 7 lab cols (45px each) illegible.
- **BUT no page h-scroll (no HARD-RULE violation):** table sits in `flex-1 overflow-hidden → flex-1 overflow-auto` (`:1710,1721`) with `minWidth` on the `<table>` only (`:1733`). Inner box owns the scroll. RC OUT identical. Today = "brutal internal squeeze," expected degrade.
- **Toolbar overflows, no responsive treatment:** RC IN toolbar is one non-wrapping `h-10 flex gap-2` row (search `w-[220px]` + Density/Columns/Settings/Select/Add/Refresh, `:1597-1688`). RC OUT mirrors + a "Closed Blocks" toggle. **Zero `sm:`/`flex-wrap`** anywhere; no `hidden sm:block`/`sm:hidden` mobile variant.
- **Column-header filters lose their entry point** in card mode (STATE/Supplier/LOC are Radix Popovers on header-label tap, `:2039,2095`).
- Desktop-only affordances (context menu, resize, cell-select) degrade silently on touch — acceptable. Virtual scroll (TanStack, `overscan:15`, fixed rowHeight, sticky glass thead/tfoot) is touch-fine.

**Recommended pattern:** **(a) Card list + full-row detail sheet.** Phones (`sm:hidden`): a **virtualized vertical list, one card per row**, ~6 load-bearing fields; tap → **full-width bottom `Sheet`** with every field (lab panel, ₱ gated, truck/sacks/remarks/audit). Keep a "View full table" escape hatch in the sheet mounting the existing `<table>` in its own `overflow-auto` box (folds candidate (c) in as power-user escape). Chosen over (b) in-table expander (fights `table-fixed`+virtualizer) and (c)-as-default (raw h-scroll of 1170px is the thing we're fixing). Decisive: the precedent **already exists** — `schedule-preview-mobile.tsx` IS this pattern, and the same virtualizer wraps `<li>` cards with zero API change.

**Keep on desktop only:** bulk input, inline edit, cell-range select+copy, context menu, column resize, density, Settings dialog, Add/Edit/Delete.

**Effort:** **M** — card list + virtualizer reuse + detail Sheet are near-copy-paste from `SchedulePreviewMobile` + `blocking-detail-panel.tsx`; genuinely new work is the mobile filter surface (a "Filters" drawer replacing the vanished header popovers) + per-table field mapping.

**Implementation notes for the future builder:**
- Desktop `<table>` gets `hidden sm:block`; new `DeliveryCardsMobile` gets `sm:hidden`. Never touch desktop path.
- Reuse `useVirtualizer` verbatim — swap `estimateSize` to card height, map `virtualRow.index` to `<li>` cards. Same `filteredData`/sort/search memo feeds both (single source of truth).
- Price gating already server-side (`canViewPrices` nulls `cost_basis`/`php_total` in `page.tsx`); card headline must exclude ₱; detail-sheet ₱ line stays behind the same prop.
- Collapse header filters into one mobile "Filters" sheet driven by existing `filters` state + URL params (`sx`/`sup`/`loc`/`m`).
- RC OUT "Closed Blocks" toggle → a segmented control above the card list (swaps data source, reuses the card component).
- iPad `sm`+: leave the table (already scrolls in-box); optional polish = frozen-first-column (`.frozen-col`/`.frozen-edge`).

**Live-verify before build:** at 375 confirm the nested `overflow-hidden→overflow-auto` truly contains the 1170px table with no page h-scroll on iOS Safari; that the toolbar squeeze doesn't overflow the Card; and count legible columns at 744/1133 to validate the "iPad = keep table" verdict.

### Archetype C pattern spec (canonical — reused by Audits 05/06/08/09)
- **Pattern:** phone = **virtualized card list** (`sm:hidden`) + **tap→full-width bottom-`Sheet` detail**, with a "View full table" escape hatch mounting the untouched desktop `<table>` in its own `overflow-auto min-w-[…]` box. Desktop table = `hidden sm:block`, never altered. Precedent to copy: `components/digest/schedule-preview-mobile.tsx`.
- **Column-selection rule:** each card shows **≤6 fields = identity (date + primary name/code) + the ONE headline metric + location + status.** For RC IN: `date · supplier · batch · weight · block_loc · state`. Everything else (lab panel, ₱ price-gated, truck, sacks, remarks, audit) lives only in the detail sheet. ₱ never in the card headline.
- **REUSE downstream:** the card-list + detail-Sheet shell, the `useVirtualizer`-wrapping-`<li>` trick, the `hidden sm:block`/`sm:hidden` split, the price-gating discipline, the full-table escape hatch.
- **RE-DECIDE per table:** the 6 headline fields (domain-specific identity + metric) and the mobile filter surface (each table's filter dimensions differ). Frozen-pane matrices (RC Movement, Flecon) are **Archetype E, NOT C** — do not force this pattern on them.

---
## Audit 06 — Feed Surfaces (2026-07-16, auditor: Sonnet)

> **Method note:** code-based (auth-gated pane).

**Verdicts:**

| Surface | iPhone 375 | iPad 744 | Notes |
|---|---|---|---|
| `/sync/cases` | 🔧 ADAPT: master-detail collapse | 🔧 (tight) | `CasesClient.tsx:767` hard-codes `w-[400px] shrink-0` list + `flex-1` detail, **zero breakpoints** → real page-overflow break, not a degrade. |
| `/review-queue` | 🔧 ADAPT: Archetype C table; cards ✅ | 🔧 | Card grid already responsive + wide table scrolls in its own box. **But Approve writes with no confirm — see risk.** |
| `/notifications` | ✅ (placeholder) | ✅ | Page is a "coming soon" stub; the real feed is the navbar bell (Audit 10). |

**What breaks (evidence):**
- `/sync/cases` — `CasesClient.tsx:765-812`: list (`w-[400px] shrink-0`) + detail (`min-w-0 flex-1`) in a plain `flex` row, no `sm:`/`md:` anywhere → at 375px forces page h-scroll or squashes detail to near-zero. Broken, not degraded.
- `/review-queue` — `ClassifiedRowsTable.tsx:129`: width ≈ **1575px** in `overflow-x-auto` (correctly scoped) but unreadable cell-by-cell on a phone → needs the Archetype C transform.
- `/review-queue` — `RowDecisionToggle.tsx:70`: segmented buttons `h-6` (~24px), under 44px (low severity — only changes staged state until Approve).

**Recommended pattern:**
- `/sync/cases`: **new pattern "Master-detail collapse to single-pane navigation"** — below `sm`, render list OR `CaseDetail` full-width (never side-by-side); select → push into detail with a back affordance. **Reference implementation already exists**: `ReviewQueueClient`'s `activeId ? <Detail/> : <List/>` swap. Above `sm`, keep the fixed-400px split unchanged.
- `/review-queue`: `ClassifiedRowsTable` is Excel-dense → **reuse Archetype C** (Audit 04), don't invent a second pattern.
- `/notifications`: none needed.

**Keep on desktop only (per scope):** resolve/pick/apply/dismiss/create-batch in Sync Review; approve/reject/upload in Review Queue.

**Accidental-tap risk (HIGH — standout finding):** `ReviewDetailPanel.tsx:88-110` (`handleApprove`) calls `approveReview()` straight from `onClick` with **NO confirmation** (Reject, on the same footer, opens an `AlertDialog`). The Approve button is in a **sticky bottom footer** that stays on-screen while the reviewer swipes through the 1575px table — exactly where a thumb lands during horizontal scroll. One mis-tap inserts/updates real `deliveries` rows with no recourse. **Recommendation: gate Review Queue's Approve/Reject footer behind `hidden sm:flex` (consistent with "approve/reject stay desktop") — do not ship the unconfirmed Approve reachable on a phone.** (Sync Review's resolve actions are already two-step → low risk.)

**Effort:** **M** — `/sync/cases` needs a real navigation-state change (bulk of the work); `/review-queue` card layer needs nothing (table rides on Audit 04), plus the small high-priority Approve-gate fix; `/notifications` free.

**Implementation notes for the future builder:**
- `CasesClient.tsx:767` (`w-[400px]`) + `:812` (`flex-1`) — the lines to make responsive; copy `ReviewQueueClient`'s single-pane swap.
- `ReviewDetailPanel.tsx:250-274` — footer button group gets `hidden sm:flex` (or a "Continue on desktop" banner below `sm`).
- `ClassifiedRowsTable.tsx` — don't touch until Archetype C is locked; its `COLUMNS` array (`:31`) mirrors RC IN order, so the Audit 04 transform ports directly.

**Live-verify before build:** confirm `CasesClient` split literally breaks at 375/744 (page-scrollbar?); touch-test "Copy for Claude" clipboard on iOS in a scrollable dense list; check `ReviewDetailPanel` sticky footer wrap at 375; confirm the navbar bell `w-[380px]` Popover clamps inside 375 via Radix collision (Audit 10's surface).

---
## Audit 10 — Platform Chrome (2026-07-16, auditor: Sonnet)

> **Method note:** code-based (auth-gated pane). Cross-refs Audit 00's safe-area / `h-screen` findings.

**Verdicts:**

| Surface | iPhone 375 | Notes |
|---|---|---|
| `components/navbar.tsx` | 🔧 ADAPT: hamburger/sheet | 3-col flex, back-link+`/`+title all `shrink-0` (only description truncates). At 375 the fixed breadcrumb parts (~180px) don't fit the ~90px left after logo+controls; no `flex-wrap`/overflow → clips or overflows (page h-scroll risk). **Zero mobile-nav exists today.** Dark toggle has a `mounted` guard (no flash). Icon targets `h-8 w-8` (32px). |
| `/login` | ✅ | Centered `Card max-w-sm`, single Google button, no chrome — cleanest surface. Nit: `min-h-screen` not `dvh` (cosmetic). PWA entry point → gated on Audit 00's real-device OAuth test. |
| `/settings` | ✅ | `max-w-2xl mx-auto px-4 md:px-6`, profile Card + sign-out. Already responsive. |
| `/admin` | 🖥 (confirmed) | User-mgmt table + invite dialog; `UserManagementTable` wraps `<Table>` in `overflow-x-auto` w/ explicit widths → degrades cleanly. No mobile work warranted. |
| `/edit/[auditLogId]` | 🔧 (light) | **Not a data-edit form** — a Slack-style discussion feed (archetype G). Structurally ready (`flex-col h-full`, bottom-pinned composer). Two issues: `DiffDisplay` (`audit-shared.tsx:60-71`) has no wrap/break on value spans → long field overflows at 375 (row is `overflow-y-auto` only); text very dense (`text-[10px]`). Phone users land here from notification taps. |
| `/access-denied` | ✅ | Centered `Card max-w-md`, no chrome. |
| `components/floating-status-bar.tsx` | 🔧 ADAPT | `fixed bottom-4 right-4 z-50` pill, mounted globally in `app-shell.tsx`. Correct glass pattern. **Gap:** no `env(safe-area-inset-bottom)` — flat `bottom-4` → in standalone (once `viewport-fit=cover` ships) sits under the home-indicator zone. Same root cause as Audit 00. |

**Navbar mobile-nav recommendation (≤5 lines):** Add a `Sheet`-based hamburger triggered by a left-side icon that only renders below `sm`, replacing the breadcrumb back-link+title (keep description hidden on mobile). The sheet reuses the existing Modules-dropdown content (`ICTC_INVENTORY`/`ICTC_MODULES`/`CENAPRO_MODULES` + privileged section) verbatim as a full-height nav list, and surfaces the current page title at its top. Keep "Blackwood" center-logo + the right-side icon cluster (bell, avatar, dark toggle) exactly as-is. Additive (`hidden sm:flex` / `sm:hidden`) — desktop navbar untouched above `sm`.

**Keep on desktop only:** Admin user-management table/invite (low phone value, degrades safely). Everything else has a mobile answer.

**Effort:** **S** overall — navbar hamburger is the biggest piece (~half day, reuses the dropdown content wholesale); FloatingStatusBar safe-area is a one-line fix (batch with Audit 00's safe-area pass); `DiffDisplay` wrap is a 2-line CSS change.

**Implementation notes for the future builder:**
- Navbar: `hidden sm:flex` on the breadcrumb block; add a `sm:hidden` hamburger `Button` + `Sheet` reusing the `ICTC_INVENTORY`/`ICTC_MODULES`/`CENAPRO_MODULES` arrays + `PRIVILEGED_ROLES` conditional (`navbar.tsx:105-124`, `:233-246`) — don't duplicate the module list.
- `floating-status-bar.tsx:81` — `bottom-4` → `bottom-[max(1rem,env(safe-area-inset-bottom))]` (matches the digest bottom-sheet pattern). Activates once `viewport-fit=cover` ships.
- `audit-shared.tsx` `DiffDisplay` (~`:63`) — add `flex-wrap` to the row + `break-all`/`min-w-0 break-words` on the value spans.
- Login/Settings/Access-denied/Admin: no changes needed (verified sound).

**Live-verify before build:** at a real 375 viewport confirm the navbar breadcrumb actually clips/overflows as predicted (vs some CSS saving it), and that `DiffDisplay` overflow triggers only with a genuinely long field value.

---
## Audit 05 — Production, read layer (2026-07-16, auditor: Opus 4.8)

> **Method note:** code-based (auth-gated pane). Load-bearing findings are the frozen-column pixel arithmetic + the `w-full`-vs-`minWidth` distinction (both deterministic from source).

**Verdicts:**

| Surface | iPhone 375 | iPad 744 | landscape | Delta from Archetype C |
|---|---|---|---|---|
| **Daily ledger** | 🔧 ADAPT: sectioned card list | 🔧 pinned-scroll (652px frozen wall) | ✅ (scrolls in box) | Detail sheet must be **section-grouped** (Identity/Production/Downtime/Waste); 8 FROZEN cols = worse than a plain scroll table |
| **Electricity** | 🔧 ADAPT: card list | 🔧 (crushed, ~68px cols) | ✅ | `w-full` NO minWidth → **crushes, never scrolls** (unlike RC IN). No ₱ → no gating |
| **Trucks** | 🔧 pinned-scroll / phone-summary | 🔧 pinned-column scroll | ✅ (mild) | **It's a days×plates frozen MATRIX (Archetype E)** — belongs with RC Movement/Flecon, NOT RC-IN cards |
| **Schedule** | 🔧 generalize `SchedulePreviewMobile` | 🔧 (min-w 1080 > 744, mild scroll) | ✅ | Closest to ready; a mobile sibling already exists — extend it |

**Stale-premise corrections (flag to Renzo):** (1) **No price gating exists in the production read layer** — Electricity's ₱ cols were renamed to non-peso `MULT`/`TTL KWH` (2026-05-29); that concern drops. (2) **Trucks is secretly a frozen-pane matrix** → handle with Audit 07's Archetype E, not RC-IN cards. (3) **Electricity *crushes* rather than scrolls** (`w-full`, no `minWidth`) — a different failure mode.

**What it shows:** `/production` = 3-tab shell (Daily/Electricity/Trucks) under a universal Year+Batch `PeriodPicker` + bottom sliding tab bar; each tab an inline-editable Excel grid (read-only on mobile by decree). `/production/schedule` = a separate Server-Component month plan-vs-actual table with `?month=` prev/next `<Link>`s.

**What breaks (evidence, from source):**
- **Daily — the frozen wall is the crux.** 8 sticky cols (`# 28 + DATE 96 + BATCH 64 + SHIFT 52 + CUSTOMER 72 + GRADE 60 + TTL KG 80 + REM 200`) = **652px frozen region, wider than the 375px iPhone** (`daily-ledger-grid.tsx:1610-1660`). The Downtime + Waste sections (scroll region starts at x=652) are effectively unreachable on a phone. `minWidth:1604px` (`:1574` — actual, CONTEXT said 1800). Scrolls in `overflow-auto max-h-[70vh]` (no page h-scroll), but `70vh` = the iOS-toolbar `vh` bug. Frozen header + footer both solid/opaque (correct).
- **Electricity — crushes instead of scrolling.** `w-full table-fixed` with **NO minWidth** (`:515`); ~688px of column widths distribute down to ~54% at 375 (START/END KWH → ~43px) → illegible, no scroll escape. `max-h-[60vh]` `vh` bug. No ₱ column.
- **Trucks — a matrix, not a table.** `tableMinWidth = 96 + plates×4×72` (`:653`), each plate group 288px; frozen DATE (96px, opaque) leaves ~279px → one plate group (288px) barely doesn't fit → pinned scroll, exactly the Flecon verdict. `vh` bug.
- **Schedule — cleanest.** `min-w-[1080px]` in `overflow-x-auto` scrolls in-box; frozen header/footer opaque. **No sticky-left Date col** → scrolling right loses the date anchor. Month-nav `<Link>`s `h-7` (~28px, under 44px).
- **Chrome touch targets:** `PeriodPicker` selects `h-6` (24px); bottom tab buttons `py-1` (~26px) — functional but under 44px.

**Recommended pattern (per surface — additive `sm:hidden`):**
- **Daily → Archetype C card list WITH a section-grouped detail sheet.** Card headline (≤6): `date · batch · shift · TTL KG · customer · [loss/waste badge]`; detail Sheet groups remaining fields into Identity/Production/Downtime/Waste (the sectioned-columns delta). One card per `production_runs` row.
- **Electricity → simplest Archetype C card** (~7 fields fit one card body; go straight to cards, the crush is the thing we're fixing).
- **Trucks → defer to Audit 07 Archetype E** (per-day card of each plate's km/fuel, or landscape matrix). Don't force RC-IN cards.
- **Schedule → generalize `SchedulePreviewMobile`** — its `<li>` row is already Archetype-C-shaped; extract it, render a **full-month** `sm:hidden` list (drop the 5-row preview slice, keep month `<Link>`s, add the `Act hrs`/`Var` fields the digest omits), desktop `<table>` stays `hidden sm:block`. Lightest of the four.

**Keep on desktop only:** all inline editing, dirty tracking, keyboard nav, paste, range-select/copy, context menus, Save/Discard toolbar.

**Effort:** **L overall** — Daily's section-grouped detail sheet is the one net-new build (M); Electricity a near-copy of RC-IN card (S); Schedule S (generalize existing); Trucks ~nothing here (folds into Audit 07). Batch the three `vh`→`dvh` swaps + sub-44px targets into the P0 safe-area pass.

**Implementation notes for the future builder:**
- Daily: gate at `daily-view.tsx` — `hidden sm:block` on the grid, new `DailyCardsMobile` in `sm:hidden`; reuse `buildGridRows()` + the in-grid `DT TTL`/`PROD HRS`/`PROD LOSS`/`TTL WASTE` values — never recompute.
- Electricity: `electricity-grid.tsx:515` — the missing `minWidth` is why it crushes; fix is the card list, not adding a minWidth.
- Schedule: extract the `SchedulePreviewMobile` `<li>` (`:39-120`) into `components/digest/schedule-row-card.tsx`; `schedule/page.tsx` renders `hidden sm:block` on its `<table>` + maps `rows` to the shared card in `sm:hidden`.
- Swap all three grids' `max-h-[60vh|70vh]` → `dvh`; bump `PeriodPicker` selects + tab buttons to ≥44px.
- `PeriodPicker` header (`layout.tsx:19`) is non-wrapping `flex` — add `flex-wrap` defensively for long batch names.

**Live-verify before build:** (1) does the 652px Daily frozen wall genuinely bury Downtime/Waste at 375; (2) Electricity numbers illegibly crushed vs merely tight; (3) Trucks pinned-DATE one-plate-per-view scroll on iOS; (4) Schedule loses its Date anchor scrolled right; (5) period-picker + tab bar tappable at 24-26px before the bump; (6) the `vh` containers don't clip their footer under the Safari toolbar.

---
## Audit 08 — Cenapro, read layer (2026-07-16, auditor: Opus 4.8)

> **Method note:** code-based (auth-gated pane). Verdicts derive from the `W_*`/`LEFT_*`/`minWidth` frozen constants + the shadcn `Table` `overflow-x-auto` wrapper. Zero mobile treatment exists in the whole tenant today. Reuses Archetype C (Audit 04) + Archetype E (Audit 07); only deltas logged.

**Verdicts:**

| Surface | iPhone 375 | iPad mini 744 | landscape 1133 |
|---|---|---|---|
| `/cenapro` hub | ✅ WORKS AS-IS | ✅ | ✅ |
| Production **ledger** (`?view=ledger`) | 🔧 **ADAPT: Archetype C** | 🔧 full table in own scroll box | ✅ |
| Production **daily block** (`?view=daily-w6/-w7`) | 🖥 full matrix / 🔧 **phone-summary** | 🔧 pinned-column scroll | ✅ (mild) |
| `/cenapro/inventory` | ✅ / mild 🔧 pinned-scroll | ✅ | ✅ |

**What it shows:** Tenant #2's three read surfaces — a two-card hub; a production screen rendering ONE period three ways via `?view=` (editable 13-col ledger + the W6/W7 Daily Block pivot = a 2-tier-header merged-cell matrix); a Flec inventory screen (pickers + balance cards + starting block + movement ledger). Editing desktop-only by decree.

**What breaks (evidence, from source constants):**
- **Hub:** `max-w-4xl` + `sm:grid-cols-2` stacks single-col below `sm`. Nothing to fix.
- **Ledger** (`production-ledger-grid.tsx:1629`): `table-fixed`, `minWidth 1228px`, **4 frozen cols = 348px** (`# · Recv · Prod · Batch`). At 375 the frozen region nearly fills the viewport (~27px left → no data cell visible) → Archetype C squeeze. Scrolls in its own box (no page h-scroll). **Toolbar is the real break:** `flex` **no `flex-wrap`** (`:1524`) — even in daily mode (picker ≈245px + switcher ≈130px ≈ 383px) overflows 375. Period selects `h-6` (24px), switcher buttons `h-5` (20px) — under touch guidance.
- **Daily block** (`production-daily-block.tsx`): **5 frozen cols = 476px** (`:370-384`), full `minWidth ≈ 1144px`. **The frozen region alone (476px) exceeds the 375px phone AND the ~343px Card content area** → can't see all identity cols, let alone a data cell → Archetype E trigger. iPad 744 → ~4-5 of 10 data cols (🔧); landscape 1133 → most (✅). 2-tier header, `rowSpan`'d Date/Shift/Grade/Source, all sticky-left + OPAQUE (correct). Scrolls in own box.
- **Inventory** (`flec-inventory-client.tsx`): friendliest. Toolbar `flex-wrap` wraps cleanly; balance cards + history grids responsive. The movement ledger (~720px) + StartingBlock (~526px) each ride the shadcn `Table` `overflow-x-auto` → h-scroll in their own box, not clipped, not page-scroll. Nit: neither freezes its Grade/Side identity col (optional polish).

**Recommended pattern (additive `sm:hidden`; desktop tables `hidden sm:block`, untouched):**
- **Ledger → Archetype C verbatim.** Deltas: (1) **no ₱ anywhere in Cenapro** → zero price-gating work. (2) Row tints + CCC/FLEC + Plant **badges carry meaning** → the card headline MUST preserve status (reuse `cccFlecBadgeClass`/`plantBadgeClass` for a disposition badge + Plant chip, not a bare tint). 6 headline fields: `recv · batch · shift+grade · source · weight · CCC/FLEC`. Filter surface = a "Filters" drawer replacing the `ColumnFilterMenu` popovers.
- **Daily block → Archetype E phone-summary:** per-plant KPI/totals strip + stacked per-row list, full matrix behind a "view full matrix" affordance (landscape/iPad). **Load-bearing = the per-day "Daily total" footer** (`:1181`). Reuse `buildDateGroups` + footer totals, never recompute.
- **Inventory:** no new pattern; optionally freeze the ledger's first identity col.

**Keep on desktop only:** the whole editable layer (ledger inline edit/Bulk Add/paste/context menu; daily-block cell edits + insert popovers; starting-balance edits + opening-history writes) — all degrade silently on touch.

**Effort:** Ledger **M** · Daily block **M** · Inventory **S** · Hub none. No backend change — every number already ships in the period rows / balance functions.

**Implementation notes for the future builder:**
- Ledger: gate where the `!isDailyView` `<table>` renders (`:1613`) — `hidden sm:block` + a `CenaproLedgerCardsMobile` in `sm:hidden` fed the same rows/sort/filter memo.
- Wrap the shared toolbar (`:1524`) in `flex-wrap` — it's shared by all 3 view modes, so one fix helps ledger + daily.
- Daily block: render its `<table>` (`:893`) `hidden sm:block`; add a `sm:hidden` summary consuming `dateGroups` + footer totals + `plantView`.
- Inventory: no structural change.

**Live-verify before build:** **the daily block's merged-rowSpan sticky identity cells are the fragile item** — `rowSpan` + `position:sticky` + `left` offset is the least-reliable combo on iOS Safari; confirm the merged Date/Shift/Grade/Source cells track (don't detach/double-paint/bleed) while flinging horizontally, and the opaque `.frozen-corner` header stays opaque. Also: ledger frozen 348px vs 375 orphaned half-column; toolbar overflow at 375 in both modes; inventory Balance column reachable via in-box h-scroll; touch-select doesn't pop a keyboard or trap page scroll.

---
## Audit 09 — Summaries (2026-07-16, auditor: Sonnet)

> **Method note:** code-based (auth-gated pane). Verified Recharts default tick-thinning directly in `node_modules/recharts` rather than assuming.

**Verdicts:**

| Surface | iPhone 375 | iPad mini 744 | landscape 1133 | Notes |
|---|---|---|---|---|
| By Period (`?view=period`) | 🔧 **ADAPT: Archetype C** (table only) | 🔧 table in own box | ✅ | Chart + KPI strip already responsive; only the monthly table needs cards. |
| By Supplier (`?view=supplier`) | 🔧 **ADAPT: Archetype C** (table only) | 🔧 table in own box | ✅ | Controls already `flex-wrap` — **no mobile filter drawer needed** (unlike RC IN). |
| Supplier slide-out panel | ✅ **WORKS AS-IS** | ✅ | ✅ | Radix `Sheet side="right" w-full sm:max-w-md` — full width at phone; only sm+ cap differs (448 vs blocking's 520px). |

**What it shows:** two views behind `?view=period|supplier`, each a hand-rolled overlay chart (price line + volume area, Recharts `ComposedChart`), a KPI strip, and an RC IN-format table with cell-selection. Supplier view adds year dropdown, Months/Quarters toggle, period multi-select, a 6-supplier overlay control, and a per-supplier `Sheet` slide-out.

**What breaks (evidence, from source):**
- **Tables overflow their own box (Archetype C), no page h-scroll:** period colgroup ~1108px priced / ~880px gated; supplier ~1232px / ~1004px (incl. a 44px checkbox col). Both in `overflow-x-auto` — same safe pattern as RC IN.
- **Cell-selection is mouse-only** (`onMouseDown`/`onMouseEnter`, never `onTouchStart`) → degrades silently on touch (tap selects one cell, drag-range just doesn't fire; no scroll hijack).
- **`StatCard` value div lacks `truncate`** (`analyst-brief-client.tsx:426-437`) while its parent is `overflow-hidden` → a long value hard-clips mid-character. Real risk for supplier view's `Top Supplier` (names like "BAGUIO/TIPALAN" clip in a `grid-cols-2` card). **The one concrete code fix.**
- **Charts already avoid the Recharts-mobile trap:** legend is a hand-rolled `flex flex-wrap div` (not native `<Legend>`) → wraps cleanly; XAxis uses Recharts default `interval:'preserveEnd'` (verified in node_modules) → auto-thins month ticks; dual Y-axis (88px) collapses to one for price-denied roles automatically.
- **Price gating leaves no holes:** KPI grids switch col counts via `canViewPrices`, table colgroups conditionally include ₱ `<col>`s + `visibleNumericColumns` keeps cell-selection index math in sync — verified consistent.

**Recommended pattern:** **Archetype C verbatim** for both tables. Card headlines — Period: `month · deliveries · weight · MC · ₱/kg (gated)`; Supplier: `supplier · deliveries · sacks · weight · ₱/kg (gated)` + the on-graph checkbox as a card-header toggle. **Summaries-specific delta:** NO bespoke mobile "Filters" sheet needed (unlike RC IN) — its filter surface (year/granularity/period chips/add-supplier) is external chrome that already `flex-wrap`s at 375.
**Chart adjustments (minor):** (1) legend already mobile-safe — no change; (2) verify month-tick legibility at 343px on device; (3) add `truncate` to `StatCard` value; (4) optionally give the period chart the Supplier view's Months/Quarters toggle for parity (bumps that slice to M).

**Keep on desktop only:** cell-range drag-select + status-bar sum/avg popup (tap-to-select-one is a harmless no-op on phone); the raw `<table>` (folded into each card list's "View full table" escape hatch).

**Effort:** **S** — both tables near-copy of Audit 04's card pattern with a 5-6 field mapping (smaller than RC IN's ~20 cols); no filter-drawer work; panel needs zero change. Only concrete fix is the `truncate`.

**Implementation notes for the future builder:**
- `analyst-brief-client.tsx:426-437` (`StatCard`) — add `truncate` to the value `<div>` (fixes the "Top Supplier" clip for free).
- `analyst-brief-client.tsx:713` / `supplier-brief-client.tsx:820` — desktop `<table>` gets `hidden sm:block`; new `MonthlyDeliveryCardsMobile` / `SupplierCardsMobile` get `sm:hidden`, reusing the same `rows`/`focusRows`/`visibleNumericColumns` (single source of truth).
- Supplier's leading "on graph" checkbox → a small toggle in the card header wired to the same `toggleGraph` handler.
- Card sheet-detail: period → full lab panel + ₱; supplier → lab panel + an "open full profile" button opening the existing `SupplierDetailPanel` (don't duplicate its logic).

**Live-verify before build:** Recharts touch tooltips (`HeroTooltip` on the hero chart + the mini chart in `SupplierDetailPanel`) — confirm a single tap on iOS surfaces the tooltip (Recharts v3.7 hover-trigger on touch is unexercised here) and whether it needs a second tap to dismiss; month-tick legibility at 343px; dual-axis crowding of the ~255px plot area on the smallest iPhone.

---
## Series wrap-up (2026-07-16)

**All 11 audit units complete** (00–10; Jarvis skipped = dormant, price-demos skipped = superseded). Verdicts at a glance:

| # | Feature | iPhone verdict | Effort |
|---|---|---|---|
| 00 | PWA shell | 🔧 not installable yet (good foundations) | S–M |
| 01 | Sync control | 🔧 bottom-sheet on phones | S |
| 02 | Home digest | 🔧 3 minor residue items | S |
| 03 | Blocking | 🔧 phone / ✅ iPad (real walk device) | M |
| 04 | Master tables | 🔧 card list (defines Archetype C) | M |
| 05 | Production | 🔧 (Daily M · Elec S · Schedule S · Trucks→07) | L |
| 06 | Feeds | 🔧 + ⚠️ HIGH accidental-write risk | M |
| 07 | Matrices | 🖥 full matrix on phone → 🔧 summary | M×2 |
| 08 | Cenapro | 🔧 ledger + 🖥/🔧 daily block + ✅ inv | M–L |
| 09 | Summaries | 🔧 tables only (charts/panel ✅) | S |
| 10 | Chrome | navbar 🔧, most ✅, admin 🖥 | S |

**Two cross-cutting themes that collapse many findings into two shared passes:**
1. **The `vh`→`dvh` + safe-area pass.** The SAME two bugs recur in: app shell (`h-screen`), sync modal (`85vh`), Flecon (`100vh`), floating status bar (`bottom-4`, no safe-area), all 3 production grids (`60/70vh`), cenapro. Fix once as a sweep — and note the digest's existing `env(safe-area-inset-bottom)` code stays inert until `viewport-fit=cover` ships (Audit 00). This is mostly S mechanical work with outsized payoff.
2. **Archetype C is the workhorse.** Build the card-list + detail-Sheet component ONCE (at RC IN, Audit 04), and it directly serves: production daily/electricity/schedule, cenapro ledger, summaries ×2, review-queue's classified-rows table. One component, six-plus reuse sites.

**Three verdict classes:**
- 🖥 **DESKTOP-ONLY (no mobile build):** all bulk/inline editing (decreed), Blend Proposal, Admin user-mgmt, the FULL frozen matrices on a phone (RC Movement / Flecon / Trucks / Cenapro daily block — each gets a phone *summary*, not the full grid).
- ✅ **WORKS AS-IS:** login, settings, access-denied, cenapro hub, summaries slide-out panel, and **iPad landscape for nearly everything** (the tablet is already a decent experience — the phone is where the work is).
- 🔧 **ADAPT:** everything else, almost all reusing 2 patterns (Archetype C cards, Archetype E phone-summary) + the shell fixes.

**Suggested implementation order:**
1. **⚠️ Ship first, independent of mobile: gate the Review Queue Approve/Reject footer** (`ReviewDetailPanel.tsx`) — it writes `deliveries` with no confirm and is thumb-reachable. Data-safety, not just mobile.
2. **Foundation pass:** PWA shell (manifest + icons + `viewport-fit=cover` + `appleWebApp`) **+ the `vh`→`dvh`/safe-area sweep** + the navbar hamburger `Sheet`. This is the container everything else sits in. Then **device-test standalone OAuth** (Audit 00's gate).
3. **Flagship:** the Sync control bottom-sheet (S — body/hook already chrome-agnostic, a dormant Sheet exists).
4. **The reusable pattern:** build Archetype C once at RC IN, then apply to production, cenapro ledger, summaries, review-queue.
5. **Archetype E summaries:** RC Movement, Flecon, Trucks, Cenapro daily block phone-summaries.
6. **Spatial:** Blocking grid (fixed-44px cells + frozen row-label).
7. **Polish:** digest residue (3 items), edit-audit `DiffDisplay` wrap.

**Everything above is additive** — no desktop code path is altered (the hard NON-GOAL). All live-verify items across the 11 audits should be confirmed in one authenticated on-device pass before building.
