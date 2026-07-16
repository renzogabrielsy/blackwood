# Blackwood Code Audit — Remediation Plan

_Assessment → fix plan. Generated 2026-07-03 by synthesizing the surviving audit run (4 codebase maps + 217-advisor condensed dump from the 2026-07-02 workflow, whose synthesis stage died on a session limit) plus first-hand re-verification of every load-bearing claim below._

## How to use this doc

This is a **plan for fixes**, ordered so it can be executed phase-by-phase. Each item carries:

- **Where** — `file:line` so no fix rests on a guess.
- **Verified** — `✓` = I opened the actual code this session and confirmed it; `map-only` = from the survived map, re-check the exact lines before editing.
- **Effort** — XS (minutes) · S (<1h) · M (half-day) · L (multi-session/design).

**Hard scope constraint (from the original audit request):** do **NOT** change how operators record data in the real world — their Excel sheets and emails stay exactly as they are. Every change here only affects **how the app presents or manipulates data that has already been ingested.** This governs Phases 2, 3, and 5 especially.

**Phase order = priority:** 0 Security → 1 Docs drift → 2 Redundancy/universalize → 3 Performance → 4 DB/RLS hardening → 5 Viewing/manipulation ideas.

**Raw evidence (may not survive — snapshot if needed):**
- 4 detailed maps: `/private/tmp/claude-501/-Users-renzosy-blackwood/93b826c5-59ad-4bcd-8f79-aea5d402f8b5/tasks/wypn73rrr.output`
- Condensed advisors: same session's `scratchpad/advisors_condensed.json`
- Draft schema-section rewrite: same `scratchpad/views_section.txt`

---

## Phase 0 — Security (do first; small, real, shippable)

### SEC-1 · Home dashboard leaks purchase prices to the Production role · ✓ VERIFIED · S
**Plain:** everywhere else in the app, the Production role can't see peso prices. But the daily ₱/kg price chart on the home dashboard (`/`) is sent to *every* role, including Production. It's a real leak in the network payload, not just the UI.

- **Where:** `lib/digest/queries.ts:541-544` — the `price: PricePoint[]` series maps `php_per_kg` with **no `showPrices` guard** (contrast the correctly-gated `openBlocks[].phpKg` at `:460` and per-delivery `price` at `:437-439`). `components/digest/digest-charts.tsx` renders `<PriceChart>` unconditionally; `app/(app)/page.tsx:~41` passes `data.price` straight through.
- **Fix:** in `getDigestData()`, when `!showPrices` set the price series to `[]` (or null `phpPerKg`). Belt-and-suspenders: pass `showPrices` into `DigestCharts` and hide the `PriceChart` block. Mirrors the gating already applied two lines up.
- **Risk:** none — additive gate. Confirm the digest still renders for Owner/Admin.

### SEC-2 · Jarvis (AI chat) returns cost data to anyone · ✓ VERIFIED · M
**Plain:** the AI assistant reads the database with an admin key that ignores all guards, and hands back cost columns to whoever's chatting. You already flagged this as "fine for now since Renzo is Owner" — logging it so it isn't forgotten.

- **Where:** `lib/jarvis/tool-handlers.ts:81` (`createAdminClient()` — RLS bypass), `:96` selects `avg_cost`, `:136` selects `cost_basis`; no `canViewPrices()`/`getUserRole()` anywhere in the file.
- **Fix:** resolve the effective role once in `executeToolCall`, and when `!canViewPrices()` strip `avg_cost`/`cost_basis` from the `batches`/`deliveries` tool results before returning. Don't change the query — scrub the payload (same pattern as the server actions).
- **Risk:** low; only removes fields for price-denied roles.

### SEC-3 · Delete/bulk mutations have no server-side permission check · map-only · S–M
**Plain:** the "delete" buttons are hidden from the wrong roles in the UI, but the underlying server action itself doesn't re-check — so the guard is only skin-deep.

