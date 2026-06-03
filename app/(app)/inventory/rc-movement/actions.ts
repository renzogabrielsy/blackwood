'use server';

import { createClient } from '@/lib/supabase/server';

// ===========================================================================
// RC MOVEMENT MATRIX (cross-tab / pivot)  — v1 structural prototype
// ---------------------------------------------------------------------------
// Reshapes view_rc_movement into a day-by-block matrix:
//   ROWS    = every calendar day from the cycle's first feed date to its last
//             (zero-feed days included so open/close edges are visible).
//   COLUMNS = each opened block (source batch consumed) during the month,
//             ordered by FIRST feed date (tie-break batch_code ASC).
//   CELLS   = kg fed from that block on that day (view.fed_today), already
//             aggregated in SQL — TS only sums fed_today for the row total.
// No prices / lab columns in v1 (deferred — structure first).
// ===========================================================================

/** One block (source batch) consumed during the month — a matrix column. */
export type RcMovementMatrixColumn = {
  batchId: string;
  batchCode: string;
  blockLoc: string | null;
  firstFedDate: string; // YYYY-MM-DD — drives chronological column order
  // ── Summary fields (footer) — computed in one batched pass over the month's
  //    batches. mc/ash are weighted averages from RC IN deliveries (same approach
  //    as Blocking's fetchBlockDataForBatch). totalOut/totalIn are SUMs from SQL.
  totalOut: number;      // total kg fed out of this block (all-time, SUM rc_out.weight_kg)
  totalIn: number;       // total kg delivered into this block (all-time, SUM deliveries.weight_kg)
  status: string;        // batches.status — drives IN-USE / CLOSED badge in the footer
  mc: number;            // weighted-avg moisture % (0 when no metric-bearing deliveries)
  ash: number;           // weighted-avg ash % (0 when no metric-bearing deliveries)
  blockLoss: number | null; // (totalOut - totalIn) / totalIn, signed ratio; null when totalIn = 0
};

/** One calendar day — a matrix row. */
export type RcMovementMatrixRow = {
  rowNum: number;        // 1-based sequential index within the visible range
  date: string;          // YYYY-MM-DD
  dayOfWeek: string;     // Mon / Tue / …
  productionBatch: string | null; // dominant non-null production_batch for the day
  totalFed: number;      // sum of fed_today across all blocks this day (kg)
  /** batchId -> kg fed that day. Absent key = no feed (blank cell). */
  fedByBatch: Record<string, number>;
};

/** A selectable cycle-month for the picker. */
export type RcMovementMonthOption = {
  value: string; // YYYY-MM
  label: string; // e.g. "May 2026"
  feedDays: number;
};

