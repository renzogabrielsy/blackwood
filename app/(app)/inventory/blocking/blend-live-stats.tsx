'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE BLEND STATS — the running total / weighted averages of the blocks picked
// so far, shown in the blend action bar while blend mode is on (Renzo, 2026-09-25:
// "so we have a good idea how the picks are going and not just randomly clicking").
//
// TWO RULES THIS FILE EXISTS TO KEEP:
//
//   1. EVERY NUMBER COMES OUT OF SQL. The hook calls a `fetcher` — in the app that is
//      `buildBlendProposal(locs)`, which wraps `fn_blend_proposal`, THE one definition the
//      modal and the saved snapshot also use. Nothing here sums a kilogram, weights a lab
//      stat or multiplies a price by 1.30. The only arithmetic is the Modify-session DELTA,
//      and that goes through `makeBlendDelta` — the one subtraction `blend-diff.ts` owns —
//      over two DB-computed figures.
//
//   2. A STALE REPLY NEVER PAINTS A NEWER SELECTION. Replies are guarded by the request's
//      SIGNATURE (the sorted block list), never by a monotonic counter: a counter is what
//      made the 2026-09-21 lens stall unrecoverable, because a remount reset it and every
//      reply after that looked stale. The first read after the bar is enabled fires on the
//      SAME frame (a debounce-only read is cancelled by any remount that lands inside the
//      timer); later reads are debounced. A read that never answers trips a WATCHDOG so the
//      operator gets Copy + Retry instead of an eternal spinner.
//
// The hook lives in `BlockingGrid` (which the route never remounts on a URL change), not in
// the bar, so toggling the bar's visibility cannot orphan a request either.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Loader2, RotateCw, Sigma } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  BLEND_LAB_KEYS,
  blendLabDecimals,
  formatSignedDelta,
  makeBlendDelta,
  type BlendComparable,
  type BlendLabKey,
} from '@/lib/blocking/blend-diff';
import type { BlendProposal } from './actions';

// ─── Signature ────────────────────────────────────────────────────────────────

/** Block locs never contain a newline, so it is a safe separator for the signature. */
const SIGNATURE_SEPARATOR = '\n';

/**
 * THE identity of a live-blend request: the selection's block locs, trimmed, de-duplicated
 * and SORTED, so the same set of blocks picked in any order is the same request.
 * An empty selection is the empty string.
 */
export function blendSelectionSignature(locs: Iterable<string>): string {
  const set = new Set<string>();
  for (const raw of locs) {
    const l = (raw ?? '').trim();
    if (l) set.add(l);
  }
  return Array.from(set).sort().join(SIGNATURE_SEPARATOR);
}

/** The block list a signature stands for (inverse of `blendSelectionSignature`). */
export function blendSignatureLocs(signature: string): string[] {
  return signature ? signature.split(SIGNATURE_SEPARATOR) : [];
}

/**
 * Should a reply be painted? Only when it answers the selection that is on screen NOW.
 * Exported so the verify script can pin the rule without a renderer.
 */
export function acceptBlendReply(latestSignature: string, replySignature: string): boolean {
  return latestSignature !== '' && latestSignature === replySignature;
}

// ─── The hook ─────────────────────────────────────────────────────────────────

/** The port: hand it block locs, get the DB-computed blend back. */
export type BlendStatsFetcher = (blockLocs: string[]) => Promise<BlendProposal>;

export const BLEND_LIVE_STATS_DEBOUNCE_MS = 250;
export const BLEND_LIVE_STATS_WATCHDOG_MS = 12_000;

export interface BlendLiveStats {
  /** The selection on screen right now ('' = nothing picked). */
  signature: string;
  /** The last blend that came back — possibly for an OLDER selection (see `valueSignature`). */
  value: BlendProposal | null;
  /** Which selection `value` describes. `value` is current iff this equals `signature`. */
  valueSignature: string | null;
  /** A read for the current selection is outstanding (debouncing or in flight). */
  pending: boolean;
  /** The read for the current selection failed — the full, copyable message. */
  error: string | null;
  /** The read for the current selection has been outstanding past the watchdog. */
  stalled: boolean;
  /** Fire the current selection's read again (after an error or a stall). */
  retry: () => void;
  /** The watchdog threshold, for the sentence that explains a stall. */
  watchdogMs: number;
}

