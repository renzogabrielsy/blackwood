# Universal Table Module ("Blackwood Table v2") — research pack

Evidence base for `.agents/prompts/universal-table-module.md` (the implementation prompt). Produced 2026-08-17 by four read-only audits; nothing here was edited by hand except headers.

| File | What it is |
|---|---|
| `01-audit-cenapro-ledger.md` | Google-Sheets-lens code audit of `app/(app)/cenapro/deliveries/` — 22 findings (A1–A22), the parity table (B), the extraction seam (C), top-10 (D). |
| `02-perf-cenapro-ledger.md` | Perf diagnosis of the same ledger — 16 findings; the render-boundary rule the module must satisfy by construction. |
| `03-rc-in-out-feature-inventory.md` | Every user-facing feature of ICTC RC IN / RC OUT + the `/inventory` shell, with a must-survive verdict per feature, the server-action contracts, and cross-module consumers (blast radius). |
| `04-table-inventory.md` | All 55 table components app-wide, their primitives, period controls, frozen-pane tier — plus the Cenapro vs ICTC period-control comparison. |

Decisions from Renzo (2026-08-17) are recorded in the prompt itself, section 1.
