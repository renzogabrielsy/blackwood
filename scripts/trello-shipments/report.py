#!/usr/bin/env python3
"""Shipment readiness report — per shipment card, which CUSTOMER send-out docs are
present on Trello vs MISSING, using a per-customer required set.

Read-only: talks to the Trello API, touches no files. Credentials from
~/.config/ictc-trello/credentials.env (never printed).

Usage: python3 report.py --board <boardId> [--card <cardId>]
"""
import os, re, sys, json, argparse, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CRED = os.path.expanduser("~/.config/ictc-trello/credentials.env")
REQ = os.path.join(HERE, "customer-requirements.json")


def load_creds():
    key = tok = None
    with open(CRED) as f:
        for line in f:
            line = line.strip()
            if line.startswith("TRELLO_API_KEY="): key = line.split("=", 1)[1].strip()
            elif line.startswith("TRELLO_TOKEN="): tok = line.split("=", 1)[1].strip()
    if not key or not tok: sys.exit("Missing creds in " + CRED)
    return key, tok


def api_get(path, key, tok, **params):
    params.update(key=key, token=tok)
    url = "https://api.trello.com" + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def doc_type(name):
    """Attachment filename -> canonical document-type label (or None = uncounted).
    Order matters: specific families before generic 'Certificate of ...'."""
    up = name.upper()
    # Bill of Lading family — many aliases; MEDUPH#### is the BL booking number.
    if any(k in up for k in ("NON NEGO", "NON-NEGO", "TELEX RELEASE", "BILL OF LADING",
                             "SIGNED BL", "DRAFT_BL", "ORIGINAL BL")) or re.search(r"MEDUPH\d+", up):
        return "BL / Non-Nego"
    if "CERTIFICATE OF ANALYSIS" in up or re.search(r"\bCOA\b", up):
        return "CoA"
    if "CERTIFICATE OF ORIGIN" in up or re.search(r"\bC\.?O\b(?!MMERCIAL|MMITMENT)", up):
        return "Certificate of Origin"
    if "HALAL" in up: return "Halal Certificate"
    if "FUMIGATION" in up or "FUMEGAT" in up or "MAPECON" in up: return "Fumigation"
    if "SAMPLE" in up or "PROFORMA" in up: return "Samples (proforma)"   # exclude from real invoice/PL
    if "COMMERCIAL INVOICE" in up: return "Commercial Invoice"
    if "PACKING LIST" in up: return "Packing List"
    if "RECORD OF WEIGHT" in up or "AVERAGE WEIGHT" in up or "CERTIFICATE OF WEIGHT" in up:
        return "Record of Weight"
    if "AUTHORITY TO LOAD" in up or re.search(r"LBUB\w+", up): return "Authority To Load"
    if "COMMODITY CLEARANCE" in up: return "Export Commodity Clearance"
    if "EXPORT DECLARATION" in up or up.startswith("ED-") or re.search(r"\bED\b", up): return "Export Declaration"
    if "LETTER OF COMMITMENT" in up: return "Letter of Commitment"
    if "HALAL" in up: return "Halal Certificate"
    if "MSDS" in up: return "MSDS"
    if "LOI" in up: return "LOI"
    if "TICKET" in up: return "Ticket"
    if "BOOKING" in up or re.search(r"EBKG\d+", up): return "Booking Confirmation"
    if "VAN PICTURE" in up or "VANNING" in up: return "Van Pictures / Vanning"
    if "DANGEROUS GOODS" in up: return "Dangerous Goods Cert"
    if "WEATHERING" in up: return "Weathering Cert"
    if re.match(r"^[A-Z]{4}\s+\d{6}\s+\d\s+[A-Z0-9-]+$", name.strip()): return "Van / Seal"
    return None


def resolve_customer(title, aliases):
    up = title.upper()
    for token, canon in aliases.items():
        if re.search(rf"\b{re.escape(token)}\b", up):
            return canon
    return None


def load_cfg():
    return json.load(open(REQ))


def readiness_lines(cardname, att_names, cfg):
    """Pure: (card title, list of attachment names, config) -> printable lines.
    Reused by this report AND by sync.py after a download."""
    aliases, reqs = cfg["aliases"], cfg["requirements"]
    cust = resolve_customer(cardname, aliases)
    present = {doc_type(n) for n in att_names} - {None}
    if not cust or cust not in reqs:
        return [f"■ {cardname}",
                f"    customer: {cust or 'UNKNOWN'} — no requirement set; {len(att_names)} attachments"]
    req = reqs[cust]
    need = req["docs"]
    miss = [d for d in need if d not in present]
    flag = "" if req.get("confirmed") else "  (⚠ DRAFT requirement set — confirm)"
    status = "✅ COMPLETE" if not miss else f"{len(need) - len(miss)}/{len(need)}"
    tail = f" · MISSING: {', '.join(miss)}" if miss else " · all customer docs present"
    return [f"■ {cardname}  [{cust}]{flag}", f"    {status}{tail}"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", required=True)
    ap.add_argument("--card")
    a = ap.parse_args()
    key, tok = load_creds()
    cfg = load_cfg()

    cards = api_get(f"/1/boards/{a.board}/cards", key, tok, fields="name,idList")
    if a.card:
        cards = [c for c in cards if c["id"] == a.card]

    print("SHIPMENT READINESS — customer send-out docs (present on Trello vs MISSING)\n")
    for c in sorted(cards, key=lambda c: c["name"]):
        atts = api_get(f"/1/cards/{c['id']}/attachments", key, tok, fields="name")
        for line in readiness_lines(c["name"], [at["name"] for at in atts], cfg):
            print(line)
        print()


if __name__ == "__main__":
    main()
