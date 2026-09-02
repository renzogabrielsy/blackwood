/**
 * blend-diff.ts — the PURE presentation arithmetic behind "Modify" and
 * "Compare with today" on the Blocking page's blend-proposal history.
 *
 * TWO JOBS, AND NEITHER OF THEM IS AGGREGATION.
 *
 *  1. **Resolve a saved version against the live yard, by BATCH IDENTITY.** A saved
 *     version stores its block list keyed by `batch_id`, because `block_loc` is
 *     REUSED — `batches.location_ref` is cleared when a batch empties, so "A-3A" in
 *     September is not necessarily the pile that was proposed in June. Seeding a
 *     Modify by block_loc alone would silently re-propose a different pile under the
 *     same address. So a block is re-selected ONLY when the batch sitting there today
 *     is the batch that was proposed; everything else is reported by name.
 *
 *  2. **Difference two already-computed blends.** Every number that goes in came out
 *     of SQL (`fn_blend_proposal` for the live what-if, `fn_blend_proposal_snapshot`
 *     for the saved version). This module subtracts them and nothing else — it never
 *     re-weights, never re-sums a balance, never recomputes a weighted average. If a
 *     figure is not already present on both sides, its delta is NULL, never 0.
 *
 * Pure and dependency-free on purpose: no React, no `@/` alias, no server action
 * import, no database. `scripts/verify-blend-diff.ts` pins the behaviour.
 *
 * NULL ≠ 0 throughout. A missing price (gated, or a batch with no priced delivery)
 * produces a NULL delta, not a zero one — "we don't know" and "it did not move" are
 * different answers, and the peso column is exactly where confusing them is
 * expensive.
 */

// ─── Lab keys ────────────────────────────────────────────────────────────────

/** The seven weighted lab stats, in the canonical column order the UI renders. */
export const BLEND_LAB_KEYS = ['mc', 'ash', 'bd_astm', 'bd_jis', 'grit', 'vm', 'fc'] as const;

export type BlendLabKey = (typeof BLEND_LAB_KEYS)[number];

/** Decimals per lab stat: BD → 3, everything else → 2 (the Excel Standard). */
export function blendLabDecimals(key: BlendLabKey): number {
  return key === 'bd_astm' || key === 'bd_jis' ? 3 : 2;
}

// ─── Resolving a saved version against the live grid ──────────────────────────

/** A block as a saved version remembers it. `batch_id` is the identity. */
export interface BlendBlockRef {
  block_loc: string;
  batch_code: string;
  /** The proposed batch. Absent only on a payload that predates the snapshot builder. */
  batch_id?: string | null;
}

/** What the live grid says occupies a block right now. */
export interface BlendGridOccupant {
  batch_id: string;
  batch_code: string;
}

/**
 * Why a saved block could not be re-selected.
 * - `empty` — nothing occupies that block on the grid today.
 * - `different_batch` — a block by that name exists, holding a DIFFERENT pile.
 * - `unknown_identity` — the saved row carries neither a batch id nor a batch code,
 *   so there is nothing to compare. Defensive; no version written by the current
 *   snapshot builder can hit it.
 */
export type BlendUnresolvedReason = 'empty' | 'different_batch' | 'unknown_identity';

export interface BlendUnresolvedBlock {
  block_loc: string;
  /** The batch that WAS proposed there. */
  batch_code: string;
  reason: BlendUnresolvedReason;
  /** The batch sitting there now — null when the block is empty. */
  currentBatchCode: string | null;
}

export interface BlendResolution {
  /** block_locs that still hold the proposed batch — seed the selection with these. */
  resolved: string[];
  /** Everything else, named, so the UI can say which ones moved. */
  unresolved: BlendUnresolvedBlock[];
  /** How many blocks the saved version listed (resolved + unresolved). */
  total: number;
}

function sameIdentity(saved: BlendBlockRef, occupant: BlendGridOccupant): boolean {
  const savedId = (saved.batch_id ?? '').trim();
  if (savedId) return savedId === occupant.batch_id;
  // No stored id: fall back to the code, which is unique in `batches` (UNIQUE
  // constraint on `batch_code`) and is therefore a real — if second-choice — identity.
  const savedCode = (saved.batch_code ?? '').trim();
  if (!savedCode) return false;
  return savedCode === (occupant.batch_code ?? '').trim();
}

/**
 * Resolve a saved version's block list against the live grid BY BATCH IDENTITY.
 *
 * Duplicate `block_loc` entries in the input collapse to one (a Set is what seeds the
 * grid selection, so reporting a location twice could only ever mislead a count).
 */