- **Where (re-verify lines):** `app/(app)/inventory/rc-in/actions.ts` `bulkDeleteDeliveries` (~`:320-338`), `deleteDelivery` (~`:437-451`); `rc-out/actions.ts` (~`:9-29`). Contrast the resolve actions which *do* check `PRIVILEGED_ROLES` server-side at `rc-in/actions.ts:~528-531`.
- **Fix:** add the same server-side role/permission check to the delete + bulk-delete actions. RLS (Phase 4) is the deeper backstop but this is the cheap first layer.
- **Risk:** low; make sure the privileged roles that legitimately delete still pass.

---

## Phase 1 — Documentation drift (cheap, zero behavior change, high clarity payoff)

The docs have drifted enough that they actively mislead a fresh agent. All fixes are text-only.

### DOC-1 · CLAUDE.md still describes the archived widget dashboard · ✓ VERIFIED · M
`components/widgets/`, `components/dashboard/`, and `lib/widgets/` **do not exist** (archived to `_archived/dashboard-v1/`; `/` is now the Daily Sync Digest). Yet CLAUDE.md's **Widget System**, **Adapter Layer**, **Dashboard Shell**, and **Platform Vocabulary** sections all present them as live.
- **Fix:** rewrite those sections to describe the digest reality (`app/(app)/page.tsx` → `getDigestData()` → `components/digest/*` bands). Keep the platform-vs-tenant *philosophy* but stop pointing at dead paths. Remove `components/widgets/CONTEXT.md` from the Component Context Files list.

### DOC-2 · CLAUDE.md Database Schema is stale · ✓ VERIFIED · M
- Missing ~10 live tables: `production_shifts/runs/downtime/waste`, `electricity_readings`, `truck_readings`, `flecon_bag_*`, `ingestion_watermarks`, `jarvis_*`, `pending_review`, `cenapro_*`.
- `batch_status` enum contradicts itself (lists 4 in the table row, 6 in the Enums line — real value is **6**: adds `SUNDRYING`, `SUNDRIED`).
- `batches` missing `notes`, `created_at`, `updated_at` (`notes` is read/written by blocking).
- Views/Functions lists are a small stale subset (real: ~20 views, `fn_blend_proposal`, all `view_digest_*`, `view_flecon_bag_balance`, etc.).
- **Fix:** regenerate from `types/supabase.ts`. A drafted replacement already exists in the run's `scratchpad/views_section.txt` — review and drop in.

