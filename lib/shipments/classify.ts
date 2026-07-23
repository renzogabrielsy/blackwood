// The ported "brain" of the Trello shipment-docs workflow — a FAITHFUL TypeScript
// port of scripts/trello-shipments/report.py::doc_type() + sync.py::classify() +
// report.py::resolve_customer(). The classification, canonical naming, and
// customer resolution MUST match the Python byte-for-byte so the in-app readiness
// numbers equal `python3 scripts/trello-shipments/report.py`.
//
// Quirk preserved on purpose: docType() tests the FULL name (incl. extension),
// while classify() tests the extension-stripped STEM. This is why van/seal docs
// (e.g. "CAAU 789243 8 FX45493895.pdf") return null from docType() — the trailing
// ".pdf" breaks the `[A-Z0-9-]+$` anchor — yet ARE canonically named by classify()
// off the stem. Van/seal is not a customer send-out doc, so the docType() null is
// harmless for readiness. Do not "fix" this divergence; it mirrors the Python.

/** Split "NAME.pdf" -> ["NAME", ".pdf"] (mirrors Python os.path.splitext). */
function splitExt(name: string): [string, string] {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  // Python splitext keeps a leading-dot file as all-stem; no dot -> empty ext.
  if (dot <= 0) return [trimmed, ""];
  return [trimmed.slice(0, dot), trimmed.slice(dot)];
}

/**
 * Attachment filename -> canonical document-type label (or null = uncounted).
 * Order matters: specific families before generic "Certificate of ...".
 * Port of report.py::doc_type(). Tests the full `name` (incl. extension).
 */
export function docType(name: string): string | null {
  const up = name.toUpperCase();

  // Bill of Lading family — many aliases; MEDUPH#### is the BL booking number.
  if (
    ["NON NEGO", "NON-NEGO", "TELEX RELEASE", "BILL OF LADING", "SIGNED BL", "DRAFT_BL", "ORIGINAL BL"].some(
      (k) => up.includes(k)
    ) ||
    /MEDUPH\d+/.test(up)
  ) {
    return "BL / Non-Nego";
  }
  if (up.includes("CERTIFICATE OF ANALYSIS") || /\bCOA\b/.test(up)) return "CoA";
  if (up.includes("CERTIFICATE OF ORIGIN") || /\bC\.?O\b(?!MMERCIAL|MMITMENT)/.test(up))
    return "Certificate of Origin";
  if (up.includes("HALAL")) return "Halal Certificate";
  if (up.includes("FUMIGATION") || up.includes("FUMEGAT") || up.includes("MAPECON")) return "Fumigation";
  if (up.includes("SAMPLE") || up.includes("PROFORMA")) return "Samples (proforma)"; // excluded from real invoice/PL
  if (up.includes("COMMERCIAL INVOICE")) return "Commercial Invoice";
  if (up.includes("PACKING LIST")) return "Packing List";
  if (up.includes("RECORD OF WEIGHT") || up.includes("AVERAGE WEIGHT") || up.includes("CERTIFICATE OF WEIGHT"))
    return "Record of Weight";
  if (up.includes("AUTHORITY TO LOAD") || /LBUB\w+/.test(up)) return "Authority To Load";
  if (up.includes("COMMODITY CLEARANCE")) return "Export Commodity Clearance";
  if (up.includes("EXPORT DECLARATION") || up.startsWith("ED-") || /\bED\b/.test(up)) return "Export Declaration";
  if (up.includes("LETTER OF COMMITMENT")) return "Letter of Commitment";
  if (up.includes("HALAL")) return "Halal Certificate";
  if (up.includes("MSDS")) return "MSDS";
  if (up.includes("LOI")) return "LOI";
  if (up.includes("TICKET")) return "Ticket";
  if (up.includes("BOOKING") || /EBKG\d+/.test(up)) return "Booking Confirmation";
  if (up.includes("VAN PICTURE") || up.includes("VANNING")) return "Van Pictures / Vanning";
  if (up.includes("DANGEROUS GOODS")) return "Dangerous Goods Cert";
  if (up.includes("WEATHERING")) return "Weathering Cert";
  // Van/Seal: 4 letters, 6 digits, 1 check digit, then the seal token — full name.
  if (/^[A-Z]{4}\s+\d{6}\s+\d\s+[A-Z0-9-]+$/.test(name.trim())) return "Van / Seal";
  return null;
}

