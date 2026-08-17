# 2026-08-17 — Liquidation Step 4, a week of sync-integrity fixes, and the deploy gap that hid them all

> Continues `2026-08-05-liquidation-steps-1-3.md`. Steps 1–3 shipped there; this session took
> liquidation to Step 4, then spent most of its length on ICTC sync data integrity.

---

## TL;DR

**Liquidation reached Step 4** — cheques can now be assigned to specific deliveries from either
direction, and supplier opening balances make the running balance true without back-entering seven
months of history.

**Then a question about two unpriced deliveries opened a week of real bugs.** The sync had priced
**zero** August deliveries because it addressed Czarina's worksheet by a name she doesn't use; nine
duplicate deliveries existed because the sync identified a delivery by facts that people correct;
and a human correction from February had been overwritten twice despite a warning note. All fixed.

**The most important discovery is structural: merging to `main` never deployed the sync worker.**
It runs on Fly and needs an explicit deploy nobody knew about. A full day of sync fixes sat inert on
`main` while the machine ran a five-day-old build — and the deploy that would have shipped them had
been failing the whole time on a broken container build.

**Everything is on `main` and deployed to both targets.** Worker at **version 16**.

---

## What shipped

| Merge | Work |
|---|---|
| `a86643a` | Liquidation Steps 1–3 (audit trail · subgroups · banks/payments/balance) |
| `67679c0` | Supplier opening balances — state what is outstanding, count forward |
| `7a8bee6` | **Step 4** — allocations, both doors, settlement views |
| `0656e69` | Excel sync report, generated every run and stored |
| `9f877c7` | RC Movement **actual fed ₱/kg** |
| `baa269c` | Czarina tab resolver + loud price failures + 10 backfilled prices |
| `a549afd` | Nine duplicate deliveries archived and removed |
| `50eced1` | **Two-tier delivery identity** — the root-cause fix for duplicates |
| `7a127b3` | Human-edit latch on `deliveries` |
| `e58c7d2` | **Worker container build fixed** + the two-deploy-targets rule |
| `26a75e1` · `43a66f8` | Blocking grand-total residual + the lag badge |
| `d6c69da` | `FEEDING # N` understood; "not filled in yet" no longer called malformed |
| `5f24f23` | Shipments: download just the customer send-out set |
| *(uncommitted at time of writing)* | `fn_recompute_batch_state` grant fix + trigger-grant guard |

**Migrations:** `20260805100000` rc_delivery_audit · `…110000` supplier subgroups · `…120000`
payments · `20260805130000` opening balances · `20260806060000` allocations ·
`20260807040107` price enrichment · `…053911` deliveries archive · `…060558` sync run reports ·
`…090554` actual-fed price · `20260808015712` human-edit latch ·
`20260814025344` + `…025716` the grant fix and its guard.

---

## Critical learnings

**1. There are TWO deploy targets and only one of them is `main`.** Vercel builds the Next.js app;
`workers/sync/` is a separate Fly artifact that ships only on `npm run deploy`. On 2026-08-08 a full
day of sync fixes was merged, green and live on the website, while the Fly machine still ran a
five-day-old bundle. **"Landed" and "live" are different facts and nothing in the repo said so.**
Now a table in `CLAUDE.md`, plus a `predeploy` gate.

**2. The worker's container build had never worked since the Excel report landed.** `findingsBridge.ts`
imports `lib/sync/findings.ts` across the package boundary — deliberate, so the workbook can't
disagree with the panel — but the Docker context was `workers/sync/` only. Every local gate passed
while the image could not build. The image now mirrors the repo layout (`WORKDIR /repo/workers/sync`);
flattening to `/app` could never work, because the relative path would climb above the filesystem root.

**3. Never address a human-named worksheet by a generated name.** Czarina's 24 tabs use at least four
conventions (`Aug. 2026`, `Jan. 2026.`, `Nov 25. ` with a trailing space, `March25`). The code built
`"August 2026"`, missed, and a bare `catch` reported *"Price file unavailable"* — **the file was
available.** One bad tab name un-priced an entire run. ₱8.9M of intake carried no value.

**4. A natural key may only be built from facts that DO NOT GET CORRECTED.** The delivery identity was
`(date, batch_code, block_loc, weight_kg)` — no truck plate, three correctable fields. Correcting any
of them made the sync insert a second row. Now tier 1 is `(date, normalised plate, sacks)`: measured
**unique with zero collisions** across 1,545 rows, and it keeps wet-sack splits separate.

**5. A warning written as a comment is not a control.** A 2026-06-25 `audit_logs` note said, verbatim,
*"DO NOT auto-revert to the Sheet value."* The sync overrode that row on 07-03 and again on 08-07.
An instruction is only obeyed when it is a predicate in an UPDATE's WHERE clause.

