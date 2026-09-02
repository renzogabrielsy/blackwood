/**
 * verify-blend-diff.ts — pin `lib/blocking/blend-diff.ts`, the pure arithmetic behind
 * "Modify" and "Compare with today" on the Blocking page.
 *
 * Run: npx tsx scripts/verify-blend-diff.ts
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * Two of its behaviours are silent when wrong, which is the only kind of wrong worth
 * a verifier:
 *
 *  1. **Resolution is by BATCH IDENTITY, not by block address.** `block_loc` is
 *     REUSED — `batches.location_ref` is cleared when a pile empties — so a Modify
 *     that seeded its selection from block names would happily re-propose a different
 *     pile under the same address and show a plausible number. Nothing on screen
 *     would look wrong. The assertions below fix the rule that a block is re-selected
 *     ONLY when the batch there today is the batch that was proposed.
 *
 *  2. **NULL ≠ 0 on every delta.** A gated or unpriced ₱ is absent, not zero; a
 *     comparison that renders "0.00" for "we don't know" is the L-008 placeholder
 *     mistake in a new costume. Every delta whose either side is missing must be
 *     NULL, and `formatSignedDelta` must print an em dash rather than a number.
 *
 * The module is pure and dependency-free, so this runs offline with no database and
 * no network. It is a REGRESSION GATE: if it fails, the module changed behaviour, and
 * the module is what the UI trusts.
 */
import assert from 'node:assert/strict';

import {
  BLEND_LAB_KEYS,
  blendLabDecimals,
  resolveBlendBlocks,
  describeBlendUnresolved,
  makeBlendDelta,
  formatSignedDelta,
  blendDeltaDirection,
  compareBlendSnapshots,
  type BlendBlockRef,
  type BlendGridOccupant,
  type BlendComparable,
} from '../lib/blocking/blend-diff';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Three saved blocks. On the live grid: A-1A still holds its pile, A-1B was emptied
// and refilled by a DIFFERENT batch, A-1C is empty.

const SAVED: BlendBlockRef[] = [
  { block_loc: 'A-1A', batch_code: 'JULY-26-BLK1', batch_id: 'id-1' },
  { block_loc: 'A-1B', batch_code: 'JULY-26-BLK2', batch_id: 'id-2' },
  { block_loc: 'A-1C', batch_code: 'JULY-26-BLK3', batch_id: 'id-3' },
];

const GRID: Record<string, BlendGridOccupant> = {
  'A-1A': { batch_id: 'id-1', batch_code: 'JULY-26-BLK1' },
  'A-1B': { batch_id: 'id-9', batch_code: 'AUG-26-BLK9' },
  // A-1C absent — the slot is empty today.
  'B-2A': { batch_id: 'id-7', batch_code: 'AUG-26-BLK7' },
};

const LAB = { mc: 10, ash: 4, bd_astm: 0.45, bd_jis: 0.4, grit: 2, vm: 20, fc: 70 };

function comparable(over: Partial<BlendComparable> = {}): BlendComparable {
  return {
    block_count: 3,
    total_balance: 300_000,
    weighted: { ...LAB },
    raw_price_per_kg: 40,
    product_cost_per_kg: 52,
    blocks: [
      { block_loc: 'A-1A', batch_code: 'JULY-26-BLK1', batch_id: 'id-1', balance: 100_000 },
      { block_loc: 'A-1B', batch_code: 'JULY-26-BLK2', batch_id: 'id-2', balance: 100_000 },
      { block_loc: 'A-1C', batch_code: 'JULY-26-BLK3', batch_id: 'id-3', balance: 100_000 },
    ],
    ...over,
  };
}

// ─── 1. Resolution by identity ───────────────────────────────────────────────

console.log('\nresolveBlendBlocks — identity, not address');

check('a block still holding the proposed batch is re-selected', () => {
  const r = resolveBlendBlocks(SAVED, GRID);
  assert.deepEqual(r.resolved, ['A-1A']);
  assert.equal(r.total, 3);
});

