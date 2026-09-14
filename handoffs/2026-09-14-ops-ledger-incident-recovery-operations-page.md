# 2026-09-14 (PM) — DB incident recovered, ops-ledger proofs made per-campaign, `/operations` page shipped

> Continues `2026-09-14-downtime-fix-ops-ledger-drafts-DB-INCIDENT.md` (same day, morning).
> Branch `feat/ops-ledger` → merged to `main` at the end of this session (see §4 for what is and is not verified).

## 1. TL;DR
- The Supabase instance came back after the dashboard restart. Nothing was lost; nothing existing was altered.
- The probe that hung it is GONE, and it is now **structurally impossible** to run a whole-history proof against the ops-ledger stack: the replacement probes are per-campaign (`production_batch` + `campaign_year` filters everywhere) and the group probe refuses more than 12 keys.
- Every `view_ops_ledger_*` view was measured on one campaign under a 5 s guard — all under 100 ms; the group RPC 147 ms.
- The new posture probe found a real defect on its first run: the ₱-bearing `view_ops_ledger_campaign_kpis` was **not `security_invoker`** on the live DB. Fixed.
- The real `/operations` page (Split lens, live adapter) is built, type-clean, lint-clean, `npm run build` green.

## 2. What shipped (file paths)
**Data layer / proofs** (commit `0120688`):
- `supabase/migrations/20260914033037_ops_ledger.sql` — sections 11–12 (both whole-history probes) removed; sections 1–10 byte-identical; note appended to §10.
- `supabase/migrations/20260914064415_drop_fn_ops_ledger_verify.sql` — the drop applied during the incident (written to match; already applied).
- `supabase/migrations/20260914065453_ops_ledger_verify_per_campaign.sql` — `fn_ops_ledger_verify_campaign(text)`, `fn_ops_ledger_verify_group(text[])`, `fn_ops_ledger_verify_posture()`; SECURITY DEFINER, STABLE, `service_role` EXECUTE only, no ₱ value returned. Applied.
- `supabase/migrations/20260914065558_ops_ledger_campaign_kpis_security_invoker.sql` — the repair. Applied.
- `scripts/verify-ops-ledger.ts` — sequential per-campaign loop, 5,000 ms budget per call. 32 campaigns · 686 ledger days · 148 rest days · 68 assertions · slowest 853 ms (JANUARY 2026).
- `app/(app)/operations/CONTEXT.md`, `CLAUDE.md` (one sub-bullet), `types/supabase.ts` (+9 lines).

**Page** (this session's final commit):
- `app/(app)/operations/page.tsx` (Server Component; `?campaigns=`, `?lens=`; default = newest campaign), `operations-view.tsx`, `ops-ledger-split.tsx`, `ops-kpi-strip.tsx`, `ops-day-detail.tsx`, `ops-group-picker.tsx`, `ops-lens.ts`, `ops-format.ts`.
- `components/navbar.tsx` + `components/NAVBAR.md` — breadcrumb entry and module link beside Analytics.
- `.agents/plans/ops-ledger-plan.md` §3 filled; `app/(app)/operations/CONTEXT.md` UI sections added.

## 3. Critical learnings
1. **A check too expensive to run is not a weaker check, it is no check.** The whole-history probe asserted `security_invoker` on all eight views and never completed once; the cheap catalog probe found the gap immediately.
2. **Per-partition measurement with `set local statement_timeout='5s'` BEFORE any proof** is now a memory rule and a repo rule. Filter on the base columns (`production_batch`, `campaign_year`), not on the computed `campaign_key`, so the planner pushes the predicate into the CTEs.
3. **`ALTER VIEW … SET (security_invoker = true)` can silently not land** — verify `pg_class.reloptions`, not the migration text.
4. Two agents in one working tree cross branches; use worktrees or sequence them (this session sequenced: backend → guardian → frontend → guardian).

## 4. Current state / what is NOT verified
- The `/operations` route was verified in Chromium on a **fixture mount of the real components** (light, dark, 375 px; row alignment read from the DOM; price-denied layout drops ₱ columns entirely). It was **NOT rendered with a signed-in session on real data** — the dev server redirected to `/login`. The adapter and ₱ gate are covered by the data layer's 68 assertions and the build. **Renzo's first look on production is the real-data test.**
- Two footers deliberately print a sentence instead of a number: the LOSSES lens and the BLOCKS FED lens have no campaign/group total in the payload (waste streams and per-block columns have no view column at that grain). If those totals are wanted, add a view column — never sum in TSX.
- No worker change this session → **no Fly deploy needed**.

## 5. Open decisions
- Whether the waste-stream and per-block footers should get real totals (needs a view column).
- The 404 Renzo saw on `/dev/ops-ledger` while signed in (morning handoff) is still unexplained; likeliest cause remains the navbar Shield impersonation cookie.

## 6. Next concrete action
Renzo opens `/operations` and `/operations?campaigns=JULY-2026,AUGUST-2026,SEPTEMBER-2026` on production, as Owner and as "view as Production", and reports what the real data looks like. Then: decide the two footer totals; remove the `/dev/ops-ledger` drafts (or keep as archive) once the real page is accepted.
