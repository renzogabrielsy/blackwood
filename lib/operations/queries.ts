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
  OpsCampaignBlock,
  OpsCampaignGrade,
  OpsCampaignOption,
  OpsCampaignRollup,
  OpsDayBlockFeed,
  OpsFedBlend,
  OpsGroupBlock,
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
 * Campaign options for the picker, from **`view_ops_ledger_campaign_span`** —
 * the ledger's own spine, 32 rows, newest first.
 *
 * ⚠ IT IS NO LONGER `view_rc_movement_campaign_options` (2026-09-16), and the
 * two pickers now legitimately DIFFER. That view is built from `rc_out`, so a
 * campaign that has PRODUCED but not yet been FED is missing from it — which is
 * exactly what SEPTEMBER 2026 was on the day it opened (a shift on 2026-08-29,
 * three days before its first feed). The ledger draws such a campaign, so its
 * picker must offer it. The span view unions feeding and production, which is
 * why it is the right list here and why RC Movement's fed-only list is still the
 * right one there.
 *
 * ⚠ THE QUARTER COMES FROM THE VIEW, NEVER FROM THE NAME. `quarter_key` places
 * a campaign in the quarter containing the MIDPOINT of its span; the preset
 * builder groups on it and does no date arithmetic of its own.
 *
 * No `campaign_year >= 2025` filter: the ledger shows what exists, and the 2024
 * one-feeding rows are real campaigns the EOQ tab can legitimately be pointed at.
 * 32 rows is three orders of magnitude under PostgREST's cap.
 */
