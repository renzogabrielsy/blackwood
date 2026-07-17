'use client';

/**
 * HOME — view toggle (Digest board ↔ Production schedule)
 *
 * The `/` page hosts two surfaces; the active one is URL-driven via
 * `?view=digest|schedule` (shareable, refresh-safe, browser-Back aware) using the
 * project's house style (useSearchParams + router.replace — NOT nuqs), mirroring
 * `app/(app)/summaries/summaries-client.tsx`'s `?view=period|supplier` switcher.
 *
 * `digest` is the DEFAULT, so selecting it DROPS the param (clean `/` URL).
 * Switching away from the schedule also drops `?month=` — that param only means
 * something to the schedule view, and leaving it behind would make the digest URL
 * carry dead state.
 *
 * The page itself branches server-side on the same param (so only the selected
 * surface is fetched); this control's only job is to write the URL. The active
 * `view` is passed in from the server (already parsed) so the segment highlight
 * is correct on first paint.
 */

import { Suspense, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

export type HomeView = 'digest' | 'schedule';

const VIEWS: { id: HomeView; label: string }[] = [
  { id: 'digest', label: 'Digest' },
  { id: 'schedule', label: 'Schedule' },
];

/* ------------------------------------------------------------------ */
/* Inner — reads search params (must sit under a Suspense boundary)     */
/* ------------------------------------------------------------------ */

function HomeViewToggleShell({ view }: { view: HomeView }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setView = useCallback(
    (next: HomeView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'digest') {
        // Keep the URL clean: "digest" is the default, so drop the param —
        // and drop the schedule-only month cursor with it.
        params.delete('view');
        params.delete('month');
      } else {
        params.set('view', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return (
    <div
      role="tablist"
      aria-label="Home view"
      // Full-width segments on phones (the digest is the flagship phone surface —
      // 44px-tall, thumb-sized targets), inline pill from `sm` up.
      className="inline-flex w-full items-center gap-0.5 rounded-md border border-border bg-muted/50 p-0.5 sm:w-auto"
    >
      {VIEWS.map((v) => {
        const active = view === v.id;
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setView(v.id)}
            className={cn(
              'flex-1 rounded-sm px-3 py-2 text-xs font-medium transition-all duration-150 sm:flex-none sm:py-1',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export — Suspense wrapper (useSearchParams requires one in App Router) */
/* ------------------------------------------------------------------ */

export function HomeViewToggle({ view }: { view: HomeView }) {
  return (
    <Suspense fallback={null}>
      <HomeViewToggleShell view={view} />
    </Suspense>
  );
}
