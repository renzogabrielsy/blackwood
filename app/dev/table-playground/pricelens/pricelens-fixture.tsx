'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The price lens's look rig. See `page.tsx` for why it exists and how it is gated.
//
// Everything below is a LITERAL. There is no Supabase client, no auth helper and no
// server action on this page: the panel's two reads are supplied through its
// `adapter` port from the static payload in `makeLens()`, shaped exactly like the
// data layer's contract (`BlockingPriceLens` / `BlockingMarketBasis`), including the
// invariants the live functions guarantee — Σ shares = 100 and Σ band counts +
// unpriced = total. The cells are the REAL `.blocking-cell blocking-cell-occupied`
// markup with the REAL `.lens-band-*` classes, so the tint, the ring and the text
// contrast are the page's own, not an approximation of them.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';
import { BlockingLensPanel } from '@/app/(app)/inventory/blocking/lens/lens-panel';
import {
  PRICE_LENS,
  PriceLensPanel,
  type PriceLensAdapter,
} from '@/app/(app)/inventory/blocking/lens/price-lens-panel';
import {
  resolveLensCellClass,
  type BlockingLensClassifier,
  type BlockingLensDefinition,
} from '@/app/(app)/inventory/blocking/lens/types';
import type {
  BlockingMarketBasis,
  BlockingPriceBand,
  BlockingPriceLens,
} from '@/app/(app)/inventory/blocking/types';

const MARKET = 39.8568;
const R = 40; // floor(39.8568) + 1 — what SQL returns as `roundedUpPhp`

const BASES: BlockingMarketBasis[] = [
  {
    basisKey: 'this_month',
    marketPhpKg: MARKET,
    pricedKg: 566_870,
    deliveryCount: 37,
    fromDate: '2026-09-01',
    toDate: '2026-09-30',
  },
  {
    basisKey: 'last_month',
    marketPhpKg: 39.9698,
    pricedKg: 824_027,
    deliveryCount: 50,
    fromDate: '2026-08-01',
    toDate: '2026-08-31',
  },
  {
    basisKey: 'last_3_months',
    marketPhpKg: 39.1187,
    pricedKg: 2_292_401,
    deliveryCount: 138,
    fromDate: '2026-07-01',
    toDate: '2026-09-30',
  },
  // Deliberately NULL — the state a lens must never coerce to ₱0.
  {
    basisKey: 'trailing_days',
    marketPhpKg: null,
    pricedKg: 0,
    deliveryCount: 0,
    fromDate: '2026-09-18',
    toDate: '2026-09-19',
  },
];

/** The offsets each `?bands=` shape stands for. */
const SHAPES: Record<string, number[]> = {
  '2': [0],
  '3': [-1, 0],
  '4': [-3, -1, 0],
  '5': [-10, -1, 0, 5],
  '7': [-10, -5, -1, 0, 3, 8],
};

const MOCK_BLOCKS = [
  'A-1A', 'A-2A', 'A-3A', 'A-4A', 'A-5A', 'A-6A', 'A-7A', 'A-8A', 'A-9A', 'A-10A',
  'A-1B', 'A-2B', 'A-3B', 'A-4B', 'A-5B', 'A-6B', 'A-7B', 'A-8B', 'A-9B', 'A-10B',
  'A-1C', 'A-2C', 'A-3C', 'A-4C', 'A-5C', 'A-6C', 'A-7C', 'A-8C', 'A-9C', 'A-10C',
] as const;

interface MockCell {
  loc: string;
  batch: string;
  balance: number;
  totalIn: number;
  php: number | null; // null = UNPRICED (the L-008 placeholder's effect)
  mc: number;
  ash: number;
  bdAstm: number;
}

/** 30 cells with prices spread across the whole scale, plus three unpriced. */
function makeCells(includeUnpriced: boolean): MockCell[] {
  return MOCK_BLOCKS.map((loc, i) => {
    const unpriced = includeUnpriced && i % 11 === 7;
    return {
      loc,
      batch: `SEPT-26-BLK${i + 1}`,
      balance: 120_000 - i * 3_400,
      totalIn: 180_000,
      php: unpriced ? null : 26 + i * 1.05,
      // One in four exceeds the default MC limit (14) so the lab-highlight red is on
      // screen over every band — that is the contrast case worth looking at.
      mc: i % 4 === 0 ? 15.2 : 11.4,
      ash: i % 5 === 0 ? 4.6 : 3.1,
      bdAstm: 0.402,
    };
  });
}

