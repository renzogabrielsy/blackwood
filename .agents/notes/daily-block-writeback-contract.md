# Daily Block Pivot — Write-Back Contract (Cenapro Tenant #2)

**Verified against live DB + migrations on 2026-06-05. Backend status: NO code/schema changes needed — the existing `saveProductionEvents` save path already supports pivot UPDATE / INSERT / DELETE.** Reuse it as-is.

- Save action: `saveProductionEvents(dirtyRows, deletedIds)` in `app/(app)/cenapro/production/actions.ts`
- Write target: auto-updatable VIEW `public.cenapro_production_events` → base table `cenapro.production_event`
- Column→disposition helpers already exist in `app/(app)/cenapro/types.ts` (`parseCccFlec`, `formatCccFlec`, `partnerEquipmentOptions`, `dispositionRequiresEquipment`).

---

## 1. The exact input shape `saveProductionEvents` expects

### `ProductionEventDirtyRow` (quoted verbatim from `actions.ts` lines 129–144)

```ts
export interface ProductionEventDirtyRow {
    id?: string | null;
    recv_date: string;
    prod_date: string;
    batch: string;
    shift_code: string;
    grade_code: string;
    plant_code: string;
    warehouse_code: string;
    source_location_code: string;
    weight_kg: string;
    disposition_kind: string;
    partner_equipment_code: string;
    flec_count: string;
    whse_side: string;
}
```

All values are **strings** (grid cells are text). The server coerces: `textOrNull` trims and maps `''`→`null`; `numOrNull` parses `weight_kg` / `flec_count` (NaN→`null`).

- **`id` present** → UPDATE that view row (`.upsert` with `id`).
- **`id` absent/empty** → INSERT a fresh row (`id` omitted → base `gen_random_uuid()` default fills it).

### `deletedIds` shape

`deletedIds: string[]` — an array of view-row `id` UUIDs. Empty/whitespace ids are filtered out, then `.delete().in('id', ids)`. **Deletes run FIRST** (before upserts) so a delete+reinsert in the same save can't collide.

### Does it accept the three pivot operations?

| Pivot op | Supported? | How |
|---|---|---|
| (a) weight-only edit of an existing cell | ✅ | dirty row WITH `id`, changed `weight_kg`. The view row already carries `id` (loaded by `fetchProductionEvents`). All other dirty-row fields are re-sent from the known row. |
| (b) brand-new event from a blank cell | ✅ | dirty row WITHOUT `id`, fields derived from cell position (see §3). |
| (c) delete a cell | ✅ | put the event `id` in `deletedIds`. |

### Which fields the action sends to the DB / which it omits

The action builds `ProductionEventInsert` (= the VIEW's generated Insert type) with **only these 13 base fields**:
`recv_date, prod_date, batch, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side` — plus `id` **only when updating**.

**It never sends:** `unique_tag`, `batch_year`, `id`-on-insert. **CONFIRMED.** (It also never sends `provenance` — and it *cannot*; see §6.)

### How `unique_tag` and `batch_year` get populated on INSERT

A **BEFORE INSERT/UPDATE trigger on the base table** does it (no INSTEAD OF rule on the view — the view is a plain auto-updatable single-table projection; verified `is_trigger_insertable_into = NO`). The view rewrites the insert to base-table DML and the base trigger fires:

```sql
-- supabase/migrations/20260601113339_create_cenapro_schema.sql (lines 334–356)
CREATE OR REPLACE FUNCTION cenapro.fn_set_unique_tag()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- auto-derive batch_year from recv_date when the caller did not supply it
  IF NEW.batch_year IS NULL THEN
    NEW.batch_year := EXTRACT(YEAR FROM NEW.recv_date)::int;
  END IF;
  NEW.unique_tag := cenapro.compute_unique_tag(NEW);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_cenapro_pe_unique_tag ON cenapro.production_event;
CREATE TRIGGER tr_cenapro_pe_unique_tag
  BEFORE INSERT OR UPDATE ON cenapro.production_event
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_set_unique_tag();
```

`unique_tag` is a 10-segment concat (`compute_unique_tag`, lines 313–329): Excel-serial recv/prod dates, batch, shift, grade, plant, warehouse, whse_side, source, and `'FLEC'` for bagging else `partner_equipment_code`. So `unique_tag`'s NOT NULL UNIQUE is satisfied **without the client ever sending it**.

**Verified by rolled-back INSERT through `public.cenapro_production_events`** (omitting id/unique_tag/batch_year/provenance): both a crusher row and a bagging row inserted; trigger filled `batch_year = 2026` (from recv_date) and a valid `unique_tag`; `provenance` defaulted to `'cenapro_xlsb'`, `dirty = true`.

#### ⚠️ batch_year edge case (document for frontend; not a blocker today)
The trigger derives `batch_year` from `YEAR(recv_date)`, NOT from the selected period. **In all 765 existing events, `batch_year == YEAR(recv_date)` (0 mismatches).** But a pivot INSERT into a `DECEMBER` period with a recv_date in early January of the next year would get the wrong `batch_year` from the trigger — landing the new event in a *different period* than the one being edited. The view's Insert type **does** accept `batch_year` (it's projected), so if the frontend ever supports cross-year-boundary batches it should send `batch_year` explicitly (taken from the selected period) to override the trigger's derive. For Phase 1 (editing within a single visible period whose rows are same-year), the default derive is correct.

