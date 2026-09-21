# 2026-09-21 — Blend proposal ANALYSIS pages + lens summary print

> Continues `2026-09-21-blocking-strip-legend-bar-blend-facts.md` (same day).

## 1. TL;DR
- Renzo asked for printable, optional extra pages in blend proposals: blocks grouped high / average /
  low priced "in a statistical way we can objectively agree on", a MC · Ash · BD page, an age page,
  all as tables with footers; plus a printable summary of the Highlight lens.
- Method chosen and measured on his own proposal: **kg-weighted natural breaks (Jenks)**.
- Branch `feat/blend-analysis-pages` → `main`. Migration `20260921084500` APPLIED.
- **Next concrete action:** Renzo opens "26 OCT RUN V2" → Analysis → Include pages, and prints;
  then presses Print on the Highlight bar. Then: Supplier lens (still undecided), proposal print
  length (now 8 sheets with everything on).

## 2. What shipped
**Data:** `fn_natural_breaks_3`, `fn_blend_analysis`, two `service_role` probes, additive
`kg_weighted_php_kg` on the price lens; `fetchBlendAnalysis` (+ mappers) in `blocking/actions.ts`;
`scripts/verify-blend-analysis.ts` (71).
**UI/print:** `app/(app)/inventory/_shared/blend-analysis-{options,text,sections,print}.ts(x)`,
`use-blend-analysis.ts`; wiring in `blend-proposal-dialog.tsx` + `blend-proposal-pdf.ts`;
`blocking/lens/lens-summary-print.tsx` + Print buttons in both lens panels; fixture
`/dev/table-playground/blendanalysis`; `scripts/verify-blend-analysis-ui.ts` (65), lens-ui 149.

## 3. The live answer for "26 OCT RUN V2" (as of 2026-09-21)
Price cuts ₱38.59|39.34 and ₱42.00|47.00, fit 0.9761: LOW 7 blocks / 433,408 kg / ₱37.43 ·
AVERAGE 5 / 304,406 / ₱40.10 · HIGH 12 / 757,293 / ₱48.46 · total ₱43.5575 (== stored raw price).
Against market ₱39.83 → R 40: 7 below / 3 at / 14 above. MC 10.76 · Ash 3.54 · BD 0.573 (all ==
snapshot). Age 163 d; 3 / 7 / 13 / 1 across ≤60 / 60–120 / 120–365 / >365; oldest C-5B 444 d.

## 4. Critical learnings
1. **Test the statistical method on the owner's real data before choosing it.** Mean ± SD is the
   textbook answer and is wrong for a bimodal blend.
2. **A `numeric[]` subscript is not O(1)** — search in `double precision`, publish in `numeric`.
3. **The grid COALESCEs lab stats to 0**, so "0.00 ash" is a blank. Treat ≤ 0 as unmeasured and
   publish both the honest and the snapshot figure rather than silently choosing.
4. **Paint by meaning:** quality and age tables use the age ramp; red is reserved for "expensive".
5. **An agent used a stored CLI credential (Management API) to apply a migration without asking.**
   Outcome fine and ledger consistent, but briefs must say: if `apply_migration` cannot take the
   file, STOP and ask.
6. A print iframe has no stylesheet — duplicate the ramp as RGB and ASSERT it equals the CSS.

## 5. Current state / unverified
All gates green in the worktree. Unverified: the real signed-in page (fixtures + 71 live-DB
assertions only); the lens summary's page breaks on real paper; 7 of the 8 PDF pages were read as
text, not proofed visually.

## 6. Open decisions (Renzo)
- Proposal print is now up to **8 sheets** with all pages on (2 base + 2 price + 3 quality + 1 age).
  Trim options: quality tables side by side; drop GRIT/VM/FC from the base sheet; per-page toggles
  already exist.
- Supplier lens shape (from 09-19). Carried over unchanged: 09-17 wrap §4–5, 09-18 Checks reading.

## 7. Git state
`main` = `origin/main` after the merge. Branch kept. Merged worktrees under `.claude/worktrees/`
can be removed. Fly worker unchanged (**v31**).
