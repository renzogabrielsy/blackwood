# Cenapro Schema Design — onboarding the second tenant to Blackwood

> **Status: DESIGN DOC ONLY.** No migrations created, no database touched, no ICTC code modified. Every block of DDL below is an **illustrative sketch, not yet applied**. Code starts in a later session, only after Renzo locks the open questions in §12.
>
> **Branch:** `feat/cenapro-integration`
> **Authored:** 2026-06-01
> **Authoritative source (the contract):** `~/CI-ICTC-Inventory-App/docs/schema-extraction.md` (codo's human-walkthrough-corrected schema spec for the *same* source workbook). This doc **ports** codo's entity model and 28 business rules to Postgres/Supabase; it does not reinvent them. Where codo already answered something (warehouse canon, BATCH-as-TEXT, the disposition taxonomy, the validity matrix), this doc cites codo and follows it.
> **Domain background:** `~/CI-ICTC-Inventory-App/PROJECT_BRAIN.md` (plain-English model + §4.7 information-density principle).
> **Pattern source:** `~/CI-ICTC-Inventory-App/docs/reference/architecture-reference.md` (canonicalize-at-write / drift log / state machine / append-only migrations).
> **Row counts / data-quality samples only:** `/Users/renzosy/blackwood/cenapro/CENAPRO_PRODUCTION_ANALYSIS.md`. ⚠️ That file's **entity model is WRONG** — it guessed `C1–C4 / RK1–RK4` were quality classes. They are a downstream **partner's 4 crushers + 4 rotary kilns**. codo's spec is authoritative. This doc does **not** propagate that error.

---

## 1. Overview & scope

### 1.1 What Cenapro is

Cenapro (the main CI / Cebu charcoal company) hand-maintains a single multi-tab Excel binary workbook — `2025 CI PRODUCTION V2.xlsb` — as its production + finished-goods ERP. The same workbook is the source codo (a sister desktop app) was built against. We are onboarding it as **Tenant #2** on the Blackwood platform, entirely decoupled from the existing ICTC tenant.

The workbook encodes **one flat event-ledger spine** (the `Production` sheet). Every row is one of **three flows**, discriminated by the `CCC / FLEC` column:

1. **CI bagging** (`CCC/FLEC = FLEC`) → CI bags finished charcoal into flecon **bags**, stored in WHSE 1/2/5/7 with a side (`LS`/`RS`) and a grade. **Inflow** to the flec inventory ledger.
2. **Partner feeds** (`CCC/FLEC = C1–C4` crushers, `RK1–RK4` kilns) → a downstream partner company draws CI charcoal into its own equipment and reports daily. **Outflow** to the flec ledger *only when* `SRC = FLEC` (drawn from already-bagged stock). Tank-stage and plant-direct partner draws touch no warehouse balance.
3. **DVO** → Davao (the ICTC sister plant) ships container vans to Cebu, stored in WHSE 3 in **kg** under batch codes like `NOVEMBER2025RIGHT`. **Deferred in v1** (see §1.3).

### 1.2 In scope (v1)

- **CI production spine** — the `Production` sheet → `cenapro.production_event` (one row per workbook row, **excluding** `SRC = DVO` rows).
- **CI flec inventory** — the per-warehouse flec ledger for **WHSE 1/2/5/7** (flec-count units, per `(grade, side)` running balance), re-derived in SQL.
- Lookup/dimension tables for shift, grade, plant, warehouse, source location, partner equipment.
- Opening balances (`cenapro.warehouse_opening_balance`) replacing the workbook's hand-typed `STARTING` blocks.
- `cenapro.drift_log` + canonicalize-at-write server actions.
- A one-shot backfill of the **current** `.xlsb` (read via `pyxlsb`).
- A Cenapro domain module (`app/(app)/cenapro/…`) + Cenapro adapters (`lib/widgets/adapters/cenapro-*.ts`).

### 1.3 Out of scope (v1) — DVO deferred entirely

Per Renzo's locked scope, **all DVO modeling is deferred**:

- **No** `cenapro.dvo_batch`, **no** `cenapro.dvo_receipt`, **no** WHSE 3 / kg-per-batch ledger.
- The workbook sheets `DVO IN`, `DVO OUT`, `PC W3`, `PC W3 - DVO`, `PC WA7 - DVO` are **not** ingested.
- The ~120–145 `SRC = DVO` rows in the `Production` spine are **not imported as events** in v1. The backfill routes them to `cenapro.drift_log` with `kind = 'dvo_row_deferred'` (an excluded bucket) so they are visible and re-ingestable later — never silently dropped. See §10.4 for the alternative (a quarantine table) and why drift_log is the v1 recommendation.

> codo *does* model DVO (it has `dvo_batch` + `dvo_receipt` and a `dvo_batch_ledger`). Blackwood v1 **diverges** by deferring it — but the schema is shaped so DVO drops in later **without a rewrite** (§11).

The existing ICTC tenant (`deliveries` / `rc_out` / `batches` / `production_*` and all its sync agents) is **UNTOUCHED**. Cenapro shares **zero** code, tables, triggers, or enums with ICTC.

### 1.4 The workbook is live

codo's frozen snapshot was 769 rows @ 2026-05-07. The current file (`CENAPRO_PRODUCTION_ANALYSIS.md`, 2026-06-01) is **906 weight-bearing rows** (1166 incl. legend/blanks), data spanning **2025-12-01 → 2026-05-28** (`CCC RECV`), production dates from **2025-11-28**. The backfill must read the **current** file, not codo's numbers. Total ΣWT ≈ 13.25M kg (≈ 2.49M of which is DVO and therefore excluded in v1).

---

## 2. Tenant placement on the platform

### 2.1 Recommendation: a dedicated Postgres `cenapro` schema

**Recommended: a dedicated Postgres schema `cenapro`** (e.g. `cenapro.production_event`), **not** `cenapro_`-prefixed tables in `public`, and **not** a `tenant` discriminator column on shared tables.

| Option | Verdict | Reasoning |
|---|---|---|
| **Dedicated `cenapro` schema** | ✅ **Recommended** | Hard separation becomes *structurally self-enforcing*. ICTC's sync agents query `public.*`; they physically cannot reach `cenapro.*` by accident. Cenapro and ICTC reuse the same words (`WHSE`, `GRADE`, `SHIFT`, `FLEC`) with **different meanings** — separate namespaces stop cross-contamination cold. Clean to drop/rebuild during the v1 iteration without risking ICTC. |
| `cenapro_`-prefixed tables in `public` | ❌ | Works, but every ICTC query (`list_tables`, ad-hoc `SELECT`, the auto-generated `types/supabase.ts`) now sees Cenapro tables intermixed. Naming collisions are only avoided by discipline, not by structure. The "zero coupling" rule wants a wall, not a prefix convention. |
| `tenant` discriminator column on shared tables | ❌ **Rejected** | The two domains share **no columns** — Cenapro's `production_event` (disposition_kind, partner_equipment, flec_count, whse_side) has nothing in common with ICTC's `production_runs` (customer, grade, ttl_kg, waste streams). A discriminator forces a false-shared table and couples the tenants at the schema level — the exact opposite of the requirement. |

### 2.2 Supabase / PostgREST exposure implications (important)

A non-`public` schema is **not exposed by PostgREST / supabase-js by default**. To make `cenapro.*` reachable from server actions:

1. **Expose the schema to the API.** In Supabase, the exposed schemas list (Dashboard → Settings → API → "Exposed schemas", which sets PostgREST's `db-schemas` / `pgrst.db_schemas`) must include `cenapro`. This is a **project config change** Renzo applies (or a migration sets via `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, cenapro';` followed by `NOTIFY pgrst, 'reload config';`). **Flag for Renzo — this is the one non-DDL prerequisite.**
2. **Grant usage + privileges.** `GRANT USAGE ON SCHEMA cenapro TO authenticated, anon, service_role;` plus per-object `GRANT SELECT/INSERT/UPDATE/DELETE` (mirroring how ICTC grants — see the production migrations, which `GRANT SELECT ... TO authenticated`).
3. **Querying from supabase-js.** Two equivalent paths:
   - `supabase.schema('cenapro').from('production_event')` (explicit per-call schema), **or**
   - a dedicated client created with `createClient(url, key, { db: { schema: 'cenapro' } })` living in a Cenapro-only module (e.g. `lib/cenapro/supabase.ts`), so Cenapro server actions never accidentally hit `public`.
   - **Recommendation:** the dedicated-client path — it reinforces the wall and keeps `app/(app)/cenapro/actions.ts` visibly scoped.
4. **`types/supabase.ts` generation.** `supabase gen types typescript --linked` emits types for **all exposed schemas**; once `cenapro` is exposed, regenerating yields a `Database['cenapro']` namespace alongside `Database['public']`. The generated `Tables<>`/`TablesInsert<>` helpers from `@/types/supabase` continue to work; Cenapro code references `Database['cenapro']['Tables']['production_event']`. **Until the schema is exposed + types regenerated, Cenapro server actions use a `(client as any)` cast** — the exact stopgap ICTC used for `view_rc_movement` before its types landed (see the project-rc-movement memory note). Remove the cast once types regenerate.

> **Divergence from codo #0:** codo ships SQLite/libSQL with no schema/PostgREST concept; placement there is trivial. On Supabase, schema exposure + grants + types-regen is real work — hence this section. This is purely a platform-boundary translation, not a model change.

> **SHIPPED — read accessors then WRITE path (migrations `..341` read, `..342` write).** The exposure problem was solved WITHOUT the dashboard toggle: thin READ-ONLY `public.cenapro_*` look-through accessors (a view + RPC passthroughs, all SECURITY INVOKER) surface the handful of shapes the UI needs in the served `public` schema; the `cenapro` schema stays unexposed and remains the sole home of data + logic. When Cenapro became the **maintaining app** (editable screens replacing the `.xlsb`), writes were added the same way: **`public.cenapro_production_events` is an auto-updatable view** (simple single-table projection — Postgres reports `is_insertable_into`/`is_updatable` = YES, `is_trigger_*` = NO), so a plain `GRANT INSERT, UPDATE, DELETE ... TO authenticated` lets `supabase.from('cenapro_production_events').insert()/.update()/.delete()/.upsert()` rewrite to base-table DML — the base BEFORE trigger still fires (computes `unique_tag` + `batch_year`), defaults fill, FK + CHECK validate. **No INSTEAD OF trigger and no write-RPC were needed** (the RPC fallback the v1 plan allowed for was unnecessary). `unique_tag`/`batch_year` are trigger-computed — a client-supplied value is overwritten. Opening-balance writes go through the dedicated `public.cenapro_set_opening_balance` RPC (§4.3) because that table needs append-only INSERT semantics, not arbitrary view DML.

### 2.3 Hexagonal placement (platform vs tenant)

Cenapro plugs into the platform **exactly** like ICTC — through the data-agnostic widget interfaces, never by touching platform code:

- **Domain module (tenant layer):** `app/(app)/cenapro/` — a Production page + a Flec Inventory page, following the ICTC module pattern (`page.tsx` server-fetches, `actions.ts` holds `'use server'` mutations calling `revalidatePath()`, client components for the Industrial-Spreadsheet grids). Register in the navbar `getBreadcrumb()` and `MODULES` array.
- **Adapters (tenant layer):** `lib/widgets/adapters/cenapro-production.ts`, `lib/widgets/adapters/cenapro-flec-inventory.ts` — pure functions turning `cenapro.view_*` rows into `ChartConfig` / `KPIData` / `WarehouseOccupancy`-style frames.
- **Widgets / dashboard shell (platform layer):** **zero changes.** Per `CLAUDE.md`, platform code holds no tenant knowledge. Cenapro adapters live *alongside* — never *inside* — the charcoal/ICTC adapters.

This is the Grafana data-source model the platform is built on: the widget is the core/port; the Cenapro adapter is just another adapter filling the same typed contract.

---

## 3. Entities & relationships (text ER)

Ported from codo §6 + `PROJECT_BRAIN.md` §7, with DVO entities removed for v1.

```
                          ┌──────────────────────────┐
                          │  plant  (W6 | W7 | DVO*)  │   *DVO plant row kept as a
                          └────────────┬─────────────┘    lookup for FK forward-compat,
                                       │ produces                but no DVO events in v1
                                       ▼
  shift ──────┐            ┌────────────────────────────────────┐         ┌── grade (3X50|2X6|3.5|4X8)
  (M|E|N)     ├─classifies►│        production_event             │◄─tagged─┤
  source_loc ─┤            │  (the Production spine; one row per │         └── partner_equipment
  (TNK1-4|W6| │            │   workbook row, DVO rows excluded)  │              (C1-C4 crusher | RK1-RK4 kiln)
   W7|FLEC)   ┘            │  PK: id (surrogate)                 │
                          │  audit-only: unique_tag (computed)  │
                          └───────────────┬────────────────────┘
                                          │ disposition_kind ∈
                                          │   flec_bagging | partner_crusher | partner_kiln
                                          │
                          ┌───────────────┴────────────────┐
            flec_bagging  │                                │ partner_crusher / partner_kiln
            (warehouse_id  ▼                                ▼  (outflow ONLY when source.kind =
             set) = INFLOW │                                │   'warehouse_flec' AND warehouse_id set)
                          ▼                                ▼
                ┌────────────────────────────────────────────────┐
                │   WHSE 1 / 2 / 5 / 7  flec ledger                │
                │   per (warehouse, grade, side) running balance   │
                │   in FLEC COUNT — re-derived in a SQL VIEW        │
                │   seeded by warehouse_opening_balance            │
                └────────────────────────────────────────────────┘

  warehouse_opening_balance ──seeds──► flec ledger fn (most-recent opening ≤ user start date)

  drift_log  ◄── canonicalize-at-write failures, unique_tag collisions,
                 cosmetic WHSE=W6/W7, and (v1) every SRC=DVO row (kind='dvo_row_deferred')

  [DEFERRED v1]  dvo_batch / dvo_receipt / WHSE 3 kg-ledger — not created (§11)
```

**Cardinality notes (from codo §6, confirmed in CENAPRO_PRODUCTION_ANALYSIS §3):**
- `production_event.warehouse_id` → `warehouse` (N:1). NULL on tank-stage / plant-direct partner draws (no warehouse touched).
- `production_event.source_location_id` → `source_location` (N:1, NOT NULL).
- `production_event.partner_equipment_id` → `partner_equipment` (N:1). NOT NULL exactly when `disposition_kind != 'flec_bagging'`.
- A WHSE 1/2/5/7 row is owned by exactly one `(grade, side)` (codo rule 6); `whse_side` may be NULL on non-sided rows.
- The flec ledger is a **start-date-scoped set-returning function over `production_event` + `warehouse_opening_balance`** (`cenapro.flec_ledger(p_warehouse_code, p_start_date)`), not a stored table (mirrors how ICTC derives balances in SQL rather than storing them — `view_blocking_grid` — but parameterized by the user's start date; see §6.1).

---

## 4. Tables (Postgres DDL sketches — NOT YET APPLIED)

> All DDL below is **illustrative**. Types/conventions mirror Blackwood's existing production migrations: `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `numeric` for weights, `date` for dates, `timestamptz NOT NULL DEFAULT now()` for audit timestamps, `CHECK` constraints + natural-key `UNIQUE`, heavy `COMMENT ON`. Everything lives in the `cenapro` schema.

### 4.1 Schema + lookup/dimension tables

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED
CREATE SCHEMA IF NOT EXISTS cenapro;

-- shift: M/E/N. Only 'M' observed in real data, E/N reserved (codo §2, rule legend).
CREATE TABLE IF NOT EXISTS cenapro.shift (
  code         text PRIMARY KEY CHECK (code IN ('M','E','N')),
  display_name text NOT NULL,
  sort_order   int  NOT NULL DEFAULT 0
);

-- grade: 3X50 / 2X6 / 3.5 / 4X8. '3.5' is stored numeric in the sheet — coerce on read.
-- expected_kg_per_bag_* are soft-warning bounds for the kg/bag check (codo rule 28; app-layer only).
CREATE TABLE IF NOT EXISTS cenapro.grade (
  code                    text PRIMARY KEY,
  display_name            text NOT NULL,
  sort_order              int  NOT NULL DEFAULT 0,
  expected_kg_per_bag_min numeric,   -- e.g. 400 for 3X50/2X6; NULL = no warning (3.5, 4X8)
  expected_kg_per_bag_max numeric    -- e.g. 700 for 3X50, 650 for 2X6
);

-- plant: includes 'DVO' so source_location FK + future DVO events stay valid (forward-compat).
-- branch distinguishes CI (Cebu) from ICTC (Davao) — a label, not a coupling to ICTC tables.
CREATE TABLE IF NOT EXISTS cenapro.plant (
  code         text PRIMARY KEY CHECK (code IN ('W6','W7','W6/W7','DVO')),
  display_name text NOT NULL,
  branch       text NOT NULL CHECK (branch IN ('CI','ICTC'))
);

-- warehouse: canonical 'WHSE 1/2/3/5/7'. default_unit drives which ledger flavor applies.
-- The warehouse set is CONFIRMED (Renzo, 2026-06-01, §12 Q8 RESOLVED): exactly
-- {WHSE 1, WHSE 2, WHSE 3, WHSE 5, WHSE 7}. No WHSE 4 / WHSE 6 exists; the W6/W7 seen in
-- the workbook WHSE column are cosmetic plant noise and canonicalize to NULL (§7.2).
-- Of these five, WHSE 1/2/5/7 are flec-count storage (the v1 flec ledger); WHSE 3 is
-- seeded (default_unit='kg') so it exists for the deferred DVO ledger, but no v1 events
-- reference it.
CREATE TABLE IF NOT EXISTS cenapro.warehouse (
  code         text PRIMARY KEY CHECK (code IN ('WHSE 1','WHSE 2','WHSE 3','WHSE 5','WHSE 7')),
  display_name text NOT NULL,
  branch       text NOT NULL CHECK (branch IN ('CI','ICTC')),
  default_unit text NOT NULL CHECK (default_unit IN ('flec_count','kg'))  -- flec for 1/2/5/7; kg for 3
);

-- source_location: the truthful SRC field. kind drives the validity matrix (§8).
-- plant_code NOT NULL for tank/plant_direct/dvo_container; NULL for warehouse_flec (FLEC).
CREATE TABLE IF NOT EXISTS cenapro.source_location (
  code         text PRIMARY KEY CHECK (code IN ('TNK 1','TNK 2','TNK 3','TNK 4','W6','W7','FLEC','DVO')),
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('tank','plant_direct','warehouse_flec','dvo_container')),
  plant_code   text REFERENCES cenapro.plant(code)   -- forced plant for non-FLEC sources (§8.2)
);

-- partner_equipment: the downstream partner's 4 crushers + 4 rotary kilns.
-- (This is the entity CENAPRO_PRODUCTION_ANALYSIS got WRONG as "quality classes".)
CREATE TABLE IF NOT EXISTS cenapro.partner_equipment (
  code         text PRIMARY KEY CHECK (code IN ('C1','C2','C3','C4','RK1','RK2','RK3','RK4')),
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('crusher','kiln')),
  sort_order   int  NOT NULL DEFAULT 0
);
```

> **Divergence from codo #1 (lookup PK style):** codo uses `INTEGER PRIMARY KEY` surrogate ids on lookups with a `code` unique column. Here the lookups are tiny, fixed, canonical-code dimensions, so the **`code` *is* the primary key** (text PK) and `production_event` FKs by code. This matches ICTC's own convention — ICTC stores `grade`/`shift` as text columns with `CHECK` constraints rather than integer-FK lookups. It keeps the canonical string visible in the spine for Excel/export parity and removes a join for the common read. (Canonicalization still happens at write — see §7.)

### 4.2 Core spine — `cenapro.production_event`

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED
CREATE TABLE IF NOT EXISTS cenapro.production_event (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),     -- surrogate identity; NOT unique_tag

  recv_date              date NOT NULL,                                  -- was CCC RECV (row logging date)
  prod_date              date,                                           -- nullable (partner takeback rows omit)
  batch                  text NOT NULL,                                  -- 'NOVEMBER'..'MAY'; NOT derived from prod_date (codo rule 10)

  shift_code             text REFERENCES cenapro.shift(code),            -- nullable
  grade_code             text NOT NULL REFERENCES cenapro.grade(code),
  plant_code             text REFERENCES cenapro.plant(code),            -- nullable: NULL when source is FLEC (codo rule 27)
  warehouse_code         text REFERENCES cenapro.warehouse(code),        -- nullable: NULL on tank/plant-direct events
  source_location_code   text NOT NULL REFERENCES cenapro.source_location(code),

  weight_kg              numeric NOT NULL CHECK (weight_kg > 0),         -- was WT

  disposition_kind       text NOT NULL
                           CHECK (disposition_kind IN ('flec_bagging','partner_crusher','partner_kiln')),
  partner_equipment_code text REFERENCES cenapro.partner_equipment(code),-- NOT NULL when disposition != flec_bagging (CHECK below + trigger)
  flec_count             integer CHECK (flec_count IS NULL OR flec_count > 0),  -- bag count; was FLEC AMT

  whse_side              text CHECK (whse_side IS NULL OR whse_side IN ('LS','RS')),  -- only for WHSE 1/2/5/7
  flec_stat              text,                                           -- legacy 'DONE'; imported, never written/validated (codo Q6)

  unique_tag             text NOT NULL UNIQUE,                           -- computed at write; audit/export parity only (§9)
  notes                  text,

  -- provenance + canonicalize-at-write pattern (architecture-reference)
  source_row             int,                                            -- original .xlsb row, for backfill traceability
  provenance             text NOT NULL DEFAULT 'cenapro_xlsb',
  dirty                  boolean NOT NULL DEFAULT true,                  -- cleared after downstream op lands
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Partner rows must name their equipment; flec_bagging rows must not.
  CONSTRAINT production_event_partner_equipment_presence CHECK (
    (disposition_kind = 'flec_bagging'  AND partner_equipment_code IS NULL)
    OR
    (disposition_kind <> 'flec_bagging' AND partner_equipment_code IS NOT NULL)
  )
);

-- Natural key (advisory) mirrors the unique_tag component set, minus the dropped DVO_SIDE segment.
-- UNIQUE on unique_tag is the real guard; this composite index serves dedup/audit lookups.
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_warehouse_recv   ON cenapro.production_event (warehouse_code, recv_date);
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_grade_side_recv  ON cenapro.production_event (grade_code, whse_side, recv_date); -- ledger window
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_disposition      ON cenapro.production_event (disposition_kind);
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_plant_prod_date  ON cenapro.production_event (plant_code, prod_date);            -- summary queries
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_unique_tag       ON cenapro.production_event (unique_tag);
```

