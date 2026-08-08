# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Platform Philosophy

**Blackwood is a general-purpose modular BI platform, not a charcoal plant tool.** Charcoal plant operations (RC IN, RC OUT, Blocking) are the first tenant on the platform — a real-world proof of concept. The platform itself must remain genuinely open to any inventory or operational domain without a rewrite.

**Inspiration: Grafana's data source model.** Grafana itself does not store data. It acts as a visualization and interaction layer, pulling information from selected data sources. Every data source emits a normalized data frame. Visualizations consume frames, never raw queries. Blackwood follows the same model: widgets consume normalized, data-agnostic interfaces (`ChartConfig`, `KPIData`, etc.) — never raw Supabase queries.

**Architecture: Hexagonal (Ports & Adapters).** The widget is the application core. The "port" is the typed interface it declares (`ChartConfig`, `KPIData`, `ScatterPoint[]`). The "adapter" is whoever fills it — today a static mock adapter, tomorrow a live Supabase adapter. The widget is permanently isolated from the adapter. This vocabulary is canonical throughout the codebase.

**Layer separation rule:** If code lives in `components/shared/`, `components/ui/`, `components/providers/`, or the navbar/shell chrome, it is **platform code** — zero tenant knowledge allowed. If it lives in `app/(app)/inventory/`, `app/(app)/production/`, `app/(app)/cenapro/`, `components/digest/`, or `lib/digest/`, it is **tenant code** — domain-specific is expected and correct. Never add domain/tenant knowledge to platform-layer components.

**Two coexisting UX paradigms:**
- **Home Digest (`/`):** The Daily Sync Digest — a read-focused briefing page of dense bands (KPIs, charts, open blocks, bag inventory, sync activity). High information density, visual-first. **Tenant-shaped presentation** over the platform's SQL-view adapter pattern.
- **Inventory pages (`/inventory/...`):** Industrial Spreadsheet — dense, keyboard-navigable tables that feel like Excel but enforce data integrity underneath. These stay as dedicated pages forever. **Tenant/domain layer.**

## Platform Vocabulary

| Term | Meaning |
|------|---------|
| **Platform layer** | Source-agnostic, domain-neutral infrastructure: providers, the shared Blackwood Table grid primitive, navbar/shell. Zero tenant knowledge allowed. |
| **Domain module** | RC IN, RC OUT, Blocking, RC Movement, Production, Flecon Bags — charcoal-specific. The first tenant on the platform. |
| **Tenant** | An organization/domain using the platform. Blackwood/ICTC charcoal is Tenant #1; Cenapro (CI/Cebu) is Tenant #2 (own `cenapro` schema/module). Domain modules and business logic are always tenant-specific. |
| **Data-agnostic interface** | The typed contract a presentation component accepts (e.g. the digest's `DigestData` bands, or a future widget's `ChartConfig`). Equivalent to Grafana's "data frame." |
| **Adapter** | Pure function — transforms a data source's raw output (a Supabase view/query) into a normalized, presentation-ready shape. The digest's `lib/digest/queries.ts` (`getDigestData()`) is the live adapter today. |

> **Historical note:** the platform's first UX experiment was a composable **widget dashboard** (Grafana-style: `components/widgets/`, `components/dashboard/`, `lib/widgets/` mock/live adapters). That system is **archived at `_archived/dashboard-v1/`** and no longer live — `/` is now the Daily Sync Digest (see the **Home Digest** section below). The platform-vs-tenant philosophy and the Grafana data-source framing above still govern all future work; only the widget implementation was retired.

## Project Timeline (MANDATORY READ)

**Before starting any work session, read `TIMELINE.md` at the project root.** It is the single source of truth for what phase the project is in, what's been completed, and what's next. Update it whenever you complete a task, start a new phase, or the scope changes.

- **Current sprint** is always documented at the top of `TIMELINE.md`
- **Phase doneness** is tracked via checkboxes (`[x]` done, `[/]` in progress, `[ ]` not started)
- **Definition of Done** at the end of each phase defines completion criteria
- **Changelog** at the bottom records all timeline updates with dates

## Handoff Files (MANDATORY READ AT SESSION START)

**Session-handoff files live in `handoffs/` at the project root.** Each file captures what happened in one session — concrete deliverables, key learnings, the current state of the codebase, open decisions, and the next concrete action.

**When the user says "view latest handoff file", "where did we leave off", or "what's the current state":**
```bash
ls handoffs/ | sort -r | head -1
```
The YYYY-MM-DD prefix on each filename makes alphabetical sort equivalent to chronological. The first result is the most recent handoff — read it before doing anything else.

**Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md` (e.g. `2026-05-26-rc-movement-backfill-jarvis-foundation.md`). One file per session. Never delete old handoffs — they form the project's session history.

**When ending a session,** create a new handoff file capturing: TL;DR, what shipped (with file paths), critical learnings, current state, open decisions, and the next concrete action. Use the most recent handoff as a template — same section structure.

## Skills

This project uses the **`frontend-design`** skill for UI and design guidance. When planning frontend features, designing UI components, or reviewing code quality, Claude will reference this skill for best practices on:
- Next.js App Router patterns and Server Components
- shadcn/ui component composition and Tailwind CSS
- Information-dense UI design (Notion/Raycast aesthetic)
- TypeScript and Supabase architecture patterns

**Reference the skill:** When working on frontend UI and design, Claude will automatically consult this skill for architectural decisions and component patterns.

## Commands

```bash
npm run dev      # Start dev server (Next.js)
npm run build    # Production build
npm run lint     # ESLint
npm run start    # Start production server
```

No test framework is configured.

## Stack

- **Next.js 16** (App Router) with React 19 and TypeScript (strict mode)
- **Supabase** (PostgreSQL) — clients in `lib/supabase/` (`client.ts` browser, `server.ts` per-request RSC/actions, `admin.ts` service-role), env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Shadcn UI** (new-york style, zinc base) with Radix primitives in `components/ui/`
- **TanStack Table** for data tables, **date-fns** for dates, **cmdk** for command menus
- **Tailwind CSS v4** with dark mode support via CSS variables
- **next-themes** for dark mode toggling and persistence

## Theming

- **Dark mode** is powered by `next-themes` (`ThemeProvider` in `components/providers/theme-provider.tsx`)
- CSS variables in `globals.css` — `:root` for light, `.dark` for dark
- `next-themes` adds/removes `.dark` class on `<html>` and persists the user's choice to **localStorage** automatically
- **Always use semantic tokens** (`bg-primary`, `text-muted-foreground`, `bg-card`, `border-border`, etc.) — not hardcoded colors like `bg-white` or `text-black`
- The navbar is always dark-themed: `bg-zinc-800` (light) / `dark:bg-zinc-700` (dark mode) — it intentionally stays dark in both modes but shifts one shade lighter in dark mode to maintain contrast against the `zinc-950` background
- Footer sliding indicators use `bg-zinc-800 dark:bg-zinc-200` to invert properly

## Architecture

**Data flow:** User Action → Client Component → Server Action → Supabase → `revalidatePath()` → Re-render

- **Server Components** (`page.tsx`) handle data fetching with direct Supabase queries
- **Client Components** (`'use client'`) handle interactivity (forms, tables)
- **Server Actions** (`actions.ts`) handle all mutations, always call `revalidatePath()` after writes
- **URL search params** drive filters, pagination, and navigation state (not React state)

**Path alias:** `@/*` maps to project root.

**Client/server module boundary trap:** a client-safe pure module (e.g. `components/sync/cases/grouping.ts`) must NEVER import from a server-heavy sibling — even for a single constant. Importing `lib/investigator/triage.ts` for `TRIAGE_KIND` drags the Anthropic SDK + admin client into the client bundle and breaks `npm run build`. Duplicate the constant locally and add a verify-script assertion that the copies match (see `scripts/verify-case-grouping.ts`).

**Two-layer data flow:**
- **Platform layer (widgets):** Widget → data-agnostic interface (`ChartConfig`, `KPIData`) → adapter fills interface → widget renders. Widget has zero knowledge of Supabase, charcoal, or any domain.
- **Domain layer (inventory modules):** User Action → Client Component → Server Action → Supabase → `revalidatePath()` → Re-render. This is the tenant-specific CRUD layer.

## Database Schema (Supabase)

Auto-generated TypeScript types live in `types/supabase.ts` — **never hand-edit this file**, regenerate with `/supabase` workflow or:
```bash
supabase gen types typescript --linked > types/supabase.ts
```

### Core inventory tables (`public`)
- **`batches`** — `id`, `batch_code` (unique), `location_ref`, `status` (`batch_status` enum), `avg_cost`, `current_weight`, `quality_stats` (JSONB), `notes`, `created_at`, `updated_at`
- **`deliveries`** — `id`, `transaction_date`, `supplier`, `batch_code` (FK→batches), `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`, `remarks`, `lab_results` (JSONB: mc/ash/bd_astm/bd_jis/grit/vm/fc), `true_weight_kg` (nullable — physical/gross weight before ASH+wet deductions; display-only, NULL = no deduction, never used in any balance/view/trigger), `deduction_note` (nullable text — short human note, e.g. '−5.86% ASH; −1,009 wet'; display-only), `created_at`, plus the **human-edit latch** (2026-08-08): nullable `human_edited_at` + `human_edited_by` (FK→profiles), the same pair the six production fact tables carry, set by the same `fn_stamp_human_edit` BEFORE INSERT/UPDATE trigger on any write with an `auth.uid()`. A latched delivery is **never updated by the sync** — see "Deliveries — the human-edit latch" below
- **`rc_out`** — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`. (Replaced the legacy `usage` table; FK constraint keeps the historic `usage_batch_id_fkey` name.) Computed columns: `rc_out_avg_price`, `rc_out_avg_wtd_value`
- **`deliveries_archive`** — the **undo** for any row removed from `deliveries` (2026-08-07, built for the duplicate cleanup below). `archive_id` (PK), `archive_batch_id` (**groups one logical operation, so a whole cleanup reverts in ONE call**), `delivery_id` (the ORIGINAL `deliveries.id` — deliberately **NOT** a FK, since the referenced row is gone by design), `row_snapshot` (jsonb, `to_jsonb(deliveries.*)` — **THE restore payload**, so the archive keeps working when `deliveries` gains a column), `context` (jsonb — the state a delete/restore CANNOT reconstruct: the owning `batches` row incl. `quality_stats`, the batch's delivery/rc_out totals before the removal, the row's latest `audit_logs` id), `archive_reason` (NOT NULL, non-blank CHECK), `archived_at`/`archived_by`, `restored_at`/`restored_by`, plus readable copies of the row (`transaction_date`, `supplier`, `batch_code`, `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`) for querying by hand. A CHECK ties `row_snapshot->>'id'` to `delivery_id` so a snapshot can never describe a different row than the one it claims. **Nothing is ever deleted from it** — an archive is not a queue, and a restored row keeps its archive entry. RLS on with a SELECT-only policy for `authenticated` (no INSERT/UPDATE/DELETE policy at all, so a client role can neither forge nor erase an entry); the SECURITY DEFINER functions below are the only writers. **`cost_basis` and `row_snapshot` carry ₱** — any server action exposing this table is subject to `canViewPrices()`. **Why this and not `audit_logs`:** the delete trigger already snapshots into `audit_logs`, so a deleted delivery was never *unrecoverable* — but recovering it meant hand-rebuilding an INSERT from JSONB buried in a table the audit UI pages through, and the unit of revert for a bulk cleanup is *the whole operation*, not one row.

### Production PLAN (`public`) — the schedule, human-editable master (Phase A, 2026-07-30)
- **`production_schedule`** — one row per calendar day, PK `plan_date`. `year`, `month`, `dow`, `shifts`, `setup`, `projected_tons`, `grades` (JSONB), `remarks`, `source`, `updated_at`, plus the **ownership** columns: `owner` (`joseph` | `gsheet` | `human` | `actual`, NOT NULL default `gsheet`, CHECKed), `source_rev`, `pending_upstream` (JSONB), `row_version` (int NOT NULL default 1), `human_edited_at`, `human_edited_by` (FK→profiles). **Nothing may write this table unconditionally** — see "Production schedule ownership" below.

### Production tables (`public`) — ingested by the `production-manager` employee
All six carry the **human-edit latch** (2026-08-03): nullable `human_edited_at` + `human_edited_by` (FK→profiles), set by the `fn_stamp_human_edit` BEFORE INSERT/UPDATE trigger on any write with an `auth.uid()`. A latched row is **never updated by the sync** — see "Production FACTS — the human-edit latch" below.
- **`production_shifts`** — parent; one row per `(transaction_date, production_batch, shift)`. `production_runs`/`production_downtime`/`production_waste` all FK to it via `shift_id`.
- **`production_runs`** — daily output by grade/shift. `customer`, `grade`, `ttl_kg`, `sacks_bags`, `remarks`, `shift_id`.
- **`production_downtime`** — per-shift downtime. `dt_hrs`, `dt_mins`, `dt_reason`, `shift_hrs`, `shift_id`.
- **`production_waste`** — 8-stream waste per shift. `bf_kg`, `grit_kg`, `rs1a_kg`/`rs1b_kg`/`rs23_kg`/`rs5_kg`, `trml1_kg`/`trml2_kg`, `remarks`, `shift_id`.
- **`electricity_readings`** — daily meter readings. Natural key `(reading_date, meter)`. `start_kwh`, `end_kwh`, `diff_kwh` (computed), `consumption_kwh`, `meter_multiplier`, `remarks`.
- **`truck_readings`** — daily odometer + fuel. Natural key `(reading_date, plate_no)`. `start_km`, `end_km`, `ttl_km` (computed), `fuel_liters`, `remarks`.

### FLECON bag inventory (`public`) — ingested by the `bagging-manager` employee
- **`flecon_bag_types`** — packaging-material SKU dimension. `code`, `label`, `nickname`, `material`, `capacity_kls`, `color`, `sort_order`, `active`, `source_column`, `source_label`, `notes`.
- **`flecon_bag_opening_balances`** — per-year opening (`year`, `bag_type_id` FK, `qty`). The 2026 opening folds in all pre-2026 stock.
- **`flecon_bag_movements`** — signed movements (`qty_delta`; negative = OUT/consumed, positive = IN). `transaction_date`, `bag_type_id` FK, `particular`, `remarks`, `source_row`. No natural-key UNIQUE — sync uses replace-by-date idempotency.
- **`flecon_bag_date_settlements`** — the flecon **date-settlement ledger** (2026-07-29), sibling of `rc_out_date_settlements`. `transaction_date` (PK), `db_movement_count`, `db_net_qty`, `reason`, `settled_at`, `settled_by_run_id` (FK→`sync_runs`, `ON DELETE SET NULL`), `settled_by_audit_log_id` (FK→`audit_logs`, `ON DELETE SET NULL`), `note`. A settled date is skipped entirely by every future flecon run — no replace, **no delete**. Written only by the sync worker's `reports/flecon/index.ts::runReport` (service role) — see "Sync Integrity" below.

### Sync / ingestion infrastructure (`public`)
- **`ingestion_watermarks`** — per-report-type high-water mark. `report_type` (PK), `last_run_at`, `last_email_id`, `last_email_received_at`.
- **`pending_review`** — staged extractions awaiting human commit. `report_type`, `status`, `rows_json`/`final_rows_json`/`diagnostic_json` (JSONB), `overall_confidence`, source-email refs, `reviewed_by` (FK→profiles), `commit_audit_log_id` (FK→audit_logs).
- **`delivery_source_aliases`** — learned SPELLING VARIANTS between our RC DELIVERIES sheet and Czarina's price file (2026-08-07, L-039), so a source typo confirmed once is known forever. `kind` (`truck_plate` | `supplier`), `ours`/`theirs` (stored **already normalized** the way the matcher normalizes — plates alphanumerics-upper, suppliers `UPPER(TRIM)` — so lookup is plain equality), `ours_raw`/`theirs_raw`, `evidence` (**NOT NULL** — an alias can never exist without saying how it was earned), `confirmed_by` (FK→profiles), `first_seen_on`, `times_seen`, `active`. An alias is **EARNED, NEVER GUESSED**: written only after a match was independently corroborated (a uniqueness-gated fallback, or a human), the same discipline as the Cenapro supplier subgroups — nothing may infer one from name similarity. Unique on `(kind, ours, theirs)`; a retired pair keeps its row (`active = false`). RLS on, SELECT-only for `authenticated`; writes are service-role or via the RPC. Seeded with exactly the three pairs Renzo confirmed on 2026-08-07. Note supplier pairs are keyed on the raw `UPPER(TRIM)` spellings, **not** `canonical_supplier()` output — this table is the fallback for variants that function does NOT collapse, so storing the collapsed form would produce a degenerate `PAQUIBOT → PAQUIBOT` row saying nothing.
- **`rc_out_date_settlements`** — the rc_out **date-settlement ledger** (2026-07-12). `transaction_date` (PK), `db_sum_kg`, `movement_kg` (the two corroborating witnesses at settlement time), `settled_at`, `settled_by_run_id` (FK→sync_runs, `ON DELETE SET NULL`). Written only by the sync worker's `workflows/runSync.ts::persistSettlements` (service role) — see "Sync Integrity" below.
- **`sync_run_reports`** — the **Excel sync-report artifact ledger** (2026-08-07, migration `20260807060558`). One row per generated (or attempted) workbook: `run_id` (FK→sync_runs, `ON DELETE CASCADE`), `storage_bucket`/`storage_path`/`filename`/`bytes`, headline counts (`finding_count`, `warn_count`, `error_count`, `sheet_counts` jsonb), `contains_prices`, `generator_version`, `ok`, `error`, `generated_at`. The payload lives in the **PRIVATE `sync-reports` Storage bucket** — same pattern as `sync-inbox` (private, service-role write, zero policies) but a **separate bucket**, because `sync-inbox` holds raw SOURCE workbooks no browser may fetch while this holds a derived artifact the app deliberately hands out. A **sibling table, not columns on `sync_runs`**, because a generation FAILURE is a first-class row here (`ok=false`, `storage_path` NULL, `error` set) and because regeneration is append-friendly; `view_sync_run_reports` joins the run back in so "list the last N reports with a download link" stays ONE query. **`contains_prices` DEFAULTS TRUE — fail-closed** (see Price gating below). Written only by the worker's `reports/excel/generate.ts` (service role); `authenticated` gets SELECT only, `anon` nothing.

### Jarvis AI assistant (`public`)
- **`jarvis_conversations`** — `id`, `user_id`, `title`, `last_message_at`, `archived`, `created_at`.
- **`jarvis_messages`** — `conversation_id` (FK), `role`, `content`, `position`, `tool_calls`/`tool_results` (JSONB), `created_at`.
- **`jarvis_learnings`** — `user_id`, `type`, `content`, `source_message_id` (FK→jarvis_messages), `last_used_at`, `created_at`.

### Platform / auth / audit tables (`public`)
- **`profiles`** — `id` (FK→auth.users), `email`, `display_name`, `avatar_url`, `role`, `status` (`'active'` | `'disabled'` | `'pending'`), `created_at`, `updated_at`
- **`audit_logs`** — `id`, `table_name`, `record_id`, `operation`, `diff` (JSONB), `snapshot` (JSONB), `comment`, `performed_by`, resolve fields
- **`audit_comments`** — `id`, `audit_log_id` (FK→audit_logs), `body`, `user_id`, `resolved`
- **`notifications`** — `id`, `user_id`, `type` (`notification_type` enum), `title`, `body`, `source_user_id`, `metadata` (JSONB), `read`, `read_at`, `archived`, `created_at`
- **`notification_subscriptions`** — `id`, `user_id`, `audit_log_id` (FK→audit_logs), `created_at`
- **`user_invites`** — `email` (PK), `role`, `invited_by` (FK→profiles), `created_at`. Whitelist for invite-only access.
- **`user_table_settings`** — per-user, per-module table prefs. `user_id`, `module`, `settings` (JSONB).
- **`user_dashboard_prefs`** — `user_id` (PK), `prefs` (JSONB), `updated_at`.

### Cenapro tenant (`cenapro` schema — Tenant #2, zero ICTC coupling)
**Production side.** Dimensions: `shift`, `grade`, `plant`, `warehouse`, `source_location`, `partner_equipment`. Facts: `production_event` (CI production spine, one row per workbook Production row), `warehouse_opening_balance` (APPEND-ONLY flec-count openings per warehouse/grade/side), `analysis_sample` (CCC/QC lab readings per date × source × effective warehouse), `production_event_audit` (append-only trail, trigger-written), `drift_log` (append-only drift/exclusion telemetry). See `cenapro/CENAPRO_PRODUCTION_ANALYSIS.md`.

**RC DELIVERIES side (raw-charcoal receipts, 2026-08-04).** A SEPARATE `rc_`-prefixed island that **shares zero dimensions with production** — a raw-charcoal yard and a finished-goods FLEC warehouse are different places with different code spaces, so never FK an `rc_*` table to `warehouse`/`source_location`/`plant`. Dimensions: `rc_supplier` (cheque payee; exists so a trader can be re-pointed without a migration, and since 2026-08-05 carries the SUBGROUP — see below), `rc_destination` (`warehouse` | `plant_feed` | `dryer`, `has_sides`). Facts: `rc_delivery` (one truck receipt, in the RC workbook's column order), `rc_payment_allocation` (the payment→receipt edge — see ALLOCATION below), `rc_delivery_sample` (1–6 moisture sub-samples per receipt, CASCADE child), `rc_delivery_audit` (append-only trail covering BOTH — see below), `rc_supplier_audit` (the dimension's own trail). **Money is decomposed and DB-computed:** `net_weight_kg`, `price_php_kg` and `total_price_php` are STORED GENERATED over `gross_weight_kg`/`deduction_pct`/`base_price_php_kg`/`price_adjustment_php_kg` — unwritable by anyone, exact decimal, never rounded (`total_price_php` repeats the full arithmetic over base columns because a generated column may not reference another; `cenapro_rc_delivery_total_consistent` CHECKs the two forms agree). **Imported rows are reference data — flagged, not fixed:** `import_flags` (jsonb) + `is_suspected_duplicate` + NULL FKs + `*_raw` originals; `delivery_date` is nullable only so an unparseable sheet date can land, and `cenapro_rc_delivery_date_present` still refuses a dateless app write. Read model `view_rc_delivery`; write path `cenapro_save_rc_delivery` / `cenapro_delete_rc_delivery` (now `(id, expected_row_version, p_release_allocations boolean DEFAULT false)` — see ALLOCATION below) / `cenapro_save_rc_delivery_samples` (compare-and-set on `row_version`, allowlisted patch). The read model's duplicate-pairing columns (`duplicate_group_key` / `_size` / `_ordinal` / `duplicate_peer_ids`) **still exist and still work** — they simply pair nothing today, because the duplicates they were built to surface have since been deleted. See `app/(app)/cenapro/CONTEXT.md` → "RC Deliveries — DATA LAYER".

**Every change is trailed (`rc_delivery_audit`, 2026-08-05).** ONE append-only table covering both `rc_delivery` and its CASCADE child `rc_delivery_sample`, discriminated by `entity` (`delivery` | `sample`) and **always keyed by the parent `delivery_id`**, so one receipt's whole history is a single indexed query. Written ONLY by the SECURITY DEFINER triggers `cenapro.fn_audit_rc_delivery` / `cenapro.fn_audit_rc_delivery_sample` — **AFTER, not BEFORE**, because STORED GENERATED columns are not computed until after BEFORE triggers run, so a BEFORE trigger would record the money wrong. The generated money columns are deliberately **kept in** `changed` and `snapshot`: a weight edit that moves ₱40,000 of payable total is exactly what someone comes looking for. `changed` excludes `updated_at` and `row_version` (the touch trigger bumps both on every write), so an UPDATE that moved nothing else writes nothing at all. No role holds INSERT/UPDATE/DELETE; RLS is on with a SELECT-only policy, so even a future blanket schema grant cannot forge or erase a row. Read it through `public.cenapro_rc_delivery_audit` (`security_invoker`, SELECT only) — and note `changed`/`snapshot` carry the ₱ columns, so any server action exposing it is subject to `canViewPrices()`. **Why it exists:** on 2026-08-04, 22 duplicate receipts were hard-DELETEd and `public.audit_logs` contains ZERO rows mentioning cenapro or `rc_delivery` — there was no trace of the deletion anywhere. A `cenapro` table rather than `audit_logs` because the latter is read by the ICTC audit UI, joined by `audit_comments` / `notification_subscriptions`, and feeds `_insert_notification`; cenapro rows would surface inside another tenant's screens. **The trail starts 2026-08-05.** Nothing before that date was recorded, and none of it was fabricated to look otherwise.

**Supplier subgroups — who may be paid for whom (`rc_supplier.parent_code`, 2026-08-05, liquidation Step 2).** A cheque made out to one trader may legitimately settle a *sub*-supplier's deliveries, so `rc_supplier` gains a self-FK `parent_code` (`ON UPDATE CASCADE ON DELETE SET NULL`) plus `row_version` and a touch trigger. **The group is a PAYMENT fact, not a delivery fact** — it says who may be paid for whom, adds no column to `rc_delivery` and changes none of its views or RPCs. Four rules govern it: (1) **ONE LEVEL, enforced** — a supplier with children may not have a parent and vice versa, which a CHECK cannot express, so `tr_cenapro_rc_supplier_one_level` is a DEFERRABLE INITIALLY IMMEDIATE **constraint trigger** (deferral exists so a legal reorganisation can happen in one transaction; a genuine chain is still refused at the deferred check). (2) **Never inferred** — nothing may guess a grouping from name similarity; it is set by hand and **nothing was seeded**, all 12 suppliers are roots. (3) **Group membership is resolved in SQL, once** — `cenapro.view_rc_supplier_group` → `public.cenapro_rc_supplier_groups` owns `group_code = coalesce(parent_code, code)`, and every downstream consumer (the balance rollup, the allocation legality check) reads it there rather than re-deriving it in TypeScript. (4) **Every change is trailed** in `cenapro.rc_supplier_audit`, because re-pointing a parent retroactively changes which past payments were legitimate. Write path `public.cenapro_save_rc_supplier(p_code, p_expected_row_version, p_patch)` — allowlisted patch, compare-and-set in the same statement as the write, human-readable refusals; `code` is deliberately not editable and there is no delete RPC (retire with `active = false`). `public.cenapro_rc_suppliers` is unchanged and does **not** expose `parent_code`, so the importer can never wipe a hand-set parent.

**LIQUIDATION — banks, payments and the running balance (2026-08-05, Step 3).** The money going back out, and the first thing in the system that answers *"what do we owe BRIX right now"*. `rc_bank` (CI's own banks — data, never an enum; BDO/CHINABANK/METROBANK/AUB seeded) → `rc_bank_account` (the cheque book's home; **structurally necessary** because a cheque number is unique only per ACCOUNT and skipped-number detection is per book) → `rc_payment` (one money movement: `cheque | bank_transfer | adjustment` — **no `cash`**; `amount_php` **always > 0** with a separate `direction`, so a careless SUM can never net two opposite movements to zero; **no `status`** — the cheque lifecycle was declined; SOFT-deleted via `deleted_at`, with `cenapro_restore_rc_payment` because a soft delete you cannot undo is not reversibility) → `rc_payment_audit` (the same append-only, trigger-written, SELECT-only idiom, built in the SAME migration as the table it trails). `stated_term` is **recorded intent only and no balance is ever computed from it** — "downpayment vs full" describes how much of a receipt an *allocation* covers, and when the label and the allocations disagree the allocations are right. **Read model:** `view_rc_payment` owns the ONE definition of `balance_effect_php` (+outgoing / −incoming) and `is_cash`; `view_rc_supplier_balance` and `view_rc_supplier_group_balance` (rolled up via `view_rc_supplier_group.group_code`) are the balance. **Write path:** `cenapro_save_rc_bank` / `_rc_bank_account` / `_rc_payment`, `cenapro_delete_rc_payment` (soft), `cenapro_restore_rc_payment` — allowlisted patch, compare-and-set in the same statement, toast-ready refusals; **every liquidation accessor in `public` is READ-ONLY**, so the RPCs are the only door.

Three rules that are easy to get wrong. (1) **`receipts_php` sums PRICEABLE receipts only** — `cenapro.rc_delivery_is_priceable(gross_weight_kg, base_price_php_kg)`, the ONE definition Step 4 must reuse. Because `total_price_php` COALESCEs both factors to 0, `SUM(total_price_php)` and the filtered sum are **numerically identical on every supplier, forever** (measured: peso gap 0 across all 971 rows): the naive balance does not give a wrong number, it gives the right number with a **silent hole**, marking every unpriced receipt settled the instant it exists. Only `unpriced_receipt_count` / `unpriced_receipt_kg` (+ the exhaustive `unpriced_awaiting_weight/price/both_count` split) reveal it. Unpriced receipts are **incomplete entries, not ₱0 payable**, and "priced but not yet weighed" is a normal daily stage — the count will never sit at zero for long. (2) **`running_balance_php = opening_balance_php + payments_php − receipts_php`, so NEGATIVE = WE OWE THE SUPPLIER** — Renzo's convention, the opposite of the accounts-payable one, stated in the column COMMENT. **A non-zero balance is never an error state**: no badge, no red, no auto-close, no nightly job, and no per-supplier rounding rule. (3) **The receipt with no `supplier_code` cannot be liquidated** and is surfaced as a **synthetic `is_unassigned` row** (`supplier_code IS NULL`) present only while such receipts exist — an exclusion can be forgotten by a UI, a row cannot. `payments_php` is the signed net (an `adjustment` write-off counts, `incoming` subtracts), decomposed as `cash_out_php − cash_in_php + adjustment_php`. Strictly additive: no column on `rc_delivery`, `view_rc_delivery` untouched. **ALLOCATION — assigning a payment to particular deliveries (2026-08-06, Step 4).** `rc_payment_allocation` is a **many-to-many join with the amount ON THE EDGE**, because one cheque routinely settles several truckloads *and* one truckload is routinely settled by a downpayment now plus a balance later — a column on either side fails one of those, and the amount on the edge **is** the entire content of a partial payment. `payment_id` CASCADEs; **`delivery_id` is ON DELETE RESTRICT and load-bearing**; partial UNIQUE `(payment_id, delivery_id) WHERE deleted_at IS NULL` (one LIVE edge per pair — two partial payments from one cheque to one receipt is one larger edge). `payee_group_code` records **the payee's resolved group at the time of writing** and is derived + forced + frozen by the touch trigger, because `group_code` answers "may this payee be paid now" while a dispute asks "was that legal when it was made". **One invariant is enforced and one deliberately is not:** a payment's live allocations may never exceed its `amount_php` (a friendly RPC refusal **and** a constraint trigger, registered on BOTH `rc_payment_allocation` and `rc_payment` so editing a cheque *down* below its allocations is refused too — it raises SQLSTATE 23514 with a readable message, so Step 3's unmodified save RPC reports it verbatim); a **receipt** may be over-allocated (decision 13 — "record it") and reads `over_allocated`. Sub-supplier legality is checked **in the RPC at write time only** (arithmetic invariants are timeless, a point-in-time judgement is not) and names both traders on refusal; a receipt with no `supplier_code` can never be allocated. **Read models:** `view_rc_delivery_settlement` (one row per receipt; `settlement_status` in {`unpriced`, `unpaid`, `partial`, `settled`, `over_allocated`} — **`unpriced` is tested FIRST and never collapses into `settled`**, and `balance_php` is **NULL, not 0**, on an unpriceable receipt) and `view_rc_payment_state` (`unallocated_php` = THE definition, + `is_advance` — §4.4: a cash advance needs no column, no flag and no table, so `WHERE is_advance` IS the cash-advance list). The balance views gained `advance_php` (+ `advance_payment_count`, `unassigned_incoming_php`, `advance_php_window`), summed from `view_rc_payment_state`; it is **ALL-TIME not windowed** and **NOT a balance term** — `running_balance_php` is unchanged, because allocation refines what a payment was *for*, not what is owed. **Write path — both doors, ONE code path:** `cenapro_save_rc_payment_allocations` replaces a payment's whole live block atomically (parent UPDATE first so it row-locks; absent edges are SOFT-deleted; the upsert is a single statement so the AFTER-ROW constraint trigger sees only the final state), and `cenapro_allocate_delivery_to_payment` is the delivery-first door built ON TOP of it (it SETS, it does not add; a NULL amount fills `LEAST(owed, unassigned)`), plus `cenapro_restore_rc_payment_allocation`. **Deleting a receipt with money against it WARNs then RELEASES:** `cenapro_delete_rc_delivery` gained `p_release_allocations boolean DEFAULT false` (DROP + CREATE, never an overload) and otherwise refuses with `has_allocations` plus the real total and cheques; with the flag the edges are **HARD-removed** (a soft-deleted row still trips ON DELETE RESTRICT) and each removal leaves a full-snapshot DELETE audit row naming the reason — a human removing an edge is SOFT and restorable, the receipt being destroyed is not. With no allocations the behaviour and payload are unchanged. **The trail is ONE table:** `rc_payment_audit` gained `entity` (`payment` | `allocation`) + `allocation_id` + `delivery_id`, always keyed by `payment_id`, so one cheque's whole history is a single indexed query. **NOT built (Step 5+):** any period boundary (`rc_balance_period`), any cheque-gap report, any UI. See `app/(app)/cenapro/CONTEXT.md` → "Liquidation" and "Allocation".

**SUPPLIER OPENING BALANCES — how the balance becomes TRUE (2026-08-06, Step 3b, migration `20260805130000`).** Step 3's balance sums every receipt since January, so it said CI owes BRIX ₱212,669,462.50 — the whole year's purchases — because no historic cheque was ever entered and back-entering seven months of them is not realistic. Renzo now **states** what is actually outstanding as of a date and the system counts forward. **`cenapro.rc_supplier_opening_balance` is APPEND-ONLY** (the `cenapro.warehouse_opening_balance` idiom): "modify" means append a NEW REVISION, and the current value is the **LATEST revision — greatest `id`**, resolved once in `cenapro.view_rc_supplier_opening_balance`. A later revision may carry an **earlier** `as_of_date`; revising a stated figure downward or backward is the whole point. Append-only has **two independent locks** — no UPDATE/DELETE grant to any client role, and RLS with SELECT + INSERT policies and **no UPDATE/DELETE policy at all**. **THE AS-OF RULE, and nothing may contradict it: the opening stands for everything STRICTLY BEFORE `as_of_date`; receipts and payments dated ON OR AFTER it count fresh on top of it** — the boundary is `>=`, never `>`, and a receipt with **no `delivery_date` counts FRESH** (a naive `>=`/`<` pair would drop it from both sides and lose it silently). Three things about the reworked `view_rc_supplier_balance`: (a) **a supplier with no opening balance reads exactly as it did before** — verified byte-identical across all 13 rows; (b) the **full-history figures are preserved** as `receipts_all_php` / `payments_all_php` / `running_balance_all_php` (+ all-time counts and cash decomposition), because without them a stated figure is unauditable, and `carried_receipt_*` / `carried_payment_*` say exactly what it stands in for (*"this ₱4.2M stands in for 275 receipts worth ₱207.9M"*); (c) **the unpriced counts stay ALL-TIME under their existing names** (`unpriced_receipt_count_window` is the new windowed twin) — an unpriced receipt from before the cutoff **cannot** have been folded into the opening balance because nobody knows what it is worth, so windowing it would hide a live unknown. Checkable identity: `running_balance_php − running_balance_all_php = opening_balance_php + carried_receipt_php − carried_payment_php`. The group rollup sums the opening term too and still equals the sum of its members exactly; `opening_as_of_date` on a group is **NULL unless every member agrees** (read `opening_as_of_date_min`/`_max`). Write path `public.cenapro_set_rc_supplier_opening_balance(p_supplier_code, p_as_of_date, p_opening_balance_php, p_note)` — **INSERT-only, no update rpc and no delete rpc**; refuses an unknown supplier, a missing amount/date, a non-finite amount, more than 2 decimal places, and a future `as_of_date` (measured in **Asia/Manila**, not UTC); **does NOT refuse** a zero amount ("we are square as of that date" is a real answer — read `has_opening_balance`, never the amount, to tell it from "never stated"), a positive amount (the supplier owes us), a re-statement of the same numbers, or a backdated revision. Read models `public.cenapro_rc_supplier_opening_balances` (current) / `cenapro_rc_supplier_opening_balance_history` (every revision, `is_current`). **Nothing is seeded** — all 12 suppliers read `has_opening_balance = false` until Renzo states a real figure.

**Enums:** `batch_status` = `STORED | IN-USE | CLOSED | FEED | SUNDRYING | SUNDRIED` (6 values) · `notification_type` = `resolve_request | resolve_approved | resolve_denied | delivery_created | delivery_edited | delivery_deleted | remarks_added | audit_comment_reply`

Batch upsert strategy: upsert by `batch_code` to prevent duplicates. **Batch auto-create policy (2026-07-11):** the sync worker auto-creates a batch when a source (Google Sheet, PROPOSED DAILY REPORT) names a `batch_code` that doesn't exist yet, PROVIDED the code is pattern-valid (a recognized month-prefix + `-YY-` + kind+number, e.g. `JULY-26-BLK6`) — see `workers/sync/src/lib/batchAutoCreate.ts`. This reverses the prior "never auto-create a batch" rule for pattern-valid codes only; a pattern-invalid code (a likely typo) still holds/unmapped and needs the manual "create this batch" Sync Review action (`lib/sync/create-batch-plan.ts`).

### Views (`public`, ~40 total)
- **RC IN / deliveries:** `view_deliveries_human_edited` (one row per delivery a human owns — the sync will not update any of them; `fn_release_delivery_rows` hands one back. **Carries no ₱ column on purpose**: it feeds the sync-visibility surface, which is not price-gated, so the refusal names the ROW and `cost_basis` stays in RC IN behind `canViewPrices()`), `view_rc_in_master`, `view_supplier_deliveries`, `view_delivery_monthly_analytics`, `view_delivery_yearly_analytics`, `view_delivery_supplier_monthly_analytics`, `view_delivery_supplier_yearly_analytics`, `view_delivery_supplier_subgroup_yearly_analytics`
- **Blocking / balance:** `view_blocking_grid`, `view_rc_out_closed_blocks`
- **RC Movement (feeding + campaign + yield):** `view_rc_movement`, `view_rc_movement_batch_price`, `view_rc_movement_day_price`, `view_rc_movement_month_price`, `view_rc_movement_campaign_cells`, `view_rc_movement_campaign_options`, `view_rc_movement_campaign_price`, `view_rc_movement_campaign_day_price`, `view_rc_movement_campaign_production`, `view_rc_movement_campaign_production_daily`, `view_rc_movement_campaign_production_daily_total`, `view_rc_movement_campaign_yield`, `view_rc_movement_production_daily`, `view_rc_movement_production_daily_total`, `view_rc_movement_production_monthly`, `view_rc_movement_yield_monthly`
- **RC Movement — ACTUAL FED ₱/kg (2026-08-07, migration `20260807090554`):** `view_rc_movement_block_actual_price` (per block), `view_rc_movement_campaign_actual_price` (campaign rollup), `view_rc_movement_campaign_open_blocks` (the still-open blocks a campaign fed)
  - **What the statistic means.** A block receives charcoal at a delivered ₱/kg, then dries out and loses weight — but **the money already spent does not shrink**. So every kilogram that actually reached the plant cost MORE than the arrival price, and that uplift was invisible in the system until now. `actual_fed_php_kg` = **SUM(`deliveries.cost_basis` × `deliveries.weight_kg`) ÷ SUM(`rc_out.weight_kg`)** — total ₱ paid for the block over total kg ever fed out of it. It exists **only when the block is CLOSED**, because only then is the fed total final. Measured: `JAN-26-BLK22` delivered at ₱48.1612 actually cost **₱50.6110** after losing 4.84% of its weight; `NOV-25-BLK7` ₱42.00 → **₱46.9580** after 10.56%.
  - **`view_rc_out_closed_blocks` is NOT this statistic and was NOT changed.** Its `total_value` is *fed kg × delivered price*, so its `avg_price` algebraically collapses back to the **delivered** ₱/kg (still ₱48.1612 for `JAN-26-BLK22`). The new views divide the **delivered value** by the **fed kg**. `view_rc_movement_campaign_price` is likewise untouched and remains the delivered-price reference line. Everything here is strictly additive.
  - **NULL ≠ 0, and this is the third time today the same bug was refused.** `cost_basis = 0` is the **L-008 unpriced placeholder**, not a ₱0 delivery. A block with any unpriced delivery has a numerator missing money against a complete denominator, so the computed price is **understated — pointing the exact opposite way from the insight the statistic exists to show**. Measured: `FEB-26-BLK5` was delivered at ₱49.00/kg and lost weight, so its actual price *must* exceed ₱49.00; computed over its partial money it reads **₱38.4957**. That is the ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume. Therefore **both `actual_fed_php_kg` and `delivered_php_kg` are NULL — never 0 — unless the block is FULLY priced** (every delivery `cost_basis > 0`). `has_unpriced_delivery` / `unpriced_delivery_count` / `unpriced_delivered_kg` let the UI explain the blank, and **`priced_delivered_php_kg`** gives it an honest partial figure — the same narrowing `fn_recompute_batch_state` applied to `batches.avg_cost` the same day. Cost of the strict rule: **4 of 462 closed blocks** (1 fully unpriced — `JULY-26-BLK14` — and 3 partial).
  - **The campaign rollup is weighted by fed kg, NEVER the mean of the per-block prices** (JULY 2026: correct ₱47.2747 vs naive mean ₱45.8374). Its price set = the campaign's blocks that are CLOSED **and** fully priced. It exposes **two** honest aggregations because a block can be fed across several campaigns: `actual_fed_php_kg` (whole-block value ÷ whole-block all-time fed kg — "the blocks this campaign drew from cost this") and `campaign_weighted_actual_fed_php_kg` (attributed to this campaign's own fed kg, shaped like `view_rc_movement_campaign_price` so the two are directly comparable). JULY 2026 reads ₱47.2747 and ₱46.2492. Coverage columns (`blocks_fed` / `blocks_closed` / `blocks_open` / `blocks_in_price`, plus `campaign_fed_kg_included` / `_excluded`) are supplied so the UI prints "18 of 19 blocks closed" rather than counting.
  - **`loss_pct` is a FRACTION, not a percent** — same convention as `view_rc_movement_campaign_yield.yield_pct`. And note `weight_lost_kg` is only *loss* once `is_closed`; before closure it also contains charcoal still sitting in the block (read `balance_kg` in the open-blocks view for that).
  - **All three carry ₱ and are `canViewPrices()`-gated at the server-action layer**, exactly as the existing `Fed ₱/kg` column already is (`rc-movement-matrix.tsx` drops that column entirely for Production). Null the ₱ fields BEFORE the payload leaves the server.
- **Production / trucks:** `view_production_daily`, `view_trucks_monthly`, `view_production_human_edited` (one row per production fact a human owns, across all six tables — the sync will not update any of them; `fn_release_production_rows` hands one back)
- **Production PLAN:** `view_production_schedule_state` (ownership-aware read model: adds `is_reported` = a `production_shifts` row exists for the date, and `effective_owner` = `'actual'` when reported else the stored `owner`), `view_production_schedule_conflicts` (one row per unarbitrated pending upstream, carrying BOTH sides)
- **Home Digest (feed the `/` bands):** `view_digest_daily_flow`, `view_digest_daily_price`, `view_digest_daily_power`, `view_digest_daily_production`, `view_digest_grades`, `view_digest_rcin_daystats`, `view_digest_mtd`, `view_digest_operational_days`, `view_digest_stream_registry`, `view_digest_stream_reported_days`, `view_digest_stream_status`, `view_digest_stream_freshness`, `view_digest_unpriced_deliveries`, `view_digest_unpriced_recent`, `view_digest_latest_sync`, `view_digest_latest_sync_by_employee`, `view_digest_audit_enriched`
  - **Unpriced deliveries (2026-08-07, L-039, migration `20260807040107`).** `view_digest_unpriced_deliveries` owns the ONE definition of **"unpriced"** (`cost_basis = 0`, the L-008 placeholder) and of **"overdue"** (`is_overdue` = still unpriced **more than 1 day** after `transaction_date`, measured against `view_digest_operational_days.operational_date` so it never fires on a day the plant has not reported yet). One row per unpriced delivery + `days_pending` + `is_recent`. **Carries no ₱ column** — every row is `cost_basis = 0` by construction, so there is nothing to leak. `view_digest_unpriced_recent` was **rewritten as a thin count projection of it** (same single `cnt` column, same integer type, same value — measured 7 → 7), so the sync warning and the digest flag can never drift apart. Do not re-derive the overdue rule anywhere else.
  - **Stream status (lag-aware, 2026-08-03, migration `20260803070000`).** `view_digest_stream_registry` (the ONE stream list + labels + `reports_next_day`) → `view_digest_stream_reported_days` (one row per stream per REPORTED date; **owns the production "has a `production_runs` child" rule** carried forward from `20260714000000` — do not duplicate or weaken it) → `view_digest_stream_status` (adds `prev_reported_date`, `operational_date` and **`missed_working_days`**). `view_digest_stream_freshness` is now a thin 3-column projection of the status view, byte-identical for existing consumers. `missed_working_days` counts `production_schedule` days with `shifts > 0` **strictly between** the stream's latest reported day and the operational date — rest days and the operational date itself are excluded, so a Sunday is never late and a next-day stream's not-yet-due report for today is never late.
- **FLECON:** `view_flecon_bag_balance`
- **Sync reports:** `view_sync_run_reports` — one row per generated Excel sync report joined to its run (status, timing, duration, dry-run flag, `is_latest` per run). `security_invoker`, `authenticated` SELECT. THE query behind "list the last N reports with a download link"; do not re-write that join in a caller.
- **Cenapro:** `cenapro_production_events`; RC deliveries `cenapro_rc_delivery_rows` / `cenapro_rc_supplier_groups` / `cenapro_rc_delivery_audit` / `cenapro_rc_supplier_audit`; liquidation (read-only) `cenapro_rc_banks` / `cenapro_rc_bank_accounts` / `cenapro_rc_payments` / `cenapro_rc_payment_audit` / **`cenapro_rc_supplier_balances`** / **`cenapro_rc_supplier_group_balances`** / **`cenapro_rc_delivery_settlement`** / **`cenapro_rc_payment_state`** / **`cenapro_rc_payment_allocations`** / **`cenapro_rc_supplier_opening_balances`** / **`cenapro_rc_supplier_opening_balance_history`**

### Functions (`public`)
- `fn_blend_proposal(p_block_locs text[])` — weighted-average blend metrics for selected blocks
- `fn_bulk_update_deliveries(rows jsonb)` / `fn_bulk_update_usage(rows jsonb)` — **transactional** bulk-edit RPCs (PERF-3). Each applies an array of `{id, data, comment}` partial updates to `deliveries` / `rc_out` in ONE transaction (all-or-nothing, no mid-loop partial commit). SECURITY INVOKER, `search_path=public` pinned, EXECUTE revoked from `anon`. They let the existing per-row AFTER triggers fire (so the `audit_logs` trail is byte-for-byte identical to the old loop) and reproduce the "attach edit remark to the record's latest audit_log" glue. Called by `bulkUpdateDeliveries` / `bulkUpdateUsage`.
- `fn_recompute_batch_state(p_batch_code text) → void` — the ONE definition of a batch's derived state. Recomputes `batches.current_weight` (deliveries − rc_out) and `batches.avg_cost` (delivery-weighted, **over PRICED deliveries only** — `cost_basis > 0`, narrowed 2026-08-07, see Database Rules) from the base tables. Idempotent, so it doubles as the backfill. Called by every branch of `fn_update_blackwood_state`. `service_role` only.
- **Delivery archive / restore (2026-08-07)** — the four functions that own `public.deliveries_archive`. All SECURITY DEFINER (owner `postgres`, so they bypass RLS), `SET search_path = public`, EXECUTE revoked from `PUBLIC` + `anon` and granted to **`service_role` only** — they can resurrect or remove operational rows and there is no UI for them, so `authenticated` deliberately does NOT hold EXECUTE. If an in-app revert is ever built, wrap it in a role-gated server action and grant then.
  - `fn_archive_delivery(p_delivery_id uuid, p_reason text, p_archive_batch_id uuid DEFAULT gen_random_uuid()) → uuid` — snapshots one LIVE delivery into the archive (does **not** delete it) and returns the `archive_id`. Refuses a blank reason (an archive row that cannot say why it exists cannot be judged later) and refuses an unknown id. Pass the same `p_archive_batch_id` for every row of one operation.
  - `fn_archive_and_delete_delivery(...)` → uuid — **the safe removal primitive: prefer this over a bare `DELETE` on `deliveries`.** Archives then deletes in one call in the caller's transaction, asserting exactly 1 row deleted, so it is structurally impossible to remove a delivery without leaving a restorable copy.
  - `fn_restore_archived_delivery(p_archive_id uuid) → jsonb` — re-inserts one archived row **exactly as it was, including its original `id` and `created_at`**, so every downstream reference (audit_logs `record_id`, notification metadata) still resolves. Idempotent: an id that is already live returns `outcome=already_present` and is never inserted twice. **Caveat:** the re-insert fires the normal AFTER triggers, so `current_weight`/`avg_cost` come back exactly (recomputed from base tables) but **`batches.quality_stats` does NOT** — it is an INSERT-only incremental blend and is not invertible. Its pre-removal value is preserved in `deliveries_archive.context->'batch'`.
  - `fn_restore_archive_batch(p_archive_batch_id uuid) → jsonb` — **THE one-command revert**: restores every archive row sharing one `archive_batch_id`, returning per-row outcomes plus `restored`/`already_present` counts. Idempotent. Run this when a cleanup fails its after-the-fact check.
  - **Restore depends on the batch row still existing** (`deliveries.batch_code` FK → `batches`). So when a cleanup empties a batch, **never delete the now-empty `batches` row** — doing so would silently make the archive un-restorable.
- `fn_record_delivery_source_alias(p_kind, p_ours, p_theirs, p_evidence, p_ours_raw, p_theirs_raw, p_seen_on) → uuid` — the idempotent write path for `public.delivery_source_aliases` (2026-08-07). First sighting INSERTs; a repeat bumps `times_seen`/`last_seen_at` and re-activates a retired pair but **never rewrites the original `evidence`** (the first corroboration is the one that earned the row). REFUSES a blank evidence string and refuses `ours = theirs`. `service_role` only — the sync worker calls it after a uniqueness-gated fallback match corroborated the pair.
- `set_audit_comment(comment text)`, `_insert_notification(...)`, `is_admin(user_id)`, `canonical_supplier(p_supplier)`, `rc_out_avg_price(...)`, `rc_out_avg_wtd_value(...)`
- `fn_apply_schedule_upstream(p_ops jsonb) → jsonb` — the ATOMIC conditional writer for `production_schedule`. Takes the sync worker's planned ops (`insert`/`apply`/`reclaim`/`park`) and re-checks `row_version = expected`, `owner = expected`, and the `production_shifts` actuals freeze **in the same statement as each write** (data-modifying CTEs, no read-then-write). Never deletes; days absent from `p_ops` are untouched. Returns `[{plan_date, action, outcome}]`. SECURITY INVOKER, `service_role` only.
- `fn_save_schedule_day(p_plan_date date, p_expected_row_version int, p_patch jsonb, p_clear_pending bool) → jsonb` — the in-app write path for `production_schedule`. Flips `owner` to `human`, stamps `human_edited_at`/`human_edited_by = auth.uid()`, bumps `row_version`; conditional on the expected version and the actuals freeze in its own UPDATE's WHERE. `p_clear_pending` defaults FALSE (an unrelated edit must not discard a parked proposal). Returns `{ok, outcome, row_version}`. SECURITY INVOKER, `authenticated` + `service_role`.
- `fn_apply_production_upstream(p_ops jsonb) → jsonb` — the sync's ONLY update path into the production FACT tables (`production_runs`/`production_downtime`/`production_waste`/`electricity_readings`/`truck_readings`; `production_shifts` deliberately excluded — the sync only inserts shifts). Takes `[{table, id, patch}]` and re-checks `human_edited_at IS NULL` **in the same statement as each write** (data-modifying CTEs). Never inserts, never deletes. Returns `[{table, id, outcome}]` with outcome `applied | human_edited | missing | empty_patch | unsupported_field`; a patch key outside the per-table allowlist refuses the whole op rather than smuggling a column in. SECURITY INVOKER, `service_role` only.
- `fn_apply_delivery_upstream(p_ops jsonb) → jsonb` — the sync's ONLY update path into `public.deliveries` (2026-08-08). The single-table sibling of `fn_apply_production_upstream`: takes `[{id, patch}]` and re-checks `human_edited_at IS NULL` **in the same statement as each write**, so a save that lands between classify and apply wins. Never inserts, never deletes. Returns `[{id, outcome}]` with outcome `applied | human_edited | missing | empty_patch | unsupported_field`. The allowlist is exactly the **nine** fields the two classifiers can diff (`supplier`, `batch_code`, `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`, `remarks`, `lab_results`); `transaction_date` is absent because it is in BOTH identity tiers, and `true_weight_kg`/`deduction_note` because they are additive and never diffed (L-021). SECURITY INVOKER, `service_role` only.
- `fn_release_delivery_rows(p_ids uuid[]) → jsonb` — hands human-edited deliveries back to the sync by clearing `human_edited_at`/`by` (2026-08-08). Same discipline as the production twin — holds the transaction-local GUC `blackwood.release_human_edit` so `fn_stamp_human_edit` does not immediately re-stamp, guard in the UPDATE's own WHERE, a row nobody claimed is reported `skipped`. One table, so no dynamic SQL. Returns `{ok, table, released[], released_count, skipped[], skipped_count}`. SECURITY INVOKER, `authenticated` + `service_role`. **No server action calls it yet** — the in-app door is not built.
- `fn_release_production_rows(p_table text, p_ids uuid[]) → jsonb` — hands human-edited production rows back to the sync by clearing `human_edited_at`/`by`. The ONLY sanctioned clear (it holds the transaction-local GUC `blackwood.release_human_edit` so `fn_stamp_human_edit` does not immediately re-stamp); an ordinary authenticated PATCH sending `human_edited_at: null` is re-stamped, not honoured. Guard in the UPDATE's own WHERE; a row nobody claimed is reported `skipped`, not written. SECURITY INVOKER, `authenticated` + `service_role`.
- `write_ingestion_audit(p_table_name text, p_record_id uuid, p_operation text, p_diff jsonb, p_snapshot jsonb, p_comment text) → uuid` — SECURITY DEFINER (owner `postgres`), `service_role`-only ingestion audit writer for the sync orchestrators / Run Sync button; inserts one `audit_logs` row (`performed_by=NULL`) and returns its id. Closes the L-009 grant gap without granting broad INSERT on `audit_logs`. Use for tables with no audit trigger (`rc_out`, `production_*`, `electricity_readings`, `truck_readings`, `flecon_bag_movements`); `deliveries` keeps its own audit trigger.
- Cenapro RPCs: `cenapro_flec_balance`, `cenapro_flec_ledger`, `cenapro_opening_balances`, `cenapro_opening_balance_history`, `cenapro_set_opening_balance`; RC deliveries `cenapro_save_rc_delivery` / `cenapro_delete_rc_delivery` / `cenapro_save_rc_delivery_samples` / `cenapro_save_rc_supplier`; liquidation `cenapro_save_rc_bank` / `cenapro_save_rc_bank_account` / `cenapro_save_rc_payment` / `cenapro_delete_rc_payment` (SOFT) / `cenapro_restore_rc_payment` / `cenapro_set_rc_supplier_opening_balance` (APPEND-only; no update or delete counterpart); allocation `cenapro_save_rc_payment_allocations` / `cenapro_allocate_delivery_to_payment` / `cenapro_restore_rc_payment_allocation`

**Triggers:**
- **`fn_update_blackwood_state()`** — **AFTER** INSERT OR UPDATE OR DELETE on `deliveries` (`tr_blackwood_delivery`): recomputes the batch's `current_weight` + `avg_cost` via `fn_recompute_batch_state`, maintains `quality_stats` (INSERT only), clears `location_ref` when a batch loses its last delivery, and flips STORED→SUNDRIED for `%SUNDRY%` batches. **AFTER, not BEFORE** — see Database Rules above.
- **`handle_new_user()`** — After INSERT on `auth.users`: creates profile from `user_invites` whitelist (role + status='active') or with default role + status='pending'
- **`handle_invite_creation()`** — After INSERT on `user_invites`: activates matching pending profiles
- **`fn_stamp_human_edit()`** — BEFORE INSERT OR UPDATE on all six production fact tables **and (2026-08-08) on `deliveries`** (`tr_stamp_human_edit`): stamps `human_edited_at`/`human_edited_by` whenever `auth.uid()` is non-null, so an in-app edit can never forget to claim its row and the sync can never revert it. Service-role (sync) writes have no `auth.uid()` and never stamp. Skipped only while `fn_release_production_rows` / `fn_release_delivery_rows` hold the transaction-local GUC `blackwood.release_human_edit`. The function is **REUSED verbatim, never cloned** — it touches only the two stamp columns, so cloning it per table would create a second definition of "how a row gets claimed" that could drift. On `deliveries` it is the only BEFORE trigger and all four existing triggers are AFTER, so it perturbs no firing order.
- **`log_delivery_changes()`** — AFTER INSERT/UPDATE/DELETE on `deliveries` (`deliveries_audit_trigger`): one `audit_logs` row per real change. **The two latch columns are excluded from the DIFF — never from the SNAPSHOT (2026-08-08).** The function builds its diff by iterating every key of `to_jsonb(NEW)`, and the stamp changes on every authenticated write, so without the exclusion an app save that moved nothing else would suddenly write a fabricated `human_edited_at: {old, new}` "delivery edited" event into the activity feed and `view_digest_audit_enriched`. Excluded, an UPDATE that moved nothing else writes nothing at all — exactly as before the latch existed. Same decision, same reason, as `cenapro.rc_delivery_audit` excluding `updated_at`/`row_version`.

**Dev Role Override:** Privileged users (Owner/Admin/Dev) can impersonate any role via localStorage (`dev_mock_role`) + cookie. Server-side `getUserRole()` in `lib/auth.ts` reads the cookie. UI controlled via navbar Shield icon dropdown.

**Price gating (security boundary) — `canViewPrices()` is canonical.** All ₱/cost data (`cost_basis`, `avg_price`, `avg_wtd_value`, fed ₱/kg) is gated by the ONE helper `canViewPrices()` in `lib/auth.ts`. It derives the effective role from `getUserRole()`, so it respects the impersonation cookie (an Owner "viewing as Production" is denied). **Production is the only role that cannot see prices.** Server actions/components MUST null/omit ₱ fields BEFORE returning the payload when `!canViewPrices()` — never rely on hiding them client-side (the network response is the leak) — and pass a `canViewPrices` boolean down for conditional render. Never re-derive price visibility with an inline `profiles.select('role')` lookup (it ignores impersonation). See `components/providers/AUTH.md` → "Price Gating".

**One artifact gates on DATA rather than on a code path: the Excel sync report (2026-08-07).** A stored file cannot be nulled at read time, so `sync_run_reports.contains_prices` records a MEASURED fact about each workbook and `getSyncRunReportUrl` refuses a ₱-bearing artifact to a `!canViewPrices()` caller. The column **DEFAULTS TRUE — fail-closed**; the generator writes `false` only after `auditPriceFree()` has re-read every string it emitted and found neither a ₱ glyph nor a cost-ish `key=value` token (`isCostKey`, exported from `lib/sync/findings.ts` so there is still exactly one definition of "cost-ish"). Today every report is price-free by construction — the finding vocabulary carries no ₱ anywhere on purpose, and a raw held-case row's `cost_basis` is stripped on the way into the cell — so **there is no ₱-free regeneration path and none is needed**; the day someone adds a ₱ column, the generator stops asserting price-freedom and the gate engages with no code change. Note the ₱ branch is currently unreachable in practice: `requirePrivileged()` (Owner/Admin/Dev) already refuses Production first.

## Supabase CLI

The project is linked to Supabase. Common commands (see `/supabase` workflow for full details):
- `supabase gen types typescript --linked > types/supabase.ts` — regenerate types after schema changes
- `supabase migration new <name>` — create a migration file in `supabase/migrations/`
- `supabase db push` — push migrations to remote
- `supabase db diff` — see schema changes as SQL

## Database Rules

- **`batch_code` is text-based linking** — not UUID. This preserves CSV/Excel parity so operators can reference batch codes directly.
- **DB trigger `tr_blackwood_delivery` → `fn_update_blackwood_state`** maintains `batches.current_weight`, `avg_cost`, `quality_stats`, `location_ref` and the SUNDRIED status flip. **It is an AFTER trigger (2026-08-04, BUG-017)** — it was BEFORE, which meant every branch recomputed from a `deliveries` table that did not yet agree with the write about to happen (a batch-code move left the old batch high and the new one low; an in-place weight edit recomputed to no change at all). Under AFTER the row is final and all branches share ONE idempotent helper, **`fn_recompute_batch_state(batch_code)`**.
- **`batches.avg_cost` has exactly ONE definition: delivery-weighted** — `SUM(cost_basis × weight_kg) / SUM(weight_kg)` over the batch's deliveries, consumption ignored (2026-08-04, BUG-018, Renzo's call). It previously had two competing definitions depending on which trigger branch last fired. Never reintroduce a running/perpetual average here; if you need one, add a new column. `quality_stats` still uses an INSERT-only incremental formula weighted by the consumption-net `current_weight` — a known inconsistency, deliberately left alone.
- **`avg_cost` averages over PRICED deliveries only — `cost_basis > 0` (2026-08-07, L-039).** This is **NOT a second definition**: the BUG-018 formula above is byte-identical and still delivery-weighted; only the **input set** narrows. `cost_basis = 0` is the **L-008 unpriced placeholder, not a ₱0 delivery**, so including it added weight to the denominator and nothing to the numerator and dragged the average toward zero in proportion to how much of the batch was still awaiting a price — `AUGUST-26-BLK1` read **₱11.01 against a real ₱39.99**, a figure that was wrong in a way nobody could see and that moved every time an unrelated price landed. Narrowed, `avg_cost` answers "what did the charcoal we have a price for cost", which is the only honest answer while a price is pending, and it converges on the full-batch figure as prices arrive. A batch with no priced delivery still reads 0 (`COALESCE`). **`current_weight` is untouched** — an unpriced delivery is still physically there.
- **FIXED 2026-08-08 (L-040b) — the sync's delivery identity is now TWO-TIER, built only from facts that do not get corrected.** `workers/sync/src/lib/deliveryIdentity.ts` is the ONE definition, shared by BOTH writers of `deliveries` (the email path and the Google Sheet path) and mirrored in the Python oracle. **TIER 1 (preferred): `(transaction_date, NORMALIZED truck_plate, sacks)`** — the plate is stamped on the truck and sacks are counted at the gate; measured UNIQUE across all 1,545 live deliveries that carry both, zero collisions (plates normalize to alphanumerics-upper because `MAV 9202` and `MAV9202` are one truck, 57 + 35 rows). **TIER 2 (fallback): the legacy key**, for the 143 rows with no plate. Lookup is tier 1 then tier 2, so the set of rows that MATCH is a strict **superset** of the old key's — the change can only turn an insert into a match, never the reverse. **The three fields that left the key are now COMPARED, and a disagreement on any of them is HELD for a human, never auto-applied** (`L040_identity_diff` → `HeldKind` `cross_batch_reassignment`): they are precisely the fields a person corrects, so a mismatch means one source is stale. Also note the old key's ONE live collision was the legitimate wet-sack split below (471 + 36 sacks, both 18,827 kg) — it called them one row; tier 1 separates them. Full rationale: LEARNING_LEDGER **L-040b**, `workers/sync/specs/deliveries.md` §3.
- **THE ORIGINAL BUG, kept because the reasoning generalises: `batch_code` WAS IN the sync's natural key and `truck_plate` was NOT — so two spellings of one batch made two deliveries (2026-08-07, L-040).** The old key was `(transaction_date, batch_code, block_loc, weight_kg)`. The Google Sheet writes the convention-correct code (`JULY-26-FEED1`) and MC's operator email writes shorthand (`FEEDING # 1`), so the same physical truckload lands twice and each copy inflates its own batch's `current_weight`. `deliveries` has **no unique index other than the PK**, so nothing at the DB level refuses it. **A real duplicate's signature is an identical FULL lab panel + sacks + weight, differing only in `batch_code`** — and lab panels must be compared **numerically, not as JSON text** (`"mc": 12` and `"mc": 12.0` are equal numbers and different strings; jsonb preserves the scale, so a text diff hides a real pair). **A wet-sack deduction split is NOT a duplicate**: same date/truck/supplier but DIFFERENT sacks and MC/ash, because the yard pulls over-moisture sacks off a load and books them separately (e.g. 2025-04-03 / KCA 378 / `MARCH-25-BLK9`, the 471- and 36-sack rows — legitimate, never flag them). Removals go through `fn_archive_and_delete_delivery`, never a bare `DELETE`.
- **Never calculate weighted averages or inventory balances in TypeScript** — trust the DB. Aggregations, running totals, and derived state belong in SQL views or triggers, not client code.
- **RLS posture (Phase-4 hardened, 2026-07-03):** RLS is enabled on every public table; the model is **single-org** — `authenticated` = org member = broad read + write (policies are intentionally permissive `USING/WITH CHECK (true)`). The **server actions + `canViewPrices()` are the enforcement layer** (roles, price boundary, delete gates), NOT row-level predicates. Do **not** add per-role row restrictions to the core tables. The Python sync writes with the **service-role key (bypasses RLS)**, so RLS never blocks ingestion. **Reporting views are `security_invoker`** — if you add a view, grant `SELECT` to `authenticated` AND ensure every underlying table has a permissive SELECT policy, or the view throws "permission denied" (the flecon-L trap). **`anon` has no data access** (all anon table/view SELECT + function EXECUTE revoked); `is_admin` is the one function `authenticated` must keep EXECUTE on (RLS policies call it). New functions: `SET search_path = public` and `REVOKE EXECUTE … FROM PUBLIC` (grant back only the roles that call it).

## Sync Integrity — Multi-Source Reconciliation (canonical, 2026-07-07)

**No ingest source is authoritative.** The daily sync pulls the same facts from several sources (the Google Sheet, the PROPOSED DAILY REPORT, the RC MOVEMENT sheet, delivery emails, Czarina pricing). None of them is "the source of truth" — each is a fallible witness. Two hard rules govern how they combine:

1. **Extraction must be exact.** An extractor's only job is to capture what its source *literally says*, per natural key, with no interpretation and no cross-record math. Each source additionally reports its own internal-consistency signals (e.g. rc_out's `STRT − END == DAY TOTAL` check) so the reconciler knows which witness to trust when they disagree.
2. **Disagreements are never auto-resolved — the human arbitrates them in the app.** When two sources give different values for the same field, the sync does **not** pick a winner (the retired "Sheet-wins" policy did exactly that and silently overwrote correct data — see `LEARNING_LEDGER.md` L-037). Instead the disagreement becomes a **diff case** surfaced in **Sync Review** (`/sync/cases`), where the operator picks which value to keep. The pick writes deterministically with a full provenance audit and feeds the known-issues ledger. **Batch identity is the one narrow exception** (2026-07-11 policy, orthogonal to this principle — it is not a *disagreement*, it is a machine-verifiable *new identity*): a pattern-valid unknown `batch_code` auto-creates from the template and the row writes through immediately, with an audit log + an info-level run finding for visibility. See "Database Rules" above and `workers/sync/specs/PORTING_DECISIONS.md`.

**Every sync run therefore ends in exactly one of two states:** (a) **CLEAN** — all sources reconciled, everything applied; or (b) **DIFFS PENDING** — a list of field-level disagreements awaiting a human pick. Never a silent auto-overwrite. The full architecture (extract → reconcile → diff-case → arbitrate) is specified in **`SYNC_RECONCILIATION_MODEL.md`**; it reuses the adjudicator's case/Sync-Review/resolve machinery wholesale.

**Scope:** cross-source reconciliation applies to the THREE reports with a Google Sheet tab — **RC IN, RC OUT, Blocking** (Blocking is derived from RC IN − RC OUT and cross-checked against the Sheet, at both per-block and grand-total level). **Production and Flecon are single-source** and auto-write when they pass the validity rules in **`SYNC_VALIDITY_RULESET.md`**, stopping only on a rule violation. A lone witness whose second source is merely *not yet arrived* (the proposed report reports yesterday) is a self-clearing `pending`, not a review case.

**Delivery PRICE enrichment — a failure here must be the loudest thing a run says (2026-08-07, L-039).** Prices come from ONE source (Czarina's `RAW CHARCOAL PURCHASES -Daily.xlsx`), so this is not a reconciliation — it is a **matching** problem, and its failure mode is silence. The sync had priced **ZERO August 2026 deliveries** for a week: the worker generated her tab name as `"<FullMonth> <YYYY>"` → `"August 2026"` and looked it up by EXACT match, her tab is `"Aug. 2026"`, the whole-file load threw, and a bare `catch` reported *"Price file unavailable — proceeding without prices."* **The file was available.** Because the price file is loaded ONCE before the row loop, one unrecognized tab un-priced the entire run. Five rules now govern it (full spec: **`workers/sync/specs/deliveries.md` §9**):

1. **Never address a human-named worksheet by a generated name.** Her 24 tabs carry at least four conventions (`Aug. 2026`, `Jan. 2026.`, `Nov 25. ` with a trailing space, `March25`). Both sides normalize to `(month, year)`; month tokens come from `lib/months.ts::monthNumberFromToken` and are **never** redefined locally. **Two tabs meaning the same month is REFUSED, never guessed.**
2. **Load every month the window spans.** The window is `watermark − 3 days`, so it straddles a month boundary on the 1st, 2nd and 3rd of **every** month. A partial failure still prices the months that resolved and still reports the one that didn't.
3. **Every price outcome is a durable run finding, never just a progress beat.** `apply.price_notes` → `lib/sync/findings.ts`. A whole-file/whole-month failure is `high` severity and names **the tab it looked for AND the tabs it found**. `ProgressLevel` gained `error` for this. **A note NEVER carries a ₱ value** — it identifies the row and describes the problem in words.
4. **A fuzzy match ENRICHES and is ALSO reported, with both spellings** ("bring it up in the sync but still proceed to enrich" — Renzo). The ladder is EXACT → learned ALIAS → a `(date ±≤2d, weight, sacks)` fallback **gated on uniqueness on BOTH sides** plus one independent corroborating field. Plate shape is a **TIE-BREAKER, never a matcher**. Suppliers go through `canonical_supplier()` on **both** sides. A collision is refused and reported — and per Renzo's measurement (unique for 1,309 of 1,327 deliveries; all 9 colliding triples are known duplicate pairs) a collision usually **is** a duplicate row.
5. **An unpriced delivery is chased, and never silently averaged as ₱0.** Any delivery still unpriced more than a day after its `transaction_date` raises a finding naming the rows ("prices are not supposed to lag, and they liquidate daily" — Renzo); that warning is independent of *why*, so it catches an outage the price step itself missed. And `avg_cost` excludes unpriced rows (see Database Rules).

**Date settlement (rc_out, 2026-07-12).** Once a `transaction_date`'s rc_out has been reconciled CLEAN by two independent witnesses (the DB sum and the RC MOVEMENT sheet, within the existing 50kg tolerance), it is recorded SETTLED in `rc_out_date_settlements` and every future sync run skips that date entirely — no extract-compare, no classify, no reconcile, no gate, no flags. This exists because the PROPOSED workbook permanently carries every day-tab ever filled in, so without a ledger every run re-walks the whole history through both HARD gates. See `workers/sync/specs/rc_out.md` §4b "§ Settlement".

**Delivery IDENTITY — a natural key may only be built from facts that DO NOT GET CORRECTED (2026-08-08, L-040b).** This is the same principle as the rest of this section, applied one level down: not "which value wins" but "is this even the same row". The old key `(transaction_date, batch_code, block_loc, weight_kg)` omitted the truck plate and contained three human-correctable facts, so a corrected batch code, block or weight made the sync stop recognising the row and **INSERT a second one**. Note what that rules out: a human-edit latch would have prevented neither confirmed incident, because nothing was overwritten. Four rules now govern it (full spec: `workers/sync/specs/deliveries.md` §3):

1. **ONE definition, shared by both writers.** `workers/sync/src/lib/deliveryIdentity.ts` — used by the email path AND the Sheet path, and by the last-instant `insertIfAbsent` race guard, so no two of them can disagree about what "the same row" is. Two writers with two identities duplicate each other; that is BUG-016's shape.
2. **A field removed from an identity is ADDED to the comparison in the same change.** Dropping `batch_code` from the key alone would have made a corrected code match and then read as a silent NOOP — invisible instead of duplicated, which is strictly worse.
3. **A disagreement on a formerly-key field is HELD, never auto-applied.** `batch_code` / `block_loc` / `weight_kg` are exactly what a person corrects, so a mismatch means one source is stale. It becomes a held row naming BOTH sides for arbitration in Sync Review — the section's governing rule, applied to identity.
4. **Check the ORDER of the guards, not only their content.** gsheet decided UNMAPPED before matching, so a known truckload under an unrecognised code held vaguely forever and, if the code was pattern-valid, the batch auto-create policy would have created a batch and inserted a **second copy of a delivery already in the database**. The identity check runs first now.


**Production schedule ownership — "follow until touched" (2026-07-30, Phase A).** The daily plan (`production_schedule`) has two upstreams — Renzo's PROD SCHED tab and Joseph Go's emailed schedule — and is becoming a human-editable master. The sync's Stage-3c refresh used to upsert EVERY `plan_date` on EVERY run, re-applying the same email over and over; that re-application is precisely the clobber mechanism this section forbids. It is now **conditional**, per day:

1. **Incoming revision unchanged from what the row carries (or already parked on it) → write NOTHING.** Not a careful write — no write at all. The steady state of this stage is a **zero-write run**.
2. **Production already reported for the date** (a `production_shifts` row exists) → **frozen**, never written, whoever owns it.
3. **`owner = 'human'` and the upstream value differs** → the row is NOT written; the proposal is parked in `pending_upstream` and surfaced as a `schedule_conflict` run finding + a `view_production_schedule_conflicts` row. **The human arbitrates** — same rule as every other disagreement in this section.
4. **`owner = 'human'` and the upstream value now MATCHES** → clear `pending_upstream`, hand ownership back. Reality caught up; not a conflict.
5. **A day the upstream no longer mentions is untouched.** Absence is never deletion — `fn_apply_schedule_upstream` has no DELETE at all.
6. **Every write is conditional on `row_version`, checked in the same statement as the write.** Editing in-app is what flips ownership to `human`; there is no separate lock toggle, and lock granularity is the **whole day**.

`source_rev` (`<source>|gm<threadId>.<uid>|<12-hex day hash>`) is what makes rule 1 decidable. Full spec: **`workers/sync/specs/prod_schedule.md`**. Phase B (the in-app editing UI) is not built yet; the write path (`fn_save_schedule_day`) and the read model already exist.

**Production FACTS — the human-edit latch (2026-08-03).** The same principle, applied to the six *actuals* tables the sync writes (`production_shifts`, `production_runs`, `production_downtime`, `production_waste`, `electricity_readings`, `truck_readings`). The sync's apply used to turn every `VALUE_CHANGED` into a bare `UPDATE … WHERE id = …`, so a number Renzo corrected in the app would be reverted on the next run — MC's workbook still says the old value. Now:

1. **A row a human edited in the app is never updated by the sync.** `human_edited_at` is set by the **trigger** `fn_stamp_human_edit` on every write where `auth.uid()` is non-null, so no app write site can forget to claim its row; the sync's service-role writes have no `auth.uid()` and never stamp.
2. **The guard is `human_edited_at IS NULL` inside the UPDATE's own WHERE** — `fn_apply_production_upstream(p_ops)` is the sync's ONLY update path into these tables. A save that lands between classify and apply wins and comes back `human_edited`. Never a read-then-write; a bare `db.update()` on a fact table is a bug.
3. **The disagreement is surfaced, not parked.** A refusal becomes a `production_human_edited` run finding naming the row and BOTH values. Nothing is stored: MC's/Ivy's workbook is cumulative, so the finding re-fires every run until the human resolves it. (This is why production needs no `pending_upstream`, and no `row_version` — the latch is monotone, so there is no ABA race for a version token to catch.)
4. **`fn_release_production_rows(table, ids)` is the way back**, exposed as `releaseProductionRows` in `app/(app)/production/actions.ts`. Release is EXPLICIT only — a row is never auto-released just because the workbook later agrees, so rule 1 holds without exception. The stamp cannot be cleared by an ordinary write (the trigger re-stamps it).
5. **Inserts are unconstrained** — the latch governs updates only; the sync stays free to file new rows. `production_shifts` is deliberately absent from the RPC's allowlist (the sync only ever inserts shifts).

Read model: `view_production_human_edited`. Full spec: **`workers/sync/specs/production.md` §7**.

**Deliveries — the human-edit latch, and why A WARNING WRITTEN AS A COMMENT IS NOT A CONTROL (2026-08-08).** The same five rules, ported to `public.deliveries`. What makes this one worth reading is its evidence. On 2026-02-04 Renzo corrected a delivery in the app and never corrected the Google Sheet; on 2026-06-25 someone recorded that fact as an `audit_logs` **COMMENT** reading, verbatim, *"DO NOT auto-revert to the Sheet value: any Sheet-vs-DB conflict on this row must be FLAGGED for human review, never applied Sheet-wins."* The sync overrode the row anyway — on 07-03, and again on 08-07. A comment is prose in a table nothing reads at write time; it documents an intention and enforces nothing. **The instruction is now a predicate in an UPDATE's WHERE clause, which is the only form an instruction can take and be obeyed.** Never encode an operational rule as a note, a remark, or a docstring and consider it enforced.

1. **A delivery a human edited in the app is never updated by the sync.** Same trigger, `fn_stamp_human_edit`, reused verbatim (not cloned) on `deliveries`.
2. **The guard is `human_edited_at IS NULL` inside the UPDATE's own WHERE** — `fn_apply_delivery_upstream(p_ops)` is the sync's ONLY update path into `deliveries`. **Both** writers now go through it: `reports/deliveries/apply.ts` (the emailed RC DELIVERIES report) and `reports/gsheet/apply.ts` (the Sheet-wins pass). A bare `db.update("deliveries", …)` is a bug.
3. **The disagreement is surfaced, not parked** — a `delivery_human_edited` run finding (`attention`) naming the row and BOTH values, built by the ONE constructor `workers/sync/src/reports/deliveryHumanEdit.ts` so a Sheet refusal and an email refusal never read as two unrelated problems. Both sources are cumulative, so nothing is stored and the finding re-fires every run until the human acts.
4. **`fn_release_delivery_rows(ids)` is the way back**, explicit only. Unlike production it has **no server action yet** — the in-app door is not built, so today a release is a service-role call.
5. **Inserts are unconstrained.** The latch stops a correction being **overwritten**; `lib/deliveryIdentity.ts` (the two-tier identity, same day) stops a correction being **duplicated**. Complementary, and neither substitutes for the other — the latch would NOT have prevented the Feb-4 incident, which was an INSERT.

**One ₱ rule this latch needs that production did not:** `cost_basis` is one of the nine fields the latch can refuse, and the run-findings channel is **not** price-gated (it feeds the Sync panel, the Excel workbook and the digest with no `canViewPrices()` check). So a refused price is reported **by NAME ONLY** — `changed_fields` carries `{field: 'cost_basis', yours: null, sheet: null, redacted: true}`. The strip happens where the note is built and is re-applied in `normalizeReport.ts`, so the only way a ₱ reaches the channel is if both defences are removed in one edit. `formatFindingData`'s cost-key strip cannot help: it skips a top-level key whose *name* looks cost-ish, and these values are nested inside `changed_fields`.

Read model: `view_deliveries_human_edited` (no ₱ column). Full spec: **`workers/sync/specs/deliveries.md` §10**. Migration: `20260808015712_deliveries_human_edit_latch.sql`.

**Date settlement (flecon, 2026-07-29).** The same mechanism, for a different reason. flecon's write model is REPLACE-BY-DATE, so a date the sheet no longer describes correctly can have its rows DELETED — and the workbook's `JANUARY 2026` tab carries an operator year-typo (cell A75 reads `2025-01-31`) whose five movements were hand-backfilled into `2026-01-31`. Those rows survived only because the sync's window never reaches January; a watermark reset would have deleted them. `flecon_bag_date_settlements` makes that human arbitration a DB fact: a settled date is skipped entirely by every future run — no extract-compare, no classify, no replace, **no delete**. Because flecon is SINGLE-SOURCE (no second per-date witness), a settlement is an *arbitration*, not a reconciliation: NOOP days are never auto-settled, and the worker settles by itself in exactly one machine-verifiable case — an out-of-year sheet-row group whose movements already exist in the DB, movement for movement, under the tab's own year. Everything else is settled by seeding the ledger. See `workers/sync/specs/flecon.md` §6a.

**The Excel sync report — a run's loud things, in a file that outlives the run (2026-08-07).** Renzo: *"After a sync happens we should have the ability to have it generate a report for us in excel form. All the loud things you said (warnings but proceeding to enrich etc) should be reported in the excel sheet for an easier way for me to digest and track"* — stored automatically, downloaded on demand. Six rules govern it:

1. **The finding list is NOT re-derived.** `lib/sync/findings.ts::flattenRunFindings` is the ONE definition, shared with the Sync panel, so the workbook can never disagree with the screen. The worker reaches it through exactly one file, `workers/sync/src/reports/excel/findingsBridge.ts` — the only worker→app import in the codebase, and legal only because `findings.ts`, `cases-fold.ts` and `app/(app)/sync/types.ts` are provably portable (no React, no `@/` alias, no `node:crypto`, zero imports in `types.ts`). The forbidden direction remains app→worker. `RunFinding` gained a **`section`** field (the existing `report_type` vocabulary plus `blocking` and `run`) set by each builder, so nothing has to parse a key or match on prose to file a finding.
2. **Eleven sheets, always all present:** `Summary` · one per section (`Deliveries`, `RC OUT`, `Google Sheet`, `Blocking`, `RC Movement`, `Production`, `FLECON`, `Run`) · `Awaiting Review` (the durable `sync_held_cases` this run raised or re-raised) · `Run Log` (**every** progress beat, filterable by level — this is where a `warn` that never became a finding lives, and it is exactly where the August price outage was hiding). Uniform columns per section sheet, including a **`Side A` / `Side B`** pair that puts BOTH values of any two-sided fact next to each other: our plate vs Czarina's, proposed vs sheet vs movement, Sheet vs app balance, your edit vs the report, the tab it wanted vs the tabs the file has.
3. **A clean run still produces a full workbook**, every section saying "Nothing flagged". An empty report is a meaningful answer; a MISSING one is indistinguishable from a generator that quietly broke.
4. **Generation can never fail a run.** `generateRunReport` never throws — even its own failure bookkeeping is best-effort. Stage 4 runs BEFORE `finishRun` so the artifact pointer joins the result that `finishRun` persists; on `ok:false` that becomes a `report_generation_failed` finding (`attention`, never `high` — nothing operational is wrong). A crashed or stopped run gets a report too, from `failRun` / `cancelRun`, because a dead run is exactly when the log is worth reading.
5. **Deterministic Storage path** `<Asia/Manila date of started_at>/<run_id>.xlsx`, uploaded `upsert:true` — idempotent under DBOS replay and browsable one folder per operating day. The friendly download name is recorded separately.
6. **The download is a 60-second signed URL minted server-side** (`app/(app)/sync/reports.ts::getSyncRunReportUrl`), never a public URL and never the service-role key in a browser. It prefers the newest **successful** artifact, not simply the newest row — a failed regeneration must not take away a file that is still valid.

Full architecture: `app/(app)/sync/CONTEXT.md` → "Excel sync report".

## UI Design System — The "Excel Standard"

All data tables must feel like dense spreadsheets:

- **Layout:** `table-fixed` with explicit pixel widths (e.g., `w-[120px]`)
- **Density:** `px-2 py-1` cell padding, `text-xs`/`text-sm` font sizes, `h-8` row height
- **Numerics:** `font-mono` for all numeric data, right-aligned
- **Spinners:** Hide number input spinners via global CSS (`appearance: textfield`)
- **Currency (Accounting format):** `flex justify-between` — ₱ symbol pinned left, number pinned right
- **Remarks:** Truncate with `max-w-[200px] truncate`, show full text via Tooltip or Popover on hover

### "Never crush, always scroll"

> A dense data table/grid must never compress cell content below its intrinsic minimum.
> Give every `table-fixed` table (and every CSS grid of data cells) an explicit
> **min-width equal to the sum of its column minimums**, wrap it in `overflow-x-auto`,
> and let the wrapper scroll horizontally when the viewport is narrower. **Never rely on
> a bare `w-full` + one `w-auto`/unset/`minmax(0,1fr)` column to absorb leftover space —
> that column is the one that silently crushes.** Fill when roomy, scroll when tight.

Reference implementations: `rc-movement-matrix.tsx` (`width:'max-content'` + full
colgroup), `flecon-bags-view.tsx` (computed `minWidth = W_DATE + W_PARTICULAR +
n×MIN_BAG_W`), and `schedule-table.tsx` (explicit `minWidthClass` prop, required of
every caller). The CSS-grid form of the rule is `.blocking-grid-cols` in `globals.css`
— `minmax(104px, 1fr)`, never `minmax(0, 1fr)`.

## Error Toasts (HARD RULE)

Every error toast — and every inline error UI — MUST persist until the user manually dismisses it and MUST include a Copy button that copies the full error text to the clipboard.

- **Use `errorToast()` from `lib/toast.ts`** — never call sonner's `toast.error()` directly. The wrapper enforces `duration: Infinity`, a close button, and a Copy action.
- For inline errors (e.g., a banner inside a panel rather than a toast), include a small "Copy" button next to the message.
- Success/info/warning toasts can still auto-dismiss — this rule is for ERRORS only.

**Why:** users paste errors into Claude chats for debugging. Auto-dismissing toasts force a screenshot, which wastes tokens on OCR.

## Motion & Glass Design System

Blackwood uses selective animation and frosted glass effects for polish without sacrificing the Industrial Spreadsheet density.

**Principles:**
- **Functional, not decorative** — animations communicate state changes (reveals, entrances, feedback)
- **Duration budget:** 150ms micro-interactions, 250ms reveals, 300ms max
- **Compositor-only:** Only animate `transform`, `opacity`, `filter` — never `width`, `height`, `top`, `left`
- **Never animate table rows** — no stagger, no fade-in on 600+ cell data tables

**Canonical glass patterns** (by surface type):

| Surface | Pattern | Use case |
|---|---|---|
| Sticky table header/footer | `bg-muted/90 backdrop-blur-sm` | TableHeader, TableFooter in master tables and bulk inputs |
| Dialog/AlertDialog content | `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80` | DialogContent, AlertDialogContent |
| Dialog/sheet headers | `bg-background/90 backdrop-blur-sm` | Sticky headers inside add/edit dialogs |
| Popovers & dropdowns | `bg-popover/95 backdrop-blur-lg` | PopoverContent, DropdownMenuContent |
| Floating bars | `bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60` | FloatingStatusBar, DeliverySheetFooter |

**Animation utilities** (defined in `globals.css`):

| Class | Duration | Use case |
|---|---|---|
| `animate-fade-up` | 250ms | Single element reveal (empty states, selection bars) |
| `animate-fade-in` | 150ms | Opacity-only fade (micro-interactions) |
| `animate-scale-in` | 200ms | Container entrance |
| `animate-blur-in` | 300ms | Page-level reveal, loading overlays |
| `animate-modal-enter` | 250ms | Dialog/AlertDialog spring entrance |
| `animate-badge-pop` | 250ms | Notification count |
| `stagger-children` | 250ms + 50ms stagger (6 slots) | Dashboard cards, activity feeds |
| `stagger-fast` | 200ms + 30ms stagger | Smaller groups, field change cards |
| `hover-lift` | 200ms | Cards — translateY(-1px) + shadow |
| `scroll-fade-bottom` | — | Gradient fade at scroll edge |
| `animate-status-grow` | 200ms | Status bar selection indicator entrance (scaleX/Y from right) |

**Row hover:** Use `transition-all duration-150` (not `transition-colors`) on table body rows for smooth hover effects.

**What NOT to animate:**
- Table rows, cells, or cell selection highlights
- Per-row entrance on virtual scroll tables (rows recycle — animation would re-fire)
- Filter changes or search results
- Bulk input grid cells
- Any element that renders 100+ instances

## Frozen Panes (sticky rows/columns)

For Excel-style tables that freeze left columns and/or the header row while the rest scrolls. **This is the OPPOSITE of the glass rule above.** Glass (`/<opacity>` + `backdrop-blur`) is for surfaces floating over EMPTY space. A frozen column, frozen header row, and especially the top-left corner sit ON TOP of scrolling content — so **any alpha lets the moving cells bleed THROUGH them.** Frozen surfaces that overlap scrolling content are **ALWAYS fully OPAQUE — never glass.**

**The rules (canonical — shared utilities live in `globals.css`):**

- **Opaque backgrounds only.** Use a SOLID theme token matched to the surface — body cells `bg-background`/`bg-card`, header cells `bg-muted` (solid, NOT `bg-muted/90`). No `/opacity`, no `backdrop-blur` on any sticky cell.
- **Strict z-scale**, applied consistently in every frozen table via the shared classes:

  | Surface | Utility class | z-index |
  |---|---|---|
  | Normal scrolling body cell | _(none)_ | base / auto |
  | Sticky LEFT column body cell | `.frozen-col` | 10 |
  | Sticky HEADER row cell | `.frozen-row` | 20 |
  | Sticky FOOTER row cell | `.frozen-row-bottom` | 20 |
  | Top-left CORNER (sticky-left **and** sticky-top) | `.frozen-corner` | 30 |
  | Bottom-left CORNER (sticky-left **and** sticky-bottom) | `.frozen-corner-bottom` | 30 |

- **Offsets:** sticky left columns use cumulative `left` offsets from each frozen column's explicit pixel width (a column's `left` = sum of widths to its left). The header row is `top: 0`; a sticky footer row is the mirror, `bottom: 0`. Top corner cells are BOTH sticky-left and sticky-top; bottom corner cells are BOTH sticky-left and sticky-bottom (highest z, 30).
- **Frozen FOOTER (bottom-pinned summary).** A sticky `<tfoot>` pinned to the container bottom is the exact mirror of the frozen header — same opaque-only discipline (solid `bg-muted`, never glass), same cumulative `left` offsets for the cells under the frozen left columns. Use `.frozen-row-bottom` for the scrolling footer cells and `.frozen-corner-bottom` for the bottom-left corner cells. Footer rows may be taller than data rows when they stack multiple values — keep them compact (`text-[10px]`/`text-[11px]`, tight leading).
- **Row state repaints opaquely.** Hover tint, zebra striping, and any row-status tint must be applied to the frozen cells too (e.g. `group-hover:bg-muted/50` layered over the opaque base) — otherwise the pinned cells diverge from the scrolling cells. The opaque base under the tint is what prevents bleed-through.
- **Kill the seam.** A 1px sliver can bleed at the frozen↔scroll boundary. Put `.frozen-edge` on the LAST frozen column (solid inset right border + soft shadow) and `.frozen-edge-top` on a sticky footer row (solid inset top border + upward shadow) — both hide the seam and visually separate the pinned region.

This is platform-level presentational guidance, tenant-neutral. Reference implementations: RC Movement matrix (`app/(app)/inventory/rc-movement/rc-movement-matrix.tsx`) and the Cenapro production ledger (`app/(app)/cenapro/production/production-ledger-grid.tsx`).

## RC IN Column Config

Strict left-to-right order for the delivery input/table:

| Column | Format |
|---|---|
| Date | `yyyy-MM-dd` |
| Supplier | text |
| Batch Code | text |
| Block/Loc | text |
| Truck Plate | text |
| Sacks | integer |
| Weight (kg) | 0 decimal |
| MC, Grit, VM, Ash, FC | 2 decimal |
| BD ASTM, BD JIS | 3 decimal |
| PHP/KG | accounting (₱) |
| PHP Total | accounting (₱) |
| Remarks | truncated text |

## Navbar & Page Titles

The persistent navbar (`components/navbar.tsx`) owns all page titles and descriptions — **pages must not render their own title/description headers**. Instead, add entries to `getBreadcrumb()` in the navbar component.

- **Left side:** Breadcrumb — `← Back to {parent} / {Page Title}` + muted description
- **Center:** "Blackwood" (always visible, links to `/`)
- **Right side:** Dev role switcher (Owner/Admin/Dev only), dark mode toggle, notifications, profile dropdown
- On the dashboard (`/`), the left side is empty — no redundant "Dashboard" label
- The navbar is dark-themed (`bg-zinc-800 dark:bg-zinc-700`) and uses `ssr: false` dynamic import to avoid Radix hydration mismatches

When adding a new page/module, register it in `getBreadcrumb()` with `backLabel`, `backHref`, `pageTitle`, and optionally `pageDescription`.

## Module Pattern (RC IN as reference)

Each module follows this structure in `app/<module>/`:
- `page.tsx` — Server component, fetches data, passes to client components
- `actions.ts` — Server actions for CRUD operations
- Client components for UI (bulk input forms, data tables)

**Key business logic** in `lib/rc-utils.ts`:
- `calculateWhse()` derives warehouse from block location first letter (F→FEED, A→WHSE A, etc.)

## Conventions

- Shadcn components live in `components/ui/` — use `cn()` from `lib/utils.ts` for class merging
- Month-based pagination: each "page" represents a calendar month
- Lab results are stored as nested JSONB, not flat columns
- Seeding script at `scripts/seed_rc_in.ts` for CSV import of legacy data

## Component Context Files

Each major module has a co-located `.md` context file documenting its files, data, behaviors, and cross-references. These eliminate redundant codebase exploration.

### Reading Rule (MANDATORY)
Before exploring or modifying any module, agents **MUST** read its `CONTEXT.md` first. Check for `CONTEXT.md` in the working directory and parent directories.

**Context file locations:**
- `app/(app)/CONTEXT.md` — Home Daily Sync Digest (`/`, server-rendered bands)
- `app/(app)/inventory/CONTEXT.md` — Inventory route map (submodule catalog)
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log)
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage)
- `app/(app)/inventory/blocking/CONTEXT.md` — Blocking (Warehouse Grid Visualization)
- `app/(app)/inventory/rc-movement/CONTEXT.md` — RC Movement (feeding matrix)
- `app/(app)/inventory/flecon-bags/CONTEXT.md` — FLECON Bags (packaging-material inventory)
- `app/(app)/production/CONTEXT.md` (+ `daily/`, `electricity/`, `trucks/`) — Production module
- `app/(app)/summaries/CONTEXT.md` — Summaries
- `app/(app)/review-queue/CONTEXT.md` — Sync review queue
- `app/(app)/jarvis/CONTEXT.md` — Jarvis route (UI lives in `components/jarvis/`)
- `app/(app)/cenapro/CONTEXT.md` — Cenapro tenant (CI/Cebu)
- `app/(app)/cenapro/deliveries/CONTEXT.md` — RC Deliveries (Cenapro raw-charcoal receipt ledger)
- `app/(app)/admin/CONTEXT.md` — Admin Panel (User Management)
- `components/digest/CONTEXT.md` — Home Digest bands (the `/` presentation components)
- `components/jarvis/CONTEXT.md` — Jarvis chat UI (mounted via `app-shell.tsx`)
- `components/shared/grid/CONTEXT.md` — Blackwood Table (universal cell selection, inline editing, keyboard nav, context menu — the agnostic grid primitive all data grids share)
- `components/NAVBAR.md` — Navbar (page titles, breadcrumbs)
- `components/providers/AUTH.md` — Auth Provider (permissions, dev override)
- `components/NOTIFICATIONS.md` — Notifications (realtime bell)

### Update Rule (STRICT)
Every code change **MUST** update the relevant `CONTEXT.md` in the same changeset. This includes: adding/removing files, changing server actions, adding DB tables/columns, changing cross-module imports, adding new pages.

### Creation Rule
Create a new `CONTEXT.md` when a module reaches 3+ files AND 200+ total lines. Use the standard template: **Purpose > Files > Data > Key Behaviors > Dependencies > See Also**.

**Naming convention:**
- Modules (directories): `CONTEXT.md`
- Standalone components (single file in shared dir): `<NAME>.md` (e.g., `NAVBAR.md`)

## Home Digest (`/`)

The home page at `/` is the **Daily Sync Digest** — a read-only, top-to-bottom operational briefing rendered as a Server Component (`app/(app)/page.tsx`). It replaced the archived widget dashboard (`_archived/dashboard-v1/`). It never talks to Supabase from the client: one server-side **adapter**, `getDigestData()` in `lib/digest/queries.ts`, queries the `view_digest_*` views (plus blocking + flecon balance) and returns a single normalized `DigestData` object (`lib/digest/types.ts`). Each band is a presentation component in `components/digest/` that consumes one slice of that object — the same port/adapter discipline the widget dashboard used, minus the composable grid.

### Bands (render order, top → bottom in `page.tsx`)

| # | Band component | `DigestData` slice | Purpose |
|---|---|---|---|
| — | `DigestHeader` | `meta` | Operational date, last-sync time, per-stream freshness |
| 1 | `OpenBlocks` | `openBlocks` | Currently **IN-USE** blocks (balance + lab stats), surfaced at the very top |
| 2 | `KpiHero` | `kpis` | Today's headline KPIs with sparklines |
| 3 | `DigestCharts` | `flow`, `price`, `grades` | Daily RC-in/out flow, ₱/kg price (price-gated), production grades |
| 4 | `TrucksSummary` | `trucks` | Trucks with a trip on the operational date (skips if none) |
| 5 | `BagInventory` | `fleconBags` | FLECON bag balance snapshot |
| 6 | `SyncSummary` + `ActivityFeed` | `latestSync`, `activity` | What the last sync brought in |
| 7 | `DigestFooterBand` | `flags`, `monthToDate` | Data-quality flags + month-to-date totals |

### Rules
- The digest is **presentation-only** — all aggregation happens in the `view_digest_*` SQL views, never in TypeScript.
- **Price gating:** ₱/kg data in `DigestCharts` and `openBlocks[].phpKg` must be nulled server-side in `getDigestData()` when `!canViewPrices()`. See the Price gating boundary above.
- See `components/digest/CONTEXT.md` and `app/(app)/CONTEXT.md` for the full band-by-band architecture.

## Blocking Module

Blocking is a **standalone route** at `/inventory/blocking` — a warehouse grid visualization of 220 block locations across 4 warehouses (A/B/C/D). Uses `view_blocking_grid` SQL view for pre-computed data, CSS Grid heatmap cells, slide-over detail panel with delivery/usage history. See `app/(app)/inventory/blocking/CONTEXT.md` for full architecture. Key patterns: role-gated cost data, heatmap coloring by balance percentage, spotlight status filter with dim/glow effect.

## Agent Model

When spawning subagents via the `Task` tool, always use `model: 'opus'` (maps to the latest Opus, currently Opus 4.8). All project implementation subagent definitions in `.claude/agents/` (frontend-design, backend, etc.) are pinned to `model: opus`. Do not default to sonnet or haiku for implementation work in this project.

**Carve-out — the four ICTC sync employees run on Sonnet for routine daily runs.** `gsheet-sync`, `deliveries-manager`, `rc-out-manager`, and `production-manager` are pinned to `model: sonnet`. Their daily PROPOSE/EXECUTE path is deterministic-Python-heavy (extract → classify → diff happens in Python; the agent only orchestrates + judges), so Sonnet is the daily driver. **Escalate an individual sync run to Opus ONLY for genuine conflict adjudication** — a flagged conflict, an ambiguous batch mapping, or a ledger-HOLD decision — by re-launching that agent (or that one row) on Opus, never by the agent self-upgrading. The "always Opus" rule still holds for every implementation agent; this carve-out applies exclusively to the four sync ingestion employees.

## Agent Prompts

All prompts written for Claude Code are saved as `.md` files in `.agents/prompts/`. This is canonical project behavior.

**Why:** Pasting multi-step prompts directly into the terminal breaks formatting when they contain code fences, backticks, TypeScript, or SQL. A file sidesteps this entirely.

**How to invoke a saved prompt in Claude Code:**
```
Read .agents/prompts/<filename>.md and follow the instructions.
```

**Naming convention:** Use kebab-case describing the task, e.g., `wire-supabase-adapters.md`, `kpi-strip-customization.md`.

**When writing a prompt:**
- No nested code fences — use indented prose to describe code shapes instead
- Always start with: read TIMELINE.md, CLAUDE.md, and the relevant CONTEXT.md(s) before starting
- Always include: enter plan mode first, get approval, then execute
- Always end with: give me a summary of what was built, what files changed, and any decisions made

**Prompt archive:** Every prompt lives permanently in `.agents/prompts/`. Do not delete old prompts — they serve as a history of intent and a reference for future agents.

## Git Workflow

- **`main`** — protected, production-ready. **Vercel deploys the PRODUCTION app (the live URL) from `main`** (project `blackwood`, org `team_TmPJkyEy…`, region `hnd1`; no production-branch override in `vercel.json`, so it defaults to the repo default branch `main`).
- **`dev`** — staging/integration branch
- **`feat/*`** — feature branches, branched from `dev`
- Use **conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

**Deploying to the live site (READ THIS before "push to live" / "make it live"):** pushing a `feat/*` branch only produces a Vercel **preview** deployment — it does NOT touch the live URL. To ship live you must land the work on **`main`** (merge `feat/* → main`, or `feat/* → dev → main`), then push `main`; Vercel auto-deploys production on that push. Merging to `main` is protected + hard-to-reverse — confirm scope with the user first, do it via the `git-branch-guardian` subagent, never force-push, and stop + report if the merge isn't clean.

### There are TWO deploy targets, and `main` only covers one of them

**Merging to `main` does NOT deploy the sync worker.** Vercel builds the Next.js app in this repo and nothing else; `workers/sync/` is a separate artifact running on **Fly.io** (app `blackwood-sync`, region `nrt`) that ships **only** on an explicit deploy. Anything under `workers/sync/**` — extractors, classifiers, reconcilers, the Excel report generator, price enrichment — is inert in production until someone runs it.

| Change touches | How it reaches production |
|---|---|
| `app/**`, `lib/**`, `components/**`, migrations | merge to `main` → Vercel auto-deploys |
| `workers/sync/**` | merge to `main` **and then** `cd workers/sync && npm run deploy` |

This gap is not theoretical: on **2026-08-08** a full day of sync fixes (the delivery-identity two-tier key, the human-edit latch, Czarina's tab resolved by month) was merged, green and live on the website while the Fly machine still ran a five-day-old bundle — and the deploy that would have shipped them had been failing the whole time on a broken container build. When a task says "ship the sync fix", the deploy is part of the task.

**`npm run deploy` (from `workers/sync`) is the only sanctioned command** — never a bare `flyctl deploy`. It runs the required `verify:container-build` gate first, sets the build context to the **repo root** (the worker's Excel report imports `lib/sync/findings.ts` across the package boundary, so the image must contain it), and passes the commit sha in as a build arg. A bare `fly deploy` gets the context wrong and fails on the first `COPY`. Full reasoning: `workers/sync/DEPLOY.md`.