export async function fetchOpsLedgerCampaignOptions(): Promise<OpsCampaignOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('view_ops_ledger_campaign_span')
    // ONE string literal, not a concatenation: supabase-js infers the row type
    // from the select LITERAL, and a `+` makes it fall back to GenericStringError.
    .select('campaign_key, campaign_label, production_batch, campaign_year, feed_days, first_fed_date, last_fed_date, first_date, last_date, quarter_key, quarter_label')
    .order('first_date', { ascending: false })
    .order('campaign_key', { ascending: false });

  if (error || !data) return [];

  return (data as Row[]).map((r) => ({
    key: String(r.campaign_key),
    label: titleCaseCampaign(String(r.campaign_label ?? '')),
    productionBatch: String(r.production_batch ?? ''),
    campaignYear: int(r.campaign_year),
    feedDays: int(r.feed_days),
    // The span view carries no fed TOTAL — it is a calendar spine, not a money
    // or tonnage view, and the picker only ever used this to sort. The ledger's
    // own KPI row is where a fed total comes from.
    totalFedKg: 0,
    minDate: str(r.first_fed_date),
    maxDate: str(r.last_fed_date),
    firstDate: String(r.first_date ?? ''),
    lastDate: String(r.last_date ?? ''),
    quarterKey: String(r.quarter_key ?? ''),
    quarterLabel: String(r.quarter_label ?? ''),
  }));
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
  const [kpiRows, gradeRows, groupRow, groupBlockRows] = await Promise.all([
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
    // THE GROUP'S BLOCKS USED TABLE — one row per DISTINCT block, already
    // de-duplicated and ordered in SQL. Read beside the group KPI row because
    // both answer the same question about the same chosen set of campaigns.
    (async (): Promise<Row[]> => {
      const { data } = await supabase.rpc('fn_ops_ledger_group_blocks', {
        p_campaign_keys: keys,
      });
      return (data as Row[] | null) ?? [];
    })().catch(() => [] as Row[]),
  ]);

  const resolvedKeys = kpiRows.map((r) => String(r.campaign_key));
  const missing = keys.filter((k) => !resolvedKeys.includes(k));

  // --- the day spine and its lenses, one campaign at a time, in parallel ---
  const perCampaign = await Promise.all(
    resolvedKeys.map(async (key) => {
      const [days, grades, blocks, shifts, campaignBlocks, fedBlends] = await Promise.all([
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
          supabase.from('view_ops_ledger_shift').select('*').eq('campaign_key', key).range(from, to),
        ).catch(() => [] as Row[]),
        // THE CAMPAIGN x BLOCK grain (<= ~30 rows/campaign) — the BLOCKS USED
        // table behind the FED PRICE / ACTUAL FED PRICE modals. Ordered here so
        // the modal renders the payload as it arrives.
        fetchAllRows<Row>((from, to) =>
          supabase
            .from('view_ops_ledger_campaign_block')
            .select('*')
            .eq('campaign_key', key)
            .order('first_campaign_feed_date', { ascending: true })
            .order('batch_code', { ascending: true })
            .range(from, to),
        ).catch(() => [] as Row[]),
        // THE DAY'S PROJECTED FED BLEND (<= ~31 rows/campaign) — the head of the
        // FED-cell sidebar. Every weighted mean was computed in SQL over the
        // SAME relation `blocks` above comes from.
        fetchAllRows<Row>((from, to) =>
          supabase
            .from('view_ops_ledger_day_fed_blend')
            .select('*')
            .eq('campaign_key', key)
            .range(from, to),
        ).catch(() => [] as Row[]),
      ]);
      return { key, days, grades, blocks, shifts, campaignBlocks, fedBlends };
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
        // The block's delivery-weighted lab profile, computed in SQL. NULL
        // (never 0) when no delivery into the block carries that stat.
        mc: num(b.mc),
        ash: num(b.ash),
        bdAstm: num(b.bd_astm),
        bdJis: num(b.bd_jis),
        grit: num(b.grit),
        vm: num(b.vm),
        fc: num(b.fc),
      });
      blockByDate.set(d, list);
    }

    // THE DAY'S PROJECTED FED BLEND, indexed by date. Mapped only — every
    // weighted mean and every coverage figure was computed in SQL.
    const blendByDate = new Map<string, OpsFedBlend>();
    for (const f of c.fedBlends) {
      blendByDate.set(String(f.calendar_date), {
        fedKg: num(f.fed_kg),
        blocksFedCount: int(f.blocks_fed_count),
        wMc: num(f.w_mc),
        mcKg: num(f.mc_kg),
        wAsh: num(f.w_ash),
        ashKg: num(f.ash_kg),
        wBdAstm: num(f.w_bd_astm),
        bdAstmKg: num(f.bd_astm_kg),
        wBdJis: num(f.w_bd_jis),
        bdJisKg: num(f.bd_jis_kg),
        wGrit: num(f.w_grit),
        gritKg: num(f.grit_kg),
        wVm: num(f.w_vm),
        vmKg: num(f.vm_kg),
        wFc: num(f.w_fc),
        fcKg: num(f.fc_kg),
      });
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
        // Computed in SQL over PRODUCED kg — the same denominator as the day row
        // and the EOQ cell. Mapped only.
        wastePct: num(s.waste_pct),
        wasteRemarks: str(s.waste_remarks),
        // The shift's own grade split, summed in SQL. NULL (no runs) reshapes to
        // an empty map; a missing KEY inside a populated map means that grade
        // did not run. No summing here.
        gradeKg: (s.grade_kg as Record<string, number | null> | null) ?? {},
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
        // DAY-LEVEL RATIOS — computed in SQL, mapped only. Fractions, ×100 at
        // render; yieldPct/lossPct are INDICATIVE (continuous-flow feed tank).
        wastePct: num(r.waste_pct),
        yieldPct: num(r.yield_pct),
        lossPct: num(r.loss_pct),
        producedByGrade: gradeByDate.get(date) ?? {},
        blocksFed: blockByDate.get(date) ?? [],
        // null on a day that fed nothing — exactly the days whose FED cell has
        // nothing to open.
        fedBlend: blendByDate.get(date) ?? null,
        shifts: shiftByDate.get(date) ?? [],
      });
    }
  }

  // --- the BLOCKS USED table, per campaign and for the group ---
  // ₱ IS STRIPPED HERE, before the payload leaves the server: four fields on
  // each shape, nulled together, exactly as the day row's fed_php_kg and the
  // rollup's seven are. Everything else on these rows is peso-free.
  const blocksByCampaign = new Map<string, OpsCampaignBlock[]>();
  for (const c of perCampaign) {
    blocksByCampaign.set(
      c.key,
      c.campaignBlocks.map((b) => ({
        campaignKey: String(b.campaign_key),
        batchId: String(b.batch_id),
        batchCode: String(b.batch_code ?? ''),
        blockLoc: str(b.block_loc),
        campaignFedKg: num(b.campaign_fed_kg),
        campaignSundryKg: num(b.campaign_sundry_kg),
        campaignFeedDays: int(b.campaign_feed_days),
        firstCampaignFeedDate: str(b.first_campaign_feed_date),
        lastCampaignFeedDate: str(b.last_campaign_feed_date),
        firstFedDate: str(b.first_fed_date),
        closeDate: str(b.close_date),
        isClosed: bool(b.is_closed),
        state: String(b.status ?? ''),
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
        isFullyPriced: bool(b.is_fully_priced),
        inPriceSet: bool(b.in_price_set),
        feedCount: num(b.feed_count),
        deliveryCount: num(b.delivery_count),
        // ₱ — the four, stripped together.
        deliveredPhpKg: showPrices ? num(b.delivered_php_kg) : null,
        pricedDeliveredPhpKg: showPrices ? num(b.priced_delivered_php_kg) : null,
        actualFedPhpKg: showPrices ? num(b.actual_fed_php_kg) : null,
        upliftPhpKg: showPrices ? num(b.uplift_php_kg) : null,
      })),
    );
  }

  const groupBlocks: OpsGroupBlock[] = groupBlockRows.map((gb) => ({
    batchId: String(gb.batch_id),
    batchCode: String(gb.batch_code ?? ''),
    blockLoc: str(gb.block_loc),
    campaignCount: int(gb.campaign_count),
    campaignKeys: (gb.campaign_keys as string[] | null) ?? [],
    groupFedKg: num(gb.group_fed_kg),
    groupSundryKg: num(gb.group_sundry_kg),
    groupFeedDays: int(gb.group_feed_days),
    firstGroupFeedDate: str(gb.first_group_feed_date),
    lastGroupFeedDate: str(gb.last_group_feed_date),
    firstFedDate: str(gb.first_fed_date),
    closeDate: str(gb.close_date),
    isClosed: bool(gb.is_closed),
    state: String(gb.status ?? ''),
    totalFedKg: num(gb.total_fed_kg),
    totalOutKg: num(gb.total_out_kg),
    deliveredKg: num(gb.delivered_kg),
    weightLostKg: num(gb.weight_lost_kg),
    lossPct: num(gb.loss_pct),
    resikoKg: num(gb.resiko_kg),
    resikoPct: num(gb.resiko_pct),
    balanceKg: num(gb.balance_kg),
    hasSundryOutflow: bool(gb.has_sundry_outflow),
    sundryKg: num(gb.sundry_kg),
    hasUnpricedDelivery: bool(gb.has_unpriced_delivery),
    unpricedDeliveryCount: num(gb.unpriced_delivery_count),
    isFullyPriced: bool(gb.is_fully_priced),
    inPriceSet: bool(gb.in_price_set),
    feedCount: num(gb.feed_count),
    deliveryCount: num(gb.delivery_count),
    // ₱ — the four, stripped together.
    deliveredPhpKg: showPrices ? num(gb.delivered_php_kg) : null,
    pricedDeliveredPhpKg: showPrices ? num(gb.priced_delivered_php_kg) : null,
    actualFedPhpKg: showPrices ? num(gb.actual_fed_php_kg) : null,
    upliftPhpKg: showPrices ? num(gb.uplift_php_kg) : null,
  }));

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
      blocks: blocksByCampaign.get(String(r.campaign_key)) ?? [],
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

    // THE BLOCKS-USED TABLE'S FOOTER, totalled in SQL over the same rows the
    // modal renders. No ₱ among them, so nothing is gated here.
    blocksDeliveredKg: num(r.blocks_delivered_kg),
    blocksClosedDeliveredKg: num(r.blocks_closed_delivered_kg),
    blocksTotalFedKg: num(r.blocks_total_fed_kg),
    blocksResikoKg: num(r.blocks_resiko_kg),
    blocksClosedResikoLossPct: num(r.blocks_closed_resiko_loss_pct),

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
        producedKgWasteReported: num(groupRow.produced_kg_waste_reported),

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

        blocks: groupBlocks,
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
