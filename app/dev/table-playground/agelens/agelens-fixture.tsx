'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The age lens's look rig, AND the two-lens rig for the frame. See `page.tsx` for
// why it exists and how it is gated.
//
// Everything below is a LITERAL. There is no Supabase client, no auth helper and no
// server action on this page: each panel's read is supplied through its `adapter`
// port from a static payload shaped exactly like its data layer's contract
// (`BlockingAgeLens` / `BlockingPriceLens` + `BlockingMarketBasis`), including the
// invariants the live functions guarantee — Σ shares = 100, and Σ band counts +
// excluded = total. The cells are the REAL `.blocking-cell blocking-cell-occupied`
// markup with the REAL `.lens-age-*` / `.lens-band-*` classes, so the tint, the ring
// and the text contrast are the page's own.
//
// ── IT ALSO RIGS THE FRAME, NOT JUST THE LENS ───────────────────────────────
// The tab strip only appears once a reader may be offered more than one lens, and a
// PRICE-DENIED reader must see Age alone with no strip at all. That is a property of
// `canShow` + the frame, so `?prices=0` flips the capability and the lens list is
// filtered with each definition's OWN `canShow` — the same predicate `visibleLenses`
// applies in the app.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';
import { BlockingLensPanel } from '@/app/(app)/inventory/blocking/lens/lens-panel';
import {
  AGE_LENS,
  AgeLensPanel,
  type AgeLensAdapter,
} from '@/app/(app)/inventory/blocking/lens/age-lens-panel';
import {
  PRICE_LENS,
  PriceLensPanel,
  type PriceLensAdapter,
} from '@/app/(app)/inventory/blocking/lens/price-lens-panel';
import {
  resolveLensCellClass,
  resolveLensCellTitle,
  type BlockingLensClassifier,
  type BlockingLensDefinition,
  type BlockingLensId,
} from '@/app/(app)/inventory/blocking/lens/types';
import type {
  BlockData,
  BlockingAgeBand,
  BlockingAgeLens,
  BlockingMarketBasis,
  BlockingPriceBand,
  BlockingPriceLens,
} from '@/app/(app)/inventory/blocking/types';

// ── Price side (enough of it to make the tab strip real) ─────────────────────

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
  {
    basisKey: 'trailing_days',
    marketPhpKg: null,
    pricedKg: 0,
    deliveryCount: 0,
    fromDate: '2026-09-18',
    toDate: '2026-09-19',
  },
];

// ── The age shapes each `?bands=` stands for, in DAYS ────────────────────────

const SHAPES: Record<string, number[]> = {
  '2': [365],
  '3': [60, 365],
  '4': [60, 120, 365], // the shipped default
  '5': [30, 60, 120, 365],
  '7': [30, 60, 90, 120, 180, 365],
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
  /** null = UNDATED (no dated delivery) — the age lens's NULL-≠-0 case. */
  ageDays: number | null;
  /** null = UNPRICED (the L-008 placeholder's effect) — the price lens's. */
  php: number | null;
  mc: number;
  ash: number;
  bdAstm: number;
}

/**
 * 30 cells whose ages span the whole scale (12 → 1,176 days, the live yard's real
 * range), plus optional undated ones.
 */
function makeCells(includeUndated: boolean): MockCell[] {
  return MOCK_BLOCKS.map((loc, i) => {
    const undated = includeUndated && i % 11 === 7;
    return {
      loc,
      batch: `SEPT-26-BLK${i + 1}`,
      balance: 120_000 - i * 3_400,
      totalIn: 180_000,
      // Spread across the ramp: a handful fresh, most in the middle, the last few
      // over a year — including one at the live yard's 1,176-day extreme.
      ageDays: undated ? null : Math.round((12 + i * 40.5) * 10) / 10,
      php: 26 + i * 1.05,
      // One in four exceeds the default MC limit (14) so the lab-highlight red is on
      // screen over every band — that is the contrast case worth looking at.
      mc: i % 4 === 0 ? 15.2 : 11.4,
      ash: i % 5 === 0 ? 4.6 : 3.1,
      bdAstm: 0.402,
    };
  });
}

/**
 * Build the payload `fn_blocking_age_lens` would return for these cells and cut lines.
 *
 * FIXTURE arithmetic, not production arithmetic: in the app every one of these
 * numbers comes out of SQL and the panel never adds anything up. It is reproduced
 * here only so the panel has a contract-shaped payload to render, with the live
 * invariants intact (Σ shares = 100, Σ counts + undated = total, a NULL weighted age
 * on an empty band, and undated blocks absent from both maps).
 */
