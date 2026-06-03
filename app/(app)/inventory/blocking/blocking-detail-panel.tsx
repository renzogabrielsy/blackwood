'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2, Pencil, Check, XIcon, StickyNote, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BlockData, BlockingDetailData, DeliveryHistoryRecord } from './types';
import { fetchBlockingDetail, updateBlockNotes, fetchSingleDelivery } from './actions';
import { EditDeliveryDialog } from './edit-delivery-dialog';
import { DeliveryHistoryDialog } from '@/app/(app)/inventory/rc-in/components/DeliveryHistoryDialog';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import { useInventoryTab } from '@/app/(app)/inventory/components/inventory-tab-context';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHeatColor(balance: number, totalIn: number): string {
  const pct = totalIn > 0 ? (balance / totalIn) * 100 : 0;
  if (pct >= 50) return '#2d6a4f';
  if (pct >= 20) return '#4a9a6a';
  if (pct >= 10) return '#d97706';
  return '#ef4444';
}

function getBalancePctClass(pct: number): string {
  if (pct >= 50) return 'text-emerald-400';
  if (pct >= 20) return 'text-amber-400';
  return 'text-red-400';
}

/**
 * Parse a warehouse block_loc (`A-1A`) into whse/col/row. Returns null when the key is
 * not a real loc (e.g. the RC Movement matrix may open a FEED column whose display key
 * is the batch code, not a `WHSE-COLROW` loc) so the caller can skip the loc subline.
 */
function parseLocKey(locKey: string): { whse: string; col: string; row: string } | null {
  const parts = locKey.split('-');
  if (parts.length < 2 || !parts[0] || !parts[1] || parts[1].length < 2) return null;
  const whse = parts[0];
  const colRow = parts[1];
  const row = colRow[colRow.length - 1];
  const col = colRow.slice(0, -1);
  // A real loc has a numeric column (A-1A). Batch codes (MAY-26-…) have a numeric
  // first segment but a non-WHSE letter prefix is the discriminator we rely on:
  // warehouse keys are single letters / PCA / PCB. Treat anything else as not-a-loc.
  if (!/^[A-D]$|^PC[AB]$/.test(whse)) return null;
  return { whse, col, row };
}

