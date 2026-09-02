'use client';

import { useState } from 'react';
import {
  Loader2,
  Calculator,
  Printer,
  X,
  Download,
  Save,
  Pencil,
  Archive,
  ArchiveRestore,
  GitCompare,
  Star,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import {
  EMDASH,
  escapeHtml,
  peso,
  printViaIframe,
  PRINT_CSS,
  blendVersionLine,
  blendComputedDate,
  type BlendDocMeta,
} from './print-utils';
import {
  blendLabDecimals,
  formatSignedDelta,
  type BlendComparison,
  type BlendLabKey,
} from '@/lib/blocking/blend-diff';
import type {
  BlendProposalStatus,
  BlendProposalVersionSummary,
  SavedBlendProposal,
} from '../blocking/types';
// PERF-4: composeBlendPdfFilename is jspdf-free (pure filename helper) and is used
// synchronously for the live preview / validity, so it stays a static import. The
// heavy downloadBlendPdf (jsPDF + jspdf-autotable) is loaded lazily on the Download
// click via `await import('./blend-proposal-pdf')` so those libs ship in a separate
// chunk instead of the main bundle.
import { composeBlendPdfFilename } from './blend-proposal-filename';
import type { BlendProposal, BlendProposalBlock } from '../blocking/actions';

// ─── Display helpers ──────────────────────────────────────────────────────────

/** Lab stat formatting matches the print/detail view: BD → 3 decimals, rest → 2. */
function formatLab(key: string, value: number): string {
  return key === 'bd_astm' || key === 'bd_jis' ? value.toFixed(3) : value.toFixed(2);
}

function formatKg(val: number): string {
  return Math.round(val).toLocaleString();
}

/** Peso, 2 decimals, accounting-friendly (on-screen — no symbol prefix). */
function pesoNum(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The 7 lab stats in canonical column order, with display labels. `key` indexes BOTH
 * `BlendProposal['weighted']` (the blended summary) and `BlendProposalBlock` (per-block),
 * so the same order drives the weighted strip and the per-block table columns.
 */
const LAB_ORDER: { key: keyof BlendProposal['weighted']; label: string }[] = [
  { key: 'mc', label: 'MC' },
  { key: 'ash', label: 'ASH' },
  { key: 'bd_astm', label: 'BD ASTM' },
  { key: 'bd_jis', label: 'BD JIS' },
  { key: 'grit', label: 'GRIT' },
  { key: 'vm', label: 'VM' },
  { key: 'fc', label: 'FC' },
];

// ─── Print document ───────────────────────────────────────────────────────────
// Mirrors the detail-panel printout: a fully self-contained HTML document (its OWN
// `<html>` + shared `PRINT_CSS`) printed in a hidden iframe — never the live DOM — so it
// is immune to dark mode, Tailwind, the Dialog portal/overlay, transforms, and fixed
// positioning. Shared plumbing (escapeHtml/peso/printViaIframe/PRINT_CSS) lives in
// `./print-utils`; only this builder is specific to the blend proposal.
//
// Price gating: the per-block PHP/KG column, raw price, and product cost are emitted ONLY
// when the EFFECTIVE flag is true — `proposal.can_view_prices` (server gate) AND the
// `showPricesPref` display preference AND the value is non-null. No role lookup here;
// relies solely on the payload flag ANDed with the passed-in preference. The per-block lab
// columns are NOT gated — everyone prints lab stats. `showPricesPref` defaults to `true`.

export function buildBlendPrintDocument(
  proposal: BlendProposal,
  showPricesPref = true,
  meta?: BlendDocMeta | null,
): string {
  const showPrices = proposal.can_view_prices && showPricesPref && proposal.raw_price_per_kg !== null;

  // ── Summary rows ──
  const summaryRows: string[] = [
    `<div class="row"><dt>Total Balance</dt><dd>${formatKg(proposal.total_balance)} kg</dd></div>`,
    `<div class="row"><dt>Blocks</dt><dd>${proposal.block_count}</dd></div>`,
  ];

  // ── Weighted lab stats ──
  const labRows = LAB_ORDER.map(
    ({ key, label }) => `<div class="row"><dt>${label}</dt><dd>${formatLab(key, proposal.weighted[key])}</dd></div>`,
  ).join('');

  // ── Pricing section (gated) ──
  let pricingSection = '';
  if (showPrices && proposal.raw_price_per_kg !== null) {
    const priceRows: string[] = [
      `<div class="row"><dt>Raw blended price</dt><dd>${peso(proposal.raw_price_per_kg)} /kg</dd></div>`,
    ];
    let formula = '';
    if (proposal.product_cost_per_kg !== null) {
      priceRows.push(
        `<div class="row"><dt>Product cost</dt><dd>${peso(proposal.product_cost_per_kg)} /kg</dd></div>`,
      );
      const multiplier = (1 + proposal.production_loss_pct / 100).toFixed(2);
      formula = `<p class="formula">Raw blend ${peso(proposal.raw_price_per_kg)} &times; ${multiplier} (${proposal.production_loss_pct}% production loss) = ${peso(
        proposal.product_cost_per_kg,
      )} /kg product cost</p>`;
    }
    pricingSection = `
  <section>
    <h2>Pricing</h2>
    <dl>${priceRows.join('')}</dl>
    ${formula}
  </section>`;
  }

  // ── Selected blocks table (block, batch, balance, 7 lab columns, PHP/KG) ──
  const blockBody = proposal.blocks
    .map((b) => {
      const labCells = LAB_ORDER.map(
        ({ key }) => `<td class="num">${formatLab(key, b[key])}</td>`,
      ).join('');
      const priceCell = showPrices
        ? `<td class="num">${b.php_kg !== null ? peso(b.php_kg) : EMDASH}</td>`
        : '';
      return (
        `<tr>` +
        `<td>${escapeHtml(b.block_loc)}</td>` +
        `<td>${escapeHtml(b.batch_code)}</td>` +
        `<td class="num">${formatKg(b.balance)}</td>` +
        labCells +
        priceCell +
        `</tr>`
      );
    })
    .join('');

  const labHeaders = LAB_ORDER.map(({ label }) => `<th class="num">${label}</th>`).join('');
  // tfoot spans: Block + Batch (2) under "Total", then Balance, then 7 empty lab cells.
  const blockTable = proposal.blocks.length
    ? `<table>` +
      `<thead><tr>` +
      `<th>Block</th><th>Batch</th><th class="num">Balance (kg)</th>` +
      labHeaders +
      (showPrices ? `<th class="num">PHP/KG</th>` : '') +
      `</tr></thead>` +
      `<tbody>${blockBody}</tbody>` +
      `<tfoot><tr>` +
      `<td colspan="2">Total</td>` +
      `<td class="num">${formatKg(proposal.total_balance)}</td>` +
      `<td colspan="${LAB_ORDER.length}"></td>` +
      (showPrices ? `<td></td>` : '') +
      `</tr></tfoot>` +
      `</table>`
    : `<p class="empty">No blocks selected.</p>`;

  // A saved version prints under its OWN name; a live what-if keeps the generic one.
  const savedTitle = (meta?.title ?? '').trim();
  const title = savedTitle ? escapeHtml(savedTitle) : 'Blend Proposal';
  const docTitle = savedTitle ? `${escapeHtml(savedTitle)} ${EMDASH} Blend Proposal` : 'Blend Proposal';

  // `v3 · as proposed 2026-09-02` — the SNAPSHOT's date, never the print clock.
  const versionLine = blendVersionLine(meta);
  const subtitleParts = [
    `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'} &middot; ${formatKg(
      proposal.total_balance,
    )} kg combined balance`,
  ];
  if (versionLine) subtitleParts.unshift(escapeHtml(versionLine));
  const subtitle = subtitleParts.join(' &middot; ');

  const remark = (meta?.notes ?? '').trim();
  const remarkLine = remark ? `<p class="subtitle remark">${escapeHtml(remark)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${docTitle}</title>
<style>${PRINT_CSS}
  .subtitle.remark { font-style: italic; color: #333; margin: -12px 0 16px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="subtitle">${subtitle}</p>
  ${remarkLine}

  <section>
    <h2>Summary</h2>
    <dl>${summaryRows.join('')}</dl>
  </section>

  <section>
    <h2>Blended Lab Stats (Weighted Avg)</h2>
    <dl>${labRows}</dl>
  </section>
${pricingSection}
  <section>
    <h2>Selected Blocks</h2>
    ${blockTable}
  </section>

  <div class="doc-footer">Blackwood ${EMDASH} Blend proposal${
    meta?.versionNo != null ? ` v${meta.versionNo}` : ''
  } &middot; Printed ${escapeHtml(
    new Date().toLocaleString(),
  )}</div>
</body>
</html>`;
}

// ─── Status pill ──────────────────────────────────────────────────────────────
//
// Shared with the Proposals LIST dialog, so a proposal reads the same in both places.
// The lifecycle is deliberately small (`draft | planned | fed`) and carries no join to
// `rc_out` — `fed` is RECORDED INTENT, not a reconciled fact.

const STATUS_STYLE: Record<BlendProposalStatus, string> = {
  draft: 'bg-zinc-400/10 text-zinc-400 border-zinc-400/30',
  planned: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  fed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
};

const STATUS_LABEL: Record<BlendProposalStatus, string> = {
  draft: 'Draft',
  planned: 'Planned',
  fed: 'Fed',
};

export const BLEND_STATUSES: BlendProposalStatus[] = ['draft', 'planned', 'fed'];

export function BlendStatusPill({
  status,
  fedOn,
  className,
}: {
  status: BlendProposalStatus;
  fedOn?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap',
        STATUS_STYLE[status] ?? STATUS_STYLE.draft,
        className,
      )}
      title={status === 'fed' && fedOn ? `Fed on ${fedOn}` : undefined}
    >
      {STATUS_LABEL[status] ?? status}
      {status === 'fed' && fedOn ? <span className="font-mono font-normal opacity-80">{fedOn}</span> : null}
    </span>
  );
}