/**
 * Build the payload the SQL function would return for these cells and offsets.
 *
 * This is FIXTURE arithmetic, not production arithmetic: in the app every one of
 * these numbers comes out of `fn_blocking_price_lens` and the panel never adds
 * anything up. It is reproduced here only so the panel has a contract-shaped
 * payload to render, with the live invariants intact.
 */
function makeLens(cells: MockCell[], offsets: number[]): BlockingPriceLens {
  const edges = offsets.map((o) => R + o);
  const bandOf = (php: number) => {
    let idx = 0;
    for (const e of edges) if (php >= e) idx += 1;
    return idx;
  };

  const bandByBlock: Record<string, number> = {};
  const counts = new Array(edges.length + 1).fill(0) as number[];
  const kgs = new Array(edges.length + 1).fill(0) as number[];
  let unpricedBlocks = 0;
  let unpricedKg = 0;
  let pricedBlocks = 0;
  let pricedKg = 0;

  for (const c of cells) {
    if (c.php === null) {
      unpricedBlocks += 1;
      unpricedKg += c.balance;
      continue;
    }
    const b = bandOf(c.php);
    bandByBlock[c.loc] = b;
    counts[b] += 1;
    kgs[b] += c.balance;
    pricedBlocks += 1;
    pricedKg += c.balance;
  }

  const bands: BlockingPriceBand[] = counts.map((_, i) => ({
    index: i,
    lowerPhp: i === 0 ? null : edges[i - 1],
    upperPhp: i === edges.length ? null : edges[i],
    blockCount: counts[i],
    kg: kgs[i],
    kgSharePct: pricedKg > 0 ? (kgs[i] / pricedKg) * 100 : null,
    blockSharePct: pricedBlocks > 0 ? (counts[i] / pricedBlocks) * 100 : null,
  }));

  return {
    marketPhpKg: MARKET,
    roundedUpPhp: R,
    edgeOffsets: offsets,
    bands,
    bandByBlock,
    unpriced: { blockCount: unpricedBlocks, kg: unpricedKg },
    total: { blockCount: pricedBlocks + unpricedBlocks, kg: pricedKg + unpricedKg },
  };
}

function formatKg(v: number): string {
  return Math.round(v).toLocaleString();
}

