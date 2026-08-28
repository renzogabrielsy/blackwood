'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Blocking detail slide-over — shell-agnostic, shared by Blocking, RC Movement
// (matrix + grid-v2), the inventory tab shell and the home digest's Open Blocks
// band.
//
// TWO OPENING CONTRACTS, and the second one is the pattern to spread:
//
//  • FETCH-FIRST (original, still the default): the host resolves `blockData`
//    and only then sets `locKey`. The drawer opens already full — but the click
//    does nothing at all until the round-trip returns.
//
//  • OPTIMISTIC (opt-in via `loading` / `error`, added 2026-08-28): the host
//    sets `locKey` on the CLICK FRAME with no data. The drawer slides out
//    immediately over a layout-matched skeleton, the fetch runs concurrently,
//    and the real content fades in over the same DOM nodes when it lands. A
//    failure keeps the drawer open with a persistent, copyable inline banner
//    plus Retry — never a silently empty panel.
//
// The two are decided per call site: with `loading` and `error` both falsy the
// optimistic branch is unreachable, so a fetch-first host renders byte-for-byte
// what it always did. See the `loading` prop doc for the adoption recipe and
// `components/digest/open-blocks.tsx` for the reference implementation.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2, Pencil, Check, XIcon, StickyNote, ExternalLink, Printer, Sigma, AlertTriangle, RotateCw, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { DetailDrawerSkeletonBody } from '@/components/shared/detail-drawer-skeleton';
import { TrueWeightPopover } from './true-weight-popover';
import type { BlockData, BlockingDetailData, DeliveryHistoryRecord } from '../blocking/types';
import { fetchBlockingDetail, updateBlockNotes, fetchSingleDelivery } from '../blocking/actions';
import { EMDASH, escapeHtml, peso, printViaIframe, PRINT_CSS } from './print-utils';
import { EditDeliveryDialog } from './edit-delivery-dialog';
import { DeliveryHistoryDialog } from '@/app/(app)/inventory/rc-in/components/DeliveryHistoryDialog';
import type { DeliveryHistoryRow } from '@/types/rc-in';
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
  full: import('../blocking/types').FullDeliveryRecord,
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
    // null (role-gated) → undefined so the info dialog treats it as withheld, not zero.
    cost_basis: full.cost_basis ?? undefined,
    remarks: full.remarks ?? undefined,
    // Weight-deduction / true-weight annotation (display-only — carried through to the dialog).
    true_weight_kg: full.true_weight_kg ?? null,
    deduction_note: full.deduction_note ?? null,
    created_at: '', // not available from fetchSingleDelivery, dialog doesn't strictly need it
    lab_results: full.lab_results,
  };
}

// ─── Print document ─────────────────────────────────────────────────────────
// The escaping (`escapeHtml`), peso formatting (`peso`), iframe print mechanism
// (`printViaIframe`), and base print CSS (`PRINT_CSS`) are shared with the blend
// proposal printout — see `./print-utils`. Only this document-body builder differs.

interface PrintDocInput {
  locKey: string;
  loc: { whse: string; col: string; row: string } | null;
  blockData: BlockData;
  detailData: BlockingDetailData | null;
  canViewPrices: boolean;
}

/**
 * Build a fully self-contained print document (its OWN `<html>` with minimal print
 * CSS). Rendered into a hidden same-origin iframe and printed from there, it is
 * completely immune to the app's dark mode, Tailwind, portals, overlays, transforms,
 * and the slide-over's fixed positioning — none of which exist in this document.
 *
 * Price gating: PHP/KG, Est. Value, the delivery PHP/KG column and the usage Avg Price
 * column are emitted ONLY when `canViewPrices && blockData.php !== null` — the exact
 * flag/condition the on-screen panel uses — so a Production user's printout omits all
 * ₱ data. The flag is passed in from the panel; this function does no role lookup.
 */
