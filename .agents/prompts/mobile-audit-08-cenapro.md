# Mobile Audit 08 — Cenapro Tenant, READ (`/cenapro`, `/cenapro/production`, `/cenapro/inventory`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — including the Archetype C spec (Audit 04) and the matrix findings (Audit 07) if present; Cenapro reuses both.
2. `app/(app)/cenapro/CONTEXT.md` — **Purpose + Files table ONLY, and skim.** This CONTEXT file is enormous and mostly documents editing behavior that is desktop-only by decree. You need: the three screens, the view-mode switcher, the frozen-pane geometry, the data shapes. Do NOT read the editing/keyboard/commit-model prose.

**Do the work YOURSELF — no delegation.**

## Mission
Tenant #2's three screens, read layer only. Everything here rhymes with audits you've already got results for — apply those patterns, log the deltas, keep this cheap.

## Surfaces
1. **`/cenapro`** — landing hub, two card-links. Trivial; confirm.
2. **`/cenapro/production`** — one grid, three view modes via `?view=`:
   - `ledger` — editable Excel ledger (12 cols, 4 frozen identity cols, row tints, badges). On mobile: READ-only concern → archetype C.
   - `daily-w6` / `daily-w7` — the Daily Block pivot (2-tier header, merged rowSpan cells, 5 frozen identity cols, day-box outlines) → archetype E (matrix).
   - Period picker + ViewModeSwitcher must work by touch.
3. **`/cenapro/inventory`** — Flec Inventory: warehouse select + start-date input, editable STARTING block (desktop-only edit; read fine), balance cards, show-your-math ledger. Mostly card/list shaped — expect the friendliest surface.

## What to verify (live)
1. All three routes × device matrix × dark mode; page-level horizontal scroll forbidden; frozen panes opaque (watch the daily block's merged sticky cells at small sizes — rowSpan + sticky is the most fragile combo in the app).
2. Ledger mode at 375px: apply the Archetype C verdict; note deltas (row tints and CCC/FLEC badges carry meaning — does the mobile pattern preserve them?).
3. Daily block at 744 + 1133 (its natural home); at 375 characterize honestly (likely 🖥 or landscape-only — say which numbers a phone user still needs, e.g. daily totals).
4. Touch behavior of the editable cells in read context — click-to-select cells must not pop keyboards or trap scroll on touch devices.
5. Inventory screen at 375px: warehouse/date pickers, balance cards, ledger list.

## Constraints
- **Audit only.** ONE combined result section (sub-verdicts per screen/mode) to `docs/MOBILE_UI_AUDIT.md`, tick P8.
- Do NOT touch save paths — do not commit any cell edit, stage any draft, or save opening balances. Look, don't commit.
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section with a sub-verdict table (hub / ledger / daily block / inventory), screenshots at 375 for ledger + daily block, reply with verdicts + deltas + effort.
