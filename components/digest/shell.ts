/**
 * The page-shell container for the Home Digest (`app/(app)/page.tsx`).
 *
 * It has its own module for a historical reason: `/` used to host a second
 * surface (`?view=schedule`) and `/production/schedule` a second door onto it,
 * and the three had to be pixel-identical (docs/BUG_LEDGER.md → BUG-003). That
 * feature was retired on 2026-08-28 (see `_archived/prod-schedule-v1/`), so
 * there is one consumer again. Kept as a constant rather than inlined because
 * `app/(app)/loading.tsx` must reproduce the same container for its skeleton.
 *
 * Not a component and not tenant-shaped: a class string, nothing else.
 */
export const HOME_SHELL_CLS =
  "mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5";
