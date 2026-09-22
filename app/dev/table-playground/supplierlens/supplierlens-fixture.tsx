'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The supplier lens's look rig, AND the THREE-lens rig for the frame. See `page.tsx`
// for why it exists and how it is gated.
//
// Everything below is a LITERAL. There is no Supabase client, no auth helper and no
// server action on this page: each panel's read is supplied through its `adapter` port
// from a static payload shaped exactly like its data layer's contract
// (`BlockingSupplierLens` / `BlockingAgeLens` / `BlockingPriceLens`), including the
// invariants the live functions guarantee — Σ dominant blocks + unattributed = total,
// Σ apportioned kg + unattributed kg = total kg, Σ kgSharePct = 100, Σ blockSharePct =
// 100, `others` LAST and present iff `supplierCount > topN`, and a block absent from
// BOTH maps when its batch has no delivery. The cells are the REAL
// `.blocking-cell blocking-cell-occupied` markup with the REAL `.lens-cat-*` classes and
// the REAL `.lens-cat-mixed` dashed outline, so the tint, the ring and the text contrast
// are the page's own.
//
// ── THE SUPPLIER SHAPE IS THE LIVE YARD'S, NOT AN INVENTION ─────────────────
// The seven bands reproduce the figures measured on 2026-09-22 and recorded in
// `blocking/CONTEXT.md` → "Supplier lens — DATA LAYER": ORNALES 78 dominant / 41.8193%,
// PAQUIBOT 58 / 36.3451%, 2023 BACKLOG 11 / 7.32%, LLANTO 7 / 3.751%, SEVILLA 5 /
// 2.9124%, LAYUPAN 6 / 2.8445%, OTHERS (11) 5 / 5.0077% — 17 suppliers, 23 mixed. That
// matters because the question the rig answers is whether the SHARES the yard really has
// are legible as a ratio bar, and a tidy 7 × 14.3% would flatter it.
//
// ── THE ADAPTERS TAKE ~300 ms ───────────────────────────────────────────────
// A resolved-immediately adapter hides everything the panel does while it waits: the
// spinner in the bar, the `…` placeholder chip, the popover's "Working out…" line, and
// whether a debounced re-read flickers. So every fixture read here sleeps ~300 ms, which
// is roughly the live round trip (the supplier lens's own SQL measures 48 ms warm, and
// the rest is the network).
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
  SUPPLIER_LENS,
  SupplierLensPanel,
  type SupplierLensAdapter,
} from '@/app/(app)/inventory/blocking/lens/supplier-lens-panel';
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
  BlockingSupplierBand,
  BlockingSupplierBlock,
  BlockingSupplierLens,
  BlockingSupplierSlice,
} from '@/app/(app)/inventory/blocking/types';
import {
  FIXTURE_MARKET_CONTEXT,
  fixtureLabStats,
  fixturePriceBlockByLoc,
  fixtureSupplierMarket,
  fixtureWarehouseSubtotals,
  type FixturePriceBlock,
  type FixtureSupplierMarketSpec,
} from '../lens-fixture-lab';

/** Roughly the live round trip. See the header note on why it is not zero. */
const FIXTURE_LATENCY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── The yard, as measured 2026-09-22 ────────────────────────────────────────

interface SupplierSpec {
  key: string;
  display: string;
  /** Blocks this supplier DOMINATES. */
  dominant: number;
  /** How many of those are MIXED. */
  mixed: number;
  /** PERCENT of the yard by APPORTIONED kg — the live figures. */
  kgShare: number;
  /**
   * ₱/kg, kg-weighted over this band's PRICED dominant blocks — the LIVE figures measured
   * 2026-09-22. Note how wide the spread is (₱17.66 … ₱43.57): a rig that gave every band the
   * same price could not show a column that is worth printing.
   */
  phpKg: number;
}

/** The six named suppliers of the live top-6, in the live order. */
const SUPPLIERS: SupplierSpec[] = [
  { key: 'ORNALES', display: 'Ornales', dominant: 78, mixed: 11, kgShare: 41.8193, phpKg: 43.5690 },
  { key: 'PAQUIBOT', display: 'Paquibot', dominant: 58, mixed: 0, kgShare: 36.3451, phpKg: 37.1574 },
  { key: '2023 BACKLOG', display: '2023 Backlog', dominant: 11, mixed: 0, kgShare: 7.32, phpKg: 17.6566 },
  { key: 'LLANTO', display: 'Llanto', dominant: 7, mixed: 6, kgShare: 3.751, phpKg: 29.9501 },
  { key: 'SEVILLA', display: 'Sevilla', dominant: 5, mixed: 0, kgShare: 2.9124, phpKg: 19.0265 },
  { key: 'LAYUPAN', display: 'Layupan', dominant: 6, mixed: 5, kgShare: 2.8445, phpKg: 20.7090 },
];