export function resolveBlendBlocks(
  blocks: readonly BlendBlockRef[],
  grid: Readonly<Record<string, BlendGridOccupant>>,
): BlendResolution {
  const resolved: string[] = [];
  const unresolved: BlendUnresolvedBlock[] = [];
  const seen = new Set<string>();

  for (const b of blocks ?? []) {
    const loc = (b?.block_loc ?? '').trim();
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);

    const occupant = grid?.[loc];
    if (!occupant) {
      unresolved.push({
        block_loc: loc,
        batch_code: b.batch_code ?? '',
        reason: 'empty',
        currentBatchCode: null,
      });
      continue;
    }

    if (sameIdentity(b, occupant)) {
      resolved.push(loc);
      continue;
    }

    const hasIdentity = !!(b.batch_id ?? '').trim() || !!(b.batch_code ?? '').trim();
    unresolved.push({
      block_loc: loc,
      batch_code: b.batch_code ?? '',
      reason: hasIdentity ? 'different_batch' : 'unknown_identity',
      currentBatchCode: occupant.batch_code ?? null,
    });
  }

  return { resolved, unresolved, total: resolved.length + unresolved.length };
}

/**
 * One sentence naming what moved, for the floating bar:
 * `2 of 8 blocks no longer hold the proposed batch: A-3A, B-7B`.
 *
 * Returns null when everything resolved — the UI shows nothing rather than a
 * reassuring banner nobody asked for. Long lists are truncated with `+N more` so the
 * bar can never grow unbounded.
 */
export function describeBlendUnresolved(res: BlendResolution, maxNamed = 4): string | null {
  const n = res.unresolved.length;
  if (n === 0) return null;
  const names = res.unresolved.slice(0, Math.max(0, maxNamed)).map((u) => u.block_loc);
  const extra = n - names.length;
  const list = extra > 0 ? `${names.join(', ')} +${extra} more` : names.join(', ');
  // The verb agrees with N (the subject), the noun with the TOTAL: "1 of 4 blocks no
  // longer holds…". Getting this wrong is the kind of thing an operator reads as
  // carelessness about the numbers themselves.
  return `${n} of ${res.total} block${res.total === 1 ? '' : 's'} no longer ${
    n === 1 ? 'holds' : 'hold'
  } the proposed batch: ${list}`;
}

// ─── Signed deltas ───────────────────────────────────────────────────────────

/** A before/after pair and their difference. `delta` is NULL unless BOTH sides exist. */
export interface BlendDelta {
  before: number | null;
  after: number | null;
  delta: number | null;
}

/** Build a delta. A non-finite input is treated as absent (NULL), never as 0. */
export function makeBlendDelta(before: number | null | undefined, after: number | null | undefined): BlendDelta {
  const b = typeof before === 'number' && Number.isFinite(before) ? before : null;
  const a = typeof after === 'number' && Number.isFinite(after) ? after : null;
  return { before: b, after: a, delta: b === null || a === null ? null : a - b };
}

/**
 * `+1.23` / `-0.45` / `0.00` / `—`. A positive delta gets an explicit `+`; zero gets
 * no sign (it did not move); a NULL delta gets an em dash (we do not know).
 *
 * `grouped` adds thousands separators — required for kilogram deltas, where `-55120`
 * beside a grouped `174,580` reads as a different KIND of number rather than the same
 * one. The sign is applied to the absolute value so grouping can never eat it.
 */
export function formatSignedDelta(delta: number | null, decimals = 2, grouped = false): string {
  if (delta === null || !Number.isFinite(delta)) return '—';
  const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals } as const;
  const body = (n: number) => (grouped ? n.toLocaleString(undefined, opts) : n.toFixed(decimals));
  // `(-0.0001).toFixed(2)` is "-0.00"; round FIRST so a rounding artefact never renders
  // as a move at all, let alone a negative one.
  const rounded = Number(delta.toFixed(decimals));
  if (rounded === 0) return body(0);
  return `${rounded > 0 ? '+' : '-'}${body(Math.abs(rounded))}`;
}

/** 'up' | 'down' | 'flat' | null — for colouring, never for arithmetic. */
export function blendDeltaDirection(delta: number | null, epsilon = 0): 'up' | 'down' | 'flat' | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  if (Math.abs(delta) <= epsilon) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

// ─── Comparing two blends ────────────────────────────────────────────────────

/** The structural subset of a blend this module needs. `BlendProposal` satisfies it. */
export interface BlendComparableBlock {
  block_loc: string;
  batch_code: string;
  batch_id?: string | null;
  balance: number;
}

export interface BlendComparable {
  block_count: number;
  total_balance: number;
  weighted: Record<BlendLabKey, number>;
  raw_price_per_kg: number | null;
  product_cost_per_kg: number | null;
  blocks: readonly BlendComparableBlock[];
}

