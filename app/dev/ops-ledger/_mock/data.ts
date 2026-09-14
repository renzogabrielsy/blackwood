import {
    GRADES,
    WASTE_STREAMS,
    type BlockFeed,
    type BlockState,
    type Campaign,
    type CampaignRollup,
    type Grade,
    type LedgerDay,
    type OpsLedgerData,
    type ShiftDetail,
    type WasteKey,
} from './types';

// ═════════════════════════════════════════════════════════════════════════════════
// The static mock ADAPTER. DEV DRAFT — no Supabase, no network, no clock.
//
// DETERMINISTIC BY CONSTRUCTION. Every figure is a pure function of the date string, so
// the same page renders the same numbers on every machine, in every screenshot, forever.
// That is not tidiness: three layouts are meant to be COMPARED, and a comparison between
// two pages holding different random numbers compares nothing.
//
// Nothing here is a claim about the real plant. The magnitudes are shaped to Renzo's July
// (30–42 t fed on a weekday, 25–31 t produced, Sundays blank, two shifts, 0–4 h downtime,
// 6–10 blocks drawn from per day) so the DENSITY is honest — a layout that looks fine on
// four tidy rows and falls apart on a real month has told you nothing.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Determinism ─────────────────────────────────────────────────────────────────

/** FNV-1a over a string → a 32-bit seed. Stable across engines. */
function hash(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32 — a tiny PRNG. Seeded per DAY, so a day's numbers never move. */
function rng(seed: string): () => number {
    let a = hash(seed);
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
const round = (n: number, dp = 0) => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
};

// ─── The calendar, done by hand ──────────────────────────────────────────────────
//
// `date-fns` is in the project and would do this in one line — but every date here is
// already a `yyyy-MM-dd` STRING and the one thing that must never happen to it is a trip
// through `new Date(...)`, which reads a bare date as UTC midnight and can hand back the
// previous day in Manila. The three functions below never build a `Date` at all.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(y: number, m: number): number {
    if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    return MONTH_DAYS[m - 1];
}

/** `2026-06-30` → `2026-07-01`. Pure string arithmetic. */
function nextDate(iso: string): string {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    if (d < daysInMonth(y, m)) return `${y}-${String(m).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
    if (m < 12) return `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return `${y + 1}-01-01`;
}