---

## 2. The partner-equipment-presence CHECK is auto-satisfied by the column→disposition map

```sql
-- supabase/migrations/20260601113339_create_cenapro_schema.sql (lines 225–229)
CONSTRAINT production_event_partner_equipment_presence CHECK (
  (disposition_kind = 'flec_bagging'  AND partner_equipment_code IS NULL)
  OR
  (disposition_kind <> 'flec_bagging' AND partner_equipment_code IS NOT NULL)
)
```

The §3 column mapping ALWAYS pairs `flec_bagging` with `partner_equipment_code = null`, and `partner_crusher`/`partner_kiln` with a non-null `Cn`/`RKn`. So the CHECK is **structurally guaranteed** by the column the cell lives in. Verified: bagging-with-null and crusher-with-C1 both inserted clean; a crusher row with null equipment is impossible given the mapping. (`weight_kg > 0` and `flec_count > 0` CHECKs also exist — see §4.)

---

## 3. Mapping tables

### Pivot COLUMN → (disposition_kind, partner_equipment_code)

Equipment codes verified live in `cenapro.partner_equipment`: crushers `C1–C4` (kind `crusher`), kilns `RK1–RK4` (kind `kiln`).

| Pivot column | `disposition_kind` | `partner_equipment_code` |
|---|---|---|
| C1 / C2 / C3 / C4 | `partner_crusher` | the column code (`C1`…`C4`) |
| RK1 / RK2 / RK3 / RK4 | `partner_kiln` | the column code (`RK1`…`RK4`) |
| Bagging (FLEC) | `flec_bagging` | `null` |

This is exactly `parseCccFlec()` / `partnerEquipmentOptions()` in `app/(app)/cenapro/types.ts` — reuse those, do not re-implement.

### Pivot ROW + selected PERIOD → dims

| Field | Source |
|---|---|
| `recv_date` | the pull ROW's recv_date |
| `prod_date` | the pull ROW's prod_date (nullable) |
| `shift_code` | the pull ROW's shift_code (nullable) |
| `grade_code` | the pull ROW's grade_code (**required**) |
| `source_location_code` | the pull ROW's source (e.g. `TNK 2`) (**required**) |
| `batch` | selected PERIOD's batch (e.g. `MAY`) |
| `batch_year` | selected PERIOD's year — but **the trigger derives it from recv_date**; send explicitly only for the cross-year edge case (§1) |
| `disposition_kind` + `partner_equipment_code` | the COLUMN (table above) |
| `weight_kg` | the typed value (**required, > 0**) |
| `warehouse_code` | from the small POPOVER (`WHSE 1/2/3/5/7`) |
| `whse_side` | from the POPOVER (`LS` / `RS`, nullable) |
| `flec_count` | from the POPOVER when relevant (bagging), nullable |
| `plant_code` | `null` (free field) |

---

## 4. Minimum a NEW-event dirty row must contain to INSERT successfully

Base-table NOT NULL columns the view can set: `recv_date, batch, grade_code, source_location_code, weight_kg, disposition_kind`. (`batch_year`, `unique_tag` are trigger-filled; `provenance/dirty/created_at/updated_at/id` are defaulted.)

**Minimum non-empty dirty-row fields for an INSERT:**