check('a block now holding a DIFFERENT batch is NOT selected, and names both sides', () => {
  const r = resolveBlendBlocks(SAVED, GRID);
  const moved = r.unresolved.find((u) => u.block_loc === 'A-1B');
  assert.ok(moved, 'A-1B must be reported unresolved');
  assert.equal(moved.reason, 'different_batch');
  assert.equal(moved.batch_code, 'JULY-26-BLK2', 'the batch that WAS proposed');
  assert.equal(moved.currentBatchCode, 'AUG-26-BLK9', 'the batch sitting there now');
});

check('an emptied block reports reason `empty` with a null current batch', () => {
  const r = resolveBlendBlocks(SAVED, GRID);
  const gone = r.unresolved.find((u) => u.block_loc === 'A-1C');
  assert.ok(gone);
  assert.equal(gone.reason, 'empty');
  assert.equal(gone.currentBatchCode, null);
});

check('THE LOAD-BEARING CASE: same block_loc, same batch_code, DIFFERENT batch_id → unresolved', () => {
  // A pile re-created under a recycled code is not the pile that was proposed. If this
  // ever resolves, Modify silently re-proposes different charcoal.
  const r = resolveBlendBlocks(
    [{ block_loc: 'A-1A', batch_code: 'JULY-26-BLK1', batch_id: 'id-OLD' }],
    { 'A-1A': { batch_id: 'id-NEW', batch_code: 'JULY-26-BLK1' } },
  );
  assert.deepEqual(r.resolved, []);
  assert.equal(r.unresolved[0].reason, 'different_batch');
});

check('a saved row with no batch_id falls back to batch_code (and still refuses a mismatch)', () => {
  const hit = resolveBlendBlocks([{ block_loc: 'A-1A', batch_code: 'JULY-26-BLK1' }], GRID);
  assert.deepEqual(hit.resolved, ['A-1A']);
  const miss = resolveBlendBlocks([{ block_loc: 'A-1B', batch_code: 'JULY-26-BLK2' }], GRID);
  assert.deepEqual(miss.resolved, []);
  assert.equal(miss.unresolved[0].reason, 'different_batch');
});

check('a row with neither id nor code is `unknown_identity`, never silently resolved', () => {
  const r = resolveBlendBlocks([{ block_loc: 'A-1A', batch_code: '' }], GRID);
  assert.deepEqual(r.resolved, []);
  assert.equal(r.unresolved[0].reason, 'unknown_identity');
});

check('duplicate block_locs collapse to one entry (the selection is a Set)', () => {
  const r = resolveBlendBlocks(
    [SAVED[0], SAVED[0], { block_loc: '  ', batch_code: 'X' }],
    GRID,
  );
  assert.deepEqual(r.resolved, ['A-1A']);
  assert.equal(r.total, 1, 'a blank loc contributes nothing and a repeat is not double-counted');
});

check('an all-resolved version produces NO notice; a partial one names the blocks', () => {
  assert.equal(describeBlendUnresolved(resolveBlendBlocks([SAVED[0]], GRID)), null);
  assert.equal(
    describeBlendUnresolved(resolveBlendBlocks(SAVED, GRID)),
    '2 of 3 blocks no longer hold the proposed batch: A-1B, A-1C',
  );
});

check('the notice agrees with itself: verb on the count, noun on the total', () => {
  assert.equal(
    describeBlendUnresolved(resolveBlendBlocks([SAVED[0], SAVED[1]], GRID)),
    '1 of 2 blocks no longer holds the proposed batch: A-1B',
  );
  assert.equal(
    describeBlendUnresolved(resolveBlendBlocks([SAVED[1]], GRID)),
    '1 of 1 block no longer holds the proposed batch: A-1B',
  );
});

