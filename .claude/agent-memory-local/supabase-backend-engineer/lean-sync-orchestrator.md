---
name: lean-sync-orchestrator
description: Token-lean two-phase orchestrator pattern for ICTC sync employees — shared PostgREST db.py helper + compact decisions files; gsheet-sync done, others designed
metadata:
  type: project
---

# Lean Sync Orchestrator refactor (2026-06-02)

Refactored the ICTC sync pipeline to be token-lean. The sync employee agents used to pull the FULL DB dump (~218k tokens) AND the FULL classified JSON (~131k tokens) into the LLM context and re-read them every step. New pattern moves DB fetch + diff + write-back entirely into Python.

**Why:** runs were 90k–160k tokens / 5–10 min, almost all spent shuttling rows the LLM never looked at. The deterministic diff was already a Python script; the LLM is only needed for judgment on a handful of ambiguous rows + talking to Renzo.

**How to apply:** when touching any sync employee, build/extend its `sync_<x>.py` two-phase orchestrator on the shared helper — never reintroduce a full-dump-into-agent-context path.

## What shipped (gsheet-sync, DONE + proven read-only)

- `scripts/lib/db.py` — shared PostgREST helper (reads `.env.local`, service-role key, pure `requests`). `read_rows(table, since_date=, columns=)` pages via Range header; `insert`/`update`; `update_trigger_audit_provenance` (deliveries L-001 — UPDATE the trigger-written audit row, never INSERT a 2nd); `insert_manual_audit` (rc_out has NO audit trigger). **Reusable across all 5 employees.** Only `public` schema is PostgREST-exposed; `cenapro` is not.
- `scripts/sync_gsheet.py` — `--phase classify --mode rc_in|rc_out --since` (pulls Sheet, fetches DB itself, reuses extract_gsheet+classify_gsheet, writes full classified JSON for audit + compact `decisions_<mode>.json`, prints summary counts + path ONLY). `--phase apply --decisions <file>` (deterministic writes: RC IN insert sets cost_basis=0 per L-008, never touches current_weight per L-005/L-006, UPDATEs trigger audit row per L-001; RC OUT writes manual audit row; safety gates NEW>50 / conf<0.7; never deletes; flagged/unmapped reassignments NOT auto-executed — left for a reviewed single UPDATE).
- Updated `.claude/agents/gsheet-sync.md` PROPOSE/EXECUTE to use the orchestrator + a HARD context-discipline rule (never cat the DB dump or `*_classified.json`).
- `LEAN_SYNC_REFACTOR.md` — blueprint for the other 4 (deliveries-manager, rc-out-manager, production-manager 6 tables, rc-movement-auditor read-only). Build order: auditor → rc-out → deliveries (money) → production (most tables/FK order).

## Measured savings (idempotency re-run)

Agent-context payload **~349k tokens → ~1k tokens (>99%)**. Compact files: rc_in 2.7KB/114 lines, rc_out 1.6KB/72 lines, vs classified 186KB+336KB.

## Idempotency proof (read-only, no apply run)

After the 2026-06-02 live run, re-classify: RC IN 813 NOOP / 6 changed (truck_plate `MAR 2499→Mar-99`) / 0 NEW; RC OUT 1626 NOOP / 2 changed / 1 malformed (DEC-25-BLK7 zero weight) / 0 NEW / 0 flagged. The June-1 inserts now NOOP. FEB-25-BLK8 (2025-04-30) dropped from `flagged` to plain `changed` because the live run already resolved the MAY-26-FEED5 reassignment that caused the collision — that's the correct post-resolution steady state.

## Trigger contract (bake into every apply path)

- `deliveries`: BEFORE-INSERT trigger maintains current_weight + audit trigger writes the audit row → NEVER `current_weight += delta`; UPDATE the audit row for provenance.
- `rc_out` + production tables: no audit trigger → INSERT audit row manually.
- cost_basis is NOT NULL on deliveries → gsheet inserts use 0 placeholder (L-008); the ONE place cost_basis is genuinely written is deliveries-manager's Czarina enrichment.
