// ═════════════════════════════════════════════════════════════════════════════════
// COLUMN GROUPS — and THE UNIFICATION THESIS, stated as data.
//
// ── The thesis ───────────────────────────────────────────────────────────────────
// The plant operations ledger and `/inventory/rc-movement` are NOT two screens. They are
// one screen showing two different column groups over the SAME row spine.
//
// Both are "one row per calendar day, on the PRODUCTION BATCH clock, with the same five
// things pinned on the left" — Date · Day · Fed ₱/kg · Total fed · Produced. RC Movement
// then puts ONE COLUMN PER OPENED BLOCK to the right of that, with kg fed in the cells.
// The ledger instead puts grades, waste streams and a blocks-used panel there. That is the
// entire difference between them: which column groups are switched on.
//
// So `blocksFed` below is not a special case bolted on to a ledger. It is the sixth entry
// in the same registry as the other five, and "RC Movement" is a PRESET — a saved set of
// toggles — rather than a route. All three drafts are built around that claim, and each
// one says so in its own UI copy, because the claim is the thing Renzo has to react to.
//
// ── Why a registry rather than five booleans ─────────────────────────────────────
// Three drafts consume this. A boolean per group in each of them is fifteen booleans and
// three different opinions about what "Losses" means. Declared once, a layout iterates it:
// it never learns the names, and a seventh group appears in all three at once.
// ═════════════════════════════════════════════════════════════════════════════════

export type ColumnGroupId =
    | 'production'
    | 'costs'
    | 'grades'
    | 'losses'
    | 'blocksUsed'
    | 'blocksFed';

export interface ColumnGroupSpec {
    id: ColumnGroupId;
    /** The chip label. Short — this sits in a rail of six. */
    label: string;
    /** One sentence, shown on hover. What the group actually puts on the sheet. */
    hint: string;
    /**
     * True when the group carries ₱ and must therefore disappear entirely for a viewer
     * who may not see prices.
     *
     * The live rule is stronger than hiding: the SERVER nulls the field before the payload
     * leaves (CLAUDE.md → "Price gating"). This flag is what a draft can honestly express
     * — it removes the column from the coordinate space rather than blanking it, which is
     * the shape the real screen already uses.
     */
    carriesPrice?: boolean;
    /**
     * How WIDE this group makes the sheet, in px, at the mock's data volume.
     *
     * Stated so a toggle rail can warn before a click rather than after: `blocksFed` over a
     * three-month group is ~40 block columns, and a person who does not know that reads the
     * resulting horizontal scrollbar as a bug.
     */
    approxWidth: number;
}

export const COLUMN_GROUPS: readonly ColumnGroupSpec[] = [
    {
        id: 'costs',
        label: 'Costs',
        hint: 'Fed ₱/kg for the day, and the day’s fed value. The only ₱ on the sheet.',
        carriesPrice: true,
        approxWidth: 236,
    },
    {
        id: 'production',
        label: 'Production',
        hint: 'Total fed · produced · loss · shifts · downtime hours — the ledger’s spine.',
        approxWidth: 500,
    },
    {
        id: 'grades',
        label: 'Grades',
        hint: 'Kg produced per finished grade: 3X50 · 2X6 · 4X8. Sums to Produced.',
        approxWidth: 288,
    },
    {
        id: 'losses',
        label: 'Losses',
        hint: 'The eight recorded waste streams. They do NOT sum to Loss — most loss is moisture.',
        approxWidth: 720,
    },
    {
        id: 'blocksUsed',
        label: 'Blocks used',
        hint: 'The blocks drawn from that day, as a sub-panel: batch · loc · open · close · state · fed · arrived · resiko.',
        approxWidth: 300,
    },
    {
        id: 'blocksFed',
        label: 'Blocks fed',
        hint: 'ONE COLUMN PER BLOCK, kg fed in the cells. This group IS the RC Movement matrix.',
        approxWidth: 1480,
    },
];

export function groupSpec(id: ColumnGroupId): ColumnGroupSpec {
    return COLUMN_GROUPS.find((g) => g.id === id) ?? COLUMN_GROUPS[0];
}

// ─── Presets — a "screen" is a saved set of toggles ──────────────────────────────

export interface LensPreset {
    id: string;
    label: string;
    /** What this preset is FOR, in one line. Shown under the segmented control. */
    hint: string;
    groups: ColumnGroupId[];
}

/**
 * THE PAYOFF OF THE THESIS.
 *
 * `rc-movement` is the same row spine as `ledger` with one group swapped. If the two
 * screens really are one screen, this array is the proof — and if they are not, this is
 * exactly where the argument falls over, which is why it is three lines rather than a
 * paragraph.
 */
export const LENS_PRESETS: readonly LensPreset[] = [
    {
        id: 'ledger',
        label: 'Ledger',
        hint: 'Renzo’s Q3 sheet: production, grades, losses and the blocks-used panel.',
        groups: ['costs', 'production', 'grades', 'losses', 'blocksUsed'],
    },
    {
        id: 'rc-movement',
        label: 'RC Movement',
        hint: 'The same days, same pinned columns — one column per block instead of the ledger groups.',
        groups: ['costs', 'production', 'blocksFed'],
    },
    {
        id: 'both',
        label: 'Both',
        hint: 'Every group at once. Wide on purpose — this is what "unite them" costs in pixels.',
        groups: ['costs', 'production', 'grades', 'losses', 'blocksUsed', 'blocksFed'],
    },
];

export function presetFor(groups: readonly ColumnGroupId[]): LensPreset | null {
    return (
        LENS_PRESETS.find(
            (p) => p.groups.length === groups.length && p.groups.every((g) => groups.includes(g)),
        ) ?? null
    );
}
