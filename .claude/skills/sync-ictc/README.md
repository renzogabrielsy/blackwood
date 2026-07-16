# sync-ictc skill

Pulls daily ICTC report emails from Gmail, extracts the rows, classifies them against existing Blackwood data, and writes the deltas to Supabase with audit trail. Bridges the trust boundary so the production Blackwood app never has to hold Gmail credentials.

```
.claude/skills/sync-ictc/
├── SKILL.md                          # Protocol the agent follows when invoked
├── README.md                         # This file
└── scripts/
    └── extract_rc_deliveries.py      # XLSX → JSON extractor for RC DELIVERIES
```

## Invocation

Once loaded, the agent triggers on these phrasings:
- *"sync ICTC"*
- *"sync today's emails"*
- *"process daily reports"*
- *"ingest the RC DELIVERIES from Gmail"*
- *"/sync-ictc"*

The agent walks Renzo through pre-flight checks → email fetch → extraction → classification → summary → confirmation → write → label-as-processed.

## Requirements

- **Gmail MCP server** connected in this Claude Code session (provides `search_threads`, `get_thread`, `label_thread` tools)
- **Supabase MCP server** connected (provides `execute_sql`)
- **Python 3** with **openpyxl** installed (`pip3 install openpyxl` — already present on most dev machines)

## How extraction works

`scripts/extract_rc_deliveries.py` reads an XLSX file, locates the header row (scans the first 15 rows for one containing both "DATE" and "WEIGHT" columns), maps each column to a canonical Blackwood field using a flexible alias list, then validates each data row against schema rules from `CLAUDE.md`:

| Field | Validation |
|---|---|
| `transaction_date` | Must parse to YYYY-MM-DD |
| `weight_kg` | 0 < x < 100,000 |
| `block_loc` | Regex `^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$` |
| `cost_basis` | 0 < x < 1000 PHP/kg |
| `lab_results.mc` | < 20% |
| `lab_results.ash` | < 10% |
| `lab_results.fc` | > 60% |
| `lab_results.bd_astm/jis` | 0.2 < x < 1.0 |

Confidence starts at 1.0, drops 0.15 per warning, floors at 0.0. Rows below 0.7 confidence get routed to `/review-queue` rather than auto-ingested.

## Adding a new report type (Phase 2)

When you're ready to ingest Daily Production, Waste, RC Movement, etc., here's the pattern:

### 1. Write a new extractor script

Copy `scripts/extract_rc_deliveries.py` to `scripts/extract_<report_type>.py`. Modify:
- `HEADER_ALIASES` — map the new report's column names to your target table's fields
- Validation thresholds — appropriate for the new domain
- Lab plausibility — replace or remove if not relevant

The output JSON shape stays the same:
```json
{
  "filename": "...",
  "rows": [ {payload + warnings + confidence}, ... ],
  "summary": { "total_rows": N, "extraction_warnings": [...], "overall_confidence": 0.0-1.0 }
}
```

### 2. Add to `SKILL.md`

Extend the skill protocol:
- Add a new section under "Step 2 — Search Gmail" for the new subject + sender filter
- Add a new branch under "Step 4 — Extract rows" pointing to the new script
- Add a new natural-key spec under "Step 5 — Classify each row" for the new target table

Example natural keys by report type:
| Report | Target table | Natural key |
|---|---|---|
| RC DELIVERIES | `deliveries` | (transaction_date, batch_code, block_loc, weight_kg) |
| RC MOVEMENT | `rc_out` | (transaction_date, batch_id, block_loc, weight_kg) |
| Daily Production | `production_runs` *(doesn't exist yet)* | (date, grade, shift) |
| Waste Production | `production_waste` *(doesn't exist yet)* | (date, shift, stream) |

### 3. Ensure target table exists

If you're ingesting into a table that doesn't exist yet, create it via a Supabase migration first (use the `supabase-backend-engineer` agent). The skill can only insert/update rows in tables that already have schemas.

## Idempotency

The skill labels every successfully-processed Gmail thread with `Blackwood-Processed`. The search query excludes that label (`-label:"Blackwood-Processed"`), so re-running the skill is safe — already-processed threads are skipped entirely, not re-classified.

If you ever need to re-process a thread (e.g., to test a fix), just remove the label manually in Gmail.

## Safety gates

Hard-coded in SKILL.md:

| Gate | Threshold | Action |
|---|---|---|
| NEW row count too high | > 50 in a single run | Abort, route to `/review-queue` for manual triage |
| Low extraction confidence | any row < 0.7 | Route those rows to `/review-queue`, ingest rest |
| Mid-batch DB write failure | any | Stop immediately. Do not label processed. Report partial state. |
| User declines confirmation | always | Stop. No writes. No labels. |

## When to graduate to in-app integration

This Claude Code-side approach is intentionally provisional. Bring Gmail integration into Blackwood proper when:

1. You want autopilot ingestion when away from your terminal
2. Multiple users need to trigger sync (Blackwood is currently single-user)
3. The extraction pipeline has been working flawlessly for 30+ days and you trust auto-commit

Path forward at that point: add an `/api/ingest` API route to Blackwood with bearer-token auth + wire either Composio MCP (hosted) or IMAP + App Password (sovereign) to it. The extraction + diff logic in `lib/jarvis/extractors/` + `lib/jarvis/diff-engine.ts` already exists from Phase A, so this becomes wiring rather than building.

## Related files in Blackwood

- `lib/jarvis/extractors/rc-deliveries.ts` — TypeScript equivalent of this Python extractor (used by the in-app `/review-queue` manual upload path)
- `lib/jarvis/diff-engine.ts` — TypeScript equivalent of this skill's natural-key classification logic
- `app/(app)/review-queue/` — manual-upload UI that does the same flow without Gmail (fallback when this skill isn't run)
- `AI_INGESTION_AGENT.md` — original design doc covering both this skill's approach AND the future in-app variant
- `handoffs/` — session history; the most recent handoff explains why we picked this architecture