**Why every nullable / CHECK:** ported verbatim from codo §6.2 + §7. `warehouse_code` nullable because tank/plant-direct partner draws have no warehouse. `plant_code` nullable because origin plant is unknowable once charcoal is bagged into FLEC (codo rule 27). The `disposition_kind` CHECK makes the workbook's `FLEC ` trailing-space typo impossible to insert. The partner-equipment-presence CHECK is codo's rule 1/2 enforced in the schema.

> **Divergence from codo #2 (no `dvo_batch_id` column in v1):** codo's `production_event` carries `dvo_batch_id INTEGER REFERENCES dvo_batch(id)`. v1 **omits** it (no DVO). When DVO is added later, a nullable `dvo_batch_id uuid REFERENCES cenapro.dvo_batch(id)` is an additive migration — no rewrite (§11).
> **Divergence from codo #3 (`dirty` as boolean):** codo uses `INTEGER NOT NULL DEFAULT 1` (SQLite has no bool). Postgres has native `boolean` — Blackwood convention. Same semantics.

### 4.3 Opening balances — `cenapro.warehouse_opening_balance`

Replaces the workbook's hand-typed `STARTING` block (PC sheet rows 3–11). Seeds the flec ledger function (`cenapro.flec_ledger`, §6.1). The operator never sees a "period" abstraction — they write "as of today, WHSE 7 RS for 3X50 has 53 flec on hand" and a new row dated today is inserted; the ledger seeds from the most-recent opening dated `≤` the user-chosen start date (codo rule 9), and counts events forward from that same start date.

