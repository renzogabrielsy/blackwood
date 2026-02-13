'use client';

import * as React from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Clock, Loader2, MessageSquareText, Send, ArrowRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  getFieldLabel,
  formatFieldValue,
  flattenLabResultsDiff,
} from '@/lib/field-labels';
import { useAuth } from '@/components/providers/auth-context';
import { getDeliveryHistory, getAuditComments, addAuditComment } from '../actions';
import type { AuditLogRow, AuditComment } from '@/types/rc-in';
import { DiffDisplay, OperationBadge, getUserInitials, getUserName } from './audit-shared';
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { calculateWhse } from '@/lib/rc-utils';

const LAB_KEYS = ['mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc'];

/** Popover for viewing/adding remarks on an audit log entry */
function RemarkPopover({ entry }: { entry: AuditLogRow }) {
  const [open, setOpen] = React.useState(false);
  const [comments, setComments] = React.useState<AuditComment[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [body, setBody] = React.useState('');

  const hasComment = !!entry.comment;
  const commentCount = comments.length;

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    getAuditComments(entry.id).then((res) => {
      setComments(res);
      setLoading(false);
    });
  }, [open, entry.id]);

  async function handleSubmit() {
    if (!body.trim()) return;
    setSubmitting(true);
    const result = await addAuditComment(entry.id, body);
    if (result.success) {
      setBody('');
      // Refresh comments
      const updated = await getAuditComments(entry.id);
      setComments(updated);
    }
    setSubmitting(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-6 w-6 shrink-0',
            hasComment || commentCount > 0
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground/40 hover:text-muted-foreground'
          )}
        >
          <MessageSquareText className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" side="left">
        <div className="p-3 space-y-3">
          {/* Resolved indicator */}
          {entry.resolved && (
            <div className="flex items-center gap-1.5 text-[10px] text-green-600 dark:text-green-400 font-medium bg-green-50 dark:bg-green-950/30 px-2 py-1.5 rounded-md border border-green-200 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              This edit has been resolved
            </div>
          )}

          {/* Edit reason from audit_logs.comment */}
          {entry.comment && (
            <div className="text-xs bg-amber-50 dark:bg-amber-950/30 p-2 rounded-md border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200">
              <span className="font-semibold block mb-0.5 text-[10px] uppercase tracking-wider opacity-70">Edit Reason</span>
              {entry.comment}
            </div>
          )}

          {/* Comments list */}
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length > 0 ? (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {comments.map((c) => {
                const isSystemMessage = c.body === 'marked this edit as resolved' || c.body === 'reopened this edit';
                return (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <Avatar className="h-5 w-5 shrink-0 mt-0.5">
                      <AvatarImage src={c.profiles?.avatar_url ?? undefined} />
                      <AvatarFallback className="text-[8px]">
                        {c.profiles?.display_name?.[0]?.toUpperCase() || c.profiles?.email?.[0]?.toUpperCase() || '?'}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="font-medium truncate">
                          {c.profiles?.display_name || c.profiles?.email || 'Unknown'}
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
                          {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      {isSystemMessage ? (
                        <p className="text-muted-foreground mt-0.5 italic">{c.body}</p>
                      ) : (
                        <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{c.body}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !entry.comment ? (
            <p className="text-xs text-muted-foreground text-center py-2">No remarks yet</p>
          ) : null}

          {/* Quick comment input */}
          <div className="flex gap-2">
            <Textarea
              placeholder="Add a comment..."
              className="text-xs min-h-[60px] resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleSubmit();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs gap-1"
              disabled={!body.trim() || submitting}
              onClick={handleSubmit}
            >
              {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Comment
            </Button>
            <Link
              href={`/inventory/rc-in/edit/${entry.id}`}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              onClick={() => setOpen(false)}
            >
              See full discussion
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
  const { hasPermission } = useAuth();
  const canViewPrices = hasPermission('view:prices');

  React.useEffect(() => {
    if (!deliveryId) {
      setLoadingHistory(false);
      return;
    }

    let cancelled = false;

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

  const current = initialData || {};

  if (!initialData && !deliveryId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No data available.
      </div>
    );
  }

  const insertEntry = history.find((h) => h.operation === 'INSERT');
  const lastUpdate = history.find((h) => h.operation === 'UPDATE');
  const lastChangedKeys = new Set(
    lastUpdate?.diff ? Object.keys(lastUpdate.diff) : []
  );
  const lastChangedLabKeys = new Set<string>();
  if (lastUpdate?.diff?.lab_results) {
    const labDiffs = flattenLabResultsDiff(
      lastUpdate.diff.lab_results.old,
      lastUpdate.diff.lab_results.new
    );
    labDiffs.forEach((ld) => lastChangedLabKeys.add(ld.key));
  }

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
          'flex-1 min-w-12 rounded-md border px-1 py-1 text-center',
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
          {entry.resolved && (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
          )}
          <div className="ml-auto flex items-center gap-1">
            <RemarkPopover entry={entry} />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap" title={format(new Date(entry.performed_at), 'MMM d, yyyy h:mm:ss a')}>
              {formatDistanceToNow(new Date(entry.performed_at), { addSuffix: true })}
            </span>
          </div>
        </div>
        {entry.comment && (
          <div className="text-xs bg-amber-50 dark:bg-amber-950/30 p-2 rounded-md border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 mt-2">
            <span className="font-semibold block mb-0.5 text-[10px] uppercase tracking-wider opacity-70">Edit Reason</span>
            {entry.comment}
          </div>
        )}
        <DiffDisplay entry={entry} />
      </div>
    </div>
  );

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
              {canViewPrices && renderField('cost_basis', current, lastChangedKeys, getPreviousValue, '', 'Price')}
            </div>

            <div className="h-px bg-border/50" />

            {/* Row 2: Batch - Block - Whse */}
            <div className="grid grid-cols-3 gap-2">
              {renderField('batch_code', current, lastChangedKeys, getPreviousValue)}
              {renderField('block_loc', current, lastChangedKeys, getPreviousValue)}
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
            {canViewPrices && (
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
            )}

            {canViewPrices && <div className="h-px bg-border/50" />}

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