function buildPrintDocument({ locKey, loc, blockData, detailData, canViewPrices }: PrintDocInput): string {
  const showPrices = canViewPrices && blockData.php !== null;
  const totalIn = blockData.total_in;
  const pct = totalIn > 0 ? Math.min(100, (blockData.balance / totalIn) * 100) : 0;
  const estValue = blockData.php !== null ? blockData.balance * blockData.php : 0;

  const subtitleLoc = loc ? `WHSE ${escapeHtml(loc.whse)}, Col ${escapeHtml(loc.col)}, Row ${escapeHtml(loc.row)} &middot; ` : '';

  const summaryRows: string[] = [
    `<div class="row"><dt>Balance</dt><dd>${blockData.balance.toLocaleString()} kg (${pct.toFixed(1)}%)</dd></div>`,
    `<div class="row"><dt>Total Delivered</dt><dd>${totalIn.toLocaleString()} kg</dd></div>`,
  ];
  if (showPrices && blockData.php !== null) {
    summaryRows.push(`<div class="row"><dt>PHP/KG</dt><dd>${peso(blockData.php)}</dd></div>`);
    summaryRows.push(`<div class="row"><dt>Est. Value</dt><dd>${peso(estValue)}</dd></div>`);
  }

  const labRows = [
    ['MC', blockData.mc.toFixed(2)],
    ['ASH', blockData.ash.toFixed(2)],
    ['BD ASTM', blockData.bd_astm.toFixed(3)],
    ['BD JIS', blockData.bd_jis.toFixed(3)],
    ['GRIT', blockData.grit.toFixed(2)],
    ['VM', blockData.vm.toFixed(2)],
    ['FC', blockData.fc.toFixed(2)],
  ]
    .map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  const notesSection =
    detailData?.notes && detailData.notes.trim().length > 0
      ? `<section><h2>Notes</h2><p class="notes">${escapeHtml(detailData.notes)}</p></section>`
      : '';

  // ── Delivery history ──
  let deliverySection: string;
  if (detailData && detailData.deliveries.length > 0) {
    const body = detailData.deliveries
      .map((d) => {
        const priceCell = showPrices
          ? `<td class="num">${d.cost_basis !== undefined ? peso(d.cost_basis) : EMDASH}</td>`
          : '';
        return (
          `<tr>` +
          `<td>${escapeHtml(d.transaction_date)}</td>` +
          `<td>${escapeHtml(d.supplier)}</td>` +
          `<td class="num">${d.sacks.toLocaleString()}</td>` +
          `<td class="num">${d.weight_kg.toLocaleString()}</td>` +
          priceCell +
          `<td class="num">${d.mc !== undefined ? d.mc.toFixed(2) : EMDASH}</td>` +
          `<td class="num">${d.bd_astm !== undefined ? d.bd_astm.toFixed(3) : EMDASH}</td>` +
          `<td class="num">${d.ash !== undefined ? d.ash.toFixed(2) : EMDASH}</td>` +
          `</tr>`
        );
      })
      .join('');
    const totalSacks = detailData.deliveries.reduce((s, d) => s + d.sacks, 0);
    const totalWeight = detailData.deliveries.reduce((s, d) => s + d.weight_kg, 0);
    deliverySection =
      `<table>` +
      `<thead><tr>` +
      `<th>Date</th><th>Supplier</th><th class="num">Sacks</th><th class="num">Weight (kg)</th>` +
      (showPrices ? `<th class="num">PHP/KG</th>` : '') +
      `<th class="num">MC</th><th class="num">BD</th><th class="num">ASH</th>` +
      `</tr></thead>` +
      `<tbody>${body}</tbody>` +
      `<tfoot><tr>` +
      `<td colspan="2">Total</td>` +
      `<td class="num">${totalSacks.toLocaleString()}</td>` +
      `<td class="num">${totalWeight.toLocaleString()}</td>` +
      (showPrices ? `<td></td>` : '') +
      `<td></td><td></td><td></td>` +
      `</tr></tfoot>` +
      `</table>`;
  } else {
    deliverySection = `<p class="empty">No deliveries found.</p>`;
  }

  // ── Usage history ──
  let usageSection: string;
  if (detailData && detailData.usage.length > 0) {
    const body = detailData.usage
      .map((u) => {
        const priceCell = showPrices
          ? `<td class="num">${u.avg_price !== null ? peso(u.avg_price) : EMDASH}</td>`
          : '';
        return (
          `<tr>` +
          `<td>${escapeHtml(u.transaction_date)}</td>` +
          `<td>${u.production_batch !== null ? escapeHtml(u.production_batch) : EMDASH}</td>` +
          `<td>${escapeHtml(u.destination)}</td>` +
          `<td class="num">${u.weight_kg.toLocaleString()}</td>` +
          priceCell +
          `</tr>`
        );
      })
      .join('');
    const totalWeight = detailData.usage.reduce((s, u) => s + u.weight_kg, 0);
    usageSection =
      `<table>` +
      `<thead><tr>` +
      `<th>Date</th><th>Batch</th><th>Plant/Etc</th><th class="num">Weight (kg)</th>` +
      (showPrices ? `<th class="num">Avg Price</th>` : '') +
      `</tr></thead>` +
      `<tbody>${body}</tbody>` +
      `<tfoot><tr>` +
      `<td colspan="3">Total</td>` +
      `<td class="num">${totalWeight.toLocaleString()}</td>` +
      (showPrices ? `<td></td>` : '') +
      `</tr></tfoot>` +
      `</table>`;
  } else {
    usageSection = `<p class="empty">No usage records found.</p>`;
  }

  const title = `Block ${escapeHtml(locKey)} ${EMDASH} ${escapeHtml(blockData.batch_code)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="subtitle">${subtitleLoc}Status: ${escapeHtml(blockData.status)}</p>

  <section>
    <h2>Summary</h2>
    <dl>${summaryRows.join('')}</dl>
  </section>

  <section>
    <h2>Quality (Weighted Avg)</h2>
    <dl>${labRows}</dl>
  </section>

  ${notesSection}

  <section>
    <h2>Delivery History (RC IN)</h2>
    ${deliverySection}
  </section>

  <section>
    <h2>Usage History (RC OUT)</h2>
    ${usageSection}
  </section>

  <div class="doc-footer">Blackwood ${EMDASH} Blocking detail &middot; Block ${escapeHtml(
    locKey,
  )} &middot; Printed ${escapeHtml(new Date().toLocaleString())}</div>
</body>
</html>`;
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Where an "Edit All" action wants to land. The panel itself owns the `router.push`
 * to `/inventory?...`; this callback is the SHELL-SPECIFIC hook a host wires up to do
 * any extra work the route push can't (e.g. flipping the in-page tab when the panel is
 * rendered inside the client tab shell). On a standalone route, the host can omit it
 * (the router push alone navigates) or point it at a `router.push` of its own.
 */
