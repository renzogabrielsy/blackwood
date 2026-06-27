#!/usr/bin/env python3
"""
Shared weight-deduction grammar + wet-recovery-row core for the RC IN extractors.

ONE source of truth for the two delivery (RC IN) extractors:
  - extract_rc_deliveries.py  (operator email file — openpyxl random-access sheet)
  - extract_gsheet.py::extract_rc_in()  (Google Sheet export — forward-only grid)

Everything here is sheet-agnostic: the grammar takes str/float and returns tuples;
the recovery core takes/returns plain dicts. There is NO openpyxl dependency — each
extractor does its own cell access and calls these helpers.

See DEDUCTIONS_DESIGN.md (locked by Renzo 2026-06-25) and LEARNING_LEDGER L-021.

Contract (unchanged across both extractors):
  - `true_weight_kg` = the physical/GROSS weight BEFORE both ASH and wet deductions,
    PARSED directly from the `net kilos of <GROSS> … = <NET>` remark — never
    recomputed from the percentage. NULL when there is no deduction; NEVER 0.
  - `deduction_note` = a short hover label (e.g. "−1.60% MC; −2.88% ASH").
  - `weight_kg` STAYS the Sheet/email's deducted NET — never overwritten here.
  - Both fields are ADDITIVE / write-only: not part of any natural key, never diffed.

Row-shape note: the email extractor's row dict carries the resolved code under
`batch_code`; the gsheet extractor carries it under `batch_code_primary` (+ a
`batch_code_fallbacks` list). The recovery helpers below accept BOTH shapes.
"""

from __future__ import annotations

import re
from typing import Any


# ---------------------------------------------------------------------------
# Weight-deduction grammar (see DEDUCTIONS_DESIGN.md)
# ---------------------------------------------------------------------------
# Operators record quality deductions (ASH / MC / wet sacks) in the REMARKS
# column with a consistent grammar:
#     <TRUCK> net kilos (of)? <GROSS> - <PCT>%(<TYPE>) [& <PCT>%(<TYPE>)] = <NET>
# Real verified examples:
#   "MAN3625 net kilos of 22,340 - .67%(MC) = 22,190"
#   "CBN2192 net kilos of 10,945 - 1.60%(MC) & 2.88%(ASH) = 10,455"
#   "NEV 8612 net kilos of 19,295 -496 KILOS of (MC dedeuction) = 18,799"
#   "MAQ 3456 net kilos   22,795  - 395 (MC) and 7,044 (ash) = 21,696"
#   "ALA 9425 net kilos of 33,950 - 1.88%(ASAH) = 33,312"   (ASH misspelled)
#
# CONTRACT (DEDUCTIONS_DESIGN.md): `weight_kg` ALREADY equals the NET (the figure
# after the final "="); the GROSS stated after "net kilos (of)" is the physical/true
# weight BEFORE both deductions. We PARSE the gross directly — never recompute it
# from the percentage. The "= NET" is used only as a consistency check.
MINUS_SIGN = "−"  # U+2212; the design's deduction_note uses this minus

