'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { WAREHOUSES } from './constants';
import type { BlockData } from './types';
import { BlockingDetailPanel } from './blocking-detail-panel';

// ─── Types ───────────────────────────────────────────────────────────────────

type StatusFilter = 'ALL' | 'STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED' | 'EMPTY';
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
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHeatClass(balance: number, totalIn: number): string {
  const pct = totalIn > 0 ? (balance / totalIn) * 100 : 0;
  if (pct >= 50) return 'heat-full';
  if (pct >= 20) return 'heat-healthy';
  if (pct >= 10) return 'heat-depleting';
  return 'heat-critical';
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

  for (const [whseKey, whse] of Object.entries(WAREHOUSES)) {
    if (!activeWarehouses.has(whseKey)) continue;
    totalSlots += whse.cols * whse.rows.length;
  }

  for (const [loc, block] of Object.entries(data)) {
    const whseKey = loc.split('-')[0];
    if (!activeWarehouses.has(whseKey)) continue;
    totalOccupied++;
    totalBalance += block.balance;
  }

  return {
    totalBalance,
    totalOccupied,
    totalSlots,
    utilization: totalSlots > 0 ? ((totalOccupied / totalSlots) * 100).toFixed(1) : '0.0',
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

function computeSpotlight(statusFilter: StatusFilter, cellStatus: CellStatus): SpotlightMatch {
  if (statusFilter === 'ALL') return 'none';
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
    default: return '';
  }
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface BlockingGridProps {
  data: Record<string, BlockData>;
  canViewPrices: boolean;
}

export function BlockingGrid({ data, canViewPrices }: BlockingGridProps) {
  const [selectedLocKey, setSelectedLocKey] = useState<string | null>(null);
  const [activeWarehouses, setActiveWarehouses] = useState<Set<string>>(new Set(['A', 'B', 'C', 'D']));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  const global = useMemo(
    () => getFilteredGlobalStats(activeWarehouses, data),
    [activeWarehouses, data],
  );

  const visibleWarehouses = (['A', 'B', 'C', 'D'] as const).filter((w) =>
    activeWarehouses.has(w),
  );

  const handleCellClick = (locKey: string) => {
    setSelectedLocKey((prev) => (prev === locKey ? null : locKey));
  };

  const handlePanelClose = () => {
    setSelectedLocKey(null);
  };

  const handleWarehouseToggle = (whse: string) => {
    setActiveWarehouses((prev) => {
      // If ALL mode, switch to just this warehouse
      if (prev.size === 4) {
        return new Set([whse]);
      }
      const next = new Set(prev);
      if (next.has(whse)) {
        next.delete(whse);
        // If none remain, revert to ALL
        if (next.size === 0) {
          return new Set(['A', 'B', 'C', 'D']);
        }
      } else {
        next.add(whse);
        // If all 4 now selected, revert to ALL mode
        if (next.size === 4) {
          return new Set(['A', 'B', 'C', 'D']);
        }
      }
      return next;
    });
  };

  const handleSelectAllWarehouses = () => {
    setActiveWarehouses(new Set(['A', 'B', 'C', 'D']));
  };

  const handleToggleStatus = (filter: StatusFilter) => {
    setStatusFilter((prev) => (prev === filter ? 'ALL' : filter));
  };

  const allSelected = activeWarehouses.size === 4;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {/* ── Global Summary Header (sticky) ── */}
      <div className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm border border-border rounded-lg px-4 py-2.5 flex items-center justify-between flex-wrap gap-3">
        {/* Warehouse filter chips */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSelectAllWarehouses}
            className={cn(
              'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 cursor-pointer',
              allSelected
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent',
            )}
          >
            ALL
          </button>
          {(['A', 'B', 'C', 'D'] as const).map((w) => (
            <button
              key={w}
              onClick={() => handleWarehouseToggle(w)}
              className={cn(
                'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                activeWarehouses.has(w) && !allSelected
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              WHSE {w}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border" />

        {/* Heatmap legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <LegendDot gradient="linear-gradient(135deg, #14532d, #16a34a)" label="> 50% Full" />
          <LegendDot gradient="linear-gradient(135deg, #166534, #22c55e)" label="20-50% OK" />
          <LegendDot gradient="linear-gradient(135deg, #92400e, #d97706)" label="10-20% Depleting" />
          <LegendDot gradient="linear-gradient(135deg, #991b1b, #dc2626)" label="< 10% Critical" />
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border" />

        {/* Status filter toggles */}
        <div className="flex items-center gap-1.5 text-xs">
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
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border" />

        {/* Global stats */}
        <div className="flex items-center gap-4 text-xs">
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
        </div>
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
        />
      ))}

      {/* ── Detail Panel ── */}
      <BlockingDetailPanel
        locKey={selectedLocKey}
        onClose={handlePanelClose}
        data={data}
        canViewPrices={canViewPrices}
      />
    </div>
  );
}

// ─── Legend Dot ──────────────────────────────────────────────────────────────

function LegendDot({ gradient, label }: { gradient: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-sm inline-block"
        style={{ background: gradient }}
      />
      <span>{label}</span>
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
}

function WarehouseSection({ whseKey, selectedLocKey, onCellClick, statusFilter, onToggleStatus, data, canViewPrices }: WarehouseSectionProps) {
  const whse = WAREHOUSES[whseKey];
  const stats = getWarehouseStats(whseKey, data);
  const utilPct = parseFloat(stats.utilization);
  const emptyCount = stats.totalSlots - stats.occupied;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* ── Warehouse Header ── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-border flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {/* Warehouse badge */}
          <div
            className={cn(
              'w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold',
              stats.occupied > 0
                ? 'bg-linear-to-br from-muted to-muted-foreground/20 text-muted-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {whseKey}
          </div>
          <div>
            <div className="text-xs font-semibold text-foreground">Warehouse {whseKey}</div>
            <div className="text-[9px] text-muted-foreground">
              {whse.cols} cols &times; {whse.rows.length} rows &middot; {stats.totalSlots} slots
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
          className="grid"
          style={{
            gridTemplateColumns: `20px repeat(${whse.cols}, minmax(0, 1fr))`,
            gap: '2px',
          }}
        >
          {/* Column headers: corner + 1..20 */}
          <div className="flex items-center justify-center" />
          {Array.from({ length: whse.cols }, (_, i) => (
            <div
              key={i}
              className="text-center text-muted-foreground font-medium uppercase tracking-wider"
              style={{ fontSize: '9px', letterSpacing: '0.05em' }}
            >
              {i + 1}
            </div>
          ))}

          {/* Data rows */}
          {whse.rows.map((row) => (
            <WarehouseRow
              key={row}
              whseKey={whseKey}
              row={row}
              cols={whse.cols}
              selectedLocKey={selectedLocKey}
              onCellClick={onCellClick}
              statusFilter={statusFilter}
              data={data}
              canViewPrices={canViewPrices}
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
  selectedLocKey: string | null;
  onCellClick: (locKey: string) => void;
  statusFilter: StatusFilter;
  data: Record<string, BlockData>;
  canViewPrices: boolean;
}

function WarehouseRow({ whseKey, row, cols, selectedLocKey, onCellClick, statusFilter, data, canViewPrices }: WarehouseRowProps) {
  return (
    <>
      {/* Row label */}
      <div
        className="flex items-center justify-center text-muted-foreground font-semibold uppercase"
        style={{ fontSize: '10px', letterSpacing: '0.05em', width: '20px' }}
      >
        {row}
      </div>

      {/* Cells */}
      {Array.from({ length: cols }, (_, i) => {
        const col = i + 1;
        const locKey = `${whseKey}-${col}${row}`;
        const blockData = data[locKey];

        if (blockData) {
          const cellStatus: CellStatus = blockData.status;
          const spotlight = computeSpotlight(statusFilter, cellStatus);
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
            />
          );
        }

        const spotlight = computeSpotlight(statusFilter, 'EMPTY');
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
}

function OccupiedCell({ locKey, data, isSelected, onClick, spotlightClass, canViewPrices }: OccupiedCellProps) {
  const heatClass = getHeatClass(data.balance, data.total_in);

  // Split batch: "FEB-26-BLK3" -> "FEB 26" + "BLK3"
  const parts = data.batch_code.split('-');
  const batchLine1 = `${parts[0]} ${parts[1]}`;
  const batchLine2 = parts.slice(2).join('-');

  return (
    <div
      className={cn('blocking-cell', heatClass, isSelected && 'selected', spotlightClass)}
      onClick={onClick}
    >
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
          className="flex flex-col items-center bg-white/10 rounded-[3px] py-[1px]"
          style={{ margin: '0 -1px' }}
        >
          <span className="font-bold text-white leading-[1.15] whitespace-nowrap" style={{ fontSize: '10px' }}>
            {batchLine1}
          </span>
          <span className="font-bold text-white leading-[1.15] whitespace-nowrap" style={{ fontSize: '10px' }}>
            {batchLine2}
          </span>
        </div>

        {/* Balance */}
        <div
          className="blocking-balance font-bold font-mono leading-none text-white flex justify-center items-baseline"
          style={{ fontSize: '10px', marginTop: '1px' }}
        >
          <span>{formatKg(data.balance)}</span>
        </div>

        {/* Bottom metrics */}
        <div className="mt-auto flex flex-col" style={{ paddingTop: '2px', gap: '1px' }}>
          {canViewPrices && (
            <div
              className="font-mono font-bold leading-none text-white/95 flex justify-between"
              style={{ fontSize: '10px' }}
            >
              <span>&#8369;</span>
              <span>{data.php?.toFixed(2) ?? '\u2014'}</span>
            </div>
          )}
          <div
            className="font-mono font-bold leading-none text-white/95 flex justify-between"
            style={{ fontSize: '10px' }}
          >
            <span>%</span>
            <span>{data.ash.toFixed(2)}</span>
          </div>
          <div
            className="font-mono font-bold leading-none text-white/95 flex justify-between"
            style={{ fontSize: '10px' }}
          >
            <span>%</span>
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
        'bg-muted border border-border/50 rounded flex items-center justify-center',
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
