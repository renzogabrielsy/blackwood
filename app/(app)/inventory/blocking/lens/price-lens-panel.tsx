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
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Coins, Copy, Loader2, Plus, RotateCcw, Sliders, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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
  addEdgeOffset,
  bandEdgeKey,
  bandOffsets,
  bandRampClass,
  DEFAULT_PRICE_LENS_SETTINGS,
  isDefaultPriceLensSettings,
  parseManualPriceInput,
  parsePriceLensSettings,
  PRICE_LENS_BASIS_LABELS,
  PRICE_LENS_BASIS_ORDER,
  PRICE_LENS_EDGE_MAX,
  PRICE_LENS_EDGE_MIN,
  PRICE_LENS_ID,
  priceBandLabel,
  removeEdgeOffset,
  serializePriceLensSettings,
  type PriceLensUnit,
} from './price-lens-settings';

const PESO = '₱';
const EMDASH = '—';
/** How long a settings change waits before it costs a round-trip. */
const LENS_DEBOUNCE_MS = 250;

// ── Small presentational helpers ────────────────────────────────────────────

function kg(n: number): string {
  return `${Math.round(n).toLocaleString()} kg`;
}

function pct(v: number | null): string {
  return v === null ? EMDASH : `${v.toFixed(1)}%`;
}

function peso(v: number, decimals = 2): string {
  return `${PESO}${v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * An inline, PERSISTENT error with a Copy button.
 *
 * The project's HARD RULE is that an error never auto-dismisses and always offers
 * Copy; CLAUDE.md allows a banner in place of a toast for an error that belongs to
 * one panel, which is exactly this — a refusal about the lens's own settings would
 * be homeless as a toast the moment the panel closed.
 */
function RefusalBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const copy = React.useCallback(() => {
    void navigator.clipboard.writeText(message);
  }, [message]);
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-snug text-foreground">
      <p>{message}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
        >
          <Copy className="h-2.5 w-2.5" />
          Copy
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** "566,870 kg priced · 37 deliveries · 2026-09-01 → 2026-09-30" */
function basisCoverage(basis: BlockingMarketBasis): string {
  return `${kg(basis.pricedKg)} priced · ${basis.deliveryCount} deliver${
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
  ) => Promise<BlockingPriceLensResult>;
}

const LIVE_ADAPTER: PriceLensAdapter = {
  fetchBases: (days) => fetchBlockingMarketBases(days),
  fetchLens: (price, edges) => fetchBlockingPriceLens(price, [...edges]),
};

