# Porting Decisions — Binding Rulings for All Wave-3 Porters

_2026-07-04, orchestrator rulings on the ambiguities the spec pass flagged. These are BINDING for the TS port. Governing principle: **classify-parity is bug-for-bug against the Python oracle; crash bugs and DB-constraint violations get fixed with a documented deviation.** Renzo may veto any of these; until then they stand._

| # | Ambiguity (see specs for detail) | Ruling | Why |
|---|---|---|---|
| 1 | `_lab_diff_is_immaterial` code contradicts its own docstring (`mc 11.5 vs 11` is MATERIAL in code) | **Port the CODE behavior** (material). Fix only the comment. Parity = what the oracle *does*, not what it *says*. | Golden-master discipline; changing materiality silently changes what gets auto-written. |
| 2 | `sync_gsheet._apply_from_compact` returns bare int `1` on the >50-NEW / confidence gates → caller crash under the contract CLI | **Fix properly in TS** (return a real gate-failure envelope; nothing applied). This is a live crash bug, not behavior. | A port that faithfully crashes is not parity. DEVIATION-LOGGED. |
| 3 | L-018 gap is live: gsheet apply honors only `skip`, never `decision`, on changed rows (once corrupted a real row) | **Fix in TS**: honor `decision` per the ledger's intent. DEVIATION-LOGGED; parity harness must carry an explicit expected-difference entry for this case. | The ledger rule is the contract; the Python never caught up. Porting the corruption path forward is indefensible. |
| 4 | gsheet RC IN extractor computes `true_weight_kg`/`deduction_note` but apply never writes them (email pipeline does) | **TS writes them** (align to the email pipeline + L-021 intent). DEVIATION-LOGGED. | Two pipelines writing different column sets for the same row type is the bug, not the feature. |
| 5 | `dt_mins >= 60` split documented in ledger but never implemented → DB CHECK violation on any ≥60-min downtime day | **Implement the split in TS** (hrs += mins//60, mins %= 60). DEVIATION-LOGGED. | Latent crash against a DB constraint; the ledger already defines the correct behavior. |
| 6 | `norm_int` diverges between pipelines (truncate in classify_deliveries vs round in classify_gsheet) | **Preserve each pipeline's own behavior** — port both variants as-is, named `normIntTruncate` / `normIntRound`, used exactly where the Python used each. Unification is post-M6 work. | Parity first; silent unification would shift natural-key matching. |
| 7 | Judgment L-rules (L-002/003/010/011/012/013/024) — codify or keep human? | **Keep human-adjudicated** (FLAGGED → held). Do NOT codify in this migration. | Matches the held-row philosophy and the migration's no-feature-additions scope. |
| 8 | L-009/L-032 audit RPC workaround — replicate or re-architect? | **Replicate as-is** (`write_ingestion_audit` / `stamp_ingestion_audit` via db.ts). They are live, verified, locked down. | Not this migration's problem to redesign. |

## Deviation log discipline
Rulings #2–#5 make the TS intentionally differ from the oracle. The parity harness (Wave 2) must model these as **expected differences** (a small `expected-deviations.json` keyed by rule id + case), so parity stays a hard gate everywhere else. Any parity diff NOT covered by that file is a porter bug, full stop.

## Also binding (from the plan, restated for porters)
- All rounding through `norm.ts` (round-half-to-even); `Math.round` is lint-banned.
- Fetch queries, thresholds, natural keys: VERBATIM from the specs — no "improvements."
- Held-row philosophy unchanged: uncertain → held, never auto-written.
