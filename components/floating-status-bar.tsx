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
    <div data-floating-status-bar className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium shadow-sm border backdrop-blur supports-backdrop-filter:bg-background/60">
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

      {/* Next.js logomark */}
      <span className="text-border">|</span>
      <svg
        aria-label="Next.js logomark"
        height="12"
        role="img"
        viewBox="0 0 180 180"
        className="text-foreground"
      >
        <mask
          height="180"
          id="mask0_408_134"
          maskUnits="userSpaceOnUse"
          width="180"
          x="0"
          y="0"
          style={{ maskType: 'alpha' }}
        >
          <circle cx="90" cy="90" fill="currentColor" r="90" />
        </mask>
        <g mask="url(#mask0_408_134)">
          <circle cx="90" cy="90" fill="currentColor" r="90" />
          <path
            d="M149.508 157.52L69.142 54H54V125.97H66.1136V69.3836L139.999 164.845C143.333 162.614 146.509 160.165 149.508 157.52Z"
            fill="url(#paint0_linear_408_134)"
          />
          <rect
            fill="url(#paint1_linear_408_134)"
            height="72"
            width="12"
            x="115"
            y="54"
          />
        </g>
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="paint0_linear_408_134"
            x1="109"
            x2="144.5"
            y1="116.5"
            y2="160.5"
          >
            <stop stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="paint1_linear_408_134"
            x1="121"
            x2="120.799"
            y1="54"
            y2="106.875"
          >
            <stop stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
