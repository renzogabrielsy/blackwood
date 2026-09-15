// =====================================================================
// PLANT OPERATIONS LEDGER — server-only query layer  (/operations)
// =====================================================================
// The live ADAPTER for the port in ./types.ts. It reads the
// `view_ops_ledger_*` views plus `fn_ops_ledger_group_kpis` and returns ONE
// normalized `OpsLedgerData`, the way `lib/digest/queries.ts` returns one
// `DigestData`.
//
// HARD RULE (CLAUDE.md): every total, weighted average, ratio and coverage
// count in the payload was computed in SQL. This module does no arithmetic
// at all — it RESHAPES: it groups rows that are already aggregated onto the
// day they belong to, exactly as the RC Movement matrix pivots already
// aggregated cells. If you find yourself writing `+`, `reduce` or a division
// here, the number belongs in a view.
//
// PRICE GATING (CLAUDE.md → "Price gating"): `canViewPrices()` is resolved
// ONCE, up front, and every ₱ field is set to null BEFORE the payload leaves
// the server. The `canViewPrices` boolean rides along so the page can drop the
// column from its coordinate space rather than render a blank one.
//
// FETCH PER CAMPAIGN. `view_ops_ledger_day_block` holds up to 114 rows for a
// single campaign and 2,148 across all history, so a whole-history read would
// hit PostgREST's 1000-row cap. Every read below is filtered to one campaign
// and paged through `fetchAllRows`, and the campaigns are fetched in parallel.
// =====================================================================

import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { canViewPrices } from '@/lib/auth';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { GRADE_DISPLAY_ORDER, WASTE_STREAMS } from './types';
import type {
  OpsCampaign,
  OpsCampaignGrade,
  OpsCampaignOption,
  OpsCampaignRollup,
  OpsDayBlockFeed,
  OpsDayBlockUsed,
  OpsGroupRollup,
  OpsLedgerData,
  OpsLedgerDay,
  OpsShift,
  OpsShiftRun,
  OpsWaste,
} from './types';

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const int = (v: unknown, fallback = 0): number =>
  v === null || v === undefined ? fallback : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const bool = (v: unknown): boolean => v === true;

/** Pull the eight streams off a row in one place, so no caller lists them again. */
function waste(r: Row, suffix: Record<string, string>): OpsWaste {
  const out = {} as OpsWaste;
  for (const s of WASTE_STREAMS) out[s.key] = num(r[suffix[s.key]]);
  return out;
}

const WASTE_COLUMNS: Record<string, string> = {
  trml1Kg: 'trml1_kg',
  trml2Kg: 'trml2_kg',
  rs1aKg: 'rs1a_kg',
  rs1bKg: 'rs1b_kg',
  rs23Kg: 'rs23_kg',
  rs5Kg: 'rs5_kg',
  bfKg: 'bf_kg',
  gritKg: 'grit_kg',
};

