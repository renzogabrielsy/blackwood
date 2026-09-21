'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE BLEND ANALYSIS READ — one payload, fetched once per thing that changes it.
//
// `fetchBlendAnalysis` answers the whole of the extra pages in ONE call: the price
// groups (natural breaks), the price-lens comparison against market, the four
// quality metrics and the age bands. So this hook is deliberately small — it decides
// WHEN to ask, and nothing else. Every figure it hands on is the payload's own; there
// is not one sum, share or average anywhere in this file or in the components that
// render it (`scripts/verify-blend-analysis-ui.ts` asserts the absence statically).
//
// ── FIRST REQUEST ON THE MOUNT FRAME, AND THE GUARD IS A SIGNATURE ──────────
// Both disciplines are borrowed from the price lens's 2026-09-21 stall bug, which is
// the exact shape a modal read would repeat. There, every request was created INSIDE
// a 250 ms `setTimeout` whose cleanup ran on every effect re-run: anything that
// re-rendered the host destroyed the pending timer before it fired, no request was
// ever issued, and the panel sat on a spinner forever with no error and no Retry.
//
//   • THERE IS NO DEBOUNCE HERE AT ALL. The inputs are discrete events — the dialog
//     opening, a version switch, a checkbox — not keystrokes, so a debounce would
//     only ever be a timer to lose.
//   • The guard is the request's own SIGNATURE, never a monotonic counter: a reply
//     for what is currently wanted is ALWAYS applied, whatever else re-ran in the
//     meantime, and a reply for a superseded request is still dropped. A counter is
//     what made the lens's stall unrecoverable.
//   • A read that never lands SAYS SO after `LENS_STALL_MS`, with Copy and Retry —
//     the project's error HARD RULE, satisfied inline (a refusal about a panel's own
//     pages would be homeless as a toast the moment the dialog closed).
//
// ── ONE SOURCE, DECIDED BY THE CALLER ───────────────────────────────────────
// A SAVED version passes `{proposalId, versionNo}` and the database reads its STORED
// snapshot verbatim (and dates the age section from that version's own day). A live
// what-if passes `{blockLocs}`. Both at once is a refusal by contract, so the hook
// takes a discriminated source and can never send both.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { errorToast } from '@/lib/toast';

import { fetchBlendAnalysis } from '../blocking/actions';
import { LENS_STALL_MS } from '../blocking/lens/lens-shared';
import type {
  BlendAnalysis,
  BlendAnalysisInput,
  BlendAnalysisResult,
} from '../blocking/types';

/** Which blend is being analysed. EXACTLY one shape — never both. */
export type BlendAnalysisSourceInput =
  | { kind: 'saved'; proposalId: string; versionNo: number }
  | { kind: 'live'; blockLocs: readonly string[] };

/**
 * The read's PORT — the adapter idiom the lens panels carry, at the same tiny scale.
 *
 * The default IS the server action and is what production always uses. It is
 * injectable for exactly one reason, the one both lens fixtures record: the gated dev
 * rig has no session, so the real action can only ever refuse there, and pages that
 * can only be LOOKED at in their refusal state cannot be reviewed for layout, colour
 * or wording.
 */
export type BlendAnalysisAdapter = (input: BlendAnalysisInput) => Promise<BlendAnalysisResult>;

export interface UseBlendAnalysisArgs {
  /** False while the dialog is shut, or while no page that needs a payload is ticked. */
  enabled: boolean;
  source: BlendAnalysisSourceInput | null;
  /** The reader's saved PRICE-lens cut lines, as offsets from R. */
  priceEdgeOffsets: readonly number[];
  /** The reader's saved AGE-lens cut lines, in days. */
  ageEdgeDays: readonly number[];
  /** A typed market ₱/kg (the price lens's `manual` basis). Null = measure it. */
  marketPhpKg?: number | null;
  /** THE cut line for a typed market — `Math.ceil(typed)`. Null for a measured basis. */
  roundedUpPhp?: number | null;
  adapter?: BlendAnalysisAdapter;
}

export interface UseBlendAnalysisState {
  analysis: BlendAnalysis | null;
  /** A read is in flight. */
  loading: boolean;
  /** The refusal's own sentence, written for a human. Shown inline with Copy. */
  refusal: string | null;
  /** The read never came back. Shown inline with Copy and Retry. */
  stalled: boolean;
  retry: () => void;
}

export function useBlendAnalysis({
  enabled,
  source,
  priceEdgeOffsets,
  ageEdgeDays,
  marketPhpKg = null,
  roundedUpPhp = null,
  adapter,
}: UseBlendAnalysisArgs): UseBlendAnalysisState {
  const [analysis, setAnalysis] = React.useState<BlendAnalysis | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [stalled, setStalled] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  // Held in a ref so a caller passing an inline adapter cannot re-trigger the read
  // on every render.
  const adapterRef = React.useRef(adapter);
  React.useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  const priceKey = priceEdgeOffsets.join(',');
  const ageKey = ageEdgeDays.join(',');
  const sourceKey =
    source === null
      ? ''
      : source.kind === 'saved'
        ? `saved:${source.proposalId}:${source.versionNo}`
        : `live:${[...source.blockLocs].join('|')}`;
  const signature = `${sourceKey}|${priceKey}|${ageKey}|${marketPhpKg ?? ''}|${roundedUpPhp ?? ''}`;

  /** The signature the caller currently wants a payload for. */
  const wantRef = React.useRef('');
  const watchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchdog = React.useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!enabled || sourceKey === '') {
      wantRef.current = '';
      stopWatchdog();
      setLoading(false);
      setStalled(false);
      return;
    }

    wantRef.current = signature;
    setLoading(true);
    setStalled(false);

    const input: BlendAnalysisInput = {
      priceEdgeOffsets: priceKey === '' ? null : priceKey.split(',').map(Number),
      ageEdgeDays: ageKey === '' ? null : ageKey.split(',').map(Number),
      marketPhpKg,
      roundedUpPhp,
    };
    if (sourceKey.startsWith('saved:')) {
      const [, id, v] = sourceKey.split(':');
      input.proposalId = id;
      input.versionNo = Number(v);
    } else {
      input.blockLocs = sourceKey.slice('live:'.length).split('|');
    }

    stopWatchdog();
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      if (wantRef.current === signature) setStalled(true);
    }, LENS_STALL_MS);

    // FIRED ON THIS FRAME — see the header note. No timer to lose.
    void (adapterRef.current ?? fetchBlendAnalysis)(input)
      .then((res) => {
        // A reply for the signature still wanted is ALWAYS applied.
        if (wantRef.current !== signature) return;
        if (res.ok) {
          setAnalysis(res.analysis);
          setRefusal(null);
          return;
        }
        // The previous payload STAYS: a refusal about a new request is not a reason
        // to blank the pages the reader is looking at.
        setRefusal(res.message);
      })
      .catch((err: unknown) => {
        if (wantRef.current !== signature) return;
        errorToast('Could not work out the analysis pages', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (wantRef.current !== signature) return;
        // The read ANSWERED — payload or refusal. Stop the watchdog before it can
        // call a healthy panel stalled eight seconds later.
        stopWatchdog();
        setLoading(false);
        setStalled(false);
      });

    return stopWatchdog;
  }, [
    enabled,
    sourceKey,
    priceKey,
    ageKey,
    marketPhpKg,
    roundedUpPhp,
    signature,
    nonce,
    stopWatchdog,
  ]);

  const retry = React.useCallback(() => setNonce((n) => n + 1), []);

  return { analysis, loading, refusal, stalled, retry };
}
