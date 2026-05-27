#!/usr/bin/env python3
"""
Fetch ICTC daily report emails from Gmail via IMAP using a Gmail App Password.

Reads credentials from ~/.config/sync-ictc/credentials.env (mode 600).
Uses Gmail's IMAP extensions:
  - X-GM-RAW for Gmail-syntax search queries (label:, after:, etc.)
  - X-GM-LABELS for marking threads processed (idempotency)
  - X-GM-THRID for thread-level operations

Outputs JSON manifest to stdout with downloaded attachment paths + metadata.

Usage:
    # Fetch new RC DELIVERIES emails since a date
    python3 fetch_gmail.py \\
        --query 'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:2026/05/18 -label:"Blackwood-Processed"' \\
        --output-dir /tmp/ictc-sync/$(date -u +%Y%m%dT%H%M%SZ) \\
        --attachment-pattern '*.xlsx'

    # Mark threads as processed after successful ingestion
    python3 fetch_gmail.py --mark-processed --thread-ids '<id1>,<id2>,<id3>'

    # List available Gmail labels (useful for setup / debugging)
    python3 fetch_gmail.py --list-folders

Exit codes:
    0 = success
    1 = credentials missing / IMAP login failed
    2 = IMAP folder selection failed
    3 = no matching emails (with --no-match-error this is also 0)
"""

from __future__ import annotations

import argparse
import email
import email.utils
import fnmatch
import imaplib
import json
import os
import re
import sys
from datetime import datetime
from email.header import decode_header, make_header
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
DEFAULT_CREDENTIALS_PATH = Path("~/.config/sync-ictc/credentials.env").expanduser()
PROCESSED_LABEL = "Blackwood-Processed"

# Cap raw IMAP fetch size to avoid pulling enormous threads accidentally.
MAX_BYTES_PER_MESSAGE = 50 * 1024 * 1024  # 50 MB


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
def load_credentials(path: Path) -> tuple[str, str]:
    """Load GMAIL_USER and GMAIL_APP_PASSWORD from a dotenv-style file."""
    if not path.exists():
        sys.stderr.write(
            json.dumps(
                {
                    "error": (
                        f"Credentials not found at {path}. Create it with:\n"
                        f"  mkdir -p {path.parent} && chmod 700 {path.parent}\n"
                        f'  printf "GMAIL_USER=you@gmail.com\\nGMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx\\n" > {path}\n'
                        f"  chmod 600 {path}"
                    )
                }
            )
            + "\n"
        )
        sys.exit(1)

    # Enforce 0600 permissions — refuse to run if world/group readable.
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        sys.stderr.write(
            json.dumps(
                {
                    "error": (
                        f"Credentials file {path} has unsafe permissions {oct(mode)}. "
                        f"Run: chmod 600 {path}"
                    )
                }
            )
            + "\n"
        )
        sys.exit(1)

    creds: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip().strip('"').strip("'")

    user = creds.get("GMAIL_USER")
    password = creds.get("GMAIL_APP_PASSWORD")
    if not user or not password:
        sys.stderr.write(
            json.dumps(
                {
                    "error": (
                        f"{path} must contain both GMAIL_USER and GMAIL_APP_PASSWORD. "
                        f"Got: {sorted(creds.keys())}"
                    )
                }
            )
            + "\n"
        )
        sys.exit(1)

    return user, password


# ---------------------------------------------------------------------------
# IMAP helpers
# ---------------------------------------------------------------------------
def imap_login(user: str, password: str) -> imaplib.IMAP4_SSL:
    """Connect to Gmail IMAP and authenticate. Returns the live connection."""
    try:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        # App Password authentication is plain user+password over TLS
        imap.login(user, password)
    except imaplib.IMAP4.error as e:
        sys.stderr.write(
            json.dumps(
                {
                    "error": f"IMAP login failed: {e}",
                    "hint": (
                        "Common causes: (1) App Password wrong/revoked, "
                        "(2) 2FA not enabled, (3) account locked. "
                        "Generate a fresh App Password at https://myaccount.google.com/apppasswords"
                    ),
                }
            )
            + "\n"
        )
        sys.exit(1)
    return imap