| Field | Why required |
|---|---|
| `recv_date` | NOT NULL; also drives trigger's `batch_year` derive |
| `batch` | NOT NULL (the selected period's month) |
| `grade_code` | NOT NULL + FK to `cenapro.grade` |
| `source_location_code` | NOT NULL + FK to `cenapro.source_location` |
| `weight_kg` | NOT NULL + CHECK `> 0` (must be a parseable positive number) |
| `disposition_kind` | NOT NULL + CHECK in (`flec_bagging`,`partner_crusher`,`partner_kiln`) |
| `partner_equipment_code` | **required iff** disposition ≠ `flec_bagging` (the CHECK in §2); for bagging it MUST be empty/null |

**Safe to leave null/empty** (send `''`, server → null): `id` (omit for insert), `prod_date`, `shift_code`, `plant_code`, `warehouse_code`, `whse_side`, `flec_count`, `notes`/`flec_stat`/`source_row` (not in the dirty-row type at all).

**FK-bearing fields** — any non-null value must exist in its lookup or the insert fails with a clear FK error (surfaced verbatim by the action → `errorToast`):
`grade_code`→`cenapro.grade`, `source_location_code`→`cenapro.source_location`, `warehouse_code`→`cenapro.warehouse` (`WHSE 1/2/3/5/7`), `shift_code`→`cenapro.shift`, `partner_equipment_code`→`cenapro.partner_equipment`.

**Popover-supplied fields:** `warehouse_code` + `whse_side` come from the popover (user's choice); `flec_count` from the popover for bagging rows (CHECK `flec_count IS NULL OR > 0`). All three are nullable at the DB level, so a bagging insert with no flec_count still succeeds — but flec_count is what feeds the WHSE 1/2/5/7 flec ledger, so capture it for bagging when the warehouse is flec-count based.

---

## 5. Collision guard (lock cells that map to >1 event)

A pivot cell maps to MORE than one event when two events share the full pivot natural key. The frontend must group its loaded rows by this key and **lock (read-only) any cell whose group size > 1** — editing it can't be disambiguated to a single event.

**Group-by key (9 columns):**
`(batch_year, batch, prod_date, shift_code, grade_code, source_location_code, recv_date, disposition_kind, partner_equipment_code)`

**Collision count (live DB, excluding FLEC + DVO source rows — the W6/W7 pivot exclusions): exactly `1` colliding cell containing `2` events.** Query + result:

```sql
SELECT COUNT(*) AS colliding_cells, COALESCE(SUM(n),0) AS events_in_colliding_cells
FROM (
  SELECT batch_year, batch, prod_date, shift_code, grade_code,
         source_location_code, recv_date, disposition_kind, partner_equipment_code,
         COUNT(*) AS n
  FROM cenapro.production_event
  WHERE source_location_code NOT IN ('FLEC','DVO')
  GROUP BY 1,2,3,4,5,6,7,8,9
  HAVING COUNT(*) > 1
) c;
-- → colliding_cells = 1, events_in_colliding_cells = 2
```

The single collision: **batch_year 2026 / batch MAY / prod_date 2026-05-26 / shift M / grade 3X50 / source TNK 2 / recv 2026-05-27 / flec_bagging / (no equipment)** — two bagging events of 8969 kg and 11992 kg. That cell should render locked.

> Note: source rows `FLEC` and `DVO` are excluded because the editable bagging/equipment views don't surface FLEC-source movements (FLEC is the warehouse-internal source) and DVO is the v1-deferred container path. Excluding them, the pivot grain ≈ event grain (1 lockable exception).

---

## 6. PROVENANCE recommendation (DOCUMENTED ONLY — not changed; not a clean one-liner)

**Recommendation:** tag app-entered events with a distinct provenance (e.g. `'cenapro_app'`) so they're distinguishable from the `.xlsb` backfill (`'cenapro_xlsb'`).

**Why it is NOT a clean addition to `saveProductionEvents`:** the VIEW `public.cenapro_production_events` does **not project the `provenance` column** (verified `pg_get_viewdef` — the view selects 16 columns, provenance is not one; and the generated Insert type in `types/supabase.ts` has no `provenance` field). So the action *cannot* set provenance through the view — every insert silently takes the base default `'cenapro_xlsb'`, which mislabels app rows as xlsb imports.

To actually tag app rows, a **migration** is required (out of scope for this pass). Two options:

- **Option A (recommended):** widen the view to project `provenance`, then `saveProductionEvents` adds `provenance: 'cenapro_app'` to the insert branch only. Lowest-magic, explicit.
- **Option B:** change the base BEFORE trigger to default provenance to `'cenapro_app'` when `NULL` on INSERT, and have the xlsb backfill keep passing `'cenapro_xlsb'` explicitly. Avoids touching the view but couples provenance semantics into the trigger.

Either way it needs a migration + `gen types` + a one-line action change. **Per the task constraints (only make the change if it's a clean addition), this was left as a recommendation.** No backend change was made.

---

## 7. AUDIT note (gap, not built)

There is **no audit-logging trigger on any `cenapro` table** — the only trigger on `cenapro.production_event` is `tr_cenapro_pe_unique_tag` (verified via `pg_trigger`). Cenapro is isolated from the ICTC `public.audit_logs` machinery (the ICTC employee agents write audit_logs manually; cenapro has none). So production_event INSERT/UPDATE/DELETE through the view **does not produce any audit_logs row**. This is a known gap — flagged, NOT addressed here.

---

## Summary for the frontend agent

- Reuse `saveProductionEvents(dirtyRows, deletedIds)` unchanged. Send `ProductionEventDirtyRow[]` (all-string fields) + `string[]` of ids to delete.
- UPDATE = dirty row with `id`; INSERT = dirty row without `id`; DELETE = id in `deletedIds`.
- Never send `unique_tag` / `batch_year` (trigger fills both). `provenance` can't be sent through the view today (see §6).
- Column→disposition map = `parseCccFlec` / `partnerEquipmentOptions` in `app/(app)/cenapro/types.ts`.
- Lock cells whose 9-col pivot key group has >1 event — exactly 1 such cell exists today (MAY-2026 / TNK 2 / 3X50 bagging).
- Required new-row fields: recv_date, batch, grade_code, source_location_code, weight_kg, disposition_kind, and partner_equipment_code iff not bagging. Everything else may be null.
