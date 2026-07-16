# Mobile Audit 06 — Feed Surfaces, VIEW-only (`/sync/cases`, `/review-queue`, `/notifications`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, template.
2. `app/(app)/sync/CONTEXT.md` — ONLY the Sync Review / cases UI parts (`RunGroupedList`, `CaseDetail`, filter chips, "Copy for Claude"). The AI layer is dormant; skip its description.
3. `app/(app)/review-queue/CONTEXT.md` — frontend files section only.
4. `components/NOTIFICATIONS.md` — skim.

**Do the work YOURSELF — no delegation.**

## Mission
Three feed/list surfaces that are naturally phone-shaped — expect the cheapest wins of the series. The locked mobile scope is **view-only**: reading cases/queue/notifications on a phone is IN; resolving cases, approving/rejecting review uploads, and pick-a-value arbitration are OUT (desktop). Audit readability and confirm the action affordances degrade gracefully rather than tempting fat-finger mistakes.

## Surfaces & what to check
### `/sync/cases` (Sync Review)
- Run-grouped case list at 375px: cards/rows readable? Filter chips wrap?
- `CaseDetail` at phone width: the diff presentation (field-level disagreements, natural key, row data) is the dense part — does it fit or need a stacked field-card layout?
- "Copy for Claude" buttons on touch (clipboard on iOS).
- **Resolve/pick actions:** per scope they stay desktop — are they safely out of the way on a phone, or one accidental tap from writing data? If risky, recommend gating them behind viewport size or a confirm.
### `/review-queue`
- Card grid (1/2/3 responsive cols) — probably fine; verify.
- `ReviewDetailPanel` + `ClassifiedRowsTable` (Excel-dense, RC IN column order, dual-value changed cells): at 375px this is archetype-C-adjacent — apply/adapt the Audit 04 pattern rather than inventing one.
- Upload form: desktop-only by scope; confirm it hides or degrades.
### `/notifications`
- List + read/archive affordances at phone width; badge/bell in navbar (note issues but the navbar itself is Audit 10).

## What to verify (live)
All three routes × the device matrix × dark mode. Evidence screenshots for anything broken. Check empty states too (a clean day = empty cases list).

## Constraints
- **Audit only.** ONE combined result section (sub-verdicts per surface) appended to `docs/MOBILE_UI_AUDIT.md`, tick P6.
- Do NOT resolve/approve/reject anything real — these buttons write production data. Look, don't click terminal actions.
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section with a 3-row sub-verdict table, reply with verdicts + the accidental-tap risk assessment + effort.
