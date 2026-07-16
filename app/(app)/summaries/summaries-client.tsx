'use client';

/**
 * SUMMARIES — client shell (view toggle host)
 *
 * Owns the top-level "By Period" / "By Supplier" toggle for the Summaries
 * module. The active view is URL-driven via `?view=period|supplier` (shareable,
 * refresh-safe, browser-Back aware) using the project's house style
 * (useSearchParams + router.replace), matching how the inventory routes drive
 * `?tab=`. No page <h1> here — the navbar owns the title (breadcrumb registry).
 *
 *   • "By Period"   → the existing AnalystBriefClient (period analytics),
 *                     fed the period props from the server component.
 *   • "By Supplier" → a placeholder slot the supplier agent will replace with
 *                     <SupplierBriefClient .../> (see SUPPLIER_VIEW_SLOT below).
 */

import { Suspense, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import AnalystBriefClient from '../price-demos/demo4/analyst-brief-client';
import SupplierBriefClient from './supplier-brief-client';
import type {
  MonthlyDeliveryRow,
  Totals,
} from '../price-demos/demo4/actions';
import type { SupplierYearSummary } from './actions';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Props                                                              */
/* ------------------------------------------------------------------ */

/** The exact period payload AnalystBriefClient consumes (plus optional error). */
interface PeriodData {
  years: number[];
  byYear: Record<number, MonthlyDeliveryRow[]>;
  totalsByYear: Record<number, Totals>;
  canViewPrices: boolean;
  error?: string;
}

/** The supplier payload SupplierBriefClient consumes (plus optional error). */
interface SupplierData {
  years: number[];
  byYear: Record<number, SupplierYearSummary[]>;
  canViewPrices: boolean;
  error?: string;
}

interface SummariesClientProps {
  /** Period analytics fetched server-side (reused demo4 action). */
  period: PeriodData;
  /** Supplier analytics fetched server-side (fetchSupplierAnalytics). */
  supplier: SupplierData;
}

type SummaryView = 'period' | 'supplier';

const VIEWS: { id: SummaryView; label: string }[] = [
  { id: 'period', label: 'By Period' },
  { id: 'supplier', label: 'By Supplier' },
];

/* ------------------------------------------------------------------ */
/* Inner — reads search params (must sit under a Suspense boundary)     */
/* ------------------------------------------------------------------ */

function SummariesShell({ period, supplier }: SummariesClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Default view is "By Period" — any unknown/absent value falls back to it.
  const raw = searchParams.get('view');
  const view: SummaryView = raw === 'supplier' ? 'supplier' : 'period';

  const setView = useCallback(
    (next: SummaryView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'period') {
        // Keep the URL clean: "period" is the default, so drop the param.
        params.delete('view');
      } else {
        params.set('view', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="flex w-full flex-col">
      {/* ---- Header strip — toggle pinned right (navbar owns the title) ---- */}
      <div className="flex items-center justify-end border-b border-border bg-background/95 px-5 py-2 backdrop-blur supports-backdrop-filter:bg-background/60 lg:px-6">
        <div
          role="tablist"
          aria-label="Summary view"
          className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/50 p-0.5"
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
                  'rounded-sm px-3 py-1 text-xs font-medium transition-all duration-150',
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
      </div>

      {/* ---- Active view ---- */}
      {view === 'period' ? (
        <AnalystBriefClient
          years={period.years}
          byYear={period.byYear}
          totalsByYear={period.totalsByYear}
          canViewPrices={period.canViewPrices}
          error={period.error}
        />
      ) : (
        <SupplierBriefClient
          years={supplier.years}
          byYear={supplier.byYear}
          canViewPrices={supplier.canViewPrices}
          error={supplier.error}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export — Suspense wrapper (useSearchParams requires one in App Router) */
/* ------------------------------------------------------------------ */

export function SummariesClient(props: SummariesClientProps) {
  return (
    <Suspense fallback={null}>
      <SummariesShell {...props} />
    </Suspense>
  );
}
