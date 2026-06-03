---
name: anomaly-cross-sheet-date-duplicate
description: A single feed date can appear on two month sheets in RAW CHARCOAL MOVEMENT; reconcile by summing across sheets, not last-write-wins, or you get a phantom drift.
metadata:
  type: project
---

A single feed date can appear on TWO month sheets in `RAW CHARCOAL MOVEMENT 2026.xlsx`. Reconcile the date->fed total by SUMMING across all sheets, never last-write-wins.

**Why:** On 2026-05-29 the fed total was split across the MAY 2026 sheet (11,210 kg, row 40) and the June 2026 sheet (10,600 kg, row 7) — true total 21,810, which matches the rc_out daily sum exactly. `extract_rc_movement.py`'s `date_to_fed_kls` map keys only on date, so the later (June) sheet silently overwrote the May value, producing a phantom -11,210 drift vs rc_out that does not actually exist. Operators sometimes record a single day's feed on the boundary between two month tabs.

**How to apply:** When cross-checking MOVEMENT vs rc_out, do not trust `date_to_fed_kls` for dates near a month boundary. Re-aggregate from the raw `rows` list, summing `raw_charcoal_fed_kls` per date across `_source_sheet`. Cross-references [[project_view_rc_movement_is_rc_out_projection]]. Drafted as proposed ledger entry L-007 (2026-06-02) for Renzo to commit.
