#!/usr/bin/env python3
"""Trello export-shipment doc downloader (Track A).

Downloads a shipment card's attachments, renames them to the ICTC house
convention, and files them into the Shipments folder. SAFETY: download-only —
never deletes, moves, or overwrites. A target that already exists is SKIPPED.
Credentials are read from ~/.config/ictc-trello/credentials.env (never printed).

Attachment downloads require the OAuth Authorization header (Trello dropped
key/token query-param auth for file downloads in 2021).

Usage: python3 sync.py --card <cardId> --prefix <YYMMDD> --dest "<folder path>" [--apply]
Default (no --apply) is a DRY RUN: prints the plan, writes nothing.
"""
import os, re, sys, json, argparse, urllib.request, urllib.parse

CRED = os.path.expanduser("~/.config/ictc-trello/credentials.env")


def load_creds():
    key = tok = None
    with open(CRED) as f:
        for line in f:
            line = line.strip()
            if line.startswith("TRELLO_API_KEY="): key = line.split("=", 1)[1].strip()
            elif line.startswith("TRELLO_TOKEN="): tok = line.split("=", 1)[1].strip()
    if not key or not tok:
        sys.exit("Missing TRELLO_API_KEY / TRELLO_TOKEN in " + CRED)
    return key, tok


def api_get(path, key, tok, **params):
    params.update(key=key, token=tok)
    url = "https://api.trello.com" + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def classify(name, prefix):
    """Original attachment name -> canonical filename. Unknown types fall back to
    the date-prefixed original (safe: nothing lost, human renames later)."""
    stem, ext = os.path.splitext(name.strip())
    up = stem.upper()
    # Container-VAN / SEAL: 4 letters, 6 digits, 1 check digit, then the seal token.
    m = re.match(r"^([A-Z]{4}\s+\d{6}\s+\d)\s+([A-Z0-9-]+)$", stem.strip())
    if m:
        return f"{prefix} VAN # {m.group(1)} SEAL # {m.group(2)}{ext}", "van/seal"
    if "COMMERCIAL INVOICE" in up: return f"{prefix} COMMERCIAL INVOICE{ext}", "commercial invoice"
    if "PACKING LIST" in up:       return f"{prefix} PACKING LIST{ext}", "packing list"
    if "LETTER OF COMMITMENT" in up: return f"{prefix} LETTER OF COMMITMENT AND UNDERTAKING{ext}", "letter of commitment"
    if up.startswith("ED-") or "EXPORT DECLARATION" in up:
        return f"{prefix} Export Declaration {stem.strip()}{ext}", "export declaration"
    if up.startswith("TICKET"):    return f"{prefix} {stem.strip()}{ext}", "ticket"
    # Authority To Load — BOC doc, filename carries an "LBUB…" reference (sometimes
    # uploaded as "ExportSSDT-LBUB…"). Match the reference and name canonically.
    mlbub = re.search(r"(LBUB\w+)", up)
    if mlbub or up.startswith("EXPORTSSDT"):
        ref = f" {mlbub.group(1)}" if mlbub else ""
        return f"{prefix} AUTHORITY TO LOAD{ref}{ext}", "authority to load"
    if "MSDS" in up: return f"{prefix} MSDS{ext}", "msds"
    # fallback — keep the original, date-prefixed, for a human to rename/confirm.
    # NOTE: the PCA "Export Commodity Clearance" is uploaded named by its application
    # number (e.g. "2026-07-3102 ICTC"), so it can't be classified from the filename
    # alone — it lands here and needs a human (or a content read) to identify. See the
    # workflow doc's Phase-3 note on content-based classification.
    return f"{prefix} {stem.strip()}{ext}", "UNCLASSIFIED (kept original)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--dest", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="download even if this shipment (by BL#) is already housed elsewhere")
    a = ap.parse_args()
    key, tok = load_creds()

    atts = api_get(f"/1/cards/{a.card}/attachments", key, tok,
                   fields="name,bytes,mimeType,url,idAttachment")
    hdr = {"Authorization": f'OAuth oauth_consumer_key="{key}", oauth_token="{tok}"'}

    # ── BL#-dedup guard ────────────────────────────────────────────────────────────
    # The reliable shipment identity is the Bill-of-Lading number (MEDUPH####), NOT
    # the card title (a title like "OCT 15" once pointed at a September shipment we
    # already had, and a naive download duplicated it). Before writing anything, scan
    # the Shipments archive (the PARENT of --dest) for these BL#s; if the shipment is
    # already housed in a DIFFERENT folder, refuse to duplicate it (override: --force).
    bls = sorted({m.upper() for n in (at["name"] for at in atts)
                  for m in re.findall(r"MEDUPH\d+", n.upper())})
    if bls and a.apply and not a.force:
        ship_root = os.path.dirname(os.path.normpath(a.dest))
        dest_norm = os.path.normpath(a.dest)
        housed = {}
        for dp, _, files in os.walk(ship_root):
            if os.path.normpath(dp).startswith(dest_norm):
                continue  # our own target folder doesn't count
            for f in files:
                up = f.upper()
                for bl in bls:
                    if bl in up:
                        housed.setdefault(bl, os.path.relpath(dp, ship_root))
        if housed:
            print("⛔ ABORT — this shipment appears ALREADY HOUSED (matched by BL#):")
            for bl, folder in housed.items():
                print(f"     {bl}  →  already in “{folder}”")
            print("   Not downloading (would duplicate). Re-run with --force to override.")
            return

    print(f"{'APPLY' if a.apply else 'DRY RUN'} · card {a.card} · {len(atts)} attachments")
    print(f"dest: {a.dest}\n")
    if a.apply:
        os.makedirs(a.dest, exist_ok=True)

    done = skipped = 0
    for at in atts:
        target, kind = classify(at["name"], a.prefix)
        path = os.path.join(a.dest, target)
        if os.path.exists(path):  # NEVER overwrite
            print(f"  SKIP (exists)   {target}")
            skipped += 1
            continue
        kb = (at.get("bytes") or 0) / 1024
        if not a.apply:
            print(f"  plan  [{kind:26}] {at['name']}  ->  {target}  ({kb:.0f} KB)")
            continue
        req = urllib.request.Request(at["url"], headers=hdr)
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as out:
            out.write(r.read())
        print(f"  OK    {target}  ({kb:.0f} KB)")
        done += 1

    print(f"\n{'Downloaded' if a.apply else 'Planned'}: {done if a.apply else len(atts)-skipped} · Skipped: {skipped}")

    # After a real download, print this shipment's customer-send-out readiness so
    # Renzo immediately sees what's still MISSING on Trello before sending.
    if a.apply:
        try:
            import report
            card = api_get(f"/1/cards/{a.card}", key, tok, fields="name")
            print("\n— shipment readiness —")
            for line in report.readiness_lines(card["name"], [at["name"] for at in atts], report.load_cfg()):
                print(line)
        except Exception as e:
            print(f"(readiness check skipped: {e})")


if __name__ == "__main__":
    main()