### DOC-3 · CONTEXT.md files point at deleted files / wrong structure · ✓ partly VERIFIED · S each
| File | Drift |
|---|---|
| `app/(app)/inventory/CONTEXT.md` | `flecon-bags` route omitted from route map + submodule catalog (violates the project's own STRICT update rule). |
| `app/(app)/inventory/rc-in/CONTEXT.md` | claims a `page.tsx` redirect stub — **there is no `page.tsx`** (confirmed); tab-behavior section names a Blocking tab that no longer exists. |
| `app/(app)/inventory/rc-out/CONTEXT.md` | same phantom `page.tsx`; "mirrors `blocking-lazy-tab.tsx`" — that file is deleted; stale price-source note. |
| `app/(app)/inventory/blocking/CONTEXT.md:~35` | references deleted `blocking-lazy-tab.tsx`; Blocking is a standalone route now, not a tab. |
| `app/(app)/inventory/rc-movement/CONTEXT.md:~148` | "the Movement tab mounts this matrix" — it's a standalone route. |
| `app/(app)/CONTEXT.md` | open-blocks position/filter wrong (now **IN-USE only**, rendered at top); no `BagInventory` band; `DigestData` contract outdated. |
| `app/(app)/jarvis/CONTEXT.md` | says UI lives in `app/(app)/jarvis/` — it's in `components/jarvis/`, mounted via `app-shell.tsx`. |
| `app/(app)/production/CONTEXT.md:~102,104` | stale "pending rewrite" TODOs — the Daily tab was rebuilt 2026-05-28. |
| `app/(app)/admin/CONTEXT.md:13` | redirect target `/inventory/rc-in` → actually `/inventory`. |
| `components/NAVBAR.md` | missing `/summaries`, five `/price-demos`, and `flecon-bags` breadcrumb entries. |
| `components/NOTIFICATIONS.md` | delivery URLs documented as `/inventory/rc-in?...` — code emits `/inventory?...`. |
| `components/digest/` | **has no CONTEXT.md at all** — create one (module is >3 files / 200 lines). |

### DOC-4 · Stale user-facing copy & in-code comments · map-only · XS each
- `app/(app)/cenapro/page.tsx:5-7,18-22` — says "read-only views over the Excel workbook"; both screens are now **editable** (the app is the maintaining file).
- `app/(app)/price-demos/page.tsx:~119` — "no backend wiring yet"; demo4 is live and feeds `/summaries`.
- `components/navbar.tsx:~68` — `/settings` described as "Manage user roles and permissions"; it only shows a profile card.
- In-code: `open-blocks.tsx:~40` + `lib/digest/types.ts:~237-238` still say "(STORED / IN-USE)" after the IN-USE-only change.

---

## Phase 2 — Redundancy → universalize (the primary goal)

### DUP-1 · `fetchAll` pagination helper copy-pasted in 4 files · ✓ VERIFIED · S · **[x] DONE**
The 1000-row `.range()` loop is re-implemented in `app/(app)/inventory/page.tsx`, `rc-out/actions.ts`, `flecon-bags/actions.ts`, `rc-movement/actions.ts` (one `.range()` each, confirmed).
- **Fix:** extract one `fetchAllRows(query)` into `lib/supabase/paginate.ts`; replace all four.
- **DONE:** Created `lib/supabase/paginate.ts` — `fetchAllRows<T>(buildQuery: (from, to) => PromiseLike<{data,error}>, pageSize=1000): Promise<T[]>`. The builder applies `.range(from, to)` itself; the helper THROWS on the first page error, same early-exit (short page). All four sites now delegate: page.tsx calls it directly; rc-out + flecon wrap it in a thin local `fetchAll` that catches the throw (rc-out returns partial/empty = its old swallow contract; flecon returns `{rows, error}` = its old surfaced-error contract); rc-movement's local `fetchAll` delegates straight through (its throw still becomes the action's `empty` fallback). Zero local pagination loops remain in the four files.

### DUP-2 · Price-gate rule written 4 different ways · ✓ VERIFIED · S · (security-adjacent) · **[x] DONE**
14 call sites correctly use canonical `canViewPrices()` — but 5 sites hand-roll the rule:
- `rc-in/actions.ts:349`, `:738` → `role === 'Production'`
- `blocking/actions.ts:57`, `:128`, `:220` → `role !== 'Production'`
- **Risk today:** all go through `getUserRole()` so impersonation is respected — but adding a second price-denied role to `PRICE_DENIED_ROLES` (`lib/auth.ts`) would **silently miss these 5**.
- **Fix:** replace the 5 inline compares with `roleCanViewPrices(role)` / `canViewPrices()`. Single source of truth.
- **DONE:** blocking's 3 `role !== 'Production'` → `roleCanViewPrices(role)` (import already present). rc-in's 2 `isProduction = role === 'Production'` (getDeliveryHistory / getAuditLogEntry cost-scrubbing) → `!roleCanViewPrices(role)` (added `roleCanViewPrices` import). Behaviour identical today (Production is the only price-denied role). Grep confirms zero `=== 'Production'` / `!== 'Production'` price compares outside `lib/auth.ts` (remaining matches are explanatory comments only).

### DUP-3 · Three near-identical frozen-pane matrices · map-only · L (design task) · **[ ] DEFERRED** (own scoped effort; not part of this Phase-2 quick-wins pass)
`rc-movement/rc-movement-matrix.tsx`, `flecon-bags/components/flecon-bags-view.tsx`, `cenapro/production/production-ledger-grid.tsx` all reimplement the frozen-column/header/corner matrix (CLAUDE.md already names them as the reference implementations).
- **Fix:** design a shared `<FrozenMatrix>` primitive in `components/shared/`. Biggest, highest-value universalization — but treat as its own scoped design effort, not a quick edit.

