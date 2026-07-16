---
name: price-gate-audit-2026-06-15
description: Adversarial security review of charcoal price/cost gating fixes — found one live server-side cost_basis leak (fetchSingleDelivery) plus pattern notes
metadata:
  type: project
---

Adversarial review of the price-gating fixes on branch `feat/blackwood-table-universal-grid` (uncommitted working tree, 2026-06-15).

**Why:** Team fixed 3 charcoal price/cost leaks; I was asked to prove they weren't fully closed. Charcoal ops = first tenant; price (₱/kg, cost_basis, avg_cost, weighted-avg fed price) must be hidden from the `Production` role, INCLUDING an Owner/Admin/Dev impersonating Production via the `dev_mock_role` cookie.

**How to apply:** When reviewing price gating in this repo, the canonical gate is `lib/auth.canViewPrices()` (impersonation-aware via getUserRole) / `roleCanViewPrices(role)`. The security boundary is the server action / RSC return — null the ₱ fields BEFORE the payload leaves. Client render gates (`hasPermission('view:prices')` or a server-passed `canViewPrices` prop) are cosmetic only.

## LIVE HOLE FOUND (server-side leak, reachable by Production)
`fetchSingleDelivery(deliveryId)` in `app/(app)/inventory/blocking/actions.ts` (~line 244) returns `cost_basis: Number(data.cost_basis)` UNGATED. Type `FullDeliveryRecord.cost_basis: number` (blocking/types.ts line 64) is non-null. Reached by Production via Blocking tab OR RC Movement matrix → detail panel → delivery row info dialog / pencil edit dialog (`_shared/blocking-detail-panel.tsx` line 264 + `_shared/edit-delivery-dialog.tsx` line 99). The edit dialog hides the PHP/KG input client-side (`canViewPrices &&`) but the value is already on the wire. Fix: gate it like its sibling `fetchBlockingDetail` (role !== 'Production' → cost_basis undefined) and make the type optional.

## CLEAN (verified gated server-side, fail-closed)
- `canViewPrices()` — fails closed (no user → false; impersonation-aware). Sound.
- RC OUT `fetchRcOutTabData` — avg_price + avg_wtd_value nulled server-side; type now `number | null`; client render via server `canViewPrices` prop threaded lazy-tab→wrapper→table (NOT hasPermission). Footer/clipboard read null → safe. `getRcOutRecords` fully deleted (no callers).
- RC Movement `fetchRcMovementMatrix` — all 3 ₱ fields (campaignAvgFedPrice, per-day avgFedPriceDay, per-column avgFedPrice) nulled at the map; empty/error returns fail closed with canViewPrices:false.
- Inventory page.tsx RC IN — cost_basis → undefined via canViewPrices(); fixed the prior impersonation leak (was inline profiles lookup).
- `getDeliveryHistory` / `getAuditLogEntry` (rc-in/actions) — scrub cost_basis from snapshot/diff/current when isProduction (via getUserRole, fails closed).
- `fetchBlockingGridData` / `fetchBlockDataForBatch` / `fetchBlockingDetail` — php/avg_cost gated in the remap; raw `select('*')` on view_blocking_grid (has avg_php_kg) is safe because the remap discards raw rows.
- review-queue actions — write/diff path, gated to PRIVILEGED_ROLES at the page; not a price-read leak.

## PATTERN NOTES (recurring)
- Two gating styles coexist: server-prop `canViewPrices` (RC OUT, RC Movement) vs client `hasPermission('view:prices')` (RC IN master table line 212). RC IN is safe ONLY because data is server-nulled; the client gate is cosmetic. Inconsistent but not a hole.
- Blocking actions use inline `role !== 'Production'` instead of `roleCanViewPrices()`. Equivalent today; drift risk if Accounting rules change.
- Audit scrubbing (getDeliveryHistory) is a DENY-LIST (deletes only 'cost_basis' key). Safe now (deliveries' only price col), fragile if a price-derived key is ever added to snapshot/diff JSONB. Allow-list (null-by-default) would be safer.