// ─── Delta rendering ──────────────────────────────────────────────────────────
//
// DELIBERATELY NOT COLOUR-CODED green/red. "MC rose 1.5" is not good or bad — it is
// just different — and painting every rise green would quietly assert a judgement the
// data does not support. The SIGN carries the direction; colour is reserved for
// "unknown" (muted em dash) and "did not move" (muted zero).

function Delta({
  value,
  decimals = 2,
  grouped = false,
}: {
  value: number | null;
  decimals?: number;
  /** Thousands separators — on for kilograms, off for lab stats and ₱/kg. */
  grouped?: boolean;
}) {
  const text = formatSignedDelta(value, decimals, grouped);
  const isZeroOrUnknown = value === null || text === formatSignedDelta(0, decimals, grouped);
  return (
    <span
      className={cn('font-mono tabular-nums', isZeroOrUnknown ? 'text-muted-foreground' : 'text-foreground')}
      title={value === null ? 'Not comparable — one side has no value' : undefined}
    >
      {text}
    </span>
  );
}

// ─── Per-block table row ──────────────────────────────────────────────────────

function BlockRow({
  block,
  showPrices,
  onRemove,
  removeDisabled,
  changed,
  currentBatchCode,
}: {
  block: BlendProposalBlock;
  showPrices: boolean;
  onRemove: (() => void) | undefined;
  removeDisabled: boolean;
  /** Compare mode: the block is held by a DIFFERENT batch today. */
  changed?: boolean;
  currentBatchCode?: string | null;
}) {
  return (
    <tr className={cn('border-b border-border/50 last:border-0', changed && 'bg-amber-500/5')}>
      <td className="text-[10px] font-mono font-semibold text-foreground px-1.5 py-1 whitespace-nowrap">
        <span className="inline-flex items-center gap-1">
          {changed && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
              title={
                currentBatchCode
                  ? `A different batch holds this block today: ${currentBatchCode}`
                  : 'This block no longer holds the proposed batch'
              }
            />
          )}
          {block.block_loc}
        </span>
      </td>
      <td className="text-[10px] text-muted-foreground px-1.5 py-1 max-w-[160px] truncate" title={block.batch_code}>
        {block.batch_code}
      </td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
        {formatKg(block.balance)} kg
      </td>
      {/* 7 per-block lab columns — NOT price-gated */}
      {LAB_ORDER.map(({ key }) => (
        <td key={key} className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
          {formatLab(key, block[key])}
        </td>
      ))}
      {showPrices && (
        <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
          {block.php_kg !== null ? (
            <span className="inline-flex w-full justify-between gap-1">
              <span className="text-muted-foreground">&#8369;</span>
              <span>{block.php_kg.toFixed(2)}</span>
            </span>
          ) : (
            EMDASH
          )}
        </td>
      )}
      {/* Remove control */}
      {onRemove && (
        <td className="px-1 py-1 w-[28px]">
          <button
            onClick={onRemove}
            disabled={removeDisabled}
            className="flex items-center justify-center w-5 h-5 rounded
                       text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10
                       transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            title={`Remove ${block.block_loc} from the blend`}
            aria-label={`Remove ${block.block_loc} from the blend`}
          >
            <X className="w-3 h-3" />
          </button>
        </td>
      )}
    </tr>
  );
}

