# AI Ingestion Agent — Design

> **Purpose.** Eliminate the manual Excel copy-paste workflow by having an AI agent parse daily reports from Gmail, propose structured inserts into the local Flask app, and let Renzo review/approve in seconds rather than minutes.
>
> **Status:** Architectural design — no code yet. Builds in Phase 8 of `FLASK_PORT_PLAN.md`.
> **Generated:** 2026-05-26
> **Companion to:** `FLASK_PORT_PLAN.md` (overall Flask architecture); the AI agent is one component of the local Flask app.

---

## 1. Why this exists

Today, every day, the same painful loop runs:

1. Five operators (Ivy, Pretchel, MC, Angelica, Gino) send daily Excel reports to Gmail
2. Renzo opens each attachment, manually copies rows, pastes them into `MASTER - ICTC INPUT FILE V1.xlsx`
3. Hopes formulas don't break, hopes nothing was missed
4. Joseph reviews from his own separate Excel; their numbers occasionally disagree

**Time cost:** ~30–60 minutes/day of copy-paste, plus 15–30 minutes/week reconciling discrepancies.
**Error rate:** several typo/transposition errors per week that propagate into KPI dashboards.
**Cognitive load:** the part of the day Renzo dreads most.

The AI agent automates the parsing step (~99% of the manual work) and turns Renzo's role from data-entry-clerk into reviewer/decision-maker.

---

## 2. Operational reality (input side)

These are the reports flowing into Gmail label `Work/ICTC Daily` today (cross-referenced from the earlier audit):

| Report subject | Sender | Frequency | Attachment | Destination in local DB |
|---|---|---|---|---|
| Daily Production Report | mccontinedo.ictc@gmail.com | Daily | `Daily Production Report 2026 2Q.xlsx` | `production_runs`, `production_downtime` |
| WASTE PRODUCTION REPORT | edilloivymae306ictc@gmail.com | Daily | `WASTE PRODUCTION REPORT 2026.xlsx` | `production_waste` (7 streams) |
| RC DELIVERIES | pretchel.jao@yahoo.com (or Ivy) | Daily when there are deliveries | `RC DELIVERIES 2026.xlsx` + PDF | `deliveries` (+ `batches` upsert) |
| RC MOVEMENT | edilloivymae306ictc@gmail.com (or Pretchel) | Daily | `RAW CHARCOAL MOVEMENT 2026.xlsx` | `rc_out` (the consumption rows) |
| FLECON BAGGED | edilloivymae306ictc@gmail.com | Daily | `FLECON BAG MOVEMENT 2026.xlsx` | `flecon_bag_movement` |
| BAGGED POWDER | edilloivymae306ictc@gmail.com / Pretchel | Daily | small Excel | `flecon_bag_movement` (powder category) |
| Bagged 6x50 (QC) | angelicagustilo26.ictc@gmail.com | Daily | `Bagged 6x50.xlsx` | `qc_results` (per-lot ash %) |
| Prepared Charcoal 3x50 (QC) | angelicagustilo26.ictc@gmail.com | Daily | similar | `qc_results` |
| PROPOSED DAILY REPORT | edilloivymae306ictc@gmail.com / Pretchel | New consolidated report under iteration | `PROPOSED DAILY REPORT MAY 2026.xlsx` | TBD — Joseph still reviewing structure |
| Daily Maintenance | ginomichael_go@yahoo.com | Daily | Image attachments | `maintenance_log` (notes + photo refs) |
| ABSENTEE | lyzashannepogio@yahoo.com | Daily | Text/PDF | **Out of scope** for v1 (HR has separate tracking) |
| Banking (Czarina) | czarinaloumaximoictc@gmail.com | Daily | Banking files | **Out of scope** for v1 (accounting separate) |

The agent handles the first 9. Maintenance images are saved as references but not parsed in v1. Absentee + banking are explicitly out of scope.

---

