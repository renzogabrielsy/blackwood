#!/usr/bin/env python3
"""
Shared plumbing for the lean two-phase sync orchestrators
(sync_deliveries.py / sync_rc_out.py / sync_production.py / sync_flecon.py /
audit_rc_movement.py).

This is the machinery every orchestrator repeats: computing the data watermark,
fetching Gmail attachments, running a child script deterministically, emitting the
EXACT CLI JSON contract on stdout (see SYNC_CLI_CONTRACT.md), adopting the
`ingestion_watermarks` table, and gating the Gmail label so a partial apply never
marks a thread processed.

Contract discipline (HARD):
  * stdout is machine JSON ONLY — exactly one object per invocation.
  * ALL human-readable logging goes to stderr via `log()`.
  * classify emits the "classify envelope"; apply emits the "apply envelope".

Nothing here re-implements a diff rule — the codified mechanical rules live in the
existing extract_*/classify_* scripts; the orchestrators only wire them together
and TRUST them (emitting `codified_rules_applied`).
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCRIPTS_DIR = Path(__file__).resolve().parent.parent   # .../scripts
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(SCRIPTS_DIR / "lib"))

from lib.db import DBClient  # noqa: E402

RUN_TS = datetime.now(timezone.utc).isoformat()
PROCESSED_LABEL = "Blackwood-Processed"
FETCH_GMAIL = str(SCRIPTS_DIR / "fetch_gmail.py")


# ---------------------------------------------------------------------------
# stderr logging (stdout stays pure machine JSON)
# ---------------------------------------------------------------------------
def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    """Print the single machine-JSON object to stdout."""
    print(json.dumps(obj, indent=2, default=str))


# ---------------------------------------------------------------------------
# work dir
# ---------------------------------------------------------------------------
def make_work_dir(report_type: str, work_dir: str | None) -> Path:
    if work_dir:
        p = Path(work_dir)
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        p = Path(f"/tmp/sync-{report_type}/{ts}")
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------
# watermarks
# ---------------------------------------------------------------------------
def data_watermark(db: DBClient, table: str, date_column: str = "transaction_date") -> str | None:
    """
    The REAL watermark = MAX(<date_column>). Unchanged behavior (SYNC_EFFICIENCY_AUDIT
    §4). Returns 'YYYY-MM-DD' or None when the table is empty.
    """
    rows = db.read_rows(
        table,
        columns=[date_column],
        since_column=None,
        extra_filters={"order": f"{date_column}.desc", "limit": "1"},
    )
    if not rows:
        return None
    val = rows[0].get(date_column)
    return str(val)[:10] if val else None


def upsert_ingestion_watermark(
    db: DBClient,
    report_type: str,
    *,
    last_email_id: str | None = None,
    last_email_received_at: str | None = None,
) -> bool:
    """
    Adopt the previously-dead `ingestion_watermarks` table (SYNC_EFFICIENCY_AUDIT
    §5A(1)). Upsert one row per report_type recording run provenance. This is
    additive run bookkeeping — the DATA watermark used for scoping remains
    MAX(transaction_date); this table is where the button records *that a run
    happened*. Best-effort: a failure here never fails the apply (returns False).
    """
    row = {
        "report_type": report_type,
        "last_run_at": RUN_TS,
    }
    if last_email_id is not None:
        row["last_email_id"] = last_email_id
    if last_email_received_at is not None:
        row["last_email_received_at"] = last_email_received_at
    try:
        db._session.post(
            f"{db.base}/ingestion_watermarks",
            params={"on_conflict": "report_type"},
            data=json.dumps(row),
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"[warn] ingestion_watermarks upsert failed (non-fatal): {exc}")
        return False


# ---------------------------------------------------------------------------
# Gmail
# ---------------------------------------------------------------------------
def run_json(cmd: list[str]) -> dict:
    """Run a child script, parse its stdout JSON. stderr is streamed to our stderr."""
    log(f"[run] {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stderr:
        log(proc.stderr.rstrip())
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"child produced no stdout: {' '.join(cmd)} (rc={proc.returncode})")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # some children print a human line before the JSON; take the last JSON object.
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)
        raise


def fetch_gmail(query: str, out_dir: Path, *, limit: int = 50) -> dict:
    """Fetch matching emails' attachments. Returns fetch_gmail.py's result dict."""
    return run_json([
        "python3", FETCH_GMAIL,
        "--query", query,
        "--output-dir", str(out_dir),
        "--limit", str(limit),
    ])


def latest_xlsx(fetch_result: dict) -> tuple[str | None, dict | None]:
    """
    From a fetch_gmail result, pick the LATEST email that carries an xlsx attachment
    (emails are UID-sorted ascending, newest last). Returns (path, email_meta) or
    (None, None) when nothing matched. Deterministic — no model needed (audit item #2).
    """
    for em in reversed(fetch_result.get("emails", [])):
        for att in em.get("attachments", []):
            p = att.get("path")
            if p and p.lower().endswith((".xlsx", ".xls")):
                return p, em
    return None, None


def mark_processed(uids: Iterable[str]) -> bool:
    """
    Apply the Blackwood-Processed label to the given UIDs. Call this ONLY when the
    apply had zero errors and zero unapplied non-held rows (SKILL.md:347 discipline).
    """
    uids = [u for u in uids if u]
    if not uids:
        return False
    res = run_json([
        "python3", FETCH_GMAIL,
        "--mark-processed",
        "--uids", ",".join(uids),
    ])
    return bool(res.get("ok"))


# ---------------------------------------------------------------------------
# CLI-contract envelopes (see SYNC_CLI_CONTRACT.md)
# ---------------------------------------------------------------------------
def classify_envelope(
    *,
    report_type: str,
    ok: bool,
    gate_failures: list[dict],
    counts: dict,
    rows_preview: list[dict],
    classified_path: str,
    source: dict,
    watermark: str | None,
    codified_rules_applied: list[str],
    extra: dict | None = None,
) -> dict:
    env = {
        "report_type": report_type,
        "ok": ok,
        "gate_failures": gate_failures,
        "counts": {
            "noop": counts.get("noop", 0),
            "insert": counts.get("insert", 0),
            "update": counts.get("update", 0),
            "flagged": counts.get("flagged", 0),
        },
        "rows_preview": rows_preview[:20],
        "classified_path": classified_path,
        "source": source,
        "watermark": watermark,
        "codified_rules_applied": codified_rules_applied,
    }
    if extra:
        env.update(extra)
    return env


def apply_envelope(
    *,
    report_type: str,
    ok: bool,
    inserts: int = 0,
    updates: int = 0,
    replaced_dates: int = 0,
    held: list[dict] | None = None,
    labeled: bool = False,
    watermark_updated: bool = False,
    errors: list[str] | None = None,
    extra: dict | None = None,
) -> dict:
    env = {
        "report_type": report_type,
        "ok": ok,
        "applied": {
            "inserts": inserts,
            "updates": updates,
            "replaced_dates": replaced_dates,
        },
        "held": held or [],
        "labeled": labeled,
        "watermark_updated": watermark_updated,
        "errors": errors or [],
    }
    if extra:
        env.update(extra)
    return env