// ─── Version rail ─────────────────────────────────────────────────────────────

function VersionRail({
  versions,
  selected,
  onSelect,
  disabled,
}: {
  versions: BlendProposalVersionSummary[];
  selected: number;
  onSelect: (versionNo: number) => void;
  disabled: boolean;
}) {
  const chosen = versions.find((v) => v.versionNo === selected) ?? null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Proposal versions">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0 pr-1">
          Versions
        </span>
        {versions.map((v) => {
          const active = v.versionNo === selected;
          return (
            <button
              key={v.versionNo}
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => onSelect(v.versionNo)}
              data-blend-version-chip={v.versionNo}
              className={cn(
                'inline-flex items-center gap-1 px-2 h-6 rounded-md border text-[10px] font-mono font-semibold shrink-0',
                'transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none',
                active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground',
              )}
              title={
                v.changeNote
                  ? `v${v.versionNo} — ${v.changeNote}`
                  : `v${v.versionNo}${v.isCurrent ? ' (current)' : ''}`
              }
            >
              v{v.versionNo}
              {v.isCurrent && <Star className="w-2.5 h-2.5 fill-current" aria-label="current version" />}
            </button>
          );
        })}
      </div>
      {/* Why this version differs, who made it, when. */}
      <div className="text-[10px] text-muted-foreground leading-snug min-h-[14px]">
        {chosen ? (
          <>
            {chosen.changeNote ? (
              <span className="text-foreground">{chosen.changeNote}</span>
            ) : (
              <span className="italic">No change note</span>
            )}
            <span className="mx-1.5 text-border">|</span>
            <span className="font-mono">{blendComputedDate(chosen.createdAt) || EMDASH}</span>
            {chosen.createdByName && <span> &middot; {chosen.createdByName}</span>}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Header edit popover (title / remark / status) ────────────────────────────

interface HeaderPatch {
  title: string;
  notes: string | null;
  status: BlendProposalStatus;
  fed_on: string | null;
}

function HeaderEditPopover({
  title,
  notes,
  status,
  fedOn,
  busy,
  onSave,
}: {
  title: string;
  notes: string | null;
  status: BlendProposalStatus;
  fedOn: string | null;
  busy: boolean;
  onSave: (patch: HeaderPatch) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftNotes, setDraftNotes] = useState(notes ?? '');
  const [draftStatus, setDraftStatus] = useState<BlendProposalStatus>(status);
  const [draftFedOn, setDraftFedOn] = useState(fedOn ?? '');

  // Re-seed every time the popover OPENS so it can never show a stale header. This is
  // an event handler, not an effect: opening is a user action, and resetting form state
  // from an effect would cascade a second render for no reason.
  function handleOpenChange(next: boolean) {
    if (next) {
      setDraftTitle(title);
      setDraftNotes(notes ?? '');
      setDraftStatus(status);
      setDraftFedOn(fedOn ?? '');
    }
    setOpen(next);
  }

  const titleValid = draftTitle.trim().length > 0;
  // The DB CHECK ties `status = 'fed'` to a non-null `fed_on` — refuse locally rather
  // than sending a write the database will bounce.
  const fedValid = draftStatus !== 'fed' || draftFedOn.trim().length > 0;
  const valid = titleValid && fedValid && !busy;

  async function submit() {
    if (!valid) return;
    const ok = await onSave({
      title: draftTitle.trim(),
      notes: draftNotes.trim() ? draftNotes.trim() : null,
      status: draftStatus,
      fed_on: draftStatus === 'fed' ? draftFedOn.trim() : null,
    });
    if (ok) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                     text-muted-foreground hover:text-foreground hover:bg-muted
                     transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          title="Edit title, remark and status"
          aria-label="Edit proposal title, remark and status"
          disabled={busy}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-foreground">Edit proposal</div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Title</label>
            <Input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="h-8 text-xs"
              aria-label="Proposal title"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Remark</label>
            <Textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              rows={2}
              placeholder="Why this blend?"
              className="text-xs min-h-[48px] resize-none"
              aria-label="Proposal remark"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Status</label>
            <div className="flex items-center gap-1">
              {BLEND_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setDraftStatus(s)}
                  aria-pressed={draftStatus === s}
                  className={cn(
                    'flex-1 h-7 rounded-md border text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                    draftStatus === s
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground',
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {draftStatus === 'fed' && (
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Fed on</label>
              <Input
                type="date"
                value={draftFedOn}
                onChange={(e) => setDraftFedOn(e.target.value)}
                className="h-8 text-xs font-mono"
                aria-label="Fed on date"
              />
              <p className="text-[10px] text-muted-foreground leading-snug">
                Recorded intent only &mdash; nothing is reconciled against actual feeding.
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!valid} onClick={submit}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Save-as-new popover (title + remark, the first save of a fresh blend) ─────

export function SaveNewPopover({
  defaultTitle,
  busy,
  onSave,
  label = 'Save',
  triggerTitle = 'Save this blend as a proposal',
}: {
  defaultTitle?: string;
  busy: boolean;
  onSave: (input: { title: string; notes: string }) => Promise<boolean>;
  label?: string;
  triggerTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [notes, setNotes] = useState('');

  // Seeded on OPEN (an event), never from an effect — see HeaderEditPopover above.
  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle(defaultTitle ?? '');
      setNotes('');
    }
    setOpen(next);
  }

  const valid = title.trim().length > 0 && !busy;

  async function submit() {
    if (!valid) return;
    const ok = await onSave({ title: title.trim(), notes: notes.trim() });
    if (ok) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          disabled={busy}
          data-blend-save-trigger
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-primary bg-primary
                     text-primary-foreground text-[11px] font-semibold
                     transition-all duration-150 cursor-pointer hover:bg-primary/90
                     disabled:opacity-40 disabled:pointer-events-none"
          title={triggerTitle}
          aria-label={triggerTitle}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-foreground">Save proposal</div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Every proposal carries a title and a remark. The blend is stored exactly as the database computes it right
            now, so this version always says what the yard actually looked like today.
          </p>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="e.g. 4x8 RUN — week 36"
              className="h-8 text-xs"
              aria-label="Proposal title"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Remark</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Why this blend? (optional)"
              className="text-xs min-h-[48px] resize-none"
              aria-label="Proposal remark"
            />
          </div>

          <div className="flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!valid} onClick={submit}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Everything the dialog needs to render a SAVED version rather than a live what-if.
 * `null`/absent = the existing fresh-blend behaviour, unchanged.
 */
export interface BlendSavedContext {
  /** The version currently on screen (already price-gated by the server action). */
  proposal: SavedBlendProposal;
  /** Every version of this proposal — the rail. */
  versions: BlendProposalVersionSummary[];
  /** The proposal's newest version — ALSO the compare-and-set token for saving. */
  currentVersionNo: number;
  status: BlendProposalStatus;
  fedOn: string | null;
  isArchived: boolean;
  /** A version fetch / header write is in flight. */
  busy: boolean;
  onSelectVersion: (versionNo: number) => void;
  onModify: () => void;
  onCompare: () => void;
  onCloseCompare: () => void;
  /** Non-null while "Compare with today" is showing. */
  comparison: BlendComparison | null;
  compareLoading: boolean;
  onSaveHeader: (patch: HeaderPatch) => Promise<boolean>;
  onArchiveToggle: () => void;
}

interface BlendProposalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The computed proposal; null while loading or before first build. */
  proposal: BlendProposal | null;
  loading: boolean;
  /**
   * Remove a block from the blend (by block_loc). The grid owns the source-of-truth
   * selection Set and re-runs `buildBlendProposal` for the reduced set, so the modal
   * numbers and the grid cell rings stay in sync. Optional — omitting it hides the
   * per-row remove control (read-only proposal). IGNORED in saved mode: a stored
   * version is immutable, and editing its block list goes through Modify.
   */
  onRemoveBlock?: (blockLoc: string) => void;
  /**
   * Client-side display preference from the Blocking "Prices" toggle — a HIDE-ONLY layer
   * on top of the server gate. Effective price visibility is `proposal.can_view_prices &&
   * showPrices`, so this can hide prices but never reveal them. Defaults to `true` (shown)
   * for callers that don't pass it.
   */
  showPrices?: boolean;
  /** Present → the dialog renders a SAVED version (history mode). */
  saved?: BlendSavedContext | null;
  /** Fresh mode only: save this blend as a brand-new proposal. */
  onSaveNew?: (input: { title: string; notes: string }) => Promise<boolean>;
  /** A save is in flight. */
  saving?: boolean;
}

/**
 * Centered modal (Dialog) result panel for the Blocking "Blend Proposal" mode. Shows the
 * selected blocks (with per-block balance, full lab results, and price), the
 * balance-weighted lab blend, the combined balance + block count, and (price-gated) the
 * raw blended ₱/kg plus the yield-adjusted product cost with the formula spelled out.
 *
 * TWO MODES, ONE COMPONENT. Without `saved` it is the live what-if it has always been.
 * With `saved` it renders a stored version — the same shape, because
 * `fetchBlendProposalVersion` returns exactly `BlendProposal` plus identity, so the
 * summary strip, the lab table, Print and PDF all work with no new code. What history
 * mode ADDS is a version rail, the title + remark as the header, and the Modify /
 * Compare / Edit / Archive actions. What it REMOVES is the per-row X: a saved version is
 * immutable, and changing its blocks is what Modify is for.
 *
 * Price gating: prices render ONLY when the EFFECTIVE flag is true — i.e.
 * `proposal.can_view_prices` (server gate, NEVER weakened) AND the `showPrices` display
 * preference AND the relevant value is non-null. The backend nulls all ₱ fields
 * server-side for Production users, so this component does NO role lookup — it relies
 * solely on the `can_view_prices` flag (ANDed with the display preference) + null checks.
 * The same effective flag gates the printed document AND the downloaded PDF. The per-block
 * lab columns are NOT gated.
 *
 * MOBILE (below `sm`): read-only. Blend Proposal selection mode is desktop-only, so
 * Save / Modify / Edit / Archive are hidden rather than offered and then refused, and a
 * one-line note says so. Viewing, comparing, printing and PDF all work.
 */
export function BlendProposalDialog({
  open,
  onOpenChange,
  proposal,
  loading,
  onRemoveBlock,
  showPrices: showPricesPref = true,
  saved = null,
  onSaveNew,
  saving = false,
}: BlendProposalDialogProps) {
  // EFFECTIVE visibility = server gate AND the client display preference. Hide-only:
  // `showPricesPref` can flip this off but can never turn the server gate back on.
  const showPrices = !!proposal?.can_view_prices && showPricesPref;

  // A saved version is immutable — the in-modal remove is disabled there by construction.
  const removeBlock = saved ? undefined : onRemoveBlock;

  // Identity for the printout / PDF. Absent in fresh mode → the documents render exactly
  // as they did before this feature existed.
  const docMeta: BlendDocMeta | null = saved
    ? {
        title: saved.proposal.title,
        notes: saved.proposal.notes,
        versionNo: saved.proposal.version_no,
        computedAt: saved.proposal.computed_at,
      }
    : null;

  const comparison = saved?.comparison ?? null;
  const changedLocs = new Set(comparison?.changedBlockLocs ?? []);
  const currentCodeByLoc = new Map(
    (comparison?.blocks ?? []).map((b) => [b.block_loc, b.currentBatchCode] as const),
  );

  // ── Download PDF (label prompt) ──
  const [pdfPopoverOpen, setPdfPopoverOpen] = useState(false);
  const [pdfLabel, setPdfLabel] = useState('');
  // Live filename preview / validity — empty after sanitize means "require a label".
  const previewFilename = composeBlendPdfFilename(pdfLabel);
  const labelValid = previewFilename !== null;

  // A saved proposal already HAS a name; default the PDF label to it rather than making
  // the operator retype it. Seeded when the popover OPENS so an edit inside it still sticks.
  const defaultPdfLabel = saved?.proposal.title ?? '';
  function handlePdfPopoverOpenChange(next: boolean) {
    setPdfPopoverOpen(next);
    setPdfLabel(next ? defaultPdfLabel : '');
  }

  async function handleDownloadPdf() {
    if (!proposal || !labelValid) return;
    try {
      // Lazy-load jsPDF only when the user actually downloads (PERF-4).
      const { downloadBlendPdf } = await import('./blend-proposal-pdf');
      // Pass the display preference so a hidden-prices PDF carries NO ₱ (the PDF builder
      // re-ANDs it with the server `can_view_prices`).
      downloadBlendPdf(proposal, pdfLabel, showPricesPref, docMeta);
      handlePdfPopoverOpenChange(false);
    } catch (err) {
      errorToast('Failed to generate PDF', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handlePrint() {
    if (!proposal) return;
    try {
      // Pass the display preference so a hidden-prices printout carries NO ₱ (the builder
      // re-ANDs it with the server `can_view_prices`).
      const html = buildBlendPrintDocument(proposal, showPricesPref, docMeta);
      const ok = printViaIframe(html);
      if (!ok) {
        errorToast('Could not open the print view', {
          description:
            'The browser blocked creating the hidden print frame. Try again, or use your browser menu (File → Print).',
        });
      }
    } catch (err) {
      errorToast('Failed to print blend proposal', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Column count for the per-block table footer/colspans (Block, Batch, Balance, 7 labs,
  // [PHP/KG], [remove]).
  const labCols = LAB_ORDER.length;

  const headerTitle = saved ? saved.proposal.title : 'Blend Proposal';
  const metaLine = saved
    ? [blendVersionLine(docMeta), saved.proposal.created_by_name].filter(Boolean).join(' · ')
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="animate-modal-enter w-[calc(100%-2rem)] max-w-4xl sm:max-w-4xl max-h-[85dvh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        {/* ── Header (actions + version rail live here; stays fixed while body scrolls) ── */}
        <DialogHeader className="shrink-0 bg-background/90 backdrop-blur-sm border-b border-border px-4 py-3 text-left gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10 text-primary shrink-0 mt-0.5">
                <Calculator className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <DialogTitle className="text-sm truncate max-w-[420px]" title={headerTitle}>
                    {headerTitle}
                  </DialogTitle>
                  {saved && <BlendStatusPill status={saved.status} fedOn={saved.fedOn} />}
                  {saved?.isArchived && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground">
                      <Archive className="w-2.5 h-2.5" />
                      Archived
                    </span>
                  )}
                </div>
                {/* The REMARK, in muted prose under the title. */}
                <DialogDescription className="text-xs">
                  {saved ? (
                    saved.proposal.notes ? (
                      <span className="line-clamp-2">{saved.proposal.notes}</span>
                    ) : (
                      <span className="italic opacity-70">No remark</span>
                    )
                  ) : (
                    <>
                      Weighted blend across{' '}
                      {proposal
                        ? `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'}`
                        : 'selected blocks'}
                    </>
                  )}
                </DialogDescription>
                {metaLine && <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{metaLine}</div>}
              </div>
            </div>

            {/* Header actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* In-flight indicator while a remove / version load re-runs the blend */}
              {(loading || saved?.busy) && proposal && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Updating blend" />
              )}

              {/* ── Save (fresh blend only; desktop only) ── */}
              {!saved && onSaveNew && (
                <span className="max-sm:hidden">
                  <SaveNewPopover busy={saving} onSave={onSaveNew} />
                </span>
              )}

              {/* ── Saved-mode actions ── */}
              {saved && (
                <>
                  {/* Compare is READ-ONLY, so it stays available on mobile too. */}
                  <button
                    onClick={comparison ? saved.onCloseCompare : saved.onCompare}
                    disabled={saved.compareLoading || !proposal}
                    aria-pressed={!!comparison}
                    data-blend-compare-toggle
                    className={cn(
                      'flex items-center justify-center w-7 h-7 rounded-md border transition-all duration-150 cursor-pointer',
                      'disabled:opacity-40 disabled:pointer-events-none',
                      comparison
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                    title={comparison ? 'Hide the comparison with today' : 'Compare this version with today'}
                    aria-label="Compare with today"
                  >
                    {saved.compareLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <GitCompare className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <span className="max-sm:hidden flex items-center gap-1.5">
                    <button
                      onClick={saved.onModify}
                      disabled={saved.busy || saved.isArchived}
                      data-blend-modify
                      className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-border
                                 text-[11px] font-semibold text-muted-foreground
                                 hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer
                                 disabled:opacity-40 disabled:pointer-events-none"
                      title={
                        saved.isArchived
                          ? 'Restore this proposal before modifying it'
                          : 'Re-select these blocks on the grid and save a new version'
                      }
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Modify
                    </button>

                    <HeaderEditPopover
                      title={saved.proposal.title}
                      notes={saved.proposal.notes}
                      status={saved.status}
                      fedOn={saved.fedOn}
                      busy={saved.busy}
                      onSave={saved.onSaveHeader}
                    />

                    <button
                      onClick={saved.onArchiveToggle}
                      disabled={saved.busy}
                      className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                                 text-muted-foreground hover:text-foreground hover:bg-muted
                                 transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                      title={saved.isArchived ? 'Restore this proposal' : 'Archive this proposal (never deleted)'}
                      aria-label={saved.isArchived ? 'Restore proposal' : 'Archive proposal'}
                    >
                      {saved.isArchived ? (
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      ) : (
                        <Archive className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </span>
                </>
              )}

              {/* Download PDF — prompts for a label via a Popover, then saves YYMMDD - {label}.pdf */}
              <Popover open={pdfPopoverOpen} onOpenChange={handlePdfPopoverOpenChange}>
                <PopoverTrigger asChild>
                  <button
                    disabled={!proposal || loading}
                    className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                               text-muted-foreground hover:text-foreground hover:bg-muted
                               transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                    title="Download as PDF"
                    aria-label="Download blend proposal as PDF"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-72 bg-popover/95 backdrop-blur-lg p-3">
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-foreground">Download PDF</div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      Name this proposal. The file is saved as{' '}
                      <span className="font-mono text-foreground">YYMMDD - label.pdf</span>.
                    </p>
                    <Input
                      autoFocus
                      value={pdfLabel}
                      onChange={(e) => setPdfLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && labelValid) {
                          e.preventDefault();
                          handleDownloadPdf();
                        }
                      }}
                      placeholder="e.g. 4x8 RUN"
                      className="h-8 text-xs"
                      aria-label="PDF label"
                    />
                    {/* Live filename preview */}
                    <div className="text-[10px] font-mono text-muted-foreground truncate min-h-[14px]">
                      {labelValid ? previewFilename : <span className="italic">Enter a label to enable download</span>}
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handlePdfPopoverOpenChange(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!labelValid}
                        onClick={handleDownloadPdf}
                      >
                        <Download className="w-3 h-3" />
                        Download
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <button
                onClick={handlePrint}
                disabled={!proposal || loading}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                title="Print blend proposal"
                aria-label="Print blend proposal"
              >
                <Printer className="w-3.5 h-3.5" />
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

          {/* ── Version rail (saved mode only) ── */}
          {saved && saved.versions.length > 0 && (
            <VersionRail
              versions={saved.versions}
              selected={saved.proposal.version_no}
              onSelect={saved.onSelectVersion}
              disabled={saved.busy}
            />
          )}

          {/* Mobile: say what is unavailable rather than silently omitting it. */}
          <p className="sm:hidden text-[10px] text-muted-foreground leading-snug">
            Read-only on a phone &mdash; saving and modifying a blend need the grid, which is desktop-only. Viewing,
            comparing and printing all work here.
          </p>
        </DialogHeader>

        {/* ── Body (scrolls internally) ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {!proposal ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* ── Compare banner ── */}
              {comparison && (
                <div className="rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span className="text-[11px] text-foreground">
                    Comparing this version with the yard <span className="font-semibold">today</span>. The saved
                    numbers are never changed.
                    {comparison.changedBlockLocs.length > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        {comparison.changedBlockLocs.length === 1
                          ? '1 block now holds a different batch.'
                          : `${comparison.changedBlockLocs.length} blocks now hold a different batch.`}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={saved?.onCloseCompare}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer shrink-0"
                  >
                    Hide
                  </button>
                </div>
              )}

              {/* ── Totals ── */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Total Balance</div>
                  <div className="text-sm font-bold font-mono text-foreground">
                    {formatKg(proposal.total_balance)}{' '}
                    <span className="text-xs font-normal text-muted-foreground">kg</span>
                  </div>
                  {comparison && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      today{' '}
                      <span className="font-mono text-foreground">
                        {comparison.totalBalance.after === null ? EMDASH : formatKg(comparison.totalBalance.after)}
                      </span>{' '}
                      <Delta value={comparison.totalBalance.delta} decimals={0} grouped />
                    </div>
                  )}
                </div>
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Blocks</div>
                  <div className="text-sm font-bold font-mono text-foreground">{proposal.block_count}</div>
                  {comparison && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      today{' '}
                      <span className="font-mono text-foreground">{comparison.blockCount.after ?? EMDASH}</span>{' '}
                      <Delta value={comparison.blockCount.delta} decimals={0} />
                    </div>
                  )}
                </div>
              </div>

              {/* ── Weighted lab blend ── */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Blended Lab Stats (Weighted Avg)
                  {comparison && <span className="ml-1.5 font-normal normal-case">— saved / today / change</span>}
                </div>
                {/* Never crush, always scroll: each stat keeps an intrinsic minimum and the
                    STRIP scrolls when the viewport is narrower. Before this, a phone
                    rendered `10.…` / `0.4…` — a truncated lab number is worse than no
                    lab number, because it still looks like a reading. */}
                <div className="flex gap-1 overflow-x-auto pb-0.5">
                  {LAB_ORDER.map(({ key, label }) => {
                    const d = comparison?.weighted[key as BlendLabKey] ?? null;
                    const dp = blendLabDecimals(key as BlendLabKey);
                    return (
                      <div
                        key={key}
                        className={cn(
                          'flex-1 rounded-md border border-border px-1 py-1 text-center',
                          comparison ? 'min-w-[72px]' : 'min-w-[62px]',
                        )}
                      >
                        <div className="text-[8px] font-medium text-muted-foreground uppercase">{label}</div>
                        <div className="text-xs font-mono font-bold text-foreground whitespace-nowrap">
                          {formatLab(key, proposal.weighted[key])}
                        </div>
                        {d && (
                          <>
                            <div className="text-[9px] font-mono text-muted-foreground whitespace-nowrap">
                              {d.after === null ? EMDASH : d.after.toFixed(dp)}
                            </div>
                            <div className="text-[9px] whitespace-nowrap">
                              <Delta value={d.delta} decimals={dp} />
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── Pricing (role-gated) ── */}
              {showPrices && proposal.raw_price_per_kg !== null && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pricing
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Raw blended price</span>
                    <span className="font-mono font-bold text-foreground inline-flex items-baseline gap-0.5">
                      <span className="text-muted-foreground font-normal">&#8369;</span>
                      {pesoNum(proposal.raw_price_per_kg)}
                      <span className="text-[10px] font-normal text-muted-foreground">/kg</span>
                    </span>
                  </div>
                  {comparison && (
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>today</span>
                      <span className="font-mono">
                        {comparison.rawPrice.after === null ? EMDASH : `₱${pesoNum(comparison.rawPrice.after)}`}
                        <span className="ml-1.5">
                          <Delta value={comparison.rawPrice.delta} decimals={2} />
                        </span>
                      </span>
                    </div>
                  )}

                  {proposal.product_cost_per_kg !== null && (
                    <>
                      <div className="flex items-center justify-between text-xs pt-1.5 border-t border-border">
                        <span className="text-foreground font-semibold">Product cost</span>
                        <span className="font-mono font-bold text-foreground inline-flex items-baseline gap-0.5">
                          <span className="text-muted-foreground font-normal">&#8369;</span>
                          {pesoNum(proposal.product_cost_per_kg)}
                          <span className="text-[10px] font-normal text-muted-foreground">/kg</span>
                        </span>
                      </div>
                      {comparison && (
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>today</span>
                          <span className="font-mono">
                            {comparison.productCost.after === null
                              ? EMDASH
                              : `₱${pesoNum(comparison.productCost.after)}`}
                            <span className="ml-1.5">
                              <Delta value={comparison.productCost.delta} decimals={2} />
                            </span>
                          </span>
                        </div>
                      )}
                      {/* Transparent formula */}
                      <div className="text-[10px] font-mono text-muted-foreground leading-relaxed bg-background/50 rounded px-2 py-1.5">
                        Raw blend &#8369;{pesoNum(proposal.raw_price_per_kg)} &times;{' '}
                        {(1 + proposal.production_loss_pct / 100).toFixed(2)} ({proposal.production_loss_pct}% production
                        loss) = &#8369;{pesoNum(proposal.product_cost_per_kg)} /kg product cost
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── Selected blocks (Excel-dense; per-block lab columns) ── */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Selected Blocks
                </div>
                {/* Horizontal scroll if the wide lab table overflows — never shrink columns illegibly.
                    Dim + disable while a remove re-fetch is in flight so stale rows don't look interactive. */}
                <div
                  className={cn(
                    'rounded-md overflow-x-auto bg-muted border border-border transition-opacity duration-150',
                    loading && 'opacity-60 pointer-events-none',
                  )}
                >
                  <table className="w-full min-w-[640px] border-collapse">
                    <thead>
                      <tr>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Block
                        </th>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Batch
                        </th>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Balance
                        </th>
                        {LAB_ORDER.map(({ label }) => (
                          <th
                            key={label}
                            className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap"
                          >
                            {label}
                          </th>
                        ))}
                        {showPrices && (
                          <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap">
                            PHP/KG
                          </th>
                        )}
                        {removeBlock && <th className="w-[28px] border-b border-border" />}
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.blocks.map((b) => (
                        <BlockRow
                          key={b.block_loc}
                          block={b}
                          showPrices={showPrices}
                          onRemove={removeBlock ? () => removeBlock(b.block_loc) : undefined}
                          removeDisabled={loading}
                          changed={changedLocs.has(b.block_loc)}
                          currentBatchCode={currentCodeByLoc.get(b.block_loc) ?? null}
                        />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/50">
                        <td
                          className="text-[9px] font-semibold text-muted-foreground uppercase px-1.5 py-1 whitespace-nowrap"
                          colSpan={2}
                        >
                          Total
                        </td>
                        <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1 whitespace-nowrap">
                          {formatKg(proposal.total_balance)} kg
                        </td>
                        {/* Empty cells under the lab columns */}
                        <td colSpan={labCols} />
                        {showPrices && <td />}
                        {removeBlock && <td />}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {comparison && comparison.missingBlockLocs.length > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    No longer on the grid:{' '}
                    <span className="font-mono text-foreground">{comparison.missingBlockLocs.join(', ')}</span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
