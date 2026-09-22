'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE PRICE LENS — "show me the blocks above market", on the grid itself.
//
// Renzo, 2026-09-19: see the Blocking grid *"ratio'd in highlights based on price
// filter"* — if market is 40.23 then ₱41 and up is above market.
//
// ── THIS FILE COMPUTES NO STATISTIC. ────────────────────────────────────────
// Every kilogram, every block count, every share percentage and every band
// membership is read verbatim out of `fetchBlockingPriceLens`'s payload. There is
// no `reduce`, no running total and no division by a total anywhere below, because
// a lens that re-derived its own shares could disagree with the SQL that drew the
// bands — and the one thing a distribution picture must never do is disagree with
// itself. `scripts/verify-blocking-lens-ui.ts` asserts the absence statically.
// The ratio bar works because the payload's shares already sum to 100 (proven by
// `scripts/verify-blocking-price-lens.ts` against the live database), so each
// segment's width IS its published share.
//
// ── R IS NOT COMPUTED HERE EITHER ───────────────────────────────────────────
// `R = floor(market) + 1` lives in SQL and is returned as `lens.roundedUpPhp`.
// This file only ever ECHOES it, and the labels derive their bounds from the
// band's own `lowerPhp`/`upperPhp`. (`verify-blocking-price-lens.ts` asserts that
// no `floor`/`Math.floor` exists in the TypeScript at all.)
//
// ── NULL IS NEVER ZERO, TWICE ───────────────────────────────────────────────
// 1. A basis with no priced market kilos returns `marketPhpKg: null`. It is shown
//    as a sentence offering the other bases — never coerced, because a lens built
//    on ₱0 would call every block in the yard "above market".
// 2. A block with no price (`avg_php_kg` 0, the L-008 placeholder) is ABSENT from
//    `bandByBlock`. It is rendered in its NORMAL un-lensed style and reported on a
//    separate muted row, never inside the cheapest band. That is the
//    ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume and it is refused here.
//
// ── THE GATE IS A REFUSAL, SO A REFUSAL CLOSES THE LENS ─────────────────────
// Band membership alone pins a block's ₱/kg to within a peso, so there is no
// price-free half of this payload and the two actions refuse a `!canViewPrices()`
// caller outright. `prices_hidden` is therefore handled QUIETLY — the panel closes
// and says nothing, because it is a fact about the reader, not an error they can
// act on. Every other refusal is shown inline with a Copy button (the project's
// error rule, satisfied by a banner rather than a toast); a thrown error goes to
// `errorToast()`.
//
// ── THE ROWS, THE BAR AND THE DISCLOSURE ARE SHARED WITH THE AGE LENS ───────
// The legend, the stacked ratio bar, the kg|blocks switch, the muted "in no band"
// row, the inline refusal banner and the Customize scaffolding live in `lens/` and
// are used by BOTH lenses. What stays here is what is actually about PRICE: the
// market basis, R, the ₱ labels, the price gate and the two reads. A second lens
// that forked those pieces is how one of them quietly loses its Copy button or
// prints a share in a different unit from its bar.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { AlertTriangle, Coins, Loader2 } from 'lucide-react';

import { errorToast } from '@/lib/toast';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { fetchBlockingMarketBases, fetchBlockingPriceLens } from '../actions';
import {
  BLOCKING_PRICE_LENS_MAX_EDGES,
  BLOCKING_TRAILING_DAYS_MAX,
  BLOCKING_TRAILING_DAYS_MIN,
  type BlockingMarketBasesResult,
  type BlockingMarketBasis,
  type BlockingPriceBand,
  type BlockingPriceLens,
  type BlockingPriceLensResult,
} from '../types';
import type {
  BlockingLensClassifier,
  BlockingLensDefinition,
  BlockingLensPanelProps,
} from './types';
import { useLensSettings } from './use-lens-settings';
import {
  LensBandChips,
  LensBandRows,
  LensExcludedChip,
  LensExcludedRow,
  LensUnitSwitch,
} from './lens-band-rows';
import { LensCustomize, type LensBandNameField, type LensCutLineChip } from './lens-customize';
import { LensRatioBar } from './lens-ratio-bar';
import { RefusalBanner } from './lens-refusal-banner';
import { LensSettingsPopover } from './lens-settings-popover';
import {
  LensSummaryPrintControl,
  type LensSummaryPrintModel,
} from './lens-summary-print';
import { buildLensSummaryBuckets } from './lens-summary-model';
import { priceBasisNoun } from '../../_shared/blend-analysis-text';
import {
  formatLensBlocks,
  formatLensKg,
  formatLensSharePct,
  LENS_DEBOUNCE_MS,
  LENS_EMDASH,
  LENS_STALL_MS,
} from './lens-shared';
import {
  addEdgeOffset,
  bandEdgeKey,
  bandOffsets,
  bandRampClass,
  DEFAULT_PRICE_LENS_SETTINGS,
  isDefaultPriceLensSettings,
  manualRoundedUpPhp,
  parseManualPriceInput,
  parsePriceLensSettings,
  PRICE_LENS_BASIS_LABELS,
  PRICE_LENS_BASIS_ORDER,
  PRICE_LENS_EDGE_MAX,
  PRICE_LENS_EDGE_MIN,
  PRICE_LENS_ID,
  PRICE_LENS_RAMP,
  priceBandLabel,
  removeEdgeOffset,
  serializePriceLensSettings,
  type PriceLensUnit,
} from './price-lens-settings';

