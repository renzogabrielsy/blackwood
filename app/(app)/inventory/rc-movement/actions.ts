'use server';

import { createClient } from '@/lib/supabase/server';

// ===========================================================================
// RC MOVEMENT MATRIX (cross-tab / pivot) — CAMPAIGN-SCOPED
// ---------------------------------------------------------------------------
// The picker selects a PRODUCTION CAMPAIGN = (production_batch, campaign_year),
// e.g. ("JUNE", 2026) labelled "June 2026". A campaign straddles calendar months
// and splits transition days by tag — the campaign-keyed SQL views already handle
// that split, so BOTH fed (RC OUT) and produced (production) are filtered to the
// same campaign here.
//
// Reshapes the campaign views into a day-by-block matrix:
//   ROWS    = every calendar day from the campaign's min_date to its max_date
//             (zero-feed days included so open/close edges are visible).
//   COLUMNS = each opened block (source batch consumed) during the campaign,
//             ordered by FIRST feed date (tie-break batch_code ASC).
//   CELLS   = kg fed from that block on that day (view.fed_kg), already
//             aggregated in SQL — TS only sums fed_kg for the row total.
//
// Every campaign view is filtered by .eq('production_batch', pb).eq('campaign_year', yr).
// Tolerates fed-but-no-production campaigns (produced = 0 / yield = NULL) — production
// only exists for Dec-2025+. 2024 legacy campaigns are excluded from the picker.
// ===========================================================================

/** One block (source batch) consumed during the campaign — a matrix column. */
export type RcMovementMatrixColumn = {
  batchId: string;
  batchCode: string;
  blockLoc: string | null;
  firstFedDate: string; // YYYY-MM-DD — drives chronological column order
  // ── Summary fields (footer) — computed in one batched pass over the campaign's
  //    batches. mc/ash are weighted averages from RC IN deliveries (same approach
  //    as Blocking's fetchBlockDataForBatch). totalOut/totalIn are SUMs from SQL.
  //    These are CAMPAIGN-INDEPENDENT, all-time per-batch figures (unchanged from
  //    the month version) — a block's lifetime in/out, not its in-campaign feed.
  totalOut: number;      // total kg fed out of this block (all-time, SUM rc_out.weight_kg)
  totalIn: number;       // total kg delivered into this block (all-time, SUM deliveries.weight_kg)
  status: string;        // batches.status — drives IN-USE / CLOSED badge in the footer
  mc: number;            // weighted-avg moisture % (0 when no metric-bearing deliveries)
  ash: number;           // weighted-avg ash % (0 when no metric-bearing deliveries)
  blockLoss: number | null; // (totalOut - totalIn) / totalIn, signed ratio; null when totalIn = 0
  /** Weighted-avg fed price (₱/kg) for this block, from view_rc_movement_batch_price
   *  (campaign-independent — a batch's lifetime weighted-avg delivery cost).
   *  NULL when the batch is zero-fed / has no delivery-cost basis. */
  avgFedPrice: number | null;
};

/** One calendar day within the campaign — a matrix row. */
export type RcMovementMatrixRow = {
  rowNum: number;        // 1-based sequential index within the visible range
  date: string;          // YYYY-MM-DD
  dayOfWeek: string;     // Mon / Tue / …
  productionBatch: string | null; // the campaign's production_batch (same on every row)
  totalFed: number;      // sum of fed_kg across all blocks this day (kg)
  /** batchId -> kg fed that day. Absent key = no feed (blank cell). */
  fedByBatch: Record<string, number>;
  /** The day's weighted-avg fed price (₱/kg), from view_rc_movement_campaign_day_price.
   *  NULL on zero-fed days (and days with no delivery-cost basis). */
  avgFedPriceDay: number | null;
  /** Total kg produced that day (all grades), from
   *  view_rc_movement_campaign_production_daily_total. NULL on days with no
   *  production (fed-but-no-output days are valid). SQL-summed — NEVER summed
   *  from producedByGrade in TS. */
  totalProduced: number | null;
  /** grade -> kg produced that day, from view_rc_movement_campaign_production_daily.
   *  Absent/zero key = no output of that grade that day (blank cell). */
  producedByGrade: Record<string, number>;
};

