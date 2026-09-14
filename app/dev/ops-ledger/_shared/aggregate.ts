import { OPS_LEDGER_DATA, daysOfMany, rollupOf } from '../_mock/data';
import { GRADES, type CampaignRollup, type Grade, type LedgerDay } from '../_mock/types';

// ═════════════════════════════════════════════════════════════════════════════════
// THE GROUP — requirement (3) in one pure function.
//
// A GROUP is a hand-picked set of campaigns ("Q3 2026 = JULY + AUGUST + SEPTEMBER"), and
// the only thing the three drafts need from it is: (a) the member campaigns in order, and
// (b) ONE rollup describing the whole set, so a KPI strip has something to print.
//
// `groupRollup` re-sums the DAYS rather than averaging the per-campaign rollups, and that
// is the one decision in this file worth reading twice. A yield is a ratio, and the mean
// of three ratios is not the ratio of the three sums — averaging JULY's 82.9%, AUGUST's
// 83.4% and SEPTEMBER's 81.1% gives an answer that belongs to no quarter. Every ₱/kg here
// is weighted by the kilos underneath it for the same reason.
//
// In the live version this whole file is a SQL view. It is TypeScript here only because
// there is no database behind a draft — which is also why it is one small pure module with
// its inputs named, rather than arithmetic smeared through three page components.
// ═════════════════════════════════════════════════════════════════════════════════

export interface GroupDefinition {
    id: string;
    label: string;
    campaignIds: string[];
}

/** The presets the group builder offers before anyone has built anything. */
export const GROUP_PRESETS: GroupDefinition[] = [
    { id: 'q3-2026', label: 'Q3 2026', campaignIds: ['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026'] },
    { id: 'q2-tail', label: 'JUNE + JULY', campaignIds: ['JUNE-2026', 'JULY-2026'] },
    { id: 'all-2026', label: 'All four', campaignIds: ['JUNE-2026', 'JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026'] },
];

/**
 * The whole group as one rollup row, plus the member rows beside it.
 *
 * `members` is what the group's analysis table prints one line per; `total` is what the
 * KPI strip prints. They are produced together so the strip and the table can never
 * disagree about what the quarter did.
 */
export interface GroupRollup {
    label: string;
    members: CampaignRollup[];
    total: CampaignRollup;
    days: LedgerDay[];
    /** Kg per grade over the whole group — the mix band. */
    producedByGrade: Record<Grade, number>;
}

const EMPTY_TOTAL: CampaignRollup = {
    campaignId: '', label: '', rcFedKg: 0, producedKg: 0, yieldPct: 0, lossKg: 0, blockResikoKg: 0,
    fedPrice: 0, actualFedPrice: 0, pcCost: 0, truePcCost: 0, rcInventoryTons: 0, rcInventoryPhp: 0,
    buyingTons: 0, buyingPhp: 0, workingDays: 0, restDays: 0, dtHours: 0, blocksOpened: 0, blocksClosed: 0,
};

export function groupRollup(campaignIds: readonly string[], label: string): GroupRollup {
    // Ordered by the canonical campaign order, never by click order — a quarter whose
    // months reshuffle when you untick and retick one is not a quarter.
    const ordered = OPS_LEDGER_DATA.campaigns.map((c) => c.id).filter((id) => campaignIds.includes(id));
    const members = ordered.map(rollupOf);
    const days = daysOfMany(ordered);

    if (members.length === 0) {
        return {
            label,
            members: [],
            total: { ...EMPTY_TOTAL, label },
            days: [],
            producedByGrade: { '3X50': 0, '2X6': 0, '4X8': 0 },
        };
    }

    const rcFedKg = members.reduce((s, m) => s + m.rcFedKg, 0);
    const producedKg = members.reduce((s, m) => s + m.producedKg, 0);
    const blockResikoKg = members.reduce((s, m) => s + m.blockResikoKg, 0);
    // Weighted by fed kg. Never `mean(m.fedPrice)`.
    const fedPrice = rcFedKg > 0 ? members.reduce((s, m) => s + m.fedPrice * m.rcFedKg, 0) / rcFedKg : 0;
    const actualFedPrice = rcFedKg > 0 ? members.reduce((s, m) => s + m.actualFedPrice * m.rcFedKg, 0) / rcFedKg : 0;
    const yieldPct = rcFedKg > 0 ? producedKg / rcFedKg : 0;

    const producedByGrade = Object.fromEntries(
        GRADES.map((g) => [g, days.reduce((s, d) => s + d.producedByGrade[g], 0)]),
    ) as Record<Grade, number>;

    return {
        label,
        members,
        days,
        producedByGrade,
        total: {
            campaignId: ordered.join('+'),
            label,
            rcFedKg,
            producedKg,
            yieldPct,
            lossKg: rcFedKg - producedKg,
            blockResikoKg,
            fedPrice,
            actualFedPrice,
            pcCost: yieldPct > 0 ? fedPrice / yieldPct : 0,
            truePcCost: yieldPct > 0 ? actualFedPrice / yieldPct : 0,
            // Stock is a LEVEL, not a flow: a quarter's closing inventory is the LAST
            // campaign's, not the sum of three months' closing balances. Summing it would
            // treble the yard.
            rcInventoryTons: members[members.length - 1].rcInventoryTons,
            rcInventoryPhp: members[members.length - 1].rcInventoryPhp,
            // Buying IS a flow, so it sums.
            buyingTons: members.reduce((s, m) => s + m.buyingTons, 0),
            buyingPhp: members.reduce((s, m) => s + m.buyingPhp, 0),
            workingDays: members.reduce((s, m) => s + m.workingDays, 0),
            restDays: members.reduce((s, m) => s + m.restDays, 0),
            dtHours: Math.round(members.reduce((s, m) => s + m.dtHours, 0) * 100) / 100,
            blocksOpened: members.reduce((s, m) => s + m.blocksOpened, 0),
            blocksClosed: members.reduce((s, m) => s + m.blocksClosed, 0),
        },
    };
}
