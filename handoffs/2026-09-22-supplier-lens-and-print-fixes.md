# 2026-09-22 — SUPPLIER LENS + print fixes from Renzo's review (Blocking round 3)

> Continues `2026-09-21-blend-analysis-pages-and-lens-print.md`.

## 1. TL;DR
- Renzo reviewed the live analysis pages and lens print: page break after every table; terse
  captions everywhere; "against set price" not "market" for a typed price; lens print retitled
  (`Price lens`), no subheading, blocks grouped by WAREHOUSE with lab data instead of three
  columns; and the Supplier lens.
- All five shipped on `feat/blocking-supplier-lens` → `main`. Migration `20260922011759` APPLIED
  (via MCP `apply_migration`, no stored credential).
- **Next concrete action:** Renzo tries the Supplier tab (tint, mixed outline, isolate), prints a
  lens and a proposal. Then the open items in §5.

## 2. What shipped
**Data:** `fn_blocking_supplier_lens` + probe; `fetchBlockingSupplierLens` (auth check, no price
gate); `scripts/verify-blocking-supplier-lens.ts` (48).
**UI/print:** `lens/supplier-lens-{settings,panel}`, `lens/lens-summary-model.ts`, palette +
`ramp: 'category'` in `lens-ramp.ts`, `.lens-cat-0…12` + `SUPPLIER_LENS_MIXED_CLASS` in
`globals.css`, `registry.ts` = `[PRICE, AGE, SUPPLIER]`; `_shared/blend-analysis-text.ts`
(captions), `blend-analysis-print.ts` + `blend-proposal-pdf.ts` (one table per page),
`lens-summary-print.tsx` (redesign); fixture `/dev/table-playground/supplierlens`;
lens-ui 167, blend-analysis-ui 82.

## 3. Live numbers (2026-09-22, top 6)
Ornales 78 dominant / 4,397,468 kg apportioned / 41.8% · Paquibot 58 / 36.3% · 2023 Backlog 11 /
7.3% · Llanto 7 / 3.8% (6 mixed) · Sevilla 5 / 2.9% · Layupan 6 / 2.8% (5 mixed) · Others (11
suppliers) 5 / 5.0%. 170 blocks / 10,515,408 kg / 17 suppliers / 23 mixed / 0 unattributed.

## 4. Critical learnings
1. **`view_blocking_block_suppliers.kg` is DELIVERED kilos, not balance.** Apportion the balance
   by share; publish the delivered figure separately. The gap grows on every feeding.
2. **A nominal category needs one colour per identity, identity-mapped** — positional colours move
   when N changes. Avoid hues another vocabulary on the page already owns.
3. **Fixing an orphan heading by moving the break can recreate the orphan** — an `h2` + intro alone
   on a page is the same bug. Remove the sub-heading level; one table per page.
4. **`share_pct` at finite scale cannot re-sum bit-exactly** — bound THAT fold, keep the rest exact,
   and say so in the COMMENT.
5. The one sanctioned TypeScript accumulation (warehouse kg subtotal in a print) must be proven to
   fold back to a published figure; weighted averages stay banned.
6. The Browser pane cannot screenshot a Radix portal — verify popovers by DOM.

## 5. Open / next
- Nothing from rounds 1–3 has been exercised on the real signed-in page by an agent; Renzo's own use
  is the verification. The 12-hue palette vs the live 17 suppliers is unseen.
- `PRICE_LENS.blurb` still says "against market" (describes the lens, not the basis) — flip to
  basis-aware if Renzo dislikes it.
- Two earlier migrations carry a local-name / remote-version skew (`blocking_age_lens`,
  `blend_block_facts_…`); harmless, but `db push` bookkeeping may one day complain.
- Proposal print with all pages on is 8 sheets. Carried over: 09-17 wrap §4–5, 09-18 Checks reading.

## 6. Git state
`main` = `origin/main` after the merge. Branch kept. Merged worktrees under `.claude/worktrees/`
can be removed. Fly worker unchanged (**v31**).

## 7. ADDENDUM (same day) — yard map page in the lens print
Renzo asked for the block arrangement printed in solid colours, loc centred and big, all blocks on one
landscape page. Shipped on `feat/lens-print-yard-map`: page 2 of every lens print. Cells 13.6 mm / 11 pt
(10.4 mm / 10 pt with PCA/PCB), locs wrap at the hyphen rather than shrink, bold mono advance 0.63 em,
ink chosen by luminance. Lesson: **a map that shares a data-sized page is legible only by luck** — give it
its own page. Unverified on the live 170-block yard.
