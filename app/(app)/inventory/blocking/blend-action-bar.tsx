'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The BLEND ACTION BAR — the floating bar shown while blend mode is on.
//
// Three stacked rows, top to bottom:
//   1. the MODIFY banner (only in a Modify session) — `Editing: <title> v3 ×` plus the
//      "N of M blocks no longer hold the proposed batch" notice;
//   2. the LIVE STATS strip (`BlendLiveStatsRow`) — the running blend of the selection,
//      every figure computed by the database;
//   3. the ACTIONS — block count, Build Proposal, and in a Modify session the three save
//      doors: **Save to v{from}** (overwrite that version in place), **Save as v{N+1}**
//      (append — the core function, unchanged) and **Save as new** (a fork by hand).
//
// Extracted from `blocking-grid.tsx` (2026-09-25) so the dev fixture
// `/dev/table-playground/blendstats` can mount the REAL bar with a fake fetcher.
// It owns no data access: every handler and every number arrives as a prop.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Calculator, Check, Loader2, Pencil, Save, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { BlendComparable, BlendResolution } from '@/lib/blocking/blend-diff';
import { SaveNewPopover } from '../_shared/blend-proposal-dialog';
import { BlendLiveStatsRow, type BlendLiveStats } from './blend-live-stats';
import type { BlendProposalOverwriteResult, BlendProposalSaveResult } from './types';

// ─── Blend proposal EDITING context (the "Modify" session) ────────────────────
//
// Set when the operator presses Modify on a saved version. It carries TWO compare-and-set
// tokens, one per save door:
//   • `expectedVersionNo` — the proposal's current version, re-checked by the APPEND RPC
//     inside its own UPDATE, so a version someone else appended while this edit was open
//     is REFUSED, never overwritten;
//   • `fromRevisionNo` — the modified version's `revision_no` AS LOADED, re-checked by the
//     OVERWRITE RPC the same way, so an overwrite someone else made meanwhile is refused.
export interface BlendEditingContext {
  proposalId: string;
  title: string;
  notes: string | null;
  /** The proposal's CURRENT version when Modify started — the append token. */
  expectedVersionNo: number;
  /** The version the operator was actually looking at (shown on the pill; the overwrite target). */
  fromVersionNo: number;
  /** That version's `revision_no` as loaded — the overwrite token. */
  fromRevisionNo: number;
  /**
   * The modified version's DB-computed numbers, so the live stats can show the change
   * against it. Captured from the saved snapshot before Modify clears the viewer.
   */
  baseline: BlendComparable;
  /** How the version's block list resolved against the live grid, for the bar's notice. */
  resolution: BlendResolution;
}

/** Turn an APPEND refusal into something a human can act on. */
export function describeSaveRefusal(res: Extract<BlendProposalSaveResult, { ok: false }>): string {
  if (res.reason === 'stale') {
    return `${res.message} Someone appended v${res.currentVersionNo ?? '?'} while this edit was open — reopen the proposal and redo the change so nothing of theirs is lost.`;
  }
  if (res.reason === 'unknown_block' && res.blocks?.length) {
    return `${res.message} (${res.blocks.join(', ')})`;
  }
  return res.message;
}

/** Turn an OVERWRITE refusal into something a human can act on — the same tone. */
export function describeOverwriteRefusal(
  res: Extract<BlendProposalOverwriteResult, { ok: false }>,
  versionNo: number,
): string {
  if (res.reason === 'stale') {
    return `${res.message} Someone else changed v${versionNo} while this edit was open${
      res.currentRevisionNo ? ` (it is now on revision ${res.currentRevisionNo})` : ''
    } — reopen the proposal, look at what they saved, and redo your change so nothing of theirs is lost.`;
  }
  if (res.reason === 'unknown_block' && res.blocks?.length) {
    return `${res.message} (${res.blocks.join(', ')})`;
  }
  return res.message;
}

// ─── The save-to-a-version popover (append OR overwrite) ─────────────────────

/**
 * `append`    — creates `v{versionNo}`; every existing version is left as it is.
 * `overwrite` — replaces what `v{versionNo}` holds; its numbers are recomputed as of
 *               today and the replaced contents go to the hidden archive.
 * The popover IS the confirm step for an overwrite — there is no second modal.
 */
