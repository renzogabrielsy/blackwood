# 2026-08-03 — Sync integrity sweep, Cenapro QC, and production batch changeovers

## TL;DR

A long session that started as "Gmail auth is broken" and turned into a sweep of the same
underlying failure pattern across four subsystems: **a detector exists, computes correctly,
and nothing consumes it.** Fourteen promotions to `main`, all deployed.

The headline correction: **the Gmail OAuth migration was solving the wrong problem.** The
real cause of the 2026-07-27 sync outage was Gmail's per-account IMAP connection limit —
Apple Notes on Renzo's Mac was holding 13 of ~15 slots, and the sync was opening 7 sessions
per run instead of 1. OAuth is still worth having (App Passwords are being retired) but it
did not fix anything, which is why the failure recurred.

Also shipped: the Cenapro QC analysis feature end to end (design drafts → live entry +
reading surfaces + partner-draw insert), the production-schedule master plotter, and a fix
for production batch changeovers that had been silently corrupting month boundaries.

---

## What shipped (all merged to `main`, all deployed)

Chronological, newest last. Branch: `feat/gmail-oauth-sync-auth` (14th promotion).

| Merge | What |
|---|---|
| `ca18c6d` | FLECON sync integrity, gsheet duplicate-write fix, digest bag band rebuild |
| `70dfa60` | BUG-019 — one shared IMAP session per run (7 → 1) |
| `3450d3c` | FLECON date-settlement ledger + balance-drift fix |
| `96e825b` | `production_schedule` ownership + gated schedule sync (Phase A) |
| `c3608d5` | Production-schedule in-app editor (Phase B) |
| `7ac5674` | Made the schedule editor discoverable |
| `070e52e` | Setup library + past-day schedule editing |
| `437be13` | Cenapro QC analysis — live feature |
| `65c21e3` | Cenapro ledger multi-select column filters |
| `a773826` | Editable QC ledger weights + `cenapro.production_event_audit` |
| `ff776f8` | Production batch-changeover handling (ENDING / STARTING) |
| `e51045f` | Lag-aware digest KPI cards |
| `8be1fa3` | Production human-edit guard (anti-clobber) |
| `db95d03` | Cenapro QC partner-draw entry |

