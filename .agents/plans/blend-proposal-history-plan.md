# Blend Proposal History — saved, versioned blends on the Blocking page

> Status: **PLAN, not built.** Written 2026-09-02 from Renzo's brief. Nothing in the database
> or the app has changed for this yet. Read `app/(app)/inventory/blocking/CONTEXT.md` first;
> the current Blend Proposal feature (mode toggle → multi-select → `buildBlendProposal` →
> `BlendProposalDialog` with Print + PDF) is the thing this plan extends.

## 0. The brief, verbatim intent

"Currently, we do not save any blend proposals. There's no history of what we proposed or
planned on feeding. The goal of that enhanced feature is to be able to view the history of all
proposed blends and to be able to modify existing blends with proper version tracking for it.
The UI should just live within the blocking page like a pop-up window or something. UI can be
just simple but the robustness I'm looking for is reliability in the features that achieve the
goals stated."

Three goals, in priority order: **(1) history of every proposal**, **(2) modify an existing
proposal with version tracking**, **(3) all of it inside the Blocking page as a pop-up.** The
brief asks for reliability over polish, so every design decision below is justified by what it
makes *impossible to get wrong*, not by what it makes pretty.

## 1. What exists today, and the one fact that shapes everything

`buildBlendProposal(blockLocs)` computes a `BlendProposal` on demand: the per-block rows
(`block_loc`, `batch_code`, `status`, `balance`, 7 lab stats, gated `php_kg`) from
`view_blocking_grid`, plus one balance-weighted row from `fn_blend_proposal` (weighted lab
stats + `raw_price_per_kg`), plus the TS-only `× 1.30` product cost. It is never stored. The
label a user types for the PDF filename is the closest thing to a "name" and it evaporates too.

**The shaping fact: a proposal is a statement about the yard on a particular day.** Block
balances fall every day as charcoal is fed; a `block_loc` is reused (`batches.location_ref` is
cleared when a batch is emptied — the same limit `view_analytics_inventory_eom` records); lab
averages move as deliveries land. So "the blend we proposed on Sept 2" and "those same eight
blocks recomputed today" are two different numbers, and both are legitimately interesting. A
design that stores only the block list would silently rewrite history every time it is opened.
A design that stores only the numbers could not be modified. **Therefore a version stores
BOTH: the block list keyed by batch identity, and a snapshot of what the DB computed at save
time.** The snapshot is what was proposed; the block list is what can be modified.

## 2. Data model (`public`, ICTC tenant)

### 2.1 `blend_proposals` — the identity (mutable header, small)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `title` | text NOT NULL, non-blank CHECK | the name the operator gives it (today's PDF label becomes this) |
| `status` | text NOT NULL, CHECK in (`draft`, `planned`, `fed`) DEFAULT `draft` | see §5 decision 3 — small, optional lifecycle |
| `fed_on` | date NULL | set when status becomes `fed`; recorded intent only, no join to `rc_out` |
| `current_version_no` | int NOT NULL DEFAULT 1 | the compare-and-set token for appending a version |
| `row_version` | int NOT NULL DEFAULT 1 + touch trigger | the compare-and-set token for header edits |
| `notes` | text NULL | |
| `archived_at` / `archived_by` | timestamptz / uuid FK→profiles | SOFT archive; restore clears it |
| `created_at` / `created_by` | | `created_by` FK→profiles, **no ON DELETE clause** (the `sync_finding_acks` reasoning — a person who authored a plan cannot be deleted out from under it) |
| `updated_at` / `updated_by` | | touch trigger |

### 2.2 `blend_proposal_versions` — APPEND-ONLY, the history

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `proposal_id` | uuid FK→blend_proposals ON DELETE RESTRICT | a proposal with versions cannot be hard-deleted; there is no hard-delete RPC anyway |
| `version_no` | int NOT NULL | **UNIQUE (`proposal_id`, `version_no`)** |
| `blocks` | jsonb NOT NULL | array of `{ block_loc, batch_id, batch_code }` — **identity is `batch_id`**, `block_loc` is where it sat that day |
| `snapshot` | jsonb NOT NULL | the full `BlendProposal` shape as computed **by the database** at save time (per-block rows incl. balance/lab/`php_kg`, weighted row, `raw_price_per_kg`, `production_loss_pct`, `product_cost_per_kg`). **Carries ₱** → every read is `canViewPrices()`-gated at the server action |
| `snapshot_hash` | text NOT NULL | sha256 of the canonicalized `blocks` + price-stripped snapshot; the idempotency key (§3.2) |
| `change_note` | text NULL | "swapped A-3A for A-5B, MC too high" |
| `parent_version_no` | int NULL | which version the author was looking at when they saved (for a fork/branch reading later; today it is always `version_no − 1`) |
| `created_at` / `created_by` | | as above |

