#!/usr/bin/env python3
"""
Shared, dependency-light DB helper for the ICTC sync employees.

Why this exists
---------------
The sync agents (gsheet-sync, deliveries-manager, rc-out-manager, production-manager,
rc-movement-auditor) historically pulled the FULL DB dump into the *LLM's* context via
the supabase MCP, then handed it to the Python classifier as `--db-rows-json`. That dump
(thousands of rows) is a major token-bloat source. This helper lets the *Python* layer
fetch DB rows itself over PostgREST with the service-role key, so the rows never touch the
agent's context window.

It also provides deterministic write-back helpers (insert / update / audit-log) so the
EXECUTE phase can write rows in batch from Python instead of the agent issuing one MCP
`execute_sql` per row.

Trust / safety
--------------
- Reads `.env.local` at the project root for NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
- Service-role key bypasses RLS — this helper is for trusted local sync only, never shipped
  to the browser. Keep it in `.claude/skills/sync-ictc/`.
- Only the `public` schema is exposed via PostgREST (the `cenapro` schema is NOT — irrelevant here).
- No psycopg / direct Postgres — pure `requests` against the auto-generated PostgREST API.

DB trigger facts replicated by the write helpers (see LEARNING_LEDGER L-001/L-005/L-006):
- `deliveries` has a BEFORE-INSERT trigger (`fn_update_blackwood_state`) that maintains
  `current_weight` AND an AFTER-insert audit trigger that writes its own `audit_logs` row.
  So: after inserting a delivery, do NOT touch current_weight, and do NOT INSERT a second
  audit row — UPDATE the trigger-written one for provenance.
- `rc_out` has NO audit trigger — its `audit_logs` row must be written manually.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

try:
    import requests
except ImportError:  # pragma: no cover
    raise SystemExit("requests not installed. Run: pip3 install requests")


# ---------------------------------------------------------------------------
# Config / env
# ---------------------------------------------------------------------------
def _find_project_root(start: Path | None = None) -> Path:
    """Walk up from this file until we find a dir containing .env.local."""
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / ".env.local").exists():
            return parent
    # Fallback: the known blackwood root.
    return Path.home() / "blackwood"


def load_env(project_root: Path | None = None) -> dict[str, str]:
    """Parse .env.local into a dict (no external dotenv dependency)."""
    root = project_root or _find_project_root()
    env_path = root / ".env.local"
    if not env_path.exists():
        raise FileNotFoundError(f".env.local not found at {env_path}")
    out: dict[str, str] = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


class DBClient:
    """Thin PostgREST client using the service-role key."""

    def __init__(self, project_root: Path | None = None):
        env = load_env(project_root)
        url = env.get("NEXT_PUBLIC_SUPABASE_URL")
        key = env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise RuntimeError(
                "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
            )
        self.base = url.rstrip("/") + "/rest/v1"
        self._key = key
        self._session = requests.Session()
        self._session.headers.update({
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        })

    # -- reads ---------------------------------------------------------------
    def read_rows(
        self,
        table: str,
        *,
        since_date: str | None = None,
        since_column: str = "transaction_date",
        columns: Iterable[str] | None = None,
        extra_filters: dict[str, str] | None = None,
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        """
        Fetch rows from `table`, optionally filtered to since_column >= since_date.
        Pages through PostgREST's Range header so large tables are fully retrieved
        without ever returning the dump to an LLM context.
        """
        params: dict[str, str] = {}
        if columns:
            params["select"] = ",".join(columns)
        else:
            params["select"] = "*"
        if since_date:
            params[since_column] = f"gte.{since_date}"
        if extra_filters:
            params.update(extra_filters)

        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            headers = {"Range-Unit": "items",
                       "Range": f"{offset}-{offset + page_size - 1}"}
            resp = self._session.get(f"{self.base}/{table}", params=params, headers=headers)
            if resp.status_code not in (200, 206):
                raise RuntimeError(f"read_rows {table} failed {resp.status_code}: {resp.text[:500]}")
            batch = resp.json()
            rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return rows

    def select_one(self, table: str, filters: dict[str, str], columns: str = "*") -> dict | None:
        params = {"select": columns, "limit": "1", **filters}
        resp = self._session.get(f"{self.base}/{table}", params=params)
        resp.raise_for_status()
        data = resp.json()
        return data[0] if data else None

    # -- writes --------------------------------------------------------------
    def insert(self, table: str, rows: list[dict[str, Any]], returning: str = "representation") -> list[dict]:
        """Insert one or many rows. Returns inserted rows (with ids) when returning='representation'."""
        if not rows:
            return []
        headers = {"Prefer": f"return={returning}"}
        resp = self._session.post(f"{self.base}/{table}", data=json.dumps(rows), headers=headers)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"insert {table} failed {resp.status_code}: {resp.text[:1000]}")
        return resp.json() if returning == "representation" else []

    def update(self, table: str, filters: dict[str, str], patch: dict[str, Any],
               returning: str = "representation") -> list[dict]:
        """UPDATE table SET patch WHERE filters. filters values are PostgREST ops e.g. {'id': 'eq.<uuid>'}."""
        headers = {"Prefer": f"return={returning}"}
        resp = self._session.patch(f"{self.base}/{table}", params=filters,
                                   data=json.dumps(patch), headers=headers)
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"update {table} failed {resp.status_code}: {resp.text[:1000]}")
        return resp.json() if (returning == "representation" and resp.text) else []

    # -- audit-log helpers ---------------------------------------------------
    def update_trigger_audit_provenance(self, table_name: str, record_id: str,
                                         comment: str, snapshot: dict | None = None) -> bool:
        """
        For tables whose INSERT fires an audit trigger (deliveries): UPDATE the
        trigger-written audit row's comment for provenance (L-001 — never INSERT a 2nd).
        Returns True if a row was updated.
        """
        patch: dict[str, Any] = {"comment": comment}
        if snapshot is not None:
            patch["snapshot"] = snapshot
        updated = self.update(
            "audit_logs",
            {"table_name": f"eq.{table_name}", "record_id": f"eq.{record_id}",
             "operation": "eq.INSERT"},
            patch,
        )
        return bool(updated)

    def insert_manual_audit(self, *, table_name: str, record_id: str, operation: str,
                            comment: str, diff: dict | None = None,
                            snapshot: dict | None = None) -> dict | None:
        """
        For tables with NO audit trigger (rc_out): INSERT the audit_logs row manually.
        """
        row: dict[str, Any] = {
            "table_name": table_name,
            "record_id": record_id,
            "operation": operation,
            "comment": comment,
        }
        if diff is not None:
            row["diff"] = diff
        if snapshot is not None:
            row["snapshot"] = snapshot
        out = self.insert("audit_logs", [row])
        return out[0] if out else None


# Convenience top-level helpers (so callers can do `from lib.db import read_rows`)
_default_client: DBClient | None = None


def client() -> DBClient:
    global _default_client
    if _default_client is None:
        _default_client = DBClient()
    return _default_client


def read_rows(table: str, **kwargs) -> list[dict[str, Any]]:
    return client().read_rows(table, **kwargs)


if __name__ == "__main__":
    # Smoke test: SELECT 1-equivalent — count deliveries since 2025 without dumping rows.
    import sys
    c = DBClient()
    try:
        d = c.read_rows("deliveries", since_date="2025-01-01", columns=["id"])
        o = c.read_rows("rc_out", since_date="2025-01-01", columns=["id"])
        print(json.dumps({"ok": True, "deliveries_2025plus": len(d), "rc_out_2025plus": len(o)}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
