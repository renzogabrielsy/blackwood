# 2026-09-21 — Blocking round 2: stuck lens fixed, header strip, legend bar, blend supplier/age

> Continues `2026-09-19-blocking-age-lens.md`. Driven by Renzo's three screenshots of the LIVE page.

## 1. TL;DR
- The Highlight lens **never resolved on the real page** (stuck "Sorting the yard into bands…").
  Root cause found by reading the data path, fixed, and guarded by new assertions.
- Header is now ONE strip in four fixed sections; the 300px lens sidebar is replaced by a
  one-line legend bar + a settings popover; the blend "Selected blocks" table shows supplier
  dominance (green/orange) and two ages, as of the version's own save date.
- Branch `feat/blocking-strip-legend-blend-facts` → `main`. Migration `20260921034512` APPLIED.
- **Next concrete action:** Renzo confirms on the live page that (a) the lens now tints, (b) the
  strip holds still, (c) the legend bar reads well. Then: proposal print to one page (§5), and the
  Supplier lens (open decision from 09-19).

## 2. What shipped
- **Data:** `fn_blend_block_facts` + probe; `fn_blocking_price_lens(…, p_rounded_up_php)`;
  `fetchBlendBlockFacts`, `roundedUpPhp` on `fetchBlockingPriceLens`; `verify-blend-block-facts.ts`
  (42), `verify-blocking-price-lens.ts` (61).
- **UI:** `blocking-route-view.tsx` (single-navigation exclusivity), `blocking-grid.tsx` (four-
  section strip, legend bar mount, no docked row), `lens/lens-panel.tsx` (legend bar),
  `lens/lens-settings-popover.tsx` (new), `lens/{price,age}-lens-panel.tsx` (mount-frame first
  request, signature guard, `LENS_STALL_MS` watchdog), `lens/lens-band-rows.tsx` (compact variant),
  `_shared/blend-proposal-dialog.tsx` + `_shared/blend-proposal-pdf.ts` (SUPPLIER · OPENED ·
  LAST PILED), fixture `/dev/table-playground/blockinghead`, `verify-blocking-lens-ui.ts` (139).

## 3. Critical learnings
1. **Two `router.replace` calls in one tick, both built from the same stale `searchParams`, race.**
   With a `useOptimistic` mirror the URL-driven id flips A → null → A and REMOUNTS whatever it
   gates. One interaction = one navigation; put cross-param rules in the route, in ONE
   `URLSearchParams`.
2. **Never let the only request live inside a debounce timer whose cleanup runs on unmount.**
   First request on the mount frame; debounce only the subsequent ones.
3. **Guard replies by request SIGNATURE, not a monotonic counter** — a counter discards the reply
   you still want after an unrelated re-run.
4. **An eternal spinner is a bug report nobody can file.** Stall watchdog → copyable banner + Retry.
5. **A fixture adapter that resolves in a microtask hides latency races.** Give it a real delay.
6. **Reserve space for what a toggle hides** (`invisible` slots, fixed-width pills) or sections shift.
7. Briefs must say "NEVER `git stash`" outright — a worktree agent did it anyway (restored cleanly).

## 4. Current state
All gates green in the worktree (tsc, build, lint baseline, 61 + 49 + 42 + 23 + 139 assertions).
Strip section boxes measured identical before/after toggling every mode at 1512 / 1280 / 1024 px.
**Unverified:** everything on the real signed-in page — the Job A diagnosis is from reading the
path, not from reproducing the stall; fixtures used injected adapters.

## 5. Known issues / open
- **Proposal print = 2 pages at 24 blocks** (A4 landscape, 7 pt floor held; break after row ~23).
  Options: drop GRIT/VM/FC from the print, a tighter summary header, or accept two pages. Renzo's call.
- Supplier lens shape still undecided (top-suppliers-as-bands recommended; dominant-supplier colour
  with a "mixed" marker). `fn_blend_block_facts` already yields dominance per batch and can feed it.
- Carried over unchanged: 09-17 wrap §4–5, 09-18 Checks-tab reading.

## 6. Git state
`main` = `origin/main` after the merge. Branch kept. Merged worktrees under `.claude/worktrees/`
can be removed. Fly worker unchanged (**v31**).

## 7. ADDENDUM (same day) — the strip still wrapped on the live page
Renzo's follow-up screenshot: totals 4+1, toggles 3+1, a hole beside the search. Cause: a `flex-wrap`
row's max-content is its ONE-LINE width, so section 1 over-claimed 620px and starved its neighbours.
Fixed on `fix/blocking-strip-wrap`: section 1 built stacked, totals `nowrap` on a `max-content` track,
modes a 4-or-2 grid, spare width between sections. **Lesson: a section that always renders stacked
must be BUILT stacked.** Cost: the strip scrolls sideways below ~1300px. Still unverified on the real
signed-in page; Renzo has not yet confirmed whether the lens now tints or the blend columns show.