**Two independent locks on append-only** (the `sync_finding_acks` / `cenapro.rc_supplier_opening_balance` idiom): no UPDATE or DELETE privilege for any client role, **and** RLS on with SELECT + INSERT policies and no update/delete policy at all, so a future blanket `GRANT … ON ALL TABLES` still cannot rewrite history. INSERT policy `WITH CHECK (created_by = auth.uid())` so authorship is verified by the database, not filled in by the caller. In practice the client never INSERTs directly — the RPC below is the only door — but the lock is the rule, not the RPC.

### 2.3 Read models

- **`view_blend_proposal_list`** — one row per proposal (archived included, with `archived_at`), joined to its CURRENT version: `title`, `status`, `fed_on`, `current_version_no`, `version_count`, `block_count`, `total_balance_kg`, `w_mc`, `w_ash`, `w_bd_astm` (the three the grid already leads with), `created_by_name`, `updated_at`, `updated_by_name`. **No ₱ column** — the list is safe for every role; prices live only inside a version's snapshot.
- **`view_blend_proposal_versions`** — one row per version with the peso-free headline (block count, balance, weighted lab) and `change_note`, `created_at`, author. The `snapshot` itself is fetched per version by the action, gated.
- Both `security_invoker`, `authenticated` SELECT, `anon` REVOKEd, no `service_role` grant (the worker reads none of this).

## 3. Write path — three RPCs, and why the snapshot is computed in SQL

### 3.1 `fn_save_blend_proposal(p_proposal_id uuid NULL, p_title text, p_block_locs text[], p_expected_version_no int NULL, p_change_note text) → jsonb`

- `p_proposal_id IS NULL` → INSERT the header (`current_version_no = 1`) and version 1.
- Otherwise → **append version `current_version_no + 1`, with the guard `current_version_no = p_expected_version_no` inside the UPDATE's own WHERE** (the `fn_apply_production_upstream` / cenapro save idiom: re-check in the same statement as the write, never read-then-write). Zero rows updated → refuse with `{ ok:false, reason:'stale', current_version_no }` so the UI can say "someone saved v4 while you were editing v3 — reload".
- **The snapshot is computed INSIDE the function** from `view_blocking_grid` + `fn_blend_proposal(p_block_locs)`, never accepted from the client. A client cannot save a proposal claiming numbers the yard did not have; the ×1.30 markup is applied here too so the stored `product_cost_per_kg` is exactly what the modal showed (one definition — move `PRODUCTION_LOSS_PCT` into SQL as a constant the action reads back, or keep it in TS and have the RPC take it as a parameter with a CHECK; recommend the former).
- Refuses: blank title, empty block list, a `block_loc` not currently in `view_blocking_grid` (naming it), and an archived proposal (restore first).
- **Idempotent:** if the computed `snapshot_hash` equals the current version's hash, no new version is written and the result says `{ ok:true, unchanged:true, version_no }`. Saving twice never produces two identical versions.
- SECURITY INVOKER, `SET search_path = public`, EXECUTE revoked from PUBLIC/anon, granted to `authenticated`. Runs under the caller's RLS; the version INSERT satisfies `created_by = auth.uid()` because the function sets it from `auth.uid()`.

### 3.2 `fn_update_blend_proposal_header(p_id, p_expected_row_version, p_patch jsonb) → jsonb`

Allowlisted patch (`title`, `status`, `fed_on`, `notes`) with compare-and-set on `row_version` in the same statement; a key outside the allowlist refuses the whole call (the `fn_apply_delivery_upstream` rule). `status = 'fed'` requires `fed_on`; any other status clears it.

### 3.3 `fn_archive_blend_proposal(p_id, p_expected_row_version)` / `fn_restore_blend_proposal(p_id)`

Soft only. There is **no hard-delete RPC and no DELETE grant**: a proposal that was made is history even if it was a bad idea. (The cenapro `cenapro_delete_rc_payment` / `_restore_` pair is the model — "a soft delete you cannot undo is not reversibility".)

### 3.4 Server actions (`app/(app)/inventory/blocking/actions.ts`)

`saveBlendProposal`, `updateBlendProposalHeader`, `archiveBlendProposal`, `restoreBlendProposal`, `fetchBlendProposalList`, `fetchBlendProposalVersion(id, versionNo)`. The last one returns the snapshot with `raw_price_per_kg`, `product_cost_per_kg` and every `blocks[].php_kg` **nulled before the payload leaves the server** when `!canViewPrices()`, and `can_view_prices:false` — exactly what `buildBlendProposal` already does, so the existing dialog renders a saved version with zero new gating code. All four writers `requirePrivileged()`? **No** — Production users propose blends today and must be able to save them; keep the same audience as the existing feature (any authenticated user), and let `canViewPrices()` gate only the ₱.

## 4. UI — inside the Blocking page, as pop-ups

Simple by design, built from parts that already exist.