export function useBlendLiveStats({
  enabled,
  selection,
  fetcher,
  debounceMs = BLEND_LIVE_STATS_DEBOUNCE_MS,
  watchdogMs = BLEND_LIVE_STATS_WATCHDOG_MS,
}: {
  enabled: boolean;
  selection: Iterable<string>;
  fetcher: BlendStatsFetcher;
  debounceMs?: number;
  watchdogMs?: number;
}): BlendLiveStats {
  // `selection` is a fresh Set on every click; the signature is what identifies it.
  const selectionSignature = blendSelectionSignature(selection);
  const signature = enabled ? selectionSignature : '';
  const locs = useMemo(() => blendSignatureLocs(signature), [signature]);

  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ signature: string; value: BlendProposal } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [stalledKey, setStalledKey] = useState<string | null>(null);

  /** The selection on screen, as of the last committed render — THE reply guard. */
  const latestSignatureRef = useRef('');
  /** `${signature}#${attempt}` of the last read fired; null = nothing fired since enable. */
  const firedKeyRef = useRef<string | null>(null);
  /** The selection of the last read fired — tells a RETRY (same selection) from a change. */
  const firedSignatureRef = useRef<string | null>(null);
  /** Which selection `result` describes — lets a return to it skip a re-read. */
  const resultSignatureRef = useRef<string | null>(null);
  /** The request key whose read FAILED — a return to it shows the failure, not a re-read. */
  const failedKeyRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const requestKey = `${signature}#${attempt}`;

  useEffect(() => {
    latestSignatureRef.current = signature;
    if (!signature) {
      // Disabled or nothing picked: nothing to read. The next pick is a FIRST read again,
      // so it fires on its own frame rather than waiting out a debounce.
      firedKeyRef.current = null;
      firedSignatureRef.current = null;
      return;
    }
    if (firedKeyRef.current === requestKey) return; // already asked this exact question
    const isRetry = firedSignatureRef.current === signature;
    if (!isRetry && (resultSignatureRef.current === signature || failedKeyRef.current === requestKey)) {
      // Back to a selection whose answer is already known (A → B → A before B landed).
      firedKeyRef.current = requestKey;
      firedSignatureRef.current = signature;
      return;
    }

    const fire = () => {
      firedKeyRef.current = requestKey;
      firedSignatureRef.current = signature;
      const replySignature = signature;
      fetcherRef
        .current(locs)
        .then((value) => {
          if (!aliveRef.current || !acceptBlendReply(latestSignatureRef.current, replySignature)) return;
          resultSignatureRef.current = replySignature;
          setResult({ signature: replySignature, value });
        })
        .catch((err: unknown) => {
          if (!aliveRef.current || !acceptBlendReply(latestSignatureRef.current, replySignature)) return;
          const detail = err instanceof Error ? err.message : String(err);
          failedKeyRef.current = requestKey;
          setFailure({
            key: requestKey,
            message: `Could not compute the running blend for ${locs.length} block${
              locs.length === 1 ? '' : 's'
            } (${locs.join(', ')}): ${detail || 'no reply from the server'}`,
          });
        });
    };

    // The FIRST read since the bar was enabled, and a Retry, fire NOW, on this frame. A
    // request that only lives inside a timer is cancelled by any remount that lands before
    // it fires (2026-09-21). Only a CHANGE of selection waits out the debounce.
    if (firedKeyRef.current === null || isRetry) {
      fire();
      return;
    }
    const timer = setTimeout(fire, debounceMs);
    return () => clearTimeout(timer);
  }, [signature, requestKey, locs, debounceMs]);

  const valueSignature = result?.signature ?? null;
  const error = failure && failure.key === requestKey ? failure.message : null;
  const pending = signature !== '' && valueSignature !== signature && error === null;

  // ── Watchdog: an eternal spinner is a silent failure. ──
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      if (aliveRef.current) setStalledKey(requestKey);
    }, watchdogMs);
    return () => clearTimeout(timer);
  }, [pending, requestKey, watchdogMs]);

  const stalled = pending && stalledKey === requestKey;

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    signature,
    value: result?.value ?? null,
    valueSignature,
    pending,
    error,
    stalled,
    retry,
    watchdogMs,
  };
}