export interface BlockingDetailNavTarget {
  /** The batch whose records should be opened. */
  batchCode: string;
  /** Which inventory sub-view the records live in. */
  view: 'deliveries' | 'usage';
}

/**
 * Shell-agnostic navigation seam. When no `onNavigateToBatch` prop is supplied, the
 * panel dispatches this `window` CustomEvent instead of reaching into any tab shell.
 * An in-page host (e.g. the inventory tab provider) listens for it and flips the active
 * tab; on a standalone route nothing listens and the router push alone drives nav.
 */
export const INVENTORY_NAVIGATE_EVENT = 'blackwood:inventory-navigate';

export function emitInventoryNavigate(detail: BlockingDetailNavTarget) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BlockingDetailNavTarget>(INVENTORY_NAVIGATE_EVENT, { detail }));
}

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
  /**
   * ── OPTIMISTIC OPEN (opt-in; default OFF — every existing call site is unchanged) ──
   *
   * The panel's ORIGINAL contract is "fetch first, then open": a host resolves
   * `blockData` and only then sets `locKey`, so the drawer never slides open
   * empty. That costs a full round-trip of dead time on every click.
   *
   * The optimistic contract inverts it: set `locKey` on the CLICK FRAME with
   * `blockData` still null, pass `loading`, and the drawer slides out at once
   * showing a layout-matched skeleton (`DetailDrawerSkeletonBody`) while the
   * fetch runs. When `blockData` lands the real content fades in
   * (`animate-fade-in`, 150ms) over the same DOM nodes — no jump, no height
   * change, no second slide.
   *
   * HOW A CALL SITE ADOPTS IT (see `components/digest/open-blocks.tsx`):
   *   1. On click: set the locKey AND `loading` immediately; clear any previous
   *      `blockData` so the drawer can never flash the last block's numbers.
   *   2. Guard the response against staleness (a request token / batch-id
   *      compare) — a second click must win over the first one's late reply.
   *   3. On failure pass `error` (+ `onRetry`); the drawer stays OPEN with a
   *      persistent, copyable inline banner. Never leave it silently empty.
   *
   * Leaving `loading`/`error` unset keeps the original fetch-first behaviour
   * EXACTLY: with both falsy the optimistic branch is unreachable and a
   * `locKey` without `blockData` renders the same empty closed shell as before.
   */
  loading?: boolean;
  /**
   * Human-readable failure text for the in-flight fetch. Truthy ⇒ the open
   * drawer renders a persistent inline error banner (with Copy, per the project
   * HARD RULE on error surfaces) instead of the skeleton. Ignored once
   * `blockData` is present.
   */
  error?: string | null;
  /** Retry affordance rendered inside the error banner. Omit for no button. */
  onRetry?: () => void;
  /**
   * Optional host hook fired by the "Edit All" buttons, BEFORE the panel pushes the
   * `/inventory?...` URL. Lets a host that lives inside the client tab shell flip the
   * active tab so the deep-link lands on the right view. The panel imports NOTHING from
   * the tab shell — this injected callback is the only seam. When omitted (e.g. a
   * standalone route), the router push alone drives navigation.
   */
  onNavigateToBatch?: (target: BlockingDetailNavTarget) => void;
}