export function PriceLensFixture() {
  const params = useSearchParams();
  const shapeKey = params.get('bands') ?? '3';
  const offsets = SHAPES[shapeKey] ?? SHAPES['3'];
  const includeUnpriced = params.get('unpriced') === '1';

  const cells = React.useMemo(() => makeCells(includeUnpriced), [includeUnpriced]);

  const adapter: PriceLensAdapter = React.useMemo(
    () => ({
      fetchBases: async (trailingDays) => ({ ok: true, bases: BASES, trailingDays }),
      fetchLens: async (_market, edgeOffsets) => ({
        ok: true,
        lens: makeLens(cells, [...edgeOffsets]),
      }),
    }),
    [cells],
  );

  // The REAL registered lens, with only its data port swapped. The frame therefore
  // renders the real panel, the real header, the real docking and the real Escape
  // handling — what is on screen is what `/inventory/blocking` puts there.
  const lenses: BlockingLensDefinition[] = React.useMemo(
    () => [
      {
        ...PRICE_LENS,
        Panel: (props) => <PriceLensPanel {...props} adapter={adapter} />,
      },
    ],
    [adapter],
  );

  const [classifier, setClassifier] = React.useState<{ fn: BlockingLensClassifier | null }>({
    fn: null,
  });
  const handleClassifier = React.useCallback(
    (fn: BlockingLensClassifier | null) => setClassifier({ fn }),
    [],
  );

  // `?bands=` has to reach the panel through the SAME door a real reader's settings
  // do — `useLensSettings` reads localStorage on mount — so the rig seeds that key
  // and only then mounts the panel. Writing it any other way would mean the shape on
  // screen was not the shape the settings pipeline produces.
  const [seeded, setSeeded] = React.useState(false);
  React.useLayoutEffect(() => {
    try {
      window.localStorage.setItem(
        'bw.blocking_lens_price.v1',
        JSON.stringify({ edgeOffsets: offsets }),
      );
    } catch {
      // Blocked store — the panel will simply show its shipped defaults.
    }
    setSeeded(true);
  }, [offsets]);

  return (
    <div className="min-h-dvh bg-background p-3 text-foreground">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Price lens look rig · static payload · <code>?bands={shapeKey}</code> (
        {offsets.join(', ')}) · <code>?unpriced={includeUnpriced ? '1' : '0'}</code> · toggle the
        OS/app theme to see both. Default offsets are <code>[-1, 0]</code>.
      </p>

      {/* The same row layout the real page uses: grid gives, panel keeps 300px. */}
      {/* The REAL frame is now a BAR (2026-09-21): full width, above the grid,
          which keeps ALL of its own width. */}
      <div className="flex flex-col gap-3">
        {/* The REAL frame + the REAL panel, driven through the adapter port. */}
        {seeded && (
          <BlockingLensPanel
            key={offsets.join(',')}
            lenses={lenses}
            activeId={PRICE_LENS.id}
            onSelectLens={() => undefined}
            onClose={() => undefined}
            onClear={() => setClassifier({ fn: null })}
            hasClassification={!!classifier.fn}
            data={{}}
            caps={{ canViewPrices: true }}
            onClassifierChange={handleClassifier}
          />
        )}
        <div className="min-w-0">
          <div className="rounded-lg border border-border bg-card p-2 overflow-x-auto">
            <div
              className="grid blocking-grid-cols"
              style={
                { '--blocking-cols': 10, gap: '2px' } as React.CSSProperties
              }
            >
              <div className="blocking-rowlabel-frozen" />
              {Array.from({ length: 10 }, (_, i) => (
                <div
                  key={i}
                  className="text-center text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {i + 1}
                </div>
              ))}
              {['A', 'B', 'C'].map((row, rowIdx) => (
                <React.Fragment key={row}>
                  <div
                    className="blocking-rowlabel-frozen flex items-center justify-center text-[10px] font-semibold uppercase text-muted-foreground"
                    style={{ width: 20 }}
                  >
                    {row}
                  </div>
                  {cells.slice(rowIdx * 10, rowIdx * 10 + 10).map((c) => {
                    const lensClass = resolveLensCellClass(classifier.fn, c.loc);
                    return (
                      <div
                        key={c.loc}
                        className={cn(
                          'blocking-cell blocking-cell-occupied relative',
                          lensClass,
                        )}
                        title={c.php === null ? 'unpriced' : `${c.php.toFixed(2)}/kg`}
                      >
                        <div
                          className="h-full flex flex-col"
                          style={{ gap: '2px', padding: '4px 5px' }}
                        >
                          <div
                            className="flex items-center justify-center rounded-[3px] bg-blue-500/70 py-[1px]"
                            style={{ margin: '0 -1px' }}
                          >
                            <span
                              className="font-mono font-semibold leading-none text-white"
                              style={{ fontSize: '10px' }}
                            >
                              {c.loc}
                            </span>
                          </div>
                          <div
                            className="flex flex-col items-center rounded-[3px] bg-black/5 py-[1px] dark:bg-white/10"
                            style={{ margin: '0 -1px' }}
                          >
                            <span
                              className="font-bold leading-[1.15] text-zinc-900 dark:text-white"
                              style={{ fontSize: '10px' }}
                            >
                              SEPT 26
                            </span>
                            <span
                              className="font-bold leading-[1.15] text-zinc-900 dark:text-white"
                              style={{ fontSize: '10px' }}
                            >
                              {c.batch.split('-').slice(2).join('-')}
                            </span>
                          </div>
                          <div
                            className="flex items-baseline justify-center font-mono font-bold leading-none text-emerald-700 dark:text-emerald-400"
                            style={{ fontSize: '10px', marginTop: '1px' }}
                          >
                            <span>{formatKg(c.balance)}</span>
                          </div>
                          <div
                            className="mt-auto flex flex-col"
                            style={{ paddingTop: '2px', gap: '1px' }}
                          >
                            <div
                              className="flex justify-between font-mono font-bold leading-none text-zinc-800 dark:text-white/95"
                              style={{ fontSize: '10px' }}
                            >
                              <span>&#8369;</span>
                              <span>{c.php === null ? '—' : c.php.toFixed(2)}</span>
                            </div>
                            <div
                              className={cn(
                                'flex justify-between font-mono font-bold leading-none',
                                c.ash > 4
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-zinc-800 dark:text-white/95',
                              )}
                              style={{ fontSize: '10px' }}
                            >
                              <span>ASH</span>
                              <span>{c.ash.toFixed(2)}</span>
                            </div>
                            <div
                              className="flex justify-between font-mono font-bold leading-none text-zinc-800 dark:text-white/95"
                              style={{ fontSize: '10px' }}
                            >
                              <span>BD</span>
                              <span>{c.bdAstm.toFixed(3)}</span>
                            </div>
                            {/* The lab-highlight RED case, on every band — the one
                                contrast question the CSS cannot answer on its own. */}
                            <div
                              className={cn(
                                'flex justify-between font-mono font-bold leading-none',
                                c.mc > 14
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-zinc-800 dark:text-white/95',
                              )}
                              style={{ fontSize: '10px' }}
                            >
                              <span>MC</span>
                              <span>{c.mc.toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