> **SHIPPED + EVOLVED — APPEND-ONLY (migration `20260601113342_cenapro_write_path_and_opening_balance_history`, 2026-06-01).** When Cenapro became the *maintaining* app, this table was made **append-only**: the `UNIQUE (warehouse_code, grade_code, side, period_start_date)` constraint (`cenapro_wob_natural_key`) was **DROPPED** and replaced with a **plain** index `idx_cenapro_wob_cell`, so re-setting the same (warehouse, grade, side, date) cell keeps a full audit trail instead of overwriting. Every "set" is a NEW row; nothing is ever UPDATEd or DELETEd. The **effective** opening as of date D is now `greatest period_start_date ≤ D`, **tie-broken by greatest `created_at`** (a later same-date set supersedes the earlier one). The seed-lookup index `idx_cenapro_wob_seed_lookup (warehouse_code, grade_code, side, period_start_date DESC)` remains and is what the ledger/accessors actually scan. The DDL block below shows the ORIGINAL shape; the live table no longer has the UNIQUE.

```sql
-- ORIGINAL shape — the UNIQUE was later DROPPED for append-only history (see SHIPPED note above).
CREATE TABLE IF NOT EXISTS cenapro.warehouse_opening_balance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_code     text NOT NULL REFERENCES cenapro.warehouse(code),
  grade_code         text NOT NULL REFERENCES cenapro.grade(code),
  side               text NOT NULL CHECK (side IN ('LS','RS')),
  period_start_date  date NOT NULL,
  opening_flec_count integer NOT NULL DEFAULT 0 CHECK (opening_flec_count >= 0),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
  -- cenapro_wob_natural_key UNIQUE (...) DROPPED 2026-06-01 → append-only; replaced by plain idx_cenapro_wob_cell
);
```

> WHSE 3 does **not** use this table (it would use per-batch DVO ledgers — deferred).

**Public write/read accessors (migration `..342`, all `public.*`, SECURITY INVOKER):**
- `public.cenapro_set_opening_balance(p_warehouse_code, p_grade_code, p_side, p_effective_date date, p_count int)` — INSERTS a new append-only entry (never updates/deletes), RETURNS the row. `GRANT EXECUTE` → authenticated, service_role.
- `public.cenapro_opening_balances(p_warehouse_code, p_as_of_date date)` — the CURRENT effective opening per (grade, side) for the warehouse as of the date (drives the editable STARTING block; matches the ledger seed rule). → authenticated, anon, service_role.
- `public.cenapro_opening_balance_history(p_warehouse_code)` — ALL entries (grade, side, period_start_date, opening_flec_count, created_at), newest-first per (grade, side), for the backtracking view. → authenticated, anon, service_role.

### 4.4 Drift log — `cenapro.drift_log`

Append-only telemetry for every silent-failure path (architecture-reference pattern; ICTC's analogue is `audit_logs` + the UNMAPPED bucket). Mirrors codo §6.6.

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED
CREATE TABLE IF NOT EXISTS cenapro.drift_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,   -- 'unique_tag_collision' | 'whse_w6_w7_cosmetic' | 'whse_side_non_canonical'
                               -- | 'dvo_row_deferred' | 'legacy_missing_src' | 'shift_non_canonical' | ...
  source_row  int,             -- original .xlsb row when applicable
  target_id   uuid,            -- production_event.id when applicable
  expected    text,
  actual      text,
  message     text,
  resolved_at timestamptz,
  resolved_by text
);

CREATE INDEX IF NOT EXISTS idx_cenapro_drift_unresolved
  ON cenapro.drift_log (detected_at) WHERE resolved_at IS NULL;
```

### 4.5 Grants (sketch)

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED. Mirrors ICTC production grants.
GRANT USAGE ON SCHEMA cenapro TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cenapro TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA cenapro TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cenapro GRANT SELECT ON TABLES TO authenticated, anon, service_role;
-- Views get GRANT SELECT ... TO authenticated alongside their definition (see §6).
```

> **No RLS** — Cenapro follows ICTC's production-module pattern (no row-level security; authn + role checks enforced in the app layer via `lib/auth.ts`). If Cenapro later needs row scoping, add policies then — out of v1 scope.

---

## 5. Enums

**Decision: model categoricals as `text` + `CHECK` constraints (or text-PK lookups), NOT native Postgres `ENUM` types.**