export function PriceLensPanel({
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

  const [bases, setBases] = React.useState<BlockingMarketBasis[] | null>(null);
  const [basesRefusal, setBasesRefusal] = React.useState<string | null>(null);
  const [basesLoading, setBasesLoading] = React.useState(false);

  const [lens, setLens] = React.useState<BlockingPriceLens | null>(null);
  const [lensRefusal, setLensRefusal] = React.useState<string | null>(null);
  const [lensPending, setLensPending] = React.useState(false);

  /** Which band rows are isolated. Empty = show every band (the "ratio'd" view). */
  const [picked, setPicked] = React.useState<Set<number>>(() => new Set());
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

  // ── (2) The classification, debounced and race-safe ───────────────────────
  // A settings change costs one round-trip, not one per keystroke. `token` is what
  // makes a slow earlier reply unable to overwrite a fast later one — the guard the
  // detail panel's optimistic-open contract calls a "request token".
  const edgeKey = settings.edgeOffsets.join(',');
  const tokenRef = React.useRef(0);
  const [lensNonce, setLensNonce] = React.useState(0);

  React.useEffect(() => {
    if (marketPhpKg === null) {
      // Nothing to classify against. Drop the tint rather than leave a stale one
      // painted against a price that is no longer on screen.
      setLens(null);
      setLensRefusal(null);
      setLensPending(false);
      return;
    }
    const token = ++tokenRef.current;
    setLensPending(true);
    const offsets = edgeKey.split(',').map(Number);
    const timer = setTimeout(() => {
      void adapterRef.current.fetchLens(marketPhpKg, offsets)
        .then((res) => {
          if (tokenRef.current !== token) return; // a later request owns the screen
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
          if (tokenRef.current !== token) return;
          errorToast('Could not work out the price lens', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (tokenRef.current === token) setLensPending(false);
        });
    }, LENS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [marketPhpKg, edgeKey, lensNonce]);

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
        `A cut line is a whole number of pesos from market, between ${PRICE_LENS_EDGE_MIN} and +${PRICE_LENS_EDGE_MAX}.`,
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
  }, [edgeDraft, patch, settings.edgeOffsets]);

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

  const atEdgeCap = settings.edgeOffsets.length >= BLOCKING_PRICE_LENS_MAX_EDGES;
  const customised = !isDefaultPriceLensSettings(settings);

  // ── Render ────────────────────────────────────────────────────────────────

  // BELT AND BRACES, in the third place. The frame refuses to render a lens whose
  // `canShow` is false, and both server actions refuse a `!canViewPrices()` caller
  // before touching the database — but if this ever mounts without the flag it
  // renders NOTHING, rather than an empty legend that invites a retry.
  if (!caps.canViewPrices) return null;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* ── (1) Market is … ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-1.5">
        <label
          htmlFor="price-lens-basis"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Market is
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
                aria-label="Market price per kilogram"
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
                  <span className="text-[11px] text-muted-foreground">
                    rounds up to{' '}
                    <span className="font-mono font-semibold text-foreground">
                      {peso(lens.roundedUpPhp, 0)}
                    </span>
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
                {basesLoading
                  ? 'Working out what market costs…'
                  : settings.basis === 'manual'
                    ? 'Type a market price above to draw the bands.'
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

      {/* ── (2)+(3) Bands, ratio bar, unit switch ───────────────────────── */}
      {lens && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bands
            </span>
            <div className="flex items-center gap-1.5">
              {lensPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              {/* kg | blocks — changes the bar AND the row percentages together,
                  so a segment and the number beside it are never in different units. */}
              <div
                role="group"
                aria-label="Measure bands by"
                className="inline-flex overflow-hidden rounded-md border border-border"
              >
                {(['kg', 'blocks'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setUnit(u)}
                    aria-pressed={settings.unit === u}
                    className={cn(
                      'px-1.5 py-0.5 text-[10px] font-semibold transition-colors duration-150 cursor-pointer',
                      settings.unit === u
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* The stacked ratio bar. Widths ARE the published shares — see header. */}
          <div
            className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-muted"
            role="img"
            aria-label={lens.bands
              .map(
                (b) =>
                  `${priceBandLabel(b, lens.roundedUpPhp, settings.bandNames)}: ${pct(share(b))} by ${
                    settings.unit
                  }`,
              )
              .join('; ')}
          >
            {lens.bands.map((b, i) => {
              const s = share(b);
              if (s === null || s <= 0) return null;
              return (
                <div
                  key={b.index}
                  className={cn('h-full', bandRampClass(i, lens.bands.length), 'lens-band-swatch')}
                  style={{ width: `${s}%` }}
                />
              );
            })}
          </div>

          {/* One toggle row per band. Every band is present even when empty, so the
              whole scale is legible without inventing rows. */}
          <ul className="flex flex-col gap-1">
            {lens.bands.map((b, i) => {
              const isPicked = picked.has(b.index);
              const label = priceBandLabel(b, lens.roundedUpPhp, settings.bandNames);
              return (
                <li key={b.index}>
                  <button
                    type="button"
                    onClick={() => togglePicked(b.index)}
                    aria-pressed={isPicked}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-150 cursor-pointer',
                      isPicked
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-card hover:bg-accent/50',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-[3px] h-3 w-3 shrink-0 rounded-sm border border-border/60',
                        bandRampClass(i, lens.bands.length),
                        'lens-band-swatch',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px] font-semibold text-foreground">
                          {label}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] font-bold text-foreground">
                          {pct(share(b))}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {b.blockCount} block{b.blockCount === 1 ? '' : 's'} · {kg(b.kg)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Unpriced — its OWN row, never a band and never {PESO}0. */}
          {lens.unpriced.blockCount > 0 && (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground">
                No price yet {EMDASH} {lens.unpriced.blockCount} block
                {lens.unpriced.blockCount === 1 ? '' : 's'}, {kg(lens.unpriced.kg)}
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                In no band, and out of both percentages. Those cells keep their normal look.
              </p>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">
            {lens.total.blockCount} occupied block
            {lens.total.blockCount === 1 ? '' : 's'} · {kg(lens.total.kg)}
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

      {!lens && marketPhpKg !== null && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Sorting the yard into bands…
        </p>
      )}

      {/* ── Customize bands ────────────────────────────────────────────── */}
      <Collapsible open={customizeOpen} onOpenChange={setCustomizeOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
          >
            <Sliders className="h-3 w-3" />
            Customize bands
            <span className="ml-auto font-mono text-[10px]">
              {settings.edgeOffsets.length}/{BLOCKING_PRICE_LENS_MAX_EDGES} cut lines
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
            <p className="text-[10px] leading-snug text-muted-foreground">
              A cut line is a whole number of pesos above or below the rounded market price
              {lens ? ` (${peso(lens.roundedUpPhp, 0)})` : ''}. {settings.edgeOffsets.length} line
              {settings.edgeOffsets.length === 1 ? '' : 's'} give{' '}
              {settings.edgeOffsets.length + 1} bands.
            </p>

            <div className="flex flex-wrap gap-1">
              {settings.edgeOffsets.map((e) => (
                <span
                  key={e}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {e >= 0 ? `+${e}` : e}
                  <button
                    type="button"
                    onClick={() => dropEdge(e)}
                    aria-label={`Remove the cut line ${e >= 0 ? `+${e}` : e} from market`}
                    className="rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <Input
                inputMode="numeric"
                value={edgeDraft}
                placeholder="+5"
                aria-label="New cut line, pesos from market"
                onChange={(e) => {
                  setEdgeDraft(e.target.value);
                  setEdgeError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addEdge();
                  }
                }}
                className="h-7 w-20 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={addEdge}
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
              {/* The cap is stated, not enforced by a dead button with no reason. */}
              {atEdgeCap && (
                <span className="text-[10px] leading-tight text-muted-foreground">
                  {BLOCKING_PRICE_LENS_MAX_EDGES} is the most a lens takes — remove one to add
                  another.
                </span>
              )}
            </div>

            {edgeError && <p className="text-[11px] text-destructive">{edgeError}</p>}

            {/* Renaming. Keyed on the band's OFFSETS, so a name follows its own
                interval instead of jumping when a cut line is added below it. */}
            {lens && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Names
                </span>
                {lens.bands.map((b) => {
                  const { lowerOffset, upperOffset } = bandOffsets(b, lens.roundedUpPhp);
                  const key = bandEdgeKey(lowerOffset, upperOffset);
                  return (
                    <Input
                      key={key}
                      defaultValue={settings.bandNames[key] ?? ''}
                      placeholder={priceBandLabel(b, lens.roundedUpPhp)}
                      aria-label={`Name for the band ${priceBandLabel(b, lens.roundedUpPhp)}`}
                      maxLength={40}
                      onBlur={(e) => renameBand(key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          renameBand(key, (e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="h-7 text-[11px]"
                    />
                  );
                })}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={resetBands}
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </Button>
              {customised && (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setManualDraft('');
                    setEdgeDraft('');
                    setEdgeError(null);
                    setManualError(null);
                  }}
                  className="text-[10px] font-semibold text-muted-foreground underline decoration-dotted transition-colors duration-150 hover:text-foreground cursor-pointer"
                >
                  Reset everything
                </button>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
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
  canShow: (caps) => caps.canViewPrices,
  Panel: PriceLensPanel,
};
