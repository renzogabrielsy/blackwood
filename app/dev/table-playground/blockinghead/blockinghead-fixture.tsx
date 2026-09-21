'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The BLOCKING CONTROL STRIP + BLEND TABLE look rig. See `page.tsx` for why it
// exists and how it is gated.
//
// Everything below is a LITERAL. There is no Supabase client, no auth helper and no
// server action reached from this file: the grid is handed a static `BlockingGridData`
// and the blend modal's supplier/age read comes through the dialog's `factsAdapter`
// port from the static record in `FACTS`. What renders is the REAL `BlockingGrid` and
// the REAL `BlendProposalDialog`, so the strip's sections, the lens bar, the cell
// classes and the supplier pills are the page's own, not an approximation.
//
// The lens PANELS' own reads are the live server actions and will refuse here (no
// session) — which is itself worth looking at, because it is the path the 2026-09-21
// stall fix put a copyable banner and a Retry on. For the lens BODIES over real
// payloads use the `pricelens` / `agelens` fixtures, which inject their own adapters.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { BlockingGrid } from '@/app/(app)/inventory/blocking/blocking-grid';
import { BlendProposalDialog } from '@/app/(app)/inventory/_shared/blend-proposal-dialog';
import type {
  BlendBlockFacts,
  BlendBlockFactsResult,
  BlockData,
  BlockingSupplierMap,
} from '@/app/(app)/inventory/blocking/types';
import type { BlendProposal } from '@/app/(app)/inventory/blocking/actions';

// ── The yard ────────────────────────────────────────────────────────────────
//
// THE FIGURES ARE THE LIVE PAGE'S OWN SHAPE, because the strip is measured by them:
// a 5-digit tonnage, a 9-digit peso total and a 2-decimal ₱/kg are what set section
// 3's width, and a rig that printed `1,234.00 t` would answer a narrower question
// than the one being asked. It occupies **170 of the real 220 slots** (→ `77.3%`
// utilization, which falls out of the count rather than being typed), and the LAST
// occupied block absorbs the rounding residual on both the weight and the price so
// the totals land exactly on the owner's own screenshot:
//
//     10,543.09 t · 170 / 220 · 77.3% · ₱ 389,587,962 · ₱ 36.95
//
// Note the Proposals badge reads the real `fetchBlendProposalList`, which degrades
// to an empty list with no session here, so it shows `0` rather than a count. Its
// width is reserved (`w-[26px] tabular-nums`), so a single digit either way is the
// same measurement.

/** The real warehouse shape — A 20×3, B 20×2, C 20×2, D 20×4 = 220 slots. */
const YARD = [
  { whse: 'A', rows: ['A', 'B', 'C'] },
  { whse: 'B', rows: ['A', 'B'] },
  { whse: 'C', rows: ['A', 'B'] },
  { whse: 'D', rows: ['A', 'B', 'C', 'D'] },
] as const;

const TARGET_BALANCE_KG = 10_543_090;
const TARGET_VALUE_PHP = 389_587_962;

function makeBlocks(withPrices: boolean): Record<string, BlockData> {
  // Every slot, in grid order, with 5 of every 22 left EMPTY → exactly 50 of 220.
  const locs: string[] = [];
  let slot = 0;
  for (const { whse, rows } of YARD) {
    for (const row of rows) {
      for (let col = 1; col <= 20; col += 1) {
        const skip = slot % 22 >= 17;
        slot += 1;
        if (skip) continue;
        locs.push(`${whse}-${col}${row}`);
      }
    }
  }

  const out: Record<string, BlockData> = {};
  const balances = locs.map((_, i) => 25_000 + ((i * 7) % 37) * 2_050);
  const prices = locs.map((_, i) => 31 + ((i * 5) % 21) * 0.6);

  // The last block carries the residual so the two headline totals are exact.
  const headBalance = balances.slice(0, -1).reduce((a, b) => a + b, 0);
  balances[balances.length - 1] = TARGET_BALANCE_KG - headBalance;
  const headValue = balances
    .slice(0, -1)
    .reduce((a, b, i) => a + b * prices[i], 0);
  prices[prices.length - 1] =
    (TARGET_VALUE_PHP - headValue) / balances[balances.length - 1];

  locs.forEach((loc, i) => {
    const n = i + 1;
    out[loc] = {
      batch_code: `SEPT-26-BLK${n}`,
      batch_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      status: n % 7 === 0 ? 'IN-USE' : 'STORED',
      balance: balances[i],
      total_in: balances[i] + 40_000,
      php: withPrices ? prices[i] : null,
      bd_astm: 0.402,
      bd_jis: 0.388,
      ash: n % 5 === 0 ? 4.6 : 3.1,
      mc: n % 4 === 0 ? 15.2 : 11.4,
      grit: 1.2,
      vm: 14.8,
      fc: 80.1,
    };
  });
  return out;
}

const SUPPLIER_MAP: BlockingSupplierMap = {
  suppliers: [
    { key: 'ORNALES', display: 'Ornales', blockCount: 9, totalKg: 900_000 },
    { key: 'LLANTO', display: 'Llanto', blockCount: 4, totalKg: 300_000 },
  ],
  byBlock: {},
};

// ── The blend proposal + its supplier/age facts ─────────────────────────────
//
// Three rows on purpose: a GREEN single-supplier block, an ORANGE mixed one, and a
// block with NO facts at all — the em-dash case, which is neither green nor orange.

const BLOCKS_IN_BLEND = ['A-1A', 'A-2A', 'A-4A'] as const;

