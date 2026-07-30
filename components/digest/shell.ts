/**
 * The shared page-shell container for the two surfaces that host the Production
 * Schedule: the home digest's `?view=schedule` branch (`app/(app)/page.tsx`) and
 * the standalone `/production/schedule` route.
 *
 * It lives in its own module purely so those two entry points can never drift
 * apart — they must feel like ONE surface reached by two doors, not two pages
 * that happen to render the same table (see docs/BUG_LEDGER.md → BUG-003).
 *
 * Not a component and not tenant-shaped: a class string, nothing else.
 */
export const HOME_SHELL_CLS =
  "mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5";
