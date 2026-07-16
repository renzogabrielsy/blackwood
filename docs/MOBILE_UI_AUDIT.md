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
| 0 | **PWA shell** | app-wide | — | install, launch | — | `mobile-audit-00-pwa-shell.md` | ☐ |
| 1 | **Sync control** | `/` (SyncLauncher modal), `sync_runs`/`sync_run_events` realtime | run progress, per-report results, findings list | **Run Sync click**, watch live, read findings | B | `mobile-audit-01-sync-control.md` | ☐ |
| 2 | **Home digest** | `/` | KPIs, charts, open blocks, schedule preview, bag inventory, sync summary, activity, flags/MTD | read; tap-to-expand | A | `mobile-audit-02-home-digest.md` | ☐ |
| 3 | **Blocking grid** | `/inventory/blocking` (`?block=`) | 220-slot heatmap ×4 warehouses (+PCA/PCB), detail slide-over (deliveries/usage history), blend proposal modal | read, tap cell → panel, filters; blend = desktop | F | `mobile-audit-03-blocking.md` | ☐ |
| 4 | **Master tables (read)** | `/inventory` (`?tab=deliveries\|usage`) | RC IN delivery log (~20 cols, virtual scroll), RC OUT usage + closed-blocks summary | read, search, filters, month/year nav; NO edit/bulk | C | `mobile-audit-04-master-tables.md` | ☐ |
| 5 | **Production (read)** | `/production` (3 tabs), `/production/schedule` | daily ledger, electricity, trucks, month plan-vs-actual | read, period picker, month nav; NO inline edit | C/D | `mobile-audit-05-production.md` | ☐ |
| 6 | **Feeds (view-only)** | `/sync/cases`, `/review-queue`, `/notifications` | diff cases grouped by run, pending uploads, notification list | read, filter chips; NO resolve/approve on phone | G | `mobile-audit-06-feeds.md` | ☐ |
| 7 | **Matrices (read)** | `/inventory/rc-movement` (`?campaign=`), `/inventory/flecon-bags` | campaign feed matrix (frozen panes), bag movement matrix | read, campaign picker, column-tap → panel | E | `mobile-audit-07-matrices.md` | ☐ |
| 8 | **Cenapro (read)** | `/cenapro`, `/cenapro/production` (`?view=`), `/cenapro/inventory` | production ledger, daily W6/W7 block, flec balances + ledger | read, period/view pickers; NO edit | C/E | `mobile-audit-08-cenapro.md` | ☐ |
| 9 | **Summaries** | `/summaries` (`?view=period\|supplier`) | multi-year price/volume overlay charts, KPI strips, monthly/supplier tables, supplier slide-out | read, year/granularity toggles | H | `mobile-audit-09-summaries.md` | ☐ |
| 10 | **Platform chrome** | navbar, `/login`, `/settings`, `/admin`, `/edit/[auditLogId]`, `/access-denied` | nav, breadcrumbs, auth, user mgmt, audit detail | login MUST work on phone; admin likely 🖥 | I | `mobile-audit-10-chrome.md` | ☐ |
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

*(none yet — audits append here)*