/**
 * Each named supplier's PRICE-vs-VOLUME history, for page one's new section (2026-09-22).
 *
 * The first three reproduce the live figures recorded in `blocking/CONTEXT.md` (measured
 * 2026-09-22): ORNALES 5,620,744 kg at ₱44.9225, down 11.67%, corr 0.264 over 12 months,
 * premium +0.4968; PAQUIBOT down 10.07%, corr 0.597, +0.8267; TAG-AT down 12.36%, corr
 * 0.735, −0.3792 — mapped onto the rig's own band names.
 *
 * ⚠️ **THREE SHAPES ARE HERE ON PURPOSE, and each one is a rendering path the live data can
 * reach:** `SEVILLA` is FLAT inside the ±2% dead band (so the table prints `→ flat` rather
 * than dressing noise up as a trend), `LAYUPAN` has only two priced months so its
 * correlation is **NULL and prints `n/a (2 m)`** rather than a spurious ±1, and it is also
 * the one with QUIET MONTHS at the start of the window — which is what puts a real GAP on a
 * chart whose axis is the WINDOW's spine rather than the series'.
 */
const SUPPLIER_MARKET_SPECS: FixtureSupplierMarketSpec[] = [
  { key: 'ORNALES', kgFirst: 430_000, kgDriftPct: 18, priceFirst: 50.86, priceLast: 44.92, corr: 0.264, corrMonths: 12, premium: 0.4968 },
  { key: 'PAQUIBOT', kgFirst: 360_000, kgDriftPct: -12, priceFirst: 49.42, priceLast: 44.44, corr: 0.597, corrMonths: 12, premium: 0.8267 },
  { key: '2023 BACKLOG', kgFirst: 96_000, kgDriftPct: -40, priceFirst: 19.80, priceLast: 17.11, corr: 0.735, corrMonths: 12, premium: -0.3792 },
  { key: 'LLANTO', kgFirst: 52_000, kgDriftPct: 26, priceFirst: 28.40, priceLast: 31.62, corr: -0.318, corrMonths: 12, premium: 0.1104 },
  // FLAT — inside the ±2% dead band, so `direction` reads `flat` and not a trend.
  { key: 'SEVILLA', kgFirst: 41_000, kgDriftPct: 4, priceFirst: 19.02, priceLast: 19.18, corr: 0.081, corrMonths: 12, premium: -0.2210 },
  // TWO priced months ⇒ NULL correlation, and a nine-month gap at the head of the window.
  { key: 'LAYUPAN', kgFirst: 38_000, kgDriftPct: 9, priceFirst: 20.44, priceLast: 21.06, corr: null, corrMonths: 2, premium: null, quietMonths: 10 },
];

/** The eleven suppliers the live yard folds into `others`, plus that fold's figures. */
const OTHERS_SUPPLIER_KEYS = [
  'MERCADO', 'ALBURO', 'CABAHUG', 'DELA CRUZ', 'ESCARIO', 'GARCIA',
  'JUMAWAN', 'NAVARRO', 'PANTALEON', 'QUIJANO', 'TORRES',
];
const OTHERS_SPEC = { dominant: 5, mixed: 1, kgShare: 5.0077, phpKg: 33.0862 };

/** 17 suppliers, 23 mixed blocks — the live totals. */
const TOTAL_SUPPLIERS = SUPPLIERS.length + OTHERS_SUPPLIER_KEYS.length;

// ── The 30 rig cells ───────────────────────────────────────────────────────

const MOCK_BLOCKS = [
  'A-1A', 'A-2A', 'A-3A', 'A-4A', 'A-5A', 'A-6A', 'A-7A', 'A-8A', 'A-9A', 'A-10A',
  'B-1A', 'B-2A', 'B-3A', 'B-4A', 'B-5A', 'B-6A', 'B-7A', 'B-8A', 'B-9A', 'B-10A',
  'D-1A', 'D-2A', 'D-3A', 'D-4A', 'D-5A', 'D-6A', 'D-7A', 'D-8A', 'D-9A', 'D-10A',
] as const;

