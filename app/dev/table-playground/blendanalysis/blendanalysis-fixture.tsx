'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The blend ANALYSIS PAGES' look rig. See `page.tsx` for why it exists and how it is
// gated.
//
// Everything below is a LITERAL or is derived from literals. There is no Supabase
// client, no auth helper and no server action on this page: the dialog's two reads are
// supplied through its `analysisAdapter` / `factsAdapter` ports, shaped exactly like
// the data layer's contract — including the invariants the live function guarantees
// (Σ group kg + unmeasured kg = totalKg, Σ shares = 100, an empty group's weighted
// figure NULL rather than 0, `groupCount === groups.length`).
//
// ⚠️ THE ARITHMETIC BELOW IS FIXTURE ARITHMETIC, NOT PRODUCTION ARITHMETIC. In the app
// every one of these numbers comes out of `fn_blend_analysis` / `fn_natural_breaks_3`
// and neither the dialog nor the print adds anything up. It is reproduced here only so
// the REAL components have a contract-shaped payload to render.
//
// The block population is the owner's own `26 OCT RUN V2` v2 shape, as CONTEXT.md
// records it: 24 blocks, prices in two clumps (₱36.57–38.59 and ₱47.00–49.50) with a
// third group between them (₱39.34–40.90), market ₱39.8272 → R 40 — so the natural split
// is 7 / 5 / 12 and the market split is 7 below / 5 at / 12 above.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { BlendProposalDialog } from '@/app/(app)/inventory/_shared/blend-proposal-dialog';
import {
  BLEND_ANALYSIS_PAGE_ORDER,
  type BlendAnalysisPageId,
} from '@/app/(app)/inventory/_shared/blend-analysis-options';
import type { BlendProposal } from '@/app/(app)/inventory/blocking/actions';
import type {
  BlendAgeBand,
  BlendAnalysis,
  BlendAnalysisBlockRef,
  BlendNaturalCut,
  BlendNaturalGroupLabel,
  BlendNaturalStats,
  BlendPriceBlock,
  BlendPriceNaturalGroup,
  BlendQualityGroup,
  BlendQualityMetric,
  BlendQualityNatural,
  BlendVsMarketBand,
  BlendProposalVersionSummary,
  SavedBlendProposal,
} from '@/app/(app)/inventory/blocking/types';

// ── The blocks ──────────────────────────────────────────────────────────────

interface Block {
  loc: string;
  batch: string;
  kg: number;
  /** null = UNPRICED (the L-008 placeholder's effect). */
  php: number | null;
  /** null = NO LAB READING (what `view_blocking_grid`'s COALESCE-to-0 really means). */
  mc: number | null;
  ash: number | null;
  bdAstm: number | null;
  bdJis: number | null;
  /** null = the batch has no dated delivery — no age at all, NOT 0 days. */
  ageDays: number | null;
  first: string | null;
  last: string | null;
}

/** The three price clumps, in the owner's own ranges. */
const PRICES = [
  36.57, 37.0, 37.4, 38.0, 38.2, 38.4, 38.59, // low — 7 blocks
  39.34, 39.7, 40.1, 40.5, 40.9, // mid — 5 (kept tight, so the two widest gaps are the
  //                                 documented ones: 38.59|39.34 and 40.90|47.00)
  47.0, 47.2, 47.5, 47.8, 48.0, 48.2, 48.5, 48.8, 49.0, 49.2, 49.4, 49.5, // high — 12
];

function makeBlocks(includeUnmeasured: boolean): Block[] {
  const out: Block[] = PRICES.map((php, i) => ({
    loc: `${'ABCD'[i % 4]}-${Math.floor(i / 4) + 1}${'ABC'[i % 3]}`,
    batch: `SEPT-26-BLK${i + 1}`,
    kg: 74_590 - i * 1_450,
    php,
    mc: 9.4 + (i % 7) * 1.1,
    ash: 2.1 + (i % 5) * 0.65,
    bdAstm: 0.36 + (i % 6) * 0.012,
    bdJis: 0.39 + (i % 6) * 0.011,
    ageDays: Math.round((18 + i * 47.3) * 10) / 10,
    first: `2026-0${(i % 8) + 1}-0${(i % 9) + 1}`,
    last: `2026-09-0${(i % 9) + 1}`,
  }));
  if (includeUnmeasured) {
    // One block with NO price and NO lab reading and NO delivery date — the three
    // NULL-≠-0 cases at once, which is the row every table must refuse to average in.
    out.push({
      loc: 'B-1A',
      batch: 'AUG-26-BLK12',
      kg: 30_115,
      php: null,
      mc: null,
      ash: null,
      bdAstm: null,
      bdJis: null,
      ageDays: null,
      first: null,
      last: null,
    });
  }
  return out;
}