| Categorical | Modeled as | Values |
|---|---|---|
| `shift` | text-PK lookup `cenapro.shift` | M, E, N |
| `grade` | text-PK lookup `cenapro.grade` | 3X50, 2X6, 3.5, 4X8 |
| `plant` | text-PK lookup `cenapro.plant` | W6, W7, W6/W7, DVO |
| `warehouse` | text-PK lookup `cenapro.warehouse` | WHSE 1/2/3/5/7 |
| `source_location` | text-PK lookup `cenapro.source_location` | TNK 1-4, W6, W7, FLEC, DVO |
| `partner_equipment` | text-PK lookup `cenapro.partner_equipment` | C1-C4, RK1-RK4 |
| `disposition_kind` | `CHECK` on `production_event` | flec_bagging, partner_crusher, partner_kiln |
| `whse_side` | `CHECK` | LS, RS |
| `source_location.kind` | `CHECK` | tank, plant_direct, warehouse_flec, dvo_container |
| `partner_equipment.kind` | `CHECK` | crusher, kiln |

**Why CHECK/lookup over native ENUM:** Blackwood's history (recorded in my MEMORY) shows native enums are painful to evolve — *"PostgreSQL requires enum values to be committed before use in function definitions; always split enum additions into separate migrations,"* and `ALTER TYPE ... ADD VALUE` cannot run inside a transaction with usage. ICTC's own production tables use `text + CHECK` for exactly this reason. Dimension values that *will* drift (the partner could add a 5th crusher; a new grade could appear) are far cheaper to extend by inserting a lookup row than by altering an enum type. This is a deliberate Blackwood-wide convention, and it matches codo's intent (codo uses `CHECK (x IN (...))` too).

> The one place a native enum is defensible is `move_state (IN/OUT)` for a stored PC-ledger table — but v1 has **no** stored PC-ledger table (the ledger is a set-returning function; direction is derived). So no native enums anywhere in v1.

---

## 6. Views

### 6.1 The flec ledger — `cenapro.flec_ledger(p_warehouse_code, p_start_date)` (the central translation)

**This is the single most important Blackwood divergence from codo.** codo computes the WHSE 1/2/5/7 ledger in **Rust** (`warehouse_ledger_flec(warehouse_id, start_date)`). Blackwood's **hard rule forbids balance math in TypeScript** — and the existing `view_blocking_grid` proves the platform pattern: **running balances live in SQL, computed with window functions.** So the flec ledger becomes **Postgres SQL with a windowed running balance per `(grade, side)`**, seeded from `cenapro.warehouse_opening_balance`.

> **SHIPPED UPDATE — latest-effective seed tiebreak (migration `..342`, 2026-06-01).** Once `warehouse_opening_balance` became append-only (§4.3), the opening SEED subquery's `ORDER BY period_start_date DESC` gained a `, ob.created_at DESC` tiebreak, so when two opening rows share the same `period_start_date`, the most-recently-inserted one wins. This is the ONLY change to the live `flec_ledger` body (the `SET search_path = ''` hardening is preserved); `flec_balance` and the `public.cenapro_flec_*` passthroughs inherit it unchanged. The verified WHSE 7 3X50/RS `53 → 56` invariant still holds.

**The ledger is ALWAYS scoped to a user-chosen START DATE — by design.** This is the intended foundation, confirmed by Renzo (2026-06-01): the opening/starting count is the baseline **as of a start date the user picks**, and the running balance counts **forward from that start date**. codo encodes exactly this — `warehouse_ledger_flec` takes `start_date` as a *required* parameter (its `RunBalComponents { opening, flec_in_to_date, flec_out_to_date }` is the per-row "show your math"). A start date is therefore not an optional filter bolted on later; it is the ledger's defining parameter and the deliberate hook for upcoming period-picker / period-filter features.

**Why a set-returning function, not a plain view.** A plain `VIEW` cannot accept a per-query start date, and a view that windows over *all history* would compute one fixed all-time baseline — the wrong semantics. The baseline must **reset to whatever the user's start date is**, and the rows must begin at that start date. A Postgres **set-returning function** (`RETURNS TABLE(...)`) is the natural fit: it takes `(p_warehouse_code, p_start_date)`, re-seeds from the most-recent opening `≤` the start date, and re-runs the window over only the events `≥` the start date. (A parameterized view via `current_setting()` or a per-call `WHERE` predicate could also carry the date, but a `RETURNS TABLE` function is the clearest, type-safe contract and mirrors codo's `warehouse_ledger_flec(warehouse_id, start_date)` one-to-one — use that.)

> **No double-count.** An earlier draft of this section raised a "double-count" concern about combining an opening balance with the full event history. With **start-date scoping that concern does not arise** and the caveat is withdrawn: the seed is the single most-recent opening dated `≤ p_start_date`, and the windowed sum runs over **only** events with `recv_date ≥ p_start_date`. Opening events strictly before the start date are folded into the seed (via the opening balance the operator typed), never re-counted as rows — so each flec movement contributes exactly once. This is the correct, intended design, and it is precisely what enables period filtering.

**How the running balance is computed (per call, for the given `p_start_date`):**

1. **Direction (IN/OUT)** is derived from the typed columns — *not* codo's brittle "last hyphen-segment of unique_tag" substring trick (codo §4.4):
   - `disposition_kind = 'flec_bagging'` AND `warehouse_code IS NOT NULL` → **IN** (`flec_in = flec_count`).
   - `disposition_kind IN ('partner_crusher','partner_kiln')` AND `source_location.kind = 'warehouse_flec'` AND `warehouse_code IS NOT NULL` → **OUT** (`flec_out = flec_count`).
   - Everything else (tank / plant-direct partner draws) → **not a warehouse event**, excluded from the ledger entirely.