def select_folder(imap: imaplib.IMAP4_SSL, folder: str, readonly: bool = True) -> int:
    """SELECT a Gmail label/folder. Returns the message count."""
    # Gmail labels with slashes work as IMAP folder paths.
    # The IMAP wire format requires quoting if the folder name has spaces.
    typ, data = imap.select(f'"{folder}"', readonly=readonly)
    if typ != "OK":
        sys.stderr.write(
            json.dumps(
                {
                    "error": f'Could not select folder "{folder}". IMAP said: {data!r}',
                    "hint": (
                        "Use --list-folders to see available folders. "
                        "Gmail labels with spaces or slashes must be quoted exactly as shown."
                    ),
                }
            )
            + "\n"
        )
        sys.exit(2)
    try:
        return int(data[0])
    except (ValueError, TypeError, IndexError):
        return 0


def list_folders(imap: imaplib.IMAP4_SSL) -> list[str]:
    """Return all available Gmail labels as folder names."""
    typ, data = imap.list()
    if typ != "OK":
        return []
    out: list[str] = []
    for raw in data:
        if raw is None:
            continue
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        # Format: '(\\HasNoChildren) "/" "Folder Name"'
        m = re.match(r'^\([^)]*\)\s+"[^"]*"\s+"?([^"]*)"?\s*$', text.strip())
        if m:
            out.append(m.group(1))
    return out


def gm_raw_search(imap: imaplib.IMAP4_SSL, gmail_query: str) -> list[bytes]:
    """
    Run a Gmail-syntax search via the X-GM-RAW extension. Returns message UIDs.

    Gmail-syntax means the same operators you use in Gmail's web search box:
    label:, subject:, from:, after:, has:attachment, newer_than:, etc.
    """
    # X-GM-RAW takes a quoted Gmail query string. Escape any embedded quotes.
    escaped = gmail_query.replace("\\", "\\\\").replace('"', '\\"')
    typ, data = imap.uid("SEARCH", "X-GM-RAW", f'"{escaped}"')
    if typ != "OK":
        return []
    if not data or not data[0]:
        return []
    return data[0].split()


def decode_mime_header(raw: Any) -> str:
    """Decode an RFC 2047 encoded header to plain str."""
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return str(raw)


def fetch_thread_id(imap: imaplib.IMAP4_SSL, uid: bytes) -> str | None:
    """Get Gmail thread ID for a UID via X-GM-THRID extension."""
    typ, data = imap.uid("FETCH", uid, "(X-GM-THRID)")
    if typ != "OK" or not data or not data[0]:
        return None
    # Response format: b'1 (UID 123 X-GM-THRID 1813091820832029634)'
    text = data[0].decode("utf-8", errors="replace") if isinstance(data[0], bytes) else str(data[0])
    m = re.search(r"X-GM-THRID\s+(\d+)", text)
    return m.group(1) if m else None


def fetch_email_size(imap: imaplib.IMAP4_SSL, uid: bytes) -> int:
    """Get RFC822.SIZE for a UID without downloading the body."""
    typ, data = imap.uid("FETCH", uid, "(RFC822.SIZE)")
    if typ != "OK" or not data or not data[0]:
        return 0
    text = data[0].decode("utf-8", errors="replace") if isinstance(data[0], bytes) else str(data[0])
    m = re.search(r"RFC822\.SIZE\s+(\d+)", text)
    return int(m.group(1)) if m else 0


def fetch_email_body(imap: imaplib.IMAP4_SSL, uid: bytes) -> bytes | None:
    """Download the full RFC822 body for a UID."""
    typ, data = imap.uid("FETCH", uid, "(RFC822)")
    if typ != "OK" or not data or not data[0]:
        return None
    body_part = data[0]
    if not isinstance(body_part, tuple) or len(body_part) < 2:
        return None
    payload = body_part[1]
    if not isinstance(payload, (bytes, bytearray)):
        return None
    return bytes(payload)


def add_label_to_thread(imap: imaplib.IMAP4_SSL, uid: bytes, label: str) -> bool:
    """Apply a Gmail label to the THREAD containing this UID."""
    # The UID STORE with +X-GM-LABELS adds the label to this specific message.
    # In Gmail's IMAP, labels are thread-scoped — applying to one message in a
    # thread effectively labels the whole thread for search purposes.
    escaped = label.replace("\\", "\\\\").replace('"', '\\"')
    typ, _ = imap.uid("STORE", uid, "+X-GM-LABELS", f'"{escaped}"')
    return typ == "OK"