function makeAgeLens(cells: MockCell[], edges: number[]): BlockingAgeLens {
  // "How many cut lines has this age passed" — total by construction, so a negative
  // age lands in band 0 rather than matching nothing.
  const bandOf = (age: number) => {
    let idx = 0;
    for (const e of edges) if (age >= e) idx += 1;
    return idx;
  };

  const bandByBlock: Record<string, number> = {};
  const ageByBlock: Record<string, number> = {};
  const counts = new Array(edges.length + 1).fill(0) as number[];
  const kgs = new Array(edges.length + 1).fill(0) as number[];
  const ageKg = new Array(edges.length + 1).fill(0) as number[];
  let undatedBlocks = 0;
  let undatedKg = 0;
  let datedBlocks = 0;
  let datedKg = 0;
  let datedAgeKg = 0;
  let oldestAge: number | null = null;
  let oldestLoc: string | null = null;

  for (const c of cells) {
    if (c.ageDays === null) {
      undatedBlocks = undatedBlocks + 1;
      undatedKg = undatedKg + c.balance;
      continue;
    }
    const b = bandOf(c.ageDays);
    bandByBlock[c.loc] = b;
    ageByBlock[c.loc] = c.ageDays;
    counts[b] = counts[b] + 1;
    kgs[b] = kgs[b] + c.balance;
    ageKg[b] = ageKg[b] + c.ageDays * c.balance;
    datedBlocks = datedBlocks + 1;
    datedKg = datedKg + c.balance;
    datedAgeKg = datedAgeKg + c.ageDays * c.balance;
    if (oldestAge === null || c.ageDays > oldestAge) {
      oldestAge = c.ageDays;
      oldestLoc = c.loc;
    }
  }

  const bands: BlockingAgeBand[] = counts.map((_, i) => ({
    index: i,
    lowerDays: i === 0 ? 0 : edges[i - 1],
    upperDays: i === edges.length ? null : edges[i],
    blockCount: counts[i],
    kg: kgs[i],
    kgSharePct: datedKg > 0 ? (kgs[i] / datedKg) * 100 : null,
    blockSharePct: datedBlocks > 0 ? (counts[i] / datedBlocks) * 100 : null,
    // NULL, never 0, on an empty band.
    kgWeightedAgeDays: kgs[i] > 0 ? ageKg[i] / kgs[i] : null,
  }));

  return {
    asOf: '2026-09-19',
    edgeDays: edges,
    bands,
    bandByBlock,
    ageByBlock,
    undated: { blockCount: undatedBlocks, kg: undatedKg },
    total: {
      blockCount: datedBlocks + undatedBlocks,
      kg: datedKg + undatedKg,
      kgWeightedAgeDays: datedKg > 0 ? datedAgeKg / datedKg : null,
      oldestAgeDays: oldestAge,
      oldestBlockLoc: oldestLoc,
    },
  };
}

/** The price payload, for the other tab. Same fixture-arithmetic disclaimer. */
function makePriceLens(cells: MockCell[], offsets: number[]): BlockingPriceLens {
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
  let pricedBlocks = 0;
  let pricedKg = 0;
  let pricedVal = 0;

  for (const c of cells) {
    if (c.php === null) continue;
    const b = bandOf(c.php);
    bandByBlock[c.loc] = b;
    counts[b] = counts[b] + 1;
    kgs[b] = kgs[b] + c.balance;
    vals[b] = vals[b] + c.balance * c.php;
    pricedBlocks = pricedBlocks + 1;
    pricedKg = pricedKg + c.balance;
    pricedVal = pricedVal + c.balance * c.php;
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
  }));

  return {
    marketPhpKg: MARKET,
    roundedUpPhp: R,
    edgeOffsets: offsets,
    bands,
    bandByBlock,
    unpriced: { blockCount: 0, kg: 0 },
    total: {
      blockCount: pricedBlocks,
      kg: pricedKg,
      kgWeightedPhpKg: pricedKg > 0 ? pricedVal / pricedKg : null,
    },
  };
}

function formatKg(v: number): string {
  return Math.round(v).toLocaleString();
}