## 3. Architecture overview

```
┌───────────────────────────────────────────────────────────┐
│  Gmail (Work/ICTC Daily label)                            │
└──────────────────┬────────────────────────────────────────┘
                   │ Gmail API poll every 5 min
                   │ (or webhook via Gmail Push)
                   ▼
┌───────────────────────────────────────────────────────────┐
│  ingestion_agent  (Python module in local Flask)          │
│  ───────────────────────────────────────────────────────  │
│  1. Discover new threads since last_check_at              │
│  2. Classify by (subject pattern, sender)                 │
│  3. Download .xlsx attachment to local tmp                │
│  4. Parse with template specific to the report type       │
│  5. (Fallback) ambiguous rows → Claude API with schema    │
│  6. Validate extracted rows (date in body, weights        │
│     plausible, batch_codes exist in batches table)        │
│  7. Append to pending_review table with confidence + diag │
└──────────────────┬────────────────────────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────────────────────────┐
│  pending_review  (SQLite table in local Flask)            │
│  ───────────────────────────────────────────────────────  │
│  Row per proposed insert with: source_email_id,           │
│  report_type, confidence, extracted_rows JSON,            │
│  warnings JSON, status='pending'                          │
└──────────────────┬────────────────────────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────────────────────────┐
│  Review UI  (React component in local Flask app)          │
│  ───────────────────────────────────────────────────────  │
│  • Inbox of pending reports, newest first                 │
│  • Side-by-side: extracted rows ↔ original attachment     │
│  • Inline edit any field; approve / reject / mark needs-  │
│    manual                                                  │
│  • Confidence-tagged rows highlighted in amber/red        │
│  • One-click approve commits to canonical tables          │
└──────────────────┬────────────────────────────────────────┘
                   │ on approve
                   ▼
┌───────────────────────────────────────────────────────────┐
│  Canonical tables (deliveries, rc_out, production_runs…)  │
│  ───────────────────────────────────────────────────────  │
│  Standard service-layer write → audit log → outbox        │
│  → push to hosted Postgres (per FLASK_PORT_PLAN §8)       │
└───────────────────────────────────────────────────────────┘
```

---

## 4. Per-report-type extraction templates

Each report type has a dedicated extractor module. The extractor knows the report's expected structure (columns, sheet name, value ranges, date format) and produces a typed list of proposed rows.

### Template structure

```python
# ingestion/extractors/base.py
from abc import ABC, abstractmethod
from typing import TypedDict

class ExtractedRow(TypedDict):
    payload: dict          # the data to insert
    confidence: float      # 0.0 to 1.0
    warnings: list[str]    # human-readable diagnostics

class ReportExtractor(ABC):
    report_type: str

    @abstractmethod
    def matches(self, email_meta: EmailMeta) -> bool:
        """Return True if this extractor should handle the given email."""

    @abstractmethod
    def extract(self, attachment_bytes: bytes, email_meta: EmailMeta) -> list[ExtractedRow]:
        """Parse the attachment, return proposed rows with confidence + warnings."""

    @abstractmethod
    def target_table(self) -> str:
        """Which canonical table these rows insert into."""
```

### Example — Daily Production Report extractor

