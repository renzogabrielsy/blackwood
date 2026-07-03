import Link from 'next/link';
import { ArrowRight, BarChart3, Table2, Grid3x3, LayoutDashboard } from 'lucide-react';
import { PORTFOLIO, SUPPLIERS, MONTHS, fmt } from './_mock/data';

const DEMOS = [
  {
    href: '/price-demos/demo1',
    n: '01',
    title: 'Terminal',
    icon: BarChart3,
    tagline: 'Dual-axis command view',
    blurb:
      'Volume bars and weighted-price line share one canvas, so the price↔volume relationship reads in a glance. Toggle any supplier to isolate it.',
    bestFor: 'Seeing whether price moves with volume',
    accent: 'text-blue-500',
    ring: 'group-hover:border-blue-500/40',
  },
  {
    href: '/price-demos/demo2',
    n: '02',
    title: 'Ledger',
    icon: Table2,
    tagline: 'Supplier league table',
    blurb:
      'A dense, sortable decision-table — one row per supplier with inline price sparklines, volume mini-bars, trend arrows and cheap/expensive color-coding.',
    bestFor: 'Ranking suppliers & spotting risers',
    accent: 'text-teal-500',
    ring: 'group-hover:border-teal-500/40',
  },
  {
    href: '/price-demos/demo3',
    n: '03',
    title: 'Heatmap',
    icon: Grid3x3,
    tagline: 'Month × supplier matrix',
    blurb:
      'A color-encoded grid. Toggle price or volume and seasonal patterns light up — a supplier whose price climbs all year visibly heats up left to right.',
    bestFor: 'Spotting seasonal & supplier patterns',
    accent: 'text-purple-500',
    ring: 'group-hover:border-purple-500/40',
  },
  {
    href: '/price-demos/demo4',
    n: '04',
    title: 'Analyst Brief',
    icon: LayoutDashboard,
    tagline: 'Executive dashboard',
    blurb:
      'A KPI strip, a hero price-trend chart with year high/low markers, and a grid of per-supplier mini-charts on a shared scale. Built for the monthly review.',
    bestFor: 'A calm, at-a-glance monthly read',
    accent: 'text-amber-500',
    ring: 'group-hover:border-amber-500/40',
  },
];

export default function PriceDemosIndex() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6 md:py-10 animate-blur-in">
      {/* Intro */}
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Planning · Design Concepts
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">
          Delivery Price &amp; Volume Analysis
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Four distinct ways to analyze RC price movement and volume-in over the year, and to track
          each supplier&apos;s price trend. Same data, four visual approaches — open each and pick the
          direction that helps you decide fastest.
        </p>
      </div>

      {/* Shared-data context bar */}
      <div className="mb-8 grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/50 p-4 sm:grid-cols-4">
        <Stat label="Suppliers" value={`${SUPPLIERS.length}`} sub="in the sample" />
        <Stat label="Window" value={`${MONTHS.length} mo`} sub="FY 2026 (mock)" />
        <Stat label="Total volume" value={fmt.tonnes(PORTFOLIO.totalVolumeKg)} sub="across the year" />
        <Stat label="Blended price" value={fmt.php(PORTFOLIO.blendedAvgPrice)} sub="vol-weighted ₱/kg" />
      </div>

      {/* Demo cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 stagger-children">
        {DEMOS.map((d) => {
          const Icon = d.icon;
          return (
            <Link
              key={d.href}
              href={d.href}
              className={`group relative flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm transition-all duration-200 hover-lift ${d.ring}`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                  <Icon className={`h-5 w-5 ${d.accent}`} />
                </span>
                <span className="font-mono text-xs text-muted-foreground/60">{d.n}</span>
              </div>
              <h3 className="text-base font-semibold tracking-tight">
                {d.title}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{d.tagline}</span>
              </h3>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground">{d.blurb}</p>
              <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
                <span className="text-xs text-muted-foreground">
                  <span className="text-muted-foreground/60">Best for: </span>
                  {d.bestFor}
                </span>
                <span className={`flex items-center gap-1 text-xs font-medium ${d.accent}`}>
                  View
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      <p className="mt-8 text-center text-xs text-muted-foreground/70">
        Design concepts for delivery price &amp; volume analysis. Concept 4 (Analyst Brief) has been
        taken forward — it&apos;s live on real data at{' '}
        <Link href="/summaries" className="underline underline-offset-2 hover:text-foreground">
          /summaries
        </Link>
        . The rest remain static sample-data explorations.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground/70">{sub}</p>
    </div>
  );
}
