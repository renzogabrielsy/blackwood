'use server';

import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import { startOfMonth, endOfMonth, format } from 'date-fns';

// ---------------------------------------------------------------------------
// Types — exported so the frontend table can import them directly.
// ---------------------------------------------------------------------------

/**
 * One batch-lane for a single day in the RC Movement table.
 * php_per_kg and php_total are null when the caller is a Production-role user.
 */
export type RcMovementRow = {
  batchCode: string;
  blockLoc: string | null;
  supplier: string | null;
  startBalance: number;
  batchFed: number;     // kg fed for this batch on this day (= view.fed_today)
  ttlFed: number;       // cumulative kg fed for this batch through this day (= view.cum_fed)
  pctLoss: number | null;
  phpPerKg: number | null;   // null when !canViewPrices
  phpTotal: number | null;   // null when !canViewPrices
  status: 'active' | 'closed';
  feedDayN: number;
};

/**
 * All batch-lanes for a single calendar day, plus day-level totals.
 * ttlPhp is null when the caller is a Production-role user.
 */
export type RcMovementDay = {
  date: string;         // YYYY-MM-DD
  day: number;          // day-of-month integer (1–31)
  ttlKg: number;        // sum of fed_today across all batches for this day
  ttlPhp: number | null; // sum of php_total across all batches (null when !canViewPrices)
  laneCount: number;    // number of batch rows on this day
  rows: RcMovementRow[];
};

/**
 * Top-level return type for fetchRcMovementData.
 */
export type RcMovementData = {
  days: RcMovementDay[];
  canViewPrices: boolean;
};

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

/**
 * Fetches RC Movement data for the given year/month.
 *
 * Queries view_rc_movement filtered to dates within the requested month,
 * groups by date in JavaScript (view already returns date DESC order),
 * computes day-level totals, and scrubs price columns for Production-role users.
 *
 * @param year  Calendar year (e.g. 2026)
 * @param month Calendar month 1-indexed (e.g. 5 = May)
 */
export async function fetchRcMovementData(
  year: number,
  month: number,
): Promise<RcMovementData> {
  const empty: RcMovementData = { days: [], canViewPrices: false };

  try {
    const supabase = await createClient();

    // --- Auth + role resolution ---
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return empty;
    }

    const role = await getUserRole(user.id);
    const canViewPrices = role !== 'Production';

    // --- Date range for requested month ---
    // Construct the first and last day strings directly to avoid date-fns
    // needing a Date object from year/month params.
    const refDate = new Date(year, month - 1, 1);
    const firstDay = format(startOfMonth(refDate), 'yyyy-MM-dd');
    const lastDay  = format(endOfMonth(refDate),   'yyyy-MM-dd');

    // --- Query view_rc_movement ---
    // The view exposes exactly the columns we need, so select('*') is safe and
    // keeps TypeScript's type inference happy (multi-line select strings break it).
    const { data: rows, error } = await supabase
      .from('view_rc_movement')
      .select('*')
      .gte('date', firstDay)
      .lte('date', lastDay)
      .order('date', { ascending: false })
      .order('batch_id', { ascending: true });

    if (error) {
      console.error('[RcMovement] view_rc_movement query error:', error);
      return { ...empty, canViewPrices };
    }

    if (!rows || rows.length === 0) {
      return { days: [], canViewPrices };
    }

    // --- Group by date ---
    // View returns date DESC; we process in that order and collect day groups.
    const dayMap = new Map<string, RcMovementDay>();

    for (const r of rows) {
      const dateStr = r.date as string; // YYYY-MM-DD

      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, {
          date:       dateStr,
          day:        parseInt(dateStr.slice(8, 10), 10),
          ttlKg:      0,
          ttlPhp:     canViewPrices ? 0 : null,
          laneCount:  0,
          rows:       [],
        });
      }

      const day = dayMap.get(dateStr)!;

      const fedToday  = Number(r.fed_today  ?? 0);
      const phpTotal  = canViewPrices ? (r.php_total  !== null ? Number(r.php_total)  : null) : null;
      const phpPerKg  = canViewPrices ? (r.php_per_kg !== null ? Number(r.php_per_kg) : null) : null;

      const lane: RcMovementRow = {
        batchCode:    r.batch_code   as string,
        blockLoc:     (r.block_loc   as string | null) ?? null,
        supplier:     (r.supplier    as string | null) ?? null,
        startBalance: Number(r.start_balance ?? 0),
        batchFed:     fedToday,
        ttlFed:       Number(r.cum_fed       ?? 0),
        pctLoss:      r.pct_loss !== null ? Number(r.pct_loss) : null,
        phpPerKg,
        phpTotal,
        status:       (r.status as 'active' | 'closed'),
        feedDayN:     Number(r.feed_day_n ?? 1),
      };

      day.rows.push(lane);
      day.ttlKg += fedToday;
      day.laneCount += 1;

      if (canViewPrices && phpTotal !== null) {
        day.ttlPhp = (day.ttlPhp ?? 0) + phpTotal;
      }
    }

    // dayMap iteration is insertion-order, which matches the date DESC ordering
    // from the view — no additional sort needed.
    const days = Array.from(dayMap.values());

    return { days, canViewPrices };

  } catch (err) {
    console.error('[RcMovement] fetchRcMovementData failed:', err);
    return empty;
  }
}