2. **The signed per-row delta** is `flec_in − flec_out`.
3. **The opening SEED** per `(grade, side)` is the `opening_flec_count` of the **most-recent** `warehouse_opening_balance` row for the chosen warehouse with `period_start_date ≤ p_start_date` (a `DISTINCT ON ... ORDER BY period_start_date DESC` lateral, or a correlated subquery). This is the baseline as of the user's start date.
4. **Rows** are filtered to events with **`recv_date ≥ p_start_date`** only — the ledger begins at the start date, not at the beginning of all history.
5. **The running balance** is `seed + SUM(delta) OVER (PARTITION BY grade_code, side ORDER BY recv_date, id ROWS UNBOUNDED PRECEDING)` over those start-date-floored rows — directly analogous to the windowed pattern the blocking-grid migration uses, and to the `view_pc_running_balance` sketch in CENAPRO_PRODUCTION_ANALYSIS §6.
6. **Information density (PROJECT_BRAIN §4.7):** the function returns the *inputs alongside* the output — `flec_in`, `flec_out`, the opening `seed`, the cumulative `flec_in_to_date` / `flec_out_to_date`, and `running_balance` on every row — so the UI can show `opening + ins − outs = balance` without recomputing. Never return the balance alone. (This mirrors codo's `RunBalComponents`.)

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED. Start-date-scoped set-returning function,
-- Blackwood-native window-function running balance. Mirrors codo
-- warehouse_ledger_flec(warehouse_id, start_date) one-to-one.
CREATE OR REPLACE FUNCTION cenapro.flec_ledger(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  id                     uuid,
  warehouse_code         text,
  grade_code             text,
  side                   text,
  recv_date              date,
  prod_date              date,
  source_location_code   text,
  disposition_kind       text,
  partner_equipment_code text,
  kg_moved               numeric,   -- per-row kg (NOT summed forward; codo §4.5)
  flec_in                integer,
  flec_out               integer,
  opening_seed           integer,   -- baseline as of p_start_date, per (grade, side)
  flec_in_to_date        bigint,    -- cumulative ins from p_start_date forward (codo RunBalComponents)
  flec_out_to_date       bigint,    -- cumulative outs from p_start_date forward
  running_balance        bigint     -- opening_seed + cumulative (in - out)
)
LANGUAGE sql
STABLE
SECURITY INVOKER                     -- inherits table grants like ICTC views
AS $$
  WITH warehouse_rows AS (
    SELECT
      pe.id,
      pe.warehouse_code,
      pe.grade_code,
      pe.whse_side                                      AS side,
      pe.recv_date,
      pe.prod_date,
      pe.source_location_code,
      pe.disposition_kind,
      pe.partner_equipment_code,
      -- direction derived from typed columns (NOT the unique_tag substring trick)
      CASE WHEN pe.disposition_kind = 'flec_bagging'
             AND pe.warehouse_code IS NOT NULL
           THEN pe.flec_count END                       AS flec_in,
      CASE WHEN pe.disposition_kind IN ('partner_crusher','partner_kiln')
             AND sl.kind = 'warehouse_flec'
             AND pe.warehouse_code IS NOT NULL
           THEN pe.flec_count END                       AS flec_out,
      pe.weight_kg
    FROM cenapro.production_event pe
    JOIN cenapro.source_location sl ON sl.code = pe.source_location_code
    JOIN cenapro.warehouse       w  ON w.code  = pe.warehouse_code
    WHERE w.default_unit = 'flec_count'                 -- WHSE 1/2/5/7 only
      AND pe.warehouse_code = p_warehouse_code          -- the chosen warehouse
      AND pe.whse_side IS NOT NULL
      AND pe.recv_date >= p_start_date                  -- START-DATE FLOOR: rows from the start date forward
      AND (
           (pe.disposition_kind = 'flec_bagging')
        OR (pe.disposition_kind IN ('partner_crusher','partner_kiln') AND sl.kind = 'warehouse_flec')
      )
  ),
  seeded AS (
    SELECT wr.*,
           -- SEED: most-recent opening balance dated on/before the user's start date
           -- (NOT per-row recv_date) — this is the baseline as of p_start_date.
           COALESCE((
             SELECT ob.opening_flec_count
             FROM cenapro.warehouse_opening_balance ob
             WHERE ob.warehouse_code = wr.warehouse_code
               AND ob.grade_code     = wr.grade_code
               AND ob.side           = wr.side
               AND ob.period_start_date <= p_start_date
             ORDER BY ob.period_start_date DESC
             LIMIT 1
           ), 0) AS opening_seed
    FROM warehouse_rows wr
  )
  SELECT
    s.id,
    s.warehouse_code,
    s.grade_code,
    s.side,
    s.recv_date,
    s.prod_date,
    s.source_location_code,
    s.disposition_kind,
    s.partner_equipment_code,
    s.weight_kg                                         AS kg_moved,
    s.flec_in,
    s.flec_out,
    s.opening_seed,
    -- cumulative ins / outs from the start date forward, per (grade, side)
    SUM(COALESCE(s.flec_in,0))
      OVER (PARTITION BY s.grade_code, s.side
            ORDER BY s.recv_date, s.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)          AS flec_in_to_date,
    SUM(COALESCE(s.flec_out,0))
      OVER (PARTITION BY s.grade_code, s.side
            ORDER BY s.recv_date, s.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)          AS flec_out_to_date,
    -- running balance per (grade, side); seed + cumulative (in - out) from p_start_date forward
    s.opening_seed
      + SUM(COALESCE(s.flec_in,0) - COALESCE(s.flec_out,0))
          OVER (PARTITION BY s.grade_code, s.side
                ORDER BY s.recv_date, s.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)      AS running_balance
  FROM seeded s
  ORDER BY s.grade_code, s.side, s.recv_date, s.id;
$$;

COMMENT ON FUNCTION cenapro.flec_ledger(text, date) IS
  'WHSE 1/2/5/7 flec-count ledger, scoped to (p_warehouse_code, p_start_date). '
  'opening_seed = most-recent warehouse_opening_balance with period_start_date <= p_start_date, '
  'per (grade, side); rows are events with recv_date >= p_start_date; '
  'running_balance = opening_seed + windowed SUM(flec_in - flec_out) over those rows. '
  'No double-count: pre-start movements live in the seed, not the rows. Direction derived from '
  'disposition_kind + source kind (not the workbook unique_tag substring trick). kg shown per-row, '
  'never summed forward. Ported from codo warehouse_ledger_flec(warehouse_id, start_date); computed '
  'in SQL per Blackwood no-balance-math-in-TS rule. Start date is the deliberate hook for period filtering.';

GRANT EXECUTE ON FUNCTION cenapro.flec_ledger(text, date) TO authenticated;
```

> **Calling it:** `SELECT * FROM cenapro.flec_ledger('WHSE 7', '2026-03-10')` from a Cenapro server action (via `supabase.schema('cenapro').rpc('flec_ledger', { p_warehouse_code: 'WHSE 7', p_start_date: '2026-03-10' })`). A period picker just changes `p_start_date`; nothing else moves.
>
> **Edge cases this captures (codo §4.4):** a partner takeback from a *tank* (not warehouse_flec) correctly does **not** count as a warehouse outflow even though the workbook's STATE column would say OUT. The typed-column derivation gets this right where the substring trick is wrong.
>
> **The `kg_moved` choice (codo §4.5):** the workbook never runs a kg balance for flec warehouses — only flec count. The function exposes per-row kg for reference but does **not** maintain a running kg balance, matching the source.

### 6.2 Current-balance summary — `cenapro.flec_balance(p_warehouse_code, p_start_date)`

A thin "balance as of the latest row" rollup for the warehouse-occupancy widget: the **last** `running_balance` per `(grade, side)`, derived from the ledger function above. Because the ledger is start-date-scoped, the summary inherits the same `p_start_date` — it is the closing balance of the chosen period, not an all-time figure. It is therefore **also a set-returning function** (a plain view can't supply the ledger function's arguments), wrapping `flec_ledger` for one warehouse.

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED
CREATE OR REPLACE FUNCTION cenapro.flec_balance(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  warehouse_code text,
  grade_code     text,
  side           text,
  current_flec   bigint,   -- last running_balance for the (grade, side) within the period
  opening_seed   integer,  -- the period's baseline (as of p_start_date)
  as_of          date      -- recv_date of the latest counted row
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (l.grade_code, l.side)
    l.warehouse_code, l.grade_code, l.side,
    l.running_balance AS current_flec,
    l.opening_seed,
    l.recv_date       AS as_of
  FROM cenapro.flec_ledger(p_warehouse_code, p_start_date) l
  ORDER BY l.grade_code, l.side, l.recv_date DESC, l.id DESC;
$$;

COMMENT ON FUNCTION cenapro.flec_balance(text, date) IS
  'Closing flec balance per (grade, side) for (p_warehouse_code, p_start_date) — the last '
  'running_balance row from cenapro.flec_ledger. Inherits the start-date scope: this is the '
  'period close, not an all-time balance. If no events fall in the period, callers should fall '
  'back to the opening_seed (a no-row (grade, side) means the balance is just its opening).';

GRANT EXECUTE ON FUNCTION cenapro.flec_balance(text, date) TO authenticated;
```

> **Empty-period note:** a `(grade, side)` with an opening balance but **no** events `≥ p_start_date` produces no ledger row, so it won't appear in `flec_balance`. When the UI needs the full grade×side grid (e.g. the occupancy widget), the adapter should left-join the `warehouse_opening_balance` seed set so a quiet `(grade, side)` shows `current_flec = opening_seed`. (Kept out of the function to preserve the "show only what moved" semantics; it's a presentation concern for the adapter.)

### 6.3 Production daily/monthly summary — `cenapro.view_production_daily`

The W6/W7 Summary pivots become an on-demand `GROUP BY` view (codo §5.2) — **not** persisted; used as a **cross-check** against the workbook's own summary tabs (analogous to ICTC's Blocking-as-cross-check). Pivots `weight_kg` by disposition bucket.

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED
CREATE OR REPLACE VIEW cenapro.view_production_daily
WITH (security_invoker = true)
AS
SELECT
  pe.plant_code,
  pe.prod_date,
  pe.batch,
  pe.source_location_code AS tnk_or_source,
  pe.shift_code,
  pe.grade_code,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C1')                          AS c1_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C2')                          AS c2_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C3')                          AS c3_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C4')                          AS c4_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK1')                         AS rk1_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK2')                         AS rk2_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK3')                         AS rk3_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK4')                         AS rk4_kg,
  SUM(pe.weight_kg) FILTER (WHERE pe.disposition_kind = 'flec_bagging')    AS flec_kg,
  SUM(pe.weight_kg)                                                        AS total_kg
FROM cenapro.production_event pe
LEFT JOIN cenapro.partner_equipment pq ON pq.code = pe.partner_equipment_code
GROUP BY pe.plant_code, pe.prod_date, pe.batch, pe.source_location_code, pe.shift_code, pe.grade_code;

COMMENT ON VIEW cenapro.view_production_daily IS
  'On-demand pivot of production_event.weight_kg by (plant, prod_date, batch, source, shift, grade) '
  'across disposition buckets. Reproduces W6/W7 Summary tabs for cross-check; never persisted. '
  'Monthly rollup = wrap this in DATE_TRUNC(''month'', prod_date).';

GRANT SELECT ON cenapro.view_production_daily TO authenticated;
```

> Monthly rollup (the Summary tabs' left block) = the same query grouped by `DATE_TRUNC('month', prod_date)` — expose as `cenapro.view_production_monthly` or compute in the adapter; either is fine since it is a pure `GROUP BY`.

---

## 7. `unique_tag`, canonicalization & drift_log

### 7.1 `unique_tag` — computed at write, audit-only, never a key

codo §3 is explicit and Blackwood follows it exactly: `unique_tag` is a 10-segment hyphen concat that is **brittle** (free-text components drift; it is **not actually unique today** — codo found 1 confirmed-mistake duplicate), so:

- **Surrogate `id uuid` is the real identity.** `unique_tag` is **never** used to join.
- `unique_tag` is **computed at write** (BEFORE-INSERT/UPDATE trigger) from the *canonicalized* component fields and **persisted** for audit / export / Excel-parity.
- A `UNIQUE` constraint guards it; a collision on backfill → first row imported, the colliding row routed to `cenapro.drift_log` with `kind = 'unique_tag_collision'` (codo §3.3).

**Segment order (codo §3.1), adapted:** the workbook's 10-segment tag includes a `DVO SIDE` segment that is **always blank** in the data (it produces the `--` run). v1 preserves byte-for-byte parity by emitting the blank segment, so exported tags match the workbook exactly:

```
recv_date - prod_date - BATCH - SHIFT - GRADE - PLANT - WHSE - <blank DVO SIDE / whse_side> - SRC - CCC/FLEC
```

> ⚠️ **Open question for Renzo (§12 Q5):** the workbook tag uses Excel **serial integers** for the two dates (`46091`, not `2026-03-10`). To reproduce tags *byte-identically* for export parity, the trigger must format `recv_date`/`prod_date` back to Excel serials. Confirm whether byte-identical parity is required, or whether ISO-date tags are acceptable (simpler, but won't string-match the workbook). Default assumption: **Excel-serial parity required** (it's why the column exists).

```sql
-- ILLUSTRATIVE SKETCH — NOT YET APPLIED. compute_unique_tag + BEFORE trigger.
CREATE OR REPLACE FUNCTION cenapro.compute_unique_tag(e cenapro.production_event)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('-',
    -- Excel serial = days since 1899-12-30 (see §12 Q5 before finalizing)
    (e.recv_date - DATE '1899-12-30')::text,
    COALESCE((e.prod_date - DATE '1899-12-30')::text, ''),
    e.batch,
    COALESCE(e.shift_code, ''),
    e.grade_code,
    COALESCE(e.plant_code, ''),
    COALESCE(e.warehouse_code, ''),
    COALESCE(e.whse_side, ''),                 -- blank DVO_SIDE segment preserved
    e.source_location_code,
    CASE WHEN e.disposition_kind = 'flec_bagging' THEN 'FLEC'
         ELSE e.partner_equipment_code END
  );