```python
# ingestion/extractors/daily_production.py

class DailyProductionExtractor(ReportExtractor):
    report_type = 'daily_production'

    def matches(self, meta):
        return (
            meta.subject.strip().lower() == 'daily production report'
            and meta.sender == 'mccontinedo.ictc@gmail.com'
        )

    def target_table(self):
        return 'production_runs'

    def extract(self, attachment_bytes, meta):
        wb = load_workbook(BytesIO(attachment_bytes), data_only=True)
        ws = wb.active

        # Locate the rows by scanning for a date column header
        header_row = self._find_header_row(ws)
        date_col = self._find_column(ws, header_row, 'DATE')
        grade_col = self._find_column(ws, header_row, 'GRADE')
        shift_col = self._find_column(ws, header_row, 'SHIFT')
        ttl_kg_col = self._find_column(ws, header_row, 'TTL KG')

        # Extract email-stated date from subject/body for cross-validation
        stated_date = self._parse_date_from_body(meta.body_text)

        rows = []
        for r in range(header_row + 1, ws.max_row + 1):
            date_val = ws.cell(r, date_col).value
            if not isinstance(date_val, datetime):
                continue

            warnings = []
            if date_val.date() != stated_date:
                warnings.append(f'Date mismatch: row says {date_val.date()}, email body says {stated_date}')

            grade = ws.cell(r, grade_col).value
            shift = ws.cell(r, shift_col).value
            ttl_kg = ws.cell(r, ttl_kg_col).value

            if grade not in ('3X50', '6X50', '2X6', '8X50'):
                warnings.append(f'Unknown grade: {grade}')
            if not (0 < ttl_kg < 100_000):
                warnings.append(f'Implausible TTL KG: {ttl_kg}')

            confidence = 1.0 - 0.2 * len(warnings)

            rows.append(ExtractedRow(
                payload={
                    'date': date_val.date().isoformat(),
                    'grade': grade,
                    'shift': shift,
                    'ttl_kg': float(ttl_kg),
                },
                confidence=max(0.0, confidence),
                warnings=warnings,
            ))

        return rows
```

Every report type gets a similar extractor. The patterns are:
- **Match function** decides whether this extractor applies (subject + sender)
- **Extract function** opens the .xlsx, finds known columns, validates, scores confidence
- **Confidence** drops with each warning; rows below 0.7 surface as red in the review UI

### Extractors needed (Phase 8 build list)

1. `DailyProductionExtractor` — PROD output rows (date, grade, shift, ttl_kg)
2. `WasteProductionExtractor` — 7 waste streams per (date, shift)
3. `RcDeliveriesExtractor` — receipts with supplier, batch_code, block_loc, weight, lab metrics, ₱/kg
4. `RcMovementExtractor` — rc_out consumption rows (date, batch, block, weight)
5. `FleconBaggedExtractor` — bag movement (grade, count, destination)
6. `BaggedPowderExtractor` — powder bag movement variant
7. `QcBagged6x50Extractor` — per-lot ash% (from email body, no attachment needed for some)
8. `QcPreparedCharcoal3x50Extractor` — same shape, different grade
9. `DailyMaintenanceExtractor` — store images as attachment refs, parse subject for date; no row extraction

### Fallback for ambiguous rows — Claude API

When the deterministic extractor encounters something unexpected (e.g. a new column, a typo, an unfamiliar batch code), it can call the Claude API as a fallback for that specific row:

```python
def extract_with_llm_fallback(self, raw_row: dict, schema: dict) -> dict:
    response = anthropic.messages.create(
        model='claude-sonnet-4-6',
        max_tokens=1024,
        messages=[{
            'role': 'user',
            'content': f"""Extract structured data from this row of a daily production report.

Raw row data:
{json.dumps(raw_row)}

Expected schema:
{json.dumps(schema)}

Return ONLY a JSON object matching the schema. If you can't extract a field,
use null and note the issue in a `_warnings` array.
"""
        }],
    )
    return json.loads(response.content[0].text)
```

The LLM fallback is **expensive and slow** (200ms + ~$0.005/call) — so it's only invoked when the deterministic parser fails on a row. For a typical day with ~100 rows across all reports, we'd expect ~5–10 LLM calls = ~$0.05/day = **<$2/month**.

---

## 5. The `pending_review` schema

