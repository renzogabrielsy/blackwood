'use client';

import { useRef, useState, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AggregationType, CellAggregates } from '@/lib/hooks/use-cell-aggregation';

const CALC_TYPES: { value: AggregationType; label: string }[] = [
  { value: 'SUM', label: 'SUM' },
  { value: 'AVERAGE', label: 'AVERAGE' },
  { value: 'COUNT', label: 'COUNT' },
  { value: 'MIN', label: 'MIN' },
  { value: 'MAX', label: 'MAX' },
];

function getStatusColor(status: string): string {
  if (status === 'SUBSCRIBED') return 'bg-green-500';
  if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') return 'bg-amber-500';
  if (status === 'CLOSED') return 'bg-red-500';
  return 'bg-orange-500';
}

function getStatusText(status: string): string {
  if (status === 'SUBSCRIBED') return 'Realtime';
  if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') return 'Polling (Fallback)';
  if (status === 'CLOSED') return 'Disconnected';
  return 'Connecting...';
}

function formatCalcValue(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getCalcValue(type: AggregationType, agg: CellAggregates): number {
  switch (type) {
    case 'SUM': return agg.sum;
    case 'AVERAGE': return agg.average;
    case 'COUNT': return agg.count;
    case 'MIN': return agg.min;
    case 'MAX': return agg.max;
  }
}

export function FloatingStatusBar() {
  const { connectionStatus, cellSelectionCount, cellAggregates } = useStatusBar();

  // User can override the recommended type via dropdown; resets when recommendation changes
  const [userOverride, setUserOverride] = useState<AggregationType | null>(null);
  const prevRecommended = useRef<AggregationType | null>(null);

  const recommended = cellAggregates?.recommendedCalcType ?? 'SUM';

  // Reset override when recommendation changes (new column selection)
  if (recommended !== prevRecommended.current) {
    prevRecommended.current = recommended;
    if (userOverride !== null) {
      setUserOverride(null);
    }
  }

  const calcType = userOverride ?? recommended;

  const handleCalcTypeChange = (type: AggregationType) => {
    setUserOverride(type);
  };

  // Track previous selection state for grow animation
  const prevHadSelection = useRef(false);
  const hasSelection = cellSelectionCount > 1;
  const shouldAnimate = hasSelection && !prevHadSelection.current;

  useEffect(() => {
    prevHadSelection.current = hasSelection;
  });

  const hasNumericValues = cellAggregates && cellAggregates.numericCount > 0;

  return (
    <div data-floating-status-bar className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 flex items-center gap-2 rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium shadow-sm border backdrop-blur supports-backdrop-filter:bg-background/60">
      {/* Connection status */}
      <span
        className={`h-2 w-2 rounded-full ${getStatusColor(connectionStatus)} ${connectionStatus === 'CONNECTING' ? 'animate-pulse' : ''}`}
      />
      <span className="text-muted-foreground">{getStatusText(connectionStatus)}</span>

      {/* Cell selection section */}
      {hasSelection && (
        <div className={shouldAnimate ? 'animate-status-grow flex items-center gap-2' : 'flex items-center gap-2'}>
          {/* Calculation display with dropdown */}
          {hasNumericValues && cellAggregates && (
            <>
              <span className="text-border">|</span>
              <Popover>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground transition-colors">
                    <span>{calcType}</span>
                    <span className="text-foreground font-semibold">{formatCalcValue(getCalcValue(calcType, cellAggregates))}</span>
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-36 p-1" align="end" side="top" sideOffset={8}>
                  {CALC_TYPES.map(({ value, label }) => (
                    <button
                      key={value}
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1 text-xs hover:bg-muted transition-colors"
                      onClick={() => handleCalcTypeChange(value)}
                    >
                      <span className="font-mono">{label}</span>
                      {calcType === value && <Check className="h-3 w-3" />}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </>
          )}

          {/* Cell count */}
          <span className="text-border">|</span>
          <span className="font-mono text-muted-foreground">
            {cellSelectionCount} cells
          </span>
        </div>
      )}
    </div>
  );
}