$$;

CREATE OR REPLACE FUNCTION cenapro.fn_set_unique_tag()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.unique_tag := cenapro.compute_unique_tag(NEW);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_cenapro_pe_unique_tag
  BEFORE INSERT OR UPDATE ON cenapro.production_event
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_set_unique_tag();
```

### 7.2 Canonicalize-at-write (architecture-reference §"canonicalize-at-write")

Every dirty enum in the workbook is canonicalized **in the server action before insert** (and re-asserted by the lookup FK + CHECK at the DB). Observed dirty values (CENAPRO_PRODUCTION_ANALYSIS §7 + codo §2):

| Field | Dirty values seen | Canonical | On unmappable |
|---|---|---|---|
| `SHIFT` | `M,`, ` M` | `M` | drift_log `kind='shift_non_canonical'` |
| `PLANT` | `W6 /W7`, `W`, `37.0` | `W6/W7` / NULL | drift_log `kind='plant_non_canonical'` |
| `WHSE` | cosmetic `W6`/`W7` (pre-auto-fill noise) | **NULL** | drift_log `kind='whse_w6_w7_cosmetic'` |
| `CCC / FLEC` | `FLEC ` (trailing space) | `FLEC` | drift_log `kind='disposition_non_canonical'` |
| `WHSE SIDE` | (on WHSE 3 rows) DVO batch codes | n/a in v1 — DVO rows excluded | (row already deferred via `dvo_row_deferred`) |

**Rule (ICTC parity — the "never auto-create" rule from my MEMORY):** values that don't map to a known canonical/lookup go to `drift_log`, **never** auto-create a lookup row. A human resolves drift.

**The `canonicalize_*` functions live in the server action layer** (`app/(app)/cenapro/lib/canonicalize.ts` — one pure `canonicalizeShift/Plant/Whse/Disposition/Side(raw) → {value, drift?}` per field), called at every write site, with a unit test per known variant (architecture-reference testing strategy). They are NOT in the DB — but the lookup FK + CHECK constraints are the DB-side backstop so a bad value cannot land even if a caller forgets.

> **Divergence from codo #4 (canonicalize in TS, not Rust):** codo's canonicalizers are Rust fns called from Tauri commands. Blackwood's equivalent is a TypeScript module called from `'use server'` actions. Same pattern (canonicalize-at-write + lock-in tests + lookup backstop), different host language. This does **not** violate the no-balance-math-in-TS rule — canonicalizing a categorical string is not balance math; balances stay in SQL (§6).

---

## 8. Write rules & validity matrix

Ported from codo §7.1 / §7.2 — the canonical row-level validation. Enforced in the Cenapro server action (a `validateProductionEvent(payload)` guard), optionally backed by a DB trigger/CHECK for defense-in-depth.

### 8.1 `(disposition_kind × source.kind × warehouse)` validity matrix (codo §7.1)

DVO rows (`source.kind = dvo_container`, `warehouse = WHSE 3`) are listed for completeness but are **excluded from v1 ingestion** (routed to drift_log). The matrix stays intact so it is correct the day DVO is enabled.

| disposition_kind | source.kind | warehouse | v1 status | example / reason |
|---|---|---|---|---|
| `flec_bagging` | `tank` | WHSE 1/2/5/7 | **VALID** | CI bagged 33 flec from TNK 2 into WHSE 7 RS; plant forced = W6. |
| `flec_bagging` | `plant_direct` | WHSE 1/2/5/7 | **VALID** | CI bagged 3.5-grade direct from W6 into WHSE 1 LS. |
| `flec_bagging` | `tank` / `plant_direct` | NULL | **FORBIDDEN** | a bagging event must have a destination warehouse. |
| `flec_bagging` | `tank` / `plant_direct` | WHSE 3 | **FORBIDDEN** | WHSE 3 is DVO-only; CI doesn't bag Cebu product there. |
| `flec_bagging` | `warehouse_flec` | any | **FORBIDDEN** | can't bag already-bagged stock. |
| `flec_bagging` | `dvo_container` | any | **FORBIDDEN** | DVO arrives in PP sacks, not flec bags. |
| `partner_crusher`/`partner_kiln` | `tank` | NULL | **VALID** | partner pulled 12,424 kg from TNK 3 into Crusher 1; no warehouse touched. |
| `partner_crusher`/`partner_kiln` | `plant_direct` | NULL | **VALID** | partner pulled direct from W6 into Crusher 2 (rare bypass). |
| `partner_crusher`/`partner_kiln` | `tank`/`plant_direct` | any warehouse | **FORBIDDEN** | tank/plant-direct partner draws don't touch a warehouse. |
| `partner_crusher`/`partner_kiln` | `warehouse_flec` | WHSE 1/2/5/7 | **VALID** | partner pulled 38 flec out of WHSE 7 LS for RK3 → flec ledger OUT. |
| `partner_crusher`/`partner_kiln` | `warehouse_flec` | NULL or WHSE 3 | **FORBIDDEN** | warehouse_flec must name a 1/2/5/7 warehouse. |
| `partner_crusher`/`partner_kiln` | `dvo_container` | WHSE 3 | **VALID (deferred)** | partner pulled kg from WHSE 3 DVO batch → DVO ledger OUT. **Excluded in v1.** |
| `partner_crusher`/`partner_kiln` | `dvo_container` | NULL or WHSE 1/2/5/7 | **FORBIDDEN** | DVO product only lives in WHSE 3. |

### 8.2 SRC ↔ PLANT pairing (codo §7.2, rules 23–27)

For non-FLEC sources, `plant_code` is fully determined by `source_location.plant_code` — the server action **derives it on save** (overwriting any workbook PLANT value), the DB has it as a forced default via the source lookup.

| source.code | source.kind | forced plant_code |
|---|---|---|
| TNK 1–4 | tank | **W6** |
| W7 | tank | **W7** |
| W6 | plant_direct | **W6** |
| DVO | dvo_container | **DVO** (deferred) |
| FLEC | warehouse_flec | **NULL** (origin unknowable once bagged — codo rule 27) |

### 8.3 Soft kg-per-bag warning (codo §7.3, rule 28) — app-layer ONLY

When `disposition_kind = 'flec_bagging'` AND `flec_count IS NOT NULL`, the form computes `kg_per_bag = weight_kg / flec_count` and warns (non-blocking) if outside the grade's `[expected_kg_per_bag_min, expected_kg_per_bag_max]`. **No DB constraint** — this is a UI warning that *shows its math* (information density). Seed bounds: 3X50 `[400,700]`, 2X6 `[400,650]`, 3.5/4X8 `NULL` (suppressed until data). After backfill, a one-shot script can tighten to `mean ± 2σ` per grade.

### 8.4 Other invariants (codo §7)

- `weight_kg > 0` always (CHECK).
- `unique_tag` UNIQUE; collisions → drift_log.
- `flec_count` populated on flec_bagging rows AND on partner takebacks of bagged stock (warn if missing).
- `batch` is a TEXT month label, **never derived** from `prod_date` (same-day month-boundary transitions exist — codo rule 10).
- `flec_stat` imported as-is, never validated or written going forward (legacy dead column — codo Q6).

---

## 9. Backfill / ingestion plan

A **one-shot, Cenapro-only** ingestion with **its own scripts and zero shared code** with ICTC. Unlike ICTC's `gsheet-sync` (a recurring email/gsheet "employee" agent), **Cenapro has no ingestion agent and no scraper** — its only ingress is a **manual in-app upload** of the `.xlsb` (§9.3, §12 Q6 RESOLVED). The ICTC email/gsheet agents stay ICTC-only and never touch Cenapro. The v1 backfill below is the one-shot first run of that same `pyxlsb` → canonicalize → ingest pipeline; steady-state re-runs are the same pipeline behind the upload server action (§9.3).

### 9.1 Pipeline

1. **Read the current `.xlsb`** via Python `pyxlsb` (LibreOffice not required; CENAPRO_PRODUCTION_ANALYSIS confirmed `pyxlsb` reads it). Source: `/Users/renzosy/Documents/1A WORK FILES/PRODUCTION/2025 CI PRODUCTION V2.xlsb`. **Never modify the file.**
2. **Parse `Production`:** header at r0; **skip the legend block (rows ~1–8)**; data starts ~r11, runs to ~r1121; **skip blank separator rows**. ~906 weight-bearing rows.
3. **Excel-serial → date:** `recv_date`/`prod_date` via `pyxlsb.convert_date` (1900 system; `45992 → 2025-12-01`, `46091 → 2026-03-10`). Coerce `GRADE = 3.5` (stored numeric) to text.
4. **Canonicalize** every categorical (§7.2). Unmappables → `drift_log` row, **never** auto-create a lookup.
5. **Exclude DVO rows:** any row with `SRC = DVO` (or `PLANT = DVO`, or a `WHSE SIDE` DVO batch code) → **not inserted**; instead a `drift_log` row `kind='dvo_row_deferred'` with `source_row` + the raw values. (~120–145 rows.)
6. **Split `CCC / FLEC`** → `disposition_kind` + `partner_equipment_code` (`FLEC → flec_bagging/NULL`; `Cn → partner_crusher/Cn`; `RKn → partner_kiln/RKn`).
7. **NULL cosmetic `WHSE = W6/W7`** → `warehouse_code = NULL` + `drift_log kind='whse_w6_w7_cosmetic'`.
8. **Derive `plant_code`** from source (§8.2), overwriting the workbook PLANT for non-FLEC sources; NULL for FLEC.
9. **Validate** each row against the §8.1 matrix; forbidden combinations → `drift_log kind='validity_violation'` (do not insert), surfaced for Renzo.
10. **Compute `unique_tag`** from canonicalized fields (the DB trigger does this on insert); the **first** of any colliding tag is imported, the rest → `drift_log kind='unique_tag_collision'`.
11. **Insert** surviving rows into `cenapro.production_event` with `provenance='cenapro_xlsb'` + `source_row`.
12. **Parse `PC WHSE 1/2/5/7` STARTING blocks** (rows 3–11, START date in r0) → `cenapro.warehouse_opening_balance` rows (`period_start_date` = the sheet's START serial, e.g. 2026-03-10). The PC ledger *body* rows are **not** imported — the ledger is re-derived on demand by `cenapro.flec_ledger(warehouse, start_date)` from `production_event` + these openings.
13. **Idempotency:** re-running matches on `unique_tag` (or the natural-key index) and UPSERTs — never blind INSERT (architecture-reference: "every sync operation safe to re-run").

### 9.2 Cell-by-cell mapping (adapted from codo §6.8)

| Workbook artifact | Becomes (v1) |
|---|---|
| `Production` r0 headers | `cenapro.production_event` columns (renamed) |
| `Production` data rows (≈906, **minus DVO**) | `cenapro.production_event` rows |
| `Production.CCC RECV` | `production_event.recv_date` |
| `Production.CCC / FLEC` | split → `disposition_kind` + `partner_equipment_code` |
| `Production.WHSE` (cosmetic W6/W7) | `warehouse_code = NULL` + drift_log |
| `Production.WHSE SIDE` (`LS`/`RS`) | `whse_side` |
| `Production.WHSE SIDE` (DVO batch code) | **deferred** — row excluded via `dvo_row_deferred` |
| `Production.DVO SIDE` (always blank) | not modeled (blank segment preserved in `unique_tag` only) |
| `Production.UNIQUE TAG` | recomputed `unique_tag` (trigger); dup → drift_log |
| `Production.FLEC STAT` | `flec_stat` (imported, never written) |
| `Production` legend rows (~1–8) | seed values for lookup tables; discarded after seeding |
| `Production` rows where `SRC=DVO` | `drift_log kind='dvo_row_deferred'` (NOT inserted) |
| `PC WHSE 1/2/5/7` STARTING block | `cenapro.warehouse_opening_balance` rows |
| `PC WHSE *` ledger body + `RUN BAL` | **not imported** — re-derived by `cenapro.flec_ledger(warehouse, start_date)` |
| `PC W3`, `PC W3 - DVO`, `PC WA7 - DVO`, `DVO IN`, `DVO OUT` | **not imported** (DVO deferred) |
| `W6 Summary` / `W7 Summary` | not imported — reproduced by `view_production_daily` (cross-check only) |

### 9.3 Refresh mechanism — manual in-app upload (RESOLVED, §12 Q6)

**Decision (Renzo, 2026-06-01, §12 Q6 RESOLVED): steady-state refresh is a manual in-app upload — NOT email, NOT a watched/shared folder, NOT an auto-fetch/scraper.** The `.xlsb` is hand-maintained and live; Renzo refreshes Blackwood by **uploading the file himself, inside the `cenapro` module**.

**The refresh path is one user-driven flow, end to end:**

1. **User upload inside the `cenapro` module** — an upload control on a Cenapro page (`app/(app)/cenapro/…`) accepts the `.xlsb`. The file is handed to a `'use server'` action; nothing is fetched, watched, or scraped.
2. **Parse with `pyxlsb`** — the same deterministic extraction the one-shot backfill uses (§9.1 steps 2–3): skip legend/blank rows, Excel-serial → date, coerce `GRADE = 3.5`.
3. **Canonicalize** — every categorical normalized at write (§7.2); unmappables → `drift_log`, never auto-create a lookup.
4. **Ingest** — the §9.1 pipeline (steps 4–13) runs unchanged: DVO rows parked in `drift_log`, validity matrix enforced, `unique_tag` collisions logged, idempotent UPSERT-by-`unique_tag`/natural-key so re-uploading the same (or an overlapping) file is safe to re-run. Then `revalidatePath()`.

**This keeps Cenapro fully decoupled from the ICTC email/gsheet agents.** There is **NO Cenapro scraper, NO Cenapro email/gsheet "employee," and no recurring auto-sync.** ICTC's ingestion agents (`deliveries-manager`, `rc-out-manager`, `gsheet-sync`, etc.) stay ICTC-only and never touch Cenapro; Cenapro's only ingress is the operator pressing "upload" in the Cenapro module. The same `pyxlsb` → canonicalize → ingest logic powers both the **one-shot v1 backfill** (run once against the local file) and the **steady-state manual upload** — they are the same pipeline behind two triggers (a script vs. a server action), not two agents.

---

## 10. What's deferred (DVO) & how the design stays forward-compatible

### 10.1 What's deferred

- Tables: `cenapro.dvo_batch`, `cenapro.dvo_receipt`.
- Ledger: the WHSE 3 **kg, per-batch** ledger (`dvo_batch_ledger` in codo) + `transit_loss` / `yield_loss` metrics.
- Sheets: `DVO IN`, `DVO OUT`, `PC W3`, `PC W3 - DVO`, `PC WA7 - DVO`.
- The ~120–145 `SRC = DVO` production rows (parked in drift_log).

### 10.2 Forward-compatibility built in (no rewrite to add DVO)

The schema is shaped so enabling DVO is purely **additive migrations**:

1. **`warehouse` already includes `WHSE 3`** with `default_unit = 'kg'` — the flec ledger function already excludes it (`WHERE default_unit = 'flec_count'`), so a kg ledger slots in beside it without touching the flec function.
2. **`source_location` already includes `DVO`** (kind `dvo_container`) and **`plant` already includes `DVO`** — the FK targets exist; DVO rows already validate against §8.1 (the matrix has the DVO cells).
3. **`disposition_kind` taxonomy is unchanged by DVO** — DVO outflows are still `partner_crusher`/`partner_kiln`; they're distinguished only by `source.kind = dvo_container`. No enum change.
4. **Adding DVO later =** (a) create `cenapro.dvo_batch` + `cenapro.dvo_receipt`; (b) add a nullable `dvo_batch_id uuid REFERENCES cenapro.dvo_batch(id)` column to `production_event` (additive); (c) add `cenapro.view_dvo_batch_ledger` (kg running balance per batch + loss metrics, same windowed-SQL approach; per-batch, so a plain view suffices — no per-query start date); (d) re-ingest the parked `dvo_row_deferred` drift rows + the DVO sheets. **Zero changes** to the existing flec tables, the `flec_ledger`/`flec_balance` functions, or spine columns.
5. **The parked rows are preserved, not lost** — drift_log holds every excluded row with `source_row` + raw values, so re-ingestion is a replay, not a re-keying.

### 10.3 Why drift_log (not silent drop) for DVO rows

Silently dropping ~145 rows would make the spine's total (≈10.76M kg of non-DVO) un-reconcilable against the workbook (≈13.25M kg total) with no audit trail. drift_log makes the exclusion **visible and reversible** — consistent with architecture-reference's "every silent-failure path produces a telemetry entry."

### 10.4 Alternative considered: a quarantine table

Instead of drift_log, the DVO rows *could* land in a dedicated `cenapro.production_event_deferred` table (same columns, no FK enforcement). **Recommendation: drift_log for v1** — it's lighter, already exists for other exclusions, and avoids tempting premature DVO code paths (codo §6.5 warns against adding "pending"/parallel tables before they're needed). If DVO ingestion volume or replay ergonomics later justify it, promoting the `dvo_row_deferred` entries into a real quarantine/staging table is itself an additive step.

---

## 11. Forward-compatibility summary (the "no rewrite" guarantees)

| Future need | Why v1 already accommodates it |
|---|---|
| Enable DVO subsystem | WHSE 3, DVO source, DVO plant seeded; validity matrix complete; only additive tables + 1 nullable column + 1 view needed (§10.2). |
| Add a 5th crusher / new kiln | Insert a `cenapro.partner_equipment` row — no enum/type change. |
| Add a new grade | Insert a `cenapro.grade` row. |
| New warehouse | Insert a `cenapro.warehouse` row (pick `default_unit`). |
| Steady-state re-ingestion (manual upload) | Backfill is UPSERT-by-`unique_tag`/natural-key + idempotent; the same `pyxlsb` → canonicalize → ingest pipeline powers the manual in-app upload (§9.3) — no agent, scraper, or email funnel. |
| Pending/review queue (email-funnel later) | `provenance` column already distinguishes sources; a `production_event_pending` table is additive (defer until needed — codo §6.5). |
| RLS / row scoping | No RLS in v1 (ICTC parity); policies are additive if Cenapro multi-user scoping is ever needed. |

---

## 12. Open questions for Renzo

| # | Question | What it blocks | Working default |
|---|---|---|---|
| **Q1** | **Schema exposure:** OK to expose a dedicated `cenapro` Postgres schema via PostgREST (Settings → API → Exposed schemas) + regenerate `types/supabase.ts`? Or do you prefer `cenapro_`-prefixed tables in `public`? | Tenant placement (§2); whether server actions use `.schema('cenapro')` + a dedicated client. | Dedicated `cenapro` schema (recommended). |
| **Q2** | **`BATCH` natural key:** is a bare month name (`MAY`) the full batch identity, or is month+year required? The summaries contain both 2025 and 2026 `JANUARY` rows. | The `unique_tag` shape + any future batch-campaign table; dedup correctness. | Keep `batch` as bare month TEXT (codo did); rely on `recv_date`/`prod_date` for year disambiguation in the tag. |
| **Q3** | **DVO confirmation:** confirm DVO (WHSE 3, `SRC=DVO` rows, all 5 DVO sheets) is fully deferred and that parking the ~145 DVO production rows in `drift_log` (not importing) is acceptable for v1. | §10 (the entire DVO exclusion + backfill step 5). | Defer DVO; park rows in drift_log. |
| **Q4** | **Ingest time-floor:** ICTC's gsheet pivot locked `2025-01-01+`. `Production` data starts 2025-12-01 so a floor is moot for the spine — but should the backfill hard-floor anyway (future-proofing) and what's the floor? | Backfill scope (§9). | No floor needed for v1 spine (all rows ≥ 2025-12-01); revisit if older data surfaces. |
| **Q5** | **`unique_tag` parity:** must the recomputed tag match the workbook **byte-for-byte** (Excel-serial date segments, blank DVO_SIDE segment), or is an ISO-date tag acceptable? | The `compute_unique_tag` formatting (§7.1) + whether exported tags string-match the sheet. | Byte-for-byte (Excel serials) — it's why the column exists for export parity. |
| ~~**Q6**~~ **RESOLVED** | ~~**Refresh mechanism:** how should the live `.xlsb` reach Blackwood for re-ingestion — manual upload, watched folder, or a link-shared cloud copy (like ICTC's gsheet)?~~ | ~~The future Cenapro ingestion agent's design (§9.3).~~ | ✅ **RESOLVED (Renzo, 2026-06-01): manual in-app upload** inside the `cenapro` module → parse with `pyxlsb` → canonicalize → ingest. NO scraper, NO email/gsheet employee, NO watched folder. Keeps Cenapro decoupled from ICTC's sync agents. See §9.3. |
| **Q7** | **Grade `3.5` / `4X8`:** is `3.5` a distinct SKU (vs shorthand for `3.5X…`) and is `4X8` (1 row) a real grade or a typo? | `cenapro.grade` seed + kg/bag bounds (§8.3). | Treat `3.5` and `4X8` as real grades with NULL kg/bag bounds (suppress warnings). |
| ~~**Q8**~~ **RESOLVED** | ~~**WHSE 5 vs the gaps:** confirm there is no `WHSE 4`/`WHSE 6` storage warehouse (the `W6`/`W7` in the WHSE column are cosmetic plant noise, per codo).~~ | ~~The `warehouse` CHECK list (§4.1).~~ | ✅ **RESOLVED (Renzo, 2026-06-01):** the warehouse set is exactly **{WHSE 1, WHSE 2, WHSE 3, WHSE 5, WHSE 7}**. No WHSE 4/6. `W6`/`W7` in the WHSE column → NULL. Reflected in the §4.1 `warehouse` CHECK + seed notes. |

> **Resolved so far (Renzo, 2026-06-01):** ~~Q6~~ (refresh = manual in-app upload, §9.3) and ~~Q8~~ (warehouse set = {WHSE 1, 2, 3, 5, 7}, §4.1). The flec-ledger start-date scoping decision is folded directly into §6.1/§6.2 (it was never a numbered open question — it's now the documented intended design).
> **Still open:** Q1 (schema exposure), Q2 (`BATCH` natural key), Q3 (DVO defer confirmation), Q4 (ingest time-floor), Q5 (`unique_tag` byte-parity), Q7 (grade `3.5`/`4X8`).
>
> codo's original Q1–Q12 are **closed** (its §8/§11). The questions above are the **new** Blackwood-platform-specific decisions (Q1, Q5 partly) plus the few CENAPRO_PRODUCTION_ANALYSIS flagged (Q2, Q7) that codo's frozen snapshot didn't need to re-confirm against the *current* file. (Q6, Q8 now resolved as noted above.)

---

## 13. Next steps (path to implementation — after Renzo locks §12)

1. **Lock §12** (especially Q1 schema-exposure, Q3 DVO-defer, Q5 tag-parity).
2. **Project config (Q1 prerequisite):** expose `cenapro` schema in Supabase API settings; this is the one non-DDL step and is Renzo's to approve/apply.
3. **Migration session** — author (in a *separate* session, per the no-bundling discipline):
   - `cenapro` schema + lookups + seed (`shift`/`grade`/`plant`/`warehouse`/`source_location`/`partner_equipment`).
   - `cenapro.production_event` + indexes + the partner-equipment-presence CHECK.
   - `cenapro.warehouse_opening_balance`, `cenapro.drift_log`.
   - `cenapro.compute_unique_tag` + `tr_cenapro_pe_unique_tag` trigger.
   - `cenapro.flec_ledger(text, date)` + `cenapro.flec_balance(text, date)` (start-date-scoped set-returning functions), `cenapro.view_production_daily` + grants (`GRANT EXECUTE` for the functions, `GRANT SELECT` for the view).
   - Regenerate `types/supabase.ts`; drop the temporary `(client as any)` cast.
4. **Backfill session** — `scripts/cenapro/migrate_from_xlsb.py` (pyxlsb), per §9. DVO rows → drift_log. Idempotent UPSERT.
5. **Server-action layer** — `app/(app)/cenapro/lib/canonicalize.ts` (per-field canonicalizers + lock-in tests) + `validateProductionEvent` (§8 matrix) + `app/(app)/cenapro/actions.ts` (`'use server'`, `revalidatePath()`), including the **manual `.xlsb` upload → `pyxlsb` parse → canonicalize → ingest** action that is Cenapro's steady-state refresh path (§9.3, §12 Q6). No scraper / email agent.
6. **Module + adapters** — `app/(app)/cenapro/` (Production page + Flec Inventory page with the upload control, Industrial-Spreadsheet grids) + `lib/widgets/adapters/cenapro-*.ts` (widgets unchanged).
7. **Iterate** — whichever screen hurts most in daily use; ask Renzo.

---

## Appendix A — Every place Blackwood diverges from codo, and why

| # | codo (SQLite/Tauri/Rust) | Blackwood (Postgres/Supabase/Next.js) | Why |
|---|---|---|---|
| 0 | Placement is trivial (single SQLite file) | Dedicated `cenapro` schema + PostgREST exposure + grants + types-regen | Multi-tenant Postgres needs an explicit, enforced boundary (§2). |
| 1 | Lookups: `INTEGER PK` surrogate + `code` unique | Lookups: **text `code` PK**, spine FKs by code | Tiny fixed dimensions; matches ICTC's text+CHECK convention; keeps canonical string in spine for export; one fewer join (§4.1). |
| 2 | `production_event.dvo_batch_id` present | **Omitted in v1** (additive when DVO lands) | DVO deferred (§1.3, §10.2). |
| 3 | `dirty INTEGER DEFAULT 1` | `dirty boolean DEFAULT true` | Postgres native bool (§4.2). |
| 4 | Canonicalizers in Rust (Tauri commands) | Canonicalizers in TS (`'use server'` actions) + lookup/CHECK backstop | Same canonicalize-at-write pattern, different host (§7.2). Not balance math. |
| 5 | **Flec ledger in Rust** (`warehouse_ledger_flec(warehouse_id, start_date)`) | **Flec ledger in a SQL set-returning function** with window-function running balance (`cenapro.flec_ledger(p_warehouse_code, p_start_date)`) | **The central divergence.** Blackwood's hard rule forbids balance math in TS; `view_blocking_grid` proves windowed running balances belong in SQL. A *function* (not a plain view) because the ledger is **start-date-scoped by design** — it re-seeds from the opening `≤` the user's start date and counts forward, mirroring codo's `(warehouse_id, start_date)` signature and enabling period filtering (§6.1). |
| 6 | **DVO ledger in Rust** (`dvo_batch_ledger`) | Deferred; when added → a SQL view (`view_dvo_batch_ledger`), same windowed approach | Consistency with #5 (§10.2). |
| 7 | W6/W7 summaries = Rust `GROUP BY` | `cenapro.view_production_daily` (SQL `GROUP BY`, cross-check only) | Native SQL; mirrors ICTC's view-based summaries (§6.3). |
| 8 | Native intent via `CHECK (x IN ...)` | Same: text + CHECK / text-PK lookups, **no native Postgres ENUM** | Blackwood's enum-evolution pain (recorded in agent MEMORY); ICTC parity (§5). |
| 9 | DVO rows → imported into DVO subsystem | DVO rows → `drift_log kind='dvo_row_deferred'` (excluded, replayable) | DVO deferred but auditable/reversible (§10.3). |
| 10 | `id INTEGER PK AUTOINCREMENT` | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` | Blackwood convention (ICTC tables all use uuid). |
| 11 | Migrations applied remote-Turso-first | Supabase `supabase/migrations/` + MCP/`db push`; **separate** from ICTC sync | Different infra; same append-only-migration discipline (architecture-reference). |

**What is ported unchanged from codo (cited, not reinvented):** the 3-flow model; the disposition taxonomy (`flec_bagging`/`partner_crusher`/`partner_kiln` + `partner_equipment`); `unique_tag` as audit-only-never-a-key; warehouse canon (`WHSE 7` canonical, `W6`/`W7`→NULL); `BATCH` as TEXT-not-derived; the SRC↔PLANT pairing (rules 23–27); the validity matrix (§7.1); the kg-per-bag soft warning; opening-balance-replaces-STARTING with most-recent-≤-date semantics; the flec-count-not-kg ledger unit; canonicalize-at-write + drift_log + dirty-flag patterns.
