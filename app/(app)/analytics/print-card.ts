// MOVED 2026-09-16 → `components/shared/print/print-card.ts` (platform layer: it
// carries zero tenant knowledge — it is a DOM + `window.print()` mechanism).
// This one-line re-export keeps every existing analytics import path working, so
// nothing on this page moved.
export { printCard } from "@/components/shared/print/print-card";