/**
 * The PREPARED-CHARCOAL slots, appended under `?pca=1`.
 *
 * They exist for the PRINTED YARD MAP, which includes PCA/PCB **iff the grid payload
 * holds a block in one of them** — so the map has two shapes (14 cell rows against 11)
 * and the one that solves to the SMALLER cell is the one only this switch can produce.
 * They are deliberately NOT in the 30-cell on-screen rig (that grid draws rows A/B/D at
 * ten columns and would have nowhere to put them); the rig's job here is the print.
 */
const MOCK_PREPARED_BLOCKS = ['PCA-15A', 'PCA-16B', 'PCB-15A', 'PCB-17C'] as const;

interface MockCell {
  loc: string;
  batch: string;
  balance: number;
  totalIn: number;
  /** Which entry of `SUPPLIERS` dominates it, or `-1` for the `others` fold. */
  supplierIdx: number;
  /** True = more than one supplier in the block (the VIEW's own rule, here a literal). */
  mixed: boolean;
  /** true = the batch has NO delivery at all, so NO supplier. Absent from both maps. */
  unattributed: boolean;
  ageDays: number | null;
  php: number | null;
  mc: number;
  ash: number;
  bdAstm: number;
}

/**
 * 30 cells spread over the seven bands, including MIXED ones in three different bands so
 * the dashed outline can be judged against three hues, and optional unattributed ones.
 */
function makeCells(includeUnattributed: boolean, includePrepared: boolean): MockCell[] {
  const locs: readonly string[] = includePrepared
    ? [...MOCK_BLOCKS, ...MOCK_PREPARED_BLOCKS]
    : MOCK_BLOCKS;
  return locs.map((loc, i) => {
    const unattributed = includeUnattributed && i % 13 === 9;
    // Bands 0…5 get four cells each; the last six go to the `others` fold.
    const supplierIdx = i < 24 ? i % 6 : -1;
    return {
      loc,
      batch: `SEPT-26-BLK${i + 1}`,
      balance: 120_000 - i * 3_400,
      totalIn: 180_000,
      supplierIdx,
      // Every third cell is mixed, so three different hues carry the marker.
      mixed: !unattributed && i % 3 === 1,
      unattributed,
      ageDays: unattributed ? null : Math.round((12 + i * 40.5) * 10) / 10,
      php: 26 + i * 1.05,
      mc: i % 4 === 0 ? 15.2 : 11.4,
      ash: i % 5 === 0 ? 4.6 : 3.1,
      bdAstm: 0.402,
    };
  });
}

/**
 * Build the payload `fn_blocking_supplier_lens` would return for these cells and this N.
 *
 * FIXTURE arithmetic, not production arithmetic: in the app every one of these numbers
 * comes out of SQL and the panel never adds anything up. It is reproduced here only so
 * the panel has a contract-shaped payload to render, with the live invariants intact —
 * including a band that dominates NO block (`dominantKg` a real 0, never a null) when N
 * is large enough to name one.
 */
