/**
 * findingsBridge.ts — THE ONE PLACE the worker reaches into the app's module graph.
 *
 * WHY THIS EXISTS. The Excel report must list exactly what the Sync panel lists: every
 * held row, every source disagreement, every price note, every quiet stream. That list has
 * a single definition — `lib/sync/findings.ts::flattenRunFindings` — and the project rule
 * is explicit that a second one must not be written ("reuse the existing finding
 * vocabulary; do not introduce a parallel taxonomy"). A worker-local re-implementation
 * would be exactly that: two flatteners that agree on the day they are written and drift
 * the first time a channel is added to only one of them.
 *
 * So the worker imports the app's flattener directly. That is safe because
 * `lib/sync/findings.ts` and its two dependencies are provably portable:
 *   - `lib/sync/findings.ts`       — imports only `./cases-fold`, `./portable-hash` and the
 *                                    shared contract types.
 *   - `lib/sync/cases-fold.ts`     — imports only the shared contract types.
 *   - `lib/sync/portable-hash.ts`  — ZERO imports (that is the whole point of the file:
 *                                    sha256 without `node:crypto`, so it ships to a browser).
 *   - `app/(app)/sync/types.ts`    — ZERO imports. Types plus a handful of const tables.
 *
 * That closure is ALSO the container's file set. It is enumerated in `workers/sync/Dockerfile`
 * and `.dockerignore`, and `npm run verify:container-build` is the gate that turns forgetting
 * one into a red build rather than a broken deploy. On 2026-08-19 `portable-hash.ts` joined
 * the closure and neither file followed — the gate was red, and nobody had run it.
 * No React, no `@/` path alias, no `next/*`, no `node:crypto`, no Supabase client. The
 * module's own header already commits to being pure and client-safe; "worker-safe" is the
 * same property.
 *
 * DIRECTION MATTERS. The forbidden direction is app -> worker (which is why
 * `app/(app)/sync/types.ts` hand-MIRRORS the worker's reconciliation shapes instead of
 * importing them). This is the opposite direction, worker -> app-pure-module, and it goes
 * through this one file: if it ever needs reversing, there is exactly one import to move.
 *
 * The relative path is deliberate — the worker has no `@/` alias, and inventing one here
 * would make the crossing invisible. `workers/sync/tsconfig.json` therefore sets no
 * `rootDir` (it never emits: `npm run build` is esbuild, `npm run typecheck` is
 * `tsc --noEmit`).
 */
export {
  flattenRunFindings,
  formatFindingData,
  isCostKey,
  summarizeFindings,
  type FindingSection,
  type FindingSeverity,
  type RunFinding,
} from "../../../../../lib/sync/findings";

export type {
  ReconciliationChannel as AppReconciliationChannel,
  SyncRunResult as AppSyncRunResult,
} from "../../../../../app/(app)/sync/types";