/** A selectable production campaign for the picker. */
export type RcMovementCampaignOption = {
  productionBatch: string; // bare month name as stored, e.g. "JUNE"
  campaignYear: number;    // e.g. 2026
  /** URL-safe encoded key: `${productionBatch}-${campaignYear}` e.g. "JUNE-2026". */
  value: string;
  /** Human label, e.g. "June 2026" (title-cased month + year). */
  label: string;
  feedDays: number;
  totalFed: number;
};

/** Top-level return type for fetchRcMovementMatrix. */
export type RcMovementMatrix = {
  /** Resolved campaign's encoded key, e.g. "JUNE-2026" ('' when none resolved). */
  campaign: string;
  /** Resolved campaign's production_batch (bare month), e.g. "JUNE". */
  productionBatch: string;
  /** Resolved campaign's year, e.g. 2026 (0 when none resolved). */
  campaignYear: number;
  /** Resolved campaign's human label, e.g. "June 2026". */
  campaignLabel: string;
  columns: RcMovementMatrixColumn[];
  rows: RcMovementMatrixRow[];
  campaignOptions: RcMovementCampaignOption[];
  /** Sum of fed_kg across the whole visible campaign (footer grand total, kg). */
  grandTotalFed: number;
  /** Campaign's weighted-avg fed price (₱/kg), from view_rc_movement_campaign_price.
   *  NULL when the campaign is zero-fed. Kept EXACT (unrounded) — display formats it. */
  campaignAvgFedPrice: number | null;
  /** Grade columns present THIS campaign (canonical order, present-only), with each
   *  grade's campaign total. Derived from view_rc_movement_campaign_production.
   *  Dynamic per campaign — never hardcoded. campaignTotal NULL only when the grade
   *  has no row (it never will from the by-grade view, but kept nullable for parity). */
  producedGrades: { grade: string; campaignTotal: number | null }[];
  /** Campaign's total kg produced (all grades), from view_rc_movement_campaign_yield.
   *  NULL when the campaign has no production. Footer headline of TOTAL PRODUCED. */
  campaignTotalProduced: number | null;
  /** Campaign's yield as a FRACTION (produced / fed), from view_rc_movement_campaign_yield.
   *  Stored AS-IS (×100 for display) — NEVER pre-multiplied. NULL when total_fed = 0. */
  campaignYieldPct: number | null;
  /** Campaign's loss in kg (fed − produced), from view_rc_movement_campaign_yield.
   *  NULL when the yield row is absent. */
  campaignLossKg: number | null;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Title-case a bare month name as stored (e.g. "JUNE" -> "June"). */
function titleCaseMonth(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Build the URL-safe campaign key from (production_batch, year): "JUNE-2026". */
function encodeCampaign(productionBatch: string, year: number): string {
  return `${productionBatch}-${year}`;
}

/** Parse "JUNE-2026" -> { productionBatch: "JUNE", campaignYear: 2026 } (null if malformed). */
function decodeCampaign(key: string): { productionBatch: string; campaignYear: number } | null {
  const idx = key.lastIndexOf('-');
  if (idx <= 0) return null;
  const pb = key.slice(0, idx);
  const yr = Number(key.slice(idx + 1));
  if (!pb || !Number.isInteger(yr)) return null;
  return { productionBatch: pb, campaignYear: yr };
}

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
 * Fetches and pivots RC Movement data for one production campaign.
 *
 * @param campaign Encoded campaign key "PRODUCTION_BATCH-YEAR" (e.g. "JUNE-2026").
 *                 When omitted/invalid/unknown, defaults to the most recent
 *                 campaign in the picker (campaignOptions[0]).
 */
export async function fetchRcMovementMatrix(campaign?: string): Promise<RcMovementMatrix> {
  const empty: RcMovementMatrix = {
    campaign: '', productionBatch: '', campaignYear: 0, campaignLabel: '',
    columns: [], rows: [], campaignOptions: [], grandTotalFed: 0, campaignAvgFedPrice: null,
    producedGrades: [], campaignTotalProduced: null, campaignYieldPct: null, campaignLossKg: null,
  };

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

    // --- Build campaign options from the options view (most recent first) ------
    // 2024 legacy campaigns are excluded from the picker per spec; production only
    // exists Dec-2025+ and the platform's data of record starts 2025.
    type OptionRow = {
      production_batch: string | null;
      campaign_year: number | null;
      feed_days: number | null;
      total_fed: number | null;
      min_date: string | null;
      max_date: string | null;
    };
    const optionRows = await fetchAll<OptionRow>(() =>
      supabase
        .from('view_rc_movement_campaign_options')
        .select('production_batch, campaign_year, feed_days, total_fed, min_date, max_date')
        .gte('campaign_year', 2025)
        .order('max_date', { ascending: false }),
    );

    const campaignOptions: RcMovementCampaignOption[] = optionRows
      .filter((r) => r.production_batch && r.campaign_year != null)
      .map((r) => {
        const pb = r.production_batch as string;
        const yr = r.campaign_year as number;
        return {
          productionBatch: pb,
          campaignYear: yr,
          value: encodeCampaign(pb, yr),
          label: `${titleCaseMonth(pb)} ${yr}`,
          feedDays: Number(r.feed_days ?? 0),
          totalFed: Number(r.total_fed ?? 0),
        };
      });

    if (campaignOptions.length === 0) return empty;

    // --- Resolve target campaign (default = most recent = campaignOptions[0]) ---
    let resolved: RcMovementCampaignOption | undefined;
    if (campaign) {
      const decoded = decodeCampaign(campaign);
      if (decoded) {
        resolved = campaignOptions.find(
          (o) => o.productionBatch === decoded.productionBatch && o.campaignYear === decoded.campaignYear,
        );
      }
    }
    if (!resolved) resolved = campaignOptions[0];

    const pb = resolved.productionBatch;
    const yr = resolved.campaignYear;
    const baseEmpty = {
      ...empty,
      campaign: resolved.value,
      productionBatch: pb,
      campaignYear: yr,
      campaignLabel: resolved.label,
      campaignOptions,
    };

    // --- Fed cells for the campaign (date × block, kg) -------------------------
    type CellRow = {
      date: string | null;
      batch_id: string | null;
      batch_code: string | null;
      block_loc: string | null;
      fed_kg: number | null;
    };
    const cells = await fetchAll<CellRow>(() =>
      supabase
        .from('view_rc_movement_campaign_cells')
        .select('date, batch_id, batch_code, block_loc, fed_kg')
        .eq('production_batch', pb)
        .eq('campaign_year', yr)
        .order('date', { ascending: true })
        .order('batch_id', { ascending: true }),
    );

    // Campaign day-range comes from the OPTIONS view (authoritative min/max),
    // not the cells — so zero-feed edge days still render even if the cells happen
    // to start later. Fall back to the cells when the option dates are missing.
    const optMin = optionRows.find((r) => r.production_batch === pb && r.campaign_year === yr)?.min_date ?? null;
    const optMax = optionRows.find((r) => r.production_batch === pb && r.campaign_year === yr)?.max_date ?? null;

    if (cells.length === 0 && (!optMin || !optMax)) {
      return baseEmpty;
    }

    // --- Build columns: one per block, ordered by first fed date --------------
    const colMap = new Map<string, RcMovementMatrixColumn>();
    for (const r of cells) {
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
          avgFedPrice: null, // filled from view_rc_movement_batch_price below
        });
      } else if (r.date < existing.firstFedDate) {
        existing.firstFedDate = r.date;
      }
    }
    const columns = Array.from(colMap.values()).sort((a, b) => {
      if (a.firstFedDate !== b.firstFedDate) return a.firstFedDate < b.firstFedDate ? -1 : 1;
      return a.batchCode.localeCompare(b.batchCode);
    });

    // --- Pivot cells: date -> (batchId -> fed kg), plus row totals ------------
    const dayMap = new Map<string, { totalFed: number; fedByBatch: Record<string, number> }>();
    let minDate = optMin ?? (cells[0].date as string);
    let maxDate = optMax ?? (cells[0].date as string);
    for (const r of cells) {
      if (!r.date || !r.batch_id) continue;
      if (r.date < minDate) minDate = r.date;
      if (r.date > maxDate) maxDate = r.date;
      const kg = Number(r.fed_kg ?? 0);
      if (!dayMap.has(r.date)) dayMap.set(r.date, { totalFed: 0, fedByBatch: {} });
      const day = dayMap.get(r.date)!;
      day.fedByBatch[r.batch_id] = (day.fedByBatch[r.batch_id] ?? 0) + kg;
      day.totalFed += kg;
    }

    // --- Fed-price views (weighted-avg ₱/kg) ----------------------------------
    // (A) per-day  : view_rc_movement_campaign_day_price → date → wtd_fed_price
    // (B) campaign : view_rc_movement_campaign_price     → campaign wtd_fed_price
    // (C) per-batch is fetched in the batched footer pass below (batch_price view,
    //     campaign-independent). All price columns are NUMERIC, NULL when zero-fed
    //     — map straight through, NEVER recompute a weighted average in TS.
    type DayPriceRow = { date: string | null; wtd_fed_price: number | null };
    const dayPriceRows = await fetchAll<DayPriceRow>(() =>
      supabase
        .from('view_rc_movement_campaign_day_price')
        .select('date, wtd_fed_price')
        .eq('production_batch', pb)
        .eq('campaign_year', yr),
    );
    const dayPriceByDate = new Map<string, number | null>();
    for (const r of dayPriceRows) {
      if (r.date) dayPriceByDate.set(r.date, r.wtd_fed_price);
    }

    const { data: campaignPriceRow } = await supabase
      .from('view_rc_movement_campaign_price')
      .select('wtd_fed_price')
      .eq('production_batch', pb)
      .eq('campaign_year', yr)
      .maybeSingle();
    // EXACT — do NOT round in the data layer (display formats to 2 dp downstream).
    const campaignAvgFedPrice: number | null = campaignPriceRow?.wtd_fed_price ?? null;

    // --- Production output + campaign yield/loss views (kg; SQL-aggregated) ----
    // Continuous-tank production is NOT attributable to an input batch, so it's keyed
    // by DAY and CAMPAIGN only (no per-block join). Campaigns with fed-but-no-production
    // are valid (produced/yield = 0/NULL). NEVER sum grades or compute a ratio in TS —
    // the daily_total + yield views are the single source of truth.
    type ProdDailyRow = { date: string | null; grade: string | null; produced_kg: number | null };
    type ProdDailyTotalRow = { date: string | null; produced_kg: number | null };
    type ProdCampaignRow = { grade: string | null; produced_kg: number | null };

    const [prodDailyRows, prodDailyTotalRows, prodCampaignRows] = await Promise.all([
      fetchAll<ProdDailyRow>(() =>
        supabase
          .from('view_rc_movement_campaign_production_daily')
          .select('date, grade, produced_kg')
          .eq('production_batch', pb)
          .eq('campaign_year', yr),
      ),
      fetchAll<ProdDailyTotalRow>(() =>
        supabase
          .from('view_rc_movement_campaign_production_daily_total')
          .select('date, produced_kg')
          .eq('production_batch', pb)
          .eq('campaign_year', yr),
      ),
      fetchAll<ProdCampaignRow>(() =>
        supabase
          .from('view_rc_movement_campaign_production')
          .select('grade, produced_kg')
          .eq('production_batch', pb)
          .eq('campaign_year', yr),
      ),
    ]);

    const { data: yieldRow } = await supabase
      .from('view_rc_movement_campaign_yield')
      .select('total_produced, yield_pct, loss_kg')
      .eq('production_batch', pb)
      .eq('campaign_year', yr)
      .maybeSingle();
    // Campaign-level production figures — mapped straight through, never recomputed.
    // yield_pct is a FRACTION (NULL when total_fed = 0); kept as-is for display ×100.
    const campaignTotalProduced: number | null = yieldRow?.total_produced ?? null;
    const campaignYieldPct: number | null = yieldRow?.yield_pct ?? null;
    const campaignLossKg: number | null = yieldRow?.loss_kg ?? null;

    // Per-day TOTAL PRODUCED, keyed by date (null when no production row that day).
    const producedTotalByDate = new Map<string, number | null>();
    for (const r of prodDailyTotalRows) {
      if (r.date) producedTotalByDate.set(r.date, r.produced_kg);
    }

    // Per-day produced BY GRADE: date -> (grade -> kg).
    const producedByGradeByDate = new Map<string, Record<string, number>>();
    for (const r of prodDailyRows) {
      if (!r.date || !r.grade) continue;
      let m = producedByGradeByDate.get(r.date);
      if (!m) { m = {}; producedByGradeByDate.set(r.date, m); }
      m[r.grade] = (m[r.grade] ?? 0) + Number(r.produced_kg ?? 0);
    }

    // --- Grade columns present THIS campaign, in canonical order ---------------
    // Order is fixed (3X50, 6X50, 8X50, 2X6) but filtered to grades present this
    // campaign. Present-set is derived from the campaign by-grade view; fall back to
    // the daily by-grade rows when the campaign view is empty. Totals come from the
    // campaign by-grade view.
    const GRADE_ORDER = ['3X50', '6X50', '8X50', '2X6'];
    const campaignGradeTotal = new Map<string, number>();
    for (const r of prodCampaignRows) {
      if (!r.grade) continue;
      campaignGradeTotal.set(r.grade, (campaignGradeTotal.get(r.grade) ?? 0) + Number(r.produced_kg ?? 0));
    }
    // Present grades: prefer the campaign view's grade set; else union of daily grades.
    const presentGradeSet = new Set<string>(campaignGradeTotal.keys());
    if (presentGradeSet.size === 0) {
      for (const r of prodDailyRows) if (r.grade) presentGradeSet.add(r.grade);
    }
    // Canonical-first ordering, then any non-canonical grades appended alphabetically
    // (so an unexpected grade still surfaces rather than silently dropping).
    const orderedGrades = [
      ...GRADE_ORDER.filter((g) => presentGradeSet.has(g)),
      ...Array.from(presentGradeSet).filter((g) => !GRADE_ORDER.includes(g)).sort(),
    ];
    const producedGrades = orderedGrades.map((grade) => ({
      grade,
      campaignTotal: campaignGradeTotal.has(grade) ? campaignGradeTotal.get(grade)! : null,
    }));

    // --- Emit one row per calendar day from minDate..maxDate (gaps included) ---
    // productionBatch is the SAME on every row — the whole view is ONE campaign,
    // so each day reads the campaign's production_batch (correct even on transition
    // days, where the same date appears under two campaigns showing only that
    // campaign's feeds).
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
        productionBatch: pb,
        totalFed: day?.totalFed ?? 0,
        fedByBatch: day?.fedByBatch ?? {},
        // SQL-provided weighted-avg fed price for the day; null on zero-fed days.
        avgFedPriceDay: dayPriceByDate.get(ymd) ?? null,
        // SQL-provided total produced (all grades) for the day; null on no-production
        // days (fed-but-no-output is valid — the tank is continuous-flow).
        totalProduced: producedTotalByDate.get(ymd) ?? null,
        // Per-grade produced kg for the day (blank cell when a grade is absent/zero).
        producedByGrade: producedByGradeByDate.get(ymd) ?? {},
      });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }

    // --- Footer summary: one batched pass over the campaign's block-batches ----
    // Per column we surface: status (badge), totalIn (RC IN SUM), totalOut (RC OUT
    // SUM), weighted-avg mc/ash, and a derived blockLoss = (out - in) / in.
    // Computed via FOUR batched queries keyed on the column batch_ids/codes —
    // NEVER one per-column action. These are ALL-TIME per-batch figures
    // (campaign-independent), unchanged from the month version. mc/ash weighting
    // mirrors fetchBlockDataForBatch (SUM(metric * weight) / SUM(weight_with_metric)).
    const batchIds = columns.map((c) => c.batchId);
    const batchCodes = Array.from(new Set(columns.map((c) => c.batchCode)));

    type BatchRow = { id: string; status: string | null };
    type DeliveryRow = { batch_code: string | null; weight_kg: number | null; lab_results: unknown };
    type RcOutSumRow = { batch_id: string | null; weight_kg: number | null };
    // (C) per-batch fed price (weighted-avg ₱/kg) — NUMERIC, NULL when zero-fed.
    type BatchPriceRow = { batch_id: string | null; batch_price: number | null };

    const [batchRows, deliveryRows, rcOutSumRows, batchPriceRows] = await Promise.all([
      batchIds.length
        ? fetchAll<BatchRow>(() => supabase.from('batches').select('id, status').in('id', batchIds))
        : Promise.resolve([] as BatchRow[]),
      batchCodes.length
        ? fetchAll<DeliveryRow>(() =>
            supabase
              .from('deliveries')
              .select('batch_code, weight_kg, lab_results')
              .in('batch_code', batchCodes),
          )
        : Promise.resolve([] as DeliveryRow[]),
      batchIds.length
        ? fetchAll<RcOutSumRow>(() =>
            supabase.from('rc_out').select('batch_id, weight_kg').in('batch_id', batchIds),
          )
        : Promise.resolve([] as RcOutSumRow[]),
      batchIds.length
        ? fetchAll<BatchPriceRow>(() =>
            supabase
              .from('view_rc_movement_batch_price')
              .select('batch_id, batch_price')
              .in('batch_id', batchIds),
          )
        : Promise.resolve([] as BatchPriceRow[]),
    ]);

    // batch_price by batch_id (NULL passes straight through — zero-fed batch).
    const priceById = new Map<string, number | null>();
    for (const r of batchPriceRows) {
      if (r.batch_id) priceById.set(r.batch_id, r.batch_price);
    }

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
      // Block loss — (out - in) / in. Guard divide-by-zero: in = 0 -> null ("—").
      col.blockLoss = totalIn > 0 ? (totalOut - totalIn) / totalIn : null;
      // SQL-provided weighted-avg fed price; null when the batch is zero-fed.
      col.avgFedPrice = priceById.get(col.batchId) ?? null;
    }

    const grandTotalFed = out.reduce((s, r) => s + r.totalFed, 0);

    return {
      campaign: resolved.value,
      productionBatch: pb,
      campaignYear: yr,
      campaignLabel: resolved.label,
      columns,
      rows: out,
      campaignOptions,
      grandTotalFed,
      campaignAvgFedPrice,
      producedGrades,
      campaignTotalProduced,
      campaignYieldPct,
      campaignLossKg,
    };
  } catch (err) {
    console.error('[RcMovement] fetchRcMovementMatrix failed:', err);
    return empty;
  }
}
