import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { requireDraftAccess } from './_shared/gate';

// ═════════════════════════════════════════════════════════════════════════════════
// /dev/ops-ledger — three interactive DRAFTS of the plant operations ledger.
//
// DEV DRAFTS, and they are meant to be REVIEWED ON THE LIVE SITE — which is why the gate
// is an auth gate rather than `/dev/table-playground`'s env gate. In production these
// render only for a signed-in Owner / Admin / Dev: an anonymous visitor is stopped by the
// middleware's login wall, and a signed-in under-privileged one gets a 404. Locally they
// are unrestricted. One definition, in `_shared/gate.ts`, called by all four pages.
//
// They read NOTHING. No Supabase client, no server action, no `view_*`: the whole thing
// hangs off a deterministic in-memory mock in `_mock/`, so it is purely a conversation
// about layout — and there is no data behind the gate to leak even in principle.
// ═════════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

interface Draft {
    href: string;
    letter: string;
    title: string;
    /** The AXIS this layout explores — the one question it is asking. */
    axis: string;
    body: string;
    tradeoff: string;
}

const DRAFTS: Draft[] = [
    {
        href: '/dev/ops-ledger/a',
        letter: 'A',
        title: 'Excel faithful',
        axis: 'How little has to change if the sheet stays the sheet?',
        body:
            'Renzo’s Q3 tab rendered as-is on the Blackwood Table — one campaign at a time, picked from month tabs across the top, with Date and Day frozen and the six column groups on toggle chips. Building a group stacks the picked months as separate tables under one KPI strip, exactly the way the workbook stacks JULY, AUGUST and SEPTEMBER under EOQ3. A chevron on each day row opens child rows inside the grid itself.',
        tradeoff:
            'Most familiar and the only draft where a breakdown lives in the grid’s own coordinate space (so it copies out with the day above it). But a group is N separate tables, so nothing is directly comparable across months without scrolling between them.',
    },
    {
        href: '/dev/ops-ledger/b',
        letter: 'B',
        title: 'Group-first dashboard',
        axis: 'What if the GROUP is the unit and the days are the evidence?',
        body:
            'The quarter comes first: a KPI strip and a compact month-by-month analysis table — the EOQ tab, live — and only then the day ledger, as ONE continuous table with month heading rows inside it rather than three separate grids. A segmented control swaps the lens between Ledger, RC Movement and Both. Clicking a day opens a side panel, so the sheet never moves under the reader.',
        tradeoff:
            'The best draft for answering “how did Q3 do?” and for comparing months side by side. The cost is that the day ledger is now ~90 rows of one table, so a specific date is further from the top than it is in A.',
    },
    {
        href: '/dev/ops-ledger/c',
        letter: 'C',
        title: 'Split lens',
        axis: 'What if the day spine and the lens are two panes instead of one sheet?',
        body:
            'The day spine — date, day, fed, produced, yield — is pinned in its own left pane and never scrolls sideways. The right pane is whichever lens you pick, scrolling horizontally on its own behind a divider you can drag. Campaigns are chips along the top rather than a popover. An expanded day opens inline underneath its row, across both panes.',
        tradeoff:
            'The only draft where a 40-column block matrix cannot push the date off screen, and the one that makes “Ledger vs RC Movement” feel like a swap rather than a navigation. The cost is a second scroll region to understand, and a divider is a control a spreadsheet does not have.',
    },
];

export default async function OpsLedgerIndexPage() {
    await requireDraftAccess();

    return (
        <main className="min-h-dvh bg-background text-foreground">
            <div className="mx-auto flex max-w-[860px] flex-col gap-6 px-4 py-8 sm:px-6">
                <header className="animate-fade-up flex flex-col gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        dev draft · no database
                    </span>
                    <h1 className="text-2xl font-semibold tracking-tight">Plant operations ledger</h1>
                    <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
                        Three interactive drafts of one screen: a day-per-row operations ledger on
                        the production-batch clock, with switchable column groups, a group builder,
                        and an expandable day. Every figure is mock data generated from the date
                        string — deterministic, realistic in magnitude, and connected to nothing.
                    </p>
                </header>

                {/* THE THESIS. It sits above the drafts because all three are built on it, and
                    it is the thing that most needs to be argued with. */}
                <section className="animate-fade-up rounded-lg border border-foreground/20 bg-card p-4">
                    <h2 className="text-xs font-semibold uppercase tracking-wide">
                        The claim all three drafts are built on
                    </h2>
                    <p className="mt-2 max-w-[72ch] text-sm leading-relaxed">
                        This ledger and <span className="font-mono text-[13px]">/inventory/rc-movement</span>{' '}
                        are not two screens. They are one screen showing two different column groups
                        over the same row spine.
                    </p>
                    <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
                        RC Movement is already days-as-rows on the campaign clock with five pinned
                        columns — Date, Day, Fed ₱/kg, Total fed, Produced — and then one column per
                        opened block. The ledger has the identical spine and puts grades, waste
                        streams and a blocks-used panel there instead. So{' '}
                        <span className="font-medium text-foreground">
                            “Blocks fed (one column per block)”
                        </span>{' '}
                        is treated throughout as the sixth entry in the same toggle registry as
                        Production, Grades, Losses, Blocks used and Costs — and “RC Movement” is a{' '}
                        <span className="font-medium text-foreground">preset</span>, not a route.
                    </p>
                </section>

                <div className="stagger-children flex flex-col gap-3">
                    {DRAFTS.map((d) => (
                        <Link
                            key={d.href}
                            href={d.href}
                            className="hover-lift group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors duration-150 hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <div className="flex items-center gap-3">
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted font-mono text-sm font-semibold">
                                    {d.letter}
                                </span>
                                <h3 className="text-base font-semibold tracking-tight">{d.title}</h3>
                                <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
                            </div>

                            <p className="text-xs font-medium italic text-muted-foreground">{d.axis}</p>
                            <p className="max-w-[72ch] text-sm leading-relaxed">{d.body}</p>
                            <p className="max-w-[72ch] border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
                                <span className="font-medium uppercase tracking-wide">Trade-off — </span>
                                {d.tradeoff}
                            </p>
                        </Link>
                    ))}
                </div>

                <footer className="border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
                    Shared between all three: the mock adapter in{' '}
                    <span className="font-mono">_mock/</span>, and the group builder, KPI strip,
                    lens switcher, column-group chips and day breakdown in{' '}
                    <span className="font-mono">_shared/</span>. Nothing under{' '}
                    <span className="font-mono">components/shared/</span> or any tenant module was
                    touched. See <span className="font-mono">app/dev/ops-ledger/CONTEXT.md</span>.
                </footer>
            </div>
        </main>
    );
}