/** Sakamoto's day-of-week. Exact, integer-only, no `Date`. */
function dayName(iso: string): string {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const yy = m < 3 ? y - 1 : y;
    return DAY_NAMES[(yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7];
}

function datesBetween(start: string, end: string): string[] {
    const out: string[] = [];
    let cur = start;
    // Bounded so a malformed pair can never spin: no campaign is 400 days long.
    for (let i = 0; i < 400 && cur <= end; i++) {
        out.push(cur);
        cur = nextDate(cur);
    }
    return out;
}

// ─── The campaigns ───────────────────────────────────────────────────────────────
//
// THE BATCH CLOCK, NOT THE CALENDAR. Renzo's JULY opens on 2026-06-30 and closes on
// 07-30; a campaign routinely straddles a month boundary and a changeover day carries the
// incoming batch. Four of them, so a group can deliberately EXCLUDE one (Q3 = JULY +
// AUGUST + SEPTEMBER, with JUNE sitting right there unpicked).

export const CAMPAIGNS: Campaign[] = [
    { id: 'JUNE-2026', label: 'JUNE 2026', batch: 'JUNE', year: 2026, startDate: '2026-05-30', endDate: '2026-06-29' },
    { id: 'JULY-2026', label: 'JULY 2026', batch: 'JULY', year: 2026, startDate: '2026-06-30', endDate: '2026-07-30' },
    { id: 'AUGUST-2026', label: 'AUGUST 2026', batch: 'AUGUST', year: 2026, startDate: '2026-07-31', endDate: '2026-08-28' },
    { id: 'SEPTEMBER-2026', label: 'SEPTEMBER 2026', batch: 'SEPTEMBER', year: 2026, startDate: '2026-08-29', endDate: '2026-09-27' },
];

/** Q3 in Renzo's sheet is these three — JUNE is the one a group builder leaves out. */
export const Q3_CAMPAIGN_IDS = ['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026'];

// ─── Blocks ──────────────────────────────────────────────────────────────────────

const WAREHOUSES = ['A', 'B', 'C', 'D'] as const;

interface BlockDef {
    batchCode: string;
    blockLoc: string;
    dateOpen: string;
    dateClose: string | null;
    state: BlockState;
    arrivedKg: number;
    resikoKg: number;
}

/**
 * A pool of blocks per campaign, deterministic from the campaign id.
 *
 * A block belongs to the month it was BUILT in, which is one month behind the campaign
 * that eats it — so JULY 2026 feeds out of `JUNE-26-BLK*`, which is exactly what the real
 * yard looks like. Roughly two thirds of a campaign's pool is CLOSED by the end of it and
 * carries a resiko figure; the rest is still open and carries 0.
 */
function blocksFor(campaign: Campaign): BlockDef[] {
    const r = rng(`blocks:${campaign.id}`);
    const prevMonth = campaign.id === 'JUNE-2026' ? 'MAY' : CAMPAIGNS[CAMPAIGNS.findIndex((c) => c.id === campaign.id) - 1].batch;
    const count = 14;
    const out: BlockDef[] = [];
    for (let i = 0; i < count; i++) {
        const arrivedKg = round(between(r, 240_000, 520_000));
        const closed = r() < 0.62;
        const lossPct = between(r, 0.021, 0.098);
        out.push({
            batchCode: `${prevMonth}-26-BLK${i + 1}`,
            blockLoc: `${WAREHOUSES[i % 4]}-${String(1 + Math.floor(i / 4) * 4 + (i % 4)).padStart(2, '0')}${'AB'[i % 2]}`,
            dateOpen: campaign.startDate,
            dateClose: closed ? campaign.endDate : null,
            state: closed ? 'CLOSED' : i < 4 ? 'IN-USE' : 'STORED',
            arrivedKg,
            resikoKg: closed ? round(arrivedKg * lossPct) : 0,
        });
    }
    return out;
}

// ─── One day ─────────────────────────────────────────────────────────────────────

const SUPERVISORS = ['M. CONTINEDO', 'I. EDILLO', 'R. ABAYON', 'J. PAQUIBOT'];
const DT_REASONS = [
    'CLEANED SCREEN RS 2A AND RS 2B',
    'CHANGED CONVEYOR BELT — LINE 2',
    'RETORT DOOR SEAL REPLACEMENT',
    'POWER INTERRUPTION — MAIN FEEDER',
    'SCHEDULED GREASING, MAGNET CHECK',
];

/**
 * Split `total` into `n` parts by the supplied weights, with the REMAINDER carried onto
 * the last part, so the parts sum to the total EXACTLY.
 *
 * This is the whole reason it exists rather than three `Math.round` calls: a grade split
 * whose parts do not add up to the day's own production is the kind of thing an operator
 * spots in half a second, and it would make the drafts look broken for a rounding reason.
 */
function splitExact(total: number, weights: number[]): number[] {
    const sum = weights.reduce((a, b) => a + b, 0);
    const parts = weights.map((w) => Math.round((total * w) / sum));
    const drift = total - parts.reduce((a, b) => a + b, 0);
    parts[parts.length - 1] += drift;
    return parts;
}

function buildDay(date: string, campaign: Campaign, pool: BlockDef[]): LedgerDay {
    const day = dayName(date);
    const r = rng(`day:${date}`);
    // Sunday is the plant's rest day. A handful of Saturdays run short rather than not at
    // all, which is why the two are separate tests and not one `isWeekend`.
    const restDay = day === 'Sun';

    const zeroGrades = { '3X50': 0, '2X6': 0, '4X8': 0 } as Record<Grade, number>;
    const zeroWaste = Object.fromEntries(WASTE_STREAMS.map((w) => [w.key, 0])) as Record<WasteKey, number>;

    if (restDay) {
        return {
            date, day, campaignId: campaign.id, restDay: true,
            fedPhpKg: null, fedKg: 0, producedKg: 0, lossKg: 0, shifts: 0, dtHours: 0,
            producedByGrade: { ...zeroGrades }, waste: { ...zeroWaste }, blocks: [], shiftDetail: [],
        };
    }

    const fedKg = Math.round(between(r, day === 'Sat' ? 18_000 : 30_000, day === 'Sat' ? 27_000 : 42_000) / 10) * 10;
    const yieldFraction = between(r, 0.795, 0.868);
    const producedKg = Math.round(fedKg * yieldFraction);
    const lossKg = fedKg - producedKg;
    const fedPhpKg = round(between(r, 43.5, 52.25), 4);
    const shifts = 2;
    const dtHours = r() < 0.42 ? round(between(r, 0.25, 4), 2) : 0;

    // 3X50 dominates (measured in the real plant at ~70% of a mixed month); the other two
    // trade places. The three parts sum to `producedKg` exactly.
    const gradeParts = splitExact(producedKg, [between(r, 0.62, 0.78), between(r, 0.10, 0.22), between(r, 0.06, 0.18)]);
    const producedByGrade = Object.fromEntries(GRADES.map((g, i) => [g, gradeParts[i]])) as Record<Grade, number>;

    // Recorded waste is 2–4% of what was fed — a small fraction of `lossKg`, because most
    // of the loss left as moisture and nobody weighs that.
    const wasteTotal = Math.round(fedKg * between(r, 0.021, 0.041));
    const wasteParts = splitExact(wasteTotal, WASTE_STREAMS.map(() => between(r, 0.4, 1.6)));
    const waste = Object.fromEntries(WASTE_STREAMS.map((w, i) => [w.key, wasteParts[i]])) as Record<WasteKey, number>;

    // 6–10 blocks drawn from, chosen deterministically from the campaign's pool, and their
    // kg summing to the day's own `fedKg` exactly.
    const blockCount = 6 + Math.floor(r() * 5);
    const offset = Math.floor(r() * pool.length);
    const picked = Array.from({ length: blockCount }, (_, i) => pool[(offset + i * 3) % pool.length]);
    const blockKg = splitExact(fedKg, picked.map(() => between(r, 0.5, 1.8)));
    const blocks: BlockFeed[] = picked.map((b, i) => ({
        batchCode: b.batchCode,
        blockLoc: b.blockLoc,
        dateOpen: b.dateOpen,
        dateClose: b.dateClose,
        state: b.state,
        fedKg: blockKg[i],
        arrivedKg: b.arrivedKg,
        resikoKg: b.resikoKg,
    }));

    // Two shifts. Every figure splits exactly, including each grade, so a breakdown can be
    // added up against the row it opened from.
    const shiftWeights = [between(r, 0.44, 0.56), 1];
    shiftWeights[1] = 1 - shiftWeights[0];
    const shiftFed = splitExact(fedKg, shiftWeights);
    const shiftProd = splitExact(producedKg, shiftWeights);
    const shiftDt = splitExact(Math.round(dtHours * 100), shiftWeights).map((v) => v / 100);
    const dtReason = DT_REASONS[Math.floor(r() * DT_REASONS.length)];
    const shiftDetail: ShiftDetail[] = [0, 1].map((i) => ({
        shift: (i + 1) as 1 | 2,
        window: i === 0 ? '06:00–18:00' : '18:00–06:00',
        fedKg: shiftFed[i],
        producedKg: shiftProd[i],
        dtHours: shiftDt[i],
        dtReason: shiftDt[i] > 0 ? dtReason : '',
        producedByGrade: Object.fromEntries(
            GRADES.map((g) => [g, splitExact(producedByGrade[g], shiftWeights)[i]]),
        ) as Record<Grade, number>,
        supervisor: SUPERVISORS[(hash(date) + i) % SUPERVISORS.length],
    }));

    return {
        date, day, campaignId: campaign.id, restDay: false,
        fedPhpKg, fedKg, producedKg, lossKg, shifts, dtHours,
        producedByGrade, waste, blocks, shiftDetail,
    };
}

// ─── The rollup ──────────────────────────────────────────────────────────────────

function rollupFor(campaign: Campaign, days: LedgerDay[]): CampaignRollup {
    const worked = days.filter((d) => !d.restDay);
    const rcFedKg = worked.reduce((s, d) => s + d.fedKg, 0);
    const producedKg = worked.reduce((s, d) => s + d.producedKg, 0);
    const fedValuePhp = worked.reduce((s, d) => s + d.fedKg * (d.fedPhpKg ?? 0), 0);
    // Weighted by kg, never the mean of the daily prices — the same rule every campaign
    // price view in the app carries.
    const fedPrice = rcFedKg > 0 ? fedValuePhp / rcFedKg : 0;

    const pool = blocksFor(campaign);
    const closed = pool.filter((b) => b.state === 'CLOSED');
    const blockResikoKg = closed.reduce((s, b) => s + b.resikoKg, 0);
    const closedArrived = closed.reduce((s, b) => s + b.arrivedKg, 0);
    // The money already spent does not shrink with the pile, so every kilo that actually
    // reached the plant cost MORE than the arrival price. That uplift is the whole point
    // of carrying an "actual" figure beside the delivered one.
    const uplift = closedArrived > 0 ? closedArrived / (closedArrived - blockResikoKg) : 1;
    const actualFedPrice = fedPrice * uplift;
    const yieldPct = rcFedKg > 0 ? producedKg / rcFedKg : 0;

    const r = rng(`rollup:${campaign.id}`);
    const rcInventoryTons = round(between(r, 8_900, 11_400), 3);
    const buyingTons = round(between(r, 900, 1_450), 3);

    return {
        campaignId: campaign.id,
        label: campaign.label,
        rcFedKg,
        producedKg,
        yieldPct,
        lossKg: rcFedKg - producedKg,
        blockResikoKg,
        fedPrice: round(fedPrice, 4),
        actualFedPrice: round(actualFedPrice, 4),
        pcCost: yieldPct > 0 ? round(fedPrice / yieldPct, 4) : 0,
        truePcCost: yieldPct > 0 ? round(actualFedPrice / yieldPct, 4) : 0,
        rcInventoryTons,
        rcInventoryPhp: round(rcInventoryTons * 1000 * between(r, 36.4, 38.2), 2),
        buyingTons,
        buyingPhp: round(buyingTons * 1000 * between(r, 41.5, 47.8), 2),
        workingDays: worked.length,
        restDays: days.length - worked.length,
        dtHours: round(worked.reduce((s, d) => s + d.dtHours, 0), 2),
        blocksOpened: pool.length,
        blocksClosed: closed.length,
    };
}

// ─── The adapter ─────────────────────────────────────────────────────────────────

/**
 * Built ONCE at module scope and frozen into a module constant.
 *
 * Three pages import it and each renders it repeatedly; rebuilding ~120 days of blocks and
 * shift splits on every render would be the single most expensive thing on the screen, and
 * it would also hand every consumer a new array identity, which is exactly what a `useMemo`
 * dependency cannot survive.
 */
function build(): OpsLedgerData {
    const days: LedgerDay[] = [];
    const rollups: CampaignRollup[] = [];
    for (const campaign of CAMPAIGNS) {
        const pool = blocksFor(campaign);
        const campaignDays = datesBetween(campaign.startDate, campaign.endDate).map((d) =>
            buildDay(d, campaign, pool),
        );
        days.push(...campaignDays);
        rollups.push(rollupFor(campaign, campaignDays));
    }
    return { campaigns: CAMPAIGNS, days, rollups, grades: [...GRADES], canViewPrices: true };
}

export const OPS_LEDGER_DATA: OpsLedgerData = build();

/** The days of one campaign, in date order. */
export function daysOf(campaignId: string): LedgerDay[] {
    return OPS_LEDGER_DATA.days.filter((d) => d.campaignId === campaignId);
}

/** The days of several campaigns, in campaign order then date order. */
export function daysOfMany(campaignIds: readonly string[]): LedgerDay[] {
    return campaignIds.flatMap((id) => daysOf(id));
}

export function campaignOf(campaignId: string): Campaign {
    return CAMPAIGNS.find((c) => c.id === campaignId) ?? CAMPAIGNS[0];
}

export function rollupOf(campaignId: string): CampaignRollup {
    return OPS_LEDGER_DATA.rollups.find((r) => r.campaignId === campaignId) ?? OPS_LEDGER_DATA.rollups[0];
}

/**
 * The DISTINCT blocks a set of campaigns fed, each with the kg drawn from it over the
 * whole selection — the column set of the "Blocks fed" lens.
 *
 * Ordered by first appearance, which is what makes the matrix read left-to-right as the
 * campaign opened blocks rather than alphabetically.
 */
export function blocksFedBy(days: readonly LedgerDay[]): { batchCode: string; blockLoc: string; state: BlockState; totalKg: number }[] {
    const seen = new Map<string, { batchCode: string; blockLoc: string; state: BlockState; totalKg: number }>();
    for (const d of days) {
        for (const b of d.blocks) {
            const found = seen.get(b.batchCode);
            if (found) found.totalKg += b.fedKg;
            else seen.set(b.batchCode, { batchCode: b.batchCode, blockLoc: b.blockLoc, state: b.state, totalKg: b.fedKg });
        }
    }
    return [...seen.values()];
}