function makeSupplierLens(
  cells: MockCell[],
  topN: number,
  /**
   * `false` reproduces what `fetchBlockingSupplierLens` returns to a reader WITHOUT the
   * price flag: **both ₱ keys nulled, `pricesHidden: true`, everything else intact.** It is
   * wired to the rig's own `?prices=0` so the printed band table's `Mixed` column — the
   * price-denied shape of the sheet — is reachable at all. Before this, `?prices=0` only
   * dropped the PRICE lens from the tab strip and left the supplier payload fully priced,
   * so the branch could not be looked at.
   */
  canViewPrices: boolean,
): BlockingSupplierLens {
  const named = SUPPLIERS.slice(0, topN);
  const foldedKeys = [
    ...SUPPLIERS.slice(topN).map((s) => s.key),
    ...OTHERS_SUPPLIER_KEYS,
  ];
  const hasOthers = foldedKeys.length > 0;

  /** Which BAND a cell's dominant supplier lands in. */
  const bandOf = (c: MockCell): number => {
    if (c.supplierIdx === -1) return named.length; // the `others` fold
    return c.supplierIdx < topN ? c.supplierIdx : named.length;
  };

  const bandByBlock: Record<string, number> = {};
  const blockByLoc: Record<string, BlockingSupplierBlock> = {};
  const dominantBlocks = new Array(named.length + 1).fill(0) as number[];
  const dominantKg = new Array(named.length + 1).fill(0) as number[];
  const mixedBlocks = new Array(named.length + 1).fill(0) as number[];
  let unattributedBlocks = 0;
  let unattributedKg = 0;
  let attributedBlocks = 0;
  let attributedKg = 0;
  let mixedTotal = 0;

  for (const c of cells) {
    if (c.unattributed) {
      unattributedBlocks = unattributedBlocks + 1;
      unattributedKg = unattributedKg + c.balance;
      continue;
    }
    const band = bandOf(c);
    const spec = c.supplierIdx === -1 ? null : SUPPLIERS[c.supplierIdx];
    const dominantKey = spec ? spec.key : OTHERS_SUPPLIER_KEYS[0];
    const dominantDisplay = spec ? spec.display : 'Mercado';

    // A mixed block's slices: 71 / 22 / 7, the shape CONTEXT.md quotes as a tooltip.
    // The two minority names are picked so they are never the DOMINANT one — a block
    // listing the same supplier twice would be a fixture artifact the rig would then be
    // asking a reviewer to look past.
    const minor = SUPPLIERS.filter((sp) => sp.key !== dominantKey).slice(0, 2);
    const slices: BlockingSupplierSlice[] = c.mixed
      ? [
          { key: dominantKey, display: dominantDisplay, kg: c.totalIn * 0.71, sharePct: 71, balanceKg: c.balance * 0.71 },
          { key: minor[0].key, display: minor[0].display, kg: c.totalIn * 0.22, sharePct: 22, balanceKg: c.balance * 0.22 },
          { key: minor[1].key, display: minor[1].display, kg: c.totalIn * 0.07, sharePct: 7, balanceKg: c.balance * 0.07 },
        ]
      : [
          { key: dominantKey, display: dominantDisplay, kg: c.totalIn, sharePct: 100, balanceKg: c.balance },
        ];

    bandByBlock[c.loc] = band;
    blockByLoc[c.loc] = {
      blockLoc: c.loc,
      batchId: c.loc,
      batchCode: c.batch,
      bandIndex: band,
      dominantSupplierKey: dominantKey,
      dominantSupplierDisplay: dominantDisplay,
      dominantSharePct: c.mixed ? 71 : 100,
      isMixed: c.mixed,
      supplierCount: c.mixed ? 3 : 1,
      kg: c.balance,
      suppliers: slices,
    };
    dominantBlocks[band] = dominantBlocks[band] + 1;
    dominantKg[band] = dominantKg[band] + c.balance;
    if (c.mixed) {
      mixedBlocks[band] = mixedBlocks[band] + 1;
      mixedTotal = mixedTotal + 1;
    }
    attributedBlocks = attributedBlocks + 1;
    attributedKg = attributedKg + c.balance;
  }

  const totalKg = attributedKg + unattributedKg;

  // The apportioned kg comes from the LIVE shares, re-based onto this rig's attributed
  // kilograms so `Σ apportionedKg + unattributed.kg === total.kg` still holds exactly.
  const shares = [...named.map((s) => s.kgShare), ...(hasOthers ? [OTHERS_SPEC.kgShare] : [])];
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const apportioned = shares.map((s) => (attributedKg * s) / shareSum);

  const bandCount = named.length + (hasOthers ? 1 : 0);
  const bands: BlockingSupplierBand[] = Array.from({ length: bandCount }, (_, i) => {
    const isOthers = hasOthers && i === named.length;
    const spec = isOthers ? OTHERS_SPEC : named[i];
    return {
      index: i,
      key: isOthers ? null : named[i].key,
      display: isOthers ? null : named[i].display,
      isOthers,
      supplierCount: isOthers ? foldedKeys.length : 1,
      supplierKeys: isOthers ? foldedKeys : null,
      dominantBlockCount: dominantBlocks[i] ?? 0,
      dominantKg: dominantKg[i] ?? 0,
      apportionedKg: apportioned[i] ?? 0,
      apportionedDeliveredKg: (apportioned[i] ?? 0) * 1.5,
      kgSharePct: attributedKg > 0 ? ((apportioned[i] ?? 0) / attributedKg) * 100 : null,
      blockSharePct:
        attributedBlocks > 0 ? ((dominantBlocks[i] ?? 0) / attributedBlocks) * 100 : null,
      mixedBlockCount: mixedBlocks[i] ?? 0,
      // THE ₱ COLUMN (2026-09-22). The live per-band figure, weighted over the band's PRICED
      // dominant blocks — and on the live yard EVERY block is priced, so the rig mirrors that
      // and sets the weight equal to `dominantKg`. A rig that wants to exercise the partial
      // coverage case should lower one band's `pricedDominantKg` and leave its price alone.
      // WITHHELD is `null` on BOTH keys, never 0 on the weight — that pair is what the
      // panel reads to tell "withheld" from "dominates no priced block".
      kgWeightedPhpKg: canViewPrices ? (spec ? spec.phpKg : null) : null,
      pricedDominantKg: canViewPrices ? (dominantKg[i] ?? 0) : null,
    };
  });

  // The yard's own figure, weighted over the bands rather than restated — so the rig's footer
  // and its rows can never disagree, which is exactly the property the SQL guarantees live.
  // Folded over `dominantKg`, not over the (possibly withheld) per-band weight, so the
  // rig's footer is the same number whether or not the reader may see it.
  const pricedTotalKg = dominantKg.reduce((s, kg) => s + kg, 0);
  const weightedTotalPhp =
    pricedTotalKg > 0
      ? bands.reduce(
          (s, b, i) => s + (dominantKg[i] ?? 0) * (b.isOthers ? OTHERS_SPEC.phpKg : SUPPLIERS[i].phpKg),
          0,
        ) / pricedTotalKg
      : null;

  return {
    topN,
    bands,
    bandByBlock,
    blockByLoc,
    unattributed: { blockCount: unattributedBlocks, kg: unattributedKg },
    total: {
      blockCount: attributedBlocks + unattributedBlocks,
      kg: totalKg,
      supplierCount: TOTAL_SUPPLIERS,
      mixedBlockCount: mixedTotal,
      attributedBlockCount: attributedBlocks,
      attributedKg,
      kgWeightedPhpKg: canViewPrices ? weightedTotalPhp : null,
      pricedDominantKg: canViewPrices ? pricedTotalKg : null,
    },
    // TRUE = the two ₱ keys above were WITHHELD, not absent. Driven by `?prices=0`.
    pricesHidden: !canViewPrices,
  };
}