check('a long unresolved list truncates with `+N more` instead of growing unbounded', () => {
  const many: BlendBlockRef[] = Array.from({ length: 7 }, (_, i) => ({
    block_loc: `D-${i}A`,
    batch_code: `B${i}`,
    batch_id: `x${i}`,
  }));
  const msg = describeBlendUnresolved(resolveBlendBlocks(many, {}), 4);
  assert.equal(msg, '7 of 7 blocks no longer hold the proposed batch: D-0A, D-1A, D-2A, D-3A +3 more');
});

// ─── 2. Deltas — NULL is never 0 ─────────────────────────────────────────────

console.log('\nmakeBlendDelta / formatSignedDelta — NULL ≠ 0');

check('a delta needs BOTH sides; a missing (gated) price yields NULL, never 0', () => {
  assert.equal(makeBlendDelta(40, 42).delta, 2);
  assert.equal(makeBlendDelta(null, 42).delta, null);
  assert.equal(makeBlendDelta(40, null).delta, null);
  assert.equal(makeBlendDelta(null, null).delta, null);
});

check('a non-finite input is treated as absent, not as a number', () => {
  assert.equal(makeBlendDelta(Number.NaN, 42).delta, null);
  assert.equal(makeBlendDelta(40, Number.POSITIVE_INFINITY).after, null);
});

check('formatting: + for a rise, - for a fall, unsigned zero, em dash for unknown', () => {
  assert.equal(formatSignedDelta(1.234, 2), '+1.23');
  assert.equal(formatSignedDelta(-0.456, 2), '-0.46');
  assert.equal(formatSignedDelta(0, 2), '0.00');
  assert.equal(formatSignedDelta(null, 2), '—');
  assert.equal(formatSignedDelta(0.0004, 3), '0.000', 'a rounding artefact never renders as a move');
  assert.equal(formatSignedDelta(-0.0004, 3), '0.000', 'and never as a NEGATIVE move');
});

check('kilogram deltas are GROUPED so they read like the number they sit beside', () => {
  // `-55120` next to `174,580` looks like a different kind of number; `-55,120` does not.
  assert.equal(formatSignedDelta(-55_120, 0, true), '-55,120');
  assert.equal(formatSignedDelta(55_120, 0, true), '+55,120');
  assert.equal(formatSignedDelta(-55_120, 0), '-55120', 'ungrouped is still the default');
  assert.equal(formatSignedDelta(0, 0, true), '0');
  assert.equal(formatSignedDelta(null, 0, true), '—');
});

check('direction is for colour only and is null when the delta is unknown', () => {
  assert.equal(blendDeltaDirection(1, 0), 'up');
  assert.equal(blendDeltaDirection(-1, 0), 'down');
  assert.equal(blendDeltaDirection(0, 0), 'flat');
  assert.equal(blendDeltaDirection(0.004, 0.01), 'flat', 'epsilon suppresses noise');
  assert.equal(blendDeltaDirection(null), null);
});

// ─── 3. Comparing two blends ─────────────────────────────────────────────────

console.log('\ncompareBlendSnapshots — subtraction only, no re-aggregation');

check('identical blends produce every delta = 0 and no block flagged', () => {
  const c = compareBlendSnapshots(comparable(), comparable());
  assert.equal(c.totalBalance.delta, 0);
  assert.equal(c.blockCount.delta, 0);
  for (const k of BLEND_LAB_KEYS) assert.equal(c.weighted[k].delta, 0, `weighted.${k}`);
  assert.deepEqual(c.changedBlockLocs, []);
  assert.deepEqual(c.missingBlockLocs, []);
  assert.deepEqual(c.addedBlockLocs, []);
});

check('signed deltas carry direction: a fallen balance is negative, a risen stat positive', () => {
  const today = comparable({
    total_balance: 288_500,
    weighted: { ...LAB, mc: 11.5, ash: 3.5 },
  });
  const c = compareBlendSnapshots(comparable(), today);
  assert.equal(c.totalBalance.delta, -11_500);
  assert.equal(c.weighted.mc.delta, 1.5);
  assert.equal(c.weighted.ash.delta, -0.5);
  assert.equal(formatSignedDelta(c.weighted.ash.delta, 2), '-0.50');
});

