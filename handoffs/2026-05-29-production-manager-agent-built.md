# Handoff — 2026-05-29 — Production Manager Agent: Built + Validated (EXECUTE deferred)

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md`. Latest: `ls handoffs/ | sort -r | head -1`.
>
> **Lineage:** continues `2026-05-29-production-ledger-backfill-shifts-refactor.md`, whose stated next action — "Build the Production Manager agent" — is **DONE** as of this session.

---

## TL;DR

Built the **Production Manager** (third ingestion employee, after deliveries-manager + rc-out-manager) **end-to-end across 5 phases**, and validated it in PROPOSE (dry-run) against the live DB. It ingests MC's "Daily Production Report" + Ivy's "WASTE PRODUCTION REPORT" into 6 tables. Started the session by **deep-reading both source emails** to map their exact XLSX structure — which surfaced several real divergences from the design-doc assumptions (electricity "120" is a meter multiplier not a peso rate; Ivy's waste stream headers differ from MASTER but map positionally; MC's "NIGHT" = Ivy's "EVENING" = canonical shift `E`). Locked those decisions with the user, then built: a DB migration, 2 extractors, 5 classifiers, a reconciler, and the agent definition.

**The PROPOSE test passed and earned its keep** — it caught a real watermark-filtering bug (cumulative workbooks ballooned the window + surfaced 74 historical null-shift rows), fixed by adding a `--since` flag to the extractors.

**Current state:** everything committed to `dev` (3 commits), build green, electricity migration live. **No production data has been written yet** — the DB is still current through 2026-05-23.

**Next concrete action:** the user wants a **real unified run with BOTH the production-manager and deliveries-manager agents, on their say-so.** This requires a **Claude Code restart first** (new agent files don't register mid-session). After restart: "sync production and deliveries" → review combined PROPOSE → approve → EXECUTE. The production catch-up waiting is **5/25–5/28 (25 rows)**.

---

## What shipped this session

### Phase 1 — Electricity schema rework (commit `e80f6f6`)
- Migration `supabase/migrations/20260529070745_rework_electricity_to_meter_multiplier.sql`: renamed `electricity_readings.rate_php_per_kwh` → **`meter_multiplier`**, added generated **`consumption_kwh = (end_kwh − start_kwh) × meter_multiplier`**, dropped the dead `view_electricity_monthly`. (The 120 was never a peso rate — the source email labels it a meter multiplier.)
- `app/(app)/production/electricity/actions.ts` — payload uses `meter_multiplier` (fallback 120).
- `app/(app)/production/electricity/electricity-grid.tsx` — `RATE`→`MULT`, `TTL PHP (₱)`→`TTL KWH`, removed the `view:prices` gate (kWh isn't price data) + unused `useAuth`.
- `types/supabase.ts` regenerated; `app/(app)/production/CONTEXT.md` + `electricity/CONTEXT.md` updated.

### Phase 2+3 — Deterministic pipeline (commit `d244be3`; `--since` fix in `2539181`)
All in `.claude/skills/sync-ictc/scripts/`:
- `extract_daily_production.py` — MC, one sheet/day → `runs/downtime/electricity/trucks`. Strips `CEBU `/`KURARAY ` customer prefix, drops KOREA/LOCAL/ZAMBOANGA powder, `NIGHT`→`E`. Has `--since YYYY-MM-DD` (exclusive watermark filter).
- `extract_waste_production.py` — Ivy, one sheet/month → `waste` (8 streams, positional). `EVENING`→`E`, absent shift→`M`. Has `--since`.
- `classify_production_{runs,downtime,waste}.py` — resolve `shift_id` via the `(date,batch,shift)` triplet; flag `needs_shift_upsert`; null-shift → MALFORMED.
- `classify_electricity.py`, `classify_trucks.py` — direct natural-key; ignore generated columns.
- `reconcile_production.py` — **informational only, always exits 0** (`--strict` flips only on internal arithmetic errors). Daily kg in/out drift never gates.

### Phase 4 — The agent (commit `2539181`)
- `.claude/agents/production-manager.md` — PROPOSE/EXECUTE, `model: opus`. Owns `production_shifts` (parent) + `production_runs/downtime/waste` (children) + `electricity_readings` + `truck_readings`. Upserts shifts before children; reconcile informational; MALFORMED/null-shift never written; cites MC+Ivy provenance in audit logs.

### Design doc
- `.claude/skills/sync-ictc/PRODUCTION_DESIGN.md` — added **§15** (canonical scrape maps for both emails with cell coordinates + the verified 8/8 waste mapping + DB reality + shift normalization), **§16** (agent built), the electricity decisions in §12, and the `--since` note in §15.7. **This is the build reference — read §15 first if touching the extractors.**

---

## Critical learnings to internalize

1. **Source-email structure (verified by reading the real emails, not MASTER):**
   - MC "Daily Production Report" = **one sheet per day**, title `MM-DD-YY` (trailing whitespace — strip). `transaction_date` = the **sheet name**, NOT cell `D4` (D4 is the next-morning write date).
   - Ivy "WASTE PRODUCTION REPORT" = **one sheet per month**, title `MONTH YYYY` (some have a leading space). Rows = days, sometimes 2/day split by shift (V column).
   - Both workbooks are **cumulative** (latest email carries the whole file) — process the latest attachment, filter by watermark.

2. **Electricity "120" is a METER MULTIPLIER, not a peso rate.** Real consumption (kWh) = raw diff × 120. The schema column was renamed accordingly; there is no peso cost anywhere in the data.

3. **Waste 8-stream mapping is positional, verified 8/8 value-for-value** against MASTER on 5/22 + 5/23: Ivy's `FILTER`→`bf_kg`, `UNCOOKED/SHELL`→`trml1_kg`, `STONES`→`trml2_kg` (the other 5 match by name). Renzo's MASTER is literally Ivy's email with renamed headers.

4. **Shift normalization is canonical:** MC's "NIGHT SHIFT" and Ivy's "EVENING SHIFT" are the **same physical 2nd shift** → both emit **`E`**. The DB already holds M(140)/E(18), **zero N** — so this needed no migration. `N` is reserved for a future 3rd shift.

5. **`customer` is real — KURARAY is a legitimate production customer** (22 rows in MASTER history); the extractor preserves it. Only KOREA/LOCAL/ZAMBOANGA *powder* (waste-buyer sales) is dropped.

6. **Reconciliation is INFORMATIONAL and NEVER gates writes** (opposite of rc-out-manager's hard gate). RC IN→RC OUT→(production+waste) doesn't balance per-day — the feed tank empties at month-end, so daily drift is expected, not an error.

7. **The `--since` bug (found by the e2e test):** with `--all-sheets` on a cumulative workbook, the classifier's DB window ballooned to ~5 months and surfaced **74 historical null-shift rows** as MALFORMED noise. Fix: extractors now take `--since {watermark}` (exclusive). The agent passes it; the no-`--since` path is preserved for backfill.

8. **Null-shift rows → MALFORMED, never written.** MC's April sheets predate shift-labeling (column H blank). The classifier surfaces them; the agent never writes them. The `--since` catch-up excludes them anyway.

9. **Two operational gotchas:** (a) **don't fetch MC + Ivy in parallel** — concurrent Gmail IMAP logins time out (`[Errno 60]`); fetch sequentially. (b) **New agent files don't register mid-session** — `production-manager` was tested via a `general-purpose` proxy reading the agent file; a **restart** is required before it's invocable by name.

---

## Current state

### ✅ Working / validated
- Electricity migration live (MAIN consumption recomputes: 5/23 = 7.0×120 = 840 kWh). Build green (`tsc` 0 errors, `npm run build` ok).
- Full pipeline PROPOSE validated against the live DB: catch-up **5/25–5/28** = 8 runs + 4 downtime + 8 waste + 4 electricity + 1 truck, **all NEW (8 shifts to upsert), 0 MALFORMED, 0 VALUE_CHANGED**, all confidence ≥ 0.95. Reconcile non-gating, arithmetic checks pass.
- Extractors verified: `--since 2026-05-23` → exactly 5/25–5/28, 0 null-shift; no-`--since` path unchanged (82/132).

### ⚠️ Built but NOT run
- **EXECUTE mode has never been run — no production data written.** DB `production_shifts` still latest 2026-05-23. The 25-row catch-up is waiting.

### ⚠️ Deferred follow-ups (flagged, not done)
- `shift_hrs` for downtime **defaults to 12** (email doesn't report it cleanly — `C26` is ambiguous). Renzo to ask MC to report shift length + split downtime by shift.
- BUNKHOUSE/PUMP electricity assume multiplier 120 (idle since 2025-12-12 — confirm if direct-read when they resume).
- Truck `fuel_liters` from "Liters issued"; qualitative gauge → remarks; the weekly-liters column unused.
- One cosmetic nit: a downtime `dt_reason` occasionally picks up a stray fragment in the concatenation — harmless free-text.
- Pre-existing (from prior handoff): RLS disabled on production tables; audit `performed_by = NULL` convention; `view_trucks_monthly` droppable (also unused).

---

## Open decisions
None blocking. The minor ones above (shift_hrs default, bunkhouse/pump multiplier) can be resolved when the data appears.

---

## Next concrete action

**The user will trigger a real unified production + deliveries run "on their say-so."** To enable it:

1. **Restart Claude Code** so `production-manager` registers as a named agent (deliveries-manager already exists).
2. User says e.g. "sync production and deliveries" (or "sync ICTC").
3. A dispatcher launches **production-manager (PROPOSE)** + **deliveries-manager (PROPOSE)** — fetch sequentially per email source — and presents a combined summary.
4. On approval, both run **EXECUTE**: production upserts 8 shifts → inserts 25 rows + audit logs + labels MC #118639 / Ivy #118635; deliveries writes whatever is new since its watermark.

If the user wants it **this session before restarting**, production-manager can be driven via a `general-purpose` proxy (read `.claude/agents/production-manager.md`, follow EXECUTE) while deliveries-manager runs as the real named agent — but the clean "both real agents in unison" path needs the restart.

---

## Git state at handoff
- Branch `dev`, working tree **clean**. This session's 3 commits (NOT yet pushed — `origin/dev` is behind; fast-forward `git push origin dev` when ready):
  - `e80f6f6` `feat(production): rework electricity schema from rate to meter multiplier`
  - `d244be3` `feat(production): add deterministic extract/classify/reconcile pipeline for email ingestion`
  - `2539181` `feat(production): add Production Manager email-ingestion employee + watermark-filtering fix`
- Prior session commits: `f74fc60`, `c36d688`, `e906312`, `dd1bd5f`, `bc2de87`.

---

*End of handoff — 2026-05-29 — Production Manager Agent: Built + Validated (EXECUTE deferred to unified run)*