### DUP-4 · Block-loc validation duplicated · map-only · S · **[x] DONE**
The ~60-line block-loc + occupied-location validation appears twice in `rc-in/actions.ts` (~`:68-140` and `~:204-263`).
- **Fix:** extract a `validateBlockLoc()` helper (candidate: `lib/validation.ts`, which already validates the grid).
- **DONE:** Extracted a **module-scope** `validateBlockLocsForRows(rows): Promise<string[]>` in `rc-in/actions.ts` (NOT lib/validation.ts — the occupied check queries `deliveries`/`batches` and is rc-in-specific; lib/validation.ts keeps its pure format-only role, no third notion of validity). Both `submitBulkDeliveries` and `bulkUpdateDeliveries` now call it. Preserved exactly: returns ALL errors at once, occupied-check is NON-FATAL on query error (proceeds with format errors only), 1-based row numbers. Normalized both call sites to `normalizeBlockLoc` (submit previously used inline `trim().toUpperCase()` — semantically identical).

### DUP-5 · Peso/kg/lab formatters duplicated across `format.ts` files · map-only · S · **[x] DONE (scoped)**
- **Fix:** consolidate into `lib/format-utils.ts`; import everywhere.
- **DONE:** The true cross-file duplicate — the round-and-group `fmtKg` + accounting `fmtPhpNumber` — is now single-homed in `lib/format-utils.ts` (added `fmtKg`/`fmtPhpNumber` alongside the existing `formatCurrency`/`formatWeight`/`formatCompact`/`formatLabValue`). `components/digest/format.ts` re-exports them (its 7 importers unchanged) and keeps its digest-specific `fmtKwh`/`fmtByUnit`/`fmtDeltaPct`/`relativeTime`/`diffValue`.
- **Left un-unified ON PURPOSE (different semantics, documented in `format-utils.ts`):**
  - `formatWeight()` — no `Math.round`, uses `toLocaleString(max:0)` half-to-even rounding (2.5 → "2" vs `fmtKg` 2.5 → "3"). Distinct.
  - `formatCurrency()` — prefixes the `₱` glyph; `fmtPhpNumber` is number-part-only. Distinct.
  - The **blank-on-zero** `fmtKg` locals in `rc-movement/rc-movement-matrix.tsx` and `cenapro/inventory/flec-inventory-client.tsx` — return `''` for 0/empty so dense grids show blank cells (a deliberate presentation choice). Unifying them would change table rendering, so NOT touched.
  - `_shared/blend-proposal-pdf.ts`'s local `fmtKg` — omits the `'en-US'` locale for PDF locale-safety; left as-is to avoid altering generated PDF output.

### DUP-6 · `UserRole` type defined twice · ✓ VERIFIED · XS · **[x] DONE**
Identical union in `types/auth.ts:1` and `components/providers/auth-context.tsx:7`.
- **Fix:** import from `types/auth.ts`; delete the duplicate.
- **DONE:** `auth-context.tsx` now `export type { UserRole } from '@/types/auth'` (+ a local `import type` for its own use). 6 files import `UserRole` from auth-context — all keep working via the re-export; `types/auth.ts` is the single definition.

### PURITY-1 · Platform provider imports a tenant action · ✓ VERIFIED · M · **[x] DONE**
`components/providers/table-settings.tsx` is mounted globally (`providers/index.tsx`) yet imports `saveTableSettings` from `@/app/(app)/inventory/rc-in/actions` (`:6`) and hardcodes the `rc_in_table_settings` localStorage key — tenant knowledge inside platform infrastructure.
- **Fix:** generalize the provider (settings keyed by table id) or move it into the RC-IN module. Lower urgency than the leaks, but it's the clearest layer-purity violation.
- **DONE:** Moved `getTableSettings`/`saveTableSettings` to the neutral `lib/actions/table-settings.ts` (`'use server'`, identical DB writes to `user_table_settings` keyed by `(user_id, module)`). NOTE: a `'use server'` file can't re-export server actions, so rc-in/actions.ts no longer defines them and `app/(app)/inventory/page.tsx` imports `getTableSettings` straight from the neutral module. The provider now takes a `tableId?` prop (default `'rc_in'` → existing mount in `providers/index.tsx` unchanged); `tableId` drives both the `module` write key and the `${tableId}_table_settings` localStorage key. Public `useTableSettings()` hook API unchanged. Provider no longer imports any tenant code.