check('a ₱ the reader cannot see compares to NULL on BOTH price rows', () => {
  const gated = comparable({ raw_price_per_kg: null, product_cost_per_kg: null });
  const c = compareBlendSnapshots(comparable(), gated);
  assert.equal(c.rawPrice.delta, null);
  assert.equal(c.productCost.delta, null);
  assert.equal(c.rawPrice.before, 40, 'the side that IS known is still reported');
  assert.equal(c.rawPrice.after, null);
});

check('a block whose occupant changed is flagged — via the grid id map the live blend lacks', () => {
  // The LIVE what-if carries no batch_id, so identity must come from the supplied map.
  const today = comparable({
    blocks: comparable().blocks.map((b) =>
      b.block_loc === 'A-1B' ? { ...b, batch_code: 'AUG-26-BLK9', batch_id: undefined } : { ...b, batch_id: undefined },
    ),
  });
  const c = compareBlendSnapshots(comparable(), today, {
    'A-1A': 'id-1',
    'A-1B': 'id-9',
    'A-1C': 'id-3',
  });
  assert.deepEqual(c.changedBlockLocs, ['A-1B']);
  const row = c.blocks.find((b) => b.block_loc === 'A-1B')!;
  assert.equal(row.snapshotBatchCode, 'JULY-26-BLK2');
  assert.equal(row.currentBatchCode, 'AUG-26-BLK9');
  assert.equal(row.batchChanged, true);
});

check('with no id map it falls back to batch_code and still flags the change', () => {
  const today = comparable({
    blocks: comparable().blocks.map((b) =>
      b.block_loc === 'A-1B' ? { ...b, batch_code: 'AUG-26-BLK9', batch_id: undefined } : { ...b, batch_id: undefined },
    ),
  });
  const c = compareBlendSnapshots(comparable(), today);
  assert.deepEqual(c.changedBlockLocs, ['A-1B']);
});

check('a block that vanished is `missing`, one that appeared is `added`, and both keep a NULL delta', () => {
  const today = comparable({
    block_count: 3,
    blocks: [
      comparable().blocks[0],
      comparable().blocks[1],
      { block_loc: 'B-2A', batch_code: 'AUG-26-BLK7', batch_id: 'id-7', balance: 50_000 },
    ],
  });
  const c = compareBlendSnapshots(comparable(), today);
  assert.deepEqual(c.missingBlockLocs, ['A-1C']);
  assert.deepEqual(c.addedBlockLocs, ['B-2A']);
  assert.equal(c.blocks.find((b) => b.block_loc === 'A-1C')!.balance.delta, null);
  assert.equal(c.blocks.find((b) => b.block_loc === 'B-2A')!.balance.delta, null);
  assert.equal(c.blocks.length, 4, 'the union of both lists, snapshot order first');
  assert.equal(c.blocks[0].block_loc, 'A-1A');
  assert.equal(c.blocks[3].block_loc, 'B-2A');
});

check('it computes NOTHING new — every output figure is present in an input', () => {
  // The whole point: this module subtracts, it never re-weights or re-sums. A blend
  // whose parts do not add up is passed through unchanged, not "corrected".
  const lying = comparable({ total_balance: 999, block_count: 42 });
  const c = compareBlendSnapshots(lying, lying);
  assert.equal(c.totalBalance.before, 999, 'not re-summed from the 3 × 100,000 blocks');
  assert.equal(c.blockCount.before, 42, 'not re-counted from blocks.length');
});

check('lab decimals follow the Excel Standard: BD → 3, the rest → 2', () => {
  assert.equal(BLEND_LAB_KEYS.length, 7);
  assert.equal(blendLabDecimals('bd_astm'), 3);
  assert.equal(blendLabDecimals('bd_jis'), 3);
  for (const k of ['mc', 'ash', 'grit', 'vm', 'fc'] as const) assert.equal(blendLabDecimals(k), 2);
});

console.log(`\nAll ${passed} blend-diff checks passed.`);