### Gmail / sync reliability
- `workers/sync/src/lib/gmail.ts` — OAuth2/XOAUTH2 with App Password fallback;
  `workers/sync/scripts/gmail-oauth-mint.ts` (one-time token mint, `--write-env` so the
  token never reaches an agent's stdout), `gmail-auth-check.ts`.
- `workers/sync/src/lib/gmailSession.ts` (new) — reference-counted broker. One IMAP session
  per run, proven by test (7 → 1). Connection-limit errors are no longer mistaken for auth
  failures (`oauthError` is now the discriminator, not `authenticationFailed`), `close()`
  always releases the socket, and the real IMAP response text surfaces instead of
  "Command failed".

### FLECON
- `components/digest/bag-inventory.tsx` — chips → dense Excel stock summary table.
- `workers/sync/src/reports/flecon/*` — silent out-of-window drops now raise findings; the
  balance cross-check (which had been computing correctly and being discarded for three
  weeks) is wired into run results; `fn_flecon_replace_date` makes replace-by-date atomic;
  a stale workbook can no longer wipe a day (it had already done so three times in prod).
- `flecon_bag_date_settlements` — makes the 2026-01-31 human arbitration durable. Five
  movements were backfilled (an operator typo dated them `2025-01-31` inside the 2026 tab).

### RC IN / batches
- Deleted a duplicated delivery (C-11B, 24,024 kg) created by a race between the two write
  paths; the gsheet path now carries the same last-instant idempotency guard as the email path.
- `fn_update_blackwood_state` DELETE branch fixed (it summed the row being deleted);
  4 drifted batches backfilled. **BUG-017 (the UPDATE branch) is still open.**

### Production schedule — the "master plotter"
- `production_schedule` ownership: `owner` / `source_rev` / `pending_upstream` /
  `row_version` / `human_edited_*`, `fn_apply_schedule_upstream`, `fn_save_schedule_day`,
  `fn_release_schedule_day`. Sync is now conditional — an unchanged upstream writes nothing.
- In-app inline editor, ownership badges, revert-to-Joseph, conflict resolution, pending
  count on the digest, setup library with auto-computed grade projections, past-day editing.
- Route: `/production/schedule` (now renders; the redirect was removed via the route-group
  escape BUG-003 itself sanctioned) + `/production/setups`.

### Cenapro QC
- Verified the CCC-CI ANALYSIS sheet **is** `production_event` plus four lab columns, and
  the derivation matched **to the kilogram** (May 2026 = 1,134,070 kg).
- Four design drafts → Renzo picked Ledger Mirror (entry) + QC Breakdown (reading).
- Live at `/cenapro/qc` and `/cenapro/qc/breakdown`. `cenapro.analysis_sample` +
  `cenapro_ccc_sample_groups` / `_analysis_daily` / `_analysis_monthly` (all aggregation in
  SQL, `scope` = `all` | `ex_dvo`). 500 real sheet samples backfilled.
- Editable weights (`cenapro_update_event_weight`, compare-and-set concurrency) and
  `cenapro.production_event_audit` — a trigger, so it catches both writers.
- Partner-draw entry (`cenapro_add_partner_draw`) + `app/(app)/cenapro/qc/add-draw-panel.tsx`.

### Cenapro production ledger
- Six-column multi-select filtering incl. CCC/FLEC (which had none). Endless scope filters
  **in SQL**, so paging is honest; focus scope filters client-side from the same state.
  Filters live in the URL. Unsaved rows are never hidden.

### ICTC production batch changeovers
- `ENDING` / `STARTING` in column H are now read as batch markers (column H is genuinely
  dual-purpose — it also holds `DAY SHIFT` / `OVERTIME`). Markers ⇒ Morning shift by
  Renzo's rule. Batch resolves from **running state**, never the calendar.
- June 30 repaired: JUNE 26,169 → 18,409, JULY's opening day gained 7,760. Day total unchanged.
- Human-edit guard on all six production fact tables (`fn_stamp_human_edit` trigger,
  `fn_release_production_rows`, `view_production_human_edited`).

### Digest
- Lag-aware KPI cards. `view_digest_stream_registry` / `_reported_days` / `_status`.
  Lateness = planned working days **strictly between** last report and today, excluding
  today and rest days. Production/Power now show their latest reported day instead of a
  permanent "Awaiting report".

---

## Critical learnings

1. **The recurring bug shape in this codebase is a detector nobody reads.** FLECON's
   balance cross-check, the `dropped_before_since` counter, `view_digest_stream_freshness`,
   the schedule's pending conflicts — all computed correctly and were discarded. When
   adding a check, wire its consumer in the same changeset.
2. **An error that hides its own message will be misdiagnosed for as long as it stays
   hidden.** `Error: Command failed` cost a day and produced an unnecessary OAuth migration.
   The real text was `NO [ALERT] Too many simultaneous connections`.
3. **Check tab *contents*, not just tab names.** I concluded "MC hasn't added August" from
   sheet names alone; the data was there in a mis-named tab. Renzo caught it.
4. **MC's workbook convention:** tab name = production day; the date printed inside = the
   morning it was written up. The gap is +1, or +2/+3 across rest days. Verified on
   `07-04-26` → JULY 6 and `07-17-26` → JULY 20.
5. **Cenapro batches and ICTC batches both straddle month boundaries** and are a strict
   unbroken monthly sequence. Never derive a batch from the calendar month.
6. **Partner draws from `FLEC` consume bagged stock** — 37% of them, and *every* kiln draw.
   An earlier claim of mine that partner draws don't touch bag inventory was wrong.
7. **Gmail's connection budget is shared with everything signed into that account.** Apple
   Notes syncs over IMAP and leaks connections. `lsof -nP -i TCP:993` diagnoses it in one second.

---

## Current state

- `main` = `db95d03`. Working tree clean apart from `.claude/agent-memory-local/**`.
- Worker deployed on Fly (`blackwood-sync`, healthy). Vercel deploys from `main`.
- Worker tests: **647 passing**, parity clean 12/12.
- August 1 production is in and correctly split (JULY 2,466 kg / AUGUST 11,830 kg).
- RC OUT was 5 days stale (last reading 2026-07-29); **Renzo believes this is now fixed** —
  verify at the start of next session.

---

## Renzo's answers on the open items (2026-08-03)

Asked to triage the remaining list, he responded:

| # | Item | His answer |
|---|---|---|
| 1 | Changeover-day downtime attribution | asked what it means — **needs explaining, then deciding** |
| 2 | BUG-018 `avg_cost` two definitions | asked what they are — **needs explaining, then deciding** |
| 3 | Dormant VALUE_CHANGED patch | **"fix it"** |
| 4 | Sync-side staleness alert | **"build a staleness alert"** |
| 5 | BUG-017 (UPDATE-branch trigger flaw) | **"go about fixing this"** |
| 6 | `public.cenapro_dimensions` view | asked what it means — **needs explaining** |
| 7 | QC ledger can't open an empty month | **"would be nice to be able to open whatever month or year even if there's no entries"** |
| 8 | Net Flow card | asked what it means — **needs explaining** |
| 9 | Python `fetch_gmail.py` on App Password | **"so this is outdated?"** — yes, legacy oracle path, dormant |
| 10 | RC OUT 5 days stale | **"i think its fixed now"** — verify |
| 11 | Ivy's A75 typo | **"no need to fret on this"** — closed, backfill is durable |
| 12 | First real QC add-draw insert | **"i will do this soon"** — his to do |

### Answers to the four he asked about

**1 — Changeover-day downtime.** On a day where one batch ends and another starts (Aug 1),
production splits across two batches, but downtime is recorded once for the whole shift with
no marker saying which batch it belongs to. The sync must pick one. It currently attaches
downtime to the batch that was **ending**, on the reasoning that an unmarked row follows the
running batch. The alternative is the new batch. Affects per-batch downtime reporting only.

**2 — BUG-018, the two `avg_cost` definitions.** `fn_update_blackwood_state` computes it two
different ways depending on which branch fires:

- **INSERT branch — perpetual moving average.**
  `((current_weight × avg_cost) + (added_weight × NEW.cost_basis)) / (current_weight + added_weight)`
  The prior side is weighted by `current_weight`, which is **net of rc_out**. So as charcoal
  is fed out, history's share shrinks and each new delivery weighs more heavily. This is the
  standard perpetual weighted-average-cost inventory method.
- **DELETE / UPDATE branches — delivery-weighted recompute.**
  `SUM(cost_basis × weight_kg) / SUM(weight_kg)` over that batch's deliveries.
  Ignores consumption entirely. Answers "what did this batch's charcoal cost per kg delivered."

They agree on a batch with no consumption and diverge as it is fed. **208 of 689 batches
currently disagree** depending on which branch last touched them. Both are legitimate
accounting answers to *different* questions — this is a business decision, not a bug fix.
The blocking-detail slide-over shows `avg_cost`, so whichever is chosen changes a visible ₱.

**6 — `public.cenapro_dimensions`.** The QC add-draw form needs dropdowns (sources,
machines, grades, shifts, warehouses). Those dimension tables live in the `cenapro` schema,
which PostgREST does not serve (`PGRST106: Invalid schema: cenapro`). So `loadQcDrawOptions()`
currently scans every row of `cenapro_production_events` for distinct codes and merges the
result over hardcoded constants in `app/(app)/cenapro/types.ts`. The merge is load-bearing:
the fact table alone is missing **C3, C4, 4X8 and WHSE 2** — options an operator could never
pick. A `security_invoker` UNION view in `public` would replace that with one ~30-row read,
drop the constants merge and the full-history scan, and give real display names plus a
truthful crusher/kiln split from `partner_equipment.kind` instead of guessing from the code shape.

**8 — Net Flow.** The card is RC In − RC Out. It currently reads 10,695 kg because RC In has
today's deliveries and RC Out hasn't reported, so it is really "everything in, nothing out"
rendered as a large positive. Same class of problem the Production card had before the
lag-aware fix; re-anchoring a two-stream derived balance is a design decision (which day do
you anchor to when the two streams report on different schedules), so it was left alone.

---

## Next concrete action

Work the four Renzo approved, in this order:

1. **Fix the dormant VALUE_CHANGED patch** (#3). `workers/sync/src/reports/production/apply.ts:498`
   reads `entry.new`; `classify.ts:161` emits `{ db, email }`. The patch is therefore always
   empty and production has **never** applied a sheet correction. The human-edit guard now
   sits underneath it, so switching the writer on is safe — but it turns on a five-section
   writer, so land it with tests and watch the first run.
2. **Build the sync-side staleness alert** (#4). `view_digest_stream_status.missed_working_days`
   already computes exactly the right number; make it a run finding so a quiet stream
   announces itself instead of waiting to be noticed.
3. **BUG-017** (#5) — the UPDATE branch of `fn_update_blackwood_state` is stale in both
   directions on a `batch_code` change (the old batch still sees the departing row, the new
   one can't see it yet). Needs the recompute moved to an AFTER trigger, or the NEW side to
   fold in the not-yet-visible row. Fix spec is in `docs/BUG_LEDGER.md`.
4. **Let the QC ledger open any month/year** (#7), including empty ones, so the first draw of
   a new month has somewhere to land. `resolveQcMonth` currently falls back to the newest
   month *with* data and the picker disables empty months. Shared with the breakdown page.

Then bring #1, #2, #6 and #8 back to Renzo with the explanations above and get decisions.

**First thing next session:** verify RC OUT is actually current again (`view_digest_stream_status`),
since he believes it self-resolved.