### CLEAN-1 · Dead code to delete · ✓ partly VERIFIED · XS · **[x] DONE**
- `app/(app)/inventory/rc-in/error.tsx` + `loading.tsx` — orphaned (no `page.tsx` / route segment). ✓ → **DELETED** (no route segment, so Next never wired them).
- `app/(app)/settings/components/RoleAssignmentTable.tsx` + the duplicate `updateUserRole` in `settings/actions.ts` — zero importers. map-only → **DELETED both** (`RoleAssignmentTable` had no importer; settings `updateUserRole` was only used by it — the LIVE `updateUserRole` lives in `admin/actions.ts`). `settings/actions.ts` became empty so the whole file was deleted. `SignOutButton.tsx` kept (still used by settings/page.tsx).
- `lib/supabase.ts` (legacy untyped anon client) — zero importers. map-only → **DELETED** (grep confirmed zero importers).
- `components/floating-status-bar.tsx:127-185` — hardcoded **Next.js logomark SVG** leftover; remove/replace with real branding. ✓ → **REMOVED** the logomark SVG + its leading `|` separator; bar layout otherwise untouched (no redesign).

---

## Phase 3 — Performance (behavior-sensitive; test each)

### PERF-1 · Whole-history loads · map-only · M–L · **[/] PARTIAL — safe part verified, rest needs product decision**
`fetchRcOutTabData` loads *every* `rc_out` row ever; `/inventory` loads a full year of deliveries into the RSC payload. Virtual scroll hides render cost but network/memory grow unbounded with history.
- **Fix:** server-side pagination or tighter default window; keep virtual scroll. **Respects scope constraint** (presentation only).
- **DONE / verified — nothing changed, because the safe bound already exists and the rest can't be bounded without a UX change (HARD CONSTRAINT):**
  - **Current scale is tiny:** `rc_out` = 2,010 rows, `deliveries` = 1,631 rows (whole history, 2024→2026). Neither load is a user-perceptible problem today; the concern is future growth (~800 rc_out rows/yr).
  - **`/inventory` (deliveries) is ALREADY windowed on first paint.** The RSC fetch is scoped to a single `year` (URL param, defaults to the **current year** via `new Date().getFullYear()`). The only unbounded paths are the *explicit user actions* `?year=all` and `?search=…` — the operator asked for all years / all matches, so loading them is correct. There is no additional safe bound to add; the default window is already the fix. **User sees NOTHING different.**
  - **`fetchRcOutTabData` (rc_out) genuinely needs full history client-side and CANNOT be window-bounded without a UX change.** `rc-out-table.tsx` holds `allData` (full history) and does ALL filtering client-side, including a **Year filter whose checkbox options (`yearOptions`) are derived from every year present**, plus cross-history Batch/State/Plant/BlockLoc filters and totals. Bounding the fetch to a recent window would silently drop old years from the year filter and change what the operator can reach — exactly the "cross-history data genuinely needed client-side" case the audit calls out. Per the HARD CONSTRAINT I did **not** force a bound.
  - **Needs product decision (deferred, not forced):** if rc_out grows enough to matter, the UX-preserving path is server-driven year pagination — fetch distinct years once (cheap) for the filter options, then fetch only the selected year(s) on demand, keeping virtual scroll. That reshapes the data flow (client filter → server round-trip) and IS a behavior change to how the table loads, so it needs sign-off before building.

### PERF-2 · Monster client components · ✓ VERIFIED · L (ongoing) · **[ ] DEFERRED** (file splitting — intentionally out of this Phase-3 pass)
Confirmed sizes: `delivery-master-table.tsx` 2300, `supplier-brief-client.tsx` 2287, `daily-ledger-grid.tsx` 2180, `production-daily-block.tsx` 2178, `rc-out-table.tsx` 1431, `blocking-grid.tsx` 1255, `blocking-detail-panel.tsx` 1127.
- **Fix:** split incrementally (extract hooks/subcomponents). Not urgent; do opportunistically when touching each.

