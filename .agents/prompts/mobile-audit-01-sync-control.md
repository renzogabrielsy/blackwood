# Mobile Audit 01 — Sync Control (Run Sync from a phone)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, pattern catalog, result template.
2. `app/(app)/sync/CONTEXT.md` — the Run Sync architecture (modal, realtime watching, findings). Skim; you need the UI surface, not the reconciliation model.
3. Then, only as needed: `components/sync/SyncLauncher.tsx` and whatever modal/panel components it mounts (follow imports; likely `useSyncRun.ts`, a run-progress view, `HeldRows.tsx`).

**Do the work YOURSELF — no delegation.**

## Mission
This is **the flagship mobile flow** — the whole reason the mobile effort exists. Renzo must be able to pull out his iPhone anywhere, tap **Run Sync**, and watch the run complete live. Audit the entire flow at the three viewports in `docs/MOBILE_UI_AUDIT.md` and name the pattern that makes it first-class on a phone.

## Feature facts you need
- Entry: a privileged-only "Run Sync" button right-aligned in the digest header row on `/` — opens a **Dialog (modal)**.
- The modal watches the run **live over Supabase Realtime** (`sync_runs` + `sync_run_events`); a run takes ~90s and walks through six report pipelines.
- Terminal states: CLEAN or DIFFS-PENDING with a findings list ("Copy for Claude" buttons, held rows). AI review is dormant — findings render as deterministic text.
- There is also a **Stop/cancel** path (`/cancel`).

## What to verify (live, with the browser tools)
Use the dev server (`preview_start` with the launch config; the ANTHROPIC_API_KEY quirk means `env -u ANTHROPIC_API_KEY` if you must start it by hand — but prefer preview_start). If the Browser pane isn't authenticated, ask Renzo to log in once in the pane, then continue. Resize to each viewport in the device matrix; dark mode pass included.

1. Is the **launcher button reachable and tappable** at 375px (not crushed by the digest header flex row)?
2. Open the modal at 375×812: does the Dialog fit, scroll internally, and remain readable through all run phases (queued → per-report progress → terminal summary)? A desktop-sized Dialog on a phone is the expected failure — confirm and characterize it.
3. The **findings list / held rows** at phone width: readable? Are the "Copy for Claude" buttons usable (clipboard works on iOS Safari)?
4. **Stop button** reachable mid-run on a phone?
5. Does anything rely on hover?
6. Realtime updates while the phone viewport is small — any layout jumping/scroll hijacking as events stream in?
7. The likely recommended pattern is **full-screen sheet on phones, Dialog at sm+** (precedent: the digest's mobile bottom-sheet work). Evaluate that against what you saw; name an alternative if it fits better.

## Constraints
- **Audit only.** No code changes except appending your result section to `docs/MOBILE_UI_AUDIT.md` + ticking P1 in its feature map.
- If you can trigger a run, prefer **dry-run** if the UI offers it; otherwise coordinate with Renzo before clicking a real Run Sync (it writes to production data paths — it's designed to be safe, but ask first).
- Do not audit the digest bands (that's Audit 02) or `/sync/cases` (Audit 06).

## Deliverable
Append the standard template section to `docs/MOBILE_UI_AUDIT.md` with screenshots as evidence, then reply with: verdicts per viewport, the ONE recommended pattern, and the S/M/L effort.