/** Convert a FullDeliveryRecord to a DeliveryHistoryRow for the DeliveryHistoryDialog */
function toDeliveryHistoryRow(
  full: import('./types').FullDeliveryRecord,
): DeliveryHistoryRow {
  return {
    id: full.id,
    transaction_date: full.transaction_date,
    supplier: full.supplier,
    batch_code: full.batch_code,
    block_loc: full.block_loc ?? '',
    truck_plate: full.truck_plate ?? '',
    sacks: full.sacks,
    weight_kg: full.weight_kg,
    cost_basis: full.cost_basis,
    remarks: full.remarks ?? undefined,
    created_at: '', // not available from fetchSingleDelivery, dialog doesn't strictly need it
    lab_results: full.lab_results,
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

interface BlockingDetailPanelProps {
  /**
   * Display key for the header badge. From the Blocking grid this is the block_loc
   * (`A-1A`); from the RC Movement matrix it's the column's block_loc (or batch code
   * fallback for FEED columns). `null` = panel closed.
   */
  locKey: string | null;
  onClose: () => void;
  /**
   * Block map keyed by block_loc — used by the Blocking grid (cell click derives the
   * BlockData via `data[locKey]`). Optional: callers that already have the exact batch
   * (e.g. the RC Movement matrix) pass `blockData` directly and omit this.
   */
  data?: Record<string, BlockData>;
  /**
   * Directly-supplied, batch-accurate summary. When present it takes precedence over
   * `data[locKey]` — required for historical matrix columns whose batch is no longer
   * the one occupying `locKey` (or is CLOSED and absent from the grid map).
   */
  blockData?: BlockData | null;
  canViewPrices: boolean;
}

export function BlockingDetailPanel({ locKey, onClose, data, blockData: blockDataProp, canViewPrices }: BlockingDetailPanelProps) {
  const isOpen = locKey !== null;
  // Explicit blockData prop wins; otherwise fall back to the grid map lookup.
  const blockData: BlockData | undefined =
    blockDataProp ?? (locKey && data ? data[locKey] : undefined) ?? undefined;
  const router = useRouter();
  const { setActiveTab } = useInventoryTab();

  const [detailData, setDetailData] = useState<BlockingDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Notes state
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);

  // Edit delivery dialog state
  const [editDeliveryId, setEditDeliveryId] = useState<string | null>(null);

  // Delivery info dialog state (reuses RC IN's DeliveryHistoryDialog)
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [infoDeliveryId, setInfoDeliveryId] = useState<string | null>(null);
  const [infoDeliveryData, setInfoDeliveryData] = useState<DeliveryHistoryRow | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    },
    [isOpen, onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent body scroll when panel open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // On-demand fetch when locKey changes
  const fetchDetail = useCallback(() => {
    if (!locKey || !blockData) {
      setDetailData(null);
      return;
    }
    setDetailLoading(true);
    setDetailData(null);
    setNotesEditing(false);
    fetchBlockingDetail(blockData.batch_code, blockData.batch_id).then((result) => {
      setDetailData(result);
      setDetailLoading(false);
    });
  }, [locKey, blockData]);

  // Key the detail fetch on the BATCH identity, not just locKey. The Blocking grid
  // supplies blockData synchronously (so batch_id changes the moment a cell is clicked),
  // while the RC Movement matrix supplies it asynchronously (blockData arrives after the
  // header-click fetch resolves) — depending on batch_id covers both: the history loads
  // as soon as the batch is known, and clears when the panel closes (batch_id undefined).
  useEffect(() => {
    fetchDetail();
  }, [blockData?.batch_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset notes editing when detail data changes
  useEffect(() => {
    if (detailData) {
      setNotesDraft(detailData.notes ?? '');
    }
  }, [detailData]);

  // ── Notes handlers ──

  function handleNotesEdit() {
    setNotesDraft(detailData?.notes ?? '');
    setNotesEditing(true);
  }

  function handleNotesCancel() {
    setNotesDraft(detailData?.notes ?? '');
    setNotesEditing(false);
  }

  async function handleNotesSave() {
    if (!blockData) return;
    const trimmed = notesDraft.trim();
    const newNotes = trimmed.length > 0 ? trimmed : null;

    // Optimistic update
    setNotesSaving(true);
    const prevNotes = detailData?.notes ?? null;
    if (detailData) {
      setDetailData({ ...detailData, notes: newNotes });
    }
    setNotesEditing(false);

    const result = await updateBlockNotes(blockData.batch_id, newNotes);
    setNotesSaving(false);

    if (!result.success) {
      // Revert on error
      if (detailData) {
        setDetailData({ ...detailData, notes: prevNotes });
      }
    }
  }

  // ── Edit delivery handlers ──

  function handleEditDeliverySuccess() {
    setEditDeliveryId(null);
    fetchDetail();
  }

  // ── Info delivery dialog handler ──

  async function handleOpenInfoDialog(deliveryId: string) {
    setInfoDeliveryId(deliveryId);
    setInfoDeliveryData(null);
    setInfoLoading(true);
    setInfoDialogOpen(true);

    const result = await fetchSingleDelivery(deliveryId);
    if (result.success) {
      setInfoDeliveryData(toDeliveryHistoryRow(result.delivery));
    }
    setInfoLoading(false);
  }

  // ── Edit All handler ──

  function handleEditAll() {
    if (!blockData) return;
    onClose();
    setActiveTab('deliveries');
    router.push(`/inventory?search=${encodeURIComponent(blockData.batch_code)}&year=all&editBatch=${encodeURIComponent(blockData.batch_code)}`);
  }

  function handleEditAllUsage() {
    if (!blockData) return;
    onClose();
    setActiveTab('usage');
    router.push(`/inventory?search=${encodeURIComponent(blockData.batch_code)}&year=all&editBatch=${encodeURIComponent(blockData.batch_code)}`);
  }

  if (!blockData || !locKey) {
    return (
      <>
        {/* Backdrop */}
        <div
          className={cn(
            'fixed inset-0 z-40 bg-black/40 transition-opacity duration-250',
            isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          onClick={onClose}
        />
        {/* Panel */}
        <div
          className={cn(
            'fixed top-0 right-0 h-dvh w-[520px] z-50 bg-background border-l border-border',
            'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
            isOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        />
      </>
    );
  }

  const loc = parseLocKey(locKey);
  const totalIn = blockData.total_in;
  const pct = totalIn > 0 ? Math.min(100, (blockData.balance / totalIn) * 100) : 0;
  const heatColor = getHeatColor(blockData.balance, totalIn);
  const estValue = blockData.php !== null ? blockData.balance * blockData.php : 0;

  // Compute delivery sacks total
  const totalSacks = detailData
    ? detailData.deliveries.reduce((sum, d) => sum + d.sacks, 0)
    : 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-250',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          'fixed top-0 right-0 h-dvh w-[520px] z-50 bg-background border-l border-border',
          'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
          'overflow-hidden shadow-2xl flex flex-col',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* ── Sticky Header ── */}
        <div className="shrink-0 bg-background/95 backdrop-blur-md border-b border-border px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              {/* Loc badge */}
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-md font-mono font-bold text-sm"
                style={{
                  background: `${heatColor}20`,
                  color: heatColor,
                  border: `1px solid ${heatColor}33`,
                }}
              >
                {locKey}
              </span>
              {/* Status badge */}
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border',
                  blockData.status === 'STORED' && 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                  blockData.status === 'IN-USE' && 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                  blockData.status === 'SUNDRYING' && 'bg-orange-500/10 text-orange-400 border-orange-500/20',
                  blockData.status === 'SUNDRIED' && 'bg-violet-500/10 text-violet-400 border-violet-500/20',
                )}
              >
                <span
                  className={cn(
                    'w-[5px] h-[5px] rounded-full inline-block',
                    blockData.status === 'STORED' && 'bg-blue-500',
                    blockData.status === 'IN-USE' && 'bg-amber-500',
                    blockData.status === 'SUNDRYING' && 'bg-orange-500',
                    blockData.status === 'SUNDRIED' && 'bg-violet-500',
                  )}
                />
                {blockData.status}
              </span>
            </div>
            {/* Close button */}
            <button
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                         text-muted-foreground hover:text-foreground hover:bg-muted
                         transition-all duration-150 cursor-pointer"
              title="Close (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {loc && (
              <>
                <span className="text-xs text-muted-foreground">
                  WHSE {loc.whse}, Col {loc.col}, Row {loc.row}
                </span>
                <span className="text-xs text-muted-foreground">--</span>
              </>
            )}
            <span className="text-sm font-semibold text-foreground">{blockData.batch_code}</span>
          </div>
        </div>

        {/* ── Metrics (Delivery-Card Style) ── */}
        <div className="shrink-0 px-4 pt-3 pb-2 space-y-2">
          {/* Row 1: Balance | PHP/KG | Est. Value */}
          <div className={cn(
            'grid gap-2',
            canViewPrices && blockData.php !== null ? 'grid-cols-3' : 'grid-cols-1',
          )}>
            {/* Balance cell — always shown, prominent */}
            <div
              className={cn(
                'rounded-md border px-2 py-1.5',
                !canViewPrices || blockData.php === null ? 'col-span-1' : '',
              )}
            >
              <div className="text-[10px] font-medium text-muted-foreground uppercase">Balance</div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-bold font-mono text-foreground">
                  {blockData.balance.toLocaleString()} kg
                </span>
                <span className={cn('text-[10px] font-semibold font-mono', getBalancePctClass(pct))}>
                  {pct.toFixed(1)}%
                </span>
              </div>
              {/* Thin progress bar */}
              <div className="h-1 bg-border rounded-full overflow-hidden mt-1">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${heatColor}, ${heatColor}cc)`,
                  }}
                />
              </div>
              <div className="flex justify-between text-[9px] font-mono text-muted-foreground mt-0.5">
                <span>0</span>
                <span>{totalIn.toLocaleString()} kg</span>
              </div>
            </div>

            {canViewPrices && blockData.php !== null && (
              <>
                {/* PHP/KG cell */}
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">PHP/KG</div>
                  <div className="text-sm font-bold font-mono text-foreground">
                    <span className="text-muted-foreground">&#8369;</span>{blockData.php.toFixed(2)}
                  </div>
                </div>

                {/* Est. Value cell */}
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Est. Value</div>
                  <div className="text-sm font-bold font-mono text-foreground">
                    <span className="text-muted-foreground">&#8369;</span>
                    {estValue >= 1_000_000
                      ? `${(estValue / 1_000_000).toFixed(2)}M`
                      : estValue >= 1_000
                        ? `${(estValue / 1_000).toFixed(0)}k`
                        : estValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Lab results row — delivery-card style flex cells */}
          <div className="flex gap-1">
            {[
              { key: 'MC', value: blockData.mc.toFixed(2) },
              { key: 'BD', value: blockData.bd_astm.toFixed(3) },
              { key: 'BD JIS', value: blockData.bd_jis.toFixed(3) },
              { key: 'ASH', value: blockData.ash.toFixed(2) },
              { key: 'GRIT', value: blockData.grit.toFixed(2) },
              { key: 'VM', value: blockData.vm.toFixed(2) },
              { key: 'FC', value: blockData.fc.toFixed(2) },
            ].map((lab) => (
              <div key={lab.key} className="flex-1 min-w-0 rounded-md border px-1 py-1 text-center">
                <div className="text-[8px] font-medium text-muted-foreground uppercase">{lab.key}</div>
                <div className="text-xs font-mono font-bold text-foreground truncate">{lab.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Notes (Inline) ── */}
        <div className="shrink-0 px-4 pb-2">
          {detailLoading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">Notes:</span>
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          ) : notesEditing ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <StickyNote className="h-3 w-3" />
                <span className="text-[10px] font-semibold uppercase tracking-wider">Notes</span>
              </div>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs
                           text-foreground placeholder:text-muted-foreground resize-y min-h-[48px] max-h-[100px]
                           focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Add notes about this block..."
                rows={2}
                autoFocus
              />
              <div className="flex items-center gap-1.5 justify-end">
                <button
                  onClick={handleNotesCancel}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px]
                             text-muted-foreground hover:text-foreground hover:bg-muted
                             border border-border transition-all duration-150 cursor-pointer"
                >
                  <XIcon className="h-2.5 w-2.5" />
                  Cancel
                </button>
                <button
                  onClick={handleNotesSave}
                  disabled={notesSaving}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px]
                             bg-primary text-primary-foreground hover:bg-primary/90
                             transition-all duration-150 cursor-pointer disabled:opacity-50"
                >
                  {notesSaving ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Check className="h-2.5 w-2.5" />
                  )}
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs min-h-[24px]">
              <StickyNote className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Notes:</span>
              <span className="text-xs text-foreground/80 truncate flex-1">
                {detailData?.notes ? detailData.notes : (
                  <span className="text-muted-foreground italic">&mdash;</span>
                )}
              </span>
              <button
                onClick={handleNotesEdit}
                className="flex items-center justify-center w-5 h-5 rounded shrink-0
                           text-muted-foreground/50 hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer"
                title="Edit notes"
              >
                <Pencil className="h-2.5 w-2.5" />
              </button>
            </div>
          )}
        </div>

        {/* ── Scrollable Content Area ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
          {/* ── Delivery History (RC IN) ── */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Delivery History (RC IN)
              </div>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleEditAll}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px]
                                 text-muted-foreground hover:text-foreground hover:bg-muted
                                 border border-transparent hover:border-border
                                 transition-all duration-150 cursor-pointer"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span>Edit All</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Open all deliveries for this batch in the Deliveries tab
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="rounded-md overflow-hidden bg-muted border border-border">
              {detailLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : detailData && detailData.deliveries.length === 0 ? (
                <div className="text-center py-4 text-xs text-muted-foreground">
                  No deliveries found
                </div>
              ) : detailData ? (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border">
                        Date
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border">
                        Supplier
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        Sacks
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        Weight
                      </th>
                      {canViewPrices && (
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                          PHP/KG
                        </th>
                      )}
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        MC
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        BD
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        ASH
                      </th>
                      <th className="w-[40px] border-b border-border" />
                    </tr>
                  </thead>
                  <tbody>
                    {detailData.deliveries.map((d) => (
                      <DeliveryRow
                        key={d.id}
                        delivery={d}
                        canViewPrices={canViewPrices}
                        onEdit={() => setEditDeliveryId(d.id)}
                        onClick={() => handleOpenInfoDialog(d.id)}
                      />
                    ))}
                  </tbody>
                  {/* Total row */}
                  <tfoot>
                    <tr className="border-t border-border bg-muted/50">
                      <td className="text-[9px] font-semibold text-muted-foreground uppercase px-1.5 py-1" colSpan={2}>
                        Total
                      </td>
                      <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1">
                        {totalSacks.toLocaleString()}
                      </td>
                      <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1">
                        {detailData.deliveries.reduce((s, d) => s + d.weight_kg, 0).toLocaleString()} kg
                      </td>
                      {canViewPrices && <td />}
                      <td />
                      <td />
                      <td />
                      <td />
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>

          {/* ── Usage History (RC OUT) ── */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Usage History (RC OUT)
              </div>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleEditAllUsage}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px]
                                 text-muted-foreground hover:text-foreground hover:bg-muted
                                 border border-transparent hover:border-border
                                 transition-all duration-150 cursor-pointer"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span>Edit All</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Open all usage records for this batch in the Usage tab
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="rounded-md overflow-hidden bg-muted border border-border">
              {detailLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : detailData && detailData.usage.length === 0 ? (
                <div className="text-center py-4 text-xs text-muted-foreground">
                  No usage records found
                </div>
              ) : detailData ? (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border">
                        Date
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border">
                        Batch
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border">
                        Plant/Etc
                      </th>
                      <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                        Weight
                      </th>
                      {canViewPrices && (
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border">
                          Avg Price
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {detailData.usage.map((u, i) => (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="text-[10px] font-mono text-foreground px-1.5 py-1">{u.transaction_date}</td>
                        <td className="text-[10px] font-mono text-muted-foreground px-1.5 py-1">
                          {u.production_batch ?? '\u2014'}
                        </td>
                        <td className="text-[10px] text-muted-foreground px-1.5 py-1">{u.destination}</td>
                        <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
                          {u.weight_kg.toLocaleString()} kg
                        </td>
                        {canViewPrices && (
                          <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
                            {u.avg_price !== null ? (
                              <span className="inline-flex w-full justify-between">
                                <span className="text-muted-foreground">&#8369;</span>
                                <span>{u.avg_price.toFixed(2)}</span>
                              </span>
                            ) : '\u2014'}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-muted/50">
                      <td className="text-[9px] font-semibold text-muted-foreground uppercase px-1.5 py-1" colSpan={3}>
                        Total
                      </td>
                      <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1">
                        {detailData.usage.reduce((s, u) => s + u.weight_kg, 0).toLocaleString()} kg
                      </td>
                      {canViewPrices && <td />}
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Delivery Dialog ── */}
      <EditDeliveryDialog
        deliveryId={editDeliveryId}
        canViewPrices={canViewPrices}
        onClose={() => setEditDeliveryId(null)}
        onSuccess={handleEditDeliverySuccess}
      />

      {/* ── Delivery Info Dialog (reuse RC IN) ── */}
      <DeliveryHistoryDialog
        deliveryId={infoDeliveryId}
        initialData={infoLoading ? null : infoDeliveryData}
        open={infoDialogOpen}
        onOpenChange={(open) => {
          setInfoDialogOpen(open);
          if (!open) {
            setInfoDeliveryId(null);
            setInfoDeliveryData(null);
          }
        }}
      />
    </>
  );
}

// ─── Delivery Row Sub-component ─────────────────────────────────────────────

function DeliveryRow({
  delivery,
  canViewPrices,
  onEdit,
  onClick,
}: {
  delivery: DeliveryHistoryRecord;
  canViewPrices: boolean;
  onEdit: () => void;
  onClick: () => void;
}) {
  return (
    <tr
      className="border-b border-border/50 last:border-0 group transition-all duration-150 cursor-pointer hover:bg-muted/50"
      onClick={onClick}
    >
      <td className="text-[10px] font-mono text-foreground px-1.5 py-1">{delivery.transaction_date}</td>
      <td className="text-[10px] text-muted-foreground px-1.5 py-1 max-w-[80px] truncate">{delivery.supplier}</td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
        {delivery.sacks.toLocaleString()}
      </td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
        {delivery.weight_kg.toLocaleString()}
      </td>
      {canViewPrices && (
        <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
          {delivery.cost_basis !== undefined ? (
            <span className="inline-flex w-full justify-between">
              <span className="text-muted-foreground">&#8369;</span>
              <span>{delivery.cost_basis.toFixed(2)}</span>
            </span>
          ) : '\u2014'}
        </td>
      )}
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
        {delivery.mc !== undefined ? delivery.mc.toFixed(2) : '\u2014'}
      </td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
        {delivery.bd_astm !== undefined ? delivery.bd_astm.toFixed(3) : '\u2014'}
      </td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1">
        {delivery.ash !== undefined ? delivery.ash.toFixed(2) : '\u2014'}
      </td>
      <td className="px-0.5 py-1">
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="flex items-center justify-center w-5 h-5 rounded
                       text-muted-foreground/50 hover:text-foreground hover:bg-background
                       transition-all duration-150 cursor-pointer"
            title="Edit delivery"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
