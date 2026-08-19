# Sync review — the "one-click fix" assessment (2026-08-19)

Written against run `312b3213` (11 findings) and the code as of `main` @ `ed84693`.
A plan, not a build. Renzo asked for the simplest options, prioritising intuitiveness.

## The one fact that explains why the report nags

Of the 11 findings, only **6 have any durable record** (`sync_held_cases`: the 5 `block_diff`
+ the 1 `cross_batch_reassignment`). The other 5 — both `delivery_human_edited`, both
`price_fuzzy_match`, and the grand-total line — are **recomputed every run and stored nowhere**.
They have no identity, so there is nothing to mark resolved; the only way to silence one is to
change the source data. That is why every note ends in "please confirm" with no button: the
sentence is written for a human, and the action lives somewhere else, or nowhere.

Two surfaces exist today: the **Run Sync panel** (per-run, ephemeral, `flattenRunFindings`) and
**`/sync/cases`** (durable cases grouped by run, with confirm-gated `ResolutionCard`,
`QuickDismissDialog`, and the two-sided `SourceDiffCard` pick UI for `source_diff`). A third
surface would be the wrong direction; the review UI should be the cases page grown up.

## 11 findings are really 4 decisions

| Decision | Kind | Durable? | The buttons a person actually wants | What exists / what is missing |
|---|---|---|---|---|
| **Batch moved** — Sheet says `AUG-26-RECOOKED1`, app has `FEEDING AREA` | `cross_batch_reassignment` ×1 | yes (case, `open`) | **[Keep app] [Take Sheet]** | The resolve machinery exists (`executeResolution` → `edit_apply`), and `SourceDiffCard` already renders exactly this two-sided pick for `source_diff`. Missing: this kind is not routed to it. **Smallest fix: extend the pick card to `cross_batch_reassignment`.** |
| **Your edit was kept** — remarks `FEED` vs source | `delivery_human_edited` ×2 (**same delivery, two sources — one decision**) | **no** | **[Keep mine] [Take the source]** | `fn_release_delivery_rows` exists in the DB and **no server action calls it** ("the in-app door is not built" — CLAUDE.md). "Keep mine" has nowhere to be stored, so it re-fires forever. Missing: the release action + a durable ack. Also: dedupe by `record_id` → one card, not two. |
| **Priced from a differently-spelled row** — `RE-COOKED` vs `LAPAYAG`, `CDD 1689` vs `CDD1889` | `price_fuzzy_match` ×2 | **no** | **[Same truck ✓]** ([Not the same ✗] deferred) | The price WAS applied; the alias is already earned by the fallback match (`delivery_source_aliases`). "Confirm" therefore changes nothing in the data — it only needs to stop re-firing. Missing: a durable ack. ✗ means "un-price + retire the alias", heavier — defer, keep as manual. |
| **Block balance mismatch** ×5 + a total that is fully explained by them | `block_diff` ×6 | yes (5 cases) | **[Acknowledge]** (nothing to fix in-app — the Sheet's Blocking tab is behind, or it is a real gap someone checks physically) | Cases exist. Missing: "changed since I last looked" — the same delta should stay quiet after ack; a NEW delta should re-alarm. The `grand_total` line (`residual_kg=0, fully_accounted=true`) should render **under** the five, not as a sixth alarm. |

So an intuitive panel shows **4 cards with buttons**, not 11 prose lines. That regrouping alone
is a rendering change with no schema.

## The one thing every option needs: an ack ledger

`sync_finding_acks (fingerprint text PK, kind, action text, note, acked_by, acked_at,
content_hash)`. A finding's `fingerprint` already exists for cases (`case_fingerprint`); the
ephemeral kinds need one built the same way (kind + the identifying data, never a ₱ value).
`content_hash` is what makes **"acknowledged until it changes"** work: same delta → stays quiet;
new delta → surfaces again. RLS on, `authenticated` insert/select, no update/delete (append-only,
the project idiom).

Without this table there is no "resolved" for half the report, and no one-click anything.

## Options, simplest first

**A — Acknowledge only.** The ack table + one server action + the panel/cases page hiding
acked findings whose `content_hash` is unchanged + the 4-card regroup. No side effects on data.
*Kills the nagging immediately.* ~1 migration, 1 action, 1 rendering pass. Lowest risk.

**B — A + the two real one-click fixes.** (1) `releaseDeliveryRows` server action over the
existing `fn_release_delivery_rows`, exposed as **[Take the source]** on the human-edit card —
next run applies the source value through the existing latch-aware path, nothing new is written
by the button itself. (2) Route `cross_batch_reassignment` through the existing `SourceDiffCard`
so **[Keep app] / [Take Sheet]** work like `source_diff` already does. Both reuse existing
functions; the risk is in the wiring, not new writes. *This is the "one-click fix" feel.*

**C — A full review inbox.** New route, per-finding cards for every kind, dashboard badge with
resolved/unresolved counts, history of who acked what. Biggest; most of it is B plus chrome.

**Recommendation: A first, then B, as two small steps.** A is a day and changes what the panel
*feels* like; B is where the buttons start doing things, and both of its actions already exist
in the DB. Do not do C until A+B have been used for a week — the kinds that turn out to nag
after acks exist are the ones worth a bespoke card.

## The dashboard hook (cheap in every option)

The digest's latest-sync band already exists; `/sync/cases?run=<id>` is already a deep link.
Add **"N need you"** (unacked, unresolved) to the band, linking straight there. Once the ack
table exists the count is one query. No new page.

## Not in scope, deliberately

- ✗ on a fuzzy price match (un-price + retire alias) — heavier, rare, keep manual for now.
- Auto-resolving `block_diff` when the Sheet catches up — the check already goes quiet on its
  own; ack-until-changed covers the human side.
- Any Jarvis/AI layer — the adjudicator is dormant by decision (2026-07-11); nothing here needs it.

## Files a build would touch (for scoping, not a brief)

`supabase/migrations/…_sync_finding_acks.sql` · `app/(app)/sync/actions.ts` (ack + release) ·
`lib/sync/findings.ts` (fingerprint + content_hash for ephemeral kinds, one definition shared
with the Excel report) · `components/sync/cases/*` (4-card regroup, `SourceDiffCard` routing) ·
`components/digest/*` (the "N need you" count). Worker: only if a finding needs a stable
fingerprint it does not carry today.