export function BlockingDetailPanel({
  locKey,
  onClose,
  data,
  blockData: blockDataProp,
  canViewPrices,
  loading,
  error,
  onRetry,
  onNavigateToBatch,
}: BlockingDetailPanelProps) {
  const isOpen = locKey !== null;
  // Explicit blockData prop wins; otherwise fall back to the grid map lookup.
  const blockData: BlockData | undefined =
    blockDataProp ?? (locKey && data ? data[locKey] : undefined) ?? undefined;
  const router = useRouter();

  const [detailData, setDetailData] = useState<BlockingDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Is this host driving the drawer optimistically? Derived PURELY from the
  // props — a host that opted in always passes a boolean `loading` (true while
  // fetching, false after), while a fetch-first host passes neither prop, so
  // `loading !== undefined` is the whole test. Deliberately NOT tracked in state:
  // "did we show a skeleton this cycle" would need a setState inside an effect,
  // i.e. a cascading render on every open, to answer a question the props
  // already answer. A fetch-first host gets `undefined` here and therefore no
  // extra class anywhere — its markup is byte-identical to before.
  const isOptimisticHost = loading !== undefined || error !== undefined;

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

  function navigateToBatch(batchCode: string, view: 'deliveries' | 'usage') {
    onClose();
    if (onNavigateToBatch) {
      // Host hook owns navigation ENTIRELY. The host pushes the correct
      // `/inventory?tab=<view>&editBatch=<code>&editView=<view>` URL; the panel must
      // NOT also router.push here — a second push without `tab=`/`editView=` would be
      // the LAST write and would clobber the host's, dropping the target view.
      onNavigateToBatch({ batchCode, view });
      return;
    }
    // ── Fallback (no host hook) ──
    // Forward-looking seam: announce the intent on `window` so a future in-shell host
    // that renders this panel itself (no onNavigateToBatch prop) can flip its active
    // tab. Today both routes (blocking + rc-movement) pass onNavigateToBatch, so this
    // event branch + the panel's own router.push only run on that fallback path.
    emitInventoryNavigate({ batchCode, view });
    router.push(`/inventory?search=${encodeURIComponent(batchCode)}&year=all&editBatch=${encodeURIComponent(batchCode)}`);
  }

  function handleEditAll() {
    if (!blockData) return;
    navigateToBatch(blockData.batch_code, 'deliveries');
  }

  function handleEditAllUsage() {
    if (!blockData) return;
    navigateToBatch(blockData.batch_code, 'usage');
  }

  // ── Print handler ──
  // Build a fully self-contained print document from the data the panel already holds
  // and print THAT in a hidden iframe — never the live DOM. This keeps the output immune
  // to dark mode, Tailwind, portals, overlays, transforms, and the slide-over's fixed
  // positioning (the old @media-print visibility toggle leaked all of those). Price
  // gating mirrors the on-screen panel via the `canViewPrices` flag passed into the
  // builder — no role lookup here.
  function handlePrint() {
    if (!blockData || !locKey) return;
    try {
      const html = buildPrintDocument({
        locKey,
        loc: parseLocKey(locKey),
        blockData,
        detailData,
        canViewPrices,
      });
      const ok = printViaIframe(html);
      if (!ok) {
        errorToast('Could not open the print view', {
          description:
            'The browser blocked creating the hidden print frame. Try again, or use your browser menu (File → Print) with the panel open.',
        });
      }
    } catch (err) {
      errorToast('Failed to print block details', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Optimistic open: the drawer is OUT but its data is not in yet ──
  // Reachable ONLY when a host opted in with `loading` / `error` (see the props
  // doc above); every fetch-first call site skips straight past it. The fragment
  // deliberately emits the SAME two children in the SAME positions as the other
  // two branches (backdrop div, panel div) so React reconciles them as the same
  // DOM nodes — the slide keeps running through the swap instead of restarting.
  if (locKey && !blockData && (loading || error)) {
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
          aria-busy={!error}
          className={cn(
            'fixed top-0 right-0 h-dvh w-full sm:w-[520px] z-50 bg-background border-l border-border',
            'safe-t safe-r safe-b',
            'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
            'overflow-hidden shadow-2xl flex flex-col',
            isOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          {error ? (
            <PanelErrorState locKey={locKey} message={error} onRetry={onRetry} onClose={onClose} />
          ) : (
            <DetailDrawerSkeletonBody title={locKey} onClose={onClose} />
          )}
        </div>
      </>
    );
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
            'fixed top-0 right-0 h-dvh w-full sm:w-[520px] z-50 bg-background border-l border-border',
            // Safe-area insets — mirrors the populated panel below (kept in sync).
            'safe-t safe-r safe-b',
            'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
            isOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        />
      </>
    );
  }

  // Skeleton → data handoff. `animate-fade-in` is 150ms opacity-only (compositor
  // safe, neutralized under prefers-reduced-motion) and is applied to the four
  // section wrappers, which React has just reused from the skeleton — so the
  // placeholder is replaced by content that fades in place rather than popping.
  // It is a constant string for an optimistic host, so it fires once per MOUNT
  // of those sections (i.e. once per open) and never re-fires on a re-render.
  // `undefined` for every fetch-first host ⇒ their markup is unchanged.
  const contentEnter = isOptimisticHost ? 'animate-fade-in' : undefined;

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
          'fixed top-0 right-0 h-dvh w-full sm:w-[520px] z-50 bg-background border-l border-border',
          // SAFE AREA (viewport-fit=cover): this panel is a custom `fixed` overlay that
          // bypasses the shell entirely, so it owns its own insets. It is anchored
          // top+right and spans the full height, so it takes top (status bar), right
          // (landscape notch) and bottom (home indicator) — but NOT left, which it never
          // touches. `bg-background` still paints edge-to-edge behind the padding.
          'safe-t safe-r safe-b',
          'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
          'overflow-hidden shadow-2xl flex flex-col',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* ── Sticky Header ── */}
        <div className={cn('shrink-0 bg-background/95 backdrop-blur-md border-b border-border px-4 py-3', contentEnter)}>
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
            {/* Header actions */}
            <div className="flex items-center gap-1.5">
              {/* Print button */}
              <button
                onClick={handlePrint}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer"
                title="Print block details"
                aria-label="Print block details"
              >
                <Printer className="w-3.5 h-3.5" />
              </button>
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
        <div className={cn('shrink-0 px-4 pt-3 pb-2 space-y-2', contentEnter)}>
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
        <div className={cn('shrink-0 px-4 pb-2', contentEnter)}>
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
        <div className={cn('flex-1 min-h-0 overflow-y-auto px-4 pb-3', contentEnter)}>
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
            <div className="rounded-md overflow-x-auto bg-muted border border-border">
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
            <div className="rounded-md overflow-x-auto bg-muted border border-border">
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

// ─── Optimistic-open failure state ──────────────────────────────────────────

/**
 * The drawer stayed OPEN and the fetch failed. Per the project HARD RULE on
 * error surfaces this banner is PERSISTENT (nothing auto-dismisses it) and
 * carries a **Copy** button that puts the full text on the clipboard, exactly
 * like `errorToast()` — an inline banner satisfies the rule in place of a toast
 * because the drawer is where the user is looking. A Retry re-runs the host's
 * fetch when it supplied one; the alternative — a silently blank panel — is the
 * one outcome this whole state exists to prevent.
 */
function PanelErrorState({
  locKey,
  message,
  onRetry,
  onClose,
}: {
  locKey: string;
  message: string;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const fullText = `Could not load block ${locKey}\n\n${message}`;

  function handleCopy() {
    void navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      {/* Header — same chrome as the loading/populated states so the drawer keeps
          its identity (and its close button) through the failure. */}
      <div className="shrink-0 bg-background/95 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md border border-border bg-muted font-mono font-bold text-sm text-muted-foreground">
            {locKey}
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                       text-muted-foreground hover:text-foreground hover:bg-muted
                       transition-all duration-150 cursor-pointer"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="text-xs text-muted-foreground">Block details</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div
          role="alert"
          className="animate-fade-in rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-foreground">
                Could not load block {locKey}
              </div>
              <p className="mt-1 text-xs text-muted-foreground break-words whitespace-pre-wrap">
                {message}
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px]
                               bg-primary text-primary-foreground hover:bg-primary/90
                               transition-all duration-150 cursor-pointer"
                  >
                    <RotateCw className="h-2.5 w-2.5" />
                    Retry
                  </button>
                )}
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px]
                             text-muted-foreground hover:text-foreground hover:bg-muted
                             border border-border transition-all duration-150 cursor-pointer"
                >
                  <Copy className="h-2.5 w-2.5" />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
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
        {delivery.true_weight_kg != null ? (
          <span className="inline-flex items-center justify-end gap-1">
            <TrueWeightPopover
              trueWeightKg={delivery.true_weight_kg}
              weightKg={delivery.weight_kg}
              deductionNote={delivery.deduction_note ?? null}
              costBasis={delivery.cost_basis ?? null}
              canViewPrices={canViewPrices}
            >
              <button
                type="button"
                aria-label="View true weight / deduction"
                title="View true weight / deduction"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Sigma className="h-3 w-3" />
              </button>
            </TrueWeightPopover>
            <span>{delivery.weight_kg.toLocaleString()}</span>
          </span>
        ) : (
          delivery.weight_kg.toLocaleString()
        )}
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
