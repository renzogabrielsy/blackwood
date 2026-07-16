# Mobile Audit 03 — Blocking Warehouse Grid (`/inventory/blocking`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, pattern catalog, result template.
2. `app/(app)/inventory/blocking/CONTEXT.md` — grid layout (warehouse configs, cell rendering, detail panel contract). Skim the file table; skip blend-PDF details.

**Do the work YOURSELF — no delegation.**

## Mission
Blocking has the strongest *physical* phone use case in the app: **walking the actual warehouse with the grid in hand**. Audit whether the 220-slot heatmap (4 warehouses × 20 columns, plus opt-in PCA/PCB) is usable on an iPhone held in one hand, and whether the detail panel flow works by touch.

## Feature facts you need
- CSS Grid heatmap: standard warehouses are **20 columns wide** — the crux at 375px (20 cols ≈ 17px cells if naively squeezed; unusable). How does it actually behave today?
- `?block=<loc>` drives the detail slide-over (deep-linkable; Back closes it). The panel is ALREADY `w-full sm:w-[520px]` — phones were considered. Verify, don't assume.
- Sticky summary header: warehouse filter chips (ALL / A / B / C / D / PCA / PCB), status-badge spotlight filters (clickable), balance legend, global stats.
- Cells: occupied = zinc gradient + balance-% text color + MC/ASH lab tint; click toggles selection.
- **Blend Proposal mode** (multi-select cells → wide modal with per-block lab table, PDF/print) — per the locked mobile scope this is a candidate for 🖥 DESKTOP-ONLY; confirm it degrades without breaking the read experience.
- Price data is role-gated + a client `showPrices` hide-only toggle exists.

## What to verify (live)
1. At 375×812: how does a 20-column warehouse section render? Page-level horizontal scroll (forbidden), per-section internal scroll, or crushed cells? Screenshot each warehouse.
2. Can you **tap a single cell accurately** with a thumb? (Fitts's law: what's the real cell hit area?)
3. Detail panel at phone width: full-width takeover, internal scroll, close by backdrop/Escape-equivalent? Delivery + usage history readable? The `Σ` true-weight popover on touch?
4. Filter chips + status spotlight at phone width — wrap or overflow?
5. iPad mini portrait (744): does the full 4-warehouse view fit meaningfully? This is likely the *primary* warehouse-walk device — treat iPad as first-class here.
6. Landscape iPhone: is that a viable fallback for the grid?
7. Pattern candidates to weigh: **(a)** per-warehouse horizontal scroll with sticky row labels; **(b)** warehouse picker (one warehouse at a time, bigger cells); **(c)** landscape-encouraged full grid; **(d)** zoom/pan container. Recommend ONE, justify in 2-3 sentences.

## Constraints
- **Audit only.** Append result to `docs/MOBILE_UI_AUDIT.md`, tick P3. No other code changes.
- Blend Proposal: verdict + graceful-degradation note only — do NOT design a mobile blend flow.
- Dev server + browser resize per device matrix; ask Renzo to log in once if needed.

## Deliverable
Standard template section + screenshots per warehouse at 375px and 744px, reply with verdicts, the ONE grid pattern, effort.