// ── Enough of the other two lenses to make the THREE-tab strip real ─────────

const MARKET = 39.8568;
const R = 40;

const BASES: BlockingMarketBasis[] = [
  { basisKey: 'this_month', marketPhpKg: MARKET, pricedKg: 566_870, deliveryCount: 37, fromDate: '2026-09-01', toDate: '2026-09-30' },
  { basisKey: 'last_month', marketPhpKg: 39.9698, pricedKg: 824_027, deliveryCount: 50, fromDate: '2026-08-01', toDate: '2026-08-31' },
  { basisKey: 'last_3_months', marketPhpKg: 39.1187, pricedKg: 2_292_401, deliveryCount: 138, fromDate: '2026-07-01', toDate: '2026-09-30' },
  // ⚠️ THE SHIPPED DEFAULT SINCE 2026-09-22 — without this row the price tab opens on a basis
  // that does not exist and renders no band at all. See the price rig's own note.
  { basisKey: 'this_quarter', marketPhpKg: 39.1816, pricedKg: 2_479_361, deliveryCount: 153, fromDate: '2026-07-01', toDate: '2026-09-30' },
  { basisKey: 'trailing_days', marketPhpKg: null, pricedKg: 0, deliveryCount: 0, fromDate: '2026-09-18', toDate: '2026-09-19' },
];