export function AgeLensFixture() {
  const params = useSearchParams();
  const shapeKey = params.get('bands') ?? '4';
  const edges = SHAPES[shapeKey] ?? SHAPES['4'];
  const includeUndated = params.get('undated') === '1';
  const canViewPrices = params.get('prices') !== '0';

  const cells = React.useMemo(() => makeCells(includeUndated), [includeUndated]);

  // The grid map the panels read for the PRINTED summary's per-block lists (block
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

  const ageAdapter: AgeLensAdapter = React.useMemo(
    () => ({
      fetchLens: async (edgeDays) => ({
        ok: true,
        lens: makeAgeLens(cells, [...edgeDays]),
      }),
    }),
    [cells],
  );

  const priceAdapter: PriceLensAdapter = React.useMemo(
    () => ({
      fetchBases: async (trailingDays) => ({ ok: true, bases: BASES, trailingDays }),
      fetchLens: async (_market, edgeOffsets) => ({
        ok: true,
        lens: makePriceLens(cells, [...edgeOffsets]),
      }),
    }),
    [cells],
  );

  // The REAL registered lenses, with only their data ports swapped — and filtered by
  // their OWN `canShow`, which is what makes `?prices=0` a real test of the frame.
  const caps = React.useMemo(() => ({ canViewPrices }), [canViewPrices]);
  const lenses: BlockingLensDefinition[] = React.useMemo(
    () =>
      [
        {
          ...PRICE_LENS,
          Panel: (props: React.ComponentProps<typeof PriceLensPanel>) => (
            <PriceLensPanel {...props} adapter={priceAdapter} />
          ),
        },
        {
          ...AGE_LENS,
          Panel: (props: React.ComponentProps<typeof AgeLensPanel>) => (
            <AgeLensPanel {...props} adapter={ageAdapter} />
          ),
        },
      ].filter((l) => l.canShow(caps)),
    [ageAdapter, priceAdapter, caps],
  );

  const [activeId, setActiveId] = React.useState<BlockingLensId>(AGE_LENS.id);
  // A lens that is no longer offered hands over to the first one that is — the grid's
  // own fallback rule, so `?prices=0` lands on Age rather than on an empty frame.
  React.useEffect(() => {
    if (!lenses.some((l) => l.id === activeId) && lenses.length > 0) setActiveId(lenses[0].id);
  }, [lenses, activeId]);

  const [classifier, setClassifier] = React.useState<{ fn: BlockingLensClassifier | null }>({
    fn: null,
  });
  const handleClassifier = React.useCallback(
    (fn: BlockingLensClassifier | null) => setClassifier({ fn }),
    [],
  );

  const [focused, setFocused] = React.useState<string | null>(null);

  // `?bands=` has to reach the panel through the SAME door a real reader's settings
  // do — `useLensSettings` reads localStorage on mount — so the rig seeds that key and
  // only then mounts the panel. Writing it any other way would mean the shape on
  // screen was not the shape the settings pipeline produces.
  const [seeded, setSeeded] = React.useState(false);
  React.useLayoutEffect(() => {
    try {
      window.localStorage.setItem(
        'bw.blocking_lens_age.v1',
        JSON.stringify({ edgeDays: edges }),
      );
    } catch {
      // Blocked store — the panel will simply show its shipped defaults.
    }
    setSeeded(true);
  }, [edges]);

  return (
    <div className="min-h-dvh bg-background p-3 text-foreground">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Age lens look rig · static payload · <code>?bands={shapeKey}</code> ({edges.join(', ')} days)
        · <code>?undated={includeUndated ? '1' : '0'}</code> ·{' '}
        <code>?prices={canViewPrices ? '1' : '0'}</code> ({lenses.length} lens
        {lenses.length === 1 ? '' : 'es'} offered
        {lenses.length === 1 ? ' — no tab strip' : ''}) · toggle the OS/app theme to see both.
        {focused && <> · clicked the oldest block: <code>{focused}</code></>}
      </p>

      {/* The same row layout the real page uses: grid gives, panel keeps 300px. */}
      {/* The REAL frame is now a BAR (2026-09-21): full width, above the grid,
          which keeps ALL of its own width. */}
      <div className="flex flex-col gap-3">
        {/* The REAL frame + the REAL panels, driven through their adapter ports. */}
        {seeded && lenses.length > 0 && (
          <BlockingLensPanel
            key={edges.join(',')}
            lenses={lenses}
            activeId={activeId}
            onSelectLens={setActiveId}
            onClose={() => undefined}
            onClear={() => setClassifier({ fn: null })}
            hasClassification={!!classifier.fn}
            data={gridData}
            caps={caps}
            onClassifierChange={handleClassifier}
            onFocusBlock={setFocused}
          />
        )}
        <div className="min-w-0">
          <div className="rounded-lg border border-border bg-card p-2 overflow-x-auto">
            <div
              className="grid blocking-grid-cols"
              style={{ '--blocking-cols': 10, gap: '2px' } as React.CSSProperties}
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
                    const lensTitle = resolveLensCellTitle(classifier.fn, c.loc);
                    return (
                      <div
                        key={c.loc}
                        className={cn('blocking-cell blocking-cell-occupied relative', lensClass)}
                        title={lensTitle ?? undefined}
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
                            {/* The age, so the tint can be read against the number it
                                stands for — the real cell shows ₱/ASH/BD/MC and hovers
                                the age, which is checked through the `title` above. */}
                            <div
                              className="flex justify-between font-mono font-bold leading-none text-zinc-800 dark:text-white/95"
                              style={{ fontSize: '10px' }}
                            >
                              <span>AGE</span>
                              <span>{c.ageDays === null ? '—' : c.ageDays.toFixed(0)}</span>
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