/** Top-level return type for fetchRcMovementMatrix. */
export type RcMovementMatrix = {
  month: string;                       // resolved YYYY-MM
  columns: RcMovementMatrixColumn[];
  rows: RcMovementMatrixRow[];
  monthOptions: RcMovementMonthOption[];
  /** Sum of fed_today across the whole visible month (footer grand total, kg). */
  grandTotalFed: number;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse a YYYY-MM-DD string into a stable, timezone-neutral Date (UTC noon). */
function parseDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** YYYY-MM-DD for a UTC Date. */
function fmtDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/**
 * Fetches and pivots RC Movement data for one cycle-month.
 *
 * @param month YYYY-MM. When omitted/invalid, defaults to the most recent
 *              month with more than 2 feeding days.
 */
export async function fetchRcMovementMatrix(month?: string): Promise<RcMovementMatrix> {
  const empty: RcMovementMatrix = { month: '', columns: [], rows: [], monthOptions: [], grandTotalFed: 0 };

  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return empty;

    // --- Paginated fetch helper (bypass PostgREST max_rows = 1000) ---
    const PAGE = 1000;
    async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
      let all: T[] = [];
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await buildQuery().range(from, from + PAGE - 1);
        if (error) throw error;
        all = all.concat((data ?? []) as T[]);
        hasMore = (data?.length ?? 0) === PAGE;
        from += PAGE;
      }
      return all;
    }

    // --- Build month options from all feed-bearing dates ---
    type DateRow = { date: string | null; fed_today: number | null };
    const allDates = await fetchAll<DateRow>(() =>
      supabase
        .from('view_rc_movement')
        .select('date, fed_today')
        .gt('fed_today', 0)
        .order('date', { ascending: false }),
    );

    const monthFeedDays = new Map<string, Set<string>>();
    for (const r of allDates) {
      if (!r.date) continue;
      const ym = r.date.slice(0, 7);
      if (!monthFeedDays.has(ym)) monthFeedDays.set(ym, new Set());
      monthFeedDays.get(ym)!.add(r.date);
    }

    const monthOptions: RcMovementMonthOption[] = Array.from(monthFeedDays.entries())
      .map(([ym, days]) => {
        const dt = parseDate(`${ym}-01`);
        const label = dt.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        return { value: ym, label, feedDays: days.size };
      })
      .sort((a, b) => (a.value < b.value ? 1 : -1)); // most recent first

    // --- Resolve target month (default = most recent with >2 feed days) ---
    let target = month && /^\d{4}-\d{2}$/.test(month) ? month : '';
    if (!target || !monthFeedDays.has(target)) {
      target = monthOptions.find((o) => o.feedDays > 2)?.value
        ?? monthOptions[0]?.value
        ?? '';
    }
    if (!target) return { ...empty, monthOptions, grandTotalFed: 0 };

    const firstOfMonth = `${target}-01`;
    const nextMonth = (() => {
      const [y, m] = target.split('-').map(Number);
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      return `${ny}-${String(nm).padStart(2, '0')}-01`;
    })();

    // --- Fetch all movement rows for the month ---
    type MovementRow = {
      date: string | null;
      batch_id: string | null;
      batch_code: string | null;
      block_loc: string | null;
      fed_today: number | null;
    };
    const rows = await fetchAll<MovementRow>(() =>
      supabase
        .from('view_rc_movement')
        .select('date, batch_id, batch_code, block_loc, fed_today')
        .gte('date', firstOfMonth)
        .lt('date', nextMonth)
        .gt('fed_today', 0)
        .order('date', { ascending: true })
        .order('batch_id', { ascending: true }),
    );

    if (rows.length === 0) {
      return { month: target, columns: [], rows: [], monthOptions, grandTotalFed: 0 };
    }

    // --- Build columns: one per block, ordered by first fed date ---
    const colMap = new Map<string, RcMovementMatrixColumn>();
    for (const r of rows) {
      if (!r.batch_id || !r.date) continue;
      const existing = colMap.get(r.batch_id);
      if (!existing) {
        colMap.set(r.batch_id, {
          batchId: r.batch_id,
          batchCode: r.batch_code ?? r.batch_id,
          blockLoc: r.block_loc && r.block_loc.trim() !== '' ? r.block_loc : null,
          firstFedDate: r.date,
          // Summary fields filled in the batched pass below (see "Footer summary").
          totalOut: 0,
          totalIn: 0,
          status: 'CLOSED',
          mc: 0,
          ash: 0,
          blockLoss: null,
        });
      } else if (r.date < existing.firstFedDate) {
        existing.firstFedDate = r.date;
      }
    }
    const columns = Array.from(colMap.values()).sort((a, b) => {
      if (a.firstFedDate !== b.firstFedDate) return a.firstFedDate < b.firstFedDate ? -1 : 1;
      return a.batchCode.localeCompare(b.batchCode);
    });

    // --- Pivot cells: date -> (batchId -> fed kg), plus row totals ---
    const dayMap = new Map<string, { totalFed: number; fedByBatch: Record<string, number> }>();
    let minDate = rows[0].date as string;
    let maxDate = rows[0].date as string;
    for (const r of rows) {
      if (!r.date || !r.batch_id) continue;
      if (r.date < minDate) minDate = r.date;
      if (r.date > maxDate) maxDate = r.date;
      const kg = Number(r.fed_today ?? 0);
      if (!dayMap.has(r.date)) dayMap.set(r.date, { totalFed: 0, fedByBatch: {} });
      const day = dayMap.get(r.date)!;
      day.fedByBatch[r.batch_id] = (day.fedByBatch[r.batch_id] ?? 0) + kg;
      day.totalFed += kg;
    }

    // --- Dominant non-null production_batch per date (the "Batch" column) ---
    // Isolated query so it's a one-column change if the user meant otherwise.
    type RcOutRow = { transaction_date: string | null; production_batch: string | null; weight_kg: number | null };
    const rcOutRows = await fetchAll<RcOutRow>(() =>
      supabase
        .from('rc_out')
        .select('transaction_date, production_batch, weight_kg')
        .gte('transaction_date', firstOfMonth)
        .lt('transaction_date', nextMonth)
        .not('production_batch', 'is', null),
    );
    const pbWeight = new Map<string, Map<string, number>>(); // date -> pb -> weight
    for (const r of rcOutRows) {
      if (!r.transaction_date || !r.production_batch) continue;
      if (!pbWeight.has(r.transaction_date)) pbWeight.set(r.transaction_date, new Map());
      const m = pbWeight.get(r.transaction_date)!;
      m.set(r.production_batch, (m.get(r.production_batch) ?? 0) + Number(r.weight_kg ?? 0));
    }
    const dominantPb = (date: string): string | null => {
      const m = pbWeight.get(date);
      if (!m) return null;
      let best: string | null = null;
      let bestW = -1;
      for (const [pb, w] of m) {
        if (w > bestW) { bestW = w; best = pb; }
      }
      return best;
    };

    // --- Emit one row per calendar day from minDate..maxDate (gaps included) ---
    const out: RcMovementMatrixRow[] = [];
    let cursor = parseDate(minDate);
    const last = parseDate(maxDate);
    let rowNum = 1;
    while (cursor.getTime() <= last.getTime()) {
      const ymd = fmtDate(cursor);
      const day = dayMap.get(ymd);
      out.push({
        rowNum: rowNum++,
        date: ymd,
        dayOfWeek: DOW[cursor.getUTCDay()],
        productionBatch: dominantPb(ymd),
        totalFed: day?.totalFed ?? 0,
        fedByBatch: day?.fedByBatch ?? {},
      });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }

    // --- Footer summary: one batched pass over the month's block-batches -------
    // Per column we surface: status (badge), totalIn (RC IN SUM), totalOut (RC OUT
    // SUM), weighted-avg mc/ash, and a derived blockLoss = (out - in) / in.
    // Computed via THREE batched queries keyed on the column batch_ids/codes —
    // NEVER one per-column action. mc/ash weighting mirrors fetchBlockDataForBatch
    // (SUM(metric * weight) / SUM(weight_with_metric)); the SUMs themselves are the
    // already-stored transaction weights, not a re-derivation of inventory state.
    const batchIds = columns.map((c) => c.batchId);
    const batchCodes = Array.from(new Set(columns.map((c) => c.batchCode)));

    type BatchRow = { id: string; status: string | null };
    type DeliveryRow = { batch_code: string | null; weight_kg: number | null; lab_results: unknown };
    type RcOutSumRow = { batch_id: string | null; weight_kg: number | null };

    const [batchRows, deliveryRows, rcOutSumRows] = await Promise.all([
      fetchAll<BatchRow>(() =>
        supabase.from('batches').select('id, status').in('id', batchIds),
      ),
      fetchAll<DeliveryRow>(() =>
        supabase
          .from('deliveries')
          .select('batch_code, weight_kg, lab_results')
          .in('batch_code', batchCodes),
      ),
      fetchAll<RcOutSumRow>(() =>
        supabase.from('rc_out').select('batch_id, weight_kg').in('batch_id', batchIds),
      ),
    ]);

    // status by batch_id
    const statusById = new Map<string, string>();
    for (const b of batchRows) {
      if (b.id) statusById.set(b.id, b.status ?? 'CLOSED');
    }

    // totalIn + weighted mc/ash accumulators, keyed by batch_code (deliveries link
    // by code). Each metric tracks its own weight so null/blank labs don't dilute.
    type LabAcc = { totalIn: number; wMc: number; mcW: number; wAsh: number; ashW: number };
    const accByCode = new Map<string, LabAcc>();
    for (const d of deliveryRows) {
      const code = d.batch_code;
      if (!code) continue;
      let acc = accByCode.get(code);
      if (!acc) {
        acc = { totalIn: 0, wMc: 0, mcW: 0, wAsh: 0, ashW: 0 };
        accByCode.set(code, acc);
      }
      const w = Number(d.weight_kg ?? 0);
      acc.totalIn += w;
      const lab = (d.lab_results as Record<string, unknown> | null) ?? {};
      const mcRaw = lab.mc;
      if (mcRaw !== null && mcRaw !== undefined && mcRaw !== '') {
        acc.wMc += Number(mcRaw) * w;
        acc.mcW += w;
      }
      const ashRaw = lab.ash;
      if (ashRaw !== null && ashRaw !== undefined && ashRaw !== '') {
        acc.wAsh += Number(ashRaw) * w;
        acc.ashW += w;
      }
    }

    // totalOut by batch_id (all-time SUM of RC OUT weight)
    const outById = new Map<string, number>();
    for (const r of rcOutSumRows) {
      if (!r.batch_id) continue;
      outById.set(r.batch_id, (outById.get(r.batch_id) ?? 0) + Number(r.weight_kg ?? 0));
    }

    for (const col of columns) {
      const acc = accByCode.get(col.batchCode);
      const totalIn = acc?.totalIn ?? 0;
      const totalOut = outById.get(col.batchId) ?? 0;
      col.totalIn = totalIn;
      col.totalOut = totalOut;
      col.status = statusById.get(col.batchId) ?? 'CLOSED';
      col.mc = acc && acc.mcW > 0 ? acc.wMc / acc.mcW : 0;
      col.ash = acc && acc.ashW > 0 ? acc.wAsh / acc.ashW : 0;
      // Block loss — formula PER SPEC: (out - in) / in. Sign/direction PENDING
      // user confirmation. Guard divide-by-zero: in = 0 -> null (rendered "—").
      col.blockLoss = totalIn > 0 ? (totalOut - totalIn) / totalIn : null;
    }

    const grandTotalFed = out.reduce((s, r) => s + r.totalFed, 0);

    return { month: target, columns, rows: out, monthOptions, grandTotalFed };
  } catch (err) {
    console.error('[RcMovement] fetchRcMovementMatrix failed:', err);
    return empty;
  }
}