# The "net kilos of <GROSS>" signal. The "of" is optional; spacing is loose.
NET_KILOS_GROSS_RE = re.compile(
    r"net\s+kilos\s+(?:of\s+)?([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)
# The NET = number immediately after the LAST "=" in the remark.
NET_AFTER_EQUALS_RE = re.compile(r"=\s*([\d,]+(?:\.\d+)?)\s*$")
# Percentage-style deduction fragment: "<PCT>%(<TYPE>)" or "<PCT>% <TYPE>" or
# bare "<PCT>%TYPE". TYPE is optional/loose (parens, spaces, or none).
PCT_FRAG_RE = re.compile(
    r"(\d*\.?\d+)\s*%\s*\(?\s*([A-Za-z]+)?",
)
# Absolute-kilos deduction fragment: "<N> KILOS" or "<N>(<TYPE>)" / "<N> (<TYPE>)".
# Only the fragments to the RIGHT of the first "-" (the deduction side) matter; we
# scan the deduction tail so the gross/net numbers are not mistaken for fragments.
ABS_KILOS_RE = re.compile(
    r"(\d[\d,]*)\s*(?:KILOS|KGS?)\b",
    re.IGNORECASE,
)
ABS_PAREN_TYPE_RE = re.compile(
    r"(\d[\d,]*)\s*\(\s*([A-Za-z]+)",
)
# WET-sacks mention anywhere in the remark.
WET_SACKS_RE = re.compile(r"WET\s+SACKS?", re.IGNORECASE)


def _strip_commas_to_float(s: str) -> float | None:
    try:
        return float(s.replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _normalize_deduction_type(raw: str | None) -> str | None:
    """Map an operator deduction-type token to a canonical label (ASH/MC/wet)."""
    if not raw:
        return None
    t = raw.strip().upper()
    if t in {"ASH", "ASAH", "ASHH", "ASE"}:  # ASAH = common operator misspelling
        return "ASH"
    if t in {"MC", "MOISTURE"}:
        return "MC"
    if t.startswith("WET"):
        return "wet"
    return None


def detect_deduction(
    remarks: str | None,
    weight_kg: float | None,
) -> tuple[float | None, str | None, list[str]]:
    """
    Detect a weight deduction annotated in `remarks` and return
    (true_weight_kg, deduction_note, warnings).

    Per DEDUCTIONS_DESIGN.md (Decision A + Decision 2):
      - true_weight_kg = the GROSS stated after "net kilos (of)" — physical weight
        BEFORE both ASH and wet deductions. PARSED directly, never recomputed from %.
      - weight_kg is authoritative and STAYS the NET; it is never changed here.
      - The "= NET" tail is a consistency check against weight_kg (warn on mismatch).
      - No "net kilos" signal -> (None, None, []) — ordinary, untagged load.
      - NEVER returns 0 for true_weight_kg; leaves NULL when it cannot be trusted.
    """
    warnings: list[str] = []
    if not remarks:
        return None, None, []

    text = remarks.strip()
    gross_m = NET_KILOS_GROSS_RE.search(text)
    if not gross_m:
        # No deduction signal at all — ordinary load.
        return None, None, []

    gross = _strip_commas_to_float(gross_m.group(1))

    # Consistency check: the number after the LAST "=" should equal weight_kg.
    net_m = NET_AFTER_EQUALS_RE.search(text)
    stated_net = _strip_commas_to_float(net_m.group(1)) if net_m else None
    if (
        stated_net is not None
        and weight_kg is not None
        and abs(stated_net - weight_kg) > 1
    ):
        warnings.append(
            f"remark net {stated_net:g} != weight_kg {weight_kg:g}"
        )

    # Build the deduction_note from fragments on the deduction SIDE (right of the
    # first "-" after the gross), so the gross/net figures aren't read as fragments.
    note = _build_deduction_note(text, gross_m.end())

    # Guard: gross must exist AND strictly exceed the net (weight_kg). A "gross"
    # that isn't above the net is suspicious — better untagged than mis-tagged.
    if gross is None:
        warnings.append(
            "deduction present but gross weight could not be parsed from 'net kilos'"
        )
        return None, note, warnings
    if weight_kg is not None and gross <= weight_kg:
        warnings.append(
            f"parsed gross {gross:g} <= weight_kg {weight_kg:g}; not tagging "
            f"(gross must exceed net)"
        )
        return None, note, warnings

    return gross, note, warnings


def _build_deduction_note(text: str, gross_end: int) -> str:
    """
    Compose a short deduction_note from the deduction-side fragments of `text`.
    `gross_end` is the offset just past the parsed gross, so we only scan the
    deduction side (avoids reading the gross/net figures as fragments).

    Produces e.g. "-.67% MC", "-1.60% MC; -2.88% ASH", "-496 kg MC",
    "-5.14% MC; wet sacks". Falls back to a trimmed copy of the remark when no
    clean fragments can be enumerated.
    """
    # The deduction side begins at the first "-" after the gross; if there's no
    # "-", scan from gross_end (some remarks use "and"/"&" only).
    tail = text[gross_end:]
    dash_idx = tail.find("-")
    ded_side = tail[dash_idx:] if dash_idx != -1 else tail
    # Drop everything from the final "=" onward (that's the NET, not a fragment).
    eq_idx = ded_side.rfind("=")
    if eq_idx != -1:
        ded_side = ded_side[:eq_idx]

    fragments: list[str] = []

    # Percentage fragments, e.g. ".67%(MC)", "2.88%(ASH)", "1.88%(ASAH)".
    for m in PCT_FRAG_RE.finditer(ded_side):
        pct = m.group(1)
        typ = _normalize_deduction_type(m.group(2))
        frag = f"{MINUS_SIGN}{pct}%"
        if typ and typ != "wet":
            frag += f" {typ}"
        elif typ == "wet":
            frag += " wet"
        fragments.append(frag)

    # Absolute-kilos fragments, e.g. "496 KILOS of (MC ...)", "7,044 (ash)".
    # Only consider these when there were no percentage fragments OR when an
    # explicit "KILOS/(type)" appears, to avoid double-counting.
    consumed_abs = False
    for m in ABS_KILOS_RE.finditer(ded_side):
        n = m.group(1)
        # Look just past the match for a "(TYPE)" or "TYPE" hint.
        rest = ded_side[m.end(): m.end() + 24]
        tmatch = re.search(r"\(?\s*([A-Za-z]+)", rest)
        typ = _normalize_deduction_type(tmatch.group(1)) if tmatch else None
        frag = f"{MINUS_SIGN}{n} kg"
        if typ and typ != "wet":
            frag += f" {typ}"
        fragments.append(frag)
        consumed_abs = True
    if not consumed_abs:
        for m in ABS_PAREN_TYPE_RE.finditer(ded_side):
            n = m.group(1)
            typ = _normalize_deduction_type(m.group(2))
            frag = f"{MINUS_SIGN}{n} kg"
            if typ and typ != "wet":
                frag += f" {typ}"
            fragments.append(frag)

    # Standalone WET-sacks mention (only add if not already captured as a type).
    if WET_SACKS_RE.search(text) and not any("wet" in f for f in fragments):
        fragments.append("wet sacks")

    if fragments:
        # Dedup while preserving order (loose regexes can double-hit).
        seen: set[str] = set()
        deduped = [f for f in fragments if not (f in seen or seen.add(f))]
        return "; ".join(deduped)

    # Fallback: a trimmed copy of the remark (kept short for a hover label).
    fallback = " ".join(text.split())
    return fallback[:80]


# ---------------------------------------------------------------------------
# Wet "recovery" sub-rows — sheet-agnostic core (see DEDUCTIONS_DESIGN.md §8)
# ---------------------------------------------------------------------------
# A recovery sub-row is a continuation row directly under a full delivery (the
# "mother") that carries its OWN weight + sacks + MC but NO truck / batch / block /
# supplier / date of its own. Historically these were dropped (silently, or flagged
# MALFORMED for lacking a batch_code) — the D-20D leak. Each extractor detects the
# "no own date" condition in its own way (the email file random-accesses the date
# cell; the gsheet grid checks the forward-only row), then calls the shared
# predicate + builder below. The builder inherits the mother's identity and keeps
# the candidate's own weight/sacks/lab_results + its own true_weight_kg/deduction_note.
def _row_batch_code(row_dict: dict[str, Any] | None) -> str | None:
    """Return the row's batch code under EITHER shape (email `batch_code` or
    gsheet `batch_code_primary`). Used so the recovery core works for both."""
    if not row_dict:
        return None
    return row_dict.get("batch_code") or row_dict.get("batch_code_primary")


def is_recovery_row_dict(row_dict: dict[str, Any] | None, *, has_own_date: bool) -> bool:
    """
    Sheet-agnostic recovery predicate. True iff `row_dict` (already extracted by
    either extractor) looks like a wet-recovery sub-row: it has a usable weight but
    is MISSING its own truck_plate AND batch code (either shape) AND block_loc, and
    it did NOT have its OWN date cell (`has_own_date` is False — the date was
    forward-filled). Such a row would otherwise carry no batch_code and be MALFORMED.

    `has_own_date` is computed by each caller from its own raw date cell (NOT the
    forward-filled value already in row_dict).
    """
    if not row_dict:
        return False
    if row_dict.get("weight_kg") is None:
        return False
    # Must lack its own identity columns.
    if row_dict.get("truck_plate") is not None:
        return False
    if _row_batch_code(row_dict) is not None:
        return False
    if row_dict.get("block_loc") is not None:
        return False
    # The row must not have had its OWN date (forward-filled dates don't count).
    if has_own_date:
        return False
    return True


def _is_inheritable_mother(row_dict: dict[str, Any] | None) -> bool:
    """A row a recovery can inherit identity from: it must itself carry a real batch
    code (either shape) so the inheritance produces a classifiable, non-MALFORMED row."""
    return _row_batch_code(row_dict) is not None


def build_recovery_row(
    candidate: dict[str, Any],
    mother: dict[str, Any],
) -> dict[str, Any]:
    """
    Turn a recovery candidate (extracted in isolation) into a standalone delivery
    row inheriting the mother's identity. Keeps the candidate's own weight_kg,
    sacks, lab_results, remarks, and re-derives true_weight_kg/deduction_note from
    the candidate's own remark (the recovery's pre-deduction gross, if stated).

    Works for BOTH row shapes: it inherits whichever batch field(s) the mother has
    (`batch_code` and/or `batch_code_primary`/`batch_code_fallbacks`) and the
    email-only `operator_batch_label` when present.
    """
    # Re-derive deduction off the recovery's OWN remark + OWN (deducted) weight.
    true_weight_kg, deduction_note, ded_warnings = detect_deduction(
        candidate.get("remarks"), candidate.get("weight_kg")
    )

    warnings = list(candidate.get("warnings") or [])
    # Drop the now-irrelevant "missing supplier / no batch label" noise the
    # isolated extract added — identity is inherited, so those aren't problems.
    warnings = [
        w for w in warnings
        if "missing supplier" not in w
        and "No operator batch label" not in w
        and "Could not map operator batch label" not in w
    ]
    src = candidate.get("_source_row")
    warnings.append(
        f"Row {src}: wet-recovery sub-row — inherited truck/block/supplier/batch "
        f"from mother row {mother.get('_source_row')}"
    )
    for w in ded_warnings:
        warnings.append(f"Row {src}: {w}")

    confidence = max(0.0, 1.0 - 0.10 * len(warnings))

    row: dict[str, Any] = {
        "transaction_date": mother.get("transaction_date"),
        "supplier": mother.get("supplier"),
        "block_loc": mother.get("block_loc"),
        "truck_plate": mother.get("truck_plate"),
        "sacks": candidate.get("sacks"),
        "weight_kg": candidate.get("weight_kg"),
        "cost_basis": mother.get("cost_basis"),
        "remarks": candidate.get("remarks"),
        "lab_results": candidate.get("lab_results"),
        "true_weight_kg": true_weight_kg,
        "deduction_note": deduction_note,
        "warnings": warnings,
        "confidence": round(confidence, 3),
        "_source_row": src,
        "_recovery": True,
        "_mother_source_row": mother.get("_source_row"),
    }

    # Inherit the batch code under whichever shape(s) the mother carries.
    if "batch_code" in mother:
        row["batch_code"] = mother.get("batch_code")
    if "batch_code_primary" in mother:
        row["batch_code_primary"] = mother.get("batch_code_primary")
        row["batch_code_fallbacks"] = list(mother.get("batch_code_fallbacks") or [])
    if mother.get("operator_batch_label") is not None:
        row["operator_batch_label"] = mother.get("operator_batch_label")

    # Carry through the source-tab marker (gsheet rows have it; email rows don't).
    if mother.get("_source_tab") is not None:
        row["_source_tab"] = mother.get("_source_tab")

    return row
