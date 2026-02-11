'use client';

import * as React from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getFieldLabel,
  isHiddenField,
  formatFieldValue,
  flattenLabResultsDiff,
} from '@/lib/field-labels';
import { getDeliveryHistory } from '../actions';
import type { AuditLogRow } from '@/types/rc-in';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';

// Fields displayed in the "current state" hero grid, matching Master Table order
// Date, Supplier, Batch, Block, Truck, Sacks, Weight, [Labs], Remarks, Cost
const HERO_FIELDS = [
  'transaction_date',
  'supplier',
  'batch_code',
  'block_loc',
  'truck_plate',
  'sacks',
  'weight_kg',
  // Lab results are handled separately in the layout map below or injected
  'remarks',
  'cost_basis',
];

const LAB_KEYS = ['mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc'];

function getUserInitials(profile: AuditLogRow['profiles']): string {
  if (!profile) return '?';
  if (profile.display_name) {
    return profile.display_name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return profile.email[0].toUpperCase();
}

function getUserName(entry: AuditLogRow): string {
  if (!entry.profiles) return 'System Import';
  return entry.profiles.display_name || entry.profiles.email;
}

function OperationBadge({ op }: { op: AuditLogRow['operation'] }) {
  const styles = {
    INSERT: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    UPDATE: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    DELETE: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={cn('text-[10px] font-mono font-bold px-1.5 py-0.5 rounded', styles[op])}>
      {op}
    </span>
  );
}

/** Renders diff rows for a single audit entry */
function DiffDisplay({ entry }: { entry: AuditLogRow }) {
  if (entry.operation === 'INSERT') {
    return <p className="text-xs text-muted-foreground italic">Record created</p>;
  }
  if (entry.operation === 'DELETE') {
    return <p className="text-xs text-muted-foreground italic">Record deleted</p>;
  }
  if (!entry.diff || Object.keys(entry.diff).length === 0) {
    return <p className="text-xs text-muted-foreground italic">No changes recorded</p>;
  }

  const rows: { label: string; oldVal: string; newVal: string }[] = [];

  for (const [key, change] of Object.entries(entry.diff)) {
    if (isHiddenField(key)) continue;

    if (key === 'lab_results') {
      const labDiffs = flattenLabResultsDiff(change.old, change.new);
      for (const ld of labDiffs) {
        rows.push({ label: ld.label, oldVal: ld.oldFormatted, newVal: ld.newFormatted });
      }
    } else {
      rows.push({
        label: getFieldLabel(key),
        oldVal: formatFieldValue(key, change.old),
        newVal: formatFieldValue(key, change.new),
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 text-xs">
          <span className="font-medium text-muted-foreground w-24 shrink-0">{r.label}</span>
          <span className="line-through text-red-500 dark:text-red-400 font-mono">{r.oldVal}</span>
          <span className="text-muted-foreground">→</span>
          <span className="text-green-600 dark:text-green-400 font-mono">{r.newVal}</span>
        </div>
      ))}
    </div>
  );
}

import { calculateWhse } from '@/lib/rc-utils';
// ... previous imports

// ... helper functions ...

export function DeliveryHistoryDialog({
  deliveryId,
  initialData,
  open,
  onOpenChange,
}: {
  deliveryId: string | null;
  initialData: Record<string, any> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col p-6">
        <DialogHeader className="shrink-0 pb-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Delivery Info
          </DialogTitle>
        </DialogHeader>

        {/* 
          We use a key here to force a complete remount of the content when the deliveryId changes.
          This ensures that the internal state (loading, history) is always fresh and starts in the 'loading' state,
          preventing any stale data from being visible and avoiding complex derived state logic.
          The Dialog shell itself remains mounted to prevent animation glitches.
        */}
        <DeliveryHistoryContent
          key={deliveryId || 'empty'}
          deliveryId={deliveryId}
          initialData={initialData}
        />
      </DialogContent>
    </Dialog>
  );
}

function DeliveryHistoryContent({
  deliveryId,
  initialData,
}: {
  deliveryId: string | null;
  initialData: Record<string, any> | null;
}) {
  const [loadingHistory, setLoadingHistory] = React.useState(true);
  const [history, setHistory] = React.useState<AuditLogRow[]>([]);

  React.useEffect(() => {
    if (!deliveryId) {
      setLoadingHistory(false);
      return;
    }

    let cancelled = false;

    // We are guaranteed to be fresh due to key={deliveryId}, so just fetch.
    getDeliveryHistory(deliveryId).then((res) => {
      if (cancelled) return;
      if (res.success) {
        setHistory(res.history);
      }
      setLoadingHistory(false);
    });

    return () => {
      cancelled = true;
    };
  }, [deliveryId]);

  // Use initialData for immediate rendering of current state, or empty object to prevent crashes
  const current = initialData || {};

  // If no data at all, render a skeletal empty state but keep layout
  if (!initialData && !deliveryId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No data available.
      </div>
    );
  }

  // Find the INSERT entry (creation)
  const insertEntry = history.find((h) => h.operation === 'INSERT');
  // Find the most recent UPDATE to determine last-changed fields
  const lastUpdate = history.find((h) => h.operation === 'UPDATE');
  const lastChangedKeys = new Set(
    lastUpdate?.diff ? Object.keys(lastUpdate.diff) : []
  );
  // Expand lab_results into sub-keys for highlight detection
  const lastChangedLabKeys = new Set<string>();
  if (lastUpdate?.diff?.lab_results) {
    const labDiffs = flattenLabResultsDiff(
      lastUpdate.diff.lab_results.old,
      lastUpdate.diff.lab_results.new
    );
    labDiffs.forEach((ld) => lastChangedLabKeys.add(ld.key));
  }

  // Get previous values for tooltips
  const getPreviousValue = (key: string): string | null => {
    if (!lastUpdate?.diff?.[key]) return null;
    return formatFieldValue(key, lastUpdate.diff[key].old);
  };

  const getPreviousLabValue = (subKey: string): string | null => {
    if (!lastUpdate?.diff?.lab_results) return null;
    const oldLab = lastUpdate.diff.lab_results.old;
    const newLab = lastUpdate.diff.lab_results.new;
    if (JSON.stringify(oldLab?.[subKey]) === JSON.stringify(newLab?.[subKey])) return null;
    return formatFieldValue(subKey, oldLab?.[subKey]);
  };

  // Helper to render a standard field cell
  const renderField = (
    key: string,
    current: Record<string, any>,
    lastChangedKeys: Set<string>,
    getPreviousValue: (k: string) => string | null,
    className?: string,
    labelOverride?: string
  ) => {
    const isChanged = lastChangedKeys.has(key);
    const prev = getPreviousValue(key);
    const cell = (
      <div
        key={key}
        className={cn(
          'rounded-md border px-2 py-1.5 overflow-hidden',
          className,
          isChanged && 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800'
        )}
      >
        <div className="text-[10px] font-medium text-muted-foreground uppercase truncate">
          {labelOverride || getFieldLabel(key)}
        </div>
        <div className="text-xs font-mono truncate" title={String(current[key] ?? '-')}>
          {formatFieldValue(key, current[key])}
        </div>
      </div>
    );

    if (isChanged && prev) {
      return (
        <Tooltip key={key}>
          <TooltipTrigger asChild>{cell}</TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-[10px]">
              Prev: <span className="font-mono">{prev}</span>
            </span>
          </TooltipContent>
        </Tooltip>
      );
    }
    return cell;
  };

  // Helper to render a lab field cell
  const renderLabField = (
    subKey: string,
    labData: Record<string, any> | null,
    isChanged: boolean,
    prev: string | null
  ) => {
    const cell = (
      <div
        key={subKey}
        className={cn(
          'flex-1 min-w-[3rem] rounded-md border px-1 py-1 text-center',
          isChanged && 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800'
        )}
      >
        <div className="text-[8px] font-medium text-muted-foreground uppercase truncate">
          {getFieldLabel(subKey)}
        </div>
        <div className="text-xs font-mono truncate font-bold">
          {formatFieldValue(subKey, labData?.[subKey])}
        </div>
      </div>
    );

    if (isChanged && prev) {
      return (
        <Tooltip key={subKey}>
          <TooltipTrigger asChild>{cell}</TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-[10px]">
              Prev: <span className="font-mono">{prev}</span>
            </span>
          </TooltipContent>
        </Tooltip>
      );
    }
    return cell;
  };

  // ... (renderHistoryEntry remains same) ...
  const renderHistoryEntry = (entry: AuditLogRow) => (
    <div key={entry.id} className="flex gap-3 text-sm">
      <Avatar className="h-7 w-7 shrink-0 mt-0.5">
        <AvatarImage src={entry.profiles?.avatar_url ?? undefined} />
        <AvatarFallback className="text-[10px]">
          {getUserInitials(entry.profiles)}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-xs">{getUserName(entry)}</span>
          <OperationBadge op={entry.operation} />
          <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap" title={format(new Date(entry.performed_at), 'MMM d, yyyy h:mm:ss a')}>
            {formatDistanceToNow(new Date(entry.performed_at), { addSuffix: true })}
          </span>
        </div>
        <DiffDisplay entry={entry} />
      </div>
    </div>
  );

  // Calculate generic WHSE for current display
  const whse = current ? calculateWhse(current.block_loc, current.batch_code) : '-';

  return (
    <>
      <div className="text-xs text-muted-foreground pt-1 pb-4 border-b mb-4">
        {insertEntry ? (
          <>
            Created on{' '}
            <span className="font-medium text-foreground">
              {format(new Date(insertEntry.performed_at), 'MMM d, yyyy h:mm a')}
            </span>{' '}
            by{' '}
            <span className="font-medium text-foreground">
              {getUserName(insertEntry)}
            </span>
          </>
        ) : (
          loadingHistory ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading history...
            </span>
          ) : 'No creation record available.'
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-5 pr-1 pt-0">
        {/* Card Body */}
        <TooltipProvider>
          <div className="space-y-3">

            {/* Row 1: Date - Supplier - Price */}
            <div className="grid grid-cols-3 gap-2">
              {renderField('transaction_date', current, lastChangedKeys, getPreviousValue)}
              {renderField('supplier', current, lastChangedKeys, getPreviousValue)}
              {renderField('cost_basis', current, lastChangedKeys, getPreviousValue, '', 'Price')}
            </div>

            <div className="h-px bg-border/50" />

            {/* Row 2: Batch - Block - Whse */}
            <div className="grid grid-cols-3 gap-2">
              {renderField('batch_code', current, lastChangedKeys, getPreviousValue)}
              {renderField('block_loc', current, lastChangedKeys, getPreviousValue)}
              {/* Computed WHSE field */}
              <div className="rounded-md border px-2 py-1.5 overflow-hidden">
                <div className="text-[10px] font-medium text-muted-foreground uppercase truncate">WHSE</div>
                <div className="text-xs font-mono truncate font-bold">{whse}</div>
              </div>
            </div>

            <div className="h-px bg-border/50" />

            {/* Row 3: Truck - Sacks - Remarks */}
            <div className="grid grid-cols-3 gap-2">
              {renderField('truck_plate', current, lastChangedKeys, getPreviousValue)}
              {renderField('sacks', current, lastChangedKeys, getPreviousValue)}
              {renderField('remarks', current, lastChangedKeys, getPreviousValue)}
            </div>

            <div className="h-px bg-border/50" />

            {/* Liquidation */}
            <div>
              <div className="text-[10px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Liquidation</div>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border px-2 py-1.5 overflow-hidden">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase truncate">PHP/TTL</div>
                  <div className="text-xs font-mono truncate font-bold">
                    {(() => {
                      const wt = parseFloat(String(current.weight_kg)) || 0;
                      const price = parseFloat(String(current.cost_basis)) || 0;
                      const total = wt * price;
                      return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    })()}
                  </div>
                </div>
              </div>
            </div>

            <div className="h-px bg-border/50" />

            {/* Lab Results */}
            <div>
              <div className="text-[10px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Lab Results</div>
              <div className="flex gap-1 justify-between">
                {LAB_KEYS.map((subKey) => {
                  const labData = current.lab_results as Record<string, any> | null;
                  const isChanged = lastChangedLabKeys.has(subKey);
                  const prev = getPreviousLabValue(subKey);
                  return renderLabField(subKey, labData, isChanged, prev);
                })}
              </div>
            </div>
          </div>
        </TooltipProvider>

        <div className="h-px bg-border" />

        {/* History Feed */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium flex items-center gap-2">
            Activity Log
          </h4>

          {loadingHistory ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground mt-2">Loading activity...</p>
            </div>
          ) : history.length > 0 ? (
            <div className="space-y-3">
              {/* Latest Update (First Item) */}
              <div className="border rounded-md p-3 bg-muted/30">
                <span className="text-[10px] font-bold text-muted-foreground uppercase mb-2 block tracking-wider">Latest Update</span>
                {renderHistoryEntry(history[0])}
              </div>

              {/* Older Updates (Accordion) */}
              {history.length > 1 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="older" className="border-none">
                    <AccordionTrigger className="text-xs font-medium py-2 hover:no-underline text-muted-foreground">
                      Show Older History ({history.length - 1} more)
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3 pt-2 pl-1">
                        {history.slice(1).map((entry) => renderHistoryEntry(entry))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              No activity recorded aside from creation.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
