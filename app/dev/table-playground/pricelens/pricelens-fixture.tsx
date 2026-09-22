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
  BlockData,
  BlockingMarketBasis,
  BlockingPriceBand,
  BlockingPriceLens,
} from '@/app/(app)/inventory/blocking/types';
import {
  FIXTURE_MARKET_CONTEXT,
  fixtureLabStats,
  fixturePriceBlockByLoc,
  fixtureWarehouseSubtotals,
  type FixturePriceBlock,
} from '../lens-fixture-lab';

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
  // ⚠️ THE SHIPPED DEFAULT SINCE 2026-09-22, so a rig WITHOUT this row opens the price lens
  // on a basis that does not exist: `activeBasis` is null, no market price is resolved, the
  // classify read never fires, no band chip renders and the Print button stays disabled.
  // Placed AFTER `last_3_months`, mirroring `PRICE_LENS_BASIS_ORDER` and the SQL row order.
  //
  // Note it reads the SAME figure as `last_3_months` would in the third month of a quarter —
  // here it carries the LIVE Q3-2026 measurement (₱39.1816 over 2,479,361 kg / 153
  // deliveries) so the two rows are visibly distinct on the rig and the highlighted MARKET
  // row on page one can be told apart from its neighbour.
  {
    basisKey: 'this_quarter',
    marketPhpKg: 39.1816,
    pricedKg: 2_479_361,
    deliveryCount: 153,
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

/**
 * THREE WAREHOUSES, not three rows of one (changed 2026-09-22).
 *
 * The price sheet now prints ONE PAGE PER WAREHOUSE inside a band, so a rig whose thirty
 * cells all sat in warehouse A could produce exactly one warehouse per band and the paging
 * it is meant to exercise would be unreachable. A / B / C, ten slots each, is the shape the
 * supplier rig already uses (`A`/`B`/`D`) and it makes every band span two or three sheets.
 */
const MOCK_BLOCKS = [
  'A-1A', 'A-2A', 'A-3A', 'A-4A', 'A-5A', 'A-6A', 'A-7A', 'A-8A', 'A-9A', 'A-10A',
  'B-1A', 'B-2A', 'B-3A', 'B-4A', 'B-5A', 'B-6A', 'B-7A', 'B-8A', 'B-9A', 'B-10A',
  'C-1A', 'C-2A', 'C-3A', 'C-4A', 'C-5A', 'C-6A', 'C-7A', 'C-8A', 'C-9A', 'C-10A',
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
  // Σ kg × ₱/kg per band, so `kgWeightedPhpKg` is a real weighted average here too.
  const vals = new Array(edges.length + 1).fill(0) as number[];
  let unpricedBlocks = 0;
  let unpricedKg = 0;
  let pricedBlocks = 0;
  let pricedKg = 0;
  let pricedVal = 0;

  // The BANDED (i.e. priced) blocks, which is exactly the population `blockByLoc` and
  // `warehouseSubtotals` cover in the live payload.
  const banded: FixturePriceBlock[] = [];

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
    vals[b] += c.balance * c.php;
    pricedBlocks += 1;
    pricedKg += c.balance;
    pricedVal += c.balance * c.php;
    banded.push({
      loc: c.loc,
      band: b,
      kg: c.balance,
      php: c.php,
      lab: { mc: c.mc, ash: c.ash, bdAstm: c.bdAstm },
    });
  }

  const bands: BlockingPriceBand[] = counts.map((_, i) => ({
    index: i,
    lowerPhp: i === 0 ? null : edges[i - 1],
    upperPhp: i === edges.length ? null : edges[i],
    blockCount: counts[i],
    kg: kgs[i],
    kgSharePct: pricedKg > 0 ? (kgs[i] / pricedKg) * 100 : null,
    blockSharePct: pricedBlocks > 0 ? (counts[i] / pricedBlocks) * 100 : null,
    // Null, never 0, on an empty band — the live contract.
    kgWeightedPhpKg: kgs[i] > 0 ? vals[i] / kgs[i] : null,
    // The three readings the mock cells carry, weighted for real; the other four stay
    // unmeasured rather than invented. See `lens-fixture-lab.ts`.
    ...fixtureLabStats(banded.filter((b) => b.band === i).map((b) => ({ kg: b.kg, lab: b.lab }))),
  }));

  return {
    marketPhpKg: MARKET,
    roundedUpPhp: R,
    edgeOffsets: offsets,
    bands,
    bandByBlock,
    // SAME key set as `bandByBlock` — the invariant the live payload guarantees.
    blockByLoc: fixturePriceBlockByLoc(banded),
    warehouseSubtotals: fixtureWarehouseSubtotals(banded),
    unpriced: { blockCount: unpricedBlocks, kg: unpricedKg },
    total: {
      blockCount: pricedBlocks + unpricedBlocks,
      kg: pricedKg + unpricedKg,
      // Weighted over the PRICED kilograms only, while the counts cover every block. The
      // seven lab means inherit that population, which is what makes the fold hold.
      kgWeightedPhpKg: pricedKg > 0 ? pricedVal / pricedKg : null,
      ...fixtureLabStats(banded.map((b) => ({ kg: b.kg, lab: b.lab }))),
    },
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

  // The grid map the panel reads for the PRINTED summary's per-block lists (block
  // code, batch and balance). Shaped exactly like `BlockingGridData.data`.
  const gridData: Record<string, BlockData> = React.useMemo(() => {
    const out: Record<string, BlockData> = {};
    for (const c of cells) {
      out[c.loc] = {
        batch_code: c.batch,
        batch_id: c.loc,
        status: 'STORED',
        balance: c.balance,
        total_in: c.totalIn,
        php: c.php,
        bd_astm: c.bdAstm,
        bd_jis: c.bdAstm,
        ash: c.ash,
        mc: c.mc,
        grit: 1.2,
        vm: 18.4,
        fc: 78.2,
      };
    }
    return out;
  }, [cells]);

  const adapter: PriceLensAdapter = React.useMemo(
    () => ({
      fetchBases: async (trailingDays) => ({ ok: true, bases: BASES, trailingDays }),
      fetchLens: async (_market, edgeOffsets) => ({
        ok: true,
        lens: makeLens(cells, [...edgeOffsets]),
      }),
      // The PRINT-ONLY third read — page one's MARKET table and chart. Without it the rig
      // could only ever show that section ABSENT, which is the one shape a reviewer does
      // not need to look at. See `lens-fixture-lab.ts`.
      fetchMarketContext: async () => ({ ok: true, context: FIXTURE_MARKET_CONTEXT }),
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
            data={gridData}
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