export function SaveVersionPopover({
  mode,
  versionNo,
  busy,
  disabled,
  onSave,
}: {
  mode: 'append' | 'overwrite';
  /** The version this save would CREATE (append) or REPLACE (overwrite). */
  versionNo: number;
  busy: boolean;
  disabled: boolean;
  onSave: (changeNote: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const overwrite = mode === 'overwrite';
  const label = overwrite ? `Save to v${versionNo}` : `Save as v${versionNo}`;

  // Cleared on OPEN (an event), never from an effect — a stale note from the previous
  // version would be the most misleading thing this popover could carry.
  function handleOpenChange(next: boolean) {
    if (next) setNote('');
    setOpen(next);
  }

  async function submit() {
    if (busy) return;
    const ok = await onSave(note.trim());
    if (ok) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          disabled={disabled || busy}
          {...(overwrite ? { 'data-blend-overwrite-version': versionNo } : { 'data-blend-save-version': versionNo })}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-semibold transition-all duration-150 cursor-pointer',
            'disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
            overwrite
              ? 'border border-primary/50 bg-background text-primary hover:bg-primary/10'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
          title={
            overwrite
              ? `Replace what v${versionNo} holds with this selection (the old contents are archived)`
              : `Append version ${versionNo} to this proposal`
          }
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : overwrite ? (
            <Pencil className="w-3.5 h-3.5" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="top" sideOffset={8} className="w-80 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-foreground">{label}</div>
          {overwrite ? (
            <p className="text-[11px] text-muted-foreground leading-snug" data-blend-overwrite-explainer>
              This replaces what v{versionNo} holds with your current selection. Its numbers are recalculated as of
              today, and the previous contents are kept in the archive.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-snug" data-blend-append-explainer>
              Adds v{versionNo} to this proposal; the versions already saved stay exactly as they are. A note here is
              what makes the history readable a month from now.
            </p>
          )}
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={
              overwrite ? `Why it changed — blank keeps v${versionNo}'s note` : 'e.g. swapped A-3A for A-5B, MC too high'
            }
            className="text-xs min-h-[48px] resize-none"
            aria-label="Change note"
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="h-7 text-xs" disabled={busy} onClick={submit}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              {overwrite ? `Save to v${versionNo}` : `Save v${versionNo}`}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── The bar ──────────────────────────────────────────────────────────────────

export interface BlendActionBarProps {
  selectionSize: number;
  stats: BlendLiveStats;
  /** The grid's EFFECTIVE price flag (`serverCanViewPrices && showPrices`). */
  canViewPrices: boolean;
  editing: BlendEditingContext | null;
  /** "2 of 8 blocks no longer hold the proposed batch: …" — or null. */
  editingNotice: string | null;
  saving: boolean;
  onBuild: () => void;
  onClear: () => void;
  onCancelEditing: () => void;
  onSaveVersion: (changeNote: string) => Promise<boolean>;
  onOverwriteVersion: (changeNote: string) => Promise<boolean>;
  onSaveAsNew: (input: { title: string; notes: string }) => Promise<boolean>;
}

export function BlendActionBar({
  selectionSize,
  stats,
  canViewPrices,
  editing,
  editingNotice,
  saving,
  onBuild,
  onClear,
  onCancelEditing,
  onSaveVersion,
  onOverwriteVersion,
  onSaveAsNew,
}: BlendActionBarProps) {
  return (
    <div
      data-blend-action-bar
      className={cn(
        // `inset-x-0 mx-auto w-fit` centres a fixed element against the WHOLE viewport, so
        // its shrink-to-fit width can grow to `max-w` — a `left-1/2 -translate-x-1/2` bar
        // is sized against only half the viewport and starves the stats strip.
        'animate-fade-up fixed bottom-4 inset-x-0 mx-auto w-fit z-50 flex flex-col gap-1.5 rounded-2xl',
        'bg-background/95 px-3 py-2 text-xs font-medium shadow-lg border max-w-[calc(100vw-2rem)]',
        'backdrop-blur supports-backdrop-filter:bg-background/60',
      )}
    >
      {/* ── Modify session banner ── */}
      {editing && (
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-[11px]">
            <Pencil className="w-3 h-3 text-primary" />
            <span className="text-muted-foreground">Editing:</span>
            <span className="font-semibold text-foreground max-w-[220px] truncate" title={editing.title}>
              {editing.title}
            </span>
            <span className="font-mono text-muted-foreground">v{editing.fromVersionNo}</span>
            <button
              onClick={onCancelEditing}
              className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
              title="Stop editing this proposal (the selection stays)"
              aria-label="Cancel editing this proposal"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
          {editingNotice && <span className="text-[11px] text-amber-500 max-w-[520px] text-center">{editingNotice}</span>}
        </div>
      )}

      {/* ── Live stats — the running blend of the selection ── */}
      <BlendLiveStatsRow
        stats={stats}
        canViewPrices={canViewPrices}
        baseline={editing?.baseline ?? null}
        baselineLabel={editing ? `v${editing.fromVersionNo}` : undefined}
      />

      {/* ── Actions ── */}
      <div className="flex items-center gap-2 flex-wrap justify-center">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Check className="w-3.5 h-3.5 text-primary" />
          <span className="font-mono font-semibold text-foreground">{selectionSize}</span>
          block{selectionSize === 1 ? '' : 's'} selected
        </span>
        <span className="text-border">|</span>
        <button
          onClick={onBuild}
          disabled={selectionSize === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-primary-foreground
                     font-semibold hover:bg-primary/90 transition-all duration-150 cursor-pointer
                     disabled:opacity-40 disabled:pointer-events-none"
        >
          <Calculator className="w-3.5 h-3.5" />
          Build Proposal
        </button>

        {editing && (
          <>
            <SaveVersionPopover
              mode="overwrite"
              versionNo={editing.fromVersionNo}
              busy={saving}
              disabled={selectionSize === 0}
              onSave={onOverwriteVersion}
            />
            <SaveVersionPopover
              mode="append"
              versionNo={editing.expectedVersionNo + 1}
              busy={saving}
              disabled={selectionSize === 0}
              onSave={onSaveVersion}
            />
            <SaveNewPopover
              defaultTitle={`${editing.title} (copy)`}
              busy={saving}
              onSave={onSaveAsNew}
              label="Save as new"
              triggerTitle="Save this selection as a separate proposal, leaving the original untouched"
            />
          </>
        )}

        <button
          onClick={onClear}
          disabled={selectionSize === 0}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-muted-foreground
                     hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer
                     disabled:opacity-40 disabled:pointer-events-none"
        >
          <X className="w-3 h-3" />
          Clear
        </button>
      </div>
    </div>
  );
}