```sql
CREATE TABLE pending_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_email_id TEXT NOT NULL,         -- Gmail thread/message ID for traceback
    source_attachment_id TEXT,             -- Gmail attachment ID
    source_filename TEXT,                  -- e.g. "Daily Production Report 2026 2Q.xlsx"
    report_type TEXT NOT NULL,             -- 'daily_production', 'rc_deliveries', etc.
    received_at TEXT NOT NULL,             -- when the email arrived
    extracted_at TEXT NOT NULL,            -- when the agent processed it
    rows_json TEXT NOT NULL,               -- JSON array of ExtractedRow
    overall_confidence REAL NOT NULL,      -- min(row.confidence) across rows
    diagnostic_json TEXT,                  -- agent's notes: what it did, what it skipped
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'manual_needed'
    reviewed_at TEXT,
    reviewed_by TEXT,
    final_rows_json TEXT,                  -- the actual JSON committed (may differ from extracted if Renzo edited)
    commit_audit_log_id INTEGER            -- pointer to the audit_log entry when approved
);

CREATE INDEX ix_pending_review_status ON pending_review(status);
CREATE INDEX ix_pending_review_received_at ON pending_review(received_at DESC);
```

The same Gmail message can produce multiple `pending_review` rows if it has multiple attachments or report types. The agent is idempotent — if it sees a `source_email_id` already in the table, it skips.

---

## 6. The Review UI

New route in the local Flask app: `/review-queue`. UI layout:

```
┌─ REVIEW QUEUE ───────────────────────────────────────────────────────────────────┐
│  [ All pending (12) ] [ Today only ] [ Last 7 days ]                             │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ ⚠ Daily Production Report — May 25, 2026  (3 rows, conf 0.84)           │  │
│  │ From: MC Continedo · Received 2 hours ago                                │  │
│  │ ┌─────────────────────────────────────────┐ ┌─────────────────────────┐ │  │
│  │ │ Extracted Rows                          │ │ Original Attachment     │ │  │
│  │ │ ─────────────────────────────────────── │ │ (rendered preview of    │ │  │
│  │ │ Date     Grade Shift  TTL KG            │ │  the Excel file)        │ │  │
│  │ │ ───────────────────────────             │ │                         │ │  │
│  │ │ 05-25    3X50  M      19,266    ✓      │ │                         │ │  │
│  │ │ 05-25    6X50  M      8,800     ✓      │ │                         │ │  │
│  │ │ 05-25    8X50  M      450       ⚠      │ │                         │ │  │
│  │ │           Warning: unusually low TTL    │ │                         │ │  │
│  │ │           (avg for grade is 6,000+)     │ │                         │ │  │
│  │ │                                          │ │                         │ │  │
│  │ │ [ Edit row ] [ Drop this row ]          │ │                         │ │  │
│  │ └─────────────────────────────────────────┘ └─────────────────────────┘ │  │
│  │                                                                          │  │
│  │ [ ✓ Approve & Commit ] [ ✗ Reject ] [ ⚙ Needs manual entry ]            │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ ● Bagged 6x50 — May 25, 2026  (6 rows, conf 0.95)                       │  │
│  │ From: Angelica Gustilo · Received 1 hour ago                             │  │
│  │ ...                                                                       │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key interactions:
- **Confidence indicator** — green dot ≥0.9, amber 0.7–0.9, red <0.7
- **Per-row warnings** — yellow triangle, click to expand
- **Inline edit** — fix typos before approving
- **Drop a row** — exclude one row from a multi-row report (useful for partial corruption)
- **Approve & Commit** — one click writes all rows to canonical tables, sets status='approved', moves to history
- **Reject** — discards entirely; status='rejected'
- **Needs manual** — sidelines for later when Renzo wants to do it by hand

Notifications: a small badge on the navbar shows the count of pending reviews. Optional: desktop notification when a new report arrives.

---

## 7. Validation rules (the agent's smarts)

Beyond just parsing, the agent runs cross-checks to catch the kinds of errors that slip through manual entry today:

| Rule | What it catches | How |
|---|---|---|
| **Date sanity** | Typo'd date or wrong attachment | Email body says "production for May 23"; attachment dates say "May 22" → warning |
| **Batch code exists** | Typo'd batch_code in RC OUT row | Cross-reference against `batches` table; if no match, warn |
| **Weight plausibility** | Decimal misplacement (e.g. 100,000 instead of 10,000) | Per-grade historical range; >3σ → warning |
| **Lab values in range** | Bad lab reading entry | MC < 20%, ASH < 10%, FC > 70% etc. — physically plausible ranges per coconut shell charcoal |
| **Supplier known** | Misspelled supplier | Match against existing `deliveries.supplier` distinct values; fuzzy match below 0.85 → warning |
| **Block_loc format** | Typo'd location | Regex `^[A-D]-\d{1,2}[A-D]$`; reject if doesn't match |
| **Daily totals sanity** | Missing rows from a multi-shift day | Sum of extracted TTL KG ≪ usual daily — warn "possibly missing shift?" |
| **No duplicate insert** | Re-sending same email | Check (date, batch_code, weight) combination already in target table → reject as duplicate |

These rules live in `ingestion/validators.py` and run after extraction. Each rule that fires lowers confidence by 0.1–0.3 and adds a warning.

---

## 8. Operational flow — end-to-end day

```
07:30  Ivy sends WASTE PRODUCTION REPORT
07:32  Gmail webhook fires (or next poll catches it)
07:32  Agent discovers new email, classifies as waste_production
07:33  Downloads attachment, extracts 6 rows (one per waste stream)
07:33  Validates: all weights in range, date matches subject
07:33  Confidence 0.98 — appends to pending_review with status=pending
07:33  Navbar badge increments to 1