function makeAgeLens(cells: MockCell[], edges: number[]): BlockingAgeLens {
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
      undatedBlocks += 1;
      undatedKg += c.balance;
      continue;
    }
    const b = bandOf(c.ageDays);
    bandByBlock[c.loc] = b;
    ageByBlock[c.loc] = c.ageDays;
    counts[b] += 1;
    kgs[b] += c.balance;
    ageKg[b] += c.ageDays * c.balance;
    datedBlocks += 1;
    datedKg += c.balance;
    datedAgeKg += c.ageDays * c.balance;
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
    kgWeightedAgeDays: kgs[i] > 0 ? ageKg[i] / kgs[i] : null,
  }));

  return {
    asOf: '2026-09-22',
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
  const vals = new Array(edges.length + 1).fill(0) as number[];
  let pricedBlocks = 0;
  let pricedKg = 0;
  let pricedVal = 0;

  // The BANDED (i.e. priced) blocks — exactly the population `blockByLoc` and
  // `warehouseSubtotals` cover in the live payload. This fixture is the one that HAS supplier
  // facts, so it fills all three supplier keys for real, including the
  // `unattributed` shape: NULL display and NULL `isMixed`, never a placeholder and never
  // `false`.
  const banded: FixturePriceBlock[] = [];

  for (const c of cells) {
    if (c.php === null) continue;
    const b = bandOf(c.php);
    bandByBlock[c.loc] = b;
    counts[b] += 1;
    kgs[b] += c.balance;
    vals[b] += c.balance * c.php;
    pricedBlocks += 1;
    pricedKg += c.balance;
    pricedVal += c.balance * c.php;
    const spec = c.supplierIdx >= 0 ? SUPPLIERS[c.supplierIdx] : undefined;
    banded.push({
      loc: c.loc,
      band: b,
      kg: c.balance,
      php: c.php,
      lab: { mc: c.mc, ash: c.ash, bdAstm: c.bdAstm },
      supplier: c.unattributed ? null : (spec?.display ?? 'Others'),
      isMixed: c.unattributed ? null : c.mixed,
      sharePct: c.unattributed ? null : c.mixed ? 62.5 : 100,
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
    unpriced: { blockCount: 0, kg: 0 },
    total: {
      blockCount: pricedBlocks,
      kg: pricedKg,
      kgWeightedPhpKg: pricedKg > 0 ? pricedVal / pricedKg : null,
      ...fixtureLabStats(banded.map((b) => ({ kg: b.kg, lab: b.lab }))),
    },
  };
}

function formatKg(v: number): string {
  return Math.round(v).toLocaleString();
}

const TOP_N_SHAPES: Record<string, number> = { '1': 1, '3': 3, '6': 6, '12': 12 };

export function SupplierLensFixture() {
  const params = useSearchParams();
  const topKey = params.get('top') ?? '6';
  const topN = TOP_N_SHAPES[topKey] ?? 6;
  const includeUnattributed = params.get('unattributed') === '1';
  const canViewPrices = params.get('prices') !== '0';
  /** `?pca=1` puts stock in PCA/PCB, which is what makes the PRINTED yard map include them. */
  const includePrepared = params.get('pca') === '1';

  const cells = React.useMemo(
    () => makeCells(includeUnattributed, includePrepared),
    [includeUnattributed, includePrepared],
  );

  // The grid map every panel reads for its PRINTED summary's per-block rows — the block
  // code, the batch, the balance AND the seven lab readings the new sheet prints. Shaped
  // exactly like `BlockingGridData.data`.
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
        bd_jis: c.bdAstm + 0.018,
        ash: c.ash,
        mc: c.mc,
        grit: 1.2,
        vm: 18.4,
        fc: 78.2,
      };
    }
    return out;
  }, [cells]);

  const supplierAdapter: SupplierLensAdapter = React.useMemo(
    () => ({
      fetchLens: async (n) => {
        await sleep(FIXTURE_LATENCY_MS);
        return { ok: true, lens: makeSupplierLens(cells, n, canViewPrices) };
      },
      // ── PAGE ONE's PRICE vs VOLUME ────────────────────────────────────────
      // The rig answers for the keys it was ASKED about, so a key the fixture has no spec
      // for is genuinely absent from the reply and the printed section NAMES it — exactly
      // what the live function does with a supplier that bought nothing in the window.
      //
      // `?prices=0` REFUSES, byte for byte as the action does: the whole payload is money
      // (including the correlation, which is ₱-derived), so there is no nulled half to
      // hand a price-denied reader. That is what makes "the entire section is absent"
      // reachable on the rig at all.
      fetchMarket: async (months, keys) => {
        await sleep(FIXTURE_LATENCY_MS);
        if (!canViewPrices) {
          return {
            ok: false,
            reason: 'prices_hidden',
            message: 'Prices are hidden for this view.',
          };
        }
        const asked = new Set(keys);
        return {
          ok: true,
          market: fixtureSupplierMarket(
            SUPPLIER_MARKET_SPECS.filter((s) => asked.has(s.key)),
            FIXTURE_MARKET_CONTEXT.months.slice(-months).map((m) => m.month),
          ),
        };
      },
    }),
    [cells, canViewPrices],
  );

  const ageAdapter: AgeLensAdapter = React.useMemo(
    () => ({
      fetchLens: async (edgeDays) => {
        await sleep(FIXTURE_LATENCY_MS);
        return { ok: true, lens: makeAgeLens(cells, [...edgeDays]) };
      },
    }),
    [cells],
  );

  const priceAdapter: PriceLensAdapter = React.useMemo(
    () => ({
      fetchBases: async (trailingDays) => {
        await sleep(FIXTURE_LATENCY_MS);
        return { ok: true, bases: BASES, trailingDays };
      },
      fetchLens: async (_market, edgeOffsets) => {
        await sleep(FIXTURE_LATENCY_MS);
        return { ok: true, lens: makePriceLens(cells, [...edgeOffsets]) };
      },
      // Page one's MARKET table and chart. The price lens is only OFFERED when
      // `canViewPrices` is true (its own `canShow`), so this needs no gate of its own — but
      // the LIVE action refuses regardless, which is the boundary.
      fetchMarketContext: async () => {
        await sleep(FIXTURE_LATENCY_MS);
        return { ok: true, context: FIXTURE_MARKET_CONTEXT };
      },
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
        {
          ...SUPPLIER_LENS,
          Panel: (props: React.ComponentProps<typeof SupplierLensPanel>) => (
            <SupplierLensPanel {...props} adapter={supplierAdapter} />
          ),
        },
      ].filter((l) => l.canShow(caps)),
    [ageAdapter, priceAdapter, supplierAdapter, caps],
  );

  const [activeId, setActiveId] = React.useState<BlockingLensId>(SUPPLIER_LENS.id);
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

  // `?top=` has to reach the panel through the SAME door a real reader's settings do —
  // `useLensSettings` reads localStorage on mount — so the rig seeds that key and only
  // then mounts the panel. Writing it any other way would mean the shape on screen was
  // not the shape the settings pipeline produces.
  const [seeded, setSeeded] = React.useState(false);
  React.useLayoutEffect(() => {
    try {
      window.localStorage.setItem(
        'bw.blocking_lens_supplier.v1',
        JSON.stringify({ topN }),
      );
    } catch {
      // Blocked store — the panel will simply show its shipped defaults.
    }
    setSeeded(true);
  }, [topN]);

  const rows = ['A', 'B', 'D'];

  return (
    <div className="min-h-dvh bg-background p-3 text-foreground">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Supplier lens look rig · static payload · <code>?top={topKey}</code> ({topN} named +
        others) · <code>?unattributed={includeUnattributed ? '1' : '0'}</code> ·{' '}
        <code>?prices={canViewPrices ? '1' : '0'}</code> ({lenses.length} lens
        {lenses.length === 1 ? '' : 'es'} offered; the supplier payload&apos;s two ₱ keys are{' '}
        {canViewPrices ? 'present' : 'WITHHELD, so the printed band table heads Mixed'}) ·{' '}
        <code>?pca={includePrepared ? '1' : '0'}</code> (PCA/PCB on the printed yard map) ·
        dashed outline = MIXED block · toggle the OS/app theme to see both.
        {focused && (
          <>
            {' '}
            · clicked: <code>{focused}</code>
          </>
        )}
      </p>

      <div className="flex flex-col gap-3">
        {seeded && lenses.length > 0 && (
          <BlockingLensPanel
            key={topN}
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
              {rows.map((row, rowIdx) => (
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
                        <div className="h-full flex flex-col" style={{ gap: '2px', padding: '4px 5px' }}>
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
                          <div className="mt-auto flex flex-col" style={{ paddingTop: '2px', gap: '1px' }}>
                            {/* The dominant supplier, so the tint can be read against
                                the name it stands for. */}
                            <div
                              className="flex justify-between font-mono font-bold leading-none text-zinc-800 dark:text-white/95"
                              style={{ fontSize: '9px' }}
                            >
                              <span className="truncate">
                                {c.unattributed
                                  ? '—'
                                  : c.supplierIdx === -1
                                    ? 'MERCADO'
                                    : SUPPLIERS[c.supplierIdx].display.toUpperCase()}
                              </span>
                              {c.mixed && <span>MIX</span>}
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
                            {/* The lab-highlight RED case, over every band — the one
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
