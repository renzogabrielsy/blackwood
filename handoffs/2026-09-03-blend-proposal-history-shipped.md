# 2026-09-03 — AUG-26-FEED2 re-point + BLEND PROPOSAL HISTORY shipped

> Continues `2026-09-02-round7-blocking-search-rcin-search-blend-plan.md`. Two items, both done.
> No `workers/sync/**` changes — no Fly deploy needed.

## TL;DR for the next session
1. **Blend proposal history is LIVE** on `/inventory/blocking` (branch `feat/blend-proposal-history`,
   commits `4c64f5f` data layer + `bef46fc` UI, merged to `main`). Renzo has not yet used it on the
   live site — every UI check ran against a fixture (Google OAuth blocks the sandbox). First thing:
   have him build a proposal, Save (title + remark), reopen from the Proposals button, Modify, Save
   as v2, Compare with today. One proof proposal exists, ARCHIVED: `e1c43dbd-…` ("ZZ TEST — …").
2. Possible follow-up he was offered: a card layout for the Proposals list on phones (today it is a
   table that scrolls horizontally past Title/Remark).

## 1. The re-point (DB write, audited)
Delivery `046e38e3-bc43-48b9-9ff8-3761e1017c41` (2026-08-12, Tag-at, KCA 378, 516 sacks,
18,650 kg, ₱39.00). Renzo had already moved it FEEDING # 2 → **AUGUST-26-FEED2** on 2026-08-14,
but its four feedings (3,000 + 3,000 + 2,650 + 10,000, CLOSED 08-17) live under **AUG-26-FEED2**
(the L-042 AUG-/AUGUST- prefix split). Re-pointed to `AUG-26-FEED2`: that pile now balances
**0.00** at ₱39.00 (was −18,650 / +18,650), and **AUGUST 2026's block-price ₱-per-produced-kg reads
₱53.90** (17 of 20 priced) instead of blank. TRUE basis still NULL — 3 piles open (SEPT-25-BLK4,
JULY-26-BLK5, JULY-26-BLK13). Audit row `074a3d5d-…` carries the provenance comment (the DO-block
`set_audit_comment` did not attach; the comment was written onto the row afterwards). The empty
`AUGUST-26-FEED2` and `FEEDING # 2` batch rows were left in place (never delete an emptied batch).

## 2. Blend proposal history — what shipped
- **Data layer** (migration `20260902160452_blend_proposal_history`, APPLIED, file md5 == ledger):
  `blend_proposals` (title, **notes = the remark**, status draft/planned/fed ⟺ `fed_on`, `row_version`,
  soft archive) + `blend_proposal_versions` (APPEND-ONLY, two locks; `blocks` keyed by `batch_id`;
  `snapshot` computed IN SQL by `fn_blend_proposal_snapshot`; `snapshot_hash` price-stripped →
  **a price-only change writes no new version**). RPCs `fn_save_blend_proposal` (compare-and-set on
  `current_version_no`, REQUIRED on an existing proposal; idempotent `unchanged:true`),
  `fn_update_blend_proposal_header` (allowlist title/status/fed_on/notes), `fn_archive_` / `fn_restore_`.
  Views `view_blend_proposal_list` (no ₱, has `notes` + `row_version`) / `view_blend_proposal_versions`.
  `fn_blend_production_loss_pct()` = 30 is now THE definition; `buildBlendProposal` reads it back.
  Seven actions in `blocking/actions.ts`; `fetchBlendProposalVersion` nulls ₱ for `!canViewPrices()`.
- **UI**: Proposals button (+ badge) beside the Blend toggle → `_shared/blend-proposals-dialog.tsx`
  list (title · remark · status · v# · blocks · T · MC/ASH/BD · updated · by; search; show archived;
  restore). Row → the existing `BlendProposalDialog` in saved mode: title + remark header, version rail
  with change note/author/date, **Modify** (blend mode ON, selection seeded by `batch_id`, floating bar
  says which blocks no longer hold the proposed batch, *Save as vN+1* with change note / *Save as new*),
  **Compare with today** (second column with signed deltas, no red/green by design), **Edit** (title,
  remark, status, fed_on), Archive/Restore, Print/PDF with `v3 · as proposed YYYY-MM-DD` + remark.
  Fresh Build Proposal modal gained **Save** (title required + remark). Deep link `?proposal=&v=`
  resolved in the route view. `lib/blocking/blend-diff.ts` pure, pinned by `scripts/verify-blend-diff.ts`
  (23). Mobile: read-only, Modify/Save hidden with a note.

## Gates (green on both commits)
tsc · lint 146/16 baseline · build · verify-blend-diff 23 · e2e 57 · verify-trigger-grants 0 ·
verify-worker-view-grants 4 views / 0.

## Standing items (Renzo to rule)
March 2026 mis-keyed meter reading · MC's August reason-only zero-hour downtime · `open_value_php` ·
Aug-12 "FEED" remark panel click · graveyard deletion · status-spotlight ring CSS order bug (blocking
CONTEXT.md) · empty `FEEDING # 2` / `FEEDING AREA # n` raw-label batches still in `batches`.