1. **A "Proposals" button** beside the Blend Proposal toggle in the sticky header (Layers/History icon + a count badge of non-archived proposals). Opens the **Proposals dialog**: a dense table (`table-fixed`, `font-mono` numerics) — Title · Status pill · v# · Blocks · Balance (T) · MC · ASH · BD · Updated · By — with a "Show archived" switch and a search box. Deep link `?proposal=<id>` (and `&v=<n>`), following the `?block=` pattern.
2. **Clicking a row opens the existing `BlendProposalDialog`** fed with the saved snapshot, plus a thin **version rail** across the top: `v1 · v2 · v3*` chips (current starred), the `change_note` under the selected chip, the author + date. Three new header buttons: **Modify**, **Compare with today**, **Rename/Status** (a tiny popover for the header patch). Print and PDF work unchanged on whatever version is shown; the PDF label defaults to the title and the subtitle gains `v3 · as proposed 2026-09-02`.
3. **Modify** closes the dialog, turns blend mode ON, and seeds `blendSelection` with the version's blocks — **resolved by `batch_id`**: a block whose current occupant is still that batch is selected in place; a block now holding a different batch (or empty) is NOT selected and the floating bar says so ("2 of 8 blocks no longer hold the proposed batch: A-3A, B-7B"). The floating bar's button reads **Save as v4** (and a secondary **Save as new proposal**). Save prompts for the change note; the RPC's stale-version refusal surfaces via `errorToast()` with the reload hint.
4. **Compare with today** runs `buildBlendProposal` on the version's block list and shows a second column beside the snapshot in the summary strip (balance, each weighted stat, price) with signed deltas; per-block rows whose occupant changed are marked. Read-only; it never overwrites the snapshot.
5. **Save from a fresh proposal**: the existing Build Proposal modal gains a **Save** button (title prompt — reuse the Download-PDF label popover pattern; Enter confirms). After save the modal shows `v1` in the rail and the Proposals badge increments.
6. Mobile: Blend Proposal is desktop-only today; the Proposals dialog is read-only on mobile (view + print), Modify stays desktop-only — stated in the dialog, not silently missing.

Every error path uses `errorToast()` (persistent + Copy). Nothing animates in the version rail or table rows.

## 5. Decisions worth recording (and the ones Renzo should confirm)

1. **Snapshot + block list, not one or the other** (§1). This is the load-bearing choice.
2. **Versions are append-only and the DB computes them.** A version cannot be edited, deleted, forged, or duplicated; a stale token cannot overwrite. Those four sentences are the "reliability" the brief asks for, and each maps to one mechanism above.
3. **Status lifecycle is deliberately small and optional** — `draft / planned / fed` with `fed_on` as recorded intent, **no join to `rc_out`**. Reconciling "planned to feed" against "actually fed" is real work (the closure-reconciliation vision, BUG-011 shape) and is out of scope. **Confirm:** is `fed` wanted at all, or is archive enough?
4. **`× 1.30` moves to one definition.** Today the markup lives only in TS. The snapshot must store the product cost the operator saw, so the constant should live where the snapshot is computed. **Confirm** the 30% is still the number (it was chosen 2026-06).
5. **No hard delete.** Archive/restore only. **Confirm.**
6. **Audience:** any authenticated user can save/modify (same as building a proposal today); prices gated by `canViewPrices()` as everywhere. **Confirm** whether saving should be Owner/Admin/Dev-only instead.
7. **Not built on purpose:** comments/discussion on a version, sharing/notifications, a "fork" from an older version (recorded as `parent_version_no` so it can be added without a migration), and any automatic feeding execution from a proposal.

## 6. Build order (three passes, each shippable)

1. **Backend** (`supabase-backend-engineer`): migration with the two tables, the two locks, the touch trigger, the three RPCs, the two views, grants; `types/supabase.ts` regenerated; the six server actions; **proofs**: append-only lock verified by attempting UPDATE/DELETE as `authenticated` (must raise), stale-token refusal measured, idempotent re-save writes no row, snapshot equals `buildBlendProposal` output for the same locs to the last decimal, `verify-trigger-grants` + `verify-worker-view-grants` still zero findings. CONTEXT.md + CLAUDE.md schema section updated.
2. **UI pass 1 — history** (`senior-frontend-engineer`): Save from the fresh modal, the Proposals dialog, the version rail, deep link, Print/PDF of a saved version. Gates: tsc, lint baseline, build, browser at 1512/375 both themes.
3. **UI pass 2 — modify + compare**: Modify seeding by `batch_id` with the "no longer holds" notice, Save as vN+1 with change note, stale-refusal toast, Compare with today. A pure `lib/blocking/blend-diff.ts` (set difference of blocks, signed deltas — presentation arithmetic, no aggregation) pinned by a `scripts/verify-blend-diff.ts`.

Estimated size: one migration (~300 lines SQL), ~150 lines of actions, ~600 lines of UI touching `blocking-grid.tsx`, `_shared/blend-proposal-dialog.tsx` and one new `_shared/blend-proposals-dialog.tsx`, plus docs.
