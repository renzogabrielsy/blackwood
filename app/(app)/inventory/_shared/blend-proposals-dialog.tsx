'use client';

import { useMemo, useState } from 'react';
import { History, Loader2, ArchiveRestore, Search, X, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { EMDASH, blendComputedDate } from './print-utils';
import { BlendStatusPill } from './blend-proposal-dialog';
import type { BlendProposalSummary } from '../blocking/types';

// ─── Column geometry ──────────────────────────────────────────────────────────
//
// "Never crush, always scroll": `table-fixed` with explicit pixel widths, an explicit
// MIN-WIDTH equal to their sum, and an `overflow-x-auto` wrapper. There is deliberately
// no `w-auto` column to absorb slack — that column is the one that silently crushes.

const COLS = [
  { key: 'title', label: 'Title', w: 200, align: 'left' },
  { key: 'remark', label: 'Remark', w: 180, align: 'left' },
  { key: 'status', label: 'Status', w: 92, align: 'left' },
  { key: 'version', label: 'v#', w: 48, align: 'right' },
  { key: 'blocks', label: 'Blocks', w: 56, align: 'right' },
  { key: 'balance', label: 'Balance', w: 94, align: 'right' },
  { key: 'mc', label: 'MC', w: 54, align: 'right' },
  { key: 'ash', label: 'ASH', w: 54, align: 'right' },
  { key: 'bd', label: 'BD ASTM', w: 74, align: 'right' },
  { key: 'updated', label: 'Updated', w: 88, align: 'left' },
  { key: 'by', label: 'By', w: 92, align: 'left' },
  { key: 'actions', label: '', w: 66, align: 'right' },
] as const;

// 1098px. The dialog is `max-w-6xl` (1152) precisely so this fits WITHOUT a horizontal
// scroll on a desktop — 12 columns is a lot, and a list you have to scroll sideways to
// read the author of is a list nobody reads. Below that width it scrolls, which is the
// rule ("never crush, always scroll"), never a squeezed column.
const TABLE_MIN_WIDTH = COLS.reduce((sum, c) => sum + c.w, 0);

// ─── Cell helpers ─────────────────────────────────────────────────────────────

/** Tonnes, 2 dp, ACCOUNTING layout — unit pinned left, number pinned right. */
function Tonnes({ kg }: { kg: number | null }) {
  if (kg === null) return <span className="text-muted-foreground">{EMDASH}</span>;
  return (
    <span className="inline-flex w-full justify-between gap-1 font-mono tabular-nums">
      <span className="text-muted-foreground">t</span>
      <span>{(kg / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </span>
  );
}

function Num({ value, decimals }: { value: number | null; decimals: number }) {
  if (value === null) return <span className="text-muted-foreground">{EMDASH}</span>;
  return <span className="font-mono tabular-nums">{value.toFixed(decimals)}</span>;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface BlendProposalsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** EVERY proposal, archived included — the archived switch filters here, not in SQL. */
  proposals: BlendProposalSummary[];
  loading: boolean;
  /** Open a proposal at its current version. */
  onOpenProposal: (proposalId: string, versionNo: number) => void;
  onRestore: (proposal: BlendProposalSummary) => void;
  onRefresh: () => void;
  /** The proposal a restore is currently in flight for. */
  busyId?: string | null;
}

/**
 * The Proposals dialog — the HISTORY half of the blend-proposal feature.
 *
 * A dense, Excel-standard list of every saved proposal, newest-touched first. It is
 * PESO-FREE by construction: `view_blend_proposal_list` carries no ₱ column and none is
 * derivable, so this dialog needs no price gate and is safe for every role including
 * Production. Prices live only inside a version's snapshot, which is fetched through the
 * `canViewPrices()`-gated `fetchBlendProposalVersion` when a row is opened.
 *
 * ARCHIVED ROWS ARE FILTERED CLIENT-SIDE, not refetched. The list is small, the header
 * badge has to count the live ones anyway, and a row you just archived should not vanish
 * behind a network round-trip. Archiving is the ONLY removal in this feature — there is
 * no delete RPC, no DELETE grant and no DELETE policy — so an archived proposal is
 * always one click from coming back.
 */
export function BlendProposalsDialog({
  open,
  onOpenChange,
  proposals,
  loading,
  onOpenProposal,
  onRestore,
  onRefresh,
  busyId = null,
}: BlendProposalsDialogProps) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(() => proposals.filter((p) => p.isArchived).length, [proposals]);

  const rows = useMemo(() => {
    // Plain case-insensitive SUBSTRING over title + remark — deliberately not a fuzzy
    // scorer. An operator searching "4x8" wants the rows that literally say 4x8.
    const q = query.trim().toLowerCase();
    return proposals
      .filter((p) => (showArchived ? true : !p.isArchived))
      .filter((p) => !q || `${p.title} ${p.notes ?? ''}`.toLowerCase().includes(q));
  }, [proposals, query, showArchived]);

  const totalVisible = proposals.filter((p) => (showArchived ? true : !p.isArchived)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="animate-modal-enter w-[calc(100%-2rem)] max-w-6xl sm:max-w-6xl max-h-[85dvh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        {/* ── Header ── */}
        <DialogHeader className="shrink-0 bg-background/90 backdrop-blur-sm border-b border-border px-4 py-3 text-left gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10 text-primary shrink-0">
                <History className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-sm">Saved Blend Proposals</DialogTitle>
                <DialogDescription className="text-xs">
                  Every blend that was ever proposed, with its version history. Nothing is deleted &mdash; only
                  archived.
                </DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={onRefresh}
                disabled={loading}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                title="Reload the list"
                aria-label="Reload the proposals list"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => onOpenChange(false)}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer"
                title="Close"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* ── Search + archived switch ── */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative w-[260px] max-sm:w-full">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title or remark…"
                className="h-8 text-xs pl-7 pr-7"
                aria-label="Search proposals by title or remark"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground
                             transition-colors duration-150 cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived proposals" />
              Show archived
              {archivedCount > 0 && <span className="font-mono text-foreground">({archivedCount})</span>}
            </label>

            <span className="text-[11px] text-muted-foreground ml-auto font-mono">
              {rows.length} of {totalVisible}
            </span>
          </div>
        </DialogHeader>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          {loading && proposals.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center space-y-1.5">
              <p className="text-sm text-foreground">
                {proposals.length === 0
                  ? 'No blend proposals have been saved yet.'
                  : query
                    ? 'No proposal matches that search.'
                    : 'Nothing here.'}
              </p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                {proposals.length === 0 ? (
                  <>
                    Turn on Blend Proposal mode, pick the blocks you are thinking of feeding, build the proposal, then
                    press Save. Every save records the blend exactly as the database computes it that day, so you can
                    come back later and see what the yard actually looked like.
                  </>
                ) : query ? (
                  <>Titles and remarks are matched as plain text &mdash; try a shorter word.</>
                ) : (
                  <>Turn on &ldquo;Show archived&rdquo; to see proposals that were put away.</>
                )}
              </p>
            </div>
          ) : (
            /* Never crush, always scroll — explicit min-width + horizontal overflow. */
            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full table-fixed border-collapse" style={{ minWidth: `${TABLE_MIN_WIDTH}px` }}>
                <colgroup>
                  {COLS.map((c) => (
                    <col key={c.key} style={{ width: `${c.w}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="bg-muted">
                    {COLS.map((c) => (
                      <th
                        key={c.key}
                        className={cn(
                          'text-[9px] font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1',
                          'border-b border-border whitespace-nowrap',
                          c.align === 'right' ? 'text-right' : 'text-left',
                        )}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <TooltipProvider delayDuration={200}>
                    {rows.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => onOpenProposal(p.id, p.currentVersionNo)}
                        data-blend-proposal-row={p.id}
                        tabIndex={0}
                        role="button"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenProposal(p.id, p.currentVersionNo);
                          }
                        }}
                        className={cn(
                          'h-8 border-b border-border/50 last:border-0 cursor-pointer',
                          'transition-all duration-150 hover:bg-muted/50 focus:bg-muted/50 focus:outline-none',
                          p.isArchived && 'opacity-55',
                        )}
                        title={p.isArchived ? 'Archived — open to view, restore to edit' : undefined}
                      >
                        <td className="px-2 py-1 text-xs font-semibold text-foreground truncate" title={p.title}>
                          {p.title}
                        </td>
                        <td className="px-2 py-1 text-xs text-muted-foreground max-w-[180px] truncate">
                          {p.notes ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate">{p.notes}</span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap text-xs">
                                {p.notes}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="opacity-60">{EMDASH}</span>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <BlendStatusPill status={p.status} fedOn={p.fedOn} />
                        </td>
                        <td className="px-2 py-1 text-xs text-right">
                          <span className="font-mono tabular-nums text-foreground">v{p.currentVersionNo}</span>
                          {p.versionCount > 1 && (
                            <span className="text-muted-foreground text-[10px]"> /{p.versionCount}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums text-foreground">
                          {p.blockCount ?? EMDASH}
                        </td>
                        <td className="px-2 py-1 text-xs text-foreground">
                          <Tonnes kg={p.totalBalanceKg} />
                        </td>
                        <td className="px-2 py-1 text-xs text-right text-foreground">
                          <Num value={p.wMc} decimals={2} />
                        </td>
                        <td className="px-2 py-1 text-xs text-right text-foreground">
                          <Num value={p.wAsh} decimals={2} />
                        </td>
                        <td className="px-2 py-1 text-xs text-right text-foreground">
                          <Num value={p.wBdAstm} decimals={3} />
                        </td>
                        <td className="px-2 py-1 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                          {blendComputedDate(p.updatedAt) || EMDASH}
                        </td>
                        <td className="px-2 py-1 text-xs text-muted-foreground truncate" title={p.updatedByName ?? ''}>
                          {p.updatedByName ?? p.createdByName ?? EMDASH}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {p.isArchived && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onRestore(p);
                              }}
                              disabled={busyId === p.id}
                              className="inline-flex items-center gap-1 h-6 px-1.5 rounded border border-border
                                         text-[10px] font-semibold text-muted-foreground
                                         hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer
                                         disabled:opacity-40 disabled:pointer-events-none"
                              title="Restore this proposal"
                            >
                              {busyId === p.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <ArchiveRestore className="w-3 h-3" />
                              )}
                              Restore
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </TooltipProvider>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
