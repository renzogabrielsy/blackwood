# Dashboard v1 — Archived (2026-06-04)

This is the **pre-digest modular widget dashboard** that previously rendered at the `/` route.

It was a composable ReactGridLayout grid of drag/resize/add widgets (chart, KPI strip,
quality scatter, warehouse occupancy), backed by the platform adapter layer
(`lib/widgets/adapters/`) with static fallbacks (`lib/widgets/mock-data.ts`).

## Why it's here

It was **replaced by the Daily Sync Digest** at `app/(app)/page.tsx` — a modern,
server-rendered operational + sync-health digest. The widget dashboard was archived
(not deleted) so it remains recoverable.

## What was moved here (preserving structure)

| Original location              | Archived location                                   |
|--------------------------------|-----------------------------------------------------|
| `components/dashboard/`        | `_archived/dashboard-v1/components/dashboard/`       |
| `components/widgets/`          | `_archived/dashboard-v1/components/widgets/`         |
| `lib/widgets/`                 | `_archived/dashboard-v1/lib/widgets/`                |
| `lib/dashboard/`               | `_archived/dashboard-v1/lib/dashboard/`              |
| `app/(app)/actions.ts`         | `_archived/dashboard-v1/app-actions.ts`              |

## Notes

- This directory is in `tsconfig.json` `exclude`, so its now-dangling `@/...` imports
  (which referenced the original non-archived paths) do **not** break typecheck/build.
- It lives **outside `app/`**, so Next.js does not route or compile it.
- `react-grid-layout` and `recharts` remain installed — `recharts` is reused by the new
  digest charts; `react-grid-layout` is kept solely for this archive.
- **Restorable via git history** — see the move commit, or `git mv` these back.
