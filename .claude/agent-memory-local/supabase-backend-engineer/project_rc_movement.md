---
name: project-rc-movement
description: RC Movement feature backend — view, migration, server action. Status and design decisions.
metadata:
  type: project
---

## RC Movement Backend (2026-05-25)

**Status:** Files on disk, pending DB apply.

**Why:** User needed a read-only derived view over RC OUT mirroring their Excel pivot table — per-(batch,day) running balance.

**What was built:**
- Migration: `supabase/migrations/20260525000000_create_view_rc_movement.sql`
- View: `view_rc_movement` — 3-CTE design: `batch_meta` → `day_agg` → `with_windows`
- Server action: `app/(app)/inventory/rc-movement/actions.ts` — exports `fetchRcMovementData(year, month)`, `RcMovementRow`, `RcMovementDay`, `RcMovementData`

**Apply migration command (once DB is unpaused):**

```
supabase db push --include-all
```

or via Supabase MCP:

```
mcp__supabase__apply_migration name=create_view_rc_movement query=<see migration file>
```

**After apply, regenerate types:**

```
supabase gen types typescript --linked > types/supabase.ts
```

Then remove the `(supabase as any)` cast in `actions.ts` lines ~91-115 (the inline type annotation) — replace with proper `supabase.from('view_rc_movement')`.

**How:** The `(supabase as any)` + inline row type cast in the server action is a temporary workaround until `types/supabase.ts` is regenerated. The build passes clean with zero TS errors in this state.

**CTE design decision:** Used `batch_meta` CTE to pre-compute supplier + deliveries_total per batch, avoiding `MAX()` inside correlated subquery WHERE clauses (PostgreSQL fussy about that). `batch_meta` only materializes batches that have rc_out records (WHERE EXISTS guard).

**block_loc GROUP BY fix:** `rc.block_loc` excluded from GROUP BY to maintain one-row-per-(batch,date) invariant. Uses `MAX(COALESCE(rc.block_loc, b.location_ref))` — deterministic, alphabetical max for the rare two-location-same-day edge case.

**How to apply:**