**6. A privileged writer masks a broken unprivileged path.** In-app delivery editing was **broken for
nine days** — the trigger runs as the user and called a helper granted to `service_role` only. The
sync never noticed because it writes privileged. The only symptom was a human hitting an error.
There is now a guard that walks the trigger call graph per role.

**7. The unpriceable-receipt hole produces NO peso discrepancy, ever.** `total_price_php` coalesces to
exactly 0, so the naive balance returns the **right number with a silent hole**. It is a count gap,
never a money gap — which is worse, because no amount anywhere reveals it.

**8. An operator's shorthand is a naming convention to be learned, not malformed input.** Third
instance this month: `Aug. 2026` vs `August 2026`, `FEEDING # 1` vs `JULY-26-FEED1`, and
`FEEDING # N` failing a regex that wanted the word "AREA".

**9. Deleting a duplicate does not stick while the source still has it.** Two February rows were
deleted at 05:41 and re-inserted by the sync at 07:34 the same morning. The fix is at source, or in
the identity.

---

## Current state

**Liquidation (`/cenapro/liquidation`)** — balances, record-a-payment, bank/account maintenance,
supplier subgroups, the cheque-spread screen, and starting balances. **No cheque or allocation has
ever been saved** — the write path needs a real session, so it was contract-tested with
refusal-only payloads (8/8 refused cleanly). **The first real cheque is still the untested path.**

**ICTC deliveries** — 1,701 rows, **zero unpriced, of any age**. All batch `avg_cost` figures honest.
Nine duplicates archived (restorable via `fn_restore_archive_batch`). In-app editing works again.

**Sync** — worker **v16** on Fly, health passing. Findings are down to block-balance drift plus three
`JAN-25-FEED2/3/4` cases waiting on Renzo. Every run leaves an Excel report.

---

## Open decisions — all waiting on Renzo

1. **Rename Sheet rows 153–155 to `JAN-25-FEED1`.** Three findings re-fire every run until then. The
   app already has all four under FEED1, where the 15 RC OUT rows point. Row 152 is the worked example.
2. **Move the 2026-08-12 delivery from `FEEDING # 2` to `AUG-26-FEED2`.** One row; clears a phantom
   **18,650 kg** and a **−3,000 kg** balance at once. Offered, not yet approved.
3. **`NO-NEGOTIABLE BL` is not recognised as a BL** (`classify.ts` matches `NON NEGO` / `NON-NEGO`).
   On the `AUGUST 19` shipment the genuine non-nego BL is **excluded from the send-out set** while an
   LOI fills the slot because it carries a `MEDUPH` booking number. **A wrong document would go to the
   customer.** One-line fix, but it diverges from the Python port.
4. **18 functions still hold `anon` EXECUTE** though `CLAUDE.md` says none do. Not exploitable (`anon`
   has no table privileges, all RLS targets `authenticated`). Revoke or amend the doc.
5. **Czarina still has the CAJ/CBJ sack totals transposed** (her CAJ 388 / CBJ 533, the reverse of MC's
   correction). No money impact — sacks are not in the price.
6. **The production-schedule sync step took 524s once** (normally ~30s), on a run that reported
   "nothing to change". Watch whether it recurs before optimising.

---

## Next concrete actions

1. **Record one real cheque end to end** — add a bank account first; the DB requires one for a cheque.
   This is the only wholly unexercised path in the liquidation module.
2. **Decide the four items above**, starting with the BL classification — it is the only one that
   could put a wrong document in front of a customer.
3. **Build the summing rule** if Czarina's one-row-per-truck format keeps colliding with MC's split
   rows. Deferred because the CAJ/CBJ case resolved without it.
4. **No in-app release door for the human-edit latch.** `fn_release_delivery_rows` and
   `view_deliveries_human_edited` exist and are granted, but nothing calls them — so a latched
   delivery can only be released by service role. Production has proper buttons; deliveries does not.

---

## Traps worth carrying forward

1. **Merging to `main` does not deploy the sync worker.** Run `npm run deploy` from `workers/sync` —
   never a bare `fly deploy`, which gets the build context wrong.
2. **Never sum a diff's `delta` field to reconcile the blocking total.** Presence-shaped diffs carry
   `delta: null`; use `(sheet_kg ?? 0) − (computed_kg ?? 0)`.
3. **A real duplicate's signature is an identical FULL lab panel + sacks + weight**, differing only in
   `batch_code` — and lab panels must be compared **numerically, not as JSON text** (`12` vs `12.0`).
4. **A wet-sack deduction split is NOT a duplicate.** Same date/truck/supplier, different sacks and
   MC/ash. Routine daily business.
5. **Search a supplier's file by weight, not by plate.** `CBG6560` vs `CBJ6560` cost an hour; weight
   found it in one query.
6. **`negative = we owe the supplier`** in Cenapro liquidation — the opposite of accounting convention.
7. **When a card shows new data but old chrome, suspect a stale browser bundle**, not the mapper.
8. **A bare `catch` around a whole-file load is the real defect**, not the parse error inside it.