08:00  MC sends Daily Production Report
08:01  Agent processes — 3 rows extracted, but one row has ttl_kg=450 (unusually low)
08:01  Confidence 0.84, warning: "unusually low TTL"

09:00  Renzo opens /review-queue
09:00  Reviews waste report — looks good, clicks Approve
09:00  6 rows commit to production_waste, audit logs entry, outbox queues 6 INSERT events
09:00  Push runner sends them to hosted within ~1 s
09:01  Reviews production report — sees the low ttl_kg, opens original attachment in side panel
09:01  Confirms it's correct (operator started late that shift)
09:01  Approves; all 3 rows commit
...

12:00  Daily summary: 9 reports processed, 8 approved, 1 still pending (PROPOSED DAILY REPORT — Renzo unsure if it's locked in)
12:00  Total time spent reviewing: ~4 minutes
```

Compare to today's flow: ~45 minutes of copy-paste, with 0 cross-validation, 0 audit trail of who entered what, and frequent typos.

---

## 9. Tech stack choices

| Component | Choice | Why |
|---|---|---|
| LLM provider | **Anthropic Claude** (Sonnet 4.5 via API) | Strong at structured extraction; long context for whole-spreadsheet parsing; Renzo is already familiar with the Anthropic ecosystem |
| LLM SDK | `anthropic` Python package | First-party SDK |
| Structured outputs | Tool-use schema / JSON mode | Forces valid JSON, eliminates parsing failure modes |
| Gmail integration | `google-api-python-client` + service account, **OR** OAuth user creds | Service account is cleaner but requires Google Workspace admin; OAuth user creds works for personal Gmail |
| Excel parsing | `openpyxl` + `pandas` | Already used in the project; same dependency set |
| Image parsing (maintenance reports) | Claude vision API | Lightweight; only for maintenance images |
| Queue runner | Simple Python thread + APScheduler (or just `threading.Timer`) | Don't need Celery/RQ for one user one machine |
| Storage of attachments | Local filesystem at `~/.blackwood/attachments/<message_id>/` | Easy backup, no cloud cost |

---

## 10. Cost estimate

Per day operating cost at full volume:

- 9 reports per day × ~5 LLM calls per report (fallback only, mostly deterministic parsing) = ~45 API calls
- Sonnet 4.5 pricing ~$3 input / $15 output per 1M tokens
- Average call: ~2K input + ~500 output tokens = $0.006 + $0.0075 = **~$0.014 per call**
- Daily cost: **~$0.65**
- Monthly cost: **~$20/month**

Add Gmail API (free under personal use limits) and hosted Flask infrastructure (~$10–25/mo per FLASK_PORT_PLAN.md).

**Total operating cost: ~$30–45/month** for the whole system.

For comparison, Renzo's time at ~$15/hour × 45 min/day × 22 days/month = **~$250/month of time saved**. ROI break-even is <2 days.

---

## 11. Phasing (within Phase 8 of FLASK_PORT_PLAN.md)

Sub-phases over ~5–7 working days:

1. **Day 1:** Gmail OAuth + label polling + email metadata extraction. End: log new emails to console.
2. **Day 2:** `pending_review` table + review UI skeleton. End: manually inserted rows render in the UI.
3. **Day 3:** First extractor (Daily Production Report — simplest format) + classifier. End: emails auto-create pending_review rows.
4. **Day 4:** Three more extractors (Waste, RC Deliveries, RC Movement). End: 4 of 9 report types working.
5. **Day 5:** Remaining extractors (FB, BaggedPowder, QC reports). End: all 9 report types working.
6. **Day 6:** Validation rule engine (all 8 rules from Section 7). Confidence scoring tuned. End: bad data caught and warned.
7. **Day 7:** LLM fallback for ambiguous rows. End-to-end test against the last 2 weeks of real Gmail data.

**Definition of done for Phase 8:** Renzo can open `/review-queue` in the morning, see all reports from the previous day pre-extracted, approve them in under 5 minutes total, and have the data flow correctly through to the hosted dashboard within seconds.

---

## 12. Open design questions

1. **Auto-commit threshold.** Should very-high-confidence reports (>0.98, all validation rules pass) auto-commit without Renzo's review, with him only seeing them in an "auto-committed" log? Or should every report always require explicit approval in v1? **Recommended: always require approval in v1.** Auto-commit threshold can be tuned in once trust is established (probably after 30 days of zero corrections).

2. **What if the agent misses an email?** Mitigation: a daily "morning summary" view that shows which expected reports arrived and which didn't. If MC hasn't sent today's production report by 10am, the UI flags it. This becomes a passive monitoring layer.

3. **What about email replies and corrections?** Sometimes Joseph replies to a report asking for clarification, and the operator re-sends an updated attachment. The agent needs to handle this: detect that thread is a continuation, prefer the latest attachment, mark the earlier one as superseded.

4. **PROPOSED DAILY REPORT.** This is a new consolidated report Ivy is iterating on with Joseph. The agent should NOT auto-parse it until its structure stabilizes. Once it stabilizes, build an extractor; until then, route it to `manual_needed` automatically.

5. **Photo-based maintenance reports.** Should the agent OCR Gino's images of equipment status? Probably yes, eventually — Claude's vision API can extract handwriting and gauge readings. v1 can skip this and just store the images as references; v2 adds vision extraction.

6. **Multi-language support.** Some emails mix Bisaya/Cebuano with English ("midyu umog po ang iyang abug" = "the dust is somewhat damp"). The deterministic parsers don't care; the LLM fallback handles this fine. No special handling needed.

---

## 13. Why this is the right move

In one sentence: **the AI ingestion agent transforms Renzo's role from data-entry operator (low-leverage, error-prone, soul-crushing) into data steward (high-leverage, exception-handling, decision-making).**

This is exactly the kind of work LLMs are best at — structured extraction with human-in-the-loop verification. It's the highest-ROI feature in the entire Flask port plan. Without it, the local Flask app is just a fancier spreadsheet. With it, the system is genuinely more capable than what exists today, and Renzo's daily workflow becomes 10× faster.

Build it.
