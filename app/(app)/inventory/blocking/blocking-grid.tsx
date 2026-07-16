'use client';

import { useState, useMemo, useCallback, useEffect, type CSSProperties } from 'react';
import { Calculator, Check, Layers, X, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { WAREHOUSES, STANDARD_WAREHOUSES } from './constants';
import type { BlockData } from './types';
import { buildBlendProposal, type BlendProposal } from './actions';
import { BlockingDetailPanel, type BlockingDetailNavTarget } from '../_shared/blocking-detail-panel';
import { BlendProposalDialog } from '../_shared/blend-proposal-dialog';
import { useTableSettings } from '@/components/providers/table-settings';
import { getLabHighlightText } from '@/types/table-settings';
import type { LabMetric, LabHighlightSpec } from '@/types/table-settings';

/** All warehouses in render order */
const ALL_WAREHOUSE_KEYS = Object.keys(WAREHOUSES);
/** Default set when "ALL" is active — only the standard 4. PCA/PCB stay opt-in. */
function makeDefaultActive(): Set<string> {
  return new Set<string>(STANDARD_WAREHOUSES);
}

// ─── Price-visibility preference (localStorage) ───────────────────────────────
//
// The "Prices" toggle is a CLIENT-SIDE DISPLAY PREFERENCE that can ONLY HIDE prices,
// never reveal them. It layers ON TOP of the server-side gate: effective visibility is
// always `serverCanViewPrices && showPrices`. Default is ON (prices shown). Persisted so
// a presenter's "hide prices" choice survives reloads. Follows the project's localStorage
// prefs convention (module-scoped key + guarded read/write).
const SHOW_PRICES_PREFS_KEY = 'blocking_show_prices';

function readShowPricesPref(): boolean {
  if (typeof window === 'undefined') return true; // SSR / default ON
  try {
    const raw = window.localStorage.getItem(SHOW_PRICES_PREFS_KEY);
    // Only an explicit "false" hides; anything else (missing/corrupt) → shown.
    return raw !== 'false';
  } catch {
    return true;
  }
}

function writeShowPricesPref(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_PRICES_PREFS_KEY, value ? 'true' : 'false');
  } catch {
    // Private mode / quota — non-fatal; the preference just won't persist.
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type StatusFilter = 'ALL' | 'STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED' | 'EMPTY' | 'WET' | 'ASHY';
type SpotlightMatch = 'none' | 'match' | 'dimmed';
type CellStatus = 'STORED' | 'IN-USE' | 'CLOSED' | 'FEED' | 'SUNDRYING' | 'SUNDRIED' | 'EMPTY';

interface WarehouseStats {
  totalSlots: number;
  occupied: number;
  stored: number;
  inUse: number;
  totalBalance: number;
  weightedPrice: number | null;
  avgMc: number;
  avgAsh: number;
  avgBdAstm: number;
  avgBdJis: number;
  avgGrit: number;
  avgVm: number;
  avgFc: number;
  utilization: string;
}

interface GlobalStats {
  totalBalance: number;
  totalOccupied: number;
  totalSlots: number;
  utilization: string;
  totalValue: number;
  wtdAvgPhpKg: number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getBalanceTextClass(balance: number, totalIn: number): string {
  const pct = totalIn > 0 ? (balance / totalIn) * 100 : 0;
  if (pct >= 50) return 'text-emerald-700 dark:text-emerald-400';
  if (pct >= 20) return 'text-zinc-900 dark:text-white';
  if (pct >= 10) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatKg(val: number): string {
  return Math.round(val).toLocaleString();
}

function getWarehouseStats(whseKey: string, data: Record<string, BlockData>): WarehouseStats {
  const whse = WAREHOUSES[whseKey];
  const totalSlots = whse.cols * whse.rows.length;
  let occupied = 0;
  let totalBalance = 0;
  let stored = 0;
  let inUse = 0;

  // Accumulators for weighted averages: SUM(metric_i * balance_i)
  let wMc = 0;
  let wAsh = 0;
  let wBdAstm = 0;
  let wBdJis = 0;
  let wGrit = 0;
  let wVm = 0;
  let wFc = 0;
  let wPrice = 0;
  let priceWeightSum = 0;

  for (const [loc, block] of Object.entries(data)) {
    if (loc.startsWith(whseKey + '-')) {
      occupied++;
      totalBalance += block.balance;
      wMc += block.mc * block.balance;
      wAsh += block.ash * block.balance;
      wBdAstm += block.bd_astm * block.balance;
      wBdJis += block.bd_jis * block.balance;
      wGrit += block.grit * block.balance;
      wVm += block.vm * block.balance;
      wFc += block.fc * block.balance;
      if (block.php !== null && block.balance > 0) {
        wPrice += block.php * block.balance;
        priceWeightSum += block.balance;
      }
      if (block.status === 'STORED') stored++;
      else inUse++;
    }
  }

  return {
    totalSlots,
    occupied,
    stored,
    inUse,
    totalBalance,
    weightedPrice: priceWeightSum > 0 ? wPrice / priceWeightSum : null,
    avgMc: totalBalance > 0 ? wMc / totalBalance : 0,
    avgAsh: totalBalance > 0 ? wAsh / totalBalance : 0,
    avgBdAstm: totalBalance > 0 ? wBdAstm / totalBalance : 0,
    avgBdJis: totalBalance > 0 ? wBdJis / totalBalance : 0,
    avgGrit: totalBalance > 0 ? wGrit / totalBalance : 0,
    avgVm: totalBalance > 0 ? wVm / totalBalance : 0,
    avgFc: totalBalance > 0 ? wFc / totalBalance : 0,
    utilization: ((occupied / totalSlots) * 100).toFixed(1),
  };
}

function getFilteredGlobalStats(activeWarehouses: Set<string>, data: Record<string, BlockData>): GlobalStats {
  let totalBalance = 0;
  let totalOccupied = 0;
  let totalSlots = 0;
  let totalValue = 0;
  let priceWeightSum = 0;

  for (const [whseKey, whse] of Object.entries(WAREHOUSES)) {
    if (!activeWarehouses.has(whseKey)) continue;
    totalSlots += whse.cols * whse.rows.length;
  }

  for (const [loc, block] of Object.entries(data)) {
    const whseKey = loc.split('-')[0];
    if (!activeWarehouses.has(whseKey)) continue;
    totalOccupied++;
    totalBalance += block.balance;
    if (block.php !== null && block.balance > 0) {
      totalValue += block.php * block.balance;
      priceWeightSum += block.balance;
    }
  }

  return {
    totalBalance,
    totalOccupied,
    totalSlots,
    utilization: totalSlots > 0 ? ((totalOccupied / totalSlots) * 100).toFixed(1) : '0.0',
    totalValue,
    wtdAvgPhpKg: priceWeightSum > 0 ? totalValue / priceWeightSum : null,
  };
}

function getUtilizationColor(pct: number): string {
  if (pct > 75) return 'text-red-400';
  if (pct > 50) return 'text-amber-400';
  return 'text-emerald-400';
}

function getUtilizationGradient(pct: number): string {
  if (pct > 75) return 'linear-gradient(90deg, #ef4444, #f87171)';
  if (pct > 50) return 'linear-gradient(90deg, #d97706, #f59e0b)';
  return 'linear-gradient(90deg, #16a34a, #22c55e)';
}

// ─── Spotlight Helpers ──────────────────────────────────────────────────────

function computeSpotlight(
  statusFilter: StatusFilter,
  cellStatus: CellStatus,
  blockData?: BlockData,
  labHighlights?: Record<LabMetric, LabHighlightSpec>,
): SpotlightMatch {
  if (statusFilter === 'ALL') return 'none';

  // Lab-based spotlights
  if (statusFilter === 'WET' && blockData && labHighlights) {
    const spec = labHighlights.mc;
    if (spec.enabled && blockData.mc > spec.limit) return 'match';
    return 'dimmed';
  }
  if (statusFilter === 'ASHY' && blockData && labHighlights) {
    const spec = labHighlights.ash;
    if (spec.enabled && blockData.ash > spec.limit) return 'match';
    return 'dimmed';
  }

  // Lab filters on empty cells — always dimmed
  if ((statusFilter === 'WET' || statusFilter === 'ASHY') && !blockData) {
    return 'dimmed';
  }

  // Status-based (existing)
  if (statusFilter === cellStatus) return 'match';
  return 'dimmed';
}

function getSpotlightClass(match: SpotlightMatch, statusFilter: StatusFilter): string {
  if (match === 'none') return '';
  if (match === 'dimmed') return 'spotlight-dimmed';
  // match === 'match'
  switch (statusFilter) {
    case 'STORED': return 'spotlight-stored';
    case 'IN-USE': return 'spotlight-in-use';
    case 'SUNDRYING': return 'spotlight-sundrying';
    case 'SUNDRIED': return 'spotlight-sundried';
    case 'EMPTY': return 'spotlight-empty';
    case 'WET': return 'spotlight-wet';
    case 'ASHY': return 'spotlight-ashy';
    default: return '';
  }
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface BlockingGridProps {
  data: Record<string, BlockData>;
  canViewPrices: boolean;
  /**
   * Controlled selection (the standalone `/inventory/blocking` route drives this from the
   * `?block=` URL param so the open block is deep-linkable / refresh-safe). When BOTH
   * `selectedLocKey` and `onSelectBlock` are supplied the grid is fully controlled;
   * otherwise it falls back to internal selection state (legacy in-shell usage).
   */
  selectedLocKey?: string | null;
  /** Toggle handler for a cell click — receives the block_loc that was clicked. */
  onSelectBlock?: (locKey: string) => void;
  /**
   * Passed straight through to the detail panel's "Edit All". On a standalone route the
   * route wires this to a `router.push('/inventory?tab=…')`; omitted in-shell so the
   * panel falls back to its `window` CustomEvent → InventoryTabProvider tab switch.
   */
  onNavigateToBatch?: (target: BlockingDetailNavTarget) => void;
}

export function BlockingGrid({
  data,
  canViewPrices: serverCanViewPrices,
  selectedLocKey: controlledLocKey,
  onSelectBlock,
  onNavigateToBatch,
}: BlockingGridProps) {
  const isControlled = controlledLocKey !== undefined && onSelectBlock !== undefined;
  const [internalLocKey, setInternalLocKey] = useState<string | null>(null);
  const selectedLocKey = isControlled ? controlledLocKey! : internalLocKey;
  const [activeWarehouses, setActiveWarehouses] = useState<Set<string>>(() => makeDefaultActive());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const { settings } = useTableSettings();
  const labHighlights = settings.labHighlights;

  // ── Price-visibility toggle (hide-only, layered on the server gate) ──
  // Lazy init from localStorage; default ON. We DON'T read it in the useState initializer
  // to avoid an SSR/CSR hydration mismatch — start at the default (true) and hydrate the
  // saved value after mount. (For a server-gated no-price user the toggle is hidden and
  // this flag is irrelevant — the server already nulled the ₱ payload.)
  const [showPrices, setShowPrices] = useState(true);
  useEffect(() => {
    setShowPrices(readShowPricesPref());
  }, []);

  const handleToggleShowPrices = useCallback(() => {
    setShowPrices((prev) => {
      const next = !prev;
      writeShowPricesPref(next);
      return next;
    });
  }, []);

  // EFFECTIVE price visibility = server gate AND the client display preference. This is
  // the ONLY value passed downstream for price render/export decisions — the toggle can
  // hide but never reveal, because the server flag is ANDed first.
  const canViewPrices = serverCanViewPrices && showPrices;

  // ── Blend Proposal mode ──
  // OFF by default. When ON, cell clicks multi-SELECT occupied blocks (the detail panel
  // does not open); a floating bar offers Build Proposal / Clear; Build calls the
  // backend action and shows the result in a Sheet. Toggling the mode off (or closing
  // the sheet) clears the selection.
  const [blendMode, setBlendMode] = useState(false);
  const [blendSelection, setBlendSelection] = useState<Set<string>>(() => new Set());
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposal, setProposal] = useState<BlendProposal | null>(null);

  const clearBlend = useCallback(() => setBlendSelection(new Set()), []);

  const handleToggleBlendMode = useCallback(() => {
    setBlendMode((prev) => {
      const next = !prev;
      // Leaving blend mode clears any in-progress selection.
      if (!next) setBlendSelection(new Set());
      return next;
    });
  }, []);

  const handleBuildProposal = useCallback(async () => {
    const locs = Array.from(blendSelection);
    if (locs.length === 0) return;
    setProposalOpen(true);
    setProposalLoading(true);
    setProposal(null);
    try {
      const result = await buildBlendProposal(locs);
      setProposal(result);
    } catch (err) {
      setProposalOpen(false);
      errorToast('Failed to build blend proposal', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProposalLoading(false);
    }
  }, [blendSelection]);

  const handleProposalOpenChange = useCallback((open: boolean) => {
    setProposalOpen(open);
    // Closing the proposal clears the selection (per spec).
    if (!open) setBlendSelection(new Set());
  }, []);

  // Remove one block from inside the open proposal modal. The grid owns the
  // source-of-truth `blendSelection` Set, so updating it here keeps the cell
  // rings/checkmarks in sync with the modal — they can never diverge. We then
  // re-run the blend calc for the reduced set so the modal's numbers update live.
  // Removing the LAST block closes the modal and clears the selection (nothing to
  // propose).
  const handleRemoveBlendBlock = useCallback(
    async (blockLoc: string) => {
      const remaining = Array.from(blendSelection).filter((l) => l !== blockLoc);

      // Keep the grid Set in sync immediately (rings update on close/reopen).
      setBlendSelection(new Set(remaining));

      if (remaining.length === 0) {
        // Nothing left to propose — close gracefully (selection already cleared).
        setProposalOpen(false);
        setProposal(null);
        return;
      }

      // Re-run the blend for the reduced set; the modal shows a loading state.
      setProposalLoading(true);
      try {
        const result = await buildBlendProposal(remaining);
        setProposal(result);
      } catch (err) {
        errorToast('Failed to update blend proposal', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setProposalLoading(false);
      }
    },
    [blendSelection],
  );

  const global = useMemo(
    () => getFilteredGlobalStats(activeWarehouses, data),
    [activeWarehouses, data],
  );

  // Render in WAREHOUSES declaration order (A, B, C, D, PCA, PCB)
  const visibleWarehouses = ALL_WAREHOUSE_KEYS.filter((w) => activeWarehouses.has(w));

  const handleCellClick = (locKey: string) => {
    // Blend mode hijacks the click: multi-select occupied blocks instead of opening
    // the detail panel. Only occupied cells (present in `data`) are selectable.
    if (blendMode) {
      if (!data[locKey]) return;
      setBlendSelection((prev) => {
        const next = new Set(prev);
        if (next.has(locKey)) next.delete(locKey);
        else next.add(locKey);
        return next;
      });
      return;
    }
    if (isControlled) {
      // Controlled: delegate the toggle decision to the parent (URL writer).
      onSelectBlock!(locKey);
      return;
    }
    setInternalLocKey((prev) => (prev === locKey ? null : locKey));
  };

  const handlePanelClose = () => {
    if (isControlled) {
      // Close always clears. The panel only emits close while something is open, so
      // toggling the currently-open key off (parent's toggle handler) clears the URL.
      if (selectedLocKey) onSelectBlock!(selectedLocKey);
      return;
    }
    setInternalLocKey(null);
  };

  // "ALL" mode = exactly the standard 4 (A/B/C/D). PCA/PCB are opt-in extras.
  const isAllMode =
    activeWarehouses.size === STANDARD_WAREHOUSES.length &&
    STANDARD_WAREHOUSES.every((w) => activeWarehouses.has(w));

  const handleWarehouseToggle = (whse: string) => {
    setActiveWarehouses((prev) => {
      // If we're in the "ALL" mode (standard 4 exactly), clicking a chip switches
      // to just that warehouse — this preserves the existing single-focus UX.
      const isAll =
        prev.size === STANDARD_WAREHOUSES.length &&
        STANDARD_WAREHOUSES.every((w) => prev.has(w));
      if (isAll) {
        return new Set([whse]);
      }
      const next = new Set(prev);
      if (next.has(whse)) {
        next.delete(whse);
        // If none remain, revert to default ALL (standard 4)
        if (next.size === 0) {
          return makeDefaultActive();
        }
      } else {
        next.add(whse);
      }
      return next;
    });
  };

  const handleSelectAllWarehouses = () => {
    setActiveWarehouses(makeDefaultActive());
  };

  const handleToggleStatus = (filter: StatusFilter) => {
    setStatusFilter((prev) => (prev === filter ? 'ALL' : filter));
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {/* ── Global Summary Header (sticky) ──
          Desktop (sm+): the original wrapping, space-between cluster row.
          Below sm: a single horizontal-scroll strip (no wrap) so the many filter/
          stat clusters stay on one compact, swipeable line instead of ballooning
          to a dozen rows; the orphan-prone top-level dividers are hidden there. */}
      <div className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm border border-border rounded-lg px-4 py-2.5 flex items-center justify-between flex-wrap gap-3 max-sm:flex-nowrap max-sm:justify-start max-sm:overflow-x-auto">
        {/* Warehouse filter chips */}
        <div className="flex items-center gap-1.5 max-sm:shrink-0">
          <button
            onClick={handleSelectAllWarehouses}
            className={cn(
              'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 cursor-pointer',
              isAllMode
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent',
            )}
          >
            ALL
          </button>
          {STANDARD_WAREHOUSES.map((w) => (
            <button
              key={w}
              onClick={() => handleWarehouseToggle(w)}
              className={cn(
                'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                activeWarehouses.has(w) && !isAllMode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              WHSE {w}
            </button>
          ))}
          {/* PCA/PCB are opt-in — they do not count against the 220-slot baseline */}
          <div className="h-4 w-px bg-border mx-0.5" />
          {(['PCA', 'PCB'] as const).map((w) => (
            <button
              key={w}
              onClick={() => handleWarehouseToggle(w)}
              className={cn(
                'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                activeWarehouses.has(w)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
              title="Prepared charcoal sundrying — opt-in, not counted in the 220-slot baseline"
            >
              {w}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border max-sm:hidden" />

        {/* Status filter toggles */}
        <div className="flex items-center gap-1.5 text-xs max-sm:shrink-0">
          <button
            onClick={() => handleToggleStatus('STORED')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'STORED'
                ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                : 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-blue-500 inline-block" />
            Stored
          </button>
          <button
            onClick={() => handleToggleStatus('IN-USE')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'IN-USE'
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-amber-500 inline-block" />
            In-Use
          </button>
          <button
            onClick={() => handleToggleStatus('SUNDRYING')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'SUNDRYING'
                ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                : 'bg-orange-500/10 text-orange-400 border-orange-500/20 hover:bg-orange-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-orange-500 inline-block" />
            Sundrying
          </button>
          <button
            onClick={() => handleToggleStatus('SUNDRIED')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'SUNDRIED'
                ? 'bg-violet-500/20 text-violet-400 border-violet-500/40'
                : 'bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-violet-500 inline-block" />
            Sundried
          </button>
          <button
            onClick={() => handleToggleStatus('EMPTY')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'EMPTY'
                ? 'bg-zinc-400/20 text-zinc-400 border-zinc-400/40'
                : 'bg-zinc-400/10 text-zinc-400 border-zinc-400/20 hover:bg-zinc-400/15',
            )}
          >
            <span className="w-2.5 h-2.5 rounded-sm bg-muted border border-border inline-block" />
            Empty
          </button>

          {/* Lab quality filter divider */}
          <div className="h-5 w-px bg-border" />

          {/* Lab quality filters */}
          <button
            onClick={() => handleToggleStatus('WET')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'WET'
                ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                : 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-blue-500 inline-block" />
            Wet
          </button>
          <button
            onClick={() => handleToggleStatus('ASHY')}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer text-[10px]',
              statusFilter === 'ASHY'
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/15',
            )}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-amber-500 inline-block" />
            Ashy
          </button>
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border max-sm:hidden" />

        {/* Global stats */}
        <div className="flex items-center gap-4 text-xs max-sm:shrink-0">
          <div className="text-right">
            <div className="text-muted-foreground font-medium">Total Balance</div>
            <div className="text-foreground font-semibold font-mono">
              {(global.totalBalance / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t
            </div>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="text-right">
            <div className="text-muted-foreground font-medium">Occupied</div>
            <div className="text-foreground font-semibold font-mono">
              {global.totalOccupied} / {global.totalSlots}
            </div>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="text-right">
            <div className="text-muted-foreground font-medium">Utilization</div>
            <div className={cn('font-semibold font-mono', getUtilizationColor(parseFloat(global.utilization)))}>
              {global.utilization}%
            </div>
          </div>
          {canViewPrices && global.totalValue > 0 && (
            <>
              <div className="h-8 w-px bg-border" />
              <div className="text-right">
                <div className="text-muted-foreground font-medium">Total Value</div>
                <div className="text-foreground font-semibold font-mono flex justify-between gap-1">
                  <span className="text-muted-foreground font-normal">&#8369;</span>
                  <span>{Math.round(global.totalValue).toLocaleString()}</span>
                </div>
              </div>
              {global.wtdAvgPhpKg !== null && (
                <>
                  <div className="h-8 w-px bg-border" />
                  <div className="text-right">
                    <div className="text-muted-foreground font-medium">Wtd Avg PHP/KG</div>
                    <div className="text-foreground font-semibold font-mono flex justify-between gap-1">
                      <span className="text-muted-foreground font-normal">&#8369;</span>
                      <span>{global.wtdAvgPhpKg.toFixed(2)}</span>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border max-sm:hidden" />

        {/* ── Prices visibility toggle (presenter/privacy) ── */}
        {/* Shown ONLY when the server allows prices. For a server-gated no-price user the
            toggle is irrelevant (the payload carries no ₱) so we hide it entirely. The
            toggle can only HIDE — `canViewPrices` above is `serverCanViewPrices && showPrices`. */}
        {serverCanViewPrices && (
          <button
            onClick={handleToggleShowPrices}
            aria-pressed={showPrices}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold max-sm:shrink-0',
              'border transition-all duration-150 cursor-pointer',
              showPrices
                ? 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground'
                : 'bg-primary text-primary-foreground border-primary',
            )}
            title={showPrices ? 'Hide all prices (presenter mode)' : 'Show prices'}
          >
            {showPrices ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>Prices</span>
            <span
              className={cn(
                'ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold',
                showPrices ? 'bg-border text-muted-foreground' : 'bg-primary-foreground/20 text-primary-foreground',
              )}
            >
              {showPrices ? 'ON' : 'OFF'}
            </span>
          </button>
        )}

        {/* ── Blend Proposal toggle (top-right) ── */}
        <button
          onClick={handleToggleBlendMode}
          aria-pressed={blendMode}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold max-sm:shrink-0',
            'border transition-all duration-150 cursor-pointer',
            blendMode
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground',
          )}
          title={blendMode ? 'Exit blend selection mode' : 'Select blocks to build a blend proposal'}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Blend Proposal</span>
          <span
            className={cn(
              'ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold',
              blendMode ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-border text-muted-foreground',
            )}
          >
            {blendMode ? 'ON' : 'OFF'}
          </span>
        </button>
      </div>

      {/* ── Warehouse Grids ── */}
      {visibleWarehouses.map((whseKey) => (
        <WarehouseSection
          key={whseKey}
          whseKey={whseKey}
          selectedLocKey={selectedLocKey}
          onCellClick={handleCellClick}
          statusFilter={statusFilter}
          onToggleStatus={handleToggleStatus}
          data={data}
          canViewPrices={canViewPrices}
          labHighlights={labHighlights}
          blendMode={blendMode}
          blendSelection={blendSelection}
        />
      ))}

      {/* ── Detail Panel ── */}
      <BlockingDetailPanel
        locKey={selectedLocKey}
        onClose={handlePanelClose}
        data={data}
        canViewPrices={canViewPrices}
        onNavigateToBatch={onNavigateToBatch}
      />

      {/* ── Blend Proposal floating action bar ── */}
      {blendMode && blendSelection.size > 0 && (
        <div
          data-blend-action-bar
          className="animate-fade-up fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3
                     rounded-full bg-background/95 px-4 py-2 text-xs font-medium shadow-lg border
                     backdrop-blur supports-backdrop-filter:bg-background/60"
        >
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Check className="w-3.5 h-3.5 text-primary" />
            <span className="font-mono font-semibold text-foreground">{blendSelection.size}</span>
            block{blendSelection.size === 1 ? '' : 's'} selected
          </span>
          <span className="text-border">|</span>
          <button
            onClick={handleBuildProposal}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-primary-foreground
                       font-semibold hover:bg-primary/90 transition-all duration-150 cursor-pointer"
          >
            <Calculator className="w-3.5 h-3.5" />
            Build Proposal
          </button>
          <button
            onClick={clearBlend}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-muted-foreground
                       hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        </div>
      )}

      {/* ── Blend Proposal result modal ── */}
      {/* `showPrices` is the client display preference; the dialog ANDs it with the
          server `proposal.can_view_prices` so the toggle can hide but never reveal. */}
      <BlendProposalDialog
        open={proposalOpen}
        onOpenChange={handleProposalOpenChange}
        proposal={proposal}
        loading={proposalLoading}
        onRemoveBlock={handleRemoveBlendBlock}
        showPrices={showPrices}
      />
    </div>
  );
}

// ─── Warehouse Section ──────────────────────────────────────────────────────

interface WarehouseSectionProps {
  whseKey: string;
  selectedLocKey: string | null;
  onCellClick: (locKey: string) => void;
  statusFilter: StatusFilter;
  onToggleStatus: (filter: StatusFilter) => void;
  data: Record<string, BlockData>;
  canViewPrices: boolean;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
  blendMode: boolean;
  blendSelection: Set<string>;
}

function WarehouseSection({ whseKey, selectedLocKey, onCellClick, statusFilter, onToggleStatus, data, canViewPrices, labHighlights, blendMode, blendSelection }: WarehouseSectionProps) {
  const whse = WAREHOUSES[whseKey];
  const stats = getWarehouseStats(whseKey, data);
  const utilPct = parseFloat(stats.utilization);
  const emptyCount = stats.totalSlots - stats.occupied;
  const colEnd = whse.colStart + whse.cols - 1;
  // Show contiguous column range (e.g. "1-20" or "15-17") for non-trivial layouts
  const colsLabel = whse.cols === 1 ? `${whse.colStart}` : `${whse.colStart}-${colEnd}`;
  // Prepared-charcoal sections get a friendlier subtitle
  const isPrepared = whseKey === 'PCA' || whseKey === 'PCB';
  const headerLabel = isPrepared ? `${whseKey} · Prepared Charcoal` : `Warehouse ${whseKey}`;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* ── Warehouse Header ── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-border flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {/* Warehouse badge */}
          <div
            className={cn(
              'rounded-md flex items-center justify-center text-xs font-bold',
              isPrepared ? 'h-7 px-1.5' : 'w-7 h-7',
              stats.occupied > 0
                ? 'bg-linear-to-br from-muted to-muted-foreground/20 text-muted-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {whseKey}
          </div>
          <div>
            <div className="text-xs font-semibold text-foreground">{headerLabel}</div>
            <div className="text-[9px] text-muted-foreground">
              cols {colsLabel} &times; {whse.rows.length} rows &middot; {stats.totalSlots} slots
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Stat card cluster — all 7 weighted averages */}
          <div className="flex items-center gap-2.5 text-[10px]">
            <StatItem label="Occupied" value={<>{stats.occupied}<span className="text-muted-foreground font-normal">/{stats.totalSlots}</span></>} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="Balance" value={formatKg(stats.totalBalance)} />
            {canViewPrices && stats.weightedPrice !== null && (
              <>
                <div className="h-4 w-px bg-border" />
                <StatItem
                  label="PHP/KG"
                  value={
                    <span className="flex justify-between gap-1">
                      <span className="text-muted-foreground font-normal">&#8369;</span>
                      <span>{stats.weightedPrice.toFixed(2)}</span>
                    </span>
                  }
                />
              </>
            )}
            <div className="h-4 w-px bg-border" />
            <StatItem label="BD ASTM" value={stats.avgBdAstm.toFixed(3)} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="BD JIS" value={stats.avgBdJis.toFixed(3)} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="MC" value={`${stats.avgMc.toFixed(1)}%`} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="ASH" value={`${stats.avgAsh.toFixed(1)}%`} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="GRIT" value={`${stats.avgGrit.toFixed(2)}%`} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="VM" value={`${stats.avgVm.toFixed(1)}%`} />
            <div className="h-4 w-px bg-border" />
            <StatItem label="FC" value={`${stats.avgFc.toFixed(1)}%`} />
          </div>

          {/* Status badges — clickable toggles */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <button
              onClick={() => onToggleStatus('STORED')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer',
                statusFilter === 'STORED'
                  ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                  : 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/15',
              )}
            >
              <span className="w-[5px] h-[5px] rounded-full bg-blue-500 inline-block" />
              Stored {stats.stored}
            </button>
            <button
              onClick={() => onToggleStatus('IN-USE')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer',
                statusFilter === 'IN-USE'
                  ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/15',
              )}
            >
              <span className="w-[5px] h-[5px] rounded-full bg-amber-500 inline-block" />
              In-Use {stats.inUse}
            </button>
            <button
              onClick={() => onToggleStatus('SUNDRYING')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer',
                statusFilter === 'SUNDRYING'
                  ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                  : 'bg-orange-500/10 text-orange-400 border-orange-500/20 hover:bg-orange-500/15',
              )}
            >
              <span className="w-[5px] h-[5px] rounded-full bg-orange-500 inline-block" />
              Sundrying
            </button>
            <button
              onClick={() => onToggleStatus('SUNDRIED')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer',
                statusFilter === 'SUNDRIED'
                  ? 'bg-violet-500/20 text-violet-400 border-violet-500/40'
                  : 'bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/15',
              )}
            >
              <span className="w-[5px] h-[5px] rounded-full bg-violet-500 inline-block" />
              Sundried
            </button>
            <button
              onClick={() => onToggleStatus('EMPTY')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-all duration-150 cursor-pointer',
                statusFilter === 'EMPTY'
                  ? 'bg-zinc-400/20 text-zinc-400 border-zinc-400/40'
                  : 'bg-zinc-400/10 text-zinc-400 border-zinc-400/20 hover:bg-zinc-400/15',
              )}
            >
              <span className="w-[5px] h-[5px] rounded-full bg-zinc-400 inline-block" />
              Empty {emptyCount}
            </button>
          </div>
        </div>
      </div>

      {/* ── Grid ── */}
      <div className="p-2 overflow-x-auto">
        <div
          className={cn('grid blocking-grid-cols', isPrepared && 'max-w-[280px]')}
          style={
            {
              '--blocking-cols': whse.cols,
              gap: '2px',
            } as CSSProperties
          }
        >
          {/* Column headers: corner (frozen-left on mobile so it pins with the row labels) */}
          <div className="blocking-rowlabel-frozen flex items-center justify-center" />
          {Array.from({ length: whse.cols }, (_, i) => (
            <div
              key={i}
              className="text-center text-muted-foreground font-medium uppercase tracking-wider"
              style={{ fontSize: '9px', letterSpacing: '0.05em' }}
            >
              {whse.colStart + i}
            </div>
          ))}

          {/* Data rows */}
          {whse.rows.map((row) => (
            <WarehouseRow
              key={row}
              whseKey={whseKey}
              row={row}
              cols={whse.cols}
              colStart={whse.colStart}
              selectedLocKey={selectedLocKey}
              onCellClick={onCellClick}
              statusFilter={statusFilter}
              data={data}
              canViewPrices={canViewPrices}
              labHighlights={labHighlights}
              blendMode={blendMode}
              blendSelection={blendSelection}
            />
          ))}
        </div>
      </div>

      {/* ── Utilization Bar ── */}
      <div className="px-3 py-1.5 flex items-center gap-3 border-t border-border">
        <span className="text-[10px] font-medium text-muted-foreground">Utilization</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-border">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${stats.utilization}%`,
              background: getUtilizationGradient(utilPct),
            }}
          />
        </div>
        <span className={cn('text-[10px] font-mono font-semibold', getUtilizationColor(utilPct))}>
          {stats.utilization}%
        </span>
      </div>
    </div>
  );
}

// ─── Warehouse Row (row label + cells) ──────────────────────────────────────

interface WarehouseRowProps {
  whseKey: string;
  row: string;
  cols: number;
  colStart: number;
  selectedLocKey: string | null;
  onCellClick: (locKey: string) => void;
  statusFilter: StatusFilter;
  data: Record<string, BlockData>;
  canViewPrices: boolean;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
  blendMode: boolean;
  blendSelection: Set<string>;
}

function WarehouseRow({ whseKey, row, cols, colStart, selectedLocKey, onCellClick, statusFilter, data, canViewPrices, labHighlights, blendMode, blendSelection }: WarehouseRowProps) {
  return (
    <>
      {/* Row label — frozen-left on mobile so the row letter stays pinned while
          the fixed-width cell columns scroll horizontally (opaque, never glass). */}
      <div
        className="blocking-rowlabel-frozen flex items-center justify-center text-muted-foreground font-semibold uppercase"
        style={{ fontSize: '10px', letterSpacing: '0.05em', width: '20px' }}
      >
        {row}
      </div>

      {/* Cells */}
      {Array.from({ length: cols }, (_, i) => {
        const col = colStart + i;
        const locKey = `${whseKey}-${col}${row}`;
        const blockData = data[locKey];

        if (blockData) {
          // view_blocking_grid only emits STORED/IN-USE/SUNDRYING/SUNDRIED batches, so the
          // widened BlockData.status (which also allows historical CLOSED/FEED for the RC
          // Movement panel) narrows safely to CellStatus here.
          const cellStatus = blockData.status as CellStatus;
          const spotlight = computeSpotlight(statusFilter, cellStatus, blockData, labHighlights);
          const spotlightClass = getSpotlightClass(spotlight, statusFilter);

          return (
            <OccupiedCell
              key={locKey}
              locKey={locKey}
              data={blockData}
              isSelected={selectedLocKey === locKey}
              onClick={() => onCellClick(locKey)}
              spotlightClass={spotlightClass}
              canViewPrices={canViewPrices}
              labHighlights={labHighlights}
              blendMode={blendMode}
              blendSelected={blendSelection.has(locKey)}
            />
          );
        }

        const spotlight = computeSpotlight(statusFilter, 'EMPTY', undefined, labHighlights);
        const spotlightClass = getSpotlightClass(spotlight, statusFilter);

        return (
          <EmptyCell
            key={locKey}
            locKey={locKey}
            spotlightClass={spotlightClass}
          />
        );
      })}
    </>
  );
}

// ─── Occupied Cell ──────────────────────────────────────────────────────────

interface OccupiedCellProps {
  locKey: string;
  data: BlockData;
  isSelected: boolean;
  onClick: () => void;
  spotlightClass: string;
  canViewPrices: boolean;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
  /** True while Blend Proposal mode is active — drives the multi-select affordance. */
  blendMode: boolean;
  /** True when this cell is in the blend selection set. */
  blendSelected: boolean;
}

function OccupiedCell({ locKey, data, isSelected, onClick, spotlightClass, canViewPrices, labHighlights, blendMode, blendSelected }: OccupiedCellProps) {
  const balanceTextClass = getBalanceTextClass(data.balance, data.total_in);
  const balancePct = data.total_in > 0 ? (data.balance / data.total_in) * 100 : 0;
  const isCritical = balancePct < 10;

  // Split batch: "FEB-26-BLK3" -> "FEB 26" + "BLK3"
  const parts = data.batch_code.split('-');
  const batchLine1 = `${parts[0]} ${parts[1]}`;
  const batchLine2 = parts.slice(2).join('-');

  return (
    <div
      className={cn(
        'blocking-cell blocking-cell-occupied relative',
        // In blend mode the panel-selection ring is suppressed; blend-selection drives
        // the highlight instead. Outside blend mode, the normal selected ring applies.
        !blendMode && isSelected && 'selected',
        blendSelected && 'ring-2 ring-primary ring-offset-1 ring-offset-card',
        spotlightClass,
      )}
      onClick={onClick}
      role={blendMode ? 'checkbox' : undefined}
      aria-checked={blendMode ? blendSelected : undefined}
    >
      {/* Blend-selection checkmark badge */}
      {blendSelected && (
        <span className="absolute top-0.5 right-0.5 z-10 flex items-center justify-center w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground shadow">
          <Check className="w-2.5 h-2.5" strokeWidth={3} />
        </span>
      )}
      <div className="h-full flex flex-col" style={{ gap: '2px', padding: '4px 5px' }}>
        {/* Loc key — badge colored by status */}
        <div
          className={cn(
            'flex items-center justify-center rounded-[3px] py-[1px]',
            data.status === 'STORED' && 'bg-blue-500/70',
            data.status === 'IN-USE' && 'bg-amber-500/70',
            data.status === 'SUNDRYING' && 'bg-orange-500/70',
            data.status === 'SUNDRIED' && 'bg-violet-500/70',
          )}
          style={{ margin: '0 -1px' }}
        >
          <span
            className="font-mono font-semibold leading-none text-white"
            style={{ fontSize: '10px' }}
          >
            {locKey}
          </span>
        </div>

        {/* Batch name (2 lines) */}
        <div
          className="flex flex-col items-center bg-black/5 dark:bg-white/10 rounded-[3px] py-[1px]"
          style={{ margin: '0 -1px' }}
        >
          <span className="font-bold text-zinc-900 dark:text-white leading-[1.15] whitespace-nowrap" style={{ fontSize: '10px' }}>
            {batchLine1}
          </span>
          <span className="font-bold text-zinc-900 dark:text-white leading-[1.15] whitespace-nowrap" style={{ fontSize: '10px' }}>
            {batchLine2}
          </span>
        </div>

        {/* Balance — color coded by percentage */}
        <div
          className={cn(
            'blocking-balance font-bold font-mono leading-none flex justify-center items-baseline',
            balanceTextClass,
            isCritical && 'balance-critical',
          )}
          style={{ fontSize: '10px', marginTop: '1px' }}
        >
          <span>{formatKg(data.balance)}</span>
        </div>

        {/* Bottom metrics */}
        <div className="mt-auto flex flex-col" style={{ paddingTop: '2px', gap: '1px' }}>
          {canViewPrices && (
            <div
              className="font-mono font-bold leading-none text-zinc-800 dark:text-white/95 flex justify-between"
              style={{ fontSize: '10px' }}
            >
              <span>&#8369;</span>
              <span>{data.php?.toFixed(2) ?? '\u2014'}</span>
            </div>
          )}
          <div
            className={cn(
              'font-mono font-bold leading-none flex justify-between',
              getLabHighlightText('ash', data.ash, labHighlights) || 'text-zinc-800 dark:text-white/95',
            )}
            style={{ fontSize: '10px' }}
          >
            <span>ASH</span>
            <span>{data.ash.toFixed(2)}</span>
          </div>
          <div
            className={cn(
              'font-mono font-bold leading-none flex justify-between',
              getLabHighlightText('bd_astm', data.bd_astm, labHighlights) || 'text-zinc-800 dark:text-white/95',
            )}
            style={{ fontSize: '10px' }}
          >
            <span>BD</span>
            <span>{data.bd_astm.toFixed(3)}</span>
          </div>
          <div
            className={cn(
              'font-mono font-bold leading-none flex justify-between',
              getLabHighlightText('mc', data.mc, labHighlights) || 'text-zinc-800 dark:text-white/95',
            )}
            style={{ fontSize: '10px' }}
          >
            <span>MC</span>
            <span>{data.mc.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Empty Cell ─────────────────────────────────────────────────────────────

interface EmptyCellProps {
  locKey: string;
  spotlightClass: string;
}

function EmptyCell({ locKey, spotlightClass }: EmptyCellProps) {
  return (
    <div
      className={cn(
        'bg-zinc-300/70 dark:bg-zinc-800/80 border border-border/50 rounded flex items-center justify-center',
        spotlightClass,
      )}
    >
      <span className="font-mono font-semibold text-muted-foreground" style={{ fontSize: '9px' }}>
        {locKey}
      </span>
    </div>
  );
}

// ─── Stat Item ──────────────────────────────────────────────────────────────

function StatItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-center">
      <div className="text-[9px] font-medium text-muted-foreground">{label}</div>
      <div className="text-xs font-semibold font-mono text-foreground">{value}</div>
    </div>
  );
}
