# ICTC Sync — Rules Digest

**Read THIS digest top-to-bottom every run (cheap — one line per rule).** It is a compressed
index of `LEARNING_LEDGER.md`. Only open the **full** `LEARNING_LEDGER.md` entry for an `L-###`
when a row in front of you actually matches that rule's **symptom tag** — then apply the full
rule verbatim. The full ledger remains the append-only source of truth and the place corrections
get appended; this digest never replaces it, it just saves you from reading all 18 entries when
most don't apply.

> Match on the symptom tag. If nothing matches, you've done your ledger duty for the run — don't
> open the full file. If something matches, open ONLY that one entry and follow it exactly.

---

## Digest — newest first (one line per ledger entry)

- **L-018**  [gsheet apply]  The apply phase honors only top-level `"skip": true`, NOT `"decision":"skip"` — when holding a `changed` row set `"skip": true` (or remove it); for a small approved subset do the writes directly via Supabase MCP, never `--phase apply`. — *symptom: held/skip row got written by apply phase; data UPDATE landed before an audit 403 crash.*
- **L-017**  [gsheet rc_out]  A no-audit-history Sheet-wins WEIGHT change is NOT automatically authoritative — ALWAYS surface weight VALUE_CHANGED rows (date/batch/old→new/Δ) for Renzo; honor his per-row call (DB can be right, Sheet can hold a typo). — *symptom: a clean Sheet-wins weight diff (e.g. 3,692→3,962) with no audit history.*
- **L-016**  [production]  A day-sheet dated exactly `watermark+1` that is byte-identical to the prior already-ingested day is a DATE-RELABEL DUPLICATE — HOLD, never write; the electricity meter start/end repeating the prior day is the tell. — *symptom: "NEW" day whose run/electricity/truck/downtime equal the previous DB day; meter start = prior day's start.*
- **L-015**  [gsheet backfill]  An "is it set?" text column is unlabeled when NULL **or** `''` — backfill with `col IS NULL OR col = ''` (a bare `IS NULL` silently misses `''` rows); write the campaign label verbatim from the Sheet, never derive from date. — *symptom: production_batch (or similar) backfill; row count higher than the NULL-only count expected.*
- **L-014**  [production runs/downtime]  A classifier MALFORMED/null-shift run is RECOVERABLE when the day's downtime/waste/electricity share one shift — resolve to that shift and insert; ALWAYS split `dt_mins>=60` into `dt_hrs+=m//60, dt_mins=m%60`. — *symptom: blank SHIFT cell → null-shift run; or downtime `dt_mins` ≥ 60.*
- **L-013**  [gsheet]  Before a Sheet-wins UPDATE, check the row's `audit_logs` for a prior Renzo-approved correction the Sheet would revert — if found, FLAG (Sheet lags resolution), don't auto-apply; roll back if it already landed. — *symptom: a clean VALUE_CHANGED whose record_id has a prior dedup/reassignment audit moving it AWAY from the Sheet value.*
- **L-012**  [rc_out]  Resolving a double-counted feed (DELETE path): keep the row whose weight matches the sheet on the batch the sheet names, delete the other, set surviving row's block_loc/remarks to mirror the source feed — requires explicit approval (it's a DELETE). — *symptom: two DB rows double-count one operator feed; sheet is authoritative.*
- **L-011**  [rc_out]  Re-home a misattributed feed by the operator's FEEDING-AREA source row, not the closed batch it points at; a clean single-row reassign is OK, but a quantity conflict/duplicate → HOLD + flag, never DELETE/pick a winner unprompted. — *symptom: rc_out feed attributed to an already-CLOSED feed batch; balance goes sharply negative.*
- **L-010** (rc_out)  [rc_out]  A PROPOSED feed's derived batch_code can name a CLOSED batch at a DIFFERENT slot — remap to the ACTIVE occupant of that `block_loc`; HOLD + flag the remap, never auto-insert on the derived code. — *symptom: derived BLK code is CLOSED / lives at another slot while another batch is the live occupant of the row's block_loc.*
- **L-010** (deliveries)  [deliveries/enrich]  `enrich_prices.py` matches on truck-plate; an operator-vs-Czarina plate typo drops a real price to NULL — recover by `(date, supplier, sacks, weight_kg)`, set `cost_basis` manually, keep the operator's plate verbatim. — *symptom: a real RC IN row comes back `cost_basis=None` "unmatched" though Czarina priced it.*
- **L-009**  [gsheet apply / lib/db.py]  An apply-phase `403 permission denied for table audit_logs` is a KNOWN non-fatal grant gap — do NOT retry the script or re-insert the data row; verify the data row landed once, then finish audit writes via Supabase MCP. — *symptom: data row inserts, then script crashes on `audit_logs` PATCH/INSERT 403 (42501).*
- **L-008**  [deliveries/gsheet]  Every gsheet-sourced `deliveries` INSERT must set `cost_basis = 0` placeholder (column is NOT NULL; pricing is out of gsheet scope) and note in the audit that deliveries-manager must enrich it. — *symptom: gsheet RC IN insert rejected `23502 null value in cost_basis`.*
- **L-007**  [production runs]  `STARTING`/`ENDING` in a run row are BATCH-transition markers, not shifts — `ENDING`=last run of OLD batch, `STARTING`=first run of NEW batch (same date, two shifts parents); resolve shift from the day's other records. (Also: dt_mins≥60 split; waste is ONE row per shift — colliding second waste row → HOLD.) — *symptom: run row whose only "shift" text is STARTING/ENDING/blank → classifier null-shift.*
- **L-006**  [deliveries/rc_out]  NEVER `UPDATE batches SET current_weight = current_weight + delta` — the BEFORE-INSERT trigger already maintains it; a manual `+= delta` double-counts. Only legit write is `VALUES (...,0) ON CONFLICT DO NOTHING` for a brand-new batch; any reconcile must use the absolute `SUM(in)−SUM(out)` form. — *symptom: a batch's current_weight exceeds SUM(in)−SUM(out) by exactly its last delivery's weight.*
- **L-005**  [blocking/deliveries]  `current_weight` is untrusted — the canonical balance is ALWAYS `SUM(in) − SUM(out)`; the Sheet-vs-computed-balance blocking check is a standing audit step. — *symptom: view_blocking_grid balance disagrees with the Sheet / transaction sum.*
- **L-004**  [rc_in]  A "NEW" RC IN row matching an existing row on `(date, batch_code, weight_kg)` but a DIFFERENT `block_loc` is a block_loc correction, NOT a new delivery — HOLD + flag; if Sheet wins, UPDATE block_loc, don't INSERT. — *symptom: "NEW" RC IN insert rejected on cost_basis NOT NULL, and a same date+batch+weight row already exists at another block_loc.*
- **L-003**  [rc_out]  A no-BLOCK-DATE bare-integer section (e.g. `514`, `601`) is a CONTINUATION of the block above it — not its own feed; never emit it as an rc_out row, never add its weight to the daily total or the reconciliation gate. — *symptom: a bare-integer "section" with no block date and light pallet weights inflating the daily total / tripping a drift halt.*
- **L-002**  [rc_out]  "ANEAR PATHWAY" / PCA / PCB zone feeds are OVERFLOW SUNDRY batches — do NOT auto-derive a regular BLK code; HOLD + flag for Renzo to assign the SUNDRY batch (tell: derived BLK is CLOSED and its slot is occupied). — *symptom: feed whose location text is a pathway/overflow note deriving to a CLOSED BLK that trips the unique-active-batch-per-location index.*
- **L-001**  [deliveries]  `audit_logs` is trigger-written on a `deliveries` insert — UPDATE the trigger-created audit row's comment for provenance, never INSERT a second one; keep batch-insert and delivery-insert as separate statements. — *symptom: a manual `INSERT INTO audit_logs` after a delivery insert creates a duplicate audit row.*

---

*When the digest and your heuristics disagree, the ledger wins. When a row matches a symptom tag,
open that one `L-###` entry in `LEARNING_LEDGER.md` and follow it to the letter.*
