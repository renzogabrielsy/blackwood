// MOVED 2026-09-15 → `components/shared/unit-value.tsx` (platform layer: it carries
// zero tenant knowledge). This one-line re-export keeps every existing analytics
// import path working, so nothing on this page moved.
export { UnitValue } from "@/components/shared/unit-value";