const PROPOSAL: BlendProposal = {
  blocks: BLOCKS_IN_BLEND.map((loc, i) => ({
    block_loc: loc,
    batch_code: `SEPT-26-BLK${i + 1}`,
    status: 'STORED',
    balance: 120_000 - i * 12_000,
    mc: 11.4 + i,
    ash: 3.1,
    bd_astm: 0.402,
    bd_jis: 0.388,
    grit: 1.2,
    vm: 14.8,
    fc: 80.1,
    php_kg: 39.5 + i,
  })),
  block_count: 3,
  total_balance: 324_000,
  weighted: { mc: 12.3, ash: 3.1, bd_astm: 0.402, bd_jis: 0.388, grit: 1.2, vm: 14.8, fc: 80.1 },
  raw_price_per_kg: 40.12,
  product_cost_per_kg: 52.16,
  production_loss_pct: 30,
  can_view_prices: true,
};

/** `block_loc` → batch id, exactly as the grid supplies it in production. */
const BATCH_ID_BY_LOC: Record<string, string | null> = {
  'A-1A': 'fixture-batch-1',
  'A-2A': 'fixture-batch-2',
  'A-4A': 'fixture-batch-3',
};

function fact(partial: Partial<BlendBlockFacts> & { batchId: string }): BlendBlockFacts {
  return {
    batchCode: 'SEPT-26-BLK',
    supplierCount: 0,
    dominantSupplierKey: null,
    dominantSupplierDisplay: null,
    dominantSharePct: null,
    isSingleSupplier: null,
    suppliers: [],
    firstDeliveryDate: null,
    lastDeliveryDate: null,
    daysSinceOpened: null,
    daysSinceLastPiled: null,
    deliveryCount: 0,
    ...partial,
  };
}

const FACTS: Record<string, BlendBlockFacts> = {
  // GREEN — the whole block is one supplier.
  'fixture-batch-1': fact({
    batchId: 'fixture-batch-1',
    batchCode: 'SEPT-26-BLK1',
    supplierCount: 1,
    dominantSupplierKey: 'PAQUIBOT',
    dominantSupplierDisplay: 'Paquibot',
    dominantSharePct: 100,
    isSingleSupplier: true,
    suppliers: [
      { key: 'PAQUIBOT', display: 'Paquibot', kg: 120_000, sharePct: 100 },
    ],
    firstDeliveryDate: '2026-08-14',
    lastDeliveryDate: '2026-09-02',
    daysSinceOpened: 38,
    daysSinceLastPiled: 19,
    deliveryCount: 6,
  }),
  // ORANGE — mixed, showing the DOMINANT supplier and its share.
  'fixture-batch-2': fact({
    batchId: 'fixture-batch-2',
    batchCode: 'SEPT-26-BLK2',
    supplierCount: 3,
    dominantSupplierKey: 'LLANTO',
    dominantSupplierDisplay: 'Llanto',
    dominantSharePct: 71.34,
    isSingleSupplier: false,
    suppliers: [
      { key: 'LLANTO', display: 'Llanto', kg: 77_000, sharePct: 71.34 },
      { key: 'ORNALES', display: 'Ornales', kg: 24_000, sharePct: 22.24 },
      { key: 'SEVILLA', display: 'Sevilla', kg: 7_000, sharePct: 6.42 },
    ],
    firstDeliveryDate: '2026-04-12',
    lastDeliveryDate: '2026-05-16',
    daysSinceOpened: 162,
    daysSinceLastPiled: 128,
    deliveryCount: 4,
  }),
  // `fixture-batch-3` is DELIBERATELY ABSENT: an unknown id is ABSENT from `facts`,
  // never zero-filled, and the row must read as em dashes with no colour at all.
};

const FACTS_ADAPTER = async (
  batchIds: string[],
  asOf?: string,
): Promise<BlendBlockFactsResult> => {
  const facts: Record<string, BlendBlockFacts> = {};
  for (const id of batchIds) if (FACTS[id]) facts[id] = FACTS[id];
  return { ok: true, asOf: asOf ?? '2026-09-21', facts };
};

// ── The rig ─────────────────────────────────────────────────────────────────

export function BlockingHeadFixture() {
  const params = useSearchParams();
  const canViewPrices = params.get('prices') !== '0';
  const blendOpen = params.get('blend') === '1';

  const blocks = React.useMemo(() => makeBlocks(canViewPrices), [canViewPrices]);

  // The lens param is LOCAL here — this rig has no route to write to, and the point of
  // the fixture is the strip and the bar, not the URL plumbing.
  const [lensId, setLensId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [supplier, setSupplier] = React.useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(blendOpen);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <p className="px-4 pt-2 text-[11px] text-muted-foreground">
        Blocking control-strip look rig · static payload · <code>?prices=0</code> for a
        price-denied reader · <code>?blend=1</code> for the blend table · toggle the OS/app
        theme to see both. The lens panels&apos; own reads refuse here (no session) — that is the
        copyable-banner path.
      </p>
      <BlockingGrid
        data={blocks}
        canViewPrices={canViewPrices}
        selectedLocKey={selected}
        onSelectBlock={(loc) => setSelected((p) => (p === loc ? null : loc))}
        supplierMap={SUPPLIER_MAP}
        supplierFilter={supplier}
        onSupplierFilterChange={setSupplier}
        lensId={lensId}
        onLensChange={setLensId}
      />
      <BlendProposalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        proposal={PROPOSAL}
        loading={false}
        showPrices={canViewPrices}
        batchIdByLoc={BATCH_ID_BY_LOC}
        factsAdapter={FACTS_ADAPTER}
      />
    </div>
  );
}