const PESO = '₱';
const EMDASH = LENS_EMDASH;

// ── Small presentational helpers ────────────────────────────────────────────
// The kilogram and share formatters, the inline refusal banner, the legend rows, the
// ratio bar and the Customize disclosure are all SHARED with the age lens — two
// lenses on one page must not format a kilogram two ways or offer Copy on only one
// of their errors. What is left here is the ₱ formatter, which is the one piece the
// other lens has no use for.

function peso(v: number, decimals = 2): string {
  return `${PESO}${v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** "566,870 kg priced · 37 deliveries · 2026-09-01 → 2026-09-30" */
function basisCoverage(basis: BlockingMarketBasis): string {
  return `${formatLensKg(basis.pricedKg)} priced · ${basis.deliveryCount} deliver${
    basis.deliveryCount === 1 ? 'y' : 'ies'
  } · ${basis.fromDate} → ${basis.toDate}`;
}

// ── The panel ───────────────────────────────────────────────────────────────

/**
 * The lens's PORT onto its two reads — the project's adapter idiom, at the smallest
 * possible scale.
 *
 * The default adapter is the two server actions and is what production always uses.
 * It is injectable for exactly one reason: the gated dev fixture at
 * `/dev/table-playground/pricelens` has no session, so the real actions can only
 * ever return a refusal there — and a panel that can only be LOOKED at in its
 * refusal state cannot be reviewed for colour, contrast or layout. The fixture
 * supplies a static payload shaped like the contract and drives the REAL component.
 */
export interface PriceLensAdapter {
  fetchBases: (trailingDays: number) => Promise<BlockingMarketBasesResult>;
  fetchLens: (
    marketPhpKg: number,
    edgeOffsets: readonly number[],
    /**
     * The TYPED cut line, or `null` for "compute R from the market price".
     * `manual` basis → `Math.ceil(typed)`; every measured basis → `null`.
     */
    roundedUpPhp: number | null,
  ) => Promise<BlockingPriceLensResult>;
}

const LIVE_ADAPTER: PriceLensAdapter = {
  fetchBases: (days) => fetchBlockingMarketBases(days),
  fetchLens: (price, edges, roundedUpPhp) =>
    fetchBlockingPriceLens(price, [...edges], roundedUpPhp),
};

export function PriceLensPanel({
  data,
  caps,
  onClassifierChange,
  onRequestClose,
  adapter = LIVE_ADAPTER,
}: BlockingLensPanelProps & { adapter?: PriceLensAdapter }) {
  const { settings, patch, reset } = useLensSettings(
    PRICE_LENS_ID,
    DEFAULT_PRICE_LENS_SETTINGS,
    parsePriceLensSettings,
    serializePriceLensSettings,
  );

  /**
   * WHAT the bands are cut against, in one word — `market` or `set price`.
   *
   * Derived once from the basis and read by every string in this panel that names it, so
   * the bar, the popover, the Customize disclosure and the printed sheet cannot disagree.
   * `priceBasisNoun` is shared with the analysis pages for the same reason.
   */
  const basisNoun = priceBasisNoun(settings.basis === 'manual');

  const [bases, setBases] = React.useState<BlockingMarketBasis[] | null>(null);
  const [basesRefusal, setBasesRefusal] = React.useState<string | null>(null);
  const [basesLoading, setBasesLoading] = React.useState(false);

  const [lens, setLens] = React.useState<BlockingPriceLens | null>(null);
  const [lensRefusal, setLensRefusal] = React.useState<string | null>(null);
  const [lensPending, setLensPending] = React.useState(false);

  /** Which band rows are isolated. Empty = show every band (the "ratio'd" view). */
  const [picked, setPicked] = React.useState<Set<number>>(() => new Set());
  /** The Settings popover — everything that used to be the docked sidebar's body. */
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [customizeOpen, setCustomizeOpen] = React.useState(false);
  const [edgeDraft, setEdgeDraft] = React.useState('');
  const [edgeError, setEdgeError] = React.useState<string | null>(null);
  const [manualDraft, setManualDraft] = React.useState('');
  const [manualError, setManualError] = React.useState<string | null>(null);

  // The saved ₱ arrives on the tick AFTER mount (settings are read in an effect, not
  // a lazy initialiser — see `use-lens-settings.ts`), so the text box is seeded from
  // the STORED value when it lands. Keyed on the stored value alone, so typing is
  // never overwritten by this.
  const storedManual = settings.manualPrice;
  React.useEffect(() => {
    setManualDraft(storedManual === null ? '' : String(storedManual));
  }, [storedManual]);

  // The close handler in a ref, so the fetch effects below do not re-run whenever
  // the frame happens to rebuild its callback.
  const closeRef = React.useRef(onRequestClose);
  React.useEffect(() => {
    closeRef.current = onRequestClose;
  }, [onRequestClose]);

  // Held in a ref so a caller passing an inline adapter object cannot re-trigger
  // either fetch effect on every render.
  const adapterRef = React.useRef(adapter);
  React.useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  // ── (1) The four computed market bases ─────────────────────────────────────
  // Re-read when N moves; `manual` needs none of this but the other four rows are
  // still what the select offers, so it is not conditional on the basis.
  const [basesNonce, setBasesNonce] = React.useState(0);
  const { trailingDays } = settings;
  React.useEffect(() => {
    let cancelled = false;
    setBasesLoading(true);
    void adapterRef.current.fetchBases(trailingDays)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setBases(res.bases);
          setBasesRefusal(null);
          return;
        }
        if (res.reason === 'prices_hidden') {
          // Quietly — see the header note. Never a toast, never a retry.
          closeRef.current();
          return;
        }
        setBasesRefusal(res.message);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        errorToast('Could not work out what market costs', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (!cancelled) setBasesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trailingDays, basesNonce]);

  const activeBasis: BlockingMarketBasis | null = React.useMemo(() => {
    if (settings.basis === 'manual') return null;
    return bases?.find((b) => b.basisKey === settings.basis) ?? null;
  }, [bases, settings.basis]);

  /** The ₱ the classifier is asked for. `null` = nothing measurable yet. */
  const marketPhpKg: number | null =
    settings.basis === 'manual' ? settings.manualPrice : activeBasis?.marketPhpKg ?? null;

  /**
   * THE TYPED CUT LINE. `manual` → `Math.ceil(typed)`, so a typed ₱41 means ₱41 and up
   * is above market; every MEASURED basis sends `null` and R stays SQL's `floor+1`. The
   * rounding lives in `price-lens-settings.ts`, never here and never in `actions.ts`.
   */
  const roundedUpOverride: number | null =
    settings.basis === 'manual' ? manualRoundedUpPhp(settings.manualPrice) : null;

  // ── (2) The classification: FIRST REQUEST IMMEDIATELY, then debounced ─────
  //
  // ── WHY THE FIRST ONE IS NOT DEBOUNCED (the 2026-09-21 bug) ──────────────
  // Every request used to be created INSIDE a 250 ms `setTimeout` whose cleanup runs
  // on every effect re-run and on unmount. On the live page the panel is mounted from
  // a URL param mirrored through `useOptimistic`, so anything that flips that param —
  // or any re-render of the frame that remounts the body — destroyed the pending timer
  // BEFORE it could fire. No request was ever issued, the panel sat on "Sorting the
  // yard into bands…" forever, and there was no error, no Retry and no diagnostic.
  // A debounce exists to coalesce KEYSTROKES; it has no business gating the first look.
  //
  // ── WHY THE GUARD IS A SIGNATURE AND NOT A COUNTER ───────────────────────
  // The old guard was a monotonic `tokenRef`: a reply was dropped whenever the token
  // had moved, even when the reply was for exactly the request the panel still wanted.
  // That is what made the stall UNRECOVERABLE — recovery depended on yet another effect
  // run. The guard is now the request's own SIGNATURE, so **a reply for what is
  // currently wanted is ALWAYS applied**, whatever else re-ran in the meantime, and a
  // reply for a superseded request is still dropped.
  const edgeKey = settings.edgeOffsets.join(',');
  const signature = `${marketPhpKg}|${edgeKey}|${roundedUpOverride ?? ''}`;
  /** The signature the panel currently wants a payload for. */
  const wantRef = React.useRef('');
  /** False until this panel instance has issued its first request. */
  const firstDoneRef = React.useRef(false);
  const [lensNonce, setLensNonce] = React.useState(0);
  /** The watchdog: a stall must be VISIBLE and retryable, never an eternal spinner. */
  const [lensStalled, setLensStalled] = React.useState(false);
  /** The live watchdog timer — CLEARED the moment a reply lands, refusal or not. */
  const watchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchdog = React.useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (marketPhpKg === null) {
      // Nothing to classify against. Drop the tint rather than leave a stale one
      // painted against a price that is no longer on screen.
      wantRef.current = '';
      setLens(null);
      setLensRefusal(null);
      setLensPending(false);
      setLensStalled(false);
      return;
    }
    wantRef.current = signature;
    setLensPending(true);
    setLensStalled(false);
    const offsets = edgeKey.split(',').map(Number);

    const run = () => {
      void adapterRef.current.fetchLens(marketPhpKg, offsets, roundedUpOverride)
        .then((res) => {
          // A reply for the signature the panel still wants is ALWAYS applied.
          if (wantRef.current !== signature) return;
          if (res.ok) {
            setLens(res.lens);
            setLensRefusal(null);
            return;
          }
          if (res.reason === 'prices_hidden') {
            closeRef.current();
            return;
          }
          // The previous tint STAYS: a refusal about the new settings is not a
          // reason to blank the picture the reader is looking at.
          setLensRefusal(res.message);
        })
        .catch((err: unknown) => {
          if (wantRef.current !== signature) return;
          errorToast('Could not work out the price lens', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (wantRef.current !== signature) return;
          // The read ANSWERED — payload or refusal. Stop the watchdog before it can
          // call a healthy panel stalled eight seconds later.
          stopWatchdog();
          setLensPending(false);
          setLensStalled(false);
        });
    };

    // FIRST look: fire on this frame, with no timer to lose. Subsequent changes are
    // debounced, which is what the 250 ms was ever for.
    const arm = (ms: number) => {
      stopWatchdog();
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        if (wantRef.current === signature) setLensStalled(true);
      }, ms);
    };

    if (!firstDoneRef.current) {
      firstDoneRef.current = true;
      arm(LENS_STALL_MS);
      run();
      return stopWatchdog;
    }
    const timer = setTimeout(run, LENS_DEBOUNCE_MS);
    arm(LENS_DEBOUNCE_MS + LENS_STALL_MS);
    return () => {
      clearTimeout(timer);
      stopWatchdog();
    };
  }, [marketPhpKg, edgeKey, roundedUpOverride, signature, lensNonce, stopWatchdog]);

  // A band set that no longer exists must not stay picked — three bands isolated
  // and then a cut line removed would isolate a band index that is now somebody
  // else's. Cleared on the EDGES changing (an event), never on every payload.
  React.useEffect(() => {
    setPicked(new Set());
  }, [edgeKey]);

  // ── (3) Publish the classifier ────────────────────────────────────────────
  const bandCount = lens?.bands.length ?? 0;
  const classifier: BlockingLensClassifier | null = React.useMemo(() => {
    if (!lens) return null;
    const byBlock = lens.bandByBlock;
    return (locKey: string) => {
      const band = byBlock[locKey];
      if (picked.size === 0) {
        // The "ratio'd" view: every PRICED block wears its band. A block absent
        // from the map (unpriced, or an empty slot) is left exactly as it looks
        // with no lens open — never painted as the cheapest band.
        return band === undefined ? null : { className: bandRampClass(band, bandCount) };
      }
      if (band !== undefined && picked.has(band)) {
        return { className: `${bandRampClass(band, bandCount)} lens-band-picked` };
      }
      return { dimmed: true };
    };
  }, [lens, picked, bandCount]);

  React.useEffect(() => {
    onClassifierChange(classifier);
  }, [classifier, onClassifierChange]);

  // Un-lens the grid when this lens goes away (panel closed, or another lens
  // selected). A separate unmount-only effect, so a classifier CHANGE never
  // passes through a null and flashes the grid back to plain.
  const publishRef = React.useRef(onClassifierChange);
  React.useEffect(() => {
    publishRef.current = onClassifierChange;
  }, [onClassifierChange]);
  React.useEffect(() => () => publishRef.current(null), []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const togglePicked = React.useCallback((index: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const commitManual = React.useCallback(() => {
    const res = parseManualPriceInput(manualDraft);
    if (!res.ok) {
      setManualError(res.message);
      return;
    }
    setManualError(null);
    patch({ manualPrice: res.value });
  }, [manualDraft, patch]);

  const addEdge = React.useCallback(() => {
    const trimmed = edgeDraft.trim();
    if (!/^[+-]?\d{1,3}$/.test(trimmed)) {
      setEdgeError(
        `A cut line is a whole number of pesos from ${basisNoun}, between ${PRICE_LENS_EDGE_MIN} and +${PRICE_LENS_EDGE_MAX}.`,
      );
      return;
    }
    const res = addEdgeOffset(settings.edgeOffsets, Number(trimmed));
    if (!res.ok) {
      setEdgeError(res.message);
      return;
    }
    setEdgeError(null);
    setEdgeDraft('');
    patch({ edgeOffsets: res.edgeOffsets });
  }, [basisNoun, edgeDraft, patch, settings.edgeOffsets]);

  const dropEdge = React.useCallback(
    (offset: number) => {
      const res = removeEdgeOffset(settings.edgeOffsets, offset);
      if (!res.ok) {
        setEdgeError(res.message);
        return;
      }
      setEdgeError(null);
      patch({ edgeOffsets: res.edgeOffsets });
    },
    [patch, settings.edgeOffsets],
  );

  const renameBand = React.useCallback(
    (key: string, name: string) => {
      const next = { ...settings.bandNames };
      const trimmed = name.trim().slice(0, 40);
      if (trimmed === '') delete next[key];
      else next[key] = trimmed;
      patch({ bandNames: next });
    },
    [patch, settings.bandNames],
  );

  const resetBands = React.useCallback(() => {
    setEdgeError(null);
    patch({
      edgeOffsets: [...DEFAULT_PRICE_LENS_SETTINGS.edgeOffsets],
      bandNames: {},
    });
  }, [patch]);

  const setUnit = React.useCallback((unit: PriceLensUnit) => patch({ unit }), [patch]);

  const share = React.useCallback(
    (band: BlockingPriceBand) => (settings.unit === 'kg' ? band.kgSharePct : band.blockSharePct),
    [settings.unit],
  );

  // ── View models for the SHARED pieces (labels and strings only) ───────────
  // Nothing below adds anything up: every figure is the payload's own, formatted.

  const bandRows = React.useMemo(() => {
    if (!lens) return [];
    const roundedUpPhp = lens.roundedUpPhp;
    return lens.bands.map((b) => ({
      index: b.index,
      label: priceBandLabel(b, roundedUpPhp, settings.bandNames),
      sharePct: share(b),
      detail: `${b.blockCount} block${b.blockCount === 1 ? '' : 's'} · ${formatLensKg(b.kg)}`,
    }));
  }, [lens, settings.bandNames, share]);

  const edgeChips: LensCutLineChip[] = React.useMemo(
    () =>
      settings.edgeOffsets.map((e) => {
        const signed = e >= 0 ? `+${e}` : String(e);
        return {
          value: e,
          text: signed,
          removeLabel: `Remove the cut line ${signed} from ${basisNoun}`,
        };
      }),
    [basisNoun, settings.edgeOffsets],
  );

  // Keyed on the band's OFFSETS from R, so a name follows its own interval instead
  // of jumping to a different slice of the yard when a cut line is added below it.
  const nameFields: LensBandNameField[] | undefined = React.useMemo(() => {
    if (!lens) return undefined;
    return lens.bands.map((b) => {
      const { lowerOffset, upperOffset } = bandOffsets(b, lens.roundedUpPhp);
      const key = bandEdgeKey(lowerOffset, upperOffset);
      return {
        key,
        value: settings.bandNames[key] ?? '',
        placeholder: priceBandLabel(b, lens.roundedUpPhp),
        ariaLabel: `Name for the band ${priceBandLabel(b, lens.roundedUpPhp)}`,
      };
    });
  }, [lens, settings.bandNames]);

  const atEdgeCap = settings.edgeOffsets.length >= BLOCKING_PRICE_LENS_MAX_EDGES;
  const customised = !isDefaultPriceLensSettings(settings);


  /**
   * THE PRINTED SUMMARY's model — this lens as it is configured RIGHT NOW.
   *
   * It is built here, not in the print component, because only the lens knows what its
   * settings MEAN. Nothing is computed: every figure is the payload's own, formatted by
   * the shared `lens-shared.ts` formatters, and the per-band block lists are a BUCKETING
   * of `bandByBlock` (a lookup, never a sum) joined to the grid's own `data` map.
   *
   * Band ISOLATION is respected — the sheet prints the bands the screen is showing, and
   * says "Showing 2 of 4 bands" when that is fewer than all of them. A printout that
   * silently widened the filter would not be a printout of the filter.
   */
  const printModel: LensSummaryPrintModel | null = React.useMemo(() => {
    if (!lens || marketPhpKg === null) return null;
    const bandCount = lens.bands.length;
    const typed = settings.basis === 'manual';

    // ONE bucketing, shared by all three lenses: band → warehouse → rows, with the
    // grid's own lab readings joined in. A LOOKUP of `bandByBlock`, never a sum of it.
    const { byBand, excludedRows } = buildLensSummaryBuckets({
      data,
      bandOf: (loc) => lens.bandByBlock[loc],
      figureOf: (_loc, block) => (block.php === null ? EMDASH : peso(block.php, 2)),
      sortKeyOf: (_loc, block) => block.php ?? 0,
      formatKg: formatLensKg,
      formatBlocks: formatLensBlocks,
      excludedFigure: EMDASH,
    });

    const visible = lens.bands.filter((b) => picked.size === 0 || picked.has(b.index));

    return {
      // THE TITLE IS THE LENS'S NAME. The settings line says what it is set to.
      title: 'Price lens',
      // ONE TERSE LINE — and for a TYPED figure the word "market" is absent, because a
      // number somebody typed in is a SET PRICE and calling it market would claim a
      // measurement nobody made (`priceBasisNoun`, the one definition).
      settingsLine: [
        typed
          ? `Set price ${peso(marketPhpKg, 2)}`
          : `Market ${peso(marketPhpKg, 2)} (${PRICE_LENS_BASIS_LABELS[settings.basis].toLowerCase()})`,
        `${peso(lens.roundedUpPhp, 0)} and up is above ${priceBasisNoun(typed)}`,
        `cuts ${settings.edgeOffsets
          .map((o) => (o === 0 ? priceBasisNoun(typed) : `${o > 0 ? '+' : ''}${o}`))
          .join(' · ')}`,
        `by ${settings.unit === 'kg' ? 'kilograms' : 'block count'}`,
      ].join(' · '),
      unit: settings.unit,
      ramp: PRICE_LENS_RAMP,
      bandCount,
      figureColumnLabel: '₱/kg',
      bands: visible.map((b) => ({
        index: b.index,
        label: priceBandLabel(b, lens.roundedUpPhp, settings.bandNames),
        blocks: formatLensBlocks(b.blockCount),
        kg: formatLensKg(b.kg),
        sharePct: share(b),
        share: formatLensSharePct(share(b)),
        figure: b.kgWeightedPhpKg === null ? EMDASH : peso(b.kgWeightedPhpKg, 2),
        warehouses: byBand.get(b.index) ?? [],
      })),
      total: {
        blocks: formatLensBlocks(lens.total.blockCount),
        kg: formatLensKg(lens.total.kg),
        figure: lens.total.kgWeightedPhpKg === null ? EMDASH : peso(lens.total.kgWeightedPhpKg, 2),
        // THE DOCUMENTED ASYMMETRY, said on the sheet: the counts cover every occupied
        // block, the price covers the PRICED ones.
        figureNote: 'avg of priced',
      },
      excluded:
        lens.unpriced.blockCount > 0
          ? {
              title: `No price yet ${EMDASH} ${formatLensBlocks(
                lens.unpriced.blockCount,
              )}, ${formatLensKg(lens.unpriced.kg)}`,
              note: 'In no band and out of both percentages. Those cells keep their normal look on the grid.',
              rows: excludedRows,
            }
          : null,
    };
  }, [lens, marketPhpKg, data, picked, settings.basis, settings.bandNames, settings.edgeOffsets, settings.unit, share]);

  /**
   * THE BAR'S HEADLINE — the whole lens in a few words.
   *
   * `Market ₱39.86 · ₱40+ above`, or for a typed figure `Set price ₱41 · ₱41+ above`.
   *
   * TWO things are visible here. The 2026-09-21 rule: a price the operator TYPES is the
   * cut line, so 41 reads back as 41 and never as 42. And the 2026-09-22 one: a typed
   * figure is a SET PRICE, so the word "market" is absent from it — `priceBasisNoun` is
   * the one definition, shared with the analysis pages.
   */
  const headline = React.useMemo(() => {
    const typed = settings.basis === 'manual';
    if (marketPhpKg === null) {
      if (typed) return 'No price set yet';
      return basesLoading ? 'Working out market…' : 'No market price yet';
    }
    // ⚠️ A TYPED FIGURE IS A SET PRICE, NEVER "MARKET" — one noun, one definition
    // (`priceBasisNoun`), so the bar, the popover, both printouts and the analysis
    // pages cannot call it two different things.
    const base = `${typed ? 'Set price' : 'Market'} ${peso(marketPhpKg, 2)}`;
    if (!lens) return base;
    return `${base} · ${peso(lens.roundedUpPhp, 0)}+ above`;
  }, [marketPhpKg, basesLoading, settings.basis, lens]);

  // ── Render ────────────────────────────────────────────────────────────────

  // BELT AND BRACES, in the third place. The frame refuses to render a lens whose
  // `canShow` is false, and both server actions refuse a `!canViewPrices()` caller
  // before touching the database — but if this ever mounts without the flag it
  // renders NOTHING, rather than an empty legend that invites a retry.
  if (!caps.canViewPrices) return null;

  return (
    <>
      {/* ═══ THE LEGEND BAR — one line, never wrapping ═══════════════════════
          What a reader looks at WHILE scanning the grid. Everything they set up
          once lives behind the gear at the end. */}
      <span
        className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
        title={marketPhpKg === null ? undefined : `${PESO}${marketPhpKg} / kg`}
      >
        {headline}
      </span>

      {/* One chip per band — the SAME isolate toggles the popover's rows are, in
          their compact variant. They overflow by scrolling, never by wrapping. */}
      {lens ? (
        <LensBandChips
          rows={bandRows}
          ramp={PRICE_LENS_RAMP}
          picked={picked}
          onToggle={togglePicked}
        />
      ) : (
        // Never an empty bar: a quiet, shimmer-free placeholder while the read runs.
        <span className="shrink-0 text-[10px] text-muted-foreground">…</span>
      )}

      {/* The thin inline ratio. Widths ARE the published shares. */}
      {lens && (
        <div className="hidden w-[110px] shrink-0 lg:block">
          <LensRatioBar
            ramp={PRICE_LENS_RAMP}
            segments={lens.bands.map((b) => ({ key: b.index, sharePct: share(b) }))}
            ariaLabel={lens.bands
              .map(
                (b) =>
                  `${priceBandLabel(b, lens.roundedUpPhp, settings.bandNames)}: ${formatLensSharePct(
                    share(b),
                  )} by ${settings.unit}`,
              )
              .join('; ')}
          />
        </div>
      )}

      {/* Unpriced — its OWN chip, never a band and never a ₱0. */}
      {lens && lens.unpriced.blockCount > 0 && (
        <LensExcludedChip
          title={`No price ${EMDASH} ${lens.unpriced.blockCount}`}
          note={`${lens.unpriced.blockCount} block${
            lens.unpriced.blockCount === 1 ? '' : 's'
          }, ${formatLensKg(
            lens.unpriced.kg,
          )} with no price yet. In no band and out of both percentages — those cells keep their normal look.`}
        />
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {lensPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {/* A stall or a refusal must be VISIBLE in the bar and actionable in the
            popover — never an eternal spinner with nothing to click. */}
        {(lensStalled || lensRefusal || basesRefusal) && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive cursor-pointer"
            title="Open Settings to read the problem, copy it, and retry"
          >
            <AlertTriangle className="h-3 w-3" />
            <span className="max-sm:hidden">Problem</span>
          </button>
        )}
        {/* PRINT — one A4 landscape sheet of this lens as configured. It is inside
            the `caps.canViewPrices` branch by construction (the whole panel returns
            null without it), and the condition is written out anyway so the gate is
            visible where the button is. */}
        {caps.canViewPrices && (
          <LensSummaryPrintControl model={printModel} lensLabel="price" />
        )}
        {/* kg | blocks — changes the bar AND the popover's row percentages
            together, so a segment and the number beside it are never in
            different units. */}
        <LensUnitSwitch unit={settings.unit} onChange={setUnit} />
        <LensSettingsPopover
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          label="Price lens settings"
          customised={customised}
        >
          {/* ═══ THE POPOVER BODY — what used to be the docked sidebar ═══════ */}
          {/* ── (1) Market is … ─────────────────────────────────────────── */}
      <section className="flex flex-col gap-1.5">
        <label
          htmlFor="price-lens-basis"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {/* A typed figure is a SET PRICE, so the label follows the basis rather than
              calling a number somebody typed in "market". */}
          {settings.basis === 'manual' ? 'Set price' : 'Market is'}
        </label>
        <Select
          value={settings.basis}
          onValueChange={(v) => patch({ basis: v as typeof settings.basis })}
        >
          <SelectTrigger id="price-lens-basis" size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRICE_LENS_BASIS_ORDER.map((b) => (
              <SelectItem key={b} value={b} className="text-xs">
                {PRICE_LENS_BASIS_LABELS[b]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {settings.basis === 'trailing_days' && (
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              inputMode="numeric"
              min={BLOCKING_TRAILING_DAYS_MIN}
              max={BLOCKING_TRAILING_DAYS_MAX}
              value={settings.trailingDays}
              aria-label="Trailing days"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (
                  Number.isInteger(n) &&
                  n >= BLOCKING_TRAILING_DAYS_MIN &&
                  n <= BLOCKING_TRAILING_DAYS_MAX
                ) {
                  patch({ trailingDays: n });
                }
              }}
              className="h-7 w-20 font-mono text-xs"
            />
            <span className="text-[11px] text-muted-foreground">
              days back ({BLOCKING_TRAILING_DAYS_MIN}
              {EMDASH}
              {BLOCKING_TRAILING_DAYS_MAX})
            </span>
          </div>
        )}

        {settings.basis === 'manual' && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{PESO}</span>
              <Input
                inputMode="decimal"
                value={manualDraft}
                aria-label="Set price per kilogram"
                placeholder="40.25"
                onChange={(e) => {
                  setManualDraft(e.target.value);
                  setManualError(null);
                }}
                onBlur={commitManual}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitManual();
                  }
                }}
                className="h-7 w-24 font-mono text-xs"
              />
              <span className="text-[11px] text-muted-foreground">per kg</span>
            </div>
            {manualError && <p className="text-[11px] text-destructive">{manualError}</p>}
          </div>
        )}

        {/* The figure itself, plus what it is measured over. */}
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
          {marketPhpKg !== null ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                {/* Two decimals on screen, the full weighted average on hover — the
                    lens classifies against the unrounded figure, so the tooltip is
                    what makes a 39.8568 that DISPLAYS as 39.86 auditable. */}
                <span
                  className="font-mono text-base font-bold text-foreground"
                  title={`${PESO}${marketPhpKg} / kg`}
                >
                  {peso(marketPhpKg, 2)}
                </span>
                {lens && (
                  // TWO SENTENCES, BECAUSE THERE ARE TWO RULES (2026-09-21).
                  // A MEASURED market rounds UP to the next whole peso, in SQL. A
                  // price the operator TYPED is the cut line itself, so saying
                  // "rounds up to ₱42" about a typed ₱41 would describe a lens one
                  // peso looser than the one they asked for.
                  <span className="text-[11px] text-muted-foreground">
                    {settings.basis === 'manual' ? (
                      <>
                        <span className="font-mono font-semibold text-foreground">
                          {peso(lens.roundedUpPhp, 0)}
                        </span>{' '}
                        and up is above
                      </>
                    ) : (
                      <>
                        rounds up to{' '}
                        <span className="font-mono font-semibold text-foreground">
                          {peso(lens.roundedUpPhp, 0)}
                        </span>
                      </>
                    )}
                  </span>
                )}
              </div>
              {/* The quiet line that makes a thin basis visible — an early-month
                  "market" measured over two truckloads is not market. */}
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                {activeBasis
                  ? basisCoverage(activeBasis)
                  : 'Typed in by hand — not measured from deliveries.'}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-[11px] leading-snug text-foreground">
                {settings.basis === 'manual'
                  ? 'Type a price above to draw the bands.'
                  : basesLoading
                    ? 'Working out what market costs…'
                    : `No priced market deliveries in ${PRICE_LENS_BASIS_LABELS[settings.basis].toLowerCase()} yet, so market cannot be measured that way.`}
              </p>
              {!basesLoading && settings.basis !== 'manual' && (
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Pick another window, or <span className="font-semibold">Set a price</span> and type
                  one in. A market of {PESO}0 would put every block above market, so nothing is
                  assumed here.
                </p>
              )}
            </div>
          )}
        </div>

        {basesRefusal && (
          <RefusalBanner message={basesRefusal} onRetry={() => setBasesNonce((n) => n + 1)} />
        )}
      </section>

      {/* ── (2) The detailed band rows ──────────────────────────────────
             The SHARED legend (`lens-band-rows.tsx`), so the age lens's rows cannot
             drift from these. What is price-specific is what is passed IN: the ₱
             labels, and the ramp id that keeps this lens on the cost scale.
             The RATIO BAR and the kg|blocks switch live in the legend BAR — they are
             what a reader glances at, and duplicating them here would be a second
             place for the same two controls to disagree. */}
      {lens && (
        <section className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bands
          </span>

          {/* One toggle row per band. Every band is present even when empty, so the
              whole scale is legible without inventing rows. */}
          <LensBandRows rows={bandRows} ramp={PRICE_LENS_RAMP} picked={picked} onToggle={togglePicked} />

          {/* Unpriced — its OWN row, never a band and never a ₱0. */}
          {lens.unpriced.blockCount > 0 && (
            <LensExcludedRow
              title={`No price yet ${EMDASH} ${lens.unpriced.blockCount} block${
                lens.unpriced.blockCount === 1 ? '' : 's'
              }, ${formatLensKg(lens.unpriced.kg)}`}
              note="In no band, and out of both percentages. Those cells keep their normal look."
            />
          )}

          <p className="text-[10px] text-muted-foreground">
            {lens.total.blockCount} occupied block
            {lens.total.blockCount === 1 ? '' : 's'} · {formatLensKg(lens.total.kg)}
            {picked.size > 0 && (
              <>
                {' '}
                ·{' '}
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="font-semibold text-foreground underline decoration-dotted cursor-pointer"
                >
                  show all bands
                </button>
              </>
            )}
          </p>
        </section>
      )}

      {lensRefusal && (
        <RefusalBanner message={lensRefusal} onRetry={() => setLensNonce((n) => n + 1)} />
      )}

      {/* THE WATCHDOG (2026-09-21). A read that never lands used to render an
          eternal "Sorting the yard into bands…" with no error, no Retry and nothing
          to paste into a bug report — which is the state the owner found the live
          page in. After `LENS_STALL_MS` the spinner line becomes the shared banner,
          persistent, with Copy and Retry. */}
      {lensStalled && !lensRefusal && (
        <RefusalBanner
          message={
            'The price lens did not come back. The bands on screen (if any) are from an earlier read. ' +
            'Retry, or reload the page; if it keeps happening, copy this and send it on.'
          }
          onRetry={() => setLensNonce((n) => n + 1)}
        />
      )}

      {!lens && !lensStalled && marketPhpKg !== null && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Sorting the yard into bands…
        </p>
      )}

      {/* ── Customize bands ──────────────────────────────────────────────
             The SHARED disclosure (`lens-customize.tsx`): it owns the shape — the
             chip row, the add box, the cap sentence, the rename inputs and the two
             resets — and every word below is this lens's own dimension, pesos from
             the rounded market price. */}
      <LensCustomize
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        edgeCount={settings.edgeOffsets.length}
        maxEdges={BLOCKING_PRICE_LENS_MAX_EDGES}
        intro={
          <>
            A cut line is a whole number of pesos above or below the rounded {basisNoun}
            {lens ? ` (${peso(lens.roundedUpPhp, 0)})` : ''}. {settings.edgeOffsets.length} line
            {settings.edgeOffsets.length === 1 ? '' : 's'} give {settings.edgeOffsets.length + 1}{' '}
            bands.
          </>
        }
        chips={edgeChips}
        onRemoveChip={dropEdge}
        draft={edgeDraft}
        onDraftChange={(v) => {
          setEdgeDraft(v);
          setEdgeError(null);
        }}
        onAdd={addEdge}
        addPlaceholder="+5"
        addAriaLabel={`New cut line, pesos from ${basisNoun}`}
        atCap={atEdgeCap}
        capNote={`${BLOCKING_PRICE_LENS_MAX_EDGES} is the most a lens takes — remove one to add another.`}
        error={edgeError}
        names={nameFields}
        onRename={renameBand}
        onResetBands={resetBands}
        onResetAll={
          customised
            ? () => {
                reset();
                setManualDraft('');
                setEdgeDraft('');
                setEdgeError(null);
                setManualError(null);
              }
            : undefined
        }
      />
        </LensSettingsPopover>
      </div>
    </>
  );
}

/**
 * The registration.
 *
 * `canShow` is the WHOLE price gate on the client side: the entry point is hidden
 * when the grid's effective price flag is false, so a Production user never sees
 * the Price lens offered. It is deliberately per-lens rather than one flag on the
 * frame — a Supplier or Age lens carries no ₱ and will read `() => true`, and the
 * Highlight button will then stay visible for Production with only the Price lens
 * absent. (The server refuses a `!canViewPrices()` call outright regardless; this
 * is the UI half, never the boundary.)
 */
export const PRICE_LENS: BlockingLensDefinition = {
  id: PRICE_LENS_ID,
  label: 'Price',
  icon: Coins,
  blurb: 'Light up the yard by what each block cost against market.',
  ramp: PRICE_LENS_RAMP,
  canShow: (caps) => caps.canViewPrices,
  Panel: PriceLensPanel,
};