// ─── The row ──────────────────────────────────────────────────────────────────

/** Lab labels — the SAME labels, order and decimals the blend proposal modal uses. */
const LAB_LABELS: Record<BlendLabKey, string> = {
  mc: 'MC',
  ash: 'ASH',
  bd_astm: 'BD ASTM',
  bd_jis: 'BD JIS',
  grit: 'GRIT',
  vm: 'VM',
  fc: 'FC',
};

const EMDASH = '—';

function formatKg(val: number): string {
  return Math.round(val).toLocaleString();
}

function pesoNum(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function copyText(text: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success('Error copied to clipboard', { duration: 2000 }))
    .catch(() => {
      /* clipboard unavailable — the message is still on screen */
    });
}

/** One stat tile: label on top, right-aligned mono value, optional delta line. */
function StatCell({
  label,
  children,
  delta,
  widthClass,
  stat,
}: {
  label: string;
  children: ReactNode;
  delta?: string | null;
  widthClass: string;
  stat: string;
}) {
  return (
    <div
      data-blend-live-stat={stat}
      className={cn('shrink-0 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5', widthClass)}
    >
      <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground leading-tight whitespace-nowrap">
        {label}
      </div>
      <div className="text-xs font-mono font-semibold text-foreground text-right leading-tight whitespace-nowrap">
        {children}
      </div>
      {delta !== undefined && (
        <div
          data-blend-live-delta={stat}
          className="text-[9px] font-mono text-muted-foreground text-right leading-tight whitespace-nowrap"
        >
          {delta ?? EMDASH}
        </div>
      )}
    </div>
  );
}

/** ₱ pinned left, number pinned right — the accounting format. */
function Peso({ value }: { value: number | null }) {
  if (value === null) return <>{EMDASH}</>;
  return (
    <span className="flex justify-between gap-1">
      <span className="text-muted-foreground font-normal">&#8369;</span>
      <span>{pesoNum(value)}</span>
    </span>
  );
}

export interface BlendLiveStatsRowProps {
  stats: BlendLiveStats;
  /**
   * The grid's EFFECTIVE price flag (`serverCanViewPrices && showPrices`). False → the two
   * ₱ tiles are not rendered at all — not an em dash, not a reserved gap.
   */
  canViewPrices: boolean;
  /**
   * The saved version being MODIFIED, when there is one. Each tile then shows the change
   * against it (one `makeBlendDelta` per figure — a subtraction of two DB numbers).
   */
  baseline?: BlendComparable | null;
  /** The label for the baseline in the delta tooltip, e.g. `v3`. */
  baselineLabel?: string;
}

/**
 * The live stats strip. Never crush, always scroll: every tile keeps its width and the
 * STRIP scrolls sideways when the bar is narrower than it.
 */