### PERF-3 · Non-transactional N+1 bulk mutations · map-only · M · **[x] DONE**
`bulkUpdateDeliveries` (`rc-in/actions.ts:~271-309`) and `bulkUpdateUsage` (`rc-out/actions.ts:~62-99`) do per-row sequential round trips (RPC → update → lookup → insert); a mid-loop failure leaves earlier rows committed with no rollback.
- **Fix:** batch into a single RPC/transaction. Data-integrity relevant — worth doing.
- **DONE:** Migration `20260703022707_fn_bulk_update_transactional.sql` (applied to the linked remote via MCP) adds **`fn_bulk_update_deliveries(rows jsonb)`** + **`fn_bulk_update_usage(rows jsonb)`** — SECURITY **INVOKER**, `SET search_path = public`, `REVOKE EXECUTE … FROM anon` + `GRANT … TO authenticated` (no new SECURITY DEFINER surface). Each takes a jsonb array of `{id, data, comment}` and applies every partial update inside ONE transaction (all-or-nothing). The partial-update is a `jsonb_populate_record(row, to_jsonb(row) || data)` merge = the exact PostgREST `.update(payload)` semantics (only supplied keys change). **Audit fidelity preserved:** the `deliveries` AFTER trigger `log_delivery_changes` still fires per row so `audit_logs` come out byte-for-byte identical (verified: an update produced the same per-key diff `{col:{old,new}}` + `snapshot=NEW`); `rc_out` has NO audit trigger, so the RPC reproduces the old glue (set the `app.audit_comment` GUC, then attach the edit remark to the record's latest existing `audit_log`). Rewrote both server actions to build the payload in JS (same `toDeliveryPayload` transform + block-loc validation) and call the RPC once. Types regenerated (`fn_bulk_update_*` emitted). **Verified end-to-end via MCP** on a throwaway row: partial update correct, audit_logs identical, and an intentional bad-id second row rolled back the whole batch (proving atomicity); test data cleaned up. `tsc` + `npm run build` both pass.

### PERF-4 · Confirm `jspdf` is dynamically imported · ✓ found static import · S · **[x] DONE**
`jspdf` + `jspdf-autotable` are statically imported in `app/(app)/inventory/_shared/blend-proposal-pdf.ts:21-22`.
- **Fix:** verify the *call site* `import()`s `blend-proposal-pdf` lazily so the PDF libs don't ship in the main bundle; if not, make it dynamic.
- **DONE:** The sole importer (`_shared/blend-proposal-dialog.tsx`, a client component) had a **static** top-level `import { downloadBlendPdf, composeBlendPdfFilename } from './blend-proposal-pdf'` — so jsPDF shipped eagerly in the blocking bundle. But the dialog needs `composeBlendPdfFilename` **synchronously** every render (live filename preview + Download-enabled gate), which pinned the whole module. Fix: split the jspdf-FREE filename helpers (`composeBlendPdfFilename`/`sanitizeLabel`) into new **`_shared/blend-proposal-filename.ts`** (imported statically — cheap, date-fns only), and load the heavy `downloadBlendPdf` **lazily via `await import('./blend-proposal-pdf')` inside the Download-click handler** (`handleDownloadPdf` is now async). `blend-proposal-pdf.ts` re-exports the filename helpers for its node/test path. **Verified in the production build:** jsPDF now lives in its own async chunk (~442 KB) that is **NOT** in `app-build-manifest.json`/`build-manifest.json` (i.e. lazy, loaded on click) instead of the eager route bundle.

---

## Phase 4 — Database / RLS hardening (217 advisors) · **[x] DONE (Steps 1–4 shipped; 5 = evidence-based no-op; 6 = manual)**

**Plain:** the database mostly trusts the app to behave rather than enforcing rules at the data layer itself. Real-world risk is **low** (invite-only, single organization; the Python sync writes with a service-role key that bypasses RLS anyway, so enabling RLS **won't break ingestion**). The price boundary is enforced server-side in the app (`canViewPrices()`); RLS is the *org* boundary. Fixed in 7 phased migrations, verifying an `authenticated`-role read (and, where relevant, a write) after EACH on the live remote DB.

**Migrations shipped (2026-07-03, all applied + on disk in `supabase/migrations/`):**
1. `20260703023945_phase4_enable_rls_production_tables.sql`
2. `20260703024226_phase4_invoker_delivery_analytics_views.sql`
3. `20260703024300_phase4_invoker_rc_movement_views.sql`
4. `20260703024338_phase4_invoker_digest_flecon_production_views.sql`
5. `20260703024510_phase4_pin_function_search_path.sql`
6. `20260703024718_phase4_revoke_anon_access.sql`
7. `20260703024907_phase4_revoke_public_execute_on_definer_funcs.sql` + `20260703025033_phase4_regrant_is_admin_execute_for_rls.sql` (correction pair)

**Before → after advisor counts:**

| Advisor | Before | After | Status |
|---|---|---|---|
| `rls_disabled_in_public` (ERROR) | 7 | **0** | **[x] DONE** — RLS enabled on all 7. The 6 production/electricity/truck tables got the rc_out 4-policy shape (authenticated SELECT/INSERT/UPDATE/DELETE, all `true`); `ingestion_watermarks` got RLS with **no** policy (app never touches it — only the service-role sync writes it). |
| `security_definer_view` (ERROR) | 26 | **0** | **[x] DONE** — all 26 flagged views → `security_invoker`, in 3 family migrations, each verified with a live `authenticated` SELECT. Every underlying table was confirmed to have authenticated GRANT SELECT + a permissive SELECT policy first (the flecon-L trap). `view_rc_in_master` is DEFINER but was **NOT** advisor-flagged → left as-is (out of scope). |
| `function_search_path_mutable` (WARN) | 12 | **0** | **[x] DONE** — pinned `SET search_path = public` on all 12 (not `''`, because `handle_audit_log`/`log_delivery_changes` reference unqualified public objects — `= public` keeps bodies untouched). Verified the audit trigger chain still writes `audit_logs`. |
| `anon_security_definer_function_executable` (WARN) | 14 | **0** | **[x] DONE** — the real fix was `REVOKE EXECUTE … FROM PUBLIC` (an initial `FROM anon` was a no-op: EXECUTE was a PUBLIC grant anon inherited). |
| `authenticated_security_definer_function_executable` (WARN) | 14 | **1** | **[x] DONE (accepted)** — the `FROM PUBLIC` revoke also cleared authenticated for 13. The remaining **`is_admin`** is a LOAD-BEARING grant: RLS policies on `pending_review` + `profiles` call `is_admin(auth.uid())`, and policy evaluation requires the caller to hold EXECUTE even on a SECURITY DEFINER function. Revoking it broke an admin UPDATE in testing (`ERROR 42501: permission denied for function is_admin`) → re-granted to authenticated. Accepted risk. |
| `pg_graphql_anon_table_exposed` (WARN) | 49 | **0** | **[x] DONE** — `REVOKE ALL/SELECT FROM anon` on the 38 flagged public objects + the 10 `cenapro.*` objects. anon reads confirmed denied; authenticated reads confirmed intact (cenapro accessors run as authenticated, which keeps its cenapro grant). No pre-login anon usage exists (middleware walls all but /login,/auth,/api; there is no app/api; auth callback reads via service-role + writes only post-session). |
| `pg_graphql_authenticated_table_exposed` (WARN) | ~73 | **73** | **[x] ACCEPTED — intentional.** These are the INTENDED authenticated org-member reads (invite-only single org). Nothing revoked from `authenticated` this phase, by design. |
| `rls_policy_always_true` (WARN) | 21 | **39** | **[/] EVALUATED — no safe tightening (see Step 5 below).** Count rose because enabling RLS on the 6 production tables added their (intended) always-true write policies. |
| `rls_enabled_no_policy` (INFO) | 0 | **1** | **[x] INTENTIONAL** — `ingestion_watermarks` (service-role-only; deny-by-default for anon/authenticated is correct). |
| `auth_leaked_password_protection` (WARN) | 1 | **1** | **[ ] MANUAL — Renzo dashboard step (Step 6).** No MCP tool and no safe CLI path in this environment (no local `supabase/config.toml`, no Management API token; synthesizing + `config push` would risk clobbering dashboard-only auth settings). **Action:** Dashboard → Authentication → Providers → Password → enable **"Leaked password protection"** (HaveIBeenPwned). Pro plan required. |

**Step 5 — always-true write policies: evaluated, LEFT permissive with evidence (no migration).** Per the "tighten only where provably safe" rule, each flagged write policy was traced to its real app path:
- **`audit_logs` UPDATE** — LEFT permissive. The advisor's own sample suggests scoping to `is_admin`, but `requestResolveAuditLog` (`rc-in/actions.ts:545`) lets ANY authenticated user UPDATE `audit_logs` (to request a resolve) — verified a Production user's UPDATE succeeds today. Scoping to admin would break that feature. Accepted: server actions are the enforcement layer (the privileged `resolveAuditLog`/`approveResolveRequest` paths gate on `PRIVILEGED_ROLES` server-side).
- **`notifications` UPDATE** — already correctly scoped to `auth.uid() = user_id` (not flagged); only its INSERT is always-true and is unused by the app (notifications are created by the `_insert_notification` SECURITY DEFINER trigger). Left as-is (no app write path to tighten).
- **`profiles` UPDATE** — already scoped (`id = auth.uid()` for own row; `is_admin(auth.uid())` for admins). Only the `Service role can insert profiles` INSERT is always-true and unused (profiles are created by the `handle_new_user` trigger; service_role bypasses RLS). Left as-is.
- **`deliveries` / `batches` / `rc_out` / `flecon_*` writes** — LEFT always-true. Written by many authenticated roles; server actions (+ the new PERF-3 transactional RPCs) are the enforcement layer today. Accepted risk, documented.

**Verification discipline:** every migration was verified live as `set local role authenticated` (and `anon` for the revokes) inside a rolled-back transaction; the RLS-policy `is_admin` regression was caught by exercising the actual admin UPDATE path and fixed before proceeding. Types regenerated; `tsc --noEmit` clean.

---

## Phase 5 — Viewing / manipulation improvements (least-covered; assessment only)

_The dedicated "viewing-modes" audit agent never ran, so these are my synthesis from the maps, not verified findings — treat as proposals to discuss, all within the scope constraint (present/manipulate ingested data; never change operator recording)._

- **Unify the three grids (ties to DUP-3):** one `<FrozenMatrix>` gives RC Movement, Flecon Bags, and Cenapro the *same* keyboard nav, inline edit, and paste behavior — consistency + less code.
- **History-aware loading (ties to PERF-1):** month/period-scoped server pagination so heavy tables stay fast as years accumulate.
- **Digest drill-down:** the home digest is read-only; each band could deep-link into its source module filtered to that date/block (some already do — make it uniform).
- **Consolidate demo→prod:** graduate `price-demos/demo4`'s data layer into `summaries/` so a permanent feature stops importing from a `price-demos` folder.

---

## Suggested execution sequence

1. **Phase 0** (SEC-1, SEC-2, SEC-3) — small, real, ship as one security PR.
2. **Phase 1** (all docs) — one docs PR; unblocks every future agent.
3. **Phase 2 quick wins** — DUP-1, DUP-2, DUP-6, CLEAN-1 (all XS–S) in one cleanup PR; DUP-3/PURITY-1 as their own scoped tasks.
4. **Phase 3** — PERF-3 then PERF-1 when history growth bites; PERF-2 opportunistically.
5. **Phase 4** — phased migration series, lowest urgency, test-per-step.
6. **Phase 5** — design discussion before any of it becomes work.

_No code has been changed. This document is the plan only._