# ---------------------------------------------------------------------------
# Attachment extraction
# ---------------------------------------------------------------------------
def safe_filename(name: str) -> str:
    """Strip path separators and dangerous chars from an attachment name."""
    # Take the basename only, then replace anything but printable safe chars
    base = os.path.basename(name)
    cleaned = re.sub(r"[^A-Za-z0-9 ._\-]", "_", base).strip()
    if not cleaned:
        cleaned = "attachment"
    # Limit length to prevent insane filenames
    if len(cleaned) > 200:
        root, ext = os.path.splitext(cleaned)
        cleaned = root[: 200 - len(ext)] + ext
    return cleaned


def extract_attachments(
    msg: email.message.Message,
    output_dir: Path,
    uid: bytes,
    patterns: list[str],
) -> list[dict[str, Any]]:
    """
    Walk MIME parts, save attachments matching any pattern to output_dir.
    Returns list of {filename, path, size, mime_type, content_id}.
    """
    saved: list[dict[str, Any]] = []
    uid_str = uid.decode() if isinstance(uid, bytes) else str(uid)

    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        # Skip inline content unless it has a filename
        disposition = part.get("Content-Disposition") or ""
        raw_filename = part.get_filename()
        if not raw_filename:
            continue

        filename = decode_mime_header(raw_filename)
        if not any(fnmatch.fnmatch(filename.lower(), p.lower()) for p in patterns):
            continue

        payload = part.get_payload(decode=True)
        if not payload:
            continue

        clean_name = safe_filename(filename)
        # Prefix with UID so files from different emails don't collide
        target = output_dir / f"{uid_str}_{clean_name}"
        target.write_bytes(payload)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass

        saved.append(
            {
                "filename": filename,
                "path": str(target),
                "size_bytes": len(payload),
                "mime_type": part.get_content_type(),
                "is_inline": "inline" in disposition.lower(),
            }
        )

    return saved


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def cmd_fetch(args: argparse.Namespace) -> int:
    creds_path = Path(args.credentials_path).expanduser()
    user, password = load_credentials(creds_path)

    output_dir = Path(args.output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    patterns = [p.strip() for p in (args.attachment_pattern or "*.xlsx,*.xls").split(",")]
    patterns = [p for p in patterns if p]

    imap = imap_login(user, password)
    try:
        # "[Gmail]/All Mail" lets us search across all labels via X-GM-RAW
        # without needing to know the exact folder. Falls back to user-specified folder.
        select_folder(imap, args.folder, readonly=False)

        uids = gm_raw_search(imap, args.query)

        if not uids:
            sys.stdout.write(
                json.dumps(
                    {
                        "ok": True,
                        "folder": args.folder,
                        "query": args.query,
                        "email_count": 0,
                        "emails": [],
                        "output_dir": str(output_dir),
                        "message": "No matching emails found.",
                    },
                    indent=2,
                )
                + "\n"
            )
            return 0

        # Limit results — sort by UID (rough proxy for chronological order, newest at end)
        uids_sorted = sorted(uids, key=lambda b: int(b))
        if args.limit and len(uids_sorted) > args.limit:
            uids_sorted = uids_sorted[-args.limit :]

        emails_out: list[dict[str, Any]] = []
        for uid in uids_sorted:
            size = fetch_email_size(imap, uid)
            if size > MAX_BYTES_PER_MESSAGE:
                emails_out.append(
                    {
                        "uid": uid.decode(),
                        "skipped": True,
                        "reason": f"message size {size} exceeds cap {MAX_BYTES_PER_MESSAGE}",
                    }
                )
                continue

            raw = fetch_email_body(imap, uid)
            if raw is None:
                emails_out.append(
                    {
                        "uid": uid.decode(),
                        "skipped": True,
                        "reason": "could not fetch RFC822 body",
                    }
                )
                continue

            msg = email.message_from_bytes(raw)
            attachments = extract_attachments(msg, output_dir, uid, patterns)
            thread_id = fetch_thread_id(imap, uid)

            emails_out.append(
                {
                    "uid": uid.decode(),
                    "thread_id": thread_id,
                    "subject": decode_mime_header(msg.get("Subject")),
                    "sender": decode_mime_header(msg.get("From")),
                    "date": decode_mime_header(msg.get("Date")),
                    "size_bytes": size,
                    "attachments": attachments,
                }
            )

        result = {
            "ok": True,
            "folder": args.folder,
            "query": args.query,
            "email_count": len(emails_out),
            "output_dir": str(output_dir),
            "emails": emails_out,
        }
        sys.stdout.write(json.dumps(result, indent=2, default=str) + "\n")
        return 0

    finally:
        try:
            imap.logout()
        except Exception:
            pass


def cmd_mark_processed(args: argparse.Namespace) -> int:
    """Apply the Blackwood-Processed label to UIDs after successful ingestion."""
    creds_path = Path(args.credentials_path).expanduser()
    user, password = load_credentials(creds_path)

    uids_raw = [u.strip() for u in args.uids.split(",") if u.strip()]
    if not uids_raw:
        sys.stderr.write(json.dumps({"error": "No UIDs supplied to --uids"}) + "\n")
        return 1

    imap = imap_login(user, password)
    try:
        select_folder(imap, args.folder, readonly=False)
        results: list[dict[str, Any]] = []
        for uid_str in uids_raw:
            uid = uid_str.encode()
            ok = add_label_to_thread(imap, uid, PROCESSED_LABEL)
            results.append({"uid": uid_str, "labeled": ok})
        sys.stdout.write(
            json.dumps({"ok": True, "label": PROCESSED_LABEL, "results": results}, indent=2) + "\n"
        )
        return 0
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def cmd_list_folders(args: argparse.Namespace) -> int:
    creds_path = Path(args.credentials_path).expanduser()
    user, password = load_credentials(creds_path)
    imap = imap_login(user, password)
    try:
        folders = list_folders(imap)
        sys.stdout.write(json.dumps({"ok": True, "folders": folders}, indent=2) + "\n")
        return 0
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch ICTC daily reports from Gmail via IMAP."
    )
    parser.add_argument(
        "--credentials-path",
        default=str(DEFAULT_CREDENTIALS_PATH),
        help=f"Path to credentials.env (default: {DEFAULT_CREDENTIALS_PATH})",
    )
    parser.add_argument(
        "--folder",
        default="[Gmail]/All Mail",
        help='IMAP folder to SELECT before searching. Default: "[Gmail]/All Mail" '
        "(searches all labels via X-GM-RAW). Use --list-folders to enumerate.",
    )

    sub = parser.add_subparsers(dest="action", required=False)

    # Default action is "fetch" — flatten args into top-level for convenience
    parser.add_argument(
        "--query",
        help='Gmail-syntax search query (X-GM-RAW). E.g. label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:2026/05/18 -label:"Blackwood-Processed"',
    )
    parser.add_argument(
        "--output-dir",
        help="Directory to save attachments. Created if missing.",
    )
    parser.add_argument(
        "--attachment-pattern",
        default="*.xlsx,*.xls",
        help='Comma-separated glob patterns. Default: "*.xlsx,*.xls"',
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Max emails to process (default: 50).",
    )

    # Mark-processed mode
    parser.add_argument(
        "--mark-processed",
        action="store_true",
        help="Mode: apply Blackwood-Processed label to UIDs from --uids.",
    )
    parser.add_argument(
        "--uids",
        help="Comma-separated UIDs to label (used with --mark-processed).",
    )

    # List-folders mode
    parser.add_argument(
        "--list-folders",
        action="store_true",
        help="Mode: list all Gmail labels as IMAP folder names and exit.",
    )

    args = parser.parse_args()

    if args.list_folders:
        return cmd_list_folders(args)

    if args.mark_processed:
        if not args.uids:
            sys.stderr.write(json.dumps({"error": "--mark-processed requires --uids"}) + "\n")
            return 1
        return cmd_mark_processed(args)

    # Default: fetch
    if not args.query or not args.output_dir:
        sys.stderr.write(
            json.dumps(
                {
                    "error": "Fetch mode requires --query and --output-dir",
                    "example": (
                        'python3 fetch_gmail.py --query \'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:2026/05/18\' '
                        "--output-dir /tmp/ictc-sync/run1"
                    ),
                }
            )
            + "\n"
        )
        return 1
    return cmd_fetch(args)


if __name__ == "__main__":
    sys.exit(main())
