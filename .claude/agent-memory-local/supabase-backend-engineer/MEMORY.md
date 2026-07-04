# Supabase Backend Engineer Memory

> Index only — one line per entry. Detail lives in the linked topic files. Trigger/view BODIES are authoritative in `supabase/migrations/**`; re-read before editing.

## Durable references
- [Schema / triggers / RLS](schema-triggers-rls.md) — batch_status trigger semantics + priority, RLS `TO authenticated`+`(true)` convention, blocking constraints, PostgREST 1000-row cap, CLI/type-regen workflow. [[schema-triggers-rls]]
- [Price gating](price-gating.md) — `canViewPrices()` in lib/auth.ts is CANONICAL; null ₱ SERVER-SIDE before payload; Production is the only denied role. [[price-gating]]

## Python → TS sync migration (`workers/sync/**`)
- [M2 parity harness](sync-ts-parity-harness.md) — 2026-07-04: `npm run parity` golden-master gate; frozen `classifyCase` contract; 12 fixtures/6 types; oracle+canonicalizer (TS+Py mirror); PORTING_DECISIONS deviations. [[sync-ts-parity-harness]]
- [Flecon TS port (Wave 3 #1)](flecon-ts-port.md) — 2026-07-04: 3/3 parity; sets porter idiom (deps/runReport, classifyCase returns classifier result). MERGED-CELL trap: exceljs duplicates merged-header values vs openpyxl → local sheet.ts wrapper. [[flecon-ts-port]]
- [rc_out TS port (Wave 3 #2)](sync-ts-rc-out-port.md) — 2026-07-04: 2/2 parity, 0 deviations; TWO hard reconcile gates (P-vs-M, O-vs-M dup, strict >500/>50kg), L-019 sub-watermark FLAGGED, batch fallback resolution; classifyCase = classify_rc_out.py result dict. [[sync-ts-rc-out-port]]
- [deliveries TS port (Wave 3 #3)](sync-ts-deliveries-port.md) — 2026-07-04: 2/2 parity, 0 dev; the L-033 flagship. classify oracle = GUARD-LAYER output (parity_guards.py); summary keeps RAW pre-guard counts; dup_noop natural_key STRING needs pyFloat ".0"; local sheet.ts (merged-cell + activeTab); L-033a/b + L-004 + low-conf guard order. [[sync-ts-deliveries-port]]
- [gsheet TS port (Wave 3 #4)](sync-ts-gsheet-port.md) — 2026-07-04: 2/2 parity; classifyCase returns COMBINED {rc_in,rc_out} dual-mode (oracle runs both regardless of opts.mode). All 3 gsheet deviations (PD-2/3/4) are APPLY-phase → DORMANT at classify (registered→shows STALE, still exits clean). Local deductions.ts (scope fence), no merge wrapper needed (0 merged cells). Write-tool null-byte trap. [[sync-ts-gsheet-port]]

## Sync orchestrators (ICTC ingestion, `.claude/skills/sync-ictc/**`)
- [Progress events + Gmail retry](sync-progress-and-gmail-retry.md) — 2026-07-03: `oc.progress()` streams `##SYNC_PROGRESS` on stderr (stdout stays pure JSON) + Gmail transient-EOF retry/jitter across all 6 orchestrators. [[sync-progress-and-gmail-retry]]
- [Run Sync orchestrators](sync-orchestrators.md) — 2026-07-03: 5 two-phase orchestrators + `write_ingestion_audit` RPC (L-009 fix), SYNC_CLI_CONTRACT, ingestion_watermarks. [[sync-orchestrators]]
- [Lean sync orchestrator](lean-sync-orchestrator.md) — 2026-06-02: token-lean two-phase Python (sync_gsheet.py + lib/db.py); agent reads compact decisions JSON only. [[lean-sync-orchestrator]]

## Data-layer views & actions
- [Closed Blocks view](rc-out-closed-blocks.md) — 2026-06-29: `view_rc_out_closed_blocks`, 1 row/CLOSED block, 440 rows, price = deliveries weighted-avg. [[rc-out-closed-blocks]]
- [deliveries true-weight/deduction cols](deliveries-true-weight-deduction.md) — 2026-06-25: additive display-only NULLABLE `true_weight_kg`+`deduction_note`; nothing computational uses them. [[deliveries-true-weight-deduction]]
- [Blend Proposal RPC](blend-proposal.md) — 2026-06-19: `fn_blend_proposal(text[])` balance-weighted blend over view_blocking_grid. [[blend-proposal]]
- [Delivery reprocessing exclusion](delivery-sundried-exclusion.md) — 2026-06-16: canonical sundried+refeed+recook exclusion on 4 Summaries views; kept = 1,508 rows/28,926,630.10 kg. [[delivery-sundried-exclusion]]
- [By-Supplier analytics](delivery-supplier-analytics.md) — 2026-06-16: 3 supplier-grain views + `canonical_supplier(text)` IMMUTABLE helper (combo/typo merges). [[delivery-supplier-analytics]]
- [Monthly delivery analytics](delivery-monthly-analytics.md) — 2026-06-15: 2 views (year/month + year), price over cost_basis>0 only (L-008). [[delivery-monthly-analytics]]
- [RC Movement campaign re-key](rc-movement-campaign.md) — 2026-06-09: 8 views keyed by (production_batch, campaign_year); production data only Dec-2025+. [[rc-movement-campaign]]
- [RC Movement production+yield](rc-movement-production-yield.md) — 2026-06-09: 4 views connecting fed→produced by grade. [[rc-movement-production-yield]]
- [RC Movement fed price](rc-movement-fed-price.md) — 2026-06-09: 3 weighted-avg fed-price views from deliveries.cost_basis; batches.avg_cost is STALE, compute from deliveries. [[rc-movement-fed-price]]
- [Daily Sync Digest backend](digest-backend.md) — 2026-06-04: 12 `view_digest_*` views + lib/digest/queries.ts; operationalDate lags calendar. [[digest-backend]]

## Tenants & modules
- [Cenapro schema (Tenant #2)](cenapro-schema.md) — 2026-06-01: isolated `cenapro` schema walled from ICTC; 3 thin public `cenapro_*` accessors expose it; write path via auto-updatable view. [[cenapro-schema]]
- [Blocking phantom-inventory fix](blocking-current-weight-drift.md) — 2026-05-31: balance = SUM(deliveries)−SUM(rc_out); root cause was imperative `+=` on top of trigger, not the trigger. [[blocking-current-weight-drift]]
- [Production module schema](production-module-schema.md) — 2026-05-28: production_shifts parent + runs/downtime/waste FK-children via shift_id; 3 views. [[production-module-schema]]
- [Jarvis ingestion pipeline](jarvis-ingestion-pipeline.md) — 2026-05-27: ingestion_watermarks table, RC deliveries extractor/classifier/review queue. [[jarvis-ingestion-pipeline]]
- [Jarvis foundation](jarvis-foundation.md) — 2026-05-26: 4 jarvis tables; Anthropic SDK needs TextBlockParam/ToolUseBlockParam for stored history. [[jarvis-foundation]]

## Security work
- [Phase 0 security fixes](phase0-security.md) — 2026-07-03: SEC-1 digest price series, SEC-2 jarvis tool-handlers price null, SEC-3 server-side delete role gate. [[phase0-security]]
