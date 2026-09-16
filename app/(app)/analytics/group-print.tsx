// MOVED 2026-09-16 → `components/shared/print/group-print.tsx` (platform layer),
// alongside `printCard`. `/operations`' price modals print one sheet per campaign
// through the identical machinery. This one-line re-export keeps every existing
// analytics import path working, so nothing on this page moved.
export {
  GroupPrintStage,
  GroupPrintPage,
  type GroupPrintStageProps,
} from "@/components/shared/print/group-print";