// ── Fixture arithmetic (see the header) ─────────────────────────────────────

function ref(b: Block): BlendAnalysisBlockRef {
  return { batchId: b.loc, blockLoc: b.loc, batchCode: b.batch, kg: b.kg };
}

/** Σ over a list — FIXTURE ONLY. */
function sum(xs: number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

function weighted(items: { kg: number; v: number }[]): number | null {
  const w = sum(items.map((i) => i.kg));
  if (w <= 0) return null;
  return sum(items.map((i) => i.kg * i.v)) / w;
}

/**
 * Cut a measured population into three groups at its TWO LARGEST GAPS — which on the
 * owner's price data lands on exactly the two the live function finds (38.59|39.34 and
 * 42.00|47.00), and on any other shape at least produces a contract-shaped payload.
 */
function naturalSplit(values: number[]): { cuts: BlendNaturalCut[]; groupCount: number } {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  if (distinct.length <= 1) return { cuts: [], groupCount: distinct.length === 0 ? 0 : 1 };
  if (distinct.length === 2) {
    return {
      cuts: [
        {
          index: 0,
          below: distinct[0],
          above: distinct[1],
          value: (distinct[0] + distinct[1]) / 2,
        },
      ],
      groupCount: 2,
    };
  }
  const gaps = distinct
    .slice(1)
    .map((v, i) => ({ i: i + 1, gap: v - distinct[i] }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i);
  return {
    cuts: gaps.map((g, idx) => ({
      index: idx,
      below: distinct[g.i - 1],
      above: distinct[g.i],
      value: (distinct[g.i - 1] + distinct[g.i]) / 2,
    })),
    groupCount: 3,
  };
}

function groupOf(cuts: BlendNaturalCut[], v: number): number {
  let idx = 0;
  for (const c of cuts) if (v >= c.above) idx += 1;
  return idx;
}

const LABELS: BlendNaturalGroupLabel[][] = [[], ['mid'], ['low', 'high'], ['low', 'mid', 'high']];

function stats(items: { kg: number; v: number }[], cuts: BlendNaturalCut[]): BlendNaturalStats {
  const mean = weighted(items);
  const totalSs =
    mean === null ? null : sum(items.map((i) => i.kg * (i.v - mean) * (i.v - mean)));
  const buckets = new Map<number, { kg: number; v: number }[]>();
  for (const i of items) {
    const g = groupOf(cuts, i.v);
    buckets.set(g, [...(buckets.get(g) ?? []), i]);
  }
  let withinSs = 0;
  for (const list of buckets.values()) {
    const m = weighted(list);
    if (m === null) continue;
    withinSs += sum(list.map((i) => i.kg * (i.v - m) * (i.v - m)));
  }
  return {
    n: items.length,
    distinctCount: new Set(items.map((i) => i.v)).size,
    totalWeight: sum(items.map((i) => i.kg)),
    weightedMean: mean,
    totalSs,
    withinSs: totalSs === null ? null : withinSs,
    betweenSs: totalSs === null ? null : totalSs - withinSs,
    candidatesConsidered: 31,
  };
}

function gvfOf(s: BlendNaturalStats): number | null {
  if (s.totalSs === null || s.totalSs === 0 || s.withinSs === null) return null;
  return 1 - s.withinSs / s.totalSs;
}

function makePriceNatural(blocks: Block[]): BlendAnalysis['price'] {
  const priced = blocks.filter((b) => b.php !== null && b.kg > 0) as (Block & { php: number })[];
  const unpriced = blocks.filter((b) => b.php === null || b.kg <= 0);
  const items = priced.map((b) => ({ kg: b.kg, v: b.php }));
  const { cuts, groupCount } = naturalSplit(priced.map((b) => b.php));
  const st = stats(items, cuts);
  const pricedKg = sum(priced.map((b) => b.kg));

  const groups: BlendPriceNaturalGroup[] = Array.from({ length: groupCount }, (_, gi) => {
    const mine = priced.filter((b) => groupOf(cuts, b.php) === gi);
    const kg = sum(mine.map((b) => b.kg));
    return {
      index: gi,
      label: LABELS[groupCount][gi],
      rangeMin: Math.min(...mine.map((b) => b.php)),
      rangeMax: Math.max(...mine.map((b) => b.php)),
      blockCount: mine.length,
      kg,
      kgSharePct: pricedKg > 0 ? (kg / pricedKg) * 100 : null,
      blockSharePct: priced.length > 0 ? (mine.length / priced.length) * 100 : null,
      kgWeightedPhpKg: kg > 0 ? weighted(mine.map((b) => ({ kg: b.kg, v: b.php }))) : null,
      valuePhp: sum(mine.map((b) => b.kg * b.php)),
      blocks: [...mine]
        .sort((a, b) => b.php - a.php)
        .map<BlendPriceBlock>((b) => ({ ...ref(b), phpKg: b.php })),
    };
  });

  const measuredPrice = weighted(items);
  // The SNAPSHOT's figure is the one an L-008 zero drags down, exactly as the live
  // payload records: it averages the ₱0 placeholders in, the honest figure does not.
  const snapshot =
    unpriced.length === 0
      ? measuredPrice
      : weighted([...items, ...unpriced.map((b) => ({ kg: b.kg, v: 0 }))]);

  // ── Against market: the owner's own 7 below / 3 at / 14 above, at R = 40 ──
  const R = 40;
  const edges = [R - 1, R];
  const bandOf = (php: number) => {
    let i = 0;
    for (const e of edges) if (php >= e) i += 1;
    return i;
  };
  const bands: BlendVsMarketBand[] = Array.from({ length: edges.length + 1 }, (_, bi) => {
    const mine = priced.filter((b) => bandOf(b.php) === bi);
    const kg = sum(mine.map((b) => b.kg));
    return {
      index: bi,
      lowerPhp: bi === 0 ? null : edges[bi - 1],
      upperPhp: bi === edges.length ? null : edges[bi],
      blockCount: mine.length,
      kg,
      kgSharePct: pricedKg > 0 ? (kg / pricedKg) * 100 : null,
      blockSharePct: priced.length > 0 ? (mine.length / priced.length) * 100 : null,
      kgWeightedPhpKg: kg > 0 ? weighted(mine.map((b) => ({ kg: b.kg, v: b.php }))) : null,
      valuePhp: sum(mine.map((b) => b.kg * b.php)),
      blocks: [...mine]
        .sort((a, b) => b.php - a.php)
        .map<BlendPriceBlock>((b) => ({ ...ref(b), phpKg: b.php })),
    };
  });

  return {
    natural: {
      metric: 'php_kg',
      groupCount,
      gvf: gvfOf(st),
      cuts,
      stats: st,
      groups,
      unmeasured: {
        blockCount: unpriced.length,
        kg: sum(unpriced.map((b) => b.kg)),
        noValueCount: unpriced.length,
        noWeightCount: 0,
        blocks: unpriced.map(ref),
      },
      overall: {
        blockCount: blocks.length,
        kg: sum(blocks.map((b) => b.kg)),
        kgWeightedPhpKg: measuredPrice,
        valuePhp: sum(priced.map((b) => b.kg * b.php)),
        snapshotPhpKg: snapshot,
        snapshotGap:
          measuredPrice === null || snapshot === null ? null : measuredPrice - snapshot,
        equalsSnapshot: unpriced.length === 0,
      },
    },
    vsMarket: {
      marketPhpKg: 39.8272,
      marketBasis: 'as_of_month',
      marketBasisMonth: '2026-09-01',
      roundedUpPhp: R,
      edgeOffsets: [-1, 0],
      bands,
      unmeasured: {
        blockCount: unpriced.length,
        kg: sum(unpriced.map((b) => b.kg)),
        blocks: unpriced.map(ref),
      },
      overall: {
        blockCount: blocks.length,
        kg: sum(blocks.map((b) => b.kg)),
        kgWeightedPhpKg: measuredPrice,
        valuePhp: sum(priced.map((b) => b.kg * b.php)),
      },
    },
    vsMarketUnavailable: null,
  };
}

function valueOf(b: Block, metric: BlendQualityMetric): number | null {
  if (metric === 'mc') return b.mc;
  if (metric === 'ash') return b.ash;
  if (metric === 'bd_astm') return b.bdAstm;
  return b.bdJis;
}

function makeQuality(blocks: Block[], metric: BlendQualityMetric): BlendQualityNatural {
  const measured = blocks
    .map((b) => ({ b, v: valueOf(b, metric) }))
    .filter((x): x is { b: Block; v: number } => x.v !== null && x.v > 0 && x.b.kg > 0);
  const missing = blocks.filter((b) => {
    const v = valueOf(b, metric);
    return v === null || v <= 0 || b.kg <= 0;
  });
  const items = measured.map((x) => ({ kg: x.b.kg, v: x.v }));
  const { cuts, groupCount } = naturalSplit(measured.map((x) => x.v));
  const st = stats(items, cuts);
  const measuredKg = sum(measured.map((x) => x.b.kg));

  const groups: BlendQualityGroup[] = Array.from({ length: groupCount }, (_, gi) => {
    const mine = measured.filter((x) => groupOf(cuts, x.v) === gi);
    const kg = sum(mine.map((x) => x.b.kg));
    return {
      index: gi,
      label: LABELS[groupCount][gi],
      rangeMin: Math.min(...mine.map((x) => x.v)),
      rangeMax: Math.max(...mine.map((x) => x.v)),
      blockCount: mine.length,
      kg,
      kgSharePct: measuredKg > 0 ? (kg / measuredKg) * 100 : null,
      blockSharePct: measured.length > 0 ? (mine.length / measured.length) * 100 : null,
      kgWeightedValue: kg > 0 ? weighted(mine.map((x) => ({ kg: x.b.kg, v: x.v }))) : null,
      blocks: [...mine]
        .sort((a, b) => b.v - a.v)
        .map((x) => ({ ...ref(x.b), value: x.v })),
    };
  });

  const measuredValue = weighted(items);
  const snapshot =
    missing.length === 0
      ? measuredValue
      : weighted([...items, ...missing.map((b) => ({ kg: b.kg, v: 0 }))]);

  return {
    metric,
    groupCount,
    gvf: gvfOf(st),
    cuts,
    stats: st,
    groups,
    unmeasured: {
      blockCount: missing.length,
      kg: sum(missing.map((b) => b.kg)),
      noValueCount: missing.length,
      noWeightCount: 0,
      blocks: missing.map(ref),
    },
    overall: {
      blockCount: blocks.length,
      kg: sum(blocks.map((b) => b.kg)),
      kgWeightedValue: measuredValue,
      snapshotValue: snapshot,
      snapshotGap: measuredValue === null || snapshot === null ? null : measuredValue - snapshot,
      equalsSnapshot: missing.length === 0,
    },
  };
}

const AGE_EDGES = [60, 120, 365];

function makeAge(blocks: Block[], asOf: string): BlendAnalysis['age'] {
  const dated = blocks.filter((b): b is Block & { ageDays: number } => b.ageDays !== null);
  const undated = blocks.filter((b) => b.ageDays === null);
  const datedKg = sum(dated.map((b) => b.kg));
  const bandOf = (age: number) => {
    let i = 0;
    for (const e of AGE_EDGES) if (age >= e) i += 1;
    return i;
  };
  const bands: BlendAgeBand[] = Array.from({ length: AGE_EDGES.length + 1 }, (_, bi) => {
    const mine = dated.filter((b) => bandOf(b.ageDays) === bi);
    const kg = sum(mine.map((b) => b.kg));
    return {
      index: bi,
      lowerDays: bi === 0 ? 0 : AGE_EDGES[bi - 1],
      upperDays: bi === AGE_EDGES.length ? null : AGE_EDGES[bi],
      blockCount: mine.length,
      kg,
      kgSharePct: datedKg > 0 ? (kg / datedKg) * 100 : null,
      blockSharePct: dated.length > 0 ? (mine.length / dated.length) * 100 : null,
      kgWeightedAgeDays: kg > 0 ? weighted(mine.map((b) => ({ kg: b.kg, v: b.ageDays }))) : null,
      blocks: [...mine]
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((b) => ({
          ...ref(b),
          ageDays: b.ageDays,
          firstDeliveryDate: b.first,
          lastDeliveryDate: b.last,
          deliveryCount: 3,
        })),
    };
  });
  const oldest = [...dated].sort((a, b) => b.ageDays - a.ageDays)[0] ?? null;
  return {
    asOf,
    edgeDays: AGE_EDGES,
    bands,
    undated: {
      blockCount: undated.length,
      kg: sum(undated.map((b) => b.kg)),
      blocks: undated.map(ref),
    },
    overall: {
      blockCount: blocks.length,
      kg: sum(blocks.map((b) => b.kg)),
      kgWeightedAgeDays: weighted(dated.map((b) => ({ kg: b.kg, v: b.ageDays }))),
      oldestAgeDays: oldest?.ageDays ?? null,
      oldestBlockLoc: oldest?.loc ?? null,
      oldestBatchCode: oldest?.batch ?? null,
    },
  };
}

function makeAnalysis(blocks: Block[], canViewPrices: boolean, asOf: string): BlendAnalysis {
  return {
    source: 'saved',
    asOf,
    proposalId: '00000000-0000-4000-8000-000000000001',
    versionNo: 2,
    title: '26 OCT RUN V2',
    snapshotComputedAt: `${asOf}T09:14:00+08:00`,
    computedAt: new Date().toISOString(),
    blockCount: blocks.length,
    totalKg: sum(blocks.map((b) => b.kg)),
    // THE PRICE HALF IS DELETED for a denied reader — not nulled field by field — and
    // the quality and age halves are still returned. That is the live action's own gate.
    price: canViewPrices ? makePriceNatural(blocks) : null,
    pricesHidden: !canViewPrices,
    quality: {
      metrics: ['mc', 'ash', 'bd_astm', 'bd_jis'],
      byMetric: {
        mc: makeQuality(blocks, 'mc'),
        ash: makeQuality(blocks, 'ash'),
        bd_astm: makeQuality(blocks, 'bd_astm'),
        bd_jis: makeQuality(blocks, 'bd_jis'),
      },
    },
    age: makeAge(blocks, asOf),
  };
}

function makeProposal(blocks: Block[], canViewPrices: boolean): BlendProposal {
  const priced = blocks.filter((b) => b.php !== null) as (Block & { php: number })[];
  const raw = weighted(priced.map((b) => ({ kg: b.kg, v: b.php })));
  return {
    blocks: blocks.map((b) => ({
      block_loc: b.loc,
      batch_code: b.batch,
      batch_id: b.loc,
      status: 'STORED',
      balance: b.kg,
      mc: b.mc ?? 0,
      ash: b.ash ?? 0,
      bd_astm: b.bdAstm ?? 0,
      bd_jis: b.bdJis ?? 0,
      grit: 1.2,
      vm: 18.4,
      fc: 78.2,
      php_kg: canViewPrices ? b.php : null,
    })),
    block_count: blocks.length,
    total_balance: sum(blocks.map((b) => b.kg)),
    weighted: { mc: 11.42, ash: 3.13, bd_astm: 0.402, bd_jis: 0.418, grit: 1.2, vm: 18.4, fc: 78.2 },
    raw_price_per_kg: canViewPrices ? raw : null,
    production_loss_pct: 30,
    product_cost_per_kg: canViewPrices && raw !== null ? raw * 1.3 : null,
    can_view_prices: canViewPrices,
  };
}

// ── The rig ─────────────────────────────────────────────────────────────────

const AS_OF = '2026-09-21';

export function BlendAnalysisFixture() {
  const params = useSearchParams();
  const canViewPrices = params.get('prices') !== '0';
  const includeUnmeasured = params.get('unmeasured') === '1';
  const isSaved = params.get('saved') === '1';
  const stall = params.get('stall') === '1';
  const delay = Number(params.get('slow') ?? '300');
  const pagesParam = params.get('pages');

  const blocks = React.useMemo(() => makeBlocks(includeUnmeasured), [includeUnmeasured]);
  const proposal = React.useMemo(
    () => makeProposal(blocks, canViewPrices),
    [blocks, canViewPrices],
  );
  const analysis = React.useMemo(
    () => makeAnalysis(blocks, canViewPrices, AS_OF),
    [blocks, canViewPrices],
  );

  // A REALISTIC delay, deliberately: a microtask-resolving adapter hid a request race
  // on the lens panels, and a skeleton that never renders cannot be reviewed.
  const analysisAdapter = React.useCallback(
    async () => {
      if (stall) return new Promise<never>(() => {});
      await new Promise((r) => setTimeout(r, Number.isFinite(delay) ? delay : 300));
      return { ok: true as const, analysis };
    },
    [analysis, delay, stall],
  );

  const factsAdapter = React.useCallback(async () => {
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true as const, facts: {}, asOf: AS_OF };
  }, []);

  // `?pages=` reaches the dialog through the SAME door a real reader's choice does —
  // `useModuleSettings` reads localStorage on mount — so the rig seeds that key and
  // only then mounts. Writing it any other way would mean what is on screen was not
  // what the settings pipeline produces.
  const [seeded, setSeeded] = React.useState(false);
  React.useLayoutEffect(() => {
    try {
      if (pagesParam === null) {
        window.localStorage.removeItem('bw.blocking_blend_analysis.v1');
      } else {
        const wanted = new Set(
          pagesParam
            .split(',')
            .map((s) => s.trim())
            .filter((s): s is BlendAnalysisPageId =>
              (BLEND_ANALYSIS_PAGE_ORDER as readonly string[]).includes(s),
            ),
        );
        const doc: Record<string, boolean> = {};
        for (const id of BLEND_ANALYSIS_PAGE_ORDER) if (!wanted.has(id)) doc[id] = false;
        window.localStorage.setItem('bw.blocking_blend_analysis.v1', JSON.stringify(doc));
      }
    } catch {
      // Blocked store — the dialog shows its shipped defaults (all three pages).
    }
    setSeeded(true);
  }, [pagesParam]);

  const savedProposal: SavedBlendProposal = React.useMemo(
    () => ({
      ...proposal,
      proposal_id: '00000000-0000-4000-8000-000000000001',
      version_no: 2,
      title: '26 OCT RUN V2',
      notes: 'Owner: keep the ash under 3.2 and lean on the cheap corner of WHSE A.',
      change_note: 'Swapped two dear blocks for the D-row piles.',
      created_at: `${AS_OF}T09:14:00+08:00`,
      created_by_name: 'Renzo Sy',
      computed_at: `${AS_OF}T09:14:00+08:00`,
    }),
    [proposal],
  );

  const versions: BlendProposalVersionSummary[] = React.useMemo(
    () => [
      {
        proposalId: '00000000-0000-4000-8000-000000000001',
        versionNo: 1,
        isCurrent: false,
        computedAt: '2026-09-18T10:00:00+08:00',
        blockCount: 21,
        totalBalanceKg: 1_402_000,
        wMc: 11.9,
        wAsh: 3.4,
        wBdAstm: 0.4,
        wBdJis: 0.42,
        wGrit: 1.2,
        wVm: 18.2,
        wFc: 77.9,
        changeNote: null,
        parentVersionNo: null,
        snapshotHash: 'a'.repeat(64),
        createdAt: '2026-09-18T10:00:00+08:00',
        createdByName: 'Renzo Sy',
      },
      {
        proposalId: '00000000-0000-4000-8000-000000000001',
        versionNo: 2,
        isCurrent: true,
        computedAt: `${AS_OF}T09:14:00+08:00`,
        blockCount: proposal.block_count,
        totalBalanceKg: proposal.total_balance,
        wMc: 11.42,
        wAsh: 3.13,
        wBdAstm: 0.402,
        wBdJis: 0.418,
        wGrit: 1.2,
        wVm: 18.4,
        wFc: 78.2,
        changeNote: 'Swapped two dear blocks for the D-row piles.',
        parentVersionNo: 1,
        snapshotHash: 'b'.repeat(64),
        createdAt: `${AS_OF}T09:14:00+08:00`,
        createdByName: 'Renzo Sy',
      },
    ],
    [proposal.block_count, proposal.total_balance],
  );

  const [open, setOpen] = React.useState(true);

  return (
    <div className="min-h-dvh bg-background p-3 text-foreground">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Blend analysis look rig · static payload · <code>?prices={canViewPrices ? '1' : '0'}</code> ·{' '}
        <code>?saved={isSaved ? '1' : '0'}</code> ·{' '}
        <code>?unmeasured={includeUnmeasured ? '1' : '0'}</code> ·{' '}
        <code>?pages={pagesParam ?? '(all)'}</code> · adapter delay{' '}
        <code>{stall ? 'never answers' : `${delay}ms`}</code> · toggle the OS/app theme to see both.
      </p>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-semibold cursor-pointer"
        >
          Reopen the dialog
        </button>
      )}
      {seeded && (
        <BlendProposalDialog
          open={open}
          onOpenChange={setOpen}
          proposal={proposal}
          loading={false}
          showPrices
          analysisAdapter={analysisAdapter}
          factsAdapter={factsAdapter}
          batchIdByLoc={Object.fromEntries(blocks.map((b) => [b.loc, b.loc]))}
          saved={
            isSaved
              ? {
                  proposal: savedProposal,
                  versions,
                  currentVersionNo: 2,
                  status: 'planned',
                  fedOn: null,
                  isArchived: false,
                  busy: false,
                  onSelectVersion: () => undefined,
                  onModify: () => undefined,
                  onCompare: () => undefined,
                  onCloseCompare: () => undefined,
                  comparison: null,
                  compareLoading: false,
                  onSaveHeader: async () => true,
                  onArchiveToggle: () => undefined,
                }
              : null
          }
        />
      )}
    </div>
  );
}