/**
 * Original attachment name -> canonical filename + kind tag. Unknown types fall
 * back to the (optionally date-prefixed) original — safe: nothing lost.
 * Port of sync.py::classify(). Tests the extension-stripped STEM.
 *
 * `prefix` is the YYMMDD date prefix (from the card title). When null/empty, the
 * canonical name omits the leading date (honest for cards with no derivable date).
 */
export function classify(name: string, prefix: string | null): { canonical: string; kind: string } {
  const [stem, ext] = splitExt(name);
  const up = stem.toUpperCase();
  const p = prefix ? `${prefix} ` : "";

  // Container-VAN / SEAL: 4 letters, 6 digits, 1 check digit, then the seal token.
  const m = stem.trim().match(/^([A-Z]{4}\s+\d{6}\s+\d)\s+([A-Z0-9-]+)$/);
  if (m) return { canonical: `${p}VAN # ${m[1]} SEAL # ${m[2]}${ext}`, kind: "van/seal" };

  if (up.includes("COMMERCIAL INVOICE")) return { canonical: `${p}COMMERCIAL INVOICE${ext}`, kind: "commercial invoice" };
  if (up.includes("PACKING LIST")) return { canonical: `${p}PACKING LIST${ext}`, kind: "packing list" };
  if (up.includes("LETTER OF COMMITMENT"))
    return { canonical: `${p}LETTER OF COMMITMENT AND UNDERTAKING${ext}`, kind: "letter of commitment" };
  if (up.startsWith("ED-") || up.includes("EXPORT DECLARATION"))
    return { canonical: `${p}Export Declaration ${stem.trim()}${ext}`, kind: "export declaration" };
  if (up.startsWith("TICKET")) return { canonical: `${p}${stem.trim()}${ext}`, kind: "ticket" };

  // Authority To Load — BOC doc; filename carries an "LBUB…" reference (sometimes
  // uploaded as "ExportSSDT-LBUB…"). Match the reference and name canonically.
  const mlbub = up.match(/(LBUB\w+)/);
  if (mlbub || up.startsWith("EXPORTSSDT")) {
    const ref = mlbub ? ` ${mlbub[1]}` : "";
    return { canonical: `${p}AUTHORITY TO LOAD${ref}${ext}`, kind: "authority to load" };
  }
  if (up.includes("MSDS")) return { canonical: `${p}MSDS${ext}`, kind: "msds" };

  // fallback — keep the original, date-prefixed, for a human to rename/confirm.
  // NOTE: the PCA "Export Commodity Clearance" is uploaded named by its application
  // number (e.g. "2026-07-3102 ICTC"), so it can't be classified from the filename
  // alone — it lands here.
  return { canonical: `${p}${stem.trim()}${ext}`, kind: "UNCLASSIFIED (kept original)" };
}

/**
 * Card title -> canonical customer (KURARAY / MAEHATA) via the alias table, or
 * null. Port of report.py::resolve_customer(). Word-boundary matched, uppercased.
 */
export function resolveCustomer(title: string, aliases: Record<string, string>): string | null {
  const up = title.toUpperCase();
  for (const [token, canon] of Object.entries(aliases)) {
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\b`).test(up)) return canon;
  }
  return null;
}

/**
 * Derive the YYMMDD date prefix from a card title. Returns the 6-digit token when
 * the title starts with (or contains) one — the reliable, present-day naming (e.g.
 * "260715 SHIPMENT KURARAY 3X50" -> "260715"). Legacy month-name titles ("OCT 15",
 * "MAY 13") carry no year, so we cannot honestly synthesize a YYMMDD — those return
 * null and their canonical filenames simply omit the date prefix.
 */
export function derivePrefix(title: string): string | null {
  const m = title.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}