export function BlendLiveStatsRow({ stats, canViewPrices, baseline = null, baselineLabel }: BlendLiveStatsRowProps) {
  const { signature, value, valueSignature, pending, error, stalled, retry, watchdogMs } = stats;

  if (!signature) {
    return (
      <div
        data-blend-live-stats="empty"
        className="flex items-center justify-center gap-1.5 h-9 text-[11px] text-muted-foreground"
      >
        <Sigma className="w-3.5 h-3.5" />
        Pick blocks to see the running blend
      </div>
    );
  }

  const current = valueSignature === signature;
  const showPrices = canViewPrices && (value?.can_view_prices ?? false);
  const deltaFor = (before: number | null | undefined, after: number | null | undefined, dp: number, grouped = false) =>
    baseline ? formatSignedDelta(makeBlendDelta(before, after).delta, dp, grouped) : undefined;

  const problem =
    error ??
    (stalled
      ? `The running blend has not answered in ${Math.round(watchdogMs / 1000)} seconds — the database may be busy.`
      : null);

  return (
    <div data-blend-live-stats={current ? 'current' : 'updating'} className="flex flex-col gap-1 min-w-0">
      <div className="flex items-stretch gap-1 overflow-x-auto min-w-0 pb-0.5" aria-live="polite" aria-busy={pending}>
        {/* Status slot — a fixed size so the spinner never shifts the tiles. */}
        <div
          className="shrink-0 flex flex-col items-center justify-center w-7 gap-0.5"
          title={
            pending
              ? 'Updating the running blend…'
              : baseline
                ? `Running blend of the current selection — the small figure is the change against ${baselineLabel ?? 'the saved version'}`
                : 'Running blend of the current selection, computed by the database'
          }
        >
          {pending ? (
            <Loader2 data-blend-live-spinner className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : (
            <Sigma className="w-3.5 h-3.5 text-primary" />
          )}
          {baseline && (
            <span className="text-[8px] font-mono leading-none text-muted-foreground whitespace-nowrap">
              vs {baselineLabel ?? 'saved'}
            </span>
          )}
        </div>

        <div
          className={cn(
            'flex items-stretch gap-1 transition-opacity duration-150',
            (!current || !value) && 'opacity-50',
          )}
        >
          <StatCell
            stat="blocks"
            label="Blocks"
            widthClass="w-[48px]"
            delta={deltaFor(baseline?.block_count, value?.block_count, 0)}
          >
            {value ? value.block_count : EMDASH}
          </StatCell>
          <StatCell
            stat="balance"
            label="Total Balance kg"
            widthClass="w-[104px]"
            delta={deltaFor(baseline?.total_balance, value?.total_balance, 0, true)}
          >
            {value ? formatKg(value.total_balance) : EMDASH}
          </StatCell>
          {showPrices && (
            <>
              <StatCell
                stat="raw_price"
                label="Raw ₱/kg"
                widthClass="w-[76px]"
                delta={deltaFor(baseline?.raw_price_per_kg, value?.raw_price_per_kg, 2)}
              >
                <Peso value={value?.raw_price_per_kg ?? null} />
              </StatCell>
              <StatCell
                stat="product_cost"
                label="Product ₱/kg"
                widthClass="w-[80px]"
                delta={deltaFor(baseline?.product_cost_per_kg, value?.product_cost_per_kg, 2)}
              >
                <Peso value={value?.product_cost_per_kg ?? null} />
              </StatCell>
            </>
          )}
          {BLEND_LAB_KEYS.map((key) => {
            const dp = blendLabDecimals(key);
            return (
              <StatCell
                key={key}
                stat={key}
                label={LAB_LABELS[key]}
                widthClass="w-[56px]"
                delta={deltaFor(baseline?.weighted[key], value?.weighted[key], dp)}
              >
                {value ? value.weighted[key].toFixed(dp) : EMDASH}
              </StatCell>
            );
          })}
        </div>
      </div>

      {problem && (
        <div
          data-blend-live-error
          role="alert"
          className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
        >
          <span className="min-w-0 flex-1 truncate" title={problem}>
            {problem}
            {value ? ' The figures above are for an earlier selection.' : ''}
          </span>
          <button
            type="button"
            onClick={() => copyText(problem)}
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-destructive/15 transition-colors duration-150 cursor-pointer"
            title="Copy the full error text"
          >
            <Copy className="w-3 h-3" />
            Copy
          </button>
          <button
            type="button"
            onClick={retry}
            data-blend-live-retry
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-destructive/15 transition-colors duration-150 cursor-pointer"
          >
            <RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