export interface BlendBlockComparison {
  block_loc: string;
  inSnapshot: boolean;
  inCurrent: boolean;
  /** True when both sides have the block but a DIFFERENT batch sits there now. */
  batchChanged: boolean;
  snapshotBatchCode: string | null;
  currentBatchCode: string | null;
  balance: BlendDelta;
}

export interface BlendComparison {
  blockCount: BlendDelta;
  totalBalance: BlendDelta;
  weighted: Record<BlendLabKey, BlendDelta>;
  rawPrice: BlendDelta;
  productCost: BlendDelta;
  /** Union of both block lists, snapshot order first, then anything only in current. */
  blocks: BlendBlockComparison[];
  changedBlockLocs: string[];
  missingBlockLocs: string[];
  addedBlockLocs: string[];
}

function identityOf(
  loc: string,
  block: BlendComparableBlock | undefined,
  idByLoc: Readonly<Record<string, string | null | undefined>> | undefined,
): { id: string | null; code: string | null } {
  const fromMap = idByLoc ? idByLoc[loc] : undefined;
  const id = (fromMap ?? block?.batch_id ?? null) || null;
  return { id: id ? String(id) : null, code: block?.batch_code ?? null };
}

/**
 * Difference a SAVED snapshot against a freshly-computed blend of the same blocks.
 *
 * `currentBatchIdByLoc` exists because the LIVE what-if (`buildBlendProposal`) does not
 * carry `batch_id` — only the saved snapshot does — so the caller supplies the grid's
 * current occupancy map. Without it the comparison falls back to `batch_code`, which is
 * a weaker but still real identity (the column is UNIQUE in `batches`).
 *
 * Read-only in every sense: it produces no new blend and it never touches the snapshot.
 */
export function compareBlendSnapshots(
  snapshot: BlendComparable,
  current: BlendComparable,
  currentBatchIdByLoc?: Readonly<Record<string, string | null | undefined>>,
): BlendComparison {
  const snapByLoc = new Map<string, BlendComparableBlock>();
  for (const b of snapshot?.blocks ?? []) if (b?.block_loc) snapByLoc.set(b.block_loc, b);
  const curByLoc = new Map<string, BlendComparableBlock>();
  for (const b of current?.blocks ?? []) if (b?.block_loc) curByLoc.set(b.block_loc, b);

  const order: string[] = [];
  for (const b of snapshot?.blocks ?? []) if (b?.block_loc && !order.includes(b.block_loc)) order.push(b.block_loc);
  for (const b of current?.blocks ?? []) if (b?.block_loc && !order.includes(b.block_loc)) order.push(b.block_loc);

  const blocks: BlendBlockComparison[] = [];
  const changedBlockLocs: string[] = [];
  const missingBlockLocs: string[] = [];
  const addedBlockLocs: string[] = [];

  for (const loc of order) {
    const s = snapByLoc.get(loc);
    const c = curByLoc.get(loc);
    const inSnapshot = !!s;
    const inCurrent = !!c;

    let batchChanged = false;
    if (inSnapshot && inCurrent) {
      const sid = identityOf(loc, s, undefined);
      const cid = identityOf(loc, c, currentBatchIdByLoc);
      // Prefer ids; fall back to codes only when an id is missing on either side.
      batchChanged =
        sid.id && cid.id
          ? sid.id !== cid.id
          : (sid.code ?? '') !== (cid.code ?? '');
      if (batchChanged) changedBlockLocs.push(loc);
    } else if (inSnapshot) {
      missingBlockLocs.push(loc);
    } else {
      addedBlockLocs.push(loc);
    }

    blocks.push({
      block_loc: loc,
      inSnapshot,
      inCurrent,
      batchChanged,
      snapshotBatchCode: s?.batch_code ?? null,
      currentBatchCode: c?.batch_code ?? null,
      balance: makeBlendDelta(s ? s.balance : null, c ? c.balance : null),
    });
  }

  const weighted = {} as Record<BlendLabKey, BlendDelta>;
  for (const key of BLEND_LAB_KEYS) {
    weighted[key] = makeBlendDelta(snapshot?.weighted?.[key] ?? null, current?.weighted?.[key] ?? null);
  }

  return {
    blockCount: makeBlendDelta(snapshot?.block_count ?? null, current?.block_count ?? null),
    totalBalance: makeBlendDelta(snapshot?.total_balance ?? null, current?.total_balance ?? null),
    weighted,
    rawPrice: makeBlendDelta(snapshot?.raw_price_per_kg ?? null, current?.raw_price_per_kg ?? null),
    productCost: makeBlendDelta(snapshot?.product_cost_per_kg ?? null, current?.product_cost_per_kg ?? null),
    blocks,
    changedBlockLocs,
    missingBlockLocs,
    addedBlockLocs,
  };
}
