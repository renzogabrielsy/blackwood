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
import os
import random
import subprocess
import sys
import time
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
# Curated progress events (the in-app "Run Sync" panel streams these live)
# ---------------------------------------------------------------------------
# FROZEN CONTRACT (see SYNC_CLI_CONTRACT.md → "Progress events"): one line on
# STDERR per event, flushed, sentinel-prefixed. stdout stays PURE machine JSON.
#   ##SYNC_PROGRESS {"stage":"fetch|extract|classify|apply|reconcile|finalize",
#                    "pct":<0-100 int>,"label":"<plain-English>",
#                    "detail":"<optional>","level":"info|warn"}
# Labels are written for a plant manager, NEVER echoed terminal lines or tracebacks.
PROGRESS_SENTINEL = "##SYNC_PROGRESS "
_PROGRESS_STAGES = {"fetch", "extract", "classify", "apply", "reconcile", "finalize"}

# monotonic guard — pct never goes backwards within a single process run.
_LAST_PCT = 0


def progress(
    stage: str,
    label: str,
    pct: int,
    detail: str | None = None,
    level: str = "info",
) -> None:
    """
    Emit ONE curated progress event on stderr (sentinel-prefixed compact JSON).

    stage  — one of fetch|extract|classify|apply|reconcile|finalize.
    label  — plain-English current activity ("Checking Gmail for new reports…").
    pct    — 0-100 int; clamped and forced monotonically nondecreasing per process.
    detail — optional specifics (may be omitted).
    level  — "info" | "warn".

    stdout is untouched — this only ever writes to stderr.
    """
    global _LAST_PCT
    try:
        p = int(round(pct))
    except (TypeError, ValueError):
        p = _LAST_PCT
    p = max(0, min(100, p))
    if p < _LAST_PCT:
        p = _LAST_PCT
    _LAST_PCT = p

    st = stage if stage in _PROGRESS_STAGES else "classify"
    lvl = level if level in ("info", "warn") else "info"
    payload: dict[str, Any] = {"stage": st, "pct": p, "label": str(label), "level": lvl}
    if detail:
        payload["detail"] = str(detail)
    print(PROGRESS_SENTINEL + json.dumps(payload, separators=(",", ":"), default=str),
          file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# DB error classification
# ---------------------------------------------------------------------------
def is_location_collision(exc: Exception) -> bool:
    """
    True when a batch INSERT was rejected because the block_loc already holds an
    active (non-CLOSED) batch — Postgres unique-violation 23505 on
    idx_unique_active_batch_per_location. This is a DATA conflict for a human to
    resolve (close the prior batch or fix the location), NOT a bug: the orchestrator
    routes the row to `held` instead of hard-erroring the whole run
    ("1 block_loc = 1 active batch" — CLAUDE.md Blocking rules).
    """
    s = str(exc)
    return "23505" in s and (
        "idx_unique_active_batch_per_location" in s or "location_ref" in s
    )


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


# ---------------------------------------------------------------------------
# Gmail transient-fault handling
# ---------------------------------------------------------------------------
# When 4 orchestrators hit Gmail IMAP simultaneously, Gmail drops burst connections
# with an EOF / socket error / abort. That is TRANSIENT — a retry a couple seconds
# later almost always succeeds. A clean rc=0 that fails to PARSE is NOT transient
# (the child ran fine but produced bad JSON) and must surface immediately.
_TRANSIENT_MARKERS = (
    "socket error",
    "eof",
    "abort",
    "timed out",
    "timeout",
    "connection reset",
    "broken pipe",
    "child produced no stdout",
)

# Backoff schedule between attempts (3 attempts total → 2 sleeps): ~2s then ~6s,
# each with a little jitter so parallel modules don't re-collide in lockstep.
_GMAIL_BACKOFFS = (2.0, 6.0)

# One-time per-process startup jitter so 4 parallel modules stop knocking on Gmail
# in the same instant. Seeded off pid → deterministic within a process, spread across.
_gmail_jitter_done = False


def _looks_transient(text: str) -> bool:
    t = (text or "").lower()
    return any(m in t for m in _TRANSIENT_MARKERS)


def _gmail_startup_jitter() -> None:
    """Sleep a small pid-seeded amount (0–2.5s) before the FIRST Gmail fetch per process."""
    global _gmail_jitter_done
    if _gmail_jitter_done:
        return
    _gmail_jitter_done = True
    delay = random.Random(os.getpid()).uniform(0.0, 2.5)
    if delay > 0:
        log(f"[gmail] startup jitter {delay:.2f}s (de-sync parallel modules)")
        time.sleep(delay)


def _run_json_gmail(cmd: list[str], *, what: str, attempts: int = 3) -> dict:
    """
    Run a Gmail child (fetch/mark-processed) with transient-fault retries.

    Retries the WHOLE child invocation up to `attempts` times (default 3) on transient
    classes only — nonzero rc, empty stdout, or stderr/exc text containing a transient
    marker (socket error / EOF / abort / timed out). A clean rc=0 JSON-parse failure is
    raised immediately (not transient). Each retry emits a 'warn' progress event.
    """
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        log(f"[run] {' '.join(cmd)}")
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.stderr:
            log(proc.stderr.rstrip())
        out = proc.stdout.strip()

        if proc.returncode == 0 and out:
            # rc=0 with output → parse; a parse failure here is NOT transient, surface it.
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                for line in reversed(out.splitlines()):
                    line = line.strip()
                    if line.startswith("{"):
                        return json.loads(line)
                raise

        # Reached here => failure. Transient iff rc!=0/no-stdout AND markers match, OR
        # empty stdout (Gmail child died before printing its JSON — the observed EOF case).
        combined = f"rc={proc.returncode} {proc.stderr or ''} {out or ''}"
        transient = (not out) or _looks_transient(combined)
        last_exc = RuntimeError(
            f"{what} failed (rc={proc.returncode}, no_stdout={not out}): "
            f"{(proc.stderr or out or '').strip()[:400]}"
        )
        if not transient or attempt >= attempts:
            raise last_exc

        wait = _GMAIL_BACKOFFS[min(attempt - 1, len(_GMAIL_BACKOFFS) - 1)]
        wait += random.uniform(0.0, 1.0)  # jitter each retry
        progress("fetch", f"Gmail dropped the connection — retrying (attempt {attempt + 1} of {attempts})…",
                 pct=_LAST_PCT, detail=f"{what}; waiting {wait:.1f}s", level="warn")
        log(f"[gmail] transient fault on {what} (attempt {attempt}/{attempts}); retrying in {wait:.1f}s")
        time.sleep(wait)

    # unreachable, but keeps type checkers content
    raise last_exc if last_exc else RuntimeError(f"{what} failed with no captured error")


def fetch_gmail(query: str, out_dir: Path, *, limit: int = 50) -> dict:
    """
    Fetch matching emails' attachments. Returns fetch_gmail.py's result dict.

    Resilient to transient Gmail IMAP faults (EOF / socket error / abort) that happen
    when several orchestrators query Gmail at once: the child invocation is retried up
    to 3 times with exponential backoff, and each process applies a one-time startup
    jitter before its FIRST fetch to de-sync parallel modules.
    """
    _gmail_startup_jitter()
    return _run_json_gmail([
        "python3", FETCH_GMAIL,
        "--query", query,
        "--output-dir", str(out_dir),
        "--limit", str(limit),
    ], what="Gmail fetch")


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
    res = _run_json_gmail([
        "python3", FETCH_GMAIL,
        "--mark-processed",
        "--uids", ",".join(uids),
    ], what="Gmail mark-processed")
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