/** `JULY 2026` → `July 2026`, the spelling RC Movement's picker uses. */
function titleCaseCampaign(label: string): string {
  return label
    .split(' ')
    .map((w) => (/^[A-Z]+$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Present grades in `GRADE_DISPLAY_ORDER`, anything unknown appended A→Z. */
function orderGrades(present: Iterable<string>): string[] {
  const set = new Set(present);
  const known = GRADE_DISPLAY_ORDER.filter((g) => set.has(g));
  const rest = [...set].filter((g) => !GRADE_DISPLAY_ORDER.includes(g as never)).sort();
  return [...known, ...rest];
}

// ---------------------------------------------------------------------
// The campaign picker
// ---------------------------------------------------------------------

/**
 * Campaign options for the picker, from `view_rc_movement_campaign_options` —
 * THE SAME source `/inventory/rc-movement` drives its picker from, filtered the
 * same way (`campaign_year >= 2025`; the 2024 rows are one-feeding legacy
 * artefacts) and ordered the same way (newest first). Reusing it is what makes
 * the two screens offer identical campaigns.
 */
export async function fetchOpsLedgerCampaignOptions(): Promise<OpsCampaignOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('view_rc_movement_campaign_options')
    .select('production_batch, campaign_year, feed_days, total_fed, min_date, max_date')
    .gte('campaign_year', 2025)
    .order('max_date', { ascending: false });

  if (error || !data) return [];

  return (data as Row[]).map((r) => {
    const pb = String(r.production_batch ?? '');
    const yr = int(r.campaign_year);
    return {
      key: `${pb}-${yr}`,
      label: titleCaseCampaign(`${pb} ${yr}`),
      productionBatch: pb,
      campaignYear: yr,
      feedDays: int(r.feed_days),
      totalFedKg: int(r.total_fed),
      minDate: str(r.min_date),
      maxDate: str(r.max_date),
    };
  });
}

// ---------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------

const EMPTY: OpsLedgerData = {
  campaigns: [],
  campaignsMissing: [],
  days: [],
  rollups: [],
  group: null,
  grades: [],
  gradesByCampaign: {},
  canViewPrices: false,
};

/**
 * THE adapter. Give it the campaign keys the group is made of (Q3 2026 =
 * `['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026']`) and it returns the whole
 * screen: the day spine with its three lenses and the shift expand nested on
 * each day, the per-campaign EOQ rows, and the group KPI row.
 */
export async function fetchOpsLedger(campaignKeys: string[]): Promise<OpsLedgerData> {
  const keys = [...new Set((campaignKeys ?? []).map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return { ...EMPTY, canViewPrices: await canViewPrices() };

  const supabase = await createClient();
  const showPrices = await canViewPrices();

  // --- the campaign rows + the grade dimension + the group row, in parallel ---
  const [kpiRows, gradeRows, groupRow] = await Promise.all([
    fetchAllRows<Row>((from, to) =>
      supabase
        .from('view_ops_ledger_campaign_kpis')
        .select('*')
        .in('campaign_key', keys)
        .order('first_date', { ascending: true })
        .range(from, to),
    ).catch(() => [] as Row[]),
    fetchAllRows<Row>((from, to) =>
      supabase
        .from('view_ops_ledger_campaign_grades')
        .select('*')
        .in('campaign_key', keys)
        .range(from, to),
    ).catch(() => [] as Row[]),
    (async (): Promise<Row | null> => {
      const { data } = await supabase.rpc('fn_ops_ledger_group_kpis', {
        p_campaign_keys: keys,
      });
      return ((data as Row[] | null) ?? [])[0] ?? null;
    })().catch(() => null),
  ]);

  const resolvedKeys = kpiRows.map((r) => String(r.campaign_key));
  const missing = keys.filter((k) => !resolvedKeys.includes(k));

  // --- the day spine and its lenses, one campaign at a time, in parallel ---
  const perCampaign = await Promise.all(
    resolvedKeys.map(async (key) => {
      const [days, grades, blocks, blocksUsed, shifts] = await Promise.all([
        fetchAllRows<Row>((from, to) =>
          supabase
            .from('view_ops_ledger_day')
            .select('*')
            .eq('campaign_key', key)
            .order('calendar_date', { ascending: true })
            .range(from, to),
        ).catch(() => [] as Row[]),
        fetchAllRows<Row>((from, to) =>
          supabase.from('view_ops_ledger_day_grade').select('*').eq('campaign_key', key).range(from, to),
        ).catch(() => [] as Row[]),
        fetchAllRows<Row>((from, to) =>
          supabase.from('view_ops_ledger_day_block').select('*').eq('campaign_key', key).range(from, to),
        ).catch(() => [] as Row[]),
        fetchAllRows<Row>((from, to) =>
          supabase.from('view_ops_ledger_day_blocks_used').select('*').eq('campaign_key', key).range(from, to),
        ).catch(() => [] as Row[]),
        fetchAllRows<Row>((from, to) =>
          supabase.from('view_ops_ledger_shift').select('*').eq('campaign_key', key).range(from, to),
        ).catch(() => [] as Row[]),
      ]);
      return { key, days, grades, blocks, blocksUsed, shifts };
    }),
  );

  // --- reshape: index the lenses by date, then hang them off the day ---
  const days: OpsLedgerDay[] = [];

  for (const c of perCampaign) {
    const gradeByDate = new Map<string, Record<string, number | null>>();
    for (const g of c.grades) {
      const d = String(g.calendar_date);
      const bucket = gradeByDate.get(d) ?? {};
      bucket[String(g.grade)] = num(g.kg);
      gradeByDate.set(d, bucket);
    }

    const blockByDate = new Map<string, OpsDayBlockFeed[]>();
    for (const b of c.blocks) {
      const d = String(b.calendar_date);
      const list = blockByDate.get(d) ?? [];
      list.push({
        batchId: String(b.batch_id),
        batchCode: String(b.batch_code ?? ''),
        blockLoc: str(b.block_loc),
        fedKg: num(b.fed_kg),
        sundryKg: num(b.sundry_kg),
      });
      blockByDate.set(d, list);
    }

    const usedByDate = new Map<string, OpsDayBlockUsed[]>();
    for (const b of c.blocksUsed) {
      const d = String(b.calendar_date);
      const list = usedByDate.get(d) ?? [];
      list.push({
        batchId: String(b.batch_id),
        batchCode: String(b.batch_code ?? ''),
        blockLoc: str(b.block_loc),
        firstFedDate: str(b.first_fed_date),
        closeDate: str(b.close_date),
        isClosed: bool(b.is_closed),
        state: String(b.status ?? ''),
        dayFedKg: num(b.day_fed_kg),
        totalFedKg: num(b.total_fed_kg),
        totalOutKg: num(b.total_out_kg),
        deliveredKg: num(b.delivered_kg),
        weightLostKg: num(b.weight_lost_kg),
        lossPct: num(b.loss_pct),
        resikoKg: num(b.resiko_kg),
        resikoPct: num(b.resiko_pct),
        balanceKg: num(b.balance_kg),
        hasSundryOutflow: bool(b.has_sundry_outflow),
        sundryKg: num(b.sundry_kg),
        hasUnpricedDelivery: bool(b.has_unpriced_delivery),
        unpricedDeliveryCount: num(b.unpriced_delivery_count),
        feedCount: num(b.feed_count),
        deliveryCount: num(b.delivery_count),
      });
      usedByDate.set(d, list);
    }

    const shiftByDate = new Map<string, OpsShift[]>();
    for (const s of c.shifts) {
      const d = String(s.calendar_date);
      const list = shiftByDate.get(d) ?? [];
      list.push({
        shiftId: String(s.shift_id),
        shift: String(s.shift ?? ''),
        shiftHrs: num(s.shift_hrs),
        shiftHrsSource: str(s.shift_hrs_source),
        dtHrs: num(s.dt_hrs),
        dtMins: num(s.dt_mins),
        downtimeHours: num(s.downtime_hours),
        productiveHrs: num(s.productive_hrs),
        dtReason: str(s.dt_reason),
        dtRanges: str(s.dt_ranges),
        dtIncidentRanges: str(s.dt_incident_ranges),
        hasIncident: bool(s.has_incident),
        downtimeRowPresent: bool(s.downtime_row_present),
        producedKg: num(s.produced_kg),
        runCount: int(s.run_count),
        sacks: num(s.sacks),
        runsWithSacks: int(s.runs_with_sacks),
        waste: waste(s, WASTE_COLUMNS),
        totalWasteKg: num(s.total_waste_kg),
        wasteRemarks: str(s.waste_remarks),
        runs: ((s.runs as OpsShiftRun[] | null) ?? []).map((r) => ({
          grade: r.grade ?? null,
          customer: r.customer ?? null,
          ttl_kg: r.ttl_kg ?? null,
          sacks_bags: r.sacks_bags ?? null,
          remarks: r.remarks ?? null,
        })),
      });
      shiftByDate.set(d, list);
    }
    for (const list of shiftByDate.values()) list.sort((a, b) => a.shift.localeCompare(b.shift));

    for (const r of c.days) {
      const date = String(r.calendar_date);
      days.push({
        campaignKey: String(r.campaign_key),
        campaignLabel: String(r.campaign_label ?? ''),
        date,
        weekday: String(r.weekday ?? '').trim(),
        isoWeekday: int(r.iso_weekday),
        isWeekend: bool(r.is_weekend),
        isRestDay: bool(r.is_rest_day),
        fedKg: num(r.fed_kg),
        sundryKg: num(r.sundry_kg),
        // ₱ — stripped here, before the payload leaves the server.
        fedPhpKg: showPrices ? num(r.fed_php_kg) : null,
        producedKg: num(r.produced_kg),
        dayDriftKg: num(r.day_drift_kg),
        blocksFedCount: int(r.blocks_fed_count),
        shiftCount: int(r.shift_count),
        shiftHrsTotal: num(r.shift_hrs_total),
        downtimeHours: num(r.downtime_hours),
        downtimeIncidentCount: int(r.downtime_incident_count),
        downtimeShiftCount: int(r.downtime_shift_count),
        downtimeShiftsWithDuration: int(r.downtime_shifts_with_duration),
        downtimeShiftsReasonOnly: int(r.downtime_shifts_reason_only),
        runCount: int(r.run_count),
        sacks: num(r.sacks),
        runsWithSacks: int(r.runs_with_sacks),
        waste: waste(r, WASTE_COLUMNS),
        totalWasteKg: num(r.total_waste_kg),
        productionReported: bool(r.production_reported),
        producedByGrade: gradeByDate.get(date) ?? {},
        blocksFed: blockByDate.get(date) ?? [],
        blocksUsed: usedByDate.get(date) ?? [],
        shifts: shiftByDate.get(date) ?? [],
      });
    }
  }

  // --- campaigns, rollups, grades ---
  const campaigns: OpsCampaign[] = kpiRows.map((r) => {
    const label = String(r.campaign_label ?? '');
    return {
      key: String(r.campaign_key),
      label,
      displayLabel: titleCaseCampaign(label),
      productionBatch: String(r.production_batch ?? ''),
      campaignYear: int(r.campaign_year),
      firstDate: String(r.first_date ?? ''),
      lastDate: String(r.last_date ?? ''),
      spanDays: int(r.span_days),
      firstFedDate: str(r.first_fed_date),
      lastFedDate: str(r.last_fed_date),
      feedDays: int(r.feed_days),
    };
  });

  const rollups: OpsCampaignRollup[] = kpiRows.map((r) => ({
    campaignKey: String(r.campaign_key),
    label: String(r.campaign_label ?? ''),
    productionBatch: String(r.production_batch ?? ''),
    campaignYear: int(r.campaign_year),
    firstDate: String(r.first_date ?? ''),
    lastDate: String(r.last_date ?? ''),
    spanDays: int(r.span_days),
    firstFedDate: str(r.first_fed_date),
    lastFedDate: str(r.last_fed_date),
    feedDays: int(r.feed_days),

    fedKg: num(r.fed_kg),
    producedKg: num(r.produced_kg),
    productionReported: bool(r.production_reported),
    yieldPct: num(r.yield_pct),
    processLossKg: num(r.process_loss_kg),
    processLossPct: num(r.process_loss_pct),

    blockResikoKg: num(r.block_resiko_kg),
    blockResikoLossPct: num(r.block_resiko_loss_pct),

    // WASTE — the eight streams and their total, folded in SQL. No ₱ here, so
    // nothing is gated: the whole waste band is safe for every role.
    waste: waste(r, WASTE_COLUMNS),
    wasteKg: num(r.waste_kg),
    wasteShiftCount: int(r.waste_shift_count),
    wasteLossPct: num(r.waste_loss_pct),

    // ₱ — every one of the seven stripped together.
    fedPhpKg: showPrices ? num(r.fed_php_kg) : null,
    fedValuePhp: showPrices ? num(r.fed_value_php) : null,
    actualFedPhpKg: showPrices ? num(r.actual_fed_php_kg) : null,
    campaignWeightedActualFedPhpKg: showPrices
      ? num(r.campaign_weighted_actual_fed_php_kg)
      : null,
    upliftPhpKg: showPrices ? num(r.uplift_php_kg) : null,
    phpPerProducedKgDelivered: showPrices ? num(r.php_per_produced_kg_delivered) : null,
    phpPerProducedKgTrue: showPrices ? num(r.php_per_produced_kg_true) : null,

    fedPriceCoveragePct: num(r.fed_price_coverage_pct),
    blocksFed: num(r.blocks_fed),
    blocksClosed: num(r.blocks_closed),
    blocksOpen: num(r.blocks_open),
    blocksInPrice: num(r.blocks_in_price),
    blocksClosedUnpriced: num(r.blocks_closed_unpriced),
    blocksWithSundry: num(r.blocks_with_sundry),
    campaignFedKgIncluded: num(r.campaign_fed_kg_included),
    campaignFedKgIncludedPct: num(r.campaign_fed_kg_included_pct),
    isFullyCovered: bool(r.is_fully_covered),
    sundryKg: num(r.sundry_kg),
    outKg: num(r.out_kg),

    reportedDays: num(r.reported_days),
    shiftCount: num(r.shift_count),
    runCount: num(r.run_count),
    downtimeHours: num(r.downtime_hours),
    downtimeShiftCount: num(r.downtime_shift_count),
    downtimeShiftsWithDuration: num(r.downtime_shifts_with_duration),
    downtimeShiftsReasonOnly: num(r.downtime_shifts_reason_only),
    sacks: num(r.sacks),
    runsWithSacks: num(r.runs_with_sacks),
    sacksCoveragePct: num(r.sacks_coverage_pct),
    kwh: num(r.kwh),
    kwhDays: num(r.kwh_days),
    kwhSuspectReadingCount: num(r.kwh_suspect_reading_count),
    kwhPerProducedKg: num(r.kwh_per_produced_kg),
    kwhPerProducedKgExclSuspect: num(r.kwh_per_produced_kg_excl_suspect),

    ledgerDays: num(r.ledger_days),
    activeDays: num(r.active_days),
    restDays: num(r.rest_days),
  }));

  const gradesByCampaign: Record<string, OpsCampaignGrade[]> = {};
  const allGrades = new Set<string>();
  for (const g of gradeRows) {
    const key = String(g.campaign_key);
    allGrades.add(String(g.grade));
    (gradesByCampaign[key] ??= []).push({
      campaignKey: key,
      grade: String(g.grade),
      kg: num(g.kg),
      sharePct: num(g.share_pct),
      campaignProducedKg: num(g.campaign_produced_kg),
      runCount: num(g.run_count),
      sacks: num(g.sacks),
    });
  }
  for (const key of Object.keys(gradesByCampaign)) {
    const order = orderGrades(gradesByCampaign[key].map((g) => g.grade));
    gradesByCampaign[key].sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  }

  const group: OpsGroupRollup | null = groupRow
    ? {
        campaignCount: int(groupRow.campaign_count),
        campaignKeys: (groupRow.campaign_keys as string[] | null) ?? [],
        campaignsMissing: (groupRow.campaigns_missing as string[] | null) ?? [],
        firstDate: str(groupRow.first_date),
        lastDate: str(groupRow.last_date),
        ledgerDays: int(groupRow.ledger_days),
        activeDays: int(groupRow.active_days),
        restDays: int(groupRow.rest_days),

        fedKg: num(groupRow.fed_kg),
        producedKg: num(groupRow.produced_kg),
        fedKgProductionReported: num(groupRow.fed_kg_production_reported),
        campaignsProductionReported: int(groupRow.campaigns_production_reported),
        yieldPct: num(groupRow.yield_pct),
        processLossKg: num(groupRow.process_loss_kg),
        processLossPct: num(groupRow.process_loss_pct),
        blockResikoLossPct: num(groupRow.block_resiko_loss_pct),

        // WASTE — summed in SQL from the campaign rows' own columns.
        waste: waste(groupRow, WASTE_COLUMNS),
        wasteKg: num(groupRow.waste_kg),
        wasteShiftCount: int(groupRow.waste_shift_count),
        wasteLossPct: num(groupRow.waste_loss_pct),
        campaignsWasteReported: int(groupRow.campaigns_waste_reported),
        fedKgWasteReported: num(groupRow.fed_kg_waste_reported),

        // ₱ — stripped exactly as on the campaign rows.
        fedPhpKg: showPrices ? num(groupRow.fed_php_kg) : null,
        fedValuePhp: showPrices ? num(groupRow.fed_value_php) : null,
        actualFedPhpKg: showPrices ? num(groupRow.actual_fed_php_kg) : null,
        upliftPhpKg: showPrices ? num(groupRow.uplift_php_kg) : null,
        phpPerProducedKgDelivered: showPrices
          ? num(groupRow.php_per_produced_kg_delivered)
          : null,
        phpPerProducedKgTrue: showPrices ? num(groupRow.php_per_produced_kg_true) : null,
        phpPerProducedKgTrueCovered: showPrices
          ? num(groupRow.php_per_produced_kg_true_covered)
          : null,

        campaignsFullyCovered: int(groupRow.campaigns_fully_covered),
        isFullyCovered: bool(groupRow.is_fully_covered),
        coveredFedKgShare: num(groupRow.covered_fed_kg_share),
        campaignFedKgIncluded: num(groupRow.campaign_fed_kg_included),
        fedPriceCoveragePct: num(groupRow.fed_price_coverage_pct),

        blocksFedDistinct: int(groupRow.blocks_fed_distinct),
        blocksClosedDistinct: int(groupRow.blocks_closed_distinct),
        blocksOpenDistinct: int(groupRow.blocks_open_distinct),
        blocksFedCampaignSum: num(groupRow.blocks_fed_campaign_sum),

        reportedCampaignDays: num(groupRow.reported_campaign_days),
        reportedCalendarDays: int(groupRow.reported_calendar_days),
        shiftCount: num(groupRow.shift_count),
        runCount: num(groupRow.run_count),
        downtimeHours: num(groupRow.downtime_hours),
        sacks: num(groupRow.sacks),
        sundryKg: num(groupRow.sundry_kg),
      }
    : null;

  return {
    campaigns,
    campaignsMissing: missing,
    days,
    rollups,
    group,
    grades: orderGrades(allGrades),
    gradesByCampaign,
    canViewPrices: showPrices,
  };
}
